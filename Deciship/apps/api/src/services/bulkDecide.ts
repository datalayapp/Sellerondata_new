/**
 * Mesaj 14 (08-B1): satır kararı, tek satırda ve toplu. Tek satırlık `PATCH /invoice-lines/:id` ile toplu
 * `POST /invoices/:id/lines/decide` aynı kuralları buradan alır:
 *  - karar alanları (`decisionFields`): `OPEN`'da gerekçe, kişi ve an boşalır;
 *  - karar fatura kilidi altında, etkin itiraz turundaki satıra dokunmadan ve toplam aynı işlemde yazılır
 *    (`refreshTotals(invoiceId, tx)`; `calculatedAt` verilmez, son hesap anı kararla ilerlemez);
 *  - kararı `OPEN`'a dönen ve `recalcPending` taşıyan satır, işlemden sonra yalnız kendisi, faturanın sabit dayanağıyla
 *    hesaplanır (`reopenPendingLines`); bu arada satıra yeniden karar verildiyse hesap yazılmaz, satır işaretli kalır.
 *
 * Satır süzgecinin tek tanımı da buradadır (`buildLineWhere`): `GET /invoices/:id/lines` ile toplu kararın "bu süzgeçteki
 * tümü" seçimi aynı satırları görür.
 */
import crypto from 'node:crypto';
import { HARD_ROW_FLAGS, isDisputable, normalizeTracking } from '@deciship/core';
import { prisma, type Prisma, TX_DEFAULTS } from '../db.ts';
import { AppError, notFound } from '../errors.ts';
import { m as msg } from '../i18n/index.ts';
import { num, numOrNull } from '../lib/util.ts';
import { applyRecompare, isEstimated, pendingCauseOf, refreshTotals, type InvoiceTotals, type RecalcCause, type RecalcPendingCause } from './compare.ts';
import { activeRoundWhere, lockInvoice } from './disputes.ts';

export type LineDecision = 'OPEN' | 'VERIFIED' | 'ACCEPTED';
export type LineStatusFilter = 'MATCH' | 'DIFF' | 'UNMATCHED' | 'NO_TARIFF';
export type DiffTypeFilter = 'DUPLICATE' | 'DIMENSION' | 'WEIGHT' | 'SURCHARGE' | 'PRICE';

/** Satır listesinin süzgeci (sayfalama hariç). `false` ile yok aynıdır (liste ucunun sorgu kuralı). */
export type LineFilter = {
  status?: LineStatusFilter;
  diffType?: DiffTypeFilter;
  decision?: LineDecision[];
  q?: string;
  /** yalnız yeniden hesap bekleyen (donmuş, `recalcPending` dolu) satırlar */
  recalcPending?: boolean;
  /** yalnız "İncele" (güveni düşük: `pricing.confidence = 'LOW'`) satırlar */
  review?: boolean;
  /** yalnız "Kontrol edilecek" (okuma bayrağı olan, kontrol edilmemiş) satırlar */
  flagged?: boolean;
};

/**
 * `contains` / `startsWith` için LIKE kaçışı. Prisma 7 (sorgu derleyicisi) değeri olduğu gibi `LIKE '%' || $1 || '%'`
 * içine koyar, `%` ve `_` kaçışlanmaz (sahte bağdaştırıcıyla üretilen SQL'e bakılarak doğrulandı): `q=%` her satırı
 * bulurdu. Postgres'in varsayılan kaçış karakteri ters bölüdür.
 */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Faturanın satırlarından süzgece uyanlar: liste ucu ve toplu karar bunu kullanır (eşdeğerlik testle sabit). */
