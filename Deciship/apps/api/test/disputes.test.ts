import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { setFxService } from '../src/services/fx.ts';
import { API, caller, cents, digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';
import { tariffPayload } from './fixtures.ts';
import { anyDayFx } from './fxFake.ts';
import { getApp, inCompany, issueIdentity } from './helpers.ts';

type Sums = { claimedAmount: number; recoveredAmount: number; rejectedAmount: number; pendingAmount: number; shortfallAmount: number };
type Round = {
  id: string;
  round: number;
  version: number;
  ttk: string | null;
  ttkSentOn: string;
  currency: string;
  sentOn: string;
  sentBy: { id: string; name: string };
  withdrawnAt: string | null;
  withdrawnBy: { id: string } | null;
  withdrawReason: string | null;
  supersededAt: string | null;
  supersededById: string | null;
  sums: Sums;
  lines: { id: string; invoiceLineId: string; claimedAmount: number; outcome: string; recoveredAmount: number | null; resultId: string | null; lineNo: number | null; trackingNo: string }[];
  results: { id: string; kind: string; amount: number; creditNoteNo: string | null; reason: string | null; revertedAt: string | null; revertedBy: { id: string } | null; revertReason: string | null; enteredBy: { id: string }; lines: { disputeLineId: string; amount: number }[] }[];
};
type InvoiceDispute = { status: string; active: Round | null; history: Round[]; sendableLineCount: number; sendableAmount: number; unsentLineCount: number; unsentAmount: number; recalcPendingLines: number; sums: Sums | null };

let app: FastifyInstance;
let call: ReturnType<typeof caller>;

beforeAll(async () => {
  app = await getApp();
  call = caller(app);
});

const detail = async (auth: { authorization: string }, invoiceId: string) => {
  const r = await call(auth, 'GET', `/invoices/${invoiceId}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().invoice.dispute as InvoiceDispute;
};

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + cents(b), 0) / 100;

describe('itiraz yaşam döngüsü: gönder → kısmi geri al → reddet → kapat → geri al → yeniden gönder → geri çek', () => {
  let c: DisputeCompany;
  let inv: Awaited<ReturnType<typeof invoiceWithDiffs>>;

  beforeAll(async () => {
    c = await disputeCompany(app);
    // dört satır listede, beşinci "Fark var" ama karar verilmedi: pakete girmez
    inv = await invoiceWithDiffs(app, c, [50, 60.55, 70.1, 80.99, 45], { verify: 4 });
  });

  it('gönderilmeden önce: durum NONE, gönderilecek satır ve talep itiraz metniyle aynı, liste UNSENT ve süresi yaklaşanlarda', async () => {
    const d = await detail(c.admin.auth, inv.invoiceId);
    expect(d).toMatchObject({ status: 'NONE', active: null, history: [], sendableLineCount: 4, unsentLineCount: 4, sums: null });
    expect(d.unsentAmount).toBe(d.sendableAmount);
    const text = (await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}/dispute`)).json();
    expect(text.lineCount).toBe(4);
    expect(d.sendableAmount).toBe(text.total);
    expect(d.sendableAmount).toBe(sumOf(inv.lines.slice(0, 4).map((l) => l.diffAmount)));

    const list = (await call(c.admin.auth, 'GET', '/disputes')).json();
    expect(list.summary.counts).toEqual({ UNSENT: 1, SENT: 0, CLOSED: 0, ALL: 1 });
    expect(list.items[0]).toMatchObject({ invoiceId: inv.invoiceId, status: 'UNSENT', lineCount: 4, unsentLineCount: 4, unsentAmount: d.sendableAmount, disputeId: null, sums: { claimedAmount: d.sendableAmount, recoveredAmount: 0 } });
    expect(list.items[0].deadlines.ttk).toMatchObject({ days: 8, daysLeft: 5, expired: false });
    expect(list.summary.dueSoon.map((i: { invoiceId: string }) => i.invoiceId)).toEqual([inv.invoiceId]);
    expect(list.summary.byCurrency).toEqual([{ currency: 'TRY', claimedAmount: 0, recoveredAmount: 0, rejectedAmount: 0, pendingAmount: 0, shortfallAmount: 0, unsentAmount: d.sendableAmount }]);
    const items = (await call(c.admin.auth, 'GET', '/invoices')).json().items;
    expect(items.find((i: { id: string }) => i.id === inv.invoiceId)).toMatchObject({ disputeStatus: 'NONE', disputeSums: null });
  });

  it('gönderme kuralları: gelecek tarih, fatura tarihinden önce, "Diğer" kanalında açıklama', async () => {
    const send = async (body: object) => call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { ...body, selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    const future = await send({ sentOn: trDay(1), channel: 'EMAIL' });
    expect([future.statusCode, future.json().error.code]).toEqual([400, 'SENT_ON_IN_FUTURE']);
    const early = await send({ sentOn: trDay(-4), channel: 'EMAIL' });
    expect([early.statusCode, early.json().error.code]).toEqual([400, 'VALIDATION']);
    expect(early.json().error.details[0].path).toBe('sentOn');
    const other = await send({ sentOn: trDay(0), channel: 'OTHER' });
    expect([other.statusCode, other.json().error.code]).toEqual([400, 'VALIDATION']);
    expect(other.json().error.details[0].path).toBe('channelNote');
    const bad = await send({ sentOn: '2026-02-30', channel: 'EMAIL' });
    expect(bad.statusCode).toBe(400);
    expect(await inCompany(c.admin.auth, () => prisma.dispute.count({ where: { invoiceId: inv.invoiceId } }))).toBe(0);
  });

  let round1: Round;

  it('gönderir: tur 1, satırlar bekliyor, talep değişmez, TTK zamanında; ikinci gönderme 409', async () => {
    const r = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'PORTAL', reference: 'CASE-1' });
    expect(r.statusCode, r.body).toBe(201);
    const d = r.json().dispute as InvoiceDispute;
    expect(d.status).toBe('SENT');
    round1 = d.active!;
    expect(round1).toMatchObject({ round: 1, version: 1, ttk: 'ON_TIME', currency: 'TRY', sentOn: trDay(-1), sentBy: { id: c.admin.userId }, withdrawnAt: null, supersededAt: null });
    expect(round1.lines.map((l) => l.outcome)).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
    expect(round1.lines.map((l) => l.claimedAmount)).toEqual(inv.lines.slice(0, 4).map((l) => l.diffAmount));
    // satır no satır tablosundaki rowIndex ile aynı
    expect(round1.lines.map((l) => l.lineNo)).toEqual(inv.lines.slice(0, 4).map((l) => l.rowIndex + 1)); // ekranda 1 tabanlı
    expect(round1.sums).toEqual({ claimedAmount: d.sendableAmount, recoveredAmount: 0, rejectedAmount: 0, pendingAmount: d.sendableAmount, shortfallAmount: 0 });
    expect(d.sums).toEqual(round1.sums);

    const again = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(0), channel: 'EMAIL' });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'DISPUTE_ACTIVE']);
  });

  it('paketteki satırın kararı, takip no ve ölçümü kilitli; not serbest; fatura silinemez ve para birimi değişmez', async () => {
    const line = inv.lines[0]!;
    for (const payload of [{ decision: 'OPEN' }, { decision: 'ACCEPTED', reason: 'x' }, { trackingNo: 'YENI123' }, { measurementId: null }]) {
      const r = await call(c.admin.auth, 'PATCH', `/invoice-lines/${line.id}`, payload);
      if ('measurementId' in payload) continue; // eşleşme sabit değilken null değişiklik değildir
      expect([r.statusCode, r.json().error?.code], JSON.stringify(payload)).toEqual([409, 'LINE_IN_DISPUTE']);
    }
    const note = await call(c.admin.auth, 'PATCH', `/invoice-lines/${line.id}`, { note: 'taşıyıcıya yazıldı' });
    expect(note.statusCode, note.body).toBe(200);
    expect(note.json().line.dispute).toEqual({ outcome: 'PENDING', recoveredAmount: null });
    // pakette olmayan satırın kararı değişir
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[4]!.id}`, { decision: 'ACCEPTED', reason: 'anlaşma' })).statusCode).toBe(200);
    const del = await call(c.admin.auth, 'DELETE', `/invoices/${inv.invoiceId}`);
    expect([del.statusCode, del.json().error.code]).toEqual([409, 'INVOICE_HAS_DISPUTE']);
    const cur = await call(c.admin.auth, 'PATCH', `/invoices/${inv.invoiceId}`, { currency: 'EUR' });
    expect([cur.statusCode, cur.json().error.code]).toEqual([409, 'INVOICE_HAS_DISPUTE']);
    // Mesaj 4: kilit dört alanı kapsar (taşıyıcı, tarih, tarife, para birimi); ayrıntısı recalculate.test.ts
    expect(cur.json().error.message).toContain('taşıyıcı, tarih, tarife ve para birimi');
  });

  it('yeniden karşılaştırma talebi değiştirmez', async () => {
    // tarife pahalılaşsa bile gönderilmiş talep aynı kalır
    expect((await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/recompare`)).statusCode).toBe(200);
    const d = await detail(c.admin.auth, inv.invoiceId);
    expect(d.active!.lines.map((l) => l.claimedAmount)).toEqual(round1.lines.map((l) => l.claimedAmount));
    expect(d.active!.version).toBe(1);
  });

  it('sonuç kuralları: eski sürüm, talebi aşan, dekontsuz, nedensiz ret, başka turun satırı, tekrar eden satır', async () => {
    const [l1, l2] = round1.lines;
    const post = (body: unknown) => call(c.admin.auth, 'POST', `/disputes/${round1.id}/results`, body);
    const base = { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-1' };
    const cases: [unknown, number, string][] = [
      [{ ...base, version: 0, lines: [{ disputeLineId: l1!.id, amount: 1 }] }, 400, 'VALIDATION'],
      [{ ...base, version: 2, lines: [{ disputeLineId: l1!.id, amount: 1 }] }, 409, 'STALE'],
      [{ ...base, lines: [{ disputeLineId: l1!.id, amount: l1!.claimedAmount + 0.01 }] }, 400, 'AMOUNT_EXCEEDS_CLAIM'],
      [{ ...base, lines: [{ disputeLineId: l1!.id, amount: 0 }] }, 400, 'VALIDATION'],
      [{ ...base, lines: [{ disputeLineId: l1!.id }] }, 400, 'VALIDATION'],
      [{ ...base, creditNoteNo: '', lines: [{ disputeLineId: l1!.id, amount: 1 }] }, 400, 'CREDIT_NOTE_REQUIRED'],
      [{ ...base, creditNoteNo: 'x'.repeat(65), lines: [{ disputeLineId: l1!.id, amount: 1 }] }, 400, 'VALIDATION'],
      [{ version: 1, kind: 'REJECTED', resultOn: trDay(0), lines: [{ disputeLineId: l1!.id }] }, 400, 'REASON_REQUIRED'],
      [{ ...base, resultOn: trDay(1), lines: [{ disputeLineId: l1!.id, amount: 1 }] }, 400, 'RESULT_ON_IN_FUTURE'],
      // tur dün gönderildi: sonuç ondan önce olamaz
      [{ ...base, resultOn: trDay(-2), lines: [{ disputeLineId: l1!.id, amount: 1 }] }, 400, 'RESULT_ON_BEFORE_SENT'],
      // ikiden çok ondalık sessizce yuvarlanmaz
      [{ ...base, lines: [{ disputeLineId: l1!.id, amount: 1.005 }] }, 400, 'VALIDATION'],
      [{ ...base, lines: [{ disputeLineId: 'yok', amount: 1 }] }, 400, 'VALIDATION'],
      [{ ...base, lines: [{ disputeLineId: l1!.id, amount: 1 }, { disputeLineId: l1!.id, amount: 1 }] }, 400, 'VALIDATION'],
      [{ ...base, lines: [] }, 400, 'VALIDATION'],
    ];
    for (const [body, status, code] of cases) {
      const r = await post(body);
      expect([r.statusCode, r.json().error?.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(l2).toBeTruthy();
    expect((await detail(c.admin.auth, inv.invoiceId)).active!.version).toBe(1);
  });

  it('bir dekont iki satırı kapsar, biri talepten az (kuruşlu): eksik kalan görünür; aynı satıra ikinci sonuç 409', async () => {
    const [l1, l2] = round1.lines;
    const partial = Math.round((l2!.claimedAmount - 1.37) * 100) / 100;
    const r = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/results`, {
      version: 1,
      kind: 'RECOVERED',
      resultOn: trDay(0),
      creditNoteNo: 'AD-2026-0091',
      lines: [
        { disputeLineId: l1!.id, amount: l1!.claimedAmount },
        { disputeLineId: l2!.id, amount: partial },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().dispute as InvoiceDispute;
    const a = d.active!;
    expect(a.version).toBe(2);
    expect(a.lines.slice(0, 2).map((l) => [l.outcome, l.recoveredAmount])).toEqual([
      ['RECOVERED', l1!.claimedAmount],
      ['RECOVERED', partial],
    ]);
    expect(a.results).toHaveLength(1);
    expect(a.results[0]).toMatchObject({ kind: 'RECOVERED', creditNoteNo: 'AD-2026-0091', amount: sumOf([l1!.claimedAmount, partial]), enteredBy: { id: c.admin.userId }, revertedAt: null });
    expect(a.sums.recoveredAmount).toBe(sumOf([l1!.claimedAmount, partial]));
    expect(a.sums.shortfallAmount).toBe(1.37);
    expect(cents(a.sums.recoveredAmount) + cents(a.sums.shortfallAmount) + cents(a.sums.rejectedAmount) + cents(a.sums.pendingAmount)).toBe(cents(a.sums.claimedAmount));

    const again = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'x', lines: [{ disputeLineId: l1!.id }] });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'LINE_NOT_PENDING']);
    const withdraw = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/withdraw`, { version: 2, reason: 'yanlış' });
    expect([withdraw.statusCode, withdraw.json().error.code]).toEqual([409, 'HAS_RECOVERED_RESULTS']);
  });

  it('ret nedeniyle girilir; son satır geri alınınca fatura KAPANDI, listede ve satırlarda sonuç görünür', async () => {
    const [, , l3, l4] = round1.lines;
    const rej = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'Taşıyıcı ölçümü kabul etmedi', lines: [{ disputeLineId: l3!.id, amount: 999 }] });
    expect(rej.statusCode, rej.body).toBe(200);
    const afterRej = rej.json().dispute as InvoiceDispute;
    expect(afterRej.status).toBe('SENT');
    expect(afterRej.active!.results[0]).toMatchObject({ kind: 'REJECTED', reason: 'Taşıyıcı ölçümü kabul etmedi', amount: l3!.claimedAmount, creditNoteNo: null });
    const rec = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/results`, { version: 3, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-3', lines: [{ disputeLineId: l4!.id, amount: l4!.claimedAmount }] });
    expect(rec.statusCode, rec.body).toBe(200);
    const d = rec.json().dispute as InvoiceDispute;
    expect(d.status).toBe('CLOSED');
    expect(d.active!.sums.pendingAmount).toBe(0);
    expect(d.active!.sums.rejectedAmount).toBe(l3!.claimedAmount);
    // sonuçlar yeni önce
    expect(d.active!.results.map((x) => x.creditNoteNo)).toEqual(['AD-3', null, 'AD-2026-0091']);

    const list = (await call(c.admin.auth, 'GET', '/disputes?status=CLOSED')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: 'CLOSED', round: 1, lineCount: 4, resolvedCount: 4, ttkStatus: 'ON_TIME', channel: 'PORTAL', sums: d.sums });
    const item = (await call(c.admin.auth, 'GET', '/invoices')).json().items.find((i: { id: string }) => i.id === inv.invoiceId);
    expect(item).toMatchObject({ disputeStatus: 'CLOSED', disputeSums: d.sums });
    const lines = (await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}/lines`)).json().items as { id: string; dispute: unknown }[];
    expect(lines.map((l) => l.dispute)).toEqual([
      { outcome: 'RECOVERED', recoveredAmount: round1.lines[0]!.claimedAmount },
      { outcome: 'RECOVERED', recoveredAmount: d.active!.lines[1]!.recoveredAmount },
      { outcome: 'REJECTED', recoveredAmount: null },
      { outcome: 'RECOVERED', recoveredAmount: l4!.claimedAmount },
      null,
    ]);
  });

  it('sonuç geri alınır: satır bekliyora döner, giriş kim/ne zaman/neden ile kalır; ikinci geri alma 409', async () => {
    const d0 = await detail(c.admin.auth, inv.invoiceId);
    const last = d0.active!.results[0]!;
    const noReason = await call(c.admin.auth, 'POST', `/dispute-results/${last.id}/revert`, { version: d0.active!.version });
    expect([noReason.statusCode, noReason.json().error.code]).toEqual([400, 'REASON_REQUIRED']);
    const r = await call(c.admin.auth, 'POST', `/dispute-results/${last.id}/revert`, { version: d0.active!.version, reason: 'Dekont başka faturanınmış' });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().dispute as InvoiceDispute;
    expect(d.status).toBe('SENT');
    expect(d.active!.lines[3]).toMatchObject({ outcome: 'PENDING', recoveredAmount: null, resultId: null });
    expect(d.active!.results[0]).toMatchObject({ id: last.id, revertReason: 'Dekont başka faturanınmış', revertedBy: { id: c.admin.userId } });
    expect(d.active!.results[0]!.revertedAt).toEqual(expect.any(String));
    // geri alınan girişin payları durur
    expect(d.active!.results[0]!.lines).toEqual([{ disputeLineId: d.active!.lines[3]!.id, amount: d.active!.lines[3]!.claimedAmount }]);
    const twice = await call(c.admin.auth, 'POST', `/dispute-results/${last.id}/revert`, { version: d.active!.version, reason: 'x' });
    expect([twice.statusCode, twice.json().error.code]).toEqual([409, 'STALE']);
  });

  let round2: Round;

  it('yeniden gönderme: eski tur kapanır, geri alınmayanlar yeniden talep edilir, geri alınanlar fatura toplamında kalır', async () => {
    const d0 = await detail(c.admin.auth, inv.invoiceId);
    const stale = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/resend`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), version: 1, sentOn: trDay(0), channel: 'EMAIL' });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'STALE']);
    const r = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/resend`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), version: d0.active!.version, sentOn: trDay(0), channel: 'EMAIL' });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().dispute as InvoiceDispute;
    round2 = d.active!;
    expect(round2.round).toBe(2);
    // satır 1 ve 2 geri alındı: yeni turda yalnız 3 (reddedilmişti) ve 4 (geri alma geri alındı)
    expect(round2.lines.map((l) => l.invoiceLineId)).toEqual([inv.lines[2]!.id, inv.lines[3]!.id]);
    expect(round2.lines.every((l) => l.outcome === 'PENDING')).toBe(true);
    expect(d.history.map((h) => [h.round, h.supersededById])).toEqual([[1, round2.id]]);
    expect(d.history[0]!.supersededAt).toEqual(expect.any(String));
    // fatura toplamı: tur 1'in geri alınanları + tur 2'nin bekleyenleri
    const r1 = d.history[0]!;
    expect(d.sums).toEqual({
      claimedAmount: sumOf([r1.lines[0]!.claimedAmount, r1.lines[1]!.claimedAmount, ...round2.lines.map((l) => l.claimedAmount)]),
      recoveredAmount: r1.sums.recoveredAmount,
      rejectedAmount: 0,
      pendingAmount: round2.sums.pendingAmount,
      shortfallAmount: r1.sums.shortfallAmount,
    });
    // eski tura sonuç girilemez
    const old = await call(c.admin.auth, 'POST', `/disputes/${round1.id}/results`, { version: r1.version, kind: 'REJECTED', resultOn: trDay(0), reason: 'x', lines: [{ disputeLineId: r1.lines[3]!.id }] });
    expect([old.statusCode, old.json().error.code]).toEqual([409, 'STALE']);
  });

  it('geri çekme: neden zorunlu, sonra durum NONE ve yeni gönderme tur 3 açar', async () => {
    const noReason = await call(c.admin.auth, 'POST', `/disputes/${round2.id}/withdraw`, { version: round2.version });
    expect([noReason.statusCode, noReason.json().error.code]).toEqual([400, 'REASON_REQUIRED']);
    const r = await call(c.admin.auth, 'POST', `/disputes/${round2.id}/withdraw`, { version: round2.version, reason: 'Yanlış kanala gönderildi' });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().dispute as InvoiceDispute;
    expect(d.status).toBe('NONE');
    expect(d.active).toBeNull();
    expect(d.history.map((h) => h.round)).toEqual([2, 1]);
    expect(d.history[0]).toMatchObject({ withdrawReason: 'Yanlış kanala gönderildi', withdrawnBy: { id: c.admin.userId } });
    expect(d.sendableLineCount).toBe(2);
    // geri çekilen turun satırları kilitli değil
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[2]!.id}`, { decision: 'OPEN' })).statusCode).toBe(200);
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[2]!.id}`, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const again = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(0), channel: 'OTHER', channelNote: 'Kargo şubesine elden' });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().dispute.active).toMatchObject({ round: 3, channel: 'OTHER', channelNote: 'Kargo şubesine elden' });
    expect(again.json().dispute.active.lines).toHaveLength(2);
  });

  it('her durum değişikliği denetim izinde (kim, ne) ve Merkez etkinlik akışında', async () => {
    const logs = await inCompany(c.admin.auth, () => prisma.auditLog.findMany({ where: { entityId: inv.invoiceId, action: { startsWith: 'dispute.' } }, orderBy: { createdAt: 'asc' } }));
    expect(logs.map((l) => l.action)).toEqual(['dispute.send', 'dispute.recovered', 'dispute.rejected', 'dispute.recovered', 'dispute.revert', 'dispute.resend', 'dispute.withdraw', 'dispute.send']);
    expect(logs.every((l) => l.userId === c.admin.userId && l.entity === 'Invoice')).toBe(true);
    const feed = await app.inject({ method: 'GET', url: `${API}/platform/activity?pageSize=50`, headers: c.admin.auth });
    expect(feed.statusCode, feed.body).toBe(200);
    const actions = (feed.json().items as { action: string; href?: string }[]).map((i) => i.action);
    for (const label of ['itiraz gönderdi', 'alacak dekontu girdi', 'itirazın reddini girdi', 'itiraz sonucu girişini iptal etti', 'itirazı yeniden gönderdi', 'itirazı geri çekti']) {
      expect(actions).toContain(label);
    }
    const en = await app.inject({ method: 'GET', url: `${API}/platform/activity?pageSize=50`, headers: { ...c.admin.auth, 'accept-language': 'en' } });
    expect((en.json().items as { action: string }[]).map((i) => i.action)).toContain('recorded a credit note');
  });
});

