import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { PRODUCT_LAUNCH_ENV } from '../src/lib/launch.ts';
import { DEV_PRODUCT_NOTIFY_SECRET, isValidNotifySecret } from '@sellerondata/contracts';
import { assertConfig, assertProductionConfig, env } from '../src/env.ts';
import { assertNoDemoAccounts, DEMO_EMAIL_DOMAIN } from '../src/lib/demo.ts';
import { assertSeedAllowed, SEED_ORGS, SEED_PEOPLE, seedDevData } from '../src/seed.ts';

const NAMES = [
  'NODE_ENV', 'DATABASE_URL', 'ACCOUNT_CODE_PEPPER', 'SMTP_URL', 'COOKIE_SECURE', 'APP_BASE_URL', 'ALLOWED_ORIGINS',
  'SITE_ORIGINS', 'EMAIL_VERIFICATION_REQUIRED', 'PRODUCT_EVENT_TARGETS', 'PRODUCT_LAUNCH', 'PRODUCT_NOTIFY_SECRETS',
];

/** Geçerli üretim yapılandırması; her test yalnız bir ayarı bozar. */
const prodBase: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://a:gercek@db/x',
  ACCOUNT_CODE_PEPPER: 'g'.repeat(40),
  SMTP_URL: 'smtp://mail:25',
  COOKIE_SECURE: '',
  APP_BASE_URL: 'https://app.example.com',
  ALLOWED_ORIGINS: 'https://app.example.com',
  SITE_ORIGINS: 'https://example.com',
  EMAIL_VERIFICATION_REQUIRED: 'true',
  // Kapalı olmayan her ürünün adresi: DeciShip `public`, TagPress `pilot`.
  PRODUCT_EVENT_TARGETS: 'deciship=http://deciship-api:4000/events,tagpress=http://tagpress-api:4200/events',
};
const TAGPRESS_TARGET = 'tagpress=http://tagpress-api:4200/events';

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of NAMES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('üretim açılış denetimleri', () => {
  it('geçerli yapılandırma açılır', () => {
    Object.assign(process.env, prodBase);
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('kayıt kipi: üretimde yazılmazsa invite (kapalı deneme, 2026-11-12); bozuk değer her ortamda durur', () => {
    const before = process.env.SIGNUP_MODE;
    try {
      Object.assign(process.env, prodBase);
      delete process.env.SIGNUP_MODE;
      expect(env.signupMode).toBe('invite');
      process.env.SIGNUP_MODE = 'acik';
      expect(() => assertConfig()).toThrow(/SIGNUP_MODE geçersiz/);
    } finally {
      if (before === undefined) delete process.env.SIGNUP_MODE;
      else process.env.SIGNUP_MODE = before;
    }
  });

  it('doğrulama kapalıysa açılış durur', () => {
    Object.assign(process.env, prodBase, { EMAIL_VERIFICATION_REQUIRED: 'false' });
    expect(() => assertProductionConfig()).toThrow(/EMAIL_VERIFICATION_REQUIRED üretimde true olmalı/);
  });

  it('hazır ürünün olay adresi yoksa açılış durur', () => {
    Object.assign(process.env, prodBase, { PRODUCT_EVENT_TARGETS: '' });
    expect(() => assertProductionConfig()).toThrow(/PRODUCT_EVENT_TARGETS içinde deciship adresi yok: olaylar teslim edilemez\./);
  });

  it('olay adresi yalın http(s) değilse açılış durur; adres (parola) metne yazılmaz (03-B13)', () => {
    for (const target of ['deciship-api:4000/events', 'ftp://deciship-api/events', 'http://kul:gizli@deciship-api:4000/events', 'http://deciship-api:4000/events?x=1', 'yanlis']) {
      Object.assign(process.env, prodBase, { PRODUCT_EVENT_TARGETS: `deciship=${target},${TAGPRESS_TARGET}` });
      expect(() => assertProductionConfig(), target).toThrow(/PRODUCT_EVENT_TARGETS içinde deciship adresi geçersiz/);
      try {
        assertProductionConfig();
      } catch (e) {
        expect((e as Error).message).not.toMatch(/gizli|kul:/);
      }
    }
    Object.assign(process.env, prodBase, { PRODUCT_EVENT_TARGETS: `deciship=https://deciship-api.internal/api/deciship/internal/events,${TAGPRESS_TARGET}` });
    expect(() => assertProductionConfig()).not.toThrow();
  });
});

describe('geliştirme modu yalnız yerel adreste', () => {
  const devBase = { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:8088', ALLOWED_ORIGINS: 'http://localhost:8088', SITE_ORIGINS: 'http://localhost:8089' };

  it('NODE_ENV üretim değilken yerel olmayan APP_BASE_URL açılışı durdurur', () => {
    for (const nodeEnv of ['development', 'test', '']) {
      Object.assign(process.env, devBase, { NODE_ENV: nodeEnv, APP_BASE_URL: 'https://app.sellerondata.com', ALLOWED_ORIGINS: 'https://app.sellerondata.com' });
      expect(() => assertConfig(), nodeEnv).toThrow(/APP_BASE_URL yerel değil.*NODE_ENV=production/);
    }
  });

  it('yerel ve yerel ağ adresleri açılır: localhost, 127.0.0.1, [::1], özel ağ IPv4', () => {
    for (const url of ['http://localhost:8088', 'http://localhost:18188', 'http://127.0.0.1:8088', 'http://[::1]:8088', 'http://192.168.1.20:8088', 'http://10.0.0.5:8088', 'http://172.20.1.2:8088']) {
      Object.assign(process.env, devBase, { APP_BASE_URL: url, ALLOWED_ORIGINS: new URL(url).origin });
      expect(() => assertConfig(), url).not.toThrow();
    }
  });

  it('özel ağ benzeri ama genel adresler yerel sayılmaz', () => {
    for (const url of ['http://172.32.0.1:8088', 'http://11.0.0.1', 'http://localhost.example.com', 'http://192.168.1.20.example.com']) {
      Object.assign(process.env, devBase, { APP_BASE_URL: url, ALLOWED_ORIGINS: new URL(url).origin });
      expect(() => assertConfig(), url).toThrow(/APP_BASE_URL yerel değil/);
    }
  });

  it('üretimde bu kural uygulanmaz (üretim denetimleri ayrı)', () => {
    Object.assign(process.env, prodBase);
    expect(() => assertConfig()).not.toThrow();
  });
});

describe('ürün kaydı ve durum açılış denetimi (PRODUCT_LAUNCH)', () => {
  it('boş: kayıt geçerli, uyarı yok', () => {
    delete process.env.PRODUCT_LAUNCH;
    expect(assertConfig()).toEqual({ warnings: [] });
  });

  it('biçim hatası ve bilinmeyen ürün açılışı durdurur', () => {
    process.env.PRODUCT_LAUNCH = 'deciship=acik';
    expect(() => assertConfig()).toThrow(/PRODUCT_LAUNCH içinde deciship için bilinmeyen durum/);
    process.env.PRODUCT_LAUNCH = 'ornekarac=pilot';
    expect(() => assertConfig()).toThrow(/PRODUCT_LAUNCH içinde bilinmeyen ürün/);
  });

  it('rolü, sahip rolü ya da deploy.api olmayan ürünü açmak açılışı durdurur (geliştirmede de)', () => {
    // TagPress artık rollü ve sunuculu; rolsüz araç örneği OrderLoom (iki açılış durumu).
    for (const value of ['orderloom=pilot', 'orderloom=public']) {
      process.env.PRODUCT_LAUNCH = value;
      expect(() => assertConfig(), value).toThrow(/Ürün kaydı ya da PRODUCT_LAUNCH geçersiz/);
    }
  });

  it('public ürünü off yapmak açılışı durdurmaz, uyarı döner', () => {
    process.env.PRODUCT_LAUNCH = 'deciship=off';
    const { warnings } = assertConfig();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^deciship kayıtta public/);
  });

  it('üretim: kapalı olmayan her ürüne olay hedefi gerekir; kapalı ürüne gerekmez', () => {
    Object.assign(process.env, prodBase, { PRODUCT_EVENT_TARGETS: '', PRODUCT_LAUNCH: 'deciship=pilot' });
    expect(() => assertProductionConfig()).toThrow(/PRODUCT_EVENT_TARGETS içinde deciship adresi yok/);
    process.env.PRODUCT_LAUNCH = 'deciship=off';
    // Kayıtta `pilot` olan TagPress de açık sayılır: adresi yoksa durur.
    expect(() => assertProductionConfig()).toThrow(/PRODUCT_EVENT_TARGETS içinde tagpress adresi yok/);
    process.env.PRODUCT_LAUNCH = 'deciship=off,tagpress=off';
    expect(() => assertProductionConfig()).not.toThrow();
    // Uyarı yalnız public → off (DeciShip); pilot → off uyarı vermez.
    expect(assertConfig().warnings).toHaveLength(1);
  });

  it('süreç: geçersiz durum ayarıyla servis gerçekten çıkar', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, PRODUCT_LAUNCH: 'orderloom=pilot', PORT: '0' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Ürün kaydı ya da PRODUCT_LAUNCH geçersiz: orderloom/);
  });
});

