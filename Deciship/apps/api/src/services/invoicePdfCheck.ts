/**
 * Mesaj 5 (04-B12): yapay zekâyla okunan PDF fatura satırları PDF'in kendi metin katmanıyla karşılaştırılır.
 *
 * Takip no ya da tutar metinde bulunamazsa satır `PDF_TRACKING_UNVERIFIED` / `PDF_AMOUNT_UNVERIFIED` bayrağı alır
 * (sert bayrak: "Kontrol edilecek / İncele"). Mesaj 5 (05-B4): ağırlık, ölçü ve ek ücret de (`PDF_WEIGHT_UNVERIFIED`,
 * `PDF_DIMS_UNVERIFIED`, `PDF_SURCHARGE_UNVERIFIED`); 05-B2: satır penceresinde KDV kuralı ve satır toplamının fatura
 * toplamıyla karşılaştırılması (`pdfTotalsCheck`). Kullanıcı kararı: fatura yine de yüklenir; PDF için onay kapısı yoktur.
 * Metin katmanı yoksa (taranmış belge) ya da okunamazsa denetim `none` olur ve hiçbir satır işaretlenmez.
 *
 * Kural motorda (`checkPdfLines`); burası yalnız dosyayı okur, sonucu API'nin biçimine çevirir ve önizlemenin kaydını
 * (`File.preview`: sayfa metni, takip no'suz satırlar) okur ve yazar.
 */
import {
  checkPdfLines,
  checkPdfTotals,
  componentsVatFromData,
  currencyCode,
  fmtNumber,
  PDF_DEFAULT_VAT_PCT,
  pdfLbAlreadyKg,
  pdfMissedTrackings,
  pdfReadNote,
  pdfTextNumbers,
  pdfVatPctOf,
  pdfVatRatesInText,
  readPdfReadNote,
  resolvePdfReadUnits,
  round2,
  round3,
  sha256Hex,
  t,
  type Locale,
  type ParsedInvoiceLine,
  type PdfCheckLine,
  type PdfCheckMethod,
  type PdfCheckUnits,
  type PdfMissedResult,
  type PdfReadNote,
  type PdfReadNoteInput,
  type PdfReadUnits,
  type PdfTotalsCheck,
  type SkippedInvoiceRow,
} from '@deciship/core';
import { prisma, type Prisma } from '../db.ts';
import { AppError } from '../errors.ts';
import { isFileLoadError, type FileJobOptions } from '../lib/fileWorkers.ts';
import { readStored } from '../lib/storage.ts';
import type { PdfInvoiceInput } from './ai.ts';
import { readPdfText } from './tariffPdf.ts';

/**
 * Y20: PDF'te KDV oranı okunamadığında kullanılan oran (core `PDF_DEFAULT_VAT_PCT`). Okunan oran `pdfReadUnits` ile gelir;
 * önizleme kaydında (`File.preview.read.vatPct`) durur, içe aktarma metin denetimini o oranla yapar.
 */
export const PDF_VAT_PCT = PDF_DEFAULT_VAT_PCT;

/** `weightAmbiguity` (K36): ağırlık PDF'te "1.500" gibi iki türlü basılı; bayrak değildir, seçilmeden içe aktarılmaz. */
export type PdfRowCheck = { rowIndex: number; codes: string[]; weightAmbiguity?: Partial<Record<'actualKg' | 'billedKg', { decimal: number; thousands: number }>> };
export type PdfLineCheck = { method: PdfCheckMethod; checked: number; unverified: number; rows: PdfRowCheck[] };

/** Bu satır bayrağı PDF metin denetiminden mi geldi (yeniden karşılaştırmada korunur, `refreshParseFlags`). */
export const isPdfFlag = (code: string) => code.startsWith('PDF_');

/**
 * PDF'in sayfa metinleri. Bozuk, şifreli ya da okunamayan belge boş liste döner: denetim `none` olur, yükleme durmaz
 * (asıl okuma yapay zekânındır; metin yalnız sağlamadır). Okuma dosya havuzundadır (Mesaj 6): yük sınırları yutulmaz,
 * uç hatası olarak geçer (413 `FILE_TOO_LARGE` sayfa sınırı, 422 `FILE_TOO_COMPLEX`, 503 `FILE_BUSY`).
 */
