/**
 * KALANLAR 6.7 (B4.30): telefonda kuyrukta bekleyip günler sonra gelen eski ölçüm, bu arada yapılmış daha yeni ölçümün yerine
 * geçmez; eski sürüm olarak zincire, ölçüm anına göre doğru yere girer (kaybolmaz). Ölçüm zamanı sunucuda denetlenir:
 * gelecekte (saat kayması payından ötede) ya da çok eski zaman `400 MEASURED_AT_INVALID`.
 */
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { MeasurementIndex, movedMeasurements } from '../src/services/compare.ts';
import { operatorFacts } from '../src/services/hub/metrics.ts';
import { makePeriod } from '../src/services/hub/period.ts';
import { MEASURED_AT_FUTURE_SKEW_MS, MEASURED_AT_MAX_AGE_MS } from '../src/services/measurementOrder.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Yalnız rakam: normalleştirme numarayı değiştirmez. */
const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

async function post(app: FastifyInstance, auth: Auth, over: Record<string, unknown>, headers: Record<string, string> = {}) {
  const p = measurementPayload(over);
  const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...auth, ...p.headers, ...headers }, payload: p.payload });
  return { r, p };
}

/** Zincir, güncel sürümden geriye: [id, version]. */
async function chainOf(auth: Auth, headId: string) {
  return inCompany(auth, async () => {
    const out: { id: string; version: number }[] = [];
    let cursor: { id: string; version: number } | null = await prisma.measurement.findFirstOrThrow({ where: { id: headId }, select: { id: true, version: true } });
    while (cursor) {
      out.push(cursor);
      cursor = await prisma.measurement.findFirst({ where: { supersededById: cursor.id }, select: { id: true, version: true } });
    }
    return out;
  });
}

async function firmWithInvoice(app: FastifyInstance, tracking: string) {
  const admin = await registerCompany(app, uniq('Geç ölçüm '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: uniq('FedEx') } });
  const carrierId = c.json().carrier.id as string;
  const tariff = await app.inject({
    method: 'POST',
    url: `${API}/tariffs`,
    headers: admin.auth,
    payload: {
      carrierId,
      name: 'TRY',
      currency: 'TRY',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'A' }],
      rates: [{ zone: 'A', weightUpto: 100, price: 100 }],
      overflow: [],
      surcharges: [],
    },
  });
  expect(tariff.statusCode, tariff.body).toBe(201);
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(`Takip No;Desi;Tutar\n${tracking};5;500`) },
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
  return { admin, worker, invoiceId: inv.json().invoice.id as string };
}

async function lineOf(app: FastifyInstance, auth: Auth, invoiceId: string, tracking: string) {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth });
  const line = (r.json().items as { trackingNo: string; measurementId: string | null; ourChargeableKg: number | null; status: string; reviewCode?: string | null }[]).find((l) => l.trackingNo === tracking);
  expect(line, tracking).toBeDefined();
  return line!;
}

