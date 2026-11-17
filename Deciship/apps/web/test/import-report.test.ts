// Fatura sayfası: alınmayan satır uyarısı ve "Nasıl hesaplandı?" yardımcıları (saf mantık).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ImportReport } from '../src/api/types.ts';
import { importReportNotice, readNotes, skippedValue, visibleByType, visibleSteps } from '../src/pages/invoice-detail/reportLogic.ts';

const base: ImportReport = {
  version: 1,
  source: 'table',
  rowsInFile: 10,
  linesImported: 10,
  skippedCount: 0,
  byReason: {},
  skippedRows: [],
};

describe('alınmayan satır uyarısı', () => {
  // Mesaj 6 (R2): içe aktarmada PDF denetimi dosya havuzu yüzünden yapılamadı: "metin katmanı yok" değil, ayrı durum
  it('PDF denetimi yapılamadı (skipped): ayrı uyarı, "metin katmanı yok" denmez', () => {
    const n = importReportNotice({ ...base, source: 'pdf', pdfCheck: { method: 'skipped', checked: 0, unverified: 0 } });
    assert.equal(n?.pdfSkipped, true);
    assert.equal(n?.pdfNone, false);
    assert.equal(importReportNotice({ ...base, source: 'pdf', pdfCheck: { method: 'none', checked: 0, unverified: 0 } })?.pdfSkipped, false);
  });

  it('rapor yok ya da hiçbir şey alınmadı: uyarı yok', () => {
    assert.equal(importReportNotice(null), null);
    assert.equal(importReportNotice(undefined), null);
    assert.equal(importReportNotice(base), null);
    assert.equal(importReportNotice({ ...base, pdfCheck: { method: 'text', checked: 5, unverified: 0 } }), null);
  });

  it('yalnız BAD_NET: sayı var, takip no\'suz kısmı yok', () => {
    const n = importReportNotice({ ...base, skippedCount: 2, byReason: { BAD_NET: 2 }, noTrackingAmount: 99 });
    assert.deepEqual(n, {
      skipped: 2,
      noTracking: 0,
      noTrackingAmount: undefined,
      pdfUnverified: 0,
      pdfNone: false,
      pdfSkipped: false,
      pdfMissed: 0,
      pdfMissedTooLarge: false,
      readNotes: [],
    });
  });

  it('NO_TRACKING: sayı ve tutar gelir', () => {
    const n = importReportNotice({ ...base, skippedCount: 3, byReason: { BAD_NET: 2, NO_TRACKING: 1 }, noTrackingAmount: 45 });
    assert.equal(n?.skipped, 3);
    assert.equal(n?.noTracking, 1);
    assert.equal(n?.noTrackingAmount, 45);
  });

  it('PDF: doğrulanamayan satır tek başına uyarı çıkarır', () => {
    const n = importReportNotice({ ...base, source: 'pdf', pdfCheck: { method: 'text', checked: 5, unverified: 1 } });
    assert.equal(n?.pdfUnverified, 1);
    assert.equal(n?.skipped, 0);
    assert.equal(n?.pdfNone, false);
  });

  it('PDF metin katmanı yok: pdfNone', () => {
    const n = importReportNotice({ ...base, source: 'pdf', pdfCheck: { method: 'none', checked: 0, unverified: 0 } });
    assert.equal(n?.pdfNone, true);
  });

  // Y31: PDF'te geçen ama okunmamış olabilecek takip no'lar tek başına uyarı çıkarır; alınmayan satır sayılmaz
  it('PDF: okunmamış olabilecek takip no', () => {
    const n = importReportNotice({ ...base, source: 'pdf', pdfCheck: { method: 'text', checked: 5, unverified: 0 }, pdfMissed: { count: 2, trackings: ['794812345306', '794812345307'] } });
    assert.equal(n?.pdfMissed, 2);
    assert.equal(n?.skipped, 0);
  });

  // Y20: varsayılan KDV oranı / kg ve libreden çeviri söylenir; varsayım yoksa sessiz
  it('PDF: KDV oranı ve ağırlık birimi varsayımı', () => {
    const vat = importReportNotice({ ...base, source: 'pdf', pdfRead: { vatPct: 20, weightUnit: 'kg', vatAssumed: true } });
    assert.deepEqual(vat?.readNotes, [{ key: 'vatAssumed', pct: 20 }]);
    assert.deepEqual(importReportNotice({ ...base, source: 'pdf', pdfRead: { vatPct: 20, weightUnit: 'kg', weightAssumed: true } })?.readNotes, [{ key: 'weightAssumed' }]);
    const lb = importReportNotice({ ...base, source: 'pdf', pdfRead: { vatPct: 18, weightUnit: 'lb' } });
    assert.deepEqual(lb?.readNotes, [{ key: 'weightLb' }]);
    assert.equal(importReportNotice({ ...base, source: 'pdf', pdfRead: { vatPct: 18, weightUnit: 'kg' } }), null);
    assert.equal(importReportNotice({ ...base, source: 'pdf', pdfRead: { vatPct: 18, weightUnit: 'kg', dimUnit: 'cm' } }), null);
  });

  // İnceleme: doğrulanamayan oran varsayım notunun yerine geçer; kullanılmayan birim, çeviri ve korunan satırlar söylenir
  it('PDF: doğrulanamayan oran, g / in çevirisi, tanınmayan birim, korunan lb satırları, karışık birim', () => {
    assert.deepEqual(readNotes({ vatPct: 10, weightUnit: 'kg', vatUnverified: true, vatAssumed: true }), [{ key: 'vatUnverified', pct: 10 }]);
    assert.deepEqual(readNotes({ vatPct: 20, weightUnit: 'g', dimUnit: 'in' }), [{ key: 'weightG' }, { key: 'dimIn' }]);
    assert.deepEqual(readNotes({ vatPct: 20, weightUnit: 'kg', weightUnusable: true, weightAssumed: true, dimUnusable: true }), [{ key: 'weightUnusable' }, { key: 'dimUnusable' }]);
    assert.deepEqual(readNotes({ vatPct: 20, weightUnit: 'lb', weightKeptLines: 3 }), [{ key: 'weightLb' }, { key: 'weightKept', n: 3 }]);
    assert.deepEqual(readNotes({ vatPct: 20, weightUnit: 'kg', unitsMixed: true, dimAssumed: true }), [{ key: 'dimAssumed' }, { key: 'unitsMixed' }]);
    assert.deepEqual(readNotes(undefined), []);
  });

  it('PDF: metin çok büyük, okunmamış satır denetimi yapılamadı', () => {
    const n = importReportNotice({ ...base, source: 'pdf', pdfMissed: { count: 0, trackings: [], tooLarge: true } });
    assert.equal(n?.pdfMissedTooLarge, true);
    assert.equal(n?.pdfMissed, 0);
  });
});

