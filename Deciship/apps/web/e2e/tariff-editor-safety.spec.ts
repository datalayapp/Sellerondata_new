import { expect, test, type Page } from './base';
import { APP, REAL_STACK, mockSession } from './helpers';

// Yeni denetim Mesaj 0: tarife ekranı yanlış kayıt yapmasın (10-B1, 10-B4, 10-B6, 10-B17 + 02-B4, 02-B10).
test.skip(REAL_STACK, 'mock kişileri ve mock tarife verisini gerektirir');

/** Bölge eşleme listesindeki (ülke, bölge) çiftleri; bölge seçicinin görünen adıyla. */
const countryZones = (page: Page) =>
  page.locator('.cz-list li.cz').evaluateAll((lis) =>
    lis.map((li) => {
      const c = (li.querySelector('input') as HTMLInputElement).value;
      const sel = li.querySelector('select') as HTMLSelectElement;
      return `${c}>${sel.options[sel.selectedIndex]?.text ?? ''}`;
    }),
  );

const save = (page: Page) => page.getByRole('button', { name: 'Kaydet', exact: true }).click();
/** Kayıtta çıkan hata listesi (toast'ta da aynı ilk hata yazar). */
const errorList = (page: Page) => page.locator('.notif.err');

test.describe('bölge adı yazılırken ülkeler yer değiştirmez (10-B1)', () => {
  test('B sütununu harf harf "A2" yapmak yalnız B ülkelerini A2 yapar; A ülkeleri A da kalır, kayıt da öyle', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    const zoneB = page.getByRole('textbox', { name: '2. bölge adı' });
    await expect(zoneB).toHaveValue('B');
    expect(await countryZones(page)).toEqual(['FR>A', 'DE>A', 'NL>A', 'GB>B', 'US>D']);
    // sil ve yeniden yaz: ara adımda ad bir an "A" olur
    await zoneB.click();
    await zoneB.press('End');
    await zoneB.press('Backspace');
    await zoneB.pressSequentially('A2');
    await expect(zoneB).toHaveValue('A2');
    expect(await countryZones(page)).toEqual(['FR>A', 'DE>A', 'NL>A', 'GB>A2', 'US>D']);
    await save(page);
    await expect(page.getByText('Tarife kaydedildi')).toBeVisible();
    const saved = await page.evaluate(async () => (await (await fetch('/api/deciship/tariffs/t1')).json()).tariff.zones as { country: string; zone: string }[]);
    expect(saved.map((z) => `${z.country}>${z.zone}`).sort()).toEqual(['DE>A', 'FR>A', 'GB>A2', 'NL>A', 'US>D']);
  });

  test('başka bölgenin adı (büyük/küçük harf farkı dahil) verilirse kayıt durur ve neden söylenir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    const zoneB = page.getByRole('textbox', { name: '2. bölge adı' });
    await zoneB.fill('a');
    await expect(zoneB).toHaveClass(/invalid/);
    // eşleme yerinde: GB hâlâ ikinci sütunda
    expect(await countryZones(page)).toEqual(['FR>A', 'DE>A', 'NL>A', 'GB>a', 'US>D']);
    await save(page);
    await expect(errorList(page)).toContainText('“a” bölge adı iki kez kullanılmış');
    await expect(page.getByText('Tarife kaydedildi')).toHaveCount(0);
  });
});

test.describe('yeni tarifede taşıyıcı değişince yüklenen PDF eski taşıyıcıya gitmez (10-B4)', () => {
  test('PDF yüklendikten sonra taşıyıcı değişirse eski taşıyıcının belgesi bırakılır; yeniden yükleme yeni taşıyıcıya gider', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/new`);
    const carrier = page.locator('#cr-car');
    await expect(carrier).toHaveValue('cf');
    const pdf = { name: 'ups-liste.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') };
    await page.getByTestId('tariff-file').setInputFiles(pdf);
    const dlg = page.getByRole('dialog');
    // kodla tarama kendiliğinden biter; sonra pencere kapanabilir
    const close = dlg.getByRole('button', { name: 'Kapat', exact: true });
    await expect(close).toBeEnabled();
    await close.click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('.imp-file')).toContainText('ups-liste.pdf');
    await carrier.selectOption('ca');
    // eski taşıyıcının belgesine dönüş yolu kalmaz ("Tablolara dön" → FedEx'e açılan tarife)
    await expect(page.locator('.imp-file')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tablolara dön' })).toHaveCount(0);
    // yükleme isteğindeki taşıyıcı (çok parçalı gövde sayfada okunur)
    await page.evaluate(() => {
      const w = window as unknown as { __carriers: unknown[]; fetch: typeof fetch };
      const orig = w.fetch.bind(window);
      w.__carriers = [];
      w.fetch = (input, init) => {
        if (init?.body instanceof FormData) w.__carriers.push(init.body.get('carrierId'));
        return orig(input, init);
      };
    });
    await page.getByTestId('tariff-file').setInputFiles(pdf);
    await expect(dlg).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __carriers: unknown[] }).__carriers)).toEqual(['ca']);
  });

  test('yükleme sürerken taşıyıcı değişirse eski taşıyıcının yanıtı açılmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/new`);
    const carrier = page.locator('#cr-car');
    await expect(carrier).toHaveValue('cf');
    await page.getByTestId('tariff-file').setInputFiles({ name: 'ups-liste.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByText('Dosya yükleniyor…')).toBeVisible();
    await carrier.selectOption('ca');
    await expect(page.getByText('Dosya yükleniyor…')).toHaveCount(0);
    // mock yükleme 500 ms sürer: yanıt gelse de pencere ve dosya satırı çıkmaz
    await page.waitForTimeout(1500);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.imp-file')).toHaveCount(0);
  });
});

