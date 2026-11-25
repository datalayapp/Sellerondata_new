// Mesaj 14 (Parça D): satır seçimi ve toplu karar gövdesi. Saf mantık; React ve ağ yok (test/bulk-select.test.ts).
import type { BulkDecideBody, BulkDecideFilter, BulkDecideResult, BulkDecideSkipped, Decision, InvoiceLine } from '../../api/types';

/** Tek seferde en çok bu kadar satır (sunucu `BULK_TOO_MANY`). */
export const BULK_MAX = 5000;

/**
 * Seçim: `ids` kipinde tek tek işaretlenmiş satırlar (sayfa değişse de korunur), `filter` kipinde süzgecin bütün satırları
 * ("Bu süzgeçteki N satırın tümünü seç"); `count` seçim anındaki toplam (sunucuya `expectedCount` olarak gider),
 * `digest` o listenin sunucudaki küme özeti (liste yanıtının `selectionDigest`'i, Y127): küme ya da kümedeki bir satır
 * değiştiyse sunucu seçimi reddeder (sayı aynı kalsa da). `eligible` (10-B14) süzgeçte kararı değişebilecek satır sayısı
 * (liste yanıtının `selectionEligible`'ı; eski sunucuda yok): ekranda ve onay metninde seçilen sayı budur.
 */
export type Selection = { mode: 'ids'; ids: ReadonlySet<string> } | { mode: 'filter'; count: number; digest: string; eligible?: number };

export const EMPTY_SELECTION: Selection = { mode: 'ids', ids: new Set() };

/** Kutunun etkin olması: kararı bekleyen, hesabı güncel, itirazda olmayan fark satırı. "İncele" satırı da uygun (yalnız "Uyumlu say" ile). */
export function isEligible(l: Pick<InvoiceLine, 'status' | 'decision' | 'recalcPending' | 'dispute'>): boolean {
  return l.status === 'DIFF' && l.decision === 'OPEN' && !l.recalcPending && !l.dispute;
}

/** Seçilen (kararı değişebilecek) satır sayısı: `filter` kipinde süzgecin toplamı değil, uygun satırlar (biliniyorsa). */
export function selectedCount(s: Selection): number {
  return s.mode === 'filter' ? (s.eligible ?? s.count) : s.ids.size;
}

/** Satırın kutusu işaretli mi (`filter` kipinde uygun olan her satır işaretlidir). */
export function isChecked(s: Selection, id: string, eligible: boolean): boolean {
  return s.mode === 'filter' ? eligible : s.ids.has(id);
}

export type PageState = 'none' | 'some' | 'all';

/** Başlıktaki kutu: `pageIds` bu sayfanın uygun satırları. */
export function pageState(s: Selection, pageIds: readonly string[]): PageState {
  if (pageIds.length === 0) return 'none';
  if (s.mode === 'filter') return 'all';
  const n = pageIds.filter((id) => s.ids.has(id)).length;
  return n === 0 ? 'none' : n === pageIds.length ? 'all' : 'some';
}

/**
 * Tek satırın işareti. `filter` kipinde işaret kaldırılırsa seçim, bu sayfanın uygun satırlarından o satır çıkarılmış
 * `ids` kipine döner (süzgecin başka sayfalardaki satırları artık seçili değildir).
 */
