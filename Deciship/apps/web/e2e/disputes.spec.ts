import { expect, test, type Page } from './base';
import { APP, REAL_STACK, mockSession, type Person } from './helpers';

// İtiraz takibi: gönderme, kısmi geri alma, ret, girişi geri alma, geri çekme, yeniden gönderme; İtirazlar sayfası, roller, para gizleme.
// Mock durumu bellektedir: yaşam döngüsü tek sayfa yüklemesinde, uygulama içi gezinmeyle sınanır.
test.skip(REAL_STACK, 'mock kişileri ve test kancaları gerektirir');

const TODAY = new Date('2026-11-08T10:00:00');

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function open(page: Page, person: Person, path: string, hooks: Record<string, string> = {}, now = TODAY) {
  await page.clock.setFixedTime(now);
  await mockSession(page, person, { sod_mock_disputes: '1', ...hooks });
  await page.goto(`${APP}${path}`);
}

const card = (page: Page) => page.getByRole('region', { name: 'İtiraz durumu' });
const dialog = (page: Page) => page.getByRole('dialog');

test.describe('muhasebe: itirazın yaşam döngüsü', () => {
  test('gönder, kısmi geri alma, ret, girişi geri al, geri çek, yeniden gönder', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, 'accounting', '/invoices/dsp-unsent');
    const c = card(page);
    await expect(c).toContainText('Gönderilmedi');
    await expect(c).toContainText('İtiraz listesinde 3 satır, talep 765,90 ₺');
    await expect(page.locator('.inv-sum-due')).toContainText('2 gün kaldı');

    // gönder: gelecek tarih reddedilir, kanal ve vaka no kaydedilir
    await c.getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    const send = dialog(page);
    await expect(send.getByRole('heading', { name: 'Gönderildi olarak işaretle' })).toBeVisible();
    await expect(send.locator('#ds-on')).toHaveValue('2026-11-08');
    await send.locator('#ds-on').fill('2026-11-09');
    await send.getByRole('button', { name: 'Kaydet' }).click();
    await expect(send).toContainText('Tarih bugünden sonra olamaz.');
    await send.locator('#ds-on').fill('2026-11-07');
    // açıklama alanı yalnız "Diğer"de çıkar ve zorunludur
    await expect(send.getByLabel('Nasıl gönderildi')).toHaveCount(0);
    await send.getByRole('button', { name: 'Diğer' }).click();
    await send.getByRole('button', { name: 'Kaydet' }).click();
    await expect(send).toContainText('Bu alan zorunlu.');
    await send.getByRole('button', { name: 'Taşıyıcı portalı' }).click();
    await expect(send.getByLabel('Nasıl gönderildi')).toHaveCount(0);
    await send.getByLabel('Taşıyıcı vaka no').fill('TR-DSP-9001');
    await send.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'İtiraz gönderildi olarak kaydedildi' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect(c).toContainText('7 Kas 2026 gönderildi · Taşıyıcı portalı · Can Yıldız');
    // TTK bir kez yazılır: özet satırında (kartta yalnız geç gönderimde)
    await expect(c).not.toContainText('TTK süresinde');
    await expect(c).toContainText('Vaka no TR-DSP-9001');
    // tek ana eylem; düzeltmeler menüde
    await expect(c.getByRole('button', { name: 'Gönderildi olarak işaretle' })).toHaveCount(0);
    await expect(c.getByRole('button', { name: 'Geri çek' })).toHaveCount(0);
    await expect(page.locator('.phead')).toContainText('İtiraz gönderildi');
    // sayaç durdu: geri sayım yerine zamanında itiraz edildi
    await expect(page.locator('.inv-sum-due')).toContainText('TTK · zamanında itiraz edildi');
    await expect(page.locator('.inv-sum-due')).not.toContainText('gün kaldı');
    await expect(page.getByRole('button', { name: 'İtiraz metni' })).toHaveClass(/btn-secondary/);

    // paketteki satırlar "İtirazda"
    await expect(page.locator('.lines-dt td.ln-c-dec', { hasText: 'İtirazda' })).toHaveCount(3);

    // kısmi geri alma: tek dekont iki satırı kapsar, biri eksik geldi
    await c.getByRole('button', { name: 'Sonuç gir' }).click();
    const res = dialog(page);
    await res.getByRole('checkbox', { name: /774055128803/ }).uncheck();
    await res.getByLabel('774055128801 geri alınan tutar').fill('500');
    await res.getByLabel('Alacak dekontu no').fill('AD-2026-7001');
    await res.getByRole('button', { name: 'Kaydet' }).click();
    await expect(res).toContainText('Tutar sıfırdan büyük, talepten fazla değil ve en çok iki ondalıklı olmalı.');
    await res.getByLabel('774055128801 geri alınan tutar').fill('400');
    await expect(res.locator('.dsp-tot')).toHaveText('Eksik kalan 58,50 ₺');
    await res.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'Alacak dekontu kaydedildi' })).toBeVisible();
    const sums = c.locator('.dsp-sums');
    await expect(sums).toContainText('Geri alınan612,40 ₺');
    await expect(sums).toContainText('Eksik kalan58,50 ₺');
    await expect(sums).toContainText('Bekleyen95,00 ₺');
    // geçmiş katlı başlar
    await expect(c.locator('.dsp-tl')).toBeHidden();
    await c.getByText('Geçmiş', { exact: true }).click();
    await expect(c.locator('.dsp-tl')).toContainText('Geri alındı · dekont AD-2026-7001 · 612,40 ₺');

    // ret: neden zorunlu
    await c.getByRole('button', { name: 'Sonuç gir' }).click();
    await res.getByRole('button', { name: 'Reddedildi' }).click();
    await res.getByRole('button', { name: 'Kaydet' }).click();
    await expect(res).toContainText('Ret nedenini yazın.');
    await expect(res.getByLabel('Alacak dekontu no')).toHaveCount(0);
    await res.getByLabel('Ret nedeni').fill('Taşıyıcı kendi ölçüsünü esas aldı.');
    await res.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'Ret kaydedildi' })).toBeVisible();
    await expect(c).toContainText('Kapandı');
    await expect(c.getByRole('button', { name: 'Sonuç gir' })).toHaveCount(0);

    const menu = async (item: string) => {
      await c.getByRole('button', { name: 'Diğer' }).click();
      await page.getByRole('menuitem', { name: item }).click();
    };
    // dekont varken geri çekilemez
    await menu('İtirazı geri çek');
    await expect(dialog(page)).toContainText('Bu itirazda alacak dekontu var');
    await expect(dialog(page).getByRole('button', { name: 'Geri çek' })).toBeDisabled();
    await dialog(page).getByRole('button', { name: 'Vazgeç' }).click();

    // yanlış dekont girişi iptal edilir: silinmez, izde kalır ("geri alındı" yalnız para için)
    await menu('Girişi iptal et');
    await dialog(page).getByRole('radio', { name: /AD-2026-7001/ }).check();
    await dialog(page).getByRole('button', { name: 'Girişi iptal et' }).click();
    await expect(dialog(page)).toContainText('Bu alan zorunlu.');
    await dialog(page).getByLabel('Neden').fill('Dekont numarası yanlış girildi.');
    await dialog(page).getByRole('button', { name: 'Girişi iptal et' }).click();
    await expect(page.locator('.toast', { hasText: 'Giriş iptal edildi' })).toBeVisible();
    await expect(c).toContainText('İtiraz gönderildi');
    const tl = c.locator('.dsp-tl');
    await expect(tl.locator('li.undone')).toContainText('Dekont numarası yanlış girildi.');
    await expect(tl.locator('li.voided')).toContainText('AD-2026-7001');
    await expect(tl.locator('li.undone')).toContainText('Giriş iptal edildi: Geri alındı · dekont AD-2026-7001');
    await expect(c.locator('.dsp-sums')).toContainText('Geri alınan0,00 ₺');

    // geri çek: kayıt geçmişte kalır, satırların kilidi açılır
    await menu('İtirazı geri çek');
    await dialog(page).getByLabel('Neden').fill('Yanlış satırlar gönderildi.');
    await dialog(page).getByRole('button', { name: 'Geri çek' }).click();
    await expect(page.locator('.toast', { hasText: 'İtiraz geri çekildi' })).toBeVisible();
    await expect(c).toContainText('Gönderilmedi');
    await expect(tl).toContainText('Tur 1 geri çekildi');
    await expect(tl).toContainText('Yanlış satırlar gönderildi.');
    await expect(page.locator('.lines-dt td.ln-c-dec', { hasText: 'İtiraz listesinde' })).toHaveCount(3);

    // yeniden gönder: önce yeni tur, ardından o turun yerine bir tur daha
    await c.getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(c).toContainText('Tur 2');
    await menu('Yeniden gönder');
    await expect(dialog(page)).toContainText('Bu tur kapanır');
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'Yeni tur kaydedildi' })).toBeVisible();
    await expect(c).toContainText('Tur 3');
    await expect(tl).toContainText('Tur 2 yerine tur 3 gönderildi');

    // İtirazlar sayfasında gönderilmiş olarak görünür
    await page.getByRole('link', { name: 'İtirazlar' }).click();
    await page.getByRole('tab', { name: /Gönderildi/ }).click();
    await expect(page).toHaveURL(/status=SENT/);
    await expect(page.locator('.dsp-list tbody tr', { hasText: '9-490-30112' })).toContainText('8 Kas 2026 gönderildi');
    expect(errors).toEqual([]);
  });

  test('başkası değiştirdiyse (409 STALE) güncel hali yüklenir, yeniden denenir', async ({ page }) => {
    await open(page, 'accounting', '/invoices/dsp-sent');
    const c = card(page);
    await expect(c).toContainText('İtiraz gönderildi');
    await c.getByRole('button', { name: 'Sonuç gir' }).click();
    // aynı anda başka bir sekme ilk satırın sonucunu girer
    const status = await page.evaluate(async () => {
      const inv = await (await fetch('/api/deciship/invoices/dsp-sent')).json();
      const a = inv.invoice.dispute.active;
      const r = await fetch(`/api/deciship/disputes/${a.id}/results`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sod-csrf': '1' },
        body: JSON.stringify({ version: a.version, kind: 'REJECTED', resultOn: '2026-11-08', reason: 'başka sekme', lines: [{ disputeLineId: a.lines[0].id }] }),
      });
      return r.status;
    });
    expect(status).toBe(200);
    await dialog(page).getByLabel('Alacak dekontu no').fill('AD-1');
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(dialog(page)).toContainText('Bu itiraz siz bakarken değişti; güncel hali yüklendi.');
    // yalnız çakışma iletisi: yeniden okunan turdan doğan alan hatası birlikte çıkmaz
    await expect(dialog(page)).not.toContainText('En az bir satır seçin.');
    await dialog(page).getByRole('button', { name: 'Vazgeç' }).click();
    await expect(c.locator('.dsp-lines')).toContainText('Reddedildi');
    // güncel sürümle yeniden: yalnız bekleyen iki satır listelenir
    await c.getByRole('button', { name: 'Sonuç gir' }).click();
    await expect(dialog(page).locator('.dsp-pick-row:not(.head)')).toHaveCount(2);
    await dialog(page).getByLabel('Alacak dekontu no').fill('AD-2');
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'Alacak dekontu kaydedildi' })).toBeVisible();
    await expect(c).toContainText('Kapandı');
  });

  test('gönderimden sonra listeye eklenen satır görünür; ana eylem yeniden göndermedir ve onu da içerir', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    // sahip hem satır kararı verir hem gönderir (muhasebe karar veremez)
    await open(page, 'owner', '/');
    // mock hazır olsun (servis çalışanı)
    await expect(page.getByRole('link', { name: 'İtirazlar' })).toBeVisible();
    // üçüncü satır listeden çıkarılıp paket iki satırla gönderilir; sonra satır listeye geri eklenir
    const sent = await page.evaluate(async () => {
      const h = { 'content-type': 'application/json', 'x-sod-csrf': '1' };
      const patch = (decision: string) => fetch('/api/deciship/invoice-lines/ldsp-unsent-2', { method: 'PATCH', headers: h, body: JSON.stringify({ decision }) });
      await patch('OPEN');
      // gönderme gönderilecek kümenin özetini ister (10-B3): fatura ayrıntısından
      const selectionDigest = (await (await fetch('/api/deciship/invoices/dsp-unsent')).json()).invoice.dispute.selectionDigest;
      const r = await fetch('/api/deciship/invoices/dsp-unsent/disputes', { method: 'POST', headers: h, body: JSON.stringify({ sentOn: '2026-11-07', channel: 'EMAIL', selectionDigest }) });
      const lines = (await r.json()).dispute.active.lines.length;
      await patch('VERIFIED');
      return lines;
    });
    expect(sent).toBe(2);

    // İtirazlar: Gönderilmedi sekmesinde ve süresi yaklaşanlarda; satırda kısa alt satır; "zamanında" denmez
    await page.getByRole('link', { name: 'İtirazlar' }).click();
    const tabs = page.getByRole('tablist', { name: 'İtiraz durumu' });
    await expect(tabs.getByRole('tab', { name: /^Gönderilmedi\s*2$/ })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: /^Tümü\s*7$/ })).toBeVisible();
    await expect(page.locator('.dsp-due')).toContainText('9-490-30112');
    await tabs.getByRole('tab', { name: /Gönderilmedi/ }).click();
    const row = page.locator('.dsp-list tbody tr', { hasText: '9-490-30112' });
    await expect(row).toContainText('Gönderildi');
    await expect(row).toContainText('1 satır gönderilmedi');
    await expect(row).toContainText('2 gün kaldı');
    await expect(row).not.toContainText('zamanında');
    await expect(page.getByRole('region', { name: 'İtiraz toplamları' })).toContainText('Tüm zamanlar');

    // kart: tek kısa satır ve tek ana eylem "Yeniden gönder"
    await row.click();
    const c = card(page);
    await expect(c).toContainText('1 satır listede, henüz gönderilmedi · 95,00 ₺');
    await expect(c.getByRole('button', { name: 'Yeniden gönder' })).toBeVisible();
    await expect(c.getByRole('button', { name: 'Sonuç gir' })).toHaveCount(0);
    await expect(page.locator('.inv-sum-due')).toContainText('2 gün kaldı');
    await c.getByRole('button', { name: 'Yeniden gönder' }).click();
    await expect(dialog(page)).toContainText('3 satır, talep 765,90 ₺');
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'Yeni tur kaydedildi' })).toBeVisible();
    await expect(c).toContainText('Tur 2');
    await expect(c).not.toContainText('henüz gönderilmedi');
    await expect(c.locator('.dsp-lines tbody tr')).toHaveCount(3);
    await expect(c.getByRole('button', { name: 'Sonuç gir' })).toBeVisible();
    await expect(page.locator('.inv-sum-due')).toContainText('TTK · zamanında itiraz edildi');
    expect(errors).toEqual([]);
  });

  test('10-B3: yeniden gönderim de itiraz metninden işaretlenir ve metnin kümesini taşır; arada liste değiştiyse yeni tur açılmaz', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, 'owner', '/');
    await expect(page.getByRole('link', { name: 'İtirazlar' })).toBeVisible();
    const h = { 'content-type': 'application/json', 'x-sod-csrf': '1' };
    // tur 1 iki satırla gönderilir, üçüncü satır sonra listeye eklenir (gönderilmemiş)
    await page.evaluate(async (h) => {
      const patch = (decision: string) => fetch('/api/deciship/invoice-lines/ldsp-unsent-2', { method: 'PATCH', headers: h, body: JSON.stringify({ decision }) });
      await patch('OPEN');
      const selectionDigest = (await (await fetch('/api/deciship/invoices/dsp-unsent')).json()).invoice.dispute.selectionDigest;
      await fetch('/api/deciship/invoices/dsp-unsent/disputes', { method: 'POST', headers: h, body: JSON.stringify({ sentOn: '2026-11-07', channel: 'EMAIL', selectionDigest }) });
      await patch('VERIFIED');
    }, h);
    await page.getByRole('link', { name: 'İtirazlar' }).click();
    await page.locator('.dsp-list tbody tr', { hasText: '9-490-30112' }).click();
    const c = card(page);
    await expect(c).toContainText('1 satır listede, henüz gönderilmedi');

    await page.getByRole('button', { name: 'İtiraz metni' }).click();
    await expect(dialog(page)).toContainText('İtiraz listesinde 3 satır');
    // metin yollandıktan sonra başka bir sekme yeni satırı listeden çıkarır
    expect(await page.evaluate(async (h) => (await fetch('/api/deciship/invoice-lines/ldsp-unsent-2', { method: 'PATCH', headers: h, body: JSON.stringify({ decision: 'OPEN' }) })).status, h)).toBe(200);
    await dialog(page).getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    const send = dialog(page);
    // yeniden gönderme penceresi, metnin kümesiyle (kartın o anki kümesiyle değil)
    await expect(send).toContainText('3 satır, talep 765,90 ₺');
    await send.getByRole('button', { name: 'Kaydet' }).click();
    await expect(send).toContainText('İtiraz listesi bu arada değişti; kayıt yapılmadı.');
    await expect(send.getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    await expect(c).not.toContainText('Tur 2');

    // satır listeye geri döner; metin yeniden alınır ve aynı yoldan yeni tur kaydedilir
    expect(await page.evaluate(async (h) => (await fetch('/api/deciship/invoice-lines/ldsp-unsent-2', { method: 'PATCH', headers: h, body: JSON.stringify({ decision: 'VERIFIED' }) })).status, h)).toBe(200);
    await send.getByRole('button', { name: 'İtiraz metnini yeniden al' }).click();
    await expect(dialog(page)).toContainText('İtiraz listesinde 3 satır');
    await dialog(page).getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    await expect(dialog(page)).toContainText('3 satır, talep 765,90 ₺');
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'Yeni tur kaydedildi' })).toBeVisible();
    await expect(c).toContainText('Tur 2');
    await expect(c.locator('.dsp-lines tbody tr')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('yeniden gönderilen faturada kart toplamı önceki turda geri alınan parayı da sayar; liste ve İtirazlar aynı', async ({ page }) => {
    await open(page, 'owner', '/invoices');
    // USD: tur 1'de 18,40 geri alındı, reddedilen 9,75 tur 2'de bekliyor
    const st = page.locator('.inv-list tbody tr', { hasText: '9-479-40001' }).locator('td[data-label="Durum"]');
    await expect(st).toContainText('İtiraz gönderildi');
    await expect(st).toContainText('Geri alınan 18,40 $');
    // hiç para gelmeden kapanan: reddedilen tutar
    await expect(page.locator('.inv-list tbody tr', { hasText: '9-484-10077' }).locator('td[data-label="Durum"]')).toContainText('Reddedildi 383,40 ₺');
    await page.getByRole('link', { name: 'İtirazlar' }).click();
    const row = page.locator('.dsp-list tbody tr', { hasText: '9-479-40001' });
    await expect(row).toContainText('28,15 $');
    await expect(row).toContainText('18,40 $');
    await row.click();
    const sums = card(page).locator('.dsp-sums');
    await expect(sums).toContainText('Talep28,15 $');
    await expect(sums).toContainText('Geri alınan18,40 $');
    await expect(sums).toContainText('Bekleyen9,75 $');
    await expect(card(page)).toContainText('Tur 2');
  });

  test('sonuç tarihi gönderimden önce olamaz', async ({ page }) => {
    await open(page, 'accounting', '/invoices/dsp-sent');
    const c = card(page);
    await c.getByRole('button', { name: 'Sonuç gir' }).click();
    // tur 30 Eki'de gönderildi
    await expect(dialog(page).locator('#dr-on')).toHaveAttribute('min', '2026-10-30');
    await dialog(page).getByLabel('Alacak dekontu no').fill('AD-1');
    await dialog(page).locator('#dr-on').fill('2026-10-29');
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(dialog(page)).toContainText('Tarih itirazın gönderildiği günden önce olamaz.');
  });

  test('gönderilmiş itirazı olan fatura silinmez; nedeni söylenir', async ({ page }) => {
    await open(page, 'owner', '/invoices');
    const row = page.locator('.inv-list tbody tr', { hasText: '9-488-77120' });
    await row.getByRole('button', { name: '9-488-77120 için diğer işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Sil' }).click();
    await dialog(page).getByRole('button', { name: 'Sil' }).click();
    await expect(page.locator('.toast', { hasText: 'önce itirazı geri çekin' })).toBeVisible();
    await expect(row).toBeVisible();
  });
});

