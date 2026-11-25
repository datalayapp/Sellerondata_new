/**
 * Merkez sağlayıcı testlerinin ortak senaryosu (yalnız test kodu). Satırlar `insert(tablo, satır)` ile yazılır: SQLite
 * düzeni (`sqliteHarness`) bugün; Postgres düzeni (TP-VERI'nin test yolu) aynı satırları kendi ham bağlantısıyla yazar,
 * böylece iki veritabanında aynı yanıt beklenir. Zamanlar sabit ISO metin; kimlikler okunur ve sabit.
 *
 * Firma saat dilimi Europe/Istanbul (+03:00): dönem sınırları firmanın gününe göre sınanır (`j-sinir-*`).
 * Müşteri metni (`MUSTERI`) iş satırlarında, ham satırda ve üretim günlüğünün iletisinde bilerek var: hiçbir Merkez yanıtında
 * görünmemeli.
 */
import { openDatabase } from "../../../db/database.ts";
import { TenantDb } from "../../../org/tenant-db.ts";
import { Tenancy } from "../../../org/tenancy.ts";
import { pgTestMode } from "../../../test/pg.ts";
import type { HubSqlDb } from "../sql.ts";
import { pgHarness } from "./pg-harness.ts";

export const ORG_A = "org-a";
export const ORG_B = "org-b";
export const ORG_EMPTY = "org-bos";
export const TIME_ZONE = "Europe/Istanbul";
/** Yanıtların "bugün"ü. */
export const NOW = new Date("2026-11-05T09:00:00.000Z");
export const OCT = { from: "2026-10-01", to: "2026-10-31" };
export const MUSTERI = "Ayşe & Mehmet 14.02";

export type Value = string | number | null;
export type Insert = (table: string, row: Record<string, Value>) => void;

export interface HubHarness {
  db: HubSqlDb;
  insert: Insert;
  close(): void | Promise<void>;
}

/** Koşunun veritabanıyla düzen: `pnpm test:pg` iken Postgres (`pg-harness.ts`), yoksa SQLite. */
export async function testHarness(): Promise<HubHarness> {
  return pgTestMode() ? pgHarness() : sqliteHarness();
}

/** Göç 14 (TP-SEMA) gelene kadar `member_id` sütunları SQLite'ta yoksa eklenir; göç 14 sonrası hiçbir şey yapmaz. */
const MEMBER_COLUMNS = ["job_log", "print_exports", "design_sessions", "ai_calls"];

export function sqliteHarness(): HubHarness {
  const raw = openDatabase(":memory:");
  for (const t of MEMBER_COLUMNS) {
    const cols = (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("member_id")) raw.exec(`ALTER TABLE ${t} ADD COLUMN member_id TEXT`);
  }
  const insert: Insert = (table, row) => {
    const keys = Object.keys(row);
    raw.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k] ?? null));
  };
  return { db: new TenantDb(raw, new Tenancy({ mode: "strict" })), insert, close: () => raw.close() };
}

const json = (v: unknown) => JSON.stringify(v);

function org(insert: Insert, id: string, name: string) {
  insert("orgs", { id, name, source: "account", created_at: "2026-09-01T08:00:00.000Z" });
}

function language(insert: Insert, orgId: string, id: string, name: string, published: { version: number; at: string }[], deletedAt: string | null = null) {
  insert("languages", { org_id: orgId, id, name, created_at: published[0]?.at ?? "2026-09-01T09:00:00.000Z", deleted_at: deletedAt });
  for (const p of published) {
    insert("profile_versions", { org_id: orgId, id: `${id}-v${p.version}`, language_id: id, version: p.version, status: "published", data: "{}", created_at: p.at, published_at: p.at });
  }
}

function batch(insert: Insert, orgId: string, id: string, languageId: string, createdAt: string, deletedAt: string | null = null) {
  insert("batches", { org_id: orgId, id, language_id: languageId, name: `${id}.csv`, created_at: createdAt, deleted_at: deletedAt });
}

