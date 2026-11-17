import { describe, expect, it } from 'vitest';
import { HEADER_FIELDS } from '@deciship/core';
import { aiRawToMapping, buildMappingPrompt, type AiMappingRaw } from '../src/services/aiMapping.ts';
import { headerAliases, headerLooksLikeData, headerPrivacy, headerSuspicious, maskShape, shouldMaskSample, unaliasHeader, type HeaderPrivacy } from '../src/services/aiMappingMask.ts';

/**
 * Kullanıcı kararı 2026-11-12 (denetim 18-B1, 05-B8): yapay zekâ ile sütun eşlemede kişisel veri biçimi korunarak maskelenir.
 * Veritabanı istemez; sağlayıcıya giden istemin uçtan uca denetimi `aiMapping.test.ts`'te.
 */

const masked = (cls: HeaderPrivacy, v: string) => shouldMaskSample(cls, v);
const sent = (header: string, v: string) => (shouldMaskSample(headerPrivacy(header), v) ? maskShape(v) : v);

describe('maskShape: biçim korunur', () => {
  it('harf A/a, rakam 9; noktalama, boşluk ve uzunluk aynen; Türkçe harfler dahil', () => {
    expect(maskShape('Atatürk Cad. No:12 Kadıköy')).toBe('Aaaaaaa Aaa. Aa:99 Aaaaaaa');
    expect(maskShape('Ayşe Yılmaz')).toBe('Aaaa Aaaaaa');
    expect(maskShape('İĞÜŞÖÇ ığüşöç')).toBe('AAAAAA aaaaaa');
    expect(maskShape('+90 532 123 45 67')).toBe('+99 999 999 99 99');
    expect(maskShape('ali@x.com')).toBe('aaa@a.aaa');
    expect(maskShape('JD014600003311')).toBe('AA999999999999');
    expect(maskShape('Straße 5')).toBe('Aaaaaa 9');
    for (const v of ['Atatürk Cad. No:12 Kadıköy', 'İĞÜŞÖÇ', 'Straße 5']) expect(maskShape(v)).toHaveLength(v.normalize('NFC').length);
  });
});

describe('headerPrivacy: başlık sınıfı', () => {
  it.each([
    ['Recipient Name', 'personal'],
    ['Recipient Address', 'personal'],
    ['Recipient Phone', 'personal'],
    ['Alıcı Adı', 'personal'],
    ['Alıcı', 'personal'],
    ['Ad Soyad', 'personal'],
    ['Telefon', 'personal'],
    ['Tel', 'personal'],
    ['GSM', 'personal'],
    ['E-Mail', 'personal'],
    ['E-posta', 'personal'],
    ['Posta Kodu', 'personal'],
    ['ZIP', 'personal'],
    ['PLZ', 'personal'],
    ['Empfängername', 'personal'],
    ['Empfängeradresse', 'personal'],
    ['Straße', 'personal'],
    ['Şehir', 'personal'],
    ['Varış İli', 'personal'],
    ['ConsigneeCity', 'personal'],
    ['TC Kimlik No', 'personal'],
    // adres ülkeyi de kapsasa da kişisel kalır (güvenli taraf)
    ['Address Country', 'personal'],
    ['Recipient Country', 'safeText'],
    ['Empfängerland', 'safeText'],
    ['Alıcı Ülke', 'safeText'],
    // inceleme 2: ad sözcüğü güvenli sözcükle ezilmez (eskiden safeText; "Charge To Name" ile ayırt edilemez)
    ['Service Name', 'personal'],
    ['Hizmet Adı', 'personal'],
    ['Charge Description', 'safeText'],
    ['Ücret Etiketi', 'safeText'],
    ['Gebührenart', 'safeText'],
    ['Währung', 'safeText'],
    ['Para Birimi', 'safeText'],
    ['Ship Date', 'safeText'],
    ['ShipDate', 'safeText'],
    ['Versanddatum', 'safeText'],
    ['Fatura Tarihi', 'safeText'],
    ['Tracking Number', 'neutral'],
    ['Sendungsnummer', 'neutral'],
    ['Nettobetrag', 'neutral'],
    ['Gewicht (kg)', 'neutral'],
    ['Açıklama', 'neutral'],
    ['Report', 'neutral'],
    ['Capacity', 'neutral'],
  ] as const)('%s → %s', (h, cls) => {
    expect(headerPrivacy(h)).toBe(cls);
  });
});

