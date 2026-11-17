import { describe, expect, it } from 'vitest';
import { roundUpToStep } from '../src/calc';
import { describeWeightSteps, sameWeightSteps, weightStepsFromRates } from '../src/weightSteps';

const flat = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => ({ weightUpto: Math.round((from + i * step) * 1000) / 1000 }));

describe('weightStepsFromRates', () => {
  it('0,5 kg aralıklı satırlar 70,5 kg\'a kadar, üstü kg başı bantlar → 1 kg', () => {
    const rates = [...flat(0.5, 70.5, 0.5), { weightUpto: 99, perKg: true }, { weightUpto: 299, perKg: true }, { weightUpto: 99999, perKg: true }];
    const steps = weightStepsFromRates(rates)!;
    expect(steps).toEqual([
      { upto: 70.5, step: 0.5 },
      { upto: null, step: 1 },
    ]);
    // 20,3 kg artık 21'e değil 20,5'e yuvarlanır; 70,7 → 71
    expect(roundUpToStep(20.3, steps)).toBe(20.5);
    expect(roundUpToStep(70.7, steps)).toBe(71);
    expect(describeWeightSteps(steps)).toBe("70,5 kg'a kadar 0,5 kg, üstü 1 kg");
  });

  it('aralık değişince yeni bant: 0,5 kg 20 kg\'a kadar, sonra 1 kg', () => {
    const steps = weightStepsFromRates([...flat(0.5, 20, 0.5), ...flat(21, 30, 1)]);
    expect(steps).toEqual([
      { upto: 20, step: 0.5 },
      { upto: null, step: 1 },
    ]);
  });

  it('desi tablosu (1, 2, … 30) → her 1 kg; büyük aralıklar (5, 10, 15) da 1 kg', () => {
    expect(weightStepsFromRates(flat(1, 30, 1))).toEqual([{ upto: null, step: 1 }]);
    expect(weightStepsFromRates([...flat(1, 10, 1), ...flat(15, 30, 5)])).toEqual([{ upto: null, step: 1 }]);
    expect(describeWeightSteps([{ upto: null, step: 1 }])).toBe('her 1 kg');
  });

  it('aşım fiyatlı tabloda üst basamak verilen değer (aşım birimi korunur)', () => {
    expect(weightStepsFromRates(flat(0.5, 10, 0.5), { aboveStep: 0.5 })).toEqual([{ upto: null, step: 0.5 }]);
    expect(weightStepsFromRates(flat(0.5, 10, 0.5))).toEqual([
      { upto: 10, step: 0.5 },
      { upto: null, step: 1 },
    ]);
  });

  it('birden çok bölge birleşir; tek ağırlık ya da yalnız kg başı → null (mevcut korunur)', () => {
    const steps = weightStepsFromRates([
      { weightUpto: 0.5 },
      { weightUpto: 1 },
      { weightUpto: 0.5 },
      { weightUpto: 1.5 },
    ]);
    expect(steps).toEqual([
      { upto: 1.5, step: 0.5 },
      { upto: null, step: 1 },
    ]);
    expect(weightStepsFromRates([{ weightUpto: 5 }])).toBeNull();
    // libreden çevrilmiş ağırlıklar düzgün basamağa oturmaz → mevcut korunur
    expect(weightStepsFromRates([{ weightUpto: 0.454 }, { weightUpto: 0.907 }, { weightUpto: 1.361 }])).toBeNull();
    expect(weightStepsFromRates([{ weightUpto: 99, perKg: true }, { weightUpto: 99999, perKg: true }])).toBeNull();
  });

  it('sameWeightSteps', () => {
    expect(sameWeightSteps([{ upto: 20, step: 0.5 }, { upto: null, step: 1 }], [{ upto: 20, step: 0.5 }, { upto: null, step: 1 }])).toBe(true);
    expect(sameWeightSteps([{ upto: 20, step: 0.5 }, { upto: null, step: 1 }], [{ upto: 70.5, step: 0.5 }, { upto: null, step: 1 }])).toBe(false);
    expect(sameWeightSteps(undefined, [])).toBe(true);
  });
});

describe('içe aktarma: ağırlık yuvarlama tablodan', () => {
  it('SUMMARY notu ve importWeightSteps; mevcutla aynıysa not yok', async () => {
    const { checkTariffImport, importWeightSteps, parseTariffImport } = await import('../src/index');
    const prices = [
      ['Ağırlık (kg)', 'A', 'B'],
      ...flat(0.5, 30.5, 0.5).map((r, i) => [String(r.weightUpto).replace('.', ','), String(10 + i), String(12 + i)]),
      ['Kg başına ücret', '', ''],
      ['31-99', '2', '3'],
    ];
    const raw = { fileName: 't.csv', kind: 'csv' as const, prices, pricesSheetName: null, zones: null, surcharges: null };
    const p = parseTariffImport(raw);
    const old = [
      { upto: 20, step: 0.5 },
      { upto: null, step: 1 },
    ];
    const c = { tariffCurrency: 'TRY', currentZones: [{ country: '*', zone: 'A' }], currentRates: [], currentWeightSteps: old };
    expect(importWeightSteps(p, c)).toEqual([
      { upto: 30.5, step: 0.5 },
      { upto: null, step: 1 },
    ]);
    const summary = checkTariffImport(p, c).find((i) => i.code === 'SUMMARY')!;
    expect(summary.detail).toContain("Ağırlık yuvarlama tablodan alındı: 30,5 kg'a kadar 0,5 kg, üstü 1 kg");
    const same = checkTariffImport(p, { ...c, currentWeightSteps: importWeightSteps(p, c)! }).find((i) => i.code === 'SUMMARY')!;
    expect(same.detail).not.toContain('Ağırlık yuvarlama');
  });
});
