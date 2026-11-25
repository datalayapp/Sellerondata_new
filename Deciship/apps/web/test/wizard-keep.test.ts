// Yükleme sihirbazı emeği korur (Mesaj 5: 10-B5, 10-B9): "Geri", "Devam", taşıyıcı/dosya değişimi ve yeniden okumanın kararı.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canContinue, isEdited, planCarrierPick, planFilePick, rereadFresh, rowsKey, sameFile, switchTariff, type PreviewSource } from '../src/pages/invoice-upload/wizardKeep.ts';

const A = { name: 'fatura.pdf', size: 1000, lastModified: 1 };
const A2 = { ...A }; // aynı dosya yeniden seçildi (başka `File` nesnesi)
const B = { name: 'fatura.pdf', size: 1000, lastModified: 2 }; // aynı ad, dosya değişti
const src = (carrierId: string, file: typeof A | null = A): PreviewSource => ({ file, carrierId });

describe('sameFile', () => {
  it('ad, boyut ve değişme zamanı aynıysa aynı dosya', () => {
    assert.equal(sameFile(A, A2), true);
    assert.equal(sameFile(A, B), false);
    assert.equal(sameFile(A, { ...A, size: 999 }), false);
    assert.equal(sameFile({ name: 'a', size: 1 }, { name: 'a', size: 1 }), true);
  });
});

describe('canContinue: 1. adımda "Devam"', () => {
  it('önizleme seçili taşıyıcıyla okunmuş ve okuma sürmüyor → var', () => {
    assert.equal(canContinue(src('cf'), 'cf', false), true);
  });
  it('önizleme yok, okuma sürüyor ya da başka taşıyıcı seçili → yok', () => {
    assert.equal(canContinue(null, 'cf', false), false);
    assert.equal(canContinue(src('cf'), 'cf', true), false);
    assert.equal(canContinue(src('cf'), 'ca', false), false);
  });
  it('sürdürme bandından açılan önizleme (yerel dosya yok) da açılır', () => {
    assert.equal(canContinue(src('cf', null), 'cf', false), true);
  });
});

describe('planCarrierPick', () => {
  const base = { current: 'cf', file: A, src: src('cf'), edited: false };
  it('aynı taşıyıcıya tıklamak hiçbir şeyi değiştirmez (yeniden okuma yok)', () => {
    assert.deepEqual(planCarrierPick({ ...base, picked: 'cf', edited: true }), { do: 'none' });
  });
  it('başka taşıyıcı: aynı dosya yeniden okunur, eski önizleme yenisi gelene kadar kalır; düzeltme yoksa sorulmaz', () => {
    assert.deepEqual(planCarrierPick({ ...base, picked: 'ca' }), { do: 'read', keepOld: true, ask: false });
  });
  it('düzeltme varsa önce sorulur', () => {
    assert.deepEqual(planCarrierPick({ ...base, picked: 'ca', edited: true }), { do: 'read', keepOld: true, ask: true });
  });
  it('önizlemenin taşıyıcısına geri dönmek okumaz, önizlemeyi açar', () => {
    assert.deepEqual(planCarrierPick({ ...base, current: 'ca', picked: 'cf', edited: true }), { do: 'back' });
  });
  it('önizleme yokken: dosya varsa okunur (sorulmaz), yoksa yalnız seçim', () => {
    assert.deepEqual(planCarrierPick({ current: '', picked: 'cf', file: A, src: null, edited: false }), { do: 'read', keepOld: false, ask: false });
    assert.deepEqual(planCarrierPick({ current: '', picked: 'cf', file: null, src: null, edited: false }), { do: 'set' });
  });
  it('PDF önizlemesi taşıyıcıya bağlı değil: başka taşıyıcı yalnız seçimi değiştirir (okuma, soru yok)', () => {
    const pdf = { ...src('cf'), pdf: true };
    assert.deepEqual(planCarrierPick({ ...base, src: pdf, picked: 'ca', edited: true }), { do: 'retarget' });
    assert.deepEqual(planCarrierPick({ ...base, src: { ...pdf, file: null }, file: null, picked: 'ca' }), { do: 'retarget' });
    assert.deepEqual(planCarrierPick({ ...base, src: pdf, picked: 'cf', edited: true }), { do: 'none' });
  });
  it('sürdürülen önizlemede yerel dosya yok: taşıyıcı değişir, okunmaz (önizleme silinmez)', () => {
    assert.deepEqual(planCarrierPick({ current: 'cf', picked: 'ca', file: null, src: src('cf', null), edited: true }), { do: 'set' });
  });
});

