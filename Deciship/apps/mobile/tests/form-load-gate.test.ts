import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { createFormLoadGate, editFormKey } from '../src/lib/formLoadGate';

describe('düzeltme formu bir kez doldurulur (G4)', () => {
  it('neden: aynı dile geçiş de languageChanged yayar (öne gelişteki profil yenilemesi `t`yi yeniler)', async () => {
    const i = i18next.createInstance();
    await i.init({ lng: 'tr', resources: { tr: { m: { a: 'A' } } } });
    let events = 0;
    i.on('languageChanged', () => (events += 1));
    await i.changeLanguage('tr');
    expect(events).toBe(1);
  });

  it('aynı kayıt için efekt yeniden çalışsa da form ikinci kez doldurulmaz', () => {
    const gate = createFormLoadGate();
    const fills: string[] = [];
    // Efekt: bağımlılık (`t`, bağlam işlevi) her değiştiğinde çalışır.
    const effect = (id: string, isLocal: boolean) => {
      const key = editFormKey(id, isLocal);
      if (gate.claim(key)) fills.push(key);
    };
    effect('m1', false); // ilk açılış
    effect('m1', false); // 60 sn sonra öne geliş: `t` yenilendi
    effect('m1', false); // ayarlar ya da koliler yenilendi
    expect(fills).toEqual(['server:m1']);
  });

  it('kayıt değişince yeniden doldurulur; yerel ve sunucu kaydı ayrı', () => {
    const gate = createFormLoadGate();
    expect(gate.claim(editFormKey('m1', false))).toBe(true);
    expect(gate.claim(editFormKey('m2', false))).toBe(true);
    expect(gate.claim(editFormKey('m2', true))).toBe(true);
    expect(gate.claim(editFormKey('m2', true))).toBe(false);
  });
});
