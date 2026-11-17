import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { sha256 } from '../src/lib/crypto.ts';
import { API, getApp, login, parseSetCookies, PASSWORD, randomIp, registerOrg, webHeaders } from './helpers.ts';

/**
 * KALANLAR 6.8: yenilemenin tekrar anahtarı. Süreye bağlı tolerans (`REFRESH_REUSE_GRACE_SECONDS`) dolduktan sonra gelen kayıp
 * yanıt tekrarı (telefon dakikalarca ağsız kaldı, uygulama yeni jetonu depoya yazamadan kapandı) eskiden hırsızlık sayılıyor,
 * çalışan oturumdan atılıyordu. İstemci her yenilemeden önce rastgele bir anahtar üretip eski jetonla birlikte saklar ve gönderir;
 * aynı eski jeton AYNI anahtarla gelirse ve yeni jeton henüz kullanılmadıysa süre sınırı yoktur. Anahtarı bilmeyen (jetonun eski
 * kopyasını tutan) için kural değişmez: pencere dışında hırsızlık, yeni jeton kullanıldıysa her zaman hırsızlık.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
// Pencere açıkça 10 sn: testler "pencere dışı"nı 90 sn ve üstüyle kurar. Önceki değer geri konur.
let savedGrace: string | undefined;
beforeEach(() => {
  savedGrace = process.env.REFRESH_REUSE_GRACE_SECONDS;
  process.env.REFRESH_REUSE_GRACE_SECONDS = '10';
});
afterEach(() => {
  if (savedGrace === undefined) delete process.env.REFRESH_REUSE_GRACE_SECONDS;
  else process.env.REFRESH_REUSE_GRACE_SECONDS = savedGrace;
});

const newKey = () => randomBytes(32).toString('hex');
const refresh = (refreshToken: string, retryKey?: string) =>
  app.inject({
    method: 'POST',
    url: `${API}/auth/refresh`,
    remoteAddress: randomIp(),
    payload: retryKey === undefined ? { refreshToken } : { refreshToken, retryKey },
  });

/** Döndürülmüş satırı geçmişe iter (sahte saat yerine veritabanındaki zaman). */
async function age(refreshToken: string, seconds: number) {
  await prisma.session.update({ where: { refreshHash: sha256(refreshToken) }, data: { rotatedAt: new Date(Date.now() - seconds * 1000) } });
}

const liveRows = (personId: string) => prisma.session.count({ where: { personId, rotatedAt: null, revokedAt: null } });
const reuseTraces = (personId: string) => prisma.auditLog.findMany({ where: { actorPersonId: personId, action: 'session.reuse_detected' } });
const retryTraces = (personId: string) => prisma.auditLog.findMany({ where: { actorPersonId: personId, action: 'session.retry_accepted' } });

