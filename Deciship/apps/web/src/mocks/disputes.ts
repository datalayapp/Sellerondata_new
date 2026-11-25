// Yalnız VITE_MOCK=1. İtiraz takibi (Deciship/spec/itiraz.md "API sözleşmesi"): paket, sonuç girişi, geri alma, geri çekme, yeniden gönderme.
// Durum bellekte; fatura ve satırlar `browser.ts`'teki depodan okunur. Kurallar gerçek API ile aynı tutulur ki e2e yaşam döngüsünü koşsun.
import { http, HttpResponse } from 'msw';
import { disputeDeadlines, fromCents, sumMoney, toCents, turkeyDate, TTK_DISPUTE_DAYS, type DeadlineInfo } from '@deciship/core';
import type {
  DisputeChannel,
  DisputeListItem,
  DisputeListResponse,
  DisputeListStatus,
  DisputeRound,
  DisputeSums,
  InvoiceDispute,
  InvoiceDisputeStatus,
  InvoiceLine,
  InvoiceListItem,
  LineDispute,
  PersonRef,
} from '../api/types';

type MockInvoice = InvoiceListItem & { currency: string };

export interface DisputeDeps {
  invoices: MockInvoice[];
  linesOf: (invoiceId: string) => InvoiceLine[];
  country: () => string | null | undefined;
  person: () => PersonRef;
}

interface LineRec {
  id: string;
  invoiceLineId: string;
  claimedAmount: number;
  outcome: 'PENDING' | 'RECOVERED' | 'REJECTED';
  recoveredAmount: number | null;
  resultId: string | null;
}
interface ResultRec {
  id: string;
  kind: 'RECOVERED' | 'REJECTED';
  creditNoteNo: string | null;
  resultOn: string;
  reason: string | null;
  lines: { disputeLineId: string; amount: number }[];
  enteredBy: PersonRef;
  enteredAt: string;
  revertedAt: string | null;
  revertedBy: PersonRef | null;
  revertReason: string | null;
}
interface RoundRec {
  id: string;
  invoiceId: string;
  round: number;
  currency: string;
  sentOn: string;
  channel: DisputeChannel;
  channelNote: string | null;
  reference: string | null;
  sentBy: PersonRef;
  createdAt: string;
  withdrawnAt: string | null;
  withdrawnBy: PersonRef | null;
  withdrawReason: string | null;
  supersededById: string | null;
  supersededAt: string | null;
  version: number;
  lines: LineRec[];
  results: ResultRec[];
}

const DAY = 86_400_000;
const uid = () => crypto.randomUUID();
const err = (status: number, code: string, message: string) => HttpResponse.json({ error: { code, message } }, { status });
const money = (values: number[]) => sumMoney(values);
const minus = (a: number, b: number) => fromCents(toCents(a) - toCents(b));
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const today = () => turkeyDate(new Date());

/** Talep: `buildDisputeText` ile aynı (mükerrer satırda faturalanan tutarın tamamı, diğerlerinde fark). */
export function claimOf(l: InvoiceLine): number {
  return Math.max(0, fromCents(toCents(l.diffTypes.includes('DUPLICATE') ? l.netAmount : (l.diffAmount ?? 0))));
}
const isListed = (l: InvoiceLine) => l.status === 'DIFF' && l.decision === 'VERIFIED' && claimOf(l) > 0;
const hasUnsent = (x: DisputeListItem) => (x.unsentLineCount ?? 0) > 0;

/**
 * API `sendableDigest`'in sahte karşılığı (10-B3): gönderilecek satırların kimliği, takip no'su ve talebi (kuruş), kimliğe
 * göre sıralı; 64 onaltılık hane (API anahtarlı SHA-256 kullanır, para birimini de katar). Metin ve fatura ayrıntısı üretir,
 * gönderme karşılaştırır.
 */
export function selectionDigestOf(lines: readonly InvoiceLine[]): string {
  const text = lines.map((l) => `${l.id}|${l.trackingNo}|${toCents(claimOf(l))}`).sort().join('\n');
  let out = '';
  for (let seed = 0; seed < 8; seed++) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/**
 * Test kancası: `sod_mock_strip_perm=deciship.prices.view` iken sunucunun `stripMoney`'si gibi para anahtarları silinir
 * (`amount`, `…Amount`, `…Total`). Arayüz bu alanlar yokken de çizmeli.
 */
function stripMoney<T>(v: T): T {
  if (localStorage.getItem('sod_mock_strip_perm') !== 'deciship.prices.view') return v;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) if (!/^(amount|.+Amount|.+Total)$/.test(k)) o[k] = walk(val);
      return o;
    }
    return x;
  };
  return walk(v) as T;
}

