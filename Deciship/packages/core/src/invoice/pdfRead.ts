import { INCH_TO_CM, LB_TO_KG, lengthFactor, weightFactor } from './values';

/**
 * PDF fatura okumasında KDV oranı, ağırlık ve ölçü birimi (Y20, denetim 04-B12). Yapay zekâ belgede yazanı okur (`vatPct`,
 * `weightUnit`, `dimUnit`); okuyamadıysa bugünkü varsayılan kullanılır (KDV %20, kg, cm) ve bunun varsayım olduğu kayda
 * geçer. Çevirme kuralı CSV/Excel yoluyla aynıdır (`weightFactor` 1 lb = 0,45359237 kg, `lengthFactor` 1 in = 2,54 cm).
 *
 * İnceleme (para): okunan oran metinde doğrulanır (`pdfVatRateCheck`), lb okunmuş ama değer zaten kg yazılmışsa ikinci kez
 * çevrilmez (`pdfLbAlreadyKg`), tanınmayan birimdeki (oz, ton…) değer kullanılmaz.
 */

/** Okunamadığında kullanılan KDV oranı (CSV/Excel eşlemesinin varsayılanıyla aynı). */
export const PDF_DEFAULT_VAT_PCT = 20;
/** Okunan oranın kabul edilen aralığı (yüzde). Dışındaki değer (ör. 0,2 kesir yazımı ya da 120) okunmamış sayılır. */
export const PDF_VAT_PCT_MAX = 50;
/** Türkiye'de olağan KDV oranları (eski ve yeni). Okunan oran bunların dışındaysa güvenilmez sayılır. */
export const PDF_USUAL_VAT_PCTS: readonly number[] = [0, 1, 8, 10, 18, 20];

export type PdfWeightUnit = 'kg' | 'lb' | 'g';
export type PdfDimUnit = 'cm' | 'in';

export type PdfReadUnits = {
  /** Tutarları nete çevirmede kullanılan oran. */
  vatPct: number;
  /** Oran belgeden okunamadı ve tutarlar KDV dahil (oran sonucu etkiliyor): varsayılan kullanıldı. */
  vatAssumed: boolean;
  weightUnit: PdfWeightUnit;
  /** Birim belgeden okunamadı ve satırlarda ağırlık var: kg varsayıldı. */
  weightAssumed: boolean;
  /** Birim yazıyor ama tanınmadı (oz, ton…) ve satırlarda ağırlık var: faturadaki ağırlıklar kullanılmaz. */
  weightUnusable: boolean;
  /** Ağırlıkların kg çarpanı (lb → 0,45359237, g → 0,001, kg → 1). */
  weightFactor: number;
  dimUnit: PdfDimUnit;
  /** Ölçü birimi okunamadı ve satırlarda ölçü var: cm varsayıldı. */
  dimAssumed: boolean;
  /** Ölçü birimi yazıyor ama tanınmadı (mm, m…) ve satırlarda ölçü var: faturadaki ölçüler kullanılmaz. */
  dimUnusable: boolean;
  /** Ölçülerin cm çarpanı (in → 2,54). */
  dimFactor: number;
};

const KG_WORDS = /^(k|kg|kgs|kilo|kilos|kilogram|kilograms|kilogramm|desi)$/;
const G_WORDS = /^(g|gr|grs|gram|grams|gramm|gramme|grammes)$/;
const CM_WORDS = /^(c|cm|cms|santim|santimetre|centimeter|centimeters|centimetre|centimetres)$/;

const unitKey = (raw: string | null | undefined) =>
  String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zçı]/g, '');

/** Yapay zekânın yazdığı ağırlık birimi → kg | lb | g; yazıyor ama tanınmıyorsa 'other'; boşsa null (okunmamış). */
export function pdfWeightUnitOf(raw: string | null | undefined): PdfWeightUnit | 'other' | null {
  const u = unitKey(raw).replace(/[^a-z]/g, '');
  if (!u) return null;
  if (weightFactor(u) === LB_TO_KG) return 'lb';
  if (KG_WORDS.test(u)) return 'kg';
  return G_WORDS.test(u) ? 'g' : 'other';
}

/** Ölçü birimi → cm | in; yazıyor ama tanınmıyorsa 'other' (mm, m…); boşsa null. */
export function pdfDimUnitOf(raw: string | null | undefined): PdfDimUnit | 'other' | null {
  const u = unitKey(raw);
  if (!u) return null;
  if (lengthFactor(u) === INCH_TO_CM) return 'in';
  return CM_WORDS.test(u) ? 'cm' : 'other';
}

