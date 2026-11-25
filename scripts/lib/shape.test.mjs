import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareShape, mergeShapes, shapeOf } from './shape.mjs';

test('şekil: ilkel, dizi, nesne, seçimli alan, birleşim', () => {
  assert.deepEqual(shapeOf({ b: 1, a: 'x', c: null, d: [] }), { a: 'string', b: 'number', c: 'null', d: [] });
  assert.deepEqual(shapeOf([{ a: 1 }, { a: 2, b: true }]), [{ a: 'number', 'b?': 'boolean' }]);
  assert.deepEqual(shapeOf([{ a: 1 }, { a: null }]), [{ a: { $oneOf: ['null', 'number'] } }]);
  assert.deepEqual(mergeShapes({ a: 'number' }, 'null'), { $oneOf: ['null', { a: 'number' }] });
});

test('şekil: kimlik, tarih, para kodu anahtarlı nesne kayıt sayılır', () => {
  assert.deepEqual(shapeOf({ TRY: 1, USD: 2 }), { '*': 'number' });
  assert.deepEqual(shapeOf({ '2026-10': { n: 1 }, '2026-11': { n: 2, m: 'x' } }), { '*': { 'm?': 'string', n: 'number' } });
  assert.deepEqual(shapeOf({ x: { a: 1 } }, { records: ['$'] }), { '*': { a: 'number' } });
  // boş kayıt çökmez; değer türü bilinmiyor sayılır
  assert.deepEqual(shapeOf({ m: {} }, { records: ['$.m'] }), { m: { '*': 'null' } });
  assert.deepEqual(compareShape(shapeOf({ m: { A: 1 } }), shapeOf({ m: {} }, { records: ['$.m'] })), []);
  // gerçekte kayıt, sahtede düz nesne: değerler karşılaştırılır, araya null katılmaz
  const realRec = shapeOf({ m: { A: 1 } }, { records: ['$.m'] });
  assert.deepEqual(compareShape(shapeOf({ m: { LIDAR: 7, MANUAL: 5 } }), realRec), []);
  assert.deepEqual(compareShape(shapeOf({ m: {} }), realRec), []);
  assert.deepEqual(compareShape(shapeOf({ m: { LIDAR: 'x' } }), realRec), ['$.m.*: sahte API string veriyor, gerçekte number']);
});

test('karşılaştırma: uydurma alan, eksik alan, tür ve null farkı yakalanır', () => {
  const real = shapeOf({ id: 'a', disputeSums: { claimed: 1 }, lines: [{ amount: 1, note: 'x' }] });
  assert.deepEqual(compareShape(shapeOf({ id: 'a', disputeSums: { claimed: 1 }, lines: [{ amount: 1, note: 'x' }] }), real), []);
  const bad = compareShape(shapeOf({ id: 1, disputeSums: null, lines: [{ amount: '1', extra: true }] }), real);
  assert.deepEqual(bad.sort(), [
    "$.disputeSums: sahte API null veriyor, gerçekte hep nesne",
    "$.id: sahte API number veriyor, gerçekte string",
    "$.lines[].amount: sahte API string veriyor, gerçekte number",
    "$.lines[].extra: sahte API'de var, gerçekte yok",
    "$.lines[].note: gerçekte var, sahte API'de yok",
  ]);
});

test('karşılaştırma: gerçekte yalnız null ya da boş dizi görülen yer bilinmiyor sayılır; seçimli alan atlanabilir; ignore', () => {
  const real = shapeOf([{ a: null, b: [], c: 1 }, { a: null, b: [] }]);
  assert.deepEqual(compareShape(shapeOf([{ a: { x: 1 }, b: [1] }]), real), []);
  assert.deepEqual(compareShape(shapeOf({ a: 1 }), shapeOf({ a: 'x' }), { ignore: ['$.a'] }), []);
});