test.describe('İtirazlar sayfası', () => {
  test('sahip: para birimi başına toplamlar, süresi yaklaşanlar, durum ve arama süzgeci', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, 'owner', '/');
    await page.getByRole('link', { name: 'İtirazlar' }).click();
    await expect(page.getByRole('heading', { name: 'İtirazlar', level: 1 })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'İtiraz durumu' });
    await expect(tabs.getByRole('tab').first()).toHaveText(/^Tümü/);
    await expect(tabs.getByRole('tab', { name: /^Gönderilmedi\s*2$/ })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: /^Gönderildi\s*3$/ })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: /^Kapandı\s*2$/ })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: /^Tümü\s*7$/ })).toHaveAttribute('aria-selected', 'true');

    const sum = page.getByRole('region', { name: 'İtiraz toplamları' });
    const tryRow = sum.locator('.dsp-sum-row', { hasText: 'TRY' });
    await expect(tryRow).toContainText('İtiraz edilen2.157,60 ₺');
    await expect(tryRow).toContainText('Bekleyen604,55 ₺');
    await expect(tryRow).toContainText('Geri alınan1.111,15 ₺');
    await expect(tryRow).toContainText('58,50 ₺ eksik geldi');
    await expect(tryRow).toContainText('Reddedilen383,40 ₺');
    await expect(tryRow).toContainText('1.027,00 ₺ henüz gönderilmedi');
    await expect(tryRow.locator('.dsp-k')).toHaveCount(4);
    // para birimleri toplanmaz
    await expect(sum.locator('.dsp-sum-row', { hasText: 'USD' })).toContainText('Geri alınan18,40 $');

    const due = page.locator('.dsp-due');
    await expect(due.locator('li').first()).toContainText('AR-2026-0457');
    await expect(due.locator('li').first()).toContainText('1 gün kaldı');
    await expect(due.locator('li').nth(1)).toContainText('2 gün kaldı');
    // yalnız fatura no araması; taşıyıcı süzgeci yok
    await expect(page.getByLabel('Taşıyıcı', { exact: true })).toHaveCount(0);

    const rows = page.locator('.dsp-list tbody tr');
    await expect(rows).toHaveCount(7);
    await expect(rows.filter({ hasText: '9-484-10077' })).toContainText('süre geçtikten sonra');
    await expect(rows.filter({ hasText: '9-486-55031' })).toContainText('58,50 ₺ eksik');

    await tabs.getByRole('tab', { name: /Kapandı/ }).click();
    await expect(page).toHaveURL(/status=CLOSED/);
    await expect(rows).toHaveCount(2);
    await page.getByLabel('Fatura no').fill('90215');
    await expect(page).toHaveURL(/q=90215/);
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Fatura no').fill('yok-boyle');
    await expect(page.getByRole('heading', { name: 'Bu fatura no ile itiraz yok' })).toBeVisible();
    await page.getByRole('button', { name: 'Aramayı temizle' }).click();
    await expect(rows).toHaveCount(2);
    await tabs.getByRole('tab', { name: /Tümü/ }).click();
    await page.getByLabel('Fatura no').fill('AR-2026');
    await expect(rows).toHaveCount(1);

    // satır faturaya götürür
    await rows.first().click();
    await expect(page).toHaveURL(/\/invoices\/dsp-unsent2$/);
    await expect(card(page)).toContainText('Gönderilmedi');
    expect(errors).toEqual([]);
  });

  test('hiç itiraz yoksa ne yapılacağı söylenir', async ({ page }) => {
    await page.clock.setFixedTime(TODAY);
    await mockSession(page, 'owner');
    await page.goto(`${APP}/disputes`);
    await expect(page.getByRole('heading', { name: 'Henüz itiraz yok' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Faturalara git' })).toBeVisible();
    await expect(page.locator('.dsp-sum')).toHaveCount(0);
  });

  test('süre durumları sabit saatle: bugün son gün, süresi doldu, taşıyıcı süresi yaklaşıyor', async ({ page }) => {
    // i1 faturası 27.10.2026: TTK son günü 04.11, FedEx son günü 26.11
    const addI1 = async (now: Date) => {
      await page.clock.setFixedTime(now);
      await mockSession(page, 'owner');
      await page.goto(`${APP}/invoices/i1`);
      await page.locator('.lines-dt tbody tr.clickable').first().click();
      await page.getByRole('button', { name: 'İtiraz listesine ekle' }).click();
      await expect(page.locator('.toast', { hasText: 'İtiraz listesine eklendi' })).toBeVisible();
      await page.getByRole('link', { name: 'İtirazlar' }).click();
      return page.locator('.dsp-list tbody tr', { hasText: '9-482-11735' });
    };

    let row = await addI1(new Date('2026-11-04T10:00:00'));
    await expect(row.locator('.dsp-dl', { hasText: 'TTK' })).toContainText('bugün son gün');
    await expect(row.locator('.dsp-dl', { hasText: 'TTK' })).toHaveAttribute('data-state', 'today');
    await expect(page.locator('.dsp-due')).toContainText('bugün son gün');

    row = await addI1(new Date('2026-11-24T10:00:00'));
    // TTK doldu: açık olan taşıyıcı süresi gösterilir
    await expect(row.locator('.dsp-dl')).toHaveCount(1);
    await expect(row.locator('.dsp-dl', { hasText: 'FedEx' })).toContainText('2 gün kaldı');
    await expect(page.locator('.dsp-due li', { hasText: '9-482-11735' })).toContainText('2 gün kaldı');

    row = await addI1(new Date('2026-12-01T10:00:00'));
    await expect(row.locator('.dsp-dl', { hasText: 'FedEx' })).toContainText('süresi doldu');
    await expect(row.locator('.dsp-dl', { hasText: 'FedEx' })).toHaveAttribute('data-state', 'expired');
  });

  test('EN 390 px: yatay taşma yok, satırlar kart', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'owner', '/disputes', { sod_mock_locale: 'en' });
    await expect(page.getByRole('heading', { name: 'Disputes', level: 1 })).toBeVisible();
    await expect(page.locator('.dsp-list tbody tr')).toHaveCount(7);
    await expect(page.locator('.dsp-list thead')).toBeHidden();
    await expect(page.getByRole('region', { name: 'Dispute totals' })).toContainText('Recovered');
    await expect(page.locator('.dsp-list tbody tr').first()).toContainText('1 day left');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('.dsp-list tbody tr, .dsp-sum, .dsp-due')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).length,
    );
    expect(wide).toBe(0);
    // fatura detayındaki kart da taşmaz
    await page.locator('.dsp-list tbody tr', { hasText: '9-486-55031' }).click();
    await expect(page.getByRole('region', { name: 'Dispute status' })).toContainText('Recovered');
    const detailOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(detailOverflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});

