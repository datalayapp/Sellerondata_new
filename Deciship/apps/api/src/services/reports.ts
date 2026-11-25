import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import pdfmake from 'pdfmake';
import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
import { diffTypeLabel, estimatedNote, fmtDate, fmtFxRate, fmtKg, fmtMoney, fmtNumber, fxSourceText, invoiceSummaryAmounts, invoiceSummarySentence, overchargeNote, statusLabel, t, type DiffType } from '@deciship/core';
import { currentLocale, m, type MessageKey } from '../i18n/index.ts';
// Bu modül dosya çalışanında (çocuk süreç) da yüklenir (Mesaj 6, 19-B1): veritabanı, ortam (`env.ts`) ya da onları içe
// aktaran servis buraya alınmaz; yalnız tür içe aktarması (`import type`) serbest.
import { DEFAULT_TIME_ZONE, zonedDateTimeText } from '../lib/time.ts';
import { sum } from '../lib/util.ts';
import type { InvoiceTotals } from './compare.ts';
import type { SerializedLine } from './invoiceSerialize.ts';

export type ReportInput = {
  companyName: string;
  carrierName: string;
  /** "FedEx IP 2025" ya da "Otomatik — A (118 satır), B (2 satır)". */
  tariffSummary?: string;
  invoiceNo: string;
  invoiceDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string;
  totals: InvoiceTotals;
  lines: SerializedLine[];
  /** Ölçüm zamanı firmanın saat diliminde yazılır; verilmezse varsayılan (İstanbul). */
  timeZone?: string;
};

/**
 * Fark sütununun toplamı nereye gidiyor. Fazla ödeme yalnız kesin ve uyumlu sayılmamış pozitif farklardır: raporda ayrı satırlar
 * olmadan Fark sütunuyla tutmaz.
 */
export function diffReconciliation(lines: SerializedLine[]) {
  const diffs = lines.filter((l) => l.status === 'DIFF');
  const positive = (l: SerializedLine) => Math.max(0, l.diffAmount ?? 0);
  const accepted = sum(diffs.filter((l) => l.decision === 'ACCEPTED').map(positive));
  const estimated = sum(diffs.filter((l) => l.decision !== 'ACCEPTED' && l.confidence === 'LOW').map(positive));
  const overcharge = sum(diffs.filter((l) => l.decision !== 'ACCEPTED' && l.confidence !== 'LOW').map(positive));
  const favorable = sum(diffs.map((l) => Math.min(0, l.diffAmount ?? 0)));
  return { overcharge, estimated, accepted, favorable, total: sum(diffs.map((l) => l.diffAmount ?? 0)) };
}

const DECISION_KEYS: Record<string, MessageKey> = { OPEN: 'report.decision.OPEN', VERIFIED: 'report.decision.VERIFIED', ACCEPTED: 'report.decision.ACCEPTED' };

function typeLabel(types: string[]) {
  return types.map((t) => diffTypeLabel(t as DiffType, currentLocale()) ?? t).join(', ');
}

function dimsText(d: { l: number; w: number; h: number } | null | undefined) {
  if (!d) return '';
  const f = (n: number) => (currentLocale() === 'en' ? String(n) : String(n).replace('.', ','));
  return `${f(d.l)}×${f(d.w)}×${f(d.h)}`;
}

/** "1 USD = 41,2345 TRY (TCMB 03.06.2025)"; kur çevrilmediyse boş. */
function fxText(l: SerializedLine) {
  const fx = l.fx;
  return fx ? `1 ${fx.base} = ${fmtFxRate(fx.rate, currentLocale())} ${fx.quote} (${fxSourceText(fx, currentLocale())})` : '';
}

/** SPEC §3.8: "Tarife" / "Faturadaki fiyat"; beklenen yoksa boş. */
function basisText(l: SerializedLine) {
  return l.pricingBasis === 'INVOICE' ? m('report.basis.invoice') : l.pricingBasis === 'TARIFF' ? m('report.basis.tariff') : '';
}

/** Fark satırı tahmini mi (LOW güven); gerekçesiyle. */
function confidenceText(l: SerializedLine) {
  return l.confidence === 'LOW' ? `${m('report.confidence.low')}${l.confidenceReason ? ` — ${l.confidenceReason}` : ''}` : l.expectedAmount != null ? m('report.confidence.high') : '';
}

