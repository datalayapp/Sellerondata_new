import { describe, expect, it } from 'vitest';
import { EDGE_WARN_CM, plausibilityLimits, plausibilityWarnings, RATIO_WARN, WARN_EDGE_RANGE, WARN_WEIGHT_RANGE, WEIGHT_WARN_KG } from '../src/lib/plausibility';

const v = (l: number | null, w: number | null, h: number | null, kg: number | null, divisor = 3000) => plausibilityWarnings({ l, w, h, kg, divisor });

describe('akla aykırı ölçü uyarısı', () => {
  it('eşikler sabit: kenar 150 cm, ağırlık 70 kg, oran 20', () => {
    expect([EDGE_WARN_CM, WEIGHT_WARN_KG, RATIO_WARN]).toEqual([150, 70, 20]);
  });

  it('olağan koli uyarı vermez', () => {
    expect(v(40, 30, 20, 2.4)).toEqual([]);
  });

  it('kenar 150 cm’yi aşınca uyarır, 150 cm’de uyarmaz', () => {
    expect(v(150, 30, 20, 30)).toEqual([]);
    expect(v(150.1, 30, 20, 30)).toEqual(['edge']);
    expect(v(40, 160, 20, 30)).toEqual(['edge']);
    expect(v(40, 30, 151, 30)).toEqual(['edge']);
  });

  it('ağırlık 70 kg’ı aşınca uyarır', () => {
    expect(v(40, 30, 20, 70)).toEqual([]);
    expect(v(40, 30, 20, 70.5)).toEqual(['weight']);
  });

  it('desi ağırlığın 20 katını aşınca uyarır', () => {
    // 60×40×50 / 3000 = 40 desi. 2 kg → 20 kat (sınırda, uyarmaz); 1,9 kg → 21 kat.
    expect(v(60, 40, 50, 2)).toEqual([]);
    expect(v(60, 40, 50, 1.9)).toEqual(['ratio']);
    // Bölen önemlidir: 5000'de 24 desi, 1,9 kg → 12,6 kat.
    expect(v(60, 40, 50, 1.9, 5000)).toEqual([]);
  });

  it('firma eşikleri (Y44): kenar ve ağırlık eşiği ayardan; oran eşiği sabit', () => {
    const limits = plausibilityLimits({ warnEdgeCm: 100, warnWeightKg: 30 });
    expect(limits).toEqual({ edgeCm: 100, weightKg: 30 });
    const w = (l: number, kg: number) => plausibilityWarnings({ l, w: 30, h: 20, kg, divisor: 3000, limits });
    expect(w(100, 30)).toEqual([]);
    expect(w(101, 30)).toEqual(['edge']);
    expect(w(40, 30.5)).toEqual(['weight']);
    // Daha yüksek eşik: 150 cm'yi aşan kenar ve 70 kg'ı aşan ağırlık artık uyarmaz.
    const wide = plausibilityLimits({ warnEdgeCm: 250, warnWeightKg: 300 });
    expect(plausibilityWarnings({ l: 200, w: 60, h: 60, kg: 120, divisor: 3000, limits: wide })).toEqual([]);
  });

  it('firma eşikleri (Y44): ayar gelmediyse ya da aralık dışıysa bugünkü sabitler', () => {
    const def = { edgeCm: EDGE_WARN_CM, weightKg: WEIGHT_WARN_KG };
    expect(plausibilityLimits(undefined)).toEqual(def);
    expect(plausibilityLimits(null)).toEqual(def);
    expect(plausibilityLimits({})).toEqual(def);
    expect(plausibilityLimits({ warnEdgeCm: '120', warnWeightKg: Number.NaN })).toEqual(def);
    expect(plausibilityLimits({ warnEdgeCm: WARN_EDGE_RANGE[0] - 1, warnWeightKg: WARN_WEIGHT_RANGE[1] + 1 })).toEqual(def);
    expect(plausibilityLimits({ warnEdgeCm: WARN_EDGE_RANGE[1], warnWeightKg: WARN_WEIGHT_RANGE[0] })).toEqual({ edgeCm: 400, weightKg: 1 });
    // Eşik verilmezse davranış bugünküyle aynı.
    expect(plausibilityWarnings({ l: 151, w: 30, h: 20, kg: 71, divisor: 3000 })).toEqual(['edge', 'weight']);
  });

  it('eksik değerde oran hesaplanmaz; birden çok uyarı birlikte döner', () => {
    expect(v(60, 40, null, 0.1)).toEqual([]);
    expect(v(60, 40, 50, null)).toEqual([]);
    expect(v(60, 40, 50, 0)).toEqual([]);
    expect(v(60, 40, 50, 1, 0)).toEqual([]);
    expect(v(200, 200, 200, 80)).toEqual(['edge', 'weight', 'ratio']);
  });
});
