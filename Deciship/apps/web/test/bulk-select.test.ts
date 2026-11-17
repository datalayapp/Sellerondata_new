// Mesaj 14 (Parça D): satır seçimi modeli ve toplu karar gövdesi.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_SELECTION,
  decideBody,
  filterOf,
  isChecked,
  isEligible,
  offersSelectAll,
  pageState,
  selectFilter,
  selectedCount,
  selectionKey,
  skippedSummary,
  toggleLine,
  togglePage,
  undoBody,
  type Selection,
} from '../src/pages/invoice-detail/bulk.ts';

const page = ['a', 'b', 'c'];
/** Liste yanıtının `selectionDigest`'i (süzgecin bütün satırlarının özeti, Y127). */
const DIGEST = 'a'.repeat(64);
/** Geri al gövdesindeki karar anı. */
const AT = '2026-11-11T09:30:00.000Z';
const ids = (...x: string[]): Selection => ({ mode: 'ids', ids: new Set(x) });
const idList = (s: Selection) => (s.mode === 'ids' ? [...s.ids].sort() : null);

describe('isEligible', () => {
  const base = { status: 'DIFF', decision: 'OPEN', recalcPending: null, dispute: null } as const;
  it('kararı bekleyen fark satırı uygundur', () => {
    assert.equal(isEligible(base), true);
  });
  it('uyumlu, kararı verilmiş, yeniden hesap bekleyen ve itirazdaki satır uygun değildir', () => {
    assert.equal(isEligible({ ...base, status: 'MATCH' }), false);
    assert.equal(isEligible({ ...base, decision: 'VERIFIED' }), false);
    assert.equal(isEligible({ ...base, recalcPending: 'MEASUREMENT' }), false);
    assert.equal(isEligible({ ...base, dispute: { outcome: 'PENDING' } as never }), false);
  });
});

describe('toggleLine ve togglePage', () => {
  it('tek satır eklenir ve çıkarılır', () => {
    let s = toggleLine(EMPTY_SELECTION, 'a', page);
    assert.deepEqual(idList(s), ['a']);
    s = toggleLine(s, 'b', page);
    assert.deepEqual(idList(s), ['a', 'b']);
    s = toggleLine(s, 'a', page);
    assert.deepEqual(idList(s), ['b']);
  });
  it('işlemler eldeki seçimi değiştirmez', () => {
    const s = ids('a');
    toggleLine(s, 'b', page);
    togglePage(s, page);
    assert.deepEqual(idList(s), ['a']);
  });
  it('başlık kutusu: hepsi seçili değilse hepsini ekler, hepsi seçiliyse hepsini bırakır', () => {
    let s = togglePage(ids('a'), page);
    assert.deepEqual(idList(s), ['a', 'b', 'c']);
    s = togglePage(s, page);
    assert.deepEqual(idList(s), []);
  });
  it('başka sayfadan seçilen satırlar korunur', () => {
    const s = togglePage(ids('z'), page);
    assert.deepEqual(idList(s), ['a', 'b', 'c', 'z']);
    assert.deepEqual(idList(togglePage(s, page)), ['z']);
  });
  it('sayfa değişince ids kipi korunur: başka sayfanın uygun satırları o sayfada işaretsiz görünür', () => {
    const s = ids('a', 'b');
    assert.equal(pageState(s, ['x', 'y']), 'none');
    assert.equal(pageState(s, page), 'some');
    assert.equal(pageState(ids('a', 'b', 'c'), page), 'all');
    assert.equal(selectedCount(s), 2);
  });
  it('uygun satırı olmayan sayfada başlık kutusu seçili sayılmaz', () => {
    assert.equal(pageState(EMPTY_SELECTION, []), 'none');
    assert.equal(pageState(selectFilter(10, DIGEST), []), 'none');
  });
});