/** Okunan KDV oranı geçerliyse (0–50) iki ondalığa yuvarlanmış hâli, değilse null. */
export function pdfVatPctOf(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > PDF_VAT_PCT_MAX) return null;
  // 0 ile 1 arası kesir yazımı olabilir (0,2 = %20 mi, %0,2 mi belirsiz): okunmamış sayılır
  if (raw > 0 && raw < 1) return null;
  return Math.round(raw * 100) / 100;
}

/**
 * Okunan değerler → kullanılacak oran ve birimler. `hasWeights` / `hasDims`: satırlardan en az birinde ağırlık / ölçü var
 * (yoksa birim önemsizdir, not yazılmaz). Oran yalnız tutarlar KDV dahilken sonucu etkiler; varsayım notu yalnız o zaman.
 */
export function resolvePdfReadUnits(raw: {
  vatPct?: number | null;
  weightUnit?: string | null;
  dimUnit?: string | null;
  amountsIncludeVat: boolean;
  hasWeights: boolean;
  hasDims?: boolean;
}): PdfReadUnits {
  const vat = pdfVatPctOf(raw.vatPct);
  const w = pdfWeightUnitOf(raw.weightUnit);
  const d = pdfDimUnitOf(raw.dimUnit);
  const weightUnit: PdfWeightUnit = w === 'lb' || w === 'g' ? w : 'kg';
  const dimUnit: PdfDimUnit = d === 'in' ? 'in' : 'cm';
  return {
    vatPct: vat ?? PDF_DEFAULT_VAT_PCT,
    vatAssumed: vat == null && raw.amountsIncludeVat,
    weightUnit,
    weightAssumed: w == null && raw.hasWeights,
    weightUnusable: w === 'other' && raw.hasWeights,
    weightFactor: weightUnit === 'lb' ? LB_TO_KG : weightUnit === 'g' ? 0.001 : 1,
    dimUnit,
    dimAssumed: d == null && !!raw.hasDims,
    dimUnusable: d === 'other' && !!raw.hasDims,
    dimFactor: dimUnit === 'in' ? INCH_TO_CM : 1,
  };
}

// ---------------------------------------------------------------------------------------------
// KDV oranının metinde doğrulanması (inceleme 1): oran yanlış okunursa net tutar yanlış çıkar, ama tutar denetimi aynı
// oranla geri çarptığı için metindeki KDV dahil tutarı bulur ve "temiz" der. Oranın kendisi metinde aranır.

/** Oran sayısı: "20", "20,00", "18.5"; ardından başka rakam gelmez (tutar ya da tarihin parçası değil). */
const RATE = String.raw`(\d{1,2}(?:[.,]\d{1,2})?)(?![.,]?\d)`;
/** "KDV %20", "KDV: 20", "K.D.V. (%18)", "KDV Oranı %20", "VAT 20%", "VAT rate: 20 %". */
const VAT_THEN_RATE = new RegExp(String.raw`(?:K\.?\s?D\.?\s?V\.?|\bVAT|\bTAX)\s*(?:oran[ıi]|rate)?\s*[:(]?\s*(?:%\s*${RATE}|(?<![\d.,])${RATE}\s*%?)`, 'gi');
/** "%20 KDV", "20% VAT" (aynı satırda; ardından kendi oranı gelen "KDV" sayılmaz: "%10 KDV %20"de 10 indirimdir). */
const RATE_THEN_VAT = new RegExp(String.raw`(?:%[ \t]*${RATE}|(?<![\d.,])${RATE}[ \t]*%)[ \t]*(?:K\.?\s?D\.?\s?V|VAT)(?![ \t]*[:(]?[ \t]*%?[ \t]*\d)`, 'gi');
/** Bağlamsız yüzde: "%20", "% 20", "20%", "20 %". */
const ANY_PERCENT = new RegExp(String.raw`(?:%\s*${RATE}|(?<![\d.,])${RATE}\s*%)`, 'g');

const rateNum = (s: string) => Math.round(Number(s.replace(',', '.')) * 100) / 100;

function ratesBy(re: RegExp, text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const v = m.slice(1).find((x) => x != null);
    if (v != null) out.add(rateNum(v));
  }
  return out;
}

