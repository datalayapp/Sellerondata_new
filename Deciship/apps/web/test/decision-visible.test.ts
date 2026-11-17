// Karar rozeti yalnız DIFF satırlarda görünür; Uyumlu'ya dönen satırda eski karar gizlenir.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { showsDecision } from '../src/pages/invoice-detail/decisionVisible.ts';

describe('showsDecision', () => {
  it('DIFF satırda verilmiş karar görünür', () => {
    assert.equal(showsDecision({ status: 'DIFF', decision: 'VERIFIED' }), true);
    assert.equal(showsDecision({ status: 'DIFF', decision: 'ACCEPTED' }), true);
  });
  it('DIFF satırda açık karar rozet üretmez', () => {
    assert.equal(showsDecision({ status: 'DIFF', decision: 'OPEN' }), false);
  });
  it('MATCH satırda eski karar gizlenir', () => {
    assert.equal(showsDecision({ status: 'MATCH', decision: 'VERIFIED' }), false);
  });
});
