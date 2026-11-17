import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  EVENT_TOKEN_TTL_SECONDS,
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  COOKIE_LANG,
  CSRF_HEADER,
  ORG_HEADER,
  isCompanyConfirmed,
} from '../src/index.ts';

test('erisim jetonu omru yenileme jetonundan kisa', () => {
  assert.ok(ACCESS_TTL_SECONDS > 0);
  assert.ok(ACCESS_TTL_SECONDS < REFRESH_TTL_SECONDS);
  assert.ok(EVENT_TOKEN_TTL_SECONDS > 0);
});

test('cerez ve baslik adlari tekil', () => {
  const names = [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_LANG, CSRF_HEADER, ORG_HEADER];
  assert.equal(new Set(names).size, names.length);
});

test('isCompanyConfirmed: null bekliyor, tarih onaylı, alan yoksa (eski sunucu) onaylı, firma yoksa değil', () => {
  assert.equal(isCompanyConfirmed({ companyConfirmedAt: null }), false);
  assert.equal(isCompanyConfirmed({ companyConfirmedAt: '2026-11-13T09:00:00.000Z' }), true);
  assert.equal(isCompanyConfirmed({}), true);
  assert.equal(isCompanyConfirmed(null), false);
  assert.equal(isCompanyConfirmed(undefined), false);
});