export function buildLineWhere(invoiceId: string, q: LineFilter): Prisma.InvoiceLineWhereInput {
  const where: Prisma.InvoiceLineWhereInput = { invoiceId };
  if (q.status) where.status = q.status;
  if (q.diffType) where.diffTypes = { has: q.diffType };
  if (q.decision) where.decision = { in: q.decision };
  if (q.q) where.trackingNo = { contains: likeEscape(normalizeTracking(q.q)) };
  if (q.recalcPending) where.recalcPending = { not: null };
  // Rozetle aynı kural (serializeLine `confidence`): güven `pricing` kaydında; eski satırda (pricing yok) kesin sayılır.
  if (q.review) where.pricing = { path: ['confidence'], equals: 'LOW' };
  if (q.flagged) {
    where.parseFlags = { hasSome: HARD_ROW_FLAGS };
    where.parseChecked = false;
  }
  return where;
}

/** Karar alanları; tek satır ve toplu aynı. `OPEN` (geri al) gerekçeyi, kişiyi ve anı boşaltır. */
export function decisionFields(decision: LineDecision, reason: string | null | undefined, userId: string, at: Date = new Date()) {
  if (decision === 'OPEN') return { decision, decisionReason: null, decidedById: null, decidedAt: null };
  return { decision, decisionReason: reason ?? null, decidedById: userId, decidedAt: at };
}

/** Tek seferde en çok bu kadar satır (gövdedeki kimlikler ya da süzgecin bugünkü toplamı). */
export const BULK_DECIDE_MAX = 5000;

/**
 * Y127: "bu süzgeçteki tümü" seçiminin özeti. Liste ucu süzgecin BÜTÜN satırlarından (yalnız görünen sayfa değil) üretir,
 * toplu karar fatura kilidi altında karar verilecek satırları okuduğu sorgudan yeniden üretir; tutmazsa 409.
 *
 * Neden zaman damgası (`listedAt`, `updatedAt > listedAt`) yetmiyordu: `updatedAt` yazımın işlem İÇİNDEKİ anıdır (Prisma
 * `@updatedAt` ve lineWrite.ts uygulama saatiyle yazar), commit anı değildir. Sıra: (1) bir yazıcı satırı t1 anıyla yazar ama
 * henüz commit etmez (ör. fatura kilidiyle saniyeler süren yeniden karşılaştırma); (2) liste ucu `listedAt = T > t1` alır ve
 * okur, yazım görünmez; (3) yazıcı commit eder, satır süzgece girer; (4) toplu karar: satırın `updatedAt`'i t1 < T olduğundan
 * yakalanmaz, süzgeçten bir satırın çıkması (aynı ya da ayrı yazım) sayıyı dengelerse `expectedCount` da tutar ve kullanıcının
 * görmediği satıra karar yazılır. Birden çok API kopyasındaki saat farkı da aynı pencereyi açar.
 *
 * Özet saate bakmaz: satır kimliği, `updatedAt`, karar, durum ve `recalcPending`, kimliğe göre sıralı, SHA-256. Kümeye giren ya
 * da çıkan her satır ve kümedeki satıra commit edilmiş her yazım (her yazım `updatedAt`'i değiştirir) özeti değiştirir.
 */
export const SELECTION_DIGEST_SELECT = { id: true, updatedAt: true, decision: true, status: true, recalcPending: true } as const;
export type SelectionDigestRow = { id: string; updatedAt: Date; decision: string; status: string; recalcPending: string | null };