test.describe('roller ve para', () => {
  test('denetleyici durumu salt okur, gönderimin muhasebede olduğunu okur; sunucu da reddeder', async ({ page }) => {
    await open(page, 'auditor', '/invoices/dsp-partial');
    const c = card(page);
    await expect(c).toContainText('İtiraz gönderildi');
    await expect(c).toContainText('İtirazı muhasebe gönderir ve sonucunu girer.');
    for (const name of ['Sonuç gir', 'Diğer', 'Gönderildi olarak işaretle']) await expect(c.getByRole('button', { name })).toHaveCount(0);
    await c.getByText('Geçmiş', { exact: true }).click();
    await expect(c.locator('.dsp-tl')).toContainText('AD-2026-1183');
    // satır kararı da kilitli
    await page.locator('.lines-dt tbody tr.clickable').first().click();
    await expect(page.locator('.panel')).toContainText('Bu satır gönderilmiş itirazda');
    await expect(page.locator('.panel').getByRole('button', { name: 'Kararı geri al' })).toHaveCount(0);
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/deciship/invoices/dsp-unsent/disputes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sod-csrf': '1' },
        body: JSON.stringify({ sentOn: '2026-11-08', channel: 'EMAIL' }),
      });
      return r.status;
    });
    expect(status).toBe(403);
    // gönderilmemiş faturada "Gönderildi olarak işaretle" yok, metin modalında da yok
    await page.getByRole('button', { name: 'Paneli kapat' }).click();
    await page.getByRole('link', { name: 'İtirazlar' }).click();
    await page.locator('.dsp-list tbody tr', { hasText: '9-490-30112' }).click();
    await expect(card(page).getByRole('button', { name: 'Gönderildi olarak işaretle' })).toHaveCount(0);
    await page.getByRole('button', { name: 'İtiraz metni' }).click();
    await expect(dialog(page).getByRole('button', { name: 'Kopyala' })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Gönderildi olarak işaretle' })).toHaveCount(0);
  });

  test('muhasebe metin penceresinden gönderildi olarak işaretler', async ({ page }) => {
    await open(page, 'accounting', '/invoices/dsp-unsent');
    await page.getByRole('button', { name: 'İtiraz metni' }).click();
    await dialog(page).getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Gönderildi olarak işaretle' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(card(page)).toContainText('İtiraz gönderildi');
  });

  test('10-B3: metin alındıktan sonra liste değiştiyse işaretleme durur; metni yeniden alıp güncel kümeyle kaydedilir', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, 'owner', '/invoices/dsp-unsent');
    await page.getByRole('button', { name: 'İtiraz metni' }).click();
    await expect(dialog(page)).toContainText('İtiraz listesinde 3 satır');
    // metin kopyalanıp yollandıktan sonra başka bir sekme bir satırı listeden çıkarır
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/deciship/invoice-lines/ldsp-unsent-2', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sod-csrf': '1' }, body: JSON.stringify({ decision: 'OPEN' }) });
      return r.status;
    });
    expect(status).toBe(200);
    await dialog(page).getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    const send = dialog(page);
    // pencere metnin kümesini gösterir (yollanan metin), tıklama anındaki listeyi değil
    await expect(send).toContainText('3 satır, talep 765,90 ₺');
    await send.getByRole('button', { name: 'Kaydet' }).click();
    await expect(send).toContainText('İtiraz listesi bu arada değişti; kayıt yapılmadı.');
    await expect(send.getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    await expect(card(page)).toContainText('Gönderilmedi');
    await send.getByRole('button', { name: 'İtiraz metnini yeniden al' }).click();
    await expect(dialog(page)).toContainText('İtiraz listesinde 2 satır');
    await dialog(page).getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    await expect(dialog(page)).toContainText('2 satır');
    await dialog(page).getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'İtiraz gönderildi olarak kaydedildi' })).toBeVisible();
    await expect(card(page).locator('.dsp-lines tbody tr')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('10-B13: panel gördüğü kararı gönderir; bu arada başkası karar verdiyse yazılmaz, güncel hali yüklenir', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, 'owner', '/invoices/i1');
    await page.locator('.lines-dt tbody tr.clickable').first().click();
    await expect(page).toHaveURL(/line=/);
    const lineId = new URL(page.url()).searchParams.get('line')!;
    // ekranı yenilememiş kişi bakarken başka bir sekme satırı uyumlu sayar
    const status = await page.evaluate(async (id) => {
      const r = await fetch(`/api/deciship/invoice-lines/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sod-csrf': '1' }, body: JSON.stringify({ decision: 'ACCEPTED', reason: 'başka sekme', expectedDecision: 'OPEN' }) });
      return r.status;
    }, lineId);
    expect(status).toBe(200);
    await page.getByRole('button', { name: 'İtiraz listesine ekle' }).click();
    await expect(page.locator('.toast', { hasText: 'Bu satırın kararı siz bakarken değişti' })).toBeVisible();
    const decision = await page.evaluate(async () => {
      const r = await (await fetch('/api/deciship/invoices/i1/lines?pageSize=200')).json();
      return r.items as { id: string; decision: string }[];
    });
    expect(decision.find((l) => l.id === lineId)?.decision).toBe('ACCEPTED');
  });

  test('fiyat izni yoksa tutarlar çizilmez, NaN ya da boş para sütunu yok', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, 'accounting', '/disputes', { sod_mock_strip_perm: 'deciship.prices.view' });
    await expect(page.locator('.dsp-list tbody tr')).toHaveCount(7);
    await expect(page.locator('.dsp-sum')).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Talep' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Geri alınan' })).toHaveCount(0);
    const text = await page.locator('.content').innerText();
    expect(text).not.toMatch(/NaN|₺|\$|undefined/);
    await page.locator('.dsp-list tbody tr', { hasText: '9-486-55031' }).click();
    const c = card(page);
    await expect(c).toContainText('İtiraz gönderildi');
    await expect(c.locator('.dsp-sums')).toHaveCount(0);
    expect(await c.innerText()).not.toMatch(/NaN|₺|undefined/);
    // muhasebe yine sonuç girer; tutar alanı boş başlar
    await c.getByRole('button', { name: 'Sonuç gir' }).click();
    await expect(dialog(page).getByLabel(/geri alınan tutar/)).toHaveValue('');
    expect(errors).toEqual([]);
  });

  test('faturalar listesinde durum, Panoda geri alınan ve itirazda bekleyen', async ({ page }) => {
    await open(page, 'owner', '/invoices');
    const row = (no: string) => page.locator('.inv-list tbody tr', { hasText: no });
    await expect(row('9-482-11735').locator('td[data-label="Durum"]')).toHaveText('İşlendi');
    await expect(row('9-488-77120').locator('td[data-label="Durum"]')).toHaveText('İtiraz gönderildi');
    await expect(row('9-480-90215').locator('td[data-label="Durum"]')).toContainText('Kapandı');
    await expect(row('9-480-90215').locator('td[data-label="Durum"]')).toContainText('Geri alınan 498,75 ₺');
    await page.getByRole('link', { name: 'Pano' }).click();
    const disp = page.locator('.dash-disp');
    await expect(disp).toContainText('Geri alınan1.111,15 ₺');
    await expect(disp).toContainText('İtirazda bekleyen604,55 ₺');
    await expect(page.locator('.dash-cur li', { hasText: 'USD' })).toContainText('geri alınan 18,40 $');
  });
});

test.describe('tablo genişlikleri', () => {
  for (const lang of ['tr', 'en'] as const) {
    for (const width of [768, 1024, 1279, 1440]) {
      test(`${lang} ${width} px: İtirazlar ve fatura listesi kaymaz`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page, 'owner', '/disputes', { sod_mock_locale: lang });
        await expect(page.locator('.dsp-list tbody tr')).toHaveCount(7);
        const over = () =>
          page.evaluate(() =>
            [...document.querySelectorAll('.table-wrap, .tbl-wrap, .dsp-sum')].map((e) => ({ c: e.className, over: e.scrollWidth - e.clientWidth })).filter((x) => x.over > 0),
          );
        expect(await over()).toEqual([]);
        await page.locator('.dsp-list tbody tr').filter({ hasText: '9-486-55031' }).click();
        await expect(page.getByRole('region', { name: lang === 'tr' ? 'İtiraz durumu' : 'Dispute status' })).toBeVisible();
        expect(await over()).toEqual([]);
      });
    }
  }
});
