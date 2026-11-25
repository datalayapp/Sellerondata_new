import type {
  BulkCurrencyTotal,
  BulkRecalcPreview,
  InvoiceBasis,
  InvoiceRecalcPreview,
  PrevResultCause,
  RecalcBasisRef,
  RecalcLineResult,
  BulkRecalcResult,
  BulkStaleInvoice,
  JobView,
} from '../../api/types';

/**
 * Önce/sonra penceresinin saf mantığı (tarayıcısız sınanır). Metin yok: arayüz `invoiceDetail` ad alanındaki anahtarı çevirir,
 * değerleri (tarih, tutar) biçimler.
 */

// Kuruş tamsayısı: kayan nokta farkı "değişti" sanılmasın.
const cents = (n: number | null | undefined) => (n == null ? null : Math.round(Math.round(n * 1000) / 10));

/**
 * Önizleme sonucu: none = pencere açılmaz, bilgi iletisi; silent = rakam değişmez ama dayanak değişir, sormadan uygulanır;
 * update = görünür değişiklik yok ama satırlar yazılacak (yeni ölçüme bağlanma, "yeniden hesap bekliyor" işaretinin
 * silinmesi, tolerans içi Beklenen kayması), sormadan uygulanır ve "Satırlar güncellendi" denir; ask = pencere.
 */
export type RecalcDecision = 'none' | 'silent' | 'update' | 'ask';

export interface BasisChange {
  /** same: aynı sürüm · revision: aynı tarifenin yeni sürümü · switch: başka tarife (ya da tarifesizden tarifeye) */
  tariff: 'same' | 'revision' | 'switch';
  rules: boolean;
}

export function basisChange(b: InvoiceRecalcPreview['basis']): BasisChange {
  const { from, to } = b;
  const sameTariff = from.tariffId === to.tariffId;
  const tariff = sameTariff && from.revisionId === to.revisionId ? 'same' : sameTariff ? 'revision' : 'switch';
  return { tariff, rules: b.rulesChanged === true };
}

export interface MoneyChange {
  before: number;
  after: number;
  delta: number;
  dir: 'up' | 'down' | 'same';
}

/** Fazla ödeme önce → sonra; fark kuruşla hesaplanır. */
export function moneyChange(before: number, after: number): MoneyChange {
  const b = cents(before) ?? 0;
  const a = cents(after) ?? 0;
  return { before: b / 100, after: a / 100, delta: (a - b) / 100, dir: a > b ? 'up' : a < b ? 'down' : 'same' };
}

/**
 * Tek fatura: değişen satır ya da toplam varsa sor; yalnız dayanak değişiyorsa sormadan uygula; dayanak aynı ama yazılacak
 * satır varsa (Y32: görünür değişiklik sayılmayan yazım) yine sormadan uygula; hiçbiri yoksa pencere yok. "Değişiklik yok"
 * deyip uygulamamak işareti kalıcı bırakır, satır eski ölçümü gösterir, toplu karar onu hep atlar.
 */
export function previewDecision(p: InvoiceRecalcPreview): RecalcDecision {
  const changed = p.changedLines > 0 || moneyChange(p.totals.before.overchargeTotal, p.totals.after.overchargeTotal).dir !== 'same';
  if (changed) return 'ask';
  const c = basisChange(p.basis);
  if (c.tariff !== 'same' || c.rules) return 'silent';
  return (p.writeLines ?? 0) > 0 ? 'update' : 'none';
}

/**
 * Y123: fatura bilgilerini düzeltme penceresinde (`edit`) kararı verilmiş satırın sonucu değişiyorsa (`frozenChanged`) ve
 * kişinin fark kararı izni yoksa kayıt sunucuda reddedilir (403 DECIDED_LINES_CHANGE): pencere "Uygula" yerine nedenini
 * söyler ve sormadan uygulanmaz. Öbür kipler zaten karar iznindedir.
 */
export function decidedLinesBlocked(s: { job: { kind: string; purpose?: string }; preview: unknown }, canDecide: boolean): boolean {
  if (canDecide || s.job.kind !== 'invoice' || s.job.purpose !== 'edit') return false;
  return ((s.preview as Partial<InvoiceRecalcPreview>).frozenChanged ?? 0) > 0;
}

/** Toplu: yeni dayanağa geçecek fatura varsa sorulur. */
export function bulkDecision(p: BulkRecalcPreview): Exclude<RecalcDecision, 'silent'> {
  return p.changedInvoices > 0 ? 'ask' : 'none';
}

export interface TextKey {
  key: string;
  values: Record<string, string | number | null>;
}

/**
 * "Neyin değiştiği" satırları (ham değerlerle; `at` ISO tarihtir, arayüz biçimler).
 * Ör. aynı tarifenin yeni sürümü: `recalc.subject.revision` { name, at } → "Tarife: FedEx 2026 (12.10.2026) → bugünkü hâli".
 */
