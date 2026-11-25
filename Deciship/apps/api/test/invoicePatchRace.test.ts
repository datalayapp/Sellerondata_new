/**
 * Mesaj 4: `PATCH /invoices/:id` başlık düzeltmesi ile ardından gelen yeniden hesap tek işlemdir.
 *
 * Eskiden başlık bir işlemde yazılıyor, yeniden hesap (`applyRecompare`) ayrı bir işlemde koşuyordu. Arada itiraz
 * gönderilirse hesap 409 INVOICE_HAS_DISPUTE ile reddediliyor ama başlık (taşıyıcı / tarife) yazılmış kalıyordu: fatura
 * yeni tarifeyi gösterir, satırlar eski tarifeyle hesaplı ve dayanak boşta.
 *
 * Yarış elle kurulur: istek önizlemenin `token`'ıyla gelir, hesap kilitsiz yapılır (itiraz ön denetimi geçilir), yazma
 * fatura kilidini bekler. Dışarıdaki bağlantı fatura satırını kilitli tutar; istek orada beklerken aynı işlemde etkin bir
 * itiraz turu ekler ve kapanır. Doğru davranış: istek fatura kilidi altında itirazı görür, hiçbir şey yazılmaz.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { applyRecompare } from '../src/services/compare.ts';
import { tariffPayload } from './fixtures.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { previewRecalc, type RecalcPreview } from './recalcHelpers.ts';
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

/** Ölçülmüş iki satırlı fatura (3 desi ölçüldü, 5 desi faturalandı) ve aynı taşıyıcıda ikinci, ucuz bir tarife. */
async function setup(app: FastifyInstance) {
  const admin = await registerCompany(app, uniq('Başlık '));
  const worker = await createWorker(app, admin.auth);
  const carrier = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
  const carrierId = carrier.json().carrier.id as string;
  const t1 = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffPayload(carrierId) });
  expect(t1.statusCode, t1.body).toBe(201);
  const t2 = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: { ...tariffPayload(carrierId), name: 'İkinci', isDefault: false, discountPct: 50 } });
  expect(t2.statusCode, t2.body).toBe(201);

  const tracking: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = measurementPayload({ lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    tracking.push(m.json().measurement.trackingNo);
  }
  const csv = ['Takip No;Desi;Tutar', ...tracking.map((t) => `${t};5;50`)].join('\n');
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
  return { admin, invoiceId: inv.json().invoice.id as string, carrierId, tariff1: t1.json().tariff.id as string, tariff2: t2.json().tariff.id as string };
}

/** Faturanın ve satırlarının veritabanındaki hâli ("hiçbir şey yazılmadı" karşılaştırması). */
const dbState = (auth: Auth, invoiceId: string) =>
  inCompany(auth, async () =>
    JSON.stringify({
      invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }),
      lines: await prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } }),
    }),
  );
const updateLogs = (auth: Auth, invoiceId: string) =>
  inCompany(auth, () => prisma.auditLog.findMany({ where: { entityId: invoiceId, action: { in: ['invoice.update', 'invoice.recalculate'] } } }));

/** İtiraz gönderiminin bıraktığı etkin tur (yalnız tur yeter: kilit `activeRoundWhere` ile bakar). */
async function insertActiveRound(companyId: string, invoiceId: string) {
  const member = await outside.query(`SELECT "id" FROM "Member" WHERE "companyId" = $1 ORDER BY "createdAt" LIMIT 1`, [companyId]);
  await outside.query(
    `INSERT INTO "Dispute" ("id", "companyId", "invoiceId", "round", "sentOn", "channel", "sentById", "currency", "claimedTotal", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, 1, date_trunc('day', now() AT TIME ZONE 'UTC'), 'EMAIL', $3, 'TRY', 40, now() AT TIME ZONE 'UTC')`,
    [companyId, invoiceId, member.rows[0].id],
  );
}

