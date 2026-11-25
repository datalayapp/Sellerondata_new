// Merkez "Yapay zekâ harcaması" ve "Platform › Yapay zekâ": sahte geçit uçları (`src/mocks/ai.ts`) sözleşmenin biçimine ve kapılarına
// uyar (`contracts/src/aiSpend.ts`), görünürlük kuralı (`src/lib/access.ts`) tek yerde. Gerçek geçit kaydı (`ai-api` G4) gelince
// şekil karşılaştırması buraya eklenir. Tarayıcısız: `npm test`.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_SPEND_CALL_COLUMNS, AI_SPEND_KPI, AI_SPEND_PATHS, AI_SPEND_SECTIONS, STEP_UP_HEADER } from '@sellerondata/contracts';
import { call, closeMock, freshMock } from './lib/mock-server.mjs';
import { canSeeAiSpend, isPlatformOperator } from '../src/lib/access.ts';

const PASSWORD = 'Test12345!';
const OWNER = 'sahip@ornek.test';
const MEMBER = 'denetci@ornek.test';
/** Geçen ay (uçlar en çok 12 ay geriye izin verir; sabit tarih zamanla pencereden çıkardı). */
const RANGE = (() => {
  const now = new Date();
  const day = (d) => d.toISOString().slice(0, 10);
  return `from=${day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))}&to=${day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)))}`;
})();

