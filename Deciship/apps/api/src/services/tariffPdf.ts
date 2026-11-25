import { currentLocale, m as msg } from '../i18n/index.ts';
import { localizeText } from '@deciship/core';
/**
 * PDF tarife: metin katmanı → yapay zekâ keşfi (bölümler) → seçilen bölümlerin çıkarılması →
 * kodla normalleştirme (DeciShip tablo biçimi + ISO-2 ülke eşlemesi) → metin katmanıyla doğrulama.
 * Çıktı mevcut taslak hattına (TariffImportDraft + checkTariffImport) girer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  ambiguousWeightText,
  applyListDiscount,
  cleanZoneLabel,
  countryNameToIso2,
  linkListDiscounts,
  fmtNumber,
  parseNumberAs,
  parseTrNumber,
  zoneKey,
  type ImportIssue,
  type NumberFormat,
  type PdfCountryRow,
  type PdfDiscountTable,
  type PdfDocumentFacts,
  type PdfListDiscountLink,
  type PdfPageLayout,
  type PdfSectionInfo,
  type PdfTable,
  type RawTariffFile,
  packagingRowLabel,
} from '@deciship/core';
import { z } from 'zod';
import { prisma } from '../db.ts';
import { AppError, badRequest } from '../errors.ts';
import { readPdfLayout as readPdfLayoutFile, readPdfText as readPdfTextFile, slicePdfPages, type FileJobOptions } from '../lib/fileWorkers.ts';
import { absolutePath } from '../lib/storage.ts';
import type Anthropic from '@anthropic-ai/sdk';
import { aiDisabled, aiEnabled, withOutputLanguage, type AiUsage } from './ai.ts';
import { meteredCall, type AiCallContext } from './aiMeter.ts';
import type { PdfDraftInfo } from './tariffImport.ts';

export const DOCUMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bunu aşan belgelerde keşfe PDF'in tamamı değil metin katmanı + ilk sayfalar gönderilir. */
const FULL_PDF_MAX_PAGES = 40;
const FULL_PDF_MAX_BYTES = 20 * 1024 * 1024;
const FIRST_PAGES = 5;
/** Çıkarmada gönderilecek en çok sayfa (bölümler + ülke tablosu). */
const MAX_EXTRACT_PAGES = 30;
const MIN_PAGE_TEXT = 40;

// ---------------------------------------------------------------------------------------------
// Metin katmanı

/** PDF'in sayfa metinleri. Okuma dosya havuzunda (worker) yapılır; `PDF_MAX_PAGES` üstü 413 (`lib/fileWorkers.ts`). */
export async function readPdfText(buf: Buffer, opts: FileJobOptions): Promise<{ pages: string[] }> {
  return readPdfTextFile(buf, opts);
}

/** Konumlu metin parçaları (kodla tarama için). Okuma dosya havuzunda; sayfa sınırı aynı. */
export async function readPdfLayout(buf: Buffer, opts: FileJobOptions): Promise<PdfPageLayout[]> {
  return readPdfLayoutFile(buf, opts);
}

export const pageHasText =(t: string | undefined) => (t ?? '').replace(/\s+/g, '').length >= MIN_PAGE_TEXT;

/** İstenen sayfalardan (1 tabanlı, sıralı) yeni bir PDF. Kesme dosya havuzunda (worker, Y96); belge dışı sayfa atlanır. */
export async function slicePdf(buf: Buffer, pages: number[], opts: FileJobOptions): Promise<Buffer> {
  return (await slicePdfPages(buf, pages, opts))!;
}

// ---------------------------------------------------------------------------------------------
// Keşif

const fuelSchema = z.object({ kind: z.enum(['FIXED_PCT', 'INDEXED', 'UNKNOWN']), pct: z.number().nullable() });

const discoverySchema = z.object({
  document: z.object({
    carrier: z.string().nullable(),
    validFrom: z.string().nullable(),
    currency: z.string().nullable(),
    weightUnit: z.enum(['kg', 'lb']).nullable(),
    dimDivisor: z.number().nullable(),
    fuel: fuelSchema,
    surchargeNotes: z.array(z.string()),
    countryZonePages: z.array(z.number()),
    discountPages: z.array(z.number()),
    notes: z.array(z.string()),
  }),
  sections: z.array(
    z.object({
      title: z.string(),
      service: z.string().nullable(),
      direction: z.enum(['export', 'import', 'domestic']).nullable(),
      priceType: z.enum(['net', 'list', 'unknown']),
      packaging: z.enum(['envelope', 'pak', 'box', 'all']).nullable(),
      zones: z.array(z.string()),
      weightMin: z.number().nullable(),
      weightMax: z.number().nullable(),
      currency: z.string().nullable(),
      pages: z.array(z.number()),
      hasAdditionalStep: z.boolean(),
      hasPerKgBands: z.boolean(),
    }),
  ),
});

export type PdfSection = PdfSectionInfo;
export type { PdfDocumentFacts };
/** Belgede saklanan tarama: kod (tablolar + ülkeler dahil) ya da yapay zekâ (yalnız bölüm listesi). */
export type StoredScan = {
  mode: 'code' | 'ai';
  document: PdfDocumentFacts;
  sections: (PdfSection & { table?: PdfTable; notes?: string[] })[];
  countries?: PdfCountryRow[];
  /** yalnız kod taraması: indirim yüzdesi tabloları (liste × indirim hesabı için) */
  discountTables?: PdfDiscountTable[];
  scannedAt: string;
};
export type StoredScans = { code?: StoredScan; ai?: StoredScan };

const DISCOVERY_SYSTEM = `You analyse a cargo carrier's price-list / contract PDF (FedEx, UPS, DHL, TNT, Aras, Yurtiçi, MNG, PTT …; Turkish or English) for DeciShip, a tool used by a Türkiye-based exporter to audit carrier invoices of parcels (boxes, and also the carrier's own paks / flyers and envelopes).
Return document facts and a list of ALL PARCEL PRICE TABLE SECTIONS in the document (every page, net and list prices, export and import — do not stop early). DeciShip will later extract the sections the user picks, so sections must be precise:
- One section = one price table with one column per zone and one row per weight (or weight band). Separate tables are separate sections even on the same page. Envelope / letter / document ("Zarf", "Dosya", "Evrak") prices and pak / flyer ("Pak", "Flyer", "Poşet") prices are their own sections with packaging "envelope" or "pak" (one section per packaging, even when it is a single row). When a page shows an "Envelope" row, a "Pak (0,5–2,5 kg)" block and an "other packaging (Diğer ambalaj malzemeleri) 0,5–70,5 kg" block, output three sections: the envelope row (packaging "envelope"), the pak block (packaging "pak") and the box block (packaging "box"; it includes its "İlave" rows and the "Kg başına ücret" bands that follow it). A heading that names both envelope and pak at once ("Envelope/Pak (0,5–2,5 kg)") is not a section by itself: use the separate "Envelope" and "Pak" sub-blocks under it. Use packaging "all" for a table that is not split by packaging. A freight service printed below another service on the same page (e.g. "International Priority Freight" per-kg rows) is its own section.
- The same service printed for different zone groups on different pages (e.g. World zones A–I on page 3 and Europe zones R–W on page 4) are separate sections. A table that continues on the next page is one section with both pages.
- Distinguish service (as printed, e.g. "FedEx International Priority® Express (IPE)", "International Priority Freight"), direction (export = shipments leaving Türkiye / "İhracat"; import = "İthalat"), and priceType: "net" for negotiated/net prices ("Net Ücretler"), "list" for public list prices ("Liste Fiyatı"), else "unknown".
- zones: the zone labels as short codes in column order ("A BÖLGESİ" → "A", "ZONE X" → "X"). weightMin/weightMax in the table's weight unit (per-kg bands count: e.g. last band "1000+" → weightMax 1000). hasAdditionalStep: the table has "İlave 0,5 kg"/"additional 0.5 kg" rows. hasPerKgBands: it has "per kg"/"Kg başına ücret" bands.
- title: a short, human Turkish title, e.g. "IPE ihracat · Dünya (A–I) · kutu 0,5–70,5 kg · net".
- Discount-percentage tables, surcharge lists, terms pages and the country → zone list are NOT price sections; report them in document.discountPages / document.countryZonePages (page numbers of the country → zone tables) / surchargeNotes.
Document facts: carrier; validFrom (YYYY-MM-DD, the "valid from" date); currency (ISO code of the prices); weightUnit; dimDivisor (e.g. "DIM 5000" → 5000); fuel: FIXED_PCT with pct when the fuel surcharge is a fixed percentage for this customer (e.g. "FIXED 5%"), INDEXED when it follows a published index/table, else UNKNOWN; surchargeNotes: short Turkish notes about surcharges or waivers (e.g. "Uzak bölge (OPA/ODA) ek ücreti %100 muaf"); notes: other short Turkish notes important for invoice auditing (VAT, billed in local currency at daily FX rate, etc.).
Page numbers are the 1-based physical page numbers of the PDF (the "Page index" in the input gives the first characters of each page to help you).
Write all human-readable text in Turkish. Do not invent values: use null/empty when the document does not say.`;

