// /deciship/ altında yayın: router yolu, tarayıcı yolu ve giriş dönüşü.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APP_BASE, isAppHref, loginHref, toFullPath, toRouterPath } from '../src/lib/base.ts';

describe('yol tabanı', () => {
  it('kendi yolunu ayırır; benzer ad ve Merkez yolları dışarıda kalır', () => {
    assert.equal(isAppHref('/deciship'), true);
    assert.equal(isAppHref('/deciship/'), true);
    assert.equal(isAppHref('/deciship/invoices'), true);
    assert.equal(isAppHref('/deciship-old'), false);
    assert.equal(isAppHref('/home'), false);
    assert.equal(isAppHref('/account/tool-access/deciship'), false);
  });
  it('router yoluna çevirir', () => {
    assert.equal(toRouterPath('/deciship/'), '/');
    assert.equal(toRouterPath('/deciship'), '/');
    assert.equal(toRouterPath('/deciship/invoices?x=1'), '/invoices?x=1');
    assert.equal(toRouterPath('/home'), '/home');
  });
  it('tarayıcı yoluna çevirir', () => {
    assert.equal(toFullPath('/'), `${APP_BASE}/`);
    assert.equal(toFullPath('/invoices'), '/deciship/invoices');
  });
  it('giriş bağlantısı kalınan yeri kodlu taşır', () => {
    assert.equal(loginHref('/deciship/invoices', '?q=a b'), '/login?next=%2Fdeciship%2Finvoices%3Fq%3Da%20b');
  });
});
