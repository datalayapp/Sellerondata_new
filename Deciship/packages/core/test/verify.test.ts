import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  billedWeightPlausible,
  emptyMapping,
  flagParsedLines,
  hardFlags,
  mappingDiagnostics,
  mergeAiMapping,
  sourcesFor,
  readTable,
  shouldSuggestAi,
  suggestMapping,
  tableFromMatrix,
  trackingLooksValid,
  verifyMapping,
  type ColumnMapping,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));

const HEAD = ['Takip No', 'Tarih', 'Kg', 'Ücretli Kg', 'En', 'Boy', 'Yükseklik', 'Navlun', 'Yakıt', 'Net Tutar', 'Fatura Toplamı'];
function table(rows: string[][]) {
  return tableFromMatrix([HEAD, ...rows]);
}
const GOOD: string[][] = [
  ['794812345301', '20.10.2026', '4', '6', '40', '30', '25', '1000,00', '250,00', '1250,00', '4400,00'],
  ['794812345302', '21.10.2026', '2', '2', '20', '20', '10', '800,00', '200,00', '1000,00', '4400,00'],
  ['794812345303', '22.10.2026', '1', '1,5', '30', '20', '10', '600,00', '150,00', '750,00', '4400,00'],
  ['794812345304', '23.10.2026', '3', '3', '30', '20', '15', '1120,00', '280,00', '1400,00', '4400,00'],
];
function mapping(over: Partial<ColumnMapping> = {}): ColumnMapping {
  return {
    ...emptyMapping(),
    trackingNo: 'Takip No',
    shipDate: 'Tarih',
    actualKg: 'Kg',
    billedKg: 'Ücretli Kg',
    dimL: 'En',
    dimW: 'Boy',
    dimH: 'Yükseklik',
    baseAmount: 'Navlun',
    fuelAmount: 'Yakıt',
    netAmount: 'Net Tutar',
    invoiceTotal: 'Fatura Toplamı',
    ...over,
  };
}