describe('filter kipi', () => {
  it('uygun her satır işaretli, uygun olmayan işaretsiz; sayı süzgecin toplamı', () => {
    const s = selectFilter(214, DIGEST);
    assert.equal(selectedCount(s), 214);
    assert.equal(isChecked(s, 'a', true), true);
    assert.equal(isChecked(s, 'q', false), false);
    assert.equal(pageState(s, page), 'all');
  });
  it('bir satırın işareti kaldırılınca bu sayfanın satırlarından o satır çıkarılmış ids kipine döner', () => {
    const s = toggleLine(selectFilter(214, DIGEST), 'b', page);
    assert.equal(s.mode, 'ids');
    assert.deepEqual(idList(s), ['a', 'c']);
    assert.equal(selectedCount(s), 2);
  });
  it('başlık kutusu filter kipinde seçimi boşaltır', () => {
    const s = togglePage(selectFilter(214, DIGEST), page);
    assert.equal(s.mode, 'ids');
    assert.equal(selectedCount(s), 0);
  });
  it('filter kipinde ekleme yapılmaz (zaten hepsi seçili)', () => {
    assert.equal(isChecked(selectFilter(5, DIGEST), 'a', true), true);
  });
  it('10-B14: süzgeçteki uygun satır sayısı biliniyorsa seçilen sayı odur; sunucuya giden beklenen sayı süzgecin toplamı kalır', () => {
    const s = selectFilter(1240, DIGEST, 30);
    assert.equal(selectedCount(s), 30);
    assert.deepEqual(decideBody(s, 'ACCEPTED', { status: 'DIFF' }, 'x'), { decision: 'ACCEPTED', filter: { status: 'DIFF' }, expectedCount: 1240, selectionDigest: DIGEST, reason: 'x' });
    // eski sunucu (sayı yok): süzgecin toplamı
    assert.equal(selectedCount(selectFilter(1240, DIGEST, null)), 1240);
  });
});

describe('offersSelectAll', () => {
  it('sayfadaki hepsi seçiliyken ve süzgeçte başka satır varken sunulur', () => {
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 214, DIGEST), true);
  });
  it('sayfa tam seçili değilse, tek sayfa varsa, zaten filter kipindeyse ya da sınır aşılıyorsa sunulmaz', () => {
    assert.equal(offersSelectAll(ids('a', 'b'), page, 3, 214, DIGEST), false);
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 3, DIGEST), false);
    assert.equal(offersSelectAll(selectFilter(214, DIGEST), page, 3, 214, DIGEST), false);
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 5001, DIGEST), false);
    assert.equal(offersSelectAll(EMPTY_SELECTION, [], 0, 10, DIGEST), false);
  });
  it('liste küme özetini vermediyse (karar izni yok, eski sunucu) sunulmaz', () => {
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 214, null), false);
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 214, undefined), false);
  });
  it('10-B14: süzgeçteki uygun satırların hepsi bu sayfadaysa sunulmaz (seçime bir şey eklemez)', () => {
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 214, DIGEST, 3), false);
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 214, DIGEST, 4), true);
    assert.equal(offersSelectAll(ids('a', 'b', 'c'), page, 3, 214, DIGEST, null), true);
  });
});

