import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { addCarrierAndTariff, confirmCompany, loadMeasurements, PASSWORD, registerOwner, SAMPLE_PERIOD, WebApi, type Owner } from '../lib/api.ts';
import { APP, E2E_DIR, SAMPLES, SHOTS, SITE, recordMetric, uniq } from '../lib/sys.ts';
import { bandNav, openApps } from '../lib/shell.ts';

// Ekran başına bekleme var: tam tur uzun sürer.
test.setTimeout(900_000);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** E-posta davetiyle DeciShip Ölçüm rolünde çalışan ekler (davet kabulü hesabı açar); giriş kimliğini döner. */
async function measureMember(owner: Owner) {
  const email = `${uniq('olcum')}@e2e.sellerondata.test`;
  const name = 'Kemal Depo';
  const inv = await owner.api.post<{ link: string }>('/api/account/org/members/invite', { kind: 'EMAIL', email, name, orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } });
  const token = new URL(inv.link).pathname.split('/').pop()!;
  const api = await WebApi.create();
  await api.post(`/api/account/invites/${token}/accept`, { name, password: PASSWORD, client: 'web' });
  await api.dispose();
  return email;
}

type Expected = { invoices: { file: string; carrierCode: string; invoiceNo: string; invoiceDate: string; currency: string; suggestedMapping: unknown }[] };

/** Gerçek veri: Merkez'de onaylı firma, tüm taşıyıcılar, tarifeleri, ölçümler ve örnek faturaların hepsi. */
async function richCompany(locale: string, orgName: string) {
  const owner = await registerOwner({ orgName, name: 'Selin Sahip', locale });
  owner.me = await confirmCompany(owner.api);
  const expected = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8')) as Expected;
  const carriers = new Map<string, string>();
  let tariffId = '';
  for (const code of ['fedex', 'ups', 'dhl', 'aras', 'yurtici', 'mng']) {
    const r = await addCarrierAndTariff(owner.api, code);
    carriers.set(code, r.carrierId);
    tariffId ||= r.tariffId;
  }
  // Ölçümleri depodaki Ölçüm rolü gönderir, faturaları sahip yükler. Yükleme sınırı kişi başı dakikada 60 (Mesaj 6,
  // RATE_UPLOAD_PER_MIN_MEMBER): 57 ölçüm + 7 önizleme aynı kişiden bir dakikada gelirse önizleme haklı olarak 429 alır.
  const measurer = await measureMember(owner);
  await loadMeasurements(measurer, PASSWORD);
  let invoiceId = '';
  for (const inv of expected.invoices) {
    const buffer = fs.readFileSync(path.join(SAMPLES, inv.file));
    const pv = await owner.api.ctx.post('/api/deciship/invoices/preview', {
      headers: { 'X-SOD-Org': owner.api.orgId! },
      multipart: { carrierId: carriers.get(inv.carrierCode)!, file: { name: path.basename(inv.file), mimeType: inv.file.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer } },
    });
    expect(pv.ok(), await pv.text()).toBeTruthy();
    const preview = await pv.json();
    const created = await owner.api.post<{ invoice: { id: string } }>('/api/deciship/invoices', {
      fileId: preview.fileId,
      carrierId: carriers.get(inv.carrierCode),
      invoiceNo: inv.invoiceNo,
      invoiceDate: inv.invoiceDate,
      currency: inv.currency,
      mapping: inv.suggestedMapping,
      acknowledgeIssues: true,
    });
    invoiceId ||= created.invoice.id;
  }
  return { owner, invoiceId, tariffId };
}

async function teamFor(owner: Owner) {
  // Ekip ekranı dolu görünsün: bekleyen davetler ve bir çalışan
  await owner.api.post('/api/account/org/members/invite', { kind: 'PHONE_CODE', phone: `0533${String(Date.now()).slice(-7)}`, name: 'Mehmet Depo', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } });
  await owner.api.post('/api/account/org/members/invite', { kind: 'EMAIL', email: `muhasebe${Date.now()}@e2e.sellerondata.test`, name: 'Mert Muhasebe', orgRole: 'MEMBER', productRoles: { deciship: 'ACCOUNTING' } });
}

