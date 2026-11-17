import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  buildWhatsAppText,
  checkTariffImport,
  compareLine,
  countryName,
  countryNameTr,
  describeWeightSteps,
  diffTypeLabel,
  emptyMapping,
  fmtDate,
  fmtDims,
  fmtFxRate,
  fmtKg,
  fmtMoney,
  fmtNumber,
  fmtNumberInput,
  fmtPct,
  fmtSignedPct,
  fmtWeightNumber,
  invoiceFileMessage,
  isFxMissingNote,
  isPakNote,
  localizeBreakdown,
  localizeComparison,
  localizePdfSectionTitle,
  localizeText,
  mappingFieldLabel,
  messages,
  normalizeLocale,
  parseRows,
  parseTariffImport,
  parseTrNumber,
  rowFlagLabel,
  statusLabel,
  surchargeLabel,
  t,
  tableFromMatrix,
  tariffHealth,
  verifyMapping,
  type Locale,
  type MessageKey,
} from '../src/index';
import { baremText } from '../src/barem';
import { FEDEX, TOL, line, meas } from './fixtures';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)].map((m) => m[1]!);

describe('t ve mesaj tabloları', () => {
  it('iki dilde aynı anahtarlar, boş metin yok', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.tr).sort());
    for (const k of Object.keys(messages.tr) as MessageKey[]) {
      expect(messages.tr[k], k).not.toBe('');
      expect(messages.en[k], k).not.toBe('');
    }
  });
  it('EN şablonu TR şablonunun değerlerinden başka değer istemez', () => {
    for (const k of Object.keys(messages.tr) as MessageKey[]) {
      const known = new Set(placeholders(messages.tr[k]));
      for (const p of placeholders(messages.en[k])) expect(known.has(p), `${k}: {${p}}`).toBe(true);
    }
  });
  it('EN metinlerde Türkçe harf kalmaz', () => {
    // "Türkiye" Merkez Bankası'nın resmi İngilizce adıdır (Central Bank of Türkiye); tek istisna.
    for (const k of Object.keys(messages.en) as MessageKey[]) expect(messages.en[k].replace(/Türkiye/g, 'Turkey'), k).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });
  it('değer koyma, tekil/çoğul, eksik değer', () => {
    expect(t('tr', 'summary.diff', { count: 3 })).toBe('3 satırda fark var');
    expect(t('en', 'summary.diff', { count: 1 })).toBe('Discrepancy on 1 line');
    expect(t('en', 'summary.diff', { count: 3 })).toBe('Discrepancy on 3 lines');
    expect(t('en', 'summary.diff', { count: '1,200' })).toBe('Discrepancy on 1,200 lines');
    expect(t('en', 'summary.diff')).toContain('{count}');
    // değerin içindeki süslü parantez ve $ işareti şablon sayılmaz
    expect(t('tr', 'dispute.total', { total: '{x} $& 5' })).toBe('Toplam talep edilen düzeltme: {x} $& 5 (KDV hariç)');
  });
  it('normalizeLocale', () => {
    expect(DEFAULT_LOCALE).toBe('tr');
    expect(['en', 'EN', 'en-US', 'en_GB', 'en-US,en;q=0.9'].map(normalizeLocale)).toEqual(['en', 'en', 'en', 'en', 'en']);
    expect(['tr', 'tr-TR', 'tr-TR,en;q=0.5', 'de-DE,tr;q=0.5'].map(normalizeLocale)).toEqual(Array(4).fill('tr'));
    // Kullanıcı kararı 2026-11-12: desteklenen dil yoksa ya da değer bozuksa İngilizce (eskiden Türkçe).
    expect(['de', 'enx', '', null, undefined, 3].map(normalizeLocale)).toEqual(Array(6).fill('en'));
  });
});

