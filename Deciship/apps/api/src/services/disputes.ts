/**
 * İtiraz takibi: gönderme, sonuç girme, geri alma, geri çekme, yeniden gönderme ve okumalar.
 *
 * Kurallar (Deciship/spec/itiraz.md "API sözleşmesi"):
 *  - Faturada aynı anda tek etkin tur (geri çekilmemiş, yerini bırakmamış). Kısmi tekil dizin son sınırdır.
 *  - Her değiştirici istek turun `version`ını taşır; eskiyse 409 STALE. Tur satırı `SELECT … FOR UPDATE` ile kilitlenir:
 *    aynı satıra eşzamanlı iki sonuç girişinden yalnız biri geçer, toplam talebi aşamaz.
 *  - Kilit sırası hep fatura → tur (gönderme, yeniden gönderme, satır kararı, fatura silme): kilitlenme olmaz.
 *  - Talep gönderim anında yazılır, yeniden karşılaştırma ona dokunmaz.
 *  - Fatura toplamı "geçerli satır" kuralıyla (core `effectiveDisputeLines`): Pano ve Merkez aynı SQL'i kullanır.
 *  - Gönderilen = metin (yeni denetim Mesaj 1): itiraz metni (`services/evidence.ts`) ve kaydedilen tur aynı kümeden
 *    (`sendableLines`); işaretleme metnin kümesinin özetini (`selectionDigest`, zorunlu) taşır, kilit altında tutmazsa 409.
 *  - Geçerli satır: geri çekilmemiş en son tur; o tur yerini yeniye bıraktıysa yalnız RECOVERED (`disputeFacts`).
 */
import crypto from 'node:crypto';
import {
  addDisputeSums,
  checkRecoveredAmount,
  disputeClaim,
  disputeDeadlines,
  disputeSums,
  disputeTtkStatus,
  emptyDisputeSums,
  invoiceDisputeStatus,
  isDisputable,
  sumMoney,
  turkeyDate,
  type DeadlineInfo,
  type DisputeLineOutcome,
  type DisputeSums,
  type DisputeTtkStatus,
  type InvoiceDisputeStatus,
} from '@deciship/core';
import { z } from 'zod';
import { prisma, Prisma, TX_DEFAULTS } from '../db.ts';
import { env } from '../env.ts';
import { AppError, badRequest, conflict, notFound } from '../errors.ts';
import { m as msg } from '../i18n/index.ts';
import { audit } from '../lib/audit.ts';
import { firmCountry, readSettings } from '../lib/settings.ts';
import { num, numOrNull } from '../lib/util.ts';

type Db = Prisma.TransactionClient | typeof prisma;

export type DisputeChannel = 'EMAIL' | 'PORTAL' | 'OTHER';
export type DisputeListStatus = 'UNSENT' | 'SENT' | 'CLOSED';
export type PersonRef = { id: string; name: string };

export type DisputeLineView = {
  id: string;
  invoiceLineId: string;
  lineNo: number | null;
  trackingNo: string | null;
  claimedAmount: number;
  outcome: DisputeLineOutcome;
  recoveredAmount: number | null;
  resultId: string | null;
};

export type DisputeResultView = {
  id: string;
  kind: 'RECOVERED' | 'REJECTED';
  creditNoteNo: string | null;
  resultOn: string;
  reason: string | null;
  amount: number;
  lines: { disputeLineId: string; amount: number }[];
  enteredBy: PersonRef;
  enteredAt: string;
  revertedAt: string | null;
  revertedBy: PersonRef | null;
  revertReason: string | null;
};

export type DisputeRound = {
  id: string;
  round: number;
  currency: string;
  sentOn: string;
  channel: DisputeChannel;
  channelNote: string | null;
  reference: string | null;
  sentBy: PersonRef;
  createdAt: string;
  ttk: DisputeTtkStatus | null;
  /**
   * KALANLAR 4a: TTK'ya esas gönderim günü (YYYY-MM-DD): turdaki her satırın taşıyıcıya ilk bildirildiği günlerin en geçi
   * (`ttkBasis`). Yeniden gönderilen turda ilk gönderimin günüdür, `sentOn` (son gönderim) değil; "zamanında itiraz edildi"
   * satırı bunu yazar.
   */
  ttkSentOn: string;
  withdrawnAt: string | null;
  withdrawnBy: PersonRef | null;
  withdrawReason: string | null;
  supersededAt: string | null;
  supersededById: string | null;
  version: number;
  sums: DisputeSums;
  lines: DisputeLineView[];
  results: DisputeResultView[];
};

export type InvoiceDispute = {
  status: InvoiceDisputeStatus;
  active: DisputeRound | null;
  history: DisputeRound[];
  sendableLineCount: number;
  sendableAmount: number;
  /** Listede olup etkin turda olmayan satırlar (etkin tur yoksa gönderilecek satırların hepsi). Yeniden gönderme bunları da içerir. */
  unsentLineCount: number;
  unsentAmount: number;
  /**
   * Gönderilecek satırlardan yeniden hesap bekleyenler (`recalcPending`: ölçüm ya da başka bir şey değişti, satır kararlı
   * olduğu için rakamı güncellenmedi). Gönderimi engellemez; web göndermeden önce uyarır.
   */
  recalcPendingLines: number;
  /**
   * Gönderilecek satır kümesinin özeti (`sendableDigest`; satır yoksa null). İtiraz metniyle (`GET /invoices/:id/dispute`)
   * aynı küme ve aynı özet: "Gönderildi olarak işaretle" bunu geri gönderir, arada küme değiştiyse 409 SELECTION_CHANGED.
   */
  selectionDigest: string | null;
  sums: DisputeSums | null;
};

export type DisputeListItem = {
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: string | null;
  currency: string;
  carrier: { id: string; name: string; code: string } | null;
  status: DisputeListStatus;
  disputeId: string | null;
  round: number | null;
  sentOn: string | null;
  channel: DisputeChannel | null;
  sentBy: PersonRef | null;
  lineCount: number;
  resolvedCount: number;
  sums: DisputeSums;
  deadlines: { ttk?: DeadlineInfo; carrier?: DeadlineInfo };
  ttkStatus: DisputeTtkStatus | null;
  /** KALANLAR 4a: etkin turun TTK'ya esas gönderim günü (`DisputeRound.ttkSentOn`); UNSENT'te null. */
  ttkSentOn: string | null;
  /** Gönderilmemiş satırlar: UNSENT'te gönderilecek satırların hepsi, SENT/CLOSED'da sonradan listeye eklenenler. */
  unsentLineCount: number;
  unsentAmount: number;
};

const day = (d: Date) => d.toISOString().slice(0, 10);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Yalnız etkin tur: geri çekilmemiş ve yerini yeniye bırakmamış. */
export const activeRoundWhere = { withdrawnAt: null, supersededAt: null } as const;

// ---------- geçerli satır toplamları (Pano, Merkez, listeler) ----------

export type InvoiceDisputeFacts = {
  invoiceId: string;
  currency: string;
  lines: number;
  resolved: number;
  pendingLines: number;
  sums: DisputeSums;
};

type FactRow = {
  invoiceId: string;
  currency: string;
  lines: number;
  resolved: number;
  pendingLines: number;
  claimed: string;
  recovered: string;
  rejected: string;
  pending: string;
  shortfall: string;
};

