import { describe, expect, it } from 'vitest';
import { guessInvoiceMeta, mappingDiagnostics, parseRows, readDateOrder, resolveDateOrder, verifyMapping, type ColumnMapping, type Table } from '../src/invoice';

const HEADERS = ['Inv #', 'Bill Date', 'Ship Date', 'Waybill', 'Total Charge'];
const table = (bill: string, ...ships: string[]): Table => ({
  headers: HEADERS,
  rows: ships.map((s, i) => ['INV-1', bill, s, `77312563743${i}`, '82.69']),
});
const mapping = (over: Partial<ColumnMapping> = {}) =>
  ({ trackingNo: 'Waybill', netAmount: 'Total Charge', shipDate: 'Ship Date', invoiceDate: 'Bill Date', invoiceNo: 'Inv #', surchargeColumns: [], amountsIncludeVat: false, vatPct: 20, desiAsWeight: false, ...over }) as ColumnMapping;
const AMBIGUOUS = /Tarih sırası belli değil: 10\/05\/2026, 10 Mayıs 2026 de olabilir 5 Ekim 2026 de/;

describe('tarih sırası', () => {
  it('bulgunun kendisi: gönderi tarihi ay/gün gösterirken 10/05/2026 fatura tarihi 5 Ekim okunur', () => {
    const t = table('10/05/2026', '10/15/2026', '10/16/2026');
    expect(guessInvoiceMeta(t, mapping()).invoiceDate).toBe('2026-10-05');
    expect(mappingDiagnostics(t, mapping()).dateAmbiguity).toBeUndefined();
    expect(mappingDiagnostics(t, mapping()).verification.issues.join()).not.toMatch(/Tarih sırası/);
  });

  it('fatura tarihi eşlenmemiş olsa da sütun bulunur, kanıt ondan da gelir', () => {
    const t = table('10/27/2026', '10/05/2026', '11/02/2026');
    const m = mapping({ invoiceDate: undefined });
    expect(guessInvoiceMeta(t, m).invoiceDate).toBe('2026-10-27');
    expect(parseRows(t, m).lines[0]!.shipDate).toBe('2026-10-05');
  });

  it('kanıt fatura tarihindeyse satırlar da aynı sırayla okunur', () => {
    const t = table('10/27/2026', '10/05/2026');
    expect(parseRows(t, mapping()).lines[0]!.shipDate).toBe('2026-10-05');
  });

  it('hiç kanıt yoksa tahmin edilmez: okuma kontrolü sorar, iki okumayı ay adıyla söyler', () => {
    const t = table('10/05/2026', '10/05/2026', '11/02/2026');
    const d = mappingDiagnostics(t, mapping());
    expect(d.dateAmbiguity).toEqual({ sample: '10/05/2026', dmy: '2026-05-10', mdy: '2026-10-05' });
    expect(d.verification.verdict).toBe('check');
    expect(d.verification.issues.join()).toMatch(AMBIGUOUS);
    expect(mappingDiagnostics(t, mapping(), { locale: 'en' }).verification.issues.join()).toMatch(/10\/05\/2026 could be 10 May 2026 or 5 October 2026/);
  });

  it.each([
    ['mdy', '2026-10-05', '2026-11-02'],
    ['dmy', '2026-05-10', '2026-02-11'],
  ] as const)('seçim yapılınca (%s) sorun kalkar, seçim üç okumada da geçerli', (order, bill, ship) => {
    const t = table('10/05/2026', '11/02/2026');
    const m = mapping({ dateOrder: order });
    const d = mappingDiagnostics(t, m);
    expect(d.verification.issues.join()).not.toMatch(/Tarih sırası/);
    expect(d.dateOrderSource).toBe('hint');
    // Seçim ekranı açık kalır: kullanıcı fikrini değiştirebilir.
    expect(d.dateAmbiguity).toBeTruthy();
    expect(guessInvoiceMeta(t, m).invoiceDate).toBe(bill);
    expect(parseRows(t, m).lines[0]!.shipDate).toBe(ship);
    expect(verifyMapping(t, m).issues.join()).not.toMatch(/Tarih sırası/);
  });

  it.each([
    ['dmy', '10/05/2026', ['10/01/2026', '10/15/2026', '10/03/2026'], '2026-10-05', ['2026-10-01', '2026-10-15', '2026-10-03'], 'mdy'],
    ['mdy', '05/10/2026', ['01/10/2026', '15/10/2026', '03/10/2026'], '2026-10-05', ['2026-10-01', '2026-10-15', '2026-10-03'], 'dmy'],
  ] as const)('kayıtlı seçim (%s) dosyanın kendi kanıtını ezmez', (saved, bill, ships, invoiceDate, shipDates, read) => {
    const t = table(bill, ...ships);
    const m = mapping({ dateOrder: saved });
    const d = mappingDiagnostics(t, m);
    expect(d.dateOrder).toBe(read);
    expect(d.dateOrderSource).toBe('detected');
    expect(d.dateAmbiguity).toBeUndefined();
    expect(guessInvoiceMeta(t, m).invoiceDate).toBe(invoiceDate);
    expect(parseRows(t, m).lines.map((l) => l.shipDate)).toEqual(shipDates);
  });

  it('kayıtlı ay/gün, sorulmayan noktalı Türkçe dosyayı bozmaz', () => {
    const t = table('05.10.2026', '01.10.2026', '04.10.2026');
    const m = mapping({ dateOrder: 'mdy' });
    expect(guessInvoiceMeta(t, m).invoiceDate).toBe('2026-10-05');
    expect(parseRows(t, m).lines.map((l) => l.shipDate)).toEqual(['2026-10-01', '2026-10-04']);
    const d = mappingDiagnostics(t, m);
    expect(d.dateOrder).toBe('dmy');
    expect(d.dateOrderSource).toBe('detected');
  });

  it('çelişen dosyada seçim geçerli, soru açık kalır', () => {
    const t = table('10/05/2026', '10/27/2026', '27/10/2026');
    const d = mappingDiagnostics(t, mapping({ dateOrder: 'mdy' }));
    expect(d.dateOrder).toBe('mdy');
    expect(d.dateOrderSource).toBe('hint');
    expect(d.dateAmbiguity?.sample).toBe('10/05/2026');
  });

  it('çelişen dosyada da sorar', () => {
    expect(readDateOrder(['10/27/2026', '27/10/2026', '10/05/2026']).ambiguous?.sample).toBe('10/05/2026');
  });

  it.each([
    ['gün 12den büyük', ['27/10/2026', '05/10/2026']],
    ['noktalı Türkçe biçim', ['05.10.2026', '06.10.2026']],
    ['ISO', ['2026-10-05']],
    ['gün ve ay aynı', ['05/05/2026']],
    ['ay adıyla', ['05-Oct-2026']],
    ['boş', ['', '  ']],
  ])('sorulmaz: %s', (_name, values) => {
    expect(readDateOrder(values).ambiguous).toBeNull();
    expect(readDateOrder(values).order).toBe('dmy');
  });

  it('tireli biçim de iki türlü okunur', () => {
    expect(readDateOrder(['10-05-2026']).ambiguous).toEqual({ sample: '10-05-2026', dmy: '2026-05-10', mdy: '2026-10-05' });
  });

  it('eşleme vermeden de çalışır', () => {
    expect(resolveDateOrder({ headers: ['Invoice Date'], rows: [['10/27/2026']] }).order).toBe('mdy');
  });
});
