/**
 * KALANLAR Aşama 1 (gerçek Türk tarifesi ve faturası öncesi), tarife satırları:
 * - 1.1 Yeni tarifenin kapsamı: yurt içi taşıyıcı 3000 bölen + sabit yakıt (PTT ve "Diğer" adla), yurt dışı 5000 + değişken.
 * - 1.2 Bölge eşlemesi olmayan tek bölgeli tarifeye kendiliğinden `*`.
 * - 1.7 "31+", "30 desi üzeri", "her ilave desi" satırları ilave birim başı okunur (son satır + k × fiyat); okunamayan sorulur.
 * - 1.9 İki ya da daha çok mesafe bölgeli tarifede fiyat farkı "İncele" (`ZONE_DISTANCE`).
 */
import { describe, expect, it } from 'vitest';
import {
  DOMESTIC_DIVISOR,
  INTERNATIONAL_DIVISOR,
  autoStarZone,
  carrierScope,
  checkTariffImport,
  compareLine,
  distanceZoneCount,
  effectiveZones,
  expectedCharge,
  importWeightSteps,
  isDomesticCarrier,
  localizeComparison,
  parseStepRule,
  parseTariffImport,
  parseWeightLabel,
  scopeDivisor,
  scopeFuelVariable,
  t,
  tariffImportFixes,
  type ParsedTariffImport,
  type RawTariffFile,
  type TariffImportContext,
  type TariffImportOptions,
  type TariffInput,
} from '../src/index';
import { TOL, line, meas } from './fixtures';

const xlsx = (prices: string[][], over: Partial<RawTariffFile> = {}): RawTariffFile => ({ fileName: 'x.xlsx', kind: 'xlsx', prices, zones: null, surcharges: null, ...over });
const ctx = (over: Partial<TariffImportContext> = {}): TariffImportContext => ({ tariffCurrency: 'TRY', currentZones: [], currentRates: [], newTariff: true, domestic: true, ...over });
const codesOf = (p: ParsedTariffImport, c: TariffImportContext = ctx(), o: TariffImportOptions = {}) =>
  checkTariffImport(p, c, o).map((i) => `${i.severity}:${i.code}`);

/** İçe aktarmanın uygulayacağı tarife (fiyat, aşım, basamak, eşleme) hesap motoruna. */
function tariffOf(p: ParsedTariffImport, c: TariffImportContext = ctx()): TariffInput {
  return {
    id: 't',
    currency: 'TRY',
    divisor: 3000,
    edgeRounding: 'CEIL_CM',
    weightSteps: importWeightSteps(p, c) ?? [],
    discountPct: 0,
    fuelPct: 0,
    zones: Object.fromEntries(effectiveZones(p, c).map((z) => [z.country, z.zone])),
    rates: p.rates.map((r) => ({ zone: r.zone, weightUpto: r.weightUpto, price: r.price, ...(r.perKg ? { perKg: true } : {}) })),
    overflowPerUnit: Object.fromEntries(p.overflow.map((o) => [o.zone, o.perUnit])),
    surcharges: [],
  };
}
const base = (tariff: TariffInput, kg: number) => {
  const e = expectedCharge({ tariff, chargeableKg: kg, destCountry: 'TR' });
  return e.ok ? e.base : e.reason;
};
/** 1–30 desi (30 desi 195 TL) + son satır. */
const domestic = (last: string[]): string[][] => [['Desi', 'Fiyat'], ['1', '60'], ['10', '120'], ['20', '160'], ['30', '195'], last];

