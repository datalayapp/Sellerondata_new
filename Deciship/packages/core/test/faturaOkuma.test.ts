// KALANLAR 1.3, 1.4, 1.5, 1.6, 1.13: gerçek taşıyıcı dosyalarında sessizce yanlış rakam üreten okuma sorunları.
// Her durumda ya doğru okunur ya da okuma kontrolü sorar (verdict 'check'); "ok" deyip yanlış tutar yazılmaz.
import ExcelJS from 'exceljs';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mappingDiagnostics } from '../src/invoice/diagnostics';
import { suggestMapping, unreadSheetsOf } from '../src/invoice/mapping';
import { mergeAiMapping, sourcesFor } from '../src/invoice/merge';
import { parseRows, resolveNumberFormat, tableWeightAmbiguity } from '../src/invoice/parse';
import { readTable } from '../src/invoice/read';
import { emptyMapping, type ColumnMapping, type Table } from '../src/invoice/types';
import { checkMappingVat, findVatAmountColumn, isVatAmountHeader, vatEvidence } from '../src/invoice/vat';
import { isScientificTracking, scientificTrackingRows, verifyMapping } from '../src/invoice/verify';
import { normalizeHeader } from '../src/invoice/normalize';

const here = dirname(fileURLToPath(import.meta.url));
const table = (headers: string[], rows: string[][]): Table => ({ headers, rows });
const nets = (t: Table, m: ColumnMapping) => parseRows(t, m).lines.map((l) => l.netAmount);

