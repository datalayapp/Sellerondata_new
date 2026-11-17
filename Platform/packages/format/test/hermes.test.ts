// Hermes kuralı (plan §3.4): telefonda çalışan biçimleme kodu, her cihazda aynı çalışmayan Intl yollarını kullanmaz.
// Taranan: paketin kaynağı ve mobilin iki sarmalayıcısı (mobil onları Hermes'te koşar).
// Yalnız yorumlar silinir; metin sabitleri kalır, böylece `Intl['NumberFormat']` ya da `{ 'weekday': 'long' }` da yakalanır.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const HERE = import.meta.dirname;
const SRC = path.resolve(HERE, '../src');
const MOBILE = path.resolve(HERE, '../../../../Deciship/apps/mobile/src');

const FILES: string[] = [
  ...fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
    .map((f) => path.join(SRC, f)),
  path.join(MOBILE, 'lib/format.ts'),
  path.join(MOBILE, 'hub/format.ts'),
];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const OPTION = (names: string) => new RegExp(`(['"\`]?)\\b(${names})\\b\\1\\s*:`);

const BANNED: Array<[RegExp, string]> = [
  [/\bNumberFormat\b/, 'Intl.NumberFormat (sayılar elle biçimlenir)'],
  [/\bformatToParts\b/, 'formatToParts'],
  [/\bformatRange(ToParts)?\b/, 'formatRange'],
  [/\bRelativeTimeFormat\b/, 'Intl.RelativeTimeFormat'],
  [/\bPluralRules\b|\bListFormat\b|\bDisplayNames\b|\bSegmenter\b|\bDurationFormat\b/, 'yeni Intl API'],
  [/\btoLocale\w*/, 'toLocaleString / toLocaleDateString (çağrı, .call ya da başvuru)'],
  [/\bnarrowSymbol\b/, 'narrowSymbol'],
  [OPTION('compact|notation|compactDisplay|currencyDisplay|unitDisplay|signDisplay|style'), 'sayı biçimi seçeneği (compact / unit / currency)'],
  [OPTION('hourCycle|hour12|dateStyle|timeStyle|weekday|era|dayPeriod|fractionalSecondDigits|timeZoneName|second'), 'temel dışı DateTimeFormat seçeneği'],
  // `Intl` yalnız `Intl.DateTimeFormat` olarak geçebilir: köşeli parantez, takma ad (`const I = Intl`) ve başka üye yasak.
  [/\bIntl\b(?!\s*\.\s*DateTimeFormat(Options)?\b)/, 'Intl yalnız Intl.DateTimeFormat olarak kullanılabilir'],
];

function violations(text: string): string[] {
  const code = stripComments(text);
  return BANNED.filter(([re]) => re.test(code)).map(([, what]) => what);
}

describe('Hermes yasakları', () => {
  it('taranacak dosyalar var', () => {
    assert.ok(FILES.length >= 3);
    for (const f of FILES) assert.ok(fs.existsSync(f), f);
  });
  for (const f of FILES) {
    it(path.relative(path.resolve(HERE, '../../../..'), f), () => {
      assert.deepEqual(violations(fs.readFileSync(f, 'utf8')), [], f);
    });
  }
  it('tarayıcı gerçekten yakalıyor (kendi kendini sınama)', () => {
    const bad = [
      'const f = new Intl.NumberFormat("tr");',
      "const f = new Intl['NumberFormat']('tr');",
      'const I = Intl; new I.DateTimeFormat();',
      'Number.prototype.toLocaleString.call(5);',
      'const f = (5).toLocaleString;',
      "new Intl.DateTimeFormat('tr', { 'weekday': 'long' });",
      'new Intl.DateTimeFormat("tr", { "hourCycle": "h23" });',
      "x({ style: 'unit' })",
      "x({ notation: 'compact' })",
      'p.formatToParts(1)',
    ];
    for (const b of bad) assert.notDeepEqual(violations(b), [], b);
    const ok = [
      '// Intl.NumberFormat yok\nconst a = 1;',
      "new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });",
      'const options: Intl.DateTimeFormatOptions = {};',
      "const units = { days: 'gün' };",
    ];
    for (const g of ok) assert.deepEqual(violations(g), [], g);
  });
});