/**
 * Fatura başına geçerli satır toplamları: her fatura satırı için geri çekilmemiş en son turdaki satır (core
 * `effectiveDisputeLines` ile aynı kural). `scope` Invoice `i` üzerinde ek koşul (kimlik listesi ya da dönem). Canlı ve örnek
 * olmayan faturalar. Para Postgres numeric'iyle toplanır, kuruş kaybı yok.
 *
 * B12: yerini yeniye bırakmış turda geçerli satır `RECOVERED` (parası gelmiş, yeni tura girmemiş) ve K38 (kullanıcı kararı
 * 2026-11-13) ile `REJECTED` olandır: reddedilmiş satırın yeniden talebi (sonraki tur) geri çekildiyse taşıyıcının son cevabı
 * reddir, satır reddedilen sayılır; yalnız satır hâlâ itiraz listesindeyken ("İtiraz listesinde" + fark var: yeniden talep
 * edilebilir). Kişi reddi kabul edip satırı listeden çıkarırsa (Uyumlu / Karar bekliyor) satır itiraz toplamından çıkar.
 * O turda sonuçsuz (`PENDING`) kalan en son satır yeniden gönderilecek (gönderilmemiş)
 * satırdır, `unsentAmount`'ta sayılır; iki kez sayılmasın (gönderilmemiş sayımı da reddedileni dışarıda bırakır, `unsentOf`).
 * Bu durum yalnız eski turdaki girişin geri alınmasıyla ya da yeniden gönderilen turun geri çekilmesiyle oluşur. Core
 * `effectiveDisputeLines`, `lineDisputeStates` ve Merkez (`hub/metrics.ts`) aynı kural.
 */
export async function disputeFacts(companyId: string, scope: Prisma.Sql = Prisma.sql`TRUE`, db: Db = prisma): Promise<Map<string, InvoiceDisputeFacts>> {
  const rows = await db.$queryRaw<FactRow[]>`
    WITH latest AS (
      SELECT DISTINCT ON (dl."invoiceLineId") d."invoiceId", i."currency", dl."outcome"::text AS outcome, dl."claimedAmount", dl."recoveredAmount",
        d."supersededAt" IS NOT NULL AS superseded, (il."decision" = 'VERIFIED' AND il."status" = 'DIFF') AS listed
      FROM "DisputeLine" dl
      JOIN "Dispute" d ON d."id" = dl."disputeId"
      JOIN "Invoice" i ON i."id" = d."invoiceId"
      JOIN "InvoiceLine" il ON il."id" = dl."invoiceLineId"
      WHERE d."companyId" = ${companyId} AND d."withdrawnAt" IS NULL AND i."deletedAt" IS NULL AND NOT i."isSample" AND ${scope}
      ORDER BY dl."invoiceLineId", d."round" DESC
    ), eff AS (
      SELECT * FROM latest WHERE NOT superseded OR outcome = 'RECOVERED' OR (outcome = 'REJECTED' AND listed)
    )
    SELECT "invoiceId", upper(min("currency")) AS currency,
      count(*)::int AS lines,
      (count(*) FILTER (WHERE outcome <> 'PENDING'))::int AS "resolved",
      (count(*) FILTER (WHERE outcome = 'PENDING'))::int AS "pendingLines",
      COALESCE(sum("claimedAmount"), 0)::text AS claimed,
      COALESCE(sum("recoveredAmount") FILTER (WHERE outcome = 'RECOVERED'), 0)::text AS recovered,
      COALESCE(sum("claimedAmount") FILTER (WHERE outcome = 'REJECTED'), 0)::text AS rejected,
      COALESCE(sum("claimedAmount") FILTER (WHERE outcome = 'PENDING'), 0)::text AS pending,
      COALESCE(sum(GREATEST("claimedAmount" - "recoveredAmount", 0)) FILTER (WHERE outcome = 'RECOVERED'), 0)::text AS shortfall
    FROM eff GROUP BY "invoiceId"`;
  return new Map(
    rows.map((r) => [
      r.invoiceId,
      {
        invoiceId: r.invoiceId,
        currency: r.currency,
        lines: r.lines,
        resolved: r.resolved,
        pendingLines: r.pendingLines,
        sums: {
          claimedAmount: Number(r.claimed),
          recoveredAmount: Number(r.recovered),
          rejectedAmount: Number(r.rejected),
          pendingAmount: Number(r.pending),
          shortfallAmount: Number(r.shortfall),
        },
      },
    ]),
  );
}

export const invoiceIdsScope = (ids: string[]) => Prisma.sql`i."id" = ANY(${ids}::text[])`;
export const invoiceDateScope = (start: Date, end: Date) => Prisma.sql`i."invoiceDate" >= ${start} AND i."invoiceDate" < ${end}`;

/** Para birimi başına geri alınan ve itirazda bekleyen (Pano ve Merkez). */
export function disputeTotalsByCurrency(facts: Iterable<InvoiceDisputeFacts>): Map<string, DisputeSums> {
  const out = new Map<string, DisputeSums>();
  for (const f of facts) out.set(f.currency, addDisputeSums(out.get(f.currency) ?? emptyDisputeSums(), f.sums));
  return out;
}

/** Etkin turu olan faturalar (gönderilmiş: süresi yaklaşanlardan çıkar). */
export async function invoicesWithActiveDispute(companyId: string, invoiceIds: string[], db: Db = prisma): Promise<Set<string>> {
  if (!invoiceIds.length) return new Set();
  const rows = await db.dispute.findMany({ where: { companyId, invoiceId: { in: invoiceIds }, ...activeRoundWhere }, select: { invoiceId: true } });
  return new Set(rows.map((r) => r.invoiceId));
}

/** Fatura listesi: durum ve geçerli satır toplamı. */
export async function invoiceDisputeSummaries(companyId: string, invoiceIds: string[]): Promise<Map<string, { status: InvoiceDisputeStatus; sums: DisputeSums | null }>> {
  const out = new Map<string, { status: InvoiceDisputeStatus; sums: DisputeSums | null }>();
  if (!invoiceIds.length) return out;
  const [facts, active] = await Promise.all([disputeFacts(companyId, invoiceIdsScope(invoiceIds)), invoicesWithActiveDispute(companyId, invoiceIds)]);
  for (const id of invoiceIds) {
    const f = facts.get(id);
    out.set(id, { status: invoiceDisputeStatus(active.has(id), f?.pendingLines ?? 0), sums: f?.sums ?? null });
  }
  return out;
}

/**
 * Satır tablosu: her fatura satırının geçerli itiraz sonucu (`disputeFacts` kuralı: eski turda RECOVERED, ve satır hâlâ itiraz
 * listesindeyse REJECTED sayılır).
 */
export async function lineDisputeStates(companyId: string, invoiceLineIds: string[]): Promise<Map<string, { outcome: DisputeLineOutcome; recoveredAmount: number | null }>> {
  if (!invoiceLineIds.length) return new Map();
  const rows = await prisma.$queryRaw<{ invoiceLineId: string; outcome: DisputeLineOutcome; recoveredAmount: string | null; superseded: boolean; listed: boolean }[]>`
    SELECT DISTINCT ON (dl."invoiceLineId") dl."invoiceLineId", dl."outcome"::text AS outcome, dl."recoveredAmount"::text AS "recoveredAmount",
      d."supersededAt" IS NOT NULL AS superseded, (il."decision" = 'VERIFIED' AND il."status" = 'DIFF') AS listed
    FROM "DisputeLine" dl JOIN "Dispute" d ON d."id" = dl."disputeId" JOIN "InvoiceLine" il ON il."id" = dl."invoiceLineId"
    WHERE dl."companyId" = ${companyId} AND d."withdrawnAt" IS NULL AND dl."invoiceLineId" = ANY(${invoiceLineIds}::text[])
    ORDER BY dl."invoiceLineId", d."round" DESC`;
  return new Map(
    rows
      .filter((r) => !r.superseded || r.outcome === 'RECOVERED' || (r.outcome === 'REJECTED' && r.listed))
      .map((r) => [r.invoiceLineId, { outcome: r.outcome, recoveredAmount: r.recoveredAmount == null ? null : Number(r.recoveredAmount) }]),
  );
}