describe('1.3 KDV dahil toplam sütunu', () => {
  it('başlık tanıma: veri sınaması için KDV tutarı sütunu', () => {
    for (const h of ['KDV', 'KDV (%20)', 'KDV Tutarı', 'KDV Tutarı (TL)', 'Hesaplanan KDV', 'VAT', 'VAT Amount', 'Tax']) {
      expect(isVatAmountHeader(normalizeHeader(h)), h).toBe(true);
    }
    for (const h of ['KDV Oranı', 'KDV %', 'KDV Hariç Tutar', 'Tutar (KDV Dahil)', 'Toplam Vergiler', 'Vergi No', 'Tax ID', 'Toplam']) {
      // "KDV %" normalleşince "kdv" olur: başlık KDV tutarıdır, oran sütunu verisiyle elenir (aşağıda)
      if (h === 'KDV %') continue;
      expect(isVatAmountHeader(normalizeHeader(h)), h).toBe(false);
    }
  });

  // net 100,00 / 141,30 / 78,55 / 1.139,79 · KDV %20 · toplam KDV dahil
  const inclRows = [
    ['571088001201', '10', '20,00', '120,00'],
    ['571088001212', '7', '28,26', '169,56'],
    ['571088001223', '3', '15,71', '94,26'],
    ['571088001234', '12', '227,96', '1.367,75'],
  ];

  it('"KDV; Toplam Fiyat": toplam KDV dahil tanınır, oran veriden (%20), net doğru, okuma kontrolü ok', () => {
    for (const carrier of ['generic', 'mng', 'aras'] as const) {
      const t = table(['Gönderi No', 'Desi', 'KDV', 'Toplam Fiyat'], inclRows);
      const { mapping } = suggestMapping(t.headers, carrier, t.rows);
      expect(mapping, carrier).toMatchObject({ trackingNo: 'Gönderi No', netAmount: 'Toplam Fiyat', amountsIncludeVat: true, vatPct: 20 });
      expect(nets(t, mapping), carrier).toEqual([100, 141.3, 78.55, 1139.79]);
      const v = verifyMapping(t, mapping);
      expect(v.fields.netAmount?.status, carrier).toBe('ok');
      expect(v.verdict, carrier).toBe('ok');
    }
  });

  it('"Toplam (TL)" + "KDV Tutarı" %10: oran veriden okunur', () => {
    const t = table(['Takip No', 'KDV Tutarı', 'Toplam (TL)'], [
      ['620031840101', '20,00', '220,00'],
      ['620031840112', '5,55', '61,05'],
      ['620031840123', '100,00', '1.100,00'],
    ]);
    const { mapping } = suggestMapping(t.headers, 'yurtici', t.rows);
    expect(mapping).toMatchObject({ netAmount: 'Toplam (TL)', amountsIncludeVat: true, vatPct: 10 });
    expect(nets(t, mapping)).toEqual([200, 55.5, 1000]);
    expect(verifyMapping(t, mapping).verdict).toBe('ok');
  });

  const exclTable = () =>
    table(['Gönderi No', 'Tutar', 'KDV', 'Toplam'], [
      ['571088001201', '100,00', '20,00', '120,00'],
      ['571088001212', '141,30', '28,26', '169,56'],
      ['571088001223', '78,55', '15,71', '94,26'],
    ]);

  it('"Tutar; KDV; Toplam": KDV hariç tutar seçilir, veri KDV hariç der', () => {
    const t = exclTable();
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(mapping).toMatchObject({ netAmount: 'Tutar', amountsIncludeVat: false });
    expect(checkMappingVat(t, mapping)).toMatchObject({ evidence: { verdict: 'excl', pct: 20, rows: 3, agreeing: 3 }, problem: null });
    expect(verifyMapping(t, mapping).verdict).toBe('ok');
  });

  it('kayıtlı/elle eşleme toplamı KDV hariç sayıyorsa okuma kontrolü sorar (sessizce %20 fazla yazmaz)', () => {
    const t = exclTable();
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Gönderi No', netAmount: 'Toplam' };
    const v = verifyMapping(t, m);
    expect(v.fields.netAmount?.status).toBe('check');
    expect(v.verdict).toBe('check');
    expect(v.issues.join('\n')).toContain('tutarlar KDV dahil görünüyor ("KDV" sütunu tutarın içindeki %20 KDV ile tutuyor); "Tutarlar KDV dahil" seçin ya da KDV hariç tutar sütununu seçin');
    const en = verifyMapping(t, m, { locale: 'en' });
    expect(en.issues.join('\n')).toContain('amounts look tax-inclusive (column "KDV" matches 20% VAT included in the amount)');
    // düzeltilince sorun kalmaz
    expect(verifyMapping(t, { ...m, amountsIncludeVat: true, vatPct: 20 }).verdict).toBe('ok');
  });

  it('KDV hariç sütun "KDV dahil" diye eşlenirse sorar', () => {
    const t = exclTable();
    const v = verifyMapping(t, { ...emptyMapping(), trackingNo: 'Gönderi No', netAmount: 'Tutar', amountsIncludeVat: true, vatPct: 20 });
    expect(v.verdict).toBe('check');
    expect(v.issues.join('\n')).toContain('tutarlar KDV hariç görünüyor ("KDV" sütunu tutarın %20 kadarı); "Tutarlar KDV dahil" seçimini kaldırın');
  });

  it('oran farklıysa sorar (eşlemede %18, dosyada %20)', () => {
    const t = table(['Gönderi No', 'Desi', 'KDV', 'Toplam Fiyat'], inclRows);
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Gönderi No', netAmount: 'Toplam Fiyat', amountsIncludeVat: true, vatPct: 18 };
    const v = verifyMapping(t, m);
    expect(v.verdict).toBe('check');
    expect(v.issues.join('\n')).toContain('KDV oranı %20 görünüyor ("KDV" sütunu), eşlemede %18 yazılı; oranı düzeltin');
  });

  it('KDV her satırda 0: toplam KDV dahil sayılmaz (eskiden başlıktan dahil sayılıp %20 eksik yazılırdı)', () => {
    const t = table(['Takip No', 'KDV', 'Toplam'], [
      ['794812345301', '0,00', '1.642,50'],
      ['794812345302', '0,00', '1.003,38'],
      ['794812345303', '0,00', '500,00'],
    ]);
    expect(findVatAmountColumn(t, ['Toplam'])).toBe('KDV');
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(mapping).toMatchObject({ netAmount: 'Toplam', amountsIncludeVat: false });
    expect(nets(t, mapping)).toEqual([1642.5, 1003.38, 500]);
    expect(verifyMapping(t, mapping).verdict).toBe('ok');
    const v = verifyMapping(t, { ...mapping, amountsIncludeVat: true });
    expect(v.verdict).toBe('check');
    expect(v.issues.join('\n')).toContain('"KDV" sütununda KDV her satırda 0; tutarlar KDV dahil değil');
  });

  it('veri tek okumaya uymuyorsa (KDV\'siz kapıda ödeme toplamda) tahmin edilmez, sorulur', () => {
    const t = table(['Gönderi No', 'Navlun', 'Kapıda Ödeme', 'KDV', 'Toplam'], [
      ['571088001201', '100,00', '15,00', '20,00', '135,00'],
      ['571088001212', '50,00', '', '10,00', '60,00'],
      ['571088001223', '80,00', '15,00', '16,00', '111,00'],
    ]);
    const { mapping } = suggestMapping(t.headers, 'mng', t.rows);
    expect(mapping.netAmount).toBe('Toplam');
    expect(vatEvidence(t, 'Toplam', 'KDV')).toMatchObject({ verdict: 'unclear', rows: 3, agreeing: 1 });
    const v = verifyMapping(t, mapping);
    expect(v.fields.netAmount?.status).toBe('check');
    expect(v.issues.join('\n')).toContain('tutarın KDV dahil mi hariç mi olduğu "KDV" sütunundan anlaşılamadı');
  });

  it('KDV\'li ve KDV\'siz satırlar karışıksa tek oranla düşülmez: sorulur', () => {
    const t = table(['Takip No', 'KDV', 'Toplam'], [
      ['794812345301', '20,00', '120,00'],
      ['794812345302', '0,00', '300,00'],
      ['794812345303', '10,00', '60,00'],
    ]);
    expect(vatEvidence(t, 'Toplam', 'KDV')).toMatchObject({ verdict: 'mixed', pct: 20, zeroRows: 1 });
    for (const amountsIncludeVat of [true, false]) {
      const v = verifyMapping(t, { ...emptyMapping(), trackingNo: 'Takip No', netAmount: 'Toplam', amountsIncludeVat });
      expect(v.verdict).toBe('check');
      expect(v.issues.join('\n')).toContain('KDV\'li satırlar KDV dahil görünüyor (%20) ama 1 satırda "KDV" boş ya da 0');
    }
  });

  it('her satırda aynı oran yazan "KDV" sütunu KDV tutarı sayılmaz; iki okumaya birden uyan küçük tutar karar vermez', () => {
    const rate = table(['Takip No', 'KDV', 'Tutar'], [
      ['794812345301', '20', '120,00'],
      ['794812345302', '20', '300,00'],
      ['794812345303', '20', '60,00'],
    ]);
    expect(findVatAmountColumn(rate, ['Tutar'])).toBe('KDV');
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip No', netAmount: 'Tutar' };
    expect(checkMappingVat(rate, m)).toMatchObject({ evidence: { verdict: 'none' }, problem: null });
    // kanıt yokken "KDV dahil" seçimi sorulur
    expect(checkMappingVat(rate, { ...m, amountsIncludeVat: true })?.problem).toBe('unclear');
    const tiny = table(['Takip No', 'KDV', 'Toplam'], [['794812345301', '0,02', '0,12']]);
    expect(vatEvidence(tiny, 'Toplam', 'KDV')).toMatchObject({ verdict: 'none', rows: 0 });
  });

  it('iade satırı (eksi tutar ve eksi KDV) aynı kuralla sınanır', () => {
    const t = table(['Takip No', 'KDV', 'Toplam'], [
      ['794812345301', '20,00', '120,00'],
      ['794812345302', '-10,00', '-60,00'],
    ]);
    expect(vatEvidence(t, 'Toplam', 'KDV')).toMatchObject({ verdict: 'incl', pct: 20, rows: 2, agreeing: 2 });
  });

  it('XLSX gerçek sayı hücreleri de sınanır (okuma kontrolü)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fatura');
    ws.addRow(['Takip No', 'KDV', 'Toplam']);
    ws.addRow(['794812345301', 20, 120]);
    ws.addRow(['794812345302', 28.26, 169.56]);
    const t = await readTable('a.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
    const v = verifyMapping(t, { ...emptyMapping(), trackingNo: 'Takip No', netAmount: 'Toplam' });
    expect(v.issues.join('\n')).toContain('tutarlar KDV dahil görünüyor');
  });
});