export function subjectLines(b: InvoiceRecalcPreview['basis'], calculatedAt?: string | null): TextKey[] {
  const c = basisChange(b);
  const out: TextKey[] = [];
  const name = (r: RecalcBasisRef) => r.tariffName ?? null;
  // "önce" tarafı faturanın hesaplandığı gündür (verilmişse; null ise tarih yazılmaz): tarife sürümünün tarihi değil
  const at = calculatedAt === undefined ? b.from.revisionAt : calculatedAt;
  if (c.tariff === 'revision') out.push({ key: 'recalc.subject.revision', values: { name: name(b.from) ?? name(b.to), at } });
  else if (c.tariff === 'switch')
    out.push(
      b.from.tariffName
        ? { key: 'recalc.subject.switch', values: { from: b.from.tariffName, to: name(b.to) } }
        : { key: 'recalc.subject.switchFromNone', values: { to: name(b.to) } },
    );
  if (c.rules) out.push({ key: 'recalc.subject.rules', values: {} });
  if (!out.length) out.push({ key: 'recalc.subject.same', values: { name: name(b.from) } });
  return out;
}

/** Satır sonucunun kısa hali: tutar varsa tutar, yoksa durum adı. */
export function lineResult(r: RecalcLineResult): { kind: 'money'; amount: number } | { kind: 'status'; status: RecalcLineResult['status'] } {
  return r.diffAmount != null && (r.status === 'DIFF' || r.status === 'MATCH') ? { kind: 'money', amount: r.diffAmount } : { kind: 'status', status: r.status };
}

/**
 * Toplu önizlemenin fazla ödeme toplamları: sunucu geçecek TÜM faturaları para birimine göre ayrı toplar (farklı para
 * birimleri toplanmaz; liste ilk 200 faturadır, toplam değildir). Alan yoksa (fiyat izni yok) boş liste.
 */
export function bulkTotals(p: Pick<BulkRecalcPreview, 'totalsByCurrency'>): BulkCurrencyTotal[] {
  return Array.isArray(p.totalsByCurrency) ? p.totalsByCurrency : [];
}

/** Listede gösterilen ilk N kayıt (sunucu en çok 200 gönderir). */
export const RECALC_LIST_LIMIT = 200;
export const hiddenCount = (total: number, shown: number) => Math.max(0, total - Math.min(shown, RECALC_LIST_LIMIT));

const PREV_CAUSES: readonly PrevResultCause[] = ['MEASUREMENT', 'DUPLICATE', 'TRACKING', 'MATCH', 'TARIFF', 'RULES', 'OTHER'];
/** "Ölçüm değişti; eski fark …" anahtarı; bilinmeyen neden OTHER. */
export const prevResultKey = (cause: string | null | undefined) =>
  `recalc.prev.${PREV_CAUSES.includes(cause as PrevResultCause) ? cause : 'OTHER'}`;

/** Satır rozeti anahtarı: sunucu üç sınıf yazar; ölçüm ve mükerrer ayrı söylenir, OTHER ve bilinmeyen değer "yeniden hesap bekliyor". */
export const pendingKey = (cause: string | null | undefined) =>
  `recalc.pending.${cause === 'MEASUREMENT' || cause === 'DUPLICATE' ? cause : 'OTHER'}`;

/** Toplu onayda geçirilmeyen fatura sayısı (itirazda olan + bu arada değişen); eski sunucuda `skipped` yok. */
export const bulkSkipped = (r: { skipped?: BulkRecalcResult['skipped'] }): number =>
  (r.skipped?.inDispute ?? 0) + (r.skipped?.stale ?? 0);

/**
 * K4: önizlemeden sonra değiştiği için geçirilmeyen faturalar. `count` sonuçtan, `list` sunucunun listesi (en çok 200,
 * silinmiş fatura yok; eski sunucuda alan yok), `more` listede görünmeyen sayı.
 */
export function bulkStale(r: { skipped?: BulkRecalcResult['skipped']; staleInvoices?: BulkStaleInvoice[] }): { count: number; list: BulkStaleInvoice[]; more: number } {
  const count = r.skipped?.stale ?? 0;
  const list = count > 0 && Array.isArray(r.staleInvoices) ? r.staleInvoices.slice(0, RECALC_LIST_LIMIT) : [];
  return { count, list, more: Math.max(0, count - list.length) };
}

/** K4: bitişte açılacak pencerenin girdisi (`stopped`: iş durduruldu). */
export type BulkFollowUp = { result: BulkRecalcResult; stopped: boolean };

/**
 * K4: bitişte "Yeniden önizle" penceresi açılır mı. Biten işte atlanan (önizlemeden sonra değişen) ya da kapsamda kalan
 * (sonradan eklenen, itirazı kapanan) fatura varsa; durdurulan işte yalnız atlanan varsa (kalanı kişi kendisi durdurdu).
 */
export function bulkFollowUp(o: BulkOutcome): BulkFollowUp | null {
  if (o.kind === 'applied') return bulkStale(o.result).count > 0 || (o.result.remaining ?? 0) > 0 ? { result: o.result, stopped: false } : null;
  if (o.kind === 'appliedStopped' && o.result && bulkStale(o.result).count > 0) return { result: o.result, stopped: true };
  return null;
}

