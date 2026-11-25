/**
 * 05-B2: fatura toplamı aynı faturadaki eşzamanlı işlemlerde satırlarla tutmalı.
 *
 * Yarış kendiliğinden nadiren denk gelir; burada elle kurulur. Dışarıdaki bir bağlantı, satır kararını kilit altında
 * yazan istekle (PATCH karar) aynı biçimde faturayı kilitler, başka bir satırın kararını değiştirir ve işlemi açık tutar.
 * Bu sırada uygulamaya ikinci bir iş verilir (başka satırda not, ölçüm düzeltmesinin arka plan karşılaştırması). İkinci
 * iş kilitte beklemeye başlayınca dış işlem kapanır. Kilitsiz toplam hesabı satırları beklemeden önce okuduğu için eski
 * toplamı yazar; doğru olanı kilidi aldıktan sonra okur.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { computeTotals, type InvoiceTotals } from '../src/services/compare.ts';
import { tariffPayload } from './fixtures.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq, type Identity } from './helpers.ts';
import { TEST_DB_NAME, testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

let outside: pg.Client;
let watcher: pg.Client;

beforeAll(async () => {
  outside = new pg.Client({ connectionString: testSuperDbUrl() });
  watcher = new pg.Client({ connectionString: testSuperDbUrl() });
  await outside.connect();
  await watcher.connect();
  await outside.query('SET search_path = deciship');
});

afterAll(async () => {
  await outside.query('ROLLBACK').catch(() => undefined);
  await outside.end();
  await watcher.end();
});

/** Uygulamanın bir bağlantısı bu veritabanında kilit beklemeye başlayana dek bekler. */
async function untilSomeoneWaitsForLock(timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await watcher.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> $2`,
      [TEST_DB_NAME, (outside as unknown as { processID: number }).processID],
    );
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('istek kilitte beklemeye hiç girmedi');
}

/** PATCH karar ile aynı sıra: önce fatura kilidi, sonra satır. İşlem açık kalır; `commit` ile kapanır. */
async function decideWhileHoldingInvoice(invoiceId: string, lineId: string, decision: 'VERIFIED' | 'ACCEPTED') {
  await outside.query('BEGIN');
  await outside.query(`SELECT "id" FROM "Invoice" WHERE "id" = $1 FOR UPDATE`, [invoiceId]);
  await outside.query(
    `UPDATE "InvoiceLine" SET "decision" = $2, "decisionReason" = 'dış', "decidedAt" = now() AT TIME ZONE 'UTC', "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = $1`,
    [lineId, decision],
  );
  return { commit: () => outside.query('COMMIT') };
}

/** İki ölçülmüş satır, ikisi de fazla kesilmiş (3 desi ölçüldü, 5 desi faturalandı). */
async function invoiceWithTwoDiffLines(app: FastifyInstance) {
  const admin = await registerCompany(app, uniq('Yarış '));
  const worker = await createWorker(app, admin.auth);
  const carrier = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: 'Aras' } });
  const carrierId = carrier.json().carrier.id as string;
  const tariff = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffPayload(carrierId) });
  expect(tariff.statusCode, tariff.body).toBe(201);

  const measurements: { id: string; trackingNo: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const p = measurementPayload({ lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    measurements.push(m.json().measurement);
  }
  const csv = ['Takip No;Desi;Tutar', ...measurements.map((m) => `${m.trackingNo};5;50`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: admin.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  const invoiceId = inv.json().invoice.id as string;
  const lines = (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines`, headers: admin.auth })).json().items as {
    id: string;
    status: string;
    trackingNo: string;
  }[];
  expect(lines.map((l) => l.status)).toEqual(['DIFF', 'DIFF']);
  return { admin, worker: worker as Identity, invoiceId, lines, measurements };
}

/** Yazılı toplam ile satırlardan şimdi hesaplanan toplam. */
async function storedAndActual(auth: Auth, invoiceId: string) {
  return inCompany(auth, async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { id: invoiceId }, select: { totals: true } });
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
    return { stored: inv.totals as InvoiceTotals, actual: computeTotals(lines) };
  });
}

describe('05-B2: fatura toplamı eşzamanlı işlemlerde satırlarla tutar', () => {
  it('bir satıra karar verilirken başka satıra not yazılırsa toplam kararı kaybetmez', async () => {
    const app = await getApp();
    const { admin, invoiceId, lines } = await invoiceWithTwoDiffLines(app);
    const [first, second] = lines;

    const held = await decideWhileHoldingInvoice(invoiceId, second!.id, 'VERIFIED');
    const note = app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${first!.id}`, headers: admin.auth, payload: { note: 'kargo ile görüşüldü' } });
    await untilSomeoneWaitsForLock();
    await held.commit();
    const r = await note;
    expect(r.statusCode, r.body).toBe(200);

    const { stored, actual } = await storedAndActual(admin.auth, invoiceId);
    expect(actual.verifiedTotal).toBeGreaterThan(0);
    expect(stored).toEqual(actual);
    // yanıttaki toplam da güncel
    expect(r.json().totals).toEqual(actual);
  });

  it('ölçüm düzeltmesinin arka plan karşılaştırması ile kullanıcı kararı çakışınca toplam ikisini de içerir', async () => {
    const app = await getApp();
    const { admin, worker, invoiceId, lines, measurements } = await invoiceWithTwoDiffLines(app);
    const [, second] = lines;
    const before = await storedAndActual(admin.auth, invoiceId);

    const held = await decideWhileHoldingInvoice(invoiceId, second!.id, 'ACCEPTED');
    // Birinci satırın ölçümü düzeltilir: 40×30×25 / 3000 = 10 desi, faturadaki 5 desiden büyük → satırın sonucu değişir.
    const fix = app.inject({
      method: 'PATCH',
      url: `${API}/measurements/${measurements[0]!.id}`,
      headers: worker.auth,
      payload: { lengthCm: 40, widthCm: 30, heightCm: 25 },
    });
    await untilSomeoneWaitsForLock();
    await held.commit();
    const r = await fix;
    expect(r.statusCode, r.body).toBe(200);

    const { stored, actual } = await storedAndActual(admin.auth, invoiceId);
    expect(actual.acceptedLines).toBe(1);
    // düzeltme de işlendi: birinci satırın fazla ödemesi artık toplamda yok
    expect(actual.overchargeTotal).not.toBe(before.actual.overchargeTotal);
    expect(stored).toEqual(actual);
  });

  it('aynı faturada birçok karar aynı anda gelince yazılı toplam satırlarla tutar', async () => {
    const app = await getApp();
    const { admin, invoiceId, lines } = await invoiceWithTwoDiffLines(app);
    for (const decision of ['VERIFIED', 'ACCEPTED', 'OPEN', 'VERIFIED'] as const) {
      const replies = await Promise.all(
        lines.flatMap((l) => [
          app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l.id}`, headers: admin.auth, payload: { decision, reason: 'toplu' } }),
          app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l.id}`, headers: admin.auth, payload: { note: uniq('not ') } }),
        ]),
      );
      for (const r of replies) expect(r.statusCode, r.body).toBe(200);
      const { stored, actual } = await storedAndActual(admin.auth, invoiceId);
      expect(stored, decision).toEqual(actual);
    }
  });
});