describe('shouldMaskSample: korunanlar', () => {
  it.each([
    '1.234,56',
    '1,234.56',
    '12.5',
    '0,4',
    '-3,50',
    '23,50-',
    '(23.50)',
    '120',
    '1 234,56',
    '€ 23,50',
    '23,50 EUR',
    '99,40 TL',
    '4,2 kg',
    '18%',
    '2026-11-03',
    '14.10.2026',
    '10/27/2026',
    '2026-11-03T10:30:00Z',
    '03.11.2026 10:30',
    '20261103',
    '10:30',
    '40x30x25',
    '40 x 30 x 25 cm',
    'TRY',
    'EUR',
    'TR',
    'KG',
    'lb',
    'CM',
  ])('neutral sütunda %s aynen gider', (v) => {
    expect(masked('neutral', v)).toBe(false);
  });

  it('güvenli metin sütununda ülke, hizmet ve ücret etiketi aynen gider', () => {
    expect(sent('Empfängerland', 'Frankreich')).toBe('Frankreich');
    expect(sent('Service', 'International Priority')).toBe('International Priority');
    expect(sent('Hizmet', 'Express 12:00')).toBe('Express 12:00');
    expect(sent('Charge Description', 'Fuel Surcharge')).toBe('Fuel Surcharge');
    expect(sent('Ücret Etiketi', 'Adres Düzeltme')).toBe('Adres Düzeltme');
    expect(sent('Versanddatum', '14-Oct-2026')).toBe('14-Oct-2026');
  });

  it('boş hücre maskelenmez (gösterim "∅" kalır)', () => {
    expect(masked('personal', '')).toBe(false);
    expect(masked('neutral', '   ')).toBe(false);
  });
});

describe('shouldMaskSample: maskelenenler', () => {
  it('kişisel başlıkta sayı gibi görünen değer de maskelenir', () => {
    expect(sent('Posta Kodu', '34710')).toBe('99999');
    expect(sent('Alıcı Telefon', '5321234567')).toBe('9999999999');
    expect(sent('Telefon', '532')).toBe('999');
    expect(sent('Recipient Name', 'TR')).toBe('AA');
    expect(sent('Recipient Address', 'Atatürk Cad. No:12 Kadıköy')).toBe('Aaaaaaa Aaa. Aa:99 Aaaaaaa');
    expect(sent('Alıcı Adı', 'Ayşe Yılmaz')).toBe('Aaaa Aaaaaa');
  });

  it.each([
    ['Atatürk Cad. No:12 Kadıköy', 'adres'],
    ['No:12', 'rakamlı adres parçası'],
    ['12 SOK', 'sayı + adres kısaltması'],
    ['0532 123 45 67', 'telefon'],
    ['(0532) 123-4567', 'telefon'],
    ['+90 555 000 11 22', 'telefon'],
    ['05321234567', 'ayırıcısız telefon'],
    ['794612345678', 'ayırıcısız takip no'],
    ['ali@x.com', 'e-posta'],
    ['Ayşe Yılmaz', 'ad'],
    ['JD014600003311', 'takip no'],
    ['RE-7781', 'fatura no'],
    ['34 ABC 123', 'plaka'],
    ['1.23E+11', 'bilimsel gösterim'],
  ])('neutral sütunda %s (%s) maskelenir', (v) => {
    expect(masked('neutral', v)).toBe(true);
  });

  it('güvenli metin sütununda bile telefon ve e-posta maskelenir; kişisel olmayan başlıkta telefon biçimli sayı maskelenir', () => {
    expect(masked('safeText', '+90 555 000 11 22')).toBe(true);
    expect(masked('safeText', 'ali@x.com')).toBe(true);
    expect(sent('Fracht', '0532 123 45 67')).toBe('9999 999 99 99');
    expect(sent('Referenz', '+90 555 000 11 22')).toBe('+99 999 999 99 99');
  });
});