export async function pdfPageTexts(buf: Buffer, opts: FileJobOptions): Promise<string[]> {
  try {
    return (await readPdfText(buf, opts)).pages;
  } catch (e) {
    if (e instanceof AppError) throw e;
    return [];
  }
}

/**
 * Saklanan dosyanın metni (içe aktarma sunucuda kendisi okur; istemcinin önizlemede gördüğü sonuca güvenilmez).
 * İçe aktarma havuz yüzünden düşmez: havuz meşgulse (503) ya da okuma süre/bellek sınırında düştüyse (422) `null` döner:
 * denetim "yapılamadı" (`method: 'skipped'`, "metin katmanı yok" değil), fatura yüklenir. Sınır aşımı (413) geçer: reddedilir.
 */
export async function storedPdfPageTexts(path: string, opts: FileJobOptions): Promise<string[] | null> {
  let buf: Buffer;
  try {
    buf = await readStored(path);
  } catch {
    return [];
  }
  try {
    return await pdfPageTexts(buf, opts);
  } catch (e) {
    if (isFileLoadError(e)) return null;
    throw e;
  }
}

/**
 * Satırları sayfa metinleriyle denetler. `rows` yalnız işaretlenen satırlardır; `unverified` onların sayısı.
 * Satırların tutarı KDV hariç nettir; metinde net ya da KDV dahil hâli (`vatPct`: okunan oran, yoksa %20) aranır.
 */
export function checkInvoicePdfLines(
  pageTexts: string[] | null,
  lines: readonly PdfCheckLine[],
  vatPct: number = PDF_VAT_PCT,
  units: PdfCheckUnits = {},
): PdfLineCheck {
  // `null`: metin o an okunamadı (havuz meşgul ya da süre/bellek sınırı): denetim yapılmadı, bayrak konmaz
  if (pageTexts === null) return { method: 'skipped', checked: 0, unverified: 0, rows: [] };
  // 05-B4: ağırlık, ölçü ve ek ücretler de (satırın kendi alanları; null olan denetlenmez)
  const r = checkPdfLines(
    pageTexts,
    lines.map((l) => ({
      rowIndex: l.rowIndex,
      trackingNo: l.trackingNo,
      netAmount: l.netAmount,
      actualKg: l.actualKg,
      billedKg: l.billedKg,
      dims: l.dims,
      baseAmount: l.baseAmount,
      discountAmount: l.discountAmount,
      fuelAmount: l.fuelAmount,
      surcharges: l.surcharges,
    })),
    { vatFactors: [1 + vatPct / 100], units },
  );
  const rows = r.rows
    .filter((x) => x.codes.length > 0 || x.weightAmbiguity)
    .map((x) => ({ rowIndex: x.rowIndex, codes: [...x.codes] as string[], ...(x.weightAmbiguity ? { weightAmbiguity: x.weightAmbiguity } : {}) }));
  // `unverified`: bayraklı satırlar (K36 sorusu bayrak değildir)
  return { method: r.method, checked: r.checked, unverified: rows.filter((x) => x.codes.length > 0).length, rows };
}

/**
 * 05-B4: metin denetiminin basılı birimi okumanın notundan (`File.preview.read`). Not yoksa (eski önizleme) ya da gruplar
 * farklı birim söylediyse (`unitsMixed`) bütün karşılıklar denenir (yanlış alarmdan kaçınmak için).
 */
export function pdfCheckUnitsOf(read: Pick<PdfReadNote, 'weightUnit' | 'dimUnit' | 'unitsMixed'> | null | undefined): PdfCheckUnits {
  if (!read || read.unitsMixed) return { weight: 'any', dim: 'any' };
  return { weight: read.weightUnit, dim: read.dimUnit ?? 'cm' };
}

/** Denetim sonucuna bütün satırlar için bir bayrak ekler (05-B2: toplam öbür KDV kipine eşit). */
export function flagAllPdfRows(check: PdfLineCheck, rowIndexes: readonly number[], code: string): PdfLineCheck {
  const byRow = new Map(check.rows.map((r) => [r.rowIndex, r]));
  const all = new Set(rowIndexes);
  const rows: PdfRowCheck[] = [...all].map((rowIndex) => {
    const prev = byRow.get(rowIndex);
    return { rowIndex, codes: mergePdfFlags(prev?.codes ?? [], [code]), ...(prev?.weightAmbiguity ? { weightAmbiguity: prev.weightAmbiguity } : {}) };
  });
  for (const r of check.rows) if (!all.has(r.rowIndex)) rows.push(r);
  rows.sort((a, b) => a.rowIndex - b.rowIndex);
  return { ...check, unverified: rows.filter((r) => r.codes.length > 0).length, rows };
}

