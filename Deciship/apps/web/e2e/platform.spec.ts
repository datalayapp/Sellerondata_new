import { expect, test, type Page } from './base';
import { ERROR_MESSAGES } from '@sellerondata/contracts';
import path from 'node:path';
import { APP, REAL_STACK, mockSession, samples } from './helpers';

// Kabuk, ortak oturum ve izne göre arayüz. Kişiler ve kancalar mock'a özgü; gerçek sistemde API testleri aynı kuralları sınar.
test.skip(REAL_STACK, 'mock kişileri ve kancaları gerektirir');

// D09 bandı: aracın menüsü bandın üst satırında yatay. Dil değişse de aynı öğe: erişilebilir adı çevrilir.
const toolNav = (page: Page) => page.locator('nav.sod-nav');
/** Dil seçimi avatar (hesap) menüsünde. */
const openLang = async (page: Page) => {
  await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
  await page.locator('.sod-pop-lang').click(); // dil tek satır; seçenekler tıklayınca açılır
};

test.describe('oturum', () => {
  test('oturum yoksa kalınan yeri taşıyarak Merkez girişine gider', async ({ page }) => {
    await mockSession(page, null);
    await page.goto(`${APP}/measurements?q=abc`);
    await expect(page).toHaveURL(/\/login\?next=%2Fdeciship%2Fmeasurements%3Fq%3Dabc$/);
  });

  test('jeton tarayıcı deposunda durmaz; istekler Bearer taşımaz, yazmada X-SOD-CSRF ve dil başlığı vardır', async ({ page }) => {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) seen.push({ url: r.url(), method: r.method(), headers: r.headers() });
    });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await expect(page.getByRole('heading', { name: 'Ayarlar', level: 1 })).toBeVisible();
    const edge = page.locator('#s-edge');
    await edge.fill((await edge.inputValue()) === '3' ? '4' : '3');
    await page.getByRole('button', { name: 'Ayarları kaydet' }).click();
    await expect(page.getByText('Ayarlar kaydedildi')).toBeVisible();

    expect(seen.some((r) => new URL(r.url).pathname === '/api/account/me')).toBeTruthy();
    expect(seen.some((r) => new URL(r.url).pathname === '/api/deciship/me')).toBeTruthy();
    expect(seen.every((r) => !r.headers.authorization)).toBeTruthy();
    expect(seen.every((r) => !!r.headers['accept-language'])).toBeTruthy();
    const patch = seen.find((r) => r.method === 'PATCH' && new URL(r.url).pathname === '/api/deciship/settings');
    expect(patch?.headers['x-sod-csrf']).toBe('1');
    expect(patch?.headers['x-sod-org']).toBe('o1');

    const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].join(' '));
    expect(keys).not.toMatch(/accessToken|refreshToken/);
  });

  for (const code of ['TOKEN_STALE', 'TOKEN_EXPIRED']) {
    test(`${code}: bir kez yenilenir, istek tekrarlanır, kullanıcı fark etmez`, async ({ page }) => {
      await mockSession(page, 'owner');
      await page.goto(`${APP}/settings`);
      await expect(page.getByRole('heading', { name: 'Ayarlar', level: 1 })).toBeVisible();
      await page.evaluate((c) => localStorage.setItem('sod_mock_expire', c), code);
      const refresh = page.waitForRequest('**/api/account/auth/refresh');
      await page.getByRole('link', { name: 'Faturalar' }).click();
      await refresh;
      await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
      await expect(page).toHaveURL(/\/deciship\/invoices$/);
    });
  }

  test('yenileme de başarısızsa girişe, kalınan yerle', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('sod_mock_expire', 'TOKEN_EXPIRED');
      localStorage.setItem('sod_mock_no_refresh', '1');
    });
    await page.getByRole('link', { name: 'Tarifeler' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fdeciship%2Ftariffs$/);
  });

  test('çıkış kabuktan: oturum kapanır, girişe gidilir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/`);
    await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('sod_mock_session'))).toBeNull();
  });
});

