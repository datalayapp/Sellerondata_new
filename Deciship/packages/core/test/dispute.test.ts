import { describe, expect, it } from 'vitest';
import { buildDisputeText, chargeableUnitOf, disputeVatPct, packagingLimitsFor, withVat, type DisputeLine } from '../src/index';

const lines: DisputeLine[] = [
  {
    trackingNo: '794812345305',
    shipDate: '2026-10-22',
    diffTypes: ['DIMENSION'],
    decision: 'VERIFIED',
    ourDims: { l: 40, w: 30, h: 25 },
    ourActualKg: 4,
    ourChargeableKg: 6,
    billedDims: { l: 45, w: 35, h: 30 },
    billedChargeableKg: 9.5,
    expectedAmount: 1184,
    billedAmount: 1642.5,
    diffAmount: 458.5,
  },
  { trackingNo: '794812345288', diffTypes: ['DUPLICATE'], decision: 'VERIFIED', ourChargeableKg: null, billedChargeableKg: 5.5, expectedAmount: null, billedAmount: 1120, diffAmount: 1120 },
  { trackingNo: '794812345290', diffTypes: ['PRICE'], decision: 'OPEN', ourChargeableKg: 15, billedChargeableKg: 15, expectedAmount: 2815, billedAmount: 2871.3, diffAmount: 56.3 },
  {
    trackingNo: '794812345293',
    diffTypes: ['SURCHARGE'],
    decision: 'VERIFIED',
    ourChargeableKg: 4.5,
    billedChargeableKg: 4.5,
    expectedAmount: 965.84,
    billedAmount: 1377.84,
    diffAmount: 412,
    surcharges: [{ code: 'ADDRESS_CORRECTION', name: 'Address Correction', amount: 412 }],
  },
];

