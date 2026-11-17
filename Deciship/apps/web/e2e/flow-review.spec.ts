import { expect, test, type Page } from './base';
import path from 'node:path';
import { APP, REAL_STACK, mockSession, samples } from './helpers';

// Ürün değerlendirmesi bulguları: akışlar, kenar durumlar.
test.skip(REAL_STACK, 'mock kişileri ve test kancaları gerektirir');

const watchErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};

function countRequests(page: Page, pathname: string) {
  const counter = { n: 0 };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === pathname) counter.n++;
  });
  return counter;
}

test.describe('K1: erişimi kapatılan kişi', () => {
  test('sunucuyu dövmez, sabit "erişiminiz yok" sayfası, Merkez\'e dönüş', async ({ page }) => {
    const errors = watchErrors(page);
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('table.dt tbody tr').first()).toBeVisible();

    const me = countRequests(page, '/api/deciship/me');
    // açık sekme: sunucu artık erişim vermiyor, kişinin kabuktaki rolü henüz eski
    await page.evaluate(() => localStorage.setItem('sod_mock_revoked', '1'));
    await page.reload();

    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await page.waitForTimeout(3000);
    expect(me.n).toBeLessThanOrEqual(5);
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await expect(page.getByText('mobil uygulamada')).toHaveCount(0); // yanlış sayfa değil
    await expect(page.getByRole('link', { name: "Merkez'e dön" })).toHaveAttribute('href', '/home');
    expect(errors).toEqual([]);
  });

  test('sayfa açıkken erişim kapanırsa da döngü yok', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('table.dt tbody tr').first()).toBeVisible();

    const me = countRequests(page, '/api/deciship/me');
    const account = countRequests(page, '/api/account/me');
    await page.evaluate(() => localStorage.setItem('sod_mock_revoked', '1'));
    await page.getByRole('link', { name: 'Ölçümler' }).click();

    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await page.waitForTimeout(3000);
    expect(me.n).toBeLessThanOrEqual(5);
    expect(account.n).toBeLessThanOrEqual(5);
  });

  test('rol Hesap\'ta kapandı, ürün API\'si hâlâ kabul ediyor: Pano\'ya tıklayınca erişim yok, rol dönünce eski rakam çizilmez', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/`);
    await expect(page.locator('.dash-hero-v')).toBeVisible();
    await page.waitForTimeout(5_200); // yeniden denetim aralığı; Pano önbelleği (30 sn) hâlâ taze

    const dashboard = countRequests(page, '/api/deciship/dashboard');
    await page.evaluate(() => localStorage.setItem('sod_mock_role_closed', '1'));
    await page.getByRole('link', { name: 'Pano' }).click();
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await expect(page.locator('.dash-hero-v')).toHaveCount(0);
    expect(dashboard.n).toBe(0);

    // Rol geri geldi: sekmeye dönüşte açılır, Pano önbellek süresi dolmadan da sunucudan okunur
    await page.evaluate(() => localStorage.removeItem('sod_mock_role_closed'));
    await page.waitForTimeout(5_200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.dash-hero-v')).toBeVisible();
    expect(dashboard.n).toBeGreaterThan(0);
  });

  test('sekmeye dönünce de denetlenir: rol kapandıysa eski sayfa kalmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/`);
    await expect(page.locator('.dash-hero-v')).toBeVisible();
    await page.waitForTimeout(5_200);
    await page.evaluate(() => localStorage.setItem('sod_mock_role_closed', '1'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await expect(page.locator('.dash-hero-v')).toHaveCount(0);
  });

  test('gezinme her seferinde Hesap\'a gitmez: aralık içinde tek istek', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/`);
    await expect(page.locator('.dash-hero-v')).toBeVisible();
    const account = countRequests(page, '/api/account/me');
    for (const name of ['Faturalar', 'Pano', 'Faturalar', 'Pano']) await page.locator('nav.sod-nav').getByRole('link', { name }).click();
    await expect(page.locator('.dash-hero-v')).toBeVisible();
    expect(account.n).toBeLessThanOrEqual(1);
  });

  test('yeniden rol verilince yenilemeyle açılır', async ({ page }) => {
    await mockSession(page, 'accounting', { sod_mock_revoked: '1' });
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('sod_mock_revoked'));
    await page.reload();
    await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
  });

  test('mobil rol metni yalnız web izni olmayan role', async ({ page }) => {
    await mockSession(page, 'measure');
    await page.goto(`${APP}/`);
    await expect(page.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();
  });

  test('sayfa sorgusu 403 alırsa kabuğu saniyede bir kez bile dövmez', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_forbid: '/dashboard' });
    const me = countRequests(page, '/api/deciship/me');
    const account = countRequests(page, '/api/account/me');
    await page.goto(`${APP}/`);
    await page.waitForTimeout(3000);
    expect(me.n).toBeLessThanOrEqual(5);
    expect(account.n).toBeLessThanOrEqual(5);
  });
});

test.describe('B5: bulunamayan kayıt', () => {
  for (const id of ['yok', '%20%2F%2F', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
    test(`fatura ${id}: yığın dökümü yok, kayıt bu firmada yok`, async ({ page }) => {
      const errors = watchErrors(page);
      await mockSession(page, 'owner');
      await page.goto(`${APP}/invoices/${id}`);
      await expect(page.getByRole('heading', { name: 'Bu kayıt bu firmada yok' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Bir şeyler ters gitti' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Faturalara dön' })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test('sunucu bozuk kimliğe 400 dönerse de aynı sayfa', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/bozuk`);
    await expect(page.getByRole('heading', { name: 'Bu kayıt bu firmada yok' })).toBeVisible();
  });

  test('tarife de aynı sayfa', async ({ page }) => {
    const errors = watchErrors(page);
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/yok`);
    await expect(page.getByRole('heading', { name: 'Bu kayıt bu firmada yok' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tarifelere dön' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('birden çok firması olana diğer firmaya geçiş önerilir, kayıt adresi korunur', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/yok`);
    await expect(page.getByRole('heading', { name: 'Bu kayıt bu firmada yok' })).toBeVisible();
    const orgs = await page.evaluate(async () => ((await (await fetch('/api/account/me')).json()) as { orgs: { id: string; name: string; status: string }[]; activeOrg: { id: string } }));
    const others = orgs.orgs.filter((o) => o.id !== orgs.activeOrg.id && o.status === 'ACTIVE');
    expect(others.length).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: others[0]!.name })).toBeVisible();
  });
});

