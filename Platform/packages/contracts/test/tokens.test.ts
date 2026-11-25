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
  STEP_UP_HEADER,
  OPERATOR_STEP_UP_AUDIENCE,
  OPERATOR_STEP_UP_TTL_SECONDS,
  TOKEN_AUDIENCE,
  EVENT_AUDIENCE,
  SERVICE_EVENT_AUDIENCE,
  isCompanyConfirmed,
  stepUpMatchesSession,
} from '../src/index.ts';

test('erisim jetonu omru yenileme jetonundan kisa', () => {
  assert.ok(ACCESS_TTL_SECONDS > 0);
  assert.ok(ACCESS_TTL_SECONDS < REFRESH_TTL_SECONDS);
  assert.ok(EVENT_TOKEN_TTL_SECONDS > 0);
});

test('cerez ve baslik adlari tekil', () => {
  const names = [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_LANG, CSRF_HEADER, ORG_HEADER, STEP_UP_HEADER];
  assert.equal(new Set(names).size, names.length);
});

test('isCompanyConfirmed: null bekliyor, tarih onaylı, alan yoksa (eski sunucu) onaylı, firma yoksa değil', () => {
  assert.equal(isCompanyConfirmed({ companyConfirmedAt: null }), false);
  assert.equal(isCompanyConfirmed({ companyConfirmedAt: '2026-11-13T09:00:00.000Z' }), true);
  assert.equal(isCompanyConfirmed({}), true);
  assert.equal(isCompanyConfirmed(null), false);
  assert.equal(isCompanyConfirmed(undefined), false);
});

test('adım artırma jetonu: ayrı kitle, 5 dakika', () => {
  const audiences = [TOKEN_AUDIENCE, EVENT_AUDIENCE, SERVICE_EVENT_AUDIENCE, OPERATOR_STEP_UP_AUDIENCE];
  assert.equal(new Set(audiences).size, audiences.length);
  assert.equal(OPERATOR_STEP_UP_AUDIENCE, 'ai-admin');
  assert.equal(OPERATOR_STEP_UP_TTL_SECONDS, 300);
  assert.ok(OPERATOR_STEP_UP_TTL_SECONDS < ACCESS_TTL_SECONDS);
});

test('stepUpMatchesSession: iki jetonda fid varsa aile, yoksa sid; sub her zaman', () => {
  const su = { sub: 'p1', sid: 's1', fid: 'f1' };
  // Aynı aile, yenilenmiş oturum (yeni sid): geçer.
  assert.equal(stepUpMatchesSession(su, { sub: 'p1', sid: 's2', fid: 'f1' }), true);
  // Başka aile: aynı sid olsa da geçmez.
  assert.equal(stepUpMatchesSession(su, { sub: 'p1', sid: 's1', fid: 'f2' }), false);
  // Başka kişi.
  assert.equal(stepUpMatchesSession(su, { sub: 'p2', sid: 's2', fid: 'f1' }), false);
  // Biri fid taşımıyor (eski jeton): sid kuralı.
  assert.equal(stepUpMatchesSession(su, { sub: 'p1', sid: 's1' }), true);
  assert.equal(stepUpMatchesSession(su, { sub: 'p1', sid: 's2' }), false);
  assert.equal(stepUpMatchesSession({ sub: 'p1', sid: 's1' }, { sub: 'p1', sid: 's1', fid: 'f1' }), true);
  assert.equal(stepUpMatchesSession({ sub: 'p1', sid: 's1' }, { sub: 'p1', sid: 's2', fid: 'f1' }), false);
  // Boş ve metin olmayan değerler eşleşmez.
  assert.equal(stepUpMatchesSession({ sub: '', sid: '' }, { sub: '', sid: '' }), false);
  assert.equal(stepUpMatchesSession({ sub: 'p1', sid: 's1', fid: '' }, { sub: 'p1', sid: 's2', fid: '' }), false);
  assert.equal(stepUpMatchesSession({ sub: 'p1', fid: 1 }, { sub: 'p1', fid: 1 }), false);
});
