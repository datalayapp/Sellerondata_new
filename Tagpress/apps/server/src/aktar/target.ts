import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AppSettingsSchema, DEFAULT_LANGUAGE_NAME, TemplateSchema } from "@tagpress/domain";
import type pg from "pg";
import { PG_SCHEMA } from "../db/pg/migrate.ts";
import { SEEDED_KEY } from "../org/platform-service.ts";
import { DEFAULT_CONTENT_DIR, readTemplateManifest } from "../org/seed.ts";
import { TENANT_TABLES, type TenantTable } from "../org/tables.ts";
import { pngSize, sha1 } from "../util/files.ts";
import { type SourceSnapshot, readSourceTable } from "./source.ts";

/**
 * Aktarımın veritabanı adımı (plan §S12): kaynak firmanın 26 kiracı tablosu hedef firmaya TEK işlemde yazılır.
 * - Uygulama rolüyle (`sod_tagpress`, RLS altında; süper kullanıcı ya da RLS'yi aşan rol reddedilir) ve işlem başında
 *   `app.org_id` = hedef firma: araç başka firmanın satırını göremez ve yazamaz.
 * - Aktarım yalnız TagPress uygulaması DURMUŞKEN yapılır (sarmalayıcı `tagpress-api`'yi durdurur): aynı rolle bu veritabanına
 *   bağlı başka oturum varsa işlemin başında ve commit'ten hemen önce reddedilir. Ayrıca işlemin ilk adımı 26 kiracı tablosunu
 *   `SHARE ROW EXCLUSIVE` kipte kilitler: aktarım süresince bu tablolara kimse yazamaz (okuma serbest; o anda yazan işlem varsa
 *   `lock_timeout` sonunda reddedilir). Uygulama READ COMMITTED yazdığından `SERIALIZABLE` tek başına onun yazısını yakalamaz
 *   (R4); koruma bağlantı denetimi ve kilittir.
 * - Hedef firma `Company`'de olmalı (TagPress Merkez'den bir kez açılmış), kapalı olmamalı. Hedefte aktarım işareti varsa
 *   (`platform.aktarim`) ikinci koşu reddedilir. Hedefte TagPress verisi varsa reddedilir; tek istisna yalnız ilk açılışın
 *   DEĞİŞTİRİLMEMİŞ varsayılan içeriğinden oluşan firma: `platform.seeded` işaretli dil (adı varsayılan, silinmemiş), onun
 *   yayımlanmış v1 sürümü, ürünle gelen paketle birebir aynı şablonları (`updated_at = created_at`, `file_missing = 0`, kayıt
 *   paketten üretilenle aynı), firma ayarlarında yalnız `platform.seeded` ve varsayılan `app` (varsayılan dil dışında hepsi
 *   varsayılan); dilin klasöründe yalnız `assets/varsayilan` dosyaları (ad ve özetle aynı; `transfer.ts`). Bu içerik (yalnız o)
 *   aynı işlemde silinir, yerine kaynak yazılır. Kullanıcının platformda yaptığı herhangi bir değişiklik (şablon düzenleme,
 *   font yükleme, ayar …) varsa açık iletiyle reddedilir; hiçbir şey silinmez.
 * - Sütunlar adla eşlenir (şema eşliği: SQLite = Postgres, Postgres'e özgü yalnız `ins_seq`); `org_id` = hedef, `member_id`
 *   boş (yerel kipte üye yok). Kimlik sütunları: `design_session_entries.id` korunur (oluşturucu kayıtları ve konuşma geçmişi
 *   bu numaralara başvurur; dizi aynı işlemde ileri alınır; numara kurulum genelinde tek sayaçtan verildiğinden platformda başka
 *   firma tasarım oturumu kullandıysa çakışabilir: o zaman nedenini ve yapılacağı söyleyen iletiyle reddedilir), başvurulmayan sayaç kimlikleri (`job_log`, `adjust_log`,
 *   `profile_revisions`, `design_session_turns`) ve `ins_seq` hedefte yeniden verilir (kaynak sırasıyla eklenir, sıra korunur;
 *   başka firmanın numaralarıyla çakışmaz). Kurulum tablosu (`settings`: anahtarlar, `install.*`) aktarılmaz; firma
 *   ayarlarından `platform.*` (platformun kendi işaretleri) aktarılmaz.
 * - Doğrulama commit'ten önce: her tabloda satır sayısı ve içerik (sütun sütun, sıra bağımsız) kaynakla aynı; değilse geri alınır.
 */