describe('1.3 bağımsız inceleme: "KDV dahil" başlıktan sessizce çıkmaz', () => {
  const issues = (t: Table, m: ColumnMapping) => verifyMapping(t, m).issues.join('\n');

  it('boş "Tax" + "Total Charge" (gümrük vergisi sütunu): KDV hariç kalır, okuma kontrolü ok (eski hâl)', () => {
    const t = table(['Tracking Number', 'Tax', 'Total Charge'], [
      ['794812345301', '', '100.00'],
      ['794812345302', '', '200.00'],
      ['794812345303', '', '50.00'],
    ]);
    for (const carrier of ['generic', 'dhl', 'ups', 'fedex'] as const) {
      const { mapping } = suggestMapping(t.headers, carrier, t.rows);
      expect(mapping.netAmount, carrier).toBe('Total Charge');
      expect(mapping.amountsIncludeVat, carrier).toBe(false);
      expect(nets(t, mapping), carrier).toEqual([100, 200, 50]);
      expect(verifyMapping(t, mapping).verdict, carrier).toBe('ok');
    }
  });

  it('dolu ama tutarsız gümrük vergisi "Tax": KDV hariç kalır, yeni engel yok', () => {
    const t = table(['Tracking Number', 'Tax', 'Total Charge'], [
      ['794812345301', '7.40', '100.00'],
      ['794812345302', '31.15', '200.00'],
      ['794812345303', '2.05', '50.00'],
    ]);
    const { mapping } = suggestMapping(t.headers, 'ups', t.rows);
    expect(mapping.amountsIncludeVat).toBe(false);
    expect(nets(t, mapping)).toEqual([100, 200, 50]);
    expect(verifyMapping(t, mapping).verdict).toBe('ok');
  });

  it('boş "KDV" + "Toplam Ücret": KDV hariç kalır', () => {
    const t = table(['Takip No', 'KDV', 'Toplam Ücret'], [
      ['794812345301', '', '100,00'],
      ['794812345302', '', '200,00'],
      ['794812345303', '', '50,00'],
    ]);
    for (const carrier of ['generic', 'yurtici'] as const) {
      const { mapping } = suggestMapping(t.headers, carrier, t.rows);
      expect(mapping.amountsIncludeVat, carrier).toBe(false);
      expect(nets(t, mapping), carrier).toEqual([100, 200, 50]);
      expect(verifyMapping(t, mapping).verdict, carrier).toBe('ok');
    }
  });

  it('her satırda tekrarlanan fatura düzeyi "KDV Toplamı": kanıt değil, KDV hariç kalır', () => {
    const t = table(['Takip No', 'KDV Toplamı', 'Toplam'], [
      ['794812345301', '70,00', '100,00'],
      ['794812345302', '70,00', '200,00'],
      ['794812345303', '70,00', '50,00'],
    ]);
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(mapping.amountsIncludeVat).toBe(false);
    expect(nets(t, mapping)).toEqual([100, 200, 50]);
    expect(verifyMapping(t, mapping).verdict).toBe('ok');
  });

  it('yalnız başlıklarla "KDV Tutarı + Toplam Fiyat" KDV dahil sayılmaz (eski dar kural)', () => {
    expect(suggestMapping(['Takip No', 'KDV Tutarı', 'Toplam Fiyat'], 'generic').mapping.amountsIncludeVat).toBe(false);
    // eski kural aynen: tam "Toplam" + tam "KDV"
    expect(suggestMapping(['Takip No', 'KDV', 'Toplam'], 'generic').mapping.amountsIncludeVat).toBe(true);
  });

  it('boş "KDV" + "Toplam": başlık tahmini (KDV dahil) kanıtsız: okuma kontrolü sorar', () => {
    const t = table(['Takip No', 'KDV', 'Toplam'], [
      ['794812345301', '', '120,00'],
      ['794812345302', '', '240,00'],
    ]);
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(mapping.amountsIncludeVat).toBe(true);
    const v = verifyMapping(t, mapping);
    expect(v.verdict).toBe('check');
    expect(v.issues.join('\n')).toContain('tutarın KDV dahil mi hariç mi olduğu "KDV" sütunundan anlaşılamadı');
    // başlık KDV dahil olduğunu açıkça yazıyorsa kanıtsızlık sorulmaz
    const explicit = table(['Takip No', 'KDV', 'Toplam (KDV Dahil)'], t.rows);
    const em = suggestMapping(explicit.headers, 'generic', explicit.rows).mapping;
    expect(em).toMatchObject({ netAmount: 'Toplam (KDV Dahil)', amountsIncludeVat: true });
    expect(verifyMapping(explicit, em).verdict).toBe('ok');
  });

  it('boş KDV hücresi KDV\'siz satır sayılır: karışık, sorulur (300 sessizce 250 olmaz)', () => {
    const rows = [
      ['794812345301', '20,00', '120,00'],
      ['794812345302', '', '300,00'],
      ['794812345303', '10,00', '60,00'],
      ['794812345304', '30,00', '180,00'],
    ];
    for (const total of ['Toplam', 'Toplam Fiyat']) {
      const t = table(['Takip No', 'KDV', total], rows);
      expect(vatEvidence(t, total, 'KDV'), total).toMatchObject({ verdict: 'mixed', pct: 20, zeroRows: 1, rows: 3, agreeing: 3 });
      const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
      const v = verifyMapping(t, mapping);
      expect(v.verdict, total).toBe('check');
      expect(issues(t, mapping), total).toContain('KDV\'li satırlar KDV dahil görünüyor (%20) ama 1 satırda "KDV" boş ya da 0');
    }
  });

  it('"KDV dahil" için tek uymayan satır yeter: 18 satır %20 + 2 satır %10 → sorulur (110 sessizce 91,67 olmaz)', () => {
    const rows = [...Array.from({ length: 18 }, (_, i) => [`7948123453${String(i).padStart(2, '0')}`, '20,00', '120,00']), ['794812345390', '10,00', '110,00'], ['794812345391', '10,00', '110,00']];
    const t = table(['Takip No', 'KDV', 'Toplam'], rows);
    expect(vatEvidence(t, 'Toplam', 'KDV')).toMatchObject({ verdict: 'unclear', rows: 20, agreeing: 18 });
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(verifyMapping(t, mapping).verdict).toBe('check');
    expect(issues(t, mapping)).toContain('anlaşılamadı');
    // "KDV hariç" kararı %90 payını korur (bölme yok, güvenli yön)
    const excl = table(['Takip No', 'KDV', 'Tutar'], [...Array.from({ length: 18 }, (_, i) => [`7948123453${String(i).padStart(2, '0')}`, '20,00', '100,00']), ['794812345390', '5,00', '100,00'], ['794812345391', '5,00', '100,00']]);
    expect(vatEvidence(excl, 'Tutar', 'KDV')).toMatchObject({ verdict: 'excl', pct: 20, rows: 20, agreeing: 18 });
  });

  it('son doğrulama: "KDV hariç" seçiliyken satırların çoğu KDV dahil görünüyorsa sorulur (20 satır %20 + 1 satır %10)', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => {
        const net = 50 + i * 7.25;
        const vat = Math.round(net * 20) / 100;
        return [`7948123453${String(i).padStart(2, '0')}`, (net + vat).toFixed(2).replace('.', ','), vat.toFixed(2).replace('.', ',')];
      }),
      ['794812345399', '110,00', '10,00'],
    ];
    const t = table(['Takip No', 'Tutar', 'KDV'], rows);
    expect(vatEvidence(t, 'Tutar', 'KDV')).toMatchObject({ verdict: 'unclear', pct: 20, rows: 21, agreeing: 20, leansIncl: true });
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(mapping).toMatchObject({ netAmount: 'Tutar', amountsIncludeVat: false });
    expect(checkMappingVat(t, mapping)?.problem).toBe('unclear');
    const v = verifyMapping(t, mapping);
    expect(v.verdict).toBe('check');
    expect(v.issues.join('\n')).toContain('tutarın KDV dahil mi hariç mi olduğu "KDV" sütunundan anlaşılamadı');
    // gümrük vergisi gibi dağınık "Tax": çoğunluk yok, sorulmaz (yukarıdaki "dolu ama tutarsız" durumu)
    const duties = table(['Tracking Number', 'Tax', 'Total Charge'], [
      ['794812345301', '7.40', '100.00'],
      ['794812345302', '31.15', '200.00'],
      ['794812345303', '2.05', '50.00'],
    ]);
    expect(vatEvidence(duties, 'Total Charge', 'Tax').leansIncl).toBeUndefined();
  });

  it('sabit fiyatlı fatura: KDV ve tutar her satırda aynıyken de sınanır (20/120 → KDV dahil)', () => {
    const flat = table(['Takip No', 'KDV', 'Toplam'], [
      ['794812345301', '20,00', '120,00'],
      ['794812345303', '20,00', '120,00'],
      ['794812345304', '20,00', '120,00'],
    ]);
    expect(vatEvidence(flat, 'Toplam', 'KDV')).toMatchObject({ verdict: 'incl', pct: 20 });
    const saved: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip No', netAmount: 'Toplam', amountsIncludeVat: false };
    expect(issues(flat, saved)).toContain('tutarlar KDV dahil görünüyor');
    expect(suggestMapping(flat.headers, 'generic', flat.rows).mapping).toMatchObject({ amountsIncludeVat: true, vatPct: 20 });
  });
});

