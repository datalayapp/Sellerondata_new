import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, rawKeys, turkishLeftovers } from '../lib/fixtures.ts';
import { provisionDeciship, registerOwner } from '../lib/api.ts';
import { E2E_DIR, PLATFORM, SAMPLES } from '../lib/sys.ts';
import { openLanguage } from '../lib/shell.ts';

/** Veri: çevrilmez. Firma, kişi, taşıyıcı adı ve dil seçicinin kendi adı. */
const DATA = ['Language Logistics', 'Selin Sahip', 'Türkçe', 'Türkiye', 'TagPress'];
/** Fatura satırı dökümü API'de Türkçe üretilip saklanıyor: aşağıdaki fixme. Diğer Türkçe metinler için sınama sürer. */
const BREAKDOWN = /^(Tarife fiyatı|İndirim %|Yakıt %)/;

type Finding = { page: string; rawKeys: string[]; turkish: string[]; banned: string[] };
/** Kullanıcı kararı: çalışana "işçi/worker" denmez, deneme süresi yoktur. */
const BANNED = /\bworkers?\b|\btrials?\b|işçi|deneme/i;
const findings: Finding[] = [];

async function inspect(page: Page, name: string) {
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
  const text = await page.locator('body').innerText();
  const f: Finding = { page: name, rawKeys: await rawKeys(page), turkish: turkishLeftovers(text, DATA), banned: text.split('\n').filter((l) => BANNED.test(l)) };
  findings.push(f);
  save();
  return f;
}

function save() {
  fs.writeFileSync(path.join(E2E_DIR, '.stack', 'i18n-en.json'), JSON.stringify(findings, null, 1));
}

