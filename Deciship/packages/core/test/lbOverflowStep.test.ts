// Y42 (DENETIM-2, eski adı Y20): lb tarifesinde "her ilave 1,5 lb" ve "her ilave 0,75 lb" aşımı. Bu iki adımın kg
// karşılığı (0,680388555 · 0,340194278) lb basamağı tanınmıyordu: hesap 680 · 340 g'lık kg basamağıyla sıfırdan sayıyor,
// son satırın üstünde bir aşım birimi fazla bekleniyordu (13 lb → 32 yerine 28). Kg tarifelerinin 0,68 · 0,34 kg
// basamağı (olağandışı ama olası) değişmemeli.
import { describe, expect, it } from 'vitest';
import {
  chargeableWeight,
  expectedCharge,
  importWeightSteps,
  lbStepKg,
  overflowUnits,
  parseTariffImport,
  ratePrice,
  roundUpToStep,
  type RawTariffFile,
  type TariffImportContext,
  type WeightStep,
} from '../src/index';

const LB = 0.45359237;
const xlsxRaw = (prices: string[][]): RawTariffFile => ({ fileName: 'x.xlsx', kind: 'xlsx', prices, zones: null, surcharges: null });
const ctx = (over: Partial<TariffImportContext> = {}): TariffImportContext => ({ tariffCurrency: 'USD', currentZones: [{ country: '*', zone: 'A' }], currentRates: [], ...over });
const o = { convertLbToKg: true, currency: 'USD' };

/** Liste: n lb = 10 + n (1–10 lb, son satır 10 lb = 20 USD), üstü "Additional X lb" = perUnit. */
function lbList(extra: [string, string]): string[][] {
  const r: string[][] = [['Weight (lb)', 'A']];
  for (let lb = 1; lb <= 10; lb++) r.push([String(lb), String(10 + lb)]);
  return [...r, extra];
}

function priceWith(steps: WeightStep[], rows: string[][]) {
  const p = parseTariffImport(xlsxRaw(rows), o);
  const tariff = { rates: p.rates, overflowPerUnit: { A: p.overflow[0]!.perUnit }, weightSteps: steps, zones: { '*': 'A' } } as never;
  return (kg: number) => (ratePrice(tariff, 'A', roundUpToStep(kg, steps)) as { ok: boolean; price: number }).price;
}

// Elle doğrulanmış beklenenler. Taşıyıcı: kg → lb (÷ 0,45359237), son satırın (10 lb) üstündeki kısım X lb'lik
// başlamış birim sayısıyla: fiyat = 20 + perUnit × ⌈(lb − 10) / X⌉. Tam lb sınırının 3 haneli kg'ı (11,5 lb = 5,21631 →
// 5,216) aynı sınır sayılır (calc.ts: 3 haneli kg sınırı en çok 0,5 g kaçırır).
const ONE_AND_HALF: [kg: number, why: string, price: number][] = [
  [4.536, 'tam 10 lb: son satır', 20],
  [4.6, '10,14 lb → 1 birim (11,5 lb)', 24],
  [5.216, 'tam 11,5 lb → 1 birim', 24],
  [5.217, '11,502 lb → 2 birim (13 lb)', 28],
  [5.5, '12,13 lb → 2 birim (eskiden 6,12 kg → 3 birim, 32)', 28],
  [5.897, 'tam 13 lb → 2 birim (eskiden 32)', 28],
  [5.9, '13,007 lb → 3 birim (14,5 lb)', 32],
  [6.577, 'tam 14,5 lb → 3 birim', 32],
  [45.359, 'tam 100 lb → 60 birim', 260],
  [100, '220,46 lb → 141 birim', 584],
];
const THREE_QUARTERS: [kg: number, why: string, price: number][] = [
  [4.536, 'tam 10 lb: son satır', 20],
  [4.7, '10,36 lb → 1 birim (10,75 lb)', 22],
  [4.876, 'tam 10,75 lb → 1 birim', 22],
  [4.877, '10,752 lb → 2 birim (11,5 lb)', 24],
  [5.216, 'tam 11,5 lb → 2 birim (eskiden 5,44 kg → 3 birim, 26)', 24],
  [5.217, '11,502 lb → 3 birim (12,25 lb)', 26],
  [5.5, '12,13 lb → 3 birim', 26],
  [5.557, 'tam 12,25 lb → 3 birim', 26],
  [45.359, 'tam 100 lb → 120 birim', 260],
];