describe('selectionKey ve filterOf', () => {
  const p = { invoiceId: 'i1', tab: 'DIFF', diffType: '', decision: '', q: '' };
  it('süzgecin herhangi bir parçası değişince anahtar değişir', () => {
    const k = selectionKey(p);
    assert.equal(selectionKey({ ...p }), k);
    for (const patch of [{ invoiceId: 'i2' }, { tab: 'ALL' }, { diffType: 'WEIGHT' }, { decision: 'OPEN' }, { q: '1Z' }]) {
      assert.notEqual(selectionKey({ ...p, ...patch }), k, JSON.stringify(patch));
    }
  });
  it('Fark var sekmesi status=DIFF, Tümü durumsuz; boş alan gönderilmez', () => {
    assert.deepEqual(filterOf({ tab: 'DIFF', diffType: '', decision: '', q: '' }), { status: 'DIFF' });
    assert.deepEqual(filterOf({ tab: 'ALL', diffType: '', decision: '', q: '' }), {});
  });
  it('tür, karar ve arama süzgece girer; ek karar seçenekleri işarete çevrilir', () => {
    assert.deepEqual(filterOf({ tab: 'ALL', diffType: 'WEIGHT', decision: 'OPEN', q: '1Z' }), { diffType: 'WEIGHT', decision: ['OPEN'], q: '1Z' });
    assert.deepEqual(filterOf({ tab: 'DIFF', diffType: '', decision: 'REVIEW', q: '' }), { status: 'DIFF', review: true });
    assert.deepEqual(filterOf({ tab: 'DIFF', diffType: '', decision: 'RECALC', q: '' }), { status: 'DIFF', recalcPending: true });
  });
});

describe('decideBody', () => {
  it('ids kipi lineIds gönderir, süzgeç ve expectedCount göndermez', () => {
    const b = decideBody(ids('a', 'b'), 'VERIFIED', { status: 'DIFF' });
    assert.deepEqual(b, { decision: 'VERIFIED', lineIds: ['a', 'b'] });
  });
  it('filter kipi süzgeç, expectedCount ve listenin küme özetini (selectionDigest) gönderir, lineIds göndermez', () => {
    const b = decideBody(selectFilter(214, DIGEST), 'ACCEPTED', { status: 'DIFF', q: '1Z' }, 'Taşıyıcı haklı');
    assert.deepEqual(b, { decision: 'ACCEPTED', filter: { status: 'DIFF', q: '1Z' }, expectedCount: 214, selectionDigest: DIGEST, reason: 'Taşıyıcı haklı' });
    assert.equal('listedAt' in b, false);
    assert.equal('lineIds' in b, false);
  });
  it('gerekçe yoksa alan eklenmez', () => {
    assert.equal('reason' in decideBody(ids('a'), 'VERIFIED', {}), false);
  });
});

describe('undoBody', () => {
  it('Geri al ilk işlemin kimliğini ve karar anını taşır: yalnız o kararı taşıyan satırlar açılır', () => {
    const b = undoBody({ opId: 'op1', changedLineIds: ['a', 'b'], decidedAt: AT });
    assert.deepEqual(b, { decision: 'OPEN', lineIds: ['a', 'b'], undoOf: { opId: 'op1', decidedAt: AT } });
  });
  it('karar anı yoksa (eski sunucu) düz geri alma', () => {
    assert.deepEqual(undoBody({ opId: 'op1', changedLineIds: ['a'], decidedAt: null }), { decision: 'OPEN', lineIds: ['a'] });
  });
});

describe('skippedSummary', () => {
  const none = { inDispute: 0, noGap: 0, review: 0, decided: 0, pending: 0, notDecided: 0, noClaim: 0, changedSince: 0 };
  it('yalnız sıfırdan büyük nedenler, sabit sırayla; notDecided sayılmaz', () => {
    const r = skippedSummary({ ...none, noGap: 2, review: 1, notDecided: 7 });
    assert.deepEqual(r, { total: 3, keys: ['review', 'noGap'] });
  });
  it('talebi sıfır olan satır ve bu arada değişen karar ayrı nedenle', () => {
    assert.deepEqual(skippedSummary({ ...none, noClaim: 1, changedSince: 2, inDispute: 1 }), { total: 4, keys: ['inDispute', 'noClaim', 'changedSince'] });
  });
  it('hiç atlanan yoksa boş', () => {
    assert.deepEqual(skippedSummary(none), { total: 0, keys: [] });
  });
  it('neden adlarında para sözcüğü yok (fiyat izni olmayan rolde API "diff" geçen alanı siler)', () => {
    for (const k of Object.keys(none)) assert.doesNotMatch(k, /price|amount|expected|diff|net|billed|overcharge|total/i, k);
  });
});
