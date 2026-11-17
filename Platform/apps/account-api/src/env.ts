import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  DEV_PRODUCT_NOTIFY_SECRET,
  NOTIFY_SECRET_MAX_LENGTH,
  NOTIFY_SECRET_MIN_LENGTH,
  ORG_PURGE_DAYS_DEFAULT,
  PRODUCT_KEYS,
  hasDevPassword,
  isProductKey,
  isValidNotifySecret,
  strictVersion,
  type ProductKey,
  type SignupMode,
} from '@sellerondata/contracts';
import { assertLaunchConfig, isProductOn } from './lib/launch.ts';

/** Platform kökünü bulur (kaynak, dist ve imaj içinde çalışır). */
function findPlatformRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'packages', 'contracts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PLATFORM_ROOT = findPlatformRoot();
loadEnv({ path: path.join(PLATFORM_ROOT, '.env'), quiet: true });

const BOOLEANS = new Set(['true', 'false', '1', '0']);
/** Geliştirmede kod özeti için sabit biber. Üretimde kullanılmaz: `ACCOUNT_CODE_PEPPER` zorunlu. */
const DEV_CODE_PEPPER = 'sod-gelistirme-biberi-uretimde-kullanilmaz';

function flag(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (!v) return fallback;
  return v === 'true' || v === '1';
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `deciship=http://...,orderloom=http://...`: araç başına olay adresi. Her ortamda: ürün kayıtta olmalı, bir kez yazılır, adres boş
 * olamaz (C4-K2: yanlış yazılmış ürün adı sessizce yok sayılıp olaylar yığılmasın). Hata metni adresi içermez (parola taşıyabilir).
 * Açık ürünün adresi yoksa üretimde açılış durur (`assertProductionConfig`), geliştirmede uyarı (`eventTargetWarnings`).
 */
export function parseEventTargets(value: string | undefined): Map<string, string> {
  const targets = new Map<string, string>();
  for (const part of list(value)) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error('PRODUCT_EVENT_TARGETS geçersiz: her girdi urun=adres biçiminde olmalı');
    const key = part.slice(0, eq).trim();
    const target = part.slice(eq + 1).trim().replace(/\/$/, '');
    const shown = /^[a-z][a-z0-9-]{0,31}$/.test(key) ? `"${key}"` : '(ad gösterilmedi)';
    if (!isProductKey(key)) throw new Error(`PRODUCT_EVENT_TARGETS içinde bilinmeyen ürün: ${shown} (kayıtta: ${PRODUCT_KEYS.join(', ')})`);
    if (targets.has(key)) throw new Error(`PRODUCT_EVENT_TARGETS içinde ${key} iki kez yazılmış`);
    if (!target) throw new Error(`PRODUCT_EVENT_TARGETS içinde ${key} adresi boş`);
    targets.set(key, target);
  }
  return targets;
}

/** Kapalı olmayan (pilot ya da public) ve olay adresi olmayan ürünler, kayıt sırasıyla. */
function productsWithoutEventTarget(): ProductKey[] {
  const targets = env.eventTargets;
  return PRODUCT_KEYS.filter((key) => isProductOn(key) && !targets.has(key));
}

/** Geliştirme: adresi olmayan açık ürün açılışı durdurmaz, olaylar teslim satırında bekler; sessiz kalmasın diye uyarı. */
function eventTargetWarnings(): string[] {
  if (env.isProduction) return [];
  return productsWithoutEventTarget().map(
    (key) => `PRODUCT_EVENT_TARGETS içinde ${key} adresi yok: olaylar teslim edilmiyor, adres yazılana dek bekler (üretimde açılış durur).`,
  );
}

/**
 * `deciship=<anahtar>,orderloom=<anahtar>`: araç başına bildirim anahtarı (`POST /api/account/internal/notify`, Mesaj 14 §4.5).
 * Her ortamda: ürün kayıtta olmalı, ürün bir kez yazılır, anahtar boş olamaz, iki ürün aynı anahtarı paylaşamaz (biri ötekinin
 * adına posta isteyemesin). Hata metni anahtarı içermez. Uzunluk ve geliştirme anahtarı üretimde denetlenir (`assertProductionConfig`).
 */