describe('Y42: lb tarifesinde "her ilave 1,5 lb" ve "her ilave 0,75 lb" aşımı', () => {
  const cases = [
    { name: '1,5 lb', extra: ['Additional 1.5 lb', '4'] as [string, string], stepLb: 1.5, edited: 0.68, hand: ONE_AND_HALF },
    { name: '0,75 lb', extra: ['Additional 0.75 lb', '2'] as [string, string], stepLb: 0.75, edited: 0.34, hand: THREE_QUARTERS },
  ];

  for (const c of cases) {
    it(`${c.name}: içe aktarılan basamaklar ve beklenen tutarlar (elle doğrulanmış)`, () => {
      const rows = lbList(c.extra);
      const p = parseTariffImport(xlsxRaw(rows), o);
      expect(p.overflow).toEqual([{ zone: 'A', perUnit: Number(c.extra[1]) }]);
      const steps = importWeightSteps(p, ctx())!;
      expect(steps).toHaveLength(2);
      expect(steps[0]).toEqual({ upto: 4.536, step: LB });
      expect(steps[1]!.upto).toBeNull();
      expect(steps[1]!.step).toBeCloseTo(c.stepLb * LB, 12);
      const price = priceWith(steps, rows);
      for (const [kg, why, want] of c.hand) expect(price(kg), `${kg} kg: ${why}`).toBe(want);
    });

    it(`${c.name}: düzenleyicide 3 haneye yuvarlanmış basamak (0,454 · ${c.edited}) aynı tutarı verir`, () => {
      const rows = lbList(c.extra);
      const steps: WeightStep[] = [
        { upto: 4.536, step: 0.454 },
        { upto: null, step: c.edited },
      ];
      const price = priceWith(steps, rows);
      for (const [kg, why, want] of c.hand) expect(price(kg), `${c.edited}: ${kg} kg: ${why}`).toBe(want);
    });

    it(`${c.name}: hesap motoru yolu (chargeableWeight + expectedCharge) aynı tutarı verir`, () => {
      const rows = lbList(c.extra);
      const p = parseTariffImport(xlsxRaw(rows), o);
      const steps = importWeightSteps(p, ctx())!;
      const tariff = {
        rates: p.rates,
        overflowPerUnit: { A: p.overflow[0]!.perUnit },
        weightSteps: steps,
        zones: { '*': 'A' },
        discountPct: 0,
        fuelPct: 0,
        surcharges: [],
        divisor: 5000,
      } as never;
      for (const [kg, why, want] of c.hand) {
        const { chargeable } = chargeableWeight({ dims: { l: 1, w: 1, h: 1 }, actualKg: kg, divisor: 5000, steps });
        expect(expectedCharge({ tariff, chargeableKg: chargeable, destCountry: 'US' }), `${kg} kg: ${why}`).toMatchObject({ ok: true, total: want });
      }
    });
  }

  it('ücretli ağırlık taşıyıcının lb sınırına yuvarlanır (13 lb = 5,897 kg; 12,25 lb = 5,557 kg)', () => {
    expect(roundUpToStep(5.5, [{ upto: 4.536, step: LB }, { upto: null, step: 1.5 * LB }])).toBe(5.897);
    expect(roundUpToStep(5.5, [{ upto: 4.536, step: LB }, { upto: null, step: 0.75 * LB }])).toBe(5.557);
    expect(overflowUnits(5.897, 4.536, 1.5 * LB)).toBe(2);
    expect(overflowUnits(5.557, 4.536, 0.75 * LB)).toBe(3);
    // tam hassasiyetli lb adımı bağlamsız da tanınır
    expect(lbStepKg(1.5 * LB)).toBeCloseTo(1.5 * LB, 12);
    expect(lbStepKg(0.75 * LB)).toBeCloseTo(0.75 * LB, 12);
  });

  it('kg tarifesindeki 0,68 · 0,34 kg basamağı değişmez (kg olarak sıfırdan sayılır)', () => {
    // bağlamsız 3 haneli değer kg basamağıdır
    for (const s of [0.34, 0.68]) expect(lbStepKg(s), String(s)).toBeNull();
    // 1 kg'lık tablo, üstü 0,68 kg: 11 kg → ⌈11000 / 680⌉ = 17 → 11,56 kg; 10 kg satırından sonra ⌈1560 / 680⌉ = 3 birim
    const kgSteps: WeightStep[] = [
      { upto: 10, step: 1 },
      { upto: null, step: 0.68 },
    ];
    expect(roundUpToStep(11, kgSteps)).toBe(11.56);
    expect(overflowUnits(11.56, 10, 0.68)).toBe(3);
    expect(overflowUnits(11.56, 10, 0.68, kgSteps)).toBe(3);
    // tek bant 0,34 kg: 1,021 kg → ⌈1021 / 340⌉ = 4 → 1,36 kg
    expect(roundUpToStep(1.021, [{ upto: null, step: 0.34 }])).toBe(1.36);
    // 11 kg (24,25 lb'ye denk düşen kg sınırı) bağlam sayılmaz
    expect(roundUpToStep(11.2, [{ upto: 11, step: 1 }, { upto: null, step: 0.68 }])).toBe(11.56);
    expect(overflowUnits(11.56, 11, 0.68, [{ upto: 11, step: 1 }, { upto: null, step: 0.68 }])).toBe(1);
  });
});
