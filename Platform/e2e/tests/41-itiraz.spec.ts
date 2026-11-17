import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { ApiFailure, FEDEX_INVOICE, PASSWORD, SAMPLE_PERIOD, WebApi, provisionDeciship, registerOwner, type Owner } from '../lib/api.ts';
import { uniq } from '../lib/sys.ts';

/*
 * İtiraz takibi (Deciship/spec/itiraz.md): denetleyici listeyi hazırlar, muhasebe gönderir ve alacak dekontunu
 * girer; Pano'daki "Geri alınan" ve "İtirazda bekleyen" Merkez Genel Bakış ve Analiz ile kuruşuna kadar aynı.
 *
 * Demo hesapları (muhasebe@demo...) yerine her koşuda yeni firma ve davetle üyeler: demo firması testler arasında
 * paylaşılır, yeniden koşuda mükerrer fatura ve taşıyıcı çakışırdı. Roller aynı (ACCOUNTING, AUDITOR).
 *
 * Seçiciler gerçek arayüze (Deciship platform-gecisi) karşı doğrulandı. Dikkat edilecekler:
 *  - karar verince panel sıradaki satırı kendiliğinden seçer; seçili satıra tıklamak paneli kapatır
 *  - satır paneli açıkken itiraz kartı kısa (compact) görünür: metin ve ipucu yok; kartı panelsiz sayfada okuyun
 *  - ayrıntılar:
 *  - fatura detayı kartı: region "İtiraz durumu"; düğmeler "Gönderildi olarak işaretle", "Sonuç gir"
 *  - kart metni: "İtiraz listesinde 2 satır, talep 554,90 ₺" (talep = fark tutarı varsayımı: DIMENSION 458,50 + WEIGHT 96,40)
 *  - yetkisiz ipucu: "İtirazı muhasebe gönderir ve sonucunu girer."
 *  - gönder iletişim kutusu: #ds-on (varsayılan bugün), kanal düğmesi "E-posta", "Taşıyıcı vaka no (isteğe bağlı)", "Kaydet";
 *    bildirim "İtiraz gönderildi olarak kaydedildi"
 *  - sonuç iletişim kutusu: satır onay kutusu adı takip no, "<takip no> geri alınan tutar", "Alacak dekontu no", "Kaydet";
 *    bildirim "Alacak dekontu kaydedildi"
 *  - Pano: region "Özet göstergeler" içinde dl "İtiraz sonuçları", dt "Geri alınan" / "İtirazda bekleyen"
 *  - Merkez: .hub-ledger-row "Geri alınan" / "İtirazda bekleyen"; etkinlik "itiraz gönderdi", "alacak dekontu girdi"
 */

const PERIOD = SAMPLE_PERIOD.hub;
const DIM = '794812345305'; // ölçü farkı 458,50 ₺
const WEIGHT = '794812345299'; // ağırlık farkı 96,40 ₺

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const money = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '');

/** Üye: e-posta davetini API ile kabul eder (46-urun-degerlendirme ile aynı yol). */
async function addMember(owner: Owner, deciship: string, name: string) {
  const email = `${uniq('uye')}@e2e.sellerondata.test`;
  const inv = await owner.api.post<{ link: string }>('/api/account/org/members/invite', { kind: 'EMAIL', email, name, orgRole: 'MEMBER', productRoles: { deciship } });
  const token = new URL(inv.link).pathname.split('/').pop()!;
  const api = await WebApi.create();
  await api.post(`/api/account/invites/${token}/accept`, { name, password: PASSWORD, client: 'web' });
  await api.me();
  return { api, email, name };
}

/** İstek reddedilmeli: durum kodu döner. */
async function statusOf(call: Promise<unknown>) {
  try {
    await call;
    return 200;
  } catch (e) {
    if (e instanceof ApiFailure) return e.status;
    throw e;
  }
}

