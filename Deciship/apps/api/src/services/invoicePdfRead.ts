/**
 * PDF fatura okuma, büyük belgede sayfa gruplarıyla (Mesaj 7 Ek E1, bulgu 03-B8). Tek çağrının çıktı sınırı (64 bin token)
 * çok sayfalı faturada aşılıyordu: yanıt kesiliyor (422 `AI_TRUNCATED`), fatura okunamıyor ama çağrı ücretleniyordu.
 *
 * - Sayfa sayısı `PDF_INVOICE_PAGES_PER_CALL`'dan (varsayılan 5) büyük değilse ya da belge güvenle kesilemiyorsa: bugünkü
 *   tek çağrı (`readInvoicePdf`; istem, şema ve önbellek anahtarı değişmez). Tek çağrı kesilirse (`AI_TRUNCATED`) ve belge
 *   en az 2 sayfaysa ve kesilebiliyorsa iki yarıyla gruplu yola geçilir.
 * - "Güvenle kesilemiyor": sayfa sayısı bilinmiyor, pdf-lib açamıyor ya da sayfa sayısı tutmuyor, belge şifreli (pdf-lib
 *   şifreli içeriği çözmeden kopyalar: parçalar boş gider ama ücretlenirdi, R3 1), ya da metni olan sayfalar kesildikten
 *   sonra metinsiz kalıyor (ilk parçada dosya çalışanıyla bir kez denetlenir). Taranmış belgede bu denetim yapılamaz:
 *   okuma sürer, önizlemede not çıkar (`review.sliceUnchecked`, Y96).
 * - Büyük belge sayfa gruplarına kesilir (pdf-lib, dosya çalışanında: Y96) ve her grup ayrı belge olarak gönderilir: girdi
 *   ücreti yalnız o grubun sayfalarıdır ("bütün belgeyi gönderip şu sayfaları oku" her çağrıda bütün belgenin girdi ücretini
 *   öderdi). Her grup ayrı ölçülür ve ayrı önbelleğe girer (anahtar: kaynak dosyanın sha256'sı + sayfa listesi).
 * - Kesilen grup ikiye bölünüp yeniden okunur; tek sayfa da kesilirse 422 `AI_TRUNCATED`.
 * - Birleştirme (`mergePdfParts`): satırlar sayfa sırasıyla eklenir, tekilleştirme ve kendiliğinden birleştirme yok (gruplar
 *   örtüşmez; birebir aynı iki satır gerçekten iki kez basılmıştır, "Mükerrer" çıkmalı). Şüpheli durumlar satıra sert bayrakla
 *   işaretlenir ("İncele"), sessiz seçim yapılmaz:
 *   - "KDV dahil": gruplar `true | false | null` döner (null = bu sayfalarda yazmıyor). Yalnız açık oylar sayılır; çelişki
 *     (hem true hem false) ya da hiç açık oy yoksa bütün satırlar `PDF_VAT_UNCLEAR`.
 *   - Sayfa sınırı: sonraki grubun ilk satırı takip no'suzsa ya da önceki grubun son satırıyla aynı takip no'yu taşıyorsa
 *     iki satır da `PDF_PAGE_BREAK` (takip no'suz satır faturaya alınmaz, takip no'suz satır olarak sayılır).
 *   - Başlık (fatura no, tarih, para birimi): 1. sayfayı içeren grup öncelikli, yoksa sırayla ilk dolu; gruplar arasında
 *     çelişirse önizlemede uyarı.
 *   - Fatura toplamları (05-B2, `mergeTotals`): son sayfayı içeren grup öncelikli, yoksa grupların aynı değeri; çelişen
 *     alan kullanılmaz.
 * - Grup arası kanca (`beforePart`): ilerleme ve durdurma (okunmuş gruplar önbellekte kalır). KALANLAR 6.5: süren grubun
 *   çağrısını durdurma sinyali keser (`AiCallContext.signal`); kesilen grup `FAILED` `AI_CANCELLED`, sonucu yok.
 *   Kota iş sürerken dolarsa sayaç 429 `AI_QUOTA_EXCEEDED` atar; okunmuş gruplar önbellektedir, yeniden okuma onları ücretsiz alır.
 */
