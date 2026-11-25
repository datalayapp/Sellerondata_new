/**
 * Kiracı (firma) tablolarının TEK listesi. Her birinde `org_id` vardır; `TenantDb` bu listedeki tabloya dokunan ve
 * firma kapsamı (`$org`) olmayan SQL'i reddeder. Sıra kalıcı silme sırasıdır (çocuk önce); 2. aşamada product-kit
 * `purge.tables` olur. Yeni kiracı tablosu (C adımının tabloları) buraya, silme sırasındaki yerine eklenir ve kendi
 * göçünde `org_id` + iki tetikleyiciyle kurulur (şema testi: `org/schema.test.ts`).
 */
export const TENANT_TABLES = [
  "print_items",
  "print_pages",
  "print_exports",
  "print_sessions",
  "print_templates",
  "adjust_log",
  "job_log",
  "gen_tasks",
  "variants",
  "jobs",
  "batches",
  // C adımı (göç 13): oturumun çocukları, oturumdan önce silinir.
  "design_session_turns",
  "profile_revisions",
  "design_samples",
  "design_session_entries",
  "design_sessions",
  "learn_runs",
  "learn_proposals",
  "refs",
  "template_tasks",
  "ai_calls",
  "undo",
  "templates",
  "profile_versions",
  "languages",
  "org_settings",
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

/**
 * Postgres kalıcı silme listesi (platform kipi; product-kit `purge.tables`, `orgColumn: "org_id"`): `TENANT_TABLES` sırasıyla.
 * `key` parça seçiminin sütunu; `id`'si olmayan tablolar: `templates` (birincil anahtar dil + şablon; dil sütunu seçilir, aynı
 * dilin bütün şablonları aynı parçada gider), `org_settings` (firma + anahtar), `undo` (`token`). Dosya yolu döndüren tablo yok:
 * firmanın klasörü `onPurged` ile silinir. Katalog denetimi `checkPurgeTables()` `[]` (`db/pg/schema.pg.test.ts`).
 */
const PG_PURGE_KEYS: Partial<Record<TenantTable, string>> = { templates: "language_id", org_settings: "key", undo: "token" };
export const PG_PURGE_TABLES: readonly { table: TenantTable; key?: string }[] = TENANT_TABLES.map((table) =>
  PG_PURGE_KEYS[table] ? { table, key: PG_PURGE_KEYS[table] } : { table },
);

/** Kurulum düzeyindeki tablolar: yalnız `TenantDb.install` ve bakım kapsamı (`maintenance`) erişir. */
export const INSTALL_TABLES = ["settings", "orgs"] as const;
export type InstallTable = (typeof INSTALL_TABLES)[number];

const TENANT = new Set<string>(TENANT_TABLES);
const INSTALL = new Set<string>(INSTALL_TABLES);

export const isTenantTable = (name: string): boolean => TENANT.has(name.toLowerCase());
export const isInstallTable = (name: string): boolean => INSTALL.has(name.toLowerCase());

/**
 * `settings` tablosunda (kurulum düzeyi) kalan anahtarlar. Geri kalan her anahtar firma ayarıdır (`org_settings`):
 * `app`, `features`, `setup`, `print.presets.<dil>`, `imported:<dil>`, `ai.limits`.
 * - `key:<sağlayıcı>`: yapay zekâ anahtarları (kurulum düzeyi; firmalar anahtar girmez, YOL-HARITASI 2026-11-21).
 * - `install.*`: `install.ownerOrgId`, `install.defaultOrgId`, `install.maxConcurrency`, `install.productKey`.
 * - `files.*`: `files.layout` (dosya düzeni sürümü; A3).
 */
export function isInstallSettingKey(key: string): boolean {
  return key.startsWith("key:") || key.startsWith("install.") || key.startsWith("files.");
}

/** Kurulum ayarı anahtarları. */
export const INSTALL_KEYS = {
  ownerOrgId: "install.ownerOrgId",
  defaultOrgId: "install.defaultOrgId",
  maxConcurrency: "install.maxConcurrency",
  /** Açıkça `true` ise kayıtlı anahtar yokken ortam değişkenindeki anahtar kullanılır (varsayılan kapalı). */
  productKey: "install.productKey",
  fileLayout: "files.layout",
} as const;
