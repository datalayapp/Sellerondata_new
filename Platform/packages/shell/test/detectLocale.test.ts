// @vitest-environment happy-dom
// İlk açılış dili (kullanıcı kararı 2026-11-12): kişinin dili → `sod_lang` çerezi → tarayıcı dilleri (ilk desteklenen) → İngilizce.
import { detectLocale } from '../src/i18n/setup.ts';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const afterEach: (fn: () => void) => void;

function setBrowser(languages: string[], language = languages[0] ?? '') {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => languages });
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => language });
}

function setCookie(value: string | null) {
  document.cookie = value === null ? 'sod_lang=; Path=/; Max-Age=0' : `sod_lang=${value}; Path=/`;
}

afterEach(() => setCookie(null));

describe('detectLocale', () => {
  it('tarayıcı dilleri sırayla, bölgeli kod ana dile iner', () => {
    setBrowser(['de-DE', 'tr-TR']);
    expect(detectLocale()).toBe('tr');
    setBrowser(['en-GB']);
    expect(detectLocale()).toBe('en');
    setBrowser(['tr-TR', 'en-US']);
    expect(detectLocale()).toBe('tr');
  });

  it('desteklenen dil yoksa İngilizce', () => {
    setBrowser(['de']);
    expect(detectLocale()).toBe('en');
    setBrowser([], '');
    expect(detectLocale()).toBe('en');
  });

  it('languages boşsa language okunur', () => {
    setBrowser([], 'tr-TR');
    expect(detectLocale()).toBe('tr');
  });

  it('çerez tarayıcıdan, kişinin dili çerezden önce', () => {
    setBrowser(['en-US']);
    setCookie('tr');
    expect(detectLocale()).toBe('tr');
    expect(detectLocale('en')).toBe('en');
    setBrowser(['tr-TR']);
    setCookie(null);
    expect(detectLocale('en')).toBe('en');
  });

  it('bozuk çerez ve kişi dili atlanır', () => {
    setBrowser(['de-DE']);
    setCookie('xx');
    expect(detectLocale('fr')).toBe('en');
    setBrowser(['tr']);
    expect(detectLocale(null)).toBe('tr');
  });
});
