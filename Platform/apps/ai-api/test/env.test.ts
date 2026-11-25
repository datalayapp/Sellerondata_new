import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertConfig, DEV_AI_KEY_MASTER, DEV_TOOL_TOKEN_PREFIX, env, parseToolTokens } from '../src/env.ts';

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

const tok = (p: string) => `${p}-${randomBytes(16).toString('hex')}`;

function productionEnv() {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://sod_ai:gercek-parola@postgres:5432/sellerondata';
  process.env.AI_KEY_MASTER = randomBytes(32).toString('base64');
  process.env.AI_KEY_MASTER_PREVIOUS = '';
  process.env.AI_GATEWAY_TOKENS = `deciship=${tok('d')},tagpress=${tok('t')}`;
  process.env.ALLOWED_ORIGINS = 'https://app.sellerondata.com';
  process.env.ACCOUNT_JWKS_URL = 'http://account-api:4100/api/account/.well-known/jwks.json';
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.GEMINI_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
}

describe('AI_GATEWAY_TOKENS', () => {
  it('ürün → jeton; ürün kayıtta ve geçidi kullanan araç olmalı', () => {
    const d = tok('d');
    const t = tok('t');
    const m = parseToolTokens(` deciship=${d} , tagpress=${t} `);
    expect([...m.entries()]).toEqual([
      ['deciship', d],
      ['tagpress', t],
    ]);
    expect(parseToolTokens('').size).toBe(0);
  });

  it('bilinmeyen ürün, ai girdisi olmayan araç, tekrar, kısa ya da ayırıcılı jeton ve iki araçta aynı jeton reddedilir; metin jetonu yansıtmaz', () => {
    const same = tok('ortak');
    const short = 'kisa-jeton';
    const cases: [string, RegExp][] = [
      [`yokarac=${tok('x')}`, /kayıtta olmayan ürün/],
      [`orderloom=${tok('o')}`, /geçidi kullanmıyor/],
      [`deciship=${tok('a')},deciship=${tok('b')}`, /iki kez/],
      [`deciship=${short}`, /jetonu geçersiz/],
      [`deciship=`, /jetonu geçersiz/],
      [`deciship=${tok('a')}=x`, /jetonu geçersiz/],
      [`deciship=${same},tagpress=${same}`, /başka araçla aynı/],
    ];
    for (const [value, re] of cases) {
      let msg = '';
      try {
        parseToolTokens(value);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, value).toMatch(re);
      expect(msg).not.toContain(same);
      expect(msg).not.toContain(short);
    }
  });
});

describe('açılış denetimi', () => {
  it('geliştirmede ana anahtar yoksa geliştirme anahtarı ve uyarı', () => {
    process.env.NODE_ENV = 'development';
    process.env.SOD_ENV = 'development';
    delete process.env.AI_KEY_MASTER;
    const { warnings } = assertConfig();
    expect(warnings.join('\n')).toMatch(/AI_KEY_MASTER yok/);
    expect(env.keyRing.current.key.equals(Buffer.from(DEV_AI_KEY_MASTER, 'base64'))).toBe(true);
  });

  it('üretim: geçerli ortamla açılır', () => {
    productionEnv();
    expect(() => assertConfig()).not.toThrow();
  });

  it('üretim: SOD_ENV=production da üretim sayılır', () => {
    productionEnv();
    process.env.NODE_ENV = 'development';
    process.env.SOD_ENV = 'production';
    delete process.env.AI_KEY_MASTER;
    expect(() => assertConfig()).toThrow(/AI_KEY_MASTER üretimde zorunlu/);
  });

  const refusals: [string, () => void, RegExp][] = [
    ['ana anahtar yok', () => delete process.env.AI_KEY_MASTER, /AI_KEY_MASTER üretimde zorunlu/],
    ['geliştirme ana anahtarı', () => (process.env.AI_KEY_MASTER = DEV_AI_KEY_MASTER), /geliştirme anahtarı/],
    ['eski anahtarlarda geliştirme anahtarı', () => (process.env.AI_KEY_MASTER_PREVIOUS = DEV_AI_KEY_MASTER), /AI_KEY_MASTER_PREVIOUS geliştirme/],
    ['bozuk ana anahtar', () => (process.env.AI_KEY_MASTER = 'kisa'), /AI_KEY_MASTER/],
    ['geliştirme jetonu', () => (process.env.AI_GATEWAY_TOKENS = `deciship=${DEV_TOOL_TOKEN_PREFIX}deciship-0123456789abcdef0123`), /geliştirme jetonu/],
    ['geliştirme veritabanı parolası', () => (process.env.DATABASE_URL = 'postgresql://sod_ai:sod_ai_dev@postgres:5432/sellerondata'), /geliştirme parolası/],
    ['köken listesi yok', () => (process.env.ALLOWED_ORIGINS = ''), /ALLOWED_ORIGINS/],
    ['JWKS adresi yok', () => delete process.env.ACCOUNT_JWKS_URL, /ACCOUNT_JWKS_URL/],
    ['sağlayıcı adresi değiştirilmiş', () => (process.env.ANTHROPIC_BASE_URL = 'https://evil.example'), /ANTHROPIC_BASE_URL üretimde kullanılamaz/],
    ['Gemini adresi değiştirilmiş', () => (process.env.GEMINI_BASE_URL = 'https://evil.example'), /GEMINI_BASE_URL üretimde kullanılamaz/],
    ['ortamda sağlayıcı anahtarı', () => (process.env.ANTHROPIC_API_KEY = 'sk-ant-ortamda-duran-anahtar'), /ANTHROPIC_API_KEY ortamda/],
  ];
  for (const [name, mutate, re] of refusals) {
    it(`üretim reddi: ${name}`, () => {
      productionEnv();
      mutate();
      let msg = '';
      try {
        assertConfig();
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(re);
      expect(msg).not.toContain('sk-ant-ortamda-duran-anahtar');
      expect(msg).not.toContain(process.env.AI_KEY_MASTER ?? '\u0000');
    });
  }

  it('geliştirmede sağlayıcı adresi değiştirme uyarıdır; anahtar ortamda olsa da okunmaz (uyarı)', () => {
    process.env.NODE_ENV = 'test';
    process.env.SOD_ENV = 'development';
    process.env.ANTHROPIC_BASE_URL = 'http://anthropic.test/';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-okunmayan';
    const { warnings } = assertConfig();
    expect(warnings.join('\n')).toMatch(/ANTHROPIC_BASE_URL değiştirilmiş/);
    expect(warnings.join('\n')).toMatch(/ANTHROPIC_API_KEY ortamda ama okunmaz/);
    expect(env.providerBaseUrls.anthropic).toBe('http://anthropic.test');
  });
});
