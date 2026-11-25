import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import pg from 'pg';
import type { AccessClaims, AuthResponse } from '@sellerondata/contracts';
import { buildApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { signAccessToken } from '../src/lib/tokens.ts';
import { flushMail } from '../src/lib/mailer.ts';
import { SUPER_URL, TEST_DB_NAME, TEST_ORIGIN } from './testEnv.ts';

export const PASSWORD = 'MaviKedi-4729';
export const API = '/api/account';

let appPromise: Promise<FastifyInstance> | null = null;
export function getApp() {
  appPromise ??= buildApp().then(async (a) => {
    await a.ready();
    return a;
  });
  return appPromise;
}

export function uniq(prefix = 'x') {
  return `${prefix}${crypto.randomBytes(5).toString('hex')}`;
}

/** Her çağrıda farklı IP: hız sınırı ilgisiz testleri etkilemesin. */
export function randomIp() {
  return `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
}

export function randomTrPhone() {
  return `+90532${String(crypto.randomInt(0, 10_000_000)).padStart(7, '0')}`;
}

export function randomEmail(prefix = 'kisi') {
  return `${uniq(prefix)}@test.sellerondata.com`;
}

export function claimsOf(token: string): AccessClaims {
  return decodeJwt(token) as unknown as AccessClaims;
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

export type Ctx = {
  accessToken: string;
  refreshToken: string;
  personId: string;
  orgId: string;
  membershipId: string;
  email: string | null;
  phone: string | null;
  headers: { authorization: string };
};

function toCtx(body: AuthResponse, email: string | null, phone: string | null): Ctx {
  const claims = claimsOf(body.accessToken as string);
  return {
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
    personId: claims.sub,
    orgId: claims.org as string,
    membershipId: claims.mid as string,
    email,
    phone,
    headers: bearer(body.accessToken as string),
  };
}

/**
 * Kayıt API'si üzerinden firma + OWNER (mobil oturum). Sınama kişisi Türkçe seçmiş Türk firmasıdır (`locale: 'tr'`, `country: 'TR'`):
 * dil bilgisi gelmeyen kayıt İngilizce açılır (kullanıcı kararı 2026-11-12); o kuralı `auth.test.ts` "ilk açılış dili" sınar.
 */
export async function registerOrg(app: FastifyInstance, over: Record<string, unknown> = {}): Promise<Ctx> {
  const email = (over.email as string) ?? randomEmail('sahip');
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/register`,
    remoteAddress: randomIp(),
    payload: { orgName: `Firma ${uniq()}`, name: 'Sahip Kişi', email, password: PASSWORD, country: 'TR', client: 'mobile', locale: 'tr', ...over },
  });
  if (res.statusCode !== 201) throw new Error(`register ${res.statusCode}: ${res.body}`);
  return toCtx(res.json(), email, null);
}

export async function login(app: FastifyInstance, identifier: string, password = PASSWORD, client: 'web' | 'mobile' = 'mobile') {
  return app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    remoteAddress: randomIp(),
    headers: client === 'web' ? webHeaders() : {},
    payload: { identifier, password, client },
  });
}

/** Mobil oturum kimliği → onun tarayıcı ikizi (test dosyası içinde). */
const webTwins = new Map<string, string>();

/**
 * Mobil jetonun tarayıcı (`web`) oturumlu ikizi. Firma yönetimi yazmaları yalnız tarayıcı oturumunu kabul eder (KARARLAR "Firma
 * yönetimi yalnız tarayıcıdan"); testlerin `Ctx`'i mobil oturumdur. İkiz, mobil jetonun alanlarını (kişi, firma, üyelik, rol, epoch,
 * ürünler) aynen taşır, yalnız `sid` web oturum satırını gösterir: bayat mobil jetonun ikizi de bayattır. Oturum satırı ilk çağrıda
 * veritabanına doğrudan açılır (giriş kovası ve `lastOrgId` değişmesin) ve iptal ile bitiş anı her çağrıda mobil satırdan kopyalanır:
 * mobil oturum düşünce ikizi de düşer.
 */