function ourDims(l: SerializedLine) {
  return l.measurement ? { l: l.measurement.lengthCm, w: l.measurement.widthCm, h: l.measurement.heightCm } : null;
}

const capitalize = (s: string) => (s ? s[0]!.toLocaleUpperCase(currentLocale() === 'en' ? 'en' : 'tr') + s.slice(1) : s);

/** Ölçüm zamanı, firmanın saat diliminde, isteğin tarih biçimiyle: "21.10.2026 14:32". */
function measuredAtText(l: SerializedLine, timeZone: string) {
  if (!l.measurement) return '';
  const [day, time] = zonedDateTimeText(new Date(l.measurement.measuredAt), timeZone).split(' ');
  return `${fmtDate(day!, currentLocale())} ${time}`;
}

/** Ölçü yöntemi tek başına: "LiDAR", "Elle (metre)". */
function dimMethodText(l: SerializedLine) {
  return l.measurement ? capitalize(t(currentLocale(), `evidence.dimMethod.${l.measurement.dimMethod}`)) : '';
}

/** Excel "Ölçüm yöntemi": ölçü ve ağırlık yöntemi, "LiDAR · terazi ekranından okundu". */
function methodText(l: SerializedLine) {
  if (!l.measurement) return '';
  return [dimMethodText(l), l.measurement.weightMethod ? t(currentLocale(), `evidence.weightMethod.${l.measurement.weightMethod}`) : ''].filter(Boolean).join(' · ');
}

/** PDF "Ölçüm" sütunu: "21.10.2026 14:32 · LiDAR · 2 fotoğraf"; ölçüm yoksa "—". */
function measurementCell(l: SerializedLine, timeZone: string) {
  if (!l.measurement) return '—';
  return [measuredAtText(l, timeZone), dimMethodText(l), m('report.photoCount', { count: l.measurement.photoCount })].join(' · ');
}

// ---------------- XLSX ----------------

const MONEY_FMT = '#,##0.00';
const KG_FMT = '#,##0.0##';

const LINE_COLUMNS: { header: MessageKey; key: string; width: number; fmt?: string }[] = [
  { header: 'report.col.row', key: 'rowIndex', width: 7 },
  { header: 'report.col.tracking', key: 'trackingNo', width: 22 },
  { header: 'report.col.shipDate', key: 'shipDate', width: 13 },
  { header: 'report.col.country', key: 'destCountry', width: 7 },
  { header: 'report.col.status', key: 'status', width: 12 },
  { header: 'report.col.types', key: 'types', width: 22 },
  { header: 'report.col.ourDims', key: 'ourDims', width: 16 },
  { header: 'report.col.ourKg', key: 'ourKg', width: 10, fmt: KG_FMT },
  { header: 'report.col.ourChargeable', key: 'ourChargeableKg', width: 12, fmt: KG_FMT },
  { header: 'report.col.billedDims', key: 'billedDims', width: 16 },
  { header: 'report.col.billedKg', key: 'billedKg', width: 10, fmt: KG_FMT },
  { header: 'report.col.billedChargeable', key: 'billedChargeableKg', width: 12, fmt: KG_FMT },
  { header: 'report.col.expected', key: 'expectedAmount', width: 13, fmt: MONEY_FMT },
  { header: 'report.col.fx', key: 'fx', width: 34 },
  { header: 'report.col.basis', key: 'basis', width: 16 },
  { header: 'report.col.rateDev', key: 'rateDev', width: 12, fmt: '0.00' },
  { header: 'report.col.confidence', key: 'confidence', width: 28 },
  { header: 'report.col.billed', key: 'netAmount', width: 13, fmt: MONEY_FMT },
  { header: 'report.col.diff', key: 'diffAmount', width: 13, fmt: MONEY_FMT },
  { header: 'report.col.decision', key: 'decision', width: 14 },
  { header: 'report.col.note', key: 'note', width: 40 },
  // Mesaj 5 (04-B8): ölçümün kanıtı. Ölçen kişinin adı yalnız firmanın kendi raporunda (itiraz metnine girmez).
  { header: 'report.col.measuredAt', key: 'measuredAt', width: 17 },
  { header: 'report.col.measuredBy', key: 'measuredBy', width: 20 },
  { header: 'report.col.method', key: 'method', width: 32 },
  { header: 'report.col.photos', key: 'photos', width: 9 },
];

