import { fromCents, subMoney, toCents } from './calc';
import { PAK_NOTE, type DiffType } from './compare';
import { fmtNumber } from './format';
import { DEFAULT_LOCALE, t as tt, type Locale } from './i18n/index';

/** Fatura özetinin (ekran, Excel, PDF) okuduğu toplamlar; yeni alanlar eski kayıtlı özetlerde yoktur. */
export type InvoiceSummaryTotals = {
  lines: number;
  match: number;
  diff: number;
  unmatched: number;
  noTariff: number;
  billedTotal: number;
  /** Karşılaştırılan satırların faturalanan toplamı (tarifede olmayan ek ücretler dahil). */
  comparedBilledTotal?: number;
  expectedTotal: number;
  /** Karşılaştırılan satırlarda Beklenen'e faturadaki tutarıyla eklenen, tarifede tanımlı olmayan ek ücretler. */
  uncheckedSurchargeTotal?: number;
  /** Pak/zarf satırları (kapsam dışı): ölçümü olmayanlar `unmatched`, ölçülmüş olanlar `noTariff` içinde de sayılır. */
  pakUnmatched?: number;
  pakNoTariff?: number;
  /** SPEC §3.8: tahmini (LOW güvenli) fark satırlarının fazlası; Fazla ödeme'ye girmez. */
  estimatedOverchargeTotal?: number;
  estimatedLines?: number;
  /** "Nasıl hesaplandı?" adımları (Mesaj 5 öncesi kayıtlı özetlerde yok). Mükerrer tutarı `uncompared` adımından okunur. */
  reconciliation?: { steps: readonly ReconStep[] };
};

/**
 * Faturalanan'a eklenen mükerrer tutarı: beklenen tutarı olmayan fark satırlarının faturalanan tutarı, "İncele" ve
 * Uyumlu sayılanlar dahil (`uncompared` adımı; mükerrer satırın farkı faturalanan tutarının tamamıdır). Adım yoksa (eski
 * kayıt) bilinemez: 0.
 */
function duplicateBilled(t: InvoiceSummaryTotals): number {
  return t.reconciliation?.steps.find((s) => s.key === 'uncompared')?.amount ?? 0;
}

/** "Tahmini" etiketinin açıklaması (ekran, Excel, PDF). */
export const ESTIMATED_NOTE = tt('tr', 'summary.estimatedNote');

/** `ESTIMATED_NOTE` istenen dilde. */
export function estimatedNote(locale: Locale = DEFAULT_LOCALE): string {
  return tt(locale, 'summary.estimatedNote');
}

/** Satırın notu pak/zarf "kapsam dışı" notu mu? */
export function isPakNote(note: string | null | undefined): boolean {
  return !!note && (note.startsWith(PAK_NOTE) || note.startsWith(tt('en', 'compare.pak')));
}

/**
 * "Karşılaştırılan satırlarda" kutusunun tutarları (ekran, Excel, PDF aynı işlevi okur). Faturalanan ile Beklenen AYNI
 * kalemleri kapsar: karşılaştırılan satırların tüm ücretleri ve mükerrer satırlar (karar 2026-11-12: mükerrer satır
 * Faturalanan'a tam tutarıyla girer, beklenen tutarı 0 sayılır; böylece Faturalanan − Beklenen = Fazla ödeme tutar).
 * Mükerrer, özet cümlesinde de "karşılaştırılan" (fark olan) satır sayılır. Tarifede olmayan ek ücretler Beklenen'e
 * faturadaki tutarıyla girer (`unchecked`, bilgi olarak ayrıca gösterilir). Fatura toplamı farklıysa ayrı satırda.
 * Satır sonuçları ve `overchargeTotal` değişmez; yalnız kutunun neyi topladığı.
 */
export function invoiceSummaryAmounts(t: InvoiceSummaryTotals): {
  billed: number;
  expected: number;
  /** Faturalanan'ın içindeki mükerrer tutarı (beklenen karşılığı 0). */
  duplicates: number;
  unchecked: number;
  invoiceTotal: number;
  /** Fatura toplamı (tüm satırlar) ayrıca gösterilsin mi (Faturalanan'dan farklıysa) */
  showInvoiceTotal: boolean;
} {
  const unchecked = t.uncheckedSurchargeTotal ?? 0;
  // çok eski özette `comparedBilledTotal` yok: Faturalanan zaten faturanın tamamı, mükerrer ayrıca eklenmez
  const duplicates = t.comparedBilledTotal != null ? duplicateBilled(t) : 0;
  const billed = t.comparedBilledTotal != null ? fromCents(toCents(t.comparedBilledTotal) + toCents(duplicates)) : t.billedTotal;
  return { billed, expected: t.expectedTotal, duplicates, unchecked, invoiceTotal: t.billedTotal, showInvoiceTotal: toCents(billed) !== toCents(t.billedTotal) };
}

