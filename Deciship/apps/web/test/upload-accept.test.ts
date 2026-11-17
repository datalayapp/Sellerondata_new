// Dosya seçicinin kabul listesi: PDF yalnız yapay zekâ okuma açıkken, .xls hiçbir durumda yok.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptList, isBlockedPdf, pdfReadState, retryFresh } from '../src/pages/invoice-upload/acceptList.ts';

describe('acceptList', () => {
  it('aiAvailable=true iken .pdf içerir', () => {
    assert.ok(acceptList(true).split(',').includes('.pdf'));
  });
  it('aiAvailable=false iken .pdf içermez', () => {
    assert.ok(!acceptList(false).split(',').includes('.pdf'));
    assert.ok(!acceptList(false).includes('application/pdf'));
  });
  it('.xls hiçbir durumda yok', () => {
    for (const ai of [true, false]) assert.ok(!acceptList(ai).split(',').includes('.xls'));
  });
  it('.xlsx ve .csv her durumda var', () => {
    for (const ai of [true, false]) {
      const parts = acceptList(ai).split(',');
      assert.ok(parts.includes('.xlsx') && parts.includes('.csv'));
    }
  });
});

describe('isBlockedPdf', () => {
  it('yalnız aiAvailable === false iken PDF engellenir', () => {
    assert.equal(isBlockedPdf({ name: 'a.PDF' }, false), true);
    assert.equal(isBlockedPdf({ name: 'a.pdf' }, true), false);
    assert.equal(isBlockedPdf({ name: 'a.pdf' }, undefined), false);
    assert.equal(isBlockedPdf({ name: 'a.csv' }, false), false);
  });
});

describe('pdfReadState (Y62-E3)', () => {
  it('anahtar yok → off; hak doldu → quota; bilgi yoksa açık', () => {
    assert.equal(pdfReadState({ aiAvailable: false, ai: { quotaExhausted: true } }), 'off');
    assert.equal(pdfReadState({ aiAvailable: true, ai: { quotaExhausted: true } }), 'quota');
    assert.equal(pdfReadState({ aiAvailable: true, ai: { quotaExhausted: false } }), 'on');
    // eski sunucu: `ai` alanı yok
    assert.equal(pdfReadState({ aiAvailable: true }), 'on');
    assert.equal(pdfReadState(null), 'on');
    assert.equal(pdfReadState(undefined), 'on');
  });
  it('hak dolunca kabul listesi PDF içermez ve PDF seçimi engellenir', () => {
    const open = pdfReadState({ aiAvailable: true, ai: { quotaExhausted: true } }) === 'on';
    assert.ok(!acceptList(open).split(',').includes('.pdf'));
    assert.equal(isBlockedPdf({ name: 'fatura.pdf' }, open), true);
    assert.equal(isBlockedPdf({ name: 'fatura.xlsx' }, open), false);
  });
});

describe('retryFresh (Y62-E3 "Yeniden oku" sonrası "Tekrar dene")', () => {
  it('iş başladıysa tekrar fresh gitmez: işin ücretlediği parçalar önbellekten gelir, ikinci kez ücretlenmez', () => {
    assert.equal(retryFresh(true, true), false);
  });
  it('iş hiç başlamadıysa (istek reddedildi) yeniden okuma isteği sürer', () => {
    assert.equal(retryFresh(true, false), true);
  });
  it('olağan okumanın tekrarı hiçbir durumda fresh olmaz', () => {
    assert.equal(retryFresh(false, false), false);
    assert.equal(retryFresh(false, true), false);
  });
});