describe('1.4 dosyanın sayı biçimi kayıtlı/önerilen biçimi ezer', () => {
  it('bağımsız inceleme: ağırlıkların yazımı tutarların biçimini belirlemez (kayıtlı "tr", "0.5" kg, "1.250" tutar → 1250)', () => {
    const t = table(['Takip No', 'Ağırlık', 'Tutar'], [
      ['794800000011', '0.5', '1.250'],
      ['794800000012', '2.5', '300'],
    ]);
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip No', actualKg: 'Ağırlık', netAmount: 'Tutar', numberFormat: 'tr' };
    expect(resolveNumberFormat(t, m)).toEqual({ format: 'tr', source: 'hint' });
    expect(nets(t, m)).toEqual([1250, 300]);
    expect(mappingDiagnostics(t, m).numberFormatSource).toBe('hint');
    // ipucu yoksa eskisi gibi bütün sayı sütunlarından
    expect(resolveNumberFormat(t, { ...m, numberFormat: undefined })).toEqual({ format: 'en', source: 'detected' });
  });

  const trTable = () =>
    table(['Takip No', 'Tutar'], [
      ['794800000011', '2.010,00'],
      ['794800000012', '150,50'],
    ]);

  it('hatırlanan "en" Türkçe dosyada "2.010,00"ı 2,01 okumaz', () => {
    const t = trTable();
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip No', netAmount: 'Tutar', numberFormat: 'en' };
    expect(resolveNumberFormat(t, m)).toEqual({ format: 'tr', source: 'detected' });
    expect(nets(t, m)).toEqual([2010, 150.5]);
    const d = mappingDiagnostics(t, m);
    expect(d).toMatchObject({ numberFormat: 'tr', numberFormatSource: 'detected', netTotal: 2160.5 });
    expect(d.verification.verdict).toBe('ok');
  });

  it('İngilizce dosyada hatırlanan "tr" de ezilir', () => {
    const t = table(['Tracking ID', 'Net Charge'], [
      ['794800000011', '2,010.00'],
      ['794800000012', '150.50'],
    ]);
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Tracking ID', netAmount: 'Net Charge', numberFormat: 'tr' };
    expect(nets(t, m)).toEqual([2010, 150.5]);
    expect(mappingDiagnostics(t, m)).toMatchObject({ numberFormat: 'en', numberFormatSource: 'detected' });
  });

  it('dosyada kanıt yoksa ipucu kullanılır', () => {
    const t = table(['Takip No', 'Tutar'], [
      ['794800000011', '1.500'],
      ['794800000012', '250'],
    ]);
    const base: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip No', netAmount: 'Tutar' };
    expect(resolveNumberFormat(t, { ...base, numberFormat: 'en' })).toEqual({ format: 'en', source: 'hint' });
    expect(nets(t, { ...base, numberFormat: 'en' })).toEqual([1.5, 250]);
    expect(nets(t, { ...base, numberFormat: 'tr' })).toEqual([1500, 250]);
    expect(mappingDiagnostics(t, { ...base, numberFormat: 'en' }).numberFormatSource).toBe('hint');
    expect(resolveNumberFormat(t, base)).toEqual({ format: 'auto', source: 'detected' });
  });

  it('yapay zekânın "en" önerisi Türkçe dosyanın kanıtını ezmez', () => {
    const t = trTable();
    const base: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip No', netAmount: 'Tutar' };
    const merged = mergeAiMapping(t, base, sourcesFor(base, 'preset'), { mapping: { ...base, numberFormat: 'en' }, confidence: { trackingNo: 0.9, netAmount: 0.9 } });
    expect(merged.mapping.numberFormat).toBe('en');
    expect(nets(t, merged.mapping)).toEqual([2010, 150.5]);
    expect(merged.verification.verdict).toBe('ok');
  });

  it('K36 değişmedi: kanıtsız dosyada ipucu "1.500" ağırlık sorusunu cevaplamaz, seçim yalnız ağırlığa uygulanır', () => {
    const t = table(['Takip No', 'Ağırlık', 'Tutar'], [
      ['794800000011', '1.500', '1.250'],
      ['794800000012', '2', '300'],
    ]);
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip No', actualKg: 'Ağırlık', netAmount: 'Tutar', numberFormat: 'en' };
    expect(tableWeightAmbiguity(t, m)).toMatchObject({ sample: '1.500', rows: 1, decimal: 1.5, thousands: 1500 });
    expect(verifyMapping(t, m).issues.join('\n')).toContain('Ağırlık yazımı belli değil');
    const picked = parseRows(t, { ...m, weightFormat: 'tr' }).lines;
    expect(picked.map((l) => [l.actualKg, l.netAmount])).toEqual([
      [1500, 1.25],
      [2, 300],
    ]);
    // kanıtlı dosyada soru yok, ağırlık dosyanın biçimiyle
    const evident = table(['Takip No', 'Ağırlık', 'Tutar'], [['794800000011', '1.500', '1.250,00']]);
    expect(tableWeightAmbiguity(evident, m)).toBeNull();
    expect(parseRows(evident, m).lines[0]).toMatchObject({ actualKg: 1500, netAmount: 1250 });
  });
});