export function parseNotifySecrets(value: string | undefined): Map<ProductKey, string> {
  const secrets = new Map<ProductKey, string>();
  for (const part of list(value)) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error('PRODUCT_NOTIFY_SECRETS geçersiz: her girdi urun=anahtar biçiminde olmalı');
    const key = part.slice(0, eq).trim();
    const secret = part.slice(eq + 1).trim();
    // Sol taraf yanlışlıkla anahtar olabilir: yalnız ürün anahtarına benzeyen ad metne girer.
    const shown = /^[a-z][a-z0-9-]{0,31}$/.test(key) ? `"${key}"` : '(ad gösterilmedi)';
    if (!isProductKey(key)) throw new Error(`PRODUCT_NOTIFY_SECRETS içinde bilinmeyen ürün: ${shown}`);
    if (secrets.has(key)) throw new Error(`PRODUCT_NOTIFY_SECRETS içinde ${key} iki kez yazılmış`);
    if (!secret) throw new Error(`PRODUCT_NOTIFY_SECRETS içinde ${key} anahtarı boş`);
    if ([...secrets.values()].includes(secret)) throw new Error(`PRODUCT_NOTIFY_SECRETS içinde ${key} başka bir ürünle aynı anahtarı kullanıyor`);
    secrets.set(key, secret);
  }
  return secrets;
}

const DEV_ORIGINS = ['http://localhost:8088', 'http://localhost:5180'];
/** Tanıtım sitesi: gateway arkasındaki nginx (8089) ve `npm run dev` (5190). */
const DEV_SITE_ORIGINS = ['http://localhost:8089', 'http://localhost:5190'];

function originSet(values: string[]): Set<string> {
  return new Set(values.map((o) => o.replace(/\/$/, '').toLowerCase()));
}