/**
 * 05-B2: okumanın satır toplamı fatura toplamlarıyla (core `checkPdfTotals`). Satır tutarları modelin verdiği kipte
 * (KDV dahil dediyse KDV dahil), takip no'suz satırlar dahil. Toplam alanı yoksa (bu alandan önceki okuma) null.
 */
export function pdfTotalsCheck(ai: Pick<PdfInvoiceInput, 'invoiceTotals' | 'amountsIncludeVat' | 'vatPct' | 'lines'>, pageTexts: readonly string[] | null, vatPct: number): PdfTotalsCheck | null {
  return checkPdfTotals(pageTexts, {
    totals: ai.invoiceTotals ?? null,
    amountsIncludeVat: ai.amountsIncludeVat,
    vatPct,
    vatPctRead: pdfVatPctOf(ai.vatPct),
    lineAmounts: ai.lines.map((l) => l.netAmount),
  });
}

/**
 * 05-B16: okuma işinin sunucuda yazdığı satırlar (`InvoicePdfPreview.aiLines`, son başarılı iş). İş yoksa (eski önizleme,
 * ya da okuma bu dosyada yapılmadı) null: karşılaştırma yapılmaz.
 */
export async function serverPdfLines(companyId: string, fileId: string): Promise<ParsedInvoiceLine[] | null> {
  const job = await prisma.job.findFirst({
    where: { companyId, kind: 'INVOICE_PDF_READ', refType: 'File', refId: fileId, status: 'SUCCEEDED' },
    orderBy: [{ finishedAt: 'desc' }, { id: 'asc' }],
    select: { result: true },
  });
  const lines = (job?.result as { aiLines?: unknown } | null | undefined)?.aiLines;
  return Array.isArray(lines) ? (lines as ParsedInvoiceLine[]) : null;
}

/**
 * Y20: okumanın KDV oranı, ağırlık ve ölçü birimi (okunmadıysa %20, kg, cm; varsayım işaretli). Eski önbellek kaydında ve
 * eski yanıtta alanlar olmayabilir: okunmamış sayılır.
 */
export function pdfReadUnits(lines: Pick<PdfInvoiceInput, 'vatPct' | 'weightUnit' | 'dimUnit' | 'amountsIncludeVat' | 'lines'>): PdfReadUnits {
  return resolvePdfReadUnits({
    vatPct: lines.vatPct ?? null,
    weightUnit: lines.weightUnit ?? null,
    dimUnit: lines.dimUnit ?? null,
    amountsIncludeVat: lines.amountsIncludeVat,
    hasWeights: lines.lines.some((l) => l.actualKg != null || l.billedKg != null),
    hasDims: lines.lines.some((l) => !!(l.dimL && l.dimW && l.dimH)),
  });
}

export type PdfParsed = {
  lines: ParsedInvoiceLine[];
  units: PdfReadUnits;
  /** Birim lb okundu ama değeri zaten kg yazılmış (metinle denetlendi) satır sayısı: bu satırlar çevrilmedi. */
  weightKeptLines: number;
};

/**
 * Yapay zekânın okuduğu PDF satırları → fatura satırları (takip no'lu olanlar; tutarlar KDV hariç net, ağırlıklar kg,
 * ölçüler cm).
 * - KDV: okunan oran (`vatPct`), okunmadıysa %20 (Y20).
 * - Ağırlık: lb ise CSV/Excel yoluyla aynı kural (`× 0,45359237`, 3 ondalık), g ise `÷ 1000`; kg ya da okunmadıysa olduğu
 *   gibi. Tanınmayan birim (oz, ton…): faturadaki ağırlık kullanılmaz (not). lb'de çift çevirmeye karşı: `pageTexts`
 *   verildiyse değer metinde zaten kg karşılığıyla duruyorsa (`pdfLbAlreadyKg`) çevrilmez (not).
 * - Ölçü: in ise `× 2,54` (CSV `lengthFactor` ile aynı, 2 ondalık); tanınmayan birimde ölçü kullanılmaz (not).
 * - Satır no (Y23): yapay zekâ çıktısındaki sıra (0 tabanlı, takip no'suz satırlar dahil). Takip no'suz satırlar da aynı
 *   sırayı taşır (`pdfSkippedRows`): ekranda ve raporda görünen no (`rowIndex + 1`) ikisinde aynı ölçektedir.
 */