/**
 * Faturada karşılaştırılan (uyumlu ya da fark olan) satır yok: ör. yeni yüklenmiş, ölçümü olmayan fatura. Ekran
 * Faturalanan/Beklenen yerine fatura toplamını ve "henüz karşılaştırılmadı" yazar (0,00 göstermez).
 */
export function nothingCompared(t: InvoiceSummaryTotals): boolean {
  return t.lines > 0 && t.match + t.diff === 0;
}

/**
 * Tamamı mükerrer fatura ve mükerrer tutarı bilinmiyor (adımları olmayan eski kayıt): Faturalanan/Beklenen 0/0 kalır;
 * ekran bu iki sıfır yerine tek satır açıklama yazar. Adımlar varsa mükerrer Faturalanan'a girer, bu durum oluşmaz.
 * `comparedBilledTotal` eski kayıtlı özetlerde yok: o zaman bilinemez, false.
 */
export function onlyDuplicateOvercharge(t: InvoiceSummaryTotals, overchargeTotal: number): boolean {
  return t.comparedBilledTotal === 0 && t.expectedTotal === 0 && duplicateBilled(t) === 0 && overchargeTotal > 0;
}

/** Faturalanan − Beklenen ile Fazla ödeme arasındaki adım (ad: `ReconStepKey`; tutar Fazla ödeme'ye imzalı katkı). */
export type SummaryGapPart = { key: Exclude<ReconStepKey, 'netDiff' | 'uncompared'>; amount: number };

/**
 * Özetin tek satırlık hesabı: Faturalanan − Beklenen (`net`) ve Fazla ödeme'ye varmak için gereken adımlar (tolerans
 * içi farklar, kabul edilenler, incelenecekler, lehe farklar). `parts` boşsa Faturalanan − Beklenen = Fazla ödeme.
 * Adımlar API'nin kayıtlı dökümünden gelir; kutulardaki sayılarla kuruşu tutmayan artık (bozuk/eski kayıt) "diğer"e
 * yazılır, satır her zaman toplanır. Döküm yoksa (eski kayıt) null: ekran eski açıklamayı (`overchargeNote`) kullanır.
 */
export function summaryGap(
  t: InvoiceSummaryTotals,
  overchargeTotal: number,
): { billed: number; expected: number; net: number; parts: SummaryGapPart[] } | null {
  if (!t.reconciliation || t.comparedBilledTotal == null) return null;
  const a = invoiceSummaryAmounts(t);
  const net = subMoney(a.billed, a.expected);
  const cents = new Map<SummaryGapPart['key'], number>();
  for (const s of t.reconciliation.steps) {
    if (s.key === 'netDiff' || s.key === 'uncompared') continue;
    cents.set(s.key, (cents.get(s.key) ?? 0) + toCents(s.amount));
  }
  let sum = toCents(net);
  for (const c of cents.values()) sum += c;
  const rest = toCents(overchargeTotal) - sum;
  if (rest !== 0) cents.set('other', (cents.get('other') ?? 0) + rest);
  const parts: SummaryGapPart[] = [];
  for (const key of RECON_ORDER) {
    if (key === 'netDiff' || key === 'uncompared') continue;
    const c = cents.get(key) ?? 0;
    if (c !== 0) parts.push({ key, amount: fromCents(c) });
  }
  return { billed: a.billed, expected: a.expected, net, parts };
}

/**
 * "Nasıl hesaplandı?" ekranda: mükerrer Faturalanan'ın içinde olduğundan `uncompared` adımı `netDiff`'e (Faturalanan −
 * Beklenen) katılır. Kayıtlı döküm değişmez; toplam aynı kalır.
 */
export function foldDuplicateStep<S extends { key: string; amount: number; lines: number }>(steps: readonly S[]): S[] {
  const dup = steps.find((s) => s.key === 'uncompared');
  if (!dup || !steps.some((s) => s.key === 'netDiff')) return [...steps];
  return steps
    .filter((s) => s.key !== 'uncompared')
    .map((s) => (s.key === 'netDiff' ? { ...s, amount: fromCents(toCents(s.amount) + toCents(dup.amount)), lines: s.lines + dup.lines } : s));
}

/** Büyük "Fazla ödeme" sayısı ile Faturalanan − Beklenen neden farklı: tek satırlık açıklama. */
export const OVERCHARGE_NOTE = tt('tr', 'summary.overchargeNote');