/** Değerler her okumada ortamdan gelir: testler anahtar değiştirebilir. */
export const env = {
  get nodeEnv() {
    return process.env.NODE_ENV ?? 'development';
  },
  get isProduction() {
    return this.nodeEnv === 'production';
  },
  get databaseUrl() {
    return process.env.DATABASE_URL ?? 'postgresql://sod_platform:sod_platform_dev@localhost:5434/sellerondata';
  },
  get port() {
    return Number(process.env.PORT ?? 4100);
  },
  get host() {
    return process.env.HOST ?? '::';
  },
  get appBaseUrl() {
    return (process.env.APP_BASE_URL?.trim() || 'http://localhost:8088').replace(/\/$/, '');
  },
  get allowedOrigins(): Set<string> {
    const configured = list(process.env.ALLOWED_ORIGINS);
    const origins = configured.length ? configured : this.isProduction ? [] : DEV_ORIGINS;
    return originSet(origins);
  },
  /**
   * Tanıtım sitesinin kökenleri. Yalnız `config.siteOrigin` işaretli uçlarda (site-session, logout) CORS ve CSRF'i geçer;
   * başka hiçbir uçta uygulama kökeni sayılmaz. Üretimde zorunlu.
   */
  get siteOrigins(): Set<string> {
    const configured = list(process.env.SITE_ORIGINS);
    const origins = configured.length ? configured : this.isProduction ? [] : DEV_SITE_ORIGINS;
    return originSet(origins);
  },
  get cookieSecure() {
    return flag(process.env.COOKIE_SECURE, this.isProduction);
  },
  get cookieLangDomain() {
    return process.env.COOKIE_LANG_DOMAIN?.trim() || undefined;
  },
  get registrationEnabled() {
    return flag(process.env.REGISTRATION_ENABLED, true);
  },
  /**
   * Yeni firma kaydının kipi (kullanıcı kararı 2026-11-12, kapalı deneme). `invite`: kayıt yalnız `signup:invite` ile üretilen
   * davetle, `POST /orgs` kapalı. Varsayılan üretimde `invite` (canlıya yanlışlıkla açık kayıtla çıkılmasın), geliştirme ve
   * testte `open`. Bozuk değeri `assertConfig` durdurur. `REGISTRATION_ENABLED=false` her kipte önce gelir (kayıt tamamen kapalı).
   */
  get signupMode(): SignupMode {
    const v = process.env.SIGNUP_MODE?.trim().toLowerCase();
    if (v === 'open' || v === 'invite') return v;
    return this.isProduction ? 'invite' : 'open';
  },
  get emailVerificationRequired() {
    return flag(process.env.EMAIL_VERIFICATION_REQUIRED, true);
  },
  /** Geliştirmede posta `MailLog`'a düşer (SMTP yok). Üretimde yok sayılır. */
  get devMailbox() {
    return flag(process.env.DEV_MAILBOX, false);
  },
  /** Oturum ailesinin üst yaşı (gün): yenileme zinciri bunu aşamaz. */
  get sessionMaxAgeDays() {
    const raw = process.env.SESSION_MAX_AGE_DAYS?.trim();
    return raw ? Number(raw) : 90;
  },
  /**
   * Kapatılan firmanın saklama süresi (gün): bu sürede sahip geri açabilir, sonra firma kalıcı silinir.
   * Varsayılan 30 (`ORG_PURGE_DAYS_DEFAULT`); ince ayar, KALANLAR "Yayından önce".
   */
  get orgPurgeDays() {
    const raw = process.env.ORG_PURGE_DAYS?.trim();
    return raw ? Number(raw) : ORG_PURGE_DAYS_DEFAULT;
  },
  get mailEnabled() {
    return Boolean(this.smtpUrl) || (!this.isProduction && this.devMailbox);
  },
  /** Posta gerçek adrese gider mi: yalnız SMTP tanımlıysa. Geliştirme kutusu (DEV_MAILBOX) gerçek gönderim değildir. */
  get mailDelivers() {
    return Boolean(this.smtpUrl);
  },
  get smtpUrl() {
    return process.env.SMTP_URL?.trim() || undefined;
  },
  get mailFrom() {
    return process.env.MAIL_FROM?.trim() || 'SellerOnData <no-reply@sellerondata.com>';
  },
  get eventTargets(): Map<string, string> {
    return parseEventTargets(process.env.PRODUCT_EVENT_TARGETS);
  },
  /**
   * Araç bildirim anahtarları (`PRODUCT_NOTIFY_SECRETS`). Haritada olmayan ürünün isteği 401 alır; boş harita: bildirim ucu kapalı.
   * Karşılaştırma uçta sabit sürede yapılır; anahtar günlüğe yazılmaz.
   */
  get productNotifySecrets(): Map<ProductKey, string> {
    return parseNotifySecrets(process.env.PRODUCT_NOTIFY_SECRETS);
  },
  /** X-Forwarded-For içinde güvenilen vekil sayısı. `true` değildir: sol taraftaki değer istemcinin yazabildiği alandır. */
  get trustProxyHops() {
    return Number(process.env.TRUST_PROXY_HOPS ?? 0);
  },
  get dispatcherIntervalMs() {
    return Number(process.env.DISPATCHER_INTERVAL_MS ?? 1000);
  },
  /**
   * Döndürülmüş yenileme jetonunun aileyi iptal etmeden kabul edildiği en uzun süre (çoklu sekme, kayıp yanıt). Ek koşul olaydır:
   * yeni jeton henüz kullanılmamış olmalı (`refreshSession`). Varsayılan 60 sn: mobilin yenileme denemeleri (ilk 6 sn, iki tekrar,
   * 7 sn pencere) yavaş ağda sunucuya geç varsa da içine sığar (04-B1; önceki varsayılan 10 sn). Aynı tekrar anahtarıyla gelen
   * istekte (`retryKey`, 6.8) bu süre aranmaz; süre anahtarsız istemciler (web, eski mobil sürüm) ve anahtarı bilmeyen kopya içindir.
   */
  get refreshReuseGraceSeconds() {
    return Number(process.env.REFRESH_REUSE_GRACE_SECONDS ?? 60);
  },
  get keysDir() {
    return process.env.ACCOUNT_KEYS_DIR?.trim() || path.join(PLATFORM_ROOT, 'keys');
  },
  get codePepper() {
    return process.env.ACCOUNT_CODE_PEPPER?.trim() || DEV_CODE_PEPPER;
  },
  /** Biber dönüşünde önceki biber: 72 saat (kod ömrü) sonra kaldırılır. */
  get codePepperPrevious() {
    return process.env.ACCOUNT_CODE_PEPPER_PREVIOUS?.trim() || undefined;
  },
  /** En düşük desteklenen mobil sürüm (katı x.y.z, `strictVersion`). Boş ya da bozuk: denetim yok (üretimde bozuk değer açılışı durdurur). */
  get minMobileVersion() {
    return strictVersion(process.env.MIN_MOBILE_VERSION);
  },
  get mobileLatestVersion() {
    return strictVersion(process.env.MOBILE_LATEST_VERSION);
  },
  get mobileUpdateUrl() {
    return process.env.MOBILE_UPDATE_URL?.trim() || null;
  },
  get signingKey() {
    return process.env.ACCOUNT_SIGNING_KEY?.trim() || undefined;
  },
  get previousPublicKeys() {
    return process.env.ACCOUNT_PREVIOUS_PUBLIC_KEYS?.trim() || undefined;
  },
};