test.describe('kabuk', () => {
  test('hangi araçta olduğu belli: bant, logo kilidi, sekme; çift logo ve çift başlık yok', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();

    // logo kilidi: [işaret] DeciShip, altında SellerOnData; tek bağlantı, DeciShip ana sayfasına
    await expect(page.locator('.sod-shell')).toHaveAttribute('data-sod-product', 'deciship');
    await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
    await expect(page.locator('.sod-brand-sub')).toHaveText('SellerOnData');
    await expect(page.locator('.sod-brand a')).toHaveCount(1);
    await expect(page.locator('.sod-brand a')).toHaveAttribute('href', /^\/deciship\/?$/); // router kökü: Pano
    await page.locator('.sod-brand a').click();
    await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
    const n = (await page.locator('.sod-brand-n').boundingBox())!;
    const sub = (await page.locator('.sod-brand-sub').boundingBox())!;
    expect(sub.y).toBeGreaterThanOrEqual(n.y + n.height - 1); // alt satır adın altında
    expect(Math.abs(sub.x - n.x)).toBeLessThan(1);
    // uygulama geçişi ⊞ menüsünde: açık olmayan ürün tıklanamaz
    await page.getByRole('button', { name: 'Uygulamalar' }).click();
    await expect(page.getByRole('menuitem', { name: 'Merkez' })).toHaveAttribute('href', '/home');
    await expect(page.getByRole('menuitem', { name: /OrderLoom/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('a', { hasText: 'OrderLoom' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page).toHaveTitle('Faturalar · DeciShip');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.locator('.sod-band .ptitle')).toHaveText('Faturalar'); // sayfa adı bandın başlık bölgesinde, tek h1
    await expect(page.locator('.brand-logo')).toHaveCount(0); // eski kenar çubuğu logosu kalmadı

    const nav = toolNav(page);
    await expect(nav.getByRole('link')).toHaveText(['Pano', 'Faturalar', 'Ölçümler', 'İtirazlar', 'Tarifeler', 'Ayarlar']);
    await expect(nav.getByRole('link', { name: 'Faturalar' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Faturalar' })).toHaveAttribute('href', '/deciship/invoices');
  });

  test('menü içi gezinti tam sayfa olmaz; ayrıntı başlığı sekmede kalır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await expect(page).toHaveTitle('FedEx International Economy 2026 · DeciShip');
    await page.evaluate(() => ((window as unknown as { __spa: boolean }).__spa = true));
    await toolNav(page).getByRole('link', { name: 'Faturalar' }).click();
    await expect(page).toHaveURL(/\/deciship\/invoices$/);
    await expect(page).toHaveTitle('Faturalar · DeciShip');
    expect(await page.evaluate(() => (window as unknown as { __spa?: boolean }).__spa)).toBe(true);
  });

  test('dil kabuktan değişir: menü, başlık, çerez ve sonraki istekler', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await openLang(page);
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(toolNav(page).getByRole('link', { name: 'Invoices' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect((await page.context().cookies()).find((c) => c.name === 'sod_lang')?.value).toBe('en');
    const req = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/deciship/dashboard');
    await toolNav(page).getByRole('link', { name: 'Dashboard' }).click();
    expect((await req).headers()['accept-language']).toBe('en');
  });

  test('dil değişince sayı biçimi de değişir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('cell', { name: '27 Eki 2026', exact: true })).toBeVisible(); // tarih tek biçimde
    await expect(page.getByRole('cell', { name: /15.189,24/ })).toBeVisible();
    await openLang(page);
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.getByRole('cell', { name: /15,189.24/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: '27 Oct 2026', exact: true })).toBeVisible();
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.inv-sum-v')).toHaveText('₺765.90'); // simge önde: tutar iki kez yazılmaz
    await page.goto(`${APP}/`);
    await expect(page.locator('.dash-hero-v')).toHaveText('₺765.90');
  });

  test('kaydedilmemiş sayı varken dil değişimi sorar: vazgeçilirse dil ve yazılan değer aynı kalır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await page.locator('#s-wt').fill('1,234');
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await openLang(page);
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect.poll(() => asked).toContain('Kaydedilmemiş değişiklikleriniz var');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page.locator('#s-wt')).toHaveValue('1,234');
    await expect(toolNav(page).getByRole('link', { name: 'Ayarlar' })).toBeVisible();
  });

  test('onaylanırsa sayfa yeni dille yüklenir: yazılan 1,234 yeniden yorumlanıp kaydedilmez', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await expect(page.locator('#s-wt')).toHaveValue('0,1');
    await page.locator('#s-wt').fill('1,234');
    page.once('dialog', (d) => void d.accept());
    const patches: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/deciship/settings') patches.push(r.url());
    });
    await openLang(page);
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(toolNav(page).getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('#s-wt')).toHaveValue('0.1');
    await expect(page.locator('.savebar')).toHaveCount(0);
    expect(patches).toEqual([]);
  });

  test('değişiklik yokken sayı alanı olan sayfada sormadan yeni dille yüklenir, form kirli görünmez', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await expect(page.locator('#s-wt')).toHaveValue('0,1');
    page.once('dialog', () => {
      throw new Error('değişiklik yokken sormamalı');
    });
    await openLang(page);
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.locator('#s-wt')).toHaveValue('0.1');
    await expect(page.locator('.savebar')).toHaveCount(0);
  });

  test('kaydedilen değişiklik artık sorulmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await page.locator('#s-wt').fill('0,25');
    await page.getByRole('button', { name: 'Ayarları kaydet' }).click();
    await expect(page.getByText('Ayarlar kaydedildi')).toBeVisible();
    // Mesaj 4 (SPEC §5.3): tolerans kaydı eski faturaları yeni ayara geçirmeyi sorar. Bu test o soruyu değil kayıttan sonra
    // çıkışın sorulmadığını sınar: soru "Vazgeç" ile kapatılır (faturalar eski ayarla kalır).
    const rules = page.getByRole('dialog', { name: /eski ayarla hesaplı/ });
    await expect(rules).toBeVisible();
    await rules.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(rules).toHaveCount(0);
    page.once('dialog', () => {
      throw new Error('kayıttan sonra sormamalı');
    });
    await openLang(page);
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.locator('#s-wt')).toHaveValue('0.25');
  });

  test('firma değişince aynı araçta kalır, önceki firmanın verisi kalmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');
    await page.getByRole('button', { name: /^Firma:/ }).click();
    await page.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');
    await expect(page).toHaveURL(/\/deciship\/$/);
    await toolNav(page).getByRole('link', { name: 'Faturalar' }).click();
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-22001' })).toBeVisible();
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toHaveCount(0);
  });

  test('firma başka sekmede değişirse: kayıt reddedilir, kabuk uyarır, bu sekme kendi firmasıyla devam edebilir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await expect(page.locator('#s-name')).toHaveValue('Örnek Firma');
    await page.locator('#s-wt').fill('0,5');
    // aynı çerez başka sekmede başka firmaya geçti
    await page.evaluate(() => localStorage.setItem('sod_mock_session', JSON.stringify({ personId: 'p1', orgId: 'o2' })));
    await page.getByRole('button', { name: 'Ayarları kaydet' }).click();

    const banner = page.locator('.sod-status');
    await expect(banner).toBeVisible();
    // tek mesaj: bant söylüyor, bildirim düşmez
    await page.waitForTimeout(300);
    await expect(page.getByText(ERROR_MESSAGES.ORG_MISMATCH.tr)).toHaveCount(0);
    await expect(page.locator('.toast')).toHaveCount(0);
    // yazı kaybolmadı, ekrandaki firma aynı, istek gitmedi
    await expect(page.locator('#s-wt')).toHaveValue('0,5');
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');

    await banner.getByRole('button', { name: /Örnek Firma/ }).click();
    await expect(banner).toBeHidden();
    await page.getByRole('button', { name: 'Ayarları kaydet' }).click();
    await expect(page.getByText('Ayarlar kaydedildi')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sod_mock_session')!).orgId)).toBe('o1');
  });

  test('dosya indirme ve FormData yükleme de firma başlığını taşır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.getByRole('button', { name: 'Diğer' })).toBeEnabled();
    const dl = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith('/report.xlsx'));
    await page.getByRole('button', { name: 'Diğer' }).click();
    await page.getByRole('menuitem', { name: 'Excel indir' }).click();
    expect((await dl).headers()['x-sod-org']).toBe('o1');

    await page.goto(`${APP}/invoices/upload`);
    await page.getByRole('radio', { name: /FedEx/ }).click();
    const up = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/deciship/invoices/preview');
    await page.setInputFiles('[data-testid=invoice-file]', path.join(samples, 'invoices/fedex-9-482-11735.csv'));
    const headers = (await up).headers();
    expect(headers['x-sod-org']).toBe('o1');
    expect(headers['x-sod-csrf']).toBe('1');
    expect(headers.authorization).toBeUndefined();
  });
});

