// Dil değişimi: açık formda yazılmış `1,234` TR'de 1,234 iken EN'de 1234 okunur. Sessizce yeniden yorumlanmaz.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planLocaleChange } from '../src/lib/unsavedChanges.ts';

describe('dil değişimi planı', () => {
  it('kaydedilmemiş değişiklik varsa sorar; hayır derse hiçbir şey değişmez', () => {
    let asked = 0;
    const plan = planLocaleChange({ unsaved: true, numberField: true, confirm: () => (asked++, false) });
    assert.equal(plan, 'cancel');
    assert.equal(asked, 1);
  });

  it('evet derse sayfa yeni dille baştan yüklenir (sayı alanı olmasa da yazılanlar silinir)', () => {
    assert.equal(planLocaleChange({ unsaved: true, numberField: true, confirm: () => true }), 'switch-and-reload');
    assert.equal(planLocaleChange({ unsaved: true, numberField: false, confirm: () => true }), 'switch-and-reload');
  });

  it('yazılmamış sayı alanı da eski dille biçimlidir: sormadan yeniden yüklenir', () => {
    const plan = planLocaleChange({ unsaved: false, numberField: true, confirm: () => assert.fail('sormamalı') });
    assert.equal(plan, 'switch-and-reload');
  });

  it('sayı alanı ve değişiklik yoksa yalnız dil değişir', () => {
    const plan = planLocaleChange({ unsaved: false, numberField: false, confirm: () => assert.fail('sormamalı') });
    assert.equal(plan, 'switch');
  });
});