describe('biçimleme: en-US kuralları', () => {
  it('sayı, para, ağırlık, ölçü, yüzde, tarih', () => {
    expect(fmtNumber(1234.5, 2, 'en')).toBe('1,234.50');
    expect(fmtNumber(1234.5, 0, 'en')).toBe('1,235');
    expect(fmtNumber(-1234567.891, 2, 'en')).toBe('-1,234,567.89');
    expect(fmtMoney(1184, 'TRY', 'en')).toBe('₺1,184.00');
    expect(fmtMoney(-12.5, 'EUR', 'en')).toBe('-€12.50');
    expect(fmtMoney(12.5, 'USD', 'en')).toBe('$12.50');
    expect(fmtMoney(12.5, 'chf', 'en')).toBe('CHF 12.50');
    expect(fmtWeightNumber(1250, 'en')).toBe('1,250.0');
    expect(fmtKg(4.025, 'en')).toBe('4.025 kg');
    expect(fmtDims({ l: 40, w: 30.5, h: 25 }, 'en')).toBe('40×30.5×25');
    expect(fmtPct(27.5, 'en')).toBe('27.5%');
    expect(fmtSignedPct(-14.7, 'en')).toBe('−14.7%');
    expect(fmtSignedPct(8, 'en')).toBe('+8%');
    expect(fmtFxRate(41.2345, 'en')).toBe('41.2345');
    // Y102: İngilizce tarih gün-ay adı-yıl, panelle aynı ("10/05" 5 Ekim mi 10 Mayıs mı karışmasın).
    expect(fmtDate('2026-10-27', 'en')).toBe('27 Oct 2026');
    expect(fmtDate('2026-10-05T14:00:00', 'en')).toBe('5 Oct 2026');
    expect(fmtDate('geçersiz', 'en')).toBe('geçersiz');
  });
  it('yuvarlama dilden bağımsız: aynı rakamlar, yalnız ayırıcılar farklı', () => {
    for (const n of [1.005, 2.675, 1.115, 0.285, 1234.565, -8.345, 999.995, 1e-7]) {
      const swap = (s: string) => s.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.'));
      expect(swap(fmtNumber(n, 2, 'en')), String(n)).toBe(fmtNumber(n, 2));
      expect(swap(fmtWeightNumber(n, 'en')), String(n)).toBe(fmtWeightNumber(n));
    }
  });
  it('varsayılan parametre TR', () => {
    expect(fmtMoney(1184)).toBe('1.184,00 ₺');
    expect(fmtMoney(1184, 'TRY', 'tr')).toBe('1.184,00 ₺');
    expect(fmtKg(4.5, undefined)).toBe('4,5 kg');
  });
});

describe('parseTrNumber: kullanıcı girdisi', () => {
  const locales: (Locale | undefined)[] = [undefined, 'tr', 'en'];
  it.each(locales)('iki ayırıcılı girdi her dilde doğru (%s)', (loc) => {
    expect(parseTrNumber('1,234.5', loc)).toBe(1234.5);
    expect(parseTrNumber('1.234,5', loc)).toBe(1234.5);
    expect(parseTrNumber('1,234,567.89', loc)).toBe(1234567.89);
    expect(parseTrNumber('1.234.567,89', loc)).toBe(1234567.89);
  });
  // Belirsiz girdinin EN kuralı ve gidiş-dönüş: parseLocale.test.ts
  it.each(locales)('dile göre değişmeyen girdiler (%s)', (loc) => {
    expect(parseTrNumber('12,5', loc)).toBe(12.5);
    expect(parseTrNumber('12.5', loc)).toBe(12.5);
    expect(parseTrNumber('0.500', loc)).toBe(0.5);
    expect(parseTrNumber('1,5', loc)).toBe(1.5);
    expect(parseTrNumber('1,2,3', loc)).toBeNull();
  });
  it('düzenlenebilir sayı aynı sayıya döner (iki dilde)', () => {
    const values = [0, 1, 4.5, 4.02, 1.234, 12.345, 999.125, 1000, 1234.5, 1234.567, -1.234, 0.5, 0.125];
    for (const loc of ['tr', 'en'] as const) {
      for (const v of values) expect(parseTrNumber(fmtNumberInput(v, 3, loc), loc), `${loc} ${v}`).toBe(v);
    }
    expect(fmtNumberInput(4.5)).toBe('4,5');
    expect(fmtNumberInput(4.5, 3, 'en')).toBe('4.5');
    expect(fmtNumberInput(1.234, 3, 'en')).toBe('1.234');
  });
});

