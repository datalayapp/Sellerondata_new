// Önizleme dosyası vazgeçme kararı: içe aktarma sürerken silme çağrısı gitmez (veri kaybı).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NO_FILE, beginImport, importFailed, importSucceeded, previewArrived, previewReady, takeDiscard } from '../src/pages/invoice-upload/liveFile.ts';

describe('liveFile', () => {
  it('önizleme var, içe aktarma başlamadı → vazgeçme gider', () => {
    assert.equal(takeDiscard(previewReady('f1')).discard, 'f1');
  });
  it('önizleme yok → gitmez', () => {
    assert.equal(takeDiscard(NO_FILE).discard, null);
  });
  it('içe aktarma sürerken → gitmez', () => {
    assert.equal(takeDiscard(beginImport(previewReady('f1'))).discard, null);
  });
  it('içe aktarma sürerken yinelenen çağrı da korur', () => {
    const s = beginImport(beginImport(previewReady('f1')));
    assert.equal(takeDiscard(s).discard, null);
    assert.equal(importFailed(s).live, 'f1');
  });
  it('içe aktarma hata verdikten sonra → gider', () => {
    assert.equal(takeDiscard(importFailed(beginImport(previewReady('f1')))).discard, 'f1');
  });
  it('içe aktarma başarılı olunca → gitmez', () => {
    assert.equal(takeDiscard(importSucceeded()).discard, null);
  });
  it('vazgeçme alındıktan sonra ikinci kez gitmez', () => {
    const { next } = takeDiscard(previewReady('f1'));
    assert.equal(takeDiscard(next).discard, null);
  });
  it('içe aktarma sürerken vazgeçme denenirse dosya yine geri verilebilir', () => {
    const { next } = takeDiscard(beginImport(previewReady('f1')));
    assert.equal(importFailed(next).live, 'f1');
  });
});

// 10-B5: "Yeniden oku" eski önizlemeyi yenisi gelmeden silmez; eski dosya yeni okuma uygulanınca silinir.
describe('previewArrived', () => {
  it('yeni okuma uygulandı → eski dosya ancak şimdi silinir, yenisi silinmeye açık', () => {
    const r = previewArrived(previewReady('f1'), 'f2');
    assert.equal(r.discard, 'f1');
    assert.equal(r.next.live, 'f2');
    assert.equal(takeDiscard(r.next).discard, 'f2');
  });
  it('içe aktarma sürerken yeni okuma uygulanırsa içe aktarılan dosya kaybolmaz (silinmez, geri verilebilir)', () => {
    const r = previewArrived(beginImport(previewReady('fA')), 'fB');
    assert.equal(r.discard, null);
    assert.equal(r.next.importing, 'fA');
    assert.equal(takeDiscard(r.next).discard, 'fB');
    assert.equal(takeDiscard(r.next).next.importing, 'fA');
  });
  it('sunucu aynı dosyayı döndürdüyse silinmez', () => {
    assert.equal(previewArrived(previewReady('f1'), 'f1').discard, null);
  });
  it('önceki önizleme yoksa ya da vazgeçilmişse silme yok', () => {
    assert.equal(previewArrived(NO_FILE, 'f1').discard, null);
    assert.equal(previewArrived(takeDiscard(previewReady('f1')).next, 'f2').discard, null);
  });
});