/** Sayaç bilgisi (denetim kaydına): önceki sonuçtan geldiyse `usage` null, `cached` true. */
export type PdfAiMeter = { usage: AiUsage | null; usageId: string | null; cached: boolean };

/** Kesilmiş PDF her kayıtta farklı bayt üretir (pdf-lib tarih yazar): önbellek anahtarında kaynak dosya ve sayfalar durur. */
const slicedPdfKey = (buf: Buffer, pages: number[]) => ({ type: 'text', text: `source-pdf sha256:${crypto.createHash('sha256').update(buf).digest('hex')} pages:${pages.join(',')}` });

/** Aynı PDF aynı firmada yeniden taranırsa önceki tarama ücretsiz kullanılır (anahtar: dosya, istem, taşıyıcı). */
export async function discoverPdf(
  buf: Buffer,
  pageTexts: string[],
  c: { carrier: { name: string; code: string } },
  ctx: AiCallContext,
): Promise<{ document: PdfDocumentFacts; sections: PdfSection[]; mode: 'full' | 'text' } & PdfAiMeter> {
  if (!aiEnabled()) throw aiDisabled(msg('pdf.aiOffTariff'));
  const full = pageTexts.length <= FULL_PDF_MAX_PAGES && buf.length <= FULL_PDF_MAX_BYTES;
  const index = pageTexts.map((t, i) => `Page ${i + 1}: ${pageHasText(t) ? t.replace(/\s+/g, ' ').slice(0, 160) : '(no text layer — scanned image?)'}`).join('\n');
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  let cacheContent: unknown[] | undefined;
  if (full) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
  } else {
    const firstPages = Array.from({ length: Math.min(FIRST_PAGES, pageTexts.length) }, (_, i) => i + 1);
    const first = await slicePdf(buf, firstPages, { companyId: ctx.companyId });
    cacheContent = [slicedPdfKey(buf, firstPages)];
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: first.toString('base64') } });
    const text = pageTexts.map((t, i) => `=== Page ${i + 1} ===\n${t.slice(0, 3500)}`).join('\n');
    content.push({
      type: 'text',
      text: `The document has ${pageTexts.length} pages; only pages 1–${Math.min(FIRST_PAGES, pageTexts.length)} are attached as PDF. Text layer of ALL pages:\n<text_layer>\n${text}\n</text_layer>`,
    });
  }
  content.push({
    type: 'text',
    text: `Context (JSON): ${JSON.stringify({ carrier: c.carrier, pages: pageTexts.length })}\nPage index:\n${index}\nList the document facts and the parcel price sections.`,
  });
  if (cacheContent) cacheContent.push(...content.slice(1));
  const metered = await meteredCall(ctx, {
    schema: discoverySchema,
    system: withOutputLanguage(DISCOVERY_SYSTEM),
    maxTokens: 48000,
    effort: 'medium',
    content,
    cache: true,
    ...(cacheContent ? { cacheContent } : {}),
  });
  const r = metered.data;
  const pageCount = pageTexts.length;
  const okPages = (ps: number[]) => [...new Set(ps.map((p) => Math.round(p)).filter((p) => p >= 1 && p <= pageCount))].sort((a, b) => a - b);
  const sections: PdfSection[] = r.sections
    .map((s, i) => ({
      ...s,
      id: `s${i + 1}`,
      title: s.title.trim(),
      zones: s.zones.map((z) => cleanZoneLabel(z)).filter(Boolean),
      pages: okPages(s.pages),
      currency: s.currency?.trim().toUpperCase().slice(0, 3) || null,
    }))
    .filter((s) => s.pages.length);
  const doc: PdfDocumentFacts = {
    ...r.document,
    currency: r.document.currency?.trim().toUpperCase().slice(0, 3) || null,
    validFrom: r.document.validFrom && /^\d{4}-\d{2}-\d{2}$/.test(r.document.validFrom.trim()) ? r.document.validFrom.trim() : null,
    dimDivisor: r.document.dimDivisor && r.document.dimDivisor >= 1000 && r.document.dimDivisor <= 10000 ? Math.round(r.document.dimDivisor) : null,
    countryZonePages: okPages(r.document.countryZonePages),
    discountPages: okPages(r.document.discountPages),
  };
  return { document: doc, sections, mode: full ? 'full' : 'text', usage: metered.usage, usageId: metered.usageId, cached: metered.cached };
}

// ---------------------------------------------------------------------------------------------
// Çıkarma

const extractionSchema = z.object({
  tables: z.array(
    z.object({
      sectionId: z.string(),
      zones: z.array(z.string()),
      rows: z.array(
        z.object({
          kind: z.enum(['weight', 'additional', 'perKg']),
          label: z.string(),
          weight: z.number().nullable(),
          from: z.number().nullable(),
          step: z.number().nullable(),
          cells: z.array(z.string()),
          page: z.number().nullable(),
        }),
      ),
    }),
  ),
  countries: z.array(z.object({ name: z.string(), zone: z.string(), page: z.number().nullable() })),
  notes: z.array(z.string()),
});
export type PdfExtraction = z.infer<typeof extractionSchema>;

const EXTRACT_SYSTEM = `You transcribe price tables from a cargo carrier's PDF EXACTLY as printed, for DeciShip (invoice auditing). Accuracy of every digit matters more than anything else; the numbers are verified against the PDF text layer afterwards.
For each requested section return one table:
- zones: the zone labels of the price columns, short codes in column order ("A BÖLGESİ" → "A", "ZONE X" → "X"). Include every printed column, even if its cells are broken (e.g. "#REF!").
- rows, top to bottom, ONLY the rows of that section's table (not other tables on the same page):
  - kind "weight": an explicit weight row (label as printed, weight = the number, e.g. "10.5" → 10.5).
  - kind "additional": an "İlave 0,5 kg" / "additional 0.5 kg" row (price to add per extra step until the next explicit weight row); step = the step size (0.5); weight/from null.
  - kind "perKg": a per-kg band row ("71-99", "1000 +", under a heading like "Kg başına ücret"); from = lower bound (71), weight = upper bound (99) or null for an open band ("1000 +").
  - cells: one string per zone, in the zones order, EXACTLY as printed (e.g. "498.75", "1.234,56", "#REF!", ""); never compute, round or reformat.
  - page: the ORIGINAL page number the row is printed on (the attached PDF only contains some pages; the mapping is given in the input).
- Skip header rows, currency rows ("USD USD …"), titles and footers. If a table has a separate "Envelope" single row and a "Pak" table and only one of them is requested, return only the requested one.
- Envelope and pak sections (packaging "envelope" / "pak"): only kind "weight" rows; weight = the printed weight in the table's unit ("FedEx Pak 1,5 kg" → 1.5), or null for a single row without a weight (e.g. "FedEx Envelope", "Dosya").
countries: when "extractCountries" is true, EVERY row of the country → zone list(s) on the "countryZoneListPages" (often 200+ rows in several columns; transcribe all of them): name exactly as printed (join names broken over several lines with a single space, e.g. "AMERİKA BİRLEŞİK DEVLETLERİ"), zone = the zone code as printed, page = original page. Return an empty list only when "extractCountries" is false.
notes: short Turkish notes about anything unclear (unreadable cells, ambiguous rows). Empty if nothing.`;

