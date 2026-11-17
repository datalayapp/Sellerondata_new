import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { FEDEX_INVOICE, SAMPLE_PERIOD, provisionDeciship, registerOwner } from '../lib/api.ts';
import { APP } from '../lib/sys.ts';

const PERIOD = SAMPLE_PERIOD.hub;

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
/** Tutar: Pano sembolü ayrı öğede çizer, boşluk biçim farkıdır; rakam ve sembol birebir aynı olmalı. */
const money = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '');

/** Pano: örnek faturanın ayının KPI'ları. */
async function panoNumbers(page: Page) {
  await page.goto('/deciship/');
  await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  await page.locator('#month').selectOption(SAMPLE_PERIOD.month);
  const lead = page.getByRole('region', { name: 'Özet göstergeler' });
  await expect(lead.locator('.dash-hero-v')).toContainText(/\d/);
  const row = async (label: string) => norm(await lead.locator('.dash-row', { hasText: label }).locator('dd').innerText());
  // İtiraz listesi tutarı baş kartın yan sütununda kendi satırında (D09 Pano).
  const verified = norm(await lead.locator('.dash-hero-row', { hasText: 'İtiraz listesinde' }).innerText());
  return {
    overcharge: norm(await lead.locator('.dash-hero-v').innerText()),
    verified: /İtiraz listesinde\s*([\d.,]+\s*₺)/.exec(verified)?.[1] ?? null,
    diff: await row('Fark var'),
    billed: await row('Faturalanan gönderi'),
  };
}

async function hubLedger(page: Page, label: string) {
  return norm(await page.locator('.hub-figure, .hub-ledger-row', { hasText: label }).first().locator('.hub-figure-value, .hub-ledger-value').first().innerText());
}

test.describe('Fark kararı araçta, Merkez aynı sayıyı gösterir', () => {
  test('karar DeciShip\'te verilir; Pano, Genel Bakış ve Analiz kuruşuna kadar aynı; Merkez satırı faturaya derin bağlantı verir', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Sayı Lojistik' });
    const { invoiceId } = await provisionDeciship(owner);
    const page = await openAs(owner.api);

    // Karar öncesi: Merkez ve Pano aynı
    const before = await panoNumbers(page);
    expect(money(before.overcharge)).toBe('611,20₺');
    expect(before.diff).toBe('4');
    expect(before.billed).toBe(String(FEDEX_INVOICE.lines));
    expect(money(before.verified)).toBe('0,00₺');

    await page.goto(`/home?${PERIOD}`);
    await expect(page.locator('.hub-hero')).toBeVisible();
    expect(money(await page.locator('.hub-hero').innerText())).toBe(money(before.overcharge));
    expect(await hubLedger(page, 'Fark bulunan gönderi')).toBe(before.diff);
    expect(await hubLedger(page, 'Karar bekleyen fark')).toBe('4');
    expect(money(await hubLedger(page, 'İtiraz listesinde'))).toBe(money(before.verified));

    // Fark kararı DeciShip'te: #5305 itiraz listesine
    await page.goto(`/deciship/invoices/${invoiceId}`);
    await page.getByRole('tab', { name: /Fark var/ }).click();
    await page.getByText('794812345305').first().click();
    await page.getByRole('button', { name: 'İtiraz listesine ekle' }).click();
    await expect(page.getByText('İtiraz listesine eklendi')).toBeVisible();

    // Merkez'de iş işlemi düğmesi yok, sayılar değişmiş
    const after = await panoNumbers(page);
    expect(money(after.overcharge), 'fazla ödeme kararla değişmez').toBe('611,20₺');
    expect(money(after.verified)).toBe('458,50₺');

    await page.goto(`/home?${PERIOD}`);
    await expect(page.locator('.hub-hero')).toBeVisible();
    expect(money(await page.locator('.hub-hero').innerText())).toBe(money(after.overcharge));
    expect(await hubLedger(page, 'Fark bulunan gönderi')).toBe(after.diff);
    expect(await hubLedger(page, 'Karar bekleyen fark')).toBe('3');
    expect(money(await hubLedger(page, 'İtiraz listesinde'))).toBe(money(after.verified));

    await page.goto(`/analytics/deciship?${PERIOD}`);
    await expect(page.getByText('Yakalanan fazla ödeme').first()).toBeVisible();
    const body = money(await page.locator('#sod-main').innerText());
    expect(body).toContain(money(after.overcharge));
    expect(body).toContain(money(after.verified));
    expect(body).toContain('28.501,33₺');

    // Veriler: satırdan derin bağlantı. Faturaya gider, yeniden giriş yok.
    await page.goto('/data/deciship/invoices');
    const row = page.locator('tr.hub-row-link', { hasText: FEDEX_INVOICE.no });
    await expect(row).toContainText('611,20');
    await expect(row).toContainText('458,50');
    await row.locator('a.hub-row-main').click();
    await expect(page).toHaveURL(new RegExp(`${APP}/deciship/invoices/${invoiceId}`));
    await expect(page.locator('.ptitle .mono')).toHaveText(FEDEX_INVOICE.no);

    // Satır veri seti: derin bağlantı aynı satırı açar, karar orada görünür
    await page.goto('/data/deciship/invoice-lines?filter.status=DIFF');
    const line = page.locator('tr.hub-row-link', { hasText: '794812345305' });
    await expect(line).toBeVisible();
    await line.locator('a.hub-row-main').click();
    await expect(page).toHaveURL(new RegExp(`/deciship/invoices/${invoiceId}`));
    await expect(page.getByText('İtiraz listesinde').locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('794812345305').locator('visible=true').first()).toBeVisible();
  });

  test('EN: Pano ve Genel Bakış aynı tutar, EN biçimi', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Numbers Logistics', locale: 'en' });
    await provisionDeciship(owner);
    const page = await openAs(owner.api, 'en-US');
    await page.goto(`/home?${PERIOD}`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.locator('.hub-hero')).toContainText('611.20');
    await page.goto('/deciship/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await page.locator('#month').selectOption(SAMPLE_PERIOD.month);
    await expect(page.locator('.dash-lead')).toContainText('611.20');
  });

  test('CSV dışa aktarma gerçek veriyi indirir', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'CSV Lojistik' });
    await provisionDeciship(owner);
    const page = await openAs(owner.api);
    await page.goto('/data/deciship/invoices');
    await expect(page.locator('tr.hub-row-link').first()).toBeVisible();
    // Mesaj 15: CSV nadir eylem, araç çubuğunun ⋯ menüsünde ("Diğer işlemler").
    await page.getByRole('button', { name: 'Diğer işlemler' }).click();
    const dl = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'CSV indir' }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const fs = await import('node:fs');
    const text = fs.readFileSync(await file.path(), 'utf8');
    expect(text).toContain(FEDEX_INVOICE.no);
  });
});
