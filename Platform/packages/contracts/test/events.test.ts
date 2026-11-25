import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyForCountry, ORG_CURRENCIES } from '../src/index.ts';

test('currencyForCountry', () => {
  assert.equal(currencyForCountry('TR'), 'TRY');
  assert.equal(currencyForCountry('tr'), 'TRY');
  assert.equal(currencyForCountry('US'), 'USD');
  assert.equal(currencyForCountry('DE'), 'EUR');
  assert.equal(currencyForCountry('NL'), 'EUR');
  assert.equal(currencyForCountry('FR'), 'EUR');
  assert.equal(currencyForCountry('GB'), 'GBP');
  assert.equal(currencyForCountry('ZZ'), 'USD');
  assert.equal(currencyForCountry(''), 'USD');
});

test('ORG_CURRENCIES ve donus degerleri bu listede', () => {
  assert.deepEqual([...ORG_CURRENCIES], ['TRY', 'USD', 'EUR', 'GBP']);
  for (const c of ['TR', 'US', 'DE', 'GB', 'XX']) {
    assert.ok((ORG_CURRENCIES as readonly string[]).includes(currencyForCountry(c)));
  }
});

test('confirmNameMatches: kırpma, büyük/küçük harf ve Türkçe i/İ', async () => {
  const { confirmNameMatches, isOrgClosedEntry } = await import('../src/index.ts');
  assert.equal(confirmNameMatches('  Demo Kargo ', 'Demo Kargo'), true);
  assert.equal(confirmNameMatches('demo kargo', 'DEMO KARGO'), true);
  assert.equal(confirmNameMatches('istanbul ticaret', 'İSTANBUL TİCARET'), true);
  assert.equal(confirmNameMatches('Demo Karg', 'Demo Kargo'), false);
  assert.equal(confirmNameMatches('', ''), false);
  assert.equal(confirmNameMatches('   ', '   '), false);
  assert.equal(isOrgClosedEntry({ orgStatus: 'CLOSED' }), true);
  assert.equal(isOrgClosedEntry({ orgStatus: 'ACTIVE' }), false);
  assert.equal(isOrgClosedEntry({}), false);
});

test('hizmet olayları (geçit): firma olayı ürünsüz, abonelik ürünlü ve limitli, üye olayı gitmez', async () => {
  const { serviceEventOf, serviceEventPath, SERVICE_EVENT_TYPES, SERVICE_EVENT_AUDIENCE, PLATFORM_SERVICE_KEYS, EVENT_AUDIENCE, PRODUCT_KEYS } = await import('../src/index.ts');
  assert.deepEqual([...PLATFORM_SERVICE_KEYS], ['ai']);
  for (const k of PLATFORM_SERVICE_KEYS) assert.ok(!(PRODUCT_KEYS as readonly string[]).includes(k), k);
  assert.notEqual(SERVICE_EVENT_AUDIENCE, EVENT_AUDIENCE);
  assert.equal(serviceEventPath('ai'), '/api/ai/internal/events');
  assert.deepEqual([...SERVICE_EVENT_TYPES.ai], ['org.updated', 'org.closed', 'org.reopened', 'org.purged', 'subscription.updated']);
  assert.deepEqual(serviceEventOf('ai', { type: 'org.updated', orgId: 'o1', product: 'deciship', name: 'Demo', timeZone: 'Europe/Istanbul', version: 3 }), {
    type: 'org.updated', orgId: 'o1', name: 'Demo', timeZone: 'Europe/Istanbul', version: 3,
  });
  assert.deepEqual(serviceEventOf('ai', { type: 'org.purged', orgId: 'o1', product: 'tagpress' }), { type: 'org.purged', orgId: 'o1' });
  assert.deepEqual(serviceEventOf('ai', { type: 'org.closed', orgId: 'o1', product: 'deciship', closedAt: 'a', purgeAfter: 'b', version: 4 }), {
    type: 'org.closed', orgId: 'o1', closedAt: 'a', purgeAfter: 'b', version: 4,
  });
  assert.deepEqual(serviceEventOf('ai', { type: 'subscription.updated', orgId: 'o1', product: 'tagpress', status: 'ACTIVE', plan: 'early_access', version: 2, limits: { aiSpendCapMonthlyUsd: 5 } }), {
    type: 'subscription.updated', orgId: 'o1', product: 'tagpress', status: 'ACTIVE', plan: 'early_access', version: 2, limits: { aiSpendCapMonthlyUsd: 5 },
  });
  assert.equal(serviceEventOf('ai', { type: 'member.removed', orgId: 'o1', product: 'deciship', membershipId: 'm', epoch: 1 }), null);
  assert.equal(serviceEventOf('ai', { type: 'member.upserted', orgId: 'o1', product: 'deciship', membershipId: 'm', personId: 'p', name: 'A', orgRole: 'MEMBER', role: null, active: true, epoch: 1 }), null);
});
