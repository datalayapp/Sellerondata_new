// Mobil sayı girişi: tuş takımı metni her dilde virgüllü, ölçü alanı cihaz klavyesinden nokta da getirebilir.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseNum } from '../src/lib/parseNum.ts';

/** `fmtInput` (plat/mobile-i18n) ile aynı biçim: virgüllü, binliksiz, sondaki sıfırlar atılır. */
const numpadText = (n: number, decimals = 3) => {
  const s = n.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',') : s;
};

describe('parseNum', () => {
  it('tuş takımı metni: virgül ondalıktır, binlik sayılmaz', () => {
    assert.equal(parseNum('4,5'), 4.5);
    assert.equal(parseNum('4,'), 4);
    assert.equal(parseNum(',5'), 0.5);
    assert.equal(parseNum('1,234'), 1.234);
    assert.equal(parseNum('1,250'), 1.25);
    assert.equal(parseNum('999,125'), 999.125);
    assert.equal(parseNum('12'), 12);
  });
  it('tuş takımı biçimi gidiş-dönüş', () => {
    for (let g = 0; g <= 1_000_000; g += 137) {
      const kg = g / 1000;
      assert.equal(parseNum(numpadText(kg)), kg, String(kg));
    }
  });
  it('cihaz klavyesi: nokta da ondalıktır', () => {
    assert.equal(parseNum('12.5'), 12.5);
    assert.equal(parseNum('1.250'), 1.25);
  });
  it('K36: "1.500" koli ağırlığında sorulmadan 1,5 kg; belirsiz olmayanlar değişmez', () => {
    assert.equal(parseNum('1.500'), 1.5);
    assert.equal(parseNum('12.000'), 12);
    assert.equal(parseNum('1,500'), 1.5);
    assert.equal(parseNum('1500'), 1500);
    assert.equal(parseNum('1.5'), 1.5);
  });
  it('iki ayırıcı birlikteyse sondaki ondalıktır', () => {
    assert.equal(parseNum('1.234,5'), 1234.5);
    assert.equal(parseNum('1,234.5'), 1234.5);
  });
  it('boş ve geçersiz', () => {
    assert.equal(parseNum(''), null);
    assert.equal(parseNum('  '), null);
    assert.equal(parseNum('abc'), null);
  });
});
