import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { defaultProfile } from "@tagpress/domain";
import { openDatabase } from "../db/database.ts";
import { TENANT_TABLES, type TenantTable } from "../org/tables.ts";

/**
 * Aktarım testlerinin kaynak veri klasörü: göç 14'te bir yerel kurulum (dosya düzeni 1: sahibin dosyaları kökte), 26 kiracı
 * tablosunun HEPSİNDE satır (zor değerlerle: emoji, Arapça, NUL'suz uzun metin, ikili, büyük tamsayı, kesirli sayı, boş), ikinci
 * bir firma (aktarılmamalı), kurulum ayarları ve kurulum düzeyi dosyalar (aktarılmamalı).
 */

export const OWNER = "01a20107-35cc-77c7-ac21-ea7ce3a6811f";
export const OTHER = "01a20107-35cc-77c7-ac21-ea7ce3a68aaa";
export const LANG = "benim-tarzim";
const T0 = "2026-10-09T19:40:26.288Z";

type Row = Record<string, unknown>;

/** Firma dosyaları (göreli yol → içerik) ve kurulum düzeyi dosyalar. */
export const OWNER_FILES: Record<string, string | Buffer> = {
  [`diller/${LANG}/sablonlar/12.png`]: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  [`diller/${LANG}/fontlar/Great Vibes.ttf`]: Buffer.alloc(2048, 7),
  [`referanslar/${LANG}/ref-1.png`]: Buffer.from("ref"),
  "onizleme/v1.png": Buffer.from("onizleme"),
  "onizleme/v1.adj1.png": Buffer.from("onizleme-adj"),
  [`aktarim/${LANG}/paket.json`]: JSON.stringify({ ad: "Benim tarzım ✨", dil: "اللهم" }),
  [`yedek/sablonlar/${LANG}/12-eski.png`]: Buffer.from("eski"),
  "baski/oturum-1/sayfa-1.pdf": Buffer.from("%PDF-1.7"),
};
export const INSTALL_FILES: Record<string, string> = {
  "ortak/fontlar/Twemoji.Mozilla.ttf": "font",
  "yedek/db-2026-10-10-son/studio.db": "eski veritabanı",
  "yedek/anahtarlar.dpapi.json": "{}",
  "ana-anahtar.json": "{\"gizli\":1}",
  ".gizli-not": "x",
  [`firmalar/${OTHER}/diller/baska/x.png`]: "başka firma",
};

