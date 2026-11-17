import { expect, test, type Page } from './base';
import { APP, REAL_STACK, mockSession } from './helpers';

// Tarifeleri görme izni (`deciship.tariffs.view`): liste ve tarife okunur, fiyat hesaplanır, değişiklik yapılamaz.
test.skip(REAL_STACK, 'mock kişileri gerektirir');

const toolNav = (page: Page) => page.locator('nav.sod-nav');

async function expectViewOnly(page: Page) {
  const form = page.locator('fieldset.te-ro');
  await expect(form.locator('#t-name')).toBeDisabled();
  await expect(form.locator('#t-disc')).toBeDisabled();
  await expect(form.locator('table.rg input').first()).toBeDisabled();
  // değiştiren hiçbir düğme çizilmez: pasif de durmaz
  await expect(form.locator('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kaydet', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bu sürüme dön' })).toHaveCount(0);
  await expect(page.locator('.te-side input[type="file"]')).toHaveCount(0);
  await expect(page.getByText('Salt okunur', { exact: true })).toBeVisible();
}

async function quoteWorks(page: Page) {
  await page.locator('#q-c').fill('DE');
  await page.locator('.qt-btn').click();
  await expect(page.locator('.quote-res .quote-total')).toBeVisible();
}

test.describe('Muhasebe tarifeleri salt okunur görür', () => {
  test('menüde Tarifeler; listede düzenleme, silme, varsayılan yapma, şablon yok', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/invoices`);
    await toolNav(page).getByRole('link', { name: 'Tarifeler' }).click();
    await expect(page).toHaveURL(/\/deciship\/tariffs$/);
    await expect(page.locator('.tl-table tbody tr').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Yeni tarife' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Excel şablonu indir' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Taşıyıcıyı düzenle' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Kaldır', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ekle', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Varsayılan yap' })).toHaveCount(0);
    await expect(page.locator('.tl-row-actions')).toHaveCount(0);
    // satır açılır
    await page.locator('.tl-table tbody tr').first().click();
    await expect(page).toHaveURL(/\/deciship\/tariffs\/[^/]+$/);
    await expectViewOnly(page);
  });

  test('tarife: alanlar kapalı, düğme yok, Fiyat hesapla çalışır, sürüm geçmişi okunur', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/tariffs/t1`);
    await expectViewOnly(page);
    await expect(page.getByRole('heading', { name: 'Sürüm geçmişi' })).toBeVisible();
    await quoteWorks(page);
    // sayfa temiz: ayrılırken uyarı sorulmaz
    await toolNav(page).getByRole('link', { name: 'Faturalar' }).click();
    await expect(page).toHaveURL(/\/deciship\/invoices$/);
  });

  test('değerler soluk değil: ana metin rengiyle okunur', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/tariffs/t1`);
    const input = page.locator('fieldset.te-ro #t-name');
    await expect(input).toBeDisabled();
    const colors = await input.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text)';
      document.body.append(probe);
      const text = getComputedStyle(probe).color;
      probe.remove();
      return { input: getComputedStyle(el).color, text };
    });
    expect(colors.input).toBe(colors.text);
  });

  test('yeni tarife adresi: neden ve tarifelere dönüş', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/tariffs/new?carrierId=c1`);
    await expect(page.getByRole('heading', { name: 'Tarife ekleme izniniz yok' })).toBeVisible();
    await expect(page.getByText('firma yöneticinize başvurun')).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await page.getByRole('link', { name: 'Tarifelere dön' }).click();
    await expect(page).toHaveURL(/\/deciship\/tariffs$/);
    await expect(page.locator('.tl-table tbody tr').first()).toBeVisible();
  });

  test('faturadan tarifeye gidilir', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/invoices/i1`);
    await page.getByRole('link', { name: 'FedEx International Economy 2026' }).click();
    await expect(page).toHaveURL(/\/deciship\/tariffs\/t1$/);
    await expectViewOnly(page);
  });

  test('sunucu yazmayı reddeder, hesap yapar (mock API ile aynı kural)', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/tariffs/t1`);
    await expect(page.locator('#t-name')).toBeDisabled();
    const result = await page.evaluate(async () => {
      const csrf = document.cookie.match(/sod_csrf=([^;]+)/)?.[1] ?? 'x';
      const call = (method: string, url: string, body?: unknown) =>
        fetch(`/api/deciship${url}`, { method, headers: { 'content-type': 'application/json', 'x-sod-csrf': csrf }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.status);
      return {
        list: await call('GET', '/tariffs?carrierId=c1'),
        one: await call('GET', '/tariffs/t1'),
        versions: await call('GET', '/tariffs/t1/versions'),
        quote: await call('POST', '/tariffs/t1/quote', { lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4 }),
        template: await call('GET', '/tariffs/template.xlsx'),
        remove: await call('DELETE', '/tariffs/t1'),
        makeDefault: await call('POST', '/tariffs/t1/default'),
        upload: await call('POST', '/tariff-imports'),
      };
    });
    expect(result).toEqual({ list: 200, one: 200, versions: 200, quote: 200, template: 403, remove: 403, makeDefault: 403, upload: 403 });
  });

  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${width} px: sayfa taşmaz, fiyat hesabı ilk ekranda ya da yanında`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await mockSession(page, 'accounting');
      await page.goto(`${APP}/tariffs`);
      await expect(page.locator('.tl-table tbody tr').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      await page.goto(`${APP}/tariffs/t1`);
      await expect(page.locator('fieldset.te-ro #t-name')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const quote = (await page.locator('.qt').boundingBox())!;
      const form = (await page.locator('fieldset.te-ro').boundingBox())!;
      if (width < 1024) expect(quote.y).toBeLessThan(form.y); // telefonda uzun formun altında kalmaz
      else expect(quote.x).toBeGreaterThanOrEqual(form.x + form.width);
      await quoteWorks(page);
    });
  }
});

test('Denetleyici düzenler: düğmeler ve alanlar açık, içe aktarma var', async ({ page }) => {
  await mockSession(page, 'auditor');
  await page.goto(`${APP}/tariffs/t1`);
  await expect(page.locator('#t-name')).toBeEnabled();
  await expect(page.locator('fieldset.te-ro')).toHaveCount(0);
  // değişiklik yokken kaydetme çubuğu gizli; Denetleyici bir alanı değiştirince Kaydet açılır
  await expect(page.locator('.savebar')).toHaveCount(0);
  await page.locator('#t-name').fill('Denetleyici adı');
  await expect(page.getByRole('button', { name: 'Kaydet', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Bölge ekle' })).toBeVisible();
  await expect(page.locator('.te-side input[type="file"]')).toHaveCount(1);
  await expect(page.getByText('Salt okunur', { exact: true })).toHaveCount(0);
});

test.describe('tarife değişince yeniden karşılaştırma önerisi', () => {
  async function saveWithNewFuel(page: Page, tariffId: string) {
    await mockSession(page, 'auditor');
    await page.goto(`${APP}/tariffs/${tariffId}`);
    await page.locator('#t-fuel').fill('26');
    await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
    await expect(page.getByText('Tarife kaydedildi')).toBeVisible();
  }

  test('faturanın kullandığı tarife: öneri ve düğme çıkar, önce/sonra penceresi onaylanınca öneri kalkar', async ({ page }) => {
    await saveWithNewFuel(page, 't1');
    const notice = page.locator('.te-notice');
    // Mesaj 4: eski fatura hesaplandığı günkü tarifeyle durur; geçiş önce/sonra penceresiyle
    await expect(notice).toContainText('hesaplandığı günkü tarifeyle duruyor');
    await page.getByRole('button', { name: 'Yeni tarifeye geçir' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('yeni tarifeye geçirilsin mi?');
    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(notice).toContainText('yeni tarifeye geçirildi');
    await expect(page.getByRole('button', { name: 'Yeni tarifeye geçir' })).toHaveCount(0);
  });

  test('varsayılan olmayan, faturanın kullanmadığı tarife: yeniden karşılaştırma önerilmez, bu tarifenin o faturayı değiştirmediği söylenir', async ({ page }) => {
    await saveWithNewFuel(page, 't3');
    await expect(page.locator('.te-notice')).toContainText('başka tarifeyle karşılaştırılıyor');
    await expect(page.locator('.te-notice')).toContainText('değiştirmez');
    await expect(page.locator('.te-notice')).not.toContainText('Yeni faturalar bu tarifeyle');
    await expect(page.getByRole('button', { name: 'Faturaları yeniden karşılaştır' })).toHaveCount(0);
  });
});

test('görme izni yoksa menüde yok, adres nedenini söyler', async ({ page }) => {
  await mockSession(page, 'accounting', { sod_mock_strip_perm: 'deciship.tariffs.view' });
  await page.goto(`${APP}/invoices`);
  await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
  await expect(toolNav(page).getByRole('link', { name: 'Tarifeler' })).toHaveCount(0);
  for (const path of ['tariffs', 'tariffs/t1', 'tariffs/new']) {
    await page.goto(`${APP}/${path}`);
    await expect(page.getByRole('heading', { name: 'Bu sayfa rolünüze açık değil' })).toBeVisible();
  }
  await page.goto(`${APP}/invoices/i1`);
  await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'FedEx International Economy 2026' })).toHaveCount(0); // ölü bağlantı yok
});

test('abonelik salt okunur: düzenleyen kişi de salt okunur görür, Fiyat hesapla çalışır, yeni tarife nedenini söyler', async ({ page }) => {
  await mockSession(page, 'owner', { sod_mock_readonly: '1' });
  await page.goto(`${APP}/tariffs/t1`);
  await expectViewOnly(page);
  await quoteWorks(page);
  await page.goto(`${APP}/tariffs/new`);
  await expect(page.getByRole('heading', { name: 'Tarife ekleme izniniz yok' })).toBeVisible();
  await expect(page.getByText('Abonelik salt okunur modda: yeni tarife eklenemez')).toBeVisible();
});

for (const lang of ['tr', 'en']) {
  for (const width of [1024, 1280, 1440]) {
    test(`kurulum menü öğesi ${lang} ${width} px: ad kesilmez, etiketle çakışmaz`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockSession(page, 'fresh', { sod_mock_locale: lang });
      await page.goto(`${APP}/setup`);
      const link = page.locator('nav.sod-nav a', { has: page.locator('.ds-setup-tag') });
      await expect(link).toBeVisible();
      const m = await link.evaluate((a) => {
        const label = a.querySelector(':scope > span:not(.ds-setup-tag)')!.getBoundingClientRect();
        const tag = a.querySelector('.ds-setup-tag')!.getBoundingClientRect();
        const box = a.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(a.querySelector(':scope > span:not(.ds-setup-tag)')!);
        const text = range.getBoundingClientRect();
        return { labelRight: text.right, labelBottom: label.bottom, tagLeft: tag.left, tagTop: tag.top, tagRight: tag.right, boxRight: box.right };
      });
      expect(m.tagRight).toBeLessThanOrEqual(m.boxRight);
      // etiket adın yanında ya da altında: üstüne binmez
      expect(m.labelRight <= m.tagLeft || m.labelBottom <= m.tagTop).toBe(true);
    });
  }
}
