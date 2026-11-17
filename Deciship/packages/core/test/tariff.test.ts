import { describe, expect, it } from 'vitest';
import { canonicalSurchargeCode, expectedCharge, findTariffSurcharge, normalizeSurchargeCode, ratePrice, resolveZone } from '../src/index';
import { ARAS, FEDEX } from './fixtures';

describe('expectedCharge', () => {
  it('#5305: A / 6,0 kg → 1.184,00 (birim test)', () => {
    const r = expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR' });
    expect(r).toMatchObject({ ok: true, zone: 'A', base: 1527.75, discount: 580.55, fuel: 236.8, surcharges: 0, total: 1184 });
    if (r.ok) {
      expect(r.lines.map((l) => l.amount)).toEqual([1527.75, -580.55, 236.8]);
      expect(r.lines[0]!.label).toBe('Tarife fiyatı (Bölge A, 6,0 kg)');
      expect(r.lines[1]!.label).toBe('İndirim %38');
      expect(r.lines[2]!.label).toBe('Yakıt %25');
    }
  });

  it('net tarife (indirim %0): indirim kalemi yok, ilk kalem "Tarife fiyatı"', () => {
    const r = expectedCharge({ tariff: { ...FEDEX, discountPct: 0 }, chargeableKg: 6, destCountry: 'FR' });
    expect(r.ok && r.lines.map((l) => l.label)).toEqual(['Tarife fiyatı (Bölge A, 6,0 kg)', 'Yakıt %25']);
  });

  it('FedEx 9,5 kg → 1.642,50 (faturalanan #5305)', () => {
    const r = expectedCharge({ tariff: FEDEX, chargeableKg: 9.5, destCountry: 'FR' });
    expect(r.ok && r.total).toBe(1642.5);
  });

  it('ara ağırlık bir üst satırın fiyatını alır', () => {
    const r = expectedCharge({ tariff: FEDEX, chargeableKg: 7, destCountry: 'DE' });
    expect(r.ok && r.base).toBe(2119.35);
  });

  it('ülke küçük harfle de bulunur', () => {
    expect(resolveZone(FEDEX, 'gb')).toBe('B');
  });

  it('bölge yoksa NO_TARIFF sebebi', () => {
    const r = expectedCharge({ tariff: FEDEX, chargeableKg: 2, destCountry: 'AU' });
    expect(r).toEqual({ ok: false, reason: 'Tarifede AU için bölge yok' });
  });

  it('ülke yoksa ve * bölgesi yoksa sebep', () => {
    const r = expectedCharge({ tariff: FEDEX, chargeableKg: 2 });
    expect(r.ok).toBe(false);
  });

  it('yurt içi: tek bölge *', () => {
    const r = expectedCharge({ tariff: ARAS, chargeableKg: 10, destCountry: 'TR' });
    expect(r).toMatchObject({ ok: true, zone: '*', base: 150, discount: 15, fuel: 0, total: 135 });
  });

  it('bölgenin fiyat satırı yoksa sebep', () => {
    const r = expectedCharge({ tariff: { ...FEDEX, zones: { FR: 'Z' } }, chargeableKg: 2, destCountry: 'FR' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Z bölgesi');
  });

  it('tablo üstü: son fiyat + ceil((kg - sonUpto)/adım) × birim', () => {
    // A son satır 30 kg = 5800; 32,4 → basamak 1 kg → 33 kg → 3 birim × 150
    const p = ratePrice(FEDEX, 'A', 33);
    expect(p.ok && p.price).toBe(6250);
    const r = expectedCharge({ tariff: ARAS, chargeableKg: 32, destCountry: 'TR' });
    expect(r.ok && r.base).toBe(round(350 + 2 * 13.5));
  });

  it('tablo üstü ve taşma tanımsızsa NO_TARIFF', () => {
    const r = expectedCharge({ tariff: FEDEX, chargeableKg: 12, destCountry: 'GB' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/aşıyor/);
  });

  it('ek ücretler yakıttan sonra, indirimsiz: FIXED / PER_KG / PCT (base üzerinden)', () => {
    const r = expectedCharge({
      tariff: FEDEX,
      chargeableKg: 6,
      destCountry: 'FR',
      surchargeCodes: ['ADDITIONAL_HANDLING', 'remote area', 'INSURANCE', 'UNKNOWN', 'ADDITIONAL_HANDLING'],
    });
    // 285 + 18,50×6 = 111 + %1 × 1527,75 = 15,28
    expect(r).toMatchObject({ ok: true, surcharges: 411.28, total: 1595.28 });
    if (r.ok) expect(r.lines).toHaveLength(6);
  });

  it('PER_KG kesirli kg', () => {
    const r = expectedCharge({ tariff: FEDEX, chargeableKg: 4.5, destCountry: 'FR', surchargeCodes: ['REMOTE_AREA'] });
    expect(r.ok && r.surcharges).toBe(83.25);
  });
});

describe('ek ücret kodları', () => {
  it('normalleştirme', () => {
    expect(normalizeSurchargeCode(' Adres düzeltme ')).toBe('ADRES_DUZELTME');
    expect(normalizeSurchargeCode('Kapıda Ödeme')).toBe('KAPIDA_ODEME');
    expect(normalizeSurchargeCode('İade')).toBe('IADE');
  });
  it('eşdeğer kodlar aynı gruba düşer', () => {
    expect(canonicalSurchargeCode('COD')).toBe('KAPIDA_ODEME');
    expect(canonicalSurchargeCode('Kapıda Ödeme Bedeli')).toBe('KAPIDA_ODEME');
    expect(canonicalSurchargeCode('adres_duzeltme')).toBe('ADDRESS_CORRECTION');
  });
  it('tarifede eşdeğer kodla bulunur', () => {
    expect(findTariffSurcharge(ARAS, 'COD')?.code).toBe('KAPIDA_ODEME');
    expect(findTariffSurcharge(FEDEX, 'ADDRESS_CORRECTION')).toBeUndefined();
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}
