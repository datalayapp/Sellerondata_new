import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeFormula, safeCell } from './csvCell.ts';

test('formül başlatan metin başına kesme alır', () => {
  for (const s of [' =1+1', '＝SUM(A1)', '\n=1', '=1', '-5', '+1', '@x', '＋1', '－1', '＠a']) {
    assert.equal(neutralizeFormula(s), `'${s}`, JSON.stringify(s));
  }
});

test('düz metin değişmez', () => {
  assert.equal(neutralizeFormula('Kargo'), 'Kargo');
});

test('sayı (number) dokunulmadan kalır, metin korunur', () => {
  assert.equal(safeCell(-5), '-5');
  assert.equal(safeCell(-5.5, true), '-5,5');
  assert.equal(safeCell('-5'), "'-5");
  assert.equal(safeCell('Kargo'), 'Kargo');
  assert.equal(safeCell(null), '');
});
