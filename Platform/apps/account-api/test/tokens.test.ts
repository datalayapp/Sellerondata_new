import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, SignJWT, decodeProtectedHeader, jwtVerify, createLocalJWKSet, exportJWK } from 'jose';
import { permissionsOf } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { generateSigningJwk, keys, loadKeyStore, rotateDevKey } from '../src/lib/keys.ts';
import { parseProductLaunch } from '../src/lib/launch.ts';
import { productAccessFor } from '../src/lib/productAccess.ts';
import { buildProductClaims } from '../src/lib/sessions.ts';
import { signEventToken } from '../src/lib/tokens.ts';
import { assertProductionConfig } from '../src/env.ts';
import { addMember, API, bearer, claimsOf, errorCode, getApp, login, randomIp, registerOrg } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const API_ROOT = path.resolve(import.meta.dirname, '..');

describe('jeton alanları', () => {
  it('sözleşmedeki tüm alanlar, doğru ömür ve başlık', async () => {
    const owner = await registerOrg(app, { name: 'Ali Veli', locale: 'en', orgName: 'Alan Firması' });
    const claims = claimsOf(owner.accessToken);
    expect(claims).toMatchObject({
      iss: 'sellerondata-account',
      aud: 'sellerondata',
      sub: owner.personId,
      name: 'Ali Veli',
      locale: 'en',
      org: owner.orgId,
      orgName: 'Alan Firması',
      mid: owner.membershipId,
      orgRole: 'OWNER',
      ep: 0,
    });
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.jti).toBeTruthy();
    expect(claims.sid).toBeTruthy();
    const header = decodeProtectedHeader(owner.accessToken);
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe('test-key-1');
    // Şifre, e-posta, telefon jetonda yok.
    const raw = Buffer.from(owner.accessToken.split('.')[1], 'base64url').toString();
    expect(raw).not.toContain(owner.email as string);
  });

  it('prod: yalnız rolü VE aboneliği olan ürün', async () => {
    const owner = await registerOrg(app);
    const noRole = await addMember(app, owner.orgId, { deciship: null });
    expect(claimsOf(noRole.accessToken).prod).toEqual({});

    const withRole = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
    expect(Object.keys(claimsOf(withRole.accessToken).prod)).toEqual(['deciship']);

    // Abonelik kalkınca rol tek başına yetmez.
    await prisma.subscription.deleteMany({ where: { orgId: owner.orgId } });
    const res = await login(app, withRole.email as string);
    expect(claimsOf(res.json().accessToken).prod).toEqual({});
    const me = res.json().me.products.find((p: { key: string }) => p.key === 'deciship');
    expect(me).toMatchObject({ subscription: null, role: null, permissions: [] });
  });

  it('prod: hazır olmayan ürün jetona girmez; veritabanına elle yazılsa bile', async () => {
    const owner = await registerOrg(app);
    await prisma.productAccess.create({ data: { membershipId: owner.membershipId, product: 'orderloom', role: 'ADMIN' } });
    await prisma.subscription.create({ data: { orgId: owner.orgId, product: 'orderloom', status: 'ACTIVE', plan: 'early_access' } });
    const res = await login(app, owner.email as string);
    expect(Object.keys(claimsOf(res.json().accessToken).prod)).toEqual(['deciship']);
    const orderloom = res.json().me.products.find((p: { key: string }) => p.key === 'orderloom');
    expect(orderloom).toMatchObject({ available: false, subscription: null, role: null });
  });

  it('prod: katalogda olmayan rol jetona girmez', async () => {
    const owner = await registerOrg(app);
    await prisma.productAccess.update({
      where: { membershipId_product: { membershipId: owner.membershipId, product: 'deciship' } },
      data: { role: 'ESKI_ROL' },
    });
    const res = await login(app, owner.email as string);
    expect(claimsOf(res.json().accessToken).prod).toEqual({});
  });

  it('abonelik durumu jetona yansır; READ_ONLY ve CANCELED durur, saklama bitince düşer', () => {
    const access = [{ product: 'deciship', role: 'ADMIN' }];
    const sub = (status: 'ACTIVE' | 'READ_ONLY' | 'CANCELED', deleteAfter: Date | null = null) => [
      { product: 'deciship', status, plan: 'early_access', limits: { seats: 3 }, deleteAfter },
    ];
    // `perms` (özel roller sözleşmesi): rolün firmadaki izinleri; düzenlenmemiş hazır rolde katalogdaki set.
    expect(buildProductClaims(access, sub('ACTIVE')).deciship).toEqual({
      role: 'ADMIN',
      perms: [...permissionsOf('deciship', 'ADMIN')],
      status: 'ACTIVE',
      plan: 'early_access',
      limits: { seats: 3 },
    });
    expect(buildProductClaims(access, sub('READ_ONLY')).deciship?.status).toBe('READ_ONLY');
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    expect(buildProductClaims(access, sub('CANCELED', future)).deciship?.status).toBe('CANCELED');
    expect(buildProductClaims(access, sub('CANCELED', past)).deciship).toBeUndefined();
    expect(buildProductClaims(access, []).deciship).toBeUndefined();
  });

  it('üyeliği olmayan kişi org null jeton alır, firma uçları ORG_REQUIRED', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await prisma.membership.delete({ where: { id: member.membershipId } });
    const res = await login(app, member.email as string);
    expect(res.statusCode).toBe(200);
    const claims = claimsOf(res.json().accessToken);
    expect(claims).toMatchObject({ org: null, orgName: null, mid: null, orgRole: null, ep: 0, prod: {} });
    const org = await app.inject({ url: `${API}/org`, headers: bearer(res.json().accessToken) });
    expect(org.statusCode).toBe(403);
    expect(errorCode(org)).toBe('ORG_REQUIRED');
    const me = await app.inject({ url: `${API}/me`, headers: bearer(res.json().accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json().activeOrg).toBeNull();
  });

  it('/me sözleşme biçiminde, üç ürün', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({ url: `${API}/me`, headers: owner.headers });
    const me = res.json();
    expect(me.person.id).toBe(owner.personId);
    expect(me.person.emailVerified).toBe(false);
    expect(me.orgs).toHaveLength(1);
    expect(me.activeOrg).toMatchObject({ id: owner.orgId, orgRole: 'OWNER', membershipId: owner.membershipId, currency: 'TRY', country: 'TR' });
    expect(me.products.map((p: { key: string }) => p.key)).toEqual(['deciship', 'orderloom', 'tagpress']);
    const deciship = me.products[0];
    expect(deciship.subscription).toEqual({ status: 'ACTIVE', plan: 'early_access' });
    expect(deciship.role).toBe('ADMIN');
    expect(deciship.permissions).toContain('deciship.settings.manage');
    expect(res.body).not.toContain('passwordHash');
  });
});