describe('olay hedefleri (PRODUCT_EVENT_TARGETS, C4-K2)', () => {
  const devBase = { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:8088', ALLOWED_ORIGINS: 'http://localhost:8088', SITE_ORIGINS: 'http://localhost:8089' };
  const SECRET_URL = 'http://kul:gizli@deciship-api:4000/events';

  it('bilinmeyen ürün, tekrar, boş adres ve bozuk girdi her ortamda açılışı durdurur; adres (parola) metne yazılmaz', () => {
    const cases: [string, RegExp][] = [
      [`decship=${SECRET_URL}`, /PRODUCT_EVENT_TARGETS içinde bilinmeyen ürün: "decship"/],
      [`deciship=${SECRET_URL},deciship=http://b/events`, /PRODUCT_EVENT_TARGETS içinde deciship iki kez yazılmış/],
      ['deciship=', /PRODUCT_EVENT_TARGETS içinde deciship adresi boş/],
      [`deciship:${SECRET_URL}`, /PRODUCT_EVENT_TARGETS geçersiz: her girdi urun=adres biçiminde olmalı/],
    ];
    for (const base of [devBase, prodBase]) {
      for (const [value, expected] of cases) {
        Object.assign(process.env, base, { PRODUCT_EVENT_TARGETS: value });
        const label = `${base.NODE_ENV}: ${value}`;
        expect(() => assertConfig(), label).toThrow(expected);
        try {
          assertConfig();
        } catch (e) {
          expect((e as Error).message, label).not.toMatch(/gizli|kul:/);
        }
      }
    }
  });

  it('geliştirmede açık ürünün olay adresi yoksa açılır ama uyarır (olaylar bekler); kapalı ürün için uyarı yok', () => {
    Object.assign(process.env, devBase, { PRODUCT_EVENT_TARGETS: '' });
    delete process.env.PRODUCT_LAUNCH;
    // Kayıt sırasıyla: DeciShip (`public`) ve TagPress (`pilot`).
    expect(assertConfig().warnings).toEqual([
      expect.stringMatching(/^PRODUCT_EVENT_TARGETS içinde deciship adresi yok: .*bekler/),
      expect.stringMatching(/^PRODUCT_EVENT_TARGETS içinde tagpress adresi yok: .*bekler/),
    ]);
    process.env.PRODUCT_LAUNCH = 'deciship=off,tagpress=off';
    expect(assertConfig().warnings.filter((w) => w.includes('PRODUCT_EVENT_TARGETS'))).toEqual([]);
    process.env.PRODUCT_LAUNCH = '';
    Object.assign(process.env, { PRODUCT_EVENT_TARGETS: 'deciship=http://localhost:4000/api/deciship/internal/events' });
    expect(assertConfig().warnings).toEqual([expect.stringMatching(/^PRODUCT_EVENT_TARGETS içinde tagpress adresi yok: .*bekler/)]);
    Object.assign(process.env, { PRODUCT_EVENT_TARGETS: 'deciship=http://localhost:4000/api/deciship/internal/events,tagpress=http://localhost:5422/api/tagpress/internal/events' });
    expect(assertConfig().warnings).toEqual([]);
  });

  it('süreç: üretimde açık ürünün olay adresi yoksa servis gerçekten çıkar', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, ...prodBase, PRODUCT_EVENT_TARGETS: '', PRODUCT_LAUNCH: '', PRODUCT_NOTIFY_SECRETS: '', PORT: '0' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/PRODUCT_EVENT_TARGETS içinde deciship adresi yok: olaylar teslim edilemez\./);
  });
});

