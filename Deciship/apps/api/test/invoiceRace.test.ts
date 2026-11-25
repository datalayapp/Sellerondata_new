import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma, Prisma } from '../src/db.ts';
import { schemaProblems } from '../src/lib/schemaCheck.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { dbSetupSection } from './globalSetup.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';
import { SUPER_URL, TEST_ADMIN_URL, TEST_DB_NAME } from './testEnv.ts';

type Auth = { authorization: string };
const API = '/api/deciship';
const API_ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(API_ROOT, 'prisma', 'migrations');
const MIGRATION = 'invoice_current_no';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-race-'));
afterAll(() => {
  setFxService(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fetcher: FxFetcher = async (url) => {
  if (url !== tcmbUrl('2026-10-15')) return { status: 404, text: '' };
  return {
    status: 200,
    text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>',
  };
};
const NOW = () => new Date('2026-11-04T12:00:00Z');

/** İki istek de mükerrer denetimini geçip kur beklemesine girince birlikte bırakılır: değerlendirmedeki yarışın ta kendisi. */
class BarrierFx extends FxService {
  private arrived = 0;
  private open!: () => void;
  private barrier = new Promise<void>((r) => (this.open = r));
  constructor(private readonly parties: number) {
    super({ fetcher, cacheDir: tmp, now: NOW });
    // Biri denetimde elenirse sonsuza dek beklemesin; test sonucu yine doğruyu söyler.
    setTimeout(() => this.open(), 20_000).unref();
  }
  override async prefetch(...args: Parameters<FxService['prefetch']>) {
    if (++this.arrived >= this.parties) this.open();
    await this.barrier;
    return super.prefetch(...args);
  }
}

async function usdFirm(app: FastifyInstance) {
  const { auth } = await registerCompany(app);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'fedex', name: uniq('FedEx') } });
  const carrierId = (c.json().carrier?.id ?? c.json().id) as string;
  const tariff = await app.inject({
    method: 'POST',
    url: `${API}/tariffs`,
    headers: auth,
    payload: {
      carrierId,
      name: 'USD',
      currency: 'USD',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'A' }],
      rates: [{ zone: 'A', weightUpto: 30, price: 100 }],
      overflow: [],
      surcharges: [],
    },
  });
  expect(tariff.statusCode, tariff.body).toBe(201);
  return { auth, carrierId };
}

async function upload(app: FastifyInstance, auth: Auth, carrierId: string, csv: string) {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const r = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().fileId as string;
}

const csvOf = (...rows: string[]) => ['Takip No;Tarih;Desi;Tutar', ...rows.map((t) => `${t};15.10.2026;10;4005`)].join('\n');

function importInvoice(app: FastifyInstance, auth: Auth, carrierId: string, fileId: string, invoiceNo: string, over: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: auth,
    payload: {
      fileId,
      carrierId,
      invoiceNo,
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', shipDate: 'Tarih', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
      ...over,
    },
  });
}

