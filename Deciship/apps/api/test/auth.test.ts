import crypto from 'node:crypto';
import { TEST_ORIGIN } from '@sellerondata/auth-kit/testing';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { companyFixture } from './fixtures.ts';
import { createWorker, getApp, getAuthority, inCompany, issueIdentity, registerCompany, sendEvent } from './helpers.ts';

describe('kimlik', () => {
  it('tanınmayan üye: ilk istekte firma varsayılan ayar ve kolilerle, üye jetondaki alanlarla açılır', async () => {
    const app = await getApp();
    const reg = await registerCompany(app, 'Kayıt Şirketi');
    const me = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: reg.auth });
    expect(me.statusCode).toBe(200);
    expect(me.json().member).toEqual({ id: reg.userId, name: 'Yönetici Test' });
    expect(me.json().company).toMatchObject({ id: reg.companyId, name: 'Kayıt Şirketi', settings: { desiDivisor: 3000, requiredBoxPhotos: 1, amountTol: 5 } });
    const presets = await app.inject({ method: 'GET', url: '/api/deciship/box-presets', headers: reg.auth });
    expect(presets.json().items.map((p: { name: string }) => p.name)).toEqual(['K1', 'K2', 'K3']);
    const row = await inCompany(reg.auth, () => prisma.member.findFirstOrThrow({ where: { id: reg.userId } }));
    expect(row).toMatchObject({ companyId: reg.companyId, personId: reg.personId, role: 'ADMIN', active: true, epoch: 0 });
    expect(row.lastSeenAt).toBeInstanceOf(Date);
  });

  it('eski kimlik uçları yok: giriş, kayıt, yenileme, kullanıcı yönetimi', async () => {
    const app = await getApp();
    const reg = await registerCompany(app);
    for (const [method, url] of [
      ['POST', '/api/deciship/auth/login'],
      ['POST', '/api/deciship/auth/register'],
      ['POST', '/api/deciship/auth/refresh'],
      ['POST', '/api/deciship/auth/logout'],
      ['GET', '/api/deciship/users'],
      ['POST', '/api/deciship/users'],
      ['PATCH', `/api/deciship/users/${reg.userId}`],
      ['POST', `/api/deciship/users/${reg.userId}/password`],
      // öneksiz eski yollar da kalmadı
      ['POST', ['/api', 'auth', 'login'].join('/')],
      ['GET', ['/api', 'me'].join('/')],
      ['GET', ['/api', 'health'].join('/')],
    ] as const) {
      const r = await app.inject({ method, url, headers: reg.auth, payload: method === 'GET' ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('ölçüm rolü /me içinde yalnız ölçüm ayarlarını görür; WORKER_WEB_FORBIDDEN yok', async () => {
    const app = await getApp();
    const reg = await registerCompany(app);
    const worker = await createWorker(app, reg.auth);
    const me = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: worker.auth });
    expect(me.statusCode).toBe(200);
    expect(Object.keys(me.json().company.settings).sort()).toEqual(['desiDivisor', 'requiredBoxPhotos', 'scaleAiRead', 'warnEdgeCm', 'warnWeightKg']);
  });

  it('jeton şartları: oturum yok, firma yok, ürün yok, bilinmeyen rol', async () => {
    const app = await getApp();
    const authority = await getAuthority();
    const none = await app.inject({ method: 'GET', url: '/api/deciship/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('UNAUTHORIZED');
    const bad = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: { authorization: 'Bearer abc' } });
    expect(bad.statusCode).toBe(401);
    const missing = await app.inject({ method: 'GET', url: '/api/deciship/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');

    const noOrg = await authority.accessToken({ orgId: null });
    const orgRes = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: authority.bearer(noOrg) });
    expect(orgRes.statusCode).toBe(403);
    expect(orgRes.json().error.code).toBe('ORG_REQUIRED');

    const noProduct = await authority.accessToken({ orgId: crypto.randomUUID(), membershipId: crypto.randomUUID(), role: null });
    const prodRes = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: authority.bearer(noProduct) });
    expect(prodRes.statusCode).toBe(403);
    expect(prodRes.json().error.code).toBe('NO_PRODUCT_ACCESS');

    // katalogda olmayan rol hiçbir izin vermez
    const unknown = await issueIdentity({ role: 'UYDURMA' });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/dashboard', headers: unknown.auth })).statusCode).toBe(403);
  });

  it('çerezli oturum: okuma çalışır, yazma CSRF başlığı ve izinli köken ister; hata Accept-Language ile gelir', async () => {
    const app = await getApp();
    const authority = await getAuthority();
    const reg = await registerCompany(app);
    const read = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: authority.cookie(reg.accessToken) });
    expect(read.statusCode).toBe(200);
    const payload = { desiDivisor: 4000 };
    const noCsrf = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: { ...authority.cookie(reg.accessToken), 'accept-language': 'en' }, payload });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toEqual({ code: 'CSRF_FAILED', message: 'The request could not be verified. Reload the page and try again.' });
    const badOrigin = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: authority.cookie(reg.accessToken, { write: true, origin: 'https://kotu.example' }), payload });
    expect(badOrigin.json().error.code).toBe('CSRF_FAILED');
    const ok = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: authority.cookie(reg.accessToken, { write: true, origin: TEST_ORIGIN }), payload });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().desiDivisor).toBe(4000);
  });

  it('CORS yalnız izinli kökene açıktır: oturum çerezi başka siteden okunamaz', async () => {
    const app = await getApp();
    const allowed = await app.inject({ method: 'GET', url: '/api/deciship/health', headers: { origin: TEST_ORIGIN } });
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    const other = await app.inject({ method: 'GET', url: '/api/deciship/health', headers: { origin: 'https://kotu.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('req.auth iş kodu adlarını da taşır: userId = membershipId, companyId = orgId', async () => {
    const authority = await getAuthority();
    const local = await buildApp({ identity: authority.authOptions });
    local.get('/api/deciship/_auth', { onRequest: local.authenticate }, async (req) => req.auth);
    await local.ready();
    const reg = await issueIdentity({ role: 'ADMIN' });
    const r = await local.inject({ method: 'GET', url: '/api/deciship/_auth', headers: reg.auth });
    expect(r.json()).toMatchObject({ companyId: reg.companyId, userId: reg.userId, orgId: reg.companyId, membershipId: reg.userId });
    await local.close();
  });

  it('dosya bağlantısı: çerezli oturumda imza yok, Bearer oturumunda dosyaya ve kişiye bağlı; üyelik değişince düşer', async () => {
    const app = await getApp();
    const authority = await getAuthority();
    const f = await companyFixture(app);
    const url = `/api/deciship/measurements/${f.measurement.id}`;

    // web: adres yalın, yetkiyi çerez taşır
    const web = await app.inject({ method: 'GET', url, headers: authority.cookie(f.admin.accessToken) });
    const webPhoto = new URL(web.json().measurement.photos[0].url);
    expect(webPhoto.pathname).toBe(`/api/deciship/files/${f.photoId}`);
    expect(webPhoto.search).toBe('');
    expect((await app.inject({ method: 'GET', url: webPhoto.pathname, headers: authority.cookie(f.admin.accessToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: webPhoto.pathname })).statusCode).toBe(401);

    // mobil: imzalı adres; başka dosyaya geçmez
    const mobile = await app.inject({ method: 'GET', url, headers: f.worker.auth });
    const signed = new URL(mobile.json().measurement.photos[0].url);
    expect(signed.searchParams.get('t')).toBeTruthy();
    const ok = await app.inject({ method: 'GET', url: signed.pathname + signed.search });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(mobile.body).not.toContain('invoiceFile');
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${f.invoiceFileId}${signed.search}` })).statusCode).toBe(404);

    // yetki değişince (epoch) ve askıda süresi dolmadan düşer
    const bump = await sendEvent(app, { eventId: crypto.randomUUID(), type: 'member.upserted', orgId: f.companyId, product: 'deciship', membershipId: f.worker.userId, personId: f.worker.personId, name: f.worker.name, orgRole: 'MEMBER', role: 'MEASURE', active: true, epoch: 1 });
    expect(bump.json().outcome).toBe('processed');
    expect((await app.inject({ method: 'GET', url: signed.pathname + signed.search })).statusCode).toBe(404);
  });

  it('GET /settings sıfırlama ucunun durumunu söyler; GET /members yalnız kim ve ad', async () => {
    const app = await getApp();
    const reg = await registerCompany(app, 'Üye Listesi');
    const worker = await createWorker(app, reg.auth);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: worker.auth })).json().dataResetEnabled).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/members', headers: worker.auth })).statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/api/deciship/members', headers: reg.auth });
    expect(list.json()).toEqual({ items: [{ id: worker.userId, name: 'Çalışan Test' }, { id: reg.userId, name: 'Yönetici Test' }] });
    const other = await registerCompany(app, 'Başka Firma');
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/deciship/members', headers: other.auth })).json())).not.toContain(worker.userId);
  });

  it('firma adı Merkez\'den gelir: PATCH /settings ad kabul etmez', async () => {
    const app = await getApp();
    const reg = await registerCompany(app, 'Asıl Ad');
    const r = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: reg.auth, payload: { name: 'Başka Ad' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
    const settings = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: reg.auth });
    expect(settings.json().name).toBe('Asıl Ad');
  });
});
