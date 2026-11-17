// DENETIM-2 01-B8: satırların para birimi birbirinden ya da faturanınkinden farklıysa okuma kontrolü sert bayrak koyar
// ve içe aktarma onayı ister (toplamlar farklı paraları toplamasın). Eskiden azınlık para birimi için hiçbir uyarı yoktu.
import { describe, expect, it } from 'vitest';
import { mappingDiagnostics } from '../src/invoice/diagnostics';
import { parseCurrency } from '../src/invoice/parse';
import { tableFromMatrix } from '../src/invoice/read';
import type { ColumnMapping } from '../src/invoice/types';
import { flagParsedLines, HARD_ROW_FLAGS, rowFlagLabel } from '../src/invoice/verify';

const m: ColumnMapping = {
  trackingNo: 'Takip No',
  netAmount: 'Tutar',
  currency: 'Para Birimi',
  surchargeColumns: [],
  chargePairs: [],
  amountsIncludeVat: false,
  vatPct: 20,
  desiAsWeight: false,
};

const table = (currencies: string[]) =>
  tableFromMatrix([['Takip No', 'Tutar', 'Para Birimi'], ...currencies.map((c, i) => [`7948000000${String(10 + i)}`, `${100 + i},00`, c])]);

describe('01-B8: karışık para birimi', () => {
  it('iki para birimli tablo: azınlık satırları sert bayrak, karar "kontrol", sorun metni sayıları söyler', () => {
    const t = table(['USD', 'USD', 'USD', 'EUR', 'USD', '€']);
    const d = mappingDiagnostics(t, m);
    const v = d.verification;
    expect(HARD_ROW_FLAGS).toContain('CURRENCY_MISMATCH');
    expect(v.rowFlags.filter((r) => r.codes.includes('CURRENCY_MISMATCH')).map((r) => r.rowIndex)).toEqual([3, 5]);
    expect(v.flagCounts.CURRENCY_MISMATCH).toBe(2);
    expect(v.verdict).toBe('check');
    expect(v.issues).toEqual(['2 satır faturanın para biriminde değil (2 EUR; fatura USD). Toplamlar farklı para birimlerini toplardı; bu satırları ayrı bir faturada yükleyin.']);
    const en = mappingDiagnostics(t, m, { locale: 'en' }).verification.issues;
    expect(en).toEqual(['2 lines are not in the invoice currency (2 EUR; invoice USD). Totals would add up different currencies; upload these lines as a separate invoice.']);
  });

  it('faturanın para birimi verilince (içe aktarma) ona göre: satırların hepsi USD, fatura TRY → hepsi bayraklı', () => {
    const t = table(['USD', 'usd', 'USD']);
    expect(mappingDiagnostics(t, m).verification.verdict).toBe('ok');
    const v = mappingDiagnostics(t, m, { invoiceCurrency: 'TRY' }).verification;
    expect(v.flagCounts.CURRENCY_MISMATCH).toBe(3);
    expect(v.issues).toEqual(['3 satır faturanın para biriminde değil (3 USD; fatura TRY). Toplamlar farklı para birimlerini toplardı; bu satırları ayrı bir faturada yükleyin.']);
    expect(mappingDiagnostics(t, m, { invoiceCurrency: 'usd' }).verification.verdict).toBe('ok');
  });

  it('para birimi sütunu yoksa ya da hücre boşsa bayrak yok (satır faturanınkini alır)', () => {
    const t = table(['USD', '', 'USD']);
    expect(mappingDiagnostics(t, m, { invoiceCurrency: 'USD' }).verification.verdict).toBe('ok');
    expect(mappingDiagnostics(t, { ...m, currency: undefined }, { invoiceCurrency: 'TRY' }).verification.flagCounts.CURRENCY_MISMATCH).toBeUndefined();
  });

  it('başka okuma sorunlarıyla birlikte: genel "okuma sorunu" metni para birimini ikinci kez saymaz', () => {
    const t = tableFromMatrix([
      ['Takip No', 'Tutar', 'Para Birimi'],
      ['794800000010', '100,00', 'USD'],
      ['794800000011', '101,00', 'USD'],
      ['794800000012', 'abc', 'USD'],
      ['794800000013', '103,00', 'EUR'],
    ]);
    const issues = mappingDiagnostics(t, m).verification.issues;
    expect(issues.filter((s) => s.includes('okuma sorunu'))).toEqual(['1 satırda okuma sorunu: net tutar sayı olarak okunamadı (1).']);
    expect(issues.filter((s) => s.includes('para biriminde değil'))).toHaveLength(1);
  });

  it('yazım farkları yanlış alarm değildir: TL, ₺, tl, Türk Lirası, TRY. → TRY; €, Euro, EUR. → EUR', () => {
    for (const c of ['TL', '₺', 'tl', 'Tl', 'try', 'TRY', 'Türk Lirası', 'TÜRK LİRASI', 'turk lirasi', 'TL.', ' TRY ', 'YTL']) expect(parseCurrency(c), c).toBe('TRY');
    for (const c of ['€', 'EUR', 'eur', 'Euro', 'EURO', 'EUR.', '(EUR)', 'Avro']) expect(parseCurrency(c), c).toBe('EUR');
    for (const c of ['$', 'US$', 'usd', 'Dolar', 'US Dollar', 'ABD Doları']) expect(parseCurrency(c), c).toBe('USD');
    for (const c of ['', '-', '1.234,50', 'Kur 32,5']) expect(parseCurrency(c), c).toBeUndefined();
    const t = table(['TL', '₺', 'tl', 'Türk Lirası', 'TRY', '']);
    const v = mappingDiagnostics(t, m, { invoiceCurrency: 'TRY' }).verification;
    expect(v.flagCounts.CURRENCY_MISMATCH).toBeUndefined();
    expect(v.verdict).toBe('ok');
    expect(mappingDiagnostics(table(['EUR', '€', 'Euro']), m, { invoiceCurrency: 'EUR' }).verification.verdict).toBe('ok');
    // fatura para birimi sembolle verilse de
    expect(flagParsedLines([{ rowIndex: 0, trackingNo: '794800000010', netAmount: 1, surcharges: [], rawHash: '', currency: 'TL' }], { invoiceCurrency: 'TRY' })).toEqual([]);
  });

  it('para birimi hücresi dolu ama tanınmıyorsa (sütunun öbür satırları tanınıyor) satır bayraklı: sessizce faturanınkini almaz', () => {
    const t = table(['USD', 'USD', 'Fr.', 'USD', '-']);
    const v = mappingDiagnostics(t, m, { invoiceCurrency: 'USD' }).verification;
    expect(v.rowFlags.filter((r) => r.codes.includes('CURRENCY_MISMATCH')).map((r) => r.rowIndex)).toEqual([2]);
    expect(v.verdict).toBe('check');
    expect(v.issues).toContain('1 satır faturanın para biriminde değil (1 FR.; fatura USD). Toplamlar farklı para birimlerini toplardı; bu satırları ayrı bir faturada yükleyin.');
    // sütunun hiçbir hücresi tanınmıyorsa satır bayrağı yok (alan denetimi "kontrol edin" der)
    const all = mappingDiagnostics(table(['Fr.', 'Fr.']), m, { invoiceCurrency: 'USD' }).verification;
    expect(all.flagCounts.CURRENCY_MISMATCH).toBeUndefined();
    expect(all.fields.currency?.status).toBe('check');
  });

  it('PDF satırları (flagParsedLines): faturanın para birimiyle ya da çoğunlukla karşılaştırılır', () => {
    const line = (rowIndex: number, currency?: string) => ({ rowIndex, trackingNo: `79480000001${rowIndex}`, netAmount: 10, surcharges: [], rawHash: '', ...(currency ? { currency } : {}) });
    const lines = [line(0, 'EUR'), line(1, 'EUR'), line(2, 'USD'), line(3)];
    expect(flagParsedLines(lines).filter((f) => f.codes.includes('CURRENCY_MISMATCH')).map((f) => f.rowIndex)).toEqual([2]);
    expect(flagParsedLines(lines, { invoiceCurrency: 'USD' }).filter((f) => f.codes.includes('CURRENCY_MISMATCH')).map((f) => f.rowIndex)).toEqual([0, 1]);
    expect(rowFlagLabel('CURRENCY_MISMATCH', 'tr')).toBe('Para birimi faturanınkinden farklı');
    expect(rowFlagLabel('CURRENCY_MISMATCH', 'en')).toBe('Currency differs from the invoice');
  });
});
