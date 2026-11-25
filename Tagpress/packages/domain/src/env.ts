/**
 * TagPress ortam değişkenleri: yeni ad `TAGPRESS_<AD>`, eski ad `STUDIO_<AD>` (Etiket Studio dönemi; geriye uyum,
 * sahibin kısayolları ve betikleri eski adla çalışmayı sürdürür). Yeni ad TANIMLIYSA (boş değer dahil: ör. boş
 * `TAGPRESS_SYSTEM_FONT_DIRS` = kapalı) o geçerlidir; tanımlı değilse eski ad okunur.
 *
 * Yalnız Node tarafı içindir (`@tagpress/domain/env`); paket kökünden dışa verilmez, web arayüzü kullanmaz.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export const ENV_PREFIX = "TAGPRESS_";
export const LEGACY_ENV_PREFIX = "STUDIO_";

/** Eski adı da kabul edilen değişkenler (önek olmadan). Yeni değişken bu listeye girmez: yalnız `TAGPRESS_` adı olur. */
export const LEGACY_ENV_NAMES = ["DATA_DIR", "BOOTSTRAP", "SYSTEM_FONT_DIRS", "URL"] as const;
export type TagpressEnvName = (typeof LEGACY_ENV_NAMES)[number];

/** `TAGPRESS_<name>`, tanımlı değilse `STUDIO_<name>`; ikisi de yoksa `undefined`. Değer kırpılmaz. */
export function tagpressEnv(name: TagpressEnvName, env: Env = process.env): string | undefined {
  const value = env[ENV_PREFIX + name];
  return value !== undefined ? value : env[LEGACY_ENV_PREFIX + name];
}
