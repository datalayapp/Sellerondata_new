import { describe, expect, it } from 'vitest';
import { withLocale } from '../src/i18n/index.ts';
import { GB_BYTES, fitsQuota, quotaBytes, storageQuotaExceeded } from '../src/services/storageQuota.ts';

/** Y65: kota kuralının saf parçaları (veritabanı yok). Toplamın sorgusu `storageFiles.test.ts`'te (veritabanı ister). */
describe('dosya alanı kotası: kural', () => {
  it('GB → bayt (1024³); 0, eksi, NaN ve sonsuz kapalı', () => {
    expect(GB_BYTES).toBe(1_073_741_824);
    expect(quotaBytes(10)).toBe(10 * 1_073_741_824);
    expect(quotaBytes(0.5)).toBe(536_870_912);
    for (const off of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(quotaBytes(off)).toBeNull();
  });

  it('sığar: kullanılan + gelen ≤ kota (tam sınır sığar, bir bayt fazlası sığmaz); kapalıyken her şey sığar', () => {
    expect(fitsQuota(0, 100, 100)).toBe(true);
    expect(fitsQuota(60, 40, 100)).toBe(true);
    expect(fitsQuota(60, 41, 100)).toBe(false);
    expect(fitsQuota(101, 0, 100)).toBe(false);
    expect(fitsQuota(Number.MAX_SAFE_INTEGER, 1, null)).toBe(true);
  });

  it('hata: 413 STORAGE_QUOTA_EXCEEDED, isteğin dilinde, sınır ayrıntıda', async () => {
    const tr = await withLocale('tr', () => storageQuotaExceeded(10));
    expect(tr).toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED', details: { limitGb: 10 } });
    expect(tr.message).toBe('Firmanızın dosya alanı doldu (en çok 10 GB). Yer açmak için gerekmeyen faturaları silin ya da bizimle iletişime geçin.');
    const en = await withLocale('en', () => storageQuotaExceeded(2.5));
    expect(en.message).toBe("Your company's file storage is full (at most 2.5 GB). Delete invoices you no longer need to free up space, or contact us.");
    expect((await withLocale('tr', () => storageQuotaExceeded(2.5))).message).toContain('en çok 2,5 GB');
  });
});