describe('verifyMapping (okuma kontrolü)', () => {
  it('temiz dosyada her alan "ok", genel karar ok, bayrak yok', () => {
    const v = verifyMapping(table(GOOD), mapping());
    expect(v.verdict).toBe('ok');
    expect(v.issues).toEqual([]);
    expect(v.rowFlags).toEqual([]);
    expect(v.fields.trackingNo).toMatchObject({ status: 'ok' });
    expect(v.fields.netAmount!.status).toBe('ok');
    expect(v.fields.netAmount!.reasons.join(' ')).toContain('fatura toplamıyla tutuyor');
    expect(v.checks.charges).toEqual({ rowsChecked: 4, rowsMatching: 4 });
    expect(v.checks.invoiceTotal).toMatchObject({ value: 4400, difference: 0 });
    expect(v.checks.billedWeight).toMatchObject({ rowsChecked: 4, rowsOdd: 0, divisor: 5000 });
  });

  it('eksik zorunlu alan "missing" olur ve AI önerilir', () => {
    const v = verifyMapping(table(GOOD), mapping({ netAmount: undefined }));
    expect(v.fields.netAmount).toEqual({ status: 'missing', confidence: 0, reasons: ['Sütun seçilmedi'] });
    expect(v.verdict).toBe('check');
    expect(shouldSuggestAi(v, 'preset', true)).toBe(true);
  });

  it('fatura toplamı net tutar olarak seçilirse sabit değer ve toplam farkı yakalanır', () => {
    const rows = [...GOOD, ['794812345305', '24.10.2026', '1', '1', '10', '10', '10', '0', '0', '0', '4400,00']].map((r) => r.slice());
    const v = verifyMapping(table(rows), mapping({ netAmount: 'Fatura Toplamı', invoiceTotal: undefined, baseAmount: undefined, fuelAmount: undefined }));
    expect(v.fields.netAmount!.status).toBe('check');
    expect(v.fields.netAmount!.reasons.join(' ')).toContain('aynı değer');
    expect(v.verdict).toBe('check');
  });

  it('satır bayrakları: ücret uyuşmazlığı, ağırlık aralığı, mükerrer, takip no biçimi, tarih, birim', () => {
    const rows = GOOD.map((r) => r.slice());
    rows[0]![9] = '1300,00'; // kalemler 1250 → CHARGES_MISMATCH
    rows[1]![2] = '1500'; // WEIGHT_RANGE
    rows[2]![0] = '794812345301'; // DUPLICATE_TRACKING (2. görünüm)
    rows[3]![1] = '31.31.2026'; // DATE_PARSE
    const t = tableFromMatrix([[...HEAD, 'Birim'], ...rows.map((r, i) => [...r, i === 3 ? 'stone' : 'KG'])]);
    const v = verifyMapping(t, mapping({ actualKgUnit: 'Birim' }));
    const by = new Map(v.rowFlags.map((f) => [f.rowIndex, f.codes]));
    expect(by.get(0)).toContain('CHARGES_MISMATCH');
    expect(by.get(1)).toContain('WEIGHT_RANGE');
    expect(by.get(2)).toContain('DUPLICATE_TRACKING');
    expect(by.get(3)).toEqual(expect.arrayContaining(['DATE_PARSE', 'UNIT_UNKNOWN']));
    expect(v.flaggedRows).toBe(3);
    expect(v.verdict).toBe('check');
    expect(v.issues.some((i) => i.includes('3 satırda okuma sorunu'))).toBe(true);
  });

  it('ücretli ağırlık max(gerçek, hacimsel) ile uyuşmazsa yumuşak bayrak; genel kararı bozmaz', () => {
    const rows = GOOD.map((r) => r.slice());
    rows[0]![3] = '25'; // 40x30x25/5000 = 6 kg, gerçek 4 → 25 kg tuhaf
    const v = verifyMapping(table(rows), mapping());
    expect(v.rowFlags).toEqual([{ rowIndex: 0, trackingNo: '794812345301', codes: ['BILLED_WEIGHT_ODD'] }]);
    expect(v.flaggedRows).toBe(0);
    expect(v.verdict).toBe('ok');
    expect(hardFlags(['BILLED_WEIGHT_ODD', 'WEIGHT_RANGE'])).toEqual(['WEIGHT_RANGE']);
  });

  it('tablodaki bölen yoksa verilen tarife böleni kullanılır', () => {
    // 40x30x25 / 3000 = 10 desi; ücretli 10 → 3000 ile uyumlu, 5000 ile tuhaf
    const rows = GOOD.map((r) => r.slice());
    rows[0]![3] = '10';
    expect(verifyMapping(table(rows), mapping()).checks.billedWeight.rowsOdd).toBe(1);
    expect(verifyMapping(table(rows), mapping(), { divisor: 3000 }).checks.billedWeight.rowsOdd).toBe(0);
  });

  it('takip no sütunu yerine fatura no seçilirse benzersizlik düşük → kontrol edin', () => {
    const t = tableFromMatrix([['Fatura No', ...HEAD], ...GOOD.map((r) => ['508945447', ...r])]);
    const v = verifyMapping(t, mapping({ trackingNo: 'Fatura No' }));
    expect(v.fields.trackingNo!.status).toBe('check');
    expect(v.fields.trackingNo!.reasons.join(' ')).toContain('farklı değer');
  });

  it('yardımcılar', () => {
    expect(trackingLooksValid('7948 1234 5305')).toBe(true);
    expect(trackingLooksValid('ABC')).toBe(false);
    expect(billedWeightPlausible(9.5, 4, 9.12)).toBe(true);
    expect(billedWeightPlausible(30, 4, 6)).toBe(false);
    expect(flagParsedLines([{ rowIndex: 0, trackingNo: 'X1', surcharges: [], netAmount: 1, rawHash: 'h', dims: { l: 500, w: 1, h: 1 } }]).map((f) => f.codes)).toEqual([
      ['TRACKING_FORMAT', 'DIMS_RANGE'],
    ]);
  });

  it('mappingDiagnostics doğrulamayı içerir; FedEx örnek dosyasında karar ok', async () => {
    const t = await readTable('fedex-fbo-tr-sample.csv', new Uint8Array(readFileSync(resolve(here, '../../../samples/invoices/fedex-fbo-tr-sample.csv'))));
    const s = suggestMapping(t.headers, 'fedex', t.rows);
    const d = mappingDiagnostics(t, s.mapping);
    expect(d.verification.fields.trackingNo!.status).toBe('ok');
    expect(d.verification.fields.netAmount!.status).toBe('ok');
    expect(d.verification.verdict, d.verification.issues.join('\n')).toBe('ok');
    expect(shouldSuggestAi(d.verification, 'preset', true)).toBe(false);
    expect(shouldSuggestAi(d.verification, 'preset', false)).toBe(true);
  });
});

