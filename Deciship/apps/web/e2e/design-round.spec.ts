import { expect, test, type Page } from './base';
import { APP, REAL_STACK, mockSession, type Person } from './helpers';

// Son tasarım turu: tarife düzenleyici dar ekranda bozulmaz, tablolar kendi içinde kayar.
test.skip(REAL_STACK, 'mock kişileri gerektirir');

/** Sayfa ve bölüm kartları taşmaz. İçeride kayan tablolar (fiyat tablosu) kendi kabında kalır. */
async function noOverflow(page: Page) {
  const r = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sections: [...document.querySelectorAll('.te-sec, .te-side > .card')]
      .map((e) => ({ id: e.querySelector('h2')?.textContent ?? e.className, over: e.scrollWidth - e.clientWidth }))
      .filter((x) => x.over > 0),
  }));
  expect(r).toEqual({ page: 0, sections: [] });
}

/** Öğe hem ekranda hem kaydırılan kabın görünür alanında. */
async function fullyShown(page: Page, sel: string) {
  const hidden = await page.evaluate((s) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      if (r.right > document.documentElement.clientWidth + 0.5 || r.left < 0) out.push(`ekran ${el.getAttribute('aria-label')}`);
      const scroller = el.closest('.rg-wrap, .te-mini-wrap');
      if (scroller) {
        const w = scroller.getBoundingClientRect();
        if (r.right > w.right + 0.5 || r.left < w.left - 0.5) out.push(`kap ${el.getAttribute('aria-label')}`);
      }
    }
    return out;
  }, sel);
  expect(hidden).toEqual([]);
}

const WIDTHS = [1024, 1280, 1439, 1440, 1920];

for (const width of WIDTHS) {
  test(`${width} px tarife düzenleyici: taşma yok, sil düğmeleri görünür, ad ve Fiyat hesapla okunur`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await expect(page.locator('#t-name')).toBeEnabled();
    await noOverflow(page);

    await fullyShown(page, '.te-sur button, .te-mini button, .cz button, .rg .rg-act button');
    const del = page.getByRole('button', { name: 'Ek ücreti sil' }).first();
    await expect(del).toBeVisible();

    // ad tam okunur: giriş kutusu değeri kesmez
    const name = page.locator('.te-sur-name input').first();
    expect(await name.evaluate((e: HTMLInputElement) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

    // tüm sütunlar görünür, tablo yeterince geniş
    await expect(page.locator('.rg thead th.rg-z')).toHaveCount(3);
    expect(await page.locator('.rg-wrap').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

    const side = (await page.locator('.qt').boundingBox())!;
    const form = (await page.locator('fieldset.ds-ro').boundingBox())!;
    if (width >= 1440) expect(side.x).toBeGreaterThanOrEqual(form.x + form.width);
    else expect(side.y).toBeGreaterThanOrEqual(form.y + form.height); // araçlar formun altında
  });

  test(`${width} px Muhasebe tarife: taşma yok, tablo tam, Fiyat hesapla formun üstünde ya da yanında`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/tariffs/t1`);
    await expect(page.locator('fieldset.te-ro #t-name')).toBeDisabled();
    await noOverflow(page);
    expect(await page.locator('.rg-wrap').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    await expect(page.locator('.te-sec button')).toHaveCount(0);
    const quote = (await page.locator('.qt').boundingBox())!;
    const form = (await page.locator('fieldset.te-ro').boundingBox())!;
    if (width >= 1440) expect(quote.x).toBeGreaterThanOrEqual(form.x + form.width);
    else expect(quote.y + quote.height).toBeLessThanOrEqual(form.y);
  });
}

test('çok bölgeli fiyat tablosu kendi içinde kayar: ağırlık ve sil yerinde kalır, sayfa taşmaz', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/tariffs/t1`);
  const add = page.getByRole('button', { name: 'Bölge ekle' });
  await expect(add).toBeVisible();
  for (let i = 0; i < 6; i++) await add.click();
  await expect(page.locator('.rg thead th.rg-z')).toHaveCount(9);
  const wrap = page.locator('.rg-wrap');
  expect(await wrap.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeGreaterThan(0);
  await noOverflow(page);
  await fullyShown(page, '.rg tbody .rg-act button');

  await wrap.evaluate((e) => (e.scrollLeft = 200));
  const box = await page.evaluate(() => {
    const w = document.querySelector('.rg-wrap')!.getBoundingClientRect();
    const first = document.querySelector('.rg tbody .rg-w')!.getBoundingClientRect();
    return { firstLeft: first.left - w.left };
  });
  expect(box.firstLeft).toBeLessThanOrEqual(1.5); // ilk sütun yapışık
  await fullyShown(page, '.rg tbody .rg-act button');
});

test('sürüm geçmişinde sözcük ortadan bölünmez', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/tariffs/t1`);
  const label = page.locator('.vh-label').first();
  await expect(label).toBeVisible();
  expect(await label.evaluate((e) => getComputedStyle(e).overflowWrap)).toBe('break-word');
  const lines = await label.evaluate((e) => {
    const r = document.createRange();
    r.selectNodeContents(e);
    return r.getClientRects().length;
  });
  expect(lines).toBe(1);
});

for (const width of [768, 1024, 1279, 1280, 1439]) {
  test(`${width} px Tarifeler: taşıyıcılar üstte, tablo satırları kart değil`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs`);
    const rows = page.locator('.tl-table tbody tr');
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('.tl-table thead')).toBeVisible();
    const carriers = (await page.locator('.tl-carriers').boundingBox())!;
    const main = (await page.locator('.tl-main').boundingBox())!;
    expect(carriers.y + carriers.height).toBeLessThanOrEqual(main.y);
    // kart hali 200 px'in üstünde: tablo satırı en çok üç satır metin
    expect(await rows.first().locator('td').first().evaluate((e) => getComputedStyle(e).display)).toBe('table-cell');
    const row = (await rows.first().boundingBox())!;
    expect(row.height).toBeLessThan(120);
    expect(await page.evaluate(() => [...document.querySelectorAll('.table-wrap')].map((e) => e.scrollWidth - e.clientWidth).filter((x) => x > 0))).toEqual([]);
  });
}

