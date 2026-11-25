// Pencere koruması: kapatma kararı ve hangi alanların "yazı" sayıldığı.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { closeDecision, isTrackedField } from '../src/lib/modalGuard.ts';

const base = { busy: false, dirty: false, asking: false, source: 'esc' as const };

describe('closeDecision', () => {
  it('meşgulken her kaynak yok sayılır', () => {
    for (const source of ['esc', 'backdrop', 'x'] as const) {
      assert.equal(closeDecision({ ...base, busy: true, dirty: true, asking: true, source }), 'ignore');
    }
  });
  it('soru açıkken Esc düzenlemeye döndürür', () => {
    assert.equal(closeDecision({ ...base, dirty: true, asking: true, source: 'esc' }), 'keep');
  });
  it('yazılmış pencere sorar', () => {
    assert.equal(closeDecision({ ...base, dirty: true, source: 'backdrop' }), 'ask');
    assert.equal(closeDecision({ ...base, dirty: true, source: 'x' }), 'ask');
  });
  it('yazılmamış pencere hemen kapanır', () => {
    assert.equal(closeDecision({ ...base, source: 'esc' }), 'close');
    assert.equal(closeDecision({ ...base, source: 'x' }), 'close');
  });
});

function field(tagName: string, type?: string, ignored = false) {
  return { tagName, type, closest: () => (ignored ? ({} as Element) : null) } as unknown as Element & { type?: string };
}

describe('isTrackedField', () => {
  it('metin, alan, seçim, onay kutusu ve seçenek düğmesi sayılır', () => {
    assert.equal(isTrackedField(field('INPUT', 'text')), true);
    assert.equal(isTrackedField(field('INPUT', 'checkbox')), true);
    assert.equal(isTrackedField(field('INPUT', 'radio')), true);
    assert.equal(isTrackedField(field('TEXTAREA')), true);
    assert.equal(isTrackedField(field('SELECT')), true);
  });
  it('gizli alan ve diğer öğeler sayılmaz', () => {
    assert.equal(isTrackedField(field('INPUT', 'hidden')), false);
    assert.equal(isTrackedField(field('DIV')), false);
    assert.equal(isTrackedField(field('BUTTON')), false);
  });
  it('.search, [role=search] ve [data-modal-ignore] içindekiler sayılmaz', () => {
    assert.equal(isTrackedField(field('INPUT', 'text', true)), false);
  });
});
