// Kabuk + DeciShip ekran görüntüleri (mock modu): `node scripts/platform-shots.mjs [baseUrl]`
// Çıktı: screenshots/platform/<genişlik>-<dil>-<ekran>.png. Sunucu: `npm run dev:mock`.
/* global document -- addInitScript ve page.evaluate geri çağrıları tarayıcıda koşar. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const base = process.argv[2] ?? `http://localhost:${process.env.DECISHIP_WEB_PORT ?? 5173}`;
const out = process.env.SHOT_DIR ?? path.resolve(import.meta.dirname, '..', 'screenshots', 'platform');
mkdirSync(out, { recursive: true });
const widths = (process.env.SHOT_WIDTHS ?? '1440,1024,390').split(',').map(Number);
const langs = (process.env.SHOT_LANGS ?? 'tr').split(',');

const browser = await chromium.launch();
const errors = [];

async function session(width, lang, personId, orgId, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, locale: lang === 'en' ? 'en-US' : 'tr-TR', timezoneId: 'Europe/Istanbul' });
  await ctx.addInitScript(
    ({ personId, orgId, extra, lang }) => {
      localStorage.setItem('sod_mock_fast', '1');
      localStorage.setItem('sod_mock_session', JSON.stringify({ personId, orgId }));
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
      document.cookie = `sod_lang=${lang}; Path=/`;
      // dil önce kişinin kaydındadır (§9)
      localStorage.setItem('sod_mock_locale', lang);
    },
    { personId, orgId, extra, lang },
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${width} ${page.url()} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push(`${width} ${page.url()} console: ${m.text()}`));
  return { ctx, page };
}

for (const width of widths) {
  for (const lang of langs) {
    const shot = async (page, name, full = false) => {
      await page.waitForTimeout(350);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) errors.push(`${width} ${name}: yatay taşma ${overflow}px`);
      await page.screenshot({ path: path.join(out, `${width}-${lang}-${name}.png`), fullPage: full });
      console.log('saved', width, lang, name);
    };

    const owner = await session(width, lang, 'p1', 'o1');
    const p = owner.page;
    await p.goto(`${base}/deciship/`);
    await p.waitForSelector('.dash-hero-v:not(:has(.skel))');
    await shot(p, '01-pano');
    await p.goto(`${base}/deciship/measurements`);
    await p.waitForSelector('table.dt tbody tr.clickable');
    await shot(p, '02-olcumler');
    await p.click('table.dt tbody tr.clickable');
    await p.waitForSelector('.panel .cmp');
    await shot(p, '03-olcum-panel');
    await p.goto(`${base}/deciship/invoices`);
    await p.waitForSelector('table.dt tbody tr.clickable');
    await shot(p, '04-faturalar');
    await p.click('table.dt tbody tr.clickable');
    await p.waitForSelector('.lines-dt tbody tr');
    await shot(p, '05-fatura-detay');
    await p.click('.lines-dt tbody tr.clickable');
    await p.waitForSelector('.panel .pn-sub');
    await shot(p, '06-fatura-satir');
    await p.goto(`${base}/deciship/tariffs`);
    await p.waitForSelector('.tl-table tbody tr, .empty');
    await shot(p, '07-tarifeler');
    await p.goto(`${base}/deciship/tariffs/t1`);
    await p.waitForSelector('.te-main');
    await shot(p, '08-tarife-duzenle');
    await p.goto(`${base}/deciship/settings`);
    await p.waitForSelector('#s-name');
    await shot(p, '09-ayarlar', true);
    if (width < 1024) {
      await p.goto(`${base}/deciship/invoices`);
      await p.waitForSelector('table.dt tbody tr.clickable');
      await p.click('.sod-burger');
      await p.waitForTimeout(300);
      await shot(p, '10-cekmece');
    }
    await owner.ctx.close();

    const fresh = await session(width, lang, 'p9', 'o3');
    await fresh.page.goto(`${base}/deciship/`);
    await fresh.page.waitForSelector('.ob-main');
    await shot(fresh.page, '11-kurulum');
    await fresh.page.goto(`${base}/deciship/setup?adim=ozet`);
    await fresh.page.waitForSelector('.ds-team');
    await shot(fresh.page, '12-kurulum-ozet', true);
    await fresh.ctx.close();

    const acc = await session(width, lang, 'p4', 'o1');
    await acc.page.goto(`${base}/deciship/invoices/i1`);
    await acc.page.waitForSelector('.lines-dt tbody tr');
    await shot(acc.page, '13-muhasebe-fatura');
    await acc.page.goto(`${base}/deciship/tariffs/new`);
    await acc.page.waitForSelector('.ds-access-card');
    await shot(acc.page, '14-izin-yok');
    await acc.page.goto(`${base}/deciship/tariffs`);
    await acc.page.waitForSelector('.tl-table tbody tr');
    await shot(acc.page, '20-muhasebe-tarifeler');
    await acc.page.goto(`${base}/deciship/tariffs/t1`);
    await acc.page.waitForSelector('fieldset.te-ro #t-name');
    await acc.page.fill('#q-c', 'DE');
    await acc.page.click('.qt-btn');
    await acc.page.waitForSelector('.quote-res');
    await shot(acc.page, '21-muhasebe-tarife');
    await shot(acc.page, '22-muhasebe-tarife-tam', true);
    await acc.ctx.close();

    const susp = await session(width, lang, 'p4', 'o1', { sod_mock_suspended: '1' });
    await susp.page.goto(`${base}/deciship/invoices`);
    await susp.page.waitForSelector('.ds-access-card');
    await shot(susp.page, '23-askida');
    await susp.ctx.close();

    const measure = await session(width, lang, 'p5', 'o1');
    await measure.page.goto(`${base}/deciship/`);
    await measure.page.waitForSelector('.ds-access-card');
    await shot(measure.page, '15-mobil-rol');
    await measure.ctx.close();

    const none = await session(width, lang, 'p8', 'o1');
    await none.page.goto(`${base}/deciship/`);
    await none.page.waitForSelector('.ds-access-card');
    await shot(none.page, '16-erisim-yok');
    await none.ctx.close();

    const ro = await session(width, lang, 'p1', 'o1', { sod_mock_readonly: '1' });
    await ro.page.goto(`${base}/deciship/invoices`);
    await ro.page.waitForSelector('table.dt tbody tr.clickable');
    await shot(ro.page, '17-salt-okunur');
    await ro.page.goto(`${base}/deciship/tariffs/t1`);
    await ro.page.waitForSelector('.te-main');
    await shot(ro.page, '18-salt-okunur-tarife');
    await ro.ctx.close();

    const down = await session(width, lang, 'p1', 'o1');
    await down.page.goto(`${base}/deciship/invoices`);
    await down.page.waitForSelector('table.dt tbody tr.clickable');
    await down.page.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
    await down.page.reload();
    await down.page.waitForSelector('.sod-status');
    await down.page.waitForSelector('table.dt tbody tr.clickable');
    await shot(down.page, '19-hesap-kesik');
    await down.ctx.close();
  }
}
console.log(errors.length ? `SORUNLAR:\n${[...new Set(errors)].join('\n')}` : 'sorun yok');
await browser.close();