export function toggleLine(s: Selection, id: string, pageIds: readonly string[]): Selection {
  if (s.mode === 'filter') return { mode: 'ids', ids: new Set(pageIds.filter((x) => x !== id)) };
  const ids = new Set(s.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { mode: 'ids', ids };
}

/** Başlıktaki kutu: sayfadaki hepsi seçiliyse hepsini bırakır, değilse hepsini ekler (diğer sayfaların seçimi korunur). */
export function togglePage(s: Selection, pageIds: readonly string[]): Selection {
  if (s.mode === 'filter') return EMPTY_SELECTION;
  const ids = new Set(s.ids);
  if (pageState(s, pageIds) === 'all') for (const id of pageIds) ids.delete(id);
  else for (const id of pageIds) ids.add(id);
  return { mode: 'ids', ids };
}

export function selectFilter(count: number, digest: string, eligible?: number | null): Selection {
  return eligible == null ? { mode: 'filter', count, digest } : { mode: 'filter', count, digest, eligible };
}

/**
 * "Bu süzgeçteki N satırın tümünü seç" bağlantısı: sayfadaki bütün uygun satırlar seçili, süzgeçte başka satırlar da var,
 * toplam tek seferlik sınırı aşmıyor ve liste küme özetini verdi (`digest`; vermediyse seçim sunucuda doğrulanamaz).
 * 10-B14: süzgeçteki uygun satır sayısı biliniyorsa (`eligible`) ve sayfadakilerden fazla değilse bağlantı sunulmaz (seçime
 * bir şey eklemez).
 */
export function offersSelectAll(
  s: Selection,
  pageIds: readonly string[],
  itemsOnPage: number,
  total: number,
  digest: string | null | undefined,
  eligible?: number | null,
): boolean {
  return (
    s.mode === 'ids' &&
    pageState(s, pageIds) === 'all' &&
    total > itemsOnPage &&
    total <= BULK_MAX &&
    Boolean(digest) &&
    (eligible == null || eligible > pageIds.length)
  );
}

/** Süzgeç parçaları değişince seçim sıfırlanır: seçimin geçerli olduğu süzgecin anahtarı. */
export function selectionKey(parts: { invoiceId: string; tab: string; diffType: string; decision: string; q: string }): string {
  return JSON.stringify([parts.invoiceId, parts.tab, parts.diffType, parts.decision, parts.q]);
}

/** Karar süzgecindeki ek seçenekler (adres değerleri; `InvoiceDetail.tsx` ile aynı). */
const RECALC = 'RECALC';
const REVIEW = 'REVIEW';

/** Listenin süzgeci, sunucunun toplu karar `filter` gövdesi olarak (liste çağrısıyla aynı kurallar; boş alan gönderilmez). */
export function filterOf(p: { tab: string; diffType: string; decision: string; q: string }): BulkDecideFilter {
  const f: BulkDecideFilter = {};
  if (p.tab === 'DIFF') f.status = 'DIFF';
  if (p.diffType) f.diffType = p.diffType as BulkDecideFilter['diffType'];
  if (p.decision === RECALC) f.recalcPending = true;
  else if (p.decision === REVIEW) f.review = true;
  else if (p.decision) f.decision = [p.decision as Decision];
  if (p.q) f.q = p.q;
  return f;
}

/** Karar gövdesi: `ids` kipinde `lineIds`, `filter` kipinde süzgeç, `expectedCount` ve `selectionDigest`. */
export function decideBody(s: Selection, decision: Decision, filter: BulkDecideFilter, reason?: string): BulkDecideBody {
  const body: BulkDecideBody =
    s.mode === 'filter' ? { decision, filter, expectedCount: s.count, selectionDigest: s.digest } : { decision, lineIds: [...s.ids] };
  if (reason) body.reason = reason;
  return body;
}

/**
 * "Geri al" gövdesi: ilk işlemin değiştirdiği satırlar ve işlemin kimliği + karar anı. Sunucu yalnız o kararı hâlâ taşıyan
 * satırları açar; arada başkasının (ya da sonradan verilen) kararı kalır ve `changedSince` olarak sayılır.
 */
export function undoBody(r: Pick<BulkDecideResult, 'opId' | 'changedLineIds' | 'decidedAt'>): BulkDecideBody {
  return { decision: 'OPEN', lineIds: [...r.changedLineIds], ...(r.decidedAt ? { undoOf: { opId: r.opId, decidedAt: r.decidedAt } } : {}) };
}

export type SkipKey = 'inDispute' | 'review' | 'decided' | 'pending' | 'noClaim' | 'noGap' | 'changedSince';
const SKIP_ORDER: SkipKey[] = ['inDispute', 'review', 'decided', 'pending', 'noClaim', 'noGap', 'changedSince'];

/** Atlanan satırlar: toplam ve nedenleri (sıfır olanlar yazılmaz). `notDecided` yalnız geri almada görülür, bildirimde yer almaz. */
export function skippedSummary(s: BulkDecideSkipped): { total: number; keys: SkipKey[] } {
  // eski sunucu yeni nedenleri göndermeyebilir: yok = 0
  const keys = SKIP_ORDER.filter((k) => (s[k] ?? 0) > 0);
  return { total: keys.reduce((n, k) => n + (s[k] ?? 0), 0), keys };
}
