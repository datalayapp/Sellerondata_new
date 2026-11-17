import { expect, test, type Page } from './base';
import { APP, REAL_STACK, mockSession } from './helpers';

/*
 * Y12 · Mesaj 4 ekranları (SPEC §3.14 "Geçmiş sonuçlar: tarife sürümü ve dondurma"): fatura hesaplandığı günkü tarife ve
 * ayarla durur; tarife ya da ayar sonradan değişince faturada bant çıkar, yeni dayanağa geçiş önce/sonra penceresiyle onaylanır.
 *
 * Mock kuralları (`src/mocks/browser.ts` "Mesaj 4"): yeni tarife sürümü fark satırlarını %15 azaltır, yeni ayar 100'ün altındaki
 * farkı siler, yeniden hesap bekleyen satırın farkı yarıya iner, kuru alınamamış satır dolar. `sod_mock_recalc`: i1'in tarifesi
 * sonradan değişmiş, satır 1 itiraz listesinde (Doğrulandı) ve ölçümü değişmiş (yeniden hesap bekliyor).
 * i1 fark satırları: 458,50 (bekleyen) · 212,40 · 95,00 → yeni tarifeyle 194,86 · 180,54 · 80,75; kur satırı (Kur alınamadı) Uyumlu olur.
 */
test.skip(REAL_STACK, 'mock dayanağı ve test kancaları gerektirir');

const INVOICE_NO = '9-482-11735';
const TARIFF = 'FedEx International Economy 2026';
const BAND_TARIFF = 'Bu fatura hesaplandığı günkü tarifeyle duruyor; tarife sonradan değişti.';
const BAND_RULES = 'Bu fatura hesaplandığı günkü ayarla duruyor; toleranslar sonradan değişti.';
const BAND_LOCKED = 'Gönderilmiş itiraz geri çekilene dek böyle kalır.';
const STALE = 'Rakamlar siz bakarken değişti; önizleme yenilendi. Kontrol edip yeniden uygulayın.';

const summary = (page: Page) => page.locator('section.inv-sum');
const band = (page: Page, text: string) => page.locator('.inv-sum-warn', { hasText: text });
const toast = (page: Page, title: string) => page.locator('.toast', { hasText: title });
/** Boşluk ve para işareti farkı olmadan karşılaştırmak için yalnız rakam ve virgül. */
const digits = (s: string | null) => (s ?? '').replace(/[^\d,]/g, '');

/** Mock sunucuda tarifeyi değiştirir (her yazım yeni sürüm açar): açık önizleme bayatlar. */
async function bumpTariff(page: Page, tariffId: string) {
  const status = await page.evaluate(async (id) => {
    const csrf = document.cookie.match(/sod_csrf=([^;]+)/)?.[1] ?? 'x';
    const headers = { 'content-type': 'application/json', 'x-sod-csrf': csrf };
    const { tariff } = (await fetch(`/api/deciship/tariffs/${id}`, { headers }).then((r) => r.json())) as { tariff: Record<string, unknown> };
    const { id: _id, ...body } = tariff;
    void _id;
    return fetch(`/api/deciship/tariffs/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) }).then((r) => r.status);
  }, tariffId);
  expect(status).toBe(200);
}

async function openInvoiceFromList(page: Page, invoiceNo: string) {
  await page.locator('nav.sod-nav').getByRole('link', { name: 'Faturalar' }).click();
  await page.locator('.inv-list td.card-title', { hasText: invoiceNo }).first().click();
  await expect(page.locator('.ptitle .mono')).toHaveText(invoiceNo);
}

/** Tarife düzenleyicide yakıt oranını değiştirip kaydeder: tarifenin yeni sürümü doğar. */
async function saveTariffWithNewFuel(page: Page, tariffId: string, fuel = '26') {
  await page.goto(`${APP}/tariffs/${tariffId}`);
  await page.locator('#t-fuel').fill(fuel);
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText('Tarife kaydedildi')).toBeVisible();
}

test.describe('fatura bandı: tarife ya da ayar sonradan değişti', () => {
  test('dayanak güncelse bant yok', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices/i1`);
    await expect(summary(page)).toBeVisible();
    await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
    await expect(page.getByText(BAND_TARIFF)).toHaveCount(0);
    await expect(page.getByText(BAND_RULES)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Yeni tarifeyle hesapla' })).toHaveCount(0);
  });

  test('tarife değişti: bant tek eylemle, bekleyen satır özeti ve rozeti görünür', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_recalc: '1' });
    await page.goto(`${APP}/invoices/i1`);
    const b = band(page, BAND_TARIFF);
    await expect(b).toBeVisible();
    await expect(b).toHaveAttribute('role', 'status');
    await expect(b.getByRole('button', { name: 'Yeni tarifeyle hesapla' })).toBeEnabled();
    await expect(b.getByRole('button')).toHaveCount(1);
    await expect(summary(page)).toContainText('1 satır yeniden hesap bekliyor (karar verildiği için sonucu değiştirilmedi).');
    await expect(page.locator('.lines-dt .ln-recalc')).toHaveText(['Ölçüm değişti']);
  });

  test('karar izni yoksa bant bilgi verir, eylem önermez', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_recalc: '1', sod_mock_strip_perm: 'deciship.lines.decide' });
    await page.goto(`${APP}/invoices/i1`);
    await expect(band(page, BAND_TARIFF)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yeni tarifeyle hesapla' })).toHaveCount(0);
  });
});