describe('dile bağlı küçük yardımcılar', () => {
  it('etiketler', () => {
    expect(statusLabel('DIFF')).toBe('Fark var');
    expect(statusLabel('DIFF', 'en')).toBe('Discrepancy');
    expect(diffTypeLabel('PRICE', 'en')).toBe('Price discrepancy');
    expect(rowFlagLabel('DATE_PARSE', 'en')).toBe('Ship date could not be read');
    expect(mappingFieldLabel('billedKg', 'en')).toBe('Billable weight (kg or dimensional weight)');
    expect(invoiceFileMessage('EMPTY_FILE')).toContain('Dosya boş');
    expect(invoiceFileMessage('EMPTY_FILE', 'en')).toContain('The file is empty');
  });
  it('ülke adları', () => {
    expect(countryName('ES')).toBe(countryNameTr('ES'));
    expect(countryName('ES', 'en')).toBe('Spain');
    expect(countryName('de', 'en')).toBe('Germany');
    expect(countryName('ABC', 'en')).toBe('ABC');
    expect(countryName(null, 'en')).toBe('—');
  });
  it('ek ücret etiketi eş anlamlıdan bulunur, bilinmeyen kod korunur', () => {
    expect(surchargeLabel('COD', 'en')).toBe('Cash on delivery');
    expect(surchargeLabel('Kapıda Ödeme Bedeli')).toBe('Kapıda ödeme');
    expect(surchargeLabel('EPH_UCRETI', 'en')).toBe('EPH_UCRETI');
    expect(surchargeLabel('EPH_UCRETI', 'en', 'EPH Ücreti')).toBe('EPH Ücreti');
  });
  it('barem ve basamaklar', () => {
    expect(baremText({ kind: 'OVER', boundaryKg: 6, overKg: 0.2, nextKg: 6.5 }, 'en')).toBe('Billable weight exceeds the 6.0 kg weight bracket by 0.2 kg.');
    expect(describeWeightSteps([{ upto: 70.5, step: 0.5 }, { upto: null, step: 1 }], 'en')).toBe('up to 70.5 kg: 0.5 kg, above that 1 kg');
    expect(describeWeightSteps([{ upto: null, step: 1 }], 'en')).toBe('every 1 kg');
  });
  it('WhatsApp tekil/çoğul', () => {
    const s = { carrierName: 'FedEx', invoiceNo: 'X', currency: 'TRY', lines: 1, diff: 1, unmatched: 0, overchargeTotal: 0 };
    expect(buildWhatsAppText(s, 'en')).toBe('DeciShip · FedEx invoice X: 1 shipment, 1 discrepancy. No overcharge.');
  });
  it('PDF bölüm başlığı', () => {
    expect(localizePdfSectionTitle('IPE ihracat · Dünya (A–O) · kutu 0,5–70,5 kg · liste', 'en')).toBe('IPE export · World (A–O) · box 0.5–70.5 kg · list');
    expect(localizePdfSectionTitle('Fiyat tablosu yurt içi · net', 'en')).toBe('Price table domestic · net');
    expect(localizePdfSectionTitle('IPE ihracat · liste')).toBe('IPE ihracat · liste');
  });
});

describe('TR taban görüntüsünün kaçırdığı iki dal', () => {
  const l = (d: number, fx: boolean) => ({ destCountry: 'ES', service: 'IE', zone: 'A', rateDeviationPct: d, fx });
  const five = (d: number, fx: boolean) => Array.from({ length: 5 }, () => l(d, fx));
  it('eski kodla aynı metin', () => {
    expect(tariffHealth(five(-1, true), { carrierName: 'FedEx' }).overallNote).toBe(
      'Satırların çoğunda fiyat tarifeden yaklaşık −%1 düşük. Bu büyük olasılıkla kur farkı: FedEx faturada kendi kurunu kullanıyor olabilir (FedEx sözleşmelerinde kur kaynağı OANDA olarak geçer), DeciShip TCMB kurunu kullanır. Kur toleransı (%1,5) bu farkı karşılar.',
    );
    expect(tariffHealth(five(2, false)).overallNote).toBe('Satırların çoğunda fiyat tarifeden yaklaşık +%2 yüksek; tarifedeki genel indirim ya da yakıt oranı güncel olmayabilir.');
  });
});