describe('gönderimden sonra listeye eklenen satır görünür, yeniden gönderimle pakete girer', () => {
  type Byc = Sums & { currency: string; unsentAmount: number };
  type ListItem = { invoiceId: string; status: string; unsentLineCount: number; unsentAmount: number; sums: Sums };
  type List = { items: ListItem[]; summary: { counts: Record<string, number>; byCurrency: Byc[]; dueSoon: { invoiceId: string }[] } };

  it('kart, liste, sayaçlar, süresi yaklaşanlar; Pano "İtiraz listesinde" = geri alınan + eksik + reddedilen + bekleyen + gönderilmemiş', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60.55, 70.1, 80.99], { verify: 3 });
    const sent = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' });
    expect(sent.statusCode, sent.body).toBe(201);
    const r1 = (sent.json().dispute as InvoiceDispute).active!;
    expect((sent.json().dispute as InvoiceDispute).unsentLineCount).toBe(0);
    const [l1, l2] = r1.lines;
    const partial = Math.round((l1!.claimedAmount - 1.11) * 100) / 100;
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-9', lines: [{ disputeLineId: l1!.id, amount: partial }] })).statusCode).toBe(200);
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'kabul edilmedi', lines: [{ disputeLineId: l2!.id }] })).statusCode).toBe(200);

    // denetleyici gönderimden sonra listeye bir satır daha ekler
    const added = inv.lines[3]!;
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${added.id}`, { decision: 'VERIFIED' })).statusCode).toBe(200);

    const d = await detail(c.admin.auth, inv.invoiceId);
    expect([d.status, d.unsentLineCount, d.unsentAmount]).toEqual(['SENT', 1, added.diffAmount]);
    // yeniden gönderilse: reddedilen, bekleyen ve yeni satır
    expect(d.sendableLineCount).toBe(3);

    const list = (await call(c.admin.auth, 'GET', '/disputes')).json() as List;
    expect(list.summary.counts).toEqual({ UNSENT: 1, SENT: 1, CLOSED: 0, ALL: 1 });
    expect(list.items[0]).toMatchObject({ invoiceId: inv.invoiceId, status: 'SENT', unsentLineCount: 1, unsentAmount: added.diffAmount, sums: d.sums! });
    expect(list.summary.dueSoon.map((i) => i.invoiceId)).toEqual([inv.invoiceId]);
    const unsentOnly = (await call(c.admin.auth, 'GET', '/disputes?status=UNSENT')).json() as List;
    expect(unsentOnly.items.map((i) => i.invoiceId)).toEqual([inv.invoiceId]);
    const sentOnly = (await call(c.admin.auth, 'GET', '/disputes?status=SENT')).json() as List;
    expect(sentOnly.items.map((i) => i.invoiceId)).toEqual([inv.invoiceId]);

    const reconcile = async () => {
      const l = (await call(c.admin.auth, 'GET', '/disputes')).json() as List;
      const t = l.summary.byCurrency[0]!;
      const month = trDay(-3).slice(0, 7);
      const pano = (await call(c.admin.auth, 'GET', `/dashboard?month=${month}`)).json() as { verifiedTotal: number; recoveredTotal: number; disputePendingTotal: number };
      const parts = [t.recoveredAmount, t.shortfallAmount, t.rejectedAmount, t.pendingAmount, t.unsentAmount];
      expect(sumOf(parts)).toBe(pano.verifiedTotal);
      expect([pano.recoveredTotal, pano.disputePendingTotal]).toEqual([t.recoveredAmount, t.pendingAmount]);
      // fatura ayrıntısı aynı kuralla
      const x = await detail(c.admin.auth, inv.invoiceId);
      expect(sumOf([x.sums!.claimedAmount, x.unsentAmount])).toBe(pano.verifiedTotal);
      return t;
    };
    const before = await reconcile();
    expect(before.unsentAmount).toBe(added.diffAmount);

    // yeniden gönderme yeni satırı da içerir; geri alınan para fatura toplamında kalır
    const re = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), version: 3, sentOn: trDay(0), channel: 'EMAIL' });
    expect(re.statusCode, re.body).toBe(200);
    const d2 = re.json().dispute as InvoiceDispute;
    expect(d2.active!.lines.map((l) => l.invoiceLineId)).toEqual([inv.lines[1]!.id, inv.lines[2]!.id, added.id]);
    expect([d2.unsentLineCount, d2.unsentAmount]).toEqual([0, 0]);
    expect(d2.active!.sums.recoveredAmount).toBe(0);
    expect(d2.sums!.recoveredAmount).toBe(partial);
    const after = await reconcile();
    expect(after.unsentAmount).toBe(0);
    const list2 = (await call(c.admin.auth, 'GET', '/disputes')).json() as List;
    expect(list2.summary.counts).toEqual({ UNSENT: 0, SENT: 1, CLOSED: 0, ALL: 1 });
    expect(list2.summary.dueSoon).toEqual([]);
  });

  it('TTK: gönderimden sonra eklenip süre geçtikten sonra ilk kez gönderilen satır turu geç yapar', async () => {
    const c = await disputeCompany(app);
    // fatura 10 gün önce: TTK son günü 2 gün önceydi
    const inv = await invoiceWithDiffs(app, c, [70, 75], { invoiceDate: trDay(-10), verify: 1 });
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-3), channel: 'EMAIL' })).json().dispute.active as Round;
    expect(r1.ttk).toBe('ON_TIME');
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[1]!.id}`, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const item = ((await call(c.admin.auth, 'GET', '/disputes')).json() as { items: (ListItem & { ttkStatus: string; deadlines: { ttk: { expired: boolean } } })[] }).items[0]!;
    // gönderilen satırlar zamanındaydı; gönderilmemiş satırın süresi geçti (web süreyi gösterir, "zamanında" demez)
    expect([item.ttkStatus, item.unsentLineCount, item.deadlines.ttk.expired]).toEqual(['ON_TIME', 1, true]);
    const r2 = (await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), version: r1.version, sentOn: trDay(0), channel: 'EMAIL' })).json().dispute.active as Round;
    expect([r2.round, r2.lines.length, r2.ttk]).toEqual([2, 2, 'LATE']);
    // TTK'ya esas gün sonradan eklenen satırın ilk gönderimi (bugün): turu geç yapan o
    expect(r2.ttkSentOn).toBe(trDay(0));
    expect((await call(c.admin.auth, 'GET', '/disputes')).json().items[0].ttkStatus).toBe('LATE');
  });
});