/**
 * Yanlış yazılmış ayar sessizce varsayılana düşmesin. Her ortamda açılışta çalışır.
 * Ürün kaydı ve `PRODUCT_LAUNCH` de burada denetlenir (`assertLaunchConfig`): hata servisi durdurur, uyarılar döner ve
 * çağıran günlüğe yazar (ör. kayıtta public olan ürünün `off`a çekilmesi; geliştirmede olay adresi olmayan açık ürün).
 */
export function assertConfig(): { warnings: string[] } {
  for (const name of ['REGISTRATION_ENABLED', 'EMAIL_VERIFICATION_REQUIRED', 'COOKIE_SECURE', 'DEV_MAILBOX']) {
    const value = process.env[name]?.trim().toLowerCase();
    if (value && !BOOLEANS.has(value)) throw new Error(`${name} geçersiz: true veya false olmalı`);
  }
  // Yanlış yazılmış kip (`davet`, `closed`) varsayılana düşmesin: kapalı denemede yanlışlıkla açık kayıt olmasın.
  const signupMode = process.env.SIGNUP_MODE?.trim().toLowerCase();
  if (signupMode && signupMode !== 'open' && signupMode !== 'invite') throw new Error('SIGNUP_MODE geçersiz: open veya invite olmalı');
  for (const name of ['PORT', 'TRUST_PROXY_HOPS', 'DISPATCHER_INTERVAL_MS', 'REFRESH_REUSE_GRACE_SECONDS']) {
    const value = process.env[name]?.trim();
    if (value && !/^\d+$/.test(value)) throw new Error(`${name} geçersiz: sıfır veya pozitif tam sayı olmalı`);
  }
  const maxAge = process.env.SESSION_MAX_AGE_DAYS?.trim();
  if (maxAge && (!/^\d+$/.test(maxAge) || Number(maxAge) < 1 || Number(maxAge) > 3650)) {
    throw new Error('SESSION_MAX_AGE_DAYS geçersiz: 1 ile 3650 arasında tam sayı olmalı');
  }
  const purgeDays = process.env.ORG_PURGE_DAYS?.trim();
  if (purgeDays && (!/^\d+$/.test(purgeDays) || Number(purgeDays) < 1 || Number(purgeDays) > 3650)) {
    throw new Error('ORG_PURGE_DAYS geçersiz: 1 ile 3650 arasında tam sayı olmalı');
  }
  env.eventTargets; // biçim hatası burada görünür
  env.productNotifySecrets; // biçim, bilinmeyen ürün ve ortak anahtar her ortamda burada durur
  // Üretim olay hedefi koşulu geçerli duruma bakar: önce durum ayarı doğrulanır.
  const launch = assertLaunchConfig();
  assertMobileVersions();
  assertSiteOrigins();
  assertDevelopmentIsLocal();
  assertProductionConfig();
  return { warnings: [...launch.warnings, ...eventTargetWarnings()] };
}

/** Mobil sürüm ayarları x.y.z olmalı. Üretimde bozuk değer servisi durdurur, geliştirmede uyarı verilir. */
export function assertMobileVersions() {
  for (const name of ['MIN_MOBILE_VERSION', 'MOBILE_LATEST_VERSION']) {
    const value = process.env[name]?.trim();
    if (!value || strictVersion(value)) continue;
    const message = `${name} geçersiz: x.y.z biçiminde olmalı (ör. 1.1.0)`;
    if (env.isProduction) throw new Error(message);
    console.warn(`[uyarı] ${message}; yok sayılacak.`);
  }
}

/**
 * Yerel ya da yerel ağ adı: geri döngü (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) ve özel ağ IPv4'ü
 * (10/8, 172.16/12, 192.168/16; telefonla sınama için). Alan adı benzerleri (`localhost.example.com`) yerel değildir.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTS.includes(host) || host.endsWith('.localhost')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Üretim dışı mod yalnız yerel adreste açılır. Ana compose `NODE_ENV=development` ve geliştirme posta kutusuyla gelir: üretim katmanı
 * olmadan canlı adrese çıkılırsa sıfırlama bağlantıları `MailLog`'a düşer, üretim denetimlerinin hiçbiri çalışmaz.
 */
