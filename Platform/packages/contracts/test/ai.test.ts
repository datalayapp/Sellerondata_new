import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_LIST_PRICES_USD,
  AI_UNKNOWN_MODEL_PRICE,
  AI_PERIOD_PATTERN,
  AI_MICROS_PER_UNIT,
  aiCostMicros,
  aiMicrosToAmount,
  aiPeriodOf,
  aiNextPeriod,
  mostExpensiveAiPrice,
} from '../src/index.ts';

const sonnet = AI_LIST_PRICES_USD['claude-sonnet-5-5']!;
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

test('aiCostMicros: kaynaktaki ornek (1000 girdi + 1000 cikti, kur 100 = 1,20 TL)', () => {
  const micros = aiCostMicros({ ...zero, inputTokens: 1000, outputTokens: 1000 }, sonnet, 100);
  assert.equal(micros, 1_200_000);
  assert.equal(micros / AI_MICROS_PER_UNIT, 1.2);
});

test('aiCostMicros: onbellek kalemleri ve toplam', () => {
  const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
  // 05-B13: Sonnet 5.5 önbellekten okuma 0,10 $ (resmî fiyat sayfası, 2026-11-13)
  assert.equal(aiCostMicros(u, sonnet, 10), Math.round((2 + 10 + 2.5 + 0.1) * 1_000_000 * 10));
});

test('05-B13: liste fiyatları resmî sayfayla (2026-11-13), Fable 5.2 ve Haiku 5.5 tabloda', () => {
  assert.deepEqual(AI_LIST_PRICES_USD['claude-sonnet-5-5'], { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 });
  assert.deepEqual(AI_LIST_PRICES_USD['claude-opus-5-5'], { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 });
  assert.deepEqual(AI_LIST_PRICES_USD['claude-fable-5-2'], { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 });
  assert.equal(AI_LIST_PRICES_USD['claude-haiku-5-5']!.input, 0.1);
});

test('05-B13: Haiku 5.5 istemi 100.000 tokeni aşınca bütün istek üst fiyattan (önbellek tokenleri istemi sayar)', () => {
  const haiku = AI_LIST_PRICES_USD['claude-haiku-5-5']!;
  // 100.000 girdi + 1.000 çıktı: alt fiyat (0,10 / 0,50 $), kur 100
  assert.equal(aiCostMicros({ ...zero, inputTokens: 100_000, outputTokens: 1000 }, haiku, 100), Math.round((100_000 * 0.1 + 1000 * 0.5) * 100));
  // 1 token fazlası: üst fiyat (0,50 / 2,50 $)
  assert.equal(aiCostMicros({ ...zero, inputTokens: 100_001, outputTokens: 1000 }, haiku, 100), Math.round((100_001 * 0.5 + 1000 * 2.5) * 100));
  // önbellekten okuma da istemin parçası
  assert.equal(
    aiCostMicros({ ...zero, inputTokens: 50_000, cacheReadTokens: 60_000 }, haiku, 100),
    Math.round((50_000 * 0.5 + 60_000 * 0.05) * 100),
  );
});

test('aiCostMicros: eksi ve sayi olmayan token 0 sayilir', () => {
  assert.equal(aiCostMicros(zero, sonnet, 100), 0);
  assert.equal(aiCostMicros({ ...zero, inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: Infinity }, sonnet, 100), 0);
});

test('aiCostMicros: sonuc tamsayi; gecersiz kurda RangeError', () => {
  const r = aiCostMicros({ ...zero, inputTokens: 3 }, { input: 0.3333, output: 0, cacheWrite: 0, cacheRead: 0 }, 7.77);
  assert.ok(Number.isInteger(r));
  for (const bad of [0, -1, Number.NaN, Infinity]) {
    assert.throws(() => aiCostMicros(zero, sonnet, bad), RangeError);
  }
});

test('bilinmeyen model en pahali fiyat', () => {
  for (const p of Object.values(AI_LIST_PRICES_USD)) {
    assert.ok(AI_UNKNOWN_MODEL_PRICE.input >= p.input);
    assert.ok(AI_UNKNOWN_MODEL_PRICE.output >= p.output);
  }
});

test('inceleme 2026-11-13: bilinmeyen model etkin tablonun (ezmeden sonra) en pahali fiyatindan', () => {
  // ezme bir modeli liste fiyatinin ustune cikarir: bilinmeyen model artik ondan sayilir (eskiden sabit Fable 5.1 fiyati)
  const table = { ...AI_LIST_PRICES_USD, 'claude-opus-5-5': { input: 30, output: 90, cacheWrite: 37.5, cacheRead: 3 } };
  assert.deepEqual(mostExpensiveAiPrice(table), { input: 30, output: 90, cacheWrite: 37.5, cacheRead: 3 });
  // her kalem ayri en yuksek (kademeli fiyatin ust kademesi dahil): hicbir modelden eksik sayilmaz
  const mixed = { a: { input: 1, output: 9, cacheWrite: 1, cacheRead: 0.1 }, b: { input: 2, output: 3, cacheWrite: 4, cacheRead: 0.05, above: { promptTokens: 10, price: { input: 5, output: 1, cacheWrite: 1, cacheRead: 0.2 } } } };
  assert.deepEqual(mostExpensiveAiPrice(mixed), { input: 5, output: 9, cacheWrite: 4, cacheRead: 0.2 });
  // bos tablo: liste fiyatlarinin en pahalisi
  assert.deepEqual(mostExpensiveAiPrice({}), AI_UNKNOWN_MODEL_PRICE);
  assert.deepEqual(AI_UNKNOWN_MODEL_PRICE, mostExpensiveAiPrice(AI_LIST_PRICES_USD));
});

test('aiMicrosToAmount: 2 hane, yarim yukari', () => {
  assert.equal(aiMicrosToAmount(1_200_000), 1.2);
  assert.equal(aiMicrosToAmount(0), 0);
  assert.equal(aiMicrosToAmount(5_000), 0.01);
  assert.equal(aiMicrosToAmount(4_999), 0);
  assert.equal(aiMicrosToAmount(1_234_567), 1.23);
  assert.equal(aiMicrosToAmount(1_235_000), 1.24);
});

test('aiPeriodOf: saat dilimi siniri', () => {
  const at = new Date('2026-10-31T22:00:00Z');
  assert.equal(aiPeriodOf(at, 'Europe/Istanbul'), '2026-11');
  assert.equal(aiPeriodOf(at, 'UTC'), '2026-10');
  assert.equal(aiPeriodOf(new Date('2026-10-31T20:59:59Z'), 'Europe/Istanbul'), '2026-10');
  assert.equal(aiPeriodOf(new Date('2026-12-31T22:00:00Z'), 'Europe/Istanbul'), '2027-01');
  assert.throws(() => aiPeriodOf(at, 'Mars/Olympus'), RangeError);
});

test('aiNextPeriod ve AI_PERIOD_PATTERN', () => {
  assert.equal(aiNextPeriod('2026-12'), '2027-01');
  assert.equal(aiNextPeriod('2026-11'), '2026-12');
  assert.equal(aiNextPeriod('2026-01'), '2026-02');
  assert.equal(aiNextPeriod('2026-09'), '2026-10');
  for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '', '2026-11-01']) {
    assert.equal(AI_PERIOD_PATTERN.test(bad), false, bad);
    assert.throws(() => aiNextPeriod(bad), RangeError);
  }
  for (const ok of ['2026-01', '2026-12', '1999-10']) assert.equal(AI_PERIOD_PATTERN.test(ok), true, ok);
});
