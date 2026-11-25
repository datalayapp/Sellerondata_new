/**
 * Performans için yazılan kısa yolların sonuçları eski (genel) yolla birebir aynı mı?
 * - cleanFloat: Number(n.toPrecision(12)) ile
 * - ratePrice: bölge dizini yerine her çağrıda tüm satırları süzen eski uygulamayla
 * - parseTrNumber / parseNumberAs: sık biçimler ("123", "-12,5", "1234.56") genel kurallarla
 */
import { describe, expect, it } from 'vitest';
import { cleanFloat, fmtKg, parseNumberAs, parseTrNumber, ratePrice, round2, round3, stepFor, zoneKey, type TariffInput } from '../src/index';
import { FEDEX } from './fixtures';

let seed = 20261105;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

describe('cleanFloat', () => {
  it('rastgele 300.000 değerde toPrecision(12) ile aynı', () => {
    const gens = [
      () => Math.round(rnd() * 1e7) / 100,
      () => (Math.round(rnd() * 1e7) / 100) * 1.18,
      () => Math.round(rnd() * 1e7) / 100 / 1.2,
      () => (Math.round(rnd() * 1e6) / 1000) * 1000,
      () => (rnd() - 0.5) * 10 ** Math.floor(rnd() * 30 - 12),
      () => (Math.round(rnd() * 200) / 2 + 0.005) * 100,
      () => -(Math.round(rnd() * 1e7) / 100) * 0.38,
      () => ((l) => (l * l * l) / 5000)(Math.round(rnd() * 2000) / 10),
    ];
    const fixed = [0, -0, 0.5, 1.005, 580.545, 580.5449999999, 1e-7, 1e-6, 999999999999.5, 99999999999.95, 0.1 + 0.2, 2.675, 1e11 + 0.5, 9.999999999995, Infinity, -Infinity, NaN];
    let bad = 0;
    for (let i = 0; i < 300_000 + fixed.length; i++) {
      const v = i < fixed.length ? fixed[i]! : pick(gens)();
      const ref = !Number.isFinite(v) || v === 0 ? (v === 0 ? 0 : v) : Number(v.toPrecision(12));
      if (!Object.is(cleanFloat(v), ref)) bad++;
    }
    expect(bad).toBe(0);
  });
});

/** Dizinden önceki ratePrice (her çağrıda süz + sırala). */
function ratePriceReference(tariff: TariffInput, zone: string, chargeableKg: number) {
  const key = zoneKey(zone);
  const rows = tariff.rates.filter((r) => zoneKey(r.zone) === key).sort((a, b) => a.weightUpto - b.weightUpto);
  if (rows.length === 0) return { ok: false, reason: `Tarifede ${zone} bölgesi için fiyat satırı yok` };
  const g = Math.round(round3(chargeableKg) * 1000);
  const hit = rows.find((r) => Math.round(round3(r.weightUpto) * 1000) >= g);
  if (hit?.perKg) {
    const kg = round3(chargeableKg);
    return { ok: true, price: round2(hit.price * kg), label: `Tarife fiyatı (Bölge ${zone}, kg başı ${String(round2(hit.price)).replace('.', ',')} × ${fmtKg(kg)})` };
  }
  if (hit) return { ok: true, price: round2(hit.price), label: `Tarife fiyatı (Bölge ${zone}, ${fmtKg(chargeableKg)})` };
  const last = rows[rows.length - 1]!;
  if (last.perKg) return { ok: false, reason: `${fmtKg(chargeableKg)} tarifedeki son kg başı bandını (${fmtKg(last.weightUpto)}) aşıyor` };
  const map = tariff.overflowPerUnit;
  let perUnit: number | undefined;
  if (map) {
    perUnit = map[zone];
    if (perUnit == null)
      for (const [z, v] of Object.entries(map))
        if (zoneKey(z) === zoneKey(zone)) {
          perUnit = v;
          break;
        }
  }
  if (perUnit == null) return { ok: false, reason: `${fmtKg(chargeableKg)} tarifedeki en yüksek ağırlığı (${fmtKg(last.weightUpto)}) aşıyor ve taşma fiyatı tanımlı değil` };
  const stepG = Math.round(stepFor(chargeableKg, tariff.weightSteps) * 1000);
  const units = Math.ceil((g - Math.round(round3(last.weightUpto) * 1000)) / stepG);
  return { ok: true, price: round2(last.price + units * perUnit), label: `Tarife fiyatı (Bölge ${zone}, ${fmtKg(chargeableKg)}, taşma ${units} birim)` };
}