describe('alınmayan satırın değeri', () => {
  it('tutarı okunamayan satırda okunamayan tutar görünür, takip no yanında', () => {
    assert.deepEqual(skippedValue({ row: 3, reason: 'BAD_NET', trackingRaw: '571099', rawNet: 'abc' }), { kind: 'raw', text: '571099 · "abc"' });
    assert.deepEqual(skippedValue({ row: 3, reason: 'BAD_NET', rawNet: 'abc' }), { kind: 'raw', text: '"abc"' });
  });
  it("takip no okunamayan satırda takip no, takip no'suz ücrette tutar", () => {
    assert.deepEqual(skippedValue({ row: 6, reason: 'BAD_TRACKING', trackingRaw: 'ABC-XYZ' }), { kind: 'raw', text: 'ABC-XYZ' });
    assert.deepEqual(skippedValue({ row: 4, reason: 'NO_TRACKING', amount: 45 }), { kind: 'amount', amount: 45 });
  });
});

describe('nasıl hesaplandı', () => {
  it('sıfır tutarlı adım elenir, sıra korunur', () => {
    const steps = visibleSteps([
      { key: 'netDiff', amount: 100, lines: 4 },
      { key: 'uncompared', amount: 0, lines: 0 },
      { key: 'accepted', amount: -20, lines: 1 },
    ]);
    assert.deepEqual(steps.map((s) => s.key), ['netDiff', 'accepted']);
    assert.deepEqual(visibleSteps(undefined), []);
  });

  it('boş tür satırı elenir', () => {
    const rows = visibleByType([
      { type: 'PRICE', lines: 2, amount: 10 },
      { type: 'WEIGHT', lines: 0, amount: 0 },
    ]);
    assert.deepEqual(rows.map((r) => r.type), ['PRICE']);
  });
});
