import { expect, test, type Locator, type Page } from './base';
import { APP, REAL_STACK, mockSession, type Person } from './helpers';

// Tablolar kapsayıcıya göre davranır: para sütunu hiçbir genişlikte kaydırma ardına gitmez.
test.skip(REAL_STACK, 'mock kişileri gerektirir');

const WIDTHS = [768, 900, 1024, 1279, 1280, 1440];
const LANGS = [
  { lang: 'tr', overpaid: 'Fazla ödeme', diff: 'Fark' },
  { lang: 'en', overpaid: 'Overcharge', diff: 'Discrepancy' },
] as const;

/** Öğe yatay olarak ekranın ve tablonun görünür alanında: kaydırmadan okunur. */
async function expectReadable(page: Page, el: Locator) {
  await expect(el).toBeVisible();
  const box = (await el.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  const clipped = await el.evaluate((node) => {
    const wrap = node.closest('.table-wrap, .tbl-wrap');
    if (!wrap) return 0;
    const r = node.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return Math.max(0, r.right - w.right, w.left - r.left);
  });
  expect(clipped).toBeLessThanOrEqual(0.5);
}

/** Satırlar ve kartlar üst üste binmez; içerik kendi satırının içinde kalır. */
async function rowsDoNotOverlap(table: Locator) {
  const bad = await table.evaluate((t) => {
    const rows = [...t.querySelectorAll('tbody tr')];
    const out: string[] = [];
    rows.forEach((tr, i) => {
      const r = tr.getBoundingClientRect();
      const next = rows[i + 1]?.getBoundingClientRect();
      if (next && next.top < r.bottom - 1) out.push(`satır ${i}: alttaki üstüne biniyor`);
      for (const td of tr.children) {
        const c = td.getBoundingClientRect();
        if (c.height && c.bottom > r.bottom + 1) out.push(`satır ${i}: hücre taşıyor`);
      }
    });
    return out;
  });
  expect(bad).toEqual([]);
}

async function noHiddenColumns(page: Page) {
  const over = await page.evaluate(() =>
    [...document.querySelectorAll('.table-wrap, .tbl-wrap')].map((e) => ({ t: e.querySelector('table')?.className, over: e.scrollWidth - e.clientWidth })).filter((x) => x.over > 0),
  );
  expect(over).toEqual([]);
}

for (const { lang, overpaid, diff } of LANGS) {
  for (const width of WIDTHS) {
    test(`${lang} ${width} px: para sütunları görünür, tablo kaymaz`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockSession(page, 'owner', { sod_mock_locale: lang });

      await page.goto(`${APP}/invoices`);
      const list = page.locator('.inv-list');
      await expect(list.locator('tbody tr').first()).toBeVisible();
      await expectReadable(page, list.getByRole('columnheader', { name: overpaid }));
      await expectReadable(page, list.locator(`tbody tr td[data-label="${overpaid}"]`).first());
      await noHiddenColumns(page);

      await page.goto(`${APP}/invoices/i1`);
      const lines = page.locator('.lines-dt');
      await expect(lines.locator('tbody tr').first()).toBeVisible();
      await expectReadable(page, lines.locator(`tbody tr td[data-label="${diff}"]`).first());
      await noHiddenColumns(page);
      await rowsDoNotOverlap(lines);

      await page.goto(`${APP}/measurements`);
      await expect(page.locator('table.dt tbody tr.clickable').first()).toBeVisible();
      await noHiddenColumns(page);

      await page.goto(`${APP}/tariffs`);
      await expect(page.locator('.tl-table tbody tr').first()).toBeVisible();
      await noHiddenColumns(page);

      await page.goto(`${APP}/settings`);
      await expect(page.locator('.set-presets tbody tr').first()).toBeVisible();
      await noHiddenColumns(page);

      await page.goto(`${APP}/`);
      await expect(page.locator('.dash-hero-v')).toBeVisible();
      await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
      await noHiddenColumns(page);
    });
  }
}

/*
 * Y105 · 600–767 px: kabuğun kart kuralı (ekran ≤ 767) açık, DeciShip tablosu kabı 600+ olduğu için tablo çizer (app.css
 * "Tablo kart kipi" geri alır). Geri alma kuralı sayfanın sütun gizlemesini ezerse başlık gizli kalır, hücre görünür: satırlar
 * başlıktan kayar, tablo kabından taşar. Her dt-cards tablosunda görünen başlık sayısı = ilk satırın görünen hücre sayısı.
 * 620'de kap 600'ün altında: kart kipi (başlık satırı gizli).
 */