function rowsFor(org: string): Partial<Record<TenantTable, Row[]>> {
  const profile = JSON.stringify(defaultProfile());
  const lang = org === OWNER ? LANG : "baska-dil";
  if (org !== OWNER) return { languages: [{ id: lang, name: "Başka", created_at: T0 }], org_settings: [{ key: "app", value: "{}" }] };
  return {
    languages: [{ id: LANG, name: "Benim tarzım", created_at: T0 }],
    profile_versions: [
      { id: "pv-1", language_id: LANG, version: 1, status: "published", data: profile, note: "ilk", created_at: T0, published_at: T0 },
      { id: "pv-2", language_id: LANG, version: 2, status: "draft", data: profile, created_at: T0 },
    ],
    templates: [{ language_id: LANG, key: "12", data: JSON.stringify({ key: "12", file: "12.png" }), created_at: T0, updated_at: T0 }],
    org_settings: [
      { key: "app", value: JSON.stringify({ defaultLanguageId: LANG, concurrency: 2 }) },
      { key: `print.presets.${LANG}`, value: "[]" },
      { key: "setup", value: JSON.stringify({ status: "completed" }) },
      { key: "platform.eski-isaret", value: "1" },
    ],
    undo: [{ token: "u-1", kind: "delete", label: "Sil", payload: "{}", created_at: T0, expires_at: T0 }],
    ai_calls: [
      { id: "ai-1", purpose: "design", model: "claude-opus-5-5", summary: "özet 🎉", response: new Uint8Array([0, 1, 2, 255]), input_tokens: 9007199254740993n, cost_usd: 0.1234567890123, created_at: T0 },
      { id: "ai-2", purpose: "rank", model: "m", summary: "", response: null, error: "hata", created_at: T0 },
    ],
    template_tasks: [{ id: "tt-1", language_id: LANG, status: "done", theme: "tema", created_at: T0, updated_at: T0 }],
    refs: [
      { id: "ref-2880-32717", language_id: LANG, data: JSON.stringify({ text: "Battesimo Diego", image: `referanslar/${LANG}/ref-1.png` }), split: "train", created_at: T0 },
      { id: "ref-2828-20281", language_id: LANG, data: JSON.stringify({ text: "اللهم أنبته نباتاً حسناً  Mohammad" }), split: "test", created_at: T0 },
    ],
    learn_proposals: [{ id: "lp-1", language_id: LANG, status: "open", title: "Öneri", created_at: T0 }],
    learn_runs: [
      { id: "lr-1", language_id: LANG, status: "done", base: "b", profile_version: 1, step: "s", done: 1, total: 2, message: "m", started_at: T0 },
      { id: "lr-0", language_id: LANG, status: "done", base: "b", profile_version: 1, step: "s", done: 0.5, total: 2, message: "m", started_at: T0 },
    ],
    design_sessions: [{ id: "ds-1", language_id: LANG, status: "open", started_at: T0, updated_at: T0, mode: "site", state: "published", cost_usd: 0.25 }],
    design_session_entries: [
      { id: 7, session_id: "ds-1", at: T0, kind: "question", text: "Soru?", data: JSON.stringify({ question: { entryId: 7 } }) },
      { id: 9, session_id: "ds-1", at: T0, kind: "answer", text: "Cevap" },
    ],
    design_samples: [{ id: "sm-1", session_id: "ds-1", language_id: LANG, seq: 1, name: "a.png", w: 10, h: 20, status: "measured", split: "train", created_at: T0 }],
    profile_revisions: [
      { id: 3, session_id: "ds-1", language_id: LANG, rev: 1, data: profile, changes: JSON.stringify([{ source: { kind: "answer", ref: "9" } }]), reason: "answer", entry_id: 9, created_at: T0 },
    ],
    design_session_turns: [{ id: 5, session_id: "ds-1", seq: 1, messages: deflateSync(Buffer.from("[]")), stop_reason: "end_turn", created_at: T0 }],
    batches: [{ id: "b-1", language_id: LANG, name: "Parti 1", created_at: T0 }],
    jobs: [
      { id: "j-1", batch_id: "b-1", seq: 1, raw: "{}", text_raw: "Ayşe & Ali ❤️", text: "Ayşe & Ali ❤️", status: "approved", dedupe_key: "d1", created_at: T0, updated_at: T0, approved_variant_id: "v-1" },
      { id: "j-2", batch_id: "b-1", seq: 2, raw: "{}", text_raw: "x", text: "x", status: "pending", dedupe_key: "d2", created_at: T0, updated_at: T0 },
    ],
    variants: [{ id: "v-1", job_id: "j-1", no: 1, kind: "auto", snapshot: "{}", preview_file: "v1.adj1.png", base_preview_file: "v1.png", score: -0.5, created_at: T0 }],
    gen_tasks: [
      { id: "g-2", job_id: "j-1", mode: "m", status: "done", created_at: T0 },
      { id: "g-1", job_id: "j-2", mode: "m", status: "done", created_at: T0 },
    ],
    job_log: [
      { id: 1, job_id: "j-1", step: "start", message: "başladı", at: T0 },
      { id: 2, job_id: "j-1", step: "done", message: "bitti", at: T0 },
      { id: 4, job_id: "j-2", step: "start", message: "başladı", at: T0 },
    ],
    adjust_log: [
      { id: 1, language_id: LANG, job_id: "j-1", variant_id: "v-1", rev: 1, frame_px: 440, adjust: "{}", target_x: 1.5, target_y: -2, target_source: "s", ink_before: "{}", ink_after: "{}", created_at: T0 },
    ],
    print_templates: [{ id: "pt-1", language_id: LANG, name: "A4", kind: "label", data: "{}", created_at: T0, updated_at: T0 }],
    print_sessions: [{ id: "ps-1", language_id: LANG, name: "Oturum", status: "printed", template_id: "pt-1", created_at: T0, updated_at: T0, printed_at: T0 }],
    print_exports: [{ id: "pe-1", session_id: "ps-1", format: "pdf", status: "done", created_at: T0 }],
    print_pages: [
      { id: "pp-2", session_id: "ps-1", template_id: "pt-1", idx: 0 },
      { id: "pp-1", session_id: "ps-1", template_id: "pt-1", idx: 1 },
    ],
    print_items: [{ id: "pi-1", page_id: "pp-2", job_id: "j-1", variant_id: "v-1", x_mm: 1.25, y_mm: 2.5 }],
  };
}

function fill(db: ReturnType<typeof openDatabase>, table: TenantTable, org: string, row: Row): void {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
  const full: Row = { ...row, org_id: org };
  for (const c of cols) {
    if (c.name in full || !c.notnull || c.dflt_value !== null) continue;
    const t = c.type.toUpperCase();
    full[c.name] = t.includes("INT") ? 1 : t.includes("REAL") ? 1.5 : t.includes("BLOB") ? new Uint8Array([1]) : `${c.name}-x`;
  }
  const names = Object.keys(full);
  db.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...(names.map((n) => full[n]) as never[]));
}

/** Kaynak veri klasörünü kurar (`dir` boş olmalı). Dönen değer sahibin satır sayıları. */
export function buildSource(dir: string): Record<TenantTable, number> {
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(path.join(dir, "studio.db"), { backupDir: null });
  const counts = {} as Record<TenantTable, number>;
  try {
    db.prepare("INSERT INTO orgs (id, name, source, created_at) VALUES (?, 'Firmam', 'local', ?), (?, 'İkinci', 'local', ?)").run(OWNER, T0, OTHER, T0);
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    set.run("install.ownerOrgId", JSON.stringify(OWNER));
    set.run("install.defaultOrgId", JSON.stringify(OWNER));
    set.run("key:anthropic", JSON.stringify({ format: "box", value: "gizli" }));
    for (const org of [OWNER, OTHER]) {
      const rows = rowsFor(org);
      for (const table of [...TENANT_TABLES].reverse()) {
        for (const r of rows[table] ?? []) fill(db, table, org, r);
        if (org === OWNER) counts[table] = (rows[table] ?? []).length;
      }
    }
    counts.org_settings -= 1; // `platform.*` aktarılmaz
  } finally {
    db.close();
  }
  for (const [rel, body] of [...Object.entries(OWNER_FILES), ...Object.entries(INSTALL_FILES)]) {
    const file = path.join(dir, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return counts;
}