describe('1.5 MNG kalıbı "Navlun"u net tutar seçmez', () => {
  // navlun + yakıt = KDV hariç; KDV %20; Genel Toplam KDV dahil
  const rows = [
    ['571088001201', '22.10.2026', '10', '100,00', '12,50', '22,50', '135,00'],
    ['571088001212', '22.10.2026', '7', '141,30', '17,66', '31,79', '190,75'],
    ['571088001223', '23.10.2026', '3', '78,55', '9,82', '17,67', '106,04'],
  ];

  it('"Navlun; Yakıt; KDV; Genel Toplam": net = Genel Toplam (KDV dahil, %20), navlun ve yakıt bileşen', () => {
    const t = table(['Gönderi No', 'Tarih', 'Desi', 'Navlun', 'Yakıt', 'KDV', 'Genel Toplam'], rows);
    const { mapping, missing } = suggestMapping(t.headers, 'mng', t.rows);
    expect(missing).toEqual([]);
    expect(mapping).toMatchObject({ netAmount: 'Genel Toplam', baseAmount: 'Navlun', fuelAmount: 'Yakıt', amountsIncludeVat: true, vatPct: 20 });
    const p = parseRows(t, mapping);
    expect(p.lines.map((l) => [l.netAmount, l.baseAmount, l.fuelAmount])).toEqual([
      [112.5, 100, 12.5],
      [158.96, 141.3, 17.66],
      [88.37, 78.55, 9.82],
    ]);
    expect(p.componentsVat).toMatchObject({ value: false, source: 'data' });
    const v = verifyMapping(t, mapping);
    expect(v.checks.charges).toEqual({ rowsChecked: 3, rowsMatching: 3 });
    expect(v.verdict).toBe('ok');
  });

  it('Aras "Navlun Tutarı; Yakıt; KDV; Toplam": net = Toplam', () => {
    const t = table(['Kargo Takip No', 'Desi', 'Navlun Tutarı', 'Yakıt', 'KDV', 'Toplam'], rows.map((r) => [r[0]!, ...r.slice(2)]));
    const { mapping } = suggestMapping(t.headers, 'aras', t.rows);
    expect(mapping).toMatchObject({ netAmount: 'Toplam', baseAmount: 'Navlun Tutarı', fuelAmount: 'Yakıt', amountsIncludeVat: true });
  });

  it('tek tutar sütunu navlunsa net odur (yakıt, indirim, ek ücret yok)', () => {
    const t = table(['Gönderi No', 'Desi', 'Navlun'], [
      ['571088001201', '10', '141,30'],
      ['571088001212', '7', '128,45'],
    ]);
    for (const carrier of ['mng', 'aras', 'generic'] as const) {
      const { mapping, missing } = suggestMapping(t.headers, carrier, t.rows);
      expect(missing, carrier).toEqual([]);
      expect(mapping.netAmount, carrier).toBe('Navlun');
      expect(mapping.baseAmount, carrier).toBeUndefined();
    }
  });

  it('bağımsız inceleme: tanınmayan başka tutar sütunu varsa ("Hizmet Bedeli") navlun net sayılmaz, net seçilmeyi bekler', () => {
    const t = table(['Gönderi No', 'Desi', 'Navlun', 'Hizmet Bedeli'], [
      ['571088001201', '10', '100,00', '12,00'],
      ['571088001212', '7', '120,00', '8,50'],
    ]);
    const { mapping, missing } = suggestMapping(t.headers, 'mng', t.rows);
    expect(missing).toEqual(['netAmount']);
    expect(mapping.baseAmount).toBe('Navlun');
    // "KDV Tutarı" ek tutar sütunu sayılmaz
    const vat = table(['Gönderi No', 'Navlun', 'KDV Tutarı'], [['571088001201', '100,00', '20,00']]);
    expect(suggestMapping(vat.headers, 'mng', vat.rows).mapping.netAmount).toBe('Navlun');
  });

  it('"Tutar" varken navlun bileşen kalır', () => {
    const { mapping } = suggestMapping(['Gönderi No', 'Navlun', 'Yakıt', 'Tutar', 'KDV', 'Toplam'], 'mng');
    expect(mapping).toMatchObject({ netAmount: 'Tutar', baseAmount: 'Navlun', fuelAmount: 'Yakıt', amountsIncludeVat: false });
  });
});