const MID_PAGES: { url: string; person?: Person; hooks?: Record<string, string>; table: string }[] = [
  { url: '/', table: '.dt.dt-cards' },
  { url: '/measurements', table: '.m-table' },
  { url: '/invoices', table: '.inv-list' },
  { url: '/invoices/i1', table: '.lines-dt' },
  { url: '/invoices/i1', person: 'accounting', table: '.lines-dt' },
  { url: '/tariffs', table: '.tl-table' },
  { url: '/settings', table: '.set-presets' },
  { url: '/disputes', hooks: { sod_mock_disputes: '1' }, table: '.dsp-list' },
];

async function midTables(page: Page) {
  return page.evaluate(() => {
    const shown = (e: Element) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    return [...document.querySelectorAll('table.dt.dt-cards')].map((t) => {
      const wrap = t.closest('.table-wrap, .tbl-wrap') ?? t.parentElement!;
      const head = t.querySelector('thead');
      const first = t.querySelector('tbody tr');
      return {
        table: t.className,
        head: head ? getComputedStyle(head).display : 'yok',
        th: [...(head?.querySelector('tr')?.children ?? [])].filter(shown).length,
        td: [...(first?.children ?? [])].filter(shown).length,
        over: Math.max(0, wrap.scrollWidth - wrap.clientWidth, Math.round(t.getBoundingClientRect().right - wrap.getBoundingClientRect().right)),
      };
    });
  });
}

for (const width of [720, 767]) {
  test(`${width} px (600–767): dt-cards tablolarında başlık ve hücre sayısı aynı, tablo kabından taşmaz`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const p of MID_PAGES) {
      await mockSession(page, p.person ?? 'owner', p.hooks);
      await page.goto(`${APP}${p.url}`);
      await expect(page.locator(`${p.table} tbody tr`).first()).toBeVisible();
      const tables = await midTables(page);
      expect(tables.length, `${p.url}: dt-cards tablosu`).toBeGreaterThan(0);
      for (const t of tables) {
        const at = `${p.url} ${p.person ?? 'owner'} ${t.table}`;
        expect(t.head, `${at}: tablo kipi`).toBe('table-header-group');
        expect(t.td, `${at}: görünen başlık / ilk satır hücresi`).toBe(t.th);
        expect(t.over, `${at}: kaptan taşma (px)`).toBeLessThanOrEqual(0);
      }
    }
  });
}

test('620 px (kap < 600): dt-cards tabloları kart kipinde', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  for (const p of MID_PAGES) {
    await mockSession(page, p.person ?? 'owner', p.hooks);
    await page.goto(`${APP}${p.url}`);
    await expect(page.locator(`${p.table} tbody tr`).first()).toBeVisible();
    for (const t of await midTables(page)) {
      const at = `${p.url} ${p.person ?? 'owner'} ${t.table}`;
      expect(t.head, `${at}: kart kipi (başlık gizli)`).toBe('none');
      expect(t.over, `${at}: kaptan taşma (px)`).toBeLessThanOrEqual(0);
    }
  }
});

// Gerçek veride takip no ve ölçü demo verisinden uzun: sütunlar yine kaymamalı.
const LONG_TRACKING = '1Z9X4A710341007819';
const LONG_DIMS = '59,6×49,8×25';
async function fillLongValues(page: Page, table: Locator) {
  await table.evaluate(
    (t, { tracking, dims }) => {
      t.querySelectorAll('tbody td .id, tbody td.card-title .mono').forEach((e) => (e.textContent = tracking));
      t.querySelectorAll('tbody td.mono, tbody td .mono:not(.id)').forEach((e) => {
        if (/×/.test(e.textContent ?? '')) e.textContent = dims;
      });
    },
    { tracking: LONG_TRACKING, dims: LONG_DIMS },
  );
  await page.waitForTimeout(50);
}

