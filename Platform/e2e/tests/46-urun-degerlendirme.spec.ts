import { spawnSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, rawKeys } from '../lib/fixtures.ts';
import { MobileApi, PASSWORD, SAMPLE_PERIOD, WebApi, addCarrierAndTariff, confirmCompany, loadMeasurements, provisionDeciship, registerOwner, uploadInvoice, type Owner } from '../lib/api.ts';
import { APP, uniq, uniqPhone } from '../lib/sys.ts';
import { openLanguage } from '../lib/shell.ts';

/** Üye: e-posta davetini API ile kabul eder. */
async function addMember(owner: Owner, deciship: string | null, name = 'Deniz Üye') {
  const email = `${uniq('uye')}@e2e.sellerondata.test`;
  const inv = await owner.api.post<{ link: string }>('/api/account/org/members/invite', { kind: 'EMAIL', email, name, orgRole: 'MEMBER', productRoles: { deciship } });
  const token = new URL(inv.link).pathname.split('/').pop()!;
  const api = await WebApi.create();
  await api.post(`/api/account/invites/${token}/accept`, { name, password: PASSWORD, client: 'web' });
  const me = await api.me();
  return { api, email, name, membershipId: me.activeOrg!.membershipId };
}

const setRole = (owner: Owner, id: string, role: string | null) => owner.api.patch(`/api/account/org/members/${id}`, { productRoles: { deciship: role } });

function countApi(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
}

