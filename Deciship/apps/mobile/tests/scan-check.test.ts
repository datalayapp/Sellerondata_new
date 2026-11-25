import { describe, expect, it } from 'vitest';
import { barcodeInFrame, pickScan, SCAN_WAIT_MS, SCAN_WAIT_WEAK_MS, scanCandidate, scanDecision, scanWaitMs } from '../src/lib/scanCheck';

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

const RS = String.fromCharCode(0x1e);
const EOT = String.fromCharCode(0x04);
const FEDEX34 = '9632001960000000000400794812345305';
// FedEx Express etiketindeki PDF417 (MH10.8.3): posta kodu, ülke, hizmet, takip no, FDE, hesap, ağırlık, adres…
const FEDEX_PDF417 = `[)>${RS}${['01', '02', '34394', '792', '001', '794812345305', 'FDE', '510087020', '329', '1/1', '2.50KG', 'N', 'BUYUKDERE CAD 1', 'ISTANBUL', 'IS', 'ACME LTD'].join(GS)}${RS}${EOT}`;

describe('barkodun içinden yalnız takip no', () => {
  it('FedEx PDF417: uzun ileti değil, 12 haneli takip no; sormadan geçer', () => {
    expect(scanDecision(FEDEX_PDF417, 'pdf417')).toEqual({ code: '794812345305', action: 'proceed' });
  });
  it('FedEx 34 haneli barkod: ekranda ve taslakta son 12 hane', () => {
    expect(scanDecision(FEDEX34, 'code128')).toEqual({ code: '794812345305', action: 'proceed' });
  });
  it('takip no çıkmayan 2D ileti: bugünkü gibi reddedilir (yeniden okutulur)', () => {
    const order = `[)>${RS}${['06', '1PABC123', 'Q1', '10DSIPARIS'].join(GS)}${RS}${EOT}`;
    expect(scanDecision(order.repeat(3), 'pdf417')).toMatchObject({ action: 'reject' });
  });
});

describe('etiketteki barkodlardan en uygununu seçme', () => {
  const at = (raw: string, sym: string, t: number, inFrame: boolean | null = null) => scanCandidate(raw, sym, { at: t, inFrame });

  it('puan: ayıklanmış takip no > taşıyıcı biçimi > bilinmeyen biçim > olağan dışı > geçersiz', () => {
    expect(at(FEDEX_PDF417, 'pdf417', 0).score).toBe(4);
    expect(at(FEDEX34, 'code128', 0).score).toBe(4);
    expect(at('794812345305', 'code128', 0).score).toBe(3);
    expect(at('AB12CD34EF', 'code128', 0).score).toBe(2);
    expect(at('8690000000005', 'ean13', 0).score).toBe(1);
    expect(at('1'.repeat(60), 'pdf417', 0).score).toBe(0);
  });
  it('kesin okuma beklemez; taşıyıcı biçimi kısa, öteki uzun bekler', () => {
    expect(scanWaitMs(at(FEDEX_PDF417, 'pdf417', 0))).toBe(0);
    expect(scanWaitMs(at('794812345305', 'code128', 0))).toBe(SCAN_WAIT_MS);
    expect(scanWaitMs(at('AB12CD34EF', 'code128', 0))).toBe(SCAN_WAIT_WEAK_MS);
    expect(scanWaitMs(at('1'.repeat(60), 'pdf417', 0))).toBe(SCAN_WAIT_WEAK_MS);
  });
  it('karışık etiket: form/sipariş kodu önce gelse de takip no seçilir', () => {
    const best = pickScan([at('0430', 'code128', 0), at('SIPARIS-2026-11-25-0001', 'qr', 10), at(FEDEX34, 'code128', 20), at(FEDEX_PDF417, 'pdf417', 30)]);
    expect(best?.code).toBe('794812345305');
    expect(best?.seenAt).toBe(20);
  });
  it('eşit puanda çerçevenin içindeki, sonra ilk görülen', () => {
    expect(pickScan([at('1234567890', 'code128', 0, false), at('794812345305', 'code128', 5, true)])?.code).toBe('794812345305');
    expect(pickScan([at('794812345305', 'code128', 0, null), at('123456789012', 'code128', 5, null)])?.code).toBe('794812345305');
    expect(pickScan([at('794812345305', 'code128', 9, null), at('123456789012', 'code128', 5, null)])?.code).toBe('123456789012');
  });
  it('yalnız geçersiz okumalar: en iyisi yine geçersizdir (bugünkü red); boş liste null', () => {
    expect(pickScan([at('1'.repeat(60), 'pdf417', 0)])?.action).toBe('reject');
    expect(pickScan([])).toBeNull();
  });
});

describe('barkod çerçevenin içinde mi', () => {
  const view = { width: 360, height: 300 };
  const box = (x: number, y: number, w = 40, h = 20) => ({ bounds: { origin: { x, y }, size: { width: w, height: h } }, cornerPoints: [] });
  it('ortadaki barkod içeride, kenardaki dışarıda', () => {
    expect(barcodeInFrame(box(160, 140), view)).toBe(true);
    expect(barcodeInFrame(box(0, 0), view)).toBe(false);
  });
  it('köşe noktaları varsa onların ortası kullanılır', () => {
    const pts = [
      { x: 170, y: 140 },
      { x: 190, y: 140 },
      { x: 190, y: 160 },
      { x: 170, y: 160 },
    ];
    expect(barcodeInFrame({ cornerPoints: pts, bounds: null }, view)).toBe(true);
  });
  it('konum yok, boş ya da görünüm dışı (başka koordinat düzeni): bilinmiyor', () => {
    expect(barcodeInFrame(box(0, 0, 0, 0), view)).toBeNull();
    expect(barcodeInFrame(box(1500, 900), view)).toBeNull();
    expect(barcodeInFrame(box(160, 140), null)).toBeNull();
  });
});