test.describe('önce/sonra penceresi (tek fatura, yeni tarife)', () => {
  test('pencere neyin değiştiğini söyler; Vazgeç hiçbir şey yazmaz', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_recalc: '1' });
    await page.goto(`${APP}/invoices/i1`);
    // özet yüklenene dek iskelet: tutar gelene kadar beklenir
    await expect.poll(async () => digits(await summary(page).locator('.inv-sum-v').textContent())).toBe('765,90');

    await band(page, BAND_TARIFF).getByRole('button', { name: 'Yeni tarifeyle hesapla' }).click();
    const dlg = page.getByRole('dialog', { name: 'Yeni tarifeyle hesapla' });
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.modal-label')).toHaveText(`FedEx · ${INVOICE_NO}`);
    // "önce" tarafı faturanın hesaplandığı gün (tarih biçimi fmtDate'in: "12 Kas 2026")
    await expect(dlg.locator('.rc-subject')).toHaveText(new RegExp(`^Tarife: ${TARIFF} \\(\\d{1,2} \\S+ \\d{4}\\) → bugünkü hâli$`));
    const kvs = dlg.locator('dl.kvs');
    await expect(kvs.locator('dt')).toHaveText(['Fazla ödeme', 'Değişen satır']);
    const change = kvs.locator('dd').first();
    expect(digits(await change.locator('b').textContent())).toBe('456,15');
    await expect(change).toContainText('765,90');
    await expect(change.locator('.green')).toContainText('309,75'); // azalan fark yeşil
    await expect(kvs.locator('dd').nth(1)).toHaveText('4');
    await expect(dlg).toContainText('1 satırda karar verilmişti; karar korunur.');
    await expect(dlg.locator('.rc-list thead th')).toHaveText(['Takip no', 'Önceki fark', 'Yeni fark']);
    await expect(dlg.locator('.rc-list tbody tr')).toHaveCount(4);
    // tek birincil eylem
    await expect(dlg.locator('.modal-actions .pa.prim')).toHaveText('Uygula');
    await expect(dlg.getByRole('button', { name: 'Vazgeç' })).toBeVisible();
    await expect(dlg.locator('.rc-stale')).toHaveCount(0);

    await dlg.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(band(page, BAND_TARIFF)).toBeVisible();
    expect(digits(await summary(page).locator('.inv-sum-v').textContent())).toBe('765,90');
    await expect(page.locator('.lines-dt .ln-recalc')).toHaveCount(1);
    await expect(toast(page, 'Fatura yeni tarifeyle hesaplandı')).toHaveCount(0);
  });

  test('onay yeni tarifeyle yazar: karar korunur, bant ve bekleyen işaret kalkar', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_recalc: '1' });
    await page.goto(`${APP}/invoices/i1`);
    await band(page, BAND_TARIFF).getByRole('button', { name: 'Yeni tarifeyle hesapla' }).click();
    const dlg = page.getByRole('dialog', { name: 'Yeni tarifeyle hesapla' });
    const after = digits(await dlg.locator('dl.kvs dd').first().locator('b').textContent());
    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(dlg).toHaveCount(0);
    const done = toast(page, 'Fatura yeni tarifeyle hesaplandı');
    await expect(done).toBeVisible();
    await expect(done).toContainText('Kararlarınız korundu.');

    await expect(page.getByText(BAND_TARIFF)).toHaveCount(0);
    await expect.poll(async () => digits(await summary(page).locator('.inv-sum-v').textContent())).toBe(after);
    await expect(summary(page)).not.toContainText('yeniden hesap bekliyor');
    await expect(page.locator('.lines-dt .ln-recalc')).toHaveCount(0);
    // satır 1 hâlâ itiraz listesinde: listedeki tutar yeni farkı (458,50 × 0,5 × 0,85) gösterir
    const inDispute = summary(page).locator('.inv-sum-kvs div', { hasText: 'İtiraz listesinde' }).locator('dd');
    await expect.poll(async () => digits(await inDispute.textContent())).toBe('194,86');
  });
});