/** PDF metni: API imajındaki pdfjs ile, dosya stdin'den. */
function pdfText(buffer: Buffer) {
  const code = `import('pdfjs-dist/legacy/build/pdf.mjs').then(async (p)=>{const d=await p.getDocument({data:new Uint8Array(require('fs').readFileSync(0)),useSystemFonts:true,disableFontFace:true,verbosity:0}).promise;const out=[];for(let i=1;i<=d.numPages;i++){const c=await (await d.getPage(i)).getTextContent();out.push(c.items.map((x)=>x.str).join(' '))}console.log(out.join(' '))})`;
  const r = spawnSync('docker', ['exec', '-i', 'sod-e2e-deciship-api-1', 'node', '-e', code], { input: buffer, encoding: 'utf8', maxBuffer: 20_000_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.replace(/\s+/g, ' ');
}

test.describe('Ürün değerlendirmesi düzeltmeleri', () => {
  test('erişim kapatılan sekmede istek döngüsü yok; rol geri verilince yeniden giriş olmadan açılır', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Döngü Lojistik' });
    await provisionDeciship(owner);
    const member = await addMember(owner, 'AUDITOR');
    const page = await openAs(member.api);
    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
    const requests = countApi(page);

    const bearer = await MobileApi.login(member.email, PASSWORD);
    await setRole(owner, member.membershipId, null);
    // Olay DeciShip'e ulaşana kadar eski jeton geçerlidir (sözleşme): teslimi bekle.
    await expect.poll(async () => (await bearer.get('/api/deciship/me')).status, { timeout: 15_000, intervals: [50] }).not.toBe(200);
    await bearer.dispose();
    // Açık sekme bir sonraki istekte öğrenir: menüden gezinti
    await page.getByRole('link', { name: 'Tarifeler' }).click();
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('mobil uygulamada');

    // Yerleştikten sonra 3 sn: en çok 5 istek
    await page.waitForTimeout(500);
    requests.length = 0;
    await page.waitForTimeout(3000);
    expect(requests.length, `3 sn'deki istekler: ${requests.join(', ')}`).toBeLessThanOrEqual(5);
    await expect(page).not.toHaveURL(/login/);

    // Rol geri: yeniden giriş yok
    await setRole(owner, member.membershipId, 'AUDITOR');
    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'DeciShip erişiminiz yok' })).toHaveCount(0);
  });

  test('başka firmanın fatura adresi: "Bu kayıt bu firmada yok", bozuk kimlik de aynı; o firmaya geçince açılır', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Kayıt Alfa' });
    const { invoiceId } = await provisionDeciship(owner);
    const alfa = owner.me.activeOrg!.id;
    await owner.api.post('/api/account/orgs', { name: 'Kayıt Beta', country: 'TR' });
    const page = await openAs(owner.api);
    await page.goto(`/deciship/invoices/${invoiceId}`);
    await expect(page.getByText('Bu kayıt bu firmada yok')).toBeVisible();
    await expect(page.getByText('Başka firmanızda olabilir, geçip bakın:')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('9-482-11735');

    await page.goto('/deciship/invoices/bozuk-kimlik');
    await expect(page.getByText('Bu kayıt bu firmada yok')).toBeVisible();

    await page.goto(`/deciship/invoices/${invoiceId}`);
    await page.getByRole('button', { name: 'Kayıt Alfa' }).click();
    await expect(page.locator('.ptitle .mono')).toHaveText('9-482-11735');
    expect((await (await page.request.get('/api/account/me')).json()).activeOrg.id).toBe(alfa);
  });

  test('Başlangıç: sıradaki adım ölçüm kurallarında sihirbaza, first-measurement ölçümlere, first-invoice fatura yüklemeye gider; iş bitince tamamlanır', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Adım Lojistik' });
    // Merkez kurulumu API ile (arayüz akışı 10-site-kayit ve 30-kurulum-fatura'da); DeciShip adımları onaydan sonra açılır.
    await confirmCompany(owner.api);
    const page = await openAs(owner.api);
    const steps = async () => {
      // Kurulum adımları döneme bağlı değil (firmada kayıt var mı); dönem örnek faturanınki.
      const q = SAMPLE_PERIOD.query;
      const ov = await owner.api.get<{ setup: { steps: { id: string; label: string; done: boolean; required: boolean; href: string }[] } }>(`/api/deciship/platform/overview?${q}`);
      return ov.setup.steps;
    };
    const first = await steps();
    const fm = first.find((s) => s.id === 'first-measurement')!;
    const fi = first.find((s) => s.id === 'first-invoice')!;
    expect(fm.required && !fm.done).toBe(true);
    expect(fi.required && !fi.done).toBe(true);

    // Başlangıç sayfası aracın sıradaki zorunlu adımına götürür ("n/m adım · Sıradaki: …").
    const row = page.getByRole('region', { name: 'Araç kurulumları' }).locator('li', { hasText: 'DeciShip' });
    const openNext = async (label: string) => {
      await page.goto('/home');
      await expect(row).toContainText(`Sıradaki: ${label}`);
      await row.getByRole('link', { name: 'Kuruluma devam et' }).click();
    };

    // Taşıyıcı ve tarife API'den; sıradaki ölçüm kuralları, sihirbazda onaylanır
    const { carrierId } = await addCarrierAndTariff(owner.api);
    const rules = (await steps()).find((s) => s.id === 'measure-rules')!;
    expect(rules.required && !rules.done).toBe(true);
    await openNext(rules.label);
    await expect(page).toHaveURL(`${APP}${rules.href}`);
    await expect(page.locator('#ob-step-title')).toContainText('Ölçüm kuralları');
    await page.getByRole('button', { name: /Onayla/ }).click();
    await expect(page.locator('#ob-step-title')).not.toContainText('Ölçüm kuralları');
    expect((await steps()).find((s) => s.id === 'measure-rules')!.done).toBe(true);

    // Sıradaki ilk ölçüm: ölçümler sayfası
    await openNext(fm.label);
    await expect(page).toHaveURL(`${APP}/deciship/measurements`);
    await expect(page.getByRole('heading', { name: 'Ölçümler', level: 1 })).toBeVisible();

    // Gerçek iş: ölçümler; sıradaki ilk fatura: fatura yükleme
    await loadMeasurements(owner.email, owner.password);
    expect((await steps()).find((s) => s.id === 'first-measurement')!.done).toBe(true);
    expect((await steps()).find((s) => s.id === 'first-invoice')!.done).toBe(false);
    await openNext(fi.label);
    await expect(page).toHaveURL(`${APP}/deciship/invoices/upload`);
    await expect(page.locator('[data-testid=invoice-file]')).toBeAttached();
    await uploadInvoice(owner.api, carrierId);
    expect((await steps()).find((s) => s.id === 'first-invoice')!.done).toBe(true);

    const end = await steps();
    expect(end.filter((s) => s.required && !s.done).map((s) => s.id)).toEqual([]);
    await page.goto(`/home?${SAMPLE_PERIOD.hub}`);
    await expect(page.locator('.hub-hero')).toContainText('611,20');
    await expect(page.locator('.hub-start-count')).toHaveCount(0);
  });

  test('PDF rapor: Karar sütunu var, parçalar toplamı tutar', async () => {
    const owner = await registerOwner({ orgName: 'Rapor Lojistik' });
    const { invoiceId } = await provisionDeciship(owner);
    const lines = await owner.api.get<{ items: { id: string; trackingNo: string; diffAmount: number }[] }>(`/api/deciship/invoices/${invoiceId}/lines?status=DIFF`);
    const by = (tail: string) => lines.items.find((l) => l.trackingNo.endsWith(tail))!;
    await owner.api.patch(`/api/deciship/invoice-lines/${by('5305').id}`, { decision: 'VERIFIED' });
    await owner.api.patch(`/api/deciship/invoice-lines/${by('5299').id}`, { decision: 'ACCEPTED', reason: 'Ağırlık farkını kabul ettik' });

    const res = await owner.api.raw().get(`/api/deciship/invoices/${invoiceId}/report.pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
    const text = pdfText(await res.body());

    for (const word of ['Karar', 'İtiraz listesinde', 'Uyumlu sayıldı', 'Karar bekliyor', 'Fark sütunu toplamı', 'Uyumlu sayılan fark', 'İncelenecek fark', 'Fazla ödeme']) expect(text, word).toContain(word);
    const amount = (label: string) => {
      const m = new RegExp(`${label}\\s*:?\\s*([\\d.]+,\\d{2})`).exec(text);
      if (!m) throw new Error(`${label} yok: ${text.slice(0, 600)}`);
      return Number(m[1]!.replaceAll('.', '').replace(',', '.'));
    };
    const toCents = (n: number) => Math.round(n * 100);
    // Fazla ödeme 611,20 − kabul edilen 96,40; #5288'in aynı dosyadaki mükerreri (1.120,00) "İncele" (KALANLAR 1.8)
    const overcharge = 611.2 - 96.4;
    expect(toCents(amount('Uyumlu sayılan fark'))).toBe(toCents(96.4));
    expect(toCents(amount('İncelenecek fark'))).toBe(toCents(1120));
    expect(toCents(amount('Fark sütunu toplamı'))).toBe(toCents(1731.2));
    // Parçalar = toplam; satırlar da aynı toplamı verir
    expect(toCents(overcharge) + toCents(amount('İncelenecek fark')) + toCents(amount('Uyumlu sayılan fark'))).toBe(toCents(amount('Fark sütunu toplamı')));
    expect(lines.items.reduce((a, l) => a + toCents(l.diffAmount), 0)).toBe(toCents(amount('Fark sütunu toplamı')));
    expect(text).toContain('514,80');
    // Merkez ve fatura özeti aynı sayıyı söyler
    const inv = await owner.api.get<{ invoice: { totals: { overchargeTotal: number; verifiedTotal: number } } }>(`/api/deciship/invoices/${invoiceId}`);
    expect(toCents(inv.invoice.totals.overchargeTotal)).toBe(toCents(overcharge));
    expect(toCents(inv.invoice.totals.verifiedTotal)).toBe(toCents(458.5));
  });

  test('posta kapalı: Şifremi unuttum form göstermez, yöneticiye yönlendirir (TR+EN), davet bağlantıyla çalışır', async ({ freshPage }) => {
    const anon = await WebApi.create();
    const catalog = await anon.get<{ mailEnabled: boolean }>('/api/account/catalog');
    expect(catalog.mailEnabled).toBe(false);
    await anon.dispose();
    const owner = await registerOwner({ orgName: 'Posta Lojistik' });
    expect(((await owner.api.get('/api/account/me')) as { account: { mailEnabled: boolean } }).account.mailEnabled).toBe(false);

    const page = await freshPage();
    await page.goto('/forgot-password');
    await expect(page.getByText('E-posta gönderimi kapalı. Telefonla giriş yapıyorsanız firma yöneticiniz yeni kod üretebilir. Diğer durumlarda bu kurulumu yöneten kişiye başvurun.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bağlantı gönder' })).toHaveCount(0);

    const en = await freshPage('en-US');
    await en.goto('/forgot-password');
    await expect(en.locator('html')).toHaveAttribute('lang', 'en');
    await expect(en.getByRole('heading', { level: 1 })).not.toContainText(/Şifre/);
    await expect(en.locator('.notif').first()).toBeVisible();
    expect(await rawKeys(en)).toEqual([]);
  });

  test('yeni firma saatte 10 e-posta + 10 telefon daveti; reddedilenler hak yemez; aşınca anlaşılır 429', async () => {
    const owner = await registerOwner({ orgName: 'Davet Lojistik' });
    const ctx = owner.api.raw();
    const h = { 'X-SOD-Org': owner.api.orgId! };
    const send = (data: Record<string, unknown>) => ctx.post('/api/account/org/members/invite', { headers: h, data });
    const email = (i: number) => ({ kind: 'EMAIL', email: `${uniq(`d${i}`)}@e2e.sellerondata.test`, name: `Kişi ${i}`, orgRole: 'MEMBER', productRoles: { deciship: 'ACCOUNTING' } });

    // Reddedilenler: geçersiz girdi ve zaten üye
    for (let i = 0; i < 12; i++) {
      const bad = await send({ ...email(i), email: 'gecersiz' });
      expect(bad.status(), `geçersiz ${i}`).toBe(400);
    }
    const already = await send({ ...email(0), email: owner.email });
    expect(already.status()).toBe(409);

    // Hak yememiş: 10 geçerli davet açılır
    for (let i = 0; i < 10; i++) {
      const ok = await send(email(i));
      expect(ok.status(), `davet ${i}: ${await ok.text()}`).toBeLessThan(300);
    }
    const over = await send(email(10));
    expect(over.status()).toBe(429);
    const body = (await over.json()) as { error: { code: string; message: string } };
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(Number(over.headers()['retry-after'])).toBeGreaterThan(0);

    // Telefon kovası ayrı
    const phone = await send({ kind: 'PHONE_CODE', phone: uniqPhone(), name: 'Telefon Kişi', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } });
    expect(phone.status(), await phone.text()).toBeLessThan(300);
  });

  test('Etkinlik: ham anahtar yok, değişim okunur (TR+EN)', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Etkinlik Lojistik' });
    const { invoiceId } = await provisionDeciship(owner);
    const member = await addMember(owner, 'AUDITOR', 'Etkin Kişi');
    await setRole(owner, member.membershipId, 'ACCOUNTING');
    await owner.api.patch('/api/account/org', { name: 'Etkinlik Lojistik 2' });
    await owner.api.post('/api/account/org/members/invite', { kind: 'PHONE_CODE', phone: uniqPhone(), name: 'Bekleyen Kişi', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } });
    const lines = await owner.api.get<{ items: { id: string }[] }>(`/api/deciship/invoices/${invoiceId}/lines?status=DIFF`);
    await owner.api.patch(`/api/deciship/invoice-lines/${lines.items[0]!.id}`, { decision: 'VERIFIED' });

    const page = await openAs(owner.api);
    const rawAction = /\b(?:member|invitation|org|carrier|tariff|invoice|invoices|line|measurement|settings|data|session|person)\.[a-z_]+(?:\.[a-z_]+)*\b/;
    for (const lang of ['tr', 'en'] as const) {
      await page.goto('/activity');
      if (lang === 'en') {
        const lang = await openLanguage(page);
        const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/account/me'));
        await lang.getByRole('menuitemradio', { name: 'English' }).click();
        await saved;
      }
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await expect(page.locator('#sod-main li, #sod-main tr').first()).toBeVisible();
      const text = await page.locator('#sod-main').innerText();
      const offenders = text.split('\n').filter((l) => rawAction.test(l) && !/@/.test(l));
      expect(offenders, `${lang} ham eylem`).toEqual([]);
      expect(await rawKeys(page), `${lang} ham anahtar`).toEqual([]);
      expect(text, 'rol değişimi okunur').toMatch(lang === 'tr' ? /Etkin Kişi/ : /Etkin Kişi/);
    }
  });

  test('askıdaki üye ekranı: açıklama görünür, araçlar açılmaz; askı kalkınca kaldığı yerden', async ({ openAs, freshPage }) => {
    const owner = await registerOwner({ orgName: 'Askı Lojistik' });
    await provisionDeciship(owner);
    const member = await addMember(owner, 'AUDITOR', 'Aslı Üye');
    const page = await openAs(member.api);
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();

    await owner.api.patch(`/api/account/org/members/${member.membershipId}`, { status: 'SUSPENDED' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Bu firmadaki üyeliğiniz askıda' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Yöneticinize başvurun. Askı kalkınca kaldığınız yerden devam edersiniz.')).toBeVisible();
    await expect(page.getByText('Askı Lojistik').first()).toBeVisible();
    await page.goto('/deciship/invoices');
    await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toHaveCount(0);

    // Yeni tarayıcıdan giriş de aynı ekrana düşer
    const fresh = await freshPage();
    await fresh.goto('/login');
    await fresh.getByLabel('E-posta veya telefon').fill(member.email);
    await fresh.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await fresh.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(fresh.getByRole('heading', { name: 'Bu firmadaki üyeliğiniz askıda' })).toBeVisible({ timeout: 20_000 });

    // Askıdan önce açık oturum, askı kalkınca kaldığı yerden
    await owner.api.patch(`/api/account/org/members/${member.membershipId}`, { status: 'ACTIVE' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible({ timeout: 20_000 });
  });

  test('askıdayken giriş yapan kişi, askı kalkınca yeniden girmeden firmasına döner', async ({ freshPage }) => {
    const owner = await registerOwner({ orgName: 'Askı Dönüş' });
    const member = await addMember(owner, 'AUDITOR', 'Dönen Üye');
    await owner.api.patch(`/api/account/org/members/${member.membershipId}`, { status: 'SUSPENDED' });
    const fresh = await freshPage();
    await fresh.goto('/login');
    await fresh.getByLabel('E-posta veya telefon').fill(member.email);
    await fresh.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await fresh.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(fresh.getByRole('heading', { name: 'Bu firmadaki üyeliğiniz askıda' })).toBeVisible({ timeout: 20_000 });
    await owner.api.patch(`/api/account/org/members/${member.membershipId}`, { status: 'ACTIVE' });
    await fresh.goto('/home');
    await expect(fresh.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(fresh.getByRole('heading', { name: 'Firma oluşturun' })).toHaveCount(0);
  });

  test('askı ekranında açık kalan sekme, askı kalkınca sekmeye dönüşte sayfa yenilenmeden firmasına geçer', async ({ freshPage }) => {
    const owner = await registerOwner({ orgName: 'Askı Sekme' });
    const member = await addMember(owner, 'AUDITOR', 'Sekme Üye');
    await owner.api.patch(`/api/account/org/members/${member.membershipId}`, { status: 'SUSPENDED' });
    const fresh = await freshPage();
    await fresh.goto('/login');
    await fresh.getByLabel('E-posta veya telefon').fill(member.email);
    await fresh.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await fresh.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(fresh.getByRole('heading', { name: 'Bu firmadaki üyeliğiniz askıda' })).toBeVisible({ timeout: 20_000 });
    await owner.api.patch(`/api/account/org/members/${member.membershipId}`, { status: 'ACTIVE' });
    await fresh.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect(fresh.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(fresh.getByRole('alert')).toHaveCount(0);
  });

  test('askıdaki üye DeciShip adresinde de askı metnini görür', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Askı Metin' });
    const member = await addMember(owner, 'AUDITOR', 'Metin Üye');
    const page = await openAs(member.api);
    await owner.api.patch(`/api/account/org/members/${member.membershipId}`, { status: 'SUSPENDED' });
    await page.goto('/deciship/invoices');
    await expect(page.getByText('Henüz bir firmaya üye değilsiniz')).toHaveCount(0);
    await expect(page.getByText(/askıda/).first()).toBeVisible({ timeout: 20_000 });
  });

  test('çıkarılan kişi: yönetici metni doğru; kişi firmayı görmez, "Firma oluşturun" ekranına düşer', async ({ openAs, freshPage }) => {
    const owner = await registerOwner({ orgName: 'Çıkarma Lojistik' });
    await provisionDeciship(owner);
    const member = await addMember(owner, 'AUDITOR', 'Çıkan Kişi');
    const bearer = await MobileApi.login(member.email, PASSWORD);
    expect((await bearer.get('/api/deciship/me')).status).toBe(200);

    const admin = await openAs(owner.api);
    await admin.goto('/account/team');
    await admin.getByRole('button', { name: 'Çıkan Kişi için işlemler' }).click();
    await admin.getByRole('menuitem', { name: 'Firmadan çıkar' }).click();
    const dlg = admin.getByRole('dialog');
    await expect(dlg).toContainText('Çıkan Kişi firmadan çıkarılsın mı?');
    await expect(dlg).toContainText('Hesabı silinmez, yaptığı kayıtlar korunur.');
    await dlg.getByRole('button', { name: /Firmadan çıkar/ }).click();
    await expect(admin.getByText('Çıkan Kişi firmadan çıkarıldı')).toBeVisible();

    const fresh = await freshPage();
    await fresh.goto('/login');
    await fresh.getByLabel('E-posta veya telefon').fill(member.email);
    await fresh.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await fresh.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(fresh.getByRole('heading', { name: 'Firma oluşturun' })).toBeVisible({ timeout: 20_000 });
    await expect(fresh.locator('body')).toContainText('Hesabınız açık ama bir firmada değilsiniz');
    await expect(fresh.locator('body')).not.toContainText('Çıkarma Lojistik');
    await expect.poll(async () => (await bearer.get('/api/deciship/invoices')).status, { timeout: 15_000 }).not.toBe(200);
    await bearer.dispose();
  });
});