export function parsePdfLines(lines: PdfInvoiceInput, opts: { pageTexts?: readonly string[] | null } = {}): PdfParsed {
  const units = pdfReadUnits(lines);
  const factor = lines.amountsIncludeVat ? 1 + units.vatPct / 100 : 1;
  const textNumbers = units.weightUnit === 'lb' && opts.pageTexts?.length ? pdfTextNumbers(opts.pageTexts) : [];
  let kept = false;
  const kg = (n: number | null) => {
    if (n == null || units.weightUnusable) return undefined;
    if (units.weightFactor === 1) return n;
    if (units.weightUnit === 'lb' && pdfLbAlreadyKg(textNumbers, n)) {
      kept = true;
      return n;
    }
    return round3(n * units.weightFactor);
  };
  const edge = (x: number) => (units.dimFactor === 1 ? x : round2(x * units.dimFactor));
  const net = (n: number | null) => (n == null ? undefined : Math.round((n / factor) * 100) / 100);
  // Denetim 04-B5: "KDV dahil" toplam tutarı anlatır; bileşenlerin (navlun, yakıt, ek ücret) KDV'si CSV/Excel yoluyla aynı
  // kuralla veriden belirlenir (bileşen toplamı KDV dahil toplama mı, KDV hariç tutara mı eşit). Kanıt yoksa bileşenler de
  // KDV dahil sayılır: yapay zekâ "belgede yalnız KDV dahil tutarlar basılı" demiştir ve PDF'te kararı değiştirecek eşleme
  // ekranı yoktur (CSV'de kanıt yoksa KDV hariç varsayılır ama kullanıcıya gösterilir).
  const vatData =
    factor === 1
      ? null
      : componentsVatFromData(
      factor,
      lines.lines.map((l) => ({
        ...(l.baseAmount != null ? { base: l.baseAmount } : {}),
        ...(l.discountAmount != null ? { discount: Math.abs(l.discountAmount) } : {}),
        ...(l.fuelAmount != null ? { fuel: l.fuelAmount } : {}),
        surcharges: l.surcharges.map((s) => s.amount),
        netRaw: l.netAmount,
      })),
    );
  const componentsIncl = vatData != null && (vatData.source === 'data' ? vatData.value : true);
  const componentFactor = componentsIncl ? factor : 1;
  const comp = (n: number | null) => (n == null ? undefined : Math.round((n / componentFactor) * 100) / 100);
  let weightKeptLines = 0;
  const parsed = lines.lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.trackingNo.trim() !== '')
    .map(({ l, i }) => {
      kept = false;
      const parsed: ParsedInvoiceLine = {
        rowIndex: i,
        trackingNo: l.trackingNo.trim(),
        shipDate: l.shipDate && /^\d{4}-\d{2}-\d{2}/.test(l.shipDate) ? l.shipDate.slice(0, 10) : undefined,
        service: l.service ?? undefined,
        destCountry: l.destCountry && /^[A-Za-z]{2}$/.test(l.destCountry) ? l.destCountry.toUpperCase() : undefined,
        actualKg: kg(l.actualKg),
        billedKg: kg(l.billedKg),
        dims: l.dimL && l.dimW && l.dimH && !units.dimUnusable ? { l: edge(l.dimL), w: edge(l.dimW), h: edge(l.dimH) } : undefined,
        billedDivisor: l.billedDivisor ?? undefined,
        baseAmount: comp(l.baseAmount),
        discountAmount: l.discountAmount == null ? undefined : comp(Math.abs(l.discountAmount)),
        fuelAmount: comp(l.fuelAmount),
        surcharges: l.surcharges.map((s) => ({ code: s.code, name: s.name ?? undefined, amount: comp(s.amount)! })),
        netAmount: net(l.netAmount)!,
        // 01-B8: "TL", "₺" → TRY (ham kalırsa karşılaştırma "TL" kuru arar, okuma kontrolü faturanın TRY'sinden farklı sayardı)
        currency: currencyCode(l.currency),
        reference: l.reference ?? undefined,
        rawHash: '',
      };
      parsed.rawHash = sha256Hex(JSON.stringify({ ...parsed, rawHash: undefined, rowIndex: undefined }));
      if (kept) weightKeptLines++;
      return parsed;
    });
  return { lines: parsed, units, weightKeptLines };
}