export const TRANSFER_KEY = "platform.aktarim";
const S = `"${PG_SCHEMA}"`;
const T = (t: string) => `${S}."${t}"`;

/** Hedefte yeniden numaralanan kimlik sütunları (başvurulmuyor). */
const RENUMBERED: Partial<Record<TenantTable, string>> = { job_log: "id", adjust_log: "id", profile_revisions: "id", design_session_turns: "id" };
/** Korunan kimlik sütunu: dizi en az kaynaktaki en büyük değere ilerletilir. */
const KEPT_IDENTITY: Partial<Record<TenantTable, string>> = { design_session_entries: "id" };
const PG_ONLY = new Set(["ins_seq"]);
/** Varsayılan içerikte olabilecek tablolar. */
const SEED_TABLES = new Set<TenantTable>(["languages", "profile_versions", "templates", "org_settings"]);

export interface TableCount {
  table: TenantTable;
  source: number;
  target: number;
}

export interface TransferMarker {
  at: string;
  source: { orgId: string; name: string; dir: string; version: { from: number; to: number }; rawDigest: string };
  tables: Record<string, number>;
  files: { count: number; bytes: number; digest: string; state: "bekliyor" | "tamam"; doneAt?: string };
  /** Hedefte silinen ilk açılış içeriğinin dili (dosya adımı onun klasörünü siler; `--yalniz-dosyalar` yeniden denemesi de). */
  seed?: { languageId: string } | null;
}

export type TargetState =
  | { kind: "empty" }
  | { kind: "seed"; languageId: string | null; templates: number }
  /** `changed`: yalnız varsayılan içerik tablolarında satır var ama içerik platformda değiştirilmiş (ne değiştiği). */
  | { kind: "data"; tables: { table: TenantTable; rows: number }[]; changed?: string[] };

export interface ImportResult {
  company: { id: string; name: string };
  tables: TableCount[];
  state: TargetState;
  /** Aktarılmayan firma ayarları (`platform.*`). */
  skippedOrgSettings: string[];
  committed: boolean;
}

export interface ImportOptions {
  dryRun: boolean;
  now: () => Date;
  marker: Omit<TransferMarker, "at" | "tables">;
  /** Yazmadan önce, işlemin içinde: hedef dosya klasörünün denetimi (varsayılan içerikte dilin klasörü serbest). */
  checkTargetFiles: (state: TargetState) => void;
  log?: (msg: string) => void;
  /** Testler: tablo yazıldıktan sonra (yarıda kalan aktarımı denemek için hata fırlatabilir). */
  afterTable?: (table: TenantTable) => void | Promise<void>;
  /** Testler: işaret yazıldıktan sonra, son bağlantı denetiminden ve commit'ten önce. */
  beforeCommit?: () => void | Promise<void>;
}

export class TransferRefused extends Error {}

/** Bağlantının rolü RLS altında mı (süper kullanıcı / BYPASSRLS reddedilir). */
export async function assertRlsRole(client: pg.ClientBase): Promise<string> {
  const r = (await client.query<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT current_user AS "user", rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  )).rows[0];
  if (!r) throw new Error("Bağlantının rolü okunamadı.");
  if (r.rolsuper || r.rolbypassrls) {
    throw new TransferRefused(`Aktarım uygulama rolüyle (sod_tagpress, RLS altında) çalışır; bağlantı ${r.user} rolüyle (RLS'yi aşıyor). DATABASE_URL'i düzeltin.`);
  }
  return r.user;
}

