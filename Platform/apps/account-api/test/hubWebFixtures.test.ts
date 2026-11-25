/**
 * Merkez'in kayıtlı gerçek Hesap yanıtları (KALANLAR 6.24): `Platform/apps/hub-web/e2e/fixtures/account-real/*.json`.
 * Bu test Merkez'in çağırdığı Hesap uçlarının gerçek yanıtını üretir ve depodaki kayıtla birebir karşılaştırır; Hesap yanıtı
 * değişince burada kırılır. Merkez tarafında `npm test` sahte API'yi (`src/mocks/handlers.ts`, `test/account-contract.test.mjs`) bu kayda karşı sınar: kayıt
 * yenilenince orada kırılır, sahte API gerçeğe uydurulur. DeciShip'teki eşi `Deciship/apps/api/test/hub/hubWebFixtures.test.ts`.
 *
 * Bilerek yenileme (Platform/apps/account-api, test veritabanı açıkken):
 *   npx vitest run test/hubWebFixtures.test.ts -u
 * sonra `git diff Platform/apps/hub-web/e2e/fixtures/account-real` ile bak ve Merkez'de `npm test` koş.
 *
 * Değişkenler sabit: adlar, e-postalar, telefonlar ve istek IP'leri sabit; kimlikler `<id>`, ISO anlar `<zaman>`, davet kodu
 * `<kod>`, davet bağlantısındaki jeton `<jeton>` yazılır. Sıranın kayıt anına bağlı olduğu listelerde (üyeler, davetler,
 * denetim izi) anlar kurulumdan sonra sabit aralıklarla yeniden yazılır: aynı milisaniyede açılan iki satırın sırası kimliğe
 * kalmasın. Senaryo: sahip (Merkez'e tarayıcıdan girer) + e-postalı yönetici + telefonlu, e-postasız çalışan + özel role alınıp
 * askıya alınan üye + hiçbir araçta rolü olmayan üye; bir e-posta ve bir telefon kodu daveti; bir özel rol. Firmada `pilot`
 * TagPress de açık (`subscription:set`; sahip ve yönetici Yönetici, çalışanlar Kullanıcı). Firmaya bağlı her
 * denetim izinin hedefi doludur (`target: null` yalnız firmasız izlerde: oturum, bakım), kayıtta hedefsiz iz yoktur.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { setSubscription } from '../src/lib/subscriptions.ts';
import { API, PASSWORD, cookieWriteHeaders, getApp, webHeaders } from './helpers.ts';

const OUT = path.resolve(import.meta.dirname, '../../hub-web/e2e/fixtures/account-real');
/** Kurulumdan sonra yeniden yazılan anların tabanı (sıra için; kayıtta `<zaman>`). */
const BASE = Date.parse('2026-11-01T09:00:00.000Z');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const INVITE_TOKEN = /\/invite\/[^/?#\s]+/g;

/**
 * Koşudan koşuya değişen değerler: kimlik (anahtarda ve bağlantıda da), kayıt anı, davet kodu ve bağlantı jetonu. Davet kodu
 * `code` alanıdır; hata gövdesindeki `error.code` sabit hata kodudur, olduğu gibi kalır.
 */
function normalize(value: unknown, key?: string, parent?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'code' && parent !== 'error') return '<kod>';
    if (STAMP.test(value)) return '<zaman>';
    return value.replace(UUID, '<id>').replace(INVITE_TOKEN, '/invite/<jeton>');
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, undefined, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(UUID, '<id>'), normalize(v, k, key)]));
  return value;
}

const OWNER_IP = '203.0.113.10';
const WORKER_IP = '203.0.113.11';
const PREVIEW_IP = '203.0.113.12';
const OWNER = { name: 'Ayşe Yılmaz', email: 'ayse@ornek.test' };
const ADMIN = { name: 'Burak Kaya', email: 'burak@ornek.test' };
const WORKER = { name: 'Mehmet Demir', phone: '+905559871201' };
const SUSPENDED = { name: 'Zeynep Arslan', email: 'zeynep@ornek.test' };
/** Hiçbir araçta rolü olmayan üye: `productRoles` boş nesne. */
const NO_TOOL = { name: 'Selin Koç', email: 'selin@ornek.test' };
const INVITED_EMAIL = { name: 'Can Öztürk', email: 'can@ornek.test' };
const INVITED_PHONE = { name: 'Elif Şahin', phone: '+905559871202' };

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

