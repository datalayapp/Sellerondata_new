/**
 * İtiraz, taşıyıcıya gönderilenle aynı olsun (yeni denetim Mesaj 1; 10-B2, B3, B11, B12, B13, B14).
 *  - B2: itiraz metni ve kaydedilen tur aynı satır kümesinden: geri alınmış (RECOVERED) satır metne girmez.
 *  - B3: "Gönderildi olarak işaretle" metnin üretildiği andaki kümeyi taşır (`selectionDigest`); arada değiştiyse 409.
 *  - B13: tek satır kararında gördüğü karar (`expectedDecision`) tutmazsa 409 LINE_CHANGED.
 *  - B12: yerini yeniye bırakmış turdaki dekont girişi geri alınabilir; satır listeye döner, iki kez sayılmaz.
 *  - B11: metindeki "Ölçümümüz" ölçüsü silinmiş ölçümden basılmaz.
 *  - B14: satır listesi süzgeçteki karar bekleyen satır sayısını verir.
 */
import { disputeSums, effectiveDisputeLines, type DisputeLineOutcome } from '@deciship/core';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { disputeFacts, invoiceIdsScope, lineDisputeStates, sendableDigest } from '../src/services/disputes.ts';
import { lineDimensions } from '../src/services/hub/metrics.ts';
import { makePeriod } from '../src/services/hub/period.ts';
import { caller, cents, digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';
import { getApp, inCompany } from './helpers.ts';

type Sums = { claimedAmount: number; recoveredAmount: number; rejectedAmount: number; pendingAmount: number; shortfallAmount: number };
type Round = {
  id: string;
  round: number;
  version: number;
  supersededAt: string | null;
  lines: { id: string; invoiceLineId: string; claimedAmount: number; outcome: string }[];
  results: { id: string; kind: string; revertedAt: string | null }[];
};
type InvoiceDispute = {
  status: string;
  active: Round | null;
  history: Round[];
  sendableLineCount: number;
  sendableAmount: number;
  unsentLineCount: number;
  unsentAmount: number;
  selectionDigest: string | null;
  sums: Sums | null;
};
type DisputeText = { subject: string; body: string; lineCount: number; total: number; selectionDigest: string };

let app: FastifyInstance;
let call: ReturnType<typeof caller>;

beforeAll(async () => {
  app = await getApp();
  call = caller(app);
});

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + cents(b), 0) / 100;