describe('1.1 yeni tarifenin kapsamı (yurt içi / yurt dışı)', () => {
  it('kodla: aras, yurtici, mng, ptt yurt içi; fedex, ups, dhl yurt dışı', () => {
    for (const code of ['aras', 'yurtici', 'mng', 'ptt', ' PTT ']) expect(carrierScope({ code }), code).toBe('domestic');
    for (const code of ['fedex', 'ups', 'dhl']) expect(carrierScope({ code, name: 'Sürat' }), code).toBe('international');
  });

  it('"Diğer" taşıyıcı adıyla: Türk taşıyıcıları ve adı bilinmeyen yurt içi, bilinen yurt dışı adları yurt dışı', () => {
    for (const name of ['Sürat Kargo', 'HepsiJet', 'Kolay Gelsin', 'Sendeo', 'Trendyol Express', 'Diğer / Genel', '', 'KARGOİST'])
      expect(carrierScope({ code: 'generic', name }), name).toBe('domestic');
    for (const name of [
      'TNT Express', 'Aramex', 'GLS', 'DPD Türkiye', 'Yurt Dışı Kargo', 'YURTDIŞI', 'PTT International', 'USPS',
      // inceleme: eksik adlar
      'Hermes', 'PostNord', 'SF Express', 'Yanwen', 'China Post', 'Swiss Post', 'Evri', 'Global Express', 'Hepsi Global', 'PTT EMS', 'Ekol Uluslararası',
    ])
      expect(carrierScope({ code: 'generic', name }), name).toBe('international');
    expect(carrierScope(null)).toBe('domestic');
  });

  it('kapsamın bölen ve yakıt varsayılanı', () => {
    expect([scopeDivisor('domestic'), scopeFuelVariable('domestic')]).toEqual([DOMESTIC_DIVISOR, false]);
    expect([scopeDivisor('international'), scopeFuelVariable('international')]).toEqual([INTERNATIONAL_DIVISOR, true]);
    expect([DOMESTIC_DIVISOR, INTERNATIONAL_DIVISOR]).toEqual([3000, 5000]);
    expect(isDomesticCarrier({ code: 'ptt', name: 'PTT Kargo' })).toBe(true);
    expect(isDomesticCarrier({ code: 'ups', name: 'UPS' })).toBe(false);
  });
});

describe('1.2 bölge eşlemesi olmayan tarife', () => {
  it('tek bölgeli fiyat tablosu, Bölgeler sayfası ve mevcut eşleme yok → * kendiliğinden; bütün satırlar o fiyattan', () => {
    const p = parseTariffImport(xlsx(domestic(['31+', '8'])));
    expect(autoStarZone(p)).toBe('Fiyat');
    expect(effectiveZones(p, ctx())).toEqual([{ country: '*', zone: 'Fiyat' }]);
    const c = codesOf(p);
    expect(c).toContain('info:ZONE_STAR_AUTO');
    expect(c).not.toContain('warning:NO_COUNTRY_MAPPING');
    expect(checkTariffImport(p, ctx()).find((i) => i.code === 'ZONE_STAR_AUTO')!.title).toBe('Bölge eşlemesi yok: bütün gönderiler (*) "Fiyat" fiyatından karşılaştırılır');
    expect(checkTariffImport(p, ctx(), {}, 'en').find((i) => i.code === 'ZONE_STAR_AUTO')!.title).toBe('No zone mapping: all shipments (*) are compared with the "Fiyat" prices');
    expect(base(tariffOf(p), 10)).toBe(120);
  });

  it('yurt dışı taşıyıcıda ("Weight | Zone A") ve kayıtlı tarifeye içe aktarmada * eklenmez, eşleme uyarısı kalır', () => {
    const fedex = parseTariffImport(xlsx([['Weight (kg)', 'Zone A'], ['0,5', '650'], ['1', '725'], ['5', '1320']]));
    const intl = ctx({ domestic: false });
    expect(effectiveZones(fedex, intl)).toEqual([]);
    expect(codesOf(fedex, intl)).toContain('warning:NO_COUNTRY_MAPPING');
    expect(codesOf(fedex, intl)).not.toContain('info:ZONE_STAR_AUTO');
    const p = parseTariffImport(xlsx(domestic(['31+', '8'])));
    const existing = ctx({ newTariff: false, currentZones: [] });
    expect(effectiveZones(p, existing)).toEqual([]);
    expect(codesOf(p, existing)).toContain('warning:NO_COUNTRY_MAPPING');
    // kapsam bilinmiyorsa (eski çağıran) da eklenmez
    expect(effectiveZones(p, ctx({ domestic: undefined }))).toEqual([]);
  });

  it('mevcut tarifenin eşlemesi ya da dosyanın Bölgeler sayfası varsa o kalır; çok bölgede tahmin yok', () => {
    const p = parseTariffImport(xlsx(domestic(['31+', '8'])));
    const current = ctx({ currentZones: [{ country: 'TR', zone: 'Fiyat' }], newTariff: false });
    expect(effectiveZones(p, current)).toEqual([{ country: 'TR', zone: 'Fiyat' }]);
    expect(codesOf(p, current)).not.toContain('info:ZONE_STAR_AUTO');
    const sheet = parseTariffImport(xlsx(domestic(['31+', '8']), { zones: [['Ülke kodu', 'Bölge'], ['TR', 'Fiyat']] }));
    expect(effectiveZones(sheet, ctx())).toEqual([{ country: 'TR', zone: 'Fiyat' }]);
    const two = parseTariffImport(xlsx([['Ağırlık', 'A', 'B'], ['1', '10', '12'], ['2', '11', '13']]));
    expect(autoStarZone(two)).toBeNull();
    expect(effectiveZones(two, ctx())).toEqual([]);
    expect(codesOf(two)).toContain('warning:NO_COUNTRY_MAPPING');
  });
});