export async function webTokenFor(mobileToken: string): Promise<string> {
  const { sid, sub, iss: _iss, aud: _aud, iat: _iat, exp: _exp, jti: _jti, ...rest } = claimsOf(mobileToken) as AccessClaims & { jti?: string };
  const mobile = await prisma.session.findUnique({ where: { id: sid }, select: { revokedAt: true, expiresAt: true } });
  const state = { revokedAt: mobile ? mobile.revokedAt : new Date(), expiresAt: mobile?.expiresAt ?? new Date(Date.now() + 30 * 24 * 3600_000) };
  const twinId = webTwins.get(sid);
  let twin = twinId ? await prisma.session.findUnique({ where: { id: twinId } }) : null;
  if (!twin) {
    const now = new Date();
    twin = await prisma.session.create({
      data: {
        personId: sub,
        activeOrgId: rest.org,
        client: 'web',
        familyId: crypto.randomUUID(),
        createdAt: now,
        familyCreatedAt: now,
        refreshHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('base64url'),
        ...state,
      },
    });
    webTwins.set(sid, twin.id);
  } else if (twin.revokedAt?.getTime() !== state.revokedAt?.getTime() || twin.expiresAt.getTime() !== state.expiresAt.getTime()) {
    twin = await prisma.session.update({ where: { id: twin.id }, data: state });
  }
  return signAccessToken(sub, { ...rest, sid: twin.id, fid: twin.familyId });
}

/**
 * Tarayıcının çerezli yazma isteği: `sod_at` çerezi (ikiz jeton), CSRF, izinli `Origin` ve jetonun firması (`X-SOD-Org`). Jeton
 * `ctx.headers`'taki Bearer'dır (testler yenilenen jetonu `{ ...ctx, headers: bearer(yeni) }` diye taşır), yoksa `ctx.accessToken`.
 */
export async function asWeb(ctx: { accessToken: string; headers?: { authorization?: string } }): Promise<Record<string, string>> {
  const fromHeader = /^Bearer\s+(\S+)$/i.exec(ctx.headers?.authorization ?? '')?.[1];
  return cookieWriteHeaders(await webTokenFor(fromHeader ?? ctx.accessToken));
}

export function cookieWriteHeaders(token: string): Record<string, string> {
  const org = claimsOf(token).org;
  return { cookie: `sod_at=${token}`, 'x-sod-csrf': '1', origin: TEST_ORIGIN, ...(org ? { 'x-sod-org': org } : {}) };
}

/**
 * Başlıklardaki mobil Bearer'ı tarayıcı ikiziyle değiştirir, diğer başlıklar (dil gibi) kalır. Bearer yoksa başlıklar aynen döner.
 * Genel istek yardımcılarının (`post(url, headers)`) firma yazmaları için.
 */
export async function webHeadersFrom(headers: Record<string, string>): Promise<Record<string, string>> {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '');
  if (!match?.[1]) return headers;
  const { authorization: _a, ...others } = headers;
  return { ...others, ...cookieWriteHeaders(await webTokenFor(match[1])) };
}

/**
 * Oturum yanıtı veren firma yazmaları (`/org/leave`, `/org/close`, `/org/reopen`) tarayıcı oturumunda jetonu gövdede değil çerezde
 * döner. Testler yeni jetonu gövdeden okur: `sod_at` çerezi gövdeye `accessToken` olarak eklenir (gövdede varsa o kalır).
 */
export function withCookieToken<T extends { json: () => unknown; cookies: { name: string; value: string }[] }>(res: T): T {
  const cookie = res.cookies.find((c) => c.name === 'sod_at')?.value;
  if (!cookie) return res;
  const read = res.json.bind(res);
  res.json = () => {
    const body = read() as Record<string, unknown>;
    return { ...body, accessToken: body.accessToken ?? cookie };
  };
  return res;
}