test.describe('kurulum', () => {
  test("özet: firma satırı yok (Merkez'de); Hazır koliler gri İsteğe bağlı; atlanan tarife uyarır", async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/setup?adim=ozet`);
    await expect(page.locator('.ob-cl', { hasText: 'Firma' })).toHaveCount(0);
    const koli = page.locator('.ob-cl', { hasText: 'Hazır koliler' });
    await expect(koli.locator('.ob-req.is-opt')).toHaveText('İsteğe bağlı');
    await expect(koli).not.toContainText('Zorunlu');
    // Tamamlanmamışsa "3 aktif hazır koli · Yapılmadı" gibi kendi içinde çelişen satır çıkmaz.
    expect(/aktif hazır koli[\s\S]*Yapılmadı/.test((await koli.textContent()) ?? '')).toBe(false);
    const tarife = page.locator('.ob-cl', { hasText: 'Tarifeler' });
    await expect(tarife.locator('.ob-req.is-req')).toHaveText('Zorunlu');
  });

  test('taşıyıcı yokken "yine de bitirebilir" denmez, düğme neden kapalı söylenir', async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/setup?adim=ozet`);
    await expect(page.getByRole('button', { name: 'Kurulumu bitir' })).toBeDisabled();
    await expect(page.getByText('Yine de bitirebilir')).toHaveCount(0);
    await expect(page.getByText('Kurulumu bitirmek için en az bir taşıyıcı ekleyin.')).toBeVisible();
  });

  test('sihirbaz yeni firmada ilk DeciShip adımından başlar; eski firma adresi (?adim=firma, ?adim=sirket) de oraya açılır', async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/setup`);
    await expect(page.locator('#ob-step-title')).toContainText('Taşıyıcılar');
    await expect(page.locator('.ob-eyebrow')).toHaveText('ADIM 1/6');
    await page.goto(`${APP}/setup?adim=firma`);
    await expect(page.locator('#ob-step-title')).toContainText('Taşıyıcılar');
    await page.goto(`${APP}/setup?adim=sirket`);
    await expect(page.locator('#ob-step-title')).toContainText('Taşıyıcılar');
    // firma satırı listenin başında, sayılmaz ve tıklanmaz
    const steps = page.getByRole('navigation', { name: 'Kurulum adımları' });
    await expect(steps.locator('.ob-hub')).toContainText("Merkez'de tamamlandı");
    await expect(steps.getByRole('button')).toHaveCount(6);
  });

  test('sihirbaz metni: "opsiyonel" yok', async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/setup`);
    // Mesaj 15 sadeleştirmesi: uzun alt metin "Birkaç adımda kurulum…" oldu; "isteğe bağlı" artık adım rozetlerinde
    await expect(page.getByText('Birkaç adımda kurulum; ilerlemeniz kaydedilir.')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Kurulum adımları' }).getByText('İsteğe bağlı', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/opsiyonel/i)).toHaveCount(0);
  });
});

