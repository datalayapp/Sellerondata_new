import { describe, expect, it } from 'vitest';
import {
  addDisputeSums,
  buildDisputeText,
  checkRecoveredAmount,
  disputeClaim,
  disputeSums,
  disputeTtkStatus,
  effectiveDisputeLines,
  emptyDisputeSums,
  invoiceDisputeStatus,
  isDisputable,
  type DisputeLineFact,
} from '../src/index';

describe('talep kuralı (itiraz metni ve paket ortak)', () => {
  it('mükerrer satırda faturalanan tutar, diğerlerinde fark; eksi talep yok', () => {
    expect(disputeClaim({ diffTypes: ['DUPLICATE'], billedAmount: 120.5, diffAmount: 10 })).toBe(120.5);
    expect(disputeClaim({ diffTypes: ['DIMENSION'], billedAmount: 120.5, diffAmount: 33.33 })).toBe(33.33);
    expect(disputeClaim({ diffTypes: ['PRICE'], billedAmount: 50, diffAmount: -4 })).toBe(0);
    expect(disputeClaim({ diffTypes: [], billedAmount: 50, diffAmount: null })).toBe(0);
  });

  it('yalnız listedeki, fark var ve talebi olan satır', () => {
    const base = { diffTypes: ['WEIGHT'], billedAmount: 100, diffAmount: 12 };
    expect(isDisputable({ ...base, decision: 'VERIFIED', status: 'DIFF' })).toBe(true);
    expect(isDisputable({ ...base, decision: 'OPEN', status: 'DIFF' })).toBe(false);
    expect(isDisputable({ ...base, decision: 'ACCEPTED', status: 'DIFF' })).toBe(false);
    expect(isDisputable({ ...base, decision: 'VERIFIED', status: 'MATCH' })).toBe(false);
    expect(isDisputable({ ...base, diffAmount: 0, decision: 'VERIFIED', status: 'DIFF' })).toBe(false);
  });

  it('itiraz metninin toplamı paket kuralıyla aynı', () => {
    const lines = [
      { trackingNo: 'A', diffTypes: ['DUPLICATE' as const], billedAmount: 80.1, diffAmount: 80.1, ourChargeableKg: null, billedChargeableKg: null, expectedAmount: null, decision: 'VERIFIED' as const, status: 'DIFF' as const },
      { trackingNo: 'B', diffTypes: ['WEIGHT' as const], billedAmount: 50, diffAmount: 10.2, ourChargeableKg: 2, billedChargeableKg: 3, expectedAmount: 39.8, decision: 'VERIFIED' as const, status: 'DIFF' as const },
      { trackingNo: 'C', diffTypes: ['WEIGHT' as const], billedAmount: 50, diffAmount: 0, ourChargeableKg: 2, billedChargeableKg: 2, expectedAmount: 50, decision: 'VERIFIED' as const, status: 'DIFF' as const },
    ];
    const text = buildDisputeText({ company: { name: 'X' }, carrier: { name: 'Aras' }, invoice: { invoiceNo: 'F1', currency: 'TRY' }, lines, lang: 'tr' });
    const claimed = lines.filter(isDisputable).map(disputeClaim);
    expect(text.lineCount).toBe(claimed.length);
    expect(text.total).toBe(90.3);
    expect(claimed).toEqual([80.1, 10.2]);
  });
});