import { INCH_TO_CM, LB_TO_KG, normalizeTracking, pdfDimUnitOf, pdfVatPctOf, pdfWeightUnitOf, round2, round3 } from '@deciship/core';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { slicePdfPages } from '../lib/fileWorkers.ts';
import { sha256 } from '../lib/storage.ts';
import { readInvoicePdf, readInvoicePdfPart, type PdfInvoice, type PdfInvoicePartInput, type PdfKnownSurcharge } from './ai.ts';
import { assertAiRate, type AiCallContext } from './aiMeter.ts';
import { pageHasText, readPdfText } from './tariffPdf.ts';

export type PdfPartProgress = { from: number; to: number; done: number; total: number };
export type PdfReadHooks = {
  /** her gruptan önce: `done` okunmuş sayfa sayısı, `from`–`to` okunacak grup (1 tabanlı) */
  beforePart?: (p: PdfPartProgress) => Promise<void>;
  /** 05-B10: taşıyıcının tarife ek ücretleri (istemde; her grupta aynı) */
  knownSurcharges?: readonly PdfKnownSurcharge[];
};

/** Birleştirmenin şüpheleri. Satır numaraları birleşik `lines` dizisindeki sıradır (0 tabanlı, takip no'suzlar dahil). */
export type PdfReadReview = {
  vatUnclear: boolean;
  pageBreakLines: number[];
  metaConflict: boolean;
  /** Gruplar farklı ağırlık ya da ölçü birimi söyledi; her grup birleştirmede kendi biriminden kg / cm'ye çevrildi (Y20). */
  unitsMixed?: boolean;
  /**
   * Y96: belge gruplarla okundu ama ilk grubun sayfalarında metin yok (taranmış): kesmenin içeriği koruduğu metinle
   * denetlenemedi. Önizleme uyarısı `invoice.pdfSliceUnchecked`.
   */
  sliceUnchecked?: boolean;
};
const CLEAN: PdfReadReview = { vatUnclear: false, pageBreakLines: [], metaConflict: false };

export type PdfReadResult = {
  data: PdfInvoice;
  /** bütün parçalar önbellekten geldi (ücret 0) */
  cached: boolean;
  /** okunan parça sayısı (tek çağrıda 1) */
  parts: number;
  review: PdfReadReview;
};

/** `pageCount` sayfayı `per`'lik ardışık gruplara böler (1 tabanlı). */
export function pageGroups(pageCount: number, per: number): number[][] {
  const out: number[][] = [];
  for (let s = 1; s <= pageCount; s += per) out.push(Array.from({ length: Math.min(per, pageCount - s + 1) }, (_, i) => s + i));
  return out;
}

/** Grubun okuması; Y20 alanları (`vatPct`, `weightUnit`) olmayabilir (eski önbellek kaydı): okunmamış sayılır. */
export type PdfPartResult = { pages: number[]; data: PdfInvoicePartInput };

const META = ['invoiceNo', 'invoiceDate', 'currency'] as const;
const metaKey = (k: (typeof META)[number], v: string) => (k === 'currency' ? v.trim().toUpperCase() : v.trim());

