import { test, expect } from '../lib/fixtures.ts';
import { MobileApi, PASSWORD, WebApi, provisionDeciship, registerOwner } from '../lib/api.ts';
import { APP, recordMetric, startService, stopService } from '../lib/sys.ts';
import { bandNav, openApps } from '../lib/shell.ts';

/** Servis durdurur: tek işçi, sırayla. Her test sonunda servisler açılır. */
test.use({ allowHttp5xx: true });

async function healthy(page: import('@playwright/test').Page, url: string) {
  await expect.poll(async () => (await page.request.get(url).catch(() => null))?.status(), { timeout: 90_000, intervals: [500] }).toBe(200);
}

test.describe('Kesintiler', () => {
  test.afterEach(() => {
    startService('account-api');
    startService('deciship-api');
  });

  test("Hesap durduğunda: açık oturum DeciShip'te çalışır, oturum kapanmaz, kullanıcı durumu anlar", async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Kesinti Lojistik' });
    const { invoiceId } = await provisionDeciship(owner);
    const page = await openAs(owner.api);
    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();

    stopService('account-api');
    try {
      // Sayfa açık: istemci içi gezinti ve DeciShip API çalışır
      await page.getByRole('link', { name: 'Pano' }).click();
      await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
      expect((await page.request.get(`/api/deciship/invoices/${invoiceId}`)).status()).toBe(200);

      // Fark kararı (yazma) Hesap'a sormadan gider
      const lines = await (await page.request.get(`/api/deciship/invoices/${invoiceId}/lines?status=DIFF`)).json();
      const lineId = lines.items[0].id as string;
      const write = await page.request.patch(`/api/deciship/invoice-lines/${lineId}`, {
        headers: { 'X-SOD-CSRF': '1', Origin: APP, 'X-SOD-Org': owner.me.activeOrg!.id },
        data: { decision: 'VERIFIED' },
      });
      expect(write.status(), await write.text()).toBeLessThan(300);

      // Tam sayfa yenileme: DeciShip açık oturumla çalışmalı, girişe atmamalı
      await page.goto(`/deciship/invoices/${invoiceId}`);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator('.ptitle .mono')).toHaveText('9-482-11735', { timeout: 20_000 });

      // Merkez: Hesap kesik, giriş sayfasına atılmaz; DeciShip bölümü çalışır.
      await page.goto('/home');
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator('.hub-hero')).toContainText('611,20');
      await expect(page.getByRole('heading', { name: 'Genel Bakış' })).toBeVisible();
      // Hesap'a bağlı sayfa hata gösterir, oturumu düşürmez
      await page.goto('/account/team');
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByRole('heading', { name: 'Ekip ve yetkiler' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Tekrar dene/ }).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      startService('account-api');
    }
    await healthy(page, '/api/account/health');
    // Hesap döndü: aynı oturum, yeniden giriş yok.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Ekip ve yetkiler' })).toBeVisible();
    await expect(page.getByText('Selin Sahip').first()).toBeVisible();
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Genel Bakış' })).toBeVisible();
    await expect(page.getByText('Bağlantı yok')).toHaveCount(0);
  });

  test('Hesap kesikken Merkez Genel Bakış kullanıcıya durumu söyler', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Durum Lojistik' });
    const page = await openAs(owner.api);
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    stopService('account-api');
    try {
      await page.reload();
      await expect(page).not.toHaveURL(/login/);
      await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
      await expect(page.getByText('Bağlantı yok.').or(page.getByText(/Hesap servisi/)).first()).toBeVisible({ timeout: 30_000 });
    } finally {
      startService('account-api');
    }
  });

  test('olay kuyruğu: DeciShip kapalıyken rol değişir, Hesap da yeniden başlar; açılınca olay teslim olur', async () => {
    const owner = await registerOwner({ orgName: 'Kuyruk Lojistik' });
    await provisionDeciship(owner);
    const email = `kuyruk${Date.now()}@e2e.sellerondata.test`;
    const invited = await owner.api.post<{ link: string }>('/api/account/org/members/invite', {
      kind: 'EMAIL',
      email,
      name: 'Kuyruk Kişi',
      orgRole: 'MEMBER',
      productRoles: { deciship: 'ADMIN' },
    });
    const token = new URL(invited.link).pathname.split('/').pop()!;
    const member = await WebApi.create();
    await member.post(`/api/account/invites/${token}/accept`, { name: 'Kuyruk Kişi', password: PASSWORD, client: 'web' });
    const meMember = await member.me();
    const bearer = await MobileApi.login(email, PASSWORD);
    expect((await bearer.get('/api/deciship/settings/onboarding')).status).toBe(200);

    stopService('deciship-api');
    const t0 = Date.now();
    await owner.api.patch(`/api/account/org/members/${meMember.activeOrg!.membershipId}`, { productRoles: { deciship: 'AUDITOR' } });
    // Dağıtıcı kapalı hedefe deneyip geri çekilir. Hesap da yeniden başlar: kuyruk bellekte değil.
    await new Promise((r) => setTimeout(r, 3000));
    stopService('account-api');
    startService('deciship-api');
    startService('account-api');

    const ctx = await WebApi.create();
    await expect.poll(async () => (await ctx.raw().get('/api/deciship/health').catch(() => null))?.status(), { timeout: 90_000, intervals: [500] }).toBe(200);
    await expect.poll(async () => (await ctx.raw().get('/api/account/health').catch(() => null))?.status(), { timeout: 90_000, intervals: [500] }).toBe(200);
    const up = Date.now();
    // Eski jeton TOKEN_STALE alana kadar: olay teslim oldu demektir. Üst sınır jeton ömrü, geri çekilme bunun altında kalmalı.
    await expect.poll(async () => (await bearer.get('/api/deciship/settings/onboarding')).status, { timeout: 180_000, intervals: [500] }).toBe(401);
    recordMetric('olay_kuyruk_acilistan_sonra_ms', Date.now() - up);
    recordMetric('olay_kuyruk_toplam_ms', Date.now() - t0);
    const stale = await bearer.get('/api/deciship/settings/onboarding');
    expect(stale.body.error.code).toBe('TOKEN_STALE');
    await bearer.dispose();
    await member.dispose();
    await ctx.dispose();
  });

  test('DeciShip API durunca Merkez yalnız o bölümde hata gösterir, sayfa ayakta', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Bölüm Lojistik' });
    await provisionDeciship(owner);
    const page = await openAs(owner.api);
    await page.goto('/home');
    await expect(page.locator('.hub-hero')).toBeVisible();

    stopService('deciship-api');
    try {
      await page.reload();
      await expect(page.getByText('DeciShip verisi alınamadı.')).toBeVisible({ timeout: 30_000 });
      // Sayfanın geri kalanı çalışır: bant menüsü, uygulama seçici, firma durumu, araç listesi
      await expect(page.getByRole('heading', { name: 'Genel Bakış' })).toBeVisible();
      await expect(bandNav(page, 'Merkez')).toBeVisible();
      await expect((await openApps(page)).getByRole('menuitem', { name: /DeciShip/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('heading', { name: 'Araçlar' })).toBeVisible();
      // Bağlantı hem bant menüsünde hem Genel Bakış içeriğinde: gezinti bant menüsünden.
      await bandNav(page, 'Merkez').getByRole('link', { name: 'Ekip ve yetkiler' }).click();
      await expect(page.getByRole('heading', { name: 'Ekip ve yetkiler' })).toBeVisible();
      await expect(page.getByText('Selin Sahip').first()).toBeVisible();
      await page.goto('/analytics/deciship');
      await expect(page.getByText('DeciShip analizi alınamadı.')).toBeVisible({ timeout: 30_000 });
      await expect(bandNav(page, 'Merkez')).toBeVisible();
      await expect((await openApps(page)).getByRole('menuitem', { name: /DeciShip/ })).toBeVisible();
      await page.keyboard.press('Escape');
      // DeciShip tarafında kullanıcıya durum
      await page.goto('/deciship/');
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator('body')).toContainText(/Sunucuya|bağlan|yüklenemedi|Bağlantı/, { timeout: 30_000 });
    } finally {
      startService('deciship-api');
    }
    await healthy(page, '/api/deciship/health');
    await page.goto('/home');
    await expect(page.locator('.hub-hero')).toBeVisible();
  });
});