function assertDevelopmentIsLocal() {
  if (env.isProduction) return;
  let hostname: string;
  try {
    hostname = new URL(env.appBaseUrl).hostname;
  } catch {
    throw new Error(`APP_BASE_URL geçersiz: "${env.appBaseUrl}" tam adres olmalı, ör. http://localhost:8088`);
  }
  if (!isLocalHostname(hostname)) {
    throw new Error(
      `APP_BASE_URL yerel değil (${env.appBaseUrl}) ama NODE_ENV=${env.nodeEnv || '(boş)'}: geliştirme modu canlı adreste açılmaz ` +
        "(postalar MailLog'a düşer, üretim denetimleri çalışmaz). Canlıda NODE_ENV=production ve docker-compose.prod.yml kullanın.",
    );
  }
}

export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * SITE_ORIGINS her girdisi yalın köken olmalı (`https://sellerondata.com`): yol, joker veya `null` kökeni kabul edilmez.
 * Üretimde https zorunlu; yerel üretim sınaması için yalnız localhost serbest (APP_BASE_URL ile aynı kural).
 */
function assertSiteOrigins() {
  for (const raw of list(process.env.SITE_ORIGINS)) {
    const value = raw.replace(/\/$/, '').toLowerCase();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`SITE_ORIGINS geçersiz: "${raw}" tam köken olmalı, ör. https://sellerondata.com`);
    }
    // Joker (`https://*.site`) URL ayrıştırıcısından geçer: alan adı harf, rakam, nokta ve tireyle sınırlanır.
    const plainHost = /^[a-z0-9.-]+$/.test(url.hostname) || /^\[[0-9a-f:.]+\]$/.test(url.hostname);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value || !plainHost) {
      throw new Error(`SITE_ORIGINS geçersiz: "${raw}" yalnız köken olmalı (şema + alan adı + isteğe bağlı port, yol yok)`);
    }
    if (env.isProduction && url.protocol !== 'https:' && !LOCAL_HOSTS.includes(url.hostname)) {
      throw new Error(`SITE_ORIGINS üretimde https olmalı: "${raw}". Site oturumu düz HTTP üzerinden okunamaz.`);
    }
  }
  // Site kökeni ALLOWED_ORIGINS'e de yazılırsa uygulama kökeni sayılır ve her uçta CSRF'i geçer: sitedeki üçüncü taraf betik hesabı yönetebilirdi.
  const overlap = [...env.siteOrigins].filter((o) => env.allowedOrigins.has(o));
  if (overlap.length) {
    throw new Error(`SITE_ORIGINS ile ALLOWED_ORIGINS çakışıyor (${overlap.join(', ')}): tanıtım sitesi uygulama kökeni olamaz.`);
  }
}

/** Üretimde yerel adres: yerel üretim sınaması için serbest, bu yüzden açılış durmaz. Ama gerçek kurulumda postalardaki bağlantılar çalışmaz, söylenir. */
export function localAddressWarning(): string | null {
  if (!env.isProduction) return null;
  try {
    if (!LOCAL_HOSTS.includes(new URL(env.appBaseUrl).hostname)) return null;
  } catch {
    return null;
  }
  return `UYARI: üretim modu yerel adresle açıldı (APP_BASE_URL=${env.appBaseUrl}). Yalnız yerel sınama içindir: kullanıcıya giden davet ve şifre bağlantıları bu adrese gider, çalışmaz.`;
}

/**
 * Oturum çerezi Secure: tarayıcı düz HTTP'de saklamaz, kayıt başarılı görünür ama kimse giriş yapamaz.
 * Köken ALLOWED_ORIGINS'te yoksa çerezli her yazma 403 alır. İkisi de açılışta söylenir.
 * Tarayıcılar localhost'u güvenli saydığı için yerel sınama serbest.
 */
function assertPublicAddress() {
  let url: URL;
  try {
    url = new URL(env.appBaseUrl);
  } catch {
    throw new Error('APP_BASE_URL geçersiz: tam adres olmalı, ör. https://alan-adiniz');
  }
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.includes(url.hostname)) {
    throw new Error('APP_BASE_URL üretimde https olmalı: oturum çerezi Secure, düz HTTP ile saklanmaz ve giriş yapılamaz.');
  }
  if (!env.allowedOrigins.has(url.origin)) {
    throw new Error(`ALLOWED_ORIGINS uygulamanın kökenini içermeli (${url.origin}): yoksa çerezli her yazma isteği reddedilir.`);
  }
}