test.describe('Pano varsayılan dönem', () => {
  test('içinde bulunulan ay boşsa son faturanın ayı açılır, "Son veri" notu; kişi seçince ona uyar', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_invoice_month: '2026-10' });
    await page.goto(`${APP}/`);
    await expect(page.locator('#month')).toHaveValue('2026-10');
    await expect(page.locator('.dash-hero-v')).toContainText('765,90');
    await expect(page.getByText('Son veri: Ekim 2026')).toBeVisible();

    // kişi seçimi ezilmez
    const current = await page.locator('#month option').first().getAttribute('value');
    await page.locator('#month').selectOption(current!);
    await expect(page.locator('#month')).toHaveValue(current!);
    await expect(page.getByText('Son veri: Ekim 2026')).toHaveCount(0);
  });

  test('içinde bulunulan ayda fatura varsa o ay kalır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/`);
    await expect(page.locator('.dash-hero-v')).toContainText('765,90');
    const first = await page.locator('#month option').first().getAttribute('value');
    await expect(page.locator('#month')).toHaveValue(first!);
    await expect(page.getByText(/Son veri/)).toHaveCount(0);
  });
});

test.describe('salt okunur satır paneli', () => {
  test('Muhasebe: pasif düğme yok, "Salt okunur" bilgi satırı', async ({ page }) => {
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/invoices/i1`);
    await page.locator('.lines-dt tbody tr.clickable').first().click();
    const panel = page.locator('.panel');
    await expect(panel.locator('.pn-sub')).toBeVisible();
    await expect(panel.getByText('Salt okunur', { exact: false }).first()).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Başka ölçümle eşleştir' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Düzelt', exact: true })).toHaveCount(0);
    await expect(panel.locator('fieldset:disabled button')).toHaveCount(0);
  });

  test('Yönetici: düğmeler açık, bilgi satırı yok', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    await page.locator('.lines-dt tbody tr.clickable').first().click();
    const panel = page.locator('.panel');
    await expect(panel.getByRole('button', { name: 'Başka ölçümle eşleştir' })).toBeEnabled();
    await expect(panel.locator('.pn-ro')).toHaveCount(0);
  });
});

test.describe('oturum süresi dolunca', () => {
  test('kaydedilmemiş yazı varsa sessiz giriş yok: uyarı, form korunur, kişi seçer', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await page.locator('#t-name').fill('Yeni ad');
    await page.evaluate(() => {
      localStorage.setItem('sod_mock_expire', 'TOKEN_EXPIRED');
      localStorage.setItem('sod_mock_no_refresh', '1');
    });
    await page.getByRole('button', { name: 'Kaydet', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Oturumunuz sona erdi');
    await expect(dialog).toContainText('kaydedilmedi');
    await expect(page).toHaveURL(/\/tariffs\/t1$/);

    await dialog.getByRole('button', { name: 'Sayfada kal' }).click();
    await expect(page.locator('#t-name')).toHaveValue('Yeni ad'); // yazı duruyor
    const bar = page.locator('.ds-session-lost');
    await expect(bar).toContainText('Oturumunuz sona erdi');

    page.on('dialog', (d) => d.accept());
    await bar.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test('yazı yoksa doğrudan girişe, kalınan yerle', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await expect(page.locator('#t-name')).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('sod_mock_expire', 'TOKEN_EXPIRED');
      localStorage.setItem('sod_mock_no_refresh', '1');
    });
    await page.getByRole('link', { name: 'Faturalar' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fdeciship%2Finvoices$/);
  });
});

test.describe('fatura sayıları tek kural', () => {
  const tabCounts = (page: Page) =>
    page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const tab of document.querySelectorAll('[role="tab"]')) {
        const m = (tab.textContent ?? '').match(/^(.*?)(\d+)$/);
        if (m) out[m[1]!.trim()] = Number(m[2]);
      }
      return out;
    });

  test('uyumlu sayılan satır Fark var sekmesinde kalır: sekmeler Tümü\'ye denk, başlık ve özet aynı sayı', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    const rows = page.locator('.lines-dt tbody tr.clickable');
    await expect(rows.first()).toBeVisible();
    const before = await tabCounts(page);

    await rows.first().click();
    await page.getByRole('button', { name: 'Uyumlu say' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('textarea').fill('Sözleşme gereği');
    await dlg.getByRole('button', { name: 'Uyumlu say' }).click();
    await expect(page.locator('.toast', { hasText: 'Uyumlu sayıldı' })).toBeVisible();
    await page.getByRole('button', { name: 'Paneli kapat' }).click();
    await expect(page.locator('.panel')).toHaveCount(0);

    // satır bulunduğu sekmede, kararıyla görünür
    await expect(rows.filter({ hasText: 'Uyumlu sayıldı' })).toHaveCount(1);
    const c = await tabCounts(page);
    expect(c['Fark var']).toBe(before['Fark var']);
    // Tarifesiz satırların hepsi kur kaynaklıysa aynı sekme "Kur alınamadı" adını alır.
    const sum = c['Fark var']! + (c['Eşleşmedi'] ?? 0) + (c['Uyumlu'] ?? 0) + (c['Tarife yok'] ?? 0) + (c['Kur alınamadı'] ?? 0);
    expect(sum).toBe(c['Tümü']);
    await expect(rows).toHaveCount(c['Fark var']!);
    // başlık, özet, sekme aynı sayı
    await expect(page.locator('.phead')).toContainText(`${c['Fark var']} satırda fark`);
    await expect(page.locator('.inv-sum-n').first()).toContainText(`${c['Fark var']} satırda fark var`);
  });

  test('Karar süzgeci yine çalışır: Uyumlu sayılan seçilince yalnız onlar', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    const rows = page.locator('.lines-dt tbody tr.clickable');
    await rows.first().click();
    await page.getByRole('button', { name: 'Uyumlu say' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('textarea').fill('Sözleşme gereği');
    await dlg.getByRole('button', { name: 'Uyumlu say' }).click();
    await expect(page.locator('.toast', { hasText: 'Uyumlu sayıldı' })).toBeVisible();
    await page.getByRole('button', { name: 'Paneli kapat' }).click();
    await page.getByRole('combobox', { name: 'Karar' }).selectOption('ACCEPTED');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Uyumlu sayıldı');
  });
});

test.describe('tarife penceresi indirim', () => {
  const open = async (page: Page, hooks: Record<string, string>) => {
    await mockSession(page, 'owner', hooks);
    await page.goto(`${APP}/tariffs/new?carrierId=cf`);
    await page.getByTestId('tariff-file').setInputFiles(path.join(samples, 'tariff-template-example.xlsx'));
    await expect(page.locator('#iw-disc')).toBeVisible();
  };

  test('dosyada indirim yok: uyarı ve onay ister; oran yazılınca ikisi de kalkar, kayıt o oranla', async ({ page }) => {
    await open(page, { sod_mock_no_discount: '1' });
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Dosyada indirim yok').first()).toBeVisible();
    await expect(dlg.locator('.iw-ack input')).toBeVisible();

    await page.locator('#iw-disc').fill('38');
    await expect(dlg.getByText('Dosyada indirim yok')).toHaveCount(0);
    await expect(dlg.locator('.iw-ack input')).toHaveCount(0);

    await page.locator('#iw-name').fill('İndirimli');
    await dlg.getByRole('button', { name: 'Tarifeyi oluştur' }).click();
    await expect(page).toHaveURL(/\/tariffs\/(?!new)/);
    await expect(page.locator('#t-disc')).toHaveValue('38');
  });

  test('oran silinirse uyarı geri gelir', async ({ page }) => {
    await open(page, { sod_mock_no_discount: '1' });
    const dlg = page.getByRole('dialog');
    await page.locator('#iw-disc').fill('38');
    await expect(dlg.getByText('Dosyada indirim yok')).toHaveCount(0);
    await page.locator('#iw-disc').fill('');
    await expect(dlg.getByText('Dosyada indirim yok').first()).toBeVisible();
  });

  test('dosyada sütun doluysa alan o oranla dolu gelir', async ({ page }) => {
    await open(page, { sod_mock_file_discount: '38' });
    await expect(page.locator('#iw-disc')).toHaveValue('38');
    await expect(page.getByRole('dialog').getByText('Dosyada indirim yok')).toHaveCount(0);
  });
});

test.describe('küçükler, tur 2', () => {
  test('özet: isteğe bağlı adımda "Eksik" yok; dolu hazır koli Tamam', async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/setup?adim=ozet`);
    const invoices = page.locator('.ob-cl', { hasText: 'Örnek faturalar' });
    await expect(invoices).toContainText('Yapılmadı');
    await expect(invoices).not.toContainText('Eksik');
    const boxes = page.locator('.ob-cl', { hasText: 'Hazır koliler' });
    await expect(boxes).not.toContainText('Eksik');
  });

  test('PDF tarifede yapay zekâ yokken "deneyin" denmez, düğme pasif, başka yol söylenir', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_pdf_empty: '1' });
    await page.goto(`${APP}/tariffs/new?carrierId=cf`);
    await page.getByTestId('tariff-file').setInputFiles({ name: 'liste.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Bu PDF\'teki tablolar otomatik okunamadı')).toBeVisible();
    await expect(dlg.getByText('deneyin')).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: 'Yapay zekâ ile tara' })).toBeDisabled();
    await expect(dlg.getByText('Excel ya da CSV')).toBeVisible();
  });

  test('EN: süre metni Türk Ticaret Kanunu bağlamını söyler', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_locale: 'en' });
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.phead')).toContainText('Turkish Commercial Code');
    await expect(page.locator('.inv-sum-due')).toContainText('Turkish Commercial Code');
    await expect(page.locator('.phead')).not.toContainText('TTK');
  });

  test('itiraz penceresi metni "doğrulanmış" demez', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    await page.getByRole('button', { name: 'İtiraz metni' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).not.toContainText('doğrula');
  });

  test('mobil rol metni Merkez ile aynı yönlendirme: yönetici paylaşır, bayat metin yok', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, 'measure');
    await page.goto(`${APP}/`);
    await expect(page.getByText('Android uygulamasını yöneticiniz paylaşacak. Telefonunuza kurun.')).toBeVisible();
    await expect(page.getByText('Uygulama henüz mağazada yok, iOS sürümü de yok. Kurulum dosyasını yöneticinizden isteyin.')).toBeVisible();
    await expect(page.getByText('karekod')).toHaveCount(0);
    await expect(page.getByText('uygulamasını açın')).toHaveCount(0);
  });

  test('mobil rol metni EN', async ({ page }) => {
    await mockSession(page, 'measure', { sod_mock_locale: 'en' });
    await page.goto(`${APP}/`);
    await expect(page.getByText('Your admin will share the Android app. Install it on your phone.')).toBeVisible();
    await expect(page.getByText('QR code')).toHaveCount(0);
  });
});

