/**
 * Y147: yarıda düşen ölçüm kaydının (ya da düzeltmesinin) fotoğrafı sahipsiz kalmaz. Fotoğraf işlemden önce diske yazılır;
 * işlem düşerse yalnız bu istekte yazılan ve hiçbir `File` satırının göstermediği dosya silinir.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { env } from '../src/env.ts';
import { storeBuffer } from '../src/lib/storage.ts';
import { discardUnsavedPhotos } from '../src/routes/measurements.ts';
import { createWorker, getApp, inCompany, JPEG, measurementPayload, multipart, registerCompany, type Part } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const abs = (rel: string) => path.join(env.storageDir, rel);

/** Firma klasöründeki dosyalar (klasörler sayılmaz), sıralı. */
function filesUnder(companyId: string): string[] {
  const dir = path.join(env.storageDir, companyId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort();
}

async function createMeasurement(auth: Auth, over: Record<string, unknown> = {}) {
  const p = measurementPayload(over, 1);
  const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement as { id: string; trackingNo: string; trackingRaw: string };
}

function patchMultipart(data: Record<string, unknown>, photos: number) {
  const parts: Part[] = [{ name: 'data', value: JSON.stringify(data) }];
  for (let i = 0; i < photos; i++) parts.push({ name: 'photos', filename: `n${i}.jpg`, contentType: 'image/jpeg', data: JPEG });
  return multipart(parts);
}

const warnings = () => {
  const calls: unknown[] = [];
  return { calls, log: { warn: (obj: unknown) => void calls.push(obj) } };
};

describe('Y147: düşen ölçüm kaydının fotoğrafı', () => {
  it('düzeltme 409 ile düşerse yeni fotoğraf diskten silinir; eski sürümün fotoğrafı yerinde kalır', async () => {
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const a = await createMeasurement(worker.auth);
    const b = await createMeasurement(worker.auth);
    const before = filesUnder(admin.companyId);
    expect(before).toHaveLength(2);

    // a'nın takip numarası b'ninkine çevrilemez: işlem kilit altında 409 ile düşer (fotoğraf o anda diske yazılmıştır)
    const form = patchMultipart({ trackingRaw: b.trackingRaw, photoKinds: ['PHOTO_LABEL'] }, 1);
    const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${a.id}`, headers: { ...worker.auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe('TRACKING_IN_USE');

    expect(filesUnder(admin.companyId)).toEqual(before);
    const rows = await inCompany(admin.companyId, () => prisma.file.findMany({ where: { companyId: admin.companyId }, select: { path: true } }));
    expect(rows).toHaveLength(2);
    for (const f of rows) expect(fs.existsSync(abs(f.path)), f.path).toBe(true);
  });

  it('düzeltme başarılıysa yeni fotoğraf kalır (temizlik yalnız düşen işlemde)', async () => {
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const a = await createMeasurement(worker.auth);
    const form = patchMultipart({ weightKg: 5, photoKinds: ['PHOTO_LABEL'] }, 1);
    const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${a.id}`, headers: { ...worker.auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBe(200);
    // ilk kaydın fotoğrafı + düzeltmede eklenen; korunan fotoğraf aynı yolu paylaşır (yeni dosya yazılmaz)
    expect(filesUnder(admin.companyId)).toHaveLength(2);
  });

  it('discardUnsavedPhotos: bir File satırının gösterdiği yol silinmez, sahipsiz yol silinir, yok olan yol sorun değil', async () => {
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    await createMeasurement(worker.auth);
    const [kept] = await inCompany(admin.companyId, () => prisma.file.findMany({ where: { companyId: admin.companyId }, select: { path: true } }));
    const orphan = await storeBuffer(admin.companyId, JPEG, 'jpg');
    const gone = `${admin.companyId}/2000-01/yok.jpg`;
    expect(fs.existsSync(abs(orphan.path))).toBe(true);

    const w = warnings();
    await inCompany(admin.companyId, () => discardUnsavedPhotos([kept!.path, orphan.path, gone], w.log));
    expect(fs.existsSync(abs(kept!.path))).toBe(true);
    expect(fs.existsSync(abs(orphan.path))).toBe(false);
    expect(w.calls).toEqual([]);

    // boş liste veritabanına gitmez, hiçbir şey yapmaz
    await discardUnsavedPhotos([], w.log);
    expect(w.calls).toEqual([]);
  });
});