async function liveInvoices(app: FastifyInstance, auth: Auth) {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices`, headers: auth });
  return r.json().items as { id: string; invoiceNo: string }[];
}

describe('B1: mükerrer fatura yarışı', () => {
  it('kur beklerken gelen aynı dosya: biri oluşur, ikincisi INVOICE_EXISTS alır', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    const csv = csvOf(uniq('7948'), uniq('7948'));
    const [a, b] = [await upload(app, auth, carrierId, csv), await upload(app, auth, carrierId, csv)];
    setFxService(new BarrierFx(2));

    const replies = await Promise.all([importInvoice(app, auth, carrierId, a, 'RACE-9001'), importInvoice(app, auth, carrierId, b, 'RACE-9001')]);

    expect(replies.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(replies.find((r) => r.statusCode === 409)!.json().error.code).toBe('INVOICE_EXISTS');
    expect((await liveInvoices(app, auth)).filter((i) => i.invoiceNo === 'RACE-9001')).toHaveLength(1);

    // Kazanan faturanın satırı kendi kopyası yüzünden "Mükerrer" görünmez.
    const winner = replies.find((r) => r.statusCode === 201)!.json().invoice.id as string;
    const lines = await app.inject({ method: 'GET', url: `${API}/invoices/${winner}/lines`, headers: auth });
    expect((lines.json().items as { diffTypes: string[] }[]).flatMap((l) => l.diffTypes)).not.toContain('DUPLICATE');
  });

  it('aynı dosya farklı yazılmış numarayla: biri oluşur, ikincisi INVOICE_EXISTS alır', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    const csv = csvOf(uniq('7948'), uniq('7948'));
    const [a, b] = [await upload(app, auth, carrierId, csv), await upload(app, auth, carrierId, csv)];
    setFxService(new BarrierFx(2));

    const replies = await Promise.all([importInvoice(app, auth, carrierId, a, 'MNG-CASE-77120'), importInvoice(app, auth, carrierId, b, 'mng-case-77120')]);

    expect(replies.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(replies.find((r) => r.statusCode === 409)!.json().error.code).toBe('INVOICE_EXISTS');
    expect((await liveInvoices(app, auth)).filter((i) => i.invoiceNo.toLowerCase() === 'mng-case-77120')).toHaveLength(1);
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): satır atlama (400 NO_LINES + skipped) kalktı; yarışta ikinci istek kilit altındaki çakışma denetiminde 409 INVOICE_OVERLAP alır.
  it('aynı satırlar bambaşka numarayla: ikinci fatura oluşmaz, INVOICE_OVERLAP alır', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    const csv = csvOf(uniq('7948'), uniq('7948'));
    const [a, b] = [await upload(app, auth, carrierId, csv), await upload(app, auth, carrierId, csv)];
    setFxService(new BarrierFx(2));

    const replies = await Promise.all([importInvoice(app, auth, carrierId, a, uniq('BIR')), importInvoice(app, auth, carrierId, b, uniq('IKI'))]);

    expect(replies.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const winner = replies.find((r) => r.statusCode === 201)!.json().invoice as { id: string; invoiceNo: string };
    const lost = replies.find((r) => r.statusCode === 409)!.json().error;
    expect(lost.code).toBe('INVOICE_OVERLAP');
    expect(lost.details).toEqual({ overlap: { total: 2, matched: 2, invoiceId: winner.id, invoiceNo: winner.invoiceNo } });
    expect(await liveInvoices(app, auth)).toHaveLength(1);
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): yarışta kapılan satır artık atlanmaz; gönderilerin yarısı ortaksa onaysız ikinci istek kilit altında 409 alır.
  it('satırların bir kısmı ortaksa: onaysız yarışta ikincisi INVOICE_OVERLAP alır', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    const shared = uniq('7948');
    const [a, b] = [
      await upload(app, auth, carrierId, csvOf(shared, uniq('7948'))),
      await upload(app, auth, carrierId, csvOf(shared, uniq('7948'))),
    ];
    setFxService(new BarrierFx(2));

    const replies = await Promise.all([importInvoice(app, auth, carrierId, a, uniq('BIR')), importInvoice(app, auth, carrierId, b, uniq('IKI'))]);

    expect(replies.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const winner = replies.find((r) => r.statusCode === 201)!.json().invoice as { id: string; invoiceNo: string; totals: { lines: number } };
    expect(winner.totals.lines).toBe(2);
    const lost = replies.find((r) => r.statusCode === 409)!.json().error;
    expect(lost.code).toBe('INVOICE_OVERLAP');
    expect(lost.details).toEqual({ overlap: { total: 2, matched: 1, invoiceId: winner.id, invoiceNo: winner.invoiceNo } });
    expect(await liveInvoices(app, auth)).toHaveLength(1);
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): eskiden yarışta kapılan satır atlanıyordu (lines [1, 2], skipped [0, 1]); artık onaylı yarışta hepsi yazılır
  // ve sonra yazılan fatura hemen yeniden karşılaştırılır (mükerrer sonucu yarışta eskimez).
  it('satırların bir kısmı ortaksa: onaylı yarışta iki fatura da tam yazılır, sonra yazılanın ortak satırı mükerrer olur', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    const shared = uniq('7948');
    const [a, b] = [
      await upload(app, auth, carrierId, csvOf(shared, uniq('7948'))),
      await upload(app, auth, carrierId, csvOf(shared, uniq('7948'))),
    ];
    setFxService(new BarrierFx(2));

    const replies = await Promise.all([
      importInvoice(app, auth, carrierId, a, uniq('BIR'), { confirmOverlap: true }),
      importInvoice(app, auth, carrierId, b, uniq('IKI'), { confirmOverlap: true }),
    ]);

    expect(replies.map((r) => r.statusCode), replies.map((r) => r.body).join()).toEqual([201, 201]);
    expect(replies.map((r) => 'skipped' in r.json())).toEqual([false, false]); // Y28: eski alan kalktı
    expect(replies.map((r) => r.json().invoice.totals.lines as number)).toEqual([2, 2]);

    // İki istek de karşılaştırmayı kilitten önce, öbürünü görmeden yaptı; sonra yazılan yeniden karşılaştırılmasaydı mükerrer hiç görünmezdi.
    type L = { trackingNo: string; diffTypes: string[] };
    const all = await Promise.all(
      replies.map(async (r) => (await app.inject({ method: 'GET', url: `${API}/invoices/${r.json().invoice.id}/lines`, headers: auth })).json().items as L[]),
    );
    expect(all.map((ls) => ls.length)).toEqual([2, 2]);
    const dupLists = all.map((ls) => ls.filter((l) => l.diffTypes.includes('DUPLICATE')).map((l) => l.trackingNo));
    expect(dupLists.map((d) => d.length).sort()).toEqual([0, 1]);
    expect(dupLists.flat()).toEqual([shared.toUpperCase()]);
    // Yanıttaki toplam da yeniden karşılaştırılmış halidir: mükerrer satırın tutarı yalnız sonra yazılanın fazla ödemesindedir.
    const over = replies.map((r) => r.json().invoice.totals.overchargeTotal as number).sort((x, y) => x - y);
    expect(over[1]! - over[0]!).toBeCloseTo(4005, 2);
  });

  it('sırayla yüklemede de numara büyük/küçük harf farkıyla geçmez; fatura kendi numarasının yazımını değiştirebilir', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    setFxService(new FxService({ fetcher, cacheDir: tmp, now: NOW }));
    const no = uniq('Harf');
    const first = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), no);
    expect(first.statusCode, first.body).toBe(201);

    const again = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), no.toUpperCase());
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('INVOICE_EXISTS');

    const own = await app.inject({ method: 'PATCH', url: `${API}/invoices/${first.json().invoice.id}`, headers: auth, payload: { invoiceNo: no.toUpperCase() } });
    expect(own.statusCode, own.body).toBe(200);

    // Numaradaki alt çizgi joker sayılmaz.
    const under = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), 'A_1');
    expect(under.statusCode, under.body).toBe(201);
    const similar = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), 'AB1');
    expect(similar.statusCode, similar.body).toBe(201);
  });

  it('numara değiştirme yarışı da INVOICE_EXISTS alır, 500 değil', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    setFxService(new FxService({ fetcher, cacheDir: tmp, now: NOW }));
    const a = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), uniq('A'));
    const b = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), uniq('B'));
    const no = uniq('AYNI');
    const replies = await Promise.all(
      [a, b].map((r) => app.inject({ method: 'PATCH', url: `${API}/invoices/${r.json().invoice.id}`, headers: auth, payload: { invoiceNo: no } })),
    );
    expect(replies.map((r) => r.statusCode).sort(), replies.map((r) => r.body).join()).toEqual([200, 409]);
    expect(replies.find((r) => r.statusCode === 409)!.json().error.code).toBe('INVOICE_EXISTS');
  });

  it('veritabanı garantisi: API atlansa da aynı numara yazılamaz; silinmiş, örnek, başka taşıyıcı ve başka firma serbest', async () => {
    const app = await getApp();
    const { auth, carrierId } = await usdFirm(app);
    const other = await usdFirm(app);
    setFxService(new FxService({ fetcher, cacheDir: tmp, now: NOW }));
    const no = uniq('DB');
    const first = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), no);
    expect(first.statusCode, first.body).toBe(201);
    const id = first.json().invoice.id as string;

    const copy = (over: Partial<Prisma.InvoiceUncheckedCreateInput> = {}) =>
      inCompany(auth, async () => {
        const src = await prisma.invoice.findFirstOrThrow({ where: { id } });
        return prisma.invoice.create({
          data: { companyId: src.companyId, carrierId: src.carrierId, invoiceNo: no, invoiceDate: src.invoiceDate, currency: src.currency, sourceFileId: src.sourceFileId, mapping: {}, totals: {}, ...over },
        });
      });
    await expect(copy()).rejects.toMatchObject({ code: 'P2002' });
    await expect(copy({ invoiceNo: no.toLowerCase() })).rejects.toMatchObject({ code: 'P2002' });
    await expect(copy({ isSample: true })).resolves.toBeTruthy();
    await expect(copy({ isSample: true })).resolves.toBeTruthy();
    await expect(copy({ deletedAt: new Date() })).resolves.toBeTruthy();

    const secondCarrier = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'dhl', name: uniq('DHL') } });
    await expect(copy({ carrierId: (secondCarrier.json().carrier?.id ?? secondCarrier.json().id) as string })).resolves.toBeTruthy();
    const elsewhere = await importInvoice(app, other.auth, other.carrierId, await upload(app, other.auth, other.carrierId, csvOf(uniq('7948'))), no);
    expect(elsewhere.statusCode, elsewhere.body).toBe(201);

    // Silince numara yeniden kullanılabilir.
    expect((await app.inject({ method: 'DELETE', url: `${API}/invoices/${id}`, headers: auth })).statusCode).toBe(204);
    const again = await importInvoice(app, auth, carrierId, await upload(app, auth, carrierId, csvOf(uniq('7948'))), no);
    expect(again.statusCode, again.body).toBe(201);
    // Silinmiş kopya geri gelemez hale gelmez: yalnız canlı kopya sayılır, silinen satır durur.
    expect(await inCompany(auth, () => prisma.invoice.count({ where: { invoiceNo: no, carrierId, deletedAt: null, isSample: false } }))).toBe(1);
  });
});

describe('B1: eski hacim', () => {
  const dbUrl = (base: string, name: string) => {
    const u = new URL(base);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const sqlOf = (dir: string) => fs.readFileSync(path.join(DIR, dir, 'migration.sql'), 'utf8');

  it('içinde kopya olan hacimde göç durmaz: en eskisi kalır, kopya silinmiş sayılır ve izi yazılır; dizinsiz şema açılmaz', async () => {
    const dirs = fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, 'migration.sql'))).sort();
    const target = dirs.find((d) => d.endsWith(MIGRATION));
    expect(target, 'göç dosyası').toBeTruthy();
    const before = dirs.slice(0, dirs.indexOf(target!));

    const name = `${TEST_DB_NAME}_eski_fatura`;
    const root = new pg.Client({ connectionString: SUPER_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.query(`CREATE DATABASE "${name}"`);
    const sup = new pg.Client({ connectionString: dbUrl(SUPER_URL, name) });
    const owner = new pg.Client({ connectionString: dbUrl(TEST_ADMIN_URL, name) });
    await sup.connect();
    await owner.connect();
    try {
      await sup.query(dbSetupSection());
      for (const d of before) await owner.query(sqlOf(d));
      expect((await schemaProblems((sql) => sup.query(sql).then((r) => r.rows))).join('\n')).toContain('Invoice_current_no_key');

      await sup.query(`
        SET search_path = deciship;
        INSERT INTO "Company"(id, name, settings, "updatedAt") VALUES ('c1','A','{}',now()), ('c2','B','{}',now());
        INSERT INTO "Member"(id, "companyId", "personId", name, role, "updatedAt")
          SELECT 'm1','c1','p1','X','ADMIN',now() UNION ALL SELECT 'm2','c2','p2','Y','ADMIN',now();
        INSERT INTO "Carrier"(id, "companyId", code, name, "updatedAt") VALUES ('k1','c1','fedex','F',now()), ('k2','c2','fedex','F',now());
        INSERT INTO "File"(id, "companyId", kind, mime, size, path, sha256, "createdById", "updatedAt")
          VALUES ('f1','c1','INVOICE_SOURCE','text/csv',1,'p','s','m1',now()), ('f2','c2','INVOICE_SOURCE','text/csv',1,'p','s','m2',now());
        INSERT INTO "Invoice"(id, "companyId", "carrierId", "invoiceNo", "invoiceDate", currency, "sourceFileId", mapping, totals, "isSample", "deletedAt", "createdAt", "updatedAt") VALUES
          ('eski',   'c1','k1','RACE-9001','2026-10-15','TRY','f1','{}','{}',false,NULL,        '2026-11-01 10:00',now()),
          ('kopya1', 'c1','k1','RACE-9001','2026-10-15','TRY','f1','{}','{}',false,NULL,        '2026-11-01 10:01',now()),
          ('kopya2', 'c1','k1','RACE-9001','2026-10-15','TRY','f1','{}','{}',false,NULL,        '2026-11-01 10:02',now()),
          ('silinmis','c1','k1','RACE-9001','2026-10-15','TRY','f1','{}','{}',false,'2026-11-02',now(),now()),
          ('ornek',  'c1','k1','RACE-9001','2026-10-15','TRY','f1','{}','{}',true, NULL,        now(),now()),
          ('tek',    'c1','k1','TEK-1',    '2026-10-15','TRY','f1','{}','{}',false,NULL,        now(),now()),
          ('baska',  'c2','k2','RACE-9001','2026-10-15','TRY','f2','{}','{}',false,NULL,        now(),now());
      `);

      // Şemanın sahibi de FORCE RLS'ye tabidir: göç bağlamsız çalışır, kopyaları görebilmeli.
      await owner.query(sqlOf(target!));

      const rows = await sup.query(`SELECT id, "deletedAt" FROM deciship."Invoice" ORDER BY id`);
      const state = Object.fromEntries(rows.rows.map((r: { id: string; deletedAt: Date | null }) => [r.id, r.deletedAt == null]));
      expect(state).toEqual({ eski: true, kopya1: false, kopya2: false, silinmis: false, ornek: true, tek: true, baska: true });

      const logs = await sup.query(`SELECT "companyId", "userId", action, entity, "entityId", data FROM deciship."AuditLog" ORDER BY "entityId"`);
      expect(logs.rows).toHaveLength(2);
      expect(logs.rows[0]).toMatchObject({ companyId: 'c1', userId: null, action: 'invoice.delete', entity: 'Invoice', entityId: 'kopya1', data: { reason: 'duplicate_invoice_no', keptInvoiceId: 'eski', invoiceNo: 'RACE-9001' } });

      const force = await sup.query(`SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('Invoice','AuditLog') AND relnamespace = 'deciship'::regnamespace`);
      expect(force.rows.every((r: { f: boolean }) => r.f)).toBe(true);
      expect(await schemaProblems((sql) => sup.query(sql).then((r) => r.rows))).toEqual(expect.not.arrayContaining([expect.stringContaining('Invoice_current_no_key')]));
      await expect(sup.query(`UPDATE deciship."Invoice" SET "deletedAt" = NULL WHERE id = 'kopya1'`)).rejects.toMatchObject({ code: '23505' });

      // Sonraki göç: yazımı farklı kopya da düşer, en eskisi kalır, izi yazılır, kural büyük/küçük harfe duyarsız olur.
      await sup.query(`
        INSERT INTO deciship."Invoice"(id, "companyId", "carrierId", "invoiceNo", "invoiceDate", currency, "sourceFileId", mapping, totals, "createdAt", "updatedAt") VALUES
          ('harf', 'c1','k1','tek-1','2026-10-15','TRY','f1','{}','{}', now() + interval '1 hour', now());
      `);
      const later = dirs.slice(dirs.indexOf(target!) + 1);
      expect(later.some((d) => d.endsWith('invoice_no_case_insensitive'))).toBe(true);
      for (const d of later) await owner.query(sqlOf(d));
      const after = await sup.query(`SELECT id, "deletedAt" FROM deciship."Invoice" WHERE id IN ('tek','harf') ORDER BY id`);
      expect(Object.fromEntries(after.rows.map((r: { id: string; deletedAt: Date | null }) => [r.id, r.deletedAt == null]))).toEqual({ tek: true, harf: false });
      const trace = await sup.query(`SELECT data FROM deciship."AuditLog" WHERE "entityId" = 'harf'`);
      expect(trace.rows[0].data).toMatchObject({ reason: 'duplicate_invoice_no', keptInvoiceId: 'tek', invoiceNo: 'tek-1' });
      await expect(sup.query(`UPDATE deciship."Invoice" SET "deletedAt" = NULL WHERE id = 'harf'`)).rejects.toMatchObject({ code: '23505' });
      expect(await schemaProblems((sql) => sup.query(sql).then((r) => r.rows))).toEqual(expect.not.arrayContaining([expect.stringContaining('Invoice_current_no_key')]));
    } finally {
      await sup.end();
      await owner.end();
      await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await root.end();
    }
  }, 60_000);

  it('check-drift göçün kısmi dizini düşürmesini yakalar', async () => {
    const { dangerousMigration } = (await import(path.join(API_ROOT, 'scripts/check-drift.mjs').replace(/\\/g, '/'))) as { dangerousMigration: (sql: string) => string[] };
    expect(dangerousMigration('DROP INDEX "deciship"."Invoice_current_no_key";')).toHaveLength(1);
    expect(dangerousMigration('drop index if exists "deciship"."Invoice_current_no_key";')).toHaveLength(1);
    // Aynı göçte kısmi olarak yeniden kurulursa düşmüş sayılmaz; kısmi olmayan dizin kuralı bozar.
    expect(dangerousMigration('DROP INDEX "deciship"."Invoice_current_no_key"; CREATE UNIQUE INDEX "Invoice_current_no_key" ON "deciship"."Invoice"("companyId") WHERE "deletedAt" IS NULL;')).toHaveLength(0);
    expect(dangerousMigration('DROP INDEX "deciship"."Invoice_current_no_key"; CREATE UNIQUE INDEX "Invoice_current_no_key" ON "deciship"."Invoice"("companyId");')).toHaveLength(1);
  });
});
