/**
 * Başarım katmanı (Aşama 0.4; `npm run test:perf`, kapı değil): büyük fatura dosyalarının okuma + ayrıştırma süresi.
 * Doğruluk kapıda: `invoice-robustness.test.ts` › "büyük dosyalar". Eşikler sabittir; yoğun makinede kırılabilir, bu
 * yüzden kapı değildir (CI 2026-11-12: 20.000 satır CSV 7,1 sn, XLSX 16,6 sn).
 */
import { describe, expect, it } from 'vitest';
import { measureBigFile } from './bigInvoiceFiles';
import { bigCsv, bigXlsx } from './fixtures/robustness/build';

const LIMIT_MS = 5000;

describe('büyük dosyalar (süre ölçümü)', () => {
  it('5.000 satır CSV (başta FedEx 11735 satırları): okuma + ayrıştırma < 5 sn', async () => {
    const { p, ms } = await measureBigFile('big-5000.csv', bigCsv(5000, { prefixFedex11735: true }));
    expect(p.lines).toHaveLength(5018);
    expect(ms.read + ms.parse).toBeLessThan(LIMIT_MS);
  });

  it('20.000 satır CSV: okuma + ayrıştırma < 5 sn', async () => {
    const { p, ms } = await measureBigFile('big-20000.csv', bigCsv(20000));
    expect(p.lines).toHaveLength(20000);
    expect(ms.read + ms.parse).toBeLessThan(LIMIT_MS);
  });

  it('20.000 satır XLSX: okuma + ayrıştırma < 10 sn', async () => {
    const { p, ms } = await measureBigFile('big-20000.xlsx', await bigXlsx(20000));
    expect(p.lines).toHaveLength(20000);
    expect(ms.read + ms.parse).toBeLessThan(LIMIT_MS * 2);
  }, 60_000);
});