/** `parsePdfLines` satırları (eski imza; `pageTexts` verilirse lb çift çevirme denetimi de yapılır). */
export function pdfLinesToParsed(lines: PdfInvoiceInput, opts: { pageTexts?: readonly string[] | null } = {}): ParsedInvoiceLine[] {
  return parsePdfLines(lines, opts).lines;
}

/** Önizleme kaydına ve rapora giden not (Y20): okumanın birimleri + metin denetimlerinin sonucu. */
export function pdfReadNoteOf(p: PdfParsed, extra: { vatUnverified?: boolean; unitsMixed?: boolean } = {}): PdfReadNote {
  const u = p.units;
  return pdfReadNote({
    vatPct: u.vatPct,
    weightUnit: u.weightUnit,
    dimUnit: u.dimUnit,
    vatAssumed: u.vatAssumed,
    vatUnverified: extra.vatUnverified,
    weightAssumed: u.weightAssumed,
    weightUnusable: u.weightUnusable,
    weightKeptLines: p.weightKeptLines,
    dimAssumed: u.dimAssumed,
    dimUnusable: u.dimUnusable,
    unitsMixed: extra.unitsMixed,
  });
}

/**
 * Mesaj 5 (04-B11): yapay zekânın okuduğu ama takip no'su boş satırlar (faturaya alınmaz). Tutarı 0 olan satır ücret
 * değildir, sayılmaz. `rowIndex` yapay zekâ çıktısındaki sıradır (0'dan), faturaya alınan satırlarla aynı ölçek (Y23);
 * tutar satırlarla aynı KDV kuralıyla (okunan oran) nettir.
 */
export function pdfSkippedRows(lines: PdfInvoiceInput): SkippedInvoiceRow[] {
  const factor = lines.amountsIncludeVat ? 1 + pdfReadUnits(lines).vatPct / 100 : 1;
  const out: SkippedInvoiceRow[] = [];
  lines.lines.forEach((l, i) => {
    if (l.trackingNo.trim() !== '' || !Number.isFinite(l.netAmount) || l.netAmount === 0) return;
    out.push({ rowIndex: i, reason: 'NO_TRACKING', amount: Math.round((l.netAmount / factor) * 100) / 100 });
  });
  return out;
}

/**
 * Y31: PDF metninde geçen ama satırlarda olmayan takip no'lar ("okunmamış olabilir"; kural core `pdfMissedTrackings`).
 * `invoiceNo` ve satırların referansları aday sayılmaz. Metin yoksa ya da o an okunamadıysa (`null`) boş.
 */
export function findPdfMissedLines(
  pageTexts: readonly string[] | null,
  lines: readonly { trackingNo: string; reference?: string | null }[],
  invoiceNo?: string | null,
): PdfMissedResult {
  if (!pageTexts?.length) return { count: 0, trackings: [] };
  return pdfMissedTrackings(pageTexts, lines, { exclude: [invoiceNo] });
}

/** Okuma bayraklarına PDF denetiminin bayraklarını ekler (sıra: önce okuma, sonra PDF; yinelenen eklenmez). */
export function mergePdfFlags(flags: readonly string[], pdf: readonly string[] | undefined): string[] {
  if (!pdf?.length) return [...flags];
  const out = [...flags];
  for (const c of pdf) if (!out.includes(c)) out.push(c);
  return out;
}

