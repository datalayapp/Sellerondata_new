// Klavye ve ekran okuyucu: sekme listeleri ok tuşuyla gezilir, fotoğraf büyütme pencere gibi odak tutar (KALANLAR 6.12).
// Davranışın kendisi kabukta sınanır (`Platform/packages/shell/test/primitives.test.tsx`); burada panelin onu kullandığı.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? (d.name === 'mocks' ? [] : files(p)) : p.endsWith('.tsx') ? [p] : [];
  });
}
const sources = files(fileURLToPath(SRC)).map((f) => ({ f, s: fs.readFileSync(f, 'utf8') }));

/** JSX açılış etiketi (`{…}` içindeki `>` sayılmaz). */
function openTags(s: string, attr: RegExp): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/<[a-zA-Z]+\b/g)) {
    let i = m.index! + m[0].length;
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tag = s.slice(m.index!, i + 1);
    if (attr.test(tag)) out.push(tag);
  }
  return out;
}

describe('sekme listeleri', () => {
  const lists = sources.flatMap(({ f, s }) => openTags(s, /role="tablist"/).map((tag) => ({ f, tag })));
  const tabs = sources.flatMap(({ f, s }) => openTags(s, /role="tab"/).map((tag) => ({ f, tag })));

  it('panelde sekme listesi var (denetim boş geçmesin)', () => {
    assert.ok(lists.length >= 3, `${lists.length} sekme listesi`);
  });

  it('her role="tablist" ok tuşlarını kabuğun tabListKeyDown işlevine verir', () => {
    for (const { f, tag } of lists) assert.match(tag, /onKeyDown=\{tabListKeyDown\}/, path.basename(f));
  });

  it('her role="tab" gezici durak taşır (Tab listeye bir kez girer)', () => {
    for (const { f, tag } of tabs) assert.match(tag, /tabIndex=\{tabStop\(/, path.basename(f));
  });
});

describe('fotoğraf büyütme', () => {
  it('odak tuzağı kabuğun useFocusTrap işleviyle (Tab içeride, Esc kapatır, odak küçük resme döner)', () => {
    const s = sources.find(({ f }) => f.endsWith(`${path.sep}Photos.tsx`))!.s;
    assert.match(s, /useFocusTrap\(true, ref, onClose\)/);
    assert.match(s, /<div ref=\{ref\} className="lightbox" role="dialog" aria-modal="true"/);
    assert.doesNotMatch(s, /autoFocus/);
  });
});
