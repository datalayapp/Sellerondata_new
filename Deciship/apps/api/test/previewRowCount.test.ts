/**
 * Y32 (Mesaj 14): yükleme önizlemesinin "N satır" sayısı ayrıştırıcının okuyacağı veri satırlarıdır. TOPLAM, ara toplam
 * ve boş satır sayılmaz; kural ayrıştırıcının kendisi (`parseRows`). Veritabanı istemez.
 */
import { describe, expect, it } from 'vitest';
import type { ColumnMapping } from '@deciship/core';
import { previewRowCount } from '../src/routes/invoices.ts';

const BASE: ColumnMapping = { surchargeColumns: [], amountsIncludeVat: false, vatPct: 20, desiAsWeight: false };
const mapping: ColumnMapping = { ...BASE, trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' };
const headers = ['Takip No', 'Desi', 'Tutar'];

describe('previewRowCount', () => {
  it('TOPLAM ve ara toplam satırları ile boş satır sayılmaz', () => {
    const rows = [
      ['794800000001', '5', '50,00'],
      ['794800000002', '3', '30,00'],
      ['Ara Toplam', '', '80,00'],
      ['', '', ''],
      ['794800000003', '2', '20,00'],
      ['TOPLAM', '', '100,00'],
    ];
    expect(previewRowCount({ headers, rows }, mapping)).toBe(3);
  });

  it('okunamayan satır ve takip no’suz ücret satırı yüklemede raporlanır: sayılır; bir satır bir kez', () => {
    const rows = [
      ['794800000001', '5', '50,00'],
      ['794800000002', '3', 'yok'],
      ['', '', '12,50'],
      ['794800000003', '2', '20,00'],
    ];
    expect(previewRowCount({ headers, rows }, mapping)).toBe(4);
  });

  it('takip no ya da tutar sütunu eşlenmemişse ham satır sayısı', () => {
    const rows = [
      ['794800000001', '5', '50,00'],
      ['TOPLAM', '', '50,00'],
    ];
    expect(previewRowCount({ headers, rows }, { ...BASE, billedKg: 'Desi', netAmount: 'Tutar' })).toBe(2);
    expect(previewRowCount({ headers, rows }, { ...BASE, trackingNo: 'Takip No' })).toBe(2);
  });
});