test.describe('bayat önizleme', () => {
  test('tek fatura: rakamlar bakarken değişirse yazılmaz, önizleme yenilenir, ikinci onay yazar', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_recalc: '1' });
    await page.goto(`${APP}/invoices/i1`);
    await band(page, BAND_TARIFF).getByRole('button', { name: 'Yeni tarifeyle hesapla' }).click();
    const dlg = page.getByRole('dialog', { name: 'Yeni tarifeyle hesapla' });
    await expect(dlg.locator('.rc-list tbody tr')).toHaveCount(4);
    await expect(dlg.locator('.rc-stale')).toHaveCount(0);

    // pencere açıkken tarife yeniden değişir (başka bir sekmede kaydedilmiş gibi): önizlemenin belirteci eskir
    await bumpTariff(page, 't1');
    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(dlg.locator('.rc-stale')).toHaveText(STALE);
    await expect(dlg).toBeVisible();
    await expect(toast(page, 'Fatura yeni tarifeyle hesaplandı')).toHaveCount(0);
    // yazılmadı: bant ve bekleyen işaret yerinde
    await expect(band(page, BAND_TARIFF)).toBeVisible();
    await expect(page.locator('.lines-dt .ln-recalc')).toHaveCount(1);

    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(toast(page, 'Fatura yeni tarifeyle hesaplandı')).toBeVisible();
    await expect(page.getByText(BAND_TARIFF)).toHaveCount(0);
  });

  test('toplu: onaydan önce tarife yeniden değişirse iş yazmaz, pencere yenilenmiş önizlemeyle döner', async ({ page }) => {
    await mockSession(page, 'owner');
    await saveTariffWithNewFuel(page, 't1');
    await page.locator('.te-notice').getByRole('button', { name: 'Yeni tarifeye geçir' }).click();
    const dlg = page.getByRole('dialog', { name: '1 fatura yeni tarifeye geçirilsin mi?' });
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.rc-stale')).toHaveCount(0);

    await bumpTariff(page, 't1');
    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(dlg.locator('.rc-stale')).toHaveText(STALE);
    await expect(page.locator('.te-notice')).not.toContainText('yeni tarifeye geçirildi');
    await expect(toast(page, 'Faturalar yeni tarifeye geçirildi')).toHaveCount(0);

    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(page.locator('.te-notice')).toContainText('1 fatura yeni tarifeye geçirildi.');
    await expect(dlg).toHaveCount(0);
    await openInvoiceFromList(page, INVOICE_NO);
    await expect(page.getByText(BAND_TARIFF)).toHaveCount(0);
  });
});

