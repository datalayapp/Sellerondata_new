import { turkeyDate } from '@deciship/core';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { prisma } from '../src/db.ts';
import { tariffPayload } from './fixtures.ts';
import { createWorker, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

export const API = '/api/deciship';
type Auth = { authorization: string };

/** Türkiye'de bugünden `days` gün sonra (eksi: önce), YYYY-MM-DD. */
export function trDay(days = 0, now = new Date()): string {
  return new Date(Date.parse(`${turkeyDate(now)}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function caller(app: FastifyInstance) {
  return (auth: Auth, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `${API}${url}`, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
}

/** Ülkesi ve para birimi verilen firma: taşıyıcı, aynı para biriminde tarife, ölçüm çalışanı. */
export async function disputeCompany(app: FastifyInstance, opts: { country?: string; currency?: string } = {}) {
  const country = opts.country ?? 'TR';
  const currency = opts.currency ?? 'TRY';
  const admin = await registerCompany(app, uniq('İtiraz '));
  await inCompany(admin.auth, async () => {
    const c = await prisma.company.findFirstOrThrow({ where: { id: admin.companyId } });
    await prisma.company.update({ where: { id: c.id }, data: { settings: { ...(c.settings as object), country, currency } } });
  });
  const worker = await createWorker(app, admin.auth);
  const carrier = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
  expect(carrier.statusCode, carrier.body).toBe(201);
  const carrierId = carrier.json().carrier.id as string;
  const tariff = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffPayload(carrierId, { currency }) });
  expect(tariff.statusCode, tariff.body).toBe(201);
  return { admin, worker, carrierId, currency, country };
}

export type DisputeCompany = Awaited<ReturnType<typeof disputeCompany>>;

export type LineRow = { id: string; rowIndex: number; trackingNo: string; diffAmount: number; netAmount: number; status: string; decision: string; dispute: unknown };

/**
 * Her tutar için ölçülmüş bir satır (30×20×15 cm, 2 kg = 3 desi) ve faturada 5 desi: hepsi "Fark var". Satırlar
 * `verify` kadarı "İtiraz listesinde"ye alınır (varsayılan hepsi).
 */
export async function invoiceWithDiffs(
  app: FastifyInstance,
  c: DisputeCompany,
  amounts: number[],
  opts: { invoiceDate?: string; verify?: number; currency?: string; tariffId?: string } = {},
) {
  const tracking: string[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const p = measurementPayload({ trackingRaw: uniq('7948'), lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    tracking.push(m.json().measurement.trackingNo);
  }
  const csv = ['Takip No;Desi;Tutar', ...amounts.map((a, i) => `${tracking[i]};5;${String(a).replace('.', ',')}`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: c.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...c.admin.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: c.admin.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId: c.carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: opts.invoiceDate ?? trDay(-3),
      currency: opts.currency ?? c.currency,
      ...(opts.tariffId ? { tariffId: opts.tariffId } : {}),
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  const invoiceId = inv.json().invoice.id as string;
  const lines = (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines`, headers: c.admin.auth })).json().items as LineRow[];
  expect(lines.map((l) => l.status)).toEqual(amounts.map(() => 'DIFF'));
  const verify = opts.verify ?? amounts.length;
  for (const l of lines.slice(0, verify)) {
    const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l.id}`, headers: c.admin.auth, payload: { decision: 'VERIFIED' } });
    expect(r.statusCode, r.body).toBe(200);
  }
  return { invoiceId, invoiceNo: inv.json().invoice.invoiceNo as string, lines };
}

export const cents = (n: number) => Math.round(n * 100);

/**
 * B3: gönderme ve yeniden gönderme `selectionDigest` ister (zorunlu): faturanın bugünkü gönderilecek kümesinin özeti, fatura
 * ayrıntısından (`GET /invoices/:id` → `invoice.dispute.selectionDigest`; web metinden ya da karttan aynısını alır).
 * Gönderilecek satır yoksa biçimce geçerli ama hiçbir kümeye uymayan bir özet döner (400 NO_SENDABLE_LINES beklenen testler).
 * `prefix` uygulamanın API öneki (Merkez testleri `/api` ile kurar).
 */
export async function digestOf(app: FastifyInstance, auth: Auth | Record<string, string>, invoiceId: string, prefix = API): Promise<string> {
  const r = await app.inject({ method: 'GET', url: `${prefix}/invoices/${invoiceId}`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().invoice.dispute?.selectionDigest as string | null) ?? '0'.repeat(64);
}
