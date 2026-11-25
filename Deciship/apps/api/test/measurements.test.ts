import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWorker, findMoneyKeys, getApp, measurementPayload, multipart, registerCompany, uniq, JPEG } from './helpers.ts';

describe('measurements', () => {
  it('LIKE jokerleri kaçışlanır: q=%, _, %%, \\ hiçbir kayıt getirmez; normal arama 1 kayıt bulur', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const tracking = `7949 ${uniq('')}`;
    const m = measurementPayload({ trackingRaw: tracking }, 1);
    const created = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...m.headers }, payload: m.payload });
    expect(created.statusCode).toBe(201);

    for (const q of ['%', '_', '%%', '\\']) {
      const list = await app.inject({ method: 'GET', url: `/api/deciship/measurements?q=${encodeURIComponent(q)}`, headers: admin.auth });
      expect(list.statusCode, q).toBe(200);
      expect(list.json().total, q).toBe(0);
    }
    const ok = await app.inject({ method: 'GET', url: `/api/deciship/measurements?q=${encodeURIComponent(tracking)}`, headers: admin.auth });
    expect(ok.json().total).toBe(1);
  });

  it('creates with photos, is idempotent on clientId and versions re-measurements', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const tracking = `7948 ${uniq('')}`;

    const first = measurementPayload({ trackingRaw: tracking }, 2);
    const r1 = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...first.headers }, payload: first.payload });
    expect(r1.statusCode).toBe(201);
    const m1 = r1.json().measurement;
    expect(m1).toMatchObject({ version: 1, photoCount: 2, desi: 10, volumetricKg5000: 6, trackingNo: tracking.replace(/\s/g, '').toUpperCase() });

    const again = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...first.headers }, payload: first.payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().measurement.id).toBe(m1.id);

    const second = measurementPayload({ trackingRaw: tracking, lengthCm: 41 }, 1);
    const r2 = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...second.headers }, payload: second.payload });
    expect(r2.statusCode).toBe(201);
    const m2 = r2.json().measurement;
    expect(m2.version).toBe(2);

    const detail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${m2.id}`, headers: admin.auth });
    const d = detail.json().measurement;
    expect(d.history.map((h: { id: string }) => h.id)).toEqual([m1.id]);
    expect(d.photos).toHaveLength(1);
    expect(d.invoiceLines).toEqual([]);

    const list = await app.inject({ method: 'GET', url: `/api/deciship/measurements?q=${encodeURIComponent(tracking)}`, headers: admin.auth });
    expect(list.json()).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(list.json().items[0].id).toBe(m2.id);

    const check = await app.inject({ method: 'GET', url: `/api/deciship/measurements/check?tracking=${encodeURIComponent(tracking)}`, headers: worker.auth });
    expect(check.json()).toMatchObject({ exists: true, last: { id: m2.id, lengthCm: 41, measuredByName: 'Çalışan Test' } });
    const none = await app.inject({ method: 'GET', url: '/api/deciship/measurements/check?tracking=YOK123', headers: worker.auth });
    expect(none.json()).toEqual({ exists: false });

    const stats = await app.inject({ method: 'GET', url: '/api/deciship/measurements/stats/today', headers: worker.auth });
    expect(stats.json()).toEqual({ count: 1, missingPhotos: 0 });
  });

  it('serves photos via short-lived signed urls, scoped to the company', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const other = await registerCompany(app);
    const p = measurementPayload({}, 1);
    const created = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...p.headers }, payload: p.payload });
    const detail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${created.json().measurement.id}`, headers: admin.auth });
    const photo = detail.json().measurement.photos[0];
    expect(photo.kind).toBe('PHOTO_BOX');
    const url = new URL(photo.url);
    const img = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.rawPayload.equals(JPEG)).toBe(true);

    const noToken = await app.inject({ method: 'GET', url: url.pathname });
    expect(noToken.statusCode).toBe(401);
    const tampered = await app.inject({ method: 'GET', url: `${url.pathname}?t=${url.searchParams.get('t')}x` });
    expect(tampered.statusCode).toBe(404);
    const otherCompany = await app.inject({ method: 'GET', url: url.pathname, headers: other.auth });
    expect(otherCompany.statusCode).toBe(404);
    const otherDetail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${created.json().measurement.id}`, headers: other.auth });
    expect(otherDetail.statusCode).toBe(404);
  });

  it('validates input and rejects non-image photos', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const bad = measurementPayload({ lengthCm: -1 });
    const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...bad.headers }, payload: bad.payload });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
    const pdf = multipart([
      { name: 'data', value: JSON.stringify({ ...measurementPayload().data, clientId: crypto.randomUUID() }) },
      { name: 'photos', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4') },
    ]);
    const r2 = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...pdf.headers }, payload: pdf.payload });
    expect(r2.statusCode).toBe(400);
  });

  it('admin correction writes a new version; delete is soft', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const p = measurementPayload({}, 1);
    const created = (await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...p.headers }, payload: p.payload })).json().measurement;
    const patched = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${created.id}`, headers: admin.auth, payload: { weightKg: 5.5 } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().measurement).toMatchObject({ version: 2, weightKg: 5.5, photoCount: 1 });
    const stale = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${created.id}`, headers: admin.auth, payload: { weightKg: 6 } });
    expect(stale.statusCode).toBe(409);
    const del = await app.inject({ method: 'DELETE', url: `/api/deciship/measurements/${patched.json().measurement.id}`, headers: admin.auth });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: `/api/deciship/measurements?q=${created.trackingNo}`, headers: admin.auth });
    expect(list.json().total).toBe(0);
  });
});

describe('roles and worker redaction', () => {
  it('blocks WORKER from admin endpoints', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    for (const [method, url] of [
      ['GET', '/api/deciship/invoices'],
      ['GET', '/api/deciship/tariffs'],
      ['GET', '/api/deciship/carriers'],
      ['GET', '/api/deciship/dashboard'],
      ['PATCH', '/api/deciship/settings'],
      ['POST', '/api/deciship/box-presets'],
    ] as const) {
      const r = await app.inject({ method, url, headers: worker.auth, payload: method === 'GET' ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('WORKER sees only own measurements and never any money field', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const adminM = measurementPayload({}, 1);
    await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...adminM.headers }, payload: adminM.payload });
    const own = measurementPayload({}, 1);
    const created = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...own.headers }, payload: own.payload });
    const id = created.json().measurement.id;

    const responses = [
      created.json(),
      (await app.inject({ method: 'GET', url: '/api/deciship/me', headers: worker.auth })).json(),
      (await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: worker.auth })).json(),
      (await app.inject({ method: 'GET', url: '/api/deciship/box-presets', headers: worker.auth })).json(),
      (await app.inject({ method: 'GET', url: '/api/deciship/measurements', headers: worker.auth })).json(),
      (await app.inject({ method: 'GET', url: `/api/deciship/measurements/${id}`, headers: worker.auth })).json(),
      (await app.inject({ method: 'GET', url: `/api/deciship/measurements/check?tracking=${own.data.trackingRaw}`, headers: worker.auth })).json(),
      (await app.inject({ method: 'GET', url: '/api/deciship/measurements/stats/today', headers: worker.auth })).json(),
    ];
    for (const body of responses) expect(findMoneyKeys(body)).toEqual([]);
    const list = responses[4];
    expect(list.total).toBe(1);
    expect(list.items[0]).not.toHaveProperty('invoiceStatus');
    const settings = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: worker.auth });
    expect(settings.json()).not.toHaveProperty('amountTol');
  });

});

describe('vision proxy', () => {
  it('returns AI_DISABLED without an API key and VISION_UNAVAILABLE when the service is down', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const img = multipart([{ name: 'image', filename: 's.jpg', contentType: 'image/jpeg', data: JPEG }]);
    const scale = await app.inject({ method: 'POST', url: '/api/deciship/vision/scale', headers: { ...admin.auth, ...img.headers }, payload: img.payload });
    expect(scale.statusCode).toBe(503);
    expect(scale.json().error).toEqual({ code: 'AI_DISABLED', message: 'Yapay zekâ şu an kullanılamıyor, ağırlığı elle girin' });
    const detect = await app.inject({ method: 'POST', url: '/api/deciship/vision/reference/detect', headers: { ...admin.auth, ...img.headers }, payload: img.payload });
    expect(detect.statusCode).toBe(503);
    expect(detect.json().error.code).toBe('VISION_UNAVAILABLE');
  });
});