test.describe('toplu geçiş', () => {
  test('tarife: itirazdaki faturalar atlanır; geçirilen fatura bantsız, itirazdaki bantta nedenini söyler', async ({ page }) => {
    // iş birkaç yoklama sürsün: "kontrol ediliyor" penceresi görünür
    await mockSession(page, 'owner', { sod_mock_disputes: '1', sod_mock_job_polls: '2' });
    await saveTariffWithNewFuel(page, 't1');
    const notice = page.locator('.te-notice');
    await expect(notice).toContainText('hesaplandığı günkü tarifeyle duruyor');
    await notice.getByRole('button', { name: 'Yeni tarifeye geçir' }).click();

    const wait = page.getByRole('dialog', { name: `Tarife: ${TARIFF}, hesaplandığı günkü fiyatlar → bugünkü hâli` });
    await expect(wait).toBeVisible();
    await expect(wait).toContainText('Faturalar kontrol ediliyor');

    const dlg = page.getByRole('dialog', { name: /fatura yeni tarifeye geçirilsin mi\?$/ });
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.modal-label')).toHaveText(TARIFF);
    await expect(dlg.locator('.rc-subject')).toHaveText(`Tarife: ${TARIFF}, hesaplandığı günkü fiyatlar → bugünkü hâli`);
    await expect(dlg.locator('.rc-list thead th')).toHaveText(['Fatura', 'Fazla ödeme', 'Değişen satır']);
    const rows = dlg.locator('.rc-list tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(1);
    // başlıktaki ve özetteki sayı listedekiyle aynı
    await expect(dlg.locator('.modal-title')).toHaveText(`${n} fatura yeni tarifeye geçirilsin mi?`);
    await expect(dlg.locator('dl.kvs dt').last()).toHaveText('Geçirilecek fatura');
    await expect(dlg.locator('dl.kvs dd').last()).toHaveText(String(n));
    await expect(rows.filter({ hasText: INVOICE_NO })).toHaveCount(1);
    // gönderilmiş itirazı olan fatura listede yok, sayısı söylenir
    await expect(rows.filter({ hasText: '9-488-77120' })).toHaveCount(0);
    await expect(dlg.getByText(/^Gönderilmiş itirazı olan \d+ fatura atlanır\.$/)).toBeVisible();

    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(toast(page, 'Faturalar yeni tarifeye geçirildi')).toBeVisible();
    await expect(notice).toContainText(`${n} fatura yeni tarifeye geçirildi.`);
    await expect(notice).toContainText(/\d+ fatura atlandı \(itirazda ya da bu arada değişti\)\./);
    await expect(notice.getByRole('button', { name: 'Yeni tarifeye geçir' })).toHaveCount(0);

    await openInvoiceFromList(page, INVOICE_NO);
    await expect(summary(page)).toBeVisible();
    await expect(page.getByText(BAND_TARIFF)).toHaveCount(0);

    // gönderilmiş itirazdaki fatura eski tarifeyle kaldı: bant var, eylem yerine neden
    await openInvoiceFromList(page, '9-488-77120');
    const b = band(page, BAND_TARIFF);
    await expect(b).toBeVisible();
    await expect(b).toContainText(BAND_LOCKED);
    await expect(b.getByRole('button')).toHaveCount(0);
  });

  test('ayar: kaydedince sorulur; Vazgeç eski ayarla bırakır, faturadaki "ayar değişti" bandından tek fatura geçirilir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await page.locator('#s-edge').fill('0,7');
    await page.getByRole('button', { name: 'Kaydet' }).first().click();
    const dlg = page.getByRole('dialog', { name: '1 fatura eski ayarla hesaplı. Yeni ayara geçirilsin mi?' });
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.modal-label')).toHaveText('Ayarlar');
    await expect(dlg.locator('.rc-subject')).toHaveText('Ayarlar: eski ayar → bugünkü ayar');
    await expect(dlg.locator('.rc-list tbody tr')).toHaveCount(1);
    await expect(dlg.locator('.rc-list tbody tr')).toContainText(INVOICE_NO);
    await dlg.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(dlg).toHaveCount(0);

    await openInvoiceFromList(page, INVOICE_NO);
    const b = band(page, BAND_RULES);
    await expect(b).toBeVisible();
    await b.getByRole('button', { name: 'Yeni ayarla hesapla' }).click();
    const one = page.getByRole('dialog', { name: 'Yeni ayarla hesapla' });
    await expect(one.locator('.rc-subject')).toHaveText('Ayarlar: hesaplandığı günkü → bugünkü');
    // 100'ün altındaki fark (95,00) yeni ayarla silinir, kur satırı dolar
    await expect(one.locator('dl.kvs dd').last()).toHaveText('2');
    await one.getByRole('button', { name: 'Uygula' }).click();
    await expect(toast(page, 'Fatura yeni ayarla hesaplandı')).toBeVisible();
    await expect(page.getByText(BAND_RULES)).toHaveCount(0);
  });

  test('ayar: değiştir, kaydetmeden geçir: düğme kapalı ve "Önce kaydedin" görünür', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    const edge = page.locator('#s-edge');
    const btn = page.getByRole('button', { name: 'Eski faturaları yeni ayara geçir' });
    await expect(edge).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(page.getByText('Önce kaydedin', { exact: true })).toHaveCount(0);
    const original = await edge.inputValue();
    await edge.fill(original === '0,9' ? '0,8' : '0,9');
    await expect(btn).toBeDisabled();
    await expect(page.getByText('Önce kaydedin', { exact: true })).toBeVisible();
    await edge.fill(original);
    await expect(btn).toBeEnabled();
    await expect(page.getByText('Önce kaydedin', { exact: true })).toHaveCount(0);
  });

  test('ayar: onaylanınca faturalar yeni ayara geçer, faturada bant kalmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await page.locator('#s-edge').fill('0,7');
    await page.getByRole('button', { name: 'Kaydet' }).first().click();
    const dlg = page.getByRole('dialog', { name: '1 fatura eski ayarla hesaplı. Yeni ayara geçirilsin mi?' });
    await dlg.getByRole('button', { name: 'Uygula' }).click();
    await expect(toast(page, 'Faturalar yeni ayara geçirildi')).toBeVisible();
    await expect(dlg).toHaveCount(0);
    await openInvoiceFromList(page, INVOICE_NO);
    await expect(summary(page)).toBeVisible();
    await expect(page.getByText(BAND_RULES)).toHaveCount(0);
  });
});