describe('6.7: geç gelen eski ölçüm yeni ölçümü ezmez', () => {
  it('yeni ölçüm güncel kalır; eski kayıt eski sürüm olarak saklanır; fatura yeni ölçümle kalır; tekrar gönderim aynı kaydı döner', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await firmWithInvoice(app, tracking);

    // Salı: koli çevrimiçi telefondan ölçüldü (30x20x15 → 3 desi).
    const fresh = await post(app, admin.auth, { trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2, measuredAt: ago(2 * HOUR) });
    expect(fresh.r.statusCode, fresh.r.body).toBe(201);
    const freshId = fresh.r.json().measurement.id as string;
    expect(await lineOf(app, admin.auth, invoiceId, tracking)).toMatchObject({ measurementId: freshId, ourChargeableKg: 3 });

    // Pazartesi çevrimdışı ölçülen (60x50x40 → 40 desi) kayıt şimdi geldi.
    const late = await post(app, worker.auth, { trackingRaw: tracking, lengthCm: 60, widthCm: 50, heightCm: 40, weightKg: 9, measuredAt: ago(30 * HOUR) });
    expect(late.r.statusCode, late.r.body).toBe(201);
    const lateM = late.r.json().measurement;
    expect(lateM).toMatchObject({ superseded: true, version: 1, deleted: false });

    // Güncel ölçüm değişmedi; eski kayıt onun eski sürümü.
    const check = await app.inject({ method: 'GET', url: `${API}/measurements/check?tracking=${tracking}`, headers: admin.auth });
    expect(check.json().last).toMatchObject({ id: freshId, lengthCm: 30 });
    const list = await app.inject({ method: 'GET', url: `${API}/measurements?q=${tracking}`, headers: admin.auth });
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([freshId]);
    expect(await chainOf(admin.auth, freshId)).toEqual([
      { id: freshId, version: 2 },
      { id: lateM.id, version: 1 },
    ]);
    const detail = await app.inject({ method: 'GET', url: `${API}/measurements/${freshId}`, headers: admin.auth });
    expect(detail.json().measurement).toMatchObject({ version: 2, canEdit: true });
    expect(detail.json().measurement.history.map((h: { id: string }) => h.id)).toEqual([lateM.id]);

    // Fatura satırı hâlâ yeni ölçümle hesaplanır (eski ölçünün 40 desisiyle değil).
    const line = await lineOf(app, admin.auth, invoiceId, tracking);
    expect(line).toMatchObject({ measurementId: freshId, ourChargeableKg: 3 });

    // Telefon aynı kaydı yeniden gönderirse (yanıt kayboldu) yeni kayıt açılmaz.
    const again = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...late.p.headers }, payload: late.p.payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().measurement.id).toBe(lateM.id);
    expect(await chainOf(admin.auth, freshId)).toHaveLength(2);

    const audit = await inCompany(admin.auth, () => prisma.auditLog.findFirstOrThrow({ where: { entityId: lateM.id } }));
    expect(audit).toMatchObject({ action: 'measurement.remeasure', data: { trackingNo: tracking, late: true, currentId: freshId } });
  });

  it('eski kayıt zincirde ölçüm anına göre yerine girer; sürüm numaraları sırayla kayar', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const tracking = trackingNo();
    const t1 = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(50 * HOUR) });
    const t3 = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(10 * HOUR) });
    const headId = t3.r.json().measurement.id as string;
    // düzeltme ölçüm anını korur: t3'ün düzeltmesi t3'le aynı ana sahip
    const fix = await app.inject({ method: 'PATCH', url: `${API}/measurements/${headId}`, headers: admin.auth, payload: { weightKg: 5 } });
    expect(fix.statusCode, fix.body).toBe(200);
    const fixedId = fix.json().measurement.id as string;

    const between = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(30 * HOUR) });
    expect(between.r.statusCode, between.r.body).toBe(201);
    const oldest = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(70 * HOUR) });
    expect(oldest.r.statusCode, oldest.r.body).toBe(201);

    expect(await chainOf(admin.auth, fixedId)).toEqual([
      { id: fixedId, version: 5 },
      { id: headId, version: 4 },
      { id: between.r.json().measurement.id, version: 3 },
      { id: t1.r.json().measurement.id, version: 2 },
      { id: oldest.r.json().measurement.id, version: 1 },
    ]);
    // güncel sürümün düzeltmesi kaymış numaradan devam eder
    const fix2 = await app.inject({ method: 'PATCH', url: `${API}/measurements/${fixedId}`, headers: admin.auth, payload: { weightKg: 6 } });
    expect(fix2.json().measurement).toMatchObject({ version: 6, superseded: false });
    // yeni ölçüm anlı kayıt yine güncel olur
    const newest = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(HOUR) });
    expect(newest.r.json().measurement).toMatchObject({ superseded: false, version: 7 });
  });

  it('güncel kaydın ölçüm anı (eski veri) gelecekteyse yeni ölçüm onu ezer: eski bozuk saat zinciri kilitlemez', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const tracking = trackingNo();
    const first = await post(app, admin.auth, { trackingRaw: tracking });
    const id = first.r.json().measurement.id as string;
    await inCompany(admin.auth, () => prisma.measurement.update({ where: { id }, data: { measuredAt: new Date(Date.now() + 48 * HOUR) } }));
    const next = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(0) });
    expect(next.r.statusCode, next.r.body).toBe(201);
    expect(next.r.json().measurement).toMatchObject({ superseded: false, version: 2 });
  });
});