// ---------- gönderilebilir satırlar ----------

type SendableLine = {
  id: string;
  rowIndex: number;
  trackingNo: string;
  claim: number;
  /** faturanın para birimi (büyük harf): talep bu birimde yazılır */
  currency: string;
  /** yeniden hesap bekliyor (`InvoiceLine.recalcPending`) */
  recalcPending?: boolean;
  /**
   * K38: geri çekilmemiş en son turdaki sonucu `REJECTED` (taşıyıcı reddetti). Yeniden talep edilebilir (gönderilecek kümede
   * kalır) ama "gönderilmemiş" sayılmaz: reddedilen sayılır (`unsentOf`).
   */
  rejected?: boolean;
};

/**
 * Geri çekilmemiş en son turdaki sonuç, fatura satırı başına: `recovered` geçerli sonucu RECOVERED olanlar (yeniden talep
 * edilmez), `rejected` REJECTED olanlar (K38: reddedilen sayılır, gönderilmemiş sayılmaz).
 */
async function latestOutcomes(db: Db, companyId: string, invoiceIds: string[]): Promise<{ recovered: Set<string>; rejected: Set<string> }> {
  if (!invoiceIds.length) return { recovered: new Set(), rejected: new Set() };
  const rows = await db.$queryRaw<{ invoiceLineId: string; outcome: string }[]>`
    SELECT DISTINCT ON (dl."invoiceLineId") dl."invoiceLineId", dl."outcome"::text AS outcome
    FROM "DisputeLine" dl JOIN "Dispute" d ON d."id" = dl."disputeId"
    WHERE d."companyId" = ${companyId} AND d."withdrawnAt" IS NULL AND d."invoiceId" = ANY(${invoiceIds}::text[])
    ORDER BY dl."invoiceLineId", d."round" DESC`;
  const of = (o: string) => new Set(rows.filter((r) => r.outcome === o).map((r) => r.invoiceLineId));
  return { recovered: of('RECOVERED'), rejected: of('REJECTED') };
}

/**
 * Şimdi gönderilse pakete girecek satırlar, fatura başına: "İtiraz listesinde", fark var, talebi > 0 (itiraz metniyle aynı
 * kural) ve geçerli sonucu RECOVERED olmayan.
 */
async function sendableByInvoice(db: Db, companyId: string, invoiceIds: string[], o: { noDisputes?: boolean } = {}): Promise<Map<string, SendableLine[]>> {
  const out = new Map<string, SendableLine[]>();
  if (!invoiceIds.length) return out;
  const [lines, outcomes] = await Promise.all([
    db.invoiceLine.findMany({
      where: { companyId, invoiceId: { in: invoiceIds }, decision: 'VERIFIED', status: 'DIFF' },
      select: {
        id: true,
        invoiceId: true,
        rowIndex: true,
        trackingNo: true,
        diffTypes: true,
        netAmount: true,
        diffAmount: true,
        decision: true,
        status: true,
        recalcPending: true,
        invoice: { select: { currency: true } },
      },
      orderBy: [{ invoiceId: 'asc' }, { rowIndex: 'asc' }],
    }),
    // itirazı hiç olmayan faturada geri alınmış satır olamaz (Y11: sorgu atlanır)
    o.noDisputes ? { recovered: new Set<string>(), rejected: new Set<string>() } : latestOutcomes(db, companyId, invoiceIds),
  ]);
  for (const l of lines) {
    const input = { diffTypes: l.diffTypes, billedAmount: num(l.netAmount), diffAmount: numOrNull(l.diffAmount), decision: l.decision, status: l.status };
    if (!isDisputable(input) || outcomes.recovered.has(l.id)) continue;
    const list = out.get(l.invoiceId) ?? [];
    list.push({
      id: l.id,
      rowIndex: l.rowIndex,
      trackingNo: l.trackingNo,
      claim: disputeClaim(input),
      currency: l.invoice.currency.toUpperCase(),
      recalcPending: l.recalcPending != null,
      ...(outcomes.rejected.has(l.id) ? { rejected: true } : {}),
    });
    out.set(l.invoiceId, list);
  }
  return out;
}

/**
 * B2: tek faturanın gönderilecek satırları, satır sırasıyla. İtiraz metni ve kanıt ZIP'i (`loadDisputeDraft`) bu kümeyi
 * kullanır, gönderme ve yeniden gönderme de: taşıyıcıya yollanan metin ile kaydedilen tur aynı satırlardır.
 */
export async function sendableLines(db: Db, companyId: string, invoiceId: string): Promise<SendableLine[]> {
  return (await sendableByInvoice(db, companyId, [invoiceId])).get(invoiceId) ?? [];
}

/**
 * B3: gönderilecek kümenin özeti: satır başına kimlik, takip no, talep (kuruş) ve para birimi; kimliğe göre sıralı, SHA-256.
 * Kümeye giren ya da çıkan her satır, talebi ya da takip no'su değişen her satır ve faturanın para birimi değişince özet
 * değişir (kararlı satırın rakamı para birimi düzeltmesinde değişmez: metin "1.000 ₺" der, kayıt "1.000 USD" olurdu). Metin
 * (`GET /invoices/:id/dispute`, metnin kendi satırlarından) ve fatura ayrıntısı (`InvoiceDispute.selectionDigest`) üretir;
 * gönderme kilit altında yeniden üretip karşılaştırır. Sıra özeti değiştirmez.
 *
 * Anahtarlı (HMAC, sunucu anahtarı `FILE_TOKEN_SECRET`'tan türetilir): özet fiyat görme izni olmayana da gider (fatura
 * ayrıntısı; `stripMoney` özeti silmez) ve satır kimliği, takip no bilinir; anahtarsız SHA-256'da tek ya da iki satırlık
 * faturanın talebi deneme yoluyla bulunurdu. Bütün API kopyaları aynı anahtarı kullanır (üretimde zorunlu ortam değişkeni).
 */
export function sendableDigest(lines: readonly Pick<SendableLine, 'id' | 'trackingNo' | 'claim' | 'currency'>[]): string {
  const parts = lines.map((l) => [l.id, l.trackingNo, Math.round(l.claim * 100), l.currency.toUpperCase()].join('|')).sort();
  return crypto.createHmac('sha256', selectionKey()).update(parts.join('\n')).digest('hex');
}

let selectionKeyCache: { secret: string; key: Buffer } | null = null;
/** Özet anahtarı: dosya bağlantısı anahtarından amaca özel türetilir (aynı anahtar iki işte doğrudan kullanılmaz). */
function selectionKey(): Buffer {
  const secret = env.fileTokenSecret;
  if (selectionKeyCache?.secret !== secret) {
    selectionKeyCache = { secret, key: crypto.createHmac('sha256', secret).update('deciship.dispute.selectionDigest.v1').digest() };
  }
  return selectionKeyCache.key;
}

/** Faturanın bugünkü gönderilecek kümesinin özeti (tohum ve testler; web metinden ya da fatura ayrıntısından alır). Satır yoksa null. */
export async function currentSelectionDigest(companyId: string, invoiceId: string, db: Db = prisma): Promise<string | null> {
  const lines = await sendableLines(db, companyId, invoiceId);
  return lines.length ? sendableDigest(lines) : null;
}

// ---------- okuma: fatura ayrıntısı ----------