async function panoDisputes(page: Page) {
  await page.goto('/deciship/');
  await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  await page.locator('#month').selectOption(SAMPLE_PERIOD.month);
  const lead = page.getByRole('region', { name: 'Özet göstergeler' });
  await expect(lead.locator('.dash-hero-v')).toContainText(/\d/);
  const results = lead.getByLabel('İtiraz sonuçları');
  await expect(results).toBeVisible();
  const value = async (label: string) => norm(await results.locator('div', { has: page.locator('dt', { hasText: label }) }).locator('dd').innerText());
  return { recovered: await value('Geri alınan'), pending: await value('İtirazda bekleyen') };
}

async function hubLedger(page: Page, label: string) {
  return norm(await page.locator('.hub-ledger-row', { hasText: label }).first().locator('.hub-ledger-value').innerText());
}

const card = (page: Page) => page.getByRole('region', { name: 'İtiraz durumu' });

test.describe('İtiraz: denetleyici hazırlar, muhasebe gönderir ve sonucu girer; Pano ve Merkez aynı sayıyı verir', () => {
  test('kısmi geri alma alacak dekontuyla; Geri alınan ve İtirazda bekleyen Pano = Merkez; denetleyici gönderemez', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'İtiraz Lojistik' });
    const { invoiceId } = await provisionDeciship(owner);
    const auditor = await addMember(owner, 'AUDITOR', 'Deniz Denetleyici');
    const accounting = await addMember(owner, 'ACCOUNTING', 'Mert Muhasebe');

    // Denetleyici iki farkı itiraz listesine alır
    const ap = await openAs(auditor.api);
    await ap.goto(`/deciship/invoices/${invoiceId}`);
    await ap.getByRole('tab', { name: /Fark var/ }).click();
    for (const tracking of [DIM, WEIGHT]) {
      // Karar sonrası arayüz sıradaki satırı kendiliğinden seçer; seçili satıra yeniden tıklamak paneli kapatır
      const row = ap.getByRole('row', { name: new RegExp(tracking) });
      if (!/(^| )sel( |$)/.test((await row.getAttribute('class')) ?? '')) await row.click();
      // Kayıt yanıtı beklenir: ilk satırın bildirimi hâlâ ekrandayken ".toast" ikinci kaydı beklemeden geçer ve
      // aşağıdaki sayfa geçişi ikinci PATCH'i yolda keser (ağ geçidi 499; karar kaydedilmez).
      const saved = ap.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/deciship/invoice-lines/'));
      await ap.getByRole('button', { name: 'İtiraz listesine ekle' }).click();
      const resp = await saved;
      expect(resp.status(), `${tracking} kararı kaydedildi`).toBe(200);
      const { line } = (await resp.json()) as { line: { trackingNo: string; decision: string } };
      expect(line, 'itiraz listesine eklenen satır').toMatchObject({ trackingNo: tracking, decision: 'VERIFIED' });
      await expect(ap.locator('.toast', { hasText: 'İtiraz listesine eklendi' }).last()).toBeVisible();
    }
    // ...ama gönderemez: kartta düğme yok, ipucu var; API de reddeder
    // (satır paneli açıkken kart kısa görünür; panelsiz sayfa açılır)
    await ap.goto(`/deciship/invoices/${invoiceId}`);
    await expect(card(ap)).toContainText('İtiraz listesinde 2 satır');
    await expect(card(ap).getByRole('button', { name: 'Gönderildi olarak işaretle' })).toHaveCount(0);
    await expect(card(ap)).toContainText('İtirazı muhasebe gönderir ve sonucunu girer.');
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
    expect(await statusOf(auditor.api.post(`/api/deciship/invoices/${invoiceId}/disputes`, { sentOn: today, channel: 'EMAIL' })), 'denetleyici gönderemez').toBe(403);

    // Muhasebe gönderir
    const page = await openAs(accounting.api);
    await page.goto(`/deciship/invoices/${invoiceId}`);
    const c = card(page);
    await expect(c).toContainText('İtiraz listesinde 2 satır, talep 554,90 ₺');
    await c.getByRole('button', { name: 'Gönderildi olarak işaretle' }).click();
    const send = page.getByRole('dialog');
    await expect(send.locator('#ds-on')).toHaveValue(today);
    await send.getByRole('button', { name: 'E-posta' }).click();
    await send.getByLabel('Taşıyıcı vaka no').fill('FDX-E2E-4410');
    await send.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'İtiraz gönderildi olarak kaydedildi' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(c).toContainText('Mert Muhasebe');
    await expect(c).toContainText('Vaka no FDX-E2E-4410');

    // Denetleyici sonuç da giremez (API)
    const round = (await accounting.api.get<{ invoice: { dispute: { active: { id: string; version: number; lines: { id: string }[] } } } }>(`/api/deciship/invoices/${invoiceId}`)).invoice.dispute.active;
    expect(
      await statusOf(auditor.api.post(`/api/deciship/disputes/${round.id}/results`, { version: round.version, kind: 'RECOVERED', resultOn: today, creditNoteNo: 'X', lines: [{ disputeLineId: round.lines[0]!.id, amount: 1 }] })),
      'denetleyici sonuç giremez',
    ).toBe(403);

    // Kısmi geri alma: ölçü farkı için 300,00 ₺ alacak dekontu, ağırlık farkı sonuç bekler
    await c.getByRole('button', { name: 'Sonuç gir' }).click();
    const res = page.getByRole('dialog');
    await res.getByRole('checkbox', { name: new RegExp(WEIGHT) }).uncheck();
    await res.getByLabel(`${DIM} geri alınan tutar`).fill('300');
    await res.getByLabel('Alacak dekontu no').fill('AD-E2E-0001');
    await expect(res.locator('.dsp-tot')).toHaveText('Eksik kalan 158,50 ₺');
    await res.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.toast', { hasText: 'Alacak dekontu kaydedildi' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(c).toContainText('300,00 ₺');

    // Pano (muhasebe): geri alınan 300,00, itirazda bekleyen 96,40
    const pano = await panoDisputes(page);
    expect(money(pano.recovered)).toBe('300,00₺');
    expect(money(pano.pending)).toBe('96,40₺');

    // Merkez Genel Bakış aynı
    await page.goto(`/home?${PERIOD}`);
    await expect(page.locator('.hub-hero')).toBeVisible();
    expect(money(await hubLedger(page, 'Geri alınan'))).toBe(money(pano.recovered));
    expect(money(await hubLedger(page, 'İtirazda bekleyen'))).toBe(money(pano.pending));
    // Fazla ödeme itirazla değişmez
    expect(money(await page.locator('.hub-hero').innerText())).toBe('611,20₺');
    await expect(page.locator('.hub-ledger-row', { hasText: 'Geri alınan' })).toHaveAttribute('href', '/deciship/disputes');

    // Merkez Analiz aynı (satırlardan toplar, Pano saklı tutardan)
    await page.goto(`/analytics/deciship?${PERIOD}`);
    await expect(page.getByText('Yakalanan fazla ödeme').first()).toBeVisible();
    const body = money(await page.locator('#sod-main').innerText());
    expect(body).toContain('Gerialınan');
    expect(body).toContain(money(pano.recovered));
    expect(body).toContain('İtirazdabekleyen');
    expect(body).toContain(money(pano.pending));

    // Veriler: fatura satırında itiraz durumu ve geri alınan
    await page.goto('/data/deciship/invoices');
    const row = page.locator('tr.hub-row-link', { hasText: FEDEX_INVOICE.no });
    await expect(row).toContainText('İtiraz gönderildi');
    await expect(row).toContainText('300,00');

    // Etkinlik: kim gönderdi, kim dekont girdi
    await page.goto('/activity');
    await expect(page.locator('#sod-main')).toContainText('itiraz gönderdi');
    await expect(page.locator('#sod-main')).toContainText('alacak dekontu girdi');
    await expect(page.locator('#sod-main')).toContainText('Mert Muhasebe');
  });
});
