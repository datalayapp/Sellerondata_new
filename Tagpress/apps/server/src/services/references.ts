import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type LearnProposal, type Reference, ReferenceSchema } from "@tagpress/domain";
import { type BreakExample, breaksOnCustomerText } from "@tagpress/ai";
import { json } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import { fail, failFields, zodFields } from "../util/errors.ts";
import { PNG, isSafeRelative, safeJoin } from "../util/safe-path.ts";
import { assertLanguageInOrg } from "./languages.ts";

const LANGUAGE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Referans görselinin diskteki yeri. `root`: geçerli firmanın kökü (`ctx.paths.root`). Kayıttaki göreli yol YALNIZ
 * `referanslar/<dil>/…png` olabilir (kökün başka bir dosyası, ör. `studio.db` ya da ana anahtar, asla); kaçış (`..`,
 * mutlak yol, ters eğik çizgi, bağ) null döner.
 */
export function referenceImageFile(root: string, ref: Pick<Reference, "image" | "languageId">): string | null {
  const rel = referenceImageRel(ref);
  return rel === null ? null : safeJoin(path.join(root, "referanslar", ref.languageId), rel, { ext: PNG });
}

/** Kayıttaki yolun dil klasörüne göre kısmı (sözdizimi denetimli), yoksa null. */
function referenceImageRel(ref: Pick<Reference, "image" | "languageId">): string | null {
  if (!ref.image || !LANGUAGE_ID.test(ref.languageId)) return null;
  const prefix = `referanslar/${ref.languageId}/`;
  const rel = ref.image.startsWith(prefix) ? ref.image.slice(prefix.length) : null;
  return isSafeRelative(rel, { ext: PNG }) ? rel : null;
}

/** Referanslar (kullanıcının bitmiş etiketleri), geçerli firmanın — CRUD. Öğrenme mantığı `learn` paketinde. */
export class ReferenceService {
  constructor(
    private readonly db: TenantDb,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  private readonly exampleCache = new Map<string, { key: string; pool: BreakExample[] }>();

  list(filter: { languageId?: string; split?: string } = {}): Reference[] {
    const where = ["org_id = $org", "deleted_at IS NULL"];
    const args: string[] = [];
    if (filter.languageId) {
      where.push("language_id = ?");
      args.push(filter.languageId);
    }
    if (filter.split) {
      where.push("split = ?");
      args.push(filter.split);
    }
    const rows = this.db.prepare(`SELECT data FROM refs WHERE ${where.join(" AND ")} ORDER BY created_at DESC`).all(...args) as { data: string }[];
    return rows.map((r) => ReferenceSchema.parse(json(r.data, {})));
  }

  get(id: string): Reference {
    const r = this.db.prepare("SELECT data FROM refs WHERE id = ? AND org_id = $org AND deleted_at IS NULL").get(id) as { data: string } | undefined;
    if (!r) throw fail("reference-not-found");
    return ReferenceSchema.parse(json(r.data, {}));
  }

  /** Ekler; aynı kimlik varsa üzerine yazar (yeniden yükleme). */
  save(input: Omit<Reference, "id" | "createdAt"> & { id?: string; createdAt?: string }): Reference {
    const parsed = ReferenceSchema.safeParse({ ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? this.clock.now().toISOString() });
    if (!parsed.success) throw failFields("reference-invalid", zodFields(parsed.error));
    const ref = parsed.data;
    // Görsel yolu istemciden gelir: yalnız dilin referans klasöründeki PNG kabul edilir (`referenceImageFile`).
    if (ref.image !== null && referenceImageRel(ref) === null) {
      throw failFields("reference-invalid", [{ path: "image", message: `Görsel yolu "referanslar/${ref.languageId}/<dosya>.png" biçiminde olmalı.` }]);
    }
    assertLanguageInOrg(this.db, ref.languageId);
    const upsert = this.db.prepare(
      `INSERT INTO refs (org_id, id, language_id, data, split, created_at) VALUES ($org, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, split = excluded.split, deleted_at = NULL WHERE refs.org_id = $org`,
    );
    const write = (r: Reference) => Number(upsert.run(r.id, r.languageId, JSON.stringify(r), r.split, r.createdAt).changes);
    // Kimlik kurulum genelinde tekil: aynı kimlik başka firmanınsa üzerine yazılmaz, kayıt yeni kimlikle eklenir
    // (ör. iki firmaya aynı aktarım paketi).
    const saved = write(ref) ? ref : { ...ref, id: randomUUID() };
    if (saved !== ref) write(saved);
    this.events.emit({ type: "reference", languageId: saved.languageId });
    return saved;
  }

  update(id: string, patch: Partial<Pick<Reference, "split" | "text" | "templateKey">>): Reference {
    return this.save({ ...this.get(id), ...patch });
  }

  /** Referans görselinin mutlak yolu (`root`: firma kökü; dilin referans klasöründe ve dosya varsa), yoksa null. Kayıttaki eski/kötü değer de burada durur. */
  imagePath(root: string, ref: Pick<Reference, "image" | "languageId">): string | null {
    const file = referenceImageFile(root, ref);
    return file && existsSync(file) ? file : null;
  }

  /** Dilin, şablondaki EĞİTİM kümesi referans görselleri (ayrılmış test kümesi asla kullanılmaz), en yenisi başta. */
  async trainImages(root: string, languageId: string, templateKey: string, limit: number, excludeId?: string): Promise<Buffer[]> {
    const out: Buffer[] = [];
    for (const ref of this.list({ languageId, split: "train" })) {
      if (out.length >= limit) break;
      if (ref.templateKey !== templateKey || ref.id === excludeId) continue;
      const file = this.imagePath(root, ref);
      if (file) out.push(await readFile(file));
    }
    return out;
  }

  /** Satır bölme örnekleri havuzu (yalnızca öğrenme kümesi); dil başına önbellekli, referans değişince tazelenir. */
  breakExamples(languageId: string): BreakExample[] {
    // Önbellek anahtarı: referans sayısı + son değişiklik (başka servislerin yazdıkları da yakalanır).
    const stamp = this.db.prepare("SELECT count(*) AS n, max(created_at) AS c, max(coalesce(deleted_at, '')) AS d FROM refs WHERE language_id = ? AND org_id = $org").get(languageId) as { n: number; c: string | null; d: string | null };
    const key = `${stamp.n}:${stamp.c}:${stamp.d}`;
    // Süreç geneli önbellek: anahtarda firma da var (başka firmanın havuzu hiçbir koşulda dönmez).
    const cacheKey = `${this.db.orgId("references.breakExamples")}|${languageId}`;
    const hit = this.exampleCache.get(cacheKey);
    if (hit && hit.key === key) return hit.pool;
    const pool: BreakExample[] = [];
    for (const ref of this.list({ languageId, split: "train" })) {
      const lines = breaksOnCustomerText(ref.text, ref.user.map((l) => l.text));
      if (lines && lines.length) pool.push({ text: ref.text, lines, templateKey: ref.templateKey, referenceId: ref.id });
    }
    this.exampleCache.set(cacheKey, { key, pool });
    return pool;
  }

  remove(id: string): void {
    const ref = this.get(id);
    this.db.prepare("UPDATE refs SET deleted_at = ? WHERE id = ? AND org_id = $org").run(this.clock.now().toISOString(), id);
    this.events.emit({ type: "reference", languageId: ref.languageId });
  }
}

/** Öğrenme önerileri, geçerli firmanın — CRUD (öneri üretimi sonra gelecek). */
export class LearnProposalService {
  constructor(
    private readonly db: TenantDb,
    private readonly clock: Clock,
  ) {}

