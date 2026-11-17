import { afterEach, describe, expect, it, vi } from 'vitest';

// İlk açılış dili (kullanıcı kararı 2026-11-12): cihaz dili desteklenenlerdense o, yoksa İngilizce.
// Cihaz dili Intl'den okunur; her durumda modül yeniden yüklenir, çünkü dil açılışta bir kez seçilir.
const RealDateTimeFormat = Intl.DateTimeFormat;

function fakeDevice(locale: string | null | 'throw') {
  const Fake = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    if (locale === 'throw') throw new RangeError('no locale');
    const real = new RealDateTimeFormat(...args);
    return Object.assign(Object.create(real), { resolvedOptions: () => ({ ...real.resolvedOptions(), locale: locale ?? '' }) });
  } as unknown as typeof Intl.DateTimeFormat;
  vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: Fake });
}

async function initialLanguage(device: string | null | 'throw') {
  fakeDevice(device);
  vi.resetModules();
  const mod = await import('../src/i18n');
  return { language: mod.i18n.language, device: mod.deviceLanguages() };
}

afterEach(() => vi.unstubAllGlobals());

describe('mobil ilk dil', () => {
  it('cihaz Türkçe → tr, bölgeli İngilizce → en', async () => {
    expect((await initialLanguage('tr-TR')).language).toBe('tr');
    expect((await initialLanguage('en-GB')).language).toBe('en');
  });

  it('desteklenmeyen, boş ya da okunamayan cihaz dili → en', async () => {
    expect((await initialLanguage('de-DE')).language).toBe('en');
    expect(await initialLanguage(null)).toEqual({ language: 'en', device: [] });
    expect(await initialLanguage('throw')).toEqual({ language: 'en', device: [] });
  });
});
