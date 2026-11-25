// Firmayı kapatma ve geri açma ekranlarının kuralları (closeOrg.ts): bölüm yalnız sahibe, kırmızı düğme ad + şifreyle açılır, sunucu
// hataları koda göre metne döner ve her metin TR + EN sözlükte var. Ekranlar bu işlevleri kullanır (pages/account/CloseOrg.tsx).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ORG_PURGE_DAYS_DEFAULT } from '@sellerondata/contracts';
import { canCloseOrg, canSubmitClose, closeErrorKey, closedOrgDate, closedOrgOf, closedOrgsOf, isOrgClosedError, noteReopened, purgePreview, reopenErrorOf, takeReopened } from './closeOrg.ts';

const dict = (lang) => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../locales/${lang}/closeOrg.json`), 'utf8'));
const lookup = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const me = (orgRole, orgs = []) => ({ activeOrg: orgRole ? { id: 'o1', name: 'Örnek Firma', orgRole } : null, orgs });

describe('Firmayı kapat bölümü', () => {
  test('yalnız etkin firmanın sahibine görünür', () => {
    assert.equal(canCloseOrg(me('OWNER')), true);
    assert.equal(canCloseOrg(me('ADMIN')), false);
    assert.equal(canCloseOrg(me('MEMBER')), false);
    assert.equal(canCloseOrg(me(null)), false);
    assert.equal(canCloseOrg(null), false);
  });

  test('kırmızı düğme: ad firma adıyla aynı (boşluk, büyük/küçük ve Türkçe İ/i farkı yok) ve şifre dolu', () => {
    const name = 'Örnek İhracat Ltd.';
    assert.equal(canSubmitClose('', '', name), false);
    assert.equal(canSubmitClose(name, '', name), false);
    assert.equal(canSubmitClose('', 'Test12345!', name), false);
    assert.equal(canSubmitClose('Örnek İhracat', 'Test12345!', name), false);
    assert.equal(canSubmitClose(name, 'Test12345!', name), true);
    assert.equal(canSubmitClose('  örnek ihracat ltd.  ', 'x', name), true);
    assert.equal(canSubmitClose('ÖRNEK İHRACAT LTD.', 'x', name), true);
    // Türkçe küçük harf: "I" "ı" olur, "i" ile aynı sayılmaz.
    assert.equal(canSubmitClose('ORNEK IHRACAT LTD.', 'x', 'Ornek ihracat Ltd.'), false);
  });

  test('saklama bitişi ön izlemesi varsayılan gün sayısı sonrası', () => {
    const now = Date.parse('2026-11-13T09:00:00Z');
    assert.equal(ORG_PURGE_DAYS_DEFAULT, 30);
    assert.equal(purgePreview(now), '2026-12-13T09:00:00.000Z');
    assert.equal(purgePreview(now, 7), '2026-11-20T09:00:00.000Z');
  });

  test('kapatma hataları koda göre kendi metnine; bilinmeyen kod sunucu metnine (null)', () => {
    assert.equal(closeErrorKey({ code: 'CONFIRM_NAME_MISMATCH' }), 'closeOrg.err.name');
    assert.equal(closeErrorKey({ code: 'INVALID_CREDENTIALS' }), 'closeOrg.err.password');
    assert.equal(closeErrorKey({ code: 'ORG_CLOSED' }), 'closeOrg.err.alreadyClosed');
    assert.equal(closeErrorKey({ code: 'FORBIDDEN' }), 'closeOrg.err.ownerOnly');
    // 429 bekleme süresini sunucu metniyle söyler (apiMessage).
    assert.equal(closeErrorKey({ code: 'TOO_MANY_ATTEMPTS' }), null);
    assert.equal(closeErrorKey(new Error('ağ')), null);
    assert.equal(closeErrorKey(null), null);
  });
});

describe('Kapalı firma ekranı', () => {
  const closed = { id: 'o9', name: 'Eski Şube Ltd.', orgRole: 'OWNER', status: 'ACTIVE', orgStatus: 'CLOSED', closedAt: '2026-11-13T09:00:00.000Z', purgeAfter: '2026-12-13T09:00:00.000Z' };
  const open = { id: 'o1', name: 'Örnek Firma', orgRole: 'OWNER', status: 'ACTIVE', orgStatus: 'ACTIVE' };
  const legacy = { id: 'o2', name: 'Eski sunucu', orgRole: 'ADMIN', status: 'ACTIVE' };

  test('yalnız /me listesinde kapalı olan firma bulunur; açık, eski sunucu ve bilinmeyen firma null', () => {
    const m = me('OWNER', [open, closed, legacy]);
    assert.deepEqual(closedOrgsOf(m).map((o) => o.id), ['o9']);
    assert.equal(closedOrgOf(m, 'o9'), closed);
    assert.equal(closedOrgOf(m, 'o1'), null);
    assert.equal(closedOrgOf(m, 'o2'), null);
    assert.equal(closedOrgOf(m, 'yok'), null);
    assert.equal(closedOrgOf(m, undefined), null);
    assert.equal(closedOrgOf(null, 'o9'), null);
  });

  test('geri açma hataları: şifre pencerede kalır; süre dolmuş, bulunamadı, zaten açık ekranı sakin hale düşürür', () => {
    assert.deepEqual(reopenErrorOf({ code: 'INVALID_CREDENTIALS' }), { key: 'closeOrg.err.password', gone: false });
    assert.deepEqual(reopenErrorOf({ code: 'ORG_PURGED' }), { key: 'closeOrg.err.purged', gone: true });
    assert.deepEqual(reopenErrorOf({ code: 'ORG_NOT_FOUND' }), { key: 'closeOrg.err.notFound', gone: true });
    assert.deepEqual(reopenErrorOf({ code: 'CONFLICT' }), { key: 'closeOrg.err.notClosed', gone: true });
    assert.deepEqual(reopenErrorOf({ code: 'TOO_MANY_ATTEMPTS' }), { key: null, gone: false });
  });

  test('hata anahtarlarının hepsi TR ve EN sözlükte dolu', () => {
    const codes = ['CONFIRM_NAME_MISMATCH', 'INVALID_CREDENTIALS', 'ORG_CLOSED', 'FORBIDDEN', 'ORG_PURGED', 'ORG_NOT_FOUND', 'CONFLICT'];
    const keys = new Set(codes.flatMap((code) => [closeErrorKey({ code }), reopenErrorOf({ code }).key]).filter(Boolean));
    assert.ok(keys.size >= 7);
    for (const lang of ['tr', 'en']) for (const k of keys) assert.ok(typeof lookup(dict(lang), k) === 'string' && lookup(dict(lang), k).length > 0, `${lang} ${k}`);
  });
});

describe('Kapalı firmanın tarihleri, kapalı firma yanıtı ve geri açma iletisi', () => {
  test('tarih kapalı firmanın kendi saat diliminde (etkin firmanınkinde değil); dilim yoksa verilen yedek', () => {
    // Londra'da 13 Aralık 23:30, İstanbul'da 14 Aralık 02:30.
    const iso = '2026-12-13T23:30:00.000Z';
    assert.equal(closedOrgDate(iso, 'tr', 'Europe/London', 'Europe/Istanbul'), '13 Aralık 2026');
    assert.equal(closedOrgDate(iso, 'en', 'Europe/London', 'Europe/Istanbul'), '13 December 2026');
    assert.equal(closedOrgDate(iso, 'tr', undefined, 'Europe/Istanbul'), '14 Aralık 2026');
    // listede olmayan ya da bozuk dilim: yedek
    assert.equal(closedOrgDate(iso, 'tr', 'Mars/Olympus', 'Europe/Istanbul'), '14 Aralık 2026');
    assert.equal(closedOrgDate('bozuk', 'tr', 'Europe/London'), '—');
  });

  test('ORG_CLOSED yanıtı tanınır (kabuk kişiyi yeniden okur); başka kodlar ve hata olmayanlar değil', () => {
    assert.equal(isOrgClosedError({ status: 409, code: 'ORG_CLOSED' }), true);
    assert.equal(isOrgClosedError({ status: 409, code: 'ORG_MISMATCH' }), false);
    assert.equal(isOrgClosedError({ status: 401, code: 'TOKEN_STALE' }), false);
    assert.equal(isOrgClosedError(new Error('ORG_CLOSED')), false);
    assert.equal(isOrgClosedError(null), false);
  });

  test('geri açma iletisi sayfa yenilendikten sonra bir kez gösterilir; depo kapalıysa sessizce yok', () => {
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
    assert.equal(takeReopened(storage), null);
    noteReopened(storage, 'Eski Şube Ltd.');
    assert.equal(takeReopened(storage), 'Eski Şube Ltd.');
    assert.equal(takeReopened(storage), null);
    const broken = { getItem: () => { throw new Error('kapalı'); }, setItem: () => { throw new Error('kapalı'); }, removeItem: () => { throw new Error('kapalı'); } };
    assert.doesNotThrow(() => noteReopened(broken, 'x'));
    assert.equal(takeReopened(broken), null);
    assert.equal(takeReopened(undefined), null);
  });

  test('geri açma iletisi TR ve EN sözlükte, firma adını taşır', () => {
    for (const lang of ['tr', 'en']) {
      const text = lookup(dict(lang), 'closeOrg.reopened');
      assert.ok(typeof text === 'string' && text.includes('{{org}}'), lang);
    }
  });
});
