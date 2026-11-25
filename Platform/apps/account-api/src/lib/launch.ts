/**
 * Araçların çalışırken geçerli durumu (`off` / `pilot` / `public`). Kaynak: `PRODUCT_LAUNCH` ortam değişkeni, yoksa kayıt
 * (`@sellerondata/contracts` `products.ts`). Yalnız saf işlevler; değer her okumada ortamdan gelir, testler değiştirebilir.
 *
 * Mesaj 11 Tur 0: bu dosya henüz hiçbir yere bağlı değil. Tur 1 (A1) jeton, `/me`, `/catalog`, kayıtta otomatik açılış,
 * olay yayını, rol doğrulaması ve üretim olay hedefi koşulunu `productLaunch` / `isProductOn`'a bağlar; açılışta
 * `assertLaunchConfig` koşar (hata → servis başlamaz, uyarılar günlüğe).
 */

import {
  PRODUCT_KEYS,
  PRODUCT_LAUNCHES,
  PRODUCT_REGISTRY,
  isProductKey,
  validateRegistry,
  type ProductEntry,
  type ProductKey,
  type ProductLaunch,
} from '@sellerondata/contracts';

export const PRODUCT_LAUNCH_ENV = 'PRODUCT_LAUNCH';

export type LaunchOverrides = ReadonlyMap<ProductKey, ProductLaunch>;

const REGISTRY = PRODUCT_REGISTRY as readonly ProductEntry[];

function registryLaunch(key: ProductKey): ProductLaunch {
  return REGISTRY.find((e) => e.key === key)!.launch;
}

/**
 * `orderloom=pilot,tagpress=off`. Boşluklar kırpılır, boş öğe yok sayılır; boş ya da tanımsız değer boş eşlem verir (kayıt geçerli).
 * Bilinmeyen anahtar, bilinmeyen durum, eksik `=` ve tekrar eden anahtar hata verir.
 */
export function parseProductLaunch(value: string | undefined): Map<ProductKey, ProductLaunch> {
  const out = new Map<ProductKey, ProductLaunch>();
  for (const raw of (value ?? '').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error(`${PRODUCT_LAUNCH_ENV} geçersiz: "${part}" (beklenen urun=durum)`);
    const key = part.slice(0, eq).trim();
    const launch = part.slice(eq + 1).trim();
    if (!isProductKey(key)) throw new Error(`${PRODUCT_LAUNCH_ENV} içinde bilinmeyen ürün: "${key}" (kayıtta: ${PRODUCT_KEYS.join(', ')})`);
    if (!(PRODUCT_LAUNCHES as readonly string[]).includes(launch)) {
      throw new Error(`${PRODUCT_LAUNCH_ENV} içinde ${key} için bilinmeyen durum: "${launch}" (beklenen ${PRODUCT_LAUNCHES.join(', ')})`);
    }
    if (out.has(key)) throw new Error(`${PRODUCT_LAUNCH_ENV} içinde ${key} iki kez yazılmış`);
    out.set(key, launch as ProductLaunch);
  }
  return out;
}

// Son ayrıştırılan değer: her istekte aynı metni yeniden ayrıştırmamak için. Ortam değişirse yeniden ayrıştırılır.
let cache: { raw: string | undefined; map: Map<ProductKey, ProductLaunch> } | null = null;

/** Ortamdaki geçerli ezmeler (`process.env.PRODUCT_LAUNCH`, her okumada). Biçim hatasında atar. */
export function launchOverrides(): LaunchOverrides {
  const raw = process.env[PRODUCT_LAUNCH_ENV];
  if (!cache || cache.raw !== raw) cache = { raw, map: parseProductLaunch(raw) };
  return cache.map;
}

/** Ürünün geçerli durumu: ortam ?? kayıt. */
export function productLaunch(key: ProductKey, overrides: LaunchOverrides = launchOverrides()): ProductLaunch {
  return overrides.get(key) ?? registryLaunch(key);
}

/** Ürün kapalı değil mi (`pilot` ya da `public`). Jeton, olay yayını ve rol doğrulaması buna bakar. */
export function isProductOn(key: ProductKey, overrides: LaunchOverrides = launchOverrides()): boolean {
  return productLaunch(key, overrides) !== 'off';
}

/** Bütün ürünlerin geçerli durumu, kayıt sırasıyla. */
export function productLaunches(overrides: LaunchOverrides = launchOverrides()): Record<ProductKey, ProductLaunch> {
  return Object.fromEntries(PRODUCT_KEYS.map((k) => [k, productLaunch(k, overrides)])) as Record<ProductKey, ProductLaunch>;
}

/**
 * Açılış denetimi. Biçim hatası ya da geçerli durumla kaydın tutarsızlığı (ör. rolü, sahip rolü ya da `deploy.api`'si olmayan
 * ürünü `pilot`/`public` yapmak) hata atar: servis başlamaz. Kayıtta `public` olup ortamda `off`a çekilen ürün uyarı olarak döner
 * (acil durdurma bilerek yapılabilir, ama sessiz kalmamalı); çağıran günlüğe yazar.
 */
export function assertLaunchConfig(value: string | undefined = process.env[PRODUCT_LAUNCH_ENV]): { warnings: string[] } {
  const overrides = parseProductLaunch(value);
  const effective = REGISTRY.map((e) => ({ ...e, launch: overrides.get(e.key as ProductKey) ?? e.launch }));
  const errors = validateRegistry(effective);
  if (errors.length) throw new Error(`Ürün kaydı ya da ${PRODUCT_LAUNCH_ENV} geçersiz: ${errors.join('; ')}`);
  const warnings: string[] = [];
  for (const e of REGISTRY) {
    const now = overrides.get(e.key as ProductKey);
    if (e.launch === 'public' && now === 'off') {
      warnings.push(`${e.key} kayıtta public, ${PRODUCT_LAUNCH_ENV} ile off: aboneliği olan firmalar da en geç jeton ömrü içinde erişimi kaybeder.`);
    }
  }
  return { warnings };
}
