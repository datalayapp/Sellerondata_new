/**
 * Y44: mobildeki akla aykırı ölçü uyarısının eşikleri firma ayarıdır (`warnEdgeCm`, `warnWeightKg`).
 * Varsayılanlar bugünkü sabitler (150 cm, 70 kg); ölçen rol de görür (telefon buradan alır); eşikler ölçümü reddetmez.
 */
import { describe, expect, it } from 'vitest';
import { createWorker, getApp, measurementPayload, registerCompany } from './helpers.ts';

const API = '/api/deciship';

describe('Y44: ölçü uyarısı eşikleri firma ayarı', () => {
  it('varsayılan 150 cm ve 70 kg; yönetici değiştirir, ölçen rol /settings ve /me içinde görür', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);

    const before = await app.inject({ method: 'GET', url: `${API}/settings`, headers: worker.auth });
    expect(before.json()).toMatchObject({ warnEdgeCm: 150, warnWeightKg: 70 });
    const adminView = await app.inject({ method: 'GET', url: `${API}/settings`, headers: admin.auth });
    expect(adminView.json()).toMatchObject({ warnEdgeCm: 150, warnWeightKg: 70 });

    const patch = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: admin.auth, payload: { warnEdgeCm: 120, warnWeightKg: 40 } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json()).toMatchObject({ warnEdgeCm: 120, warnWeightKg: 40, desiDivisor: 3000, requiredBoxPhotos: 1 });

    const after = await app.inject({ method: 'GET', url: `${API}/settings`, headers: worker.auth });
    expect(after.json()).toMatchObject({ warnEdgeCm: 120, warnWeightKg: 40 });
    const me = await app.inject({ method: 'GET', url: `${API}/me`, headers: worker.auth });
    expect(me.json().company.settings).toMatchObject({ warnEdgeCm: 120, warnWeightKg: 40 });
  });

  it('sınır dışı ya da tam sayı olmayan eşik 400 VALIDATION; ölçen rol yazamaz', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    for (const payload of [{ warnEdgeCm: 9 }, { warnEdgeCm: 401 }, { warnEdgeCm: 150.5 }, { warnWeightKg: 0 }, { warnWeightKg: 1000 }, { warnWeightKg: '70' }]) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: admin.auth, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION');
    }
    const edges = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: admin.auth, payload: { warnEdgeCm: 10, warnWeightKg: 999 } });
    expect(edges.statusCode, edges.body).toBe(200);
    const denied = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: worker.auth, payload: { warnEdgeCm: 300 } });
    expect(denied.statusCode).toBe(403);
  });

  it('eşikleri aşan ölçüm reddedilmez (yalnız telefonda uyarıdır)', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: admin.auth, payload: { warnEdgeCm: 50, warnWeightKg: 5 } });
    const p = measurementPayload({ lengthCm: 200, widthCm: 60, heightCm: 60, weightKg: 120 });
    const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    expect(m.json().measurement).toMatchObject({ lengthCm: 200, weightKg: 120 });
  });
});