describe('1.7 açık uçlu ve ilave satırları', () => {
  it('örnek (B4.3): 30 desi 195, üstü her desi 8 → 35 desi 235 (eskiden 8 × 35 = 280)', () => {
    const p = parseTariffImport(xlsx(domestic(['31+', '8'])));
    expect(p.overflow).toEqual([{ zone: 'Fiyat', perUnit: 8 }]);
    expect(p.overflowStep).toBe(1);
    expect(p.rates.some((r) => r.weightUpto > 30)).toBe(false);
    const tariff = tariffOf(p);
    expect(tariff.weightSteps.at(-1)).toEqual({ upto: null, step: 1 });
    expect([base(tariff, 30), base(tariff, 31), base(tariff, 35), base(tariff, 34.2)]).toEqual([195, 203, 235, 235]);
    expect(codesOf(p)).toContain('warning:OPEN_BAND_ADDITIONAL');
  });

  it('açık uçlu yazımlar aynı okunur: "30 desi üzeri", "30 DESİ ÜZERİ", "30+ desi", "> 30", "31-∞", "31 ve üstü"', () => {
    for (const label of ['30 desi üzeri', '30 DESİ ÜZERİ', '30+ desi', '30 + desi', '> 30', '>30 desi', '31-∞', '31 - ∞', '31 ve üstü', '31 ve üzeri', '30 kg üzeri', '31 desi ve üzeri']) {
      const p = parseTariffImport(xlsx(domestic([label, '8'])));
      expect(p.overflow, label).toEqual([{ zone: 'Fiyat', perUnit: 8 }]);
      expect(base(tariffOf(p), 35), label).toBe(235);
      expect(parseWeightLabel(label)?.kind, label).toBe('open');
    }
  });

  it('ilave yazımları ("Her ilave desi", "30 desi üzeri her desi için", "+1 desi") son satırdan sonra aşım fiyatı', () => {
    const labels = ['Her ilave desi', 'İlave desi', 'her ilave 1 desi', 'İLAVE HER DESİ', '30 desi üzeri her desi için', '30 desi üstü her ilave desi', '30 desiden sonra her ilave desi', '30 Desi Üzeri Her Desi', '+1 desi', 'Each additional kg', 'Her ek kg'];
    for (const label of labels) {
      const p = parseTariffImport(xlsx(domestic([label, '8'])));
      expect(p.overflow, label).toEqual([{ zone: 'Fiyat', perUnit: 8 }]);
      expect(p.stepIssues, label).toEqual([]);
      expect(base(tariffOf(p), 35), label).toBe(235);
      // ilave kuralı uyarı istemez (yazımı açık)
      expect(codesOf(p).filter((c) => c.includes('OPEN_BAND') || c.includes('STEP')), label).toEqual([]);
    }
    expect(parseStepRule('30 desi üzeri her desi için')).toEqual({ step: 1, from: 30 });
    expect(parseStepRule('Her ilave 0,5 kg')).toEqual({ step: 0.5, from: null });
    expect(parseStepRule('İlave 0,5 kg')).toEqual({ step: 0.5, from: null });
    expect(parseStepRule('31+')).toBeNull();
    expect(parseStepRule('Ek hizmet')).toBeNull();
    expect(parseStepRule('30')).toBeNull();
  });

  it('çok bölgeli tablo: her bölge kendi son satırından', () => {
    const p = parseTariffImport(xlsx([['Desi', 'A', 'B'], ['1', '60', '70'], ['30', '195', '230'], ['31+', '8', '9']], { zones: [['Ülke kodu', 'Bölge'], ['*', 'A']] }));
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 8 }, { zone: 'B', perUnit: 9 }]);
    const tariff = tariffOf(p);
    expect(base({ ...tariff, zones: { '*': 'B' } }, 35)).toBe(275);
    expect(base(tariff, 35)).toBe(235);
  });


  it('başlangıcı tablonun sonuna uymayan açık uç ("50+" ama tablo 30\'da bitiyor) okunmaz, sorulur; seçince uygulanır', () => {
    const raw = xlsx(domestic(['50+', '8']));
    const p = parseTariffImport(raw);
    expect(p.overflow).toEqual([]);
    expect(p.rates.some((r) => r.weightUpto > 30)).toBe(false);
    const err = checkTariffImport(p, ctx()).find((i) => i.code === 'OPEN_BAND_UNCLEAR')!;
    expect(err.severity).toBe('error');
    expect(err.detail).toBe('satır 6, bölge Fiyat: "50+" 8,00; tablo 30,0 kg satırında bitiyor (195,00): başlangıç tablonun son satırına uymuyor');
    const fixes = tariffImportFixes(p, ctx()).filter((f) => f.id === 'openBandMode');
    expect(fixes.map((f) => [f.value, f.resolves])).toEqual([
      ['additional', ['OPEN_BAND_UNCLEAR', 'OPEN_BAND_ADDITIONAL']],
      ['perKg', ['OPEN_BAND_UNCLEAR', 'OPEN_BAND_ADDITIONAL']],
      ['flat', ['OPEN_BAND_UNCLEAR', 'OPEN_BAND_ADDITIONAL']],
    ]);
    expect(fixes[0]!.label).toBe('Açık uçlu satır: son satırın fiyatı + her ilave birim');
    const chosen = parseTariffImport(raw, { openBandMode: 'additional' });
    expect(chosen.overflow).toEqual([{ zone: 'Fiyat', perUnit: 8 }]);
    expect(codesOf(chosen, ctx(), { openBandMode: 'additional' }).filter((c) => c.includes('OPEN_BAND'))).toEqual([]);
    const perKg = parseTariffImport(raw, { openBandMode: 'perKg' });
    expect(perKg.rates.find((r) => r.weightUpto === 99999)).toMatchObject({ price: 8, perKg: true });
    const flat = parseTariffImport(raw, { openBandMode: 'flat' });
    expect(flat.rates.find((r) => r.weightUpto === 99999)).toEqual({ zone: 'Fiyat', weightUpto: 99999, price: 8, row: 6 });
  });

  it('ilave fiyatı tablodaki artıştan çok düşükse ("31+ | 1", 20→30 desi +35) sorulur', () => {
    const p = parseTariffImport(xlsx(domestic(['31+', '1'])));
    expect(p.overflow).toEqual([]);
    expect(p.openBands.map((b) => [b.reading, b.why])).toEqual([['unclear', 'price']]);
    expect(checkTariffImport(p, ctx()).find((i) => i.code === 'OPEN_BAND_UNCLEAR')!.detail).toBe(
      'satır 6, bölge Fiyat: "31+" 1,00; tablo 30,0 kg satırında bitiyor (195,00): ilave birim fiyatı tablodaki artıştan çok düşük',
    );
    // artış 3,5/desi: yarısı 1,75; 2 ilave sayılır
    expect(parseTariffImport(xlsx(domestic(['31+', '2']))).overflow).toEqual([{ zone: 'Fiyat', perUnit: 2 }]);
    expect(parseTariffImport(xlsx(domestic(['31+', '1'])), { openBandMode: 'additional' }).overflow).toEqual([{ zone: 'Fiyat', perUnit: 1 }]);
  });

  it('açık uç ("31+", "> 30", "30+ desi", "31-∞", "31 ve üstü") önceki satırdan ucuz sabit fiyatsa sorulur; pahalıysa sabit', () => {
    for (const label of ['31+', '30 üzeri', '> 30', '30+ desi', '31-∞', '31 ve üstü']) {
      const p = parseTariffImport(xlsx(domestic([label, '60'])));
      expect(p.openBands.map((b) => [b.reading, b.why]), label).toEqual([['unclear', 'cheaper']]);
      expect(p.rates.some((r) => r.weightUpto === 99999), label).toBe(false);
      expect(codesOf(p), label).toContain('error:OPEN_BAND_UNCLEAR');
      // önceki satırdan pahalı sabit fiyat eskisi gibi
      expect(parseTariffImport(xlsx(domestic([label, '250']))).rates.find((r) => r.weightUpto === 99999)?.price, label).toBe(250);
      expect(parseTariffImport(xlsx(domestic([label, '60'])), { openBandMode: 'flat' }).rates.find((r) => r.weightUpto === 99999)?.price, label).toBe(60);
    }
    // inceleme örneği: 30 desi 195, "31+ | 180" eskiden tek sabit fiyattı (yalnız PRICE_DECREASES uyarısı)
    const p180 = parseTariffImport(xlsx(domestic(['31+', '180'])));
    expect(p180.openBands.map((b) => [b.reading, b.why])).toEqual([['unclear', 'cheaper']]);
    expect(tariffImportFixes(p180, ctx()).filter((f) => f.id === 'openBandMode').map((f) => f.value)).toEqual(['additional', 'perKg', 'flat']);
    expect(parseTariffImport(xlsx(domestic(['31+', '180'])), { openBandMode: 'flat' }).rates.find((r) => r.weightUpto === 99999)?.price).toBe(180);
    expect(parseTariffImport(xlsx(domestic(['31+', '180'])), { openBandMode: 'additional' }).overflow).toEqual([{ zone: 'Fiyat', perUnit: 180 }]);
    expect(parseWeightLabel('31+')?.newSpelling).toBeUndefined();
    expect(parseWeightLabel('> 30')?.newSpelling).toBe(true);
  });

  it('bölgenin "Aşım" satırı da varsa açık uç sorulur (iki aşım fiyatı)', () => {
    const p = parseTariffImport(xlsx([['Desi', 'A'], ['30', '195'], ['31+', '8'], ['Aşım (her ilave desi)', '9']]));
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 9 }]);
    expect(p.openBands.map((b) => [b.reading, b.why])).toEqual([['unclear', 'conflict']]);
    expect(codesOf(p, ctx({ currentZones: [{ country: '*', zone: 'A' }] }))).toContain('error:OPEN_BAND_UNCLEAR');
  });

  it('çelişen iki aşım kuralı ("31+ | 8" ve "Her ilave desi | 9", sıra fark etmez; "Aşım" + ilave) sorulur; aynı tutar sorun değil', () => {
    const a = parseTariffImport(xlsx(domestic(['31+', '8']).concat([['Her ilave desi', '9']])));
    expect(a.overflow).toEqual([{ zone: 'Fiyat', perUnit: 8 }]);
    expect(a.stepConflicts.map((x) => x.reason)).toEqual(['bölgenin başka aşım kuralı var (8,00)']);
    expect(codesOf(a)).toContain('error:STEP_RULE_UNCLEAR');
    const b = parseTariffImport(xlsx(domestic(['Her ilave desi', '9']).concat([['31+', '8']])));
    expect(b.openBands.map((x) => [x.reading, x.why])).toEqual([['unclear', 'conflict']]);
    expect(codesOf(b)).toContain('error:OPEN_BAND_UNCLEAR');
    const c = parseTariffImport(xlsx(domestic(['Aşım (her ilave desi)', '9']).concat([['Her ilave desi', '8']])));
    expect(codesOf(c)).toContain('error:STEP_RULE_UNCLEAR');
    const same = parseTariffImport(xlsx(domestic(['31+', '8']).concat([['Her ilave desi', '8']])));
    expect(same.overflow).toEqual([{ zone: 'Fiyat', perUnit: 8 }]);
    expect(codesOf(same).filter((x) => x.startsWith('error:'))).toEqual([]);
    // ters sıra da aynı şeyi söyler
    const reversed = parseTariffImport(xlsx(domestic(['Her ilave desi', '8']).concat([['31+', '8']])));
    expect(reversed.overflow).toEqual([{ zone: 'Fiyat', perUnit: 8 }]);
    expect(codesOf(reversed).filter((x) => x.startsWith('error:'))).toEqual([]);
  });

  it('çok bölgeli tabloda kısa biten bölgede "Her ilave desi" başlangıcı belirsiz: sorulur', () => {
    const p = parseTariffImport(
      xlsx([['Desi', 'A', 'B'], ['1', '60', '70'], ['20', '150', '170'], ['30', '195', ''], ['Her ilave desi', '8', '9']], { zones: [['Ülke kodu', 'Bölge'], ['*', 'A'], ['XX', 'B']] }),
    );
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 8 }]);
    expect(p.stepConflicts).toEqual([{ row: 5, zone: 'B', reason: 'bölgenin tablosu 20 satırında bitiyor, diğer bölgelerinki 30' }]);
    expect(codesOf(p)).toContain('error:STEP_RULE_UNCLEAR');
  });

  it('ilave kuralının başlangıcı tablonun sonuna uymuyorsa kullanılmaz, sorulur', () => {
    const p = parseTariffImport(xlsx([['Desi', 'A'], ['10', '100'], ['20', '150'], ['30 desi üzeri her desi', '8']]));
    expect(p.overflow).toEqual([]);
    expect(p.stepConflicts.map((i) => i.reason)).toEqual(['kural 30 üstünden başlıyor, tablo 20 satırında bitiyor']);
    expect(codesOf(p)).toContain('error:STEP_RULE_UNCLEAR');
    expect(checkTariffImport(p, ctx(), {}, 'en').find((i) => i.code === 'STEP_RULE_UNCLEAR')!.detail).toContain('the rule starts above 30, the table ends at 20');
  });

  it('açık uç ya da ilave satırına benzeyen ama okunamayan etiket tahmin edilmez, sorulur', () => {
    const p = parseTariffImport(xlsx(domestic(['30 desi sonrası beher', '8'])));
    expect(p.overflow).toEqual([]);
    expect(p.unreadableOpenBands).toEqual([{ row: 6, label: '30 desi sonrası beher' }]);
    const issue = checkTariffImport(p, ctx()).find((i) => i.code === 'OPEN_BAND_UNREADABLE')!;
    expect(issue.severity).toBe('warning');
    expect(issue.title).toBe('1 açık uçlu satır okunamadı; tablonun üstündeki ağırlıklar "Tarife yok" kalır');
    expect(issue.detail).toBe('satır 6: "30 desi sonrası beher"');
    expect(codesOf(p)).not.toContain('warning:SKIPPED_ROWS');
    expect(base(tariffOf(p), 35)).not.toBe(235);
    // açık uca benzemeyen okunamayan satır eskisi gibi atlanan satırdır
    const other = parseTariffImport(xlsx(domestic(['Ek hizmet', '8'])));
    expect(other.unreadableOpenBands).toEqual([]);
    expect(codesOf(other)).toContain('warning:SKIPPED_ROWS');
  });

  it('İngilizce ileti', () => {
    const p = parseTariffImport(xlsx(domestic(['31+', '8'])));
    const w = checkTariffImport(p, ctx(), {}, 'en').find((i) => i.code === 'OPEN_BAND_ADDITIONAL')!;
    expect(w.title).toBe('1 open-ended row was read as an "each additional unit" price');
    expect(w.detail).toBe('row 6, zone Fiyat: "31+" 8.00 → above 30.0 kg each additional unit 8.00; 35.0 kg: 195.00 + 5 × 8.00 = 235.00 (per kg it would be 280.00)');
  });
});