/** Üretimde eksik ayar açılışta durdurur, ilk istekte değil. */
export function assertProductionConfig() {
  if (!env.isProduction) return;
  const missing: string[] = [];
  if (!process.env.ALLOWED_ORIGINS?.trim()) missing.push('ALLOWED_ORIGINS');
  if (!process.env.APP_BASE_URL?.trim()) missing.push('APP_BASE_URL');
  if (!process.env.DATABASE_URL?.trim()) missing.push('DATABASE_URL');
  // Geliştirme varsayılanı (localhost) üretimde sessizce devreye girmesin: site kökeni açıkça yazılır.
  if (!list(process.env.SITE_ORIGINS).length) missing.push('SITE_ORIGINS');
  if (missing.length) throw new Error(`Üretimde zorunlu ayar eksik: ${missing.join(', ')}`);
  assertSiteOrigins();
  assertPublicAddress();
  if (hasDevPassword(env.databaseUrl)) throw new Error('DATABASE_URL geliştirme parolası taşıyor (*_dev). Üretimde kullanılamaz.');
  if ((process.env.ACCOUNT_CODE_PEPPER?.trim().length ?? 0) < 32) throw new Error('ACCOUNT_CODE_PEPPER üretimde zorunlu, en az 32 karakter.');
  if (env.codePepper === DEV_CODE_PEPPER || env.codePepperPrevious === DEV_CODE_PEPPER) {
    throw new Error('Geliştirme biberi üretimde kullanılamaz (ACCOUNT_CODE_PEPPER, ACCOUNT_CODE_PEPPER_PREVIOUS).');
  }
  const secure = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (secure === 'false' || secure === '0') throw new Error('COOKIE_SECURE=false üretimde kullanılamaz: oturum çerezi düz HTTP ile gider.');
  // Posta yoksa "şifremi unuttum" ve davetler sessizce çalışmaz: kullanıcıya "gönderildi" denip gönderilmez.
  if (!env.smtpUrl) throw new Error('SMTP_URL üretimde zorunlu: şifre sıfırlama ve davet postası gönderilemez.');
  if (!env.emailVerificationRequired) throw new Error('EMAIL_VERIFICATION_REQUIRED üretimde true olmalı: doğrulanmamış e-postayla hesap kullanılamaz.');
  // Bildirim anahtarı tahmin edilemez olmalı: sızan ya da kısa anahtarla bir firmanın üyelerine posta istenebilir.
  // Kural sözleşmede (`isValidNotifySecret`); DeciShip `missingProductionEnv` aynısını kullanır.
  for (const [key, secret] of env.productNotifySecrets) {
    if (secret === DEV_PRODUCT_NOTIFY_SECRET) throw new Error(`PRODUCT_NOTIFY_SECRETS içinde ${key} geliştirme anahtarını kullanıyor: üretimde kullanılamaz.`);
    if (!isValidNotifySecret(secret)) {
      throw new Error(
        `PRODUCT_NOTIFY_SECRETS içinde ${key} anahtarı üretimde en az ${NOTIFY_SECRET_MIN_LENGTH} karakter olmalı (en çok ${NOTIFY_SECRET_MAX_LENGTH}, yalnız görünür ASCII, boşluksuz).`,
      );
    }
  }
  // Kapalı olmayan (pilot ya da public) her ürüne olay gitmeli: adres yoksa üyelik ve firma değişiklikleri ürüne ulaşmaz.
  // Adres açıkça yazılır; kayıttan varsayılan yok (Mesaj 8 kuralı).
  const [untargeted] = productsWithoutEventTarget();
  if (untargeted) throw new Error(`PRODUCT_EVENT_TARGETS içinde ${untargeted} adresi yok: olaylar teslim edilemez.`);
  // Olay gövdesi üye adı ve rol taşır (03-B13): yanlış yazılmış adres 72 saat boyunca yanlış yere denenmesin. Adres yalın
  // http(s) olmalı; kullanıcı adı, parola, sorgu ve parça taşımaz. Adres metne yazılmaz (parola taşıyor olabilir).
  for (const [key, target] of env.eventTargets) {
    let url: URL | null = null;
    try {
      url = new URL(target);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error(`PRODUCT_EVENT_TARGETS içinde ${key} adresi geçersiz: yalın http(s) adresi olmalı (kullanıcı adı, parola, sorgu yok).`);
    }
  }
}