test.describe('askıdaki üye', () => {
  test('DeciShip adresinde askı metnini okur, "üye değilsiniz" değil; Merkez ile aynı metin', async ({ page }) => {
    await mockSession(page, 'accounting', { sod_mock_suspended: '1' });
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('heading', { name: 'Bu firmadaki üyeliğiniz askıda' })).toBeVisible();
    await expect(page.getByText('Yöneticinize başvurun. Askı kalkınca kaldığınız yerden devam edersiniz.')).toBeVisible();
    await expect(page.getByText('Henüz bir firmaya üye değilsiniz')).toHaveCount(0);
    await expect(page.getByRole('link', { name: "Merkez'e dön" })).toHaveAttribute('href', '/home');
  });

  test('EN', async ({ page }) => {
    await mockSession(page, 'accounting', { sod_mock_suspended: '1', sod_mock_locale: 'en' });
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('heading', { name: 'Your membership in this company is suspended' })).toBeVisible();
    await expect(page.getByText('Contact your admin. You continue where you left off once it is resumed.')).toBeVisible();
  });

  test('hiç üyeliği olmayan kişi yine "üye değilsiniz" okur', async ({ page }) => {
    await mockSession(page, 'noOrg');
    await page.goto(`${APP}/invoices`);
    await expect(page.getByText('Henüz bir firmaya üye değilsiniz')).toBeVisible();
    await expect(page.getByText(/askıda/)).toHaveCount(0);
  });

  test('başka etkin firması olan askıdaki kişi firma seçer', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_suspended: '1' });
    await page.goto(`${APP}/invoices`);
    // Önce askıda olduğu söylenir, sonra başka firmayla devam edebilir.
    await expect(page.getByRole('heading', { name: 'Bu firmadaki üyeliğiniz askıda' })).toBeVisible();
    await expect(page.getByText('üyesi olduğunuz başka bir firmayla devam edebilirsiniz')).toBeVisible();
    await expect(page.locator('.ds-access-orgs button').first()).toBeVisible();
    await expect(page.getByText('Devam etmek için bir firma seçin')).toHaveCount(0);
  });
});