describe('1.9 mesafe bölgeli tarife: kesin fark en az farkı veren bölgeden, değilse "İncele"', () => {
  // İnceleme örneği: Şehir içi 5 desi 70 / 10 desi 100, Yakın 78 / 115, Uzak 89 / 130; * → Şehir içi
  const distance: TariffInput = {
    id: 'yurtici-mesafe',
    currency: 'TRY',
    divisor: 3000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: null, step: 1 }],
    discountPct: 0,
    fuelPct: 0,
    fuelVariable: false,
    zones: { '*': 'SEHIRICI' },
    rates: [
      { zone: 'SEHIRICI', weightUpto: 5, price: 70 },
      { zone: 'SEHIRICI', weightUpto: 10, price: 100 },
      { zone: 'YAKIN', weightUpto: 5, price: 78 },
      { zone: 'YAKIN', weightUpto: 10, price: 115 },
      { zone: 'UZAK', weightUpto: 5, price: 89 },
      { zone: 'UZAK', weightUpto: 10, price: 130 },
    ],
    surcharges: [],
  };
  const single: TariffInput = { ...distance, id: 'tek', zones: { '*': 'TR' }, rates: [{ zone: 'TR', weightUpto: 5, price: 70 }, { zone: 'TR', weightUpto: 10, price: 100 }] };
  const five = meas(30, 20, 20, 2); // 4 desi → 5
  const ten = meas(40, 30, 25, 2); // 10 desi
  const cmp = (tariff: TariffInput, m: ReturnType<typeof meas>, netAmount: number, billedKg: number) =>
    compareLine({ line: line({ trackingNo: 'Z1', billedKg, netAmount, destCountry: 'TR' }), measurement: m, tariff, tol: TOL, isDuplicate: false });

  it('mesafe bölgesi sayısı', () => {
    expect(distanceZoneCount(distance)).toBe(3);
    expect(distanceZoneCount(single)).toBe(0);
    expect(distanceZoneCount({ rates: [{ zone: 'Şehir içi', weightUpto: 1, price: 1 }, { zone: 'A', weightUpto: 1, price: 1 }] })).toBe(1);
    expect(distanceZoneCount({ rates: [{ zone: '0-200 km', weightUpto: 1, price: 1 }, { zone: '1000KM+', weightUpto: 1, price: 1 }] })).toBe(2);
  });

  it('ağırlık farkı: 5 desi ölçülmüş, Uzak 10 desi 130 kesilmiş → kesin 41 (Uzak 5 desi 89), 60 değil', () => {
    const r = cmp(distance, five, 130, 10);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 89, diffAmount: 41, confidence: 'HIGH' });
    expect(r.note).toContain(t('tr', 'compare.zoneDistanceMin', { zone: 'UZAK' }));
    expect(localizeComparison(r, 'en').note).toContain(t('en', 'compare.zoneDistanceMin', { zone: 'UZAK' }));
    // * Uzak'a bağlıyken Şehir içi 10 desi (100) kesilmiş: kesin kısım bölgelerin en küçüğü
    const s = cmp({ ...distance, zones: { '*': 'UZAK' } }, five, 100, 10);
    expect(s).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], confidence: 'HIGH' });
    expect(s.diffAmount).toBe(30);
  });

  it('fiyat farkı bir bölgenin fiyatına uyuyorsa (Uzak 130) "İncele"; en pahalı bölgenin de üstündeyse aradaki kesin', () => {
    const r = cmp(distance, ten, 130, 10);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 30, confidence: 'LOW', reviewCode: 'ZONE_DISTANCE' });
    expect(r.confidenceReason).toBe(t('tr', 'compare.confidence.zoneDistance'));
    expect(localizeComparison(r, 'en').confidenceReason).toBe(t('en', 'compare.confidence.zoneDistance'));
    // 145: Şehir içine göre %45 ("tarifeden çok farklı"), Uzak'a göre bile 15 fazla → 15 kesin
    expect(cmp(distance, ten, 145, 10)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: 130, diffAmount: 15, confidence: 'HIGH' });
    // 300 her bölgeye göre olağandışı: "İncele" (tarifeden çok farklı) kalır
    expect(cmp(distance, ten, 300, 10)).toMatchObject({ status: 'DIFF', confidence: 'LOW', reviewCode: 'EXTREME_RATE' });
  });

  it('ülkesi ayrı bölgeye bağlı gönderi (DE → EU1) mesafe bölgeleriyle denenmez; denemede yalnız mesafe bölgeleri', () => {
    const mixed: TariffInput = {
      ...distance,
      zones: { '*': 'SEHIRICI', DE: 'EU1' },
      rates: [...distance.rates, { zone: 'EU1', weightUpto: 5, price: 500 }, { zone: 'EU1', weightUpto: 10, price: 900 }],
    };
    const de = (netAmount: number, billedKg: number, m = five) =>
      compareLine({ line: line({ trackingNo: 'D1', billedKg, netAmount, destCountry: 'DE' }), measurement: m, tariff: mixed, tol: TOL, isDuplicate: false });
    // Almanya: EU1 fiyatıyla kesin (5 desi 500, 10 desi kesilmiş 900 → 400), yurt içi bölgelerle küçültülmez
    expect(de(900, 10)).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 500, diffAmount: 400, confidence: 'HIGH' });
    expect(de(900, 10).note ?? '').not.toContain(t('tr', 'compare.zoneDistanceMin', { zone: 'UZAK' }));
    // yurt içi (*) satırı EU1 ile denenmez: en küçük fark Uzak'tan 41 (EU1 olsaydı fark yok sayılıp "İncele" olurdu)
    expect(cmp(mixed, five, 130, 10)).toMatchObject({ diffTypes: ['WEIGHT'], expectedAmount: 89, diffAmount: 41, confidence: 'HIGH' });
  });

  it('tek bölgeli tarifede değişiklik yok; uyumlu satır işaretlenmez', () => {
    expect(cmp(single, five, 130, 10)).toMatchObject({ diffTypes: ['WEIGHT'], diffAmount: 60, confidence: 'HIGH' });
    expect(cmp(single, ten, 130, 10)).toMatchObject({ diffTypes: ['PRICE'], diffAmount: 30, confidence: 'HIGH' });
    expect(cmp(distance, ten, 100, 10)).toMatchObject({ status: 'MATCH', confidence: 'HIGH' });
  });
});