const detail = async (auth: { authorization: string }, invoiceId: string) => {
  const r = await call(auth, 'GET', `/invoices/${invoiceId}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().invoice.dispute as InvoiceDispute;
};

const draft = async (auth: { authorization: string }, invoiceId: string) => {
  const r = await call(auth, 'GET', `/invoices/${invoiceId}/dispute`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as DisputeText;
};

/** Pano "İtiraz listesinde" = geri alınan + eksik + reddedilen + bekleyen + gönderilmemiş (aynı fatura kümesinde). */
async function reconcile(c: DisputeCompany, invoiceId: string) {
  const l = (await call(c.admin.auth, 'GET', '/disputes')).json() as { summary: { byCurrency: (Sums & { unsentAmount: number })[] } };
  const t = l.summary.byCurrency[0]!;
  const pano = (await call(c.admin.auth, 'GET', `/dashboard?month=${trDay(-3).slice(0, 7)}`)).json() as { verifiedTotal: number; recoveredTotal: number; disputePendingTotal: number };
  expect(sumOf([t.recoveredAmount, t.shortfallAmount, t.rejectedAmount, t.pendingAmount, t.unsentAmount])).toBe(pano.verifiedTotal);
  expect([pano.recoveredTotal, pano.disputePendingTotal]).toEqual([t.recoveredAmount, t.pendingAmount]);
  const x = await detail(c.admin.auth, invoiceId);
  expect(sumOf([x.sums?.claimedAmount ?? 0, x.unsentAmount])).toBe(pano.verifiedTotal);
  return t;
}

describe('B2: ikinci turda itiraz metni, geri alınmış satırı yeniden talep etmez', () => {
  it('metin, toplam ve kaydedilen tur aynı satırlardan; geri alınan satırın takip no’su metinde yok', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60.55, 70.1, 80.99], { verify: 3 });
    const sent = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' });
    expect(sent.statusCode, sent.body).toBe(201);
    const r1 = (sent.json().dispute as InvoiceDispute).active!;
    const [a, b] = r1.lines;
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-1', lines: [{ disputeLineId: a!.id, amount: a!.claimedAmount }] })).statusCode).toBe(200);
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'kabul edilmedi', lines: [{ disputeLineId: b!.id }] })).statusCode).toBe(200);
    // denetleyici bir satır daha ekler: kartta "Yeniden gönder"
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[3]!.id}`, { decision: 'VERIFIED' })).statusCode).toBe(200);

    const d = await detail(c.admin.auth, inv.invoiceId);
    const text = await draft(c.admin.auth, inv.invoiceId);
    expect([text.lineCount, text.total]).toEqual([d.sendableLineCount, d.sendableAmount]);
    expect(text.body).not.toContain(inv.lines[0]!.trackingNo);
    expect(text.total).toBe(sumOf(inv.lines.slice(1).map((l) => l.diffAmount)));

    const re = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { version: 3, sentOn: trDay(0), channel: 'EMAIL', selectionDigest: text.selectionDigest });
    expect(re.statusCode, re.body).toBe(200);
    const r2 = (re.json().dispute as InvoiceDispute).active!;
    // kaydedilen tur = metindeki satırlar, aynı toplam
    expect(r2.lines.map((l) => l.invoiceLineId)).toEqual(inv.lines.slice(1).map((l) => l.id));
    expect(sumOf(r2.lines.map((l) => l.claimedAmount))).toBe(text.total);
  });

  it('bütün liste satırları geri alındıysa metin üretilmez (400 NO_VERIFIED_LINES)', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [40]);
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' })).json().dispute.active as Round;
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-2', lines: [{ disputeLineId: r1.lines[0]!.id, amount: r1.lines[0]!.claimedAmount }] })).statusCode).toBe(200);
    const r = await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}/dispute`);
    expect([r.statusCode, r.json().error?.code]).toEqual([400, 'NO_VERIFIED_LINES']);
  });
});

describe('B3: işaretleme, metnin üretildiği andaki satır kümesini kaydeder', () => {
  it('metin ve fatura ayrıntısı aynı özeti verir; arada liste değiştiyse gönderim 409 SELECTION_CHANGED, hiçbir şey yazılmaz', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60, 70], { verify: 2 });
    const text = await draft(c.admin.auth, inv.invoiceId);
    expect(text.selectionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await detail(c.admin.auth, inv.invoiceId)).selectionDigest).toBe(text.selectionDigest);

    // metin kopyalandıktan sonra denetleyici bir satır daha ekler
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[2]!.id}`, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const stale = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: text.selectionDigest });
    expect([stale.statusCode, stale.json().error?.code]).toEqual([409, 'SELECTION_CHANGED']);
    expect(await inCompany(c.admin.auth, () => prisma.dispute.count({ where: { invoiceId: inv.invoiceId } }))).toBe(0);

    // bir satır "Uyumlu say"a çevrilse de özet değişir
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[0]!.id}`, { decision: 'ACCEPTED', reason: 'anlaşma' })).statusCode).toBe(200);
    const fresh = await draft(c.admin.auth, inv.invoiceId);
    expect(fresh.selectionDigest).not.toBe(text.selectionDigest);
    expect(fresh.lineCount).toBe(2);
    const ok = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: fresh.selectionDigest });
    expect(ok.statusCode, ok.body).toBe(201);
    const r1 = (ok.json().dispute as InvoiceDispute).active!;
    expect(r1.lines.map((l) => l.invoiceLineId)).toEqual([inv.lines[1]!.id, inv.lines[2]!.id]);
    expect(sumOf(r1.lines.map((l) => l.claimedAmount))).toBe(fresh.total);
  });

  it('yeniden gönderimde de: arada sonuç girildiyse (küme değişti) 409, güncel özetle geçer', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60, 70], { verify: 2 });
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' })).json().dispute.active as Round;
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[2]!.id}`, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const text = await draft(c.admin.auth, inv.invoiceId);
    expect(text.lineCount).toBe(3);
    // metin yollandıktan sonra muhasebe ilk satır için dekont girer: o satır yeni tura girmeyecek
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-3', lines: [{ disputeLineId: r1.lines[0]!.id, amount: 10 }] })).statusCode).toBe(200);
    const stale = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { version: 2, sentOn: trDay(0), channel: 'EMAIL', selectionDigest: text.selectionDigest });
    expect([stale.statusCode, stale.json().error?.code]).toEqual([409, 'SELECTION_CHANGED']);
    const still = await detail(c.admin.auth, inv.invoiceId);
    expect([still.active!.id, still.active!.version]).toEqual([r1.id, 2]);
    const fresh = await draft(c.admin.auth, inv.invoiceId);
    const ok = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { version: 2, sentOn: trDay(0), channel: 'EMAIL', selectionDigest: fresh.selectionDigest });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json().dispute as InvoiceDispute).active!.lines.map((l) => l.invoiceLineId)).toEqual([inv.lines[1]!.id, inv.lines[2]!.id]);
  });

  it('özet biçimsizse 400 VALIDATION', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50]);
    const r = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: 'x'.repeat(500) });
    expect([r.statusCode, r.json().error?.code]).toEqual([400, 'VALIDATION']);
  });
});

