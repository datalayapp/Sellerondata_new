/**
 * FedEx Pak / Zarf (ambalaj türü), veritabanısız: tarife sürümünün özeti mevcut tarifelerde değişmez, Pak / Zarf satırları ve
 * indirimleri özete girer, eski sürüm anlık görüntüsü ambalajsız okunur, içe aktarma dosyada olmayan ambalajın satırlarını
 * korur. Veritabanlı uçlar `packaging.test.ts`'te.
 */
import { describe, expect, it } from 'vitest';
import { snapshotToTariffInput } from '../src/services/compare.ts';
import { importedRates } from '../src/services/tariffImport.ts';
import { assertNoDuplicateRows, tariffBody, tariffContentHash, type TariffBody } from '../src/services/tariffs.ts';

/** Ambalaj göçünden önceki kuralla hesaplanmış özetler (göçten önceki kodla bir kez üretildi; bilerek değiştirilmez). */
const GOLDEN: { body: Record<string, unknown>; hash: string }[] = [
  {
    hash: 'd134ac01889a3b5003f18977a577edcb781f4d8961b975f409365236e87f66d0',
    body: {
      carrierId: 'carrier-aras',
      name: 'Aras Desi',
      currency: 'TRY',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'TR' }],
      rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * 10 })),
      overflow: [{ zone: 'TR', perUnit: 10 }],
      surcharges: [{ code: 'FUEL', name: 'Yakıt', kind: 'PCT', amount: 10 }],
    },
  },
  {
    hash: '004d94b489dad0c370e47a75ec90d6edcaa2ecee72ca0af44ff378860c596bb0',
    body: {
      carrierId: 'carrier-fedex',
      name: 'FedEx International Priority 2026',
      service: 'International Priority',
      currency: 'USD',
      divisor: 5000,
      edgeRounding: 'NONE',
      weightSteps: [
        { upto: 20, step: 0.5 },
        { upto: null, step: 1 },
      ],
      discountPct: 38.5,
      fuelPct: 25.25,
      fuelVariable: true,
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      active: true,
      isDefault: false,
      zones: [
        { country: 'DE', zone: 'A' },
        { country: 'FR', zone: 'A' },
        { country: 'GB', zone: 'B' },
        { country: 'US', zone: 'D' },
      ],
      rates: [
        { zone: 'A', weightUpto: 0.5, price: 650 },
        { zone: 'A', weightUpto: 1, price: 724.53 },
        { zone: 'B', weightUpto: 0.5, price: 767.0 },
        { zone: 'B', weightUpto: 1, price: 854.95 },
        { zone: 'D', weightUpto: 0.5, price: 1007.5 },
        { zone: 'A', weightUpto: 70, price: 12.4, perKg: true },
        { zone: 'B', weightUpto: 99999, price: 14.1, perKg: true },
      ],
      overflow: [{ zone: 'A', perUnit: 60.5 }],
      surcharges: [
        { code: 'RESI', name: 'Residential', kind: 'FIXED', amount: 4.5 },
        { code: 'OVERSIZE', name: 'Oversize', kind: 'PER_KG', amount: 1.25 },
      ],
      countryAdjustments: [{ country: 'US', pct: -12.5, note: 'faturadan', source: 'invoice', invoiceId: 'inv-1' }],
    },
  },
];

const fedex = (): TariffBody => tariffBody.parse(GOLDEN[1]!.body);