describe('mergeAiMapping (birleştirme kuralları)', () => {
  it('doğrulanmış deterministik seçim, daha düşük güvenli farklı yapay zekâ seçimine karşı korunur', () => {
    const t = table(GOOD);
    const base = mapping();
    const ai = { mapping: { ...mapping(), netAmount: 'Navlun', baseAmount: undefined, shipDate: undefined }, confidence: { netAmount: 0.4, trackingNo: 0.99 } };
    const r = mergeAiMapping(t, base, sourcesFor(base, 'preset'), ai);
    expect(r.mapping.netAmount).toBe('Net Tutar');
    expect(r.decisions.netAmount).toBe('kept');
    expect(r.decisions.trackingNo).toBe('agree');
    expect(r.sources.netAmount).toBe('preset');
    expect(r.mapping.shipDate).toBe('Tarih');
  });

  it('eksik ya da sorunlu deterministik seçimin yerine yapay zekâ seçimi alınır, kaynak "ai" olur', () => {
    const t = table(GOOD);
    const base = mapping({ netAmount: undefined, shipDate: undefined });
    const ai = { mapping: { ...emptyMapping(), netAmount: 'Net Tutar', shipDate: 'Tarih', dateOrder: 'dmy' as const }, confidence: { netAmount: 0.9, shipDate: 0.8 } };
    const r = mergeAiMapping(t, base, sourcesFor(base, 'preset'), ai);
    expect(r.mapping.netAmount).toBe('Net Tutar');
    expect(r.sources.netAmount).toBe('ai');
    expect(r.sources.trackingNo).toBe('preset');
    expect(r.verification.verdict).toBe('ok');
  });

  it('aynı sütun iki alana verilmez; yapay zekânın çakışan seçimi geri alınır', () => {
    const t = table(GOOD);
    const base = mapping({ fuelAmount: undefined });
    const ai = { mapping: { ...emptyMapping(), fuelAmount: 'Navlun' }, confidence: { fuelAmount: 0.9 } };
    const r = mergeAiMapping(t, base, sourcesFor(base, 'preset'), ai);
    expect(r.mapping.fuelAmount).toBeUndefined();
    expect(r.mapping.baseAmount).toBe('Navlun');
  });
});

describe('parseCountry (dile bağımsız)', () => {
  it('Almanca, Fransızca, İspanyolca ülke adlarını ISO-2 koduna çevirir', async () => {
    const { parseCountry } = await import('../src/index');
    expect(parseCountry('Frankreich')).toBe('FR');
    expect(parseCountry('Niederlande')).toBe('NL');
    expect(parseCountry('Österreich')).toBe('AT');
    expect(parseCountry('Allemagne')).toBe('DE');
    expect(parseCountry('Estados Unidos')).toBe('US');
    expect(parseCountry('Fransa')).toBe('FR');
    expect(parseCountry('Atlantis')).toBeUndefined();
  });
});

describe('mergeAiMapping (güvenlik)', () => {
  it('boş isteğe bağlı alana yapay zekânın koyduğu ama doğrulamadan geçmeyen seçim atılır', async () => {
    const { mergeAiMapping, sourcesFor } = await import('../src/index');
    const t = tableFromMatrix([[...HEAD, 'Hacim'], ...GOOD.map((r) => [...r, '139'])]);
    const base = mapping();
    const r = mergeAiMapping(t, base, sourcesFor(base, 'saved'), { mapping: { ...emptyMapping(), billedDivisor: 'Hacim' }, confidence: { billedDivisor: 0.8 } });
    expect(r.mapping.billedDivisor).toBeUndefined();
    expect(r.decisions.billedDivisor).toBe('reverted');
    expect(r.verification.verdict).toBe('ok');
  });

  it('yerleşik koda sahip ek ücret etiketinin kodu yapay zekâ tarafından değiştirilmez', async () => {
    const { mergeAiMapping, sourcesFor } = await import('../src/index');
    const base = mapping();
    const ov = [
      { label: 'Demand Surcharge', kind: 'surcharge' as const, code: 'DEMAND' },
      { label: 'Gebühr XYZ', kind: 'discount' as const },
    ];
    const r = mergeAiMapping(table(GOOD), base, sourcesFor(base, 'preset'), { mapping: { ...emptyMapping(), chargeLabelOverrides: ov }, confidence: {} });
    expect(r.mapping.chargeLabelOverrides).toEqual([{ label: 'Gebühr XYZ', kind: 'discount' }]);
  });
});

describe('suggestMapping birim ipucu', () => {
  it('"(lbs)" ve "(in)" başlıkları sabit birim olur', () => {
    const s = suggestMapping(['Waybill', 'Weight (lbs)', 'Dimensions (in)', 'Total Charge'], 'generic', [['773125637437', '19.7', '10x8x4', '82.69']]);
    expect(s.mapping.actualKg).toBe('Weight (lbs)');
    expect(s.mapping.defaultWeightUnit).toBe('lb');
    expect(s.mapping.defaultDimUnit).toBe('in');
  });
});