export async function extractPdfSections(
  buf: Buffer,
  pageTexts: string[],
  sections: PdfSection[],
  countryPages: number[],
  ctx: AiCallContext,
): Promise<{ extraction: PdfExtraction; pages: number[] } & PdfAiMeter> {
  if (!aiEnabled()) throw aiDisabled(msg('pdf.aiOffExtract'));
  const pages = [...new Set([...sections.flatMap((s) => s.pages), ...countryPages])].sort((a, b) => a - b);
  if (pages.length > MAX_EXTRACT_PAGES) {
    throw badRequest('TOO_MANY_PAGES', msg('pdf.tooManyPages', { pages: pages.length, max: MAX_EXTRACT_PAGES }));
  }
  const sliced = await slicePdf(buf, pages, { companyId: ctx.companyId });
  const text = pages
    .map((p) => `=== Original page ${p} ===\n${pageHasText(pageTexts[p - 1]) ? pageTexts[p - 1]!.slice(0, 12000) : '(no text layer)'}`)
    .join('\n');
  const request = {
    attachedPdfPages: pages.map((p, i) => ({ attachedPage: i + 1, originalPage: p })),
    sections: sections.map((s) => ({
      sectionId: s.id,
      title: s.title,
      service: s.service,
      packaging: s.packaging,
      zones: s.zones,
      weightMin: s.weightMin,
      weightMax: s.weightMax,
      originalPages: s.pages,
      hasAdditionalStep: s.hasAdditionalStep,
      hasPerKgBands: s.hasPerKgBands,
    })),
    extractCountries: countryPages.length > 0,
    countryZoneListPages: countryPages,
  };
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: sliced.toString('base64') } },
      {
        type: 'text',
        text: `Text layer of the attached pages (use it to read digits exactly; it may be missing for scanned pages):\n<text_layer>\n${text}\n</text_layer>`,
      },
      {
        type: 'text',
        text: `Request (JSON): ${JSON.stringify(request)}\nTranscribe the requested sections${countryPages.length ? ` and EVERY country → zone row on original page(s) ${countryPages.join(', ')} (extractCountries is true)` : ''}.`,
      },
  ];
  const metered = await meteredCall(ctx, {
    schema: extractionSchema,
    system: withOutputLanguage(EXTRACT_SYSTEM),
    maxTokens: 64000,
    effort: 'low',
    content,
    cache: true,
    cacheContent: [slicedPdfKey(buf, pages), ...content.slice(1)],
  });
  return { extraction: metered.data, pages, usage: metered.usage, usageId: metered.usageId, cached: metered.cached };
}

// ---------------------------------------------------------------------------------------------
// Normalleştirme (kod) — test edilebilir saf kısım

const numKey = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const NUMBER_TOKEN = /\d[\d.,]*\d|\d/g;

/** Hücre ya da sayfa sayısının çıplak hâli: para birimi, boşluk, işaret, parantez atılır. */
const bareNumber = (s: string) => s.replace(/[^\d.,]/g, '');
const STRONG_EN = /^\d{1,3}(,\d{3})+\.\d+$/;
const STRONG_TR = /^\d{1,3}(\.\d{3})+,\d+$/;
const WEAK_EN = /^\d+\.\d{1,2}$/;
const WEAK_TR = /^\d+,\d{1,2}$/;
/** Saat ("09.00", "18:30"), tarih, yüzde: fiyat hücresinde bile kanıt sayılmaz. */
const NOT_EVIDENCE = /[:/%]|^\s*0\d[.,]\d{2}\s*$/;
/** Güçlü kanıt yokken zayıf kanıtla biçim seçmek için en az bu kadar hücre (karşı kanıt hiç yokken). */
export const NUMBER_FORMAT_MIN_WEAK = 3;

export type CellNumberFormat = {
  format: NumberFormat;
  /** Güçlü kanıtla (iki ayırıcılı sayı) ve hiç karşı kanıt olmadan seçildi: eski okumadan sapma uyarısız. */
  certain: boolean;
  strong: { en: number; tr: number };
  weak: { en: number; tr: number };
};

/**
 * Y27 (inceleme 1): sayı biçimi yalnız alınan tablonun FİYAT HÜCRELERİNDEN; sayfa metninin geneli (saat, madde no, desi
 * sütunu, tarih) kanıt değildir. Güçlü kanıt: iki ayırıcılı sayı ("1.234,56" Türkçe, "1,234.56" İngilizce). Zayıf kanıt:
 * tek ayırıcı ve ardından 1–2 hane ("12,50" / "12.50"). Kanıt değil: tek ayırıcı ve ardından tam 3 hane ("1.250", "1,125":
 * iki biçimde de geçerli), tam sayı. Karar:
 * - güçlü kanıt tek yönde ve karşı yönde hiç (güçlü ya da zayıf) kanıt yok → o biçim, `certain`;
 * - güçlü kanıt yok, zayıf kanıt tek yönde en az `NUMBER_FORMAT_MIN_WEAK` → o biçim, kesin değil;
 * - diğer her durum `auto`: eski okuma (`legacyPdfNumber`).
 * Kesin değilse eski okumadan sapan ve iki türlü okunan her hücre uyarıyla işaretlenir (`PDF_NUMBER_FORMAT_UNCLEAR`).
 */
export function cellNumberFormat(cells: Iterable<string>): CellNumberFormat {
  const strong = { en: 0, tr: 0 };
  const weak = { en: 0, tr: 0 };
  for (const c of cells) {
    if (!c || NOT_EVIDENCE.test(c)) continue;
    const b = bareNumber(c);
    if (STRONG_EN.test(b)) strong.en++;
    else if (STRONG_TR.test(b)) strong.tr++;
    else if (WEAK_EN.test(b)) weak.en++;
    else if (WEAK_TR.test(b)) weak.tr++;
  }
  let format: NumberFormat = 'auto';
  let certain = false;
  if (strong.en > 0 && strong.tr === 0 && weak.tr === 0) [format, certain] = ['en', true];
  else if (strong.tr > 0 && strong.en === 0 && weak.en === 0) [format, certain] = ['tr', true];
  else if (strong.en === 0 && strong.tr === 0) {
    if (weak.en >= NUMBER_FORMAT_MIN_WEAK && weak.tr === 0) format = 'en';
    else if (weak.tr >= NUMBER_FORMAT_MIN_WEAK && weak.en === 0) format = 'tr';
  }
  return { format, certain, strong, weak };
}

/** İki türlü okunan fiyat: ayırıcıdan sonra tam 3 hane, tam kısım 1–999 ("1,234" / "1.234"; "0,125" belirsiz değil). */
const AMBIGUOUS_NUMBER = /^[-+(]?[1-9]\d{0,2}[.,]\d{3}\)?-?$/;
export const isAmbiguousNumber = (s: string) => AMBIGUOUS_NUMBER.test(s.replace(/[^\d.,()+-]/g, ''));

/**
 * Y27 öncesi uçtan uca okuma: hücre `parseTrNumber` ile okunup tarife dosyasına `String(v)` yazılıyor, dosya onu yine
 * `parseTrNumber` ile okuyordu. Sonuç: iki türlü okunan "1,234" ve "1.234" binlik (1234), "1,125" de 1125.
 */
