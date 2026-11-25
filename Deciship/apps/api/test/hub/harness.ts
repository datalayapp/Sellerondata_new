/**
 * Merkez testlerinin kimlik düzeni: katalogda olmayan izin kümelerini de (para izni kapalı rapor okuyucu) denemek için
 * `x-test-auth` başlığındaki `req.auth` doğrudan isteğe yazılır, `guard` izne bakar. Firma bağlamı gerçektir (RLS):
 * uygulama kodu `sod_deciship` ile çalışır. Gerçek auth-kit ile uçlar test/permissionMatrix.test.ts içinde denenir.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type onRequestHookHandler } from 'fastify';
import multipart from '@fastify/multipart';
import { permissionsOf, type Permission } from '@sellerondata/contracts';
import { PrismaPg } from '@prisma/adapter-pg';
import { runInCompany, withCompany } from '../../src/db.ts';
import { registerErrorHandling } from '../../src/errors.ts';
import { registerLocale } from '../../src/i18n/index.ts';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { DEFAULT_BOX_PRESETS, DEFAULT_SETTINGS, LEGACY_EDGE_TOL_CM } from '../../src/lib/settings.ts';
import { stripMoney } from '../../src/app.ts';
import { dashboardRoutes } from '../../src/routes/dashboard.ts';
import { disputeRoutes } from '../../src/routes/disputes.ts';
import { invoiceRoutes } from '../../src/routes/invoices.ts';
import { hubRoutes } from '../../src/routes/platform.ts';
import { settingsRoutes } from '../../src/routes/settings.ts';
import { refreshTotals } from '../../src/services/compare.ts';
import type { HubGuard } from '../../src/services/hub/types.ts';
import { multipart as formData, SAMPLES } from '../helpers.ts';
import { testSuperDbUrl } from '../testEnv.ts';

/** Testin kendi tohumu ve doğrudan okuması: süper kullanıcı, RLS'yi atlar. Uygulama kodu bu istemciyi kullanmaz. */
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' }, { schema: 'deciship' }) });

export const ROLE = {
  ADMIN: [...permissionsOf('deciship', 'ADMIN')],
  AUDITOR: [...permissionsOf('deciship', 'AUDITOR')],
  ACCOUNTING: [...permissionsOf('deciship', 'ACCOUNTING')],
  MEASURE: [...permissionsOf('deciship', 'MEASURE')],
  /** Katalogda henüz yok; para izni kapalı rapor okuyucu: süzme kuralını kanıtlar. */
  NO_PRICES: permissionsOf('deciship', 'ACCOUNTING').filter((p) => p !== 'deciship.prices.view'),
  /** Çalışan adı görmeyen rapor okuyucu. */
  NO_PEOPLE: permissionsOf('deciship', 'ACCOUNTING').filter((p) => p !== 'deciship.measurements.view_all'),
} satisfies Record<string, Permission[]>;

export type Actor = { companyId: string; userId: string };

export function authHeader(actor: Actor, permissions: readonly string[], locale = 'tr') {
  const auth = { ...actor, permissions, name: 'Test', orgId: actor.companyId, membershipId: actor.userId };
  return { 'x-test-auth': Buffer.from(JSON.stringify(auth)).toString('base64'), 'accept-language': locale };
}

function readAuth(raw: unknown) {
  return JSON.parse(Buffer.from(String(raw), 'base64').toString()) as { permissions: string[]; companyId: string };
}

/** `stripMoney`: uygulamadaki son güvence (src/app.ts) de açılır. Varsayılan kapalı: Merkez kendi süzmesiyle sınanır. */
export async function buildHubApp(opts: { stripMoney?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandling(app);
  registerLocale(app);
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 20, fields: 20 } });
  app.decorateRequest('auth', null as never);
  const gate = (permission?: Permission): onRequestHookHandler =>
    function gateHook(req, reply, done) {
      const raw = req.headers['x-test-auth'];
      if (!raw) return void reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'no auth' } });
      const auth = readAuth(raw);
      (req as unknown as { auth: unknown }).auth = auth;
      if (permission && !auth.permissions.includes(permission)) return void reply.status(403).send({ error: { code: 'FORBIDDEN', message: permission } });
      runInCompany(auth.companyId, done);
    };
  app.decorate('authenticate', gate());
  app.decorate('requirePermission', (permission: Permission) => gate(permission));
  // gerçek uygulamadaki gibi: gövde okunduktan sonra firma bağlamı yeniden açılır (src/app.ts)
  app.addHook('preHandler', (req, _reply, done) => {
    const auth = (req as unknown as { auth?: { companyId: string } }).auth;
    if (auth) runInCompany(auth.companyId, done);
    else done();
  });
  if (opts.stripMoney) {
    app.addHook('preSerialization', async (req, _reply, payload) => {
      const auth = (req as unknown as { auth?: { permissions: string[] } }).auth;
      return auth && !auth.permissions.includes('deciship.prices.view') ? stripMoney(payload) : payload;
    });
  }
  const guard: HubGuard = (permission) => gate(permission);
  await app.register(
    async (api) => {
      await api.register(settingsRoutes);
      await api.register(invoiceRoutes);
      await api.register(disputeRoutes);
      await api.register(dashboardRoutes);
      await hubRoutes(api, { guard });
    },
    { prefix: '/api' },
  );
  await app.ready();
  return app;
}

