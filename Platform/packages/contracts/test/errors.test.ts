import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  EXTRA_ERROR_CODES,
  ERROR_MESSAGES,
  errorMessage,
  localeFromAcceptLanguage,
  acceptLanguageLocale,
  requestLocaleOf,
  hasDevPassword,
  type ApiErrorCode,
} from '../src/index.ts';

test('kodlar tekil, iki liste kesismiyor', () => {
  const all: string[] = [...ERROR_CODES, ...EXTRA_ERROR_CODES];
  assert.equal(new Set(all).size, all.length);
});

test('her kodun bos olmayan TR ve EN metni var, fazladan metin yok', () => {
  const all: ApiErrorCode[] = [...ERROR_CODES, ...EXTRA_ERROR_CODES];
  for (const code of all) {
    const m = ERROR_MESSAGES[code];
    assert.ok(m.tr.trim().length > 0, `${code} tr`);
    assert.ok(m.en.trim().length > 0, `${code} en`);
    assert.equal(errorMessage(code, 'tr'), m.tr);
    assert.equal(errorMessage(code, 'en'), m.en);
  }
  assert.equal(Object.keys(ERROR_MESSAGES).length, all.length);
});

test('localeFromAcceptLanguage', () => {
  assert.equal(localeFromAcceptLanguage('en-US,en;q=0.9'), 'en');
  assert.equal(localeFromAcceptLanguage('tr'), 'tr');
  assert.equal(localeFromAcceptLanguage('de-DE,tr-TR;q=0.8'), 'tr');
  // Kullanıcı kararı 2026-11-12: dil bilgisi yoksa ya da desteklenen dil yoksa İngilizce (eskiden Türkçe).
  assert.equal(localeFromAcceptLanguage(null), 'en');
  assert.equal(localeFromAcceptLanguage(undefined), 'en');
  assert.equal(localeFromAcceptLanguage(''), 'en');
  assert.equal(localeFromAcceptLanguage('*'), 'en');
  assert.equal(localeFromAcceptLanguage('de,fr'), 'en');
  assert.equal(localeFromAcceptLanguage('tr;q=0.5,en;q=0.9'), 'en');
  assert.equal(localeFromAcceptLanguage('en;q=0,tr'), 'tr');
  assert.equal(localeFromAcceptLanguage('de,en;q=0.8'), 'en');
});

test('requestLocaleOf: başlık → oturum dili → İngilizce', () => {
  assert.equal(requestLocaleOf('tr-TR', 'en'), 'tr');
  assert.equal(requestLocaleOf('de-DE', 'tr'), 'tr');
  assert.equal(requestLocaleOf(undefined, 'tr'), 'tr');
  assert.equal(requestLocaleOf('de-DE', null), 'en');
  assert.equal(requestLocaleOf(undefined, 'xx'), 'en');
  assert.equal(requestLocaleOf('', undefined), 'en');
});

test('acceptLanguageLocale: desteklenen yoksa null', () => {
  assert.equal(acceptLanguageLocale('de-DE,tr;q=0.4'), 'tr');
  assert.equal(acceptLanguageLocale('en-GB'), 'en');
  assert.equal(acceptLanguageLocale('de,fr'), null);
  assert.equal(acceptLanguageLocale(''), null);
  assert.equal(acceptLanguageLocale(undefined), null);
});

test('hasDevPassword', () => {
  assert.equal(hasDevPassword('postgresql://user:secret_dev@localhost:5434/db'), true);
  assert.equal(hasDevPassword('postgresql://user:Gercek-Sifre-123@db.example.com/db'), false);
  assert.equal(hasDevPassword('postgresql://user@localhost/db'), false);
  assert.equal(hasDevPassword('bu bir adres degil'), false);
  assert.equal(hasDevPassword(''), false);
});