describe('tarife sürümü özeti: ambalaj', () => {
  it('ambalaj öncesi tarifelerin özeti değişmez (ambalajsız gövde, açık OWN ve boş indirimler aynı özet)', () => {
    for (const g of GOLDEN) {
      const b = tariffBody.parse(g.body);
      expect(tariffContentHash(b)).toBe(g.hash);
      // bugünkü anlık görüntü biçimi: her satırda packaging: 'OWN', iki indirim null
      const explicit: TariffBody = { ...b, pakDiscountPct: null, envelopeDiscountPct: null, rates: b.rates.map((r) => ({ ...r, packaging: 'OWN' as const })) };
      expect(tariffContentHash(explicit)).toBe(g.hash);
      // ham (ayrıştırılmamış) eski anlık görüntü de aynı özeti verir
      expect(tariffContentHash(g.body as TariffBody)).toBe(g.hash);
    }
  });

  it('eski sürüm anlık görüntüsü ambalajsız okunur: her satır OWN, Pak / Zarf indirimi boş', () => {
    const input = snapshotToTariffInput(GOLDEN[1]!.body, 't1', 'USD');
    expect(input.rates.every((r) => r.packaging === 'OWN')).toBe(true);
    expect(input.pakDiscountPct).toBeNull();
    expect(input.envelopeDiscountPct).toBeNull();
    const parsed = tariffBody.parse(GOLDEN[1]!.body);
    expect(parsed.rates.every((r) => r.packaging === 'OWN')).toBe(true);
    expect(parsed.pakDiscountPct).toBeUndefined();
  });

  it('Pak / Zarf satırı ve dolu indirim özeti değiştirir; Pak satırının sırası önemsiz', () => {
    const b = fedex();
    const h = tariffContentHash(b);
    const pak = { zone: 'A', weightUpto: 0.5, price: 400, perKg: false, packaging: 'PAK' as const };
    const env = { zone: 'A', weightUpto: 0.5, price: 300, perKg: false, packaging: 'ENVELOPE' as const };
    const withPak = { ...b, rates: [...b.rates, pak] };
    const hp = tariffContentHash(withPak);
    expect(hp).not.toBe(h);
    expect(tariffContentHash({ ...b, rates: [pak, ...b.rates] })).toBe(hp);
    // aynı fiyat Zarf olarak başka özet; ambalajı değişen satır başka özet
    expect(tariffContentHash({ ...b, rates: [...b.rates, { ...pak, packaging: 'ENVELOPE' as const }] })).not.toBe(hp);
    const both = tariffContentHash({ ...b, rates: [...b.rates, pak, env] });
    expect(tariffContentHash({ ...b, rates: [env, ...b.rates, pak] })).toBe(both);
    expect(tariffContentHash({ ...b, pakDiscountPct: 10 })).not.toBe(h);
    expect(tariffContentHash({ ...b, envelopeDiscountPct: 10 })).not.toBe(h);
    expect(tariffContentHash({ ...b, pakDiscountPct: 10 })).not.toBe(tariffContentHash({ ...b, envelopeDiscountPct: 10 }));
    // %0 indirim boş indirimden farklıdır (boş = tarifenin indirimi)
    expect(tariffContentHash({ ...b, pakDiscountPct: 0 })).not.toBe(h);
  });

  it('aynı bölge ve ağırlıkta Pak ve kendi ambalaj satırı birlikte durabilir; aynı ambalajda ikinci satır 400', () => {
    const b = fedex();
    const pak = { zone: 'A', weightUpto: 0.5, price: 400, perKg: false, packaging: 'PAK' as const };
    expect(() => assertNoDuplicateRows({ ...b, rates: [...b.rates, pak] })).not.toThrow();
    expect(() => assertNoDuplicateRows({ ...b, rates: [...b.rates, pak, { ...pak, price: 401 }] })).toThrow();
    expect(() => assertNoDuplicateRows({ ...b, rates: [...b.rates, { ...b.rates[0]!, price: 1 }] })).toThrow();
  });
});

describe('tarife içe aktarma: ambalaj', () => {
  const current = {
    rates: [
      { zone: 'A', weightUpto: 1, price: 100, perKg: false, packaging: 'OWN' as const },
      { zone: 'A', weightUpto: 1, price: 60, perKg: false, packaging: 'PAK' as const },
      { zone: 'A', weightUpto: 0.5, price: 40, perKg: false, packaging: 'ENVELOPE' as const },
    ],
  };
  type Parsed = Parameters<typeof importedRates>[0];
  // core: `rates` yalnız kendi ambalajı, poşet / zarf satırları `packagingRates`'te
  const parsed = (rows: Record<string, unknown>[]) =>
    ({ rates: rows.filter((r) => !r.packaging), packagingRates: rows.filter((r) => r.packaging) }) as unknown as Parsed;

  it('dosyada yalnız koli tablosu varsa mevcut Pak / Zarf satırları korunur', () => {
    const out = importedRates(parsed([{ zone: 'A', weightUpto: 1, price: 110, row: 2 }]), current);
    expect(out.map((r) => [r.packaging ?? 'OWN', r.price])).toEqual([
      ['OWN', 110],
      ['PAK', 60],
      ['ENVELOPE', 40],
    ]);
  });

  it('dosyadaki ambalajın satırları dosyadakilerle değişir, öbürleri korunur', () => {
    const out = importedRates(
      parsed([
        { zone: 'A', weightUpto: 1, price: 110, row: 2 },
        { zone: 'A', weightUpto: 1, price: 65, packaging: 'PAK', row: 3 },
      ]),
      current,
    );
    expect(out.map((r) => [r.packaging ?? 'OWN', r.price])).toEqual([
      ['OWN', 110],
      ['PAK', 65],
      ['ENVELOPE', 40],
    ]);
    // satır numarası ve üretilmiş işareti tarifeye yazılmaz
    expect(out[0]).not.toHaveProperty('row');
  });
});