let seq = 0;
function job(
  insert: Insert,
  orgId: string,
  id: string,
  batchId: string,
  o: { status: string; created: string; updated?: string; orderNo?: string | null; product?: string | null; quantity?: number | null; kind?: string; runIssues?: unknown[]; deleted?: string },
) {
  seq += 1;
  insert("jobs", {
    org_id: orgId,
    id,
    batch_id: batchId,
    seq,
    raw: json({ text: MUSTERI, note: `Not: ${MUSTERI}` }),
    order_no: o.orderNo === undefined ? `ETSY-${1000 + seq}` : o.orderNo,
    quantity: o.quantity === undefined ? 1 : o.quantity,
    product: o.product === undefined ? "Kolye etiketi" : o.product,
    text_raw: MUSTERI,
    text: MUSTERI,
    kind: o.kind ?? "label",
    status: o.status,
    run_issues: json(o.runIssues ?? []),
    dedupe_key: `${id}-key`,
    created_at: o.created,
    updated_at: o.updated ?? o.created,
    deleted_at: o.deleted ?? null,
  });
}

/** A firması: iki dil (biri sonradan eklendi), silinmiş dil, işler, kuyruk, baskı, çıktı, yapay zekâ, günlük, oturum, kurulum. */
export function seedOrgA(insert: Insert): void {
  seq = 0;
  org(insert, ORG_A, "Örnek Atölye");
  language(insert, ORG_A, "dil-zarif", "Zarif", [
    { version: 1, at: "2026-09-01T09:00:00.000Z" },
    { version: 2, at: "2026-10-03T10:00:00.000Z" },
  ]);
  language(insert, ORG_A, "dil-cocuk", "Çocuk", [{ version: 1, at: "2026-10-20T10:00:00.000Z" }]);
  language(insert, ORG_A, "dil-eski", "Eski", [{ version: 1, at: "2026-09-02T09:00:00.000Z" }], "2026-09-10T09:00:00.000Z");

  batch(insert, ORG_A, "parti-1", "dil-zarif", "2026-09-15T08:00:00.000Z");
  batch(insert, ORG_A, "parti-2", "dil-cocuk", "2026-10-21T08:00:00.000Z");
  batch(insert, ORG_A, "parti-silinen", "dil-zarif", "2026-10-02T08:00:00.000Z", "2026-10-03T08:00:00.000Z");

  job(insert, ORG_A, "j-onay-1", "parti-1", { status: "approved", created: "2026-10-02T08:00:00.000Z", updated: "2026-10-04T12:00:00.000Z", quantity: 2 });
  job(insert, ORG_A, "j-hazir", "parti-1", { status: "ready", created: "2026-10-05T08:00:00.000Z" });
  job(insert, ORG_A, "j-hata", "parti-1", { status: "failed", created: "2026-10-06T08:00:00.000Z", orderNo: null });
  job(insert, ORG_A, "j-onay-2", "parti-2", { status: "approved", created: "2026-10-21T08:00:00.000Z", updated: "2026-10-22T09:00:00.000Z", kind: "sticker", product: "Bebek sticker" });
  job(insert, ORG_A, "j-dusen", "parti-2", {
    status: "ready",
    created: "2026-10-22T08:00:00.000Z",
    runIssues: [{ code: "template-cut-changed", message: "Şablonun kesimi değişti", severity: "warning", fixes: [] }],
  });
  job(insert, ORG_A, "j-eylul", "parti-1", { status: "approved", created: "2026-09-15T08:00:00.000Z", updated: "2026-09-16T08:00:00.000Z" });
  job(insert, ORG_A, "j-sirada", "parti-1", { status: "queued", created: "2026-11-04T08:00:00.000Z" });
  job(insert, ORG_A, "j-silinen", "parti-1", { status: "approved", created: "2026-10-07T08:00:00.000Z", updated: "2026-10-07T09:00:00.000Z", deleted: "2026-10-08T08:00:00.000Z" });
  job(insert, ORG_A, "j-silinen-parti", "parti-silinen", { status: "approved", created: "2026-10-02T08:30:00.000Z", updated: "2026-10-02T09:00:00.000Z" });
  // Gün sınırı (İstanbul +03:00): 31 Ekim 21:30 UTC = 1 Kasım 00:30 (dönem dışı); 30 Eylül 21:30 UTC = 1 Ekim 00:30 (dönem içi).
  job(insert, ORG_A, "j-sinir-kasim", "parti-1", { status: "new", created: "2026-10-31T21:30:00.000Z" });
  job(insert, ORG_A, "j-sinir-ekim", "parti-1", { status: "new", created: "2026-09-30T21:30:00.000Z" });

  insert("gen_tasks", { org_id: ORG_A, id: "g-sira", job_id: "j-sirada", mode: "text", status: "queued", created_at: "2026-11-05T08:55:00.000Z" });
  insert("gen_tasks", { org_id: ORG_A, id: "g-takili", job_id: "j-hata", mode: "text", status: "running", attempts: 1, created_at: "2026-11-05T08:20:00.000Z", started_at: "2026-11-05T08:30:00.000Z" });
  insert("gen_tasks", { org_id: ORG_A, id: "g-bitti", job_id: "j-onay-1", mode: "text", status: "done", created_at: "2026-10-02T08:01:00.000Z", finished_at: "2026-10-02T08:05:00.000Z" });

  insert("variants", { org_id: ORG_A, id: "v-1", job_id: "j-onay-1", no: 1, kind: "text", snapshot: "{}", preview_file: "v-1.png", created_at: "2026-10-02T08:05:00.000Z" });
  insert("print_sessions", {
    org_id: ORG_A,
    id: "baski-1",
    language_id: "dil-zarif",
    name: "Ekim baskısı",
    status: "printed",
    job_ids: json(["j-onay-1"]),
    created_at: "2026-10-09T08:00:00.000Z",
    updated_at: "2026-10-10T10:00:00.000Z",
    printed_at: "2026-10-10T10:00:00.000Z",
  });
  insert("print_pages", { org_id: ORG_A, id: "sayfa-1", session_id: "baski-1", template_id: "pt-1", idx: 0, copies: 2 });
  insert("print_pages", { org_id: ORG_A, id: "sayfa-2", session_id: "baski-1", template_id: "pt-1", idx: 1, copies: 1 });
  insert("print_pages", { org_id: ORG_A, id: "sayfa-silinen", session_id: "baski-1", template_id: "pt-1", idx: 2, copies: 5, deleted_at: "2026-10-09T09:00:00.000Z" });
  insert("print_items", { org_id: ORG_A, id: "oge-1", page_id: "sayfa-1", job_id: "j-onay-1", variant_id: "v-1", x_mm: 0, y_mm: 0 });
  insert("print_sessions", {
    org_id: ORG_A,
    id: "baski-taslak",
    language_id: "dil-cocuk",
    name: "Kasım taslağı",
    status: "draft",
    job_ids: json(["j-onay-2"]),
    created_at: "2026-11-02T08:00:00.000Z",
    updated_at: "2026-11-03T08:00:00.000Z",
  });
  insert("print_pages", { org_id: ORG_A, id: "sayfa-taslak", session_id: "baski-taslak", template_id: "pt-1", idx: 0, copies: 1 });
  insert("print_exports", { org_id: ORG_A, id: "cikti-1", session_id: "baski-1", format: "pdf", status: "done", done: 2, total: 2, created_at: "2026-10-10T10:01:00.000Z", finished_at: "2026-10-10T10:05:00.000Z", member_id: "m-1" });
  insert("print_exports", { org_id: ORG_A, id: "cikti-2", session_id: "baski-1", format: "png", status: "failed", error: "motor", created_at: "2026-10-11T10:00:00.000Z", finished_at: "2026-10-11T10:01:00.000Z", member_id: null });

  const call = (id: string, purpose: string, at: string, o: { language?: string | null; error?: string | null } = {}) =>
    insert("ai_calls", { org_id: ORG_A, id, purpose, model: "claude-haiku-5-5", summary: `${purpose} özeti`, language_id: o.language === undefined ? "dil-zarif" : o.language, error: o.error ?? null, created_at: at });
  call("ai-1", "design", "2026-10-02T08:02:00.000Z");
  call("ai-2", "rank", "2026-10-02T08:03:00.000Z");
  call("ai-3", "builder-turn", "2026-10-20T09:00:00.000Z", { language: "dil-cocuk", error: "529" });
  call("ai-4", "sablon-design", "2026-10-25T09:00:00.000Z", { language: null });
  call("ai-eylul", "design", "2026-09-15T08:02:00.000Z");

  insert("job_log", { org_id: ORG_A, id: 1, job_id: "j-onay-1", task_id: "g-bitti", step: "ai", message: `Revizyon isteniyor: "${MUSTERI}"`, at: "2026-10-02T08:01:30.000Z", member_id: "m-1" });
  insert("job_log", { org_id: ORG_A, id: 2, job_id: "j-onay-1", task_id: "g-bitti", step: "done", message: "Varyasyon hazır", at: "2026-10-02T08:05:00.000Z", member_id: "m-1" });
  insert("job_log", { org_id: ORG_A, id: 3, job_id: "j-hata", task_id: null, step: "error", message: `Hata: ${MUSTERI}`, at: "2026-10-06T08:10:00.000Z", member_id: "m-silinmis" });

  insert("design_sessions", {
    org_id: ORG_A,
    id: "oturum-1",
    language_id: "dil-cocuk",
    title: "Çocuk dili",
    status: "idle",
    started_at: "2026-10-19T09:00:00.000Z",
    updated_at: "2026-10-20T10:30:00.000Z",
    mode: "site",
    state: "published",
    member_id: "m-2",
  });
  insert("design_sessions", { org_id: ORG_A, id: "oturum-mcp", language_id: "dil-zarif", title: "MCP", status: "done", started_at: "2026-10-01T09:00:00.000Z", updated_at: "2026-10-01T10:00:00.000Z", mode: "mcp" });

  insert("org_settings", { org_id: ORG_A, key: "setup", value: json({ status: "completed", step: 3, answers: { labelTypes: [] }, completedAt: "2026-09-01T08:30:00.000Z", skipped: false }) });

  const tpl = (languageId: string, key: string, data: Record<string, unknown>, updated: string) =>
    insert("templates", { org_id: ORG_A, language_id: languageId, key, data: json({ key, languageId, file: `${key}.png`, width: 40, height: 40, ...data }), created_at: updated, updated_at: updated });
  tpl("dil-zarif", "a1", { kind: "label", cut: null }, "2026-09-01T09:00:00.000Z");
  tpl("dil-zarif", "yuvarlak", { kind: "label", cut: { shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 } }, "2026-10-12T09:00:00.000Z");
  tpl("dil-cocuk", "s1", { kind: "sticker", cut: { shape: "roundRect", wMm: 63.5, hMm: 38.1, radiusMm: 3 } }, "2026-10-20T09:00:00.000Z");
  tpl("dil-eski", "eski", { kind: "label", cut: null }, "2026-09-02T09:00:00.000Z");
}