describe('6.7: ölçüm zamanı sunucuda denetlenir', () => {
  it('gönderim anını bildiren istemcide: kayma payı içindeki gelecek zaman kabul, ötesi ve çok eski zaman 400 MEASURED_AT_INVALID; kayıt yazılmaz', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);

    const skew = await post(app, worker.auth, { measuredAt: new Date(Date.now() + MEASURED_AT_FUTURE_SKEW_MS - 60_000).toISOString() });
    expect(skew.r.statusCode, skew.r.body).toBe(201);

    for (const measuredAt of [
      new Date(Date.now() + MEASURED_AT_FUTURE_SKEW_MS + 60_000).toISOString(),
      new Date(Date.now() + 400 * 24 * HOUR).toISOString(),
      new Date(Date.now() - MEASURED_AT_MAX_AGE_MS - 24 * HOUR).toISOString(),
      '1970-01-01T00:00:00.000Z',
    ]) {
      const bad = await post(app, worker.auth, { measuredAt }, { 'x-sod-sent-at': new Date().toISOString() });
      expect(bad.r.statusCode, measuredAt).toBe(400);
      expect(bad.r.json().error.code, measuredAt).toBe('MEASURED_AT_INVALID');
      expect(bad.r.json().error.details).toEqual([{ path: 'measuredAt', message: bad.r.json().error.message }]);
      const stored = await inCompany(admin.auth, () => prisma.measurement.count({ where: { clientId: bad.p.data.clientId } }));
      expect(stored, measuredAt).toBe(0);
    }
    const en = measurementPayload({ measuredAt: '1970-01-01T00:00:00.000Z' });
    const enR = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...en.headers, 'accept-language': 'en', 'x-sod-sent-at': new Date().toISOString() }, payload: en.payload });
    expect(enR.json().error.message).toMatch(/clock/i);

    // Kayıt yazıldıktan sonra gelen tekrar gönderim, zamanı ne olursa olsun aynı kaydı döner (idempotent; eski veri).
    const legacy = await post(app, worker.auth, {});
    const legacyId = legacy.r.json().measurement.id as string;
    await inCompany(admin.auth, () => prisma.measurement.update({ where: { id: legacyId }, data: { measuredAt: new Date(Date.now() + 72 * HOUR) } }));
    const future = JSON.parse(String(JSON.stringify(legacy.p.data)));
    future.measuredAt = new Date(Date.now() + 72 * HOUR).toISOString();
    const resend = multipart([{ name: 'data', value: JSON.stringify(future) }]);
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...resend.headers }, payload: resend.payload });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().measurement.id).toBe(legacyId);
  });

  it('düzeltmede ölçüm anı yalnız yönetme izniyle değişir ve gelecekte olamaz; çalışanın gönderdiği yok sayılır', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const m = await post(app, worker.auth, {});
    const id = m.r.json().measurement.id as string;
    const future = new Date(Date.now() + MEASURED_AT_FUTURE_SKEW_MS + 60_000).toISOString();

    const own = await app.inject({ method: 'PATCH', url: `${API}/measurements/${id}`, headers: worker.auth, payload: { weightKg: 3, measuredAt: future } });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().measurement.measuredAt).toBe(m.r.json().measurement.measuredAt);
    const ownId = own.json().measurement.id as string;

    const managed = await app.inject({ method: 'PATCH', url: `${API}/measurements/${ownId}`, headers: admin.auth, payload: { measuredAt: future } });
    expect(managed.statusCode, managed.body).toBe(400);
    expect(managed.json().error.code).toBe('MEASURED_AT_INVALID');

    // geçmişe çekmek serbest (yönetici gerçek ölçüm anını düzeltir)
    const past = '2024-01-02T03:04:05.000Z';
    const ok = await app.inject({ method: 'PATCH', url: `${API}/measurements/${ownId}`, headers: admin.auth, payload: { measuredAt: past } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().measurement.measuredAt).toBe(past);
  });
});

