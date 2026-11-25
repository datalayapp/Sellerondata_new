import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  AI_GATEWAY_PORT,
  AI_LIMIT_DEFAULTS,
  AI_PROVIDERS,
  aiProductKeys,
  hasDevPassword,
  isProductKey,
  type AiProvider,
  type ProductKey,
} from '@sellerondata/contracts';
import { masterKeyRing, type MasterKeyRing } from './keystore/seal.ts';

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

/**
 * Geliştirme ana anahtarı (32 bayt, base64). Yalnız yerelde ve testte; `AI_KEY_MASTER` boşken geliştirmede bu kullanılır, üretimde
 * açılış bu değeri reddeder. Bununla mühürlenmiş anahtar yerel veritabanında kalır, sunucuya taşınmaz.
 */
export const DEV_AI_KEY_MASTER = 'eWVyZWwtYWktYW5hLWFuYWh0YXJpLTAxMjM0NTY3ODk=';

/**
 * Geliştirme araç jetonlarının öneki (compose ve `scripts/dev.ps1` varsayılanları bununla başlar, ör. `yerel-gecit-deciship-…`).
 * Üretimde bu önekli jeton açılışı durdurur.
 */
export const DEV_TOOL_TOKEN_PREFIX = 'yerel-gecit-';

/** Araç jetonu biçimi: görünür ASCII, ayırıcı (`,` `=`) yok, 32..512 karakter. Kısa jeton her ortamda reddedilir. */
export const TOOL_TOKEN_PATTERN = /^[\x21-\x2b\x2d-\x3c\x3e-\x7e]{32,512}$/;

/** Sağlayıcıların gerçek adresi. Değiştirme (`ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL`) yalnız test ve geliştirmede: üretimde anahtar başka adrese gitmesin. */
export const PROVIDER_BASE_URLS: Readonly<Record<AiProvider, string>> = {
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};
const BASE_URL_ENV: Readonly<Record<AiProvider, string>> = { anthropic: 'ANTHROPIC_BASE_URL', gemini: 'GEMINI_BASE_URL' };

/** Üretimde ortamda olmaması gereken sağlayıcı anahtarları: anahtar yalnız geçidin deposundadır (`docker inspect` göstermesin). */
const FORBIDDEN_KEY_ENV = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

const DEV_ORIGINS = ['http://localhost:8088', 'http://localhost:5180'];

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `AI_GATEWAY_TOKENS=deciship=<jeton>,tagpress=<jeton>`: araç başına geçit jetonu. Ürün kayıtta olmalı ve geçidi kullanmalı
 * (kayıtta `ai` girdisi), bir kez yazılır; jeton biçime uymalı ve iki araçta aynı olamaz (ürün jetondan çözülür). Hata metni jetonu
 * içermez.
 */
export function parseToolTokens(value: string | undefined): Map<ProductKey, string> {
  const out = new Map<ProductKey, string>();
  const seen = new Set<string>();
  const allowed = new Set<string>(aiProductKeys());
  for (const part of list(value)) {
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    const token = eq < 0 ? '' : part.slice(eq + 1).trim();
    if (!isProductKey(name)) throw new Error(`AI_GATEWAY_TOKENS: kayıtta olmayan ürün "${name.slice(0, 20)}"`);
    if (!allowed.has(name)) throw new Error(`AI_GATEWAY_TOKENS: ${name} kayıtta geçidi kullanmıyor (ai girdisi yok)`);
    if (out.has(name)) throw new Error(`AI_GATEWAY_TOKENS: ${name} iki kez yazılmış`);
    if (!TOOL_TOKEN_PATTERN.test(token)) throw new Error(`AI_GATEWAY_TOKENS: ${name} jetonu geçersiz (32..512 görünür karakter, virgül ve = yok)`);
    if (seen.has(token)) throw new Error(`AI_GATEWAY_TOKENS: ${name} jetonu başka araçla aynı`);
    seen.add(token);
    out.set(name, token);
  }
  return out;
}

