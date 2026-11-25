// Denetim 10-B19 (para etkili parça): eşlemedeki KDV oranı her tuşta yeniden biçimlenince "7,5" yazan kişi 75 kaydediyordu
// ("7," → 7 → "7", ardından "5" → "75"); tutarlar yanlış KDV ile bölünürdü. Kutu yazarken metni tutar, çıkınca sayıya çevirir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';

// `@deciship/core` kök dosyası uzantısız içe aktarma yapar (Vite çözer, düz Node çözmez): format-golden testindeki kanca.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const f = await import('../src/lib/format.ts');
const { commitVatPct } = await import('../src/pages/invoice-upload/vatInput.ts');

const SRC = path.resolve(import.meta.dirname, '../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('KDV oranı kutusu (10-B19)', () => {
  it('her tuşta biçimlemek ondalığı yutar (eski davranışın nedeni)', () => {
    f.setFormatLocale('tr');
    let shown = '';
    for (const key of '7,5') shown = f.numToInput(f.parseTrNumber(shown + key) ?? 0);
    assert.equal(shown, '75');
  });

  it('kutudan çıkınca okunur: TR "7,5" ve "7.5", EN "7.5"', () => {
    f.setFormatLocale('tr');
    assert.equal(commitVatPct('7,5', 20), 7.5);
    assert.equal(commitVatPct('7.5', 20), 7.5);
    assert.equal(commitVatPct('18', 20), 18);
    f.setFormatLocale('en');
    assert.equal(commitVatPct('7.5', 20), 7.5);
    assert.equal(commitVatPct('0', 20), 0);
  });

  it('okunamayan, boş ya da 0-100 dışı metin önceki orana döner', () => {
    f.setFormatLocale('tr');
    assert.equal(commitVatPct('', 20), 20);
    assert.equal(commitVatPct('abc', 18), 18);
    assert.equal(commitVatPct('-1', 20), 20);
    assert.equal(commitVatPct('120', 20), 20);
  });

  it('eşleme ekranı yazarken biçimlemez, kutudan çıkınca çevirir', () => {
    const src = read('pages/invoice-upload/MappingStep.tsx');
    assert.doesNotMatch(src, /vatPct:\s*parseTrNumber\(e\.target\.value\)/);
    assert.match(src, /onBlur=\{[\s\S]{0,200}commitVatPct\(/);
  });
});