describe('localizeText: kayıtlı Türkçe metinler', () => {
  it('tr metne dokunmaz, boş değerler geçer', () => {
    expect(localizeText('Lehimize fark', 'tr')).toBe('Lehimize fark');
    expect(localizeText('Lehimize fark')).toBe('Lehimize fark');
    expect(localizeText(null, 'en')).toBeNull();
    expect(localizeText(undefined, 'en')).toBeUndefined();
    expect(localizeText('', 'en')).toBe('');
  });
  it.each([
    ['Lehimize fark', 'Discrepancy in our favor'],
    ['Bu takip no için ölçüm yok', 'No measurement for this tracking number'],
    ['Pak/zarf gönderisi — kapsam dışı', 'Pak/envelope shipment — out of scope'],
    ['Pak/zarf gönderisi — kapsam dışı; koli tarifesiyle karşılaştırılmadı', 'Pak/envelope shipment — out of scope; not compared with the box tariff'],
    ['Para birimi uyuşmuyor (fatura EUR, tarife TRY)', 'Currency mismatch (invoice EUR, tariff TRY)'],
    ['Kur bulunamadı (USD→TRY, 22.10.2026)', 'Exchange rate not found (USD→TRY, 22 Oct 2026)'],
    ['Kur alınamadı (USD→TRY, 22.10.2026) — TCMB yanıt vermedi', 'Exchange rate could not be fetched (USD→TRY, 22 Oct 2026) — CBRT did not respond'],
    ['Kur farkı tolerans içinde (%1,5)', 'Exchange rate difference within tolerance (1.5%)'],
    ['Faturadaki fiyatla hesaplandı (tarifeden −%14,7)', 'Calculated from the invoiced price (−14.7% vs tariff)'],
    ["Tarifede olmayan ek ücretler faturadaki tutarıyla Beklenen'e eklendi: EPH Ücreti 1.234,50 ₺, Foo 12,00 CHF", 'Surcharges not in the tariff were added to Expected at their invoiced amount: EPH Ücreti ₺1,234.50, Foo CHF 12.00'],
    ['Tarifeden fazla ek ücret: ADDITIONAL_HANDLING +515,00 ₺', 'Surcharge above the tariff: ADDITIONAL_HANDLING +₺515.00'],
    ['Tarifede faturadaki ağırlık (1.250,0 kg) için fiyat yok; beklenen yalnız tarifeden', 'The tariff has no price for the invoiced weight (1,250.0 kg); expected amount is from the tariff only'],
    ['Tarife fiyatı (Bölge A, 6,0 kg)', 'Tariff price (Zone A, 6.0 kg)'],
    ['Taşıma — faturadaki fiyatla: 650,00 ₺ × 1.527,75/2.119,35 (6,0 kg / 9,5 kg)', 'Freight — at the invoiced price: ₺650.00 × 1,527.75/2,119.35 (6.0 kg / 9.5 kg)'],
    ['Beklenen 1.184,00 USD × 41,2345 (TCMB 23.10.2026, 25.10.2026 için)', 'Expected 1,184.00 USD × 41.2345 (TCMB 23 Oct 2026, for 25 Oct 2026)'],
    ['Ağırlık okunamadı', 'Weight could not be read'],
    ['DE zaten A bölgesinde; bu satır alınmadı', 'DE is already in zone A; this row was not imported'],
    ['Etiketsiz ücret', 'Unlabeled charge'],
    ['Diğer / Genel', 'Other / General'],
    ['Fiyatlara KDV dahil değil', 'Prices exclude tax'],
    ['Satır 3: tarih okunamadı "dün"', 'Row 3: date could not be read "dün"'],
    ['Tarife (2026 FedEx) 22.10.2026 tarihinde geçerli değil (geçerlilik: … – 2026-01-01); yine de bu tarifeyle hesaplandı', 'Tariff (2026 FedEx) is not valid on 22 Oct 2026 (validity: … – 2026-01-01); calculated with this tariff anyway'],
  ])('%s', (tr, en) => {
    expect(localizeText(tr, 'en')).toBe(en);
  });
  it('birleşik not parça parça çevrilir, tanınmayan parça olduğu gibi kalır', () => {
    expect(localizeText('Lehimize fark · Depo elemanı 12,5 yazdı · Bu takip no için ölçüm yok', 'en')).toBe('Discrepancy in our favor · Depo elemanı 12,5 yazdı · No measurement for this tracking number');
    expect(localizeText('Elle yazılmış not 1.234,50 ₺', 'en')).toBe('Elle yazılmış not 1.234,50 ₺');
  });
  it('döküm: yalnız etiket değişir; ülke adı çevrilir; dizi olmayan değer geçer', () => {
    const b = [
      { label: 'Tarife fiyatı (Bölge A, 6,0 kg)', amount: 1527.75, fx: { rate: 41.2 } },
      { label: 'İspanya istisnası −%15,45', amount: -10 },
      { label: 'Ek elleçleme', amount: 285 },
    ];
    expect(localizeBreakdown(b, 'en')).toEqual([
      { label: 'Tariff price (Zone A, 6.0 kg)', amount: 1527.75, fx: { rate: 41.2 } },
      { label: 'Spain adjustment −15.45%', amount: -10 },
      { label: 'Ek elleçleme', amount: 285 },
    ]);
    expect(localizeBreakdown(b)).toBe(b);
    expect(localizeBreakdown(null, 'en')).toBeNull();
    expect(localizeBreakdown({ a: 1 }, 'en')).toEqual({ a: 1 });
  });
  it('kayıtlı sonuç okunurken çevrilir, girdi değişmez', () => {
    const r = { note: 'Lehimize fark', confidenceReason: null, breakdown: [] };
    expect(localizeComparison(r, 'en').note).toBe('Discrepancy in our favor');
    expect(r.note).toBe('Lehimize fark');
  });
});