/** Tarayıcı girişi: gövde ve `sod_at` çerezi (jeton gövdede değil, çerezde). */
async function webLogin(identifier: string, ip: string) {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    remoteAddress: ip,
    headers: { ...webHeaders(), 'accept-language': 'tr' },
    payload: { identifier, password: PASSWORD, client: 'web' },
  });
  expect(res.statusCode, res.body).toBe(200);
  const token = res.cookies.find((c) => c.name === 'sod_at')?.value;
  if (!token) throw new Error('sod_at çerezi yok');
  return { res, token };
}

/** Doğrudan veritabanına üye (helpers `addMember` gibi; ad ve iletişim sabit, giriş yok). */
async function insertMember(orgId: string, who: { name: string; email?: string; phone?: string }, orgRole: 'ADMIN' | 'MEMBER', deciship: string | null, tagpress: string | null = null) {
  const person = await prisma.person.create({
    data: { name: who.name, email: who.email ?? null, phone: who.phone ?? null, locale: 'tr', passwordHash: await hashPassword(PASSWORD) },
  });
  const access = [...(deciship ? [{ product: 'deciship', role: deciship }] : []), ...(tagpress ? [{ product: 'tagpress', role: tagpress }] : [])];
  const membership = await prisma.membership.create({
    data: { personId: person.id, orgId, orgRole, ...(access.length ? { productAccess: { create: access } } : {}) },
  });
  await prisma.person.update({ where: { id: person.id }, data: { lastOrgId: orgId } });
  return membership;
}