describe('Hesap kendi jetonunu sıkı doğrular', () => {
  async function foreignToken(sub: string, sid: string) {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    return new SignJWT({ sid, ep: 0, org: null, prod: {} })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-1' })
      .setIssuer('sellerondata-account')
      .setAudience('sellerondata')
      .setSubject(sub)
      .setJti('x')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
  }

  it('yabancı anahtar, süresi dolmuş, olay jetonu reddedilir', async () => {
    const owner = await registerOrg(app);
    const claims = claimsOf(owner.accessToken);
    const foreign = await foreignToken(owner.personId, claims.sid);
    expect((await app.inject({ url: `${API}/me`, headers: bearer(foreign) })).statusCode).toBe(401);

    const expired = await new SignJWT({ sid: claims.sid, ep: 0, org: null, prod: {} })
      .setProtectedHeader({ alg: 'EdDSA', kid: keys().kid })
      .setIssuer('sellerondata-account')
      .setAudience('sellerondata')
      .setSubject(owner.personId)
      .setJti('x')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(keys().privateKey);
    const res = await app.inject({ url: `${API}/me`, headers: bearer(expired) });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('TOKEN_EXPIRED');

    const event = await signEventToken(
      { eventId: 'e', type: 'org.updated', orgId: owner.orgId, product: 'deciship', name: 'x' },
      new Date(),
    );
    expect((await app.inject({ url: `${API}/me`, headers: bearer(event) })).statusCode).toBe(401);
  });

  it('başka kişinin oturum kimliğiyle basılmış jeton geçmez', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const forged = await new SignJWT({ sid: claimsOf(a.accessToken).sid, ep: 0, org: b.orgId, prod: {} })
      .setProtectedHeader({ alg: 'EdDSA', kid: keys().kid })
      .setIssuer('sellerondata-account')
      .setAudience('sellerondata')
      .setSubject(b.personId)
      .setJti('x')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(keys().privateKey);
    expect((await app.inject({ url: `${API}/me`, headers: bearer(forged) })).statusCode).toBe(401);
  });
});