describe('B13: tek satır kararında yarış koruması', () => {
  it('eski ekrandaki karar (expectedDecision) tutmazsa 409 LINE_CHANGED ve satır listede kalır', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50], { verify: 0 });
    const line = inv.lines[0]!;
    // A kişisi listeye ekler
    const a = await call(c.admin.auth, 'PATCH', `/invoice-lines/${line.id}`, { decision: 'VERIFIED', expectedDecision: 'OPEN' });
    expect(a.statusCode, a.body).toBe(200);
    // ekranı yenilememiş B kişisi "Uyumlu say" der
    const b = await call(c.admin.auth, 'PATCH', `/invoice-lines/${line.id}`, { decision: 'ACCEPTED', reason: 'uyumlu', expectedDecision: 'OPEN' });
    expect([b.statusCode, b.json().error?.code]).toEqual([409, 'LINE_CHANGED']);
    const row = await inCompany(c.admin.auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { id: line.id }, select: { decision: true } }));
    expect(row.decision).toBe('VERIFIED');
    // güncel kararla geçer; denetim izinde çelişen iki karar yok
    const ok = await call(c.admin.auth, 'PATCH', `/invoice-lines/${line.id}`, { decision: 'ACCEPTED', reason: 'uyumlu', expectedDecision: 'VERIFIED' });
    expect(ok.statusCode, ok.body).toBe(200);
    const logs = await inCompany(c.admin.auth, () => prisma.auditLog.findMany({ where: { entityId: line.id, action: 'invoiceLine.decision' }, orderBy: { createdAt: 'asc' } }));
    expect(logs.map((l) => (l.data as { decision: string }).decision)).toEqual(['VERIFIED', 'ACCEPTED']);
  });

  it('karar dışı alan (not) beklenen kararla da yazılır; beklenen karar yanlışsa not da yazılmaz', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50], { verify: 1 });
    const line = inv.lines[0]!;
    const bad = await call(c.admin.auth, 'PATCH', `/invoice-lines/${line.id}`, { note: 'x', expectedDecision: 'OPEN' });
    expect([bad.statusCode, bad.json().error?.code]).toEqual([409, 'LINE_CHANGED']);
    const ok = await call(c.admin.auth, 'PATCH', `/invoice-lines/${line.id}`, { note: 'x', expectedDecision: 'VERIFIED' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().line.note).toBe('x');
  });
});