const roundInclude = {
  sentBy: { select: { id: true, name: true } },
  withdrawnBy: { select: { id: true, name: true } },
  lines: { include: { invoiceLine: { select: { rowIndex: true } } }, orderBy: { invoiceLine: { rowIndex: 'asc' } } },
  results: {
    include: { enteredBy: { select: { id: true, name: true } }, revertedBy: { select: { id: true, name: true } }, lines: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  },
} as const satisfies Prisma.DisputeInclude;

type RoundRow = Prisma.DisputeGetPayload<{ include: typeof roundInclude }>;

type ChainRound = { id: string; sentOn: Date; supersededById: string | null; lineIds: readonly string[] };

/**
 * TTK'ya esas gün, tur başına. Zincir: tur ve yerini bıraktığı önceki turlar (geri çekilen tur yerini bırakamaz, zincire
 * girmez). Turdaki her satırın taşıyıcıya ilk bildirildiği gün, zincirde o satırı içeren en erken gönderimdir; esas gün bu
 * günlerin en geçidir. Böylece süresinde gönderilip süre geçtikten sonra yeniden gönderilen satır zamanında sayılır, ama
 * gönderimden sonra listeye eklenip ilk kez süre geçtikten sonra gönderilen satır turu "geç" yapar.
 */
function ttkBasis(rounds: readonly ChainRound[]) {
  const prevOf = new Map(rounds.filter((p) => p.supersededById).map((p) => [p.supersededById!, p]));
  const byId = new Map(rounds.map((r) => [r.id, r]));
  return (id: string, sentOn: Date): Date => {
    const self = byId.get(id);
    if (!self?.lineIds.length) return sentOn;
    const first = new Map(self.lineIds.map((l) => [l, sentOn]));
    let cursor = prevOf.get(id);
    for (let guard = 0; cursor && guard < 1000; guard++) {
      for (const l of cursor.lineIds) {
        const seen = first.get(l);
        if (seen && cursor.sentOn < seen) first.set(l, cursor.sentOn);
      }
      cursor = prevOf.get(cursor.id);
    }
    return new Date(Math.max(...[...first.values()].map((d) => d.getTime())));
  };
}

/**
 * Listede olup etkin turda olmayan satırlar (etkin tur yoksa hepsi). K38: son cevabı red olan satır (yeniden talebi geri
 * çekildi) gönderilmemiş sayılmaz, reddedilen sayılır (`disputeFacts`); yeniden gönderimde yine talep edilir.
 */
export function unsentLinesOf<T extends Pick<SendableLine, 'id' | 'rejected'>>(sendable: readonly T[], activeLineIds: readonly string[] | null): T[] {
  const inRound = new Set(activeLineIds ?? []);
  return sendable.filter((l) => !inRound.has(l.id) && !l.rejected);
}

/**
 * Y30: etkin turu olan faturalarda gönderimden sonra listeye eklenip henüz gönderilmemiş satır sayısı (`unsentOf` kuralı);
 * yalnız sayısı > 0 olan faturalar. Etkin turu olmayan fatura dönmez. İtiraz süresi hatırlatması (`services/reminders.ts`).
 */
export async function unsentAfterSend(db: Db, companyId: string, invoiceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!invoiceIds.length) return out;
  const [active, sendable] = await Promise.all([
    db.dispute.findMany({ where: { companyId, invoiceId: { in: invoiceIds }, ...activeRoundWhere }, select: { invoiceId: true, lines: { select: { invoiceLineId: true } } } }),
    sendableByInvoice(db, companyId, invoiceIds),
  ]);
  for (const d of active) {
    const n = unsentLinesOf(sendable.get(d.invoiceId) ?? [], d.lines.map((l) => l.invoiceLineId)).length;
    if (n > 0) out.set(d.invoiceId, n);
  }
  return out;
}

function unsentOf(sendable: readonly SendableLine[], activeLineIds: readonly string[] | null) {
  const lines = unsentLinesOf(sendable, activeLineIds);
  return { unsentLineCount: lines.length, unsentAmount: sumMoney(lines.map((l) => l.claim)) };
}

function serializeRound(r: RoundRow, invoiceDate: string, country: string | null, ttkSentOn: string): DisputeRound {
  const lines: DisputeLineView[] = r.lines.map((l) => ({
    id: l.id,
    invoiceLineId: l.invoiceLineId,
    lineNo: l.invoiceLine ? l.invoiceLine.rowIndex + 1 : null, // ekranda 1 tabanlı (içe aktarma raporuyla aynı)
    trackingNo: l.trackingNo,
    claimedAmount: num(l.claimedAmount),
    outcome: l.outcome,
    recoveredAmount: numOrNull(l.recoveredAmount),
    resultId: l.resultId,
  }));
  const sentOn = day(r.sentOn);
  return {
    id: r.id,
    round: r.round,
    currency: r.currency,
    sentOn,
    channel: r.channel,
    channelNote: r.channelNote,
    reference: r.reference,
    sentBy: r.sentBy,
    createdAt: r.createdAt.toISOString(),
    ttk: disputeTtkStatus(invoiceDate, ttkSentOn, country),
    ttkSentOn,
    withdrawnAt: iso(r.withdrawnAt),
    withdrawnBy: r.withdrawnBy ?? null,
    withdrawReason: r.withdrawReason,
    supersededAt: iso(r.supersededAt),
    supersededById: r.supersededById,
    version: r.version,
    sums: disputeSums(lines),
    lines,
    results: r.results.map((x) => ({
      id: x.id,
      kind: x.kind,
      creditNoteNo: x.creditNoteNo,
      resultOn: day(x.resultOn),
      reason: x.reason,
      amount: sumMoney(x.lines.map((s) => num(s.amount))),
      lines: x.lines.map((s) => ({ disputeLineId: s.disputeLineId, amount: num(s.amount) })),
      enteredBy: x.enteredBy,
      enteredAt: x.createdAt.toISOString(),
      revertedAt: iso(x.revertedAt),
      revertedBy: x.revertedBy ?? null,
      revertReason: x.revertReason,
    })),
  };
}

async function countryOf(companyId: string, db: Db = prisma): Promise<string | null> {
  const company = await db.company.findFirst({ where: { id: companyId }, select: { settings: true, nameVersion: true } });
  return company ? firmCountry(company) : null;
}

/** Fatura ayrıntısındaki itiraz bloğu. */
export async function invoiceDispute(companyId: string, invoice: { id: string; invoiceDate: Date }, db: Db = prisma): Promise<InvoiceDispute> {
  // Y11: itirazı hiç olmayan faturada (çoğu) tur, ülke, geri alınan satır ve itiraz toplamı okunmaz: Prisma `include`
  // boş tur listesinde de alt ilişki başına sorgu açıyordu (~9 sorgu). Sonuç aynı: hepsi boş çıkardı.
  const any = await db.dispute.findFirst({ where: { companyId, invoiceId: invoice.id }, select: { id: true } });
  const [rounds, country, sendable, facts] = any
    ? await Promise.all([
        db.dispute.findMany({ where: { companyId, invoiceId: invoice.id }, include: roundInclude, orderBy: { round: 'desc' } }),
        countryOf(companyId, db),
        sendableByInvoice(db, companyId, [invoice.id]),
        disputeFacts(companyId, invoiceIdsScope([invoice.id]), db),
      ])
    : [[] as RoundRow[], null, await sendableByInvoice(db, companyId, [invoice.id], { noDisputes: true }), new Map<string, InvoiceDisputeFacts>()];
  const invoiceDate = day(invoice.invoiceDate);
  const basis = ttkBasis(rounds.map((r) => ({ ...r, lineIds: r.lines.map((l) => l.invoiceLineId) })));
  const views = rounds.map((r) => serializeRound(r, invoiceDate, country, day(basis(r.id, r.sentOn))));
  const active = views.find((r) => !r.withdrawnAt && !r.supersededAt) ?? null;
  const lines = sendable.get(invoice.id) ?? [];
  const f = facts.get(invoice.id);
  return {
    status: invoiceDisputeStatus(active != null, f?.pendingLines ?? 0),
    active,
    history: views.filter((r) => r !== active),
    sendableLineCount: lines.length,
    sendableAmount: sumMoney(lines.map((l) => l.claim)),
    ...unsentOf(lines, active ? active.lines.map((l) => l.invoiceLineId) : null),
    recalcPendingLines: lines.filter((l) => l.recalcPending).length,
    selectionDigest: lines.length ? sendableDigest(lines) : null,
    sums: f?.sums ?? null,
  };
}

