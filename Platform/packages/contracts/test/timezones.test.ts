import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ORG_TIME_ZONE, defaultTimeZone, isOrgTimeZone, TIME_ZONES } from '../src/index.ts';

test('TIME_ZONES: 16 değer, tekil, hepsi çalışma zamanında geçerli', () => {
  assert.equal(TIME_ZONES.length, 16);
  assert.equal(new Set(TIME_ZONES).size, 16);
  assert.ok((TIME_ZONES as readonly string[]).includes(DEFAULT_ORG_TIME_ZONE));
  for (const tz of TIME_ZONES) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: tz }), tz);
});

test('defaultTimeZone', () => {
  assert.equal(defaultTimeZone('TR'), 'Europe/Istanbul');
  assert.equal(defaultTimeZone('tr'), 'Europe/Istanbul');
  assert.equal(defaultTimeZone('GB'), 'Europe/London');
  assert.equal(defaultTimeZone('DE'), 'Europe/Berlin');
  assert.equal(defaultTimeZone('FR'), 'Europe/Paris');
  assert.equal(defaultTimeZone('NL'), 'Europe/Amsterdam');
  assert.equal(defaultTimeZone('US'), 'America/New_York');
  assert.equal(defaultTimeZone('JP'), 'Europe/Istanbul');
  assert.equal(defaultTimeZone(''), 'Europe/Istanbul');
  for (const c of ['TR', 'GB', 'DE', 'FR', 'NL', 'US', 'ZZ']) assert.ok(isOrgTimeZone(defaultTimeZone(c)), c);
});

test('isOrgTimeZone', () => {
  assert.ok(isOrgTimeZone('UTC'));
  assert.ok(isOrgTimeZone('Asia/Tokyo'));
  for (const bad of ['utc', 'Europe/Kyiv', '', null, 3, 'Europe/istanbul']) assert.ok(!isOrgTimeZone(bad), String(bad));
});