describe('B12: yeniden gönderimden sonra önceki turdaki yanlış dekont girişi geri alınır', () => {
  it('satır listeye döner (gönderilmemiş), iki kez sayılmaz; reddedilip yeniden gönderilen satırın girişi geri alınamaz', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60, 70]);
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' })).json().dispute.active as Round;
    const [a, b] = r1.lines;
    // yanlış: A için talebin tamamı dekont girildi (gerçekte 12,00)
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-X', lines: [{ disputeLineId: a!.id, amount: a!.claimedAmount }] })).statusCode).toBe(200);
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'kabul edilmedi', lines: [{ disputeLineId: b!.id }] })).statusCode).toBe(200);
    const re = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { version: 3, sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    expect(re.statusCode, re.body).toBe(200);
    const d0 = re.json().dispute as InvoiceDispute;
    const old = d0.history[0]!;
    expect(old.supersededAt).toEqual(expect.any(String));
    const recovered = old.results.find((x) => x.kind === 'RECOVERED')!;
    const rejected = old.results.find((x) => x.kind === 'REJECTED')!;

    // reddedilen satır yeni turda yeniden talep edildi: o giriş geri alınamaz
    const no = await call(c.admin.auth, 'POST', `/dispute-results/${rejected.id}/revert`, { version: old.version, reason: 'yanlış' });
    expect([no.statusCode, no.json().error?.code]).toEqual([409, 'RESULT_LINES_RESENT']);
    // eski sürümle 409 STALE
    const stale = await call(c.admin.auth, 'POST', `/dispute-results/${recovered.id}/revert`, { version: old.version - 1, reason: 'yanlış' });
    expect([stale.statusCode, stale.json().error?.code]).toEqual([409, 'STALE']);

    const r = await call(c.admin.auth, 'POST', `/dispute-results/${recovered.id}/revert`, { version: old.version, reason: 'Tutar yanlış girildi' });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().dispute as InvoiceDispute;
    // etkin tur aynı; A artık geri alınmış sayılmaz, listede gönderilmemiş satır olarak durur
    expect(d.active!.id).toBe(d0.active!.id);
    expect(d.sums!.recoveredAmount).toBe(0);
    expect([d.unsentLineCount, d.unsentAmount]).toEqual([1, a!.claimedAmount]);
    expect(d.history[0]!.results.find((x) => x.id === recovered.id)!.revertedAt).toEqual(expect.any(String));
    const lines = (await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}/lines`)).json().items as { id: string; dispute: unknown }[];
    expect(lines.find((l) => l.id === a!.invoiceLineId)!.dispute).toBeNull();
    const t = await reconcile(c, inv.invoiceId);
    expect(t.unsentAmount).toBe(a!.claimedAmount);
    await sameEffective(c, inv.invoiceId);

    // denetim izinde: kim, hangi tur, neden
    const log = await inCompany(c.admin.auth, () => prisma.auditLog.findFirstOrThrow({ where: { entityId: inv.invoiceId, action: 'dispute.revert' } }));
    expect(log.data).toMatchObject({ resultId: recovered.id, round: 1, superseded: true, reason: 'Tutar yanlış girildi' });

    // yeniden gönderimle A yeni tura girer, doğru tutar girilebilir
    const text = await draft(c.admin.auth, inv.invoiceId);
    const r3 = await call(c.admin.auth, 'POST', `/disputes/${d.active!.id}/resend`, { version: d.active!.version, sentOn: trDay(0), channel: 'EMAIL', selectionDigest: text.selectionDigest });
    expect(r3.statusCode, r3.body).toBe(200);
    const round3 = (r3.json().dispute as InvoiceDispute).active!;
    expect(round3.round).toBe(3);
    const lineA = round3.lines.find((l) => l.invoiceLineId === a!.invoiceLineId)!;
    expect((await call(c.admin.auth, 'POST', `/disputes/${round3.id}/results`, { version: round3.version, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-Y', lines: [{ disputeLineId: lineA.id, amount: 12 }] })).statusCode).toBe(200);
    expect((await detail(c.admin.auth, inv.invoiceId)).sums!.recoveredAmount).toBe(12);
    await reconcile(c, inv.invoiceId);
  });

  it('geri çekilmiş turdaki giriş geri alınamaz (409 STALE)', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60]);
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' })).json().dispute.active as Round;
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'REJECTED', resultOn: trDay(0), reason: 'x', lines: [{ disputeLineId: r1.lines[0]!.id }] })).statusCode).toBe(200);
    const w = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/withdraw`, { version: 2, reason: 'yanlış kanal' });
    expect(w.statusCode, w.body).toBe(200);
    const res = (w.json().dispute as InvoiceDispute).history[0]!.results[0]!;
    const r = await call(c.admin.auth, 'POST', `/dispute-results/${res.id}/revert`, { version: 3, reason: 'x' });
    expect([r.statusCode, r.json().error?.code]).toEqual([409, 'STALE']);
  });
});