const base = {
  company: { name: 'Demo İhracat', contactName: 'Elif Kaya', email: 'elif@demo.com' },
  carrier: { name: 'FedEx', accountNo: '123456789' },
  invoice: { invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY' },
  lines,
};

describe('buildDisputeText', () => {
  it('TR: yalnız VERIFIED satırlar, toplam, ölçüler ve tutarlar', () => {
    const r = buildDisputeText({ ...base, lang: 'tr' });
    expect(r.lineCount).toBe(3);
    expect(r.total).toBe(1990.5);
    expect(r.subject).toBe('Fatura itirazı — FedEx 9-482-11735 (3 gönderi, 1.990,50 ₺)');
    expect(r.body).toContain('Sayın FedEx Faturalandırma Ekibi');
    expect(r.body).toContain('27.10.2026 tarihli 9-482-11735');
    expect(r.body).toContain('Takip numarası 794812345305 (22.10.2026) — Ölçü farkı');
    expect(r.body).toContain('Bizim ölçümümüz: 40×30×25 cm, 4,0 kg, ücretli 6,0 kg');
    expect(r.body).toContain('Faturalanan: 45×35×30 cm, ücretli 9,5 kg');
    expect(r.body).toContain('Beklenen tutar: 1.184,00 ₺ · Faturalanan tutar: 1.642,50 ₺');
    expect(r.body).toContain('Talep edilen düzeltme: 458,50 ₺');
    expect(r.body).toContain('Mükerrer faturalama');
    expect(r.body).toContain('1.120,00 ₺ (tamamının iptali)');
    expect(r.body).toContain('Address Correction 412,00 ₺');
    expect(r.body).toContain('Toplam talep edilen düzeltme: 1.990,50 ₺');
    expect(r.body).not.toContain('794812345290');
    expect(r.body).toMatch(/Saygılarımızla,\nElif Kaya\nDemo İhracat\nE-posta: elif@demo.com$/);
  });

  // KALANLAR 1.12: yurt içinde ücretli ağırlık desidir; gerçek ağırlık kg kalır. Verilmezse bugünkü metin (kg).
  // Bağımsız inceleme: ücretli ağırlık desi ile gerçek kg'ın büyüğüdür; birim kaynağa göre, her taraf ayrı.
  it('desi birimi: hacimsel desi belirlediyse "desi", gerçek kg büyükse "kg", bilinmiyorsa "desi/kg" (TR ve EN)', () => {
    const inv = { ...base.invoice, chargeUnit: 'desi' as const, divisor: 3000 };
    const tr = buildDisputeText({ ...base, invoice: inv, lang: 'tr' }).body;
    // 40×30×25 / 3000 = 10 desi > 4 kg
    expect(tr).toContain('Bizim ölçümümüz: 40×30×25 cm, 4,0 kg, ücretli 6,0 desi');
    // faturada gerçek ağırlık yok: kaynak bilinmez
    expect(tr).toContain('Faturalanan: 45×35×30 cm, ücretli 9,5 desi/kg');
    // ölçü yok
    expect(tr).toContain('Bizim ölçümümüz: ücretli 4,5 desi/kg');
    expect(tr).not.toContain('ücretli 6,0 kg');
    const en = buildDisputeText({ ...base, invoice: inv, lang: 'en' }).body;
    expect(en).toContain('Our measurement: 40 x 30 x 25 cm, 4.0 kg, chargeable 6.0 desi');
    expect(en).toContain('Billed: 45 x 35 x 30 cm, chargeable 9.5 desi/kg');
    // 20×20×20 cm, 10 kg: desi 2,67, gerçek ağırlık belirler → kg (iki taraf ayrı)
    const heavy: DisputeLine = {
      trackingNo: 'H1',
      diffTypes: ['WEIGHT'],
      decision: 'VERIFIED',
      ourDims: { l: 20, w: 20, h: 20 },
      ourActualKg: 10,
      ourChargeableKg: 10,
      billedDims: { l: 60, w: 50, h: 40 },
      billedActualKg: 10,
      billedChargeableKg: 40,
      expectedAmount: 100,
      billedAmount: 400,
      diffAmount: 300,
    };
    const h = buildDisputeText({ ...base, lines: [heavy], invoice: inv, lang: 'tr' }).body;
    expect(h).toContain('Bizim ölçümümüz: 20×20×20 cm, 10,0 kg, ücretli 10,0 kg');
    expect(h).toContain('Faturalanan: 60×50×40 cm, 10,0 kg, ücretli 40,0 desi');
    // bölen yoksa kaynak bilinmez
    expect(buildDisputeText({ ...base, lines: [heavy], invoice: { ...inv, divisor: null }, lang: 'tr' }).body).toContain('ücretli 10,0 desi/kg');
    expect(chargeableUnitOf({ l: 20, w: 20, h: 20 }, 10, 3000)).toBe('kg');
    expect(chargeableUnitOf({ l: 40, w: 30, h: 30 }, 3, 3000)).toBe('desi');
    expect(chargeableUnitOf({ l: 30, w: 10, h: 10 }, 1, 3000)).toBe('desi'); // eşitlik: desi
    expect(chargeableUnitOf(null, 3, 3000)).toBe('desi/kg');
    expect(chargeableUnitOf({ l: 40, w: 30, h: 30 }, null, 3000)).toBe('desi/kg');
    const kg = buildDisputeText({ ...base, invoice: { ...base.invoice, chargeUnit: 'kg' }, lang: 'tr' }).body;
    expect(kg).toBe(buildDisputeText({ ...base, lang: 'tr' }).body);
  });

  it('imza: e-posta ve telefon etiketli; Türkiye cep numarası gruplu; olmayan ya da boş alan yazılmaz', () => {
    const sign = (company: Parameters<typeof buildDisputeText>[0]['company'], lang: 'tr' | 'en' = 'tr') =>
      buildDisputeText({ ...base, company, lang }).body.split('\n').slice(-5).join('\n');
    expect(sign({ name: 'Demo İhracat', contactName: 'Elif Kaya', email: 'elif@demo.com', phone: '+905321234567' })).toBe(
      'Saygılarımızla,\nElif Kaya\nDemo İhracat\nE-posta: elif@demo.com\nTel: +90 532 123 45 67',
    );
    expect(sign({ name: 'Demo Export', contactName: 'Elif Kaya', email: 'elif@demo.com', phone: '+905321234567' }, 'en')).toBe(
      'Kind regards,\nElif Kaya\nDemo Export\nEmail: elif@demo.com\nPhone: +90 532 123 45 67',
    );
    // yalnız telefon; başka ülke numarası olduğu gibi
    expect(sign({ name: 'Demo İhracat', contactName: 'Elif Kaya', phone: '+4915112345678' })).toMatch(/Demo İhracat\nTel: \+4915112345678$/);
    // ikisi de yok ya da boşluk: imza yalnız ad ve firma
    expect(buildDisputeText({ ...base, company: { name: 'Demo İhracat', contactName: 'Elif Kaya', email: '  ', phone: '' }, lang: 'tr' }).body).toMatch(
      /Saygılarımızla,\nElif Kaya\nDemo İhracat$/,
    );
  });

  it('EN', () => {
    const r = buildDisputeText({ ...base, lang: 'en' });
    expect(r.subject).toBe('Invoice dispute — FedEx 9-482-11735 (3 shipments, 1,990.50 TRY)');
    expect(r.body).toContain('Dear FedEx Billing Team');
    expect(r.body).toContain('Our measurement: 40 x 30 x 25 cm, 4.0 kg, chargeable 6.0 kg');
    expect(r.body).toContain('Requested correction: 458.50 TRY');
    expect(r.body).toContain('Total requested correction: 1,990.50 TRY');
    expect(r.body).toContain('(account 123456789)');
  });

  // Denetim 01-B9, karar (a): tutarlar KDV hariç saklanır ve öyle yazılır; metin bunu söyler (taşıyıcı kendi faturasıyla eşlesin).
  it('tutarların KDV hariç olduğunu yazar (TR ve EN)', () => {
    const tr = buildDisputeText({ ...base, lang: 'tr' }).body;
    expect(tr).toContain('Beklenen tutar: 1.184,00 ₺ · Faturalanan tutar: 1.642,50 ₺ (KDV hariç)');
    expect(tr).toContain('Bu gönderi daha önce faturalanmıştır. Faturalanan: 1.120,00 ₺ (KDV hariç)');
    expect(tr).toContain('Toplam talep edilen düzeltme: 1.990,50 ₺ (KDV hariç)');
    const en = buildDisputeText({ ...base, lang: 'en' }).body;
    expect(en).toContain('Expected amount: 1,184.00 TRY · Billed amount: 1,642.50 TRY (excl. VAT)');
    expect(en).toContain('This shipment has already been billed. Billed: 1,120.00 TRY (excl. VAT)');
    expect(en).toContain('Total requested correction: 1,990.50 TRY (excl. VAT)');
  });

  // K43 (rapor 01-B9 seçenek b): faturanın KDV oranı biliniyorsa satırda faturalanan tutar ve toplam talep KDV dahil
  // hâliyle de yazılır; taşıyıcı kendi (KDV dahil) faturasıyla eşleştirebilsin. Oran yoksa metin yalnız KDV hariç kalır.
  it('KDV oranı biliniyorsa KDV hariç ve KDV dahil tutar birlikte (TR ve EN)', () => {
    const inv = { ...base.invoice, vatPct: 20 };
    const r = buildDisputeText({ ...base, invoice: inv, lang: 'tr' });
    // 1.642,50 × 1,2 = 1.971,00; 1.120,00 × 1,2 = 1.344,00; toplam 1.990,50 × 1,2 = 2.388,60
    expect(r.body).toContain('Beklenen tutar: 1.184,00 ₺ · Faturalanan tutar: 1.642,50 ₺ (KDV hariç) · KDV dahil (%20): 1.971,00 ₺');
    expect(r.body).toContain('Bu gönderi daha önce faturalanmıştır. Faturalanan: 1.120,00 ₺ (KDV hariç) · KDV dahil (%20): 1.344,00 ₺');
    expect(r.body).toContain('Toplam talep edilen düzeltme: KDV hariç 1.990,50 ₺, KDV dahil (%20) 2.388,60 ₺');
    // talep tutarı (KDV hariç) değişmez: gönderilen tur ve "İtiraz listesinde" toplamı aynı kalır
    expect(r.total).toBe(1990.5);
    expect(r.body).toContain('Talep edilen düzeltme: 458,50 ₺' + String.fromCharCode(10));
    const en = buildDisputeText({ ...base, invoice: inv, lang: 'en' }).body;
    expect(en).toContain('Billed amount: 1,642.50 TRY (excl. VAT) · incl. VAT (20%): 1,971.00 TRY');
    expect(en).toContain('Billed: 1,120.00 TRY (excl. VAT) · incl. VAT (20%): 1,344.00 TRY');
    expect(en).toContain('Total requested correction: 1,990.50 TRY excl. VAT, 2,388.60 TRY incl. VAT (20%)');
  });

  it('oran yoksa, 0 ya da geçersizse yalnız KDV hariç (bugünkü metin)', () => {
    for (const vatPct of [undefined, null, 0, -5, Number.NaN, 150]) {
      const body = buildDisputeText({ ...base, invoice: { ...base.invoice, vatPct }, lang: 'tr' }).body;
      expect(body).not.toContain('KDV dahil');
      expect(body).toContain('Toplam talep edilen düzeltme: 1.990,50 ₺ (KDV hariç)');
    }
    expect(disputeVatPct(20)).toBe(20);
    expect(disputeVatPct(0)).toBeNull();
  });

  it('KDV dahil tutar kuruşa yarım-yukarı; toplamınki toplamdan (satırların yuvarlanmış toplamı değil)', () => {
    expect(withVat(100.01, 20)).toBe(120.01); // 120,012
    expect(withVat(110.81, 20)).toBe(132.97); // denetimdeki Aras satırı: 132,972
    expect(withVat(0.05, 10)).toBe(0.06); // 0,055 → yarım yukarı
    expect(withVat(1.25, 18)).toBe(1.48); // 1,475 → yarım yukarı
    expect(withVat(83.34, 20)).toBe(100.01); // 100,008
    expect(withVat(0, 20)).toBe(0);
    expect(withVat(10.5, 1.5)).toBe(10.66); // ondalık oran: 10,6575
    // iki satır 0,03 + 0,03: satır başına 0,04 + 0,04 = 0,08 olurdu; toplamdan 0,06 × 1,2 = 0,072 → 0,07
    const two: DisputeLine[] = ['A1', 'A2'].map((trackingNo) => ({ trackingNo, diffTypes: ['PRICE'], decision: 'VERIFIED', ourChargeableKg: 1, billedChargeableKg: 1, expectedAmount: 1, billedAmount: 1.03, diffAmount: 0.03 }));
    const body = buildDisputeText({ ...base, lines: two, invoice: { ...base.invoice, vatPct: 20 }, lang: 'tr' }).body;
    expect(body).toContain('Toplam talep edilen düzeltme: KDV hariç 0,06 ₺, KDV dahil (%20) 0,07 ₺');
    expect(body).toContain('Faturalanan tutar: 1,03 ₺ (KDV hariç) · KDV dahil (%20): 1,24 ₺'); // 1,236
  });

  it('karar alanı olmayan satırlar (çağıran süzmüş) dahil edilir', () => {
    const r = buildDisputeText({ ...base, lines: [{ ...lines[0]!, decision: undefined }], lang: 'tr' });
    expect(r.lineCount).toBe(1);
    expect(r.subject).toContain('1 gönderi');
  });
});

describe('ambalaj farkı (PACKAGING) anlatımı', () => {
  const pak: DisputeLine = {
    trackingNo: '794812345400',
    diffTypes: ['PACKAGING'],
    decision: 'VERIFIED',
    ourDims: { l: 30, w: 20, h: 3 },
    ourActualKg: 0.8,
    ourChargeableKg: 1,
    billedChargeableKg: 1,
    expectedAmount: 420,
    billedAmount: 561.51,
    diffAmount: 141.51,
    ourPackaging: 'PAK',
    billedPackaging: 'OWN',
    pricedPackaging: 'PAK',
  };
  const input = (l: DisputeLine, lang: 'tr' | 'en', limits = packagingLimitsFor('fedex')) => ({
    ...base,
    carrier: { name: 'FedEx', code: 'fedex' },
    lines: [l],
    lang,
    packagingLimits: limits,
  });

  it('TR: ambalaj, sınır, faturadaki fiyatlama', () => {
    const r = buildDisputeText(input(pak, 'tr'));
    expect(r.total).toBe(141.51);
    expect(r.body).toContain('Takip numarası 794812345400 — Ambalaj farkı');
    expect(r.body).toContain('   Gönderi FedEx Pak ile gönderildi (0,8 kg, 30×20×3 cm; sınır içinde: en çok 2,5 kg, 15.400 cm³).\n   Faturada kendi ambalajı olarak fiyatlanmış; beklenen tutar FedEx Pak fiyatıdır.');
    expect(r.body).toContain('Beklenen tutar: 420,00 ₺ · Faturalanan tutar: 561,51 ₺');
  });

  it('EN ve zarf → Pak', () => {
    const env: DisputeLine = { ...pak, ourPackaging: 'ENVELOPE' };
    const r = buildDisputeText(input(env, 'en'));
    expect(r.body).toContain('Tracking number 794812345400 — Packaging discrepancy');
    expect(r.body).toContain(
      '   The shipment was sent in a FedEx Envelope (0.8 kg, 30 x 20 x 3 cm); as it exceeds the envelope limit, the FedEx Pak rate applies (within the limits: max 2.5 kg, 15,400 cm³).',
    );
    expect(r.body).toContain('   The invoice prices it as own packaging; the expected amount is the FedEx Pak rate.');
  });

  it('Zarf: ağırlık ve kenar sınırı', () => {
    const env: DisputeLine = { ...pak, ourPackaging: 'ENVELOPE', pricedPackaging: 'ENVELOPE', ourActualKg: 0.3, ourDims: { l: 30, w: 22, h: 1 } };
    expect(buildDisputeText(input(env, 'tr')).body).toContain('   Gönderi FedEx Zarf ile gönderildi (0,3 kg, 30×22×1 cm; sınır içinde: en çok 0,5 kg, 31,7×24,1×2 cm).');
    expect(buildDisputeText(input(env, 'en')).body).toContain('   The shipment was sent in a FedEx Envelope (0.3 kg, 30 x 22 x 1 cm; within the limits: max 0.5 kg, 31.7 x 24.1 x 2 cm).');
  });

  it('sınır bilinmiyor ya da faturada ambalaj yok; başka taşıyıcının adı', () => {
    const r = buildDisputeText({ ...input({ ...pak, billedPackaging: null }, 'tr', packagingLimitsFor('ups')), carrier: { name: 'UPS', code: 'ups' } });
    expect(r.body).toContain('   Gönderi UPS Express Pak ile gönderildi (0,8 kg, 30×20×3 cm).');
    expect(r.body).toContain('   Faturada ambalaj belirtilmemiş ve tutar UPS Express Pak fiyatını aşıyor; beklenen tutar UPS Express Pak fiyatıdır.');
  });

  it('ambalajı kendi ambalajı olan ya da PACKAGING olmayan satırda yazılmaz', () => {
    expect(buildDisputeText(input({ ...pak, ourPackaging: 'OWN' }, 'tr')).body).not.toContain('ile gönderildi');
    expect(buildDisputeText(input({ ...pak, diffTypes: ['PRICE'] }, 'tr')).body).not.toContain('ile gönderildi');
  });
});
