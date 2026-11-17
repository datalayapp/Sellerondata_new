// İtiraz penceresi: e-posta bağlantısı uzunluğu, kısa gövdeye düşme, dil değişiminde onay, hatırlanan adres anahtarı.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { disputeEmailKey, isTooLong, mailPlan, mailtoHref, MAILTO_MAX, needsLangConfirm, signatureHeaders } from '../src/lib/disputeMail.ts';

describe('mailtoHref ve isTooLong', () => {
  it('adres, konu ve gövdeyi kodlar', () => {
    assert.equal(
      mailtoHref('a@b.com', 'Konu ş', 'Satır 1\nSatır 2'),
      'mailto:a%40b.com?subject=Konu%20%C5%9F&body=Sat%C4%B1r%201%0ASat%C4%B1r%202',
    );
  });
  it('sınır tam 1.800 karakterde uzun sayılmaz, bir fazlasında sayılır', () => {
    const base = mailtoHref('a@b.com', 's', '').length;
    assert.equal(isTooLong(mailtoHref('a@b.com', 's', 'x'.repeat(MAILTO_MAX - base))), false);
    assert.equal(isTooLong(mailtoHref('a@b.com', 's', 'x'.repeat(MAILTO_MAX - base + 1))), true);
  });
  it('kodlama uzunluğu büyütür: Türkçe harfler üç karakter tutar', () => {
    assert.equal(isTooLong(mailtoHref('a@b.com', 's', 'ş'.repeat(300))), true);
  });
});

describe('mailPlan', () => {
  it('kısa metinde tam gövde gider', () => {
    const p = mailPlan('a@b.com', 'Konu', 'kısa', 'GİRİŞ');
    assert.equal(p.long, false);
    assert.equal(p.href, mailtoHref('a@b.com', 'Konu', 'kısa'));
  });
  it('uzun metinde yalnız kısa giriş gider', () => {
    const p = mailPlan('a@b.com', 'Konu', 'x'.repeat(3000), 'GİRİŞ');
    assert.equal(p.long, true);
    assert.equal(p.href, mailtoHref('a@b.com', 'Konu', 'GİRİŞ'));
    assert.equal(isTooLong(p.href), false);
  });
});

describe('needsLangConfirm', () => {
  const loaded = { subject: 'S', body: 'B' };
  it('yüklenen metin değişmediyse sormaz', () => {
    assert.equal(needsLangConfirm(loaded, { subject: 'S', body: 'B' }), false);
  });
  it('konu ya da metin düzenlendiyse sorar', () => {
    assert.equal(needsLangConfirm(loaded, { subject: 'S2', body: 'B' }), true);
    assert.equal(needsLangConfirm(loaded, { subject: 'S', body: 'B2' }), true);
  });
  it('metin henüz yüklenmediyse sormaz', () => {
    assert.equal(needsLangConfirm(undefined, { subject: 'x', body: 'y' }), false);
  });
});

describe('disputeEmailKey', () => {
  it('firma ve taşıyıcıya göre', () => {
    assert.equal(disputeEmailKey('c1', 'k2'), 'deciship.disputeEmail.c1.k2');
  });
});

// KALANLAR 1.12: imzanın e-postası ve telefonu Merkez hesabından, başlıkla (adreste değil)
describe('signatureHeaders', () => {
  it('dolu alanlar kodlanmış başlık olur', () => {
    assert.deepEqual(signatureHeaders({ email: ' elif@demo.com ', emailVerified: true, phone: '+905321234567' }), {
      'X-Signature-Email': 'elif%40demo.com',
      'X-Signature-Phone': '%2B905321234567',
    });
  });
  it('boş ya da olmayan alan gönderilmez', () => {
    assert.deepEqual(signatureHeaders({ email: '', emailVerified: true, phone: null }), {});
    assert.deepEqual(signatureHeaders({ email: 'a@b.co', emailVerified: true }), { 'X-Signature-Email': 'a%40b.co' });
    assert.deepEqual(signatureHeaders(null), {});
  });
  it('doğrulanmamış e-posta gönderilmez (telefon gider)', () => {
    assert.deepEqual(signatureHeaders({ email: 'a@b.co', emailVerified: false, phone: '+905321234567' }), { 'X-Signature-Phone': '%2B905321234567' });
    assert.deepEqual(signatureHeaders({ email: 'a@b.co' }), {});
  });
});