test.describe('Dil', () => {
  test('TR→EN her yer değişir, EN\'de ham anahtar yok; Türkçe kalanlar kaydedilir', async ({ openAs, freshPage }) => {
    const owner = await registerOwner({ orgName: 'Language Logistics' });
    const { invoiceId, tariffId } = await provisionDeciship(owner);
    const page = await openAs(owner.api);
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Genel Bakış' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');

    // Dil menüden değişir: sayfa yerinde EN
    const lang = await openLanguage(page);
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/account/me'));
    await lang.getByRole('menuitemradio', { name: 'English' }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const hub = ['/home', '/analytics/deciship', '/data/deciship/invoices', '/data/deciship/invoice-lines', '/activity', '/account/team', '/account/company', '/account/billing', '/account/profile', '/account/security', '/account/firms', '/orderloom', '/tagpress', '/yok-boyle-sayfa'];
    const deciship = ['/deciship/', '/deciship/measurements', '/deciship/invoices', `/deciship/invoices/${invoiceId}`, '/deciship/invoices/upload', '/deciship/tariffs', `/deciship/tariffs/${tariffId}`, '/deciship/settings', '/deciship/setup'];
    for (const p of [...hub, ...deciship]) {
      await page.goto(p);
      await inspect(page, p);
    }

    // Satır paneli ve oturum kapalı sayfalar
    await page.goto(`/deciship/invoices/${invoiceId}`);
    await page.getByRole('tab', { name: /Discrepanc|Diff/ }).click();
    await page.getByText('794812345305').first().click();
    await inspect(page, 'satir-paneli');

    const anon = await freshPage('en-US');
    for (const p of ['/login', '/register', '/join', '/forgot-password']) {
      await anon.goto(p);
      await expect(anon.locator('html')).toHaveAttribute('lang', 'en');
      await inspect(anon, `anon ${p}`);
    }
    save();

    // Dil hesaba yazıldı: yeni tarayıcıda da EN (tarayıcı Türkçe olsa bile)
    const me = await owner.api.me();
    expect(me.person.locale).toBe('en');

    const withKeys = findings.filter((f) => f.rawKeys.length);
    expect(withKeys, `ham anahtar: ${JSON.stringify(withKeys)}`).toEqual([]);
  });

  test('EN: işçi, worker, deneme hiçbir ekranda ve çeviri dosyasında yok', async () => {
    const all = JSON.parse(fs.readFileSync(path.join(E2E_DIR, '.stack', 'i18n-en.json'), 'utf8')) as Finding[];
    expect(all.filter((f) => f.banned.length), 'ekranlar').toEqual([]);
    const base = path.resolve(SAMPLES, '..', '..');
    const roots = [path.join(base, 'Deciship/apps/web/src/locales/en'), path.join(PLATFORM, 'apps/hub-web/src/locales/en'), path.join(PLATFORM, 'packages/shell/src/locales/en')];
    const hits: string[] = [];
    const scan = (v: unknown, where: string) => {
      if (typeof v === 'string') {
        if (BANNED.test(v)) hits.push(`${where}: ${v}`);
      } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${where}.${k}`);
    };
    for (const r of roots) for (const f of fs.readdirSync(r)) scan(JSON.parse(fs.readFileSync(path.join(r, f), 'utf8')), f);
    expect(hits, 'çeviri dosyaları').toEqual([]);
  });

  test('EN arayüzde Türkçe metin kalmadı (API mesajları hariç)', async () => {
    const file = path.join(E2E_DIR, '.stack', 'i18n-en.json');
    const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Finding[];
    const left = all.map((f) => ({ ...f, turkish: f.turkish.filter((l) => !BREAKDOWN.test(l)) })).filter((f) => f.turkish.length);
    expect(left, JSON.stringify(left, null, 1)).toEqual([]);
  });

  test('EN: fatura satırı dökümü İngilizce', async () => {
    const all = JSON.parse(fs.readFileSync(path.join(E2E_DIR, '.stack', 'i18n-en.json'), 'utf8')) as Finding[];
    const panel = all.find((f) => f.page === 'satir-paneli')!;
    expect(panel.turkish.filter((l) => BREAKDOWN.test(l))).toEqual([]);
  });

  test('TR ve EN anahtar kümesi aynı: eksik anahtar Türkçeye düşüp EN ekranda görünmez', () => {
    const flat = (o: Record<string, unknown>, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
    const base = path.resolve(SAMPLES, '..', '..');
    const roots = [path.join(base, 'Deciship/apps/web/src/locales'), path.join(PLATFORM, 'apps/hub-web/src/locales'), path.join(PLATFORM, 'packages/shell/src/locales')];
    const missing: string[] = [];
    for (const root of roots) {
      for (const f of fs.readdirSync(path.join(root, 'tr'))) {
        const en = new Set(flat(JSON.parse(fs.readFileSync(path.join(root, 'en', f), 'utf8'))));
        for (const k of flat(JSON.parse(fs.readFileSync(path.join(root, 'tr', f), 'utf8')))) {
          if (!en.has(k)) missing.push(`${root} ${f} ${k}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('sayı girişi dile göre: EN 1,234 = 1234, TR 1.234 = 1234, TR 1,5 = 1,5', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Sayı Dil' });
    const settings = async () => owner.api.get<Record<string, unknown> & { settings?: Record<string, unknown> }>('/api/deciship/settings');
    const amountTol = async () => {
      const s = await settings();
      return (s.settings ?? s).amountTol;
    };

    const page = await openAs(owner.api);
    await page.goto('/deciship/settings');
    await expect(page.locator('#s-amt')).toBeVisible();
    await page.locator('#s-amt').fill('1.234');
    await page.getByRole('button', { name: 'Ayarları kaydet' }).click();
    await expect(page.getByText(/kaydedildi/i).first()).toBeVisible();
    expect(await amountTol()).toBe(1234);

    await page.locator('#s-amt').fill('1,5');
    await page.getByRole('button', { name: 'Ayarları kaydet' }).click();
    await expect.poll(amountTol).toBe(1.5);

    const lang = await openLanguage(page);
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/account/me'));
    // Ekranda sayı alanı var: dil değişince sayfa yeni dille baştan yüklenir (planLocaleChange). Yükleme beklenir, yoksa sonraki gezinti onunla yarışır.
    const reloaded = page.waitForEvent('load');
    await lang.getByRole('menuitemradio', { name: 'English' }).click();
    expect((await saved).status()).toBe(200);
    await reloaded;
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.goto('/deciship/settings');
    await expect(page.locator('#s-amt')).toHaveValue('1.5');
    await page.locator('#s-amt').fill('1,234');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect.poll(amountTol).toBe(1234);
    await page.reload();
    await expect(page.locator('#s-amt')).toHaveValue(/1,?234/);
  });
});