/**
 * TagPress uygulaması durmuş mu: aynı rolle bu veritabanına bağlı başka oturum (uygulamanın havuzu, senkron köprüsü) varsa
 * reddedilir. Uygulama READ COMMITTED yazar; açıkken aktarım sırasında okuyup sonra yazdığı (ör. ilk açılışın varsayılan
 * içeriği, bir ayar) aktarılanın üstüne geçebilir (R4).
 */
export async function assertAppStopped(client: pg.ClientBase): Promise<void> {
  // Oturum listesi işlem içinde ilk okumada dondurulur: commit'ten önceki denetim güncel listeyi görsün.
  await client.query("SELECT pg_stat_clear_snapshot()");
  const n =(await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()`,
  )).rows[0]!.n;
  if (n) {
    throw new TransferRefused(
      `TagPress uygulaması veritabanına bağlı (aynı rolle ${n} bağlantı): açıkken yazdıkları aktarılanın üstüne geçebilir. Önce TagPress'i durdurun (docker compose stop tagpress-api; Platform\\scripts\\tagpress-aktar.ps1 bunu kendisi yapar ve sonra yeniden başlatır), sonra yeniden deneyin. Hiçbir şey yazılmadı.`,
    );
  }
}

/** Aktarım süresince kiracı tablolarına yazmayı durdurur (okuma serbest; işlem bitince kalkar). İşlemin ilk sorgusu olmalı. */
async function lockTenantTables(client: pg.ClientBase): Promise<void> {
  try {
    await client.query(`LOCK TABLE ${TENANT_TABLES.map(T).join(", ")} IN SHARE ROW EXCLUSIVE MODE`);
  } catch (err) {
    if ((err as { code?: string }).code === "55P03") {
      throw new TransferRefused("TagPress tabloları kilitlenemedi: o anda yazan bir işlem var (TagPress uygulaması açık mı?). Uygulamayı durdurup yeniden deneyin. Hiçbir şey yazılmadı.");
    }
    throw err;
  }
}

async function setOrg(client: pg.ClientBase, orgId: string): Promise<void> {
  await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.scope', '', true)", [orgId]);
}

async function readCompany(client: pg.ClientBase, orgId: string): Promise<{ id: string; name: string }> {
  const c = (await client.query<{ name: string; closedAt: Date | null }>(`SELECT "name", "closedAt" FROM ${T("Company")} WHERE "id" = $1`, [orgId])).rows[0];
  if (!c) throw new TransferRefused(`Hedef firma TagPress'te kayıtlı değil (${orgId}). Önce TagPress'i Merkez'den bu firmayla bir kez açın, sonra yeniden deneyin.`);
  if (c.closedAt) throw new TransferRefused(`Hedef firma kapalı (${orgId}); kapalı firmaya aktarılmaz.`);
  return { id: orgId, name: c.name };
}

export async function readTransferMarker(client: pg.ClientBase, orgId: string): Promise<TransferMarker | null> {
  const row = (await client.query<{ value: string }>(`SELECT "value" FROM ${T("org_settings")} WHERE org_id = $1 AND "key" = $2`, [orgId, TRANSFER_KEY])).rows[0];
  if (!row) return null;
  return JSON.parse(row.value) as TransferMarker;
}

async function writeSetting(client: pg.ClientBase, orgId: string, key: string, value: unknown): Promise<void> {
  await client.query(
    `INSERT INTO ${T("org_settings")} (org_id, "key", "value") VALUES ($1, $2, $3) ON CONFLICT (org_id, "key") DO UPDATE SET "value" = excluded."value"`,
    [orgId, key, JSON.stringify(value)],
  );
}

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
};