describe('6.8: aynı tekrar anahtarıyla gelen eski jeton süreden bağımsız kabul edilir', () => {
  it('yanıt kayboldu, telefon 2 dk sonra aynı jeton ve anahtarla dener: oturum sürer, hırsızlık izi yazılmaz', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    expect((await refresh(owner.refreshToken, key)).statusCode).toBe(200); // yanıt kayboldu
    await age(owner.refreshToken, 120);
    const retry = await refresh(owner.refreshToken, key);
    expect(retry.statusCode, retry.body).toBe(200);
    const next = retry.json().refreshToken as string;
    expect(next).toBeTruthy();
    // Zincir olağan biçimde sürer: yeni jeton (yeni anahtarla) döner, eski jeton artık hırsızlıktır.
    const after = await refresh(next, newKey());
    expect(after.statusCode).toBe(200);
    expect(await reuseTraces(owner.personId)).toHaveLength(0);
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: { not: null } } })).toBe(0);
    expect(await liveRows(owner.personId)).toBe(1);
    // Pencere dışında anahtarla geçen tekrar izlenir: tek kayıt, süresiyle, kişi düzeyinde.
    const traces = await retryTraces(owner.personId);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.orgId).toBeNull();
    expect((traces[0]?.meta as { ageSeconds: number }).ageSeconds).toBeGreaterThanOrEqual(120);
  });

  it('pencere içindeki tekrar ve olağan yenileme "tekrarla tamamlandı" izi yazmaz', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    await refresh(owner.refreshToken, key);
    const retry = await refresh(owner.refreshToken, key);
    expect(retry.statusCode).toBe(200);
    expect((await refresh(retry.json().refreshToken, newKey())).statusCode).toBe(200);
    expect(await retryTraces(owner.personId)).toHaveLength(0);
  });

  it('uygulama günlerce kapalı kaldı (yeni jeton depoya yazılamadı): aynı anahtarla açılışta yine geçer', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    await refresh(owner.refreshToken, key);
    await age(owner.refreshToken, 3 * 24 * 3600);
    expect((await refresh(owner.refreshToken, key)).statusCode).toBe(200);
    expect(await reuseTraces(owner.personId)).toHaveLength(0);
  });

  it('birden çok kayıp tekrar: aynı anahtarla her biri geçer, ailede tek baş kalır, kaybolan ara halefler hırsızlıktır', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    const lost1 = (await refresh(owner.refreshToken, key)).json().refreshToken as string;
    await age(owner.refreshToken, 90);
    const lost2 = (await refresh(owner.refreshToken, key)).json().refreshToken as string;
    await age(owner.refreshToken, 300);
    const kept = await refresh(owner.refreshToken, key);
    expect(kept.statusCode, kept.body).toBe(200);
    const head = kept.json().refreshToken as string;
    expect(await liveRows(owner.personId)).toBe(1);
    const headRow = await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(head) } });
    expect(headRow.parentId).toBe((await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(owner.refreshToken) } })).id);
    expect([lost1, lost2].every((t) => t !== head)).toBe(true);
    expect((await refresh(lost2)).statusCode).toBe(401);
    expect((await refresh(head)).statusCode).toBe(401);
  });

  it('aynı jeton ve anahtarla eşzamanlı tekrarlar pencere dışında da sıraya girer: hepsi geçer, tek baş', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    await refresh(owner.refreshToken, key);
    await age(owner.refreshToken, 120);
    const results = await Promise.all([1, 2, 3].map(() => refresh(owner.refreshToken, key)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await liveRows(owner.personId)).toBe(1);
    expect(await reuseTraces(owner.personId)).toHaveLength(0);
  });

  it('yeni jeton geldi ama hiç kullanılmadı: anahtarlı tekrar yine geçer, baş döner; elde kalan ilk yeni jeton artık halef değil', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    const first = (await refresh(owner.refreshToken, key)).json().refreshToken as string;
    await age(owner.refreshToken, 120);
    const again = await refresh(owner.refreshToken, key);
    expect(again.statusCode).toBe(200);
    // Elde kalan `first` artık halef değil: kullanılırsa aile düşer (istemci anahtarlı tekrar yanıtını yazar, ilkini değil).
    expect((await refresh(first)).statusCode).toBe(401);
  });
});