describe('6.7 inceleme: sıra telefon saatine körü körüne güvenmez', () => {
  it('saati 10 dk ileride telefonun yanlış ölçümünü, hemen ardından doğru saatli yeniden ölçüm düzeltir (eski uygulama, sentAt yok)', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await firmWithInvoice(app, tracking);
    const wrong = await post(app, worker.auth, { trackingRaw: tracking, lengthCm: 60, widthCm: 50, heightCm: 40, weightKg: 9, measuredAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect(wrong.r.statusCode, wrong.r.body).toBe(201);
    const wrongId = wrong.r.json().measurement.id as string;
    const createdAt = await inCompany(admin.auth, async () => (await prisma.measurement.findFirstOrThrow({ where: { id: wrongId } })).createdAt);
    // B telefonu doğru saatli: ölçüm anı A'nın sunucuya ulaştığı andan sonra, A'nın (ileri) ölçüm anından önce
    const fix = await post(app, admin.auth, { trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2, measuredAt: new Date(createdAt.getTime() + 1000).toISOString() });
    expect(fix.r.statusCode, fix.r.body).toBe(201);
    expect(fix.r.json().measurement).toMatchObject({ superseded: false, version: 2 });
    expect(await lineOf(app, admin.auth, invoiceId, tracking)).toMatchObject({ measurementId: fix.r.json().measurement.id, ourChargeableKg: 3 });
  });

  it('replacesId: kontrol ekranında görülüp bilerek yerine konan kayıt, saat 3 saat geride olsa da güncel olur; güncel değilse yok sayılır', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const tracking = trackingNo();
    const first = await post(app, admin.auth, { trackingRaw: tracking });
    const firstId = first.r.json().measurement.id as string;
    const behind = ago(3 * HOUR);
    // saat geride, kimlik yok: geç kayıt sayılır (eski davranış)
    const plain = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: behind });
    expect(plain.r.json().measurement.superseded).toBe(true);
    // bilerek yerine koyma: güncel sürüm o kayıt → yeni kayıt güncel
    const replaced = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: behind, replacesId: firstId });
    expect(replaced.r.statusCode, replaced.r.body).toBe(201);
    expect(replaced.r.json().measurement).toMatchObject({ superseded: false });
    const audit = await inCompany(admin.auth, () => prisma.auditLog.findFirstOrThrow({ where: { entityId: replaced.r.json().measurement.id } }));
    expect(audit.data).toMatchObject({ previousId: firstId, replaced: true });
    // eski kimlik artık güncel değil: yok sayılır, saat sırası geçerli
    const stale = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(5 * HOUR), replacesId: firstId });
    expect(stale.r.json().measurement.superseded).toBe(true);
  });

  it('sentAt: cihaz saati farkı gönderim anında ölçülüp düzeltilir; ham an ayrı saklanır; sıfırlanmış (1970) ve ileri saat kurtulur', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const tracking = trackingNo();
    await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(60_000) });

    // 3 saat geride telefon: hem ölçüm hem gönderim anı 3 saat geride → eskiden geç kayıt sayılırdı
    const shift = 3 * HOUR;
    const raw = new Date(Date.now() - shift + 30_000).toISOString();
    const behind = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: raw, sentAt: raw });
    expect(behind.r.statusCode, behind.r.body).toBe(201);
    const b = behind.r.json().measurement;
    expect(b).toMatchObject({ superseded: false, version: 2 });
    expect(Math.abs(Date.parse(b.measuredAt) - Date.now())).toBeLessThan(5 * 60_000);
    const row = await inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: b.id } }));
    expect(row.deviceMeasuredAt?.toISOString()).toBe(raw);
    const audit = await inCompany(admin.auth, () => prisma.auditLog.findFirstOrThrow({ where: { entityId: b.id } }));
    expect((audit.data as { clockOffsetMs: number }).clockOffsetMs).toBeGreaterThan(shift - 5 * 60_000);

    // saati 1970'e sıfırlanmış telefon: 5 dk önce ölçtü
    const reset = await post(app, admin.auth, { measuredAt: '1970-01-01T00:00:00.000Z', sentAt: '1970-01-01T00:05:00.000Z' });
    expect(reset.r.statusCode, reset.r.body).toBe(201);
    expect(Math.abs(Date.parse(reset.r.json().measurement.measuredAt) - (Date.now() - 5 * 60_000))).toBeLessThan(60_000);
    // 3 saat ileride telefon: kabul edilir, an düzelir
    const aheadAt = new Date(Date.now() + shift).toISOString();
    const ahead = await post(app, admin.auth, { measuredAt: aheadAt, sentAt: aheadAt });
    expect(ahead.r.statusCode, ahead.r.body).toBe(201);
    expect(Math.abs(Date.parse(ahead.r.json().measurement.measuredAt) - Date.now())).toBeLessThan(60_000);
    // küçük fark (ağ gecikmesi) düzeltilmez
    const smallAt = ago(HOUR);
    const small = await post(app, admin.auth, { measuredAt: smallAt, sentAt: ago(20_000) });
    const smallRow = await inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: small.r.json().measurement.id } }));
    expect(smallRow.deviceMeasuredAt).toBeNull();
    expect(smallRow.measuredAt.toISOString()).toBe(smallAt);
  });

  it('sürüm değişimi de ölçüm değişikliğidir: süren içe aktarma geç kaydı kaçırmaz (movedMeasurements)', () => {
    const base = { id: 'm1', trackingNo: 'T', trackingRaw: 'T', lengthCm: 1, widthCm: 1, heightCm: 1, weightKg: 1, measuredAt: new Date() };
    const idx = (version: number) => new MeasurementIndex([{ ...base, version } as never]);
    expect(movedMeasurements(idx(1), idx(2))).toEqual(['m1']);
    expect(movedMeasurements(idx(1), idx(1))).toEqual([]);
  });
});