/** B firması: aynı kimlik düzeninde başka satırlar (izolasyon: A'nın yanıtında görünmemeli). */
export function seedOrgB(insert: Insert): void {
  org(insert, ORG_B, "Başka Firma");
  language(insert, ORG_B, "dil-b", "B Dili", [{ version: 1, at: "2026-10-01T09:00:00.000Z" }]);
  batch(insert, ORG_B, "parti-b", "dil-b", "2026-10-01T09:00:00.000Z");
  for (let i = 0; i < 4; i++) {
    insert("jobs", {
      org_id: ORG_B,
      id: `jb-${i}`,
      batch_id: "parti-b",
      seq: i + 1,
      raw: "{}",
      order_no: `B-${i}`,
      text_raw: "B metni",
      text: "B metni",
      status: i < 3 ? "approved" : "failed",
      dedupe_key: `jb-${i}`,
      created_at: "2026-10-03T09:00:00.000Z",
      updated_at: "2026-10-03T10:00:00.000Z",
    });
  }
  insert("gen_tasks", { org_id: ORG_B, id: "gb-1", job_id: "jb-3", mode: "text", status: "queued", created_at: "2026-11-05T08:00:00.000Z" });
  insert("ai_calls", { org_id: ORG_B, id: "ai-b", purpose: "design", model: "m", summary: "b", language_id: "dil-b", created_at: "2026-10-03T09:00:00.000Z" });
  insert("job_log", { org_id: ORG_B, id: 100, job_id: "jb-0", step: "done", message: "B", at: "2026-10-03T09:30:00.000Z", member_id: null });
}

/** Boş firma: yalnız firma kaydı. */
export function seedEmpty(insert: Insert): void {
  org(insert, ORG_EMPTY, "Boş Firma");
}

/** Etkinlikteki kişi adları (Merkez izdüşümünün yerine). `m-silinmis` bilinmiyor: `actor` null. */
export const MEMBER_NAMES: Record<string, string> = { "m-1": "Elif Demir", "m-2": "Can Kaya" };
