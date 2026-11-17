// ci:son günlük özeti (gh çağrılmaz; günlük örnekleri gerçek CI günlüklerinden kısaltıldı).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './ci-son.mjs';

const T = '2026-11-13T20:13:00.5575769Z ';
const ESC = String.fromCharCode(27);

test('vitest bildirimi, test.mjs özeti ve grep -n önekli FAIL satırı', () => {
  const log = [
    `${T}  account          kaldı (çıkış kodu 1)  [11 dk 4 sn]`,
    `${T}767:${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m test/signupInvite.test.ts${ESC}[2m > ${ESC}[22mkayıt daveti${ESC}[2m > ${ESC}[22maynı davetle eşzamanlı iki kayıt: yalnız biri geçer`,
    `${T}768:AssertionError: expected [ 201, 403 ] to deeply equal [ 201, 409 ]`,
    `${T}796:::error file=/home/runner/x/test/signupInvite.test.ts,title=test/signupInvite.test.ts > kayıt daveti > aynı davetle eşzamanlı iki kayıt%3A yalnız biri geçer,line=173,column=53::AssertionError: expected [ 201, 403 ] to deeply equal [ 201, 409 ]%0A%0A- Expected`,
    `${T}  account          kaldı (çıkış kodu 1)  [11 dk 4 sn]`,
  ].join('\n');
  const d = digest(log);
  assert.deepEqual(d.tests, ['test/signupInvite.test.ts > kayıt daveti > aynı davetle eşzamanlı iki kayıt: yalnız biri geçer']);
  assert.equal(d.first, 'AssertionError: expected [ 201, 403 ] to deeply equal [ 201, 409 ]');
  assert.deepEqual(d.parts, ['account kaldı (çıkış kodu 1)  [11 dk 4 sn]']);
});

test('node --test ve tip denetimi hataları', () => {
  const log = [
    `${T}✖ failing tests:`,
    `${T}✖ yanıt şekli eşleşir (12.5ms)`,
    `${T}src/x.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
  ].join('\n');
  const d = digest(log);
  assert.deepEqual(d.tests, ['yanıt şekli eşleşir']);
  assert.match(d.first, /error TS2322/);
});

test('hatasız günlük: boş özet', () => {
  assert.deepEqual(digest(`${T}ok\n${T}SONUÇ: tamam`), { tests: [], first: null, parts: [] });
});
