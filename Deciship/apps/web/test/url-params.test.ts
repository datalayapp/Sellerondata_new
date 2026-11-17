// Adresten okunan süzgeç değerleri: elle yazılan bilinmeyen değer API'ye gitmez, varsayılana düşer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enumParam, pageParam } from '../src/lib/urlParams.ts';

const TABS = ['DIFF', 'UNMATCHED', 'MATCH', 'NO_TARIFF', 'FLAGGED', 'ALL'] as const;

describe('adres süzgeçleri', () => {
  it('bilinen değeri büyük/küçük harf duyarsız eşler', () => {
    assert.equal(enumParam('ALL', TABS, 'DIFF'), 'ALL');
    assert.equal(enumParam('all', TABS, 'DIFF'), 'ALL');
    assert.equal(enumParam('No_Tariff', TABS, 'DIFF'), 'NO_TARIFF');
    assert.equal(enumParam(' match ', TABS, 'DIFF'), 'MATCH');
  });
  it('bilinmeyen ya da boş değer varsayılana düşer', () => {
    assert.equal(enumParam('hepsi', TABS, 'DIFF'), 'DIFF');
    assert.equal(enumParam('', TABS, 'DIFF'), 'DIFF');
    assert.equal(enumParam(null, TABS, 'DIFF'), 'DIFF');
    assert.equal(enumParam('WEIGHTS', ['WEIGHT', 'PRICE'] as const, ''), '');
  });
  it('sayfa yalnız pozitif tam sayı', () => {
    assert.equal(pageParam(null), 1);
    assert.equal(pageParam('3'), 3);
    assert.equal(pageParam('0'), 1);
    assert.equal(pageParam('-2'), 1);
    assert.equal(pageParam('1.5'), 1);
    assert.equal(pageParam('abc'), 1);
    assert.equal(pageParam(''), 1);
  });
});