describe('araç bildirim anahtarları (PRODUCT_NOTIFY_SECRETS)', () => {
  const devBase = { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:8088', ALLOWED_ORIGINS: 'http://localhost:8088', SITE_ORIGINS: 'http://localhost:8089' };
  const strong = 's'.repeat(40);

  it('boş: harita boş, açılış durmaz (geliştirme ve üretim)', () => {
    Object.assign(process.env, devBase, { PRODUCT_NOTIFY_SECRETS: '' });
    expect(env.productNotifySecrets.size).toBe(0);
    expect(() => assertConfig()).not.toThrow();
    Object.assign(process.env, prodBase, { PRODUCT_NOTIFY_SECRETS: '' });
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('geçerli harita okunur; anahtarda = bulunabilir, boşluklar kırpılır', () => {
    Object.assign(process.env, devBase, { PRODUCT_NOTIFY_SECRETS: ` deciship = ${DEV_PRODUCT_NOTIFY_SECRET} , orderloom=abc==` });
    expect(() => assertConfig()).not.toThrow();
    expect([...env.productNotifySecrets]).toEqual([['deciship', DEV_PRODUCT_NOTIFY_SECRET], ['orderloom', 'abc==']]);
  });

  it('biçim, bilinmeyen ürün, iki kez yazılan ürün, boş ve ortak anahtar her ortamda açılışı durdurur; hata anahtarı göstermez', () => {
    const cases: [string, RegExp][] = [
      ['gizli-anahtar-biçimsiz', /her girdi urun=anahtar biçiminde/],
      ['=gizli-anahtar', /her girdi urun=anahtar biçiminde/],
      ['bilinmeyen=gizli-anahtar', /bilinmeyen ürün: "bilinmeyen"/],
      ['gizli-anahtar+/x=deciship', /bilinmeyen ürün: \(ad gösterilmedi\)/],
      ['deciship=gizli-anahtar,deciship=gizli-anahtar-2', /deciship iki kez yazılmış/],
      ['deciship=', /deciship anahtarı boş/],
      ['deciship=gizli-anahtar,orderloom=gizli-anahtar', /orderloom başka bir ürünle aynı anahtarı/],
    ];
    for (const [value, error] of cases) {
      Object.assign(process.env, devBase, { PRODUCT_NOTIFY_SECRETS: value });
      expect(() => assertConfig(), value).toThrow(error);
      try {
        assertConfig();
      } catch (e) {
        expect((e as Error).message, value).not.toMatch(/gizli-anahtar/);
      }
    }
  });

  it('üretim: kısa anahtar ve geliştirme anahtarı açılışı durdurur, uzun anahtar açılır', () => {
    Object.assign(process.env, prodBase, { PRODUCT_NOTIFY_SECRETS: `deciship=${'k'.repeat(31)}` });
    expect(() => assertProductionConfig()).toThrow(/deciship anahtarı üretimde en az 32 karakter/);
    process.env.PRODUCT_NOTIFY_SECRETS = `deciship=${DEV_PRODUCT_NOTIFY_SECRET}`;
    expect(() => assertProductionConfig()).toThrow(/deciship geliştirme anahtarını kullanıyor/);
    process.env.PRODUCT_NOTIFY_SECRETS = `deciship=${strong}`;
    expect(() => assertProductionConfig()).not.toThrow();
    expect(() => assertConfig()).not.toThrow();
  });

  it('geliştirmede kısa anahtar serbest (yalnız yerel)', () => {
    Object.assign(process.env, devBase, { PRODUCT_NOTIFY_SECRETS: 'deciship=kisa' });
    expect(() => assertConfig()).not.toThrow();
  });

  it('üretim: biçim sözleşmedeki isValidNotifySecret (32..512 görünür ASCII); DeciShip ile aynı kural, hata anahtarı göstermez', () => {
    const bad = [`gizli${'k'.repeat(27)} ek`, `gizli${'k'.repeat(30)}ç`, `gizli${'k'.repeat(508)}`, `gizli${'k'.repeat(27)}\u007f`];
    for (const secret of bad) {
      expect(isValidNotifySecret(secret), JSON.stringify(secret)).toBe(false);
      Object.assign(process.env, prodBase, { PRODUCT_NOTIFY_SECRETS: `deciship=${secret}` });
      expect(() => assertProductionConfig(), JSON.stringify(secret)).toThrow(/deciship anahtarı üretimde en az 32 karakter olmalı \(en çok 512, yalnız görünür ASCII/);
      try {
        assertProductionConfig();
      } catch (e) {
        expect((e as Error).message).not.toMatch(/gizli/);
      }
    }
    for (const secret of ['k'.repeat(32), `${'k'.repeat(511)}~`]) {
      expect(isValidNotifySecret(secret)).toBe(true);
      Object.assign(process.env, prodBase, { PRODUCT_NOTIFY_SECRETS: `deciship=${secret}` });
      expect(() => assertProductionConfig()).not.toThrow();
    }
    // geliştirmede biçim denetlenmez: yerel varsayılanlar bozulmaz
    Object.assign(process.env, devBase, { PRODUCT_NOTIFY_SECRETS: `deciship=${DEV_PRODUCT_NOTIFY_SECRET}` });
    expect(() => assertConfig()).not.toThrow();
  });
});

describe('compose: Hesap servisinin okuduğu her ortam değişkeni kaba ulaşır', () => {
  const API_ROOT = path.resolve(import.meta.dirname, '..');
  const PLATFORM = path.resolve(API_ROOT, '../..');
  /**
   * Bilerek compose'a yazılmayanlar. Boş değer bunlarda `Number('') = 0` olur (varsayılan değil): compose'a ancak açık
   * varsayılanla girer. Kod varsayılanı (1000 ms, 10 sn) kapta da geçerlidir.
   */
  const NOT_IN_COMPOSE: Record<string, string> = {
    DISPATCHER_INTERVAL_MS: 'kod varsayılanı 1000; boş değer 0 olur',
    REFRESH_REUSE_GRACE_SECONDS: 'kod varsayılanı 60; boş değer 0 olur',
  };

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'generated' ? [] : sourceFiles(p);
      return e.name.endsWith('.ts') ? [p] : [];
    });
  }

  /** `src` içinde okunan adlar. `process.env[...]` yalnız bilinen iki biçimde olabilir; yenisi gelirse test düşer. */
  function readNames(): Set<string> {
    const names = new Set<string>();
    for (const file of sourceFiles(path.join(API_ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
      for (const m of text.matchAll(/process\.env\[([^\]]+)\]/g)) {
        const rel = path.relative(API_ROOT, file).replaceAll('\\', '/');
        expect([`${rel}:name`, `${rel}:PRODUCT_LAUNCH_ENV`], `${rel}: process.env[${m[1]}]`).toContain(`${rel}:${m[1]}`);
        if (m[1] === 'PRODUCT_LAUNCH_ENV') names.add(PRODUCT_LAUNCH_ENV);
      }
    }
    return names;
  }

  /** `services.account-api.environment` anahtarları (düz metin: compose dosyası iki boşluk girintili). */
  function composeNames(file: string): Set<string> {
    const lines = fs.readFileSync(path.join(PLATFORM, file), 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => l === '  account-api:');
    expect(start, `${file}: account-api`).toBeGreaterThan(-1);
    const names = new Set<string>();
    let inEnv = false;
    for (const line of lines.slice(start + 1)) {
      if (/^ {0,2}\S/.test(line)) break; // sonraki servis ya da üst anahtar
      if (/^ {4}\S/.test(line)) inEnv = line.trim() === 'environment:';
      const m = inEnv ? /^ {6}([A-Z][A-Z0-9_]*):/.exec(line) : null;
      if (m) names.add(m[1]);
    }
    return names;
  }

  it('docker-compose.yml account-api ortamı okunan her adı içerir (istisnalar açık listede)', () => {
    const read = readNames();
    expect(read.has('PRODUCT_LAUNCH')).toBe(true);
    const composed = composeNames('docker-compose.yml');
    const missing = [...read].filter((n) => !composed.has(n) && !(n in NOT_IN_COMPOSE)).sort();
    expect(missing).toEqual([]);
    // İstisna listesi bayatlamasın: okunmayan ya da artık compose'da olan ad listede kalmaz.
    for (const n of Object.keys(NOT_IN_COMPOSE)) {
      expect(read.has(n), n).toBe(true);
      expect(composed.has(n), n).toBe(false);
    }
  });

  it('docker-compose.prod.yml acil durdurma ayarını taşır', () => {
    expect(composeNames('docker-compose.prod.yml').has('PRODUCT_LAUNCH')).toBe(true);
  });
});

describe('demo hesap koruması', () => {
  const demoEmail = `ek-${Date.now()}@${DEMO_EMAIL_DOMAIN}`;
  let personId: string;
  beforeEach(async () => {
    const p = await prisma.person.create({ data: { name: 'Demo Sınama', email: demoEmail, passwordHash: 'x' } });
    personId = p.id;
  });
  afterEach(async () => {
    await prisma.person.delete({ where: { id: personId } });
  });

  it('üretim ve yerel olmayan adreste demo kişi varsa durur', async () => {
    Object.assign(process.env, prodBase);
    await expect(assertNoDemoAccounts(prisma)).rejects.toThrow(/Üretim veritabanında demo hesap var .*Demo verisi canlıya taşınamaz/);
  });

  it('yerel adreste vermez', async () => {
    Object.assign(process.env, prodBase, { APP_BASE_URL: 'http://localhost:8088', ALLOWED_ORIGINS: 'http://localhost:8088' });
    await expect(assertNoDemoAccounts(prisma)).resolves.toBeUndefined();
  });

  it('geliştirmede vermez', async () => {
    Object.assign(process.env, prodBase, { NODE_ENV: 'development' });
    await expect(assertNoDemoAccounts(prisma)).resolves.toBeUndefined();
  });
});

describe('tohum', () => {
  it('yerel olmayan adreste reddedilir', () => {
    expect(() => assertSeedAllowed('development', 'https://app.example.com')).toThrow(/yerel/);
    expect(() => assertSeedAllowed('development', 'http://localhost:8088')).not.toThrow();
    expect(() => assertSeedAllowed('production', 'http://localhost:8088')).toThrow(/üretimde/);
  });

  it('demo kişileri doğrulanmış yazar', async () => {
    await seedDevData();
    const rows = await prisma.person.findMany({ where: { id: { in: SEED_PEOPLE.map((p) => p.id) } } });
    expect(rows).toHaveLength(SEED_PEOPLE.length);
    for (const row of rows) {
      const seed = SEED_PEOPLE.find((p) => p.id === row.id)!;
      expect(row.pendingEmail).toBeNull();
      if (seed.email) expect(row.emailVerifiedAt).not.toBeNull();
      else expect(row.emailVerifiedAt).toBeNull();
    }
    expect(Object.keys(SEED_ORGS).length).toBeGreaterThan(0);
  });
});