describe('buildMappingPrompt: istemde kişisel veri yok, sayılar aynen', () => {
  // Denetimin (18-B1) kurgusal üç satırı.
  const table = {
    headers: ['Tracking Number', 'Recipient Name', 'Recipient Address', 'Recipient Phone', 'Net Charge', 'Ship Date', 'Currency', 'Weight', 'E-mail'],
    rows: [
      ['794612345678', 'Ayse Kurgu', 'Kurgu Sk. No 12 Daire 3', '+90 555 000 11 22', '120,50', '2026-11-03', 'TRY', '1.234,56', 'ayse@kurgu.example'],
      ['794612345679', 'Mehmet Ornek', 'Ornek Cad. 45/7 Kadikoy', '+90 555 000 33 44', '98,10', '2026-11-04', 'TRY', '12.5', 'mehmet@ornek.example'],
      ['794612345680', 'Zeynep Deneme', 'Deneme Mah. 8. Sokak No 2', '+90 555 000 55 66', '75,00', '2026-11-05', 'TRY', '0,4', 'zeynep@deneme.example'],
    ],
  };
  const text = buildMappingPrompt(table, { code: 'fedex', name: 'FedEx' });

  it('ad, adres, telefon, e-posta ve takip no istemde geçmez; başlıklar aynen', () => {
    for (const r of table.rows) {
      for (const v of [r[0]!, r[1]!, r[2]!, r[3]!, r[8]!]) expect(text).not.toContain(v);
      for (const part of r[1]!.split(' ')) expect(text).not.toContain(part);
    }
    for (const leak of ['Kurgu', 'Ornek', 'Deneme', 'Kadikoy', '555', '7946', '@kurgu', 'Sokak', 'Daire']) expect(text).not.toContain(leak);
    for (const h of table.headers) expect(text).toContain(JSON.stringify(h));
    expect(text).toContain('Aaaa Aaaaa | Aaaaaa Aaaaa | Aaaaaa Aaaaaa');
    expect(text).toContain('+99 999 999 99 99');
    expect(text).toContain('999999999999');
  });

  it('tutar, ağırlık, tarih ve para birimi istemde aynen kalır', () => {
    expect(text).toContain('120,50 | 98,10 | 75,00');
    expect(text).toContain('2026-11-03 | 2026-11-04 | 2026-11-05');
    // rakamsız sütun: farklı değerler bir kez (eski davranış)
    expect(text).toContain('"Currency" — filled 3/3, distinct 1: TRY\n');
    expect(text).toContain('1.234,56 | 12.5 | 0,4');
    // farklı değer sayısı gerçek tablodan
    expect(text).toMatch(/"Tracking Number" — filled 3\/3, distinct 3:/);
  });
});

describe('inceleme 2: ad ve taraf sözcüğü güvenli sözcükle ezilmez; kısa güvenli sözcük tam sözcük', () => {
  it.each([
    'Charge To Name',
    'Recipient Name / Delivery Date',
    'Produkt Empfänger',
    'Customer Service Rep',
    'Ürün / Alıcı',
    'Hizmet Alan',
    'Teslim Alan',
    'Landline',
    'Service Contact',
    'Signed By',
    'POD Signature',
    'Doğum Tarihi',
  ])('%s → personal (değer maskelenir)', (h) => {
    expect(headerPrivacy(h)).toBe('personal');
    expect(sent(h, 'Ahmet Yılmaz')).toBe('Aaaaa Aaaaaa');
  });

  it('taraf sözcüğü yalnız ülke ya da tarih anlamıyla güvenli; "Land" tam sözcükken ülke', () => {
    for (const h of ['Recipient Country', 'Alıcı Ülke', 'Empfängerland', 'Consignee Date', 'Land', 'Zielland']) expect(headerPrivacy(h), h).toBe('safeText');
  });
});

describe('inceleme 3: gruplu rakam, küçük harfli kısa ad, posta kodu kısaltmaları', () => {
  it.each(['612 345 678', '030 123 456', '5 321 234', '123 456', '1234 5678', 'Ali', 'Can', 'Ali Can'])('neutral sütunda %s maskelenir', (v) => {
    expect(masked('neutral', v)).toBe(true);
  });

  it.each(['1 234,56', '1 234 kg', '€ 1 234', '1 234 TL', 'TRY', 'KG', 'kg', 'lb', 'cm', '12 TL'])('neutral sütunda %s aynen gider', (v) => {
    expect(masked('neutral', v)).toBe(false);
  });

  it.each(['PK', 'CAP', 'CP', 'NPA', 'PLZ', 'Móvil', 'Tfno', 'Rufnummer', 'Kontaktnummer'])('%s başlığı kişisel: sayı da maskelenir', (h) => {
    expect(headerPrivacy(h)).toBe('personal');
    expect(sent(h, '34710')).toBe('99999');
  });
});