describe('metne bakan mantık iki dilde çalışır', () => {
  const noMeas = { measurement: null, tariff: FEDEX, tol: TOL, isDuplicate: false };
  it('isPakNote', () => {
    const pak = line({ trackingNo: 'a', netAmount: 100, service: 'FedEx Envelope' });
    for (const locale of ['tr', 'en'] as const) {
      expect(isPakNote(compareLine({ ...noMeas, line: pak, locale }).note)).toBe(true);
      expect(isPakNote(compareLine({ ...noMeas, measurement: meas(40, 30, 25, 4), line: pak, locale }).note)).toBe(true);
      expect(isPakNote(compareLine({ ...noMeas, line: line({ trackingNo: 'a', netAmount: 100 }), locale }).note)).toBe(false);
    }
  });
  it('isFxMissingNote', () => {
    for (const note of ['Kur bulunamadı (USD→TRY, 22.10.2026)', 'Kur alınamadı (USD→TRY, 22.10.2026) — TCMB yanıt vermedi']) {
      expect(isFxMissingNote(note)).toBe(true);
      expect(isFxMissingNote(localizeText(note, 'en'))).toBe(true);
    }
    expect(isFxMissingNote('Lehimize fark')).toBe(false);
    expect(isFxMissingNote(null)).toBe(false);
  });
  it('İngilizce parseRows iletileri aynı satır bayraklarını üretir', () => {
    const head = ['Takip No', 'Tarih', 'Net Tutar'];
    const t2 = tableFromMatrix([head, ['ABCDEF', '20.10.2026', '10,00'], ['794812345301', 'dün', '10,00'], ['794812345302', '20.10.2026', 'yok'], ['794812345303', '20.10.2026', '10,00']]);
    const map = { ...emptyMapping(), trackingNo: 'Takip No', shipDate: 'Tarih', netAmount: 'Net Tutar' };
    const flags = (locale: Locale) => {
      const parsed = parseRows(t2, map, locale);
      return verifyMapping(t2, map, { lines: parsed.lines, errors: parsed.errors }).rowFlags;
    };
    expect(parseRows(t2, map, 'en').errors.map((e) => e.message)).toEqual(['Row 1: invalid tracking no "ABCDEF"', 'Row 2: date could not be read "dün"', 'Row 3: net amount could not be read "yok"']);
    expect(flags('en')).toEqual(flags('tr'));
    expect(flags('tr').length).toBeGreaterThan(0);
  });
});

describe('EN önerilerindeki satır adları dosyada tanınır', () => {
  const run = (label: string) => {
    const prices = [['Weight', 'A'], ['1', '10'], ['2', '20'], [label, '5']];
    const parsed = parseTariffImport({ fileName: 'x.xlsx', kind: 'xlsx', prices, zones: null, surcharges: null });
    const ctx = { tariffCurrency: 'TRY', currentZones: [{ country: 'DE', zone: 'A' }], currentRates: [] };
    return { parsed, codes: checkTariffImport(parsed, ctx, {}, 'en').map((i) => i.code) };
  };
  it.each([
    ['Overflow (each extra unit)', null],
    ['Overflow (per kg)', 1],
    ['Overflow (per desi)', 1],
    ['Overflow (each additional 0.5 kg)', 0.5],
  ])('%s', (label, step) => {
    const { parsed, codes } = run(label);
    expect(parsed.overflow).toEqual([{ zone: 'A', perUnit: 5 }]);
    expect(parsed.overflowStep ?? null).toBe(step);
    expect(codes).not.toContain('OVERFLOW_UNIT_MISSING');
  });
  it('birimsiz satır uyarısı korunur', () => {
    expect(run('Overflow').codes).toContain('OVERFLOW_UNIT_MISSING');
    expect(run('Aşım').codes).toContain('OVERFLOW_UNIT_MISSING');
  });
});

describe('küresel durum yok', () => {
  it('eşzamanlı çağrılar birbirinin dilini etkilemez', async () => {
    const one = async (locale: Locale, i: number) => {
      await new Promise((r) => setTimeout(r, i % 3));
      return { locale, money: fmtMoney(1234.5, 'TRY', locale), defaultMoney: fmtMoney(1234.5), status: statusLabel('MATCH', locale) };
    };
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => one(i % 2 ? 'en' : 'tr', i)));
    for (const r of results) {
      expect(r.money).toBe(r.locale === 'en' ? '₺1,234.50' : '1.234,50 ₺');
      expect(r.defaultMoney).toBe('1.234,50 ₺');
      expect(r.status).toBe(r.locale === 'en' ? 'Matched' : 'Uyumlu');
    }
  });
});