/** Ürünle gelen şablon kayıtları (anahtar → kayıt), `seedDefaultContent` + `TemplateService.upsert`'in yazdığı biçimde. */
export function defaultTemplateRecords(languageId: string, contentDir = DEFAULT_CONTENT_DIR): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const t of readTemplateManifest(contentDir).sablonlar) {
    const png = readFileSync(path.join(contentDir, "sablonlar", t.file));
    const size = pngSize(png);
    if (!size) throw new Error(`Varsayılan şablon PNG değil: ${t.file}`);
    const rec = TemplateSchema.loose().parse({ ...t, languageId, hash: sha1(png), width: size.width, height: size.height }) as Record<string, unknown>;
    delete rec.figma; // `TemplateService` kaldırılmış alanı yazmaz
    out.set(t.key, JSON.parse(JSON.stringify({ ...rec, languageId })) as unknown);
  }
  return out;
}

/** Varsayılan `app` ayarı mı (varsayılan dil dışında her değer şema varsayılanı). */
function isDefaultAppSettings(value: string, languageId: string): boolean {
  const got = AppSettingsSchema.safeParse(parseJson(value));
  return got.success && isDeepStrictEqual(got.data, AppSettingsSchema.parse({ defaultLanguageId: languageId }));
}

/** Hedef firmanın durumu: boş, yalnız (değiştirilmemiş) varsayılan içerik ya da veri var. */
async function inspectTarget(client: pg.ClientBase, orgId: string): Promise<TargetState> {
  const counts = new Map<TenantTable, number>();
  for (const t of TENANT_TABLES) counts.set(t, Number((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T(t)} WHERE org_id = $1`, [orgId])).rows[0]!.n));
  const nonEmpty = TENANT_TABLES.filter((t) => counts.get(t)! > 0).map((t) => ({ table: t, rows: counts.get(t)! }));
  if (!nonEmpty.length) return { kind: "empty" };
  const data: TargetState = { kind: "data", tables: nonEmpty };
  if (nonEmpty.some((x) => !SEED_TABLES.has(x.table))) return data;

  const settings = (await client.query<{ key: string; value: string }>(`SELECT "key", "value" FROM ${T("org_settings")} WHERE org_id = $1 ORDER BY "key"`, [orgId])).rows;
  const seededRaw = settings.find((s) => s.key === SEEDED_KEY);
  if (!seededRaw) return data;
  const seededVal = parseJson(seededRaw.value) as { languageId?: unknown } | undefined;
  if (!seededVal || typeof seededVal !== "object") return data;
  const languageId = typeof seededVal.languageId === "string" ? seededVal.languageId : null;

  // Kullanıcının platformda yaptığı her değişiklik (ne olduğu iletide): varsa hiçbir şey silinmez.
  const changed: string[] = [];
  for (const s of settings) {
    if (s.key === SEEDED_KEY) continue;
    if (s.key === "app" && languageId && isDefaultAppSettings(s.value, languageId)) continue;
    changed.push(`firma ayarı ${s.key}`);
  }
  const langs = (await client.query<{ id: string; name: string; deleted_at: string | null }>(`SELECT id, name, deleted_at FROM ${T("languages")} WHERE org_id = $1 ORDER BY id`, [orgId])).rows;
  for (const l of langs) {
    if (l.id !== languageId) changed.push(`dil ${l.id} eklenmiş`);
    else if (l.deleted_at) changed.push(`varsayılan dil silinmiş`);
    else if (l.name !== DEFAULT_LANGUAGE_NAME) changed.push(`varsayılan dilin adı değiştirilmiş ("${l.name}")`);
  }
  const versions = (await client.query<{ language_id: string; version: string; status: string }>(`SELECT language_id, version, status FROM ${T("profile_versions")} WHERE org_id = $1 ORDER BY version`, [orgId])).rows;
  for (const v of versions) {
    if (v.language_id !== languageId || Number(v.version) !== 1 || v.status !== "published") changed.push(`tasarım dili düzenlenmiş (sürüm ${v.version}, ${v.status})`);
  }
  const expected = languageId ? defaultTemplateRecords(languageId) : new Map<string, unknown>();
  const templates = (await client.query<{ language_id: string; key: string; data: string; file_missing: string; created_at: string; updated_at: string }>(
    `SELECT language_id, "key", data, file_missing, created_at, updated_at FROM ${T("templates")} WHERE org_id = $1 ORDER BY "key"`,
    [orgId],
  )).rows;
  for (const t of templates) {
    const want = t.language_id === languageId ? expected.get(t.key) : undefined;
    if (want === undefined) changed.push(`şablon ${t.key} eklenmiş`);
    else if (Number(t.file_missing) !== 0) changed.push(`şablon ${t.key} dosyası eksik`);
    else if (t.updated_at !== t.created_at || !isDeepStrictEqual(parseJson(t.data), want)) changed.push(`şablon ${t.key} düzenlenmiş`);
  }
  if (changed.length) return { ...data, changed };
  return { kind: "seed", languageId, templates: templates.length };
}

/** Yalnız varsayılan içeriği siler (durumu `inspectTarget` doğruladı; aynı işlem). */
async function removeSeed(client: pg.ClientBase, orgId: string): Promise<void> {
  for (const t of ["templates", "profile_versions", "languages", "org_settings"] as const) await client.query(`DELETE FROM ${T(t)} WHERE org_id = $1`, [orgId]);
}

// ---------------------------------------------------------------------------------------------------------------- değerler

type PgColumn = { name: string; type: string };

async function pgColumns(client: pg.ClientBase): Promise<Map<string, PgColumn[]>> {
  const rows = (await client.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
    [PG_SCHEMA],
  )).rows;
  const out = new Map<string, PgColumn[]>();
  for (const r of rows) out.set(r.table_name, [...(out.get(r.table_name) ?? []), { name: r.column_name, type: r.data_type }]);
  return out;
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/** SQLite değeri → Postgres parametresi. Metin sütununda ikili veri ya da sayı sütununda ikili veri durdurur (sessiz bozulma yok). */
function toPg(v: unknown, col: PgColumn, where: string): unknown {
  if (v === null || v === undefined) return null;
  if (col.type === "bytea") {
    if (isBytes(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (typeof v === "string") return Buffer.from(v, "utf8");
    throw new Error(`${where}: ikili sütunda ${typeof v} değer`);
  }
  if (isBytes(v)) throw new Error(`${where}: ${col.type} sütununda ikili veri (aktarılamaz; kaynağı denetleyin)`);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "string") return v;
  throw new Error(`${where}: tanınmayan değer türü ${typeof v}`);
}

/** Karşılaştırma biçimi (iki veritabanında aynı değer aynı metni verir). */
function canon(values: readonly unknown[]): string {
  return JSON.stringify(values.map((v) => (v === null || v === undefined ? null : isBytes(v) ? { b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex") } : String(v))));
}

function describePgError(err: unknown, table: string): Error {
  const e = err as { code?: string; constraint?: string; detail?: string; message?: string };
  const tail = e.constraint ? ` (${e.constraint})` : "";
  if (e.code === "23505" && table === "design_session_entries") {
    // Üst tablolar (dil, oturum: metin kimlikli) sorunsuz yazıldıysa bu veri başka firmaya aktarılmamıştır: çakışma sayaçtan.
    return new TransferRefused(
      "Tasarım oturumu kayıtlarının numaraları (design_session_entries) bu platformda başka bir firmanın kayıtlarıyla çakışıyor: bu numaralar bütün firmalarda tek sayaçtan verilir ve platformda başka bir firma tasarım oturumu kullanmış. Kaynaktaki kayıtlar numaralarıyla aktarılmak zorunda (oluşturucu kayıtları ve konuşma geçmişi bu numaralara başvurur). Hiçbir şey yazılmadı. Ne yapılmalı: kaynaktaki tasarım oturumları gerekmiyorsa yerel TagPress'te silip aktarımı yeniden deneyin; gerekiyorsa aktarım bu kurulumda yapılamaz, geliştiriciye bildirin.",
    );
  }
  if (e.code === "23505") {
    return new TransferRefused(
      `Kimlik çakışması: ${table}${tail}. Aynı kayıt hedef veritabanında başka bir firmada zaten var; bu veri daha önce başka bir firmaya aktarılmış olabilir. Hiçbir şey yazılmadı.`,
    );
  }
  if (e.code === "23503") return new Error(`Kaynakta bağlantısı kopuk kayıt: ${table}${tail}${e.detail ? `: ${e.detail}` : ""}. Hiçbir şey yazılmadı.`);
  if (e.code === "40001") return new TransferRefused("Hedef firma aktarım sırasında değişti (TagPress o anda açık mıydı?). Hiçbir şey yazılmadı; uygulamayı durdurup yeniden deneyin.");
  return new Error(`${table}: ${e.message ?? String(err)}`, { cause: err });
}

// ---------------------------------------------------------------------------------------------------------------- aktarım

async function advanceSequence(client: pg.ClientBase, table: TenantTable, column: string, max: bigint): Promise<void> {
  const seq = (await client.query<{ s: string | null }>("SELECT pg_get_serial_sequence($1, $2) AS s", [T(table), column])).rows[0]?.s;
  if (!seq) throw new Error(`${table}.${column}: kimlik dizisi bulunamadı`);
  // Uygulama rolünde dizide yalnız değer alma hakkı var (setval yok): dizi nextval ile ilerletilir (boşluk zararsız).
  const v = BigInt((await client.query<{ v: string }>("SELECT nextval($1::regclass) AS v", [seq])).rows[0]!.v);
  if (v < max) await client.query("SELECT max(nextval($1::regclass)) FROM generate_series(1, $2::bigint)", [seq, (max - v).toString()]);
}

async function insertTable(client: pg.ClientBase, snap: SourceSnapshot, table: TenantTable, pgCols: PgColumn[], orgId: string): Promise<{ source: string[]; compare: string[] }> {
  const src = readSourceTable(snap, table);
  const pgByName = new Map(pgCols.map((c) => [c.name, c]));
  const missing = src.columns.filter((c) => !pgByName.has(c));
  const extra = pgCols.map((c) => c.name).filter((c) => !src.columns.includes(c) && !PG_ONLY.has(c));
  if (missing.length || extra.length) {
    throw new Error(`Şema eşleşmiyor: ${table} (yalnız kaynakta: ${missing.join(", ") || "-"}; yalnız hedefte: ${extra.join(", ") || "-"}). Aracı ve göçleri güncelleyin.`);
  }
  const renumbered = RENUMBERED[table];
  const insertCols = src.columns.filter((c) => c !== renumbered);
  // Karşılaştırılan sütunlar: hedefte değiştirilenler (firma, üye, yeniden numaralanan kimlik) dışında hepsi.
  const compareCols = insertCols.filter((c) => c !== "org_id" && c !== "member_id");
  const idx = new Map(src.columns.map((c, i) => [c, i]));
  const params = src.rows.map((row) =>
    insertCols.map((c) => {
      if (c === "org_id") return orgId;
      if (c === "member_id") return null;
      return toPg(row[idx.get(c)!], pgByName.get(c)!, `${table}.${c}`);
    }),
  );
  const kept = KEPT_IDENTITY[table];
  if (kept && src.rows.length) {
    const max = src.rows.reduce<bigint>((m, r) => {
      const v = BigInt(r[idx.get(kept)!] as bigint | number);
      return v > m ? v : m;
    }, 0n);
    await advanceSequence(client, table, kept, max);
  }
  const n = insertCols.length;
  const per = Math.max(1, Math.min(500, Math.floor(30000 / n)));
  const list = insertCols.map((c) => `"${c}"`).join(", ");
  for (let i = 0; i < params.length; i += per) {
    const chunk = params.slice(i, i + per);
    const values = chunk.map((_, r) => `(${insertCols.map((__, c) => `$${r * n + c + 1}`).join(", ")})`).join(", ");
    try {
      await client.query(`INSERT INTO ${T(table)} (${list}) VALUES ${values}`, chunk.flat());
    } catch (err) {
      throw describePgError(err, table);
    }
  }
  const sourceCanon = src.rows.map((row) => canon(compareCols.map((c) => {
    const v = row[idx.get(c)!];
    return pgByName.get(c)!.type === "bytea" && typeof v === "string" ? Buffer.from(v, "utf8") : v;
  }))).sort();
  return { source: sourceCanon, compare: compareCols };
}

/** Tek işlemde veritabanı aktarımı. `dryRun`: her şey yazılır ve doğrulanır, sonra geri alınır. */
export async function importDatabase(client: pg.ClientBase, snap: SourceSnapshot, orgId: string, opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  let open = true;
  try {
    await client.query("SET LOCAL statement_timeout = '300s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    // Kilit ilk sorgu: işlemin anlık görüntüsü kilitten SONRA alınır (o ana kadar commit edilmiş her yazı görünür).
    await lockTenantTables(client);
    await assertAppStopped(client);
    await setOrg(client, orgId);
    const company = await readCompany(client, orgId);
    const prev = await readTransferMarker(client, orgId);
    if (prev) {
      const filesNote = prev.files.state === "tamam" ? "" : " Dosyalar tamamlanmamış: --yalniz-dosyalar ile yeniden deneyin.";
      throw new TransferRefused(`Bu firmaya aktarım zaten yapılmış (${prev.at}, kaynak ${prev.source.dir}). İkinci aktarım yapılmaz.${filesNote}`);
    }
    const state = await inspectTarget(client, orgId);
    if (state.kind === "data" && state.changed) {
      throw new TransferRefused(
        `Hedef firmada TagPress verisi var: ilk açılış içeriği platformda değiştirilmiş (${state.changed.slice(0, 8).join("; ")}${state.changed.length > 8 ? " …" : ""}). Kullanıcının işi silinmez; aktarım yalnız boş ya da hiç kullanılmamış firmaya yapılır. Hiçbir şey yazılmadı.`,
      );
    }
    if (state.kind === "data") {
      throw new TransferRefused(
        `Hedef firmada TagPress verisi var (${state.tables.map((t) => `${t.table} ${t.rows}`).join(", ")}); dolu firmaya aktarılmaz. Hiçbir şey yazılmadı.`,
      );
    }
    opts.checkTargetFiles(state);
    if (state.kind === "seed") {
      log(`hedefte yalnız ilk açılışın varsayılan içeriği var (dil ${state.languageId ?? "-"}, ${state.templates} şablon): silinip yerine kaynak yazılıyor`);
      await removeSeed(client, orgId);
    }

    const columns = await pgColumns(client);
    const tables: TableCount[] = [];
    const skippedOrgSettings: string[] = [];
    // Ebeveyn önce (`TENANT_TABLES` silme sırasıdır, çocuk önce).
    for (const table of [...TENANT_TABLES].reverse()) {
      const pgCols = columns.get(table);
      if (!pgCols) throw new Error(`Hedef şemada tablo yok: ${table} (göçler uygulanmış mı?)`);
      let res: { source: string[]; compare: string[] };
      if (table === "org_settings") {
        const all = readSourceTable(snap, table);
        const keyAt = all.columns.indexOf("key");
        for (const r of all.rows) if (String(r[keyAt]).startsWith("platform.")) skippedOrgSettings.push(String(r[keyAt]));
        res = await insertOrgSettings(client, snap, pgCols, orgId);
      } else {
        res = await insertTable(client, snap, table, pgCols, orgId);
      }
      const back = (await client.query({ text: `SELECT ${res.compare.map((c) => `"${c}"`).join(", ")} FROM ${T(table)} WHERE org_id = $1`, values: [orgId], rowMode: "array" })).rows as unknown[][];
      const target = back.map((r) => canon(r)).sort();
      tables.push({ table, source: res.source.length, target: target.length });
      if (target.length !== res.source.length) throw new Error(`Doğrulama: ${table} satır sayısı kaynakta ${res.source.length}, hedefte ${target.length}. Hiçbir şey yazılmadı.`);
      const diff = res.source.filter((s, i) => s !== target[i]).length;
      if (diff) throw new Error(`Doğrulama: ${table} içeriği kaynakla aynı değil (${diff} satır). Hiçbir şey yazılmadı.`);
      log(`${table}: ${target.length}`);
      await opts.afterTable?.(table);
    }

    const at = opts.now().toISOString();
    await writeSetting(client, orgId, SEEDED_KEY, { at, languageId: null });
    const marker: TransferMarker = {
      ...opts.marker,
      at,
      tables: Object.fromEntries(tables.map((t) => [t.table, t.target])),
      seed: state.kind === "seed" && state.languageId ? { languageId: state.languageId } : null,
    };
    await writeSetting(client, orgId, TRANSFER_KEY, marker);
    await opts.beforeCommit?.();
    // Aktarım sırasında uygulama açıldıysa (bağlantısı belirdiyse) commit edilmez.
    await assertAppStopped(client);
    if (opts.dryRun) {
      await client.query("ROLLBACK");
      open = false;
      return { company, tables, state, skippedOrgSettings, committed: false };
    }
    try {
      await client.query("COMMIT");
    } catch (err) {
      open = false;
      throw describePgError(err, "commit");
    }
    open = false;
    return { company, tables, state, skippedOrgSettings, committed: true };
  } finally {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
  }
}

/** Firma ayarları: `platform.*` dışındakiler (kaynakta olmaz; olursa platformun işaretleriyle karışmasın). */
async function insertOrgSettings(client: pg.ClientBase, snap: SourceSnapshot, pgCols: PgColumn[], orgId: string): Promise<{ source: string[]; compare: string[] }> {
  const src = readSourceTable(snap, "org_settings");
  const cols = pgCols.map((c) => c.name);
  if (src.columns.length !== cols.length || src.columns.some((c) => !cols.includes(c))) throw new Error("Şema eşleşmiyor: org_settings");
  const k = src.columns.indexOf("key");
  const v = src.columns.indexOf("value");
  const rows = src.rows.filter((r) => !String(r[k]).startsWith("platform."));
  for (const r of rows) {
    await client.query(`INSERT INTO ${T("org_settings")} (org_id, "key", "value") VALUES ($1, $2, $3)`, [orgId, toPg(r[k], { name: "key", type: "text" }, "org_settings.key"), toPg(r[v], { name: "value", type: "text" }, "org_settings.value")]).catch((err: unknown) => {
      throw describePgError(err, "org_settings");
    });
  }
  return { source: rows.map((r) => canon([r[k], r[v]])).sort(), compare: ["key", "value"] };
}

/** Dosya adımı bitince işaret güncellenir (kendi kısa işleminde). */
export async function markFilesDone(client: pg.ClientBase, orgId: string, now: Date): Promise<void> {
  await client.query("BEGIN");
  try {
    await setOrg(client, orgId);
    const m = await readTransferMarker(client, orgId);
    if (!m) throw new Error("Aktarım işareti bulunamadı");
    m.files = { ...m.files, state: "tamam", doneAt: now.toISOString() };
    await writeSetting(client, orgId, TRANSFER_KEY, m);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/** `--yalniz-dosyalar`: hedef firma ve aktarım işareti (salt okuma). */
export async function readTargetForFiles(client: pg.ClientBase, orgId: string): Promise<{ company: { id: string; name: string }; marker: TransferMarker }> {
  await client.query("BEGIN READ ONLY");
  try {
    await setOrg(client, orgId);
    const company = await readCompany(client, orgId);
    const marker = await readTransferMarker(client, orgId);
    if (!marker) throw new TransferRefused("Bu firmaya veritabanı aktarımı yapılmamış; önce --yalniz-dosyalar olmadan çalıştırın.");
    return { company, marker };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}