/** Veri hücrelerinin biçimi (sütun biçimiyle aynı içerik), sütun başına tek nesne. */
const DATA_STYLES: Partial<ExcelJS.Style>[] = LINE_COLUMNS.map((c) => (c.fmt ? { numFmt: c.fmt } : {}));

function lineRow(l: SerializedLine, timeZone: string) {
  return {
    // Dosyadaki sıra 0'dan saklanır; rapor okuyan için ilk satır 1.
    rowIndex: l.rowIndex + 1,
    trackingNo: l.trackingNo,
    shipDate: l.shipDate ? fmtDate(l.shipDate, currentLocale()) : '',
    destCountry: l.destCountry ?? '',
    status: statusLabel(l.status as Parameters<typeof statusLabel>[0], currentLocale()) ?? l.status,
    types: typeLabel(l.diffTypes),
    ourDims: dimsText(ourDims(l)),
    ourKg: l.measurement?.weightKg ?? null,
    ourChargeableKg: l.ourChargeableKg,
    billedDims: dimsText(l.dims),
    billedKg: l.actualKg,
    billedChargeableKg: l.billedChargeableKg,
    expectedAmount: l.expectedAmount,
    fx: fxText(l),
    basis: basisText(l),
    rateDev: l.rateDeviationPct,
    confidence: confidenceText(l),
    netAmount: l.netAmount,
    diffAmount: l.diffAmount,
    // Karar yalnız fark satırının: uyumlu satırda "Açık" yanıltır.
    decision: l.status !== 'DIFF' ? '—' : DECISION_KEYS[l.decision] ? m(DECISION_KEYS[l.decision]!) : l.decision,
    note: [l.note, l.decisionReason].filter(Boolean).join(' · '),
    measuredAt: measuredAtText(l, timeZone),
    measuredBy: l.measurement?.measuredByName ?? '',
    method: methodText(l),
    photos: l.measurement ? l.measurement.photoCount : null,
  };
}

/**
 * Satır sayfası. Akışlı yazıcıda (`stream`) her satır eklenir eklenmez dosyaya yazılıp bellekten atılır; başlık satırının
 * biçimi bu yüzden veri satırlarından önce verilir (bellekteki çalışma kitabında sıra fark etmez, çıktı aynıdır).
 */
function addLineSheet(wb: ExcelJS.Workbook, name: string, lines: SerializedLine[], stream: boolean, timeZone: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = LINE_COLUMNS.map((c) => ({ header: m(c.header), key: c.key, width: c.width, style: c.fmt ? { numFmt: c.fmt } : {} }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF161616' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: LINE_COLUMNS.length } };
  if (stream) header.commit();
  for (const l of lines) {
    const row = ws.addRow(lineRow(l, timeZone));
    // Hücreler sütunun biçimini kendi kopyasıyla alır; exceljs biçimi nesne kimliğiyle önbelleğe aldığından her hücre
    // için biçim XML'i yeniden üretiliyordu (raporun en pahalı kısmı). Aynı içerikli ortak nesne verilir.
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.style = DATA_STYLES[col - 1]!;
    });
    if (stream) row.commit();
  }
  if (stream) ws.commit();
  return ws;
}

