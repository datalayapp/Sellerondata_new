/**
 * Fatura okuma dayanıklılık fikstürleri (uydurma veriler).
 *
 * Sütun adları taşıyıcıların herkese açık dışa aktarım düzenlerinden esinlenmiştir:
 * - FedEx Billing Online "Download" dosyası: tüm değerler tırnaklı, tarihler YYYYMMDD,
 *   "Express or Ground Tracking ID", "Actual/Rated Weight Amount" + "... Units", "Tracking ID Charge Description/Amount" çiftleri.
 * - UPS Billing Data: "Tracking Number", "Entered/Billed Weight" + "... Unit of Measure", "Package Dimensions", "Incentive Amount", "Net Amount".
 * - DHL MyBill: "Shipment Number", "Shipment Date" (YYYYMMDD), "Weight (kg)", "Total amount (excl. VAT)".
 * - Türk taşıyıcıların Excel raporları: "Gönderi No", "Tarih", "Desi", "Tutar", "KDV", "Toplam", üstte başlık satırları, altta TOPLAM.
 * Sayılar, takip numaraları, adlar ve adresler uydurmadır. Yeniden üretmek: `npx tsx test/fixtures/robustness/generate.ts` (packages/core içinde).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = resolve(here, '../../../../../samples/invoices');
export const FIXTURE_DIR = here;

// ---------------------------------------------------------------- ortak uydurma veri

export type Row = {
  tracking: string;
  /** YYYY-MM-DD */
  date: string;
  country: string;
  actualKg: number;
  billedKg: number;
  dims: [number, number, number];
  base: number;
  discount: number;
  fuel: number;
  net: number;
  currency: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
function row(tracking: string, date: string, country: string, actualKg: number, billedKg: number, dims: [number, number, number], base: number, discount: number, fuel: number, currency = 'TRY'): Row {
  return { tracking, date, country, actualKg, billedKg, dims, base, discount, fuel, net: r2(base - discount + fuel), currency };
}

/** 5 satır: biri ≥ 10.000, biri < 100; tarihlerin ikisinde gün > 12 (ABD sırası tespit edilebilsin). */
export const ROWS: Row[] = [
  row('794800000011', '2026-11-05', 'DE', 4.0, 6.0, [40, 30, 25], 1527.75, 580.55, 236.8),
  row('794800000022', '2026-11-03', 'FR', 12.5, 12.5, [50, 40, 30], 1650.4, 627.15, 211.31),
  row('794800000033', '2026-10-28', 'NL', 2.0, 2.5, [30, 25, 20], 1108.2, 421.12, 300.57),
  row('794800000044', '2026-10-13', 'US', 28.0, 30.0, [80, 60, 50], 15420.0, 5859.6, 2785.27),
  row('794800000055', '2026-11-12', 'GB', 0.5, 0.5, [20, 15, 5], 61.9, 23.52, 6.72),
];

const pad2 = (n: number) => String(n).padStart(2, '0');
const parts = (iso: string) => iso.split('-').map(Number) as [number, number, number];
export const dmy = (iso: string) => {
  const [y, m, d] = parts(iso);
  return `${pad2(d)}.${pad2(m)}.${y}`;
};
export const mdy = (iso: string) => {
  const [y, m, d] = parts(iso);
  return `${pad2(m)}/${pad2(d)}/${y}`;
};
export const ymd8 = (iso: string) => iso.replace(/-/g, '');
/** Excel 1900 seri tarihi. */
export const excelSerial = (iso: string) => Math.round((Date.UTC(...(parts(iso).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number])) / 86400000) + 25569);

/** 1234.5 → "1.234,50" */
export function trNum(n: number, decimals = 2): string {
  const neg = n < 0;
  const [i, f] = Math.abs(n).toFixed(decimals).split('.');
  return (neg ? '-' : '') + i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (decimals ? ',' + f : '');
}
/** 1234.5 → "1,234.50" */
export function enNum(n: number, decimals = 2): string {
  const neg = n < 0;
  const [i, f] = Math.abs(n).toFixed(decimals).split('.');
  return (neg ? '-' : '') + i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decimals ? '.' + f : '');
}