const WIDTHS = [1440, 1024, 390];
const PERIOD = SAMPLE_PERIOD.hub;
/** Tüm örnek faturaların dönemi (`expected.json` fatura tarihleri; dosyadaki gibi sabit, KALANLAR 6.28): ilk faturanın ayının başından son faturaya. */
const ALL_SAMPLES = (() => {
  const dates = (JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8')) as Expected).invoices.map((i) => i.invoiceDate).sort();
  return `from=${dates[0]!.slice(0, 7)}-01&to=${dates.at(-1)!}`;
})();

type Layout = { lang: string; page: string; width: number; scrollWidth: number; clipped: string[] };
const layout: Layout[] = [];

async function shoot(page: Page, lang: string, name: string, url: string, base = '') {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(base + url);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    const dir = path.join(SHOTS, lang);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name}-${width}.png`), fullPage: true });
    // Yatay taşma: belge pencereden geniş mi, metin kutusundan taşan öğe var mı
    const m = await page.evaluate(() => {
      const clipped: string[] = [];
      for (const el of Array.from(document.querySelectorAll('button, a, h1, h2, th, .btn, .kpi, label'))) {
        const e = el as HTMLElement;
        if (!e.offsetParent) continue;
        const r = e.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 && !e.closest('.table-wrap, .wsteps, [class*=scroll], .sod-nav')) clipped.push(`${e.tagName}.${e.className}: ${(e.innerText ?? '').slice(0, 30)}`);
      }
      return { scrollWidth: document.documentElement.scrollWidth, clipped: clipped.slice(0, 5) };
    });
    if (m.scrollWidth > width + 1 || m.clipped.length) layout.push({ lang, page: name, width, ...m });
  }
}

test.describe('Performans ve görüntü', () => {
  test('ölçümler: ilk açılış, Merkez→DeciShip geçişi, overview', async ({ browser }) => {
    const { owner } = await richCompany('tr', 'Ölçüm Lojistik');

    const coldContext = async () => browser.newContext({ baseURL: APP, locale: 'tr-TR', storageState: await owner.api.ctx.storageState() });

    // İlk açılış: önbelleksiz yeni bağlam
    {
      const ctx = await browser.newContext({ baseURL: APP, locale: 'tr-TR' });
      const page = await ctx.newPage();
      const t = Date.now();
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Giriş yapın' })).toBeVisible();
      recordMetric('ilk_acilis_login_ms', Date.now() - t);
      await ctx.close();
    }
    const homes: number[] = [];
    const decis: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ctx = await coldContext();
      const page = await ctx.newPage();
      let t = Date.now();
      await page.goto(`/home?${PERIOD}`);
      await expect(page.locator('.hub-hero')).toBeVisible();
      homes.push(Date.now() - t);
      await ctx.close();
      const ctx2 = await coldContext();
      const p2 = await ctx2.newPage();
      t = Date.now();
      await p2.goto('/deciship/');
      await expect(bandNav(p2, 'DeciShip')).toBeVisible();
      await expect(p2.locator('.dash-lead, .ob').first()).toBeVisible();
      decis.push(Date.now() - t);
      await ctx2.close();
    }
    recordMetric('ilk_acilis_home_veri_ms_medyan', median(homes));
    recordMetric('ilk_acilis_deciship_ms_medyan', median(decis));

    // Geçiş: önceden yükleme fırsatı olan gerçek kullanıcı; tıklamadan ray+içerik görünene
    const ctx = await coldContext();
    const page = await ctx.newPage();
    await page.goto('/home');
    await expect(page.locator('.hub-hero')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const trans: number[] = [];
    const back: number[] = [];
    for (let i = 0; i < 5; i++) {
      // D09: araçlar ⊞ uygulama seçicisinde; etkin araç logo kilidinde.
      const ds = (await openApps(page)).getByRole('menuitem', { name: /DeciShip/ });
      await ds.hover();
      await page.waitForTimeout(300);
      let t = Date.now();
      await ds.click();
      await page.waitForURL(/\/deciship\//);
      await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
      trans.push(Date.now() - t);
      await page.waitForLoadState('networkidle');
      const hub = (await openApps(page)).getByRole('menuitem', { name: /Merkez/ });
      t = Date.now();
      await hub.click();
      await page.waitForURL(/\/home/);
      await expect(page.locator('.sod-brand-n')).toHaveText('Merkez');
      back.push(Date.now() - t);
      await page.waitForLoadState('networkidle');
    }
    recordMetric('gecis_merkez_deciship_ms_medyan', median(trans));
    recordMetric('gecis_deciship_merkez_ms_medyan', median(back));
    await ctx.close();

    // overview: gerçek veriyle API süresi (gateway üzerinden)
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = Date.now();
      await owner.api.get(`/api/deciship/platform/overview?${ALL_SAMPLES}`);
      times.push(Date.now() - t);
    }
    recordMetric('overview_ms_medyan', median(times));
    recordMetric('overview_ms_en_kotu', Math.max(...times));
    const analytics: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await owner.api.get(`/api/deciship/platform/analytics?${ALL_SAMPLES}`);
      analytics.push(Date.now() - t);
    }
    recordMetric('analytics_ms_medyan', median(analytics));
  });

  for (const lang of ['tr', 'en'] as const) {
    test(`ekran görüntüleri ${lang.toUpperCase()}: 1440, 1024, 390`, async ({ openAs, freshPage }) => {
      const { owner, invoiceId, tariffId } = await richCompany(lang, lang === 'tr' ? 'Demo Lojistik A.Ş.' : 'Demo Logistics Ltd.');
      await teamFor(owner);
      const page = await openAs(owner.api, lang === 'tr' ? 'tr-TR' : 'en-US');
      const pages: [string, string][] = [
        ['merkez-genel-bakis', `/home?${PERIOD}`],
        ['merkez-analiz', `/analytics/deciship?${PERIOD}`],
        ['merkez-veriler', '/data/deciship/invoices'],
        ['merkez-veriler-satirlar', '/data/deciship/invoice-lines?filter.status=DIFF'],
        ['merkez-etkinlik', '/activity'],
        ['merkez-ekip', '/account/team'],
        ['merkez-firma', '/account/company'],
        ['merkez-abonelik', '/account/billing'],
        ['merkez-profil', '/account/profile'],
        ['merkez-guvenlik', '/account/security'],
        ['merkez-firmalarim', '/account/firms'],
        ['merkez-yakinda-order', '/orderloom'],
        ['deciship-pano', '/deciship/'],
        ['deciship-olcumler', '/deciship/measurements'],
        ['deciship-faturalar', '/deciship/invoices'],
        ['deciship-fatura-detay', `/deciship/invoices/${invoiceId}`],
        ['deciship-fatura-yukle', '/deciship/invoices/upload'],
        ['deciship-tarifeler', '/deciship/tariffs'],
        ['deciship-tarife', `/deciship/tariffs/${tariffId}`],
        ['deciship-ayarlar', '/deciship/settings'],
        ['deciship-kurulum', '/deciship/setup'],
      ];
      for (const [name, url] of pages) await shoot(page, lang, name, url);

      // Pano boş firma, Ölçüm rolü
      const fresh = await registerOwner({ orgName: lang === 'tr' ? 'Yeni Firma' : 'New Company', locale: lang });
      const empty = await openAs(fresh.api, lang === 'tr' ? 'tr-TR' : 'en-US');
      await shoot(empty, lang, 'merkez-bos-firma', '/home');

      const anon = await freshPage(lang === 'tr' ? 'tr-TR' : 'en-US');
      await shoot(anon, lang, 'giris', '/login');
      await shoot(anon, lang, 'kayit', '/register');
      await shoot(anon, lang, 'kodla-katilim', '/join');
      await shoot(anon, lang, 'site', lang === 'tr' ? '/' : '/en/', SITE);

      fs.writeFileSync(path.join(E2E_DIR, '.stack', `layout-${lang}.json`), JSON.stringify(layout.filter((l) => l.lang === lang), null, 1));
      const overflow = layout.filter((l) => l.lang === lang && l.scrollWidth > l.width + 1);
      expect.soft(overflow, `yatay taşma: ${JSON.stringify(overflow)}`).toEqual([]);
      void WebApi;
    });
  }
});