/** Firma yönetimi yazması mı (`/org`, `/org/*`, okuma olmayan): genel yardımcılar buna göre `webHeadersFrom` uygular. */
export function isOrgWrite(method: string, path: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && /^(\/api\/account)?\/org(\/|$|\?)/.test(path);
}

export function webHeaders(cookie?: string) {
  return { 'x-sod-csrf': '1', origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}) };
}

let cachedHash: Promise<string> | undefined;
function passwordHash() {
  cachedHash ??= hashPassword(PASSWORD);
  return cachedHash;
}

/** Üyeyi doğrudan veritabanına ekleyip API'den girer. Yetki testlerinin hazırlığı için. */
export async function addMember(
  app: FastifyInstance,
  orgId: string,
  over: { orgRole?: 'ADMIN' | 'MEMBER'; deciship?: string | null; email?: string | null; phone?: string | null; personId?: string } = {},
): Promise<Ctx> {
  const email = over.email === undefined ? randomEmail('uye') : over.email;
  const phone = over.phone ?? null;
  const person = over.personId
    ? await prisma.person.findUniqueOrThrow({ where: { id: over.personId } })
    : await prisma.person.create({
        data: { name: `Üye ${uniq()}`, email, phone, passwordHash: await passwordHash() },
      });
  const membership = await prisma.membership.create({
    data: {
      personId: person.id,
      orgId,
      orgRole: over.orgRole ?? 'MEMBER',
      ...(over.deciship ? { productAccess: { create: { product: 'deciship', role: over.deciship } } } : {}),
    },
  });
  await prisma.person.update({ where: { id: person.id }, data: { lastOrgId: orgId } });
  const res = await login(app, (person.email ?? person.phone) as string);
  if (res.statusCode !== 200) throw new Error(`login ${res.statusCode}: ${res.body}`);
  const ctx = toCtx(res.json(), person.email, person.phone);
  return { ...ctx, membershipId: membership.id, orgId };
}

/** Yanıttaki Set-Cookie'leri ad -> { value, attrs } olarak açar. */
export function parseSetCookies(res: { cookies: { name: string; value: string; path?: string; httpOnly?: boolean; sameSite?: string; secure?: boolean; maxAge?: number; domain?: string }[] }) {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c]));
}

export function cookieHeader(cookies: Record<string, { value: string }>) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v.value}`)
    .join('; ');
}

export function errorCode(res: { json: () => unknown }) {
  return (res.json() as { error?: { code?: string } }).error?.code;
}

export async function lastMailTo(to: string) {
  await flushMail();
  return prisma.mailLog.findFirst({ where: { to }, orderBy: { createdAt: 'desc' } });
}

export async function outboxFor(membershipId: string) {
  const rows = await prisma.outbox.findMany({ orderBy: { createdAt: 'asc' }, include: { deliveries: true } });
  return rows.filter((r) => (r.payload as { membershipId?: string }).membershipId === membershipId);
}

export async function epochOf(membershipId: string) {
  return (await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).epoch;
}

/**
 * Zincirleme silmenin tetikleyici sırası kısıt adına (OID) bağlı. Göç sırasıyla kurulan veritabanında üyelik zinciri özel rol
 * zincirinden önce çalışır ve hata çıkmaz; geri yüklenmiş ya da kısıtı yeniden kurulmuş veritabanında sıra tersine döner. Testin
 * veritabanı koşu başına ayrıdır: üyeliğin firma kısıtı aynı tanımla yeniden kurulur, kötü sıra kesinleşir.
 */
export async function recreateMembershipOrgFk() {
  const url = new URL(SUPER_URL);
  url.pathname = `/${TEST_DB_NAME}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query(`
      ALTER TABLE "platform"."Membership" DROP CONSTRAINT "Membership_orgId_fkey";
      ALTER TABLE "platform"."Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "platform"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;`);
  } finally {
    await db.end();
  }
}
