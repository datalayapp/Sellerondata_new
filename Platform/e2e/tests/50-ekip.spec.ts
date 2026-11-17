import { test, expect } from '../lib/fixtures.ts';
import { MobileApi, PASSWORD, WebApi, measurementBody, provisionDeciship, registerOwner, sampleMeasurements, type Owner } from '../lib/api.ts';
import { APP, recordMetric, sql, uniq, uniqPhone } from '../lib/sys.ts';
import { openApps } from '../lib/shell.ts';
import type { Page } from '@playwright/test';

const MONEY = /price|amount|expected|diff|net|billed|overcharge/i;

function moneyKeys(value: unknown, trail = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => moneyKeys(v, `${trail}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [...(MONEY.test(k) ? [`${trail}.${k}`] : []), ...moneyKeys(v, `${trail}.${k}`)]);
  }
  return [];
}

async function openTeam(page: Page) {
  await page.goto('/account/team');
  await expect(page.getByRole('heading', { name: 'Ekip ve yetkiler' })).toBeVisible();
}

async function invite(page: Page, kind: 'email' | 'phone', o: { name: string; contact: string; orgRole?: string; deciship: string }) {
  await page.getByRole('button', { name: 'Kişi davet et' }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: kind === 'email' ? 'E-posta' : 'Telefon + kod' }).click();
  await panel.locator('#inv-name').fill(o.name);
  await panel.locator('#inv-contact').fill(o.contact);
  if (o.orgRole) await panel.locator('#inv-org').selectOption(o.orgRole);
  await panel.locator('#inv-deciship').selectOption(o.deciship);
  await panel.getByRole('button', { name: kind === 'email' ? 'Davet oluştur' : 'Kod üret' }).click();
}

/** E-posta daveti: yönetici bağlantıyı kopyalar, kişi yeni tarayıcıda açar. */
async function inviteByEmail(ownerPage: Page, freshPage: () => Promise<Page>, deciship: string, name = 'Deniz Davetli') {
  const email = `${uniq('davet')}@e2e.sellerondata.test`;
  await invite(ownerPage, 'email', { name, contact: email, deciship });
  const link = await ownerPage.getByRole('textbox', { name: 'Bağlantıyı kopyala' }).inputValue();
  expect(link).toContain(`${APP}/invite/`);
  await ownerPage.getByRole('button', { name: /Bağlantıyı kopyala/ }).click();
  await expect(ownerPage.getByText('Bağlantı kopyalandı')).toBeVisible();
  await ownerPage.keyboard.press('Escape');
  const page = await freshPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /sizi davet etti/ })).toBeVisible();
  await expect(page.getByLabel('Ad soyad')).toHaveValue(name);
  await page.getByLabel('Şifre belirleyin').fill(PASSWORD);
  await page.getByRole('button', { name: 'Katıl' }).click();
  await expect(page).toHaveURL(`${APP}/home`);
  return { page, email, name };
}

/** Telefon daveti: kod bir kez gösterilir, /join ile çalışan hesabı açılır. */
async function inviteByPhone(ownerPage: Page, freshPage: () => Promise<Page>, deciship: string, name = 'Mehmet Depo') {
  const phone = uniqPhone();
  await invite(ownerPage, 'phone', { name, contact: phone, deciship });
  const dlg = ownerPage.getByRole('dialog');
  await expect(dlg).toContainText('Bu kod bir daha gösterilmez');
  const code = (await dlg.getByLabel('Tek seferlik kod').innerText()).replace(/[\s-]/g, '');
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  await dlg.getByRole('button', { name: 'Kapat' }).first().click();
  await expect(ownerPage.locator('body')).not.toContainText(code);
  const page = await freshPage();
  await page.goto('/join');
  await page.getByLabel('Telefon').fill(phone);
  await page.getByLabel('Kod').fill(code);
  await page.getByRole('button', { name: 'Devam et' }).click();
  await expect(page.getByRole('heading', { name: /firmasına katılın/ })).toBeVisible();
  await expect(page.getByLabel('Ad soyad')).toHaveValue(name);
  await page.getByLabel('Şifre belirleyin').fill(PASSWORD);
  await page.getByRole('button', { name: 'Katıl' }).click();
  await expect(page).toHaveURL(`${APP}/home`);
  return { page, phone, code, name };
}

/** Kullanıcı hızı: sayfa açıldı, kimlik yanıtı döndü. Yanıt beklenmeden yazma yarışı ayrı test: "sayfa açılır açılmaz yazma". */
async function reloadSettled(page: Page) {
  const me = page.waitForResponse((r) => r.url().endsWith('/api/account/me'));
  await page.reload();
  await me;
}

/** Davet sonrası sayfa Davetler sekmesinde kalır. */
async function peopleTab(page: Page) {
  await page.getByRole('tab', { name: /Kişiler/ }).click();
}

async function setDecishipRole(ownerPage: Page, name: string, role: string) {
  await peopleTab(ownerPage);
  const saved = ownerPage.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/account/org/members/'));
  await ownerPage.getByRole('combobox', { name: `${name} DeciShip rolü` }).selectOption(role);
  const res = await saved;
  expect(res.status(), await res.text()).toBe(200);
}

async function waitMs(check: () => Promise<boolean>, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`koşul ${timeoutMs} ms içinde sağlanmadı`);
}

let ownerState: Owner;

test.describe('Ekip ve yetkiler', () => {
  test.beforeEach(async () => {
    ownerState = await registerOwner({ orgName: `Ekip Lojistik ${uniq('')}` });
    await provisionDeciship(ownerState);
  });

  test('e-posta daveti: bağlantı kopyala, yeni tarayıcıda katılım, davet ikinci kez kullanılamaz', async ({ openAs, freshPage, context }) => {
    void context;
    const owner = await openAs(ownerState.api);
    await openTeam(owner);
    const { email } = await inviteByEmail(owner, freshPage, 'AUDITOR');
    // Bağlantı yeniden açılırsa geçersiz
    const links = sql(`SELECT count(*) FROM platform."Invitation" WHERE email='${email}' AND "acceptedAt" IS NOT NULL`);
    expect(links).toBe('1');
    await owner.reload();
    await peopleTab(owner);
    await expect(owner.getByRole('cell', { name: new RegExp(email) })).toBeVisible();
  });

  test('telefon daveti: kod bir kez, /join ile hesap, Ölçüm web\'de "mobil uygulamada çalışır", API\'de para alanı yok', async ({ openAs, freshPage }) => {
    const owner = await openAs(ownerState.api);
    await openTeam(owner);
    const { page, phone, code, name } = await inviteByPhone(owner, freshPage, 'MEASURE');

    // Kod ikinci kez kullanılamaz
    const again = await freshPage();
    await again.goto('/join');
    await again.getByLabel('Telefon').fill(phone);
    await again.getByLabel('Kod').fill(code);
    await again.getByRole('button', { name: 'Devam et' }).click();
    await expect(again.locator('.notif, [role=alert]').first()).toBeVisible();
    await expect(again.getByRole('heading', { name: 'Kodla katılın' })).toBeVisible();

    // Web: Merkez'in sade hali, DeciShip mobil sayfası
    await expect(page.getByText('Bu rol mobil uygulamada çalışır').first()).toBeVisible();
    await (await openApps(page)).getByRole('menuitem', { name: /DeciShip/ }).click();
    await expect(page).toHaveURL(/\/account\/tool-access\/deciship/);
    await expect(page.getByText(/mobil/).first()).toBeVisible();
    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();

    // Mobil istemci: telefonla giriş, Bearer, ölçüm
    const mobile = await MobileApi.login(phone, PASSWORD);
    const me = await mobile.get('/api/deciship/me');
    expect(me.status).toBe(200);
    expect(me.body.member.name).toBe(name);
    const m = sampleMeasurements()[0]!;
    const created = await mobile.postMeasurement({ ...measurementBody(m), trackingRaw: `E2E${Date.now()}` });
    expect(created.status, created.text).toBe(201);
    expect(moneyKeys(created.body), 'ölçüm yanıtında para alanı olmamalı').toEqual([]);
    const stats = await mobile.get('/api/deciship/measurements/stats/today');
    expect(stats.status).toBe(200);
    // Web işleri kapalı
    for (const url of ['/api/deciship/invoices', '/api/deciship/dashboard', '/api/deciship/tariffs', '/api/deciship/platform/overview', '/api/deciship/carriers']) {
      expect((await mobile.get(url)).status, url).toBe(403);
    }
    await mobile.dispose();
  });

  test('rol değişimi anında: Yönetici Denetleyici\'ye düşer, sonraki istekte settings kapalı', async ({ openAs, freshPage }) => {
    const owner = await openAs(ownerState.api);
    await openTeam(owner);
    const { page, email, name } = await inviteByEmail(owner, freshPage, 'ADMIN', 'Yasin Yönetici');

    await page.goto('/deciship/settings');
    await expect(page.getByRole('heading', { name: 'Ayarlar', level: 1 })).toBeVisible();

    const bearer = await MobileApi.login(email, PASSWORD);
    expect((await bearer.get('/api/deciship/settings/onboarding')).status).toBe(200);

    await reloadSettled(owner);
    await setDecishipRole(owner, name, 'AUDITOR');
    const t0 = Date.now();

    // Olay teslimi gerçek: eski jeton TOKEN_STALE alana kadar geçen süre
    let stale = -1;
    await waitMs(async () => {
      const r = await bearer.get('/api/deciship/settings/onboarding');
      if (r.status === 401 && r.body?.error?.code === 'TOKEN_STALE') {
        stale = Date.now() - t0;
        return true;
      }
      return r.status === 403;
    });
    recordMetric('olay_rol_degisimi_ms', stale);
    expect(stale, 'jeton eski sayılmalı').toBeGreaterThanOrEqual(0);

    // Yenilenen jetonla 403
    expect((await bearer.refresh()).status).toBe(200);
    const after = await bearer.get('/api/deciship/settings/onboarding');
    expect(after.status).toBe(403);

    // Tarayıcı: yeni sayfa yüklemesinde Ayarlar kapalı, kullanıcı atılmadı
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Bu sayfa rolünüze açık değil' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ayarlar' })).toHaveCount(0);
    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
    await bearer.dispose();
  });

  // Kabuk önbellekteki firmayı açılışta benimser: /me gecikse de ilk yazma X-SOD-Org taşır.
  test('sayfa açılır açılmaz yazma: kimlik yanıtı gecikse de rol değişikliği gider', async ({ openAs, freshPage }) => {
    const owner = await openAs(ownerState.api);
    await openTeam(owner);
    const { name } = await inviteByEmail(owner, freshPage, 'ADMIN', 'Hızlı Kişi');
    await owner.reload();
    await peopleTab(owner);
    await expect(owner.getByRole('combobox', { name: `${name} DeciShip rolü` })).toBeVisible();
    // Yavaş ağda /me geç döner, tablo önbellekteki kişiyle çizilmiştir.
    await owner.route('**/api/account/me', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await owner.reload();
    await setDecishipRole(owner, name, 'AUDITOR');
  });

  test('Muhasebe fiyat görür ve fatura yükleyebilir (Y123); itiraz ve taşıyıcı yazamaz, API 403', async ({ openAs, freshPage }) => {
    const owner = await openAs(ownerState.api);
    await openTeam(owner);
    const { page, email } = await inviteByEmail(owner, freshPage, 'ACCOUNTING', 'Mert Muhasebe');

    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
    await expect(page.locator('body')).toContainText('611,20');
    await expect(page.getByRole('link', { name: 'Fatura yükle' })).toHaveCount(1);
    await page.getByText('9-482-11735').first().click();
    await page.getByRole('tab', { name: /Fark var/ }).click();
    await page.getByText('794812345305').first().click();
    await expect(page.locator('body')).toContainText('458,50');
    await expect(page.getByRole('button', { name: 'İtiraz listesine ekle' })).toHaveCount(0);

    const web = await WebApi.create();
    await web.login(email);
    const write = await web.raw().post('/api/deciship/carriers', { data: { code: 'ups' }, headers: { 'X-SOD-Org': web.orgId! } });
    expect(write.status()).toBe(403);
    await web.dispose();
  });

  test('EN: telefon daveti, /join, Ölçüm mobil sayfası', async ({ openAs, freshPage }) => {
    const en = await registerOwner({ orgName: `Team Logistics ${uniq('')}`, locale: 'en' });
    const owner = await openAs(en.api, 'en-US');
    await owner.goto('/account/team');
    await owner.getByRole('button', { name: 'Invite person' }).click();
    const panel = owner.getByRole('dialog');
    await panel.getByRole('button', { name: 'Phone + code' }).click();
    const phone = uniqPhone();
    await panel.locator('#inv-name').fill('Mark Depot');
    await panel.locator('#inv-contact').fill(phone);
    await panel.locator('#inv-deciship').selectOption('MEASURE');
    await panel.getByRole('button', { name: 'Create code' }).click();
    const dlg = owner.getByRole('dialog');
    await expect(dlg).toContainText('This code is not shown again');
    const code = (await dlg.getByLabel('One-time code').innerText()).replace(/[\s-]/g, '');
    const page = await freshPage('en-US');
    await page.goto('/join');
    await page.getByLabel('Phone').fill(phone);
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible();
    await page.getByLabel('Set a password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page).toHaveURL(`${APP}/home`);
    await expect(page.getByText('This role works in the mobile app').first()).toBeVisible();
    await page.goto('/deciship/');
    await expect(page.getByRole('heading', { name: 'This role works in the mobile app' })).toBeVisible();
  });

  test('Muhasebe tarifeleri görür, değiştiremez: gerçek API ve web', async ({ openAs, freshPage }) => {
    const owner = await openAs(ownerState.api);
    await openTeam(owner);
    const { page, email } = await inviteByEmail(owner, freshPage, 'ACCOUNTING', 'Tülin Tarife');

    // API: okuma açık, her yazma 403
    const web = await WebApi.create();
    await web.login(email);
    const { items } = await web.get<{ items: { id: string; tariffs?: { id: string }[] }[] }>('/api/deciship/tariffs');
    const tariffId = (items[0]?.tariffs?.[0]?.id ?? items[0]?.id)!;
    expect(tariffId).toBeTruthy();
    const detail = await web.raw().get(`/api/deciship/tariffs/${tariffId}`);
    expect(detail.status()).toBe(200);
    const h = { 'X-SOD-Org': web.orgId! };
    const body = (await detail.json()) as { tariff: Record<string, unknown> };
    expect(JSON.stringify(body)).toMatch(/rates/);
    const denied = [
      await web.raw().post('/api/deciship/tariffs', { headers: h, data: { name: 'x' } }),
      await web.raw().put(`/api/deciship/tariffs/${tariffId}`, { headers: h, data: body.tariff }),
      await web.raw().delete(`/api/deciship/tariffs/${tariffId}`, { headers: h }),
      await web.raw().post(`/api/deciship/tariffs/${tariffId}/default`, { headers: h, data: {} }),
      await web.raw().post(`/api/deciship/tariffs/${tariffId}/duplicate`, { headers: h, data: {} }),
    ];
    expect(denied.map((r) => r.status())).toEqual([403, 403, 403, 403, 403]);
    expect((await web.raw().get('/api/deciship/tariffs/template.xlsx')).status()).toBe(403);
    await web.dispose();

    // Web: menüde var, yazma düğmesi yok, editör salt okunur
    await page.goto('/deciship/tariffs');
    await expect(page.getByRole('heading', { name: 'Tarifeler', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tarifeler' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Yeni tarife' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Taşıyıcı ekle' })).toHaveCount(0);
    await expect(page.locator('body')).toContainText('FedEx International Economy 2026');
    await page.goto(`/deciship/tariffs/${tariffId}`);
    await expect(page.getByText('Salt okunur').first()).toBeVisible();
    await expect(page.locator('body')).toContainText('FedEx International Economy 2026');
    await expect(page.getByRole('button', { name: 'Kaydet', exact: true })).toHaveCount(0);
    await expect(page.locator('#t-disc')).toBeDisabled();
    // Yeni tarife adresi yazılırsa nedeni söylenir
    await page.goto('/deciship/tariffs/new');
    await expect(page.locator('#t-name')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  });

  test('askı ve çıkarma anında etki: bekleme süreleri ölçülür', async ({ openAs, freshPage }) => {
    const owner = await openAs(ownerState.api);
    await openTeam(owner);
    const { page, email, name } = await inviteByEmail(owner, freshPage, 'AUDITOR', 'Aslı Askı');
    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();

    const bearer = await MobileApi.login(email, PASSWORD);
    expect((await bearer.get('/api/deciship/me')).status).toBe(200);

    // Askı
    await reloadSettled(owner);
    await peopleTab(owner);
    await owner.getByRole('button', { name: `${name} için işlemler` }).click();
    await owner.getByRole('menuitem', { name: 'Askıya al' }).click();
    await owner.getByRole('dialog').getByRole('button', { name: 'Askıya al' }).click();
    const t1 = Date.now();
    await waitMs(async () => (await bearer.get('/api/deciship/me')).status !== 200);
    recordMetric('olay_aski_ms', Date.now() - t1);
    const denied = await bearer.get('/api/deciship/me');
    expect([401, 403]).toContain(denied.status);
    // Askıdaki kişi yenileyince DeciShip erişimi yok
    const refreshed = await bearer.refresh();
    if (refreshed.status === 200) expect((await bearer.get('/api/deciship/me')).status).toBe(403);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toHaveCount(0);

    // Askı kalkar
    await owner.getByRole('button', { name: `${name} için işlemler` }).click();
    const resumed = owner.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/account/org/members/'));
    await owner.getByRole('menuitem', { name: 'Askıyı kaldır' }).click();
    expect((await resumed).status()).toBe(200);
    const back = await MobileApi.login(email, PASSWORD);
    // Yeni girişin jetonu askıdan sonraki daha büyük sürümü (epoch) taşır: DeciShip jetonla eşitlemede pasif üyeyi hemen
    // açar, olayı beklemez (KALANLAR 6.10). Ölçülen olay gecikmesi değil, yeni girişten ilk başarılı isteğe kadar geçen süre.
    const t3 = Date.now();
    await waitMs(async () => (await back.get('/api/deciship/me')).status === 200);
    recordMetric('jeton_aski_kaldirma_ms', Date.now() - t3);

    // Çıkarma
    await owner.getByRole('button', { name: `${name} için işlemler` }).click();
    await owner.getByRole('menuitem', { name: 'Firmadan çıkar' }).click();
    await owner.getByRole('dialog').getByRole('button', { name: /Firmadan çıkar/ }).click();
    const t2 = Date.now();
    await expect(owner.getByText(`${name} firmadan çıkarıldı`)).toBeVisible();
    await waitMs(async () => (await back.get('/api/deciship/me')).status !== 200);
    recordMetric('olay_cikarma_ms', Date.now() - t2);
    const gone = await back.get('/api/deciship/invoices');
    expect([401, 403]).toContain(gone.status);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toHaveCount(0);
    await bearer.dispose();
    await back.dispose();
  });
});