function usd(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}: negatif olmayan sayı olmalı`);
  return n;
}

let ringCache: { source: string; ring: MasterKeyRing } | null = null;

/** Değerler her okumada ortamdan gelir: testler değiştirebilir. */
export const env = {
  get isProduction() {
    return process.env.NODE_ENV === 'production' || process.env.SOD_ENV === 'production';
  },
  get port() {
    return Number(process.env.PORT ?? AI_GATEWAY_PORT);
  },
  get host() {
    return process.env.HOST ?? '::';
  },
  get databaseUrl() {
    return process.env.DATABASE_URL ?? 'postgresql://sod_ai:sod_ai_dev@localhost:5434/sellerondata';
  },
  get jwksUrl() {
    return process.env.ACCOUNT_JWKS_URL?.trim() || 'http://localhost:4100/api/account/.well-known/jwks.json';
  },
  get allowedOrigins(): Set<string> {
    const configured = list(process.env.ALLOWED_ORIGINS);
    const origins = configured.length ? configured : this.isProduction ? [] : DEV_ORIGINS;
    return new Set(origins.map((o) => o.replace(/\/$/, '').toLowerCase()));
  },
  /** Yalnız bilinen vekil sayısı kadar güvenilir (gateway: 1). */
  get trustProxyHops() {
    const raw = process.env.TRUST_PROXY_HOPS?.trim();
    return raw ? Number(raw) : 0;
  },
  get toolTokens(): Map<ProductKey, string> {
    return parseToolTokens(process.env.AI_GATEWAY_TOKENS);
  },
  /**
   * Ana anahtar halkası: `AI_KEY_MASTER` (mühürleyen) + `AI_KEY_MASTER_PREVIOUS` (virgüllü; döndürmede yalnız açmak için).
   * Geliştirmede `AI_KEY_MASTER` boşsa `DEV_AI_KEY_MASTER`; üretimde zorunlu (`assertConfig`).
   */
  get keyRing(): MasterKeyRing {
    const current = process.env.AI_KEY_MASTER?.trim() || (this.isProduction ? '' : DEV_AI_KEY_MASTER);
    if (!current) throw new Error('AI_KEY_MASTER yok (32 bayt, base64)');
    const previous = process.env.AI_KEY_MASTER_PREVIOUS?.trim() ?? '';
    const source = `${current}|${previous}`;
    if (ringCache?.source !== source) ringCache = { source, ring: masterKeyRing(current, previous) };
    return ringCache.ring;
  },
  get providerBaseUrls(): Record<AiProvider, string> {
    const out = { ...PROVIDER_BASE_URLS };
    for (const p of AI_PROVIDERS) {
      const v = process.env[BASE_URL_ENV[p]]?.trim();
      if (v) out[p] = v.replace(/\/+$/, '');
    }
    return out;
  },
  /** Platform ve firma tavanları (USD) [V]; yönetici ekranı platform tavanlarını ve firma hakkını ezer (G3). */
  get limits() {
    return {
      platformDailyUsd: usd('AI_PLATFORM_DAILY_USD', AI_LIMIT_DEFAULTS.platformDailyUsd),
      platformMonthlyUsd: usd('AI_PLATFORM_MONTHLY_USD', AI_LIMIT_DEFAULTS.platformMonthlyUsd),
      orgMonthlyUsd: usd('AI_ORG_MONTHLY_USD', AI_LIMIT_DEFAULTS.orgMonthlyUsd),
    };
  },
};

/**
 * Açılış denetimi. Hata fırlatır (servis açılmaz); uyarıları döner. Hata metinleri gizli değer içermez.
 * Üretimde: geliştirme parolası, geliştirme ana anahtarı ya da jetonu, eksik köken listesi, sağlayıcı adresi değiştirme ve ortamdaki
 * sağlayıcı anahtarı açılışı durdurur.
 */
export function assertConfig(): { warnings: string[] } {
  const warnings: string[] = [];
  const problems: string[] = [];
  let tokens = new Map<ProductKey, string>();
  try {
    tokens = env.toolTokens;
  } catch (e) {
    problems.push((e as Error).message);
  }
  try {
    void env.keyRing;
  } catch (e) {
    problems.push((e as Error).message);
  }
  try {
    void env.limits;
  } catch (e) {
    problems.push((e as Error).message);
  }
  for (const p of AI_PROVIDERS) {
    const v = process.env[BASE_URL_ENV[p]]?.trim();
    if (!v) continue;
    let url: URL | null = null;
    try {
      url = new URL(v);
    } catch {
      problems.push(`${BASE_URL_ENV[p]} geçerli bir adres değil`);
    }
    if (url && env.isProduction) problems.push(`${BASE_URL_ENV[p]} üretimde kullanılamaz (anahtar yalnız sağlayıcının gerçek adresine gider)`);
    else if (url) warnings.push(`${BASE_URL_ENV[p]} değiştirilmiş: ${p} çağrıları ${url.origin} adresine gidiyor (yalnız geliştirme ve test)`);
  }
  if (env.isProduction) {
    if (hasDevPassword(env.databaseUrl)) problems.push('DATABASE_URL geliştirme parolası taşıyor (*_dev)');
    if (!process.env.AI_KEY_MASTER?.trim()) problems.push('AI_KEY_MASTER üretimde zorunlu');
    else if (process.env.AI_KEY_MASTER.trim() === DEV_AI_KEY_MASTER) problems.push('AI_KEY_MASTER geliştirme anahtarı; üretimde kullanılamaz');
    if (list(process.env.AI_KEY_MASTER_PREVIOUS).includes(DEV_AI_KEY_MASTER)) problems.push('AI_KEY_MASTER_PREVIOUS geliştirme anahtarını içeriyor');
    for (const [product, token] of tokens) {
      if (token.startsWith(DEV_TOOL_TOKEN_PREFIX)) problems.push(`AI_GATEWAY_TOKENS: ${product} geliştirme jetonu; üretimde kullanılamaz`);
    }
    if (env.allowedOrigins.size === 0) problems.push('ALLOWED_ORIGINS üretimde zorunlu');
    if (!process.env.ACCOUNT_JWKS_URL?.trim()) problems.push('ACCOUNT_JWKS_URL üretimde zorunlu');
    for (const name of FORBIDDEN_KEY_ENV) {
      if (process.env[name]?.trim()) problems.push(`${name} ortamda: sağlayıcı anahtarı yalnız geçidin deposunda durur (Merkez › Platform › Yapay zekâ ya da ai-key komutu)`);
    }
  } else {
    if (!process.env.AI_KEY_MASTER?.trim()) warnings.push('AI_KEY_MASTER yok: geliştirme ana anahtarı kullanılıyor (yalnız yerel)');
    for (const name of FORBIDDEN_KEY_ENV) {
      if (process.env[name]?.trim()) warnings.push(`${name} ortamda ama okunmaz: anahtar geçidin deposundan gelir`);
    }
  }
  if (tokens.size === 0) warnings.push('AI_GATEWAY_TOKENS boş: hiçbir araç geçidi kullanamaz');
  if (problems.length) throw new Error(`ai-api açılamadı:\n- ${problems.join('\n- ')}`);
  return { warnings };
}
