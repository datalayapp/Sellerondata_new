// Tarife bildirimi: öneri yalnız bu tarifeyle fiyatlanan fatura varsa çıkar; başka tarifedeki faturalara düğme vaat edilmez.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { hasSavedNotice, noticeInvoices } from '../src/pages/tariff-editor/noticeInvoices.ts';

const texts = (lang: string) =>
  JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}/tariffEditor.json`, import.meta.url), 'utf8')).notice as Record<string, string>;

describe('tarife bildirimi', () => {
  it('varsayılan olmayan yeni tarife: kullanan fatura yok, öneri yok, öbür faturalar söylenir', () => {
    assert.deepEqual(noticeInvoices({ affected: 0, other: 2 }), { suggestRecompare: false, otherInvoices: 2 });
  });

  it('tarifeyi kullanan fatura varsa öneri çıkar, varsayılan olup olmaması önemli değil', () => {
    assert.deepEqual(noticeInvoices({ affected: 1, other: 1 }), { suggestRecompare: true, otherInvoices: 1 });
  });

  it('karşılaştırma yapıldıktan sonra öneri kalkar', () => {
    assert.equal(noticeInvoices({ affected: 1, recompared: { invoices: 1, lines: 8 } }).suggestRecompare, false);
  });

  it('eski sonuçta `other` yoksa satır çıkmaz', () => {
    assert.equal(noticeInvoices({ affected: 0 }).otherInvoices, 0);
  });

  it('metin iki dilde de var: düğme vaat etmez, faturada seçmeyi söyler', () => {
    const tr = texts('tr');
    const en = texts('en');
    for (const key of ['otherInvoices_one', 'otherInvoices_other']) {
      assert.match(tr[key], /<b>\{\{formatted\}\} faturası<\/b>/);
      assert.match(tr[key], /tarifeyi seçin/);
      assert.match(en[key], /<b>\{\{formatted\}\} invoices?<\/b>/);
      assert.match(en[key], /select it/);
    }
  });
});

describe('tarife kaydetme bildirimi', () => {
  it('yalnız başka tarifedeki fatura varsa da bildirim çıkar', () => {
    assert.equal(hasSavedNotice({ affectedInvoices: 0, otherInvoices: 2 }), true);
    assert.equal(hasSavedNotice({ affectedInvoices: 0, otherInvoices: 0 }), false);
  });
  it('kaydetme toast metni yanlış vaat içermez', () => {
    for (const lang of ['tr', 'en']) {
      const j = JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}/tariffEditor.json`, import.meta.url), 'utf8'));
      assert.doesNotMatch(j.page.savedBody, /karşılaştır|compared|Recompare/i);
    }
  });
});

describe('kur alınamayan satır metinleri', () => {
  it('iki dilde de var ve "tarife yok" demez', () => {
    for (const lang of ['tr', 'en']) {
      const j = JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}/invoiceDetail.json`, import.meta.url), 'utf8'));
      assert.ok(j.tabs.fxMissing && j.summary.sentence.fxMissing_one && j.summary.sentence.fxMissing_other);
      assert.doesNotMatch(j.tabs.fxMissing, /tarife yok|no tariff/i);
    }
  });
});