// ---------------------------------------------------------------- kodlamalar

/** Windows-1252 / 1254 kodlayıcı (yalnız fikstürlerde geçen karakterler; bilinmeyen karakter hata verir). */
const CP_EXTRA: Record<'1252' | '1254', Record<string, number>> = {
  '1252': { '€': 0x80, '’': 0x92 },
  '1254': { '€': 0x80, '’': 0x92, Ğ: 0xd0, İ: 0xdd, Ş: 0xde, ğ: 0xf0, ı: 0xfd, ş: 0xfe },
};
const CP_FORBIDDEN: Record<'1252' | '1254', Set<number>> = {
  '1252': new Set(),
  '1254': new Set([0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe]),
};
export function encodeCp(text: string, cp: '1252' | '1254'): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const extra = CP_EXTRA[cp][ch];
    if (extra != null) out.push(extra);
    else {
      const c = ch.codePointAt(0)!;
      if (c < 0x80 || (c >= 0xa0 && c <= 0xff && !CP_FORBIDDEN[cp].has(c))) out.push(c);
      else throw new Error(`cp${cp} ile kodlanamaz: ${ch}`);
    }
  }
  return Uint8Array.from(out);
}
const utf8 = (s: string) => new TextEncoder().encode(s);
const BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
function concat(...a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}
function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

// ---------------------------------------------------------------- CSV yardımcıları