/**
 * Fazla ödeme (fark olan satırların pozitif farkları + mükerrer) Faturalanan − Beklenen'den (net fark, mükerrer dahil;
 * uyumlu satırlardaki küçük, çoğu zaman lehe farklar da netleşir) farklıysa açıklama; aynıysa null (gereksiz metin yok).
 */
export function overchargeNote(t: InvoiceSummaryTotals, overchargeTotal: number, locale: Locale = DEFAULT_LOCALE): string | null {
  const a = invoiceSummaryAmounts(t);
  // tahmini satırların fazlası da Faturalanan − Beklenen'in içindedir
  const all = subMoney(overchargeTotal, -(t.estimatedOverchargeTotal ?? 0));
  return subMoney(subMoney(a.billed, a.expected), all) === 0 ? null : tt(locale, 'summary.overchargeNote');
}

/**
 * Özetin tek cümlesi: "19/120 satır karşılaştırıldı · 3 satırda fark var · 63 satırın ölçümü bulunamadı ·
 * 38 pak/zarf satırı kapsam dışı". Pak/zarf satırları ölçüm/tarife sayılarından ayrılır (toplamların anlamı değişmez).
 */
export function invoiceSummarySentence(t: InvoiceSummaryTotals, locale: Locale = DEFAULT_LOCALE): string {
  const n = (x: number) => fmtNumber(x, 0, locale);
  // kontrol edilen satırlar: uyumlu + fark (mükerrer satır da fark sayılır)
  const compared = t.match + t.diff;
  const pakU = t.pakUnmatched ?? 0;
  const pakT = t.pakNoTariff ?? 0;
  const parts: string[] = [];
  const partial = t.lines > 0 && compared < t.lines;
  if (partial) {
    const params = { compared: n(compared), lines: n(t.lines) };
    parts.push(tt(locale, t.diff > 0 ? 'summary.compared' : 'summary.comparedNoDiff', params));
  } else if (t.diff === 0) {
    parts.push(tt(locale, 'summary.noDiff'));
  }
  if (t.diff > 0) parts.push(tt(locale, 'summary.diff', { count: n(t.diff) }));
  const unmatched = t.unmatched - pakU;
  if (unmatched > 0) parts.push(tt(locale, 'summary.unmatched', { count: n(unmatched) }));
  const noTariff = t.noTariff - pakT;
  if (noTariff > 0) parts.push(tt(locale, 'summary.noTariff', { count: n(noTariff) }));
  if (pakU + pakT > 0) parts.push(tt(locale, 'summary.pak', { count: n(pakU + pakT) }));
  return parts.join(' · ');
}

/**
 * "Nasıl hesaplandı?" (Mesaj 5, denetim 08-B10): Fazla ödeme rakamının Faturalanan − Beklenen'den adım adım çıkışı.
 * Fazla ödeme kuralı DEĞİŞMEZ (API `countsAsOvercharge` / `computeTotals`): fark olan (DIFF), kabul edilmemiş, tutarı
 * tahmini olmayan satırların pozitif farkı. Burada yalnız açıklanır; adımların toplamı kuruşu kuruşuna `overchargeTotal`
 * ve türlere göre toplamla aynıdır.
 *
 * Adımlar (imzalı katkı, sırayla):
 * - `netDiff`: karşılaştırılan (beklenen tutarı olan) satırların farkı (`comparedBilledTotal − expectedTotal`).
 * - `uncompared`: beklenen tutarı olmayan fark satırları (mükerrer: faturalanan tutarın tamamı), güveni ve kararı ne
 *   olursa olsun: Faturalanan taşıyıcının kestiğidir. Özet kutusundaki Faturalanan − Beklenen = `netDiff + uncompared`
 *   (mükerrer Faturalanan'a girer; `invoiceSummaryAmounts`). Fazla ödemeye girmeyen mükerrer (Uyumlu sayılan ya da
 *   "İncele") aynı tutarla `accepted` / `review` adımında geri çıkar.
 * - `matchLines`: uyumlu satırların tolerans içindeki küçük ARTI farkları çıkar (yalnız fark > 0 olan uyumlu satırlar).
 * - `accepted`: "Uyumlu say" denen fark satırları çıkar.
 * - `review`: tutarından emin olunamayan ("İncele", tahmini) fark satırları çıkar; ayrıca gösterilir.
 * - `favourable`: lehe (eksi) farklar fazla ödemeden düşülmez, geri eklenir: fazla ödeme kümesindeki eksi farklar ve
 *   uyumlu satırların eksi farkları (taşıyıcı sözleşmeden ucuza kesmiş; tutarı sınırsız olabilir, tolerans değildir).
 * - `other`: beklenen tutarı olup uyumlu da fark da olmayan satırlar (olağan veride yok).
 * `netDiff` her zaman yazılır; diğer adımlar tutarı 0 değilse.
 */
