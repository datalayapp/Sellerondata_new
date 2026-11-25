import test from 'node:test';
import assert from 'node:assert/strict';
import { baseLocale, DEFAULT_LOCALE, LOCALES, pickInitialLocale } from '../src/index.ts';

test('son çare İngilizce (kullanıcı kararı 2026-11-12)', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.ok(LOCALES.includes(DEFAULT_LOCALE));
});

test('cihaz dilleri sırayla: ilk desteklenen', () => {
  assert.equal(pickInitialLocale(null, ['de-DE', 'tr-TR']), 'tr');
  assert.equal(pickInitialLocale(null, ['de']), 'en');
  assert.equal(pickInitialLocale(null, []), 'en');
  assert.equal(pickInitialLocale(undefined, undefined), 'en');
  assert.equal(pickInitialLocale(null, ['en-GB']), 'en');
  assert.equal(pickInitialLocale(null, ['tr', 'en']), 'tr');
  assert.equal(pickInitialLocale(null, ['en-US', 'tr-TR']), 'en');
  assert.equal(pickInitialLocale(null, ['TR_tr']), 'tr');
});

test('kayıtlı tercih cihaz dilinden önce', () => {
  assert.equal(pickInitialLocale('tr', ['en']), 'tr');
  assert.equal(pickInitialLocale('en', ['tr-TR']), 'en');
  // Öncelik listesi: ilk geçerli kayıt kazanır (hesap dili → çerez → yerel kayıt).
  assert.equal(pickInitialLocale([null, 'tr', 'en'], ['en']), 'tr');
  assert.equal(pickInitialLocale(['de', undefined, ''], ['tr-TR']), 'tr');
});

test('bozuk değerler atlanır', () => {
  assert.equal(pickInitialLocale('xx', ['yy']), 'en');
  assert.equal(pickInitialLocale(42, [null, 3, {}, '', '  ', '-', 'enx', 'tr-TR']), 'tr');
  assert.equal(pickInitialLocale({}, 'tr' as unknown as string[]), 'en');
  assert.equal(pickInitialLocale(['', null], [undefined]), 'en');
});

test('desteklenen liste dışarıdan verilebilir', () => {
  assert.equal(pickInitialLocale(null, ['tr-TR'], ['en']), 'en');
  assert.equal(pickInitialLocale(null, ['de-DE'], ['tr']), 'tr');
});

test('baseLocale', () => {
  assert.deepEqual(['tr-TR', 'TR', 'en_GB', ' en ', 'de', '', null, 'enx'].map((v) => baseLocale(v)), ['tr', 'tr', 'en', 'en', null, null, null, null]);
});