function fillReport(wb: ExcelJS.Workbook, r: ReportInput, stream: boolean) {
  wb.creator = 'DeciShip';
  wb.created = new Date();

  const locale = currentLocale();
  const sum = wb.addWorksheet(m('report.sheet.summary'));
  sum.columns = [
    { key: 'k', width: 32 },
    { key: 'v', width: 28 },
  ];
  sum.addRow([m('report.title')]).font = { bold: true, size: 14 };
  sum.addRow([]);
  const t = r.totals;
  const rec = diffReconciliation(r.lines);
  const a = invoiceSummaryAmounts(t);
  // üçüncü alan: tutar (para biçimiyle yazılır)
  const rows: [string, string | number, boolean?][] = [
    [m('report.sum.company'), r.companyName],
    [m('report.sum.carrier'), r.carrierName],
    ...(r.tariffSummary ? ([[m('report.sum.tariff'), r.tariffSummary]] as [string, string][]) : []),
    [m('report.sum.invoiceNo'), r.invoiceNo],
    [m('report.sum.invoiceDate'), fmtDate(r.invoiceDate, locale)],
    [m('report.sum.period'), r.periodFrom || r.periodTo ? `${r.periodFrom ? fmtDate(r.periodFrom, locale) : ''} – ${r.periodTo ? fmtDate(r.periodTo, locale) : ''}` : '—'],
    [m('report.sum.currency'), r.currency],
    [m('report.sum.lines'), t.lines],
    [m('report.sum.match'), t.match],
    [m('report.sum.diff'), t.diff],
    [m('report.sum.unmatched'), t.unmatched],
    [m('report.sum.noTariff'), t.noTariff],
    [m('report.sum.summary'), invoiceSummarySentence(t, locale)],
    // ekrandaki gibi: Faturalanan ile Beklenen aynı kalemleri kapsar (tarifede olmayan ek ücretler Beklenen'e faturadan)
    [m('report.sum.billedTotal'), a.billed, true],
    [m('report.sum.expectedTotal'), a.expected, true],
    [m('report.sum.overcharge'), t.overchargeTotal, true],
    [m('report.sum.verified'), t.verifiedTotal, true],
    ...(rec.accepted > 0 ? ([[m('report.sum.accepted'), rec.accepted, true]] as [string, number, boolean][]) : []),
    ...(rec.estimated > 0 ? ([[m('report.sum.estimatedDiff'), rec.estimated, true]] as [string, number, boolean][]) : []),
    ...(rec.favorable < 0 ? ([[m('report.sum.favorable'), rec.favorable, true]] as [string, number, boolean][]) : []),
    [m('report.sum.diffColumn'), rec.total, true],
  ];
  // SPEC §3.8: tahmini satırların fazlası ayrı (Fazla ödeme'ye girmez)
  if ((t.estimatedOverchargeTotal ?? 0) > 0) {
    rows.push([m('report.sum.estimated'), t.estimatedOverchargeTotal, true], [m('report.sum.estimatedNote'), estimatedNote(locale)]);
  }
  // ekrandaki gibi: Fazla ödeme ≠ Faturalanan − Beklenen ise neden farklı olduğunu tek satırda söyle
  const note = overchargeNote(t, t.overchargeTotal, locale);
  if (note) rows.push([m('report.sum.note'), note]);
  // Eski faturaların kayıtlı özetinde alan yok; 0 ise satır eklenmez.
  if (a.unchecked > 0) rows.push([m('report.sum.unchecked'), a.unchecked, true]);
  if (a.showInvoiceTotal) rows.push([m('report.sum.invoiceTotal'), a.invoiceTotal, true]);
  for (const [k, v, money] of rows) {
    const row = sum.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    if (money) row.getCell(2).numFmt = MONEY_FMT;
  }
  if (stream) sum.commit();

  const tz = r.timeZone ?? DEFAULT_TIME_ZONE;
  addLineSheet(wb, m('report.sheet.diffs'), r.lines.filter((l) => l.status === 'DIFF'), stream, tz);
  addLineSheet(wb, m('report.sheet.all'), r.lines, stream, tz);
  addLineSheet(wb, m('report.sheet.unmatched'), r.lines.filter((l) => l.status === 'UNMATCHED'), stream, tz);
}

/**
 * Excel raporu. Varsayılan akışlı yazıcıdır (exceljs WorkbookWriter): satırlar eklendikçe sıkıştırılır, tüm hücre
 * modeli bellekte tutulmaz (20.000 satırlık faturada süre ve bellek birkaç kat azalır). `inMemory` yalnız testte
 * akışlı çıktının hücre değerleri ve biçimleri bakımından bellekteki çalışma kitabıyla aynı olduğunu doğrulamak için.
 */
export async function buildReportXlsx(r: ReportInput, opts: { inMemory?: boolean } = {}): Promise<Buffer> {
  if (opts.inMemory) {
    const wb = new ExcelJS.Workbook();
    fillReport(wb, r, false);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    out.on('end', resolve);
    out.on('error', reject);
  });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: true });
  fillReport(wb, r, true);
  await wb.commit();
  await done;
  return Buffer.concat(chunks);
}