test.describe('kg satırı tek satır', () => {
  const lineCount = () =>
    [...document.querySelectorAll('.lines-dt .ln-dim .sub')].map((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return { text: e.textContent, lines: new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.bottom))).size };
    });
  const overflow = () => [...document.querySelectorAll('.table-wrap, .tbl-wrap')].map((e) => e.scrollWidth - e.clientWidth).filter((x) => x > 0);

  for (const lang of ['tr', 'en']) {
    for (const width of [768, 1024, 1279]) {
      test(`${lang} ${width} px: ayraçtan kırılmaz, tablo taşmaz`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mockSession(page, 'owner', { sod_mock_locale: lang });
        await page.goto(`${APP}/invoices/i1`);
        await expect(page.locator('.lines-dt tbody tr.clickable').first()).toBeVisible();
        const lines = await page.evaluate(lineCount);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.filter((l) => l.lines > 1)).toEqual([]);
        expect(await page.evaluate(overflow)).toEqual([]);
      });
    }
    test(`${lang} 1440 px panel açıkken: ayraçtan kırılmaz`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await mockSession(page, 'owner', { sod_mock_locale: lang });
      await page.goto(`${APP}/invoices/i1`);
      await page.locator('.lines-dt tbody tr.clickable').first().click();
      await expect(page.locator('.panel')).toBeVisible();
      const lines = await page.evaluate(lineCount);
      expect(lines.filter((l) => l.lines > 1)).toEqual([]);
      expect(await page.evaluate(overflow)).toEqual([]);
    });
  }

  test('geniş tabloda gerçek kg da görünür; darda yalnız ücretli, farklı gerçek kg kalır', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    const sub = page.locator('.lines-dt tbody tr.clickable').first().locator('.ln-dim .sub').first();
    await expect(sub).toHaveText(/4,0\s*kg\s*·\s*ücretli\s*6,0\s*kg/);
    // D09'da yan menü yok: dar tablo (≤ 820 px) artık ~860 px ekranda
    await page.setViewportSize({ width: 860, height: 900 });
    await expect(sub).toHaveText(/ücretli\s*6,0\s*kg/);
    await expect(sub.locator('.ln-kg-actual')).toBeHidden();
  });
});