function csvCell(v: string, delim: string, quoteAll: boolean): string {
  if (quoteAll || v.includes(delim) || v.includes('"') || /[\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
function csv(rows: string[][], delim = ',', opts: { quoteAll?: boolean; eol?: string } = {}): string {
  return rows.map((r) => r.map((c) => csvCell(c, delim, !!opts.quoteAll)).join(delim)).join(opts.eol ?? '\r\n') + (opts.eol ?? '\r\n');
}

// ---------------------------------------------------------------- metin fikstürleri

/** Türkçe başlıklı ortak tablo (`;`, TR sayı/tarih). */
export const TR_HEADERS = ['Gönderi No', 'Gönderi Tarihi', 'Alıcı Adı', 'Varış Ülkesi', 'Ağırlık', 'Ücretli Ağırlık', 'Ölçü', 'Navlun', 'İndirim', 'Yakıt', 'Tutar', 'Para Birimi'];
export const TR_NAMES = ['Şükrü Işıkoğlu', 'İpek Ağaçlı', 'Ilgaz Öztaş', 'Çağrı Güneş', 'Gülşen İnce'];
function trRows(fmt: (n: number) => string = trNum): string[][] {
  return ROWS.map((r, i) => [r.tracking, dmy(r.date), TR_NAMES[i]!, r.country, trNum(r.actualKg, 1), trNum(r.billedKg, 1), r.dims.join('x'), fmt(r.base), fmt(r.discount), fmt(r.fuel), fmt(r.net), r.currency]);
}

/** FedEx Billing Online tarzı: virgül, her değer tırnaklı, YYYYMMDD, EN sayılar, adreste virgül + satır sonu + "" kaçışı. */
function fedexFboQuoted(): Uint8Array {
  const headers = [
    'Bill to Account Number', 'Invoice Date', 'Invoice Number', 'Express or Ground Tracking ID', 'Shipment Date', 'Service Type',
    'Recipient Name', 'Recipient Company', 'Recipient Address Line 1', 'Recipient Country/Territory',
    'Actual Weight Amount', 'Actual Weight Units', 'Rated Weight Amount', 'Rated Weight Units',
    'Dim Length', 'Dim Width', 'Dim Height', 'Dim Unit', 'Dim Divisor',
    'Transportation Charge Amount', 'Net Charge Amount', 'Currency',
    'Tracking ID Charge Description', 'Tracking ID Charge Amount', 'Tracking ID Charge Description', 'Tracking ID Charge Amount',
  ];
  const companies = ['Atelier "Lumière", Paris', 'Muster GmbH', 'Van Dijk & Zn', 'Acme, Inc.', 'Example Ltd'];
  const body = ROWS.map((r, i) => [
    '000000000', '20261106', '9-000-00001', r.tracking, ymd8(r.date), 'International Economy',
    `Alıcı ${i + 1}`, companies[i]!, `Örnek Sokak ${i + 1},\nKat ${i + 2}`, r.country,
    enNum(r.actualKg, 1), 'K', enNum(r.billedKg, 1), 'K',
    String(r.dims[0]), String(r.dims[1]), String(r.dims[2]), 'C', '5000',
    enNum(r.base), enNum(r.net), r.currency,
    'Discount', enNum(-r.discount), 'Fuel Surcharge', enNum(r.fuel),
  ]);
  return utf8(csv([headers, ...body], ',', { quoteAll: true }));
}

/** Excel'in "sep=;" ipucu satırı + BOM + `;` + TR sayılar. */
function semicolonSepHint(): Uint8Array {
  return concat(BOM, utf8('sep=;\r\n' + csv([TR_HEADERS, ...trRows()], ';')));
}

/** Excel "Unicode Metin" kaydı: UTF-16LE BOM'lu, sekme ayırıcılı. */
function tabUtf16(): Uint8Array {
  return utf16le(csv([TR_HEADERS, ...trRows()], '\t'));
}

/** Sekme ayırıcı, UTF-8 (BOM'suz), sekme dışında virgül de içeren hücreler. */
function tabUtf8(): Uint8Array {
  return utf8(csv([TR_HEADERS, ...trRows()], '\t'));
}

function utf8Turkish(withBom: boolean): Uint8Array {
  const text = csv([TR_HEADERS, ...trRows()], ';');
  return withBom ? concat(BOM, utf8(text)) : utf8(text);
}

/** MNG örnek faturası (samples/) Windows-1254 ile, tutarlar "TL" ekli. Karşılaştırma sonucu samples/expected.json ile aynı olmalı. */
export function mngCp1254Text(): string {
  const src = readFileSync(resolve(SAMPLES_DIR, 'mng-MNG-2026-77120.csv'), 'utf8').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/).filter((l) => l !== '');
  const head = lines[0]!.split(';');
  const moneyCols = ['Tutar', 'Kapıda Ödeme', 'Adres Düzeltme', 'KDV', 'Toplam'].map((h) => head.indexOf(h));
  const out = lines.map((l, i) => {
    if (i === 0) return l;
    const cells = l.split(';');
    for (const c of moneyCols) if (cells[c]) cells[c] = `${cells[c]} TL`;
    return cells.join(';');
  });
  return out.join('\r\n') + '\r\n';
}
function mngCp1254(): Uint8Array {
  return encodeCp(mngCp1254Text(), '1254');
}

/** Windows-1254, `;`, Türkçe başlık ve adlar (ş ğ ı İ), "TL" ekli tutarlar. */
function turkishCp1254(): Uint8Array {
  return encodeCp(csv([TR_HEADERS, ...trRows((n) => `${trNum(n)} TL`)], ';'), '1254');
}

/** Windows-1252 (Almanca başlıklar, € simgesi 0x80). */
function germanCp1252(): Uint8Array {
  const headers = ['Sendungsnummer', 'Versanddatum', 'Empfängerland', 'Gewicht (kg)', 'Größe', 'Betrag (€)', 'Währung'];
  const body = ROWS.map((r) => [r.tracking, dmy(r.date), r.country, trNum(r.actualKg, 1), r.dims.join('x'), `€ ${trNum(r.net)}`, 'EUR']);
  return encodeCp(csv([headers, ...body], ';'), '1252');
}

/** Para simgeli TR tutarlar: "₺1.234,56", "1.234,56 TL", "1.234,56 ₺", "TRY 1.234,56", "-₺12,00". */
function moneySymbolsTr(): Uint8Array {
  const fmts = [(n: number) => `₺${trNum(n)}`, (n: number) => `${trNum(n)} TL`, (n: number) => `${trNum(n)} ₺`, (n: number) => `TRY ${trNum(n)}`, (n: number) => `₺ ${trNum(n)}`];
  const headers = ['Takip No', 'Tarih', 'Desi', 'Tutar'];
  const body = ROWS.map((r, i) => [r.tracking, dmy(r.date), trNum(r.billedKg, 1), fmts[i]!(r.net)]);
  body.push(['794800000066', dmy('2026-11-04'), '1,0', '-₺12,00']);
  return concat(BOM, utf8(csv([headers, ...body], ';')));
}

/** Para simgeli EN tutarlar: "$1,234.56", "1,234.56 USD", "USD 1,234.56", "(12.00)". */
function moneySymbolsEn(): Uint8Array {
  const fmts = [(n: number) => `$${enNum(n)}`, (n: number) => `${enNum(n)} USD`, (n: number) => `USD ${enNum(n)}`, (n: number) => `$ ${enNum(n)}`, (n: number) => enNum(n)];
  const headers = ['Tracking Number', 'Shipment Date', 'Billed Weight', 'Net Amount', 'Currency'];
  const body = ROWS.map((r, i) => [r.tracking, r.date, enNum(r.billedKg, 1), fmts[i]!(r.net), 'USD']);
  body.push(['794800000066', '2026-11-04', '1.0', '(12.00)', 'USD']);
  return utf8(csv([headers, ...body], ','));
}

/** Tarih biçimleri: her dosya tek biçim. */
function dates(kind: 'dmy' | 'iso' | 'mdy' | 'serial' | 'ymd8'): Uint8Array {
  const f = { dmy, iso: (s: string) => s, mdy, serial: (s: string) => String(excelSerial(s)), ymd8 }[kind];
  const headers = ['Tracking Number', 'Shipment Date', 'Net Amount'];
  return utf8(csv([headers, ...ROWS.map((r) => [r.tracking, f(r.date), r.net.toFixed(2)])], ','));
}

/** CSV'de Excel metin sarmalayıcısı ="..." (baştaki sıfırlar korunsun diye) ve başında boşluk. */
function excelTextWrapped(): Uint8Array {
  // Gerçek dışa aktarımlardaki gibi ham yazılır (tırnak kaçışı yok).
  const text = ['Gönderi No;Tarih;Desi;Tutar', '="0012345678901";05.11.2026;3;125,40', '="0012345678902";05.11.2026;5;180,00', '  0012345678903 ;06.11.2026;2;99,90'].join('\r\n') + '\r\n';
  return concat(BOM, utf8(text));
}

/** Mükerrer takip no: aynı takip no iki kez, referansı farklı. */
function duplicates(): Uint8Array {
  const headers = ['Tracking Number', 'Shipment Date', 'Net Amount', 'Reference'];
  const body = [
    ['794800000011', '2026-11-05', '1184.00', 'SIP-1'],
    ['794800000022', '2026-11-03', '1234.56', 'SIP-2'],
    ['794800000011', '2026-11-05', '1184.00', 'SIP-1-R'],
  ];
  return utf8(csv([headers, ...body]));
}

/** Zorunlu sütun eksik: tutar sütunu yok. */
function missingAmount(): Uint8Array {
  const headers = ['Tracking Number', 'Shipment Date', 'Billed Weight'];
  return utf8(csv([headers, ...ROWS.map((r) => [r.tracking, r.date, r.billedKg.toFixed(1)])]));
}

/** İade/düzeltme satırları: "-125,00", "(80,00)", "45,00-". */
function refunds(): Uint8Array {
  const headers = ['Gönderi No', 'Tarih', 'Açıklama', 'Desi', 'Tutar'];
  const body = [
    ['571000000001', '05.11.2026', 'Gönderi', '4', '210,50'],
    ['571000000002', '05.11.2026', 'Gönderi', '6', '1.250,00'],
    ['571000000001', '06.11.2026', 'İade (fiyat düzeltme)', '', '-125,00'],
    ['571000000003', '06.11.2026', 'Kredi notu', '', '(80,00)'],
    ['571000000004', '07.11.2026', 'Düzeltme', '', '45,00-'],
    ['', '', 'TOPLAM', '', '1.210,50'],
  ];
  return concat(BOM, utf8(csv([headers, ...body], ';')));
}

/** Farklı para birimleri tek dosyada (sütun + simge). */
function multiCurrency(): Uint8Array {
  const headers = ['Waybill Number', 'Shipment Date', 'Destination Country', 'Weight (kg)', 'Currency', 'Total amount (excl. VAT)'];
  const body = [
    ['4821900001', '20261105', 'DE', '2.5', 'EUR', '84.30'],
    ['4821900002', '20261105', 'US', '4.0', 'USD', '1,120.75'],
    ['4821900003', '20261106', 'TR', '1.0', 'TRY', '1,450.00'],
    ['4821900004', '20261106', 'GB', '3.5', 'GBP', '96.10'],
  ];
  return utf8(csv([headers, ...body], ','));
}

// ---------------------------------------------------------------- XLSX fikstürleri

const FIXED_DATE = new Date(Date.UTC(2026, 10, 5));
function workbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DeciShip fixtures';
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;
  return wb;
}
async function xlsxBytes(wb: ExcelJS.Workbook): Promise<Uint8Array> {
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** samples/ FedEx 9-482-11735 faturasının sütunları ve satırları (sayısal hücreler için sayıya çevrilir). */
export function fedex11735(): { headers: string[]; rows: string[][] } {
  const src = readFileSync(resolve(SAMPLES_DIR, 'fedex-9-482-11735.csv'), 'utf8').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/).filter((l) => l !== '');
  return { headers: lines[0]!.split(','), rows: lines.slice(1).map((l) => l.split(',')) };
}
const NUMERIC = /^-?\d+(\.\d+)?$/;
const asCell = (v: string): string | number => (NUMERIC.test(v) && !/^\d{9,}$/.test(v) ? Number(v) : v);

/**
 * Çok sayfalı: 1. sayfa "Özet" (kısa özet), 2. sayfa "Gönderi Detayı": birleştirilmiş başlık satırı (logo yeri),
 * fatura bilgi satırları, boş satır, başlık, FedEx 11735 satırları, alt toplam satırı. 3. sayfa "Notlar" (metin).
 */
async function multiSheet(): Promise<Uint8Array> {
  const { headers, rows } = fedex11735();
  const wb = workbook();
  const sum = wb.addWorksheet('Özet');
  sum.addRow(['FATURA ÖZETİ']);
  sum.addRow(['Fatura No', '9-482-11735']);
  sum.addRow(['Fatura Tarihi', new Date(Date.UTC(2026, 9, 27))]);
  sum.addRow(['Gönderi sayısı', rows.length]);
  sum.addRow(['Ödenecek Tutar', 28501.33]);
  const ws = wb.addWorksheet('Gönderi Detayı');
  ws.addRow(['FEDEX EXPRESS — GÖNDERİ DETAYI']);
  ws.mergeCells(1, 1, 1, headers.length);
  ws.addRow(['Fatura No: 9-482-11735', '', '', 'Hesap: 000000000']);
  ws.addRow([]);
  ws.addRow(headers);
  const net = headers.indexOf('Net Charge Amount');
  let total = 0;
  for (const r of rows) {
    ws.addRow(r.map(asCell));
    total += Number(r[net]);
  }
  const footer: (string | number)[] = headers.map(() => '');
  footer[0] = 'TOPLAM';
  footer[net] = Math.round(total * 100) / 100;
  ws.addRow(footer);
  const notes = wb.addWorksheet('Notlar');
  notes.addRow(['Bu fatura uydurma örnektir.']);
  return xlsxBytes(wb);
}

/** İki katlı birleştirilmiş başlık: "Ağırlık" (Gerçek/Ücretli), "Ölçü (cm)" (En/Boy/Yükseklik); diğerleri dikey birleşik. */
async function mergedHeader(): Promise<Uint8Array> {
  const wb = workbook();
  const ws = wb.addWorksheet('Rapor');
  ws.addRow(['ÖRNEK KARGO A.Ş.']);
  ws.mergeCells('A1:I1');
  ws.addRow(['Gönderi Raporu — Kasım 2026']);
  ws.mergeCells('A2:I2');
  ws.addRow(['Gönderi No', 'Tarih', 'Ağırlık', '', 'Ölçü (cm)', '', '', 'Desi', 'Tutar']);
  ws.addRow(['', '', 'Gerçek', 'Ücretli', 'En', 'Boy', 'Yükseklik', '', '']);
  for (const c of ['A', 'B', 'H', 'I']) ws.mergeCells(`${c}3:${c}4`);
  ws.mergeCells('C3:D3');
  ws.mergeCells('E3:G3');
  for (const r of ROWS) {
    const p = parts(r.date);
    ws.addRow([r.tracking, new Date(Date.UTC(p[0], p[1] - 1, p[2])), r.actualKg, r.billedKg, ...r.dims, r.billedKg, r.net]);
  }
  ws.addRow(['Genel Toplam', '', '', '', '', '', '', '', r2(ROWS.reduce((a, r) => a + r.net, 0))]);
  return xlsxBytes(wb);
}

/** Sayısal seri tarihler (tarih biçimi yok), metin TR tutarlar, sayı olarak takip no. */
async function serialDates(): Promise<Uint8Array> {
  const wb = workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Takip No', 'Gönderi Tarihi', 'Kg', 'Tutar']);
  for (const r of ROWS) ws.addRow([Number(r.tracking), excelSerial(r.date), r.actualKg, trNum(r.net)]);
  return xlsxBytes(wb);
}

async function headerOnlyXlsx(): Promise<Uint8Array> {
  const wb = workbook();
  wb.addWorksheet('Sayfa1').addRow(['Takip No', 'Tarih', 'Tutar']);
  return xlsxBytes(wb);
}

async function emptyXlsx(): Promise<Uint8Array> {
  const wb = workbook();
  wb.addWorksheet('Sayfa1');
  return xlsxBytes(wb);
}

// ---------------------------------------------------------------- büyük dosyalar

/** n satırlık FedEx tarzı CSV (UTF-8, `,`, nokta ondalık). İsteğe bağlı olarak başa FedEx 11735 satırları eklenir. */
export function bigCsv(n: number, opts: { prefixFedex11735?: boolean } = {}): Uint8Array {
  const headers = ['Tracking ID', 'Shipment Date', 'Service Type', 'Recipient Name', 'Recipient Country/Territory', 'Actual Weight', 'Rated Weight', 'Dim Length', 'Dim Width', 'Dim Height', 'Transportation Charge Amount', 'Discount', 'Fuel Surcharge', 'Address Correction', 'Remote Area Surcharge', 'Additional Handling', 'Net Charge Amount', 'Currency', 'Customer Reference'];
  const lines: string[] = [headers.join(',')];
  if (opts.prefixFedex11735) {
    const f = fedex11735();
    const pick = headers.map((h) => f.headers.indexOf(h));
    for (const r of f.rows) lines.push(pick.map((i) => (i < 0 ? '' : r[i]!)).join(','));
  }
  const countries = ['DE', 'FR', 'NL', 'GB', 'US', 'IT', 'ES', 'BE'];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const kg = Math.round((0.5 + rnd() * 29) * 10) / 10;
    const billed = Math.ceil(kg * 2) / 2;
    const base = r2(400 + billed * 180 + rnd() * 50);
    const disc = r2(base * 0.38);
    const fuel = r2((base - disc) * 0.25);
    const net = r2(base - disc + fuel);
    const day = 1 + (i % 28);
    lines.push([
      `7951${String(i).padStart(8, '0')}`, `2026-10-${pad2(day)}`, 'FedEx International Economy', `Alıcı ${i}`, countries[i % countries.length]!,
      kg.toFixed(1), billed.toFixed(1), String(20 + (i % 40)), String(15 + (i % 30)), String(10 + (i % 20)),
      base.toFixed(2), (-disc).toFixed(2), fuel.toFixed(2), '', '', '', net.toFixed(2), 'TRY', `SIP-${i}`,
    ].join(','));
  }
  return utf8(lines.join('\r\n') + '\r\n');
}

