import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyMapping,
  fmtKg,
  fmtMoney,
  fmtNumber,
  fmtNumberInput,
  fmtPct,
  fmtWeightNumber,
  mappingDiagnostics,
  parseRows,
  parseTariffImport,
  parseTrNumber,
  tableFromMatrix,
  verifyMapping,
  type Locale,
} from '../src/index';

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseTrNumber: arayüz girdisi dile göre okunur', () => {
  it.each([
    ['1,234', 1234],
    ['1.234', 1.234],
    ['1,234.5', 1234.5],
    ['1.234,5', 1234.5],
    ['1,234,567', 1234567],
    ['1,234,567.89', 1234567.89],
    ['1.234.567,89', 1234567.89],
    ['12.5', 12.5],
    ['1.500', 1.5],
    ['999.125', 999.125],
    ['0.500', 0.5],
    ['-1,234', -1234],
    ['(1,234)', -1234],
    ['1,234-', -1234],
    ['₺1,234', 1234],
    ['1,234 TRY', 1234],
    ['1,250 kg', 1250],
    // üç haneye oturmayan tek virgül binlik olamaz: ondalık kabul edilir
    ['12,5', 12.5],
    ['1,5', 1.5],
    ['1,23', 1.23],
    ['0,500', 0.5],
    ['1234,567', 1234.567],
    // birden çok nokta ondalık olamaz: binlik
    ['1.234.567', 1234567],
  ])('en: %s → %s', (s, n) => {
    expect(parseTrNumber(s, 'en')).toBe(n);
  });
  it.each([['1,2,3'], ['1,234,5'], ['abc'], [''], ['1.2.3']])('en: %j → null', (s) => {
    expect(parseTrNumber(s, 'en')).toBeNull();
  });

  // Türkçe kural: varsayılan ve açık 'tr' karakteri karakterine bugünkü davranış
  it.each([
    ['1,234', 1.234],
    ['1.234', 1234],
    ['1,234.5', 1234.5],
    ['1.234,5', 1234.5],
    ['1,234,567', 1234567],
    ['12,5', 12.5],
    ['12.5', 12.5],
    ['1.500', 1500],
    ['0.500', 0.5],
    ['0,500', 0.5],
    ['-1,234', -1.234],
    ['1234,567', 1234.567],
  ])('tr ve varsayılan: %s → %s', (s, n) => {
    expect(parseTrNumber(s)).toBe(n);
    expect(parseTrNumber(s, 'tr')).toBe(n);
  });
});

describe('gidiş-dönüş: etkin dilde gösterilen değer aynı dilde geri okunur', () => {
  const locales: Locale[] = ['tr', 'en'];
  const rnd = prng(20261106);
  const values = Array.from({ length: 4000 }, () => {
    const scale = [1, 10, 1000, 100000, 10000000][Math.floor(rnd() * 5)]!;
    const v = Math.round(rnd() * scale * 1000) / 1000;
    return rnd() < 0.15 ? -v : v;
  }).concat([0.5, 1, 1.5, 1.234, 12.345, 999.125, 1000, 1234, 1234.5, 1234.567, 1000000, 0.125, 1.25]);
  const round = (v: number, d: number) => Number(v.toFixed(d));

  it.each(locales)('%s: düzenleme alanı', (loc) => {
    for (const v of values) expect(parseTrNumber(fmtNumberInput(v, 3, loc), loc), String(v)).toBeCloseTo(v, 9);
  });
  it.each(locales)('%s: binlik ayırıcılı gösterimler', (loc) => {
    for (const v of values) {
      for (const d of [0, 2, 3]) expect(parseTrNumber(fmtNumber(v, d, loc), loc), `${v}/${d}`).toBeCloseTo(round(v, d), d === 2 ? 1 : 9);
      expect(parseTrNumber(fmtWeightNumber(v, loc), loc), String(v)).toBeCloseTo(v, 9);
      expect(parseTrNumber(fmtKg(v, loc), loc), String(v)).toBeCloseTo(v, 9);
    }
  });
  it.each(locales)('%s: para ve yüzde', (loc) => {
    for (const v of values) {
      for (const cur of ['TRY', 'EUR', 'USD', 'GBP', 'CHF']) expect(parseTrNumber(fmtMoney(v, cur, loc), loc), `${v} ${cur}`).toBeCloseTo(v, 1);
      expect(parseTrNumber(fmtPct(v, loc), loc), String(v)).toBeCloseTo(v, 1);
    }
  });
  it('düzenleme alanı sade kalır', () => {
    expect(fmtNumberInput(4.5)).toBe('4,5');
    expect(fmtNumberInput(1.234)).toBe('1,234');
    expect(fmtNumberInput(1234.5)).toBe('1234,5');
    expect(fmtNumberInput(4.5, 3, 'en')).toBe('4.5');
    expect(fmtNumberInput(1.234, 3, 'en')).toBe('1.234');
    expect(fmtNumberInput(1234.5, 3, 'en')).toBe('1234.5');
  });
});

