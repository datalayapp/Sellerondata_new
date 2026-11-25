import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { FEDEX_INVOICE, MobileApi, provisionDeciship, registerOwner, type Owner, type WebApi } from '../lib/api.ts';
import { PUBLIC_PRODUCTS, productRoles, toolOf, type Product, type ToolSeed } from '../lib/products.ts';
import { uniq } from '../lib/sys.ts';

async function switchOrg(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: `Firma: ${from}` }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(to) }).click();
  await expect(page.getByRole('button', { name: `Firma: ${to}` })).toBeVisible();
}

// ---------- Firma ayrımı (KALANLAR 6.26; C2.4-A3): A firmasının verisi B'nin hiçbir yüzeyinde görünmez ----------

type Surface = { what: string; text: string };
type Firm = { owner: Owner; tag: string; invitee: string; markers: string[] };

/** İki ayrı firma, ayrı sahipler. Etiketler A ve B ile başlar: birinin işareti ötekinin işaretinin parçası olamaz. */
async function firm(letter: 'A' | 'B', base: string): Promise<Firm> {
  const tag = `${letter}${base}`;
  const name = letter === 'A' ? 'Alfa Kişi' : 'Beta Kişi';
  const owner = await registerOwner({ orgName: `${letter === 'A' ? 'Alfa' : 'Beta'} Ayrım ${tag}`, name, email: `ayrim-${tag.toLowerCase()}@e2e.sellerondata.test` });
  // Bekleyen davet: Hesap'ın davet listesinde firmaya özgü kayıt (her açık araçta kayıttaki davet rolüyle).
  const invitee = `davet-${tag.toLowerCase()}@e2e.sellerondata.test`;
  await owner.api.post('/api/account/org/members/invite', { kind: 'EMAIL', email: invitee, name: `${name} Davetli`, orgRole: 'MEMBER', productRoles: productRoles() });
  return { owner, tag, invitee, markers: [owner.orgName, owner.email, invitee, name, owner.me.activeOrg!.id] };
}

async function textOf(api: WebApi, what: string, url: string, headers: Record<string, string> = {}): Promise<Surface> {
  const r = await api.raw().get(url, { headers });
  expect(r.status(), `${what} (${url})`).toBe(200);
  return { what, text: await r.text() };
}

/** Hesap servisinin firmaya bağlı okuma uçları. */
const ACCOUNT_READS = ['/api/account/me', '/api/account/org', '/api/account/org/members', '/api/account/org/roles', '/api/account/org/invitations', '/api/account/org/subscriptions', '/api/account/org/audit'];

/**
 * Merkez sözleşmesinin (`/api/<araç>/platform/*`, `contracts/src/hub.ts`) firma verisi taşıyan uçları: her araçta aynı.
 * Veri setlerinin hepsi, dışa aktarılabilenlerin CSV'si ve etkinlik akışı.
 */
async function hubSurfaces(api: WebApi, p: Product, period: string | undefined): Promise<Surface[]> {
  const base = `/api/${p.key}/platform`;
  const q = period ? `?${period}` : '';
  const out = [await textOf(api, 'overview', `${base}/overview${q}`), await textOf(api, 'analytics', `${base}/analytics${q}`), await textOf(api, 'activity', `${base}/activity?page=1`)];
  const list = JSON.parse((await textOf(api, 'datasets', `${base}/datasets`)).text) as { datasets: { id: string; exportable: boolean }[] };
  expect(list.datasets.length, `${p.name} veri setleri`).toBeGreaterThan(0);
  for (const d of list.datasets) {
    out.push(await textOf(api, `veri seti ${d.id}`, `${base}/datasets/${encodeURIComponent(d.id)}?pageSize=100`));
    if (d.exportable) out.push(await textOf(api, `CSV ${d.id}`, `${base}/datasets/${encodeURIComponent(d.id)}/export`));
  }
  return out;
}

async function datasetIds(api: WebApi, p: Product) {
  return (await api.get<{ datasets: { id: string }[] }>(`/api/${p.key}/platform/datasets`)).datasets.map((d) => d.id);
}

/** Görünmemesi gereken işaretler, yüzey yüzey. Boşsa ayrım tamam. */
function leaks(surfaces: Surface[], markers: string[]) {
  return surfaces.flatMap((s) => markers.filter((m) => s.text.includes(m)).map((m) => `${s.what}: ${m}`));
}

/** Sayfa yüklenip veri istekleri bitince görünen metin (adres de yüzey adıdır). */
async function pageText(page: Page, url: string): Promise<Surface> {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#sod-main, main').first()).toBeVisible();
  return { what: `sayfa ${url}`, text: await page.locator('body').innerText() };
}