export function legacyPdfNumber(s: string): number | null {
  const v = parseTrNumber(s);
  if (v == null) return null;
  return parseTrNumber(String(v)) ?? v;
}

/** Seçilen biçimle sayı. `en`: "1,234" → 1234, "1.234" → 1,234. `tr`: `parseTrNumber` ("1,125" → 1,125). `auto`: eski okuma. */
export function parsePdfNumber(s: string, format: NumberFormat = 'auto'): number | null {
  if (format === 'en') return parseNumberAs(s, 'en');
  if (format === 'tr') return parseTrNumber(s);
  return legacyPdfNumber(s);
}

/**
 * Okunan fiyatın tarife dosyasına yazımı. Dosya `parseTrNumber` ile yeniden okunur: "1.125" orada binliktir (1125). Tam 3
 * ondalıklı değer virgülle yazılır ("1,125" → 1,125); diğerleri `String` (bugünkü yazım, beklentiler değişmez).
 */
export const priceCellText = (v: number) => {
  const s = String(v);
  return /^-?[1-9]\d{0,2}\.\d{3}$/.test(s) ? s.replace('.', ',') : s;
};

/**
 * Sayfa metnindeki tüm sayıların olası değerleri (ör. "498.75", "1.234,56" → "498.75", "1234.56"). Biçimden bağımsız
 * (inceleme 1, madde 4): iki türlü okunan sayının ("1,234") iki okuması da eklenir; doğrulama seçilen biçimle döngüsel
 * olmasın. Biçim hatasını doğrulama değil hücre uyarısı yakalar.
 */
export function numbersOnPage(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    const v = parseTrNumber(m[0]);
    if (v != null) out.add(numKey(v));
    if (isAmbiguousNumber(m[0])) {
      const other = parseTrNumber(m[0].includes(',') ? m[0].replace(',', '') : m[0].replace('.', ','));
      if (other != null) out.add(numKey(other));
    }
  }
  return out;
}

/** Sayfa metnindeki ham sayı dizileri ("1,234", "45.20"): hücrenin basılı hâli birebir aranır. */
function tokensOnPage(text: string): Set<string> {
  return new Set([...text.matchAll(NUMBER_TOKEN)].map((m) => m[0]));
}

// ---------------------------------------------------------------------------------------------
// 05-B11: fiyatın yeri. Metin katmanında bir satır, pdfjs'in satır sonuyla (`hasEOL`) ayrılan, aynı yükseklikteki parçalardır.

/** `keys`: olası bütün değerler; `label`: etikete benzer sayının ("5", "0,5", "1000") tek değeri, diğerinde null. */
type LineToken = { raw: string; keys: Set<string>; label: string | null };
type PlacedCell = { raw: string; key: string };
export type RowPlacement = 'ok' | 'misplaced' | 'swapped' | null;

const LABEL_LIKE = /^\d{1,4}(?:[.,]\d{1,2})?$/;

/** Sayfa metninin satırları, her satırın sayıları (basılı hâli + olası değerleri); sayısız satır atlanır. */
function lineTokens(text: string): LineToken[][] {
  return text
    .split('\n')
    .map((l) =>
      [...l.matchAll(NUMBER_TOKEN)].map((m) => ({
        raw: m[0],
        keys: numbersOnPage(m[0]),
        label: LABEL_LIKE.test(m[0]) ? numKey(Number(m[0].replace(',', '.'))) : null,
      })),
    )
    .filter((l) => l.length > 0);
}

const tokenIs = (t: LineToken, c: PlacedCell) => t.raw === c.raw || t.keys.has(c.key);
/** kendi etiketi: geniş (her okuma); başka satırın etiketi: dar (yalnız etikete benzer sayı). İkisi de yanlış alarmı azaltır. */
const tokenIn = (t: LineToken, keys: Set<string>) => [...t.keys].some((k) => keys.has(k));
const tokenLabelIn = (t: LineToken, keys: Set<string>) => t.label != null && keys.has(t.label);

/**
 * Bir fiyat satırının (bütün hücreleri sayfada bulunmuş) metindeki yeri:
 * - `ok`: hücreler bir satırda sırayla geçiyor ve o satırda kendi etiketi (ağırlık, bant sınırı) var;
 * - `misplaced`: hücreler bir satırda sırayla geçiyor ama o satırda kendi etiketi yok, tablonun başka bir satırının etiketi
 *   var (satır kayması: 5 kg'ın fiyatı 5,5 kg'a yazılmış);
 * - `swapped`: hücrelerin hepsi kendi etiketli satırında var ama sırası başka (iki bölgenin sütunu karışmış);
 * - `null`: denetlenemez (hücreler tek satırda değil: sütun sütun çizilmiş tablo, ağırlıklar sütunda, satıra bölünmüş
 *   hücre; ya da satırda etiket yok). Eski davranış: yalnız "sayfada var" denetimi.
 * Bir satır bile `ok` ise sonuç `ok` (aynı fiyatlar sayfada başka yerde de geçebilir).
 */
export function rowPlacement(lines: LineToken[][], cells: PlacedCell[], own: Set<string>, others: Set<string>): RowPlacement {
  if (!cells.length || !own.size) return null;
  let misplaced = false;
  let swapped = false;
  for (const line of lines) {
    if (line.length <= cells.length) continue;
    let ordered = false;
    for (let j = 0; j < line.length; j++) {
      if (!tokenIs(line[j]!, cells[0]!)) continue;
      const used = new Set([j]);
      let ci = 1;
      for (let k = j + 1; ci < cells.length && k < line.length; k++) {
        if (tokenIs(line[k]!, cells[ci]!)) {
          used.add(k);
          ci++;
        }
      }
      // en soldan açgözlü eşleme yetmediyse daha sağdan başlayan da yetmez
      if (ci < cells.length) break;
      ordered = true;
      const rest = line.filter((_, x) => !used.has(x));
      if (rest.some((t) => tokenIn(t, own))) return 'ok';
      if (rest.some((t) => tokenLabelIn(t, others))) misplaced = true;
    }
    if (ordered || cells.length < 2) continue;
    const used = new Set<number>();
    const all = cells.every((c) => {
      const x = line.findIndex((t, k) => !used.has(k) && tokenIs(t, c));
      if (x < 0) return false;
      used.add(x);
      return true;
    });
    if (all && line.some((t, k) => !used.has(k) && tokenIn(t, own))) swapped = true;
  }
  return misplaced ? 'misplaced' : swapped ? 'swapped' : null;
}

/** Gösterim için ondalık hane: en çok 3 ("1,125" görünsün, "1.234,00" değil). */
const decimalsOf = (v: number) => Math.min(3, (String(v).split('.')[1] ?? '').length);

const fmtW = (n: number) => String(n).replace('.', ',');

export type BuildInput = {
  fileName: string;
  extraction: PdfExtraction;
  sections: PdfSection[];
  document: PdfDocumentFacts;
  pageTexts: string[];
  includeCountryZones: boolean;
  /** mevcut tarifenin bölen/para birimi (uyarılar için; yeni tarifede null) */
  current: { divisor: number; currency: string } | null;
  /** kodla taranmış bölümler: değerler metin katmanından alındığı için doğrulama kendiliğinden tamdır */
  codeSectionIds?: Set<string>;
  /** mevcut tarifenin ülke eşlemesi (ülke listesi alınmadığında düşen bölge kontrolü için) */
  currentZones?: { country: string; zone: string }[];
};

export type BuildResult = {
  raw: RawTariffFile;
  /** bölüm başlıkları; bölge aralığı alınan sütunlara göre ("Avrupa (R–X)" → X alınmadıysa "Avrupa (R–S)") */
  sectionTitles: string[];
  issues: ImportIssue[];
  verification: PdfDraftInfo['verification'];
  suggestedMeta: PdfDraftInfo['suggestedMeta'];
  priceType: PdfDraftInfo['priceType'];
};

