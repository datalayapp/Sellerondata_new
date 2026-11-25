// Sayfalama metni (KALANLAR 5.17): sayılar ekranın geri kalanı gibi binlik ayırıcıyla ("1.212 ölçüm", tasarımdaki gibi),
// "1212" değil. Metin kabuğun sözlüğünden gelir (`Pager`, `@sellerondata/shell`); panel ve Merkez aynı metni kullanır.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import i18next from 'i18next';

const require = createRequire(import.meta.url);
// `time-zone` girişi `src/timeZone.ts`: sözlükler aynı klasörün `locales/` altında.
const shellSrc = path.dirname(require.resolve('@sellerondata/shell/time-zone'));
const dict = (lng: string) => JSON.parse(readFileSync(path.join(shellSrc, 'locales', lng, 'shell.json'), 'utf8'));

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'tr',
  fallbackLng: 'en',
  defaultNS: 'shell',
  resources: { tr: { shell: dict('tr') }, en: { shell: dict('en') } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

describe('sayfalama metni', () => {
  it('Türkçe: binlik nokta', () => {
    const t = i18n.getFixedT('tr', 'shell');
    assert.equal(t('common.rangeOf', { from: 1001, to: 1020, total: 1212 }), '1.001–1.020 / 1.212 kayıt');
    assert.equal(t('common.rangeOfUnit', { from: 1, to: 20, total: 1212, label: 'ölçüm' }), '1–20 / 1.212 ölçüm');
    assert.equal(t('common.pageOf', { page: 1, pages: 1061 }), 'Sayfa 1 / 1.061');
    assert.equal(t('common.rangeOf', { from: 0, to: 0, total: 0 }), '0–0 / 0 kayıt');
  });

  it('İngilizce: binlik virgül', () => {
    const t = i18n.getFixedT('en', 'shell');
    assert.equal(t('common.rangeOf', { from: 1001, to: 1020, total: 1212 }), '1,001–1,020 of 1,212 records');
    assert.equal(t('common.rangeOfUnit', { from: 1, to: 20, total: 1212, label: 'measurements' }), '1–20 of 1,212 measurements');
    assert.equal(t('common.pageOf', { page: 1, pages: 1061 }), 'Page 1 of 1,061');
  });
});
