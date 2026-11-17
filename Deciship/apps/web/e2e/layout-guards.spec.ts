import { expect, test, type Page } from './base';
import { APP, REAL_STACK, mockSession } from './helpers';

// Gerçek sistem gezisinde (2026-11-12) bulunan görünüm kusurlarının kalıcı korumaları: yatay taşma yok, değer kırpılmıyor,
// pencere düğmeleri ekranda, elle yazılan adres değeri varsayılana düşüyor.
test.skip(REAL_STACK, 'mock kişileri ve kancaları gerektirir');

/** Sayfa yana kaymıyor: belge genişliği görüntü alanını aşmaz. */
async function expectNoHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'sayfa yatay taşıyor (px)').toBeLessThanOrEqual(0);
}

/**
 * i1'i "tamamı mükerrer" faturaya çevirir (karşılaştırılan satır yok, fazla ödemenin tamamı mükerrerden). Mock deposuna
 * senaryo eklemeden yalnız bu testin tarayıcısında fatura yanıtının toplamlarını değiştirir.
 */
function onlyDuplicatesInit() {
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\/api\/deciship\/invoices\/i1(\?|$)/.test(url) || !res.ok) return res;
    const body = await res.json();
    const t = (body.invoice ?? body).totals;
    Object.assign(t, { match: 0, diff: t.lines, unmatched: 0, noTariff: 0, comparedBilledTotal: 0, expectedTotal: 0, verifiedTotal: 0 });
    // Karar 2026-11-12: döküm varsa mükerrer Faturalanan'a girer ve kutular gösterilir; açıklama cümlesi yalnız dökümü
    // olmayan (eski kayıtlı) özette kalır. Bu koruma o cümlenin yerleşimini sınar.
    delete t.reconciliation;
    delete t.overchargeByType;
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  };
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width} px`, () => {
    test.use({ viewport });

    test('tamamı mükerrer faturada özet cümlesi "İtiraz listesinde"nin üstüne binmez, sayfa taşmaz', async ({ page }) => {
      await mockSession(page, 'owner');
      await page.addInitScript(onlyDuplicatesInit);
      await page.goto(`${APP}/invoices/i1`);
      const sum = page.getByRole('region', { name: 'Özet' });
      const sentence = sum.getByText('Bu faturada karşılaştırılan satır yok', { exact: false });
      await expect(sentence).toBeVisible();
      const list = sum.locator('.inv-sum-kvs > div', { hasText: 'İtiraz listesinde' });
      await expect(list).toBeVisible();
      const a = (await sentence.boundingBox())!;
      const b = (await list.boundingBox())!;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, 'cümle ile "İtiraz listesinde" üst üste').toBe(false);
      // cümle kartın içinde kalır
      const card = (await sum.boundingBox())!;
      expect(a.x + a.width).toBeLessThanOrEqual(card.x + card.width);
      await expectNoHorizontalOverflow(page);
    });

    test('Pano: "Ölçüm kapsamı" değeri görünür, kart satırları kırpılmaz', async ({ page }) => {
      await mockSession(page, 'owner');
      await page.goto(`${APP}/`);
      await page.waitForSelector('.dash-hero-v:not(:has(.skel))');
      const rows = page.locator('.dash-rows');
      const value = rows.locator('.dash-row.has-bar dd');
      await expect(value).toHaveText(/%\s?\d/);
      const v = (await value.boundingBox())!;
      const box = (await rows.boundingBox())!;
      expect(v.y + v.height, 'değer kartın altından taşıyor').toBeLessThanOrEqual(box.y + box.height);
      // hiçbir satır içeriğinden kısa değil (kart overflow: hidden ile kırpar)
      const clipped = await rows.evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>('.dash-row')].filter((r) => r.scrollHeight > r.clientHeight + 1).length,
      );
      expect(clipped, 'kırpılan satır sayısı').toBe(0);
      await expectNoHorizontalOverflow(page);
    });
  });
}

test.describe('itiraz metni penceresi', () => {
  // mock metni kısa: pencerenin görüntü alanından uzun olduğu durum alçak ekranla üretilir
  for (const viewport of [
    { width: 1440, height: 640 },
    { width: 1440, height: 900 },
    { width: 390, height: 640 },
  ]) {
    test(`${viewport.width}×${viewport.height}: düğmeler görüntü alanında, gövde kayar`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockSession(page, 'owner', { sod_mock_disputes: '1' });
      await page.goto(`${APP}/invoices/dsp-unsent`);
      await page.getByRole('button', { name: 'İtiraz metni' }).click();
      const dlg = page.getByRole('dialog');
      for (const name of ['Kopyala', 'Gönderildi olarak işaretle']) {
        const b = (await dlg.getByRole('button', { name }).boundingBox())!;
        expect(b.y, `${name} üstte kesik`).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height, `${name} ekranın altında`).toBeLessThanOrEqual(viewport.height);
      }
      // e-posta adresi yazılmadan <a> bağlantı değildir (href yok): metniyle bulunur
      const mail = (await dlg.locator('.dispute-mail', { hasText: 'E-posta ile aç' }).boundingBox())!;
      expect(mail.y + mail.height, '"E-posta ile aç" ekranın altında').toBeLessThanOrEqual(viewport.height);
      // gövdenin sonu (ek bağlantıları) kaydırınca ulaşılır; iç fark raporu kargoya önerilmez (KALANLAR 1.11)
      await expect(dlg.getByRole('button', { name: /Fark raporu/ })).toHaveCount(0);
      const attach = dlg.getByRole('button', { name: 'Fotoğraflar (ZIP)' });
      await attach.scrollIntoViewIfNeeded();
      await expect(attach).toBeInViewport();
    });
  }
});

test.describe('adresten gelen sekme ve süzgeçler', () => {
  test('küçük harfli "tab=all" Tümü sekmesini açar, bilinmeyen değer varsayılana düşer', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1?tab=all`);
    await expect(page.getByRole('tab', { name: /^Tümü/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();

    await page.goto(`${APP}/invoices/i1?tab=hepsi&page=-3&diffType=agirlik&decision=x`);
    await expect(page.getByRole('tab', { name: /^Fark var/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
    await expect(page.getByText('Veriler yüklenemedi')).toHaveCount(0);

    await page.goto(`${APP}/invoices/i1?tab=match`);
    await expect(page.getByRole('tab', { name: /^Uyumlu/ })).toHaveAttribute('aria-selected', 'true');
    expect(errors).toEqual([]);
  });

  test('listelerde geçersiz sayfa ve yöntem 1. sayfaya / tümüne düşer', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_disputes: '1' });
    await page.goto(`${APP}/invoices?page=-1`);
    await expect(page.locator('.inv-list tbody tr').first()).toBeVisible();
    await page.goto(`${APP}/disputes?page=abc`);
    await expect(page.locator('.dsp-list tbody tr').first()).toBeVisible();
    await page.goto(`${APP}/measurements?page=0&method=lazer`);
    await expect(page.locator('.m-table tbody tr').first()).toBeVisible();
    await expect(page.getByText('Veriler yüklenemedi')).toHaveCount(0);
  });
});

test.describe('dar ekran ayrıntıları', () => {
  test('720 px: fatura satırları arama kutusu 176 px\'e kısılmaz', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    await page.waitForSelector('.lines-dt tbody tr');
    const w = (await page.locator('#lq').boundingBox())!.width;
    expect(w).toBeGreaterThan(176);
    await expectNoHorizontalOverflow(page);
  });

  for (const width of [1440, 390]) {
    test(`${width} px: İtirazlar tablosu ile sayfalayıcı bitişik (Faturalar gibi)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockSession(page, 'owner', { sod_mock_disputes: '1' });
      await page.goto(`${APP}/disputes`);
      await page.waitForSelector('.dsp-list tbody tr');
      const table = (await page.locator('.dsp > .table-wrap').boundingBox())!;
      const foot = (await page.locator('.dsp > .tfoot').boundingBox())!;
      expect(Math.abs(foot.y - (table.y + table.height)), 'tablo ile sayfalayıcı arası (px)').toBeLessThanOrEqual(1);
    });
  }
});
