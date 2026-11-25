import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_HEADER, compareVersions, formatClientHeader, isBelowMinimum, parseClientHeader, errorMessage, strictVersion } from '../src/index.ts';

test('baslik adi', () => assert.equal(CLIENT_HEADER, 'X-SOD-Client'));

test('compareVersions: sayisal, metin degil', () => {
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions('1.9.3', '1.10.0'), -1);
  assert.equal(compareVersions('1.1', '1.1.0'), 0);
  assert.equal(compareVersions('2', '1.99.99'), 1);
  assert.equal(compareVersions('abc', '1.0.0'), 0);
});

test('isBelowMinimum', () => {
  assert.equal(isBelowMinimum('1.0.0', '1.1.0'), true);
  assert.equal(isBelowMinimum('1.1.0', '1.1.0'), false);
  assert.equal(isBelowMinimum('1.9.3', '1.10.0'), true);
  assert.equal(isBelowMinimum('1.0.0', null), false);
  assert.equal(isBelowMinimum('1.0.0', undefined), false);
  assert.equal(isBelowMinimum('1.0.0', ''), false);
  assert.equal(isBelowMinimum('1.0.0', 'bozuk'), false);
  assert.equal(isBelowMinimum('bozuk', '1.0.0'), false);
});

test('formatClientHeader ve parseClientHeader gidis-donus', () => {
  const full = { kind: 'mobile', version: '1.1.0', build: 2, platform: 'android' } as const;
  assert.equal(formatClientHeader(full), 'mobile/1.1.0+2 (android)');
  assert.deepEqual(parseClientHeader('mobile/1.1.0+2 (android)'), full);
  assert.deepEqual(parseClientHeader('mobile/1.1.0'), { kind: 'mobile', version: '1.1.0', build: null, platform: null });
  assert.equal(formatClientHeader({ kind: 'mobile', version: '1.1.0', build: null, platform: null }), 'mobile/1.1.0');
});

test('parseClientHeader: bozuk ya da yabanci baslik null', () => {
  for (const h of [undefined, null, '', 'web/1.0.0', 'mobile', 'mobile/', 'mobile/abc', 'mobile/1.0.0 (', 'x'.repeat(200), 'mobile/1.0.0.0']) {
    assert.equal(parseClientHeader(h), null, String(h));
  }
});

test('UPGRADE_REQUIRED metni', () => {
  assert.match(errorMessage('UPGRADE_REQUIRED', 'tr'), /güncelleyin/);
  assert.match(errorMessage('UPGRADE_REQUIRED', 'en'), /update/i);
});

test('strictVersion: sunucu ayari yalniz tam x.y.z (iki servis ayni kurali kullanir)', () => {
  assert.equal(strictVersion('1.1.0'), '1.1.0');
  assert.equal(strictVersion(' 1.10.0 '), '1.10.0');
  assert.equal(strictVersion('1.1'), null);
  assert.equal(strictVersion('1'), null);
  assert.equal(strictVersion('1.1.0.0'), null);
  assert.equal(strictVersion('v1.1.0'), null);
  assert.equal(strictVersion('bozuk'), null);
  assert.equal(strictVersion(''), null);
  assert.equal(strictVersion(null), null);
  assert.equal(strictVersion(undefined), null);
});
