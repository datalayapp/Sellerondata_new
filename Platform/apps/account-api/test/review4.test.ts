import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AUDIT_ACTION_LABEL, ERROR_MESSAGES, NAME_MAX_LENGTH } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { assertProductionConfig } from '../src/env.ts';
import { RATE_RULES } from '../src/lib/rateLimit.ts';
import { addMember, API, errorCode, getApp, randomEmail, randomIp, randomTrPhone, registerOrg, PASSWORD, asWeb, webHeadersFrom, isOrgWrite } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
// Firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer ikiz web oturumuna çevrilir.
const post = async (url: string, headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `${API}${url}`, remoteAddress: randomIp(), headers: isOrgWrite('POST', url) ? await webHeadersFrom(headers) : headers, payload });
const patchMember = async (headers: Record<string, string>, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `${API}/org/members/${id}`, headers: await webHeadersFrom(headers), payload });

describe('B3: posta sağlayıcı', () => {
  const prodEnv = {
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://a',
    APP_BASE_URL: 'https://a',
    DATABASE_URL: 'postgresql://a:gercek@db/x',
    ACCOUNT_CODE_PEPPER: 'g'.repeat(40),
    EMAIL_VERIFICATION_REQUIRED: 'true',
  };
  function withEnv(extra: Record<string, string>, fn: () => void) {
    const keys = [...Object.keys(prodEnv), ...Object.keys(extra), 'SMTP_URL'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      delete process.env.SMTP_URL;
      Object.assign(process.env, prodEnv, extra);
      fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('üretimde SMTP_URL zorunlu: "gönderildi" deyip göndermeyen servis başlamaz', () => {
    withEnv({}, () => expect(() => assertProductionConfig()).toThrow(/SMTP_URL/));
    withEnv({ SMTP_URL: 'smtp://mail:25' }, () => expect(() => assertProductionConfig()).not.toThrow());
  });

  it('me ve catalog posta durumunu söyler', async () => {
    const owner = await registerOrg(app);
    const me = (await app.inject({ url: `${API}/me`, headers: owner.headers })).json();
    expect(me.account.mailEnabled).toBe(false);
    expect((await app.inject({ url: `${API}/catalog` })).json().mailEnabled).toBe(false);
    const saved = process.env.SMTP_URL;
    process.env.SMTP_URL = 'smtp://127.0.0.1:1';
    try {
      expect((await app.inject({ url: `${API}/me`, headers: owner.headers })).json().account.mailEnabled).toBe(true);
      expect((await app.inject({ url: `${API}/catalog` })).json().mailEnabled).toBe(true);
    } finally {
      process.env.SMTP_URL = saved;
    }
  });

  it('kimlik varlığını ele vermeme kuralı korunur: posta kapalıyken de yanıt aynı', async () => {
    const owner = await registerOrg(app);
    const known = await post('/auth/forgot-password', {}, { identifier: owner.email });
    const unknown = await post('/auth/forgot-password', {}, { identifier: randomEmail('yok') });
    expect(known.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
  });
});

describe('B6: yeni firma davet sınırı', () => {
  it('saatte 10 telefon, 10 e-posta: 5 kişilik depo takılmaz', async () => {
    expect(RATE_RULES.phoneInviteNewOrg.limit).toBe(10);
    expect(RATE_RULES.emailInviteNewOrg.limit).toBe(10);
    const owner = await registerOrg(app);
    for (let i = 0; i < 10; i++) {
      expect((await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone: randomTrPhone(), name: `Çalışan ${i}` })).statusCode).toBe(201);
    }
    expect((await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Fazla' })).statusCode).toBe(429);
  });

  it('geçersiz girdi, zaten üye ve yetkisiz deneme sayılmaz', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const phone = randomTrPhone();
    await addMember(app, owner.orgId, { email: null, phone });
    const member = await addMember(app, owner.orgId);
    for (let i = 0; i < 15; i++) {
      expect((await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone: 'gecersiz', name: 'X' })).statusCode).toBe(400);
      expect((await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone, name: 'X' })).statusCode).toBe(409);
      expect((await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email: member.email, name: 'X' })).statusCode).toBe(409);
      expect((await post('/org/members/invite', admin.headers, { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'X', orgRole: 'ADMIN' })).statusCode).toBe(403);
    }
    expect(await prisma.rateBucket.count({ where: { key: { in: [`invite:phone:${owner.orgId}`, `invite:email:${owner.orgId}`, `invite:org:${owner.orgId}`] } } })).toBe(0);
    expect((await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Geçerli' })).statusCode).toBe(201);
    expect((await prisma.rateBucket.findUniqueOrThrow({ where: { key: `invite:phone:${owner.orgId}` } })).count).toBe(1);
  });
});

describe('O8: askıdaki çalışan', () => {
  it('me askı durumunu bildirir, firma açma önerisi tek başına gösterilmez', async () => {
    const owner = await registerOrg(app);
    const worker = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await patchMember(owner.headers, worker.membershipId, { status: 'SUSPENDED' });
    const refreshed = await post('/auth/refresh', {}, { refreshToken: worker.refreshToken });
    const me = (await app.inject({ url: `${API}/me`, headers: { authorization: `Bearer ${refreshed.json().accessToken}` } })).json();
    expect(me.activeOrg).toBeNull();
    expect(me.orgs).toEqual([expect.objectContaining({ id: owner.orgId, status: 'SUSPENDED' })]);
    expect(me.account.suspendedOrgCount).toBe(1);
  });
});

