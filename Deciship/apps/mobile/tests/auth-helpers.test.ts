import { afterEach, describe, expect, it, vi } from 'vitest';

// Derleme ortamı (`extra.sod.appEnv`) `expo-constants`ten okunur; yerel modül Node'da yüklenemez.
const constants = vi.hoisted(() => ({ expoConfig: { extra: { sod: { appEnv: 'development' } } } }));
vi.mock('expo-constants', () => ({ default: constants }));
import { DEFAULT_SERVER_URL, normalizeServerUrl, serverCandidates } from '../src/api/serverUrl';
import { authErrorKey, joinCodeComplete, looksLikeIdentifier, looksLikePhone, normalizeIdentifierInput, normalizeJoinCodeInput } from '../src/auth/errors';
import { claimsSignature, decodeClaims, sameScope, scopeFromClaims, scopeKey } from '../src/auth/token';
import { needsRestore } from '../src/draft/owner';
import { fakeToken } from './helpers';
import tr from '../src/locales/tr/auth.json';
import en from '../src/locales/en/auth.json';

describe('jeton kapsamı', () => {
  it('kişi ve firmayı okur, Türkçe ad bozmaz', () => {
    const claims = decodeClaims(fakeToken({ sub: 'p1', org: 'o1', name: 'Ayşe Çağlar Öztürk' }));
    expect(scopeFromClaims(claims)).toEqual({ personId: 'p1', orgId: 'o1' });
  });

  it('firmasız jetonda kapsam yok, kişi var', () => {
    const claims = decodeClaims(fakeToken({ sub: 'p1', org: null }));
    expect(claims?.sub).toBe('p1');
    expect(scopeFromClaims(claims)).toBeNull();
  });

  it('bozuk jeton null', () => {
    for (const bad of [null, undefined, '', 'abc', 'a.b.c', 'a.!!!.c']) expect(decodeClaims(bad)).toBeNull();
    expect(decodeClaims(`x.${Buffer.from('{"org":"o1"}').toString('base64url')}.y`)).toBeNull();
  });

  it('karşılaştırma: null hiçbir şeye eşit değil', () => {
    const a = { personId: 'p', orgId: 'o' };
    expect(sameScope(a, { personId: 'p', orgId: 'o' })).toBe(true);
    expect(sameScope(a, { personId: 'p', orgId: 'x' })).toBe(false);
    expect(sameScope(a, { personId: 'x', orgId: 'o' })).toBe(false);
    expect(sameScope(a, null)).toBe(false);
    expect(sameScope(null, null)).toBe(false);
    expect(scopeKey(a)).toBe('p:o');
    expect(scopeKey(null)).toBeNull();
  });

  it('yetki değişimi imzayı değiştirir', () => {
    const base = decodeClaims(fakeToken({ sub: 'p', org: 'o', ep: 1 }));
    expect(claimsSignature(base)).not.toBe(claimsSignature(decodeClaims(fakeToken({ sub: 'p', org: 'o', ep: 2 }))));
    expect(claimsSignature(base)).toBe(claimsSignature(decodeClaims(fakeToken({ sub: 'p', org: 'o', ep: 1 }))));
  });
});

describe('taslak sahibi', () => {
  it('başka kişi veya firmada taslak yeniden okunur, geçici kapanışta bellekteki taslak kalır', () => {
    // Aynı sahip: okunmaz, bellekteki taslak sürer.
    expect(needsRestore('p:a', 'p:a')).toBe(false);
    // Başka firma ya da kişi: o kapsamın taslağı diskten okunur (öncekinin taslağı diskte kalır).
    expect(needsRestore('p:a', 'p:b')).toBe(true);
    expect(needsRestore('p:a', 'q:a')).toBe(true);
    // Kapsam yok: hiçbir şey okunmaz, yazılmaz, silinmez.
    expect(needsRestore('p:a', null)).toBe(false);
    expect(needsRestore(null, null)).toBe(false);
    // Açılış: sahip yok, okunur.
    expect(needsRestore(null, 'p:a')).toBe(true);
  });
});

describe('sunucu adresi', () => {
  it('tabana indirger', () => {
    expect(normalizeServerUrl(' http://1.2.3.4:8088/ ')).toBe('http://1.2.3.4:8088');
    expect(normalizeServerUrl('http://1.2.3.4:8088/api')).toBe('http://1.2.3.4:8088');
    expect(normalizeServerUrl('http://1.2.3.4:8088/api/deciship/')).toBe('http://1.2.3.4:8088');
    expect(normalizeServerUrl('192.168.1.5:8088')).toBe('http://192.168.1.5:8088');
    expect(normalizeServerUrl('https://app.sellerondata.com')).toBe('https://app.sellerondata.com');
    expect(normalizeServerUrl('')).toBe(DEFAULT_SERVER_URL);
  });

  it('yerel adresse diğerlerini de dener, uzak adreste denemez', () => {
    expect(serverCandidates('http://10.0.2.2:8088')).toEqual(['http://10.0.2.2:8088', 'http://127.0.0.1:8088', 'http://localhost:8088']);
    expect(serverCandidates('https://app.sellerondata.com')).toEqual(['https://app.sellerondata.com']);
  });
});

