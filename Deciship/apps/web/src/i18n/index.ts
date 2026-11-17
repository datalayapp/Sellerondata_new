import type { Resource } from 'i18next';
import { initShellI18n } from '@sellerondata/shell';

/**
 * DeciShip web i18n. Ad alanı = `locales/<dil>/<ad>.json` dosya adı.
 * Metinler TR'den EN'e eş anahtarla tutulur; `npm run check:i18n` farkları yakalar.
 * Dil kaynağı ve değişimi kabuktadır (Person.locale → `sod_lang` çerezi → tarayıcı).
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