describe('inceleme 1: başlık satırı veri gibiyse başlıklar da gitmez', () => {
  it('veri gibi başlık: sayı, tarih, e-posta, telefon, 7+ rakam, rakam-harf-rakam kimlik; gerçek başlıklar değil', () => {
    for (const h of ['12,50', '2,5', '12.5', '2026-11-03', 'ali@x.com', '0532 123 45 67', '1Z999AA10123456784', '1Z1', '794612345678']) expect(headerLooksLikeData(h), h).toBe(true);
    for (const h of ['Tracking Number', 'Net Charge', 'Gewicht (kg)', 'Charge 2', 'Address2', '2nd Charge', 'KG', 'Ship Date', 'Takip No']) expect(headerLooksLikeData(h), h).toBe(false);
    expect(headerSuspicious('Gönderici: Ahmet Yılmaz / Takip No')).toBe(true);
    expect(headerSuspicious('12345 67')).toBe(true);
    expect(headerSuspicious('Recipient Name')).toBe(false);
  });

  it('başlıksız dosya (veri satırı başlık seçilmiş): hiçbir başlık ve kişisel değer isteme girmez; sayılar aynen', () => {
    const row0 = ['1Z999AA10123456784', 'Ahmet Yılmaz', 'Atatürk Cad. No 5 Kadıköy', 'İstanbul', '0532 123 45 67', '12,50', '2,5'];
    const t = {
      headers: row0,
      rows: [
        ['1Z999AA10123456785', 'Ayşe Demir', 'İnönü Sok. 3 Çankaya', 'Ankara', '0533 222 33 44', '15,00', '3'],
        ['1Z999AA10123456786', 'Mehmet Kaya', 'Cumhuriyet Mah. 7', 'İzmir', '0534 111 22 33', '9,90', '1'],
      ],
    };
    expect(headerAliases(t.headers)).toEqual(['#0', '#1', '#2', '#3', '#4', '#5', '#6']);
    const text = buildMappingPrompt(t, { code: 'ups', name: 'UPS' });
    for (const leak of ['Ahmet', 'Yılmaz', 'Atatürk', 'Kadıköy', 'İstanbul', '0532', '1Z999AA', 'Ayşe', 'Demir', 'İnönü', 'Ankara', '0533', 'Mehmet', 'Cumhuriyet', 'İzmir']) {
      expect(text, leak).not.toContain(leak);
    }
    expect(text).toContain('[1] "#1" (header hidden, shape "Aaaaa Aaaaaa")');
    expect(text).toContain('15,00 | 9,90');
  });

  it('yinelenen başlıklı dosyada veri satırı başlık seçilmişse ("1Z1", "12.5" veri gibi): ad başlığı da gitmez', () => {
    const t = { headers: ['1Z1', 'Fuel', 'Residential', 'Remote', 'Address Correction', 'Base', 'John Smith', '12.5'], rows: [['1Z2', 'Fuel', 'Base', '', '', '', 'Jane Doe', '10']] };
    const text = buildMappingPrompt(t, { code: 'ups', name: 'UPS' });
    for (const leak of ['John', 'Smith', 'Jane', 'Doe', '1Z1', '1Z2']) expect(text, leak).not.toContain(leak);
  });

  it('grup başlığı birleşmiş ("Gönderici: Ahmet Yılmaz / Takip No"): yalnız o başlık gizlenir, diğerleri aynen', () => {
    const t = { headers: ['Gönderici: Ahmet Yılmaz / Takip No', 'Gönderici: Ahmet Yılmaz', 'Tutar', 'Ağırlık'], rows: [['123456789012', 'x', '12,50', '2']] };
    expect(headerAliases(t.headers)).toEqual(['#0', '#1', null, null]);
    const text = buildMappingPrompt(t, { code: 'yk', name: 'Yurtiçi' });
    expect(text).not.toContain('Ahmet');
    expect(text).not.toContain('Yılmaz');
    expect(text).toContain('"Tutar"');
    expect(text).toContain('"Ağırlık"');
  });

  it('takma ad dosyadaki bir başlıkla çakışmaz; yanıttaki takma ad gerçek başlığa çevrilir (eşleme sütunla çalışır)', () => {
    expect(headerAliases(['#0', '12,50'])).toEqual(['#0~', '#1']);
    const headers = ['1Z999AA10123456784', 'Ahmet Yılmaz', '12,50'];
    const aliases = headerAliases(headers);
    expect(unaliasHeader(headers, aliases, '#0')).toBe('1Z999AA10123456784');
    expect(unaliasHeader(headers, aliases, ' #2 ')).toBe('12,50');
    expect(unaliasHeader(headers, aliases, 'Net')).toBe('Net');
    expect(unaliasHeader(headers, aliases, null)).toBeNull();

    const pick = (header: string | null) => ({ header, confidence: header ? 0.9 : 0.5, reason: 'r' });
    const raw = {
      fields: Object.fromEntries(HEADER_FIELDS.map((f) => [f, pick(f === 'trackingNo' ? '#0' : f === 'netAmount' ? '#2' : null)])),
      chargePairs: [],
      chargeLabels: [],
      surchargeColumns: [],
      defaultDimUnit: null,
      defaultWeightUnit: null,
      numberFormat: 'tr',
      dateOrder: null,
      amountsIncludeVat: false,
      desiAsWeight: false,
    } as unknown as AiMappingRaw;
    const out = aiRawToMapping({ headers, rows: [] }, raw);
    expect(out.input.mapping.trackingNo).toBe('1Z999AA10123456784');
    expect(out.input.mapping.netAmount).toBe('12,50');
    expect(out.dropped).toEqual([]);
  });

  it('gerçek başlıklı dosyada hiçbir başlık gizlenmez (eski davranış)', () => {
    expect(headerAliases(['Tracking Number', 'Recipient Name', 'Net Charge', 'Ship Date', 'Currency'])).toEqual([null, null, null, null, null]);
  });
});