describe('1.6 çok sayfalı Excel: okunmayan sayfa söylenir', () => {
  const headers = ['Takip No', 'Tarih', 'Desi', 'Tutar'];
  const row = (i: number) => [`79480000${String(1000 + i)}`, '05.11.2026', '3', '100,00'];

  async function book(build: (wb: ExcelJS.Workbook) => void): Promise<Table> {
    const wb = new ExcelJS.Workbook();
    build(wb);
    return readTable('fatura.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
  }

  it('"Yurtiçi" (6 satır) + "Yurtdışı" (4 satır): çok satırlı sayfa okunur, öbürü okuma kontrolünde onay ister', async () => {
    const t = await book((wb) => {
      const a = wb.addWorksheet('Yurtiçi');
      a.addRow(headers);
      for (let i = 0; i < 6; i++) a.addRow(row(i));
      const b = wb.addWorksheet('Yurtdışı');
      b.addRow(headers);
      for (let i = 10; i < 14; i++) b.addRow(row(i));
    });
    expect(t.rows).toHaveLength(6);
    expect(t.sheets).toMatchObject({ read: 'Yurtiçi', unread: [{ name: 'Yurtdışı', rows: 4, headers }] });
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    const v = verifyMapping(t, mapping);
    expect(v.verdict).toBe('check');
    expect(v.issues).toContain(
      'Okunmayan sayfada gönderi satırı var: "Yurtdışı" (4 satır). Yalnız "Yurtiçi" sayfası okundu; öbür sayfadaki satırlar bu faturaya girmez. O sayfayı ayrı bir Excel dosyası olarak kaydedip ayrıca yükleyin.',
    );
    expect(verifyMapping(t, mapping, { locale: 'en' }).issues).toContain(
      'A sheet that was not read has shipment rows: "Yurtdışı" (4 rows). Only the sheet "Yurtiçi" was read; rows on the other sheet are not included in this invoice. Save that sheet as a separate Excel file and upload it too.',
    );
    expect(mappingDiagnostics(t, mapping).sheets).toEqual({ read: 'Yurtiçi', unread: [{ name: 'Yurtdışı', rows: 4, invoiceLike: true }] });
  });

  it('farklı düzenli "Ek Hizmetler" sayfası da gönderi satırı sayılır (takip no + tutar bulunuyor)', async () => {
    const t = await book((wb) => {
      const a = wb.addWorksheet('Gönderiler');
      a.addRow(headers);
      for (let i = 0; i < 5; i++) a.addRow(row(i));
      const b = wb.addWorksheet('Ek Hizmetler');
      b.addRow(['Gönderi No', 'Hizmet', 'Ücret']);
      b.addRow(['794800002001', 'Adres düzeltme', '25,00']);
      b.addRow(['794800002002', 'Kapıda ödeme', '15,00']);
    });
    expect(unreadSheetsOf(t, { trackingNo: 'Takip No' })).toEqual([{ name: 'Ek Hizmetler', rows: 2, invoiceLike: true }]);
    expect(verifyMapping(t, suggestMapping(t.headers, 'generic', t.rows).mapping).issues.join('\n')).toContain('"Ek Hizmetler" (2 satır)');
  });

  it('bağımsız inceleme: iki sütunlu "Ek Ücretler" (Takip No | Tutar) sayfası da gönderi satırı sayılır', async () => {
    const t = await book((wb) => {
      const a = wb.addWorksheet('Gönderiler');
      a.addRow(headers);
      for (let i = 0; i < 5; i++) a.addRow(row(i));
      const b = wb.addWorksheet('Ek Ücretler');
      b.addRow(['Takip No', 'Tutar']);
      b.addRow(['794800003001', '25,00']);
      b.addRow(['794800003002', '15,00']);
    });
    expect(t.sheets?.unread).toMatchObject([{ name: 'Ek Ücretler', rows: 2 }]);
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(unreadSheetsOf(t, mapping)).toEqual([{ name: 'Ek Ücretler', rows: 2, invoiceLike: true }]);
    // aynı düzen olmasa da genel kalıp takip no + tutar buluyor
    expect(unreadSheetsOf(t, { trackingNo: 'Başka Sütun' })).toEqual([{ name: 'Ek Ücretler', rows: 2, invoiceLike: true }]);
    expect(verifyMapping(t, mapping).issues.join('\n')).toContain('"Ek Ücretler" (2 satır)');
  });

  it('"Özet" ve "Notlar" sayfaları yalnız bilgi: okuma kontrolü onay istemez', async () => {
    const t = await readTable('x.xlsx', new Uint8Array(readFileSync(resolve(here, 'fixtures/robustness/xlsx-multi-sheet.xlsx'))));
    expect(t.sheets?.read).toBe('Gönderi Detayı');
    const { mapping } = suggestMapping(t.headers, 'fedex', t.rows);
    const d = mappingDiagnostics(t, mapping);
    expect(d.sheets).toEqual({ read: 'Gönderi Detayı', unread: [expect.objectContaining({ name: 'Özet', invoiceLike: false }), expect.objectContaining({ name: 'Notlar', invoiceLike: false })] });
    expect(d.verification.issues.join('\n')).not.toContain('Okunmayan sayfa');
  });

  it('tek sayfa, boş sayfa ve gizli sayfa söylenmez', async () => {
    const t = await book((wb) => {
      wb.addWorksheet('Boş');
      const hidden = wb.addWorksheet('Ham');
      hidden.state = 'hidden';
      hidden.addRow(headers);
      hidden.addRow(row(50));
      const a = wb.addWorksheet('Fatura');
      a.addRow(headers);
      a.addRow(row(1));
    });
    expect(t.sheets).toBeUndefined();
    expect(mappingDiagnostics(t, suggestMapping(t.headers, 'generic', t.rows).mapping).sheets).toBeUndefined();
  });
});

describe('1.13 Excel\'in bilimsel yazıma çevirdiği takip no', () => {
  it('tanıma', () => {
    for (const v of ['1,23457E+11', '7.94612E+11', '1E+11', '1,2E+15', ' 7,94612E+11 ']) expect(isScientificTracking(v), v).toBe(true);
    for (const v of ['794812345305', 'JD014600040000DE', '1Z9X4A710341007731', '3E12345', '1.23457E11', '']) expect(isScientificTracking(v), v).toBe(false);
  });

  it('CSV: açık ileti ne yapılacağını söyler; satır sayısı ve örnek', async () => {
    const csv = 'Takip No;Tarih;Tutar\n1,23457E+11;05.11.2026;100,00\n7,94612E+11;05.11.2026;50,00\n794800000011;05.11.2026;20,00\n';
    const t = await readTable('fatura.csv', new TextEncoder().encode(csv));
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(scientificTrackingRows(t, mapping)).toEqual({ count: 2, sample: '1,23457E+11' });
    const v = verifyMapping(t, mapping);
    expect(v.verdict).toBe('check');
    expect(v.issues).toContain(
      'Takip no Excel\'de bozulmuş: 2 satırda bilimsel yazıma dönmüş (ör. "1,23457E+11") ve haneleri kaybolmuş; bu satırlar hiçbir ölçümle eşleşmez. Dosyayı taşıyıcının sitesinden yeniden indirip Excel\'de açıp kaydetmeden yükleyin. Excel\'de açmanız gerekirse Veri > Metinden/CSV\'den ile açın ve takip no sütununu "Metin" seçin.',
    );
    expect(verifyMapping(t, mapping, { locale: 'en' }).issues.join('\n')).toContain('Tracking numbers were damaged by Excel: on 2 rows they turned into scientific notation (e.g. "1,23457E+11")');
    expect(scientificTrackingRows(table(['Takip No'], [['794800000011']]), { trackingNo: 'Takip No' })).toBeNull();
  });
});
