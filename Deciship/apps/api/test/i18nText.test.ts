/**
 * Veritabanısız dil denetimleri (Aşama 0.3; hızlı grup `npm run test:unit`): metin tablosunun anlık görüntüsü, iki dil ve
 * yer tutucular, çoğul kuralı, görüntü servisinin metinleri, `src` altında kullanıcıya dönen Türkçe metin taraması ve
 * döküm etiketlerinin çevirisi. İstek diliyle ilgili, veritabanı isteyen denetimler `i18n.test.ts`'te.
 * Anlık görüntü yalnız metin bilerek değiştiyse güncellenir: `npm run t -- Deciship/apps/api/test/i18nText.test.ts -u`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { localizeBreakdown } from '@deciship/core';
import { describe, expect, it } from 'vitest';
import { m } from '../src/i18n/index.ts';
import { MESSAGES } from '../src/i18n/messages.ts';

const SRC = path.resolve(import.meta.dirname, '../src');
const TR_CHARS = /[ğüşıöçĞÜŞİÖÇ]/;

describe('metin tablosu', () => {
  it('Türkçe metinler karakteri karakterine sabit (anlık görüntü)', () => {
    expect(Object.fromEntries(Object.entries(MESSAGES).map(([k, v]) => [k, v.tr]))).toMatchSnapshot();
  });

  it('her anahtarın İngilizcesi var, Türkçe harf taşımaz, yer tutucular iki dilde aynı', () => {
    const wrong: string[] = [];
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join();
    for (const [k, v] of Object.entries(MESSAGES)) {
      if (!v.en.trim()) wrong.push(`${k}: boş`);
      if (TR_CHARS.test(v.en)) wrong.push(`${k}: Türkçe harf: ${v.en}`);
      if (holes(v.tr) !== holes(v.en)) wrong.push(`${k}: yer tutucu farklı`);
    }
    expect(wrong).toEqual([]);
  });

  it('çoğul: {n|tekil|çoğul} bir ise tekil, değilse çoğul; Türkçe değişmez', () => {
    expect(m('invoice.tariffUsedLines', { name: 'A', lines: 1 }, 'en')).toBe('A (1 line)');
    expect(m('invoice.tariffUsedLines', { name: 'A', lines: 2 }, 'en')).toBe('A (2 lines)');
    expect(m('invoice.tariffUsedLines', { name: 'A', lines: '1.200' }, 'en')).toBe('A (1.200 lines)');
    expect(m('measurement.photoRequired', { required: 1 }, 'en')).toBe('At least 1 box photo is required to save');
    expect(m('measurement.photoRequired', { required: 3 }, 'en')).toBe('At least 3 box photos are required to save');
    expect(m('pdf.omittedCountries', { count: 1, list: 'X' }, 'en')).toContain('1 country is in zones');
    expect(m('pdf.omittedCountries', { count: 1, list: 'X' }, 'en')).toContain('and was not added');
    expect(m('pdf.omittedCountries', { count: 4, list: 'X' }, 'en')).toContain('4 countries are in zones');
    expect(m('invoice.tariffUsedLines', { name: 'A', lines: 2 }, 'tr')).toBe('A (2 satır)');
  });

  it('görüntü servisinin metinleri tabloyla birebir aynı', () => {
    const py = fs.readFileSync(path.resolve(import.meta.dirname, '../../../services/vision/app/main.py'), 'utf8');
    for (const code of ['NO_MARKER', 'BAD_IMAGE', 'TOO_LARGE', 'BLURRY', 'BOX_FOUND', 'BOX_DEFAULT', 'BAD_POINTS'] as const) {
      const text = new RegExp(`^MSG_${code} = "(.*)"$`, 'm').exec(py)?.[1];
      expect(text, code).toBe(MESSAGES[`vision.${code}`].tr);
    }
  });
});

describe('kaynak kod taraması', () => {
  /**
   * Türkçe metin taşımasına izin verilen satırlar. Kullanıcıya dönmez: yapay zekâ promptu, işletim günlüğü, iç hata (yanıtta
   * genel 500 olur), geliştirme tohumu, kanonik kayıt metni, tarife ayrıştırıcısının tanıdığı başlıklar.
   */
  const ALLOWED: Record<string, RegExp> = {
    // dil tabloları
    'i18n/messages.ts': /./,
    'services/hub/i18n.ts': /./,
    // yapay zekâ promptları
    'services/ai.ts': /trackingNo: the tracking|The invoice may be in Turkish/,
    'services/aiMapping.ts': /Ücret Etiketi|in Turkish/,
    'services/aiTariffReview.ts': /Türkiye|Bölgeler|Turkish|Taşıyıcı|Ağırlık/,
    // prompt + ayrıştırıcının okuduğu ham tablo (kullanıcıya çıkmaz, tanıma sözlüğü)
    'services/tariffPdf.ts': /Yurtiçi|Türkiye|Turkish|BÖLGESİ|İlave|kg başı|extractCountries|Kg başına|İhracat|Ülke kodu|Ağırlık \(/,
    // işletim günlüğü, iç hata
    'db.ts': /Dizi biçimi/,
    'lib/schemaCheck.ts': /./,
    'main.ts': /ANTHROPIC_API_KEY/,
    'startup.ts': /Üretimde zorunlu|Şema denetimi/,
    'services/hub/limiter.ts': /koruyucu süreyle/,
    'env.ts': /geliştirme parolası|üretimde kapalı|MIN_MOBILE_VERSION/,
    'services/hub/datasets.ts': /Dışa aktarma eksik/,
    'errors.ts': /veritabanı bağlantısı koptu/,
    'identity.ts': /Üyelik kimliği|Hesap anahtarları/,
    'lib/storage.ts': /Geçersiz dosya yolu/,
    'seed.ts': /./,
    'dev-seed.ts': /./,
    'seedDemoDisputes.ts': /./,
    'services/companyData.ts': /log\(|new Error/,
    'services/sampleInvoices.ts': /new Error/,
    'services/demoTour.ts': /new Error/,
    'services/lineWrite.ts': /Geçersiz sayı/,
    'services/reports.ts': /yazı tipi/,
    'services/maintenance.ts': /log|warn/,
    // satır notunun kanonik önekleri (veritabanında Türkçe durur, gösterirken çevrilir)
    'services/compare.ts': /Kur alınamadı|Kur bulunamadı|MeasurementIndex\.find/,
  };

  it('src altında kullanıcıya dönen Türkçe metin kalmadı', () => {
    const files = fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.includes('generated')).map((f) => f.replace(/\\/g, '/'));
    const found: string[] = [];
    for (const f of files) {
      const allow = ALLOWED[f];
      fs.readFileSync(path.join(SRC, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const code = line.replace(/\s\/\/ .*$/, '');
        if (!TR_CHARS.test(code) || allow?.test(code)) return;
        found.push(`${f}:${i + 1}: ${code.trim().slice(0, 110)}`);
      });
    }
    expect(found).toEqual([]);
  });
});

