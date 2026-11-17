import { expect, test, type Page } from './base';
import fs from 'node:fs';
import path from 'node:path';
import { APP, REAL_STACK, addMeasurement5305, createFedexTariff, importSampleInvoice, mockSession, registerCompany, samples } from './helpers';

/** Only the app's API calls (Vite also serves source files under /src/api/…). */
const isApi = (url: URL) => url.pathname.startsWith('/api/');

/** Recipient names from the sample invoice: none may leak into the WhatsApp message. */
function recipientNames(): string[] {
  const [head, ...rows] = fs.readFileSync(path.join(samples, 'invoices/fedex-9-482-11735.csv'), 'utf8').trim().split(/\r?\n/);
  const col = head.split(',').indexOf('Recipient Name');
  return [...new Set(rows.map((r) => r.split(',')[col]).filter(Boolean))];
}

/** Sunucu kapalı: gerçek sistemde ağ düzeyinde, mock'ta istekleri servis çalışanı yanıtladığı için kancayla. */
async function serverDown(page: Page, down: boolean) {
  if (REAL_STACK) {
    if (down) await page.route(isApi, (r) => r.abort('connectionrefused'));
    else await page.unroute(isApi);
  } else {
    await page.evaluate((d) => (d ? localStorage.setItem('sod_mock_offline', '1') : localStorage.removeItem('sod_mock_offline')), down);
  }
}

async function openSampleInvoice(page: Page, withMeasurement: boolean) {
  await registerCompany(page);
  await createFedexTariff(page);
  if (withMeasurement) await addMeasurement5305(page);
  await importSampleInvoice(page);
}

test('fatura özeti: fazla ödeme, karşılaştırılan satır cümlesi, itiraz süresi, WhatsApp yalnız sayılar', async ({ page }) => {
  await openSampleInvoice(page, true);

  const sum = page.getByRole('region', { name: 'Özet' });
  await expect(sum).not.toHaveAttribute('aria-busy');
  // #5305 dimension diff +458,50 and the in-invoice duplicate #5288 +1.120,00 (samples/README.md)
  await expect(sum.locator('.inv-sum-v')).toHaveText('1.578,50₺');
  await expect(sum.locator('.inv-sum-n').first()).toHaveText(/^2\/18 satır karşılaştırıldı · 2 satırda fark var/);
  // the deadline depends on today's date: either "son gün … kaldı" or "süresi doldu"
  await expect(sum.locator('.inv-sum-due')).toHaveText(/TTK (itirazı için son gün \d{1,2} \p{L}+ \d{4} · |itiraz süresi doldu)/u);

  await page.getByRole('button', { name: 'Diğer' }).click();
  const wa = page.getByRole('menuitem', { name: "WhatsApp'ta paylaş" });
  await expect(wa).toBeVisible();
  const href = (await wa.getAttribute('href')) ?? '';
  const url = new URL(href);
  expect(url.host).toBe('wa.me');
  const text = url.searchParams.get('text') ?? '';
  expect(text).toContain('9-482-11735');
  expect(text).toContain('Fazla ödeme 1.578,50 ₺');
  const names = recipientNames();
  expect(names.length).toBeGreaterThan(3);
  for (const n of names) expect(text).not.toContain(n);
  expect(text).not.toMatch(/7948\d{8}/); // no tracking numbers either
});

test('telefonda (390 px) fatura ayrıntısı: "Diğer" menüsü 5 öğe, Esc ile kapanır', async ({ page }) => {
  await openSampleInvoice(page, false);
  await page.setViewportSize({ width: 390, height: 844 });

  const more = page.getByRole('button', { name: 'Diğer' });
  await expect(more).toBeVisible();
  await expect(more).toBeEnabled();
  await more.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Excel indir', 'PDF indir', 'Düzenle', 'Yeniden karşılaştır', "WhatsApp'ta paylaş"]);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
});

test('sunucu kapalıyken "Sunucuya bağlanılamadı", sunucu dönünce Tekrar dene sayfayı açar', async ({ page }) => {
  await registerCompany(page);
  await page.goto(`${APP}/settings`);
  await expect(page.getByRole('heading', { name: 'Ayarlar' })).toBeVisible();

  await serverDown(page, true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sunucuya bağlanılamadı' })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Tekrar dene' });
  await expect(retry).toBeVisible();
  // still down: retry keeps the offline screen (no silent logout)
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Sunucuya bağlanılamadı' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);

  await serverDown(page, false);
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Ayarlar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sunucuya bağlanılamadı' })).toBeHidden();
});

test('oturum düşünce giriş sayfasına kalınan yerle gidilir', async ({ page }) => {
  test.skip(REAL_STACK, 'mock oturumu gerektirir');
  await mockSession(page, 'owner');
  await page.goto(`${APP}/settings?sekme=e2e`);
  await expect(page.getByRole('heading', { name: 'Ayarlar' })).toBeVisible();
  // yenileme jetonu da geçersiz: /me 401, /auth/refresh başarısız, oturum kendiliğinden biter
  await page.evaluate(() => localStorage.removeItem('sod_mock_session'));
  await page.reload();
  await expect(page).toHaveURL(/\/login\?next=%2Fdeciship%2Fsettings%3Fsekme%3De2e$/);
});

test('ayarlar: değişiklik yapılınca kaydet çubuğu görünür, kaydedince kaybolur', async ({ page }) => {
  await registerCompany(page);
  await page.getByRole('link', { name: 'Ayarlar' }).click();
  const edge = page.locator('#s-edge');
  await expect(edge).toBeVisible();
  const bar = page.getByRole('region', { name: 'Kaydet' });
  await expect(bar).toBeHidden();

  const before = await edge.inputValue();
  const next = before === '3' ? '4' : '3';
  await edge.fill(next);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Kaydedilmemiş değişiklikler');
  // putting the old value back is not a change
  await edge.fill(before);
  await expect(bar).toBeHidden();

  await edge.fill(next);
  await bar.getByRole('button', { name: 'Ayarları kaydet' }).click();
  await expect(page.getByText('Ayarlar kaydedildi')).toBeVisible();
  await expect(bar).toBeHidden();
  await page.reload();
  await expect(page.locator('#s-edge')).toHaveValue(next);
  await expect(bar).toBeHidden();
});

test('ayarlar: tartı okuması varsayılan kapalı; yönetici açınca kaydedilir (kullanıcı kararı 2026-11-12)', async ({ page }) => {
  await registerCompany(page);
  await page.getByRole('link', { name: 'Ayarlar' }).click();
  const toggle = page.getByLabel('Tartı fotoğrafını yapay zekâ okusun');
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#set-mobile')).toContainText('Açıkken her okuma yapay zekâ hakkınızdan düşer');
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/deciship/settings') patches.push(r.postData() ?? '');
  });
  await toggle.check();
  const bar = page.getByRole('region', { name: 'Kaydet' });
  await bar.getByRole('button', { name: 'Ayarları kaydet' }).click();
  await expect(page.getByText('Ayarlar kaydedildi')).toBeVisible();
  expect(patches.map((p) => JSON.parse(p).scaleAiRead)).toEqual([true]);
  if (process.env.SHOT_DIR) await page.locator('#set-mobile').screenshot({ path: path.join(process.env.SHOT_DIR, 'ayarlar-mobil-olcum.png') });
  await page.reload();
  await expect(page.getByLabel('Tartı fotoğrafını yapay zekâ okusun')).toBeChecked();
});
