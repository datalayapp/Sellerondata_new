/**
 * KALANLAR 4.8: ölçüm kaydında takip no temizliği ve kesin geçersiz takip no (core `trackingFormat.ts`).
 * Telefon aynı işlevle okuma anında uyarır; sunucu yalnız kesin kuralları uygular, olağan dışı biçimi kabul eder.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TRACKING_HARD_MAX, TRACKING_HARD_MIN } from '@deciship/core';
import { createWorker, getApp, measurementPayload, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
// Kaynakta görünmez karakter yazılmaz (depo denetimi K2): kod noktasıyla kurulur.
const GS = String.fromCharCode(0x1d);
const ZWSP = String.fromCharCode(0x200b);
const S_CEDILLA = String.fromCharCode(0x15e);

async function setup() {
  const app = await getApp();
  const admin = await registerCompany(app);
  const worker = await createWorker(app, admin.auth);
  const post = (over: Record<string, unknown>) => {
    const p = measurementPayload(over, 1);
    return app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
  };
  return { app, admin, worker, post };
}

describe('ölçüm kaydı: takip no kesin kuralları', () => {
  it.each([
    ['kısa (yarım okuma)', '1'.repeat(TRACKING_HARD_MIN - 1)],
    ['boşluklarla kısa', '7 9 4 8'],
    ['uzun (QR adresi)', `https://example.com/t?id=${'1'.repeat(TRACKING_HARD_MAX)}`],
    ['ASCII dışı harf', `${S_CEDILLA}123456789`],
  ])('%s: 400 VALIDATION, alan adıyla', async (_name, trackingRaw) => {
    const { post } = await setup();
    const r = await post({ trackingRaw });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
    expect(r.json().error.message).toMatch(/Takip no|Tracking number/);
    expect(r.json().error.details).toEqual([expect.objectContaining({ path: 'trackingRaw' })]);
  });

  it('düzeltmede de aynı kural; kayıt değişmez', async () => {
    const { app, worker, post } = await setup();
    const m = (await post({})).json().measurement as { id: string; trackingRaw: string };
    const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${m.id}`, headers: worker.auth, payload: { trackingRaw: '12' } });
    expect(r.statusCode, r.body).toBe(400);
    const after = await app.inject({ method: 'GET', url: `${API}/measurements/${m.id}`, headers: worker.auth });
    expect(after.json().measurement.trackingRaw).toBe(m.trackingRaw);
  });

  it('olağan dışı ama kesin geçersiz olmayan biçim (ürün EAN-13) kabul edilir: uyarı telefonda', async () => {
    const { post } = await setup();
    const r = await post({ trackingRaw: '8691234567890' });
    expect(r.statusCode, r.body).toBe(201);
  });
});

describe('ölçüm kaydı: okutma temizliği', () => {
  it('görünmez karakter ve AIM öneki ham değerden de silinir; temiz okutmayla aynı zincir', async () => {
    const { app, worker, post } = await setup();
    const base = `7948${crypto.randomInt(10 ** 7, 10 ** 8)}`;
    const noisy = `]C1${base.slice(0, 6)}${GS}${base.slice(6)}${ZWSP}`;
    const r1 = await post({ trackingRaw: noisy });
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json().measurement).toMatchObject({ trackingRaw: base, trackingNo: base, version: 1 });

    const check = await app.inject({ method: 'GET', url: `${API}/measurements/check?tracking=${encodeURIComponent(`]C1${base}`)}`, headers: worker.auth });
    expect(check.json()).toMatchObject({ exists: true, last: { id: r1.json().measurement.id } });

    const r2 = await post({ trackingRaw: base, lengthCm: 41 });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json().measurement).toMatchObject({ trackingNo: base, version: 2 });
  });

  it('temiz değer eskisi gibi kaydedilir (boşluk ve tire ham değerde kalır)', async () => {
    const { post } = await setup();
    const raw = `7948 ${uniq('')}-12`;
    const r = await post({ trackingRaw: raw });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().measurement).toMatchObject({ trackingRaw: raw, trackingNo: raw.replace(/[\s-]/g, '').toUpperCase() });
  });
});
