import { describe, expect, it } from 'vitest';
import { compareLine, fxFromBreakdown, t, type FxInput, type TariffInput } from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

/** FEDEX tarifesinin USD kopyası: A/6 kg liste 1.527,75 → beklenen 1.184,00 (aynı rakamlar, USD). */
const FEDEX_USD: TariffInput = { ...FEDEX, id: 'fedex-usd', currency: 'USD' };
const RATE = 41.2345;
const fxOk = (date = '2025-06-03', rateDate = date): FxInput => ({
  date,
  rate: { base: 'USD', quote: 'TRY', rate: RATE, date: rateDate, source: 'TCMB' },
});
const EXPECTED_TRY = Math.round(1184 * RATE * 100) / 100; // 48.821,65

const run = (netAmount: number, fx: FxInput | undefined, extra: Partial<Parameters<typeof line>[0]> = {}, tol = TOL) =>
  compareLine({
    line: line({ trackingNo: '1', netAmount, billedKg: 6, currency: 'TRY', ...extra }),
    measurement: meas(40, 30, 25, 4),
    tariff: FEDEX_USD,
    tol,
    isDuplicate: false,
    fx,
  });

describe('kur çevrimi (fatura TRY, tarife USD)', () => {
  it('kur verilmezse eski davranış: Para birimi uyuşmuyor', () => {
    const r = run(EXPECTED_TRY, undefined);
    expect(r.status).toBe('NO_TARIFF');
    expect(r.note).toBe('Para birimi uyuşmuyor (fatura TRY, tarife USD)');
  });

  it('kur bulunamadı → NO_TARIFF + açık not', () => {
    const r = run(EXPECTED_TRY, { date: '2025-06-03', rate: null });
    expect(r).toMatchObject({ status: 'NO_TARIFF', expectedAmount: null, diffAmount: null, ourChargeableKg: 6 });
    expect(r.note).toBe('Kur bulunamadı (USD→TRY, 03.06.2025)');
  });

  it('kur bulunamadı yapısal işaret taşır (Y144): API notu metne bakmadan kurar; başka NO_TARIFF nedeninde yok', () => {
    const r = run(EXPECTED_TRY, { date: '2025-06-03', rate: null });
    expect(r.fxMissing).toEqual({ tariff: 'USD', line: 'TRY', date: '03.06.2025' });
    expect(t('tr', 'compare.fxMissing', r.fxMissing!)).toBe(r.note);
    expect(t('tr', 'stored.fxFailed', r.fxMissing!)).toBe('Kur alınamadı (USD→TRY, 03.06.2025) — TCMB yanıt vermedi');
    expect(run(EXPECTED_TRY, undefined).fxMissing).toBeUndefined();
    expect(run(EXPECTED_TRY, fxOk()).fxMissing).toBeUndefined();
    // ölçümsüz satırda kur çözümü yalnız fiyat raporu içindir: sonuç NO_TARIFF değil, işaret yok
    const unmatched = compareLine({ line: line({ trackingNo: '1', netAmount: 1, billedKg: 6, currency: 'TRY' }), measurement: null, tariff: FEDEX_USD, tol: TOL, isDuplicate: false, fx: { date: '2025-06-03', rate: null } });
    expect(unmatched.status).toBe('UNMATCHED');
    expect(unmatched.fxMissing).toBeUndefined();
  });

  it('ters yönlü kur verilirse kullanılmaz', () => {
    const r = run(EXPECTED_TRY, { date: '2025-06-03', rate: { base: 'TRY', quote: 'USD', rate: 0.024, date: '2025-06-03', source: 'TCMB' } });
    expect(r.status).toBe('NO_TARIFF');
    expect(r.note).toContain('Kur bulunamadı');
  });

  it('tam tutar → MATCH, beklenen TRY, döküm USD + çevrim satırı', () => {
    const r = run(EXPECTED_TRY, fxOk());
    expect(r).toMatchObject({ status: 'MATCH', expectedAmount: EXPECTED_TRY, diffAmount: 0 });
    expect(r.note).toBeUndefined();
    expect(r.breakdown.slice(0, 3).map((b) => [b.amount, b.currency])).toEqual([
      [1527.75, 'USD'],
      [-580.55, 'USD'],
      [236.8, 'USD'],
    ]);
    const last = r.breakdown.at(-1)!;
    expect(last.label).toBe('Beklenen 1.184,00 USD × 41,2345 (TCMB 03.06.2025)');
    expect(last).toMatchObject({ amount: EXPECTED_TRY, currency: 'TRY' });
    expect(r.fx).toMatchObject({ base: 'USD', quote: 'TRY', rate: RATE, expected: 1184, converted: EXPECTED_TRY, requestedDate: '2025-06-03' });
    expect(fxFromBreakdown(JSON.parse(JSON.stringify(r.breakdown)))).toEqual(r.fx);
  });

  it('hafta sonu düşüşü dökümde görünür', () => {
    const r = run(EXPECTED_TRY, fxOk('2025-06-07', '2025-06-06'));
    expect(r.breakdown.at(-1)!.label).toContain('(TCMB 06.06.2025, 07.06.2025 için)');
  });

  it('%1,5 içindeki fark → MATCH + "Kur farkı tolerans içinde"', () => {
    const r = run(EXPECTED_TRY + 500, fxOk()); // %1,02
    expect(r.status).toBe('MATCH');
    expect(r.diffAmount).toBe(500);
    expect(r.note).toBe('Kur farkı tolerans içinde (%1,5)');
  });

  it('lehimize %1,5 içindeki fark da kur farkı sayılır', () => {
    const r = run(EXPECTED_TRY - 500, fxOk());
    expect(r.status).toBe('MATCH');
    expect(r.note).toBe('Kur farkı tolerans içinde (%1,5)');
  });

  it('sabit tolerans içindeki küçük farkta not yok', () => {
    const r = run(EXPECTED_TRY + 3, fxOk());
    expect(r).toMatchObject({ status: 'MATCH', diffAmount: 3 });
    expect(r.note).toBeUndefined();
  });

  it('%1,5 üstü → DIFF / PRICE', () => {
    const r = run(EXPECTED_TRY + 800, fxOk()); // %1,64
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 800 });
  });

  it('fxTolerancePct ayarı uygulanır', () => {
    const r = run(EXPECTED_TRY + 800, fxOk(), {}, { ...TOL, fxTolerancePct: 2 });
    expect(r.status).toBe('MATCH');
    expect(r.note).toBe('Kur farkı tolerans içinde (%2)');
    const z = run(EXPECTED_TRY + 100, fxOk(), {}, { ...TOL, fxTolerancePct: 0 });
    expect(z.diffTypes).toEqual(['PRICE']);
  });

  it('ağırlık farkı kurdan bağımsız tespit edilir', () => {
    const r = run(EXPECTED_TRY, fxOk(), { billedKg: 9.5 });
    expect(r.diffTypes).toEqual(['WEIGHT']);
  });

  it('ek ücret beklenen tutarı da çevrilir', () => {
    const exp = Math.round(285 * RATE * 100) / 100; // 11.751,83
    const ok = run(EXPECTED_TRY + exp, fxOk(), { surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'AHS', amount: exp }] });
    expect(ok.status).toBe('MATCH');
    const over = run(EXPECTED_TRY + exp + 1000, fxOk(), { surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'AHS', amount: exp + 1000 }] });
    expect(over.diffTypes).toEqual(['SURCHARGE']);
    expect(over.note).toContain('ADDITIONAL_HANDLING +1.000,00 ₺');
    const unknown = run(EXPECTED_TRY + 412, fxOk(), { surcharges: [{ code: 'ADDRESS_CORRECTION', name: 'Address Correction', amount: 412 }] });
    expect(unknown.note).toContain('412,00 ₺');
  });

  it('Y18: saklı (bayat) kur → satır hesaplanır, notta "Kur … tarihli", yapısal işaret fxStale ve fx.stale', () => {
    const stale: FxInput = { date: '2025-06-03', rate: { base: 'USD', quote: 'TRY', rate: RATE, date: '2025-05-30', source: 'TCMB', stale: true } };
    const r = run(EXPECTED_TRY, stale);
    expect(r).toMatchObject({ status: 'MATCH', expectedAmount: EXPECTED_TRY, diffAmount: 0, fxStale: '2025-05-30' });
    expect(r.note).toBe('Kur 30.05.2025 tarihli (TCMB yanıt vermedi, saklı son kur kullanıldı)');
    expect(r.fx).toMatchObject({ stale: true, date: '2025-05-30', requestedDate: '2025-06-03' });
    expect(fxFromBreakdown(JSON.parse(JSON.stringify(r.breakdown)))).toMatchObject({ stale: true });
    // fark çıkan satırda not öbür notların sonunda
    const diff = run(EXPECTED_TRY + 800, stale);
    expect(diff).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], fxStale: '2025-05-30' });
    // inceleme: bayat kurlu fark kesin sayılmaz ("İncele", tahmini kova); taze kurla aynı satır kesin
    expect(diff).toMatchObject({ confidence: 'LOW', reviewCode: 'FX_STALE', confidenceReason: 'Kur 30.05.2025 tarihli (TCMB yanıt vermedi); güncel kurla Yeniden karşılaştırın' });
    expect(run(EXPECTED_TRY + 800, fxOk())).toMatchObject({ status: 'DIFF', confidence: 'HIGH' });
    expect(r.confidence).toBe('LOW');
    expect(diff.note!.split(' · ').at(-1)).toBe('Kur 30.05.2025 tarihli (TCMB yanıt vermedi, saklı son kur kullanıldı)');
    // İngilizce gösterimde not çevrilir
    const en = compareLine({ line: line({ trackingNo: '1', netAmount: EXPECTED_TRY, billedKg: 6, currency: 'TRY' }), measurement: meas(40, 30, 25, 4), tariff: FEDEX_USD, tol: TOL, isDuplicate: false, fx: stale, locale: 'en' });
    expect(en.note).toBe('Exchange rate dated 30 May 2025 (CBRT did not respond, the last stored rate was used)');
    // taze kurda işaret yok
    expect(run(EXPECTED_TRY, fxOk()).fxStale).toBeUndefined();
  });

  it('para birimleri aynıysa kur yok sayılır, sonuç değişmez', () => {
    const base = { line: line({ trackingNo: '1', netAmount: 1184, billedKg: 6 }), measurement: meas(40, 30, 25, 4), tariff: FEDEX, tol: TOL, isDuplicate: false };
    const a = compareLine(base);
    const b = compareLine({ ...base, fx: fxOk() });
    expect(b).toEqual(a);
    expect(a.fx).toBeUndefined();
  });
});

