import { type AppSettings, AppSettingsSchema, type SettingsPatch } from "@tagpress/domain";
import { json } from "../db/database.ts";
import { isInstallSettingKey } from "../org/tables.ts";
import type { TenantDb } from "../org/tenant-db.ts";

/**
 * Ayarlar iki düzeyde:
 * - Kurulum (`settings` tablosu): `key:<sağlayıcı>` (API anahtarları), `install.*`, `files.*` (`org/tables.ts`
 *   `isInstallSettingKey`). Yalnız `getInstall`/`setInstall`/`deleteInstall` ya da kurulum anahtarıyla `getValue`.
 * - Firma (`org_settings`, geçerli firma): `app` (uygulama ayarları), `print.presets.<dil>`, `imported:<dil>`,
 *   `features`, `setup`, `ai.limits` … Geri kalan her anahtar.
 * `getValue`/`setValue`/`deleteValue` anahtara göre doğru düzeye gider (bugünkü çağıranlar değişmeden çalışır).
 */
export class SettingsService {
  constructor(private readonly db: TenantDb) {}

  getValue<T>(key: string, fallback: T): T {
    return isInstallSettingKey(key) ? this.getInstall(key, fallback) : this.getOrg(key, fallback);
  }

  setValue(key: string, value: unknown): void {
    if (isInstallSettingKey(key)) this.setInstall(key, value);
    else this.setOrg(key, value);
  }

  deleteValue(key: string): void {
    if (isInstallSettingKey(key)) this.deleteInstall(key);
    else this.deleteOrg(key);
  }

  // ------------------------------------------------------------ kurulum

  getInstall<T>(key: string, fallback: T): T {
    this.assertInstall(key);
    const row = this.db.install.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return json(row?.value, fallback);
  }

  setInstall(key: string, value: unknown): void {
    this.assertInstall(key);
    this.db.install.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  deleteInstall(key: string): void {
    this.assertInstall(key);
    this.db.install.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  // ------------------------------------------------------------ firma

  getOrg<T>(key: string, fallback: T): T {
    this.assertOrg(key);
    const row = this.db.prepare("SELECT value FROM org_settings WHERE org_id = $org AND key = ?").get(key) as { value: string } | undefined;
    return json(row?.value, fallback);
  }

  setOrg(key: string, value: unknown): void {
    this.assertOrg(key);
    this.db
      .prepare("INSERT INTO org_settings (org_id, key, value) VALUES ($org, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  deleteOrg(key: string): void {
    this.assertOrg(key);
    this.db.prepare("DELETE FROM org_settings WHERE org_id = $org AND key = ?").run(key);
  }

  /** Firmanın uygulama ayarları (`app`). */
  get(): AppSettings {
    return AppSettingsSchema.parse(this.getOrg("app", {}));
  }

  /** Kısmi güncelleme: gönderilmeyen ayar değişmez. */
  update(patch: SettingsPatch): AppSettings {
    const next = AppSettingsSchema.parse({ ...this.get(), ...patch });
    this.setOrg("app", next);
    return next;
  }

  private assertInstall(key: string): void {
    if (!isInstallSettingKey(key)) throw new Error(`Kurulum ayarı değil: ${key}`);
  }

  private assertOrg(key: string): void {
    if (isInstallSettingKey(key)) throw new Error(`Firma ayarı değil (kurulum anahtarı): ${key}`);
  }
}