describe('JWKS ve anahtar yönetimi', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sod-keys-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('JWKS açık anahtar yayınlar, özel alan yok, jeton onunla doğrulanır', async () => {
    const res = await app.inject({ url: `${API}/.well-known/jwks.json` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    const body = res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'test-key-1', alg: 'EdDSA', use: 'sig' });
    expect(body.keys[0].d).toBeUndefined();
    expect(res.body).not.toMatch(/"d"/);

    const owner = await registerOrg(app);
    const { payload } = await jwtVerify(owner.accessToken, createLocalJWKSet(body), { issuer: 'sellerondata-account', audience: 'sellerondata' });
    expect(payload.sub).toBe(owner.personId);
  });

  it('üretimde anahtar yoksa başlamaz', async () => {
    await expect(loadKeyStore({ isProduction: true, keysDir: tmp })).rejects.toThrow(/ACCOUNT_SIGNING_KEY/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('üretimde servis gerçekten çıkar (süreç testi), anahtar içeriği hata metnine girmez', () => {
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        cwd: API_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          APP_BASE_URL: 'http://localhost:8088',
          ALLOWED_ORIGINS: 'http://localhost:8088',
          DATABASE_URL: 'postgresql://sod_platform:gercek-parola@127.0.0.1:1/x',
          ACCOUNT_CODE_PEPPER: 'x'.repeat(40),
          SMTP_URL: 'smtp://mail:25',
          PORT: '0',
          EMAIL_VERIFICATION_REQUIRED: 'true',
          ...extra,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const missing = run({ ACCOUNT_SIGNING_KEY: '' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('ACCOUNT_SIGNING_KEY');

    const broken = run({ ACCOUNT_SIGNING_KEY: '{"kty":"OKP","crv":"Ed25519","d":"gizli-ozel-alan"' });
    expect(broken.status).toBe(1);
    expect(broken.stderr).not.toContain('gizli-ozel-alan');
  });

  it('üretimde ALLOWED_ORIGINS ve APP_BASE_URL zorunlu', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOWED_ORIGINS = '';
      expect(() => assertProductionConfig()).toThrow(/ALLOWED_ORIGINS/);
      process.env.ALLOWED_ORIGINS = 'https://a';
      process.env.APP_BASE_URL = '';
      expect(() => assertProductionConfig()).toThrow(/APP_BASE_URL/);
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      process.env.ALLOWED_ORIGINS = saved.ALLOWED_ORIGINS;
      process.env.APP_BASE_URL = saved.APP_BASE_URL;
    }
  });

  it('geliştirmede anahtarı üretir, sonraki açılışta aynısını okur', async () => {
    const dir = path.join(tmp, 'gelistirme');
    const first = await loadKeyStore({ isProduction: false, keysDir: dir });
    const second = await loadKeyStore({ isProduction: false, keysDir: dir });
    expect(first.kid).toBe(second.kid);
    expect(fs.existsSync(path.join(dir, 'signing-key.jwk.json'))).toBe(true);
    expect(first.publicJwks[0].d).toBeUndefined();
  });

  it('döndürme: yeni kid imzalar, eski anahtar JWKS\'te kalır, eski jeton doğrulanır', async () => {
    const dir = path.join(tmp, 'dondurme');
    const before = await loadKeyStore({ isProduction: false, keysDir: dir });
    const oldToken = await new SignJWT({ a: 1 }).setProtectedHeader({ alg: 'EdDSA', kid: before.kid }).setExpirationTime('10m').sign(before.privateKey);

    const { kid, previousKid } = await rotateDevKey(dir);
    expect(previousKid).toBe(before.kid);
    const after = await loadKeyStore({ isProduction: false, keysDir: dir });
    expect(after.kid).toBe(kid);
    expect(after.kid).not.toBe(before.kid);
    expect(after.publicJwks.map((k) => k.kid)).toEqual([kid, previousKid]);
    expect(after.publicJwks.every((k) => k.d === undefined)).toBe(true);
    await expect(jwtVerify(oldToken, after.verifierKeySet)).resolves.toBeTruthy();
  });

  it('ortamdan anahtar: eski açık anahtarlar yayınlanır, özel alanı olsa da süzülür', async () => {
    const active = await generateSigningJwk();
    const old = await generateSigningJwk();
    const store = await loadKeyStore({
      isProduction: true,
      keysDir: tmp,
      signingKey: JSON.stringify(active),
      previousPublicKeys: JSON.stringify([old]),
    });
    expect(store.kid).toBe(active.kid);
    expect(store.publicJwks.map((k) => k.kid)).toEqual([active.kid, old.kid]);
    expect(JSON.stringify(store.publicJwks)).not.toContain(old.d as string);
    expect(JSON.stringify(store.publicJwks)).not.toContain(active.d as string);
  });

  it('geçersiz anahtarlar reddedilir: kid yok, açık anahtar, yanlış eğri, x ile d uyuşmuyor', async () => {
    const good = await generateSigningJwk();
    const other = await generateSigningJwk();
    const { kid: _k, ...noKid } = good;
    const { d: _d, ...publicOnly } = good;
    const load = (jwk: unknown) => loadKeyStore({ isProduction: true, keysDir: tmp, signingKey: JSON.stringify(jwk) });
    await expect(load(noKid)).rejects.toThrow();
    await expect(load(publicOnly)).rejects.toThrow(/d alanı/);
    await expect(load({ ...good, crv: 'P-256' })).rejects.toThrow();
    await expect(load({ ...good, x: other.x })).rejects.toThrow(/uyuşmuyor/);
    await expect(loadKeyStore({ isProduction: true, keysDir: tmp, signingKey: 'bozuk' })).rejects.toThrow(/JSON/);
  });

  it('Ed25519 dışında anahtar JWKS istemcisine girmez', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    await expect(
      loadKeyStore({ isProduction: true, keysDir: tmp, signingKey: JSON.stringify(jwk) }),
    ).rejects.toThrow();
  });
});

/** `PRODUCT_LAUNCH`'ı geçici değiştirir; `launch.ts` ortamı her okumada okur. */
async function withLaunch<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.PRODUCT_LAUNCH;
  process.env.PRODUCT_LAUNCH = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PRODUCT_LAUNCH;
    else process.env.PRODUCT_LAUNCH = saved;
  }
}