/**
 * Başlıktaki "(R–X)" bölge aralığını alınan sütunlara göre yazar. Yalnız aralık tablonun ilk/son bölgesiyle
 * birebir eşleşiyorsa değiştirir (başka biçimdeki başlıklara dokunmaz).
 */
export function titleWithZones(title: string, all: string[], kept: string[]): string {
  if (all.length < 2 || !kept.length || kept.length === all.length) return title;
  const m = /\(([^()–]+)–([^()–]+)\)/.exec(title);
  if (!m || zoneKey(m[1]!) !== zoneKey(all[0]!) || zoneKey(m[2]!) !== zoneKey(all[all.length - 1]!)) return title;
  const range = kept.length > 1 ? `(${kept[0]}–${kept[kept.length - 1]})` : `(${kept[0]})`;
  return title.replace(m[0], range);
}

/** Çıkarılan ham tabloları DeciShip tablo biçimine çevirir; ülke adları ISO-2'ye; metin katmanıyla doğrular. */
export function buildPdfImport(i: BuildInput): BuildResult {
  const issues: ImportIssue[] = [];
  const unit = i.document.weightUnit === 'lb' ? 'lb' : 'kg';
  const currency = (i.document.currency ?? i.sections.find((s) => s.currency)?.currency ?? '').toUpperCase();
  const byId = new Map(i.sections.map((s) => [s.id, s]));
  const tables = i.extraction.tables.filter((t) => byId.has(t.sectionId));
  const missing = i.sections.filter((s) => !tables.some((t) => t.sectionId === s.id));
  if (missing.length) {
    issues.push({
      severity: 'warning',
      code: 'PDF_SECTION_MISSING',
      title: msg('pdf.sectionsMissing', { count: missing.length }),
      detail: missing.map((s) => `"${s.title}"`).join(', '),
      suggestion: msg('pdf.sectionsMissing.fix'),
    });
  }

  // sütunlar: bölge → okunabilir mi
  type Col = { zone: string; key: string };
  const columns: Col[] = [];
  const dropped = new Map<string, { zone: string; samples: Set<string>; section: string }>();
  const unreadable: { zone: string; label: string; text: string }[] = [];
  const matrixRows: string[][] = [];
  const verifyItems: { zone: string; weight: number; price: number; raw: string; pages: number[]; page: number | null; code: boolean }[] = [];
  const codeIds = i.codeSectionIds ?? new Set<string>();
  // 05-B11: yer denetimi girdisi. Yalnız yapay zekâ bölümlerinin ağırlık ve kg başı satırları (ilave satırının etiketi
  // basılı hâliyle çok değişken: "her ilave 0,5 kg", "(31-70 kg)"); `own` satırın etiket sayıları, `labels` tablonunkiler.
  const posRows: { table: number; own: Set<string>; items: number[] }[] = [];
  const tableLabels: Set<string>[] = [];
  const pageCount = i.pageTexts.length;
  // Y27: sayı biçimi belgenin metninden; hücreler ve doğrulama aynı biçimle okunur
  // Y27: sayı biçimi yalnız alınan tabloların fiyat hücrelerinden (`cellNumberFormat`); doğrulama biçimden bağımsız
  const numberFormat = cellNumberFormat(tables.flatMap((t) => t.rows.flatMap((r) => r.cells)));
  const num = (s: string) => parsePdfNumber(s, numberFormat.format);
  const ambiguous: { zone: string; label: string; text: string; value: number }[] = [];
  // K36: ağırlık etiketi "1.500" (nokta + tam 3 hane) 1,5 kg da 1500 kg da olabilir; biçim kesin değilse okunan değer sorulur
  const ambiguousWeights: { label: string; value: number }[] = [];
  // Belgenin ülke listesindeki bölgeler (ülke listesi alınıyorsa). Listede hiç ülkesi olmayan fiyat sütunu
  // kullanılamaz; FedEx PDF'lerinde bu, görünmeyen artık sütundur ("ZONE X": gizli, anlamsız sayılar) → alınmaz.
  const listZones =
    i.includeCountryZones && i.extraction.countries.length
      ? new Set(i.extraction.countries.filter((c) => countryNameToIso2(c.name.replace(/\s+/g, ' ').trim())).map((c) => zoneKey(cleanZoneLabel(c.zone))))
      : null;
  const orphans = new Map<string, string>();

  const tableZones = tables.map((t) => {
    const sec = byId.get(t.sectionId)!;
    const zones = (t.zones.length ? t.zones : sec.zones).map((z) => cleanZoneLabel(z));
    // kural yalnız tablonun bölge adları listeyle örtüşüyorsa (en az 2 sütun) uygulanır; adlandırma farklıysa dokunulmaz
    const orphanRule = !!listZones && zones.filter((z) => z && listZones.has(zoneKey(z))).length >= 2;
    const keep = zones.map((z, ci) => {
      const cells = t.rows.map((r) => (r.cells[ci] ?? '').trim()).filter((c) => c !== '' && c !== '-' && c !== '—');
      const bad = cells.filter((c) => num(c) == null);
      if (cells.length && bad.length / cells.length > 0.5) {
        const k = zoneKey(z);
        const d = dropped.get(k) ?? { zone: z, samples: new Set<string>(), section: sec.title };
        bad.slice(0, 2).forEach((b) => d.samples.add(b));
        dropped.set(k, d);
        return false;
      }
      if (z && orphanRule && !listZones!.has(zoneKey(z))) {
        orphans.set(zoneKey(z), z);
        return false;
      }
      return !!z;
    });
    for (let ci = 0; ci < zones.length; ci++) {
      if (!keep[ci]) continue;
      const k = zoneKey(zones[ci]!);
      if (!columns.some((c) => c.key === k)) columns.push({ zone: zones[ci]!, key: k });
    }
    return { t, sec, zones, keep };
  });

  for (const [ti, { t, sec, zones, keep }] of tableZones.entries()) {
    /** Bölümün ambalajı: poşet / zarf bölümünün satırları ambalaj etiketiyle yazılır. */
    const pack = sec.packaging === 'pak' ? ('PAK' as const) : sec.packaging === 'envelope' ? ('ENVELOPE' as const) : null;
    const labels = new Set<string>();
    tableLabels[ti] = labels;
    for (const r of t.rows) {
      let label: string;
      let weightForReport: number;
      // Okunan değer (r.weight; açık uçta r.from) etiketteki iki türlü yazımın okumalarından biriyse uyarılır: değer o yazımdan
      // gelmiştir ("1.500 KGS" de: ağırlığı yapay zekâ ya da kod taraması `parseWeightLabel` birim ekiyle okur). Etiketin başka
      // bir sayısından okunan değer uyarılmaz.
      const value = r.weight ?? r.from;
      const fromAmbiguous = (tok: string) => {
        const w = ambiguousWeightText(tok, 'any');
        return !!w && value != null && (Math.abs(w.decimal - value) < 1e-9 || Math.abs(w.thousands - value) < 1e-9);
      };
      if (r.kind !== 'additional' && !numberFormat.certain && value != null && (r.label.match(/\d[\d.,]*\d|\d/g) ?? []).some(fromAmbiguous)) {
        ambiguousWeights.push({ label: r.label.slice(0, 30), value });
      }
      if (pack && r.kind !== 'weight') {
        // Poşet / zarf tablosunda yalnız tek ağırlık satırları alınır (ilave ve kg başı satırı koli tablosunundur)
        continue;
      } else if (r.kind === 'weight') {
        if (pack && r.weight == null) {
          // ağırlık yazmayan zarf satırı ("FedEx Envelope", "Dosya"): her ağırlıkta tek fiyat (taşıyıcının sınırına kadar)
          label = packagingRowLabel(pack, null);
          weightForReport = 0;
        } else {
          if (r.weight == null || !(r.weight > 0)) continue;
          // Poşet / zarf satırı içe aktarmada ayrı fiyat listesine gider (core `parsePackagingLabel` aynı etiketi okur)
          label = pack ? packagingRowLabel(pack, fmtW(r.weight)) : fmtW(r.weight);
          weightForReport = r.weight;
        }
      } else if (r.kind === 'additional') {
        const step = r.step ?? num(r.label.match(/\d+(?:[.,]\d+)?/)?.[0] ?? '') ?? 0.5;
        label = `İlave ${fmtW(step)} ${unit}`;
        weightForReport = step;
      } else {
        const from = r.from ?? null;
        if (r.weight == null && from == null) continue;
        // "kg başı" işareti birim değil, bant işaretidir (lb tablolarında lb→kg seçeneği fiyatı çevirir)
        label = r.weight == null ? `${fmtW(from!)}+ kg başı` : `${fmtW(from ?? r.weight)}-${fmtW(r.weight)} kg başı`;
        weightForReport = r.weight ?? from!;
      }
      const row = [label, ...columns.map(() => '')];
      const page = r.page != null && r.page >= 1 && r.page <= pageCount ? Math.round(r.page) : null;
      let pos: (typeof posRows)[number] | null = null;
      if (r.kind !== 'additional' && !codeIds.has(sec.id)) {
        const own = numbersOnPage(r.label);
        for (const v of [r.weight, r.from]) if (v != null && Number.isFinite(v)) own.add(numKey(v));
        own.forEach((k) => labels.add(k));
        if (own.size) {
          pos = { table: ti, own, items: [] };
          posRows.push(pos);
        }
      }
      for (let ci = 0; ci < zones.length; ci++) {
        if (!keep[ci]) continue;
        const cell = (r.cells[ci] ?? '').trim();
        if (cell === '' || cell === '-' || cell === '—') continue;
        const v = num(cell);
        const colIdx = columns.findIndex((c) => c.key === zoneKey(zones[ci]!));
        if (v == null) {
          unreadable.push({ zone: zones[ci]!, label: r.label, text: cell.slice(0, 20) });
          continue;
        }
        // biçim belgeden anlaşılamadıysa "1,234" bugünkü kuralla okunur ama sessiz kalmaz (Y27)
        // Biçim kesin değilse: iki türlü okunan ya da eski okumadan sapan fiyat asla sessiz kalmaz (Y27)
        if (!numberFormat.certain && (isAmbiguousNumber(cell) || legacyPdfNumber(cell) !== v)) {
          ambiguous.push({ zone: zones[ci]!, label: r.label, text: cell.slice(0, 20), value: v });
        }
        row[colIdx + 1] = priceCellText(v);
        verifyItems.push({ zone: zones[ci]!, weight: weightForReport, price: v, raw: bareNumber(cell), pages: page ? [page] : sec.pages, page, code: codeIds.has(sec.id) });
        pos?.items.push(verifyItems.length - 1);
      }
      matrixRows.push(row);
    }
  }

  if (unreadable.length) {
    issues.push({
      severity: 'warning',
      code: 'PDF_CELLS_UNREADABLE',
      title: msg('pdf.cellsUnreadable', { count: unreadable.length }),
      detail: unreadable
        .slice(0, 6)
        .map((u) => msg('pdf.zoneCell', { zone: u.zone, label: u.label, text: u.text }))
        .join('; '),
    });
  }
  if (ambiguous.length) {
    issues.push({
      severity: 'warning',
      code: 'PDF_NUMBER_FORMAT_UNCLEAR',
      title: msg('pdf.numberFormatUnclear', { count: ambiguous.length }),
      detail: ambiguous
        .slice(0, 6)
        .map((u) => msg('pdf.numberFormatUnclear.item', { zone: u.zone, label: u.label, text: u.text, value: fmtNumber(u.value, decimalsOf(u.value), currentLocale()) }))
        .join('; '),
      suggestion: msg('pdf.numberFormatUnclear.fix'),
    });
  }

  if (ambiguousWeights.length) {
    issues.push({
      severity: 'warning',
      code: 'PDF_WEIGHT_FORMAT_UNCLEAR',
      title: msg('pdf.weightFormatUnclear', { count: ambiguousWeights.length }),
      detail: ambiguousWeights
        .slice(0, 6)
        .map((u) => msg('pdf.weightFormatUnclear.item', { label: u.label, value: fmtNumber(u.value, decimalsOf(u.value), currentLocale()) }))
        .join('; '),
      suggestion: msg('pdf.weightFormatUnclear.fix'),
    });
  }

  // doğrulama: her fiyat, belirtilen sayfanın metin katmanında geçiyor mu? (kod taraması: kendiliğinden eşleşir)
  const pageNums = new Map<number, Set<string>>();
  const numsOf = (p: number) => {
    let s = pageNums.get(p);
    if (!s) {
      s = numbersOnPage(i.pageTexts[p - 1] ?? '');
      pageNums.set(p, s);
    }
    return s;
  };
  const pageTokens = new Map<number, Set<string>>();
  const tokensOf = (p: number) => {
    let s = pageTokens.get(p);
    if (!s) {
      s = tokensOnPage(i.pageTexts[p - 1] ?? '');
      pageTokens.set(p, s);
    }
    return s;
  };
  const allCode = tables.length > 0 && tables.every((t) => codeIds.has(t.sectionId));
  const verifiable = verifyItems.filter((v) => v.code || v.pages.some((p) => pageHasText(i.pageTexts[p - 1])));
  let verification: BuildResult['verification'] = null;
  if (verifyItems.length && !verifiable.length) {
    issues.push({
      severity: 'warning',
      code: 'PDF_SCANNED',
      title: msg('pdf.scanned'),
      detail: msg('pdf.scanned.detail'),
      suggestion: msg('pdf.scanned.fix'),
    });
  } else if (verifiable.length) {
    // basılı hâl birebir ya da (yapay zekâ biçimi değiştirdiyse) değer; ikisi de biçimden bağımsız
    const unmatched = verifiable.filter((v) => !v.code && !v.pages.some((p) => tokensOf(p).has(v.raw) || numsOf(p).has(numKey(v.price))));
    // 05-B11: bütün hücreleri sayfada bulunan satır, metinde başka bir ağırlığın satırında ya da başka sırada mı?
    const notFound = new Set(unmatched);
    const pageLines = new Map<number, LineToken[][]>();
    const linesOf = (p: number) => {
      let l = pageLines.get(p);
      if (!l) {
        l = lineTokens(i.pageTexts[p - 1] ?? '');
        pageLines.set(p, l);
      }
      return l;
    };
    const misplaced: typeof verifiable = [];
    for (const pr of posRows) {
      const items = pr.items.map((x) => verifyItems[x]!);
      if (items.length < 2 || items.some((v) => notFound.has(v) || !v.pages.some((p) => pageHasText(i.pageTexts[p - 1])))) continue;
      const others = new Set([...tableLabels[pr.table]!].filter((k) => !pr.own.has(k)));
      const lines = items[0]!.pages.flatMap((p) => linesOf(p));
      const placed = rowPlacement(lines, items.map((v) => ({ raw: v.raw, key: numKey(v.price) })), pr.own, others);
      if (placed === 'misplaced' || placed === 'swapped') misplaced.push(...items);
    }
    verification = {
      method: allCode ? 'code' : 'ai',
      checked: verifiable.length,
      matched: verifiable.length - unmatched.length - misplaced.length,
      unmatched: [...unmatched, ...misplaced].slice(0, 50).map((u) => ({ zone: u.zone, weight: u.weight, price: u.price, page: u.page })),
    };
    const itemText = (u: (typeof verifiable)[number]) => {
      const item = { zone: u.zone, weight: fmtNumber(u.weight, 2, currentLocale()), unit, price: fmtNumber(u.price, 2, currentLocale()) };
      return u.page ? msg('pdf.unmatched.itemPage', { ...item, page: u.page }) : msg('pdf.unmatched.item', item);
    };
    const ratio = unmatched.length / verifiable.length;
    if (unmatched.length) {
      issues.push({
        severity: ratio > 0.02 ? 'error' : 'warning',
        code: 'PDF_VALUES_UNVERIFIED',
        title: msg('pdf.unmatched', { count: unmatched.length, total: verifiable.length }),
        detail: unmatched.slice(0, 6).map(itemText).join('; '),
        suggestion:
          ratio > 0.02
            ? msg('pdf.unmatched.fixUnreliable')
            : msg('pdf.unmatched.fix'),
      });
    }
    if (misplaced.length) {
      // uyarı (onayla kaydedilir), hata değil: yerleşimi alışılmadık PDF'te yanlış alarm kaydı kilitlemesin
      issues.push({
        severity: 'warning',
        code: 'PDF_VALUES_MISPLACED',
        title: msg('pdf.misplaced', { count: misplaced.length, total: verifiable.length }),
        detail: misplaced.slice(0, 6).map(itemText).join('; '),
        suggestion: msg('pdf.misplaced.fix'),
      });
    }
    if (verifiable.length < verifyItems.length) {
      issues.push({
        severity: 'warning',
        code: 'PDF_SCANNED',
        title: msg('pdf.scannedPrices', { count: verifyItems.length - verifiable.length }),
      });
    }
  }

  // ülke → bölge
  let zonesSheet: string[][] | null = null;
  const infoParts: string[] = [];
  const mappedZones = new Set<string>();
  if (i.includeCountryZones) {
    const priceKeys = new Set(columns.map((c) => c.key));
    const seen = new Map<string, string>();
    const unknown: string[] = [];
    const conflicts: string[] = [];
    const omitted = new Map<string, string[]>();
    for (const c of i.extraction.countries) {
      const zone = cleanZoneLabel(c.zone);
      const name = c.name.replace(/\s+/g, ' ').trim();
      if (!name || !zone) continue;
      const iso = countryNameToIso2(name);
      if (!iso) {
        unknown.push(name);
        continue;
      }
      mappedZones.add(zoneKey(zone));
      if (!priceKeys.has(zoneKey(zone))) {
        omitted.set(zone, [...(omitted.get(zone) ?? []), iso]);
        continue;
      }
      const prev = seen.get(iso);
      if (prev != null) {
        if (zoneKey(prev) !== zoneKey(zone)) conflicts.push(`${name} (${iso}): ${prev} / ${zone}`);
        continue;
      }
      seen.set(iso, zone);
    }
    if (!i.extraction.countries.length) {
      issues.push({
        severity: 'warning',
        code: 'PDF_NO_COUNTRIES',
        title: msg('pdf.noCountryList'),
        suggestion: msg('pdf.noCountryList.fix'),
      });
    } else {
      zonesSheet = [['Ülke kodu', 'Bölge'], ...[...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, z]) => [c, z])];
    }
    if (unknown.length) {
      infoParts.push(msg('pdf.unknownCountries', { count: unknown.length, list: `${unknown.slice(0, 8).map((u) => `"${u}"`).join(', ')}${unknown.length > 8 ? ' …' : ''}` }));
    }
    if (conflicts.length) {
      issues.push({
        severity: 'warning',
        code: 'PDF_COUNTRY_CONFLICT',
        title: msg('pdf.countryConflicts', { count: conflicts.length }),
        detail: conflicts.slice(0, 10).join('; '),
      });
    }
    if (omitted.size) {
      const total = [...omitted.values()].reduce((n, l) => n + l.length, 0);
      infoParts.push(
        msg('pdf.omittedCountries', { count: total, list: [...omitted.entries()].map(([z, l]) => `${z}: ${l.slice(0, 6).join(', ')}${l.length > 6 ? ' …' : ''}`).join('; ') }),
      );
    }
  } else {
    for (const z of i.currentZones ?? []) mappedZones.add(zoneKey(z.zone));
  }

  // tek bölgeli yurt içi liste ("Desi | Ücret"): tüm gönderiler bu bölgeye (`*`). Mevcut tarifenin `*` bölgesi
  // varsa fiyatlar onun adıyla yazılır (eşleme değişmez); tarifede hiç eşleme yoksa `*` → bölge eklenir.
  if (!zonesSheet && columns.length === 1 && tables.length && i.sections.every((s) => s.direction === 'domestic' && s.zones.length === 1)) {
    const cur = i.currentZones ?? [];
    const star = cur.find((z) => z.country === '*');
    if (star) columns[0]!.zone = star.zone;
    else if (!cur.length) {
      zonesSheet = [['Ülke kodu', 'Bölge'], ['*', columns[0]!.zone]];
      infoParts.push(msg('pdf.singleColumn', { zone: columns[0]!.zone }));
    }
  }

  if (dropped.size) {
    const list = [...dropped.values()];
    const used = list.filter((d) => mappedZones.has(zoneKey(d.zone)));
    const text = list.map((d) => msg('pdf.brokenZoneCells', { zone: d.zone, section: d.section, samples: [...d.samples].map((x) => `"${x}"`).join(', ') })).join('; ');
    if (used.length) {
      issues.push({
        severity: 'warning',
        code: 'PDF_COLUMN_DROPPED',
        title: msg('pdf.brokenZones', { zones: used.map((d) => d.zone).join(', ') }),
        detail: text,
        suggestion: msg('pdf.brokenZones.fix'),
      });
    } else {
      infoParts.push(msg('pdf.brokenUnused', { zones: list.map((d) => d.zone).join(', ') }));
    }
  }
  const orphanList = [...orphans.entries()].filter(([k]) => !dropped.has(k)).map(([, z]) => z);
  if (orphanList.length) {
    infoParts.push(msg('pdf.orphanColumns', { zones: orphanList.join(', ') }));
  }

  // belge bilgileri (uygulamada tarifeye otomatik yazılır; bkz. analyze → PDF_SETTINGS)
  const suggestedMeta: BuildResult['suggestedMeta'] = {};
  const priceTypes = [...new Set(i.sections.map((s) => s.priceType))];
  const priceType: BuildResult['priceType'] = priceTypes.length === 1 ? priceTypes[0]! : 'unknown';
  if (i.document.fuel.kind === 'FIXED_PCT' && i.document.fuel.pct != null && i.document.fuel.pct >= 0 && i.document.fuel.pct <= 100) {
    suggestedMeta.fuelPct = i.document.fuel.pct;
  } else if (i.document.fuel.kind === 'INDEXED') {
    infoParts.push(msg('pdf.fuelIndexed'));
  }
  if (i.document.validFrom) suggestedMeta.validFrom = i.document.validFrom;
  if (currency && /^[A-Z]{3}$/.test(currency)) suggestedMeta.currency = currency;
  if (i.document.dimDivisor) suggestedMeta.divisor = i.document.dimDivisor;
  // seçilen tabloların tek bir hizmeti varsa (ör. "FedEx Regional Economy (RE)") tarifenin hizmet adı olarak önerilir
  const services = [...new Set(i.sections.map((s) => s.service?.replace(/®|™/g, '').replace(/\s+/g, ' ').trim()).filter((x): x is string => !!x))];
  if (services.length === 1 && services[0]!.length <= 200) suggestedMeta.service = services[0];
  if (priceType === 'net') suggestedMeta.discountPct = 0;
  if (priceType === 'list') {
    infoParts.push(
      i.document.discountPages.length
        ? msg('pdf.listPricesPages', { pages: i.document.discountPages.join(', ') })
        : msg('pdf.listPrices'),
    );
  }
  if (i.document.surchargeNotes.length) infoParts.push(msg('pdf.surchargeNotes', { notes: i.document.surchargeNotes.slice(0, 4).map((n) => localizeText(n, currentLocale())).join('; ') }));
  if (i.extraction.notes.length) infoParts.push(msg('pdf.readNotes', { notes: i.extraction.notes.slice(0, 4).map((n) => localizeText(n, currentLocale())).join('; ') }));
  if (infoParts.length) {
    issues.push({
      severity: 'info',
      code: 'PDF_NOTES',
      title: msg('pdf.docNotes'),
      detail: infoParts.map((t) => t.charAt(0).toLocaleUpperCase(currentLocale()) + t.slice(1)).join('. ') + '.',
    });
  }

  // başlıktaki bölge aralığı yalnız alınan sütunları söyler (alınmayan/bozuk sütun "Avrupa (R–X)" demesin)
  const titles = i.sections.map((s) => {
    const own = tableZones.filter((x) => x.sec.id === s.id);
    if (!own.length) return s.title;
    const all = own[0]!.zones;
    const keptKeys = new Set(own.flatMap((x) => x.zones.filter((_, ci) => x.keep[ci]).map((z) => zoneKey(z))));
    const kept = all.filter((z) => keptKeys.has(zoneKey(z)));
    return titleWithZones(s.title, all, kept);
  });
  const header = [`Ağırlık (${unit})`, ...columns.map((c) => c.zone)];
  const prices: string[][] = [
    [`${i.document.carrier ?? ''} ${titles.join(' + ')}${currency ? ` — fiyatlar ${currency}` : ''}`.trim()],
    header,
    ...matrixRows,
  ];
  return {
    raw: { fileName: i.fileName, kind: 'pdf', prices, pricesSheetName: null, zones: zonesSheet, surcharges: null },
    sectionTitles: titles,
    issues,
    verification,
    suggestedMeta,
    priceType,
  };
}