export function createDisputeMock(deps: DisputeDeps) {
  const rounds: RoundRec[] = [];
  const invoiceOf = (id: string) => deps.invoices.find((x) => x.id === id);
  const activeOf = (invoiceId: string) => rounds.find((r) => r.invoiceId === invoiceId && !r.withdrawnAt && !r.supersededById) ?? null;
  const roundsOf = (invoiceId: string) => rounds.filter((r) => r.invoiceId === invoiceId);
  /** Yerini yeniye bırakmış (geri çekilmemiş) turlarda geri alınan satırlar: yeni tura girmez, parası faturada sayılır. */
  const carried = (invoiceId: string) =>
    roundsOf(invoiceId)
      .filter((r) => r.supersededById && !r.withdrawnAt)
      .flatMap((r) => r.lines.filter((l) => l.outcome === 'RECOVERED'));

  function sendableLines(invoiceId: string, exclude?: RoundRec | null): InvoiceLine[] {
    const done = new Set(carried(invoiceId).map((l) => l.invoiceLineId));
    if (exclude) for (const l of exclude.lines) if (l.outcome === 'RECOVERED') done.add(l.invoiceLineId);
    return deps.linesOf(invoiceId).filter((l) => isListed(l) && !done.has(l.id));
  }

  function sumsOf(lines: LineRec[]): Required<DisputeSums> {
    const rec = lines.filter((l) => l.outcome === 'RECOVERED');
    return {
      claimedAmount: money(lines.map((l) => l.claimedAmount)),
      recoveredAmount: money(rec.map((l) => l.recoveredAmount ?? 0)),
      rejectedAmount: money(lines.filter((l) => l.outcome === 'REJECTED').map((l) => l.claimedAmount)),
      pendingAmount: money(lines.filter((l) => l.outcome === 'PENDING').map((l) => l.claimedAmount)),
      shortfallAmount: money(rec.map((l) => minus(l.claimedAmount, l.recoveredAmount ?? 0))),
    };
  }
  /** Faturanın toplamı: etkin tur + önceki turlarda geri alınıp yeni tura girmeyen satırlar. */
  const invoiceSums = (invoiceId: string) => {
    const a = activeOf(invoiceId);
    return sumsOf([...(a?.lines ?? []), ...carried(invoiceId)]);
  };
  const statusOf = (invoiceId: string): InvoiceDisputeStatus => {
    const a = activeOf(invoiceId);
    return !a ? 'NONE' : a.lines.some((l) => l.outcome === 'PENDING') ? 'SENT' : 'CLOSED';
  };
  /**
   * TTK satır başına: turdaki her satırın zincirde (bu tur ve yerini bıraktığı turlar; geri çekilen tur girmez) ilk
   * gönderildiği gün; esas gün bunların en geçi. Sonradan listeye eklenip süre geçtikten sonra ilk kez gönderilen satır turu
   * "geç" yapar. Deciship/spec/itiraz.md "TTK".
   */
  /** TTK'ya esas gün (API `ttkSentOn`): yeniden gönderilen turda ilk gönderim. */
  const ttkSentOnOf = (r: RoundRec) => {
    const first = new Map(r.lines.map((l) => [l.invoiceLineId, r.sentOn]));
    for (let prev = rounds.find((x) => x.supersededById === r.id); prev; prev = rounds.find((x) => x.supersededById === prev!.id)) {
      for (const l of prev.lines) {
        const seen = first.get(l.invoiceLineId);
        if (seen && prev.sentOn < seen) first.set(l.invoiceLineId, prev.sentOn);
      }
    }
    const days = [...first.values()];
    return days.length ? days.reduce((a, b) => (b > a ? b : a)) : r.sentOn;
  };
  const ttkOf = (r: RoundRec) => {
    const inv = invoiceOf(r.invoiceId);
    if (deps.country() !== 'TR' || !inv?.invoiceDate) return null;
    return ttkSentOnOf(r) <= addDays(inv.invoiceDate, TTK_DISPUTE_DAYS) ? ('ON_TIME' as const) : ('LATE' as const);
  };
  /** Listede olup etkin turda olmayan satırlar (etkin tur yoksa gönderilecek satırların hepsi). */
  const unsentOf = (invoiceId: string) => {
    const a = activeOf(invoiceId);
    const inRound = new Set(a?.lines.map((l) => l.invoiceLineId) ?? []);
    const lines = sendableLines(invoiceId, a).filter((l) => !inRound.has(l.id));
    return { unsentLineCount: lines.length, unsentAmount: money(lines.map(claimOf)) };
  };

  function viewRound(r: RoundRec): DisputeRound {
    const byId = new Map(deps.linesOf(r.invoiceId).map((l) => [l.id, l]));
    return {
      id: r.id,
      round: r.round,
      currency: r.currency,
      sentOn: r.sentOn,
      channel: r.channel,
      channelNote: r.channelNote,
      reference: r.reference,
      sentBy: r.sentBy,
      createdAt: r.createdAt,
      ttk: ttkOf(r),
      ttkSentOn: ttkSentOnOf(r),
      withdrawnAt: r.withdrawnAt,
      withdrawnBy: r.withdrawnBy,
      withdrawReason: r.withdrawReason,
      supersededById: r.supersededById,
      supersededAt: r.supersededAt,
      version: r.version,
      sums: sumsOf(r.lines),
      lines: r.lines.map((l) => {
        const il = byId.get(l.invoiceLineId);
        return { ...l, lineNo: il ? il.rowIndex + 1 : null, trackingNo: il?.trackingNo ?? null };
      }),
      results: [...r.results]
        .sort((a, b) => b.enteredAt.localeCompare(a.enteredAt))
        .map((x) => ({ ...x, amount: money(x.lines.map((y) => y.amount)) })),
    };
  }

  function invoiceDispute(invoiceId: string): InvoiceDispute {
    const a = activeOf(invoiceId);
    const send = sendableLines(invoiceId, a);
    return stripMoney({
      status: statusOf(invoiceId),
      active: a ? viewRound(a) : null,
      history: roundsOf(invoiceId)
        .filter((r) => r !== a)
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
        .map(viewRound),
      sendableLineCount: send.length,
      sendableAmount: money(send.map(claimOf)),
      recalcPendingLines: send.filter((l) => l.recalcPending).length,
      selectionDigest: send.length ? selectionDigestOf(send) : null,
      ...unsentOf(invoiceId),
      sums: a || carried(invoiceId).length ? invoiceSums(invoiceId) : null,
    });
  }

  /** Satırın geçerli sonucu: etkin turdaki ya da önceki turda geri alınıp yeni tura girmeyen satır. */
  function lineDispute(invoiceId: string, lineId: string): LineDispute | null {
    const l = [...(activeOf(invoiceId)?.lines ?? []), ...carried(invoiceId)].find((x) => x.invoiceLineId === lineId);
    return l ? stripMoney({ outcome: l.outcome, recoveredAmount: l.recoveredAmount }) : null;
  }

  function deadlinesOf(inv: MockInvoice) {
    return disputeDeadlines(inv.invoiceDate, inv.carrier?.code, new Date(), deps.country()) ?? {};
  }
  /** Süresi yaklaşanlar için tek süre: açık olan ilk süre (TTK, sonra taşıyıcı), hepsi geçtiyse sonuncusu. */
  const nearest = (d: { ttk?: DeadlineInfo; carrier?: DeadlineInfo }) => {
    const all = [d.ttk, d.carrier].filter((x): x is DeadlineInfo => !!x);
    return all.find((x) => !x.expired) ?? all.at(-1) ?? null;
  };

  function listItems(): DisputeListItem[] {
    const out: DisputeListItem[] = [];
    for (const inv of deps.invoices) {
      const a = activeOf(inv.id);
      const base = {
        invoiceId: inv.id,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate ?? null,
        currency: inv.currency,
        carrier: inv.carrier ? { id: inv.carrier.id, name: inv.carrier.name, code: inv.carrier.code ?? 'generic' } : null,
        deadlines: deadlinesOf(inv),
      };
      if (a) {
        out.push({
          ...base,
          status: statusOf(inv.id) as DisputeListStatus,
          disputeId: a.id,
          round: a.round,
          sentOn: a.sentOn,
          channel: a.channel,
          sentBy: a.sentBy,
          lineCount: a.lines.length + carried(inv.id).length,
          resolvedCount: a.lines.filter((l) => l.outcome !== 'PENDING').length + carried(inv.id).length,
          sums: invoiceSums(inv.id),
          ttkStatus: ttkOf(a),
          ttkSentOn: ttkSentOnOf(a),
          ...unsentOf(inv.id),
        });
        continue;
      }
      const send = sendableLines(inv.id);
      if (!send.length) continue;
      out.push({
        ...base,
        status: 'UNSENT',
        disputeId: null,
        round: null,
        sentOn: null,
        channel: null,
        sentBy: null,
        lineCount: send.length,
        resolvedCount: 0,
        sums: { claimedAmount: money(send.map(claimOf)), recoveredAmount: 0, rejectedAmount: 0, pendingAmount: 0, shortfallAmount: 0 },
        ttkStatus: null,
        ttkSentOn: null,
        unsentLineCount: send.length,
        unsentAmount: money(send.map(claimOf)),
      });
    }
    // gönderilecek satırı olanlar önde (hiç gönderilmemiş ya da gönderimden sonra satır eklenmiş)
    const rank = (x: DisputeListItem) => (hasUnsent(x) ? 0 : 1);
    const left = (x: DisputeListItem) => {
      const n = nearest(x.deadlines);
      return n ? (n.expired ? 10_000 - n.daysLeft : n.daysLeft) : 99_999;
    };
    return out.sort((a, b) => rank(a) - rank(b) || (hasUnsent(a) ? left(a) - left(b) : (b.sentOn ?? '').localeCompare(a.sentOn ?? '')));
  }

  function list(url: URL): DisputeListResponse {
    const status = url.searchParams.get('status') as DisputeListStatus | null;
    const q = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase('tr-TR');
    const carrierId = url.searchParams.get('carrierId');
    const page = Number(url.searchParams.get('page') ?? 1) || 1;
    const pageSize = Number(url.searchParams.get('pageSize') ?? 25) || 25;
    const all = listItems();
    const items = all.filter(
      (x) => (!status || (status === 'UNSENT' ? hasUnsent(x) : x.status === status)) && (!q || x.invoiceNo.toLocaleLowerCase('tr-TR').includes(q) || (x.carrier?.name ?? '').toLocaleLowerCase('tr-TR').includes(q)) && (!carrierId || x.carrier?.id === carrierId),
    );
    const cur = new Map<string, { currency: string; c: number[]; r: number[]; j: number[]; p: number[]; s: number[]; u: number[] }>();
    for (const x of all) {
      const e = cur.get(x.currency) ?? { currency: x.currency, c: [], r: [], j: [], p: [], s: [], u: [] };
      cur.set(x.currency, e);
      e.u.push(x.unsentAmount ?? 0);
      if (x.status !== 'UNSENT') {
        e.c.push(x.sums.claimedAmount ?? 0);
        e.r.push(x.sums.recoveredAmount ?? 0);
        e.j.push(x.sums.rejectedAmount ?? 0);
        e.p.push(x.sums.pendingAmount ?? 0);
        e.s.push(x.sums.shortfallAmount ?? 0);
      }
    }
    // API gibi: etkin turu olmayan faturada önceki turda parası gelmiş satırlar da özete girer (Pano ile aynı)
    for (const inv of deps.invoices) {
      const c = activeOf(inv.id) ? [] : carried(inv.id);
      if (!c.length) continue;
      const s = sumsOf(c);
      const e = cur.get(inv.currency) ?? { currency: inv.currency, c: [], r: [], j: [], p: [], s: [], u: [] };
      cur.set(inv.currency, e);
      e.c.push(s.claimedAmount);
      e.r.push(s.recoveredAmount);
      e.j.push(s.rejectedAmount);
      e.p.push(s.pendingAmount);
      e.s.push(s.shortfallAmount);
    }
    const dueSoon = all
      .filter(hasUnsent)
      .map((x) => ({ x, n: nearest(x.deadlines) }))
      .filter((y) => y.n && y.n.daysLeft <= 7)
      .sort((a, b) => Number(a.n!.expired) - Number(b.n!.expired) || (a.n!.expired ? b.n!.daysLeft - a.n!.daysLeft : a.n!.daysLeft - b.n!.daysLeft))
      .slice(0, 5)
      .map((y) => y.x);
    return stripMoney({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: items.length,
      page,
      pageSize,
      summary: {
        counts: {
          UNSENT: all.filter(hasUnsent).length,
          SENT: all.filter((x) => x.status === 'SENT').length,
          CLOSED: all.filter((x) => x.status === 'CLOSED').length,
          ALL: all.length,
        },
        byCurrency: [...cur.values()].map((e) => ({
          currency: e.currency,
          claimedAmount: money(e.c),
          recoveredAmount: money(e.r),
          rejectedAmount: money(e.j),
          pendingAmount: money(e.p),
          shortfallAmount: money(e.s),
          unsentAmount: money(e.u),
        })),
        dueSoon,
      },
    });
  }

  // ---- değiştiriciler ----
  type Fail = { status: number; code: string; message: string };
  const fail = (status: number, code: string, message: string): Fail => ({ status, code, message });

  function checkSendBody(invoiceId: string, b: Record<string, unknown>): Fail | null {
    const inv = invoiceOf(invoiceId);
    if (!isDay(b.sentOn)) return fail(400, 'VALIDATION', 'Gönderim tarihi geçersiz.');
    if (b.sentOn > today()) return fail(400, 'SENT_ON_IN_FUTURE', 'Gönderim tarihi bugünden sonra olamaz.');
    if (inv?.invoiceDate && b.sentOn < inv.invoiceDate) return fail(400, 'VALIDATION', 'Gönderim tarihi fatura tarihinden önce olamaz.');
    if (!['EMAIL', 'PORTAL', 'OTHER'].includes(String(b.channel))) return fail(400, 'VALIDATION', 'Kanal geçersiz.');
    if (b.channel === 'OTHER' && !String(b.channelNote ?? '').trim()) return fail(400, 'VALIDATION', 'Kanal "Diğer" ise nasıl gönderildiğini yazın.');
    return null;
  }
  function newRound(invoiceId: string, b: Record<string, unknown>, lines: InvoiceLine[], by: PersonRef, at = new Date().toISOString()): RoundRec {
    const inv = invoiceOf(invoiceId)!;
    const r: RoundRec = {
      id: uid(),
      invoiceId,
      round: Math.max(0, ...roundsOf(invoiceId).map((x) => x.round)) + 1,
      currency: inv.currency,
      sentOn: String(b.sentOn),
      channel: b.channel as DisputeChannel,
      channelNote: String(b.channelNote ?? '').trim() || null,
      reference: String(b.reference ?? '').trim() || null,
      sentBy: by,
      createdAt: at,
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawReason: null,
      supersededById: null,
      supersededAt: null,
      version: 1,
      lines: lines.map((l) => ({ id: uid(), invoiceLineId: l.id, claimedAmount: claimOf(l), outcome: 'PENDING', recoveredAmount: null, resultId: null })),
      results: [],
    };
    rounds.push(r);
    return r;
  }
  const reasonOf = (b: Record<string, unknown>) => String(b.reason ?? '').trim();

  function send(invoiceId: string, b: Record<string, unknown>, by = deps.person(), at?: string): Fail | RoundRec {
    if (!invoiceOf(invoiceId)) return fail(404, 'NOT_FOUND', 'Fatura bulunamadı.');
    if (activeOf(invoiceId)) return fail(409, 'DISPUTE_ACTIVE', 'Bu faturanın gönderilmiş bir itirazı var.');
    const bad = checkSendBody(invoiceId, b);
    if (bad) return bad;
    const lines = sendableLines(invoiceId);
    if (!lines.length) return fail(400, 'NO_SENDABLE_LINES', 'İtiraz listesinde gönderilecek satır yok.');
    const changed = selectionChanged(b, lines);
    if (changed) return changed;
    return newRound(invoiceId, b, lines, by, at);
  }
  /** API gibi (10-B3): özet verildiyse bugünkü gönderilecek kümeyle tutmalı; tutmazsa 409, hiçbir şey yazılmaz. */
  function selectionChanged(b: Record<string, unknown>, lines: InvoiceLine[]): Fail | null {
    if (b.selectionDigest === undefined || b.selectionDigest === selectionDigestOf(lines)) return null;
    return fail(409, 'SELECTION_CHANGED', 'İtiraz listesi metni aldığınızdan beri değişti; itiraz metnini yeniden alıp gönderin.');
  }
  const roundById = (id: string) => rounds.find((r) => r.id === id);
  function guard(r: RoundRec | undefined, b: Record<string, unknown>): Fail | null {
    if (!r) return fail(404, 'NOT_FOUND', 'İtiraz bulunamadı.');
    if (r.withdrawnAt || r.supersededById || Number(b.version) !== r.version) return fail(409, 'STALE', 'İtiraz siz bakarken değişti. Sayfayı yenileyip yeniden deneyin.');
    return null;
  }
  function resend(id: string, b: Record<string, unknown>, by = deps.person(), at?: string): Fail | RoundRec {
    const r = roundById(id);
    const g = guard(r, b);
    if (g) return g;
    const bad = checkSendBody(r!.invoiceId, b);
    if (bad) return bad;
    const lines = sendableLines(r!.invoiceId, r);
    if (!lines.length) return fail(400, 'NO_SENDABLE_LINES', 'Yeniden gönderilecek satır yok.');
    const changed = selectionChanged(b, lines);
    if (changed) return changed;
    // yeni tur, eskisi kapanır: geri alınan satırlar eski turda kalır
    const n = newRound(r!.invoiceId, b, lines, by, at);
    r!.supersededById = n.id;
    r!.supersededAt = n.createdAt;
    r!.version++;
    return n;
  }
  function withdraw(id: string, b: Record<string, unknown>, by = deps.person(), at = new Date().toISOString()): Fail | RoundRec {
    const r = roundById(id);
    const g = guard(r, b);
    if (g) return g;
    const reason = reasonOf(b);
    if (!reason) return fail(400, 'REASON_REQUIRED', 'Geri çekme nedenini yazın.');
    if (reason.length > 1000) return fail(400, 'VALIDATION', 'Neden en çok 1000 karakter olabilir.');
    if (r!.results.some((x) => !x.revertedAt && x.kind === 'RECOVERED'))
      return fail(409, 'HAS_RECOVERED_RESULTS', 'Bu itirazda girilmiş alacak dekontu var; önce dekont girişini iptal edin.');
    Object.assign(r!, { withdrawnAt: at, withdrawnBy: by, withdrawReason: reason, version: r!.version + 1 });
    return r!;
  }
  function addResult(id: string, b: Record<string, unknown>, by = deps.person(), at = new Date().toISOString()): Fail | RoundRec {
    const r = roundById(id);
    const g = guard(r, b);
    if (g) return g;
    const kind = b.kind as 'RECOVERED' | 'REJECTED';
    if (kind !== 'RECOVERED' && kind !== 'REJECTED') return fail(400, 'VALIDATION', 'Sonuç türü geçersiz.');
    if (!isDay(b.resultOn)) return fail(400, 'VALIDATION', 'Tarih geçersiz.');
    if (b.resultOn > today()) return fail(400, 'RESULT_ON_IN_FUTURE', 'Tarih bugünden sonra olamaz.');
    if (b.resultOn < r!.sentOn) return fail(400, 'RESULT_ON_BEFORE_SENT', 'Sonuç tarihi itirazın gönderildiği günden önce olamaz.');
    const reqLines = Array.isArray(b.lines) ? (b.lines as { disputeLineId: string; amount?: number }[]) : [];
    if (!reqLines.length) return fail(400, 'VALIDATION', 'En az bir satır seçin.');
    const creditNoteNo = String(b.creditNoteNo ?? '').trim();
    const reason = reasonOf(b);
    if (kind === 'RECOVERED' && !creditNoteNo) return fail(400, 'CREDIT_NOTE_REQUIRED', 'Alacak dekontu numarasını yazın.');
    if (creditNoteNo.length > 64) return fail(400, 'VALIDATION', 'Dekont numarası en çok 64 karakter olabilir.');
    if (kind === 'REJECTED' && !reason) return fail(400, 'REASON_REQUIRED', 'Ret nedenini yazın.');
    if (reason.length > 1000) return fail(400, 'VALIDATION', 'Neden en çok 1000 karakter olabilir.');
    const picked: { line: LineRec; amount: number }[] = [];
    for (const x of reqLines) {
      const line = r!.lines.find((l) => l.id === x.disputeLineId);
      if (!line) return fail(400, 'VALIDATION', 'Satır bu turda değil.');
      if (line.outcome !== 'PENDING') return fail(409, 'LINE_NOT_PENDING', 'Seçilen satırlardan birinin sonucu zaten girilmiş.');
      let amount = line.claimedAmount;
      if (kind === 'RECOVERED') {
        if (typeof x.amount !== 'number' || !Number.isFinite(x.amount) || x.amount <= 0) return fail(400, 'VALIDATION', 'Geri alınan tutar sıfırdan büyük olmalı.');
        if (Math.abs(x.amount * 100 - Math.round(x.amount * 100)) > 1e-6) return fail(400, 'VALIDATION', 'Tutar en çok iki ondalıklı olabilir.');
        if (toCents(x.amount) > toCents(line.claimedAmount)) return fail(400, 'AMOUNT_EXCEEDS_CLAIM', 'Geri alınan tutar talep edilenden fazla olamaz.');
        amount = fromCents(toCents(x.amount));
      }
      picked.push({ line, amount });
    }
    const res: ResultRec = {
      id: uid(),
      kind,
      creditNoteNo: kind === 'RECOVERED' ? creditNoteNo : null,
      resultOn: String(b.resultOn),
      reason: reason || null,
      lines: picked.map((p) => ({ disputeLineId: p.line.id, amount: p.amount })),
      enteredBy: by,
      enteredAt: at,
      revertedAt: null,
      revertedBy: null,
      revertReason: null,
    };
    for (const p of picked) Object.assign(p.line, { outcome: kind, recoveredAmount: kind === 'RECOVERED' ? p.amount : null, resultId: res.id });
    r!.results.push(res);
    r!.version++;
    return r!;
  }
  /**
   * API gibi (10-B12): yerini yeniye bırakmış (geri çekilmemiş) turdaki giriş de geri alınır, yeter ki satırları sonraki
   * bir turda yeniden talep edilmemiş olsun (409 RESULT_LINES_RESENT). Geri alınan satır listeye döner (gönderilmemiş).
   */
  function revert(resultId: string, b: Record<string, unknown>, by = deps.person(), at = new Date().toISOString()): Fail | RoundRec {
    const r = rounds.find((x) => x.results.some((y) => y.id === resultId));
    if (!r) return fail(404, 'NOT_FOUND', 'İtiraz bulunamadı.');
    if (r.withdrawnAt || Number(b.version) !== r.version) return fail(409, 'STALE', 'İtiraz siz bakarken değişti. Sayfayı yenileyip yeniden deneyin.');
    const res = r.results.find((y) => y.id === resultId)!;
    if (r.supersededById) {
      const ids = new Set(r.lines.filter((l) => res.lines.some((x) => x.disputeLineId === l.id)).map((l) => l.invoiceLineId));
      const resent = roundsOf(r.invoiceId).some((x) => !x.withdrawnAt && x.round > r.round && x.lines.some((l) => ids.has(l.invoiceLineId)));
      if (resent) return fail(409, 'RESULT_LINES_RESENT', 'Bu girişin satırları sonraki bir turda yeniden talep edildi; bu giriş geri alınamaz.');
    }
    if (res.revertedAt) return fail(409, 'STALE', 'Bu giriş zaten iptal edilmiş.');
    const reason = reasonOf(b);
    if (!reason) return fail(400, 'REASON_REQUIRED', 'İptal nedenini yazın.');
    if (reason.length > 1000) return fail(400, 'VALIDATION', 'Neden en çok 1000 karakter olabilir.');
    Object.assign(res, { revertedAt: at, revertedBy: by, revertReason: reason });
    for (const l of r!.lines) if (l.resultId === res.id) Object.assign(l, { outcome: 'PENDING', recoveredAmount: null, resultId: null });
    r!.version++;
    return r!;
  }

  const isFail = (x: Fail | RoundRec): x is Fail => 'code' in x;
  const reply = (x: Fail | RoundRec, status = 200) => (isFail(x) ? err(x.status, x.code, x.message) : HttpResponse.json({ dispute: invoiceDispute(x.invoiceId) }, { status }));
  const body = async (r: Request) => ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  /** API gibi (10-B3): gönderme ve yeniden gönderme özetsiz 400 VALIDATION (tohum iç işlevleri doğrudan çağırır). */
  const withDigest = (b: Record<string, unknown>, work: () => Fail | RoundRec): Fail | RoundRec =>
    typeof b.selectionDigest === 'string' && /^[0-9a-f]{64}$/.test(b.selectionDigest) ? work() : fail(400, 'VALIDATION', 'Gönderilecek satır kümesinin özeti eksik.');
  const handlers = [
    http.get('/api/deciship/disputes', ({ request }) => HttpResponse.json(list(new URL(request.url)))),
    http.post('/api/deciship/invoices/:id/disputes', async ({ request, params }) => {
      const b = await body(request);
      return reply(withDigest(b, () => send(String(params.id), b)), 201);
    }),
    http.post('/api/deciship/disputes/:id/resend', async ({ request, params }) => {
      const b = await body(request);
      // API gibi: yeni tur açılsa da yeniden gönderme 200 döner (ilk gönderme 201)
      return reply(withDigest(b, () => resend(String(params.id), b)));
    }),
    http.post('/api/deciship/disputes/:id/withdraw', async ({ request, params }) => reply(withdraw(String(params.id), await body(request)))),
    http.post('/api/deciship/disputes/:id/results', async ({ request, params }) => reply(addResult(String(params.id), await body(request)))),
    http.post('/api/deciship/dispute-results/:id/revert', async ({ request, params }) => reply(revert(String(params.id), await body(request)))),
  ];

  /** Tohum yardımcıları: geçmişe dönük kayıt (kişi ve an verilir). Hata tohumda programcı hatasıdır. */
  const must = (x: Fail | RoundRec): RoundRec => {
    if (isFail(x)) throw new Error(`itiraz tohumu: ${x.code} ${x.message}`);
    return x;
  };
  const seed = {
    send: (invoiceId: string, b: Record<string, unknown>, by: PersonRef, at: string) => must(send(invoiceId, b, by, at)),
    resend: (r: RoundRec, b: Record<string, unknown>, by: PersonRef, at: string) => must(resend(r.id, { ...b, version: r.version }, by, at)),
    withdraw: (r: RoundRec, reason: string, by: PersonRef, at: string) => must(withdraw(r.id, { version: r.version, reason }, by, at)),
    result: (r: RoundRec, b: { kind: 'RECOVERED' | 'REJECTED'; resultOn: string; creditNoteNo?: string; reason?: string; lines: [number, number?][] }, by: PersonRef, at: string) =>
      must(addResult(r.id, { ...b, version: r.version, lines: b.lines.map(([i, amount]) => ({ disputeLineId: r.lines[i]!.id, amount: amount ?? r.lines[i]!.claimedAmount })) }, by, at)),
    revert: (r: RoundRec, reason: string, by: PersonRef, at: string) => must(revert(r.results.at(-1)!.id, { version: r.version, reason }, by, at)),
  };

  return {
    handlers,
    seed,
    invoiceDispute,
    lineDispute,
    statusOf,
    /**
     * Faturalar listesi: durum ve toplam. API gibi (`invoiceDisputeSummaries`, spec/itiraz.md "geçerli satır"): toplam, geçerli
     * itiraz satırı yoksa null. Etkin tur olmasa da (NONE) önceki turda geri alınmış satır geçerlidir, toplam doludur.
     */
    listFields: (invoiceId: string) => ({
      disputeStatus: statusOf(invoiceId),
      disputeSums: activeOf(invoiceId) || carried(invoiceId).length ? stripMoney(invoiceSums(invoiceId)) : null,
    }),
    /** İtiraz metninin satırları (10-B2): gönderme ile aynı küme, geri alınmış satır yok. */
    draftLines: (invoiceId: string) => sendableLines(invoiceId, activeOf(invoiceId)),
    /** Paketteki satırın kararı değişmez (409 LINE_IN_DISPUTE). */
    lineLocked: (invoiceId: string, lineId: string) => !!activeOf(invoiceId)?.lines.some((l) => l.invoiceLineId === lineId),
    /** Etkin paketi olan fatura silinmez (409 INVOICE_HAS_DISPUTE). */
    hasActive: (invoiceId: string) => !!activeOf(invoiceId),
    /** Pano: para birimi başına geri alınan ve itirazda bekleyen. */
    dashboardTotals: (currency: string) => {
      const ids = deps.invoices.filter((i) => i.currency === currency).map((i) => i.id);
      const s = ids.map(invoiceSums);
      return { recoveredTotal: money(s.map((x) => x.recoveredAmount)), disputePendingTotal: money(s.map((x) => x.pendingAmount)) };
    },
    reset: () => {
      rounds.length = 0;
    },
  };
}

export type DisputeMock = ReturnType<typeof createDisputeMock>;
