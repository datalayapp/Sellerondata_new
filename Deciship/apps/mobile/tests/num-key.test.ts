import { describe, expect, it } from 'vitest';
import { applyNumKey, numKeyUpdater, type NumKey } from '../src/lib/numKey';

const W = { maxDecimals: 3, maxLength: 7 };

/** React'in işlevsel güncelleme kuyruğu gibi: güncellemeler sırayla bir önceki sonuca uygulanır. */
function stateQueue(initial: string) {
  let state = initial;
  const queue: Array<(prev: string) => string> = [];
  return {
    set: (u: (prev: string) => string) => queue.push(u),
    flush: () => {
      for (const u of queue.splice(0)) state = u(state);
      return state;
    },
  };
}

describe('tuş takımı: tuşun değere uygulanması', () => {
  it('rakam, virgül ve silme', () => {
    const seq = (keys: NumKey[], from = '') => keys.reduce((v, k) => applyNumKey(v, k, W), from);
    expect(seq(['3', ',', '2', '5'])).toBe('3,25');
    expect(seq([',', '5'])).toBe('0,5');
    expect(seq(['0', '7'])).toBe('7');
    expect(seq(['1', ',', ','])).toBe('1,');
    expect(seq(['del'], '3,25')).toBe('3,2');
    expect(seq(['del'], '')).toBe('');
  });

  it('ondalık ve uzunluk sınırında basış değeri değiştirmez', () => {
    expect(applyNumKey('1,234', '5', W)).toBe('1,234');
    expect(applyNumKey('1234567', '8', W)).toBe('1234567');
    expect(applyNumKey('12', ',', { maxDecimals: 0, maxLength: 7 })).toBe('12');
  });

  it('G3: hızlı ardışık basışta hiçbir rakam kaybolmaz (dört basış aynı karede)', () => {
    // Emülatörde 300 ms arayla 3 , 2 5 basınca "35" kalıyordu: her basış ekrandaki bayat değere uygulanıyordu.
    // Dört basış da yeniden çizimden önce gelse bile sonuç "3,25" olmalı.
    const s = stateQueue('');
    for (const k of ['3', ',', '2', '5'] as NumKey[]) s.set(numKeyUpdater(k, W));
    expect(s.flush()).toBe('3,25');
  });

  it('G3: araya giren çizimle de aynı sonuç', () => {
    const s = stateQueue('');
    s.set(numKeyUpdater('3', W));
    expect(s.flush()).toBe('3');
    s.set(numKeyUpdater(',', W));
    s.set(numKeyUpdater('2', W));
    expect(s.flush()).toBe('3,2');
    s.set(numKeyUpdater('5', W));
    s.set(numKeyUpdater('del', W));
    s.set(numKeyUpdater('5', W));
    expect(s.flush()).toBe('3,25');
  });
});

describe('ağırlık: taslaktan geri yüklenen değer kaydedilenle aynı (yanlış kayıt yok)', () => {
  it('3 ondalıklı ağırlık tuş takımı metnine yuvarlanmadan döner, yeniden okununca aynı sayı', async () => {
    const { fmtInput, parseNum } = await import('../src/lib/format');
    const { WEIGHT_DECIMALS } = await import('../src/lib/numKey');
    for (const kg of [4.025, 12.345, 0.005, 999.999, 1, 7.5]) {
      expect(parseNum(fmtInput(kg, WEIGHT_DECIMALS)), String(kg)).toBe(kg);
    }
  });

  it('ağırlık ekranı taslağı, tartı okumasını ve tuş takımını aynı ondalık sınırıyla kullanır (eskiden geri yükleme 2 ondalıktı)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/(tabs)/deciship/weight.tsx', 'utf8');
    expect(src).toContain('fmtInput(draft.weightKg, WEIGHT_DECIMALS)');
    expect(src).toContain('maxDecimals={WEIGHT_DECIMALS}');
    expect(src).not.toMatch(/fmtInput\([^)]*,\s*2\)/);
  });
});