describe('TTK: yeniden gönderme zincirinin ilk gönderimi esas', () => {
  it('süresinde gönderilip süre geçtikten sonra yeniden gönderilen zamanında; geri çekilip yeniden açılan geç', async () => {
    const c = await disputeCompany(app);
    // fatura 10 gün önce: TTK son günü 2 gün önceydi
    const inv = await invoiceWithDiffs(app, c, [70, 75], { invoiceDate: trDay(-10) });
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-3), channel: 'EMAIL' })).json().dispute.active as Round;
    expect(r1.ttk).toBe('ON_TIME');
    const resent = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), version: r1.version, sentOn: trDay(0), channel: 'PORTAL' });
    expect(resent.statusCode, resent.body).toBe(200);
    const r2 = resent.json().dispute.active as Round;
    expect([r2.round, r2.sentOn, r2.ttk]).toEqual([2, trDay(0), 'ON_TIME']);
    // KALANLAR 4a: "zamanında itiraz edildi" ilk gönderimin gününü yazar, son yeniden gönderimin değil
    expect(r2.ttkSentOn).toBe(trDay(-3));
    expect(r1.ttkSentOn).toBe(trDay(-3));
    const listed = (await call(c.admin.auth, 'GET', '/disputes')).json().items[0];
    expect([listed.round, listed.ttkStatus, listed.ttkSentOn]).toEqual([2, 'ON_TIME', trDay(-3)]);
    // geri çekilen tur zinciri bitirir: yeni gönderme kendi gününe göre
    await call(c.admin.auth, 'POST', `/disputes/${r2.id}/withdraw`, { version: r2.version, reason: 'yanlış' });
    const r3 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(0), channel: 'EMAIL' })).json().dispute.active as Round;
    expect([r3.round, r3.ttk, r3.ttkSentOn]).toEqual([3, 'LATE', trDay(0)]);
    expect((await call(c.admin.auth, 'GET', '/disputes')).json().items[0].ttkStatus).toBe('LATE');
  });
});