/** Fatura bandı: hangi durumda ne söylenir, hangi eylem önerilir. */
export function basisNotice(b: InvoiceBasis | null | undefined): { key: string; action: 'tariff' | 'rules' | null } | null {
  switch (b?.state) {
    case 'TARIFF_CHANGED':
      return { key: 'recalc.band.tariffChanged', action: 'tariff' };
    case 'RULES_CHANGED':
      return { key: 'recalc.band.rulesChanged', action: 'rules' };
    case 'TARIFF_REMOVED':
      return { key: 'recalc.band.tariffRemoved', action: null };
    default:
      return null;
  }
}

/** Sunucu hata kodu (ApiError ya da benzeri). */
export const errorCode = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};

// ---- Mesaj 7: toplu yeniden hesap arka plan işi (önizleme ve uygulama) ----

/** İşin bittiğinde ekranda ne olacağı. `stale`: önizleme eskidi, yenisi alınır. */
export type BulkOutcome =
  | { kind: 'previewReady'; preview: BulkRecalcPreview }
  | { kind: 'previewFailed'; message: string }
  | { kind: 'applied'; result: BulkRecalcResult }
  /** durduruldu ve en az bir fatura yazıldı (`result` bölüm sonucu yoksa yazılan sayı `counters`tan) */
  | { kind: 'appliedStopped'; written: number; result?: BulkRecalcResult }
  | { kind: 'stale' }
  /** `written`: bu arada yazıldığı bilinen fatura sayısı (bilinmiyorsa 0) */
  | { kind: 'applyFailed'; message: string; written: number }
  | { kind: 'stopped' };

/** Uygulama işinde yazılan fatura sayısı: bölüm/son sonuç varsa ondan, yoksa yazım sayacından. */
export function bulkWritten(job: Pick<JobView, 'result' | 'counters'>): number {
  const r = job.result as Partial<BulkRecalcResult> | undefined | null;
  if (r && typeof r.invoices === 'number') return r.invoices;
  const c = job.counters?.invoices;
  return typeof c === 'number' && c > 0 ? c : 0;
}

/** Uygulama işi nasıl biterse bitsin fatura ve pano sorguları tazelenir (kısmen yazılmış olabilir). */
export const INVOICE_REFRESH_KEYS: readonly (readonly string[])[] = [['invoice'], ['invoices'], ['dashboard']];

/** Bitmiş işin (phase: önizleme ya da uygulama) sonucu. Durdurulan uygulamada bölüm sonucu varsa yazılanlar bildirilir. */
export function bulkOutcome(phase: 'preview' | 'apply', job: Pick<JobView, 'status' | 'result' | 'error' | 'counters'>): BulkOutcome {
  const message = job.error?.message ?? '';
  if (phase === 'preview') {
    if (job.status === 'SUCCEEDED' && job.result) return { kind: 'previewReady', preview: job.result as BulkRecalcPreview };
    return job.status === 'FAILED' ? { kind: 'previewFailed', message } : { kind: 'stopped' };
  }
  if (job.status === 'SUCCEEDED' && job.result) return { kind: 'applied', result: job.result as BulkRecalcResult };
  const written = bulkWritten(job);
  if (job.status === 'CANCELLED') return written > 0 ? { kind: 'appliedStopped', written, result: (job.result as BulkRecalcResult | undefined) ?? undefined } : { kind: 'stopped' };
  if (job.status === 'FAILED') return job.error?.code === 'PREVIEW_STALE' ? { kind: 'stale' } : { kind: 'applyFailed', message, written };
  return { kind: 'stopped' };
}

/** Durdurulduğunda uygulanmayan fatura sayısı (eski sunucuda yok). */
export const bulkStopped = (r: { stopped?: number }): number => r.stopped ?? 0;

/** 409 JOB_ACTIVE: farklı onayla süren uygulama; `details.job` ona bağlanmak içindir. */
export function activeJobFromError(e: unknown): JobView | null {
  if (errorCode(e) !== 'JOB_ACTIVE') return null;
  const job = (e as { details?: { job?: unknown } } | null)?.details?.job as Partial<JobView> | undefined;
  return job && typeof job.id === 'string' && typeof job.status === 'string' ? (job as JobView) : null;
}

/** Listeden süren toplu uygulama işi (bant için). */
export const activeApplyJob = (items: readonly JobView[]): JobView | null =>
  items.find((j) => j.kind === 'BULK_RECOMPARE_APPLY' && j.status !== 'SUCCEEDED' && j.status !== 'FAILED' && j.status !== 'CANCELLED') ?? null;

/** Bant sayıları: toplam bilinmiyorsa 0 (bant yalnız aşama ve n / N gösterir). */
export const bandNumbers = (j: Pick<JobView, 'progress'>): { done: number; total: number } => ({ done: j.progress.done, total: j.progress.total ?? 0 });

// Aynı iş için bitiş iletisi bir kez: pencerenin kancası ve sayfa bandı aynı işi izleyebilir.
const announced = new Set<string>();
export function firstAnnouncement(jobId: string): boolean {
  if (announced.has(jobId)) return false;
  announced.add(jobId);
  return true;
}