const signIn = async (identifier) => {
  const r = await call('POST', '/api/account/auth/login', { body: { identifier, password: PASSWORD, client: 'web' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};

/** Kişiyi platform yöneticisi yapar (Hesap'ta `PLATFORM_OPERATORS` listesi; sahte depoda kişi alanı). */
function makeOperator(email) {
  const db = JSON.parse(localStorage.getItem('sod_mock_db'));
  db.persons.find((p) => p.email === email).platformOperator = true;
  localStorage.setItem('sod_mock_db', JSON.stringify(db));
}

after(() => closeMock());

describe('görünürlük (access.ts)', () => {
  const me = (orgRole, platformOperator) => ({ activeOrg: { orgRole }, platformOperator });
  test('Platform menüsü yalnız `platformOperator: true`; alan yoksa ya da false ise yok', () => {
    assert.equal(isPlatformOperator(me('OWNER', true)), true);
    assert.equal(isPlatformOperator(me('OWNER', false)), false);
    assert.equal(isPlatformOperator(me('OWNER', undefined)), false);
    assert.equal(isPlatformOperator(null), false);
  });
  test('harcama sayfası firma sahibi ve yöneticisine; üyeye yok', () => {
    assert.equal(canSeeAiSpend(me('OWNER')), true);
    assert.equal(canSeeAiSpend(me('ADMIN')), true);
    assert.equal(canSeeAiSpend(me('MEMBER')), false);
    assert.equal(canSeeAiSpend(null), false);
  });
});

describe('sahte geçit: firma görünümü', () => {
  test('/me: tohumda kimse platform yöneticisi değil', async () => {
    freshMock();
    await signIn(OWNER);
    const r = await call('GET', '/api/account/me');
    assert.equal(r.body.platformOperator, false);
  });

  test('özet: bölüm, KPI ve süzgeç kimlikleri sözleşmeden; USD ve firma kırılımı yok', async () => {
    freshMock();
    await signIn(OWNER);
    const r = await call('GET', `${AI_SPEND_PATHS.summary}?${RANGE}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.product, 'ai');
    assert.deepEqual(
      r.body.sections.map((s) => s.id),
      [AI_SPEND_SECTIONS.overview, AI_SPEND_SECTIONS.products, AI_SPEND_SECTIONS.purposes, AI_SPEND_SECTIONS.models, AI_SPEND_SECTIONS.members],
    );
    const kpis = r.body.sections[0].widgets.find((w) => w.kind === 'kpis').items.map((k) => k.id);
    assert.deepEqual(
      kpis,
      AI_SPEND_KPI.filter((k) => k !== 'spend_usd'),
    );
    assert.ok(r.body.sections[0].widgets.some((w) => w.kind === 'timeseries' && w.id === 'daily' && w.chart === 'bar'));
    assert.deepEqual(
      r.body.filters.map((f) => f.id),
      ['product', 'purpose', 'model', 'status', 'member'],
    );
    const spend = r.body.sections[0].widgets[0].items[0];
    assert.equal(spend.currency, 'TRY');
    // Kişi adı geçitte yok: Merkez ekip listesinden çözer.
    const byMember = r.body.sections[4].widgets[0];
    assert.ok(byMember.items.length > 0 && byMember.items.every((i) => i.label === ''));
  });

  test('çağrılar: sütunlar sözleşme sırasıyla (firma sütunu yok), gizliler işaretli; sayfa boyu sınırı', async () => {
    freshMock();
    await signIn(OWNER);
    const r = await call('GET', `${AI_SPEND_PATHS.calls}?${RANGE}&page=1&pageSize=10`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'calls');
    assert.deepEqual(
      r.body.columns.map((c) => c.id),
      AI_SPEND_CALL_COLUMNS.filter((c) => c !== 'org'),
    );
    assert.ok(r.body.columns.find((c) => c.id === 'error_code').hiddenByDefault);
    assert.ok(r.body.rows.length <= 10 && r.body.total >= r.body.rows.length);
    assert.equal((await call('GET', `${AI_SPEND_PATHS.calls}?${RANGE}&pageSize=500`)).status, 400);
  });

  test('firma görünümünde başka firma seçilemez, USD yok', async () => {
    freshMock();
    await signIn(OWNER);
    assert.equal((await call('GET', `${AI_SPEND_PATHS.summary}?${RANGE}&org=o2`)).status, 400);
    assert.equal((await call('GET', `${AI_SPEND_PATHS.summary}?${RANGE}&currency=USD`)).status, 400);
  });

  test('üye (OWNER/ADMIN değil) harcamayı ve hakkı göremez', async () => {
    freshMock();
    await signIn(MEMBER);
    assert.equal((await call('GET', `${AI_SPEND_PATHS.summary}?${RANGE}`)).status, 403);
    assert.equal((await call('GET', AI_SPEND_PATHS.allowance)).status, 403);
  });

  test('boş dönem geçerli yanıt: çağrı 0', async () => {
    freshMock();
    localStorage.setItem('sod_mock_ai_empty', '1');
    await signIn(OWNER);
    const r = await call('GET', `${AI_SPEND_PATHS.summary}?${RANGE}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.sections[0].widgets[0].items.find((k) => k.id === 'calls').value, 0);
  });

  test('hak: durdurulmuş platform `paused`, dolmuş hak `capped`', async () => {
    freshMock();
    await signIn(OWNER);
    const ok = await call('GET', AI_SPEND_PATHS.allowance);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.currency, 'TRY');
    assert.ok(['ok', 'warn', 'capped'].includes(ok.body.state));
    localStorage.setItem('sod_mock_ai_capped', '1');
    assert.equal((await call('GET', AI_SPEND_PATHS.allowance)).body.state, 'capped');
    freshMock();
    localStorage.setItem('sod_mock_ai_paused', '1');
    await signIn(OWNER);
    const paused = await call('GET', AI_SPEND_PATHS.allowance);
    assert.deepEqual([paused.body.state, paused.body.pausedBy], ['paused', 'platform']);
  });
});

describe('sahte geçit: platform yöneticisi', () => {
  test('yönetici olmayana platform görünümü ve yönetici uçları 403', async () => {
    freshMock();
    await signIn(OWNER);
    assert.equal((await call('GET', `${AI_SPEND_PATHS.summary}?scope=platform&${RANGE}`)).status, 403);
    assert.equal((await call('GET', AI_SPEND_PATHS.adminKeys)).status, 403);
    assert.equal((await call('POST', '/api/account/operator/step-up', { body: { password: PASSWORD } })).status, 403);
  });

  test('platform görünümü: firma kırılımı, USD KPI, kişi süzgeci yok', async () => {
    freshMock();
    await signIn(OWNER);
    makeOperator(OWNER);
    assert.equal((await call('GET', '/api/account/me')).body.platformOperator, true);
    const r = await call('GET', `${AI_SPEND_PATHS.summary}?scope=platform&${RANGE}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.sections.at(-1).id, AI_SPEND_SECTIONS.orgs);
    const kpis = r.body.sections[0].widgets[0].items.map((k) => k.id);
    assert.ok(kpis.includes('spend_usd') && !kpis.includes('cap_used'));
    assert.ok(r.body.filters.some((f) => f.id === 'org') && !r.body.filters.some((f) => f.id === 'member'));
    assert.equal((await call('GET', `${AI_SPEND_PATHS.summary}?scope=platform&${RANGE}&member=m1`)).status, 400);
    const calls = await call('GET', `${AI_SPEND_PATHS.calls}?scope=platform&${RANGE}&currency=USD`);
    assert.equal(calls.body.columns.at(-1).id, 'org');
    assert.equal(calls.body.columns.find((c) => c.id === 'amount').currency, 'USD');
  });

  test('anahtar: yanıtta anahtar yok; değiştirme adım artırma ister; yanlış şifre 401', async () => {
    freshMock();
    await signIn(OWNER);
    makeOperator(OWNER);
    const keys = await call('GET', AI_SPEND_PATHS.adminKeys);
    assert.equal(keys.status, 200);
    assert.deepEqual(
      keys.body.keys.map((k) => k.provider),
      ['anthropic', 'gemini'],
    );
    for (const k of keys.body.keys) assert.deepEqual(Object.keys(k).sort(), ['last4', 'lastTest', 'provider', 'setAt', 'setBy', 'state']);
    const secret = 'sk-ant-ornek-0123456789abcd';
    const denied = await call('PUT', `${AI_SPEND_PATHS.adminKeys}/gemini`, { body: { key: secret } });
    assert.deepEqual([denied.status, denied.body.error.code], [403, 'STEP_UP_REQUIRED']);
    assert.equal((await call('POST', '/api/account/operator/step-up', { body: { password: 'yanlis-sifre' } })).status, 401);
    const up = await call('POST', '/api/account/operator/step-up', { body: { password: PASSWORD } });
    assert.equal(up.status, 200);
    assert.ok(up.body.token && Date.parse(up.body.expiresAt) > Date.now());
    const saved = await call('PUT', `${AI_SPEND_PATHS.adminKeys}/gemini`, { body: { key: secret }, headers: { [STEP_UP_HEADER]: up.body.token } });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.state, saved.body.last4], ['ok', 'abcd']);
    assert.ok(!JSON.stringify(saved.body).includes(secret));
    assert.ok(!JSON.stringify((await call('GET', AI_SPEND_PATHS.adminKeys)).body).includes(secret));
  });

  test('acil durdurma adım artırmasız; geri açma ve tavan adım artırmalı', async () => {
    freshMock();
    await signIn(OWNER);
    makeOperator(OWNER);
    const paused = await call('PATCH', AI_SPEND_PATHS.adminLimits, { body: { paused: true } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.platform.paused, true);
    assert.equal((await call('GET', AI_SPEND_PATHS.adminStatus)).body.paused, true);
    assert.equal((await call('PATCH', AI_SPEND_PATHS.adminLimits, { body: { paused: false } })).status, 403);
    assert.equal((await call('PATCH', AI_SPEND_PATHS.adminLimits, { body: { platformDailyUsd: 5 } })).status, 403);
    assert.equal((await call('PUT', `${AI_SPEND_PATHS.adminLimits}/orgs/o1`, { body: { capUsd: 50 } })).status, 403);
    const up = await call('POST', '/api/account/operator/step-up', { body: { password: PASSWORD } });
    const h = { [STEP_UP_HEADER]: up.body.token };
    const resumed = await call('PATCH', AI_SPEND_PATHS.adminLimits, { body: { paused: false }, headers: h });
    assert.equal(resumed.body.platform.paused, false);
    const capped = await call('PUT', `${AI_SPEND_PATHS.adminLimits}/orgs/o1`, { body: { capUsd: 50 }, headers: h });
    const row = capped.body.orgs.find((o) => o.orgId === 'o1');
    assert.deepEqual([row.capOverridden, row.capMicroUsd], [true, 50_000_000]);
  });
});
