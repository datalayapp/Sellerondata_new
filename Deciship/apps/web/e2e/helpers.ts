import { expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import path from 'node:path';

export const samples = path.resolve(import.meta.dirname, '../../../samples');
export const PASSWORD = 'Test12345!';
export const APP = '/deciship';
/** Gerçek sistem (ağ geçidi) mi, mock mu? Yalnız mock'a özgü test kancaları bu ayrıma bakar. */
export const REAL_STACK = Boolean(process.env.E2E_BASE_URL);

/** Mock kişileri: `src/mocks/account.ts` ile aynı. Kod rol adına bakmaz; testler kişiyle konuşur. */
export const PEOPLE = {
  owner: { personId: 'p1', orgId: 'o1' },
  auditor: { personId: 'p3', orgId: 'o1' },
  accounting: { personId: 'p4', orgId: 'o1' },
  measure: { personId: 'p5', orgId: 'o1' },
  noRole: { personId: 'p8', orgId: 'o1' },
  fresh: { personId: 'p9', orgId: 'o3' },
  noOrg: { personId: 'p10', orgId: null },
} as const;
export type Person = keyof typeof PEOPLE;

/** Mock durumu tarayıcı deposundadır: her test temiz başlar. `hooks`: `sod_mock_*` test kancaları. */
export async function mockSession(page: Page, person: Person | null, hooks: Record<string, string> = {}) {
  await page.goto(`${APP}/favicon.svg`);
  await page.evaluate(
    ({ session, hooks }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('sod_mock_fast', '1');
      if (session) localStorage.setItem('sod_mock_session', JSON.stringify(session));
      for (const [k, v] of Object.entries(hooks)) localStorage.setItem(k, v);
    },
    { session: person ? PEOPLE[person] : null, hooks },
  );
}

/**
 * Yeni firma açar ve Pano'ya gelir. Kayıt Merkez'dedir (`POST /api/account/auth/register`, ARCHITECTURE §6); mock'ta karşılığı
 * boş firmanın sahibi. Yeni firmada Pano bir kez kurulum sihirbazına yönlendirir, menüden Pano'ya dönülür.
 */
export async function registerCompany(page: Page, label = 'E2E') {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `e2e-${stamp}@example.com`;
  if (REAL_STACK) {
    const res = await page.request.post('/api/account/auth/register', {
      headers: { 'X-SOD-CSRF': '1', 'X-Forwarded-For': `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}` },
      data: { orgName: `${label} Lojistik ${stamp}`, name: 'Test Yönetici', email, password: PASSWORD, country: 'TR', locale: 'tr' },
    });
    expect(res.ok()).toBeTruthy();
  } else {
    await mockSession(page, 'fresh');
  }
  await page.goto(`${APP}/`);
  await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();
  await page.getByRole('link', { name: 'Pano' }).click();
  await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  return { email, password: PASSWORD };
}

/** FedEx carrier + a tariff whose rate grid comes from the Excel template (same steps as the smoke test). */
export async function createFedexTariff(page: Page) {
  await page.getByRole('link', { name: 'Tarifeler' }).click();
  await page.getByRole('button', { name: 'Taşıyıcı ekle' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('FedEx tarifeleri')).toBeVisible();
  await page.getByRole('link', { name: 'Yeni tarife' }).click();
  await page.getByRole('button', { name: 'veya elle oluştur' }).click();
  await page.fill('#t-name', 'FedEx International Economy 2026');
  await page.fill('#t-disc', '38');
  await page.fill('#t-fuel', '25');
  await page.getByLabel('1. satır ağırlık').fill('0,5');
  await page.getByLabel('0,5 kg A fiyatı', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/\/deciship\/tariffs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Dosyadan içe aktar' })).toBeVisible();
  await page.getByTestId('tariff-file').setInputFiles(path.join(samples, 'tariff-template-example.xlsx'));
  const importDialog = page.getByRole('dialog', { name: 'Tarifeyi içe aktar' });
  await expect(importDialog).toBeVisible();
  const ack = importDialog.locator('.iw-ack input');
  if (await ack.count()) await ack.check();
  await importDialog.getByRole('button', { name: 'Uygula', exact: true }).click();
  await expect(page.getByText('Tarife içe aktarıldı')).toBeVisible();
}

/** Manual measurement for #5305 (40×30×25, 4 kg): the sample invoice bills it +458,50 ₺ too much. */
export async function addMeasurement5305(page: Page) {
  await page.getByRole('link', { name: 'Ölçümler' }).click();
  await page.getByRole('button', { name: 'Elle ölçüm ekle' }).first().click();
  await page.fill('#m-trk', '794812345305');
  await page.fill('#m-l', '40');
  await page.fill('#m-w', '30');
  await page.fill('#m-h', '25');
  await page.fill('#m-kg', '4');
  await page.getByRole('dialog').getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('cell', { name: '794812345305' })).toBeVisible();
}

/** Uploads the FedEx sample invoice and waits for its comparison page. */
export async function importSampleInvoice(page: Page) {
  await page.getByRole('link', { name: 'Faturalar' }).click();
  await page.getByRole('link', { name: 'Fatura yükle' }).first().click();
  await page.getByRole('radio', { name: /FedEx/ }).click();
  await page.setInputFiles('[data-testid=invoice-file]', path.join(samples, 'invoices/fedex-9-482-11735.csv'));
  await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.locator('#ino')).toHaveValue('9-482-11735');
  await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
  await expect(page).toHaveURL(/\/deciship\/invoices\/[0-9a-f-]{36}/);
  await expect(page.locator('.ptitle .mono')).toHaveText('9-482-11735');
}
