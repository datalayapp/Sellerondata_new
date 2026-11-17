import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { request } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { registerOwner } from '../lib/api.ts';
import { OFF_PRODUCTS, PRODUCTS, RUNNING_PRODUCTS, servicesOf, toolOf } from '../lib/products.ts';
import { APP, PLATFORM, SITE, compose } from '../lib/sys.ts';
import { bandNav } from '../lib/shell.ts';

/** Kayıttaki web'i olan açık araçlar (`deploy.web`): kendi paketleri gateway'den gelir. Web'i olmayanın yolları Merkez'e düşer. */
const WEB_PRODUCTS = RUNNING_PRODUCTS.filter((p) => p.deploy?.web);

test.describe('Sistem bütünlüğü', () => {
  test('gateway yolları gerçek servislere gider', async () => {
    const ctx = await request.newContext({ baseURL: APP, maxRedirects: 0 });
    expect((await ctx.get('/healthz')).status()).toBe(200);
    expect((await ctx.get('/api/account/health')).status()).toBe(200);
    for (const p of RUNNING_PRODUCTS) if (p.deploy?.api) expect((await ctx.get(`/api/${p.key}/health`)).status(), p.name).toBe(200);

    const root = await ctx.get('/');
    expect(root.status()).toBe(302);
    expect(root.headers().location).toBe('/home');

    for (const p of WEB_PRODUCTS) {
      const slash = await ctx.get(`/${p.key}`);
      expect(slash.status(), p.name).toBe(301);
      expect(slash.headers().location).toBe(`/${p.key}/`);
    }

    // Kapalı araçların yolu Merkez'in "Yakında" sayfası; açık aracın sayfaları kendi paketinden (sürücüdeki liste).
    const htmlPaths = ['/home', '/login', '/register', '/join', ...OFF_PRODUCTS.map((p) => `/${p.key}`), ...WEB_PRODUCTS.flatMap((p) => [`/${p.key}/`, ...toolOf(p).pages])];
    for (const p of htmlPaths) {
      const r = await ctx.get(p);
      expect(r.status(), p).toBe(200);
      expect(r.headers()['content-type'], p).toContain('text/html');
      expect(r.headers()['content-security-policy'], p).toContain("frame-ancestors 'none'");
    }

    // Aracın paketi kendi adresinden gelir, değişmez önbellekle
    for (const p of WEB_PRODUCTS) {
      const html = await (await ctx.get(`/${p.key}/`)).text();
      const asset = new RegExp(`src="(/${p.key}/assets/[^"]+\\.js)"`).exec(html)?.[1];
      expect(asset, `${p.name} giriş paketi`).toBeTruthy();
      const js = await ctx.get(asset!);
      expect(js.status()).toBe(200);
      expect(js.headers()['content-type']).toContain('javascript');
      expect(js.headers()['cache-control']).toContain('immutable');
    }

    for (const p of RUNNING_PRODUCTS) {
      if (!p.deploy?.api) continue;
      expect((await ctx.get(`/api/${p.key}/internal/events`)).status(), p.name).toBe(404);
      expect((await ctx.post(`/api/${p.key}/internal/events`, { data: {} })).status(), p.name).toBe(404);
    }
    expect((await ctx.get('/api/account/.well-known/jwks.json')).status()).toBe(200);
    await ctx.dispose();
  });

  test('araç kaydı = çalışan sistem: katalogdaki durum kayıtla aynı, her açık aracın e2e sürücüsü var', async () => {
    const ctx = await request.newContext({ baseURL: APP });
    const catalog = (await (await ctx.get('/api/account/catalog')).json()) as { products: { key: string; launch: string }[] };
    await ctx.dispose();
    expect(catalog.products.map((p) => `${p.key}=${p.launch}`)).toEqual(PRODUCTS.map((p) => `${p.key}=${p.launch}`));
    // Yeni araç açılınca (launch 'off' değil) sürücü yazılmadan geçmez: firma ayrımı ve sistem testleri ona da koşmalı.
    for (const p of RUNNING_PRODUCTS) expect(() => toolOf(p), p.name).not.toThrow();
  });

  test('tanıtım sitesi ayrı kökende açık', async () => {
    const ctx = await request.newContext({ baseURL: SITE });
    expect((await ctx.get('/')).status()).toBe(200);
    expect((await ctx.get('/en/')).status()).toBe(200);
    await ctx.dispose();
  });

  test('tek seferlik kaplar başarıyla bitti, tüm servisler sağlıklı', async () => {
    const rows = compose('ps', '-a', '--format', 'json')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { Service: string; State: string; Health: string; ExitCode: number });
    for (const one of ['postgres-upgrade', 'account-migrate', ...RUNNING_PRODUCTS.flatMap((p) => toolOf(p).oneShot)]) {
      const r = rows.find((x) => x.Service === one);
      expect(r, one).toBeTruthy();
      expect(r!.ExitCode, one).toBe(0);
    }
    // BASLAT adresler yanıt verince döner; Docker sağlık denetimi 5 sn aralıkla gelir.
    for (const svc of ['postgres', 'account-api', 'hub-web', 'site', 'gateway', ...RUNNING_PRODUCTS.flatMap(servicesOf)]) {
      const status = () => {
        const all = compose('ps', '-a', '--format', 'json')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { Service: string; State: string; Health: string });
        const r = all.find((x) => x.Service === svc);
        return `${r?.State}/${r?.Health}`;
      };
      await expect.poll(status, { message: svc, timeout: 30_000 }).toBe('running/healthy');
    }
  });

  test('olay hedefi ve yerel sırlar kapta', async () => {
    // Olay hedefi her açık aracın API'sinin iç adresi (kayıttaki `deploy.api`); sıra önemsiz.
    const accountEnv = compose('exec', '-T', 'account-api', 'printenv', 'PRODUCT_EVENT_TARGETS').trim();
    const targets = RUNNING_PRODUCTS.filter((p) => p.deploy?.api).map((p) => `${p.key}=http://${p.deploy!.api!.service}:${p.deploy!.api!.port}/api/${p.key}/internal/events`);
    expect(accountEnv.split(',').sort()).toEqual(targets.sort());
    expect(compose('exec', '-T', 'account-api', 'printenv', 'ACCOUNT_CODE_PEPPER').trim().length).toBeGreaterThanOrEqual(32);
    expect(compose('exec', '-T', 'deciship-api', 'printenv', 'FILE_TOKEN_SECRET').trim().length).toBeGreaterThanOrEqual(32);
  });

  test('üretim compose: sır eksikse başlamaz, tamsa FILE_TOKEN_SECRET ve biber kaplara geçer', () => {
    const SECRETS = {
      SOD_POSTGRES_PASSWORD: 'p1',
      SOD_PLATFORM_ADMIN_DB_PASSWORD: 'p2',
      SOD_DECISHIP_ADMIN_DB_PASSWORD: 'p3',
      SOD_PLATFORM_DB_PASSWORD: 'p4',
      SOD_DECISHIP_DB_PASSWORD: 'p5',
      APP_BASE_URL: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      SITE_BASE_URL: 'https://site.example.test',
      SITE_ORIGINS: 'https://site.example.test',
      // 3.2: Caddy'nin alan adları ve ACME e-postası üretimde zorunlu.
      APP_HOST: 'app.example.test',
      SITE_HOST: 'site.example.test',
      ACME_EMAIL: 'ops@example.test',
      ACCOUNT_SIGNING_KEY: '{}',
      ACCOUNT_CODE_PEPPER: 'x'.repeat(40),
      FILE_TOKEN_SECRET: 'y'.repeat(40),
      PRODUCT_NOTIFY_SECRET: 'z'.repeat(40),
      SMTP_URL: 'smtp://kullanici:parola@sunucu:587',
    };
    const run = (env: Record<string, string>) =>
      spawnSync('docker', ['compose', '-p', 'sod-e2e-prodcheck', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', '--env-file', 'e2e-yok.env', 'config', '--format', 'json'], {
        cwd: PLATFORM,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    fs.writeFileSync(path.join(PLATFORM, 'e2e-yok.env'), '');
    try {
      const { FILE_TOKEN_SECRET: _f, ...noFile } = SECRETS;
      void _f;
      const missing = run(noFile);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('FILE_TOKEN_SECRET');
      // Tek hesap: sitenin kökeni üretimde zorunlu (ARCHITECTURE §5 "Tek hesap").
      const { SITE_ORIGINS: _s, ...noSite } = SECRETS;
      void _s;
      const missingSite = run(noSite);
      expect(missingSite.status).not.toBe(0);
      expect(missingSite.stderr).toContain('SITE_ORIGINS');
      // Araç bildirim anahtarı üretimde zorunlu: yerel varsayılana düşmez.
      const { PRODUCT_NOTIFY_SECRET: _n, ...noNotify } = SECRETS;
      void _n;
      const missingNotify = run(noNotify);
      expect(missingNotify.status).not.toBe(0);
      expect(missingNotify.stderr).toContain('PRODUCT_NOTIFY_SECRET');
      const ok = run(SECRETS);
      expect(ok.status, ok.stderr).toBe(0);
      const cfg = JSON.parse(ok.stdout) as { services: Record<string, { environment: Record<string, string> }> };
      expect(cfg.services['deciship-api']!.environment.FILE_TOKEN_SECRET).toBe(SECRETS.FILE_TOKEN_SECRET);
      expect(cfg.services['account-api']!.environment.ACCOUNT_CODE_PEPPER).toBe(SECRETS.ACCOUNT_CODE_PEPPER);
      expect(cfg.services['account-api']!.environment.SITE_ORIGINS).toBe(SECRETS.SITE_ORIGINS);
      expect(cfg.services['deciship-api']!.environment.NODE_ENV).toBe('production');
      // Aynı anahtar iki uca: Hesap haritada, DeciShip tek değer; hatırlatma iç ağ adresine gider, deneme turu varsayılan açık.
      expect(cfg.services['account-api']!.environment.PRODUCT_NOTIFY_SECRETS).toBe(`deciship=${SECRETS.PRODUCT_NOTIFY_SECRET}`);
      expect(cfg.services['deciship-api']!.environment.PRODUCT_NOTIFY_SECRET).toBe(SECRETS.PRODUCT_NOTIFY_SECRET);
      expect(cfg.services['deciship-api']!.environment.ACCOUNT_NOTIFY_URL).toBe('http://account-api:4100/api/account/internal/notify');
      expect(cfg.services['deciship-api']!.environment.DEMO_TOUR).toBe('on');
    } finally {
      fs.rmSync(path.join(PLATFORM, 'e2e-yok.env'), { force: true });
    }
  });

  test('CSP: dedektör ihlali yakalar; Speculation Rules izni olmadan engellenirdi, izinle engellenmez', async ({ page, issues, openAs }) => {
    // Kontrol: gerçek ihlal toplayıcıya düşer. Sonra çıkarılır, testin sonu temiz sayılsın.
    const owner = await registerOwner();
    const app = await openAs(owner.api);
    await app.goto('/home');
    await expect(bandNav(app, 'Merkez')).toBeVisible();
    expect(issues.filter((i) => i.kind === 'csp'), 'gerçek sayfada ihlal yok').toEqual([]);
    await app.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = 'body{}';
      document.head.appendChild(s);
    });
    await expect.poll(() => issues.filter((i) => i.kind === 'csp').length).toBeGreaterThan(0);

    // Aynı sayfa, başlıktan izin çıkarılmış: kabuğun bloğu engellenir. İzin bu yüzden gerekli.
    const before = issues.length;
    await app.route('**/home', async (route) => {
      const res = await route.fetch();
      const headers = { ...res.headers() };
      headers['content-security-policy'] = headers['content-security-policy']!.replace(" 'inline-speculation-rules'", '');
      await route.fulfill({ response: res, headers });
    });
    await app.goto('/home');
    await expect(bandNav(app, 'Merkez')).toBeVisible();
    await expect.poll(() => issues.slice(before).filter((i) => i.kind === 'csp' && /script/i.test(i.text)).length).toBeGreaterThan(0);
    issues.length = 0;
    void page;
  });
});
