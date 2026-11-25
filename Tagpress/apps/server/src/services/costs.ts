import { randomUUID } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { type AiCallSummary, type CostSummary, estimateCost } from "@tagpress/domain";
import type { TenantDb } from "../org/tenant-db.ts";
import type { AiCallRecord } from "../ports.ts";
import type { Clock } from "../util/clock.ts";
import { fail } from "../util/errors.ts";

const SUMMARY_MAX = 2000;

interface CallRow {
  id: string;
  purpose: string;
  model: string;
  summary: string;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  duration_ms: number;
  created_at: string;
  response?: Uint8Array | null;
}

/**
 * AI çağrı kaydı ve maliyet. Tam istem SAKLANMAZ (eski veritabanının 21 MB'ı buydu): yalnızca kısa özet ve
 * sıkıştırılmış ham yanıt. Maliyet domain `estimateCost` ile (platform sözleşmesinin fiyatı, geçidin defteriyle aynı
 * kural ve yuvarlama; tabloda olmayan model en pahalı fiyattan). Kullanımı olmayan (başarısız) çağrının maliyeti null.
 * Kayıtlar ve özet geçerli firmanındır; `member_id` bağlamın üyesi (`$member`; yerelde ve arka plan işinde boş),
 * `gateway_call_id` platform kipinde geçidin çağrı kimliği.
 */
export class CostService {
  constructor(
    private readonly db: TenantDb,
    private readonly clock: Clock,
  ) {}

  record(call: AiCallRecord, ctx: { jobId?: string | null; taskId?: string | null; variantId?: string | null; languageId?: string | null }): { id: string; costUsd: number | null } {
    const id = randomUUID();
    const u = call.usage ?? null;
    const costUsd = u ? estimateCost(u) : null;
    this.db
      .prepare(
        `INSERT INTO ai_calls (org_id, id, job_id, task_id, variant_id, language_id, purpose, model, summary, response, error, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, images, cost_usd, duration_ms, created_at, member_id, gateway_call_id)
         VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, $member, ?)`,
      )
      .run(
        id, ctx.jobId ?? null, ctx.taskId ?? null, ctx.variantId ?? null, ctx.languageId ?? null, call.purpose, u?.model ?? call.model,
        call.summary.slice(0, SUMMARY_MAX), call.response ? deflateSync(Buffer.from(call.response, "utf8")) : null, call.error ?? null,
        u?.inputTokens ?? 0, u?.outputTokens ?? 0, u?.cacheReadTokens ?? 0, u?.cacheWriteTokens ?? 0, u?.images ?? 0, costUsd,
        Math.round(call.durationMs), this.clock.now().toISOString(), call.gatewayCallId ?? u?.gatewayCallId ?? null,
      );
    return { id, costUsd };
  }

  forJob(jobId: string): AiCallSummary[] {
    const rows = this.db
      .prepare("SELECT id, purpose, model, summary, error, input_tokens, output_tokens, cost_usd, duration_ms, created_at FROM ai_calls WHERE job_id = ? AND org_id = $org ORDER BY created_at DESC")
      .all(jobId) as unknown as CallRow[];
    return rows.map(toSummary);
  }

  /** Tek çağrı + açılmış ham yanıt. */
  get(id: string): AiCallSummary & { response: string | null } {
    const r = this.db.prepare("SELECT * FROM ai_calls WHERE id = ? AND org_id = $org").get(id) as CallRow | undefined;
    if (!r) throw fail("ai-call-not-found");
    return { ...toSummary(r), response: r.response ? inflateSync(Buffer.from(r.response)).toString("utf8") : null };
  }

  summary(languageId?: string): CostSummary {
    const now = this.clock.now();
    const today = now.toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    const where = languageId ? "WHERE org_id = $org AND language_id = ?" : "WHERE org_id = $org";
    const args = languageId ? [languageId] : [];
    const one = (sql: string, ...a: string[]) => this.db.prepare(sql).get(...args, ...a) as { usd: number | null; n: number };
    const and = `${where} AND`;
    const total = one(`SELECT SUM(cost_usd) AS usd, COUNT(*) AS n FROM ai_calls ${where}`);
    const t = one(`SELECT SUM(cost_usd) AS usd, COUNT(*) AS n FROM ai_calls ${and} substr(created_at, 1, 10) = ?`, today);
    const m = one(`SELECT SUM(cost_usd) AS usd, COUNT(*) AS n FROM ai_calls ${and} substr(created_at, 1, 7) = ?`, month);
    const unpriced = one(`SELECT 0 AS usd, COUNT(*) AS n FROM ai_calls ${and} cost_usd IS NULL`);
    const group = (col: string, extra = "", ...a: string[]) =>
      (this.db.prepare(`SELECT ${col} AS k, SUM(COALESCE(cost_usd, 0)) AS usd, COUNT(*) AS n FROM ai_calls ${extra || where} GROUP BY k ORDER BY k`).all(...args, ...a) as {
        k: string;
        usd: number;
        n: number;
      }[]);
    return {
      todayUsd: t.usd ?? 0,
      monthUsd: m.usd ?? 0,
      totalUsd: total.usd ?? 0,
      byDay: group("substr(created_at, 1, 10)", `${and} substr(created_at, 1, 10) >= ?`, since).map((r) => ({ day: r.k, usd: r.usd, calls: r.n })),
      byModel: group("model").map((r) => ({ model: r.k, usd: r.usd, calls: r.n })),
      byPurpose: group("purpose").map((r) => ({ purpose: r.k, usd: r.usd, calls: r.n })),
      unpricedCalls: unpriced.n,
    };
  }
}

function toSummary(r: CallRow): AiCallSummary {
  return {
    id: r.id,
    purpose: r.purpose,
    model: r.model,
    summary: r.summary,
    error: r.error,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
}