export async function createMember(companyId: string, name: string, _username: string, role = 'ADMIN') {
  return prisma.member.create({ data: { id: crypto.randomUUID(), companyId, personId: crypto.randomUUID(), name, role } });
}

export async function createCompany(name: string, settings: Record<string, unknown> = {}): Promise<Actor & { name: string }> {
  const company = await prisma.company.create({ data: { id: crypto.randomUUID(), name, settings: { ...DEFAULT_SETTINGS, edgeTolCm: LEGACY_EDGE_TOL_CM, country: 'TR', ...settings } as never, boxPresets: { create: DEFAULT_BOX_PRESETS } } });
  const admin = await createMember(company.id, 'Ayşe Yönetici', 'admin');
  return { companyId: company.id, userId: admin.id, name };
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Örnek faturayı gerçek akışla (önizleme + içe aktarma) yükler. */
export async function importSample(app: FastifyInstance, actor: Actor, file: string, carrierId: string, meta: { invoiceNo: string; invoiceDate: string; currency?: string }) {
  const data = fs.readFileSync(path.join(SAMPLES, 'invoices', file));
  const form = formData([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: file, contentType: file.endsWith('.csv') ? 'text/csv' : XLSX_MIME, data },
  ]);
  const headers = authHeader(actor, ROLE.ADMIN);
  const preview = await app.inject({ method: 'POST', url: '/api/invoices/preview', headers: { ...headers, ...form.headers }, payload: form.payload });
  if (preview.statusCode !== 200) throw new Error(`preview ${preview.statusCode} ${preview.body}`);
  const p = preview.json();
  const res = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    headers,
    payload: { fileId: p.fileId, carrierId, invoiceNo: meta.invoiceNo, invoiceDate: meta.invoiceDate, currency: meta.currency ?? 'TRY', mapping: p.suggestedMapping, saveMapping: false },
  });
  if (res.statusCode !== 201) throw new Error(`import ${res.statusCode} ${res.body}`);
  return res.json().invoice as { id: string; totals: Record<string, number> };
}

export type LineSeed = {
  tracking?: string;
  status: 'MATCH' | 'DIFF' | 'UNMATCHED' | 'NO_TARIFF';
  net: number;
  expected?: number | null;
  diff?: number | null;
  diffTypes?: string[];
  decision?: 'OPEN' | 'VERIFIED' | 'ACCEPTED';
  low?: boolean;
  note?: string;
  service?: string;
  country?: string;
};

/** Karşılaştırmadan geçmiş fatura durumunu doğrudan yazar; toplamlar gerçek `refreshTotals` ile hesaplanır. */
export async function insertInvoice(actor: Actor, opts: { carrierId: string; invoiceNo: string; date: string; currency?: string; lines: LineSeed[]; isSample?: boolean }) {
  const file = await prisma.file.create({
    data: { companyId: actor.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: 'x', sha256: crypto.randomBytes(16).toString('hex'), createdById: actor.userId },
  });
  const invoice = await prisma.invoice.create({
    data: {
      companyId: actor.companyId,
      carrierId: opts.carrierId,
      invoiceNo: opts.invoiceNo,
      invoiceDate: new Date(`${opts.date}T00:00:00.000Z`),
      currency: opts.currency ?? 'TRY',
      sourceFileId: file.id,
      mapping: {},
      totals: {},
      isSample: opts.isSample ?? false,
    },
  });
  await prisma.invoiceLine.createMany({
    data: opts.lines.map((l, i) => ({
      invoiceId: invoice.id,
      companyId: actor.companyId,
      rowIndex: i + 1,
      trackingNo: l.tracking ?? `${opts.invoiceNo}X${i + 1}`,
      netAmount: l.net,
      expectedAmount: l.expected ?? null,
      diffAmount: l.diff ?? null,
      status: l.status,
      diffTypes: l.diffTypes ?? [],
      decision: l.decision ?? 'OPEN',
      decidedAt: l.decision && l.decision !== 'OPEN' ? new Date() : null,
      surcharges: [],
      breakdown: [],
      rawHash: crypto.randomBytes(8).toString('hex'),
      pricing: l.low ? { confidence: 'LOW', basis: 'INVOICE', rateDeviationPct: null, confidenceReason: 'test', zone: null, rateKg: null, mode: null, adjustmentPct: 0 } : undefined,
      note: l.note ?? null,
      service: l.service ?? null,
      destCountry: l.country ?? null,
    })),
  });
  await withCompany(actor.companyId, () => refreshTotals(invoice.id));
  return invoice;
}

export async function insertCarrier(companyId: string, code: string, name: string) {
  return prisma.carrier.create({ data: { companyId, code, name } });
}

/** Yanıttaki tüm anahtar ve değerleri gezer. */
export function walk(value: unknown, visit: (key: string, v: unknown) => void, key = '') {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, k);
  else visit(key, value);
}

/** Para izni olmayana gitmemesi gerekenler: `format: money`, `currency`, para sütunları, widget kimlikleri. */
export function moneyTraces(value: unknown): string[] {
  const found: string[] = [];
  walk(value, (k, v) => {
    if (k === 'format' && v === 'money') found.push('format:money');
    if (k === 'currency' && v !== 'currency') found.push(`currency=${String(v)}`);
  });
  return found;
}