describe('izinler: muhasebe ve yönetici gönderir, denetleyici ve ölçüm göndermez, salt okunur abonelik yazamaz', () => {
  it('rol başına', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [55, 66]);
    const accounting = await issueIdentity({ companyId: c.admin.companyId, orgName: c.admin.orgName, role: 'ACCOUNTING', name: 'Mert Muhasebe' });
    const auditor = await issueIdentity({ companyId: c.admin.companyId, orgName: c.admin.orgName, role: 'AUDITOR', name: 'Deniz Denetleyici' });
    const body = { sentOn: trDay(0), channel: 'EMAIL' };

    for (const who of [auditor, c.worker]) {
      const r = await call(who.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, body);
      expect([r.statusCode, r.json().error.code]).toEqual([403, 'FORBIDDEN']);
    }
    expect((await call(c.worker.auth, 'GET', '/disputes')).statusCode).toBe(403);
    // denetleyici listeyi görür (fatura izni) ve hazırlar (karar), göndermez
    expect((await call(auditor.auth, 'GET', '/disputes')).statusCode).toBe(200);

    const readOnly = await c.admin.token({ status: 'READ_ONLY' });
    const ro = await call(readOnly.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, body);
    expect([ro.statusCode, ro.json().error.code]).toEqual([403, 'READ_ONLY']);
    expect((await call(readOnly.auth, 'GET', '/disputes')).statusCode).toBe(200);

    const sent = await call(accounting.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { ...body, selectionDigest: await digestOf(app, accounting.auth, inv.invoiceId) });
    expect(sent.statusCode, sent.body).toBe(201);
    const round = sent.json().dispute.active;
    expect(round.sentBy).toEqual({ id: accounting.userId, name: 'Mert Muhasebe' });
    const result = await call(accounting.auth, 'POST', `/disputes/${round.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'M-1', lines: [{ disputeLineId: round.lines[0].id, amount: 1.5 }] });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().dispute.active.results[0].enteredBy).toEqual({ id: accounting.userId, name: 'Mert Muhasebe' });
    const resultId = result.json().dispute.active.results[0].id;
    for (const [url, payload] of [
      [`/disputes/${round.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'x', lines: [{ disputeLineId: round.lines[1].id }] }],
      [`/dispute-results/${resultId}/revert`, { version: 2, reason: 'x' }],
      [`/disputes/${round.id}/withdraw`, { version: 2, reason: 'x' }],
      [`/disputes/${round.id}/resend`, { version: 2, sentOn: trDay(0), channel: 'EMAIL' }],
    ] as const) {
      const r = await call(auditor.auth, 'POST', url, payload);
      expect(r.statusCode, url).toBe(403);
      const ro2 = await call(readOnly.auth, 'POST', url, payload);
      expect(ro2.json().error.code, url).toBe('READ_ONLY');
    }
    // yönetici de girer; sürüm hâlâ 2 (reddedilen istekler değiştirmedi)
    expect((await call(c.admin.auth, 'POST', `/dispute-results/${resultId}/revert`, { version: 2, reason: 'düzeltme' })).statusCode).toBe(200);
  });
});

