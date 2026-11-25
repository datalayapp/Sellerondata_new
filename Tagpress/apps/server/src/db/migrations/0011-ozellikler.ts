import type { DatabaseSync } from "node:sqlite";
import type { MigrationEnv } from "./types.ts";

// 11: özellik anahtarları ve kurulum durumu (SUNUCU-PLANI §3.1, §9). Şema değişmez; yalnız firma ayarı (`org_settings`).
// - Göç anında verisi olan her firma (dili ya da işi olan; silinmiş satırlar da sayılır) sahibin bugünkü kullanımıdır:
//   `features` bütün özellikler açık (`by: 'migration'`); `setup` tamamlanmış (`completedAt` göç anı, adım 3, cevap
//   yok, atlanmadı). Sahip kurulum ekranını görmez.
// - Firmada `features` ya da `setup` kaydı zaten varsa (bozuk olsa bile) o kayda dokunulmaz.
// - Verisi olmayan firma (ve taze kurulum) kayıtsız kalır: kayıt varsayılanları, kurulum `pending` (`SetupService.state`).
// - Görsel denetim üründen kalktı (§9): her firmanın `app` ayarından `visualCritique` alanı silinir (bozuk JSON'lu
//   satır atlanır; geçmiş varyasyonlardaki denetim sonuçlarına dokunulmaz).
// İkinci koşu hiçbir şey değiştirmez. Ham bağlantıyla, firma bağlamı olmadan (bakım) çalışır.
//
// Anahtar listesi bu göçte DONDURULMUŞTUR (göçler değişmez); sonradan eklenen özellik kendi varsayılanıyla gelir.

/** Göç 11'in yazdığı anahtarlar (16; `packages/domain/src/features.ts` `FEATURE_KEYS`, 2026-11-21). */
export const MIGRATION_11_FEATURE_KEYS = [
  "core.production",
  "import.json",
  "jobs.manual",
  "adjust",
  "revise",
  "image.onTemplate",
  "image.themeTemplate",
  "learn",
  "print",
  "print.stickers",
  "templates.editor",
  "language.builder",
  "language.rules",
  "language.multi",
  "language.package",
  "text.languages",
] as const;

export function migration(db: DatabaseSync, env: MigrationEnv): void {
  const at = env.now();
  const orgs = db
    .prepare(
      `SELECT o.id FROM orgs o
       WHERE EXISTS (SELECT 1 FROM languages l WHERE l.org_id = o.id) OR EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = o.id)
       ORDER BY o.created_at, o.id`,
    )
    .all() as { id: string }[];
  const has = db.prepare("SELECT 1 FROM org_settings WHERE org_id = ? AND key = ?");
  const insert = db.prepare("INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?)");
  const features = JSON.stringify(Object.fromEntries(MIGRATION_11_FEATURE_KEYS.map((k) => [k, { on: true, by: "migration", at }])));
  const setup = JSON.stringify({ status: "completed", step: 3, answers: { labelTypes: [] }, completedAt: at, skipped: false });
  for (const { id } of orgs) {
    if (!has.get(id, "features")) insert.run(id, "features", features);
    if (!has.get(id, "setup")) insert.run(id, "setup", setup);
  }

  // Görsel denetim ayarı: yalnız geçerli JSON nesnesinde ve alan varsa (diğer alanlar ve sıraları aynı kalır).
  const apps = db.prepare("SELECT org_id, value FROM org_settings WHERE key = 'app'").all() as { org_id: string; value: string }[];
  const update = db.prepare("UPDATE org_settings SET value = ? WHERE org_id = ? AND key = 'app'");
  for (const row of apps) {
    let app: unknown;
    try {
      app = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (!app || typeof app !== "object" || Array.isArray(app) || !Object.hasOwn(app, "visualCritique")) continue;
    const { visualCritique: _removed, ...rest } = app as Record<string, unknown>;
    update.run(JSON.stringify(rest), row.org_id);
  }
}
