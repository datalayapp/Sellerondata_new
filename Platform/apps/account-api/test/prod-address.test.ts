import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertProductionConfig } from '../src/env.ts';

/** Üretim adresi: TLS'siz veya kökeni listede olmayan kurulum açılışta durur, kullanıcıya sessiz giriş döngüsü yaşatmaz. */
describe('üretim adresi denetimi', () => {
  const base: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://a:gercek@db/x',
    ACCOUNT_CODE_PEPPER: 'g'.repeat(40),
    SMTP_URL: 'smtp://mail:25',
    COOKIE_SECURE: '',
    EMAIL_VERIFICATION_REQUIRED: 'true',
  };
  const names = [...Object.keys(base), 'APP_BASE_URL', 'ALLOWED_ORIGINS'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    Object.assign(process.env, base);
  });
  afterEach(() => {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const check = (app: string, origins: string) => {
    process.env.APP_BASE_URL = app;
    process.env.ALLOWED_ORIGINS = origins;
    return () => assertProductionConfig();
  };

  it('https ve kökeni listede: açılır', () => {
    expect(check('https://app.test', 'https://app.test')).not.toThrow();
    expect(check('https://APP.test/', 'https://other.test, https://app.test/')).not.toThrow();
    expect(check('https://app.test:8443', 'https://app.test:8443')).not.toThrow();
  });

  it('düz HTTP: durur, nedeni yazar', () => {
    expect(check('http://app.test', 'http://app.test')).toThrow(/https olmalı/);
    expect(check('http://10.0.0.5:8088', 'http://10.0.0.5:8088')).toThrow(/https olmalı/);
  });

  it('yerel sınama: localhost düz HTTP ile açılır', () => {
    expect(check('http://localhost:8088', 'http://localhost:8088')).not.toThrow();
    expect(check('http://127.0.0.1:8088', 'http://127.0.0.1:8088')).not.toThrow();
  });

  it('köken ALLOWED_ORIGINS içinde değil: durur, kökeni yazar', () => {
    expect(check('https://app.test', 'https://baska.test')).toThrow(/ALLOWED_ORIGINS.*https:\/\/app\.test/);
    expect(check('https://app.test:8443', 'https://app.test')).toThrow(/ALLOWED_ORIGINS/);
  });

  it('adres çözülemez: durur', () => {
    expect(check('app.test', 'https://app.test')).toThrow(/APP_BASE_URL geçersiz/);
  });
});