describe('6.7 inceleme: görünürlük, Merkez ve geri yükleme', () => {
  it('çalışan kendi geç kaydını listede ve Bugün sayısında görür; Merkez onu ölçene yazar, güncel kaydın sahibine düzeltme yazmaz; akışta ayrı etiket', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const tracking = trackingNo();
    const head = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(60_000) });
    // aynı gün içinde kalsın (gece yarısına yakın koşuda gün sınırı)
    const late = await post(app, worker.auth, { trackingRaw: tracking, measuredAt: ago(5 * 60_000) });
    expect(late.r.json().measurement.superseded).toBe(true);
    const lateId = late.r.json().measurement.id as string;

    const mine = await app.inject({ method: 'GET', url: `${API}/measurements`, headers: worker.auth });
    expect(mine.json().items.map((i: { id: string }) => i.id)).toEqual([lateId]);
    const search = await app.inject({ method: 'GET', url: `${API}/measurements?q=${tracking}`, headers: worker.auth });
    expect(search.json().items.map((i: { id: string }) => i.id)).toEqual([lateId]);
    const stats = await app.inject({ method: 'GET', url: `${API}/measurements/stats/today`, headers: worker.auth });
    const sameDay = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
    if (sameDay) expect(stats.json().count).toBe(1);
    // hepsini gören yönetici yalnız güncel kaydı görür (aynı takip no iki satır olmaz)
    const all = await app.inject({ method: 'GET', url: `${API}/measurements?q=${tracking}`, headers: admin.auth });
    expect(all.json().items.map((i: { id: string }) => i.id)).toEqual([head.r.json().measurement.id]);

    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const facts = await inCompany(admin.auth, () => operatorFacts(admin.companyId, makePeriod(day(-2), day(1))));
    expect(facts.find((f) => f.userId === worker.userId)).toMatchObject({ count: 1, corrected: 0 });
    expect(facts.find((f) => f.userId === admin.userId)).toMatchObject({ count: 1, corrected: 0 });

    const feed = await app.inject({ method: 'GET', url: `${API}/platform/activity`, headers: admin.auth });
    expect(feed.statusCode, feed.body).toBe(200);
    const labels = feed.json().items.map((i: { action: string }) => i.action);
    expect(labels).toContain('koliyi daha önce ölçmüştü, ölçüm geç gönderildi');
    expect(labels).not.toContain('koliyi yeniden ölçtü');
  });

  it('güncel kayıt silinmişken gelen geç kayıt, silinen yeni kayıt geri yüklenince onun eski sürümü olur (yanlış NEWER_EXISTS yok)', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const tracking = trackingNo();
    const newer = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(60_000) });
    const newerId = newer.r.json().measurement.id as string;
    expect((await app.inject({ method: 'DELETE', url: `${API}/measurements/${newerId}`, headers: admin.auth })).statusCode).toBe(204);
    const late = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(3 * HOUR) });
    expect(late.r.json().measurement).toMatchObject({ superseded: false, version: 1 });
    const lateId = late.r.json().measurement.id as string;

    const restore = await app.inject({ method: 'POST', url: `${API}/measurements/${newerId}/restore`, headers: admin.auth });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json().measurement).toMatchObject({ id: newerId, deleted: false, version: 2 });
    expect(await chainOf(admin.auth, newerId)).toEqual([
      { id: newerId, version: 2 },
      { id: lateId, version: 1 },
    ]);
    const row = await inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: lateId } }));
    expect(row).toMatchObject({ arrivedLate: true, deletedAt: null });

    // gerçekten daha yeni ölçüm varsa eskisi gibi NEWER_EXISTS
    const t2 = trackingNo();
    const old = await post(app, admin.auth, { trackingRaw: t2, measuredAt: ago(3 * HOUR) });
    await app.inject({ method: 'DELETE', url: `${API}/measurements/${old.r.json().measurement.id}`, headers: admin.auth });
    await post(app, admin.auth, { trackingRaw: t2, measuredAt: ago(60_000) });
    const blocked = await app.inject({ method: 'POST', url: `${API}/measurements/${old.r.json().measurement.id}/restore`, headers: admin.auth });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('NEWER_EXISTS');
  });
});