test.describe('Firma ayrımı: Hesap', () => {
  test('B firmasının sahibi A\'nın kişilerini, davetlerini, denetim kaydını ve firmasını göremez; başlıkta A\'nın kimliği de açmaz', async ({ openAs }) => {
    const base = uniq('').toUpperCase();
    const a = await firm('A', base);
    const b = await firm('B', base);

    // Kontrol: işaretler A'nın kendi yüzeylerinde var (yoksa aşağıdaki "görünmez" boşuna geçerdi).
    const own = await Promise.all(ACCOUNT_READS.map((u) => textOf(a.owner.api, u, u)));
    for (const m of [a.owner.email, a.invitee, a.owner.orgName]) expect(own.some((s) => s.text.includes(m)), `A kendi ${m} kaydını görür`).toBe(true);

    const seen = await Promise.all(ACCOUNT_READS.map((u) => textOf(b.owner.api, u, u)));
    expect(leaks(seen, a.markers)).toEqual([]);

    // B'nin oturumu A'nın firma kimliğini başlıkta gönderir: okuma ya reddedilir ya B'nin verisini döner.
    for (const u of ACCOUNT_READS) {
      const r = await b.owner.api.raw().get(u, { headers: { 'X-SOD-Org': a.owner.me.activeOrg!.id } });
      if (r.status() === 200) expect(leaks([{ what: `${u} (A başlığı)`, text: await r.text() }], a.markers)).toEqual([]);
    }

    // Merkez arayüzü
    const page = await openAs(b.owner.api);
    const pages = [await pageText(page, '/account/team'), await pageText(page, '/account/company'), await pageText(page, '/activity')];
    expect(leaks(pages, a.markers)).toEqual([]);
  });
});

/** Araç başına: kayıttaki her açık araç için aynı senaryo (sürücü `lib/products.ts` `TOOLS`). */
for (const product of PUBLIC_PRODUCTS) {
  test.describe(`Firma ayrımı: ${product.name}`, () => {
    test(`A'nın ${product.name} verisi B'de araçta, Merkez'de, veri setlerinde, CSV'de ve etkinlikte görünmez; ID ile açılmaz`, async ({ openAs }) => {
      test.setTimeout(360_000);
      const tool = toolOf(product);
      const base = uniq('').toUpperCase();
      const a = await firm('A', base);
      const b = await firm('B', base);
      // İki firmada da veri var: B'nin boş olduğu için değil, süzüldüğü için görmediği sınanır.
      const seedA: ToolSeed = await tool.seed(a.owner, a.tag);
      await tool.seed(b.owner, b.tag);
      const markersA = [...seedA.markers, ...a.markers];

      // Kontrol: A kendi verisini Merkez uçlarında ve araç sayfalarında görür.
      const ownHub = await hubSurfaces(a.owner.api, product, tool.period);
      for (const m of seedA.markers) expect(ownHub.some((s) => s.text.includes(m)), `A ${m} kaydını Merkez veri setlerinde görür`).toBe(true);
      const ownPage = await openAs(a.owner.api);
      const ownPages: Surface[] = [];
      for (const url of tool.pages) ownPages.push(await pageText(ownPage, url));
      for (const m of seedA.markers) expect(ownPages.some((s) => s.text.includes(m)), `A ${m} kaydını ${product.name} sayfalarında görür`).toBe(true);
      const ownData: Surface[] = [];
      for (const id of await datasetIds(a.owner.api, product)) ownData.push(await pageText(ownPage, `/data/${product.key}/${id}`));
      for (const m of seedA.markers) expect(ownData.some((s) => s.text.includes(m)), `A ${m} kaydını Merkez › Veriler'de görür`).toBe(true);

      // Merkez sözleşmesi uçları: B, A'nın hiçbir işaretini görmez; A'nın firma kimliği başlıkta da açmaz.
      expect(leaks(await hubSurfaces(b.owner.api, product, tool.period), markersA)).toEqual([]);
      const ids = await datasetIds(b.owner.api, product);
      for (const id of ids) {
        const r = await b.owner.api.raw().get(`/api/${product.key}/platform/datasets/${encodeURIComponent(id)}?pageSize=100`, { headers: { 'X-SOD-Org': a.owner.me.activeOrg!.id } });
        if (r.status() === 200) expect(leaks([{ what: `veri seti ${id} (A başlığı)`, text: await r.text() }], markersA)).toEqual([]);
      }

      // A'nın kayıtları ID ile: çerezli oturum ve telefon (Bearer) 404.
      const mobile = await MobileApi.login(b.owner.email, b.owner.password);
      for (const url of seedA.privateApi) {
        expect((await b.owner.api.raw().get(url)).status(), `web ${url}`).toBe(404);
        expect((await mobile.get(url)).status, `Bearer ${url}`).toBe(404);
      }
      await mobile.dispose();

      // Arayüz: araç sayfaları, A'nın kayıtlarına derin bağlantı, Merkez Genel Bakış, Analiz, Veriler ve Etkinlik.
      const page = await openAs(b.owner.api);
      const range = tool.period ? `?range=custom&${tool.period}` : '';
      const urls = [...tool.pages, ...seedA.privatePages, '/home', `/home${range}`, `/analytics/${product.key}${range}`, '/activity', ...ids.map((id) => `/data/${product.key}/${id}`)];
      const seen: Surface[] = [];
      for (const url of urls) seen.push(await pageText(page, url));
      expect(leaks(seen, markersA)).toEqual([]);
    });
  });
}