type MeProduct = { key: string; available: boolean; launch?: string; subscription: unknown; role: string | null; permissions: string[] };
const productOf = (me: { products: MeProduct[] }, key: string) => me.products.find((p) => p.key === key) as MeProduct;

describe('çalışırken durum: productAccessFor (jeton ve /me ortak kuralı)', () => {
  const access = [{ product: 'deciship', role: 'ADMIN' }];
  const sub = (status: 'ACTIVE' | 'READ_ONLY' | 'CANCELED' = 'ACTIVE', deleteAfter: Date | null = null) => [
    { product: 'deciship', status, plan: 'early_access', limits: {}, deleteAfter },
  ];
  const deciship = (launch: string, subs: ReturnType<typeof sub> | [], acc = access) =>
    productAccessFor(acc, subs, { overrides: parseProductLaunch(`deciship=${launch}`) }).find((s) => s.key === 'deciship')!;

  it('public: abonelik ve rol varsa jeton; aboneliksiz firmada açık görünür ama jeton, rol yok', () => {
    expect(deciship('public', sub())).toMatchObject({ launch: 'public', available: true, role: 'ADMIN', claim: { role: 'ADMIN', status: 'ACTIVE' } });
    expect(deciship('public', [])).toMatchObject({ launch: 'public', available: true, subscription: null, role: null, claim: null });
  });

  it('pilot: yalnız canlı aboneliği olan firmada açık; aboneliksiz ya da saklaması bitmiş iptalde kapalı', () => {
    expect(deciship('pilot', sub())).toMatchObject({ available: true, role: 'ADMIN', claim: { status: 'ACTIVE' } });
    expect(deciship('pilot', sub('READ_ONLY'))).toMatchObject({ available: true, claim: { status: 'READ_ONLY' } });
    expect(deciship('pilot', [])).toMatchObject({ launch: 'pilot', available: false, subscription: null, role: null, claim: null });
    expect(deciship('pilot', sub('CANCELED', new Date(Date.now() - 1000)))).toMatchObject({ available: false, subscription: null, claim: null });
    expect(deciship('pilot', sub('CANCELED', new Date(Date.now() + 86_400_000)))).toMatchObject({ available: true, claim: { status: 'CANCELED' } });
  });

  it('off: abonelik ve rol olsa da kapalı; abonelik, rol ve jeton yok', () => {
    expect(deciship('off', sub())).toMatchObject({ launch: 'off', available: false, subscription: null, role: null, claim: null });
  });

  it('katalogda olmayan rol: jeton yok, rol null; rolsüz üyede abonelik görünür', () => {
    expect(deciship('public', sub(), [{ product: 'deciship', role: 'ESKI_ROL' }])).toMatchObject({
      role: null,
      claim: null,
      subscription: { status: 'ACTIVE' },
    });
    expect(deciship('public', sub(), [])).toMatchObject({ role: null, claim: null, available: true });
  });

  it('sonuç kayıt sırasıyla bütün ürünler; kayıtta olmayan ürün satırı yok sayılır', () => {
    const unknownSub = { product: 'eskiurun', status: 'ACTIVE' as const, plan: 'p', limits: {}, deleteAfter: null };
    const states = productAccessFor([{ product: 'eskiurun', role: 'ADMIN' }, ...access], [unknownSub, ...sub()], { overrides: new Map() });
    expect(states.map((s) => s.key)).toEqual(['deciship', 'orderloom', 'tagpress']);
    expect(buildProductClaims([{ product: 'eskiurun', role: 'ADMIN' }], [unknownSub])).toEqual({});
  });
});