// ---------------------------------------------------------------------------------------------
// PDF önizlemesinin kaydı: `File.preview` (Mesaj 7, plan §2 E2 ve E6). Süreç belleği yerine veritabanı: sunucu yeniden
// başlasa da, istek başka kopyaya gitse de içe aktarma aynı bilgiyi bulur. Değeri yalnız sunucu yazar; istemci değiştiremez.
//
// - `pageTexts`: PDF'in sayfa metinleri (toplam 1 MB'tan küçükse). İçe aktarma metni buradan alır, PDF'i ikinci kez okumaz
//   (E2); yoksa eskisi gibi saklanan dosyadan okur.
// - `skipped`: yapay zekânın okuduğu ama takip no'su boş satırlar (E6). İçe aktarma isteği yalnız takip no'lu satırları
//   taşır; bu sayılar buradan gelir. Alan yoksa (okuma bitmedi ya da eski önizleme) `NO_TRACKING` yazılmaz (bugünkü davranış).
// - `method`: önizlemedeki metin denetiminin yolu (bilgi için).
// - `read` (Y20): okumanın KDV oranı ve ağırlık birimi, varsayıldıysa işaretli. İçe aktarma metin denetimini bu oranla
//   yapar ve varsayımı rapora yazar. Alan yoksa (Y20 öncesi önizleme) %20 ile denetler, not yazmaz (bugünkü davranış).
// - `invoiceVatPct` (K43): faturanın KDV oranı, yalnız biliniyorsa (`knownPdfVatPct`). İçe aktarma faturanın eşlemesine
//   yazar, itiraz metni tutarları KDV dahil hâliyle de verir. Alan yoksa metin yalnız KDV hariç yazar.
//
// KALANLAR 6.5: `pageTexts` PDF'in ham metnidir (kişi adı, adres taşıyabilir) ve yalnız içe aktarmaya kadar gerekir. Fatura
// yazılınca (aynı işlemde) silinir (`dropPdfPageTexts`); öbür alanlar ve PDF dosyasının kendisi (itiraz kanıtı) kalır.

export type PdfSkippedRow = SkippedInvoiceRow;
/**
 * `review` (Mesaj 7 E1, büyük PDF): gruplu okumanın şüpheleri; içe aktarma satırlara sert bayrak koyar ("İncele").
 * `vatUnclear`: bütün satırlar `PDF_VAT_UNCLEAR`; `pageBreak`: bu takip no'lu satırlar `PDF_PAGE_BREAK` (normalleştirilmiş).
 * `surchargeCode` (inceleme 2, 2026-11-13): modelin tarife kodu basılı adla uyuşmadı, kod basılı addan türedi
 * (`alignPdfSurchargeCodesReport`): bu takip no'lu satırlar `PDF_SURCHARGE_UNVERIFIED` ("Kontrol edilecek").
 */
export type PdfPreviewReview = { vatUnclear?: boolean; pageBreak?: string[]; surchargeCode?: string[] };
/** Y20: okumanın oranı, birimleri ve notları (core `PdfReadNote`; bayraklar yalnız `true` iken yazılır). */
export type PdfPreviewRead = PdfReadNote;
export type PdfPreview = { v: 1; pageTexts?: string[]; skipped?: PdfSkippedRow[]; method?: PdfCheckMethod; review?: PdfPreviewReview; read?: PdfPreviewRead; invoiceVatPct?: number };

/** Geçerli KDV oranı (0–100, sonlu); değilse null. */
const vatPctOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);

/**
 * K43: PDF faturanın KDV oranı biliniyor mu. Modelin okuduğu oran yalnız sayfa metninde bir KDV sözcüğünün yanında
 * yazıyorsa ("KDV %20", "VAT 18%"; core `pdfVatRatesInText`) kabul edilir (inceleme 2026-11-13: KDV'siz USD ihracat
 * faturasında model %20 uydurunca itiraz metni "KDV dahil (%20)" diyordu); metin yoksa (taranmış) doğrulanamaz, sayılmaz.
 * Kabul edilmezse: tutarlar KDV dahil okunduysa nete çevirmede kullanılan oran (`units.vatPct`, %20), değilse null.
 * KDV belirsizse (`vatUnclear`: oran doğrulanamadı, toplam öbür kipe eşit) null: itiraz metni yalnız KDV hariç yazar.
 */
export function knownPdfVatPct(o: {
  rawVatPct: number | null | undefined;
  amountsIncludeVat: boolean;
  usedVatPct: number;
  vatUnclear: boolean;
  pageTexts: readonly string[] | null | undefined;
}): number | null {
  if (o.vatUnclear) return null;
  const printed = pdfVatPctOf(o.rawVatPct);
  if (printed != null && o.pageTexts?.length && pdfVatRatesInText(o.pageTexts).vat.has(printed)) return printed;
  return o.amountsIncludeVat ? vatPctOrNull(o.usedVatPct) : null;
}