test.describe('terim ve açık metin', () => {
  test('süre metni: TTK itirazı ile taşıyıcı düzeltmesi ayrı, neye yaradığı belli', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    const due = page.locator('.inv-sum-due');
    await expect(due).toContainText('TTK');
    await expect(due).toContainText('FedEx');
    await expect(due).toContainText('düzeltme talebi');
  });

  test('buton ve durum tek dil: İtiraz listesine ekle → İtiraz listesinde', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    await page.locator('.lines-dt tbody tr.clickable').first().click();
    await page.getByRole('button', { name: 'İtiraz listesine ekle' }).click();
    await expect(page.getByText('İtiraz listesine eklendi')).toBeVisible();
    // panel sıradaki satıra geçer: durum satırın kendisinde okunur
    await page.getByRole('button', { name: 'Paneli kapat' }).click();
    await page.getByRole('tab', { name: /Tümü/ }).click();
    await expect(page.locator('.lines-dt td.ln-c-dec', { hasText: 'İtiraz listesinde' }).first()).toBeVisible();
    await expect(page.getByText('Doğrulandı')).toHaveCount(0);
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('columnheader', { name: 'Doğrulanan' })).toHaveCount(0);
  });

  test('Tarife uyumu uyarısı indirimi de sorar', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_health_suspect: '1' });
    await page.goto(`${APP}/invoices/i1`);
        await expect(page.getByText('tarifedeki indirim oranını da kontrol edin')).toBeVisible();
  });
});
