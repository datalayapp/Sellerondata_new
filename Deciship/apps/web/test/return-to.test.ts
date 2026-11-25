// Kurulum sihirbazının dönüş adresi (?donus=): yalnız uygulama içi yol, parametreler korunur.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addQuery, safeReturnPath, withReturn } from '../src/lib/returnTo.ts';

describe('dönüş adresi', () => {
  it('yalnız uygulama içi yolu kabul eder', () => {
    assert.equal(safeReturnPath('/setup?adim=tarifeler'), '/setup?adim=tarifeler');
    assert.equal(safeReturnPath('https://kotu.example'), null);
    assert.equal(safeReturnPath('//kotu.example'), null);
    assert.equal(safeReturnPath('/\\kotu.example'), null);
    assert.equal(safeReturnPath(''), null);
    assert.equal(safeReturnPath(null), null);
  });

  it('dönüşü ekler ve ek parametreleri birleştirir', () => {
    assert.equal(withReturn('/tariffs/new?carrierId=c1', '/setup?adim=tarifeler'), '/tariffs/new?carrierId=c1&donus=%2Fsetup%3Fadim%3Dtarifeler');
    assert.equal(withReturn('/tariffs/t1', null), '/tariffs/t1');
    assert.equal(addQuery('/setup?adim=kalibrasyon', { fatura: 'abc' }), '/setup?adim=kalibrasyon&fatura=abc');
    assert.equal(addQuery('/setup', { fatura: 'abc' }), '/setup?fatura=abc');
  });
});