describe('PATCH /invoices/:id: başlık ve yeniden hesap birlikte yazılır ya da hiç', () => {
  it('hesap sürerken itiraz gönderilirse 409 INVOICE_HAS_DISPUTE; tarife, dayanak, satırlar ve denetim kaydı yerinde', async () => {
    const app = await getApp();
    const s = await setup(app);
    const auth = s.admin.auth;
    const p = await previewRecalc(app, auth, s.invoiceId, { basis: 'pinned', patch: { tariffId: s.tariff2 } });
    expect(p.statusCode, p.body).toBe(200);
    const token = (p.json() as RecalcPreview).token;
    const before = await dbState(auth, s.invoiceId);

    await outside.query('BEGIN');
    await outside.query(`SELECT "id" FROM "Invoice" WHERE "id" = $1 FOR UPDATE`, [s.invoiceId]);
    const pending = app.inject({ method: 'PATCH', url: `${API}/invoices/${s.invoiceId}`, headers: auth, payload: { tariffId: s.tariff2, token } });
    await untilSomeoneWaitsForLock();
    await insertActiveRound(s.admin.companyId, s.invoiceId);
    await outside.query('COMMIT');

    const r = await pending;
    expect([r.statusCode, r.json().error?.code], r.body).toEqual([409, 'INVOICE_HAS_DISPUTE']);
    expect(r.json().error.message).toContain('itiraz geri çekilene dek değişmez');
    expect(await dbState(auth, s.invoiceId)).toBe(before);
    const row = await inCompany(auth, () => prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } }));
    expect(row.tariffId).toBe(s.tariff1);
    expect(await updateLogs(auth, s.invoiceId)).toHaveLength(0);
  });

  it('itirazsız aynı akış: başlık, yeni dayanak ve satırlar birlikte yazılır; tek denetim kaydı çifti', async () => {
    const app = await getApp();
    const s = await setup(app);
    const auth = s.admin.auth;
    const p = await previewRecalc(app, auth, s.invoiceId, { basis: 'pinned', patch: { tariffId: s.tariff2 } });
    const r = await app.inject({ method: 'PATCH', url: `${API}/invoices/${s.invoiceId}`, headers: auth, payload: { tariffId: s.tariff2, invoiceNo: uniq('YENI'), token: (p.json() as RecalcPreview).token } });
    expect(r.statusCode, r.body).toBe(200);
    const stored = await inCompany(auth, async () => ({
      inv: await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } }),
      tariff: await prisma.tariff.findUniqueOrThrow({ where: { id: s.tariff2 } }),
      lines: await prisma.invoiceLine.findMany({ where: { invoiceId: s.invoiceId } }),
    }));
    expect([stored.inv.tariffId, stored.inv.tariffRevisionId]).toEqual([s.tariff2, stored.tariff.currentRevisionId]);
    expect(stored.lines.map((l) => [l.tariffId, l.tariffRevisionId])).toEqual(stored.lines.map(() => [s.tariff2, stored.tariff.currentRevisionId]));
    const logs = await updateLogs(auth, s.invoiceId);
    expect(logs.map((l) => l.action).sort()).toEqual(['invoice.recalculate', 'invoice.update']);
    expect(logs.find((l) => l.action === 'invoice.update')!.data).toMatchObject({ recompared: true, changes: { tariffId: { to: s.tariff2 } } });
  });

  it('motor: onWrite hata verirse patch, dayanak ve satırlar geri alınır (tek işlem)', async () => {
    const app = await getApp();
    const s = await setup(app);
    const before = await dbState(s.admin.auth, s.invoiceId);
    const boom = new Error('denetim kaydı yazılamadı');
    await expect(
      inCompany(s.admin.auth, () =>
        applyRecompare(s.invoiceId, {
          basis: 'pinned',
          scope: 'all',
          patch: { tariffId: s.tariff2 },
          onWrite: async (tx) => {
            await tx.invoice.update({ where: { id: s.invoiceId }, data: { invoiceNo: uniq('YARIM') } });
            throw boom;
          },
        }),
      ),
    ).rejects.toBe(boom);
    expect(await dbState(s.admin.auth, s.invoiceId)).toBe(before);
  });
});
