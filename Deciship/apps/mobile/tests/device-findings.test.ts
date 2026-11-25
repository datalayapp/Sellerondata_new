import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import appJson from '../app.json';
import { pickOrg } from '../src/ui/orgPick';

const require = createRequire(import.meta.url);

/** Cihazda bulunan hataların regresyon testleri. */
describe('firma seçimi', () => {
  it('geri çağırma olmadan da firma değişir (firma seçimi ekranı)', async () => {
    const switchOrg = vi.fn(async () => null);
    await pickOrg(switchOrg, 'firmaA');
    expect(switchOrg).toHaveBeenCalledWith('firmaA');
  });

  it('geri çağırma sonucu alır', async () => {
    const done = vi.fn();
    await pickOrg(async () => 'yeni', 'firmaA', done);
    expect(done).toHaveBeenCalledWith('yeni');
  });

  it('OrgRows (Hesap ve firma seçimi) bu işlevi kullanır', () => {
    const src = readFileSync('src/hub/ui.tsx', 'utf8');
    expect(src).toContain('pickOrg(switchOrg, orgId, onSwitched)');
    expect(src).not.toMatch(/onSwitched\?\.\(await/);
  });
});

describe('giriş grubu', () => {
  it('firma seçiminden çıkınca davet ekranına değil girişe düşer (yönlendirme kökü login)', () => {
    expect(readFileSync('app/(auth)/_layout.tsx', 'utf8')).toMatch(/unstable_settings = \{ anchor: 'login' \}/);
  });
});

describe('etkinlik yeniden yaratılması', () => {
  const { withExtraConfigChanges } = require('../plugins/with-config-changes.js') as { withExtraConfigChanges: (v?: string) => string };

  it('yazı boyutu ve yoğunluk değişimi etkinliği yeniden yaratmaz (router bağsız kalıp uygulama düşüyordu)', () => {
    const out = withExtraConfigChanges('keyboard|orientation|screenSize').split('|');
    for (const c of ['fontScale', 'density', 'locale', 'layoutDirection']) expect(out).toContain(c);
    expect(out).toContain('orientation');
  });

  it('iki kez uygulanınca çoğalmaz, boş girdiyi kabul eder', () => {
    const once = withExtraConfigChanges('fontScale');
    expect(withExtraConfigChanges(once)).toBe(once);
    expect(withExtraConfigChanges(undefined)).toContain('density');
  });

  it('app.json eklentiyi yükler', () => {
    expect(appJson.expo.plugins).toContain('./plugins/with-config-changes.js');
  });
});

describe('diyalog düğmeleri', () => {
  const { applyDialogStyles } = require('../plugins/with-dialog-buttons.js') as {
    applyDialogStyles: (r: { style?: { $: { name: string; parent?: string }; item?: { $: { name: string }; _: string }[] }[] }) => {
      style: { $: { name: string; parent?: string }; item?: { $: { name: string }; _: string }[] }[];
    };
  };

  it('büyük harfe çevirmez: I/İ cihaz diline bağlı bozulmaz', () => {
    const out = applyDialogStyles({ style: [{ $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' }, item: [] }] });
    const theme = out.style.find((s) => s.$.name === 'AppTheme')!;
    expect(theme.item?.find((i) => i.$.name === 'alertDialogTheme')?._).toBe('@style/SodAlertDialog');
    const button = out.style.find((s) => s.$.name === 'SodDialogButton')!;
    expect(button.item?.find((i) => i.$.name === 'android:textAllCaps')?._).toBe('false');
  });

  it('iki kez uygulanınca çoğalmaz', () => {
    const once = applyDialogStyles({ style: [{ $: { name: 'AppTheme' }, item: [] }] });
    const twice = applyDialogStyles(once);
    expect(twice.style.filter((s) => s.$.name === 'SodDialogButton').length).toBe(1);
    expect(twice.style.find((s) => s.$.name === 'AppTheme')!.item?.filter((i) => i.$.name === 'alertDialogTheme').length).toBe(1);
  });

  it('app.json eklentiyi yükler', () => {
    expect(appJson.expo.plugins).toContain('./plugins/with-dialog-buttons.js');
  });
});

describe('emülatör sınaması bulguları', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('Bugün sayaç etiketi Android yazı küçültmesi kullanmaz', () => {
    expect(read('app/(tabs)/deciship/today.tsx')).not.toMatch(/adjustsFontSizeToFit/);
  });

  it('ölçüm girişi kapalıyken boş ekran olmayan düğmeyi söylemez', () => {
    expect(read('app/(tabs)/deciship/today.tsx')).toContain("access.canCapture ? 'today.emptyText' : 'today.emptyTextNoCapture'");
    for (const lng of ['tr', 'en']) {
      const today = JSON.parse(read(`src/locales/${lng}/measure.json`)).today;
      expect(today.emptyTextNoCapture).toBeTruthy();
      expect(today.emptyTextNoCapture).not.toEqual(today.emptyText);
    }
  });

  it('firma seçimi ekranında seçilmeden "Etkin" rozeti yok', () => {
    expect(read('app/(auth)/select-org.tsx')).toContain('activeId={null}');
  });

  it('giriş ekranında dil seçici var ve seçim cihazda kalır', () => {
    const src = read('app/(auth)/login.tsx');
    expect(src).toContain('<LangPicker');
    expect(src).toContain('SecureStore.setItemAsync(K_LOGIN_LOCALE, locale)');
    expect(src).toContain('SecureStore.getItemAsync(K_LOGIN_LOCALE)');
  });
});