describe('B11: metindeki ölçü silinmiş ölçümden basılmaz', () => {
  it('listedeki satırın ölçümü silinince "Ölçümümüz" ölçü ve ağırlığı yazmaz', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50]);
    const before = await draft(c.admin.auth, inv.invoiceId);
    expect(before.body).toContain('30×20×15');
    const { measurementId } = await inCompany(c.admin.auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { id: inv.lines[0]!.id }, select: { measurementId: true } }));
    const del = await app.inject({ method: 'DELETE', url: `/api/deciship/measurements/${measurementId}`, headers: c.admin.auth });
    expect(del.statusCode, del.body).toBe(204);
    const after = await draft(c.admin.auth, inv.invoiceId);
    expect(after.body).not.toContain('30×20×15');
  });
});

describe('B14: satır listesi, süzgeçteki karar bekleyen satırları sayar', () => {
  it('selectionEligible: kararı bekleyen, fark var, hesabı güncel, itirazda olmayan', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60, 70, 80], { verify: 1 });
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[1]!.id}`, { decision: 'ACCEPTED', reason: 'anlaşma' })).statusCode).toBe(200);
    const r = await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}/lines`);
    expect(r.statusCode, r.body).toBe(200);
    expect([r.json().total, r.json().selectionEligible]).toEqual([4, 2]);
  });
});

/**
 * "Geçerli satır" kuralının dört kopyası aynı sonucu verir: core `effectiveDisputeLines` (veritabanındaki ham satırlardan),
 * `disputeFacts` (Pano, fatura listesi, itirazlar listesi, fatura ayrıntısı), `lineDisputeStates` (satır tablosu) ve Merkez
 * `lineDimensions` (`hub/metrics.ts`).
 */