describe('derleme ortamından sunucu', () => {
  afterEach(() => {
    constants.expoConfig.extra.sod.appEnv = 'development';
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('tanımlı değilse geliştirme adresi, alan düzenlenebilir', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_URL', '');
    vi.resetModules();
    const m = await import('../src/api/serverUrl');
    expect(m.DEFAULT_SERVER_URL).toBe('http://127.0.0.1:8088');
    expect(m.SERVER_EDITABLE).toBe(true);
  });

  // Mesaj 13 §3.3: alanın görünürlüğü adrese değil derleme profiline bağlı (APP_ENV).
  it('üretim derlemesinde üretim adresi, alan gizli', async () => {
    constants.expoConfig.extra.sod.appEnv = 'production';
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://app.sellerondata.com/');
    vi.resetModules();
    const m = await import('../src/api/serverUrl');
    expect(m.DEFAULT_SERVER_URL).toBe('https://app.sellerondata.com');
    expect(m.SERVER_EDITABLE).toBe(false);
    expect(m.normalizeServerUrl('')).toBe('https://app.sellerondata.com');
  });

  it('geliştirme derlemesinde adres verilse de alan görünür (plan §7-6)', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://app.sellerondata.com/');
    vi.resetModules();
    const m = await import('../src/api/serverUrl');
    expect(m.DEFAULT_SERVER_URL).toBe('https://app.sellerondata.com');
    expect(m.SERVER_EDITABLE).toBe(true);
  });
});

describe('giriş kimliği', () => {
  it('e-posta ve telefon geçer, eski kullanıcı adı geçmez', () => {
    expect(looksLikeIdentifier('ayse@firma.com')).toBe(true);
    expect(looksLikeIdentifier('0532 000 00 00')).toBe(true);
    expect(looksLikeIdentifier('+905320000000')).toBe(true);
    expect(looksLikeIdentifier('mehmet')).toBe(false);
    expect(looksLikeIdentifier('mehmet12')).toBe(false);
  });

  it('telefon ve kod denetimi', () => {
    expect(looksLikePhone('0532 000 00 00')).toBe(true);
    expect(looksLikePhone('ayse@firma.com')).toBe(false);
    expect(joinCodeComplete('ABCD-EFGH')).toBe(true);
    expect(joinCodeComplete('ABCD EFG')).toBe(false);
  });
});

describe('Türkçe I/İ', () => {
  it('davet kodunda İ, ı, i aynı harf (sunucu I yi 1 sayar)', () => {
    expect(normalizeJoinCodeInput(' Y3MP3İGR ')).toBe('Y3MP3IGR');
    expect(normalizeJoinCodeInput('y3mp3ıgr')).toBe('y3mp3Igr');
    expect(normalizeJoinCodeInput('ABCi')).toBe('ABCI');
  });

  it('e-postada Türkçe harf ASCII olur, telefona dokunulmaz', () => {
    expect(normalizeIdentifierInput('SAHİP@demo.com ')).toBe('SAHiP@demo.com');
    expect(normalizeIdentifierInput('sahıp@demo.com')).toBe('sahip@demo.com');
    expect(normalizeIdentifierInput(' 0555 000 00 05')).toBe('0555 000 00 05');
  });
});

describe('hata kodları', () => {
  const e = (code: string, status = 400, details?: unknown) => ({ code, status, details });

  it('girişte ve katılımda farklı metin', () => {
    expect(authErrorKey(e('INVALID_CREDENTIALS', 401), 'login')).toBe('auth:errors.INVALID_CREDENTIALS');
    expect(authErrorKey(e('INVALID_CREDENTIALS', 401), 'joinAccept')).toBe('auth:errors.WRONG_CURRENT_PASSWORD');
  });

  it('alan hatası', () => {
    expect(authErrorKey(e('VALIDATION', 400, [{ path: 'phone', code: 'invalid_phone' }]), 'joinCode')).toBe('auth:errors.INVALID_PHONE');
    expect(authErrorKey(e('VALIDATION', 400, [{ path: 'password', code: 'weak_password' }]), 'joinAccept')).toBe('auth:errors.WEAK_PASSWORD');
    expect(authErrorKey(e('VALIDATION'), 'login')).toBe('auth:errors.VALIDATION');
  });

  it('bilinmeyen kodda sunucu mesajına bırakır, 5xx genel metin', () => {
    expect(authErrorKey(e('YENI_KOD', 409), 'login')).toBeNull();
    expect(authErrorKey(e('YENI_KOD', 500), 'login')).toBe('auth:errors.SERVER');
    expect(authErrorKey(e('AUTH_UNAVAILABLE', 503), 'login')).toBe('auth:errors.AUTH_UNAVAILABLE');
  });

  it('her anahtarın TR ve EN metni var', () => {
    const keys = ['NETWORK', 'TIMEOUT', 'TOO_MANY_ATTEMPTS', 'INVITE_INVALID', 'ALREADY_MEMBER', 'EMAIL_NOT_VERIFIED', 'AUTH_UNAVAILABLE', 'DB_UNAVAILABLE', 'INVALID_CREDENTIALS', 'WRONG_CURRENT_PASSWORD', 'ORG_NOT_FOUND', 'INVALID_PHONE', 'WEAK_PASSWORD', 'NAME_REQUIRED', 'VALIDATION', 'SERVER'];
    for (const k of keys) {
      expect((tr.errors as Record<string, string>)[k], k).toBeTruthy();
      expect((en.errors as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});

describe('metin dosyaları', () => {
  const flat = (o: object, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? flat(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]));

  it('TR ve EN aynı anahtarlara sahip', () => {
    expect(flat(tr).sort()).toEqual(flat(en).sort());
  });

  it('satın alma, fiyat, yükseltme metni yok (mağaza kuralı)', () => {
    const text = JSON.stringify([tr, en]).toLowerCase();
    for (const w of ['satın al', 'yükselt', 'fiyat', 'upgrade', 'purchase', 'pricing', 'buy ']) expect(text).not.toContain(w);
  });
});