/** Metinde KDV bağlamında geçen oranlar ("KDV %20" → 20) ve bağlamsız yüzdeler. */
export function pdfVatRatesInText(pageTexts: readonly string[]): { vat: Set<number>; percents: Set<number> } {
  const text = pageTexts.join('\n');
  const vat = ratesBy(VAT_THEN_RATE, text);
  for (const r of ratesBy(RATE_THEN_VAT, text)) vat.add(r);
  return { vat, percents: ratesBy(ANY_PERCENT, text) };
}

export type PdfVatRateCheck = {
  /** `false`: satırlar "KDV belirsiz" (`PDF_VAT_UNCLEAR`) olmalı. */
  trusted: boolean;
  /** Neden güvenilmez: olağan oran değil, metinde yok, metin başka oran söylüyor. */
  reason?: 'unusual' | 'notInText' | 'contradicted';
};

/**
 * Tutarlar KDV dahilken nete çevirmede kullanılan oran güvenilir mi.
 * - Okunan oran: olağan oranlardan biri (0, 1, 8, 10, 18, 20) olmalı ve metin varsa metinde geçmeli. Metinde KDV
 *   bağlamında oran yazıyorsa ("KDV %20", "KDV 20", "VAT 20%", "%8 KDV") yalnız onlar sayılır; yazmıyorsa bağlamsız yüzde
 *   ("%20", "% 20", "20%") yeter.
 * - Varsayılan oran (%20, okunmadı): yalnız metin KDV bağlamında başka bir oran söylüyorsa güvenilmez (yoksa varsayım notu yeter).
 * - Tutarlar KDV hariçse ya da metin yoksa (taranmış belge, denetlenemez) güvenilir sayılır; olağan dışı okunan oran yine güvenilmez.
 */
export function pdfVatRateCheck(pageTexts: readonly string[] | null, o: { vatPct: number; assumed: boolean; amountsIncludeVat: boolean }): PdfVatRateCheck {
  if (!o.amountsIncludeVat) return { trusted: true };
  if (!o.assumed && !PDF_USUAL_VAT_PCTS.includes(o.vatPct)) return { trusted: false, reason: 'unusual' };
  const hasText = !!pageTexts?.some((t) => t.trim() !== '');
  if (!hasText) return { trusted: true };
  const { vat, percents } = pdfVatRatesInText(pageTexts!);
  // KDV bağlamında oran yazıyorsa yalnız o sayılır ("%10 indirim" "KDV %20"yi geçersiz kılmaz); yazmıyorsa bağlamsız yüzde
  if (o.assumed) return vat.size && !vat.has(o.vatPct) ? { trusted: false, reason: 'contradicted' } : { trusted: true };
  const found = vat.size ? vat.has(o.vatPct) : percents.has(o.vatPct);
  return found ? { trusted: true } : { trusted: false, reason: vat.size ? 'contradicted' : 'notInText' };
}

// ---------------------------------------------------------------------------------------------
// Çift çevirmeye karşı (inceleme 2): model değeri kendisi kg'a çevirip birimi yine "lb" derse ağırlık iki kez küçülürdü.