export async function bigXlsx(n: number): Promise<Uint8Array> {
  const wb = workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['Tracking Number', 'Pickup Date', 'Receiver Country', 'Billed Weight', 'Net Amount', 'Currency']);
  for (let i = 0; i < n; i++) ws.addRow([`1Z9X4A71${String(i).padStart(10, '0')}`, new Date(Date.UTC(2026, 9, 1 + (i % 28))), 'DE', 1 + (i % 30), r2(300 + (i % 500) * 3.17), 'TRY']);
  return xlsxBytes(wb);
}

// ---------------------------------------------------------------- dosya listesi

export type Fixture = { name: string; bytes: () => Uint8Array | Promise<Uint8Array> };

export const FIXTURES: Fixture[] = [
  { name: 'sep-comma-quoted-fedex-fbo.csv', bytes: fedexFboQuoted },
  { name: 'sep-semicolon-sep-hint.csv', bytes: semicolonSepHint },
  { name: 'sep-tab-utf8.csv', bytes: tabUtf8 },
  { name: 'sep-tab-utf16le.txt', bytes: tabUtf16 },
  { name: 'enc-utf8-bom.csv', bytes: () => utf8Turkish(true) },
  { name: 'enc-utf8-nobom.csv', bytes: () => utf8Turkish(false) },
  { name: 'enc-cp1254-turkish.csv', bytes: turkishCp1254 },
  { name: 'enc-cp1254-mng.csv', bytes: mngCp1254 },
  { name: 'enc-cp1252-german.csv', bytes: germanCp1252 },
  { name: 'num-money-symbols-tr.csv', bytes: moneySymbolsTr },
  { name: 'num-money-symbols-en.csv', bytes: moneySymbolsEn },
  { name: 'date-dmy.csv', bytes: () => dates('dmy') },
  { name: 'date-iso.csv', bytes: () => dates('iso') },
  { name: 'date-mdy.csv', bytes: () => dates('mdy') },
  { name: 'date-excel-serial.csv', bytes: () => dates('serial') },
  { name: 'date-yyyymmdd.csv', bytes: () => dates('ymd8') },
  { name: 'excel-text-wrapped.csv', bytes: excelTextWrapped },
  { name: 'content-empty.csv', bytes: () => new Uint8Array(0) },
  { name: 'content-blank-lines.csv', bytes: () => utf8('\r\n  \r\n;;;\r\n') },
  { name: 'content-header-only.csv', bytes: () => concat(BOM, utf8('Takip No;Tarih;Tutar\r\n')) },
  { name: 'content-duplicate-tracking.csv', bytes: duplicates },
  { name: 'content-missing-amount.csv', bytes: missingAmount },
  { name: 'content-refunds.csv', bytes: refunds },
  { name: 'content-multi-currency.csv', bytes: multiCurrency },
  { name: 'xlsx-multi-sheet.xlsx', bytes: multiSheet },
  { name: 'xlsx-merged-header.xlsx', bytes: mergedHeader },
  { name: 'xlsx-serial-dates.xlsx', bytes: serialDates },
  { name: 'xlsx-header-only.xlsx', bytes: headerOnlyXlsx },
  { name: 'xlsx-empty.xlsx', bytes: emptyXlsx },
];