describe('firmalar arası: başka firmanın itirazı görünmez ve değişmez', () => {
  it('A jetonu, B kaydı → 404; B verisi aynı; listeler karışmaz', async () => {
    const a = await disputeCompany(app);
    const b = await disputeCompany(app);
    const invB = await invoiceWithDiffs(app, b, [70]);
    const sent = await call(b.admin.auth, 'POST', `/invoices/${invB.invoiceId}/disputes`, { selectionDigest: await digestOf(app, b.admin.auth, invB.invoiceId), sentOn: trDay(0), channel: 'EMAIL' });
    const roundB = sent.json().dispute.active;
    const res = await call(b.admin.auth, 'POST', `/disputes/${roundB.id}/results`, { version: 1, kind: 'REJECTED', resultOn: trDay(0), reason: 'x', lines: [{ disputeLineId: roundB.lines[0].id }] });
    const resultId = res.json().dispute.active.results[0].id;
    const before = await inCompany(b.admin.auth, async () => JSON.stringify([await prisma.dispute.findMany(), await prisma.disputeLine.findMany(), await prisma.disputeResult.findMany()]));

    const attempts: [string, unknown][] = [
      [`/invoices/${invB.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL' }],
      [`/disputes/${roundB.id}/resend`, { version: 2, sentOn: trDay(0), channel: 'EMAIL' }],
      [`/disputes/${roundB.id}/withdraw`, { version: 2, reason: 'x' }],
      [`/disputes/${roundB.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'x', lines: [{ disputeLineId: roundB.lines[0].id }] }],
      [`/dispute-results/${resultId}/revert`, { version: 2, reason: 'x' }],
    ];
    for (const [url, payload] of attempts) {
      const r = await call(a.admin.auth, 'POST', url, payload);
      expect(r.statusCode, url).toBe(404);
      expect(r.body).not.toContain(roundB.lines[0].id);
    }
    const list = (await call(a.admin.auth, 'GET', '/disputes')).json();
    expect(list.items).toEqual([]);
    expect(list.summary.counts).toEqual({ UNSENT: 0, SENT: 0, CLOSED: 0, ALL: 0 });
    expect((await call(a.admin.auth, 'GET', `/disputes?carrierId=${b.carrierId}`)).json().items).toEqual([]);
    const after = await inCompany(b.admin.auth, async () => JSON.stringify([await prisma.dispute.findMany(), await prisma.disputeLine.findMany(), await prisma.disputeResult.findMany()]));
    expect(after).toBe(before);
  });
});