describe('ratePrice bölge dizini', () => {
  it('rastgele 10.000 sorguda eski uygulamayla aynı (karışık sıra, bölge adı yazımları, kg başı bant, taşma)', () => {
    const names = [['A', 'Zone A', 'a', 'A Bölgesi'], ['B', 'ZONE-B', 'Bölge B'], ['3', 'Zone 3'], ['EU']];
    const tariffs: TariffInput[] = Array.from({ length: 8 }, (_, i) => {
      const rates: TariffInput['rates'] = [];
      for (const z of names.slice(0, 2 + (i % 3))) {
        const max = pick([10, 30, 70]);
        for (let w = 0.5; w <= max; w += pick([0.5, 1])) rates.push({ zone: pick(z), weightUpto: w, price: round2(100 + w * 90 * rnd()) });
        rates.push({ zone: pick(z), weightUpto: 0.5, price: 1 }); // aynı ağırlıkta ikinci satır: kararlı sıralama
        if (rnd() < 0.4) rates.push({ zone: pick(z), weightUpto: max + 50, price: 12.5, perKg: true });
      }
      for (let k = rates.length - 1; k > 0; k--) {
        const j = Math.floor(rnd() * (k + 1));
        [rates[k], rates[j]] = [rates[j]!, rates[k]!];
      }
      return { ...FEDEX, id: `t${i}`, rates, overflowPerUnit: rnd() < 0.6 ? { [pick(names[0]!)]: 25, B: 30 } : undefined };
    });
    let bad = 0;
    for (let i = 0; i < 10_000; i++) {
      const t = pick(tariffs);
      const zone = pick([...names.flat(), 'Z', ' zone  a ']);
      const kg = Math.round(rnd() * 150 * 1000) / 1000;
      if (JSON.stringify(ratePrice(t, zone, kg)) !== JSON.stringify(ratePriceReference(t, zone, kg))) bad++;
    }
    expect(bad).toBe(0);
  });

  it('satır sonradan eklenirse dizin yenilenir', () => {
    const t: TariffInput = { ...FEDEX, rates: [{ zone: 'A', weightUpto: 1, price: 10 }] };
    expect(ratePrice(t, 'B', 1).ok).toBe(false);
    t.rates.push({ zone: 'B', weightUpto: 1, price: 20 });
    expect(ratePrice(t, 'B', 1)).toMatchObject({ ok: true, price: 20 });
  });
});

describe('sayı okuma kısa yolu', () => {
  it('genel kurallarla aynı sonuç', () => {
    expect(parseTrNumber('123')).toBe(123);
    expect(Object.is(parseTrNumber('-0'), -0)).toBe(true);
    expect(parseTrNumber('007')).toBe(7);
    expect(parseTrNumber('-1234,56')).toBe(-1234.56);
    expect(parseTrNumber('9'.repeat(400))).toBeNull();
    expect(parseTrNumber('1.234')).toBe(1234);
    expect(parseNumberAs('-1234.56', 'en')).toBe(-1234.56);
    expect(parseNumberAs('1.234', 'en')).toBe(1.234);
    expect(parseNumberAs('1,234', 'en')).toBe(1234);
    expect(parseNumberAs('12,5', 'en')).toBe(12.5);
    expect(parseNumberAs('9'.repeat(400), 'en')).toBeNull();
    expect(parseNumberAs('1.234', 'tr')).toBe(1234);
  });
});
