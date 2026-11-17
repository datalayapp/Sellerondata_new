// Renk belirteçleri: metin renkleri kullanıldıkları açık zeminlerde WCAG AA (≥ 4.5:1) geçmeli (DESIGN.md → Erişilebilirlik).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

// Belirteçler main.tsx'teki yükleme sırasıyla okunur: kabuğun tokens.css'i, üstüne DeciShip'in tokens.deciship.css'i (sonraki kazanır).
const require = createRequire(import.meta.url);
const SOURCES = [require.resolve('@sellerondata/shell/tokens.css'), new URL('../src/styles/tokens.deciship.css', import.meta.url)];
const rootBlock = (css: string) => css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const roots = SOURCES.map((f) => rootBlock(fs.readFileSync(f, 'utf8')));
function token(name: string): string {
  let hex: string | undefined;
  for (const root of roots) {
    const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
    if (m) hex = m[1];
  }
  assert.ok(hex, `--${name} bulunamadı`);
  return hex;
}
function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = ['text', 'text-2', 'text-3', 'primary', 'danger', 'warning', 'success'];
const BACKGROUNDS = ['surface', 'surface-2', 'bg', 'primary-soft', 'danger-bg', 'warning-bg', 'success-bg'];

describe('renk kontrastı (AA)', () => {
  for (const fg of TEXT) {
    it(`--${fg} her açık zeminde ≥ 4.5:1`, () => {
      for (const bg of BACKGROUNDS) {
        const r = ratio(token(fg), token(bg));
        assert.ok(r >= 4.5, `--${fg} ${token(fg)} / --${bg} ${token(bg)} = ${r.toFixed(2)}`);
      }
    });
  }
  it('beyaz metin dolu primary ve danger düğmelerde ≥ 4.5:1', () => {
    for (const bg of ['primary', 'primary-hover', 'danger', 'danger-hover']) assert.ok(ratio('#ffffff', token(bg)) >= 4.5, bg);
  });
  it('marka belirteçleri değişmedi', () => {
    assert.equal(token('primary').toLowerCase(), '#1d5bd8');
    assert.equal(token('accent').toLowerCase(), '#fdb022');
  });
});