describe('Y18: tutar toleransının kuru (firma TRY, tarife ve fatura USD)', () => {
  const base = {
    line: line({ trackingNo: '1', netAmount: 1184, billedKg: 6, currency: 'USD' }),
    measurement: meas(40, 30, 25, 4),
    tariff: FEDEX_USD,
    tol: { ...TOL, amountTol: 0.13 },
    isDuplicate: false,
  };
  const tolRate = (extra: Partial<{ stale: true; date: string }> = {}) => ({ base: 'TRY', quote: 'USD', rate: 0.025, date: '2025-06-03', source: 'TCMB', ...extra });

  it('tolerans kuru yoksa sabit yedek oran kullanılmaz: NO_TARIFF + "Kur bulunamadı (TRY→USD, …)", kesin sonuç yok', () => {
    const r = compareLine({ ...base, line: line({ trackingNo: '1', netAmount: 1300, billedKg: 6, currency: 'USD' }), tolFx: { base: 'TRY', quote: 'USD', date: '2025-06-03', rate: null } });
    expect(r).toMatchObject({ status: 'NO_TARIFF', diffTypes: [], expectedAmount: null, diffAmount: null, ourChargeableKg: 6 });
    expect(r.note).toBe('Kur bulunamadı (TRY→USD, 03.06.2025)');
    expect(r.fxMissing).toEqual({ tariff: 'TRY', line: 'USD', date: '03.06.2025' });
    expect(t('tr', 'stored.fxFailed', r.fxMissing!)).toBe('Kur alınamadı (TRY→USD, 03.06.2025) — TCMB yanıt vermedi');
  });

  it('tolerans kuru yokluğu mükerrer ve ölçümsüz satırı değiştirmez (tolerans orada kullanılmaz)', () => {
    const tolFx = { base: 'TRY', quote: 'USD', date: '2025-06-03', rate: null };
    expect(compareLine({ ...base, isDuplicate: true, tolFx }).status).toBe('DIFF');
    expect(compareLine({ ...base, measurement: null, tolFx }).status).toBe('UNMATCHED');
  });

  it('taze tolerans kuru: sonuç kursuz hesapla aynı; bayat kur: aynı sonuç + not ve fxStale', () => {
    const plain = compareLine(base);
    expect(compareLine({ ...base, tolFx: { base: 'TRY', quote: 'USD', date: '2025-06-03', rate: tolRate() } })).toEqual(plain);
    const stale = compareLine({ ...base, tolFx: { base: 'TRY', quote: 'USD', date: '2025-06-03', rate: tolRate({ stale: true, date: '2025-05-29' }) } });
    expect(stale).toMatchObject({ status: plain.status, expectedAmount: plain.expectedAmount, diffAmount: plain.diffAmount, fxStale: '2025-05-29' });
    expect(stale.note).toBe('Kur 29.05.2025 tarihli (TCMB yanıt vermedi, saklı son kur kullanıldı)');
    expect(stale).toMatchObject({ confidence: 'LOW', reviewCode: 'FX_STALE' });
  });

  it('iki kur da bayat ve günleri farklı: notta iki gün; aynı günse bir kez', () => {
    const usdTry = (date: string) => ({ base: 'USD', quote: 'TRY', rate: RATE, date, source: 'TCMB', stale: true as const });
    const tryTry = { ...base, line: line({ trackingNo: '1', netAmount: EXPECTED_TRY, billedKg: 6, currency: 'TRY' }) };
    const two = compareLine({ ...tryTry, fx: { date: '2025-06-03', rate: usdTry('2025-05-30') }, tolFx: { base: 'EUR', quote: 'TRY', date: '2025-06-03', rate: { base: 'EUR', quote: 'TRY', rate: 45, date: '2025-05-29', source: 'TCMB', stale: true } } });
    expect(two).toMatchObject({ fxStale: '2025-05-30', confidence: 'LOW' });
    expect(two.note).toBe('Kur 30.05.2025, 29.05.2025 tarihli (TCMB yanıt vermedi, saklı son kur kullanıldı)');
    const one = compareLine({ ...tryTry, fx: { date: '2025-06-03', rate: usdTry('2025-05-30') }, tolFx: { base: 'EUR', quote: 'TRY', date: '2025-06-03', rate: { base: 'EUR', quote: 'TRY', rate: 45, date: '2025-05-30', source: 'TCMB', stale: true } } });
    expect(one.note).toBe('Kur 30.05.2025 tarihli (TCMB yanıt vermedi, saklı son kur kullanıldı)');
  });
});