describe('fatura satırı dökümü', () => {
  it('kaydedilen her döküm etiketi İngilizceye çevrilir, sayılar EN biçiminde; tarife ek ücreti adı veridir', () => {
    const table: [string, string][] = [
      ['Tarife fiyatı (Bölge A, 6,0 kg)', 'Tariff price (Zone A, 6.0 kg)'],
      ['Tarife fiyatı (Bölge A, kg başı 12,5 × 6,0 kg)', 'Tariff price (Zone A, per kg 12.5 × 6.0 kg)'],
      ['Tarife fiyatı (Bölge A, 6,0 kg, taşma 2 birim)', 'Tariff price (Zone A, 6.0 kg, overflow 2 units)'],
      ['İndirim %38', 'Discount 38%'],
      ['Yakıt %25', 'Fuel 25%'],
      ['Yakıt %27,75', 'Fuel 27.75%'],
      ['Almanya istisnası +%5', 'Germany adjustment +5%'],
      ['Taşıma — faturadaki fiyatla: ₺100,00 × 0,5', 'Freight — at the invoiced price: ₺100.00 × 0.5'],
      ['Tarifeye göre olurdu', 'Would be, per the tariff'],
      ['Beklenen 100 USD × 41,2345 (TCMB 03.06.2025)', 'Expected 100 USD × 41.2345 (TCMB 3 Jun 2025)'],
      ['Özel Hizmet', 'Özel Hizmet'],
    ];
    for (const [tr, en] of table) expect(localizeBreakdown([{ label: tr, amount: 1 }], 'en')[0]!.label, tr).toBe(en);
    expect(localizeBreakdown([{ label: 'İndirim %38', amount: 1 }], 'tr')[0]!.label).toBe('İndirim %38');
  });
});