describe('çalışırken durum: jeton, /me ve /catalog (PRODUCT_LAUNCH)', () => {
  const catalog = () =>
    app.inject({ url: `${API}/catalog` }).then((r) => r.json() as { products: { key: string; available: boolean; launch: string }[] });
  const refresh = (refreshToken: string) =>
    app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken } });

  it('varsayılan: DeciShip public ve ACTIVE, OrderLoom ve TagPress off (mevcut firmalar değişmez)', async () => {
    const owner = await registerOrg(app);
    expect(Object.keys(claimsOf(owner.accessToken).prod)).toEqual(['deciship']);
    const me = (await app.inject({ url: `${API}/me`, headers: owner.headers })).json();
    expect(me.products.map((p: MeProduct) => [p.key, p.launch, p.available])).toEqual([
      ['deciship', 'public', true],
      ['orderloom', 'off', false],
      ['tagpress', 'off', false],
    ]);
    expect(productOf(me, 'deciship')).toMatchObject({ subscription: { status: 'ACTIVE', plan: 'early_access' }, role: 'ADMIN' });
    expect((await catalog()).products.map((p) => [p.key, p.launch, p.available])).toEqual([
      ['deciship', 'public', true],
      ['orderloom', 'off', false],
      ['tagpress', 'off', false],
    ]);
  });

  it("katalogda olmayan rol /me'de de görünmez (jetonla aynı)", async () => {
    const owner = await registerOrg(app);
    await prisma.productAccess.update({
      where: { membershipId_product: { membershipId: owner.membershipId, product: 'deciship' } },
      data: { role: 'ESKI_ROL' },
    });
    const res = await login(app, owner.email as string);
    expect(claimsOf(res.json().accessToken).prod).toEqual({});
    expect(productOf(res.json().me, 'deciship')).toMatchObject({ role: null, permissions: [], subscription: { status: 'ACTIVE' } });
  });

  it("off: aboneliği olan firmada da jetonda, /me'de ve abonelik listesinde ürün yok; geri açılınca döner", async () => {
    const owner = await registerOrg(app);
    await withLaunch('deciship=off', async () => {
      const res = await login(app, owner.email as string);
      expect(claimsOf(res.json().accessToken).prod).toEqual({});
      expect(productOf(res.json().me, 'deciship')).toEqual({
        key: 'deciship',
        available: false,
        launch: 'off',
        subscription: null,
        role: null,
        permissions: [],
      });
      expect(claimsOf((await refresh(res.json().refreshToken)).json().accessToken).prod).toEqual({});
      const subs = await app.inject({ url: `${API}/org/subscriptions`, headers: bearer(res.json().accessToken) });
      expect(subs.statusCode).toBe(200);
      expect(subs.json().subscriptions).toEqual([]);
      expect((await catalog()).products[0]).toMatchObject({ key: 'deciship', available: false, launch: 'off' });
    });
    const back = await login(app, owner.email as string);
    expect(claimsOf(back.json().accessToken).prod.deciship).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
  });

  it('pilot: aboneliği olan firmada açık; aboneliği olmayan firmanın jetonuna hiçbir yoldan girmez', async () => {
    const withSub = await registerOrg(app);
    await withLaunch('deciship=pilot', async () => {
      // Aboneliği olan firma: jeton ve /me aynı.
      const subLogin = await login(app, withSub.email as string);
      expect(claimsOf(subLogin.json().accessToken).prod.deciship).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
      expect(productOf(subLogin.json().me, 'deciship')).toMatchObject({ available: true, launch: 'pilot', role: 'ADMIN' });
      expect((await catalog()).products[0]).toMatchObject({ key: 'deciship', available: false, launch: 'pilot' });

      // Kayıt: pilot ürün otomatik açılmaz, sahibe rol yazılmaz.
      const fresh = await registerOrg(app);
      expect(claimsOf(fresh.accessToken).prod).toEqual({});
      expect(await prisma.subscription.count({ where: { orgId: fresh.orgId } })).toBe(0);
      expect(await prisma.productAccess.count({ where: { membershipId: fresh.membershipId } })).toBe(0);
      const freshMe = (await app.inject({ url: `${API}/me`, headers: fresh.headers })).json();
      expect(productOf(freshMe, 'deciship')).toMatchObject({ available: false, launch: 'pilot', subscription: null, role: null, permissions: [] });

      // Rol veritabanına elle yazılsa da abonelik olmadan jetona girmez: giriş ve yenileme.
      await prisma.productAccess.create({ data: { membershipId: fresh.membershipId, product: 'deciship', role: 'ADMIN' } });
      const freshLogin = await login(app, fresh.email as string);
      expect(claimsOf(freshLogin.json().accessToken).prod).toEqual({});
      expect(productOf(freshLogin.json().me, 'deciship')).toMatchObject({ available: false, role: null });
      expect(claimsOf((await refresh(fresh.refreshToken)).json().accessToken).prod).toEqual({});

      // POST /orgs: aboneliği olan firmanın kişisi yeni firma açar; yeni firmada ürün yok.
      const created = await app.inject({
        method: 'POST',
        url: `${API}/orgs`,
        remoteAddress: randomIp(),
        headers: withSub.headers,
        payload: { name: 'Pilot Dışı Firma', country: 'TR' },
      });
      expect(created.statusCode).toBe(201);
      const newOrgId = created.json().activeOrgId as string;
      expect(claimsOf(created.json().accessToken).prod).toEqual({});
      expect(await prisma.subscription.count({ where: { orgId: newOrgId } })).toBe(0);

      // Firma değiştirme: aboneliği olan firmaya dönünce ürün gelir, aboneliksize geçince gider.
      const switchTo = (orgId: string) =>
        app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: withSub.headers, payload: { orgId } });
      expect(claimsOf((await switchTo(withSub.orgId)).json().accessToken).prod.deciship?.role).toBe('ADMIN');
      expect(claimsOf((await switchTo(newOrgId)).json().accessToken).prod).toEqual({});
    });
  });
});
