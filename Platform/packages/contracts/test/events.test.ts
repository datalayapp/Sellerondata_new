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