describe('Y45: güvenli başlıklı sütuna yazılmış kişi adı da maskelenir (değere bakılır)', () => {
  it('"Hizmet", "Ülke", "Service", "Charge Description" sütununda ad soyad maskeli gider', () => {
    expect(sent('Hizmet', 'Ahmet Yılmaz')).toBe('Aaaaa Aaaaaa');
    expect(sent('Ülke', 'Ayşe Kaya')).toBe('Aaaa Aaaa');
    expect(sent('Service', 'John Smith')).toBe('Aaaa Aaaaa');
    expect(sent('Charge Description', 'Mehmet Demir')).toBe('Aaaaaa Aaaaa');
    expect(sent('Recipient Country', 'Maria Rossi')).toBe('Aaaaa Aaaaa');
    // ad olarak da kullanılan sözcükler sözlükte yok
    expect(sent('Hizmet', 'Deniz Kara')).toBe('Aaaaa Aaaa');
    expect(sent('Ücret Etiketi', 'Kıymet Özel')).toBe('Aaaaaa Aaaa');
  });

  it('ülke, para birimi, hizmet ve ücret etiketleri aynen gider (eşleme kanıtı)', () => {
    for (const [h, v] of [
      ['Ülke', 'Almanya'],
      ['Ülke', 'Germany'],
      ['Country', 'United States'],
      ['Currency', 'Euro'],
      ['Hizmet', 'Yurtiçi Kargo Standart'],
      ['Service', 'FedEx International Economy'],
      ['Service', 'UPS Express Saver'],
      ['Product', 'Expressversand'],
      ['Charge Description', 'Residential Delivery'],
      ['Charge Description', 'Declared Value Charge'],
      ['Charge Description', 'Earned Discount'],
      ['Gebührenart', 'Inselzuschlag'],
      ['Ücret Etiketi', 'Kapıda Ödeme Bedeli'],
      ['Ücret Etiketi', 'Mobil Bölge'],
      ['Ship Date', '3 Kasım 2026'],
    ] as const) {
      expect(sent(h, v), `${h}: ${v}`).toBe(v);
    }
  });

  it('istemde güvenli başlıklı sütundaki ad geçmez; hizmet adı geçer', () => {
    const table = {
      headers: ['Tracking Number', 'Hizmet', 'Ülke', 'Net Charge'],
      rows: [
        ['794612345678', 'Ayse Kurgu', 'Mehmet Ornek', '120,50'],
        ['794612345679', 'International Priority', 'Almanya', '98,10'],
      ],
    };
    const text = buildMappingPrompt(table, { code: 'fedex', name: 'FedEx' });
    for (const leak of ['Kurgu', 'Ayse', 'Mehmet', 'Ornek']) expect(text).not.toContain(leak);
    expect(text).toContain('International Priority');
    expect(text).toContain('Almanya');
  });
});
