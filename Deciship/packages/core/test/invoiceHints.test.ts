import { describe, expect, it } from 'vitest';
import { buildWhatsAppText, disputeDeadlines, isTariffSuspect, ttkApplies, turkeyDate, whatsAppUrl } from '../src/index';

describe('disputeDeadlines: Türkiye firması', () => {
  it('TTK 8 gün + FedEx 30 gün (wiki örneği: 27.10 → 04.11 ve 26.11)', () => {
    const d = disputeDeadlines('2026-10-27', 'fedex', '2026-11-01', 'TR')!;
    expect(d.ttk).toEqual({ days: 8, lastDay: '2026-11-04', daysLeft: 3, expired: false });
    expect(d.carrier).toEqual({ days: 30, lastDay: '2026-11-26', daysLeft: 25, expired: false });
  });

  it('FedEx dışındaki taşıyıcıda yalnızca TTK', () => {
    const d = disputeDeadlines('2026-10-27', 'aras', '2026-10-27', 'TR')!;
    expect(d.carrier).toBeUndefined();
    expect(d.ttk!.daysLeft).toBe(8);
    expect(disputeDeadlines('2026-10-27', 'FedEx-TR', '2026-10-27', 'TR')!.carrier).toBeDefined();
  });

  it('son gün 0, ertesi gün süre doldu', () => {
    expect(disputeDeadlines('2026-10-27', 'aras', '2026-11-04', 'TR')!.ttk).toMatchObject({ daysLeft: 0, expired: false });
    expect(disputeDeadlines('2026-10-27', 'aras', '2026-11-05', 'TR')!.ttk).toMatchObject({ daysLeft: -1, expired: true });
  });

  it('ay sonu ve yıl sonu', () => {
    expect(disputeDeadlines('2026-01-28', null, '2026-01-28', 'TR')!.ttk!.lastDay).toBe('2026-02-05');
    expect(disputeDeadlines('2026-12-28', null, '2026-12-28', 'TR')!.ttk!.lastDay).toBe('2027-01-05');
  });

  it('artık yıl: 29 Şubat sayılır', () => {
    expect(disputeDeadlines('2028-02-25', null, '2028-02-25', 'TR')!.ttk!.lastDay).toBe('2028-03-04');
    expect(disputeDeadlines('2027-02-25', null, '2027-02-25', 'TR')!.ttk!.lastDay).toBe('2027-03-05');
    expect(disputeDeadlines('2028-02-01', 'fedex', '2028-02-01', 'TR')!.carrier!.lastDay).toBe('2028-03-02');
  });

  it('bugün Türkiye yerel tarihine göre (UTC+3)', () => {
    // 2026-11-03 22:30 UTC = 2026-11-04 01:30 İstanbul → son gün (0), henüz dolmadı
    const late = new Date('2026-11-03T22:30:00Z');
    expect(turkeyDate(late)).toBe('2026-11-04');
    expect(disputeDeadlines('2026-10-27', 'fedex', late, 'TR')!.ttk!.daysLeft).toBe(0);
    // 2026-11-04 20:59 UTC = 23:59 İstanbul → hâlâ son gün; 21:00 UTC = ertesi gün → doldu
    expect(disputeDeadlines('2026-10-27', 'fedex', new Date('2026-11-04T20:59:00Z'), 'TR')!.ttk!.expired).toBe(false);
    expect(disputeDeadlines('2026-10-27', 'fedex', new Date('2026-11-04T21:00:00Z'), 'TR')!.ttk!.expired).toBe(true);
  });

  it('fatura tarihi yoksa ya da geçersizse null', () => {
    expect(disputeDeadlines(null, 'fedex', '2026-11-01', 'TR')).toBeNull();
    expect(disputeDeadlines('', 'fedex', '2026-11-01', 'TR')).toBeNull();
    expect(disputeDeadlines('2026-02-30', 'fedex', '2026-11-01', 'TR')).toBeNull();
  });
});

describe('disputeDeadlines: TTK yalnız Türkiye firmasında', () => {
  it('Türkiye: TTK ve FedEx düzeltme süresi', () => {
    const d = disputeDeadlines('2026-10-27', 'fedex', '2026-11-01', 'TR')!;
    expect(d.ttk).toEqual({ days: 8, lastDay: '2026-11-04', daysLeft: 3, expired: false });
    expect(d.carrier?.lastDay).toBe('2026-11-26');
  });

  it.each(['US', 'DE', 'GB', null, undefined, '', 'tr'])('%s: TTK yok, taşıyıcının kendi süresi kalır', (country) => {
    const d = disputeDeadlines('2026-10-27', 'fedex', '2026-11-01', country)!;
    expect(d.ttk).toBeUndefined();
    expect(d.carrier).toEqual({ days: 30, lastDay: '2026-11-26', daysLeft: 25, expired: false });
  });

  it('başka ülke, FedEx dışı taşıyıcı: hiçbir süre yok', () => {
    expect(disputeDeadlines('2026-10-27', 'ups', '2026-11-01', 'US')).toEqual({});
  });

  it('ttkApplies yalnız TR için doğru', () => {
    expect(ttkApplies('TR')).toBe(true);
    for (const c of ['US', 'tr', '', null, undefined]) expect(ttkApplies(c)).toBe(false);
  });
});

describe('isTariffSuspect', () => {
  it('5 satırdan azında asla uyarmaz', () => {
    expect(isTariffSuspect(4, 4)).toBe(false);
    expect(isTariffSuspect(0, 0)).toBe(false);
  });
  it('fiyat farkı oranı %30\'u aşınca uyarır (tam %30 uyarmaz)', () => {
    expect(isTariffSuspect(10, 3)).toBe(false);
    expect(isTariffSuspect(10, 4)).toBe(true);
    expect(isTariffSuspect(5, 2)).toBe(true);
    expect(isTariffSuspect(18, 1)).toBe(false);
  });
});

describe('buildWhatsAppText', () => {
  it('yalnızca sayılarla kısa özet', () => {
    const text = buildWhatsAppText({
      carrierName: 'FedEx',
      invoiceNo: '9-482-11735',
      invoiceDate: '2026-10-27',
      currency: 'TRY',
      lines: 18,
      diff: 4,
      unmatched: 1,
      overchargeTotal: 1731.2,
      disputeLastDay: '2026-11-04',
    });
    expect(text).toBe(
      'DeciShip · FedEx fatura 9-482-11735 (27.10.2026): 18 gönderi, 4 fark, 1 eşleşmedi. Fazla ödeme 1.731,20 ₺. İtiraz için son gün 04.11.2026.',
    );
  });
  it('fark yoksa ve süre geçtiyse son gün yazılmaz', () => {
    expect(
      buildWhatsAppText({ carrierName: 'Aras', invoiceNo: 'A1', currency: 'TRY', lines: 3, diff: 0, unmatched: 0, overchargeTotal: 0, disputeLastDay: '2026-11-04' }),
    ).toBe('DeciShip · Aras fatura A1: 3 gönderi, 0 fark. Fazla ödeme yok.');
    expect(
      buildWhatsAppText({ carrierName: 'Aras', invoiceNo: 'A1', currency: 'EUR', lines: 3, diff: 1, unmatched: 0, overchargeTotal: 12.5 }),
    ).toBe('DeciShip · Aras fatura A1: 3 gönderi, 1 fark. Fazla ödeme 12,50 €.');
  });
  it('wa.me bağlantısı metni kodlar', () => {
    expect(whatsAppUrl('a & b ₺')).toBe('https://wa.me/?text=a%20%26%20b%20%E2%82%BA');
  });
});
