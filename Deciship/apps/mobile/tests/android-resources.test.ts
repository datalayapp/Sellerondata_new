import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RES = 'modules/box-measure/android/src/main/res';

/** aapt2, `\` ile kaçmamış ' ve " karakterinde derlemeyi düşürür ("Can not extract resource"). */
function unescapedQuotes(xml: string): string[] {
  const bad: string[] = [];
  for (const m of xml.matchAll(/<string name="([^"]+)">([\s\S]*?)<\/string>/g)) {
    if (/(^|[^\\])['"]/.test(m[2]!)) bad.push(m[1]!);
  }
  return bad;
}

describe('Android yerel modül metinleri', () => {
  for (const dir of readdirSync(RES).filter((d) => d.startsWith('values'))) {
    it(`${dir}/strings.xml aapt2 ile derlenebilir`, () => {
      expect(unescapedQuotes(readFileSync(`${RES}/${dir}/strings.xml`, 'utf8'))).toEqual([]);
    });
  }

  it('denetim kusuru yakalıyor', () => {
    expect(unescapedQuotes(`<string name="a">box's</string>`)).toEqual(['a']);
    expect(unescapedQuotes(`<string name="a">box\\'s</string>`)).toEqual([]);
  });
});
