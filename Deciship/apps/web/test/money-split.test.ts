// Büyük tutar gösterimi (Pano "Fazla ödeme", fatura özeti): birim küçük yazılır, tutar büyük kalır (Mesaj 12 R4-4).
// Eskiden biçimlenmiş metin son boşluktan bölünüyordu; EN bilinmeyen kodda ("CHF 1,234.50") tutar küçülüyordu.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

// `@deciship/core` kök dosyası uzantısız içe aktarma yapar (Vite çözer, düz Node çözmez): format-golden testindeki kanca.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const f = await import('../src/lib/format.ts');

const NB = String.fromCharCode(0xa0);
const M = String.fromCharCode(0x2212);
const join = (p: { before: string; small: string; after: string }) => p.before + p.small + p.after;

describe('fmtMoneySplit', () => {
  it('TR: tutar büyük, birim (simge ya da kod) küçük', () => {
    f.setFormatLocale('tr');
    assert.deepEqual(f.fmtMoneySplit(765.9, 'TRY'), { before: '765,90', small: '₺', after: '' });
    assert.deepEqual(f.fmtMoneySplit(-1234.5, 'USD'), { before: `${M}1.234,50`, small: '$', after: '' });
    assert.deepEqual(f.fmtMoneySplit(1234.5, 'CHF'), { before: '1.234,50', small: 'CHF', after: '' });
    assert.deepEqual(f.fmtMoneySplit(-0.004, 'TRY'), { before: '0,00', small: '₺', after: '' });
  });
  it('EN: bilinmeyen kodda kod küçük ve önde, tutar büyük kalır', () => {
    f.setFormatLocale('en');
    const chf = f.fmtMoneySplit(1234.5, 'CHF');
    assert.deepEqual(chf, { before: '', small: 'CHF', after: `${NB}1,234.50` });
    assert.equal(join(chf), f.fmtMoney(1234.5, 'CHF'));
    assert.deepEqual(f.fmtMoneySplit(-12.5, 'xxx1'), { before: M, small: 'XXX1', after: `${NB}12.50` });
    f.setFormatLocale('tr');
  });
  it('EN: simge bitişik ("₺765.90"), küçültülecek birim yok', () => {
    f.setFormatLocale('en');
    assert.deepEqual(f.fmtMoneySplit(765.9, 'TRY'), { before: '₺765.90', small: '', after: '' });
    assert.deepEqual(f.fmtMoneySplit(-5, 'EUR'), { before: `${M}€5.00`, small: '', after: '' });
    f.setFormatLocale('tr');
  });
  it('round2 ile yuvarlar; değer yoksa uzun çizgi', () => {
    f.setFormatLocale('tr');
    assert.equal(f.fmtMoneySplit(1.005, 'TRY').before, '1,01');
    for (const n of [null, undefined, Number.NaN]) assert.deepEqual(f.fmtMoneySplit(n, 'TRY'), { before: '—', small: '', after: '' });
  });
});