describe('6.8: anahtar güvenliği zayıflatmaz', () => {
  it('yeni jeton kullanıldıktan sonra eski jeton doğru anahtarla da hırsızlıktır: aile düşer, iz yazılır', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    const second = (await refresh(owner.refreshToken, key)).json().refreshToken as string;
    expect((await refresh(second, newKey())).statusCode).toBe(200);
    const replay = await refresh(owner.refreshToken, key);
    expect(replay.statusCode).toBe(401);
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: null } })).toBe(0);
    const [trace] = await reuseTraces(owner.personId);
    expect(trace?.meta).toMatchObject({ successorUsed: true, retryKey: true });
  });

  it('pencere dışında anahtarsız ya da yanlış anahtarla gelen eski jeton hırsızlıktır (eski kopya)', async () => {
    for (const wrong of [undefined, newKey()]) {
      const owner = await registerOrg(app);
      await refresh(owner.refreshToken, newKey());
      await age(owner.refreshToken, 120);
      expect((await refresh(owner.refreshToken, wrong)).statusCode).toBe(401);
      expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: null } })).toBe(0);
      const [trace] = await reuseTraces(owner.personId);
      expect(trace?.meta).toMatchObject({ successorUsed: false, retryKey: wrong !== undefined });
    }
  });

  it('anahtarsız yenilemenin tekrarına sonradan uydurulan anahtar süre kazandırmaz', async () => {
    const owner = await registerOrg(app);
    await refresh(owner.refreshToken); // eski istemci: anahtar yok
    await age(owner.refreshToken, 120);
    expect((await refresh(owner.refreshToken, newKey())).statusCode).toBe(401);
  });

  it('hırsız eski jetonu pencere içinde anahtarsız kullandıysa meşru sahibin anahtarlı tekrarı pencere dışında aileyi düşürür', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    await refresh(owner.refreshToken, key); // meşru: yanıt kayboldu
    const thief = await refresh(owner.refreshToken); // hırsız: tolerans içinde, anahtarsız
    expect(thief.statusCode).toBe(200);
    await age(owner.refreshToken, 120);
    expect((await refresh(owner.refreshToken, key)).statusCode).toBe(401);
    expect((await refresh(thief.json().refreshToken)).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: null } })).toBe(0);
  });

  it('yeni jetonun satırı süresi dolup kalktıysa (baş yok) anahtarlı eski jeton yine düşer; iz başın yokluğunu ayırır', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    const next = (await refresh(owner.refreshToken, key)).json().refreshToken as string;
    await age(owner.refreshToken, 120);
    await prisma.session.update({ where: { refreshHash: sha256(next) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await refresh(owner.refreshToken, key)).statusCode).toBe(401);
    const [trace] = await reuseTraces(owner.personId);
    expect(trace?.meta).toMatchObject({ successorUsed: false, retryKey: true, headMissing: true });
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: null } })).toBe(0);
  });

  it('baş varken düşen anahtarlı tekrarın izi başın yokluğunu söylemez', async () => {
    const owner = await registerOrg(app);
    await refresh(owner.refreshToken, newKey());
    await age(owner.refreshToken, 120);
    expect((await refresh(owner.refreshToken, newKey())).statusCode).toBe(401);
    const [trace] = await reuseTraces(owner.personId);
    expect(trace?.meta).toMatchObject({ headMissing: false, retryKey: true });
  });

  it('web oturumunda anahtar yok sayılır (hata değil): özet yazılmaz, pencere dışı tekrar hırsızlıktır', async () => {
    const owner = await registerOrg(app);
    const cookies = parseSetCookies(await login(app, owner.email as string, PASSWORD, 'web'));
    const old = cookies.sod_rt.value;
    const key = newKey();
    const webRefresh = () =>
      app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(`sod_rt=${old}`), payload: { retryKey: key } });
    const first = await webRefresh();
    expect(first.statusCode).toBe(200);
    const next = parseSetCookies(first).sod_rt.value;
    expect((await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(next) } })).retryKeyHash).toBeNull();
    await age(old, 120);
    expect((await webRefresh()).statusCode).toBe(401);
    const webFamily = (await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(old) } })).familyId;
    expect(await prisma.session.count({ where: { familyId: webFamily, revokedAt: null } })).toBe(0);
    const [trace] = await reuseTraces(owner.personId);
    expect(trace?.meta).toMatchObject({ retryKey: false });
  });

  it('anahtar ailenin üst yaşını aşamaz: süre dolunca oturum biter (hırsızlık değil)', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    await refresh(owner.refreshToken, key);
    const row = await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(owner.refreshToken) } });
    await prisma.session.updateMany({ where: { familyId: row.familyId }, data: { familyCreatedAt: new Date(Date.now() - 400 * 24 * 3600_000) } });
    expect((await refresh(owner.refreshToken, key)).statusCode).toBe(401);
    expect(await prisma.auditLog.count({ where: { actorPersonId: owner.personId, action: 'session.expired' } })).toBe(1);
    expect(await reuseTraces(owner.personId)).toHaveLength(0);
  });

  it('veritabanında anahtarın kendisi değil özeti durur', async () => {
    const owner = await registerOrg(app);
    const key = newKey();
    const next = (await refresh(owner.refreshToken, key)).json().refreshToken as string;
    const row = await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(next) } });
    expect(row.retryKeyHash).toBe(sha256(key));
  });

  it('biçimsiz anahtar 400: kısa, uzun ya da izin dışı karakter', async () => {
    const owner = await registerOrg(app);
    for (const bad of ['kisa', 'x'.repeat(129), `${'a'.repeat(40)}!`]) {
      expect((await refresh(owner.refreshToken, bad)).statusCode).toBe(400);
    }
    // Jeton harcanmadı.
    expect((await refresh(owner.refreshToken, newKey())).statusCode).toBe(200);
  });
});