// ---------------- PDF ----------------

function findFontsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../assets/fonts'),
    path.resolve(here, '../assets/fonts'),
    path.resolve(here, 'assets/fonts'),
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(process.cwd(), 'apps/api/assets/fonts'),
  ];
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'Roboto-Regular.ttf')));
  if (!dir) throw new Error('PDF yazı tipi bulunamadı (assets/fonts)');
  return dir;
}

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const dir = findFontsDir();
  pdfmake.setFonts({
    Roboto: {
      normal: path.join(dir, 'Roboto-Regular.ttf'),
      bold: path.join(dir, 'Roboto-Medium.ttf'),
      italics: path.join(dir, 'Roboto-Italic.ttf'),
      bolditalics: path.join(dir, 'Roboto-MediumItalic.ttf'),
    },
  });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((p: string) => path.resolve(p).startsWith(dir));
  fontsReady = true;
}

/** PDF'te tutar ile para simgesi arasındaki boşluk bölünmez olsun: simge alt satıra düşmesin. */
export function pdfMoney(n: number, currency: string, locale: ReturnType<typeof currentLocale>): string {
  return fmtMoney(n, currency, locale).replace(/ /g, ' ');
}

function kpi(label: string, value: string, color = '#161616'): Content {
  return {
    stack: [
      { text: label, fontSize: 8, color: '#525252' },
      { text: value, fontSize: 13, bold: true, color, margin: [0, 2, 0, 0] },
    ],
    margin: [6, 6, 6, 6],
  };
}

/**
 * PDF fark tablosunun satırları (karar 2026-11-12). Fark satırı: durumu `DIFF` olan satır (Excel "Farklar" sayfasıyla aynı
 * küme; kabul edilen, tahmini ve lehe olanlar dahil). Sınır aşılmadıysa satırlar dosyadaki sırasıyla, eskisi gibi. Aşıldıysa
 * en büyük Fark tutarından küçüğe (eşitse dosyadaki sıra) ilk `maxRows` satır, bu sırayla. `maxRows` verilmemiş ya da geçersizse
 * (0, eksi, NaN, sonsuz) sınırsız değil, varsayılan `REPORT_PDF_MAX_ROWS_DEFAULT`; kesirli değer aşağı yuvarlanır.
 */
export const REPORT_PDF_MAX_ROWS_DEFAULT = 1000;

export function pdfDiffRows(lines: SerializedLine[], maxRows?: number): { rows: SerializedLine[]; total: number; truncated: boolean } {
  const limit = typeof maxRows === 'number' && Number.isFinite(maxRows) && maxRows >= 1 ? Math.floor(maxRows) : REPORT_PDF_MAX_ROWS_DEFAULT;
  const diffs = lines.filter((l) => l.status === 'DIFF');
  if (diffs.length <= limit) return { rows: diffs, total: diffs.length, truncated: false };
  const rows = diffs
    .slice()
    .sort((a, b) => (b.diffAmount ?? 0) - (a.diffAmount ?? 0) || a.rowIndex - b.rowIndex)
    .slice(0, limit);
  return { rows, total: diffs.length, truncated: true };
}

/**
 * PDF raporu. `maxRows`: fark tablosunun en çok satırı (ana süreç `REPORT_PDF_MAX_ROWS` ile verir; bu modül ortamı okumaz).
 * Sınır yalnız satır listesini kısaltır: üstteki sayılar ve tutarlar (`totals`) ile tablonun altındaki toplamlar
 * (`diffReconciliation(r.lines)`) her zaman bütün faturadır.
 */