// ---------------------------------------------------------------------------------------------
// Liste fiyatı × indirim tablosu (FedEx sözleşmesi s. 2: kesin hesap)

type StoredSection = StoredScan['sections'][number];

/** Kod taramasındaki bölümler için liste × indirim bağlantıları (tablosu olmayan yapay zekâ bölümleri hariç). */
export function listDiscountLinks(scan: StoredScan | undefined): Map<string, PdfListDiscountLink> {
  if (!scan || scan.mode !== 'code' || !scan.discountTables?.length) return new Map();
  return linkListDiscounts(scan.sections, scan.discountTables);
}

const pagesLabel = (p: number[]) => {
  const s = [...new Set(p)].sort((a, b) => a - b);
  return s.length > 1 && s[s.length - 1]! - s[0]! === s.length - 1 ? `${s[0]}–${s[s.length - 1]}` : s.join(', ');
};

/**
 * `pricing: 'listDiscount'`: seçilen her kod bölümünü (net tablo ya da liste tablosu) karşılık gelen liste bölümü ×
 * indirim tablosuyla hesaplanmış net bölüme çevirir. Karşılığı olmayan bölüm tablodaki fiyatla kalır (bilgi notu).
 * İndirimi olmayan hücrelere sayı yazılmaz (uyarı); tamamen indirimsiz bölge sütunu mevcut "#REF!" kuralıyla düşer.
 */