/** Grupların sonuçlarını birleştirir (kural dosya başında; KDV oranı ve ağırlık birimi: işlevin içinde, Y20). */
export function mergePdfParts(parts: readonly PdfPartResult[]): { data: PdfInvoice; review: PdfReadReview } {
  const ordered = [...parts].sort((a, b) => a.pages[0]! - b.pages[0]!);
  const firstPage = ordered.find((p) => p.pages.includes(1));
  let metaConflict = false;
  const meta = {} as Record<(typeof META)[number], string | null>;
  for (const k of META) {
    const values = ordered.map((p) => p.data[k]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (new Set(values.map((v) => metaKey(k, v))).size > 1) metaConflict = true;
    const fromFirst = firstPage?.data[k];
    meta[k] = typeof fromFirst === 'string' && fromFirst.trim() !== '' ? fromFirst : (values[0] ?? null);
  }
  // "KDV dahil": yalnız açık oylar; çelişki ya da hiç oy yoksa belirsiz (satırlar bayraklı)
  const votes = ordered.map((p) => p.data.amountsIncludeVat).filter((v): v is boolean => typeof v === 'boolean');
  const yes = votes.filter(Boolean).length;
  const no = votes.length - yes;
  const vatUnclear = votes.length === 0 || (yes > 0 && no > 0);
  const firstVote = typeof firstPage?.data.amountsIncludeVat === 'boolean' ? firstPage.data.amountsIncludeVat : null;
  const amountsIncludeVat = !vatUnclear ? yes > 0 : (firstVote ?? (yes > no));

  // Y20: KDV oranı yalnız okunan değerlerden; çelişirse 1. sayfanın grubu (yoksa ilk okunan) ve tutarlar KDV dahilse
  // satırlar "KDV belirsiz" (oran nete çevirmeyi değiştirir). Ağırlık / ölçü birimi çelişirse (bir grup kg, öbürü lb) her
  // grubun değerleri burada kendi biriminden kg / cm'ye çevrilir (tanınmayan birimdeki değer kullanılmaz), birleşik birim
  // kg / cm olur ve `unitsMixed` (raporda not); çelişki yoksa okunan birim bütün gruplara uygulanır (çeviri sonra).
  const rates = ordered.map((p) => pdfVatPctOf(p.data.vatPct));
  const okRates = rates.filter((r): r is number => r != null);
  const firstRate = firstPage ? rates[ordered.indexOf(firstPage)] : null;
  const vatPct = firstRate ?? okRates[0] ?? null;
  const rateConflict = new Set(okRates).size > 1;
  const wUnits = ordered.map((p) => pdfWeightUnitOf(p.data.weightUnit));
  const dUnits = ordered.map((p) => pdfDimUnitOf(p.data.dimUnit));
  const mixedW = new Set(wUnits.filter((u) => u != null)).size > 1;
  const mixedD = new Set(dUnits.filter((u) => u != null)).size > 1;
  /** Çelişki yoksa ilk okunan grubun yazdığı birim (sonraki çeviri aynı sınıflandırmayı yapar). */
  const rawUnit = (key: 'weightUnit' | 'dimUnit', us: readonly (string | null)[]) => {
    const i = us.findIndex((u) => u != null);
    return i < 0 ? null : (ordered[i]!.data[key] ?? null);
  };
  const weightUnit = mixedW ? 'kg' : rawUnit('weightUnit', wUnits);
  const dimUnit = mixedD ? 'cm' : rawUnit('dimUnit', dUnits);
  const wConv = (u: (typeof wUnits)[number]) => (n: number | null) =>
    n == null || u === 'other' ? null : u === 'lb' ? round3(n * LB_TO_KG) : u === 'g' ? round3(n / 1000) : n;
  const dConv = (u: (typeof dUnits)[number]) => (n: number | null) => (n == null || u === 'other' ? null : u === 'in' ? round2(n * INCH_TO_CM) : n);

  const lines: PdfInvoice['lines'] = [];
  const pageBreak = new Set<number>();
  for (const [gi, p] of ordered.entries()) {
    const prevLast = lines.length - 1;
    const first = p.data.lines[0];
    if (prevLast >= 0 && first) {
      const a = normalizeTracking(lines[prevLast]!.trackingNo);
      const b = normalizeTracking(first.trackingNo);
      if (!b || (a && a === b)) {
        pageBreak.add(prevLast);
        pageBreak.add(prevLast + 1);
      }
    }
    const w = mixedW && wUnits[gi] !== 'kg' && wUnits[gi] != null ? wConv(wUnits[gi]!) : null;
    const d = mixedD && dUnits[gi] !== 'cm' && dUnits[gi] != null ? dConv(dUnits[gi]!) : null;
    if (!w && !d) lines.push(...p.data.lines);
    else {
      lines.push(
        ...p.data.lines.map((l) => ({
          ...l,
          ...(w ? { actualKg: w(l.actualKg), billedKg: w(l.billedKg) } : {}),
          ...(d ? { dimL: d(l.dimL), dimW: d(l.dimW), dimH: d(l.dimH) } : {}),
        })),
      );
    }
  }
  return {
    data: { invoiceNo: meta.invoiceNo, invoiceDate: meta.invoiceDate, currency: meta.currency, amountsIncludeVat, vatPct, weightUnit, dimUnit, invoiceTotals: mergeTotals(ordered), lines },
    review: {
      vatUnclear: vatUnclear || (rateConflict && amountsIncludeVat),
      pageBreakLines: [...pageBreak].sort((x, y) => x - y),
      metaConflict,
      ...(mixedW || mixedD ? { unitsMixed: true } : {}),
    },
  };
}

type Totals = NonNullable<PdfInvoice['invoiceTotals']>;
const TOTAL_KEYS = ['net', 'vat', 'gross'] as const;

/**
 * 05-B2: fatura toplamları sayfa gruplarından. Toplam çoğunlukla son sayfadadır: son sayfayı içeren grup herhangi bir toplam
 * verdiyse yalnız onun toplamları geçerlidir (eksik alan öbür gruptan tamamlanmaz: ara sayfadaki "sayfa toplamı" toplam
 * sanılmış olabilir); son grup hiç söylemiyorsa öbür grupların değeri, alan başına yalnız aynıysa (çelişen alan null). Hiçbir grup alanı taşımıyorsa (bu alandan önceki önbellek kaydı) null:
 * karşılaştırma yapılmaz.
 */
function mergeTotals(ordered: readonly PdfPartResult[]): Totals | null {
  const lastPage = Math.max(...ordered.flatMap((p) => p.pages));
  const objs = ordered.map((p) => ({ last: p.pages.includes(lastPage), t: p.data.invoiceTotals ?? null })).filter((x): x is { last: boolean; t: Totals } => x.t != null);
  if (!objs.length) return null;
  const out: Totals = { net: null, vat: null, gross: null };
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // son grup bir toplam verdiyse yalnız onun toplamları (öbür gruptaki değer sayfa toplamı olabilir; karıştırılmaz)
  const last = objs.find((x) => x.last && TOTAL_KEYS.some((k) => num(x.t[k]) != null));
  if (last) return { net: num(last.t.net), vat: num(last.t.vat), gross: num(last.t.gross) };
  for (const k of TOTAL_KEYS) {
    const val = (t: Totals) => num(t[k]);
    const values = [...new Set(objs.map((x) => val(x.t)).filter((v): v is number => v != null).map((v) => Math.round(v * 100)))];
    out[k] = values.length === 1 ? values[0]! / 100 : null;
  }
  return out;
}

const isTruncated = (e: unknown) => e instanceof AppError && e.code === 'AI_TRUNCATED';

type Slicer = { slice: (pages: number[]) => Promise<Buffer | null> };

/**
 * Kesici (Y96: kesme ana süreçte değil dosya çalışanında, `slicePdfPages`). Sayfa sayısı 2'den azsa yok. Belge güvenle
 * kesilemiyorsa (şifreli, sayfa sayısı tutmuyor) `slice` null döner: şifreli belgede pdf-lib içeriği çözmeden kopyalar,
 * parçalar boş gider ama ücretlenirdi (R3 1).
 */
function slicerFor(buf: Buffer, pageCount: number, companyId: string): Slicer | null {
  if (!(pageCount >= 2)) return null;
  return { slice: (pages) => slicePdfPages(buf, pages, { companyId, strict: { pageCount, refuseEncrypted: true } }) };
}

/** İlk kesme: havuz meşgulse hata (geçici, henüz ücret yok); belge açılamıyor, sınırda ya da süre doldu: kesilemez (null). */
async function firstSlice(slicer: Slicer, pages: number[]): Promise<Buffer | null> {
  try {
    return await slicer.slice(pages);
  } catch (e) {
    if (e instanceof AppError && e.code === 'FILE_BUSY') throw e;
    return null;
  }
}

/**
 * Metni olan sayfa kesildikten sonra metinsiz kaldıysa kesme güvenilmez (içerik kopyalanmamış): false. Kaynakta metni olan
 * sayfa yoksa (taranmış belge) denetlenecek bir şey yoktur: `unchecked` (Y96: önizlemede not, `review.sliceUnchecked`).
 */
async function sliceKeepsText(part: Buffer, pages: number[], pageTexts: readonly string[], companyId: string): Promise<boolean | 'unchecked'> {
  const expected = pages.filter((p) => pageHasText(pageTexts[p - 1]));
  if (!expected.length) return 'unchecked';
  let texts: string[];
  try {
    texts = (await readPdfText(part, { companyId })).pages;
  } catch (e) {
    if (e instanceof AppError) throw e; // dosya havuzu meşgul/sınır: geçici hata, henüz ücret yok
    return false;
  }
  return expected.some((p) => pageHasText(texts[pages.indexOf(p)]));
}

/**
 * PDF faturayı okur: küçükse ya da güvenle kesilemiyorsa tek çağrı, büyükse sayfa gruplarıyla. `pageTexts` dosya havuzunun
 * okuduğu sayfa metinleridir (`pdfPageTexts`); sayısı sayfa sayısıdır (boşsa bilinmiyor: tek çağrı).
 *
 * Y96: istek içi çağrıda (eski eşzamanlı yol, `origin: 'request'`) kişi başı dakika sınırı burada BİR KEZ sayılır, gruplar
 * yeniden saymaz: grup başına sayım `AI_RATE_PDF_PER_MIN` (6) grubu aşan belgeyi (5'lik gruplarla 31+ sayfa) yarıda 429
 * ile kesiyordu. Arka plan işinde (`origin: 'job'`) sınır zaten başlatmada sayıldı. Firma yuvası, kota ve önbellek her
 * grupta aynen geçerli (`meteredCall`).
 */
export async function readInvoicePdfAll(buf: Buffer, pageTexts: readonly string[], ctx: AiCallContext, hooks: PdfReadHooks = {}): Promise<PdfReadResult> {
  if (ctx.origin !== 'job') {
    assertAiRate(ctx);
    ctx = { ...ctx, origin: 'job' };
  }
  const pageCount = pageTexts.length;
  const per = env.pdfInvoicePagesPerCall;
  const slicer = slicerFor(buf, pageCount, ctx.companyId);
  const single = async (): Promise<PdfReadResult> => {
    const r = await readInvoicePdf(buf, ctx, { knownSurcharges: hooks.knownSurcharges });
    return { data: r.data, cached: r.cached, parts: 1, review: CLEAN };
  };

  if (!slicer) return single();
  if (pageCount <= per) {
    try {
      return await single();
    } catch (e) {
      // R3 5: küçük belgede de kesilirse iki yarıyla gruplu yola geç (kesilen çağrı FAILED satırıdır, kotadan düşmez)
      if (!isTruncated(e)) throw e;
      const half = Math.ceil(pageCount / 2);
      const grouped = await readGrouped(buf, pageTexts, slicer, [pageGroups(pageCount, half)[0]!, pageGroups(pageCount, half)[1]!], ctx, hooks);
      if (!grouped) throw e;
      return grouped;
    }
  }
  return (await readGrouped(buf, pageTexts, slicer, pageGroups(pageCount, per), ctx, hooks)) ?? single();
}

/**
 * Gruplu okuma. Belge güvenle kesilemiyorsa (ilk kesme null) ya da ilk parçanın kesmesi güvenilmezse (metin kayboldu)
 * hiçbir çağrı yapmadan null döner.
 */
async function readGrouped(
  buf: Buffer,
  pageTexts: readonly string[],
  slicer: Slicer,
  groups: number[][],
  ctx: AiCallContext,
  hooks: PdfReadHooks,
): Promise<PdfReadResult | null> {
  const pageCount = pageTexts.length;
  const sourceSha256 = sha256(buf);
  const first = await firstSlice(slicer, groups[0]!);
  if (!first) return null;
  const kept = await sliceKeepsText(first, groups[0]!, pageTexts, ctx.companyId);
  if (!kept) return null;

  const results: PdfPartResult[] = [];
  let cached = true;
  let done = 0;
  const sliceOf = async (pages: number[]): Promise<Buffer> => {
    const part = await slicer.slice(pages);
    // ilk kesme aynı belgede başarılıydı: burada null beklenmez (şifre ve sayfa sayısı değişmez)
    if (!part) throw new Error('pdf slice refused after the first part');
    return part;
  };
  const read = async (pages: number[], part?: Buffer): Promise<void> => {
    await hooks.beforePart?.({ from: pages[0]!, to: pages.at(-1)!, done, total: pageCount });
    try {
      const r = await readInvoicePdfPart(part ?? (await sliceOf(pages)), { sourceSha256, pages, pageCount, knownSurcharges: hooks.knownSurcharges }, ctx);
      results.push({ pages, data: r.data });
      cached &&= r.cached;
      done += pages.length;
    } catch (e) {
      // kesildi: grup ikiye bölünür (sırayla, sayfa sırası korunur); tek sayfa da kesilirse açık hata
      if (!isTruncated(e) || pages.length < 2) throw e;
      const mid = Math.ceil(pages.length / 2);
      await read(pages.slice(0, mid));
      await read(pages.slice(mid));
    }
  };
  for (const [i, g] of groups.entries()) await read(g, i === 0 ? first : undefined);
  const merged = mergePdfParts(results);
  // Y96: taranmış (metinsiz) ilk grupta kesmenin içeriği koruduğu metinle denetlenemedi: önizlemede not
  const review = kept === 'unchecked' ? { ...merged.review, sliceUnchecked: true } : merged.review;
  return { data: merged.data, cached, parts: results.length, review };
}