describe('Merkez kayıtlı gerçek Hesap yanıtları (hub-web e2e/fixtures/account-real)', () => {
  it('yanıtlar kayıtla aynı (bilerek değişiklikte -u ile yenilenir)', async () => {
    const written = new Set<string>();
    const record = async (name: string, res: { statusCode: number; body: string; json: () => unknown }, status: number) => {
      expect(res.statusCode, `${name}: ${res.body}`).toBe(status);
      written.add(`${name}.json`);
      await expect
        .soft(`${JSON.stringify({ status: res.statusCode, body: normalize(res.json()) }, null, 2)}\n`, name)
        .toMatchFileSnapshot(path.join(OUT, `${name}.json`));
    };

    // ---------- Kurulum ----------
    const reg = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: OWNER_IP,
      payload: { orgName: 'Örnek Ticaret', name: OWNER.name, email: OWNER.email, password: PASSWORD, country: 'TR', client: 'mobile', locale: 'tr' },
    });
    expect(reg.statusCode, reg.body).toBe(201);
    const orgId = (reg.json() as { activeOrgId: string }).activeOrgId;
    // TagPress `pilot`: demo firması gibi `subscription:set` ile açılır; ilk açılış sahibe aracın sahip rolünü (Yönetici) verir.
    await prisma.$transaction((tx) => setSubscription(tx, orgId, 'tagpress', { status: 'ACTIVE' }, { operator: 'hub-web-kayit', via: 'set' }));

    // Sahip Merkez'e tarayıcıdan girer; bütün firma yönetimi bu oturumla (çerez, CSRF, Origin, X-SOD-Org).
    const owner = await webLogin(OWNER.email, OWNER_IP);
    const ownerHeaders = (locale = 'tr') => ({ ...cookieWriteHeaders(owner.token), 'accept-language': locale });
    const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>, headers = ownerHeaders()) =>
      app.inject({ method, url: `${API}${url}`, headers, remoteAddress: OWNER_IP, ...(payload ? { payload } : {}) });

    // TagPress rolleri tohumdaki gibi: firma yöneticisi Yönetici, çalışanlar Kullanıcı.
    const admin = await insertMember(orgId, ADMIN, 'ADMIN', 'ACCOUNTING', 'ADMIN');
    const worker = await insertMember(orgId, WORKER, 'MEMBER', 'MEASURE', 'USER');
    const suspended = await insertMember(orgId, SUSPENDED, 'MEMBER', 'MEASURE', 'USER');
    const noTool = await insertMember(orgId, NO_TOOL, 'MEMBER', null);

    const roleRes = await call('POST', '/org/roles', {
      product: 'deciship',
      name: 'Depo şefi',
      description: 'Ölçer ve bütün ölçümleri görür.',
      permissions: ['deciship.measurements.capture', 'deciship.measurements.view_all'],
      basedOn: 'MEASURE',
    });
    expect(roleRes.statusCode, roleRes.body).toBe(201);
    const roleKey = (roleRes.json() as { role: { key: string } }).role.key;

    const patchRes = await call('PATCH', `/org/members/${suspended.id}`, { productRoles: { deciship: roleKey } });
    expect(patchRes.statusCode, patchRes.body).toBe(200);
    const suspend = await call('PATCH', `/org/members/${suspended.id}`, { status: 'SUSPENDED' });
    expect(suspend.statusCode, suspend.body).toBe(200);

    const inviteEmail = await call('POST', '/org/members/invite', {
      kind: 'EMAIL',
      email: INVITED_EMAIL.email,
      name: INVITED_EMAIL.name,
      orgRole: 'MEMBER',
      productRoles: { deciship: 'MEASURE' },
    });
    expect(inviteEmail.statusCode, inviteEmail.body).toBe(201);
    const invitePhone = await call('POST', '/org/members/invite', {
      kind: 'PHONE_CODE',
      phone: INVITED_PHONE.phone,
      name: INVITED_PHONE.name,
      orgRole: 'MEMBER',
      productRoles: { deciship: 'MEASURE' },
    });
    expect(invitePhone.statusCode, invitePhone.body).toBe(201);
    const link = (inviteEmail.json() as { link: string }).link;
    const inviteToken = link.slice(link.lastIndexOf('/') + 1);
    const phoneCode = (invitePhone.json() as { code: string }).code;

    // Sıra kayıt anına bağlı listeler: anlar kurulum sırasıyla sabit aralıklı yazılır.
    const stamp = (i: number) => new Date(BASE + i * 60_000);
    const memberships = await prisma.membership.findMany({
      where: { orgId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, orgRole: true },
    });
    const order = [memberships.find((m) => m.orgRole === 'OWNER')!.id, admin.id, worker.id, suspended.id, noTool.id];
    expect(memberships.map((m) => m.id).sort()).toEqual([...order].sort());
    for (const [i, id] of order.entries()) await prisma.membership.update({ where: { id }, data: { createdAt: stamp(i) } });
    const invitationIds = [
      (inviteEmail.json() as { invitation: { id: string } }).invitation.id,
      (invitePhone.json() as { invitation: { id: string } }).invitation.id,
    ];
    for (const [i, id] of invitationIds.entries()) await prisma.invitation.update({ where: { id }, data: { createdAt: stamp(10 + i) } });
    const audit = await prisma.auditLog.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    for (const [i, { id }] of audit.entries()) await prisma.auditLog.update({ where: { id }, data: { createdAt: stamp(20 + i) } });

    // Çalışan (MEMBER, DeciShip Ölçüm) da tarayıcıdan girer.
    const workerLogin = await webLogin(WORKER.phone, WORKER_IP);
    const workerHeaders = { ...cookieWriteHeaders(workerLogin.token), 'accept-language': 'tr' };

    // ---------- Kayıt ----------
    await record('login.web.tr', owner.res, 200);
    await record('invite-create.email.tr', inviteEmail, 201);
    await record('invite-create.phone.tr', invitePhone, 201);
    await record('member-patch.tr', patchRes, 200);
    await record('role-create.tr', roleRes, 201);

    await record('me.owner.tr', await call('GET', '/me'), 200);
    await record('me.owner.en', await call('GET', '/me', undefined, ownerHeaders('en')), 200);
    await record('me.member.tr', await call('GET', '/me', undefined, workerHeaders), 200);
    await record('catalog', await call('GET', '/catalog'), 200);
    await record('org.tr', await call('GET', '/org'), 200);
    await record('org-members.tr', await call('GET', '/org/members'), 200);
    await record('org-members.member.tr', await call('GET', '/org/members', undefined, workerHeaders), 403);
    await record('org-invitations.tr', await call('GET', '/org/invitations'), 200);
    await record('org-roles.tr', await call('GET', '/org/roles'), 200);
    await record('org-subscriptions.tr', await call('GET', '/org/subscriptions'), 200);
    await record('org-audit.tr', await call('GET', '/org/audit?page=1&pageSize=50'), 200);
    await record('me-sessions.tr', await call('GET', '/me/sessions'), 200);

    // Davet önizlemeleri: oturumsuz, davet edilenin tarayıcısı.
    const anon = { ...webHeaders(), 'accept-language': 'tr' };
    await record('invite-preview.tr', await app.inject({ method: 'GET', url: `${API}/invites/${inviteToken}`, headers: anon, remoteAddress: PREVIEW_IP }), 200);
    await record(
      'join-preview.tr',
      await app.inject({
        method: 'POST',
        url: `${API}/auth/join/preview`,
        headers: anon,
        remoteAddress: PREVIEW_IP,
        payload: { phone: INVITED_PHONE.phone, code: phoneCode },
      }),
      200,
    );

    // Uç kalkınca kaydı da kalkmalı: klasörde üretilmeyen dosya kalmaz.
    expect(
      fs
        .readdirSync(OUT)
        .filter((f) => f.endsWith('.json'))
        .sort(),
    ).toEqual([...written].sort());
  });
});