async function sameEffective(c: DisputeCompany, invoiceId: string) {
  const raw = await inCompany(c.admin.auth, () =>
    prisma.disputeLine.findMany({
      where: { dispute: { invoiceId } },
      include: { dispute: { select: { round: true, withdrawnAt: true, supersededAt: true } }, invoiceLine: { select: { decision: true, status: true } } },
    }),
  );
  const eff = effectiveDisputeLines(
    raw.map((l) => ({
      invoiceLineId: l.invoiceLineId,
      round: l.dispute.round,
      withdrawn: l.dispute.withdrawnAt != null,
      superseded: l.dispute.supersededAt != null,
      outcome: l.outcome as DisputeLineOutcome,
      listed: l.invoiceLine.decision === 'VERIFIED' && l.invoiceLine.status === 'DIFF',
      claimedAmount: Number(l.claimedAmount),
      recoveredAmount: l.recoveredAmount == null ? null : Number(l.recoveredAmount),
    })),
  );
  const core = disputeSums(eff);
  const facts = (await inCompany(c.admin.auth, () => disputeFacts(c.admin.companyId, invoiceIdsScope([invoiceId])))).get(invoiceId);
  expect(facts?.sums ?? null, 'disputeFacts').toEqual(eff.length ? core : null);
  expect(facts?.lines ?? 0).toBe(eff.length);
  const lineIds = [...new Set(raw.map((l) => l.invoiceLineId))];
  const states = await inCompany(c.admin.auth, () => lineDisputeStates(c.admin.companyId, lineIds));
  expect(Object.fromEntries([...states].map(([k, v]) => [k, v.outcome])), 'lineDisputeStates').toEqual(Object.fromEntries(eff.map((l) => [l.invoiceLineId, l.outcome])));
  const hub = await inCompany(c.admin.auth, () => lineDimensions(c.admin.companyId, makePeriod(trDay(-30), trDay(0))));
  expect([hub.total.recovered, hub.total.disputePending], 'Merkez').toEqual([core.recoveredAmount, core.pendingAmount]);
  return core;
}