/**
 * KALANLAR 6.5: içe aktarma faturayı yazdı; önizleme kaydındaki sayfa metni (`pageTexts`, PDF'in ham metni) silinir. Kayıttaki
 * öbür alanlar (takip no'suz satırlar, okuma notu, KDV oranı, şüpheler) ve PDF dosyası kalır. Faturayı yazan işlemin içinde
 * çağrılır: fatura ya yazılır ve metin silinir ya da hiçbiri. Metinden sonra yeniden gereken olursa (aynı dosyanın ikinci içe
 * aktarması) metin saklanan PDF'ten okunur (`storedPdfPageTexts`), yapay zekâ yeniden çağrılmaz.
 */
export async function dropPdfPageTexts(tx: Prisma.TransactionClient, companyId: string, fileId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "File" SET "preview" = "preview" - 'pageTexts'
    WHERE "id" = ${fileId} AND "companyId" = ${companyId} AND jsonb_typeof("preview") = 'object' AND jsonb_exists("preview", 'pageTexts')`;
}

/** `pageTexts` bu boyutun (UTF-8 bayt, JSON) üstündeyse yazılmaz; içe aktarma metni dosyadan okur. */
export const PDF_PREVIEW_TEXT_MAX_BYTES = 1_000_000;

/** Kaydedilecek değer. Sayfa metni sınırı aşıyorsa düşer (satırlar ve sayılar kalır). */
export function pdfPreviewValue(o: {
  pageTexts?: string[] | null;
  skipped?: PdfSkippedRow[];
  method?: PdfCheckMethod;
  review?: PdfPreviewReview;
  read?: PdfReadNoteInput;
  invoiceVatPct?: number | null;
}): PdfPreview {
  const out: PdfPreview = { v: 1 };
  if (o.pageTexts && Buffer.byteLength(JSON.stringify(o.pageTexts), 'utf8') <= PDF_PREVIEW_TEXT_MAX_BYTES) out.pageTexts = o.pageTexts;
  if (o.skipped) out.skipped = o.skipped.map((r) => ({ rowIndex: r.rowIndex, reason: r.reason, amount: r.amount }));
  if (o.method) out.method = o.method;
  if (o.review?.vatUnclear || o.review?.pageBreak?.length || o.review?.surchargeCode?.length) {
    out.review = {
      ...(o.review.vatUnclear ? { vatUnclear: true } : {}),
      ...(o.review.pageBreak?.length ? { pageBreak: [...o.review.pageBreak] } : {}),
      ...(o.review.surchargeCode?.length ? { surchargeCode: [...o.review.surchargeCode] } : {}),
    };
  }
  if (o.read) out.read = pdfReadNote(o.read);
  const vat = vatPctOrNull(o.invoiceVatPct);
  if (vat != null) out.invoiceVatPct = vat;
  return out;
}

const SKIP_REASONS = new Set<string>(['NO_TRACKING']);

/**
 * Kayıtlı değeri okur; biçimi bozuk alan yok sayılır (yanlış sayı yazmaktansa hiç yazmamak). Bilinmeyen sürüm: null.
 */
export function readPdfPreview(raw: unknown): PdfPreview | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  const out: PdfPreview = { v: 1 };
  if (Array.isArray(o.pageTexts) && o.pageTexts.every((t) => typeof t === 'string')) out.pageTexts = o.pageTexts as string[];
  if (Array.isArray(o.skipped)) {
    const rows: PdfSkippedRow[] = [];
    let ok = true;
    for (const r of o.skipped as unknown[]) {
      const x = r as Record<string, unknown> | null;
      if (!x || !Number.isInteger(x.rowIndex) || typeof x.reason !== 'string' || !SKIP_REASONS.has(x.reason) || typeof x.amount !== 'number' || !Number.isFinite(x.amount)) {
        ok = false;
        break;
      }
      rows.push({ rowIndex: x.rowIndex as number, reason: x.reason as PdfSkippedRow['reason'], amount: x.amount });
    }
    if (ok) out.skipped = rows;
  }
  if (o.method === 'text' || o.method === 'none' || o.method === 'skipped') out.method = o.method;
  const r = o.review as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    const review: PdfPreviewReview = {};
    if (r.vatUnclear === true) review.vatUnclear = true;
    if (Array.isArray(r.pageBreak)) review.pageBreak = r.pageBreak.filter((t): t is string => typeof t === 'string');
    if (Array.isArray(r.surchargeCode)) {
      const codes = r.surchargeCode.filter((t): t is string => typeof t === 'string');
      if (codes.length) review.surchargeCode = codes;
    }
    if (review.vatUnclear || review.pageBreak?.length || review.surchargeCode?.length) out.review = review;
  }
  // Y20: oran 0–50 arası sayı, birim kg/lb/g, ölçü cm/in; biçimi bozuksa alan yok sayılır (içe aktarma %20 ile denetler, not yazmaz)
  const read = readPdfReadNote(o.read);
  if (read) out.read = read;
  const vat = vatPctOrNull(o.invoiceVatPct);
  if (vat != null) out.invoiceVatPct = vat;
  return out;
}

/**
 * Önizleme kaydındaki şüpheler → satır bayrakları (içe aktarma). Satırlar istemciden gelir; bayrak sunucunun kaydına göre:
 * KDV belirsizse bütün satırlar, sayfa sınırındaki ve ek ücret kodu doğrulanamayan takip no'lar eşleşen satırlar.
 */
export function pdfReviewFlags(review: PdfPreviewReview | undefined, lines: readonly { rowIndex: number; trackingNo: string }[], normalize: (t: string) => string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!review) return out;
  const breaks = new Set(review.pageBreak ?? []);
  const surchargeCode = new Set(review.surchargeCode ?? []);
  for (const l of lines) {
    const codes: string[] = [];
    if (review.vatUnclear) codes.push('PDF_VAT_UNCLEAR');
    if (breaks.has(normalize(l.trackingNo))) codes.push('PDF_PAGE_BREAK');
    if (surchargeCode.has(normalize(l.trackingNo))) codes.push('PDF_SURCHARGE_UNVERIFIED');
    if (codes.length) out.set(l.rowIndex, codes);
  }
  return out;
}

/** 01-B8: PDF içe aktarmanın para birimi kapısının yanıtı (`409 MAPPING_UNVERIFIED` ayrıntısı; tablo yolunun biçimi). */
export type PdfCurrencyGate = {
  issues: string[];
  verdict: 'check';
  flaggedRows: number;
  flagCounts: { CURRENCY_MISMATCH: number };
  examples: { rowIndex: number; trackingNo: string; codes: ['CURRENCY_MISMATCH'] }[];
};

/**
 * 01-B8: PDF satırlarından biri faturanın para biriminde değilse (USD fatura, 3 EUR satır) içe aktarma onay ister: tablo
 * yolundaki okuma kontrolüyle aynı metin (core `verify.issue.currencyMismatch`) ve aynı kapı (`acknowledgeIssues`). Onaylanırsa
 * satırlar `CURRENCY_MISMATCH` bayrağıyla ("Kontrol edilecek") yüklenir. Para birimi yazmayan satır faturanınkini alır, sayılmaz.
 * Sorun yoksa null.
 */
export function pdfCurrencyGate(
  lines: readonly { rowIndex: number; trackingNo: string; currency?: string | null }[],
  invoiceCurrency: string,
  locale: Locale,
): PdfCurrencyGate | null {
  const invoice = currencyCode(invoiceCurrency);
  if (!invoice) return null;
  const mismatched = lines.filter((l) => {
    const c = currencyCode(l.currency);
    return c != null && c !== invoice;
  });
  if (!mismatched.length) return null;
  const byCurrency = new Map<string, number>();
  for (const l of mismatched) {
    const c = currencyCode(l.currency)!;
    byCurrency.set(c, (byCurrency.get(c) ?? 0) + 1);
  }
  const n = (x: number) => fmtNumber(x, 0, locale);
  const parts = [...byCurrency].map(([c, k]) => t(locale, 'verify.issue.currencyPart', { count: n(k), currency: c }));
  return {
    issues: [t(locale, 'verify.issue.currencyMismatch', { count: n(mismatched.length), parts: parts.join(', '), invoice })],
    verdict: 'check',
    flaggedRows: mismatched.length,
    flagCounts: { CURRENCY_MISMATCH: mismatched.length },
    examples: mismatched.slice(0, 10).map((l) => ({ rowIndex: l.rowIndex, trackingNo: l.trackingNo, codes: ['CURRENCY_MISMATCH'] })),
  };
}
