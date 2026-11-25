import { describe, expect, it } from 'vitest';
import { findBestTrackingMatch, normalizeTracking, trackingCandidates, trackingMatchLevel } from '../src/index';

const FEDEX34 = '9632001960000000000400794812345305';

describe('normalizeTracking', () => {
  it('boşluk ve tire temizler, büyük harf yapar', () => {
    expect(normalizeTracking(' 7948 1234 5301 ')).toBe('794812345301');
    expect(normalizeTracking('1z9x-4a71-0341')).toBe('1Z9X4A710341');
    expect(normalizeTracking('abc 123')).toBe('ABC123');
  });
  it('FedEx 34 haneli barkod → son 12 hane', () => {
    expect(FEDEX34).toHaveLength(34);
    expect(normalizeTracking(FEDEX34)).toBe('794812345305');
  });
  it('96 ile başlamayan 34 hane kısaltılmaz', () => {
    const s = '1'.repeat(34);
    expect(normalizeTracking(s)).toBe(s);
  });
});

describe('trackingCandidates', () => {
  it('normal takip no tek aday', () => {
    expect(trackingCandidates('7948-1234-5305')).toEqual(['794812345305']);
  });
  it('FedEx 34: son 12, son 15, tamamı', () => {
    expect(trackingCandidates(FEDEX34)).toEqual(['794812345305', '400794812345305', FEDEX34]);
  });
  it('boş', () => {
    expect(trackingCandidates('  ')).toEqual([]);
  });
});

describe('eşleşme sırası', () => {
  it('(1) normalize tam eşit', () => {
    expect(trackingMatchLevel('7948 1234 5305', '794812345305')).toBe(1);
    expect(trackingMatchLevel(FEDEX34, '794812345305')).toBe(1);
  });
  it('(2) sonek, en az 10 karakter', () => {
    expect(trackingMatchLevel('00340434161094042557', '4161094042557')).toBe(2);
    expect(trackingMatchLevel('X123456789', 'AB-X123456789')).toBe(2);
    expect(trackingMatchLevel('123456789', 'AB123456789')).toBeNull();
  });
  it('(3) ham değer eşit', () => {
    expect(trackingMatchLevel('--', '--')).toBe(3);
  });
  it('eşleşmez', () => {
    expect(trackingMatchLevel('794812345305', '794812345306')).toBeNull();
    expect(trackingMatchLevel('', '')).toBeNull();
  });
  it('en güçlü eşleşme seçilir', () => {
    const items = [{ t: 'AA794812345305' }, { t: '794812345305' }];
    expect(findBestTrackingMatch('794812345305', items, (x) => x.t)).toBe(items[1]);
    expect(findBestTrackingMatch('999', items, (x) => x.t)).toBeNull();
  });
});