test.describe('İki firma', () => {
  test('aynı kişi iki firmada: firma değiştir, veriler karışmaz, A\'nın faturasına B\'den ID ile gidilemez', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Alfa Lojistik' });
    const { invoiceId } = await provisionDeciship(owner);
    await owner.api.post('/api/account/orgs', { name: 'Beta Lojistik', country: 'TR' });
    await owner.api.me();
    await owner.api.post('/api/account/auth/switch-org', { orgId: owner.me.activeOrg!.id });
    await owner.api.me();

    const page = await openAs(owner.api);
    await page.goto('/deciship/invoices');
    await expect(page.locator('body')).toContainText(FEDEX_INVOICE.no);
    await expect(page.getByRole('button', { name: 'Firma: Alfa Lojistik' })).toBeVisible();

    await switchOrg(page, 'Alfa Lojistik', 'Beta Lojistik');
    await page.goto('/deciship/invoices');
    await expect(page.locator('body')).not.toContainText(FEDEX_INVOICE.no);

    // ID ile B'den A'nın faturası
    await page.goto(`/deciship/invoices/${invoiceId}`);
    await expect(page.locator('body')).not.toContainText(FEDEX_INVOICE.no);
    const r = await page.request.get(`/api/deciship/invoices/${invoiceId}`);
    expect(r.status()).toBe(404);

    // Merkez B firmasında A'nın sayısını göstermez
    await page.goto('/home');
    await expect(page.locator('#sod-main')).not.toContainText('611,20');

    // Geri dön: veri yerinde
    await switchOrg(page, 'Beta Lojistik', 'Alfa Lojistik');
    await page.goto(`/deciship/invoices/${invoiceId}`);
    await expect(page.locator('.ptitle .mono')).toHaveText(FEDEX_INVOICE.no);
  });

  test('iki sekme: birinde firma değişince diğerinde yazma 409 ORG_MISMATCH, kullanıcı uyarılır', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Alfa Sekme' });
    await provisionDeciship(owner);
    await owner.api.post('/api/account/orgs', { name: 'Beta Sekme', country: 'TR' });
    await owner.api.post('/api/account/auth/switch-org', { orgId: owner.me.activeOrg!.id });
    await owner.api.me();

    const tab1 = await openAs(owner.api);
    await tab1.goto('/deciship/settings');
    await expect(tab1.locator('#s-amt')).toBeVisible();

    const tab2 = await tab1.context().newPage();
    await tab2.goto('/home');
    await expect(tab2.getByRole('button', { name: 'Firma: Alfa Sekme' })).toBeVisible();
    await switchOrg(tab2, 'Alfa Sekme', 'Beta Sekme');

    // Sekme 1 hâlâ Alfa'yı gösteriyor; yazma yanlış firmaya gitmemeli
    await tab1.locator('#s-amt').fill('7');
    const write = tab1.waitForResponse((res) => res.url().includes('/api/deciship/settings') && res.request().method() === 'PATCH');
    await tab1.getByRole('button', { name: 'Ayarları kaydet' }).click();
    const res = await write;
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('ORG_MISMATCH');
    await expect(tab1.getByText('Firma değişti.')).toBeVisible();
    await expect(tab1.locator('#s-amt'), 'yazılan silinmez').toHaveValue('7');

    // Beta'ya yazılmadı
    const beta = await tab2.request.get('/api/deciship/settings');
    expect((await beta.json()).settings?.amountTol ?? (await beta.json()).amountTol).not.toBe(7);
  });
});