export type ReconStepKey = 'netDiff' | 'uncompared' | 'matchLines' | 'accepted' | 'review' | 'favourable' | 'other';
export type ReconStep = { key: ReconStepKey; amount: number; lines: number };
/** İlk fark türüne göre (Pano ile aynı), tutarı büyükten küçüğe. */
export type OverchargeByType = { type: DiffType; lines: number; amount: number };
export type OverchargeReconciliation = { steps: ReconStep[]; overchargeTotal: number };

export type ReconLineInput = {
  status: string;
  decision: string;
  expectedAmount: number | null;
  diffAmount: number | null;
  diffTypes: readonly string[];
  /** Tutarı tahmini (LOW güvenli, "İncele") satır. */
  estimated: boolean;
};

const DIFF_TYPES: readonly DiffType[] = ['DUPLICATE', 'DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE', 'PACKAGING'];
const RECON_ORDER: readonly ReconStepKey[] = ['netDiff', 'uncompared', 'matchLines', 'accepted', 'review', 'favourable', 'other'];

/** API `countsAsOvercharge` ile aynı küme. */
function inOvercharge(l: ReconLineInput): boolean {
  return l.status === 'DIFF' && l.decision !== 'ACCEPTED' && !l.estimated;
}

export function overchargeReconciliation(lines: readonly ReconLineInput[]): {
  reconciliation: OverchargeReconciliation;
  overchargeByType: OverchargeByType[];
} {
  const acc = new Map<ReconStepKey, { cents: number; lines: number }>(RECON_ORDER.map((k) => [k, { cents: 0, lines: 0 }]));
  const add = (key: ReconStepKey, cents: number) => {
    const a = acc.get(key)!;
    a.cents += cents;
    a.lines++;
  };
  let overchargeCents = 0;
  const byType = new Map<DiffType, { lines: number; cents: number }>();

  for (const l of lines) {
    const d = l.diffAmount != null && Number.isFinite(l.diffAmount) ? toCents(l.diffAmount) : 0;
    const counted = inOvercharge(l);
    const positive = counted ? Math.max(0, d) : 0;
    if (counted) {
      overchargeCents += positive;
      // DIFF satırında fark türü hep vardır; olmayan (bozuk kayıt) tutar kaybolmasın diye fiyat farkına yazılır.
      const first = l.diffTypes[0] as DiffType | undefined;
      const type: DiffType = first && DIFF_TYPES.includes(first) ? first : 'PRICE';
      const e = byType.get(type) ?? { lines: 0, cents: 0 };
      e.lines++;
      e.cents += positive;
      byType.set(type, e);
    }
    if (l.expectedAmount == null) {
      // Mükerrer (beklenen tutarı olmayan fark satırı) taşıyıcının kestiği tutardır: güveni ve kararı ne olursa olsun
      // Faturalanan'a girer. Fazla ödemeye girmeyeni (Uyumlu sayılan, "İncele") kendi adımında geri çıkar.
      if (l.status !== 'DIFF') continue;
      const billed = Math.max(0, d);
      add('uncompared', billed);
      if (!counted && billed !== 0) add(l.decision === 'ACCEPTED' ? 'accepted' : 'review', -billed);
      continue;
    }
    add('netDiff', d);
    if (l.status === 'MATCH') {
      if (d < 0) add('favourable', -d);
      else if (d > 0) add('matchLines', -d);
    }
    else if (l.status !== 'DIFF') add('other', -d);
    else if (l.decision === 'ACCEPTED') add('accepted', -d);
    else if (l.estimated) add('review', -d);
    else if (d < 0) add('favourable', -d);
  }

  const steps: ReconStep[] = [];
  for (const key of RECON_ORDER) {
    const a = acc.get(key)!;
    if (key !== 'netDiff' && a.cents === 0) continue;
    steps.push({ key, amount: fromCents(a.cents), lines: a.lines });
  }
  const overchargeByType = [...byType.entries()]
    .map(([type, e]) => ({ type, lines: e.lines, amount: fromCents(e.cents) }))
    .sort((a, b) => b.amount - a.amount || b.lines - a.lines);
  return { reconciliation: { steps, overchargeTotal: fromCents(overchargeCents) }, overchargeByType };
}