describe('para birimi: ABD firması, USD fatura', () => {
  // Y9: USD firmadaki TRY fatura, tutar toleransı için USD→TRY kuru ister (fatura günü trDay(-3)). Eskiden sahte kur
  // servisi takılı değildi ve test gerçek TCMB'ye gidiyordu (2026-11-11 koşusundaki `08112026.xml` izi). 1 USD = 40,05 TRY.
  beforeAll(() => setFxService(anyDayFx({ USD: 40.05 })));
  afterAll(() => setFxService(null));

  it('tutarlar USD saklanır ve döner, TTK yok, Pano para birimlerini ayırır', async () => {
    const c = await disputeCompany(app, { country: 'US', currency: 'USD' });
    const inv = await invoiceWithDiffs(app, c, [50.25, 61]);
    const d0 = await detail(c.admin.auth, inv.invoiceId);
    const list0 = (await call(c.admin.auth, 'GET', '/disputes')).json();
    expect(list0.items[0].deadlines).toEqual({});
    expect(list0.summary.dueSoon).toEqual([]);
    const r = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(0), channel: 'EMAIL' });
    expect(r.statusCode, r.body).toBe(201);
    const round = r.json().dispute.active as Round;
    expect(round).toMatchObject({ currency: 'USD', ttk: null });
    expect(round.sums.claimedAmount).toBe(d0.sendableAmount);
    const stored = await inCompany(c.admin.auth, () => prisma.dispute.findFirstOrThrow({ where: { id: round.id } }));
    expect(stored.currency).toBe('USD');
    expect(Number(stored.claimedTotal)).toBe(d0.sendableAmount);
    const rec = await call(c.admin.auth, 'POST', `/disputes/${round.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'CN-77', lines: [{ disputeLineId: round.lines[0]!.id, amount: 10.1 }] });
    expect(rec.statusCode, rec.body).toBe(200);

    // aynı firmada TRY fatura (TRY tarifesiyle, kur çevrimi yok): her yerde ayrı para birimi, toplanmaz
    const tryTariff = await call(c.admin.auth, 'POST', '/tariffs', tariffPayload(c.carrierId, { currency: 'TRY', isDefault: false }));
    expect(tryTariff.statusCode, tryTariff.body).toBe(201);
    // KARARLAR "Tutar toleransı" (2026-11-10): tolerans firmanın para birimindedir (5 USD); TRY satırda kurla çevrilir
    // (sahte kurla 5 USD = 200,25 TL; Y18'den beri kur yoksa sabit yedek oran yok, satır "Kur alınamadı" olurdu).
    // "Fark var" senaryosu için tutar 800 TL (fark 767 TL, 5 USD'nin her makul kurdaki karşılığının çok üstünde).
    const invTry = await invoiceWithDiffs(app, c, [800], { currency: 'TRY', tariffId: tryTariff.json().tariff.id });
    const sentTry = await call(c.admin.auth, 'POST', `/invoices/${invTry.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, invTry.invoiceId), sentOn: trDay(0), channel: 'EMAIL' });
    expect(sentTry.statusCode, sentTry.body).toBe(201);
    const roundTry = sentTry.json().dispute.active as Round;
    expect(roundTry.currency).toBe('TRY');
    const recTry = await call(c.admin.auth, 'POST', `/disputes/${roundTry.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'TR-1', lines: [{ disputeLineId: roundTry.lines[0]!.id, amount: 7 }] });
    expect(recTry.statusCode, recTry.body).toBe(200);

    const list = (await call(c.admin.auth, 'GET', '/disputes')).json();
    expect(list.summary.byCurrency.map((x: { currency: string }) => x.currency)).toEqual(['USD', 'TRY']);
    expect(list.summary.byCurrency[0]).toMatchObject({ currency: 'USD', recoveredAmount: 10.1, pendingAmount: round.lines[1]!.claimedAmount, unsentAmount: 0 });
    expect(list.summary.byCurrency[1]).toMatchObject({ currency: 'TRY', recoveredAmount: 7, pendingAmount: 0, shortfallAmount: roundTry.lines[0]!.claimedAmount - 7 });

    const month = trDay(-3).slice(0, 7);
    const dash = (await call(c.admin.auth, 'GET', `/dashboard?month=${month}`)).json();
    expect(dash.currency).toBe('USD');
    expect(dash.recoveredTotal).toBe(10.1);
    expect(dash.disputePendingTotal).toBe(round.lines[1]!.claimedAmount);
    const byCur = Object.fromEntries((dash.byCurrency as { currency: string; recoveredTotal: number; disputePendingTotal: number }[]).map((x) => [x.currency, [x.recoveredTotal, x.disputePendingTotal]]));
    expect(byCur).toEqual({ USD: [10.1, round.lines[1]!.claimedAmount], TRY: [7, 0] });
  });
});

describe('eşzamanlı giriş', () => {
  it('aynı satıra aynı anda iki sonuç: biri geçer, diğeri STALE ya da LINE_NOT_PENDING; toplam talebi aşmaz', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [90]);
    const r = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(0), channel: 'EMAIL' });
    const round = r.json().dispute.active as Round;
    const line = round.lines[0]!;
    for (let attempt = 0; attempt < 3; attempt++) {
      const d = await detail(c.admin.auth, inv.invoiceId);
      if (attempt > 0) {
        // önceki denemenin sonucunu geri al: satır yeniden bekliyor
        const last = d.active!.results.find((x) => !x.revertedAt)!;
        expect((await call(c.admin.auth, 'POST', `/dispute-results/${last.id}/revert`, { version: d.active!.version, reason: 'yeni deneme' })).statusCode).toBe(200);
      }
      const v = (await detail(c.admin.auth, inv.invoiceId)).active!.version;
      const entry = (amount: number) => call(c.admin.auth, 'POST', `/disputes/${round.id}/results`, { version: v, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: `E${amount}`, lines: [{ disputeLineId: line.id, amount }] });
      const both = await Promise.all([entry(line.claimedAmount), entry(line.claimedAmount - 1)]);
      const statuses = both.map((x) => x.statusCode).sort();
      expect(statuses, both.map((x) => x.body).join('\n')).toEqual([200, 409]);
      expect(['STALE', 'LINE_NOT_PENDING']).toContain(both.find((x) => x.statusCode === 409)!.json().error.code);
      const live = await inCompany(c.admin.auth, () => prisma.disputeResult.count({ where: { disputeId: round.id, revertedAt: null } }));
      expect(live).toBe(1);
      const after = await detail(c.admin.auth, inv.invoiceId);
      expect(after.active!.sums.recoveredAmount).toBeLessThanOrEqual(after.active!.sums.claimedAmount);
      expect(after.active!.version).toBe(v + 1);
    }
  });

  it('aynı faturayı aynı anda iki kez gönderme: tek tur', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [44, 45]);
    const body = { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) };
    const both = await Promise.all([1, 2, 3].map(() => call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, body)));
    expect(both.map((x) => x.statusCode).sort()).toEqual([201, 409, 409]);
    expect(both.filter((x) => x.statusCode === 409).every((x) => x.json().error.code === 'DISPUTE_ACTIVE')).toBe(true);
    expect(await inCompany(c.admin.auth, () => prisma.dispute.count({ where: { invoiceId: inv.invoiceId } }))).toBe(1);
  });

  it('gönderme ile satır kararı yarışı: satır ya pakette ve kilitli ya da kayıt hiç yapılmaz (B3: küme özeti tutmaz)', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [44, 45]);
    // özet yarıştan önce alınır (kişi metni/kartı gördü, sonra işaretledi)
    const selectionDigest = await digestOf(app, c.admin.auth, inv.invoiceId);
    const [sent, patched] = await Promise.all([
      call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest, sentOn: trDay(0), channel: 'EMAIL' }),
      call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[0]!.id}`, { decision: 'OPEN' }),
    ]);
    if (sent.statusCode === 201) {
      // gönderme önce: kayıt görülen kümenin tamamı, satır kilitli
      expect((sent.json().dispute.active.lines as { invoiceLineId: string }[]).map((l) => l.invoiceLineId)).toEqual(inv.lines.map((l) => l.id));
      expect([patched.statusCode, patched.json().error?.code]).toEqual([409, 'LINE_IN_DISPUTE']);
    } else {
      // karar önce: görülen küme artık yok, kayıt yapılmaz (kişi metni yeniden alır)
      expect([sent.statusCode, sent.json().error?.code], sent.body).toEqual([409, 'SELECTION_CHANGED']);
      expect(patched.statusCode, patched.body).toBe(200);
      expect(await inCompany(c.admin.auth, () => prisma.dispute.count({ where: { invoiceId: inv.invoiceId } }))).toBe(0);
    }
  });
});