// ---------- değiştiriciler ----------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStr = z
  .string()
  .trim()
  .regex(DAY_RE, 'v.invalidDate')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00.000Z`).getTime()) && new Date(`${s}T00:00:00.000Z`).toISOString().startsWith(s), 'v.invalidDate');
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
const version = z.number().int().min(1);
const reason = z.string().trim().max(1000).nullable().optional();
/** Para: en çok iki ondalık (kuruş). 1,005 sessizce 1,00'a yuvarlanmaz, 400 döner. */
const money = z
  .number()
  .min(-1e12)
  .max(1e12)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'v.maxTwoDecimals');

export const sendBody = z.object({
  sentOn: dayStr,
  channel: z.enum(['EMAIL', 'PORTAL', 'OTHER']),
  channelNote: optText(500),
  reference: optText(200),
  /**
   * B3: taşıyıcıya yollanan metnin satır kümesinin özeti (`GET /invoices/:id/dispute` ya da `InvoiceDispute.selectionDigest`).
   * Zorunlu: fatura kilidi altında bugünkü gönderilecek kümenin özetiyle karşılaştırılır, tutmazsa 409 SELECTION_CHANGED
   * (hiçbir şey yazılmaz). Özetsiz istek 400 VALIDATION: hiçbir istemci kümeyi görmeden işaretleyemez.
   */
  selectionDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const resendBody = sendBody.extend({ version });
export const withdrawBody = z.object({ version, reason });
export const revertBody = z.object({ version, reason });
export const resultBody = z.object({
  version,
  kind: z.enum(['RECOVERED', 'REJECTED']),
  resultOn: dayStr,
  creditNoteNo: optText(64),
  reason,
  lines: z
    .array(z.object({ disputeLineId: z.string().min(1).max(100), amount: money.nullable().optional() }))
    .min(1)
    .max(10_000),
});

const stale = () => conflict('STALE', msg('dispute.stale'));
const field = (path: string, message: string) => [{ path, message }];

function requireReason(text: string | null | undefined): string {
  const r = text?.trim();
  if (!r) throw badRequest('REASON_REQUIRED', msg('dispute.reasonRequired'), field('reason', msg('v.required')));
  return r;
}

/** Gün en geç Türkiye'de bugün (sözleşme). */
function notInFuture(value: string, code: 'SENT_ON_IN_FUTURE' | 'RESULT_ON_IN_FUTURE', now: Date) {
  if (value > turkeyDate(now)) {
    const key = code === 'SENT_ON_IN_FUTURE' ? 'dispute.sentOnFuture' : 'dispute.resultOnFuture';
    throw badRequest(code, msg(key), field(code === 'SENT_ON_IN_FUTURE' ? 'sentOn' : 'resultOn', msg(key)));
  }
}

function checkSend(body: z.infer<typeof sendBody>, invoiceDate: Date, now: Date) {
  notInFuture(body.sentOn, 'SENT_ON_IN_FUTURE', now);
  if (body.sentOn < day(invoiceDate)) throw badRequest('VALIDATION', msg('dispute.sentOnBeforeInvoice'), field('sentOn', msg('dispute.sentOnBeforeInvoice')));
  if (body.channel === 'OTHER' && !body.channelNote) throw badRequest('VALIDATION', msg('dispute.channelNoteRequired'), field('channelNote', msg('v.required')));
}

const toDay = (s: string) => new Date(`${s}T00:00:00.000Z`);

type Actor = { companyId: string; userId: string };

/** Faturayı kilitler (gönderme, yeniden gönderme, karar, silme aynı sırayla). Silinmişse 404. */
export async function lockInvoice(tx: Prisma.TransactionClient, companyId: string, invoiceId: string) {
  const rows = await tx.$queryRaw<{ id: string; invoiceDate: Date; currency: string }[]>`
    SELECT "id", "invoiceDate", "currency" FROM "Invoice" WHERE "id" = ${invoiceId} AND "companyId" = ${companyId} AND "deletedAt" IS NULL FOR UPDATE`;
  const inv = rows[0];
  if (!inv) throw notFound(msg('invoice.notFound'));
  return inv;
}

type LockedRound = { id: string; invoiceId: string; version: number; round: number; sentOn: Date; withdrawnAt: Date | null; supersededAt: Date | null };

/** Turu kilitler; geri çekilmişse ya da sürüm eskiyse 409 STALE. Yerini yeniye bırakmış tur da döner (çağıran karar verir). */
async function lockRound(tx: Prisma.TransactionClient, companyId: string, disputeId: string, expected: number): Promise<LockedRound> {
  const rows = await tx.$queryRaw<LockedRound[]>`
    SELECT "id", "invoiceId", "version", "round", "sentOn", "withdrawnAt", "supersededAt" FROM "Dispute"
    WHERE "id" = ${disputeId} AND "companyId" = ${companyId} FOR UPDATE`;
  const r = rows[0];
  if (!r) throw notFound(msg('dispute.notFound'));
  if (r.withdrawnAt || r.version !== expected) throw stale();
  return r;
}

/** Turu kilitler; etkin değilse ya da sürüm eskiyse 409 STALE. */
async function lockActiveRound(tx: Prisma.TransactionClient, companyId: string, disputeId: string, expected: number): Promise<LockedRound> {
  const r = await lockRound(tx, companyId, disputeId, expected);
  if (r.supersededAt) throw stale();
  return r;
}

async function createRound(
  tx: Prisma.TransactionClient,
  a: Actor,
  invoice: { id: string; currency: string },
  body: z.infer<typeof sendBody>,
  lines: SendableLine[],
) {
  const last = await tx.dispute.findFirst({ where: { companyId: a.companyId, invoiceId: invoice.id }, orderBy: { round: 'desc' }, select: { round: true } });
  // Kanıt: gönderim anındaki ölçüm sürümü itiraz satırına değişmez yazılır (kalıcı silme bunu korur; services/deletedPurge.ts).
  // Fatura kilidi altında okunur: satırın bağı bu işlemde değişemez.
  const linked = await tx.invoiceLine.findMany({ where: { companyId: a.companyId, id: { in: lines.map((l) => l.id) } }, select: { id: true, measurementId: true } });
  const measurementOf = new Map(linked.map((l) => [l.id, l.measurementId]));
  return tx.dispute.create({
    data: {
      companyId: a.companyId,
      invoiceId: invoice.id,
      round: (last?.round ?? 0) + 1,
      sentOn: toDay(body.sentOn),
      channel: body.channel,
      channelNote: body.channelNote,
      reference: body.reference,
      sentById: a.userId,
      currency: invoice.currency.toUpperCase(),
      claimedTotal: sumMoney(lines.map((l) => l.claim)),
      lines: {
        create: lines.map((l) => ({ companyId: a.companyId, invoiceLineId: l.id, trackingNo: l.trackingNo, measurementId: measurementOf.get(l.id) ?? null, claimedAmount: l.claim })),
      },
    },
    select: { id: true, round: true, claimedTotal: true },
  });
}

/**
 * B3: işaretlenen küme, taşıyıcıya yollanan metnin kümesi mi? Fatura kilidi altında okunan gönderilecek satırların özeti
 * gövdedeki özetle tutmazsa 409 SELECTION_CHANGED: metin üretildikten sonra listeye satır eklendi ya da çıktı, bir satıra
 * sonuç girildi ya da talebi değişti. Web metni yeniden almayı söyler.
 */
function assertSameSelection(body: { selectionDigest: string }, lines: readonly SendableLine[]) {
  if (body.selectionDigest !== sendableDigest(lines)) {
    throw conflict('SELECTION_CHANGED', msg('dispute.selectionChanged'));
  }
}

/** Kısmi tekil dizin: iki gönderme aynı anda geçerse ikincisi burada düşer. */
async function guardActive<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('DISPUTE_ACTIVE', msg('dispute.active'));
    throw e;
  }
}

export async function loadDisputeOr404(companyId: string, disputeId: string) {
  const d = await prisma.dispute.findFirst({
    where: { id: disputeId, companyId, invoice: { deletedAt: null } },
    select: { id: true, invoiceId: true, invoice: { select: { invoiceDate: true } } },
  });
  if (!d) throw notFound(msg('dispute.notFound'));
  return d;
}

export async function sendDispute(a: Actor, invoice: { id: string; invoiceDate: Date }, raw: unknown, now = new Date()) {
  const body = sendBody.parse(raw);
  checkSend(body, invoice.invoiceDate, now);
  const created = await guardActive(() =>
    prisma.$transaction(async (tx) => {
      const inv = await lockInvoice(tx, a.companyId, invoice.id);
      if (await tx.dispute.findFirst({ where: { companyId: a.companyId, invoiceId: inv.id, ...activeRoundWhere }, select: { id: true } })) {
        throw conflict('DISPUTE_ACTIVE', msg('dispute.active'));
      }
      const lines = await sendableLines(tx, a.companyId, inv.id);
      if (!lines.length) throw badRequest('NO_SENDABLE_LINES', msg('dispute.noSendableLines'));
      assertSameSelection(body, lines);
      const round = await createRound(tx, a, inv, body, lines);
      return { ...round, lineCount: lines.length };
    }, TX_DEFAULTS),
  );
  await audit(a.companyId, a.userId, 'dispute.send', 'Invoice', invoice.id, {
    disputeId: created.id,
    round: created.round,
    sentOn: body.sentOn,
    channel: body.channel,
    lines: created.lineCount,
    claimedTotal: num(created.claimedTotal),
  });
  return created;
}

export async function resendDispute(a: Actor, disputeId: string, raw: unknown, now = new Date()) {
  const d = await loadDisputeOr404(a.companyId, disputeId);
  const body = resendBody.parse(raw);
  checkSend(body, d.invoice.invoiceDate, now);
  const result = await guardActive(() =>
    prisma.$transaction(async (tx) => {
      const inv = await lockInvoice(tx, a.companyId, d.invoiceId);
      const old = await lockActiveRound(tx, a.companyId, disputeId, body.version);
      // RECOVERED satırlar eski turda kalır; yeniden talep edilenler: geri kalan liste satırları
      const lines = await sendableLines(tx, a.companyId, inv.id);
      if (!lines.length) throw badRequest('NO_SENDABLE_LINES', msg('dispute.noSendableLines'));
      assertSameSelection(body, lines);
      // Önce eski tur etkinlikten çıkar (dizin ikisini aynı anda etkin görmesin), sonra yeni tur bağlanır.
      const at = new Date();
      await tx.dispute.update({ where: { id: old.id }, data: { supersededAt: at, version: { increment: 1 } } });
      const round = await createRound(tx, a, inv, body, lines);
      await tx.dispute.update({ where: { id: old.id }, data: { supersededById: round.id } });
      return { ...round, previousId: old.id, previousRound: old.round, lineCount: lines.length };
    }, TX_DEFAULTS),
  );
  await audit(a.companyId, a.userId, 'dispute.resend', 'Invoice', d.invoiceId, {
    disputeId: result.id,
    round: result.round,
    previousDisputeId: result.previousId,
    previousRound: result.previousRound,
    sentOn: body.sentOn,
    channel: body.channel,
    lines: result.lineCount,
    claimedTotal: num(result.claimedTotal),
  });
  return { invoiceId: d.invoiceId, invoiceDate: d.invoice.invoiceDate };
}

export async function withdrawDispute(a: Actor, disputeId: string, raw: unknown) {
  const d = await loadDisputeOr404(a.companyId, disputeId);
  const body = withdrawBody.parse(raw);
  const why = requireReason(body.reason);
  const round = await prisma.$transaction(async (tx) => {
    const r = await lockActiveRound(tx, a.companyId, disputeId, body.version);
    if (await tx.disputeLine.findFirst({ where: { disputeId, outcome: 'RECOVERED' }, select: { id: true } })) {
      throw conflict('HAS_RECOVERED_RESULTS', msg('dispute.hasRecovered'));
    }
    await tx.dispute.update({ where: { id: r.id }, data: { withdrawnAt: new Date(), withdrawnById: a.userId, withdrawReason: why, version: { increment: 1 } } });
    return r;
  }, TX_DEFAULTS);
  await audit(a.companyId, a.userId, 'dispute.withdraw', 'Invoice', d.invoiceId, { disputeId, round: round.round, reason: why });
  return { invoiceId: d.invoiceId, invoiceDate: d.invoice.invoiceDate };
}

export async function addDisputeResult(a: Actor, disputeId: string, raw: unknown, now = new Date()) {
  const d = await loadDisputeOr404(a.companyId, disputeId);
  const body = resultBody.parse(raw);
  notInFuture(body.resultOn, 'RESULT_ON_IN_FUTURE', now);
  const recovered = body.kind === 'RECOVERED';
  const why = body.reason?.trim() || null;
  if (!recovered && !why) requireReason(why);
  if (recovered && !body.creditNoteNo) {
    throw badRequest('CREDIT_NOTE_REQUIRED', msg('dispute.creditNoteRequired'), field('creditNoteNo', msg('v.required')));
  }
  const ids = body.lines.map((l) => l.disputeLineId);
  if (new Set(ids).size !== ids.length) throw badRequest('VALIDATION', msg('dispute.lineRepeated'), field('lines', msg('dispute.lineRepeated')));
  if (recovered) {
    body.lines.forEach((l, i) => {
      if (l.amount == null || checkRecoveredAmount(Number.MAX_SAFE_INTEGER, l.amount) === 'NOT_POSITIVE') {
        throw badRequest('VALIDATION', msg('dispute.amountRequired'), field(`lines.${i}.amount`, msg('dispute.amountRequired')));
      }
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    const round = await lockActiveRound(tx, a.companyId, disputeId, body.version);
    if (body.resultOn < day(round.sentOn)) {
      throw badRequest('RESULT_ON_BEFORE_SENT', msg('dispute.resultOnBeforeSent'), field('resultOn', msg('dispute.resultOnBeforeSent')));
    }
    // Kilit altında okunur: eşzamanlı giriş bu noktaya sürümü artırdıktan sonra gelir, yukarıda STALE alır.
    const lines = await tx.disputeLine.findMany({ where: { disputeId, id: { in: ids } }, select: { id: true, claimedAmount: true, outcome: true } });
    const byId = new Map(lines.map((l) => [l.id, l]));
    const shares = body.lines.map((l, i) => {
      const line = byId.get(l.disputeLineId);
      if (!line) throw badRequest('VALIDATION', msg('dispute.lineNotInRound'), field(`lines.${i}.disputeLineId`, msg('dispute.lineNotInRound')));
      if (line.outcome !== 'PENDING') throw conflict('LINE_NOT_PENDING', msg('dispute.lineNotPending'));
      const claimed = num(line.claimedAmount);
      if (!recovered) return { id: line.id, amount: claimed };
      if (checkRecoveredAmount(claimed, l.amount!) === 'EXCEEDS_CLAIM') {
        throw new AppError(400, 'AMOUNT_EXCEEDS_CLAIM', msg('dispute.amountExceedsClaim'), field(`lines.${i}.amount`, msg('dispute.amountExceedsClaim')));
      }
      return { id: line.id, amount: Math.round(l.amount! * 100) / 100 };
    });
    const result = await tx.disputeResult.create({
      data: {
        companyId: a.companyId,
        disputeId,
        kind: body.kind,
        creditNoteNo: recovered ? body.creditNoteNo : null,
        resultOn: toDay(body.resultOn),
        reason: why,
        enteredById: a.userId,
        lines: { create: shares.map((s) => ({ companyId: a.companyId, disputeLineId: s.id, amount: s.amount })) },
      },
      select: { id: true },
    });
    for (const s of shares) {
      // PENDING koşulu kilitle birlikte ikinci güvencedir: satır iki kez sonuçlanamaz
      const n = await tx.disputeLine.updateMany({
        where: { id: s.id, outcome: 'PENDING' },
        data: { outcome: body.kind, recoveredAmount: recovered ? s.amount : null, resultId: result.id },
      });
      if (n.count !== 1) throw conflict('LINE_NOT_PENDING', msg('dispute.lineNotPending'));
    }
    await tx.dispute.update({ where: { id: disputeId }, data: { version: { increment: 1 } } });
    return { id: result.id, total: sumMoney(shares.map((s) => s.amount)), lines: shares.length };
  }, TX_DEFAULTS);
  await audit(a.companyId, a.userId, recovered ? 'dispute.recovered' : 'dispute.rejected', 'Invoice', d.invoiceId, {
    disputeId,
    resultId: created.id,
    kind: body.kind,
    creditNoteNo: recovered ? body.creditNoteNo : null,
    resultOn: body.resultOn,
    lines: created.lines,
    amount: created.total,
    ...(why ? { reason: why } : {}),
  });
  return { invoiceId: d.invoiceId, invoiceDate: d.invoice.invoiceDate };
}

/**
 * Sonuç girişini geri alır: giriş kalır (kim, ne zaman, neden), satırları `PENDING`'e döner.
 *
 * B12: giriş yerini yeniye bırakmış (geri çekilmemiş) bir turdaysa da geri alınabilir, yeter ki girişin satırlarından hiçbiri
 * sonraki (geri çekilmemiş) bir turda yeniden talep edilmemiş olsun; yoksa 409 RESULT_LINES_RESENT. Pratikte bu yanlış girilmiş
 * dekonttur: geri alınan (RECOVERED) satır yeniden gönderilmez, reddedilen satır ise yeni turda yeniden talep edilir. Geri
 * alınan satır eski turda sonuçsuz kalır ve geçerli satır sayılmaz (`disputeFacts`): listeye döner, bir sonraki yeniden
 * gönderimde yeniden talep edilir. Fatura kilidi altında (gönderilecek küme değişir; gönderme ile aynı kilit sırası).
 */
export async function revertDisputeResult(a: Actor, resultId: string, raw: unknown) {
  const r = await prisma.disputeResult.findFirst({
    where: { id: resultId, companyId: a.companyId, dispute: { invoice: { deletedAt: null } } },
    select: { id: true, disputeId: true, kind: true, dispute: { select: { invoiceId: true, invoice: { select: { invoiceDate: true } } } } },
  });
  if (!r) throw notFound(msg('dispute.resultNotFound'));
  const body = revertBody.parse(raw);
  const why = requireReason(body.reason);
  const { lines, round } = await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, a.companyId, r.dispute.invoiceId);
    const round = await lockRound(tx, a.companyId, r.disputeId, body.version);
    if (round.supersededAt) {
      const resent = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one
        FROM "DisputeResultLine" rl
        JOIN "DisputeLine" dl ON dl."id" = rl."disputeLineId"
        JOIN "DisputeLine" later ON later."invoiceLineId" = dl."invoiceLineId" AND later."companyId" = ${a.companyId}
        JOIN "Dispute" d ON d."id" = later."disputeId"
        WHERE rl."resultId" = ${r.id} AND rl."companyId" = ${a.companyId} AND d."withdrawnAt" IS NULL AND d."round" > ${round.round}
        LIMIT 1`;
      if (resent.length) throw conflict('RESULT_LINES_RESENT', msg('dispute.resultResent'));
    }
    const live = await tx.disputeResult.updateMany({
      where: { id: r.id, revertedAt: null },
      data: { revertedAt: new Date(), revertedById: a.userId, revertReason: why },
    });
    if (live.count !== 1) throw stale();
    const reopened = await tx.disputeLine.updateMany({ where: { resultId: r.id }, data: { outcome: 'PENDING', recoveredAmount: null, resultId: null } });
    await tx.dispute.update({ where: { id: r.disputeId }, data: { version: { increment: 1 } } });
    return { lines: reopened.count, round };
  }, TX_DEFAULTS);
  await audit(a.companyId, a.userId, 'dispute.revert', 'Invoice', r.dispute.invoiceId, {
    disputeId: r.disputeId,
    resultId: r.id,
    kind: r.kind,
    lines,
    round: round.round,
    ...(round.supersededAt ? { superseded: true } : {}),
    reason: why,
  });
  return { invoiceId: r.dispute.invoiceId, invoiceDate: r.dispute.invoice.invoiceDate };
}

