import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createTestAuthority, type TestAuthority, type TestTokenInput } from '@sellerondata/auth-kit/testing';
import type { PlatformEvent } from '@sellerondata/contracts';
import { buildApp } from '../src/app.ts';
import { prisma, withCompany } from '../src/db.ts';
import { SEED_COMPANY, SEED_MEMBERS } from '../src/seed.ts';
import { LEGACY_EDGE_TOL_CM } from '../src/lib/settings.ts';

export const SAMPLES = path.resolve(import.meta.dirname, '../../../samples');
export const samplesExist = fs.existsSync(path.join(SAMPLES, 'expected.json'));

let authorityPromise: Promise<TestAuthority> | null = null;
/** Hesap'ın yerine geçen sahte yetkili: anahtar üretir, jeton basar, JWKS'i `fetch` sahtesiyle sunar. */
export function getAuthority() {
  authorityPromise ??= createTestAuthority();
  return authorityPromise;
}

let appPromise: Promise<FastifyInstance> | null = null;
export function getApp() {
  appPromise ??= getAuthority().then(async (authority) => {
    const a = await buildApp({ identity: authority.authOptions });
    await a.ready();
    return a;
  });
  return appPromise;
}

export type Part =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; data: Buffer };

export function multipart(parts: Part[]) {
  const boundary = `----deciship${crypto.randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(p.data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Smallest valid JPEG-ish payload (content is not decoded by the API). */
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export function uniq(prefix: string) {
  // Takip no olarak kullanılır: rakamsız (yalnız a-f) çıkarsa BAD_TRACKING olur; rakam içerene kadar yeniden üretilir.
  let hex = crypto.randomBytes(4).toString('hex');
  while (!/\d/.test(hex)) hex = crypto.randomBytes(4).toString('hex');
  return `${prefix}${hex}`;
}

export type Identity = {
  companyId: string;
  orgName: string;
  userId: string;
  personId: string;
  name: string;
  role: string;
  /** Jetondaki izin listesi (`ProductClaim.perms`; özel rol). Yoksa eski biçim jeton: izinler rolden türer. */
  perms?: string[];
  epoch: number;
  accessToken: string;
  auth: { authorization: string };
  /** Aynı üyelik için yeni jeton (ör. rol değişti, epoch arttı). */
  token: (over?: TestTokenInput) => Promise<{ accessToken: string; auth: { authorization: string } }>;
};

/** Oturum başlığından firmayı bulur: `createWorker(app, admin.auth)` çağrıları eskisi gibi kalsın. */
const identityByHeader = new Map<string, Identity>();

/**
 * Hesap tarafında var sayılan bir üyelik için jeton üretir. Yerel kayıt JIT ile ilk istekte açılır.
 * `perms` verilirse jeton özel rol biçimindedir (`ProductClaim.perms`): izinler rol adından değil bu listeden.
 */
export async function issueIdentity(
  input: { companyId?: string; orgName?: string; role?: string; perms?: string[]; name?: string; epoch?: number; userId?: string; personId?: string } = {},
) {
  const authority = await getAuthority();
  const companyId = input.companyId ?? crypto.randomUUID();
  const userId = input.userId ?? crypto.randomUUID();
  const personId = input.personId ?? crypto.randomUUID();
  const orgName = input.orgName ?? 'Test Şirketi';
  const name = input.name ?? 'Test Kişi';
  const role = input.role ?? 'ADMIN';
  const epoch = input.epoch ?? 0;
  const token = async (over: TestTokenInput = {}) => {
    const accessToken = await authority.accessToken({
      orgId: companyId,
      orgName,
      membershipId: userId,
      personId,
      name,
      role,
      ...(input.perms ? { perms: input.perms } : {}),
      epoch,
      orgRole: role === 'ADMIN' ? 'OWNER' : 'MEMBER',
      ...over,
    });
    return { accessToken, auth: authority.bearer(accessToken) };
  };
  const issued = await token();
  const identity: Identity = { companyId, orgName, userId, personId, name, role, ...(input.perms ? { perms: input.perms } : {}), epoch, ...issued, token };
  identityByHeader.set(issued.auth.authorization, identity);
  return identity;
}

/**
 * Yeni firma ve yöneticisi. İlk istek JIT ile yerel kayıtları açar.
 * Tartı okuması (`scaleAiRead`) gerçek firmada varsayılan kapalıdır (kullanıcı kararı 2026-11-12). Sınama firması onu açık
 * kurar: tartı okumasının ücretli yolunu (kota, hız sınırı, kesilme) sınayan eski testler bu firmayla koşar. Gerçek
 * varsayılanı sınayan test `{ realDefaults: true }` verir (`test/scaleAiSetting.test.ts`).
 * Firma bilgileri de Merkez'de onaylı kurulur (`companyConfirmed: true`, Merkez'in onay olayı gelmiş gibi): kurulumu sınayan
 * eski testler DeciShip adımlarını ölçer, Merkez onayını değil. Gerçek yeni firma onaysız açılır; onu sınayan test
 * `{ realDefaults: true }` verir (`test/onboarding.test.ts`).
 */
export async function registerCompany(app: FastifyInstance, name = 'Test Şirketi', opts: { realDefaults?: boolean } = {}) {
  const identity = await issueIdentity({ orgName: name, role: 'ADMIN', name: 'Yönetici Test' });
  const me = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: identity.auth });
  if (me.statusCode !== 200) throw new Error(`JIT failed ${me.statusCode} ${me.body}`);
  if (!opts.realDefaults) {
    await withCompany(identity.companyId, async () => {
      const c = await prisma.company.findFirstOrThrow({ where: { id: identity.companyId } });
      // edgeTolCm: testler 1 cm kenar toleransıyla yazıldı; yeni firmanın varsayılanı 0,5 (KALANLAR 1.10, `realDefaults` sınar)
      await prisma.company.update({
        where: { id: identity.companyId },
        data: { settings: { ...((c.settings as object | null) ?? {}), scaleAiRead: true, companyConfirmed: true, edgeTolCm: LEGACY_EDGE_TOL_CM } },
      });
    });
  }
  return { ...identity, user: { id: identity.userId } };
}

export async function createMember(app: FastifyInstance, adminAuth: { authorization: string }, role: string, name = 'Çalışan Test') {
  const admin = identityByHeader.get(adminAuth.authorization);
  if (!admin) throw new Error('Bu oturum başlığı registerCompany ile üretilmedi');
  const identity = await issueIdentity({ companyId: admin.companyId, orgName: admin.orgName, role, name });
  const me = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: identity.auth });
  if (me.statusCode !== 200) throw new Error(`JIT failed ${me.statusCode} ${me.body}`);
  return identity;
}

/** Eski "çalışan": ölçüm yapar, fiyat görmez. */
export function createWorker(app: FastifyInstance, adminAuth: { authorization: string }) {
  return createMember(app, adminAuth, 'MEASURE');
}

/**
 * Testin veritabanına doğrudan bakması için firma bağlamı (RLS). Oturum başlığı ya da firma kimliği alır.
 */
export function inCompany<T>(who: { authorization: string } | string, work: () => PromiseLike<T> | T): Promise<T> {
  const companyId = typeof who === 'string' ? who : identityByHeader.get(who.authorization)?.companyId;
  if (!companyId) throw new Error('Bu oturum başlığı issueIdentity ile üretilmedi');
  return withCompany(companyId, work);
}

/**
 * Firmanın saat dilimini doğrudan yazar. Tek yazarı Merkez'dir (`org.updated`); `PATCH /settings` kabul etmez (Y131).
 * Olayın kabul ettiği listede olmayan adlar (ör. `Asia/Kolkata`, `Pacific/Kiritimati`) da bununla kurulur.
 */
export function writeTimeZone(companyId: string, timeZone: string): Promise<void> {
  return withCompany(companyId, async () => {
    const c = await prisma.company.findFirstOrThrow({ where: { id: companyId } });
    await prisma.company.update({ where: { id: companyId }, data: { settings: { ...((c.settings as object | null) ?? {}), timeZone } } });
  });
}

/** Geliştirme tohumundaki üyelik için jeton (Hesap tohumuyla aynı kimlikler). Varsayılan: yönetici. */
export function seedIdentity(role: (typeof SEED_MEMBERS)[number]['role'] = 'ADMIN') {
  const m = SEED_MEMBERS.find((x) => x.role === role)!;
  return issueIdentity({ companyId: SEED_COMPANY.id, orgName: SEED_COMPANY.name, userId: m.id, personId: m.personId, name: m.name, role: m.role });
}

/** Hesap'tan gelmiş gibi olay gönderir. */
export async function sendEvent(app: FastifyInstance, event: PlatformEvent) {
  const authority = await getAuthority();
  const token = await authority.eventToken(event);
  return app.inject({ method: 'POST', url: '/api/deciship/internal/events', payload: { token } });
}

export function measurementPayload(over: Record<string, unknown> = {}, photos = 1) {
  const data = {
    clientId: crypto.randomUUID(),
    trackingRaw: uniq('7948'),
    lengthCm: 40,
    widthCm: 30,
    heightCm: 25,
    weightKg: 4,
    dimMethod: 'MANUAL',
    weightMethod: 'MANUAL',
    measuredAt: new Date().toISOString(),
    photoKinds: Array.from({ length: photos }, (_, i) => (i === 0 ? 'PHOTO_BOX' : 'PHOTO_SCALE')),
    ...over,
  };
  const parts: Part[] = [{ name: 'data', value: JSON.stringify(data) }];
  for (let i = 0; i < photos; i++) parts.push({ name: 'photos', filename: `p${i}.jpg`, contentType: 'image/jpeg', data: JPEG });
  return { data, ...multipart(parts) };
}

/** Uygulamanın `stripMoney` deseninden bağımsız ve ondan geniş: orada unutulan bir sözcük burada yakalanır. */
const FORBIDDEN = /price|pricing|amount|expected|diff|net|billed|overcharge|cost|charge|fee|fx|rate|totals|.total$/i;
export function findMoneyKeys(value: unknown, pathPrefix = '$'): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) value.forEach((v, i) => found.push(...findMoneyKeys(v, `${pathPrefix}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.test(k)) found.push(`${pathPrefix}.${k}`);
      found.push(...findMoneyKeys(v, `${pathPrefix}.${k}`));
    }
  }
  return found;
}