describe('geçerli satır: dört kopya aynı, yeniden gönderilen tur geri çekilince hiçbir satır iki kez sayılmaz', () => {
  it('tur 1: A geri alındı, B reddedildi, C bekliyor → tur 2 (B, C) → tur 2 geri çekildi: A geri alınan, B reddedilen (K38), C gönderilmemiş', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60, 70]);
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' })).json().dispute.active as Round;
    const [a, b] = r1.lines;
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-W', lines: [{ disputeLineId: a!.id, amount: 20 }] })).statusCode).toBe(200);
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'red', lines: [{ disputeLineId: b!.id }] })).statusCode).toBe(200);
    await sameEffective(c, inv.invoiceId);
    const re = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { version: 3, sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    expect(re.statusCode, re.body).toBe(200);
    const r2 = (re.json().dispute as InvoiceDispute).active!;
    expect(r2.lines.map((l) => l.invoiceLineId)).toEqual([inv.lines[1]!.id, inv.lines[2]!.id]);
    await sameEffective(c, inv.invoiceId);
    await reconcile(c, inv.invoiceId);

    const w = await call(c.admin.auth, 'POST', `/disputes/${r2.id}/withdraw`, { version: r2.version, reason: 'yanlış kanal' });
    expect(w.statusCode, w.body).toBe(200);
    const d = w.json().dispute as InvoiceDispute;
    // K38: B tur 1'de reddedilmişti, yeniden talebi geri çekildi: taşıyıcının son cevabı red, reddedilen sayılır (gönderilmemiş
    // sayılmaz, iki kez sayılmaz). C'nin tur 1'de sonucu yoktu: gönderilmemiş.
    expect(d.sums).toEqual({
      claimedAmount: sumOf([a!.claimedAmount, b!.claimedAmount]),
      recoveredAmount: 20,
      rejectedAmount: b!.claimedAmount,
      pendingAmount: 0,
      shortfallAmount: (cents(a!.claimedAmount) - 2000) / 100,
    });
    expect([d.status, d.unsentLineCount, d.unsentAmount]).toEqual(['NONE', 1, r1.lines[2]!.claimedAmount]);
    // B yine yeniden talep edilebilir: gönderilecek kümede kalır
    expect(d.sendableLineCount).toBe(2);
    const core = await sameEffective(c, inv.invoiceId);
    expect(core.rejectedAmount).toBe(b!.claimedAmount);
    const lines = (await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}/lines`)).json().items as { id: string; dispute: { outcome: string } | null }[];
    expect(lines.map((l) => l.dispute?.outcome ?? null)).toEqual(['RECOVERED', 'REJECTED', null]);
    // İtirazlar özeti etkin turu olmayan faturanın geri alınan ve reddedilen talebini de sayar (Pano ile aynı)
    const t = await reconcile(c, inv.invoiceId);
    expect([t.recoveredAmount, t.rejectedAmount, t.pendingAmount, t.unsentAmount]).toEqual([20, b!.claimedAmount, 0, d.unsentAmount]);
    // itirazlar listesinde fatura "gönderilmedi" olarak C ile çıkar (B gönderilecek sayılmaz)
    const item = ((await call(c.admin.auth, 'GET', '/disputes')).json().items as { invoiceId: string; status: string; lineCount: number; unsentLineCount: number }[]).find((x) => x.invoiceId === inv.invoiceId)!;
    expect([item.status, item.lineCount, item.unsentLineCount]).toEqual(['UNSENT', 1, 1]);

    // reddi kabul edip B'yi listeden çıkarınca (etkin tur yok, satır kilitli değil) B itiraz toplamından da çıkar
    const acc = await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[1]!.id}`, { decision: 'ACCEPTED', reason: 'red kabul' });
    expect(acc.statusCode, acc.body).toBe(200);
    const dAcc = await detail(c.admin.auth, inv.invoiceId);
    expect([dAcc.sums?.rejectedAmount, dAcc.sendableLineCount, dAcc.unsentLineCount]).toEqual([0, 1, 1]);
    const coreAcc = await sameEffective(c, inv.invoiceId);
    expect(coreAcc.rejectedAmount).toBe(0);
    const tAcc = await reconcile(c, inv.invoiceId);
    expect([tAcc.recoveredAmount, tAcc.rejectedAmount]).toEqual([20, 0]);
    // geri alınır: B listeye döner, reddedilen yine sayılır
    const back = await call(c.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[1]!.id}`, { decision: 'VERIFIED' });
    expect(back.statusCode, back.body).toBe(200);
    expect((await detail(c.admin.auth, inv.invoiceId)).sums?.rejectedAmount).toBe(b!.claimedAmount);
    await sameEffective(c, inv.invoiceId);
    await reconcile(c, inv.invoiceId);

    // etkin tur yokken de tur 1'deki yanlış dekont geri alınır: A da listeye döner, faturada itiraz toplamı kalmaz
    const old = d.history.find((h) => h.round === 1)!;
    const rec = old.results.find((x) => x.kind === 'RECOVERED')!;
    const rv = await call(c.admin.auth, 'POST', `/dispute-results/${rec.id}/revert`, { version: old.version, reason: 'Tutar yanlış' });
    expect(rv.statusCode, rv.body).toBe(200);
    const d2 = rv.json().dispute as InvoiceDispute;
    // A listeye döner (gönderilmemiş); B reddedilen olarak kalır
    expect([d2.sums?.rejectedAmount, d2.sums?.recoveredAmount, d2.unsentLineCount]).toEqual([b!.claimedAmount, 0, 2]);
    await sameEffective(c, inv.invoiceId);
    await reconcile(c, inv.invoiceId);
  });

  it('B12 senaryosunda da dört kopya aynı (önceki turdaki giriş geri alındı, satır yeni tura girdi)', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60]);
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' })).json().dispute.active as Round;
    const [a, b] = r1.lines;
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-1', lines: [{ disputeLineId: a!.id, amount: a!.claimedAmount }] })).statusCode).toBe(200);
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 2, kind: 'REJECTED', resultOn: trDay(0), reason: 'red', lines: [{ disputeLineId: b!.id }] })).statusCode).toBe(200);
    const re = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { version: 3, sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    const old = (re.json().dispute as InvoiceDispute).history[0]!;
    const rv = await call(c.admin.auth, 'POST', `/dispute-results/${old.results.find((x) => x.kind === 'RECOVERED')!.id}/revert`, { version: old.version, reason: 'yanlış' });
    expect(rv.statusCode, rv.body).toBe(200);
    await sameEffective(c, inv.invoiceId);
    // aynı giriş iki kez geri alınamaz
    const twice = await call(c.admin.auth, 'POST', `/dispute-results/${old.results.find((x) => x.kind === 'RECOVERED')!.id}/revert`, { version: old.version + 1, reason: 'yanlış' });
    expect([twice.statusCode, twice.json().error?.code]).toEqual([409, 'STALE']);
  });
});

describe('B3: seçim özeti', () => {
  const line = (id: string, claim: number, trackingNo = 'T1', currency = 'TRY') => ({ id, trackingNo, claim, currency });

  it('sıradan bağımsız; talep (kuruş), takip no ve para birimi özeti değiştirir', () => {
    const base = sendableDigest([line('a', 10.1), line('b', 20)]);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(sendableDigest([line('b', 20), line('a', 10.1)])).toBe(base);
    expect(sendableDigest([line('a', 10.11), line('b', 20)])).not.toBe(base);
    expect(sendableDigest([line('a', 10.1, 'T2'), line('b', 20)])).not.toBe(base);
    expect(sendableDigest([line('a', 10.1, 'T1', 'USD'), line('b', 20, 'T1', 'USD')])).not.toBe(base);
    expect(sendableDigest([line('a', 10.1, 'T1', 'try'), line('b', 20, 'T1', 'try')])).toBe(base);
    expect(sendableDigest([line('a', 10.1)])).not.toBe(base);
  });

  it('özet anahtarlıdır: satır kimliği, takip no ve aday tutarla düz SHA-256 aynı özeti vermez (fiyat izni olmayana tutar sızmaz)', async () => {
    const { createHash } = await import('node:crypto');
    const plain = createHash('sha256').update(['a', 'T1', 1010, 'TRY'].join('|')).digest('hex');
    expect(sendableDigest([line('a', 10.1)])).not.toBe(plain);
  });

  it('özet zorunlu: göndermede ve yeniden göndermede özetsiz istek 400 VALIDATION, hiçbir şey yazılmaz', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60]);
    const r = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL' });
    expect([r.statusCode, r.json().error?.code, r.json().error?.details?.[0]?.path]).toEqual([400, 'VALIDATION', 'selectionDigest']);
    expect(await inCompany(c.admin.auth, () => prisma.dispute.count({ where: { invoiceId: inv.invoiceId } }))).toBe(0);
    const r1 = (await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId), sentOn: trDay(-1), channel: 'EMAIL' })).json().dispute.active as Round;
    expect((await call(c.admin.auth, 'POST', `/disputes/${r1.id}/results`, { version: 1, kind: 'REJECTED', resultOn: trDay(0), reason: 'red', lines: [{ disputeLineId: r1.lines[0]!.id }] })).statusCode).toBe(200);
    const re = await call(c.admin.auth, 'POST', `/disputes/${r1.id}/resend`, { version: 2, sentOn: trDay(0), channel: 'EMAIL' });
    expect([re.statusCode, re.json().error?.code]).toEqual([400, 'VALIDATION']);
    expect(await inCompany(c.admin.auth, () => prisma.dispute.count({ where: { invoiceId: inv.invoiceId } }))).toBe(1);
  });

  it('metin alındıktan sonra faturanın para birimi düzeltildiyse (kararlı satırın rakamı aynı kalır) işaretleme 409', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50]);
    const text = await draft(c.admin.auth, inv.invoiceId);
    await inCompany(c.admin.auth, () => prisma.invoice.update({ where: { id: inv.invoiceId }, data: { currency: 'EUR' } }));
    const fresh = await draft(c.admin.auth, inv.invoiceId);
    expect([fresh.total, fresh.lineCount]).toEqual([text.total, text.lineCount]);
    expect(fresh.selectionDigest).not.toBe(text.selectionDigest);
    const stale = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: text.selectionDigest });
    expect([stale.statusCode, stale.json().error?.code]).toEqual([409, 'SELECTION_CHANGED']);
    const ok = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: fresh.selectionDigest });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().dispute.active.currency).toBe('EUR');
  });
});
