import { readFileSync } from 'node:fs';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any

// Odak işareti kaybolmasın (DESIGN.md → Erişilebilirlik). Görünüm tarayıcıda (görsel takım) doğrulanır; burada kuralların varlığı ve sırası.
const css = (name: string) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8');

describe('odak kuralları', () => {
  it('bant içindeki beyaz açılır menüde odak --focus rengindedir; kural bandın açık odağından sonra ve ondan özgül', () => {
    const shell = css('shell.css');
    const band = shell.indexOf('outline: 2px solid var(--focus-on-dark)');
    const pop = shell.search(/\.sod-band \.sod-pop :focus-visible \{\s*outline-color: var\(--focus\);/);
    expect(band).toBeGreaterThan(-1);
    expect(pop).toBeGreaterThan(band);
  });

  it('sayfa değişiminde odak alan başlık çizgi çizmez (eylem değil)', () => {
    expect(css('shell.css')).toMatch(/\.sod-head h1\.ptitle:focus \{\s*outline: none;/);
  });

  it('yüksek karşıtlık kipinde odak çizgisini sayfa kuralı silemez (programla odaklanan kap hariç)', () => {
    const a11y = css('a11y.css');
    const forced = a11y.slice(a11y.indexOf('@media (forced-colors: active)'));
    expect(forced).toMatch(/:focus-visible:not\(\[tabindex='-1'\]\) \{\s*outline: 2px solid Highlight !important;/);
  });
});
