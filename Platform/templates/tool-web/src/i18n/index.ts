import type { Resource } from 'i18next';
import { initShellI18n } from '@sellerondata/shell';

/**
 * Aracın i18n kurulumu. Ad alanı = `locales/<dil>/<ad>.json` dosya adı; kabuğun kendi metinleri `shell` ad alanında hazır gelir.
 * Her metin TR ve EN'de eş anahtarla durur; `npm run check:i18n` farkı, eksik anahtarı ve kodda kalan Türkçeyi yakalar.
 * İlk dil kabukta: kayıtlı tercih (Person.locale) → `sod_lang` çerezi → tarayıcı dili (tr, en) → İngilizce (`pickInitialLocale`).
 * Karşılığı: Deciship/apps/web/src/i18n/index.ts.
 */
const files = import.meta.glob<{ default: Record<string, unknown> }>('../locales/*/*.json', { eager: true });

export const resources: Resource = {};
for (const [path, mod] of Object.entries(files)) {
  const m = path.match(/locales\/(\w+)\/(\w+)\.json$/);
  if (!m) continue;
  const [, lng, ns] = m;
  (resources[lng] ??= {})[ns] = mod.default;
}

export const i18n = initShellI18n({ resources, defaultNS: 'common' });