describe('planFilePick', () => {
  it('aynı dosya aynı taşıyıcıyla yeniden seçildi → okunmadan önizleme açılır', () => {
    assert.deepEqual(planFilePick({ file: A2, carrierId: 'cf', src: src('cf'), edited: true }), { do: 'show' });
  });
  it('başka dosya → eski önizleme bırakılır (silinir); düzeltme varsa önce sorulur', () => {
    assert.deepEqual(planFilePick({ file: B, carrierId: 'cf', src: src('cf'), edited: false }), { do: 'read', keepOld: false, ask: false });
    assert.deepEqual(planFilePick({ file: B, carrierId: 'cf', src: src('cf'), edited: true }), { do: 'read', keepOld: false, ask: true });
  });
  it('aynı dosya ama taşıyıcı değişmiş (okuma düşmüştü) → yeniden okunur, eski önizleme kalır', () => {
    assert.deepEqual(planFilePick({ file: A2, carrierId: 'ca', src: src('cf'), edited: true }), { do: 'read', keepOld: true, ask: true });
  });
  it('önizleme yok → okunur; sürdürülen önizlemede (yerel dosya yok) seçilen dosya başka dosyadır', () => {
    assert.deepEqual(planFilePick({ file: A, carrierId: 'cf', src: null, edited: false }), { do: 'read', keepOld: false, ask: false });
    assert.deepEqual(planFilePick({ file: A, carrierId: 'cf', src: src('cf', null), edited: false }), { do: 'read', keepOld: false, ask: false });
  });
});

describe('isEdited: düzeltme var mı', () => {
  const rows = [{ key: 'k1', trackingNo: '1', netAmount: '10,00' }];
  const base = { rows: rowsKey(rows), mapping: '', metaEdited: false };
  it('okunduğu gibi → yok; ekrandaki rastgele satır anahtarı sayılmaz', () => {
    assert.equal(isEdited(base, { ...base }), false);
    assert.equal(isEdited(base, { ...base, rows: rowsKey([{ ...rows[0]!, key: 'k2' }]) }), false);
  });
  it('hücre, satır silme, eşleme ya da elle fatura bilgisi → var', () => {
    const cellEdited = { ...rows[0]!, netAmount: '12,00' };
    assert.equal(isEdited(base, { ...base, rows: rowsKey([cellEdited]) }), true);
    assert.equal(isEdited(base, { ...base, rows: rowsKey([]) }), true);
    assert.equal(isEdited({ rows: '', mapping: '{"a":1}', metaEdited: false }, { rows: '', mapping: '{"a":2}', metaEdited: false }), true);
    assert.equal(isEdited(base, { ...base, metaEdited: true }), true);
  });
  it('önizleme yok → yok', () => {
    assert.equal(isEdited(null, { ...base, metaEdited: true }), false);
  });
});

describe('switchTariff: A→B→A tarifeyi sıfırlamaz', () => {
  it('bırakılan taşıyıcının tarifesi hatırlanır, dönünce geri gelir; hiç seçilmemişse varsayılan ("")', () => {
    const ab = switchTariff({}, 'cf', 't1', 'ca');
    assert.equal(ab.tariffId, '');
    const ba = switchTariff(ab.memo, 'ca', 't9', 'cf');
    assert.equal(ba.tariffId, 't1');
    assert.equal(switchTariff(ba.memo, 'cf', 't1', 'ca').tariffId, 't9');
  });
  it('ilk seçimde (önceki taşıyıcı yok) hatıra yazılmaz', () => {
    assert.deepEqual(switchTariff({}, '', '', 'cf'), { memo: {}, tariffId: '' });
  });
});

describe('rereadFresh: "Yeniden oku" çift ücretlemez', () => {
  it('önceki "Yeniden oku"nun işi başladı ve uygulanmadı → fresh gitmez; değilse gider', () => {
    assert.equal(rereadFresh(true), false);
    assert.equal(rereadFresh(false), true);
  });
});