describe('6.7 ikinci inceleme', () => {
  it('gönderim süresi (yükleme, jeton yenileme) saat farkı sayılmaz: 75 sn süren gönderim ölçüm anını kaydırmaz, sonraki doğru ölçüm güncel olur', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await firmWithInvoice(app, tracking);
    // T1'de yanlış ölçüm; telefon saati doğru, istek 75 sn sürdü (sunucu T1 + 80 sn'de aldı)
    const t1 = Date.now() - 80_000;
    const wrong = await post(
      app,
      worker.auth,
      { trackingRaw: tracking, lengthCm: 60, widthCm: 50, heightCm: 40, weightKg: 9, measuredAt: new Date(t1).toISOString() },
      { 'x-sod-sent-at': new Date(t1 + 5_000).toISOString() },
    );
    expect(wrong.r.json().measurement.measuredAt).toBe(new Date(t1).toISOString());
    // T1 + 40 sn'de doğru yeniden ölçüm (ilk kayıt o an sunucuda değildi: replacesId yok)
    const fix = await post(app, admin.auth, { trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2, measuredAt: new Date(t1 + 40_000).toISOString() });
    expect(fix.r.json().measurement).toMatchObject({ superseded: false, version: 2 });
    expect(await lineOf(app, admin.auth, invoiceId, tracking)).toMatchObject({ measurementId: fix.r.json().measurement.id, ourChargeableKg: 3 });
  });

  it('başlıktaki gönderim anı gövdedekinden önceliklidir', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const shift = 3 * HOUR;
    const raw = new Date(Date.now() - shift).toISOString();
    // gövdedeki alan eski (jeton yenilemeden önce yazılmış gibi), başlık doğru: fark başlıktan
    const r = await post(app, admin.auth, { measuredAt: raw, sentAt: new Date(Date.now() - shift - 2 * HOUR).toISOString() }, { 'x-sod-sent-at': raw });
    expect(r.r.statusCode, r.r.body).toBe(201);
    expect(Math.abs(Date.parse(r.r.json().measurement.measuredAt) - Date.now())).toBeLessThan(60_000);
  });

  it('eski uygulama (gönderim anı yok): aralık dışı an reddedilmez, alış anına çekilir, ham an saklanır; güncel ölçümün yerine geçmez', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    for (const measuredAt of [new Date(Date.now() + 2 * HOUR).toISOString(), '1970-01-01T00:00:00.000Z', new Date(Date.now() - MEASURED_AT_MAX_AGE_MS - 24 * HOUR).toISOString()]) {
      const r = await post(app, worker.auth, { measuredAt });
      expect(r.r.statusCode, `${measuredAt} ${r.r.body}`).toBe(201);
      const m = r.r.json().measurement;
      expect(Math.abs(Date.parse(m.measuredAt) - Date.now()), measuredAt).toBeLessThan(60_000);
      const row = await inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: m.id } }));
      expect(row.deviceMeasuredAt?.toISOString()).toBe(measuredAt);
      const audit = await inCompany(admin.auth, () => prisma.auditLog.findFirstOrThrow({ where: { entityId: m.id } }));
      expect(audit.data).toMatchObject({ clockClamped: true });
    }
    // gerçek anı bilinmeyen kayıt güncel ölçümü değiştirmez: eski sürüm olarak saklanır
    const tracking = trackingNo();
    const head = await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(10 * 60_000) });
    const clamped = await post(app, worker.auth, { trackingRaw: tracking, measuredAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    expect(clamped.r.statusCode).toBe(201);
    expect(clamped.r.json().measurement.superseded).toBe(true);
    const check = await app.inject({ method: 'GET', url: `${API}/measurements/check?tracking=${tracking}`, headers: admin.auth });
    expect(check.json().last.id).toBe(head.r.json().measurement.id);
  });

  it('yönetici listeyi çalışana göre süzünce o çalışanın geç kaydı da görünür', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const tracking = trackingNo();
    await post(app, admin.auth, { trackingRaw: tracking, measuredAt: ago(60_000) });
    const late = await post(app, worker.auth, { trackingRaw: tracking, measuredAt: ago(5 * 60_000) });
    const lateId = late.r.json().measurement.id as string;
    const byWorker = await app.inject({ method: 'GET', url: `${API}/measurements?userId=${worker.userId}`, headers: admin.auth });
    expect(byWorker.json().items.map((i: { id: string }) => i.id)).toEqual([lateId]);
    const byAdmin = await app.inject({ method: 'GET', url: `${API}/measurements?userId=${admin.userId}`, headers: admin.auth });
    expect(byAdmin.json().total).toBe(1);
  });
});