describe('dosya ve veri ayrıştırma arayüz diline bağlı değil', () => {
  const HEAD = ['Takip No', 'Tarih', 'Kg', 'Ücretli Kg', 'Net Tutar'];
  const map = { ...emptyMapping(), trackingNo: 'Takip No', shipDate: 'Tarih', actualKg: 'Kg', billedKg: 'Ücretli Kg', netAmount: 'Net Tutar' };
  const trTable = tableFromMatrix([
    HEAD,
    ['794812345301', '20.10.2026', '4,5', '6,0', '1.234,50'],
    ['794812345302', '21.10.2026', '1,234', '2,0', '1.000'],
    ['794812345303', '22.10.2026', '12,75', '13,0', '12.345,67'],
  ]);
  const enTable = tableFromMatrix([
    HEAD,
    ['794812345301', '10/20/2026', '4.5', '6.0', '1,234.50'],
    ['794812345302', '10/21/2026', '1.234', '2.0', '1,000'],
    ['794812345303', '10/22/2026', '12.75', '13.0', '12,345.67'],
  ]);
  const amounts = (t: typeof trTable, locale?: Locale) => parseRows(t, map, locale).lines.map((l) => [l.netAmount, l.actualKg, l.billedKg, l.shipDate]);
  const expected = [
    [1234.5, 4.5, 6, '2026-10-20'],
    [1000, 1.234, 2, '2026-10-21'],
    [12345.67, 12.75, 13, '2026-10-22'],
  ];

  it.each([[undefined], ['tr'], ['en']] as [Locale | undefined][])('Türkçe ve İngilizce biçimli fatura aynı okunur (arayüz %s)', (locale) => {
    expect(amounts(trTable, locale)).toEqual(expected);
    expect(amounts(enTable, locale)).toEqual(expected);
  });
  it('parseRows locale yalnız ileti dilini değiştirir', () => {
    const t = tableFromMatrix([HEAD, ['ABCDEF', '20.10.2026', '1', '1', '10,00'], ['794812345301', 'dün', '1,234', '2', '1.000'], ['794812345302', '20.10.2026', '1', '1', 'yok']]);
    const tr = parseRows(t, map, 'tr');
    const en = parseRows(t, map, 'en');
    expect(en.lines).toEqual(tr.lines);
    expect(en.errors.map((e) => e.rowIndex)).toEqual(tr.errors.map((e) => e.rowIndex));
    expect(en.errors[0]!.message).toBe('Row 1: invalid tracking no "ABCDEF"');
    expect(tr.errors[0]!.message).toBe('Satır 1: geçersiz takip no "ABCDEF"');
  });
  it('okuma kontrolü kararları iki biçimde ve iki dilde aynı', () => {
    for (const t of [trTable, enTable]) {
      const strip = (v: ReturnType<typeof verifyMapping>) => ({ verdict: v.verdict, rowFlags: v.rowFlags, flagCounts: v.flagCounts, checks: v.checks, status: Object.entries(v.fields).map(([k, f]) => [k, f.status, f.confidence]) });
      expect(strip(verifyMapping(t, map, { locale: 'en' }))).toEqual(strip(verifyMapping(t, map, { locale: 'tr' })));
      const de = mappingDiagnostics(t, map, { locale: 'en' });
      const dt = mappingDiagnostics(t, map, { locale: 'tr' });
      expect([de.numberFormat, de.dateOrder, de.netTotal]).toEqual([dt.numberFormat, dt.dateOrder, dt.netTotal]);
    }
  });
  it('tarife dosyası: ayrıştırma dil almaz, belirsiz hücre bugünkü kuralla okunur', () => {
    expect(parseTariffImport.length).toBeLessThanOrEqual(2);
    const parsed = parseTariffImport({ fileName: 'x.xlsx', kind: 'xlsx', prices: [['Ağırlık', 'A', 'B'], ['0,5', '1.234', '1,234.50'], ['1', '1.234,50', '12,5']], zones: null, surcharges: null });
    expect(parsed.rates.map((r) => [r.weightUpto, r.price])).toEqual([
      [0.5, 1234],
      [0.5, 1234.5],
      [1, 1234.5],
      [1, 12.5],
    ]);
  });
  it('core içinde parseTrNumber dil parametresiyle çağrılmaz (dosya, fatura, tarife, PDF)', () => {
    const src = path.resolve(import.meta.dirname, '../src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : [path.join(dir, f)]));
    const offenders: string[] = [];
    for (const f of files(src)) {
      // format.ts tanımın kendisi; pastedNumbers.ts yapıştırılan metni bilerek iki dilin kuralıyla karşılaştırır
      if (['format.ts', 'pastedNumbers.ts'].includes(path.basename(f))) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/parseTrNumber\(/g)) {
        // çağrının üst düzey argümanlarını say
        let depth = 1;
        let i = m.index + m[0].length;
        let quote = '';
        let commas = 0;
        for (; i < text.length && depth > 0; i++) {
          const c = text[i]!;
          if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = '';
          } else if (c === "'" || c === '"' || c === '`') quote = c;
          else if ('([{'.includes(c)) depth++;
          else if (')]}'.includes(c)) depth--;
          else if (c === ',' && depth === 1) commas++;
        }
        if (commas > 0) offenders.push(`${path.basename(f)}: ${text.slice(m.index, i)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