describe('toplamlar', () => {
  const lines: DisputeLineFact[] = [
    { claimedAmount: 10.1, outcome: 'RECOVERED', recoveredAmount: 10.1 },
    { claimedAmount: 20.2, outcome: 'RECOVERED', recoveredAmount: 15.05 },
    { claimedAmount: 0.3, outcome: 'REJECTED', recoveredAmount: null },
    { claimedAmount: 0.1, outcome: 'PENDING', recoveredAmount: null },
    { claimedAmount: 0.2, outcome: 'PENDING', recoveredAmount: null },
  ];

  it('kuruş güvenli: talep = geri alınan + eksik + reddedilen + bekleyen', () => {
    const s = disputeSums(lines);
    expect(s).toEqual({ claimedAmount: 30.9, recoveredAmount: 25.15, rejectedAmount: 0.3, pendingAmount: 0.3, shortfallAmount: 5.15 });
    const parts = Math.round((s.recoveredAmount + s.shortfallAmount + s.rejectedAmount + s.pendingAmount) * 100);
    expect(parts).toBe(Math.round(s.claimedAmount * 100));
  });

  it('boş liste sıfır, birleştirme kuruş güvenli', () => {
    expect(disputeSums([])).toEqual(emptyDisputeSums());
    const a = disputeSums([{ claimedAmount: 0.1, outcome: 'PENDING', recoveredAmount: null }]);
    const b = disputeSums([{ claimedAmount: 0.2, outcome: 'PENDING', recoveredAmount: null }]);
    expect(addDisputeSums(a, b).pendingAmount).toBe(0.3);
  });

  it('geçerli satırlar: geri çekilen tur sayılmaz, satır başına en son tur', () => {
    const rows = [
      { invoiceLineId: 'l1', round: 1, withdrawn: false, tag: 'r1-l1' },
      { invoiceLineId: 'l2', round: 1, withdrawn: false, tag: 'r1-l2' },
      { invoiceLineId: 'l2', round: 2, withdrawn: false, tag: 'r2-l2' },
      { invoiceLineId: 'l3', round: 3, withdrawn: true, tag: 'r3-l3' },
      { invoiceLineId: 'l3', round: 2, withdrawn: false, tag: 'r2-l3' },
    ];
    expect(effectiveDisputeLines(rows).map((r) => r.tag).sort()).toEqual(['r1-l1', 'r2-l2', 'r2-l3']);
  });

  it('10-B12 + K38: yerini yeniye bırakmış turda RECOVERED ve REJECTED geçerli (sonuçsuz kalan yeniden gönderilecek)', () => {
    type O = 'PENDING' | 'RECOVERED' | 'REJECTED';
    const row = (line: string, round: number, outcome: O, o: { superseded?: boolean; withdrawn?: boolean } = {}) => ({
      invoiceLineId: line,
      round,
      outcome,
      superseded: o.superseded ?? false,
      withdrawn: o.withdrawn ?? false,
      tag: `r${round}-${line}`,
    });
    const rows = [
      // tur 1 (yerini tur 2'ye bıraktı): A geri alındı, B reddedildi, C sonuç bekliyordu, D'nin dekontu sonradan geri alındı
      row('A', 1, 'RECOVERED', { superseded: true }),
      row('B', 1, 'REJECTED', { superseded: true }),
      row('C', 1, 'PENDING', { superseded: true }),
      row('D', 1, 'PENDING', { superseded: true }),
      // tur 2 (B ve C yeniden talep edildi) geri çekildi
      row('B', 2, 'PENDING', { withdrawn: true }),
      row('C', 2, 'PENDING', { withdrawn: true }),
      // E yalnız etkin turda
      row('E', 3, 'REJECTED'),
    ];
    // K38: B'nin yeniden talebi geri çekildi, taşıyıcının son cevabı red: reddedilen sayılır
    expect(effectiveDisputeLines(rows).map((r) => r.tag).sort()).toEqual(['r1-A', 'r1-B', 'r3-E']);
    // ... yalnız satır hâlâ itiraz listesindeyken: reddi kabul edilip listeden çıkan satır sayılmaz
    const accepted = rows.map((r) => (r.invoiceLineId === 'B' ? { ...r, listed: false } : { ...r, listed: true }));
    expect(effectiveDisputeLines(accepted).map((r) => r.tag).sort()).toEqual(['r1-A', 'r3-E']);
    // eski çağrı biçimi (tur durumu verilmeden) değişmedi
    expect(effectiveDisputeLines(rows.map(({ superseded: _s, outcome: _o, ...r }) => r)).map((r) => r.tag).sort()).toEqual(['r1-A', 'r1-B', 'r1-C', 'r1-D', 'r3-E']);
  });
});

describe('durum ve süre', () => {
  it('fatura durumu', () => {
    expect(invoiceDisputeStatus(false, 3)).toBe('NONE');
    expect(invoiceDisputeStatus(true, 1)).toBe('SENT');
    expect(invoiceDisputeStatus(true, 0)).toBe('CLOSED');
  });

  it('TTK: son güne kadar zamanında, sonra geç; Türkiye dışında yok', () => {
    // 2026-10-27 + 8 gün = 2026-11-04
    expect(disputeTtkStatus('2026-10-27', '2026-11-04', 'TR')).toBe('ON_TIME');
    expect(disputeTtkStatus('2026-10-27', '2026-10-27', 'TR')).toBe('ON_TIME');
    expect(disputeTtkStatus('2026-10-27', '2026-11-05', 'TR')).toBe('LATE');
    expect(disputeTtkStatus('2026-10-27', '2026-11-01', 'US')).toBeNull();
    expect(disputeTtkStatus('2026-10-27', '2026-11-01', null)).toBeNull();
    expect(disputeTtkStatus(null, '2026-11-01', 'TR')).toBeNull();
  });

  it('geri alınan pay: 0 < tutar ≤ talep, kuruşla', () => {
    expect(checkRecoveredAmount(10, 10)).toBe('OK');
    expect(checkRecoveredAmount(10, 0.01)).toBe('OK');
    expect(checkRecoveredAmount(0.3, 0.1 + 0.2)).toBe('OK');
    expect(checkRecoveredAmount(10, 10.01)).toBe('EXCEEDS_CLAIM');
    expect(checkRecoveredAmount(10, 0)).toBe('NOT_POSITIVE');
    expect(checkRecoveredAmount(10, -1)).toBe('NOT_POSITIVE');
    expect(checkRecoveredAmount(10, Number.NaN)).toBe('NOT_POSITIVE');
  });
});