for (const width of [768, 1024, 1279]) {
  test(`${width} px uzun takip no ve ölçü: Ölçümler'de son sütun, fatura detayında Fark görünür`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockSession(page, 'owner');

    await page.goto(`${APP}/measurements`);
    const m = page.locator('table.dt').first();
    await expect(m.locator('tbody tr.clickable').first()).toBeVisible();
    await fillLongValues(page, m);
    await expect(m.locator('tbody tr').first()).toContainText(LONG_TRACKING);
    await expectReadable(page, m.getByRole('columnheader', { name: 'Fatura', exact: true }));
    await noHiddenColumns(page);

    await page.goto(`${APP}/invoices/i1`);
    const lines = page.locator('.lines-dt');
    await expect(lines.locator('tbody tr').first()).toBeVisible();
    await fillLongValues(page, lines);
    await expect(lines.locator('tbody tr').first()).toContainText(LONG_TRACKING);
    await expectReadable(page, lines.locator('tbody tr td[data-label="Fark"]').first());
    await noHiddenColumns(page);
    await rowsDoNotOverlap(lines);
  });
}

test('telefonda (390 px) kart hali: tutar ve tarih kartta, sütun gizlenmez', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/invoices`);
  const row = page.locator('.inv-list tbody tr').first();
  await expectReadable(page, row.locator('td[data-label="Fazla ödeme"]'));
  await expect(row.locator('td[data-label="Fatura tarihi"]')).toBeVisible();
  await expect(row.locator('td[data-label="İtiraz listesinde"]')).toBeVisible();
  await expect(page.locator('.inv-list thead')).toBeHidden();
});

test('orta genişlikte fatura tarihi kaybolmaz: faturanın altına iner', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/invoices`);
  const row = page.locator('.inv-list tbody tr').first();
  await expect(row.locator('.inv-date-inline')).toHaveText('27 Eki 2026');
});

for (const width of [1024, 1279, 1280, 1440]) {
  test(`${width} px: satır seçilince seçili satır ve panel birlikte görünür, panel kapanınca liste döner`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    const rows = page.locator('.lines-dt tbody tr.clickable');
    await rows.first().click();
    const decide = page.getByRole('button', { name: 'İtiraz listesine ekle' });
    await expect(decide).toBeInViewport({ ratio: 1 });

    const selected = page.locator('.lines-dt tr.sel');
    await expect(selected).toBeVisible();
    const tracking = selected.locator('td').first();
    await expect(tracking).toBeInViewport();
    const cell = (await tracking.locator('.id').boundingBox())!;
    const panel = (await page.locator('.panel').boundingBox())!;
    expect(cell.x + cell.width).toBeLessThanOrEqual(panel.x); // takip no panelin altında kalmaz
    await noHiddenColumns(page);
    await rowsDoNotOverlap(page.locator('.lines-dt'));

    // seçim görünür: kartta da satırda da mavi zemin
    const bg = await selected.evaluate((tr) => {
      const cell = getComputedStyle(tr.querySelector('td')!).backgroundColor;
      return cell !== 'rgba(0, 0, 0, 0)' ? cell : getComputedStyle(tr).backgroundColor;
    });
    expect(bg).toBe('rgb(232, 238, 252)'); // --primary-soft #e8eefc (D09)

    await page.getByRole('button', { name: 'Paneli kapat' }).click();
    await expect(page.locator('.panel')).toHaveCount(0);
    await expect(page.locator('.lines-dt tr.sel')).toHaveCount(0);
    await noHiddenColumns(page);
  });
}

test('1280 px: ölçüm paneli açıkken liste okunur, satırlar üst üste binmez', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/measurements`);
  await page.locator('table.dt tbody tr.clickable').first().click();
  await expect(page.locator('.panel .cmp')).toBeVisible();
  await rowsDoNotOverlap(page.locator('table.dt').first());
  await noHiddenColumns(page);
});

test('orta genişlikte karar Fark altında küçük metin', async ({ page }) => {
  // D09'da yan menü yok: 1024'te tablo ~960 px; orta tablo genişliği (600–820) artık ~860 px ekranda
  await page.setViewportSize({ width: 860, height: 900 });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/invoices/i1`);
  await page.locator('.lines-dt tbody tr.clickable').first().click();
  await page.getByRole('button', { name: 'İtiraz listesine ekle' }).click();
  await expect(page.getByText('İtiraz listesine eklendi')).toBeVisible();
  await page.getByRole('button', { name: 'Paneli kapat' }).click();
  await expect(page.locator('.panel')).toHaveCount(0);
  await page.getByRole('tab', { name: /Tümü/ }).click();
  const row = page.locator('.lines-dt tbody tr').first();
  await expect(row.locator('.ln-dec-sub')).toHaveText('İtiraz listesinde'); // Karar sütunundaki etiketin aynısı
  await expect(row.locator('td.ln-c-dec')).toBeHidden();
});