test('1440 px Tarifeler: taşıyıcılar solda', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/tariffs`);
  await expect(page.locator('.tl-table tbody tr').first()).toBeVisible();
  const carriers = (await page.locator('.tl-carriers').boundingBox())!;
  const main = (await page.locator('.tl-main').boundingBox())!;
  expect(carriers.x + carriers.width).toBeLessThanOrEqual(main.x);
});

test('390 px satır kartı: Fark ana, Beklenen ve Faturalanan panelde', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/invoices/i1`);
  const row = page.locator('.lines-dt tbody tr.clickable').first();
  await expect(row.locator('td[data-label="Fark"]')).toBeVisible();
  await expect(row.locator('td[data-label="Beklenen"]')).toBeHidden();
  await expect(row.locator('td[data-label="Faturalanan"]')).toBeHidden();
  await row.click();
  await expect(page.locator('.panel')).toContainText('Beklenen');
  await expect(page.locator('.panel')).toContainText('Faturalanan');
});

for (const width of [768, 1024]) {
  test(`${width} px satır tablosu: Karar sütunu yok, Fark altında küçük metin`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    const row = page.locator('.lines-dt tbody tr.clickable').first();
    await expect(page.getByRole('columnheader', { name: 'Karar' })).toBeHidden();
    await expect(row.locator('.ln-dec-sub')).toHaveText('Karar bekliyor');
  });
}

test('1440 px panel açıkken tutar ve kg kırılmaz', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/invoices/i1`);
  await page.locator('.lines-dt tbody tr.clickable').first().click();
  await expect(page.locator('.panel')).toBeVisible();
  const r = await page.locator('.lines-dt tbody tr.clickable').first().evaluate((tr) => {
    const lineCount = (e: Element) => {
      const range = document.createRange();
      range.selectNodeContents(e);
      return new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size;
    };
    const diff = tr.querySelector('td.ln-diff')!;
    const text = [...tr.querySelectorAll('.ln-dim .sub')].map((e) => e.textContent ?? '');
    return { diffLines: lineCount(diff), brokenKg: text.filter((t) => /\d kg/.test(t)) };
  });
  expect(r).toEqual({ diffLines: 1, brokenKg: [] });
});

test('Pano: dl içinde geçerli yapı, satırın tamamı tıklanır', async ({ page }) => {
  await mockSession(page, 'owner');
  await page.goto(`${APP}/`);
  await expect(page.locator('.dash-hero-v')).toBeVisible();
  await expect(page.locator('.dash-rows > a')).toHaveCount(0);
  await expect(page.locator('.dash-rows > div > dt')).toHaveCount(4);
  await expect(page.locator('.dash-rows > div > dd')).toHaveCount(4);
  const row = page.locator('.dash-row', { has: page.getByRole('link', { name: 'Faturalanan gönderi' }) });
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2); // sayının üstü
  await expect(page).toHaveURL(/\/deciship\/invoices$/);
});

test('Pano telefonda toplam satırının birimi var', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/`);
  const total = page.locator('.rr.tot .rr-count');
  await expect(total).toBeVisible();
  const unit = await total.evaluate((e) => getComputedStyle(e, '::after').content);
  expect(unit).toContain('satır');
});

test('terimler Merkez ile aynı: Firma, Ölçüm kapsamı, Elle', async ({ page }) => {
  await mockSession(page, 'owner');
  await page.goto(`${APP}/`);
  await expect(page.getByText('Ölçüm kapsamı')).toBeVisible();
  await expect(page.getByText('Ölçüm kapsaması')).toHaveCount(0);
  await expect(page.locator('.dash-methods')).toContainText('Elle');
  await expect(page.locator('.dash-methods')).not.toContainText('Manuel');
  await page.goto(`${APP}/settings`);
  await expect(page.getByRole('heading', { name: 'Firma', exact: true })).toBeVisible();
  await expect(page.getByText('Şirket')).toHaveCount(0);
});

test('EN tarih Merkez biçiminde: 27 Oct 2026', async ({ page }) => {
  await mockSession(page, 'owner', { sod_mock_locale: 'en' });
  await page.goto(`${APP}/invoices`);
  await expect(page.locator('.inv-list tbody tr').first()).toContainText('27 Oct 2026');
  await expect(page.locator('.inv-list tbody tr').first()).not.toContainText('Oct 27');
});

const MEASURE: Person = 'measure';
test('mobil rol metni Merkez ile aynı', async ({ page }) => {
  await mockSession(page, MEASURE);
  await page.goto(`${APP}/`);
  await expect(page.getByText('Android uygulamasını yöneticiniz paylaşacak. Telefonunuza kurun.')).toBeVisible();
  await expect(page.getByText('Koliyi okutun, ölçün, kaydedin.')).toBeVisible();
  await expect(page.getByText('Uygulama henüz mağazada yok')).toBeVisible();
});
