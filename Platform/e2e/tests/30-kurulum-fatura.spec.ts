import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../lib/fixtures.ts';
import { FEDEX_INVOICE, confirmCompany, loadMeasurements, registerOwner, sampleFile } from '../lib/api.ts';
import { APP, SAMPLES } from '../lib/sys.ts';

/** Gerçek kullanıcının ilk kurulumu: sihirbaz, tarife dosyası, gerçek fatura. */
test.describe('DeciShip kurulumu ve gerçek fatura', () => {
  test("kurulum: çalışan adımı yok, firma bilgileri Merkez'de onaylanır ve salt okunur; taşıyıcı, tarife, gerçek fatura 18/13/4/1, 611,20 ₺", async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Kurulum Lojistik' });
    const page = await openAs(owner.api);
    await page.goto('/deciship/');
    // Yeni firma DeciShip'e ilk girişte kuruluma düşer
    await expect(page).toHaveURL(/\/deciship\/setup/);
    await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();

    // Çalışan adımı yok
    const steps = page.getByRole('navigation', { name: 'Kurulum adımları' });
    await expect(steps).toBeVisible();
    await expect(steps).not.toContainText(/çalışan|personel|kullanıcı/i);
    await expect(page.locator('body')).not.toContainText(/Çalışan ekle|Kullanıcı ekle/);

    // Firma bilgileri yalnız Merkez'de (KARARLAR "Merkez kurulumu ve araç kurulumu"): sihirbazda "Firma" adımı ve alanı yok.
    // Onaysız yeni firmada sihirbaz yalnız "Önce firma bilgileri"ni gösterir; DeciShip adımları kapalı.
    await expect(page.getByLabel('Firma adı')).toHaveCount(0);
    await expect(steps).toContainText(/Firma bilgileri\s*Merkez'de bekliyor/);
    await expect(steps.getByRole('button', { name: /^Taşıyıcılar/ })).toBeDisabled();
    const gate = page.getByRole('region', { name: 'Önce firma bilgileri' });
    await expect(gate.locator('dd').first()).toHaveText('Kurulum Lojistik');
    await expect(gate).toContainText('TRY (onay bekliyor)');

    // "Merkez'de onayla": Merkez › Firma, onay, sonra sihirbaza dönüş (`next`).
    await gate.getByRole('link', { name: "Merkez'de onayla" }).click();
    await expect(page).toHaveURL(`${APP}/account/company?next=${encodeURIComponent('/deciship/setup')}`);
    await expect(page.getByLabel('Firma adı')).toHaveValue('Kurulum Lojistik');
    await page.getByRole('button', { name: 'Onayla', exact: true }).click();
    await expect(page).toHaveURL(/\/deciship\/setup/);

    // Onaydan sonra: firma bilgileri Merkez'den salt okunur gösterilir, sihirbaz taşıyıcılarla başlar
    await expect(steps).toContainText(/Firma bilgileri\s*Merkez'de tamamlandı/);
    await expect(page.locator('.ob-hub-strip')).toContainText('Kurulum Lojistik · Türkiye · TRY · Europe/Istanbul');
    await expect(page.locator('.ob-hub-strip').getByRole('link', { name: /Merkez'de değiştir/ })).toHaveAttribute('href', '/account/company');
    await expect(page.getByLabel('Firma adı')).toHaveCount(0);

    // Taşıyıcı
    await expect(page.locator('#ob-step-title')).toContainText('Taşıyıcılar');
    await page.locator('label.ob-car', { hasText: 'FedEx' }).click();
    await page.getByRole('button', { name: 'Ekle ve devam et' }).click();
    await expect(page.getByText('Taşıyıcı eklendi')).toBeVisible();

    // Örnek fatura adımı opsiyonel: atlanır, gerçek fatura sonra yüklenir
    await expect(page.locator('#ob-step-title')).toContainText('Örnek faturalar');
    await page.getByRole('button', { name: 'Örnek fatura olmadan devam et' }).click();

    // Tarife: Excel şablonundan
    await expect(page.locator('#ob-step-title')).toContainText('Tarifeler');
    await page.getByRole('link', { name: 'PDF / Excel yükle' }).first().click();
    await page.getByTestId('tariff-file').setInputFiles(path.join(SAMPLES, 'tariff-template-example.xlsx'));
    const dlg = page.getByRole('dialog', { name: /Yeni tarife/ });
    await expect(dlg).toBeVisible();
    const ack = dlg.locator('.iw-ack input');
    if (await ack.count()) await ack.check();
    await page.locator('#iw-name').fill('FedEx International Economy 2026');
    await page.locator('#iw-fuel').fill('25');
    await dlg.getByRole('button', { name: 'Tarifeyi oluştur' }).click();
    await expect(page).toHaveURL(/deciship.tariffs.[0-9a-f-]{36}/);
    // Şablonda iskonto yok: anlaşma oranı tarife ekranından girilir.
    await page.locator('#t-disc').fill('38');
    // Yeni yurt dışı tarifesinde yakıt "değişken" başlar (KARARLAR › Emin olunmayan fark kesin gösterilmez, "Yakıt"). Örnek sözleşmede yakıt sabit %25:
    // seçim yapılmazsa #5290'ın yakıt farkı (%27,5) kabul edilir ve README'nin 4 farkı 3'e düşer.
    const fuelMode = page.locator('#t-fuelvar');
    await expect(fuelMode).toHaveValue('variable');
    await fuelMode.selectOption('fixed');
    await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
    await expect(page.getByText('Tarife kaydedildi')).toBeVisible();
    await page.getByRole('link', { name: /Kuruluma dön/ }).click();
    await expect(page).toHaveURL(/deciship.setup/);
    await expect(page.locator('#ob-step-title')).toContainText('Tarifeler');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();

    // Ölçüm kuralları, hazır koliler, özet
    await expect(page.locator('#ob-step-title')).toContainText('Ölçüm kuralları');
    await page.getByRole('button', { name: /Onayla/ }).click();
    await expect(page.locator('#ob-step-title')).toContainText('Hazır koliler');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();
    await expect(page.locator('#ob-step-title')).toContainText('Özet');
    await page.getByRole('button', { name: 'Kurulumu bitir' }).click();
    await expect(page.getByText('Kurulum tamamlandı')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();

    // Mobil çalışan ölçümleri gönderir: API, Bearer. Fatura karşılaştırması bu kayıtlara bakar.
    expect(await loadMeasurements(owner.email, owner.password)).toBeGreaterThan(50);

    // Gerçek fatura
    await page.goto('/deciship/invoices/upload');
    await page.getByRole('radio', { name: /FedEx/ }).click();
    await page.setInputFiles('[data-testid=invoice-file]', sampleFile(FEDEX_INVOICE.file));
    await page.getByRole('button', { name: 'Devam', exact: true }).click();
    await expect(page.locator('#ino')).toHaveValue(FEDEX_INVOICE.no);
    await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
    await expect(page).toHaveURL(/\/deciship\/invoices\/[^/]+$/);

    // README: 18 satır, 13 uyumlu, 4 fark, 1 eşleşmedi, 611,20 ₺ (+ 1.120,00 ₺ İncele: aynı dosyada tekrarlanan mükerrer)
    const tabs = page.getByRole('tablist').first();
    await expect(tabs).toContainText(/Fark var\s*4/);
    await expect(tabs).toContainText(/Eşleşmedi\s*1/);
    await expect(tabs).toContainText(/Uyumlu\s*13/);
    await expect(tabs).toContainText(/Tümü\s*18/);
    await expect(page.locator('body')).toContainText('611,20');
    await expect(page.locator('body')).toContainText('₺');
  });

  test('EN: kurulum sihirbazı ve gerçek fatura', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Setup Logistics', locale: 'en' });
    // Merkez onayı arayüzden TR testinde; burada Merkez'in çağırdığı uçla.
    await confirmCompany(owner.api);
    const page = await openAs(owner.api, 'en-US');
    await page.goto('/deciship/');
    await expect(page).toHaveURL(/deciship.setup/);
    await expect(page.getByRole('heading', { name: 'Initial setup' })).toBeVisible();
    // Firma adı Merkez'den, salt okunur satırda; sihirbazda alan yok
    await expect(page.getByRole('navigation', { name: 'Setup steps' })).toContainText(/Company details\s*Completed in Hub/);
    // Ülke adı tarayıcının Intl verisinden (EN'de "Türkiye" ya da eski adı).
    await expect(page.locator('.ob-hub-strip')).toContainText(/Setup Logistics · (Türkiye|Turkey) · TRY · Europe\/Istanbul/);
    await expect(page.getByLabel('Company name')).toHaveCount(0);
    await expect(page.locator('#ob-step-title')).toContainText('Carriers');
    await page.locator('label.ob-car', { hasText: 'FedEx' }).click();
    await page.getByRole('button', { name: 'Add and continue' }).click();
    await expect(page.locator('#ob-step-title')).toContainText(/sample/i);

    const { addCarrierAndTariff, uploadInvoice, WebApi } = await import('../lib/api.ts');
    void addCarrierAndTariff;
    void WebApi;
    // Taşıyıcı arayüzden açıldı; tarife API'den, karşılaştırma aynı.
    const carriers = await owner.api.get<{ items: { id: string; code: string }[] }>('/api/deciship/carriers');
    const carrierId = carriers.items[0]!.id;
    const seed = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'seed-tariffs.json'), 'utf8'))[0];
    await owner.api.post('/api/deciship/tariffs', { ...seed.tariffs[0], carrierId });
    await loadMeasurements(owner.email, owner.password);
    const id = await uploadInvoice(owner.api, carrierId);
    await page.goto(`/deciship/invoices/${id}`);
    const tabs = page.getByRole('tablist').first();
    await expect(tabs).toContainText(/Discrepancies\s*4/);
    await expect(tabs).toContainText(/Unmatched\s*1/);
    await expect(tabs).toContainText(/Matched\s*13/);
    await expect(tabs).toContainText(/All\s*18/);
    // TR testiyle aynı: kesin fazla ödeme 611.20, tekrarlanan takip no 1,120.00 "İncele"de ayrı.
    await expect(page.locator('body')).toContainText('611.20');
    await expect(page.locator('body')).toContainText('1,120.00');
  });
});