/** Metindeki sayılar (TR "1.234,56" ve EN "1,234.56" okumalarıyla), artan sırada. Tarih gibi yazımlar alınmaz. */
export function pdfTextNumbers(pageTexts: readonly string[]): number[] {
  const out = new Set<number>();
  for (const text of pageTexts) {
    for (const tok of text.match(/\d[\d.,]*\d|\d/g) ?? []) for (const v of pdfNumberReadings(tok)) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

const plainNumber = (s: string) => (/^\d+(?:\.\d+)?$/.test(s) ? Number(s) : null);

/**
 * Rakam/ayraç dizisinin olası değerleri: TR ("1.234,5" → 1234,5), EN ("1,234.5" → 1234,5) ve düz ("12,5" / "12.5" →
 * 12,5; "1.234" hem 1234 hem 1,234). Tarih gibi yazımlar ("20.10.2026") değer vermez.
 */
export function pdfNumberReadings(tok: string): number[] {
  const tr = plainNumber(tok.replace(/\.(?=\d{3}(?!\d))/g, '').replace(',', '.'));
  const en = plainNumber(tok.replace(/,(?=\d{3}(?!\d))/g, ''));
  const plain = /^\d+[.,]\d+$/.test(tok) ? plainNumber(tok.replace(',', '.')) : null;
  const out: number[] = [];
  for (const v of [tr, en, plain]) if (v != null && Number.isFinite(v) && !out.includes(v)) out.push(v);
  return out;
}

function near(sorted: readonly number[], x: number, tol: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < x - tol) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! <= x + tol;
}

/**
 * Birim "lb" okunmuş ama `v` zaten kg mı: `v`'nin lb karşılığı (`v / 0,4536`) metinde var ve `v`'nin kg karşılığı
 * (`v × 0,4536`) yok. Metinde hem lb hem kg basılıysa ve model lb değerini verdiyse kg karşılığı da metindedir: çevrilir.
 * Metin yoksa ya da iki karşılık da yoksa false (bugünkü gibi çevrilir). Yuvarlama payı: iki ondalık.
 */
export function pdfLbAlreadyKg(textNumbers: readonly number[], v: number): boolean {
  if (!textNumbers.length || !(v > 0)) return false;
  return near(textNumbers, v / LB_TO_KG, 0.006 / LB_TO_KG) && !near(textNumbers, v * LB_TO_KG, 0.006);
}

// ---------------------------------------------------------------------------------------------
// Kayıt ve rapor notu: önizleme kaydı (`File.preview.read`) ve içe aktarma raporu (`importReport.pdfRead`) aynı biçimde.

export type PdfReadNote = {
  vatPct: number;
  weightUnit: PdfWeightUnit;
  /** Y20 incelemesinden önceki kayıtta yok (cm sayılır). */
  dimUnit?: PdfDimUnit;
  vatAssumed?: true;
  /** Okunan (ya da varsayılan) oran metinde doğrulanamadı: satırlar "KDV belirsiz". */
  vatUnverified?: true;
  weightAssumed?: true;
  weightUnusable?: true;
  /** Birim lb okundu ama bu kadar satırın değeri zaten kg yazılmıştı: çevrilmedi. */
  weightKeptLines?: number;
  dimAssumed?: true;
  dimUnusable?: true;
  /** Sayfa grupları farklı birim söyledi; her grup kendi biriminden çevrildi. */
  unitsMixed?: true;
};

export type PdfReadNoteInput = {
  vatPct: number;
  weightUnit: PdfWeightUnit;
  dimUnit?: PdfDimUnit;
  vatAssumed?: boolean;
  vatUnverified?: boolean;
  weightAssumed?: boolean;
  weightUnusable?: boolean;
  weightKeptLines?: number;
  dimAssumed?: boolean;
  dimUnusable?: boolean;
  unitsMixed?: boolean;
};

const NOTE_FLAGS = ['vatAssumed', 'vatUnverified', 'weightAssumed', 'weightUnusable', 'dimAssumed', 'dimUnusable', 'unitsMixed'] as const;

/** Notun yazılacak hâli: bayraklar yalnız `true` iken, sayı yalnız 0'dan büyükken. */
export function pdfReadNote(i: PdfReadNoteInput): PdfReadNote {
  const out: PdfReadNote = { vatPct: i.vatPct, weightUnit: i.weightUnit };
  if (i.dimUnit) out.dimUnit = i.dimUnit;
  for (const k of NOTE_FLAGS) if (i[k] === true) out[k] = true;
  if (Number.isInteger(i.weightKeptLines) && i.weightKeptLines! > 0) out.weightKeptLines = i.weightKeptLines;
  return out;
}

/** Söylenecek bir şey var mı (varsayım, doğrulanamayan oran, çeviri, kullanılmayan değer). */
export function pdfReadNoteWorthy(n: PdfReadNote): boolean {
  return NOTE_FLAGS.some((k) => n[k] === true) || (n.weightKeptLines ?? 0) > 0 || n.weightUnit !== 'kg' || (n.dimUnit ?? 'cm') !== 'cm';
}

/** Kayıttan (JSON) okur; biçimi bozuksa null. */
export function readPdfReadNote(raw: unknown): PdfReadNote | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.vatPct !== 'number' || !Number.isFinite(r.vatPct) || r.vatPct < 0 || r.vatPct > PDF_VAT_PCT_MAX) return null;
  if (r.weightUnit !== 'kg' && r.weightUnit !== 'lb' && r.weightUnit !== 'g') return null;
  if (r.dimUnit != null && r.dimUnit !== 'cm' && r.dimUnit !== 'in') return null;
  const flags = Object.fromEntries(NOTE_FLAGS.map((k) => [k, r[k] === true]));
  return pdfReadNote({
    vatPct: r.vatPct,
    weightUnit: r.weightUnit,
    ...(r.dimUnit ? { dimUnit: r.dimUnit as PdfDimUnit } : {}),
    ...flags,
    ...(typeof r.weightKeptLines === 'number' ? { weightKeptLines: r.weightKeptLines } : {}),
  });
}