export async function buildReportPdf(r: ReportInput, opts: { maxRows?: number } = {}): Promise<Buffer> {
  ensureFonts();
  const locale = currentLocale();
  const t = r.totals;
  const a = invoiceSummaryAmounts(t);
  const note = overchargeNote(t, t.overchargeTotal, locale);
  const money = (n: number | null) => (n == null ? '—' : pdfMoney(n, r.currency, locale));
  const kg = (n: number | null | undefined) => (n == null ? '—' : fmtKg(n, locale));
  const { rows: diffs, total: diffTotal, truncated } = pdfDiffRows(r.lines, opts.maxRows);
  const truncatedNote = truncated ? m('report.pdf.truncatedNote', { shown: fmtNumber(diffs.length, 0, locale), total: fmtNumber(diffTotal, 0, locale) }) : '';
  const tz = r.timeZone ?? DEFAULT_TIME_ZONE;

  const header: TableCell[] = [
    m('report.col.tracking'),
    m('report.pdf.type'),
    m('report.pdf.ourDims'),
    m('report.pdf.measurement'),
    m('report.pdf.billedDims'),
    m('report.col.expected'),
    m('report.col.billed'),
    m('report.col.decision'),
    m('report.col.diff'),
  ].map((h) => ({ text: h, bold: true, color: '#ffffff', fillColor: '#161616', fontSize: 8 }));

  const rec = diffReconciliation(r.lines);
  const body: TableCell[][] = [header];
  for (const l of diffs) {
    body.push([
      { text: l.trackingNo, fontSize: 8 },
      { text: typeLabel(l.diffTypes), fontSize: 8 },
      { text: `${dimsText(ourDims(l)) || '—'}\n${kg(l.ourChargeableKg)}`, fontSize: 8 },
      { text: measurementCell(l, tz), fontSize: 7 },
      { text: `${dimsText(l.dims) || '—'}\n${kg(l.billedChargeableKg)}`, fontSize: 8 },
      {
        text: l.fx ? `${money(l.expectedAmount)}
${fmtMoney(l.fx.expected, l.fx.base, locale)} × ${fmtFxRate(l.fx.rate, locale)}` : money(l.expectedAmount),
        fontSize: 8,
        alignment: 'right',
      },
      { text: money(l.netAmount), fontSize: 8, alignment: 'right' },
      { text: DECISION_KEYS[l.decision] ? m(DECISION_KEYS[l.decision]!) : l.decision, fontSize: 8 },
      l.decision === 'ACCEPTED'
        ? { text: money(l.diffAmount), fontSize: 8, alignment: 'right', color: '#6f6f6f' }
        : l.confidence === 'LOW'
        ? { text: [{ text: money(l.diffAmount), bold: true }, { text: `\n${m('report.pdf.estimatedTag')}`, fontSize: 7 }], fontSize: 8, alignment: 'right', color: '#8e6a00' }
        : { text: money(l.diffAmount), fontSize: 8, alignment: 'right', color: '#da1e28', bold: true },
    ]);
  }
  if (diffs.length === 0) {
    body.push([{ text: m('report.pdf.noDiffs'), colSpan: 9, fontSize: 9, italics: true }, '', '', '', '', '', '', '', '']);
  } else {
    // Fark sütunu nereye gidiyor: üstteki Fazla ödeme ile aynı sayı, gerisi ayrı satır.
    const total = (label: string, value: number, bold = false) =>
      body.push([{ text: label, colSpan: 8, fontSize: 8, alignment: 'right', bold }, '', '', '', '', '', '', '', { text: money(value), fontSize: 8, alignment: 'right', bold }]);
    total(m('report.sum.overcharge'), t.overchargeTotal);
    if (rec.estimated > 0) total(m('report.sum.estimatedDiff'), rec.estimated);
    if (rec.accepted > 0) total(m('report.sum.accepted'), rec.accepted);
    if (rec.favorable < 0) total(m('report.sum.favorable'), rec.favorable);
    total(m('report.sum.diffColumn'), rec.total, true);
  }
  // tablonun son satırı: liste kısaltıldı (toplamlar yukarıda yine bütün faturadır)
  if (truncated) body.push([{ text: truncatedNote, colSpan: 9, fontSize: 8, italics: true, color: '#8e6a00' }, '', '', '', '', '', '', '', '']);

  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [32, 40, 32, 40],
    defaultStyle: { font: 'Roboto', fontSize: 9 },
    info: { title: m('report.pdf.docTitle', { invoiceNo: r.invoiceNo }), author: 'DeciShip' },
    footer: (current: number, count: number) => ({
      text: `DeciShip · ${r.companyName} · ${current}/${count}`,
      alignment: 'center',
      fontSize: 7,
      color: '#8d8d8d',
      margin: [0, 10, 0, 0],
    }),
    content: [
      {
        columns: [
          { text: r.companyName, fontSize: 18, bold: true },
          { text: m('report.pdf.title'), alignment: 'right', fontSize: 11, color: '#525252', margin: [0, 6, 0, 0] },
        ],
      },
      {
        text: `${m('report.pdf.invoiceLine', { carrier: r.carrierName, invoiceNo: r.invoiceNo, date: fmtDate(r.invoiceDate, locale) })}${
          r.periodFrom || r.periodTo ? m('report.pdf.periodPart', { from: r.periodFrom ? fmtDate(r.periodFrom, locale) : '', to: r.periodTo ? fmtDate(r.periodTo, locale) : '' }) : ''
        }`,
        margin: [0, 4, 0, r.tariffSummary ? 2 : 12],
        color: '#393939',
      },
      ...(r.tariffSummary ? [{ text: m('report.pdf.tariff', { tariff: r.tariffSummary }), margin: [0, 0, 0, 12], color: '#525252', fontSize: 9 } as Content] : []),
      // karar 2026-11-12: liste kısaltıldıysa raporun başında da söylenir
      ...(truncated ? [{ text: truncatedNote, bold: true, fontSize: 9, color: '#8e6a00', margin: [0, 0, 0, 8] } as Content] : []),
      {
        table: {
          widths: [48, 48, 48, 60, 60, '*', '*', '*', '*'],
          body: [
            [
              kpi(m('report.pdf.kpi.lines'), String(t.lines)),
              kpi(m('report.pdf.kpi.match'), String(t.match), '#198038'),
              kpi(m('report.pdf.kpi.diff'), String(t.diff), '#da1e28'),
              kpi(m('report.pdf.kpi.unmatched'), String(t.unmatched), '#525252'),
              kpi(m('report.pdf.kpi.noTariff'), String(t.noTariff), '#8e6a00'),
              kpi(m('report.pdf.kpi.billed'), money(a.billed)),
              kpi(m('report.pdf.kpi.expected'), money(a.expected)),
              kpi(m('report.pdf.kpi.overcharge'), money(t.overchargeTotal), '#da1e28'),
              kpi(m('report.pdf.kpi.verified'), money(t.verifiedTotal), '#0f62fe'),
            ],
          ],
        },
        layout: {
          hLineColor: () => '#e0e0e0',
          vLineColor: () => '#e0e0e0',
          fillColor: () => '#f4f4f4',
        },
        margin: [0, 0, 0, 6],
      },
      // SPEC §3.8: tahmini fazla ödeme ayrı satırda
      ...((t.estimatedOverchargeTotal ?? 0) > 0
        ? [{ text: m('report.pdf.estimatedLine', { amount: money(t.estimatedOverchargeTotal ?? 0), note: estimatedNote(locale) }), fontSize: 8, color: '#8e6a00', margin: [0, 0, 0, 2] } as Content]
        : []),
      // ekrandaki gibi: Fazla ödeme ≠ Faturalanan − Beklenen ise tek satırlık açıklama
      ...(note ? [{ text: note, fontSize: 8, color: '#393939', margin: [0, 0, 0, 2] } as Content] : []),
      {
        // ekrandaki cümle + aynı taban açıklaması
        text: [
          invoiceSummarySentence(t, locale),
          m('report.pdf.basisNote'),
          a.unchecked > 0 ? m('report.pdf.uncheckedNote', { amount: money(a.unchecked) }) : '',
          a.showInvoiceTotal ? m('report.pdf.invoiceTotalNote', { amount: money(a.invoiceTotal) }) : '',
          '.',
        ].join(''),
        fontSize: 8,
        color: '#6f6f6f',
        margin: [0, 0, 0, 16],
      },
      { text: m('report.pdf.diffLines'), fontSize: 12, bold: true, margin: [0, 0, 0, 6] },
      {
        table: { headerRows: 1, widths: [84, 72, '*', 96, '*', 64, 64, 58, 64], body },
        layout: {
          hLineColor: () => '#e0e0e0',
          vLineColor: () => '#ffffff',
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
      },
    ],
  };
  return pdfmake.createPdf(doc).getBuffer();
}