  list(filter: { languageId?: string; status?: string } = {}): LearnProposal[] {
    const where = ["org_id = $org"];
    const args: string[] = [];
    if (filter.languageId) {
      where.push("language_id = ?");
      args.push(filter.languageId);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    const rows = this.db.prepare(`SELECT * FROM learn_proposals WHERE ${where.join(" AND ")} ORDER BY created_at DESC`).all(...args);
    return (rows as unknown as ProposalRow[]).map(toProposal);
  }

  get(id: string): LearnProposal {
    const r = this.db.prepare("SELECT * FROM learn_proposals WHERE id = ? AND org_id = $org").get(id) as ProposalRow | undefined;
    if (!r) throw fail("proposal-not-found");
    return toProposal(r);
  }

  create(input: { languageId: string; title: string; summary: string; patch: unknown; evidence: unknown }): LearnProposal {
    assertLanguageInOrg(this.db, input.languageId);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO learn_proposals (org_id, id, language_id, status, title, summary, patch, evidence, created_at) VALUES ($org, ?, ?, 'open', ?, ?, ?, ?, ?)")
      .run(id, input.languageId, input.title, input.summary, JSON.stringify(input.patch ?? null), JSON.stringify(input.evidence ?? null), this.clock.now().toISOString());
    return this.get(id);
  }

  update(id: string, patch: { status?: LearnProposal["status"]; title?: string; summary?: string }): LearnProposal {
    const cur = this.get(id);
    const status = patch.status ?? cur.status;
    const decidedAt = patch.status && patch.status !== cur.status ? (status === "open" ? null : this.clock.now().toISOString()) : cur.decidedAt;
    this.db
      .prepare("UPDATE learn_proposals SET status = ?, title = ?, summary = ?, decided_at = ? WHERE id = ? AND org_id = $org")
      .run(status, patch.title ?? cur.title, patch.summary ?? cur.summary, decidedAt, id);
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    this.db.prepare("DELETE FROM learn_proposals WHERE id = ? AND org_id = $org").run(id);
  }
}

interface ProposalRow {
  id: string;
  language_id: string;
  status: LearnProposal["status"];
  title: string;
  summary: string;
  patch: string | null;
  evidence: string | null;
  created_at: string;
  decided_at: string | null;
}

function toProposal(r: ProposalRow): LearnProposal {
  return {
    id: r.id,
    languageId: r.language_id,
    status: r.status,
    title: r.title,
    summary: r.summary,
    patch: json(r.patch, null),
    evidence: json(r.evidence, null),
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}