export function selectionDigest(rows: readonly SelectionDigestRow[]): string {
  const parts = rows.map((r) => `${r.id}|${r.updatedAt.getTime()}|${r.decision}|${r.status}|${r.recalcPending ?? ''}`).sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Liste ucu için süzgecin toplamı ve özeti, tek sorguda (toplam ile özet aynı anın kümesi). Süzgeçte `BULK_DECIDE_MAX`'tan
 * çok satır varsa null: "tümünü seç" zaten sunulmaz, büyük faturada bütün satırlar okunmaz. 5.000 satırda beş küçük sütun.
 */
export async function listSelection(where: Prisma.InvoiceLineWhereInput): Promise<{ total: number; digest: string } | null> {
  // 19-B14: önce sayım (dizinli); büyük süzgeçte 5.001 satır okunup atılmaz. Toplam ve özet yine aynı okumadan.
  if ((await prisma.invoiceLine.count({ where })) > BULK_DECIDE_MAX) return null;
  const rows = await prisma.invoiceLine.findMany({ where, select: SELECTION_DIGEST_SELECT, take: BULK_DECIDE_MAX + 1 });
  if (rows.length > BULK_DECIDE_MAX) return null;
  return { total: rows.length, digest: selectionDigest(rows) };
}

/**
 * Atlanan satırlar, nedene göre. Adlarda para sözcüğü yok (`app.ts` `MONEY_KEY`: fiyat izni olmayana "diff" geçen alan
 * silinir): "Fark var" olmayan satır `noGap`, talebi sıfır olan `noClaim`.
 */
export type BulkSkipped = {
  inDispute: number;
  /** "Fark var" değil (uyumlu, eşleşmedi, tarifesiz) */
  noGap: number;
  review: number;
  decided: number;
  pending: number;
  notDecided: number;
  /** "İtiraz listesine ekle": fark var ama talebi sıfır (itiraz metnine girmez, `isDisputable` dışı) */
  noClaim: number;
  /** "Geri al": kararı bu arada başkası ya da başka bir işlem verdi (geri alınan işlemin kararı değil) */
  changedSince: number;
};
export type BulkSkipReason = keyof BulkSkipped;
const noneSkipped = (): BulkSkipped => ({ inDispute: 0, noGap: 0, review: 0, decided: 0, pending: 0, notDecided: 0, noClaim: 0, changedSince: 0 });

/** Geri alınan işlemin yazdığı karar: karar veren ve an (tek işlemde bütün satırlara aynı an yazılır). */
export type UndoMark = { userId: string; decidedAt: Date };

/**
 * Toplu kararın satır kuralı; `null` = satır değişir. Sıra önemlidir (her satır tek nedenle sayılır):
 *  - Etkin itiraz turundaki satıra hiçbir kararda dokunulmaz.
 *  - `VERIFIED` / `ACCEPTED` yalnız kararı bekleyen (`OPEN`), "Fark var" (`DIFF`) ve yeniden hesap beklemeyen satıra.
 *    `VERIFIED` (itiraz listesi) talebi sıfır olan satıra uygulanmaz (`noClaim`; itiraz metniyle aynı kural). "İncele"
 *    işaretli (tahmini) satır itiraz listesine toplu girmez ama uyumlu sayılabilir.
 *  - `OPEN` (geri al) yalnız kararı verilmiş satıra; `undo` verilmişse yalnız o işlemin kararını taşıyan satıra.
 */
export function bulkSkipReason(
  decision: LineDecision,
  l: {
    decision: string;
    status: string;
    recalcPending: string | null;
    pricing: unknown;
    inDispute: boolean;
    diffTypes?: readonly string[];
    netAmount?: Prisma.Decimal | number | null;
    diffAmount?: Prisma.Decimal | number | null;
    decidedById?: string | null;
    decidedAt?: Date | null;
  },
  undo?: UndoMark | null,
): BulkSkipReason | null {
  if (l.inDispute) return 'inDispute';
  if (decision === 'OPEN') {
    if (l.decision === 'OPEN') return 'notDecided';
    if (undo && (l.decidedById !== undo.userId || l.decidedAt == null || +l.decidedAt !== +undo.decidedAt)) return 'changedSince';
    return null;
  }
  if (l.decision !== 'OPEN') return 'decided';
  if (l.status !== 'DIFF') return 'noGap';
  if (l.recalcPending != null) return 'pending';
  if (decision === 'VERIFIED' && !hasClaim(l)) return 'noClaim';
  if (decision === 'VERIFIED' && isEstimated(l.pricing)) return 'review';
  return null;
}

/**
 * "Fark var" satırın talebi sıfırdan büyük mü (itiraz metniyle aynı kural, `isDisputable`). "İtiraz listesine ekle"nin
 * toplu yolu (`noClaim`) ve tek satır yolu (`PATCH /invoice-lines/:id`, 409 `NO_CLAIM`) bunu kullanır (Y126).
 */
export function hasClaim(l: {
  diffTypes?: readonly string[] | null;
  netAmount?: Prisma.Decimal | number | null;
  diffAmount?: Prisma.Decimal | number | null;
}): boolean {
  return isDisputable({ diffTypes: l.diffTypes ?? [], billedAmount: num(l.netAmount ?? 0), diffAmount: numOrNull(l.diffAmount ?? null), status: 'DIFF' });
}

export type BulkDecideInput = {
  decision: LineDecision;
  /** `ACCEPTED`'da zorunlu (çağıran denetler); `OPEN`'da yok sayılır */
  reason?: string | null;
  /** tam olarak biri: kimlikler ya da süzgeç (+ `expectedCount` ve `selectionDigest`) */
  lineIds?: string[];
  filter?: LineFilter;
  expectedCount?: number;
  /** Süzgeçle seçimde liste yanıtının `selectionDigest`'i (Y127): kilit altında yeniden üretilen özet tutmazsa 409. */
  selectionDigest?: string;
  /** Yalnız `OPEN` + `lineIds`: geri alınan işlem (`opId` ve o işlemin `decidedAt`'i). */
  undoOf?: { opId: string; decidedAt: Date };
};

export type BulkDecideResult = {
  opId: string;
  decision: LineDecision;
  changed: number;
  /** satır sırasıyla; web "Geri al"da bunlarla `decision: 'OPEN'` ve `undoOf` gönderir */
  changedLineIds: string[];
  /** yazılan karar anı (ISO; `OPEN`'da null): "Geri al" `undoOf.decidedAt` olarak geri gönderir */
  decidedAt: string | null;
  skipped: BulkSkipped;
  totals: InvoiceTotals;
};

const tooMany = () => new AppError(400, 'BULK_TOO_MANY', msg('err.bulkTooMany'));
/**
 * Ayrıntı adlarında para sözcüğü yok ("expected" fiyat izni olmayana silinirdi). `changed`: 0 = sayı tutmadı; 1 = sayı tuttu
 * ama küme ya da kümedeki bir satır değişti (özet kaç satır olduğunu söylemez).
 */
const selectionChanged = (listed: number, current: number, changed = 0) =>
  new AppError(409, 'SELECTION_CHANGED', msg('err.selectionChanged'), { listed, current, changed });

/**
 * Toplu karar (§4.1). Fatura kilidi altında, tek işlemde: seçim (kimlikler ya da süzgeç) yeniden okunur; süzgeçte bugünkü
 * toplam `expectedCount`'tan farklıysa ya da karar verilecek satırların özeti listedeki `selectionDigest`'i tutmazsa hiçbir
 * şey yazılmaz (409 SELECTION_CHANGED). "Geri al" (`undoOf`) yalnız o işlemin kararını (karar veren + an) hâlâ taşıyan satırları açar,
 * arada başkasının verdiği karar kalır (`skipped.changedSince`). Satırların kararı, durumu, güveni,
 * `recalcPending` değeri ve etkin itiraz üyeliği aynı sorguda okunur; uygun olanlar yazılır, öbürleri nedenine göre sayılır.
 * Satır başına `invoiceLine.bulkDecision` ve fatura için tek `invoice.linesDecided` denetim kaydı kararla aynı işlemdedir
 * (karar ile izi birlikte yazılır ya da hiç). Toplam aynı işlemde yazılır. İşlemden sonra geri alınan işaretli satırlar
 * tek satır kuralıyla hesaplanır. Fatura yoksa ya da silinmişse 404; kimliklerden biri bu faturanın değilse 404.
 */
export async function bulkDecide(actor: { companyId: string; userId: string }, invoiceId: string, input: BulkDecideInput): Promise<BulkDecideResult> {
  const { companyId, userId } = actor;
  const { decision } = input;
  const reason = decision === 'OPEN' ? null : (input.reason ?? null);
  const ids = input.lineIds ? [...new Set(input.lineIds)] : null;
  if (ids && ids.length > BULK_DECIDE_MAX) throw tooMany();
  // Çağıran (uç) gövdeyi doğrular; burası programlama hatasına karşı.
  if (input.undoOf && (decision !== 'OPEN' || !ids)) throw new Error('bulkDecide: undoOf requires decision OPEN with lineIds');
  if (!ids && !input.selectionDigest) throw new Error('bulkDecide: filter requires selectionDigest');
  const undo: UndoMark | null = input.undoOf ? { userId, decidedAt: input.undoOf.decidedAt } : null;
  const opId = crypto.randomUUID();
  const at = new Date();

  const written = await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, companyId, invoiceId);
    let where: Prisma.InvoiceLineWhereInput;
    let expected: number | null = null;
    if (ids) where = { invoiceId, id: { in: ids } };
    else {
      where = buildLineWhere(invoiceId, input.filter ?? {});
      expected = input.expectedCount ?? -1;
      const actual = await tx.invoiceLine.count({ where });
      if (actual !== expected) throw selectionChanged(expected, actual);
      if (actual > BULK_DECIDE_MAX) throw tooMany();
    }
    // Kilit altında tek okuma: karar, durum, güven, işaret, talep ve etkin itiraz turu (itiraz tarafıyla aynı koşul).
    // Süzgeçte özet de bu okumadan üretilir: özeti tutan küme, kararın yazılacağı kümenin kendisidir.
    const rows = await tx.invoiceLine.findMany({
      where,
      orderBy: { rowIndex: 'asc' },
      select: {
        id: true,
        updatedAt: true,
        decision: true,
        decidedById: true,
        decidedAt: true,
        status: true,
        recalcPending: true,
        pricing: true,
        diffTypes: true,
        netAmount: true,
        diffAmount: true,
        disputeLines: { where: { companyId, dispute: activeRoundWhere }, select: { id: true }, take: 1 },
      },
    });
    if (ids && rows.length !== ids.length) throw notFound(msg('line.notFound'));
    if (expected != null && rows.length !== expected) throw selectionChanged(expected, rows.length);
    // Y127: sayı tutsa da küme değişmiş olabilir (bir satır süzgece girdi, biri çıktı) ya da kümedeki bir satır listeden sonra
    // yazılmış olabilir. Saatten bağımsız: listedeki özet ile kilit altındaki kümenin özeti.
    if (expected != null && selectionDigest(rows) !== input.selectionDigest) throw selectionChanged(expected, rows.length, 1);

    const skipped = noneSkipped();
    const chosen: typeof rows = [];
    for (const r of rows) {
      const why = bulkSkipReason(decision, { ...r, inDispute: r.disputeLines.length > 0 }, undo);
      if (why) skipped[why]++;
      else chosen.push(r);
    }

    if (chosen.length) {
      const chosenIds = chosen.map((r) => r.id);
      // Kilit altında okunan koşul yazımda yeniden: kilidi almayan bir yazıcı araya girdiyse işlem geri alınır.
      const guard: Prisma.InvoiceLineWhereInput =
        decision !== 'OPEN'
          ? { decision: 'OPEN', status: 'DIFF', recalcPending: null }
          : undo
            ? { decision: { not: 'OPEN' }, decidedById: undo.userId, decidedAt: undo.decidedAt }
            : { decision: { not: 'OPEN' } };
      const n = await tx.invoiceLine.updateMany({ where: { invoiceId, id: { in: chosenIds }, ...guard }, data: decisionFields(decision, reason, userId, at) });
      if (n.count !== chosenIds.length) throw new Error(`bulkDecide: ${chosenIds.length - n.count} line(s) changed under the invoice lock`);
      const undoOf = input.undoOf?.opId ?? null;
      await tx.auditLog.createMany({
        data: chosen.map((r) => ({
          companyId,
          userId,
          action: 'invoiceLine.bulkDecision',
          entity: 'InvoiceLine',
          entityId: r.id,
          data: { decision, reason, previous: r.decision, opId, ...(undoOf ? { undoOf } : {}) },
        })),
      });
      await tx.auditLog.create({
        data: { companyId, userId, action: 'invoice.linesDecided', entity: 'Invoice', entityId: invoiceId, data: { decision, count: chosen.length, opId, ...(undoOf ? { undoOf } : {}) } },
      });
    }
    // Son hesap anı (`calculatedAt`) kararla ilerlemez.
    const totals = await refreshTotals(invoiceId, tx);
    return { chosen, skipped, totals };
  }, TX_DEFAULTS);

  let totals = written.totals;
  if (decision === 'OPEN') {
    const reopened = written.chosen.filter((r) => r.recalcPending != null).map((r) => ({ id: r.id, recalcPending: r.recalcPending }));
    totals = (await reopenPendingLines(invoiceId, reopened)) ?? totals;
  }
  return {
    opId,
    decision,
    changed: written.chosen.length,
    changedLineIds: written.chosen.map((r) => r.id),
    decidedAt: decision === 'OPEN' || !written.chosen.length ? null : at.toISOString(),
    skipped: written.skipped,
    totals,
  };
}

