// Menüdeki "Kurulum" etiketi: API'nin tek tanımını (`onboarding.completed`) okur, kendi kuralı yoktur.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSetupPending } from '../src/lib/onboarding.ts';

describe('kurulum etiketi', () => {
  it('API tamam derse gösterilmez, tamamlanmadı derse gösterilir', () => {
    assert.equal(isSetupPending(true, { completed: true }, true), false);
    assert.equal(isSetupPending(true, { completed: false }, false), true);
  });
  it('API yanıtı gelene kadar son bilinen değer', () => {
    assert.equal(isSetupPending(true, undefined, true), true);
    assert.equal(isSetupPending(true, undefined, false), false);
  });
  it('ayar izni olmayana gösterilmez', () => {
    assert.equal(isSetupPending(false, { completed: false }, true), false);
  });
});
