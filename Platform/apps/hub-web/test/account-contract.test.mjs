// Sahte Hesap uçları ile gerçek Hesap servisi ayrılmasın (KALANLAR 6.24, C3-B2). Tarayıcısız: `npm test` ile her gönderimde koşar.
// Gerçek yanıtlar `e2e/fixtures/account-real/*.json`: Hesap servisinin veritabanlı testi üretir ve denetler
// (Platform/apps/account-api/test/hubWebFixtures.test.ts; yenileme orada `-u`). Kimlikler `<id>`, anlar `<zaman>` yazılı.
// Sahte API'nin işleyicileri (`src/mocks/handlers.ts`) Node'da `msw/node` ile çağrılır (`test/lib/mock-server.mjs`), tohumdaki örnek
// firmayla aynı türden senaryo kurulur ve yanıtın şekli (alan adları, türleri; `scripts/lib/shape.mjs`) kayda karşı sınanır.
// Kayıt yenilenince bu test kırılır: sahte API gerçeğe uydurulur, test gevşetilmez.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareShape, shapeOf } from '../../../../scripts/lib/shape.mjs';
import { call, closeMock, freshMock } from './lib/mock-server.mjs';

const DIR = path.resolve(import.meta.dirname, '../e2e/fixtures/account-real');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));

const PASSWORD = 'Test12345!';
const OWNER = 'sahip@ornek.test';
/** Tohumda: Zeynep Arslan, MEMBER (DeciShip AUDITOR). */
const MEMBER = 'denetci@ornek.test';
/** Tohumda: Mehmet Demir, telefonla giren MEMBER (DeciShip MEASURE). */
const MEASURE = '+905320000004';

const signIn = async (identifier) => {
  const r = await call('POST', '/api/account/auth/login', { body: { identifier, password: PASSWORD, client: 'web' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
};

/** Sahibin firmasında kayıttaki izlerin türleri de oluşsun: e-posta ve telefon daveti, rol değişikliği, özel rol. */
async function ownerWithHistory() {
  freshMock();
  await signIn(OWNER);
  const email = await call('POST', '/api/account/org/members/invite', {
    body: { kind: 'EMAIL', email: 'can@ornek.test', name: 'Can Öztürk', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } },
  });
  const phone = await call('POST', '/api/account/org/members/invite', {
    body: { kind: 'PHONE_CODE', phone: '+905559871202', name: 'Elif Şahin', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } },
  });
  const role = await call('POST', '/api/account/org/roles', {
    body: {
      product: 'deciship',
      name: 'Tarife okuyucu',
      description: 'Tarifeleri görür.',
      permissions: ['deciship.web.access', 'deciship.prices.view', 'deciship.tariffs.view'],
      basedOn: 'AUDITOR',
    },
  });
  const patch = await call('PATCH', '/api/account/org/members/m4', { body: { productRoles: { deciship: 'AUDITOR' } } });
  return { email, phone, role, patch };
}

/** Kayıt adı → sahte API'nin aynı senaryodaki yanıtı. Kayıtta olup burada olmayan dosya testte hata verir. */
const SCENARIOS = {
  'login.web.tr': async () => {
    freshMock();
    return signIn(OWNER);
  },
  'me.owner.tr': async () => {
    freshMock();
    await signIn(OWNER);
    return call('GET', '/api/account/me');
  },
  'me.owner.en': async () => {
    freshMock();
    await signIn(OWNER);
    return call('GET', '/api/account/me', { locale: 'en' });
  },
  'me.member.tr': async () => {
    freshMock();
    await signIn(MEASURE);
    return call('GET', '/api/account/me');
  },
  catalog: async () => {
    freshMock();
    return call('GET', '/api/account/catalog');
  },
  'org.tr': async () => {
    freshMock();
    await signIn(OWNER);
    return call('GET', '/api/account/org');
  },
  'org-members.tr': async () => {
    freshMock();
    await signIn(OWNER);
    return call('GET', '/api/account/org/members');
  },
  'org-members.member.tr': async () => {
    freshMock();
    await signIn(MEMBER);
    return call('GET', '/api/account/org/members');
  },
  'org-invitations.tr': async () => {
    await ownerWithHistory();
    return call('GET', '/api/account/org/invitations');
  },
  'org-roles.tr': async () => {
    await ownerWithHistory();
    return call('GET', '/api/account/org/roles');
  },
  'org-subscriptions.tr': async () => {
    freshMock();
    await signIn(OWNER);
    return call('GET', '/api/account/org/subscriptions');
  },
  'org-audit.tr': async () => {
    await ownerWithHistory();
    return call('GET', '/api/account/org/audit?page=1&pageSize=50');
  },
  'me-sessions.tr': async () => {
    freshMock();
    await signIn(OWNER);
    return call('GET', '/api/account/me/sessions');
  },
  'invite-create.email.tr': async () => (await ownerWithHistory()).email,
  'invite-create.phone.tr': async () => (await ownerWithHistory()).phone,
  'role-create.tr': async () => (await ownerWithHistory()).role,
  'member-patch.tr': async () => (await ownerWithHistory()).patch,
  'invite-preview.tr': async () => {
    const { email } = await ownerWithHistory();
    const token = new URL(email.body.link).pathname.split('/').pop();
    return call('GET', `/api/account/invites/${encodeURIComponent(token)}`);
  },
  'join-preview.tr': async () => {
    const { phone } = await ownerWithHistory();
    await call('POST', '/api/account/auth/logout');
    return call('POST', '/api/account/auth/join/preview', { body: { phone: '+905559871202', code: phone.body.code } });
  },
};

after(() => closeMock());

describe('sahte Hesap API = gerçek Hesap kaydı', () => {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();

  test('her kayıt dosyasının sahte API senaryosu var (kayda yeni uç eklenince burada da eklenir)', () => {
    assert.deepEqual(
      files.filter((f) => !(f in SCENARIOS)),
      [],
    );
    assert.deepEqual(
      Object.keys(SCENARIOS)
        .filter((f) => !files.includes(f))
        .sort(),
      [],
    );
  });

  test('katalog birebir: araçlar, roller, firma rolleri ve izin adları kayıttan (posta ayarı ortamdan)', async () => {
    const real = fixture('catalog').body;
    const mock = (await SCENARIOS.catalog()).body;
    const strip = ({ mailEnabled: _m, ...rest }) => rest;
    assert.deepEqual(strip(mock), strip(real));
  });

  test('/me: hazır rol adı kişinin kayıtlı dilinde, isteğin dili değil (gerçekte tr ve en kaydı aynı ad)', async () => {
    const realTr = fixture('me.owner.tr').body.products.find((p) => p.key === 'deciship').roleLabel;
    assert.equal(fixture('me.owner.en').body.products.find((p) => p.key === 'deciship').roleLabel, realTr);
    const label = async (name) => (await SCENARIOS[name]()).body.products.find((p) => p.key === 'deciship').roleLabel;
    assert.equal(await label('me.owner.en'), await label('me.owner.tr'));
    assert.equal(await label('me.owner.tr'), realTr);
  });

  for (const name of files) {
    test(`${name}: durum, hata kodu ve yanıt şekli`, async () => {
      const real = fixture(name);
      const mock = await SCENARIOS[name]();
      assert.equal(mock.status, real.status, `${name} durumu: ${JSON.stringify(mock.body)}`);
      if (real.status >= 400) assert.equal(mock.body?.error?.code, real.body.error.code);
      assert.deepEqual(compareShape(shapeOf(mock.body), shapeOf(real.body)), []);
    });
  }
});
