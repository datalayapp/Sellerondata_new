import { describe, expect, it } from 'vitest';
import { scanDecision } from '../src/lib/scanCheck';

// Kaynakta görünmez karakter yazılmaz (depo denetimi K2): kod noktasıyla kurulur.
const GS = String.fromCharCode(0x1d);
const CR = String.fromCharCode(0x0d);

describe('barkod okuma kararı (KALANLAR 4.8; kural core trackingFormat.ts)', () => {
  it('takip no gibi görünen değer sormadan geçer', () => {
    expect(scanDecision('794812345305', 'code128')).toEqual({ code: '794812345305', action: 'proceed' });
    expect(scanDecision('1Z9X4A710341000011')).toEqual({ code: '1Z9X4A710341000011', action: 'proceed' });
    expect(scanDecision('AB12CD34EF')).toMatchObject({ action: 'proceed' });
  });

  it('okuyucu işaretleri ham değerden silinir; aradaki boşluk kalır', () => {
    expect(scanDecision(`]C1794812345305${CR}`, 'code128').code).toBe('794812345305');
    expect(scanDecision(`7948${GS}12345305`).code).toBe('794812345305');
    expect(scanDecision('  7948 1234 5305 ').code).toBe('7948 1234 5305');
  });

  it('ürün barkodu ve olağan dışı biçim: sorulur, yine de kaydedilebilir', () => {
    expect(scanDecision('8690000000005', 'ean13')).toEqual({ code: '8690000000005', action: 'confirm' });
    expect(scanDecision('8691234567890')).toMatchObject({ action: 'confirm' });
    expect(scanDecision('1234567')).toMatchObject({ action: 'confirm' });
    expect(scanDecision('HTTPS://X.CO/A1', 'qr')).toMatchObject({ action: 'confirm' });
    expect(scanDecision('ABCDEFGHIJ')).toMatchObject({ action: 'confirm' });
  });

  it('kesin geçersiz: kaydedilmez (sunucu da 400 verirdi, kayıt "Hatalı" kalırdı)', () => {
    expect(scanDecision('1234')).toMatchObject({ action: 'reject' });
    expect(scanDecision('---')).toMatchObject({ action: 'reject' });
    expect(scanDecision(`https://example.com/track?id=${'1'.repeat(40)}`, 'qr')).toMatchObject({ action: 'reject' });
  });

  it('boş girdi: hiçbir şey yapılmaz', () => {
    expect(scanDecision('   ')).toEqual({ code: '', action: 'ignore' });
    expect(scanDecision(`${CR}`)).toEqual({ code: '', action: 'ignore' });
  });
});