/** Etkin turdaki satır: kararı, takip no'su ve ölçüm eşleşmesi değişmez (409). Çağıran faturayı kilitlemiş olmalı. */
export async function assertLineNotInActiveDispute(db: Db, companyId: string, invoiceLineId: string) {
  const hit = await db.disputeLine.findFirst({ where: { companyId, invoiceLineId, dispute: activeRoundWhere }, select: { id: true } });
  if (hit) throw conflict('LINE_IN_DISPUTE', msg('line.inDispute'));
}

/** Etkin turu olan fatura silinemez (409). */
export async function assertInvoiceHasNoActiveDispute(
  db: Db,
  companyId: string,
  invoiceId: string,
  message: 'invoice.hasDispute' | 'invoice.hasDisputeLocked' = 'invoice.hasDispute',
) {
  const hit = await db.dispute.findFirst({ where: { companyId, invoiceId, ...activeRoundWhere }, select: { id: true } });
  if (hit) throw conflict('INVOICE_HAS_DISPUTE', msg(message));
}

// ---------- faturalar arası liste ----------

export const listQuery = z.object({
  status: z.enum(['UNSENT', 'SENT', 'CLOSED']).optional(),
  carrierId: z.string().trim().min(1).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

/** Listede esas alınan süre: açık olan ilk süre (TTK, sonra taşıyıcı); hepsi geçtiyse sonuncusu. */
function mainDeadline(d: DisputeListItem['deadlines']): DeadlineInfo | null {
  const all = [d.ttk, d.carrier].filter((x): x is DeadlineInfo => x != null);
  return all.find((x) => !x.expired) ?? all.at(-1) ?? null;
}

const DUE_SOON_DAYS = 7;
const DUE_SOON_MAX = 5;

function byDeadline(a: DisputeListItem, b: DisputeListItem): number {
  const da = mainDeadline(a.deadlines);
  const db = mainDeadline(b.deadlines);
  // süresi olmayan en sona; dolmamışlar kalan güne göre, sonra dolmuşlar en yeni dolan önce
  const rank = (d: DeadlineInfo | null) => (d == null ? [2, 0] : d.expired ? [1, -d.daysLeft] : [0, d.daysLeft]);
  const [ra, va] = rank(da);
  const [rb, vb] = rank(db);
  return ra! - rb! || va! - vb! || a.invoiceNo.localeCompare(b.invoiceNo);
}

/** Gönderilecek satırı olan: hiç gönderilmemiş ya da gönderimden sonra listeye satır eklenmiş. */
const hasUnsent = (x: DisputeListItem) => x.unsentLineCount > 0;

/**
 * Önce gönderilecek satırı olanlar (süresi en yakın önce), sonra gönderilen ve kapananlar gönderim günü yeniden eskiye.
 */
function compareItems(a: DisputeListItem, b: DisputeListItem): number {
  const unsent = (x: DisputeListItem) => (hasUnsent(x) ? 0 : 1);
  if (unsent(a) !== unsent(b)) return unsent(a) - unsent(b);
  if (hasUnsent(a)) return byDeadline(a, b);
  return (b.sentOn ?? '').localeCompare(a.sentOn ?? '') || a.invoiceNo.localeCompare(b.invoiceNo) || a.invoiceId.localeCompare(b.invoiceId);
}

export async function listDisputes(companyId: string, rawQuery: unknown, now = new Date()) {
  const q = listQuery.parse(rawQuery);
  const company = await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true, nameVersion: true } });
  const country = firmCountry(company);
  const firmCurrency = readSettings(company.settings).currency.toUpperCase();
  const today = turkeyDate(now);

  // Aday faturalar: geri çekilmemiş turu olan ya da "İtiraz listesinde" satırı olan canlı faturalar.
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      deletedAt: null,
      isSample: false,
      OR: [{ disputes: { some: { withdrawnAt: null } } }, { lines: { some: { decision: 'VERIFIED', status: 'DIFF' } } }],
    },
    select: { id: true, invoiceNo: true, invoiceDate: true, currency: true, carrier: { select: { id: true, name: true, code: true } } },
  });
  const ids = invoices.map((i) => i.id);
  const [facts, rounds, sendable] = await Promise.all([
    disputeFacts(companyId, invoiceIdsScope(ids)),
    // Geri çekilmemiş turlar: etkin tur ve TTK zinciri (yerini yeniye bırakan turlar). Geri çekilen tur zincire girmez.
    ids.length
      ? prisma.dispute.findMany({
          where: { companyId, invoiceId: { in: ids }, withdrawnAt: null },
          select: {
            id: true,
            invoiceId: true,
            round: true,
            sentOn: true,
            channel: true,
            supersededAt: true,
            supersededById: true,
            sentBy: { select: { id: true, name: true } },
            lines: { select: { invoiceLineId: true } },
          },
        })
      : Promise.resolve([]),
    sendableByInvoice(prisma, companyId, ids),
  ]);
  const activeOf = new Map(rounds.filter((d) => !d.supersededAt).map((d) => [d.invoiceId, d]));
  const basis = ttkBasis(rounds.map((r) => ({ ...r, lineIds: r.lines.map((l) => l.invoiceLineId) })));

  const all: DisputeListItem[] = [];
  for (const inv of invoices) {
    const invoiceDate = day(inv.invoiceDate);
    const deadlines = disputeDeadlines(invoiceDate, inv.carrier.code, today, country) ?? {};
    const active = activeOf.get(inv.id);
    const lines = sendable.get(inv.id) ?? [];
    const base = {
      invoiceId: inv.id,
      invoiceNo: inv.invoiceNo,
      invoiceDate,
      currency: inv.currency.toUpperCase(),
      carrier: inv.carrier,
      deadlines,
    };
    if (active) {
      const f = facts.get(inv.id);
      const sentOn = day(active.sentOn);
      all.push({
        ...base,
        status: invoiceDisputeStatus(true, f?.pendingLines ?? 0) as DisputeListStatus,
        disputeId: active.id,
        round: active.round,
        sentOn,
        channel: active.channel,
        sentBy: active.sentBy,
        lineCount: f?.lines ?? 0,
        resolvedCount: f?.resolved ?? 0,
        sums: f?.sums ?? emptyDisputeSums(),
        ttkStatus: disputeTtkStatus(invoiceDate, day(basis(active.id, active.sentOn)), country),
        ttkSentOn: day(basis(active.id, active.sentOn)),
        ...unsentOf(lines, active.lines.map((l) => l.invoiceLineId)),
      });
      continue;
    }
    // K38: son cevabı red olan satırlar gönderilecek değildir (reddedilen; özete `facts`'ten girer)
    const toSend = unsentLinesOf(lines, null);
    if (!toSend.length) continue;
    all.push({
      ...base,
      status: 'UNSENT',
      disputeId: null,
      round: null,
      sentOn: null,
      channel: null,
      sentBy: null,
      lineCount: toSend.length,
      resolvedCount: 0,
      sums: { ...emptyDisputeSums(), claimedAmount: sumMoney(toSend.map((l) => l.claim)) },
      ttkStatus: null,
      ttkSentOn: null,
      ...unsentOf(lines, null),
    });
  }

  // Özet, süzgeçten bağımsız. SENT ve CLOSED etkin turu olan faturaları böler; UNSENT gönderilecek satırı olan faturalardır
  // (hiç gönderilmemiş ya da gönderimden sonra listeye satır eklenmiş): ikinci grup SENT/CLOSED içinde de sayılır.
  // ALL listedeki fatura sayısıdır (süzgeçsiz), üçünün toplamı değil.
  const counts = { UNSENT: 0, SENT: 0, CLOSED: 0, ALL: all.length };
  const byCur = new Map<string, DisputeSums & { currency: string; unsentAmount: number }>();
  const bucket = (currency: string) => {
    const cur = byCur.get(currency) ?? { currency, ...emptyDisputeSums(), unsentAmount: 0 };
    byCur.set(currency, cur);
    return cur;
  };
  for (const it of all) {
    if (it.status !== 'UNSENT') counts[it.status]++;
    if (hasUnsent(it)) counts.UNSENT++;
    const cur = bucket(it.currency);
    if (it.status !== 'UNSENT') Object.assign(cur, addDisputeSums(cur, it.sums));
    cur.unsentAmount = sumMoney([cur.unsentAmount, it.unsentAmount]);
  }
  // Etkin turu olmayan faturanın geçerli satırları (yeniden gönderilen tur geri çekildiyse önceki turda parası gelmiş
  // satırlar): Pano ve Merkez sayar, özet de sayar; satır listede "gönderilmedi" görünse de, hiç görünmese de.
  for (const inv of invoices) {
    const f = activeOf.has(inv.id) ? undefined : facts.get(inv.id);
    if (f) Object.assign(bucket(f.currency), addDisputeSums(bucket(f.currency), f.sums));
  }
  const byCurrency = [...byCur.values()].sort((a, b) => (a.currency === firmCurrency ? -1 : b.currency === firmCurrency ? 1 : a.currency.localeCompare(b.currency)));
  const dueSoon = all
    .filter(hasUnsent)
    .filter((it) => {
      const d = mainDeadline(it.deadlines);
      return d != null && d.daysLeft <= DUE_SOON_DAYS;
    })
    .sort(byDeadline)
    .slice(0, DUE_SOON_MAX);

  const needle = q.q?.toLocaleLowerCase('tr');
  const filtered = all
    .filter((it) => !q.status || (q.status === 'UNSENT' ? hasUnsent(it) : it.status === q.status))
    .filter((it) => !q.carrierId || it.carrier?.id === q.carrierId)
    .filter((it) => !needle || it.invoiceNo.toLocaleLowerCase('tr').includes(needle) || (it.carrier?.name ?? '').toLocaleLowerCase('tr').includes(needle))
    .sort(compareItems);
  const start = (q.page - 1) * q.pageSize;
  return {
    items: filtered.slice(start, start + q.pageSize),
    total: filtered.length,
    page: q.page,
    pageSize: q.pageSize,
    summary: { counts, byCurrency, dueSoon },
  };
}