test.describe('okunamayan oran kaydı durdurur (10-B6)', () => {
  test('yakıta "2o" yazılınca alan işaretlenir, kayıt durur; düzeltilince kaydedilir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await page.locator('#t-fuel').fill('2o');
    await expect(page.locator('#t-fuel')).toHaveAttribute('aria-invalid', 'true');
    await save(page);
    await expect(errorList(page)).toContainText('Yakıt oranı okunamadı');
    await expect(page.getByText('Tarife kaydedildi')).toHaveCount(0);
    await page.locator('#t-fuel').fill('20');
    await save(page);
    await expect(page.getByText('Tarife kaydedildi')).toBeVisible();
    await expect(page.locator('#t-fuel')).toHaveValue('20');
  });
});

/** Başka bir yöneticinin aynı tarifeyi kaydetmesi: ekranın kullandığı API ile, sürüm bilgisi olmadan (eski istemci gibi). */
async function otherAdminSaves(page: Page, patch: Record<string, unknown>) {
  const status = await page.evaluate(async (p) => {
    const csrf = document.cookie.match(/sod_csrf=([^;]+)/)?.[1] ?? 'x';
    const cur = (await (await fetch('/api/deciship/tariffs/t1')).json()).tariff;
    const r = await fetch('/api/deciship/tariffs/t1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-sod-csrf': csrf },
      body: JSON.stringify({ ...cur, ...p, expectedUpdatedAt: cur.updatedAt }),
    });
    return r.status;
  }, patch);
  expect(status).toBe(200);
}

test.describe('tarife siz bakarken değişirse (10-B17, 02-B4)', () => {
  test('kayıt ezmez: bant çıkar, taslak durur; "Güncel hâli yükle" öbür değişikliği getirir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await page.locator('#t-fuel').fill('26');
    await otherAdminSaves(page, { name: 'Başka yöneticinin adı' });
    await save(page);
    const band = page.locator('.te-stale');
    await expect(band).toContainText('Bu tarife siz bakarken değişti');
    await expect(page.locator('#t-fuel')).toHaveValue('26');
    await expect(page.locator('#t-name')).toHaveValue('FedEx International Economy 2026');
    await band.getByRole('button', { name: 'Güncel hâli yükle' }).click();
    await expect(band).toHaveCount(0);
    await expect(page.locator('#t-name')).toHaveValue('Başka yöneticinin adı');
    await expect(page.locator('#t-fuel')).toHaveValue('25');
  });

  test('"Yine de kaydet" bilerek üzerine yazar; öbür hâl sürüm geçmişinde kalır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await page.locator('#t-fuel').fill('26');
    await otherAdminSaves(page, { name: 'Başka yöneticinin adı' });
    await save(page);
    const band = page.locator('.te-stale');
    await expect(band).toBeVisible();
    await band.getByRole('button', { name: 'Yine de kaydet' }).click();
    await expect(page.getByText('Tarife kaydedildi')).toBeVisible();
    await expect(band).toHaveCount(0);
    await expect(page.locator('#t-fuel')).toHaveValue('26');
    await expect(page.locator('#t-name')).toHaveValue('FedEx International Economy 2026');
    const versions = await page.evaluate(async () => (await (await fetch('/api/deciship/tariffs/t1/versions')).json()).items as unknown[]);
    // açılıştaki 2 + öbür yöneticinin kaydı + bu kayıt
    expect(versions.length).toBe(4);
  });
});

test.describe('aynı ek ücret iki kez girilmez (02-B10)', () => {
  test('aynı kodlu ikinci ek ücret kaydı durdurur', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/tariffs/t1`);
    await page.getByRole('button', { name: 'Ek ücret ekle' }).click();
    const codes = page.getByRole('textbox', { name: 'Kod' });
    await codes.last().fill('res');
    await page.getByRole('textbox', { name: 'Tutar' }).last().fill('50');
    await save(page);
    await expect(errorList(page)).toContainText('RES ek ücreti iki kez girilmiş');
    await expect(page.getByText('Tarife kaydedildi')).toHaveCount(0);
  });
});
