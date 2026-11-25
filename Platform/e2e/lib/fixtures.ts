// Her test için: tarayıcıda CSP ihlali ve yakalanmamış hata toplayıcı. Hız sınırı kovaları testten önce boşalır.
import { expect, test as base, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test';
import { browserFor, type WebApi } from './api.ts';
import { APP, clearRateLimits } from './sys.ts';

export type BrowserIssue = { kind: 'csp' | 'pageerror' | 'http5xx'; text: string; url: string };

function watch(context: BrowserContext, issues: BrowserIssue[]) {
  const onPage = (page: Page) => {
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to (apply|load|execute|connect)/i.test(m.text())) {
        issues.push({ kind: 'csp', text: m.text(), url: page.url() });
      }
    });
    page.on('pageerror', (e) => issues.push({ kind: 'pageerror', text: `${e.name}: ${e.message}`, url: page.url() }));
    page.on('response', (r) => {
      if (r.status() >= 500) issues.push({ kind: 'http5xx', text: `${r.status()} ${r.request().method()} ${r.url()}`, url: page.url() });
    });
  };
  context.pages().forEach(onPage);
  context.on('page', onPage);
}

type Fixtures = {
  issues: BrowserIssue[];
  /** Kesinti senaryolarında 5xx beklenir. */
  allowHttp5xx: boolean;
  _guard: void;
  /** Bu API oturumunun çerezleriyle yeni tarayıcı bağlamı (izlenir, test sonunda kapanır). */
  openAs: (api: WebApi, locale?: string, viewport?: { width: number; height: number }) => Promise<Page>;
  /** Boş, girişsiz yeni tarayıcı bağlamı. */
  freshPage: (locale?: string) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  allowHttp5xx: [false, { option: true }],
  issues: async ({}, use) => {
    await use([]);
  },
  context: async ({ context, issues }, use) => {
    watch(context, issues);
    await use(context);
  },
  openAs: async ({ browser, issues }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (api, locale = 'tr-TR', viewport) => {
      const ctx = await browserFor(browser, api, locale);
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
      if (viewport) await ctx.pages()[0]?.setViewportSize(viewport);
      watch(ctx, issues);
      opened.push(ctx);
      const page = await ctx.newPage();
      if (viewport) await page.setViewportSize(viewport);
      return page;
    });
    await Promise.all(opened.map((c) => c.close().catch(() => undefined)));
  },
  freshPage: async ({ browser, issues }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (locale = 'tr-TR') => {
      const ctx = await browser.newContext({ baseURL: APP, locale, timezoneId: 'Europe/Istanbul', viewport: { width: 1440, height: 900 } });
      watch(ctx, issues);
      opened.push(ctx);
      return ctx.newPage();
    });
    await Promise.all(opened.map((c) => c.close().catch(() => undefined)));
  },
  // Testten önce hız sınırı sayaçları sıfır; sonunda gerçek tarayıcıda CSP ihlali ve yakalanmamış hata olmamalı.
  _guard: [
    async ({ issues, allowHttp5xx }, use, info) => {
      clearRateLimits();
      await use();
      const bad = issues.filter((i) => i.kind !== 'http5xx' || !allowHttp5xx);
      if (bad.length) await info.attach('tarayici-sorunlari', { body: JSON.stringify(bad, null, 2), contentType: 'application/json' });
      expect(bad, `Tarayıcı sorunları:\n${bad.map((b) => `${b.kind} @ ${b.url}: ${b.text}`).join('\n')}`).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Sayfada ham çeviri anahtarı (`auth.login.title`) kalmış mı. */
export async function rawKeys(page: Page) {
  const text = await page.locator('body').innerText();
  return text.split('\n').filter((l) => /^\s*[a-z]+(?:[A-Z][a-z]+)*(?:\.[a-zA-Z_]+){1,4}\s*$/.test(l));
}

/** Türkçeye özgü harfler veya tipik Türkçe sözcükler: EN arayüzde kalmamalı. Veri (firma, kişi adı) çağıran tarafta çıkarılır. */
export function turkishLeftovers(text: string, ignore: string[] = []) {
  let t = text;
  for (const i of ignore) t = t.replaceAll(i, ' ');
  return t.split('\n').filter((l) => /[çğıöşüÇĞİÖŞÜ]|\b(ve|ile|için|bir|bu|yok|var|Firma|Fatura|Tarife|Kaydet|Giriş|Çıkış)\b/.test(l));
}