/** Karar geri alınırken satıra bu arada yeniden karar verildi: hesap yazılmaz (işlem geri alınır). */
class ReopenRaced extends Error {}

/** Bir neden sınıfı için en çok bu kadar deneme (her yarışta kalan satırlarla yeniden). */
const REOPEN_ATTEMPTS = 3;

/**
 * Kararı `OPEN`'a dönmüş, `recalcPending` taşıyan satırlar: işaretin nedenine göre gruplanır (en çok üç grup) ve her
 * grup yalnız kendi satırlarıyla (`lineIds`), faturanın sabit dayanağıyla hesaplanır (eski rakam `prevResult`'a, işaret
 * silinir). Yazımdan hemen önce, fatura kilidi altında satırların hâlâ `OPEN` olduğu denetlenir; değilse (bu arada yeniden
 * karar verildi) grup yazılmaz ve hâlâ açık, işaretli ve itirazsız kalan satırlarla yeniden denenir. Yeniden karar verilen
 * satır işaretli kalır. Son yazılan toplamı döner; hiçbir grup yazılmadıysa (ya da fatura silindiyse) null.
 */
export async function reopenPendingLines(invoiceId: string, lines: { id: string; recalcPending: string | null }[]): Promise<InvoiceTotals | null> {
  const groups = new Map<RecalcPendingCause, string[]>();
  for (const l of lines) {
    if (l.recalcPending == null) continue;
    const cause = pendingCauseOf(l.recalcPending as RecalcCause);
    groups.set(cause, [...(groups.get(cause) ?? []), l.id]);
  }
  let totals: InvoiceTotals | null = null;
  for (const [cause, ids] of groups) {
    let want = ids;
    for (let attempt = 1; attempt <= REOPEN_ATTEMPTS && want.length; attempt++) {
      try {
        const lineIds = want;
        const r = await applyRecompare(invoiceId, {
          basis: 'pinned',
          scope: 'open',
          lineIds,
          cause,
          patient: true,
          onWrite: async (tx) => {
            const open = await tx.invoiceLine.count({ where: { invoiceId, id: { in: lineIds }, decision: 'OPEN' } });
            if (open !== lineIds.length) throw new ReopenRaced();
          },
        });
        if (r === null) return totals;
        if (typeof r !== 'string') {
          totals = r.totals;
          break;
        }
        // LINE_IN_DISPUTE: satır bu arada yeniden listeye alınıp gönderildi; kalanlarla yeniden.
      } catch (e) {
        if (!(e instanceof ReopenRaced)) throw e;
      }
      want = await stillReopened(invoiceId, want);
    }
  }
  return totals;
}

/** Hâlâ kararı açık, işaretli ve etkin itiraz turunda olmayan satırlar. */
async function stillReopened(invoiceId: string, ids: string[]): Promise<string[]> {
  const rows = await prisma.invoiceLine.findMany({
    where: { invoiceId, id: { in: ids }, decision: 'OPEN', recalcPending: { not: null }, disputeLines: { none: { dispute: activeRoundWhere } } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