describe('O15: metinler', () => {
  it('uzunluk hatası alanı ve sınırı söyler, TR ve EN', async () => {
    const payload = { orgName: 'x'.repeat(NAME_MAX_LENGTH + 1), name: 'Ali', email: randomEmail(), password: PASSWORD, client: 'mobile' };
    // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); burada sınanan metnin içeriği.
    const tr = await post('/auth/register', { 'accept-language': 'tr' }, payload);
    expect(tr.statusCode).toBe(400);
    const detail = tr.json().error.details[0];
    expect(detail).toMatchObject({ path: 'orgName', code: 'too_big', max: NAME_MAX_LENGTH });
    expect(detail.message).toBe(`Firma adı en fazla ${NAME_MAX_LENGTH} karakter olabilir.`);
    const en = await app.inject({ method: 'POST', url: `${API}/auth/register`, remoteAddress: randomIp(), headers: { 'accept-language': 'en' }, payload });
    expect(en.json().error.details[0].message).toBe(`Company name can be at most ${NAME_MAX_LENGTH} characters.`);
  });

  it('firma adı uç noktalarında da firma adı denir; kısa şifrede sınır söylenir', async () => {
    const owner = await registerOrg(app);
    // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); burada sınanan metnin içeriği.
    const res = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: { ...(await asWeb(owner)), 'accept-language': 'tr' }, payload: { name: 'x'.repeat(NAME_MAX_LENGTH + 1) } });
    expect(res.json().error.details[0].message).toContain('Firma adı');
    const short = await post('/auth/register', { 'accept-language': 'tr' }, { orgName: 'F', name: 'A', email: randomEmail(), password: 'kisa', client: 'mobile' });
    expect(short.json().error.details[0]).toMatchObject({ path: 'password', code: 'too_small', min: 10 });
    expect(short.json().error.details[0].message).toBe('Şifre en az 10 karakter olmalı.');
  });

  it('geçersiz kod ne yapılacağını söyler', () => {
    expect(ERROR_MESSAGES.INVITE_INVALID.tr).toContain('Yöneticinizden yeni');
    expect(ERROR_MESSAGES.INVITE_INVALID.en.toLowerCase()).toContain('ask your admin');
  });

  it('hata metinlerinde çift nokta yok', () => {
    for (const [code, text] of Object.entries(ERROR_MESSAGES)) {
      expect(text.tr, code).not.toMatch(/\.\.|\s\./);
      expect(text.en, code).not.toMatch(/\.\.|\s\./);
    }
  });
});

describe('O10: denetim izi', () => {
  it('member.updated neyin değiştiğini taşır: rol A -> B', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await patchMember(owner.headers, member.membershipId, { orgRole: 'ADMIN', status: 'SUSPENDED', productRoles: { deciship: 'AUDITOR' } });
    // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); burada sınanan metnin içeriği.
    const audit = (await app.inject({ url: `${API}/org/audit`, headers: { ...owner.headers, 'accept-language': 'tr' } })).json();
    const item = audit.items.find((i: { action: string }) => i.action === 'member.updated');
    expect(item.details.changes).toEqual(
      expect.arrayContaining([
        { field: 'orgRole', from: 'MEMBER', to: 'ADMIN' },
        { field: 'status', from: 'ACTIVE', to: 'SUSPENDED' },
        // Rol adı değişiklik anındaki haliyle (firmanın dilinde katalog adı; özel rolde firmanın yazdığı ad).
        { field: 'productRole', product: 'deciship', from: 'MEASURE', to: 'AUDITOR', fromLabel: 'Ölçüm', toLabel: 'Denetleyici' },
      ]),
    );
    expect(item.label).toBe('Üyelik güncellendi');
    expect(item.targetName).toBeTruthy();
  });

  it('etiket dile göre gelir, hedef kişi adı görünür; çıkarılan üyenin adı da', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const name = (await prisma.person.findUniqueOrThrow({ where: { id: member.personId } })).name;
    await app.inject({ method: 'DELETE', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner) });
    const audit = (await app.inject({ url: `${API}/org/audit`, headers: { ...owner.headers, 'accept-language': 'en' } })).json();
    const item = audit.items.find((i: { action: string }) => i.action === 'member.removed');
    expect(item.label).toBe('Member removed');
    expect(item.targetName).toBe(name);
  });

  it('kaynaktaki her denetim eyleminin etiketi var', () => {
    const src = path.resolve(import.meta.dirname, '../src');
    const actions = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'generated') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else for (const m of fs.readFileSync(full, 'utf8').matchAll(/action: '([a-z_.]+)'/g)) actions.add(m[1]);
      }
    };
    walk(src);
    expect(actions.size).toBeGreaterThan(15);
    for (const action of actions) expect(AUDIT_ACTION_LABEL[action], action).toBeTruthy();
    for (const label of Object.values(AUDIT_ACTION_LABEL)) {
      expect(label.tr).toBeTruthy();
      expect(label.en).toBeTruthy();
    }
  });
});

void errorCode;