export function applyListDiscountSelection(
  selected: StoredSection[],
  scan: StoredScan | undefined,
): { sections: StoredSection[]; issues: ImportIssue[]; applied: number } {
  const links = listDiscountLinks(scan);
  const out: StoredSection[] = [];
  const issues: ImportIssue[] = [];
  const notes: string[] = [];
  const kept: string[] = [];
  const missing: { title: string; zone: string; label: string; band: string | null; text: string }[] = [];
  const noDiscountZones = new Map<string, string>();
  let applied = 0;
  let compared = 0;
  let differing = 0;
  let maxDiff = 0;
  const seen = new Set<string>();
  for (const s of selected) {
    const link = s.id.startsWith('c') ? links.get(s.id) : undefined;
    const list = link ? scan!.sections.find((x) => x.id === link.listSectionId) : undefined;
    const disc = link ? scan!.discountTables!.find((d) => d.id === link.discountTableId) : undefined;
    if (!link || !list?.table || !disc) {
      out.push(s);
      if (s.id.startsWith('c')) kept.push(s.title);
      continue;
    }
    if (link.diff) {
      compared += link.diff.compared;
      differing += link.diff.differing;
      maxDiff = Math.max(maxDiff, link.diff.maxDiff);
    }
    if (seen.has(list.id)) continue;
    seen.add(list.id);
    const r = applyListDiscount({ zones: list.zones, table: list.table }, disc);
    applied++;
    const title = list.title.replace(/\s*·\s*liste$/, '') + ' · liste × indirim';
    out.push({ ...list, priceType: 'net', title, table: { ...r.table, sectionId: list.id }, notes: list.notes });
    for (const z of r.zonesWithoutDiscount) noDiscountZones.set(zoneKey(z), z);
    const full = new Set(r.zonesWithoutDiscount.map((z) => zoneKey(z)));
    for (const m of r.missing) if (!full.has(zoneKey(m.zone))) missing.push({ title, ...m });
    notes.push(
      msg('pdf.discount.link', { title: title.split(' · ').slice(0, 2).join(' · '), listPages: pagesLabel(list.pages), discount: disc.title, discountPages: pagesLabel(disc.pages), bands: r.bands.length }),
    );
  }
  if (applied) {
    const parts = [
      msg('pdf.discount.method'),
      notes.join('; '),
      msg('pdf.discount.steps'),
    ];
    if (compared) {
      parts.push(
        differing
          ? msg('pdf.discount.diff', { compared: fmtNumber(compared, 0, currentLocale()), differing: fmtNumber(differing, 0, currentLocale()), max: fmtNumber(maxDiff, 2, currentLocale()) })
          : msg('pdf.discount.same', { compared: fmtNumber(compared, 0, currentLocale()) }),
      );
    }
    if (noDiscountZones.size) {
      parts.push(msg('pdf.discount.noRate', { zones: [...noDiscountZones.values()].join(', ') }));
    }
    issues.push({ severity: 'info', code: 'PDF_LIST_DISCOUNT', title: msg('pdf.discount.title'), detail: parts.join('. ') + '.' });
  }
  if (missing.length) {
    issues.push({
      severity: 'warning',
      code: 'PDF_DISCOUNT_MISSING',
      title: msg('pdf.discount.missing', { count: fmtNumber(missing.length, 0, currentLocale()) }),
      detail: missing
        .slice(0, 6)
        .map((x) => (x.band ? msg('pdf.discount.missingItemBand', { zone: x.zone, label: x.label, band: x.band, text: x.text }) : msg('pdf.discount.missingItem', { zone: x.zone, label: x.label, text: x.text })))
        .join('; '),
      suggestion: msg('pdf.discount.missing.fix'),
    });
  }
  if (kept.length) {
    issues.push({
      severity: 'info',
      code: 'PDF_LIST_DISCOUNT',
      title: applied ? msg('pdf.discount.keptSome') : msg('pdf.discount.keptAll'),
      detail: msg('pdf.discount.kept.detail', { tables: kept.map((t) => `"${t}"`).join(', ') }),
    });
  }
  return { sections: out, issues, applied };
}

// ---------------------------------------------------------------------------------------------
// Belge kaydı / temizlik

export async function cleanupDocuments() {
  const old = await prisma.tariffDocument.findMany({
    where: { createdAt: { lt: new Date(Date.now() - DOCUMENT_TTL_MS) } },
    select: { id: true, path: true },
    take: 200,
  });
  for (const d of old) await fs.rm(absolutePath(d.path), { force: true }).catch(() => undefined);
  if (old.length) await prisma.tariffDocument.deleteMany({ where: { id: { in: old.map((d) => d.id) } } });
}

export async function loadDocument(id: string, companyId: string) {
  const d = await prisma.tariffDocument.findFirst({
    where: { id, companyId, createdAt: { gte: new Date(Date.now() - DOCUMENT_TTL_MS) } },
  });
  if (!d) throw new AppError(404, 'NOT_FOUND', msg('pdf.notFound'));
  return d;
}
