// Denetim 14-B1: elle ölçüm formunda TR "2.500" kg 2,5 kg'dır (mobil ile aynı); 2500 kg kaydedilmez.
// Ölçü/ağırlık alanları core `parseMeasureNumber` (binlik yok) ile okunur; para, bölen ve yüzde alanları `parseTrNumber`da kalır.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { edgeValid, weightValid } from '../src/pages/measurements/dimLimits.ts';
import { MAX_EDGE_CM, MAX_WEIGHT_KG, measureEdgeOk, measureWeightOk, parseMeasureNumber } from '@deciship/core/measure';

const SRC = path.resolve(import.meta.dirname, '../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('ölçü girişi', () => {
  it('"2.500" kg 2,5 kg okunur; kenar ≤ 400 cm, ağırlık < 1000 kg', () => {
    assert.equal(parseMeasureNumber('2.500'), 2.5);
    assert.equal(parseMeasureNumber('2,500'), 2.5);
    assert.equal(parseMeasureNumber('12.5'), 12.5);
    assert.equal(measureWeightOk('2.500'), true);
    assert.equal(measureWeightOk('2500'), false);
    assert.equal(measureEdgeOk('1.250'), true); // 1,25 cm
    assert.equal(measureEdgeOk('1250'), false);
    assert.deepEqual([MAX_EDGE_CM, MAX_WEIGHT_KG], [400, 1000]);
  });

  it('ölçü ve ağırlık alanları binlik okuyan parseTrNumber ile okunmaz', () => {
    const MEASURE_ARGS = /parseTrNumber\(\s*(f!?\.(l|w|h|kg|edgeTolCm|weightTolKg)|x)\s*\)/g;
    const files = [
      'pages/measurements/FormParts.tsx',
      'pages/measurements/MeasurementModals.tsx',
      'pages/tariff-editor/QuoteBox.tsx',
      'pages/onboarding/SetupSteps.tsx',
      'pages/Settings.tsx',
    ];
    const wrong: string[] = [];
    for (const f of files) for (const m of read(f).matchAll(MEASURE_ARGS)) wrong.push(`${f}: ${m[0]}`);
    // yalnız ölçü/ağırlık okuyan formlar parseTrNumber'ı hiç almaz; hazır koli formunun yardımcısı da ölçü okur
    for (const f of ['pages/measurements/FormParts.tsx', 'pages/measurements/MeasurementModals.tsx', 'pages/tariff-editor/QuoteBox.tsx']) {
      if (/\bparseTrNumber\b/.test(read(f))) wrong.push(`${f}: parseTrNumber`);
    }
    if (/const pos = \(s: string\) => \(parseTrNumber\(s\)/.test(read('pages/Settings.tsx'))) wrong.push('pages/Settings.tsx: hazır koli pos');
    assert.deepEqual(wrong, []);
  });

  it('elle ölçüm formu kenar ve ağırlığı mobil sınırlarıyla doğrular', () => {
    const text = read('pages/measurements/FormParts.tsx');
    assert.match(text, /edgeValid\(f\.l,/);
    assert.match(text, /edgeValid\(f\.w,/);
    assert.match(text, /edgeValid\(f\.h,/);
    assert.match(text, /weightValid\(f\.kg,/);
  });

  it('düzenlemede değişmeyen eski büyük değer sınır hatası vermez; değişen ya da yeni kayıt verir', () => {
    assert.equal(edgeValid('600', '600'), true); // özgün 600 cm korunuyor
    assert.equal(edgeValid('650', '600'), false); // değiştirildi, sınır uygulanır
    assert.equal(edgeValid('600'), false); // yeni kayıt
    assert.equal(weightValid('2500', '2500'), true);
    assert.equal(weightValid('2600', '2500'), false);
    assert.equal(weightValid('2500'), false);
    assert.equal(edgeValid('30', '600'), true); // sınır içine indirildi
  });
});
