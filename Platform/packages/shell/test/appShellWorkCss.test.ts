// Tezgâh çalışma düzeni (TagPress): shell.css'teki Tezgâh bloğunun kapsamı ve ölçüleri. Görünüm tarayıcıda (görsel takım).
import { readFileSync } from 'node:fs';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Tezgâh CSS kapsamı', () => {
  const css = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = css.indexOf('/* ==== TEZGÂH ÇALIŞMA DÜZENİ (TagPress) — başlangıç ====');
  const end = css.indexOf('/* ==== TEZGÂH ÇALIŞMA DÜZENİ — bitiş ==== */');
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  /** Bloktaki kural seçicileri (@media başlıkları hariç). */
  const selectors = [...block.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => !s.startsWith('@media'));

  it('blok var ve dosyanın sonunda (önceki kuralları yalnız kendi kapsamında ezer)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(css.slice(end).trim()).toBe('/* ==== TEZGÂH ÇALIŞMA DÜZENİ — bitiş ==== */');
    expect(selectors.length).toBeGreaterThan(5);
  });

  it('her kural workspace ya da work kapsamında: Merkez ve DeciShip etkilenmez', () => {
    const scoped = /\[data-sod-workspace\]|\[data-sod-size='work'\]|\[data-size='work'\]/;
    for (const sel of selectors) for (const part of sel.split(',')) expect([part.trim(), scoped.test(part)]).toEqual([part.trim(), true]);
  });

  it('ölçüler: iş satırı 44, alt boşluk 0, kenar 24 (telefonda 16)', () => {
    expect(block).toMatch(/\.sod-band\[data-size='work'\] \{\s*--sod-head-h: 44px;\s*--sod-band-pad: 0px;/);
    expect(block).toMatch(/--sod-wrap: 100%;\s*--gutter: 24px;/);
    expect(block).toMatch(/@media \(max-width: 760px\) \{\s*\.sod-shell:is\(\[data-sod-workspace\], \[data-sod-size='work'\]\) \{\s*--gutter: 16px;/);
  });

  it('üst satır Merkez ve DeciShip kurallarıyla çizilir: blokta logo kilidi, ⊞, menü ya da sağ küme kuralı yok', () => {
    for (const sel of selectors) expect([sel, /\.sod-(lead|brand|nav|apps|sw|pop|firm|av)\b/.test(sel)]).toEqual([sel, false]);
  });

  it('üst satır her ekranda Merkez ve DeciShip sütununda: blokta .sod-top için yalnız sütun hizası', () => {
    const top = selectors.filter((s) => /\.sod-top\b/.test(s));
    expect(top).toEqual(['.sod-shell[data-sod-workspace] .sod-top,\n.sod-shell[data-sod-workspace] .sod-band .sod-head', ':root[data-sod-stuck] .sod-shell[data-sod-workspace] .sod-top']);
    // üst satır ve baş yuvası (iş satırı) aynı sütun hizasında
    expect(block).toMatch(
      /\.sod-shell\[data-sod-workspace\] \.sod-top,\s*\.sod-shell\[data-sod-workspace\] \.sod-band \.sod-head \{\s*box-sizing: border-box;\s*max-width: calc\(var\(--sod-column-wrap\) - 2 \* var\(--gutter\)\);\s*margin-inline: auto;\s*padding-inline: calc\(var\(--sod-column-gutter\) - var\(--gutter\)\);\s*\}/,
    );
    // sabit (yapışkan) satır tam genişlikte, içi sütun hizasında
    expect(block).toMatch(/\.sod-top \{\s*max-width: none;\s*margin-inline: 0;\s*padding-inline: calc\(max\(0px, \(100% - var\(--sod-column-wrap\)\) \/ 2\) \+ var\(--sod-column-gutter\)\);/);
  });

  it('sütun: içerik [data-sod-column] altında kök belirteçlerine (--sod-wrap, --gutter) döner; kırıntı her ekranda sütunda', () => {
    // Kök değerler kabuk ezmeden önce kökte saklanır (yalnız workspace kabuğu varken).
    expect(block).toMatch(/:root:has\(\.sod-shell\[data-sod-workspace\]\) \{\s*--sod-column-wrap: var\(--sod-wrap\);\s*--sod-column-gutter: var\(--gutter\);/);
    const col = selectors.filter((s) => s.includes('[data-sod-column]'));
    expect(col).toEqual(['.sod-shell[data-sod-workspace][data-sod-column] > .sod-main']);
    expect(selectors).toContain('.sod-shell[data-sod-workspace] .sod-band-crumb');
    expect(block).toMatch(/> \.sod-main \{\s*--sod-wrap: var\(--sod-column-wrap\);\s*--gutter: var\(--sod-column-gutter\);/);
    // Baş yuvası: kenardan kenara satırın (kenar --gutter) içinde Merkez'in sütun içeriğiyle aynı x.
    expect(block).toMatch(/\.sod-band \.sod-head \{\s*box-sizing: border-box;\s*max-width: calc\(var\(--sod-column-wrap\) - 2 \* var\(--gutter\)\);\s*margin-inline: auto;\s*padding-inline: calc\(var\(--sod-column-gutter\) - var\(--gutter\)\);/);
    // Sütun ölçüleri belirteçlerdeki Merkez/DeciShip değerleri (1240, 32, telefonda 16).
    const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
    expect(tokens).toMatch(/--sod-wrap: 1240px;/);
    expect(tokens).toMatch(/:root \{[^}]*--gutter: 32px;/);
    expect(tokens).toMatch(/@media \(max-width: 760px\) \{\s*:root \{\s*--gutter: 16px;/);
  });
});
