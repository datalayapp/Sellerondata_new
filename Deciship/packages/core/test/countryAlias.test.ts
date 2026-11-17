// Denetim 04-B14: "UK" (Birleşik Krallık) ve "EL" (Yunanistan, AB kullanımı) ISO kodu değildir; GB ve GR'ye çevrilir.
import { describe, expect, it } from 'vitest';
import { compareLine, parseCountry, resolveZone } from '../src/index';
import { FEDEX, TOL, line } from './fixtures';

describe('04-B14 ülke kodu takma adları', () => {
  it('parseCountry: UK → GB, EL → GR (büyük/küçük harf ve boşluk fark etmez)', () => {
    expect(parseCountry('UK')).toBe('GB');
    expect(parseCountry(' uk ')).toBe('GB');
    expect(parseCountry('EL')).toBe('GR');
    expect(parseCountry('el')).toBe('GR');
    // gerçek ISO kodları değişmez
    expect(parseCountry('GB')).toBe('GB');
    expect(parseCountry('GR')).toBe('GR');
    expect(parseCountry('fr')).toBe('FR');
  });

  it('resolveZone: faturada UK, tarifede GB → bölge bulunur; tersi de', () => {
    expect(resolveZone(FEDEX, 'UK')).toBe('B');
    expect(resolveZone(FEDEX, 'uk')).toBe('B');
    expect(resolveZone({ ...FEDEX, zones: { UK: 'B' } }, 'GB')).toBe('B');
    expect(resolveZone({ ...FEDEX, zones: { GR: 'A' } }, 'EL')).toBe('A');
    expect(resolveZone(FEDEX, 'XX')).toBeNull();
  });

  it('UK varışlı satır "Tarife yok" kalmaz', () => {
    const r = compareLine({
      line: line({ trackingNo: '794812345302', netAmount: 930, destCountry: 'UK', billedKg: 5 }),
      measurement: { id: 'm', dims: { l: 30, w: 20, h: 15 }, actualKg: 3.2, measuredAt: '2026-10-22T11:03:00+03:00' },
      tariff: FEDEX,
      tol: TOL,
      isDuplicate: false,
    });
    expect(r.status).not.toBe('NO_TARIFF');
    expect(r.expectedAmount).not.toBeNull();
  });
});