test.describe('tasarım değerlendirmesi', () => {
  test('fatura ayrıntısı: tablo ilk ekranda; satır açılınca liste ve karar aynı anda görünür', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    const rows = page.locator('.lines-dt tbody tr.clickable');
    await expect(rows.first()).toBeVisible();
    expect((await rows.first().boundingBox())!.y).toBeLessThan(900 - 52);
    await expect(page.locator('.th-fold')).toContainText('satır uyumlu');

    await rows.first().click();
    const decide = page.getByRole('button', { name: 'İtiraz listesine ekle' });
    await expect(decide).toBeVisible();
    await expect(page.locator('.inv-sum-line')).toBeVisible();
    const selected = page.locator('.lines-dt tr.sel');
    await expect(selected).toBeInViewport({ ratio: 1 });
    const row = (await selected.boundingBox())!;
    const panel = (await page.locator('.panel').boundingBox())!;
    expect(row.x + row.width).toBeLessThanOrEqual(panel.x); // panel satırı örtmez
    expect(row.y + row.height).toBeLessThanOrEqual(900);
    await expect(decide).toBeInViewport({ ratio: 1 });

    // alttaki satıra geçince de görünür kalır
    await rows.last().click();
    await expect(page.locator('.lines-dt tr.sel')).toBeInViewport({ ratio: 1 });

    // Tarife uyumu istenince açılır, katlanır
    await page.locator('.th-fold-btn').click();
    await expect(page.getByRole('heading', { name: 'Tarife uyumu' })).toBeVisible();
    await page.getByRole('button', { name: 'Tarife uyumunu katla' }).click();
    await expect(page.locator('.th-fold')).toBeVisible();
  });

  test('itiraz süresi: dolunca başlıkta söylenir, birincil eylem duruma göre', async ({ page }) => {
    await mockSession(page, 'owner');
    // fatura 27.10: TTK 8 gün dolmuş, FedEx düzeltme süresi açık → hâlâ yapılabilir
    await page.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
    await page.goto(`${APP}/invoices/i1`);
    const head = page.locator('.phead');
    await expect(head.getByText('TTK itiraz süresi doldu')).toBeVisible();
    await expect(page.getByRole('button', { name: 'İtiraz metni' })).toHaveClass(/btn-primary/);

    // düzeltme süresi de geçti: itiraz artık ana iş değil
    await page.clock.setFixedTime(new Date('2027-02-01T10:00:00'));
    await page.reload();
    await expect(head.getByText('TTK itiraz süresi doldu')).toBeVisible();
    await expect(page.getByRole('button', { name: 'İtiraz metni' })).toHaveClass(/btn-secondary/);

    // süre içinde uyarı yok
    await page.clock.setFixedTime(new Date('2026-10-28T10:00:00'));
    await page.reload();
    await expect(page.getByRole('button', { name: 'İtiraz metni' })).toHaveClass(/btn-primary/);
    await expect(head.getByText('TTK itiraz süresi doldu')).toHaveCount(0);
  });

  test('ülke Türkiye değilse TTK süresi, son günü ve açıklaması hiçbir yerde çıkmaz; taşıyıcı süresi kalır', async ({ page }) => {
    await mockSession(page, 'owner', { 'sod_mock_ds_settings:o1': JSON.stringify({ country: 'US', currency: 'USD' }) });
    // fatura 27.10: TTK doldu, FedEx düzeltme süresi açık
    await page.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
    await page.goto(`${APP}/invoices/i1`);
    const head = page.locator('.phead');
    await expect(head).toBeVisible();
    await expect(head.getByText('TTK itiraz süresi doldu')).toHaveCount(0);
    const due = page.locator('.inv-sum-due');
    await expect(due).toContainText('düzeltme talebi için son gün');
    await expect(due).not.toContainText('TTK');
    await expect(due).not.toHaveClass(/over/);
    await page.locator('.inv-sum-i').click();
    await expect(page.locator('.inv-sum-tip')).toContainText('taşıyıcının kendi süresidir');
    await expect(page.locator('.inv-sum-tip')).not.toContainText('TTK');
    await expect(page.locator('body')).not.toContainText('TTK');
    await expect(page.getByRole('button', { name: 'İtiraz metni' })).toHaveClass(/btn-primary/);

    // TTK süresi içinde olunan gün de aynı: yalnız taşıyıcı
    await page.clock.setFixedTime(new Date('2026-10-28T10:00:00'));
    await page.reload();
    await expect(page.locator('.inv-sum-due')).toContainText('düzeltme talebi için son gün');
    await expect(page.locator('body')).not.toContainText('TTK');

    // Düzeltme süresi de geçti: süre satırı yok, itiraz ana iş değil, etiket yine yok
    await page.clock.setFixedTime(new Date('2027-02-01T10:00:00'));
    await page.reload();
    await expect(page.getByRole('button', { name: 'İtiraz metni' })).toHaveClass(/btn-secondary/);
    await expect(page.locator('.inv-sum-due')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('TTK');
  });

  test('EN: ABD firmasında Türk Ticaret Kanunu hiçbir metinde geçmez', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_locale: 'en', 'sod_mock_ds_settings:o1': JSON.stringify({ country: 'US', currency: 'USD' }) });
    await page.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.inv-sum-due')).toContainText('correction request deadline');
    await page.locator('.inv-sum-i').click();
    await expect(page.locator('.inv-sum-tip')).toContainText("the carrier's own deadline");
    await expect(page.locator('body')).not.toContainText('Turkish Commercial Code');
  });

  test('ülke bilinmiyorsa (null) TTK çıkmaz; Türkiye firmasında dolar kullansa da çıkar', async ({ page }) => {
    await mockSession(page, 'owner', { 'sod_mock_ds_settings:o1': JSON.stringify({ country: null }) });
    await page.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.inv-sum-due')).toContainText('düzeltme talebi için son gün');
    await expect(page.locator('body')).not.toContainText('TTK');

    await page.evaluate(() => localStorage.setItem('sod_mock_ds_settings:o1', JSON.stringify({ country: 'TR', currency: 'USD' })));
    await page.reload();
    await expect(page.locator('.phead').getByText('TTK itiraz süresi doldu')).toBeVisible();
    await expect(page.locator('.inv-sum-due')).toContainText('TTK itiraz süresi doldu');
  });

  test('Pano: tek baş rakam, kırmızı yalnız ana tutarda, ikon kutusu yok, diğer para birimi ayrı', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_multi_currency: '1' });
    await page.goto(`${APP}/`);
    await expect(page.locator('.dash-hero-v')).toContainText('765,90');
    await expect(page.locator('.dash-hero-v')).toHaveClass(/red/);
    await expect(page.locator('.kpi, .kpi-ic')).toHaveCount(0);
    await expect(page.locator('.dash-row')).toHaveCount(4);
    await expect(page.locator('.dash .red')).toHaveCount(1);
    await expect(page.locator('.dash-cur li')).toContainText('USD');
    await expect(page.locator('.dash-cur li')).toContainText('120,50');
  });

  test('Pano: telefonda satır birimi çeviriden, dönem seçici kırpılmaz', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, 'owner', { sod_mock_locale: 'en' });
    await page.goto(`${APP}/`);
    const unit = await page.locator('.rr-count[data-unit]').first().getAttribute('data-unit');
    expect(unit).toMatch(/^lines?$/);
    const sel = page.locator('#month');
    const box = (await sel.boundingBox())!;
    const needed = await sel.evaluate((el) => {
      const o = (el as HTMLSelectElement).selectedOptions[0];
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = getComputedStyle(el).font;
      return c.measureText(o.text).width;
    });
    expect(box.width - 36 - 32).toBeGreaterThan(needed); // simge ve ok dışında yazı sığar
  });

  test('telefonda dokunma hedefleri en az 44 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, 'owner');
    await page.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
    await page.goto(`${APP}/invoices/i1`);
    const info = (await page.locator('.inv-sum-i').boundingBox())!;
    expect(Math.min(info.width, info.height)).toBeGreaterThanOrEqual(44);
    const link = (await page.locator('.notif .link-btn').first().boundingBox())!;
    expect(link.height).toBeGreaterThanOrEqual(44);
  });

  test('Ölçümler: yöntem düz metin, renk yalnız durumda', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/measurements`);
    const cell = page.locator('table.dt tbody tr.clickable').first().locator('td[data-label="Yöntem"]');
    await expect(cell).toBeVisible();
    await expect(cell.locator('.tag')).toHaveCount(0);
  });

  test('Kurulum: firma adımı yok, gereksiz cümle yok, Zorunlu sade metin', async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/setup`);
    await expect(page.locator('#ob-cur')).toHaveCount(0);
    await expect(page.getByText('seçmeden devam edilemez')).toHaveCount(0);
    const tag = page.locator('.ob-req.is-req').first();
    await expect(tag).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    // sonraki adımda tek cümle, yan şerit yok
    await page.getByRole('navigation', { name: 'Kurulum adımları' }).getByRole('button', { name: /Hazır koliler/ }).click();
    await expect(page.locator('.ob-need')).toHaveCSS('border-left-width', '0px');
  });

  test('sekme başlıkları sayfayı söyler', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/upload`);
    await expect(page).toHaveTitle('Fatura yükle · DeciShip');
    await page.goto(`${APP}/tariffs/new`);
    await expect(page).toHaveTitle('Yeni tarife · DeciShip');
    await mockSession(page, 'measure');
    await page.goto(`${APP}/`);
    await expect(page).toHaveTitle('Bu rol mobil uygulamada çalışır · DeciShip');
  });

  test('tarife düzenleyici: değişiklik yokken kaydetme çubuğu yok, değişince çıkar', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await expect(page.locator('#t-name')).toBeVisible();
    await expect(page.locator('.savebar')).toHaveCount(0);
    await page.locator('#t-name').fill('Yeni ad');
    await expect(page.getByRole('button', { name: 'Kaydet', exact: true })).toBeEnabled();
  });

  test('Ayarlar: nadir eylem "⋯" menüsünde, sağ kenar içerik sütunuyla aynı; metin içi bağlantı altı çizili', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    const more = page.getByRole('button', { name: 'Diğer işlemler' });
    const btn = (await more.boundingBox())!;
    const card = (await page.locator('.set-stack > .card').first().boundingBox())!;
    expect(Math.abs(btn.x + btn.width - (card.x + card.width))).toBeLessThanOrEqual(1);
    await expect(page.getByRole('link', { name: /Merkez'de değiştir/ })).toHaveCSS('text-decoration-line', 'underline');
    await more.click();
    await page.getByRole('menuitem', { name: 'Kurulum sihirbazını aç' }).click();
    await expect(page).toHaveURL(/\/deciship\/setup$/);
  });

  test('mobil rol sayfası mağaza varmış gibi söylemez', async ({ page }) => {
    await mockSession(page, 'measure');
    await page.goto(`${APP}/`);
    await expect(page.getByText('henüz mağazada yok')).toBeVisible();
  });
});

test.describe('Hesap kesik', () => {
  test('son bilinen kişiyle açık kalır, DeciShip verisi ve kayıt çalışır, uyarı geri gelince kalkar', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();

    await page.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
    await page.reload();
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');
    await expect(page.locator('.sod-av')).toHaveText('SA');
    const banner = page.locator('.sod-status');
    await expect(banner).toContainText('Bağlantı');
    await expect(page).toHaveURL(/\/deciship\/invoices$/); // girişe atılmadı

    // firma başlığı önbellekten: yazma yanlış firmaya gidemez, kayıt çalışır
    const save = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/deciship/settings');
    await toolNav(page).getByRole('link', { name: 'Ayarlar' }).click();
    await page.locator('#s-wt').fill('0,5');
    await page.getByRole('button', { name: 'Ayarları kaydet' }).click();
    expect((await save).headers()['x-sod-org']).toBe('o1');
    await expect(page.getByText('Ayarlar kaydedildi')).toBeVisible();
    // Kayıttan sonra "eski faturalar geçirilsin mi" sorusu arka plan işiyle hazırlanıp açılır (Mesaj 7); vazgeçilip devam edilir.
    const ask = page.getByRole('dialog', { name: /Yeni ayara geçirilsin mi/ });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(page.locator('.overlay')).toHaveCount(0);

    await page.evaluate(() => localStorage.removeItem('sod_mock_account_down'));
    await banner.getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(banner).toBeHidden();
  });

  test('erişim jetonu bitmişken yenileme ulaşamazsa girişe atılmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('sod_mock_account_down', '1');
      localStorage.setItem('sod_mock_expire', 'TOKEN_EXPIRED');
    });
    await toolNav(page).getByRole('link', { name: 'Tarifeler' }).click();
    await expect(page.locator('.sod-status')).toContainText('Bağlantı');
    await expect(page).toHaveURL(/\/deciship\/tariffs$/);
    expect(await page.evaluate(() => localStorage.getItem('sod_mock_session'))).not.toBeNull();
  });

  test('kişi önbellekte yoksa sunucu sayfası çıkar; uyarı iki kez yazılmaz, geri gelince açılır', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_account_down: '1' });
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('heading', { name: 'Sunucuya bağlanılamadı' })).toBeVisible();
    await expect(page.locator('.sod-status')).toBeHidden();
    await expect(page).toHaveURL(/\/deciship\/invoices$/);
    await page.evaluate(() => localStorage.removeItem('sod_mock_account_down'));
    await page.getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();
  });
});

test.describe('izne göre arayüz', () => {
  // İzinler katalogdan (`Platform/packages/contracts/src/products.ts` ACCOUNTING): fatura yükler, düzeltir ve siler (Y123);
  // fark kararı, tarife düzenleme, ölçüm yönetimi ve ayar yok.
  test('Muhasebe: fatura yükler, düzeltir ve siler; menüde Ayarlar yok, fark kararı, yeniden karşılaştırma ve ölçüm yönetimi yok', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/`);
    await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
    await expect(toolNav(page).getByRole('link')).toHaveText(['Pano', 'Faturalar', 'Ölçümler', 'İtirazlar', 'Tarifeler']);
    await expect(page.getByRole('link', { name: 'Fatura yükle' }).first()).toBeVisible(); // yükleme izni var (Y123)

    await page.goto(`${APP}/invoices`);
    await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Fatura yükle' })).toBeVisible();
    // satır menüsünde silme: yükleme izni silmeyi de getirir (Y123)
    await page.getByRole('row', { name: /9-482-11735/ }).getByRole('button', { name: /için diğer işlemler/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Sil' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('columnheader', { name: 'Faturalanan' })).toBeVisible(); // fiyat izni var

    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: 'Diğer' }).click();
    await expect(page.getByRole('menuitem', { name: 'Excel indir' })).toBeVisible(); // dışa aktarma izni var
    await expect(page.getByRole('menuitem', { name: 'Düzenle', exact: true })).toBeVisible(); // başlık düzeltme yükleme izninde (Y123)
    await expect(page.getByRole('menuitem', { name: 'Yeniden karşılaştır' })).toHaveCount(0); // fark kararı izni yok
    await page.keyboard.press('Escape');
    await page.locator('.lines-dt tbody tr.clickable').first().click();
    await expect(page.locator('.panel .pn-sub')).toBeVisible();
    await expect(page.getByRole('button', { name: 'İtiraz listesine ekle' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Uyumlu say' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Başka ölçümle eşleştir' })).toHaveCount(0);
    // tarife görme izni var: satırın tarifesi bağlantıdır (izin yokken ölü bağlantı olmaması tariffs-view.spec.ts'de)
    await expect(page.locator('.panel').getByRole('link', { name: 'FedEx International Economy 2026' })).toBeVisible();

    await page.goto(`${APP}/measurements`);
    await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Elle ölçüm ekle' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Silinenler' })).toHaveCount(0);

  });

  test('Muhasebe: yükleme sayfası açılır', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/invoices/upload`);
    await expect(page).toHaveTitle('Fatura yükle · DeciShip');
    await expect(page.getByRole('radio', { name: /FedEx/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bu sayfa rolünüze açık değil' })).toHaveCount(0);
  });

  test('Muhasebe: fatura bilgisini düzeltir; kararı verilmiş satırı etkileyen düzeltmede "Uygula" yok, nedeni yazar, kayıt gitmez', async ({ page }) => {
    // `sod_mock_recalc`: i1'in satır 1'i itiraz listesinde (karar verilmiş) ve yeniden hesap bekliyor; sabit dayanakla hesap onu değiştirir
    await mockSession(page, 'accounting', { sod_mock_recalc: '1' });
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
    const openEdit = async () => {
      await page.getByRole('button', { name: 'Diğer' }).click();
      await page.getByRole('menuitem', { name: 'Düzenle', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Fatura bilgilerini düzenle' });
      await expect(dlg).toBeVisible();
      return dlg;
    };

    // hesabı değiştirmeyen alan (fatura no): doğrudan kaydedilir
    let edit = await openEdit();
    await edit.locator('#e-ino').fill('9-482-11735-M');
    await edit.getByRole('button', { name: 'Kaydet' }).click();
    await expect(edit).toBeHidden();
    await expect(page.locator('.ptitle .mono')).toHaveText('9-482-11735-M');

    // hesabı değiştiren alan (tarih): önizleme kararı verilmiş satırı değiştiriyor; Muhasebe kaydedemez
    const patches: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/deciship/invoices/i1') patches.push(r.url());
    });
    edit = await openEdit();
    const date = edit.locator('#e-idate');
    await date.fill((await date.inputValue()) === '2026-10-01' ? '2026-10-02' : '2026-10-01');
    await edit.getByRole('button', { name: 'Kaydet' }).click();
    const check = page.getByRole('dialog', { name: 'Kaydetmeden önce kontrol edin' });
    await expect(check).toBeVisible();
    await expect(check).toContainText('Bu değişiklik kararı verilmiş satırların tutarını değiştirir; fark kararı verebilen biri yapmalı.');
    await expect(check.getByRole('button', { name: 'Uygula' })).toHaveCount(0);
    await check.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(check).toHaveCount(0);
    expect(patches).toEqual([]);
  });

  test('adresi yazsa da izni olmayan sayfa nedenini söyler', async ({ page }) => {
    await mockSession(page, 'accounting');
    for (const path of ['settings', 'setup']) {
      await page.goto(`${APP}/${path}`);
      await expect(page.getByRole('heading', { name: 'Bu sayfa rolünüze açık değil' })).toBeVisible();
      await expect(page.getByRole('link', { name: "Merkez'e dön" })).toHaveAttribute('href', '/home');
    }
  });

  test('Denetleyici: fatura yükler, tarife yazar, taşıyıcı ve ayarlara dokunamaz', async ({ page }) => {
    await mockSession(page, 'auditor');
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('link', { name: 'Fatura yükle' })).toBeVisible();
    await expect(toolNav(page).getByRole('link', { name: 'Ayarlar' })).toHaveCount(0);
    await page.goto(`${APP}/tariffs`);
    await expect(page.getByRole('link', { name: 'Yeni tarife' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Taşıyıcıyı düzenle' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ekle', exact: true })).toHaveCount(0);
    await page.goto(`${APP}/settings`);
    await expect(page.getByRole('heading', { name: 'Bu sayfa rolünüze açık değil' })).toBeVisible();
  });

  test('fiyat izni yoksa tutar sütunu da yok', async ({ page }) => {
    // izin listesi sunucudan gelir: bu kişide yalnız fiyat izni kaldırılır
    await mockSession(page, 'accounting', { sod_mock_strip_perm: 'deciship.prices.view' });
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Fatura', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Faturalanan' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Fazla ödeme' })).toHaveCount(0);
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Beklenen' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Fark' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Özet' })).toHaveCount(0);
  });

  test('web izni olmayan rol: "Bu rol mobil uygulamada çalışır" + Merkez\'e dönüş, menü yok', async ({ page }) => {
    await mockSession(page, 'measure');
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();
    await expect(page.getByText('Ölçüm', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: "Merkez'e dön" })).toHaveAttribute('href', '/home');
    await expect(toolNav(page)).toHaveCount(0);
    await expect(page).toHaveTitle('Bu rol mobil uygulamada çalışır · DeciShip');
    await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
  });

  test('araç rolü yok: erişim yok sayfası', async ({ page }) => {
    await mockSession(page, 'noRole');
    await page.goto(`${APP}/`);
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await expect(page.getByRole('link', { name: "Merkez'e dön" })).toBeVisible();
  });

  test('etkin firma yok: firma seçince araç açılır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.evaluate(() => localStorage.setItem('sod_mock_session', JSON.stringify({ personId: 'p1', orgId: null })));
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('heading', { name: 'Devam etmek için bir firma seçin' })).toBeVisible();
    await page.getByRole('button', { name: 'Örnek Firma' }).click();
    await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  });

  test('hiç firması olmayan kişi ne yapacağını okur', async ({ page }) => {
    await mockSession(page, 'noOrg');
    await page.goto(`${APP}/`);
    await expect(page.getByRole('heading', { name: 'Henüz bir firmaya üye değilsiniz' })).toBeVisible();
  });

  test('abonelik salt okunur: bant görünür, yazma düğmeleri kapanır', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_readonly: '1' });
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('status').filter({ hasText: 'salt okunur' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Fatura yükle' })).toHaveCount(0);
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();
    // kayıtlar okunur kalır, değişmez
    await page.goto(`${APP}/tariffs/t1`);
    await expect(page.locator('#t-name')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Kaydet' })).toHaveCount(0);
    await page.goto(`${APP}/settings`);
    await expect(page.locator('#s-edge')).toBeDisabled();
    await page.goto(`${APP}/invoices/upload`);
    await expect(page.getByRole('heading', { name: 'Bu sayfa rolünüze açık değil' })).toBeVisible();
  });

  test('abonelik oturum içinde salt okunura düşerse READ_ONLY anlaşılır gösterilir ve bant açılır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();
    await page.evaluate(() => localStorage.setItem('sod_mock_readonly', '1'));
    await page.getByRole('row', { name: /9-482-11735/ }).getByRole('button', { name: /için diğer işlemler/ }).click();
    await page.getByRole('menuitem', { name: 'Sil' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sil', exact: true }).click();
    await expect(page.getByText(ERROR_MESSAGES.READ_ONLY.tr)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Kayıtlara bakabilir' })).toBeVisible();
  });

  test('izin oturum içinde kalkarsa (NO_PRODUCT_ACCESS) erişim sayfasına geçer', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('.inv-list td.card-title', { hasText: '9-482-11735' })).toBeVisible();
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.memberships.find((m: { id: string }) => m.id === 'm1').productRoles.deciship = null;
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
    });
    await page.getByRole('row', { name: /9-482-11735/ }).getByRole('button', { name: /için diğer işlemler/ }).click();
    await page.getByRole('menuitem', { name: 'Sil' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sil', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
  });
});

test.describe('yetki Merkez\'de', () => {
  test('Kullanıcılar sayfası ve menüsü yok', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/`);
    await expect(toolNav(page).getByRole('link', { name: 'Kullanıcılar' })).toHaveCount(0);
    await page.goto(`${APP}/users`);
    await expect(page.getByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeVisible();
  });

  test('Ayarlar: firma adı Merkez\'den salt okunur + bağlantı; Veriler kartı kapalıyken yok', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    const name = page.locator('#s-name');
    await expect(name).toHaveValue('Örnek Firma');
    await expect(name).toHaveAttribute('readonly', '');
    await expect(page.getByRole('link', { name: /Merkez'de değiştir/ })).toHaveAttribute('href', '/account/company');
    await expect(page.getByRole('heading', { name: /Veriler/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sistemi sıfırla' })).toHaveCount(0);
  });

  test('Ayarlar: ENABLE_DATA_RESET açıkken Veriler kartı görünür', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_data_reset: '1' });
    await page.goto(`${APP}/settings`);
    await expect(page.getByRole('button', { name: 'Sistemi sıfırla' })).toBeVisible();
  });

  test('firma üyesi yönetici değilse firma adı bağlantısı yerine yönlendirme okur', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`); // örnek veri ilk açılışta oluşur
    await expect(page.locator('#s-name')).toHaveValue('Örnek Firma');
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.memberships.find((m: { id: string }) => m.id === 'm1').orgRole = 'MEMBER';
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      sessionStorage.clear();
    });
    await page.reload();
    await expect(page.locator('#s-name')).toHaveValue('Örnek Firma');
    await expect(page.getByRole('link', { name: /Merkez'de değiştir/ })).toHaveCount(0);
    await expect(page.getByText('Değiştirmek için firma yöneticinize başvurun.')).toBeVisible();
  });

  test("Kurulum: çalışan ve firma adımı yok, firma bilgisi Merkez'den, özet Merkez'e bağlar", async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/`);
    await expect(page).toHaveURL(/\/deciship\/setup/);
    const steps = page.getByRole('navigation', { name: 'Kurulum adımları' });
    await expect(steps.getByRole('button')).toHaveCount(6);
    await expect(steps.getByText('Kullanıcılar')).toHaveCount(0);

    await expect(page.locator('#ob-name')).toHaveCount(0);
    await expect(page.locator('.ob-hub-strip')).toContainText('Yeni Atölye');
    await expect(page.getByRole('link', { name: /Merkez'de değiştir/ }).first()).toHaveAttribute('href', '/account/company');

    await steps.getByRole('button', { name: /Özet/ }).click();
    const team = page.getByRole('region', { name: "Ekibinizi Merkez'den ekleyin" });
    await expect(team).toBeVisible();
    await expect(team.getByRole('link', { name: 'Ekip ve yetkiler' })).toHaveAttribute('href', '/account/team');
    await expect(page.locator('.ob-check-list').getByText('Kullanıcılar')).toHaveCount(0);
  });
});

test.describe('dar ekran', () => {
  for (const width of [390, 1024]) {
    test(`${width} px: yatay taşma yok, ayrıntı paneli başlığın altında ve kapanır`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mockSession(page, 'owner');
      await page.goto(`${APP}/invoices/i1`);
      await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.locator('.lines-dt tbody tr.clickable').first().click();
      const close = page.getByRole('button', { name: 'Paneli kapat' });
      await expect(close).toBeVisible();
      // D09 bandı yapışkan değil: panel ekranın tepesinden başlar, başlığı ve kapatma düğmesi ekranda
      const top = await page.evaluate(() => document.querySelector('.panel')!.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(0);
      await expect(close).toBeInViewport();
      await close.click();
      await expect(close).toBeHidden();
    });
  }

  test('390 px: menü bandın üçüncü satırında yatay kayar; seçim gezinir, etkin öğe görünür; işaret bir kez', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    const nav = toolNav(page);
    await expect(nav).toBeVisible();
    await expect(page.locator('.sod-brand .sod-mark')).toHaveCount(1);
    await expect(page.locator('.sod-brand-sub')).toBeVisible(); // iki satırlı kilit telefonda da
    expect(((await page.locator('.sod-brand').boundingBox())!.height)).toBeLessThanOrEqual(44);
    await expect(page.getByRole('button', { name: 'Uygulamalar' })).toBeHidden(); // ⊞ telefonda hesap menüsünde
    const brand = (await page.locator('.sod-brand').boundingBox())!;
    expect((await nav.boundingBox())!.y).toBeGreaterThan(brand.y + brand.height - 1); // menü logo satırının altında
    expect(await nav.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    await nav.getByRole('link', { name: 'Tarifeler' }).click();
    await expect(page).toHaveURL(/\/deciship\/tariffs$/);
    await expect(nav.getByRole('link', { name: 'Tarifeler' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('390 px: firma, dil ve kullanıcı menüsü ekranda açılır', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/`);
    await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    const item = page.getByRole('menuitem', { name: 'Çıkış yap' });
    await expect(item).toBeVisible();
    const box = await item.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});

/**
 * Bant boyu sabit: yalnız Pano büyük bant; diğer her sayfa (kırıntı, durum etiketi, alt metin, eylem, sekme olsa da olmasa da)
 * aynı en az yükseklikte. Merkez de aynı değeri kullanır (hub-web e2e aynı sayıları sınar).
 * Mesaj 15 K (DESIGN.md "Bant"): alt metin her ekranda, başlık telefonda en çok iki satır; bant yalnız ikinci satır kadar uzar.
 * Telefonda fatura ayrıntısının rozetleri alt metnin ikinci satırına iner (Mesaj 14 D, 08-B2); başlık tek satır kalır.
 */
for (const [w, h, std, titleLine, subLine] of [
  [1440, 900, 240, 44, 24],
  [390, 844, 289, 34, 20],
] as const) {
  test(`bant yüksekliği ${w} px: standart sayfalar ${std} px, Pano büyük`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await mockSession(page, 'owner');
    const band = page.locator('.sod-band');
    const px = async (sel: string) => Math.round((await page.locator(sel).boundingBox())!.height);
    const height = () => px('.sod-band');
    await page.goto(`${APP}/`);
    await expect(band).toHaveAttribute('data-size', 'hero');
    await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
    expect(await height()).toBeGreaterThan(std);
    for (const p of ['/invoices', '/invoices/i1', '/invoices/upload', '/measurements', '/disputes', '/tariffs', '/settings']) {
      await page.goto(`${APP}${p}`);
      await expect(band).toHaveAttribute('data-size', 'standard');
      await expect(page.locator('.sod-band h1')).toBeVisible();
      const pills = w === 390 && p === '/invoices/i1';
      if (pills) await expect(page.locator('.sod-band .psub .inv-pills')).toBeVisible();
      // Tek satırlık başlık ve alt metinde bant tam en az yükseklikte; ikinci satır bandı en çok o satır kadar uzatır
      // (eylem satırı boş sayfada ikinci satır en az yüksekliğin içinde kalabilir). Başka hiçbir şey bandı uzatmaz.
      const subPx = async () => ((await page.locator('.sod-band .psub').count()) ? await px('.sod-band .psub') : 0);
      const extra = async () => (await px('.sod-band h1')) - titleLine + Math.max(0, (await subPx()) - subLine);
      await expect.poll(async () => ((await extra()) === 0 ? (await height()) === std : (await height()) >= std && (await height()) <= std + (await extra())), { message: p }).toBe(true);
      // fatura ayrıntısında eylem satırı dolu: bant tam rozet satırı kadar uzar
      if (pills) expect(await height(), p).toBe(std + (await extra()));
      const title = await px('.sod-band h1');
      expect(pills || w > 760 ? [titleLine] : [titleLine, 2 * titleLine], `${p} başlık satırı`).toContain(title);
      const sub = await subPx();
      if (sub > 0) {
        if (pills) expect(sub, `${p} alt metin: ilk satır + rozet satırı`).toBeGreaterThan(subLine);
        else expect([subLine, 2 * subLine], `${p} alt metin en çok iki satır`).toContain(sub);
      }
    }
    // Fatura ayrıntısında özet kartı banda biner, başlığın altında kalır; kaynak satırı (tarife, dosya) kartta görünür.
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.sod-band .inv-pills')).toBeVisible(); // bant verisi geldi (rozetler telefonda bandı uzatır)
    await expect(page.locator('.inv-sum .inv-src .inv-file')).toBeVisible();
    const b = (await band.boundingBox())!;
    const head = (await page.locator('.sod-band .phead.is-band').boundingBox())!;
    const sum = (await page.locator('.inv-sum.lift').boundingBox())!;
    expect(sum.y).toBeLessThan(b.y + b.height);
    expect(sum.y).toBeGreaterThanOrEqual(head.y + head.height);
    await expect(page.locator('.inv-sum .inv-src .inv-file')).toBeVisible();
    await expect(page.locator('.inv-sum .inv-src .inv-tariff a')).toBeVisible();
  });
}

/**
 * Deneme (kabuk shell.css "SABİT ÜST SATIR", "A · BÖLMELİ SEKMELER"): geniş ekranda üst satır kaydırınca ekranın üstünde sabit;
 * sayfa içi yapışkan öğeler (`--sod-sticky-top`) onun altından başlar, pencere onun önünde açılır. Telefonda da sabit (sekmeler dahil); altta uygulama çubuğu.
 */
test.describe('sabit üst satır', () => {
  test('1440: 800 px kaydırınca üst satır üstte, etkin sekme görünür; yan panel satırın altından başlar; pencere satırın önünde', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/measurements`);
    const rows = page.locator('table.dt tbody tr.clickable');
    await rows.first().waitFor();
    const top = page.locator('.sod-top');
    const band = page.locator('.sod-band');
    expect((await top.boundingBox())!.height).toBe(72);
    const bandH = Math.round((await band.boundingBox())!.height);
    const current = toolNav(page).getByRole('link', { name: 'Ölçümler' });
    await expect(current).toHaveAttribute('aria-current', 'page');
    expect(await current.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');

    await page.evaluate(() => window.scrollTo(0, 800));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(800);
    expect((await top.boundingBox())!.y).toBe(0);
    await expect(top).toBeInViewport();
    await expect(current).toBeInViewport();
    expect(Math.round((await band.boundingBox())!.height)).toBe(bandH);
    expect(await page.evaluate(() => !!document.elementFromPoint(720, 4)?.closest('.sod-top'))).toBe(true);

    // ≥ 1280: yan panel listenin yanında yapışkan; sabit satırın altından başlar.
    await rows.nth(12).click();
    const panel = page.locator('.panel');
    await panel.waitFor();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect.poll(async () => Math.round((await panel.boundingBox())!.y)).toBeGreaterThanOrEqual(72);

    // Pencere (örtü) sabit satırın önünde.
    await panel.getByRole('button', { name: 'Ölçümü sil' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => !!document.elementFromPoint(720, 30)?.closest('.overlay'))).toBe(true);
  });

  test('390: telefonda üst satır sekmelerle birlikte sabit; altta uygulama çubuğu, DeciShip etkin', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/measurements`);
    await page.locator('table.dt tbody tr').first().waitFor();
    await page.evaluate(() => window.scrollTo(0, 800));
    // telefonda kart listesi kaydırma sırasında boy değiştirebilir: konum tam 800 olmayabilir
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const top = page.locator('.sod-top');
    expect(await top.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    expect(Math.round((await top.boundingBox())!.y)).toBe(0);
    await expect(toolNav(page).getByRole('link', { name: 'Ölçümler' })).toBeInViewport();
    const dock = page.locator('.sod-dock');
    await expect(dock).toBeInViewport();
    await expect(dock.locator('[aria-current="page"]')).toContainText('DeciShip');
  });
});
