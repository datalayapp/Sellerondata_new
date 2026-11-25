// Fatura ayrıntısı: dil alan core işlevleri etkin dille çağrılır. Dil verilmezse core Türkçe yazar, EN ekranda Türkçe kalır.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const DIR = path.resolve(import.meta.dirname, '../src/pages/invoice-detail');
const LOCALE_TAKING = ['buildWhatsAppText', 'fmtFxRate', 'fmtPct', 'fmtSignedPct', 'fxSourceText', 'overchargeNote'];

/** `name(` ile başlayan çağrının parantez içi; iç içe parantez ve nesne korunur. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('kapanmayan parantez');
}

describe('fatura ayrıntısı core metinleri', () => {
  it('dil alan her core çağrısı getFormatLocale() geçirir', () => {
    const wrong: string[] = [];
    let seen = 0;
    for (const file of fs.readdirSync(DIR)) {
      const text = fs.readFileSync(path.join(DIR, file), 'utf8');
      for (const name of LOCALE_TAKING) {
        for (const hit of text.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'g'))) {
          seen++;
          const args = callArgs(text, hit.index + name.length);
          if (!/getFormatLocale\(\)\s*$/.test(args)) wrong.push(`${file}: ${name}(${args.slice(0, 50)})`);
        }
      }
    }
    assert.ok(seen >= 10, `çağrı sayısı beklenenden az: ${seen}`);
    assert.deepEqual(wrong, []);
  });
});