test.describe('Hesap yaşam döngüsü', () => {
  test('şifre değişimi diğer oturumları düşürür; eski şifre geçmez; çıkış', async ({ openAs, freshPage }) => {
    const owner = await registerOwner({ orgName: 'Şifre Lojistik' });
    const { MobileApi, PASSWORD, WebApi } = await import('../lib/api.ts');
    const mobile = await MobileApi.login(owner.email, owner.password);
    expect((await mobile.get('/api/deciship/me')).status).toBe(200);

    const other = await WebApi.create();
    await other.login(owner.email);
    const otherPage = await openAs(other);
    await otherPage.goto('/home');
    await expect(otherPage.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();

    const page = await openAs(owner.api);
    await page.goto('/account/security');
    await expect(page).toHaveTitle(/^Güvenlik/);
    await expect(page.getByRole('navigation', { name: 'Hesabım' }).getByRole('link', { name: 'Güvenlik' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
    const next = `${PASSWORD}-yeni`;
    await page.getByLabel('Mevcut şifre').fill(PASSWORD);
    await page.getByLabel('Yeni şifre', { exact: true }).fill(next);
    await page.getByLabel('Yeni şifre (tekrar)').fill(next);
    await page.getByRole('button', { name: 'Şifreyi değiştir' }).click();
    await expect(page.getByText('Şifre değiştirildi')).toBeVisible();

    // Mobil: eski jeton ve yenileme jetonu düşer
    await expect.poll(async () => (await mobile.get('/api/deciship/me')).status, { timeout: 15_000 }).toBe(401);
    expect((await mobile.refresh()).status).toBe(401);
    // İkinci tarayıcı: girişe düşer
    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/login/, { timeout: 20_000 });

    // Eski şifre artık geçmez, yenisi geçer
    const fresh = await freshPage();
    await fresh.goto('/login');
    await fresh.getByLabel('E-posta veya telefon').fill(owner.email);
    await fresh.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await fresh.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(fresh.locator('.notif, [role=alert]').first()).toBeVisible();
    await fresh.getByLabel('Şifre', { exact: true }).fill(next);
    await fresh.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(fresh).toHaveURL(/\/home/);

    // Çıkış
    await fresh.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await fresh.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(fresh).toHaveURL(/\/login/);
    await fresh.goto('/home');
    await expect(fresh).toHaveURL(/\/login/);
    await fresh.goto('/deciship/invoices');
    await expect(fresh).toHaveURL(/\/login/);
    await mobile.dispose();
    await other.dispose();
  });

  test('firma açma ve firmadan ayrılma', async ({ openAs, freshPage }) => {
    const { MobileApi: _m, PASSWORD } = await import('../lib/api.ts');
    void _m;
    const owner = await registerOwner({ orgName: 'Açma Lojistik' });
    const page = await openAs(owner.api);
    await page.goto('/home');
    // Firma aç
    await page.getByRole('button', { name: 'Firma: Açma Lojistik' }).click();
    await page.getByRole('menuitem', { name: 'Yeni firma' }).click();
    await expect(page).toHaveURL(/\/account\/company\/new/);
    await page.getByLabel('Firma adı').fill('Yeni Açılan Firma');
    await page.getByRole('button', { name: 'Firmayı aç' }).click();
    await expect(page.getByRole('button', { name: 'Firma: Yeni Açılan Firma' })).toBeVisible();

    // Sahip ayrılamaz: önce devir
    await page.goto('/account/firms');
    await expect(page.getByText(/Firma sahibi ayrılamaz/)).toBeVisible();

    // Davetle gelen çalışan ayrılabilir
    await page.goto('/account/team');
    const email = `ayrilan${Date.now()}@e2e.sellerondata.test`;
    await page.getByRole('button', { name: 'Kişi davet et' }).click();
    const panel = page.getByRole('dialog');
    await panel.getByRole('button', { name: 'E-posta' }).click();
    await panel.locator('#inv-name').fill('Ayrılan Kişi');
    await panel.locator('#inv-contact').fill(email);
    await panel.locator('#inv-deciship').selectOption('ACCOUNTING');
    await panel.getByRole('button', { name: 'Davet oluştur' }).click();
    const link = await page.getByRole('textbox', { name: 'Bağlantıyı kopyala' }).inputValue();
    const member = await freshPage();
    await member.goto(link);
    await member.getByLabel('Şifre belirleyin').fill(PASSWORD);
    await member.getByRole('button', { name: 'Katıl' }).click();
    await expect(member).toHaveURL(/\/home/);
    await member.goto('/account/firms');
    await member.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    await member.getByRole('dialog').getByRole('button', { name: 'Firmadan ayrıl' }).click();
    // Üyeliği kalmadı: firma oluştur ekranı
    await expect(member.getByRole('heading', { name: 'Firma oluşturun' })).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: /Kişiler/ }).click();
    await expect(page.getByText('Selin Sahip').first()).toBeVisible();
    await expect(page.getByText('Ayrılan Kişi')).toHaveCount(0);
  });
});
