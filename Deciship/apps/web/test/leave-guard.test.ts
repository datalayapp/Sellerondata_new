// Sayfadan çıkış koruması: hangi gezinti engellenir.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldBlockLeave } from '../src/lib/leaveGuard.ts';

const base = { dirty: true, released: false, from: '/settings', to: '/invoices' };

describe('shouldBlockLeave', () => {
  it('yazılmış sayfadan başka yola gidiş engellenir', () => {
    assert.equal(shouldBlockLeave(base), true);
  });
  it('değişiklik yoksa engellenmez', () => {
    assert.equal(shouldBlockLeave({ ...base, dirty: false }), false);
  });
  it('kişi çıkışa izin verdiyse engellenmez', () => {
    assert.equal(shouldBlockLeave({ ...base, released: true }), false);
  });
  it('aynı yolda (yalnız sorgu değişir) engellenmez', () => {
    assert.equal(shouldBlockLeave({ ...base, to: '/settings' }), false);
  });
});
