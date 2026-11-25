// Yeni denetim Mesaj 0: tarife taslağının kayda çevrilmesi (draft.ts). Okunamayan oran %0 kaydedilmez (10-B6), bölge adı
// değişince ülke eşlemesi sütununda kalır (10-B1), aynı bölge adı ve aynı ek ücret kaydı durdurur (10-B1, 02-B10),
// sunucuda değişen tarife açık taslağı ezmez (10-B17).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { before, describe, it } from 'node:test';

// draft.ts uzantısız içe aktarır (Vite çözer, düz Node çözmez): format-golden.test.ts ile aynı çözümleyici kancası.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const i18next = (await import('i18next')).default;
const D = await import('../src/pages/tariff-editor/draft.ts');
type Draft = ReturnType<typeof D.newDraft>;

const dict = (lang: string) => JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}/tariffEditor.json`, import.meta.url), 'utf8'));

before(async () => {
  await i18next.init({ lng: 'tr', fallbackLng: false, resources: { tr: { tariffEditor: dict('tr') }, en: { tariffEditor: dict('en') } }, interpolation: { escapeValue: false } });
});

/** Kaydedilebilir küçük taslak: A (DE), B (FR), * → A. */
function base(): Draft {
  const d = D.newDraft('cf', 'TRY');
  return {
    ...d,
    name: 'Deneme',
    zones: ['A', 'B'],
    rows: [{ upto: '1', prices: ['10', '20'], perKg: false }],
    overflow: ['', ''],
    countryZones: [
      { country: 'DE', zone: 0 },
      { country: 'FR', zone: 1 },
      { country: '*', zone: 0 },
    ],
  } as Draft;
}

const ok = (d: Draft) => {
  const r = D.toBody(d);
  assert.deepEqual(r.errors, []);
  return r.body!;
};
const fails = (d: Draft, text: RegExp) => {
  const r = D.toBody(d);
  assert.equal(r.body, null);
  assert.ok(r.errors.some((e) => text.test(e)), `beklenen hata yok: ${text} / ${JSON.stringify(r.errors)}`);
};

describe('okunamayan oran %0 kaydedilmez (10-B6)', () => {
  it('indirim: "12,5 (Ekim)" okunamaz, kayıt durur', () => fails({ ...base(), discountPct: '12,5 (Ekim)' }, /İndirim oranı okunamadı/));
  it('yakıt: "2o" (harf o) okunamaz, kayıt durur', () => fails({ ...base(), fuelPct: '2o' }, /Yakıt oranı okunamadı/));
  it('basamak sınırı: "2O" okunamaz, "sınırsız" sayılmaz', () => fails({ ...base(), steps: [{ upto: '2O', step: '0,5' }, { upto: '', step: '1' }] }, /Ağırlık basamaklarını kontrol edin/));
  it('boş indirim/yakıt %0, "%25" ve "25" okunur, boş sınır sınırsız', () => {
    assert.equal(ok({ ...base(), discountPct: '', fuelPct: '' }).discountPct, 0);
    const b = ok({ ...base(), discountPct: '%25', fuelPct: '12,5' });
    assert.equal(b.discountPct, 25);
    assert.equal(b.fuelPct, 12.5);
    assert.deepEqual(ok(base()).weightSteps, [
      { upto: 20, step: 0.5 },
      { upto: null, step: 1 },
    ]);
  });
  it('alan durumu: dolu ve okunamayan ya da aralık dışı değer işaretlenir', () => {
    assert.equal(D.pctFieldState('2o'), 'unreadable');
    assert.equal(D.pctFieldState('120'), 'range');
    assert.equal(D.pctFieldState(''), null);
    assert.equal(D.pctFieldState('%25'), null);
  });
});

describe('bölge adı değişince ülke eşlemesi sütununda kalır (10-B1)', () => {
  const zonesOf = (d: Draft) => D.toBody(d).body!.zones.map((z) => `${z.country}>${z.zone}`);
  it('B harf harf "A2" olur (ara adım "", "A"): A ülkeleri A da kalır', () => {
    let d = base();
    for (const v of ['', 'A', 'A2']) d = D.renameZone(d, 1, v);
    assert.deepEqual(d.zones, ['A', 'A2']);
    assert.deepEqual(zonesOf(d), ['DE>A', 'FR>A2', '*>A']);
  });
  it('A sütunu "B" yapılırken ara adımda B ile çakışsa da B ülkeleri yerinde kalır', () => {
    let d = base();
    for (const v of ['B', 'BX']) d = D.renameZone(d, 0, v);
    assert.deepEqual(zonesOf(d), ['DE>BX', 'FR>B', '*>BX']);
  });
  it('aynı ad (büyük/küçük harf, "Zone" öneki dahil) kaydı durdurur ve adı söyler', () => {
    fails(D.renameZone(base(), 1, 'a'), /“a” bölge adı iki kez kullanılmış/);
    fails(D.renameZone(base(), 1, 'Zone A'), /bölge adı iki kez kullanılmış/);
    assert.deepEqual(D.duplicateZoneColumns(['A', 'a', 'B']), [1]);
    assert.deepEqual(D.duplicateZoneColumns(['A', 'B']), []);
  });
  it('bölge silinince o bölgenin ülkeleri gider, sağdaki sütunların ülkeleri kaymaz', () => {
    let d = { ...base(), zones: ['A', 'B', 'C'], rows: [{ upto: '1', prices: ['10', '20', '30'], perKg: false }], overflow: ['', '', ''], countryZones: [{ country: 'DE', zone: 0 }, { country: 'FR', zone: 1 }, { country: 'US', zone: 2 }] } as Draft;
    d = D.removeZone(d, 1);
    assert.deepEqual(d.zones, ['A', 'C']);
    assert.deepEqual(zonesOf(d), ['DE>A', 'US>C']);
  });
  it('başlık yapıştırma ada göre eşler: sıra değişse de ülke kendi bölgesinin sütununa gider, olmayan ad işaretlenir', () => {
    const d = D.pasteBlock(base(), 0, 0, 'B\tC\n5\t6\n', true)!;
    assert.deepEqual(d.zones, ['B', 'C']);
    // FR B'deydi → B sütunu (0); A artık yok → eşleme bilinmiyor, kayıt durur
    assert.deepEqual(d.countryZones, [{ country: 'DE', zone: -1 }, { country: 'FR', zone: 0 }, { country: '*', zone: -1 }]);
    fails(d, /Bölge eşlemesinde tabloda olmayan bir bölge var/);
  });
  it('sunucudaki tarife taslağa sütun sırasıyla gelir; "Zone A" ile "A" tek sütun', () => {
    const d = D.fromTariff({
      ...ok(base()),
      id: 't',
      zones: [{ country: 'DE', zone: 'Zone A' }, { country: 'FR', zone: 'B' }],
      rates: [{ zone: 'A', weightUpto: 1, price: 10 }, { zone: 'B', weightUpto: 1, price: 20 }],
    });
    assert.deepEqual(d.zones, ['A', 'B']);
    assert.deepEqual(d.countryZones, [{ country: 'DE', zone: 0 }, { country: 'FR', zone: 1 }]);
  });
});

describe('aç-kaydet tarifeyi değiştirmez (gidiş-dönüş)', () => {
  // Sunucunun GET yanıtı biçiminde (serializeTariffFull: ülkeler ülkeye, fiyatlar bölge + ağırlığa göre sıralı).
  const server = () => ({
    id: 't',
    updatedAt: '2026-11-01T10:00:00.123Z',
    carrierId: 'cf',
    name: 'FedEx IE 2026',
    service: 'IE',
    currency: 'USD',
    divisor: 5000,
    edgeRounding: 'CEIL_CM' as const,
    weightSteps: [{ upto: 20, step: 0.5 }, { upto: null, step: 1 }],
    discountPct: 12.5,
    fuelPct: 27.25,
    fuelVariable: true,
    validFrom: '2026-01-01',
    validTo: null,
    active: true,
    isDefault: true,
    zones: [{ country: '*', zone: 'C' }, { country: 'DE', zone: 'A' }, { country: 'FR', zone: 'B' }, { country: 'US', zone: 'C' }],
    rates: [
      { zone: 'A', weightUpto: 0.5, price: 1234.56, perKg: false },
      { zone: 'A', weightUpto: 1.234, price: 10, perKg: false },
      { zone: 'A', weightUpto: 71, price: 7.27, perKg: true },
      { zone: 'B', weightUpto: 0.5, price: 20.5, perKg: false },
      { zone: 'B', weightUpto: 71, price: 8.1, perKg: true },
      { zone: 'C', weightUpto: 1.234, price: 30, perKg: false },
      { zone: 'C', weightUpto: 71, price: 9, perKg: true },
    ],
    overflow: [{ zone: 'A', perUnit: 1.5 }, { zone: 'C', perUnit: 2.25 }],
    surcharges: [{ code: 'RES', name: 'Konut', kind: 'FIXED' as const, amount: 95 }, { code: 'ODA', name: 'Uzak bölge', kind: 'PER_KG' as const, amount: 0.45 }],
    countryAdjustments: [{ country: 'DE', pct: -15.45, note: 'sözleşme', source: 'manual' as const, invoiceId: null }],
  });
  /** sıradan bağımsız karşılaştırma (sunucu sıralar, hesap sıraya bakmaz); perKg yok = false */
  const canon = (b: ReturnType<typeof server> | NonNullable<ReturnType<typeof D.toBody>['body']>) => ({
    ...b,
    id: undefined,
    updatedAt: undefined,
    zones: [...b.zones].sort((x, y) => x.country.localeCompare(y.country)),
    rates: [...b.rates].map((r) => ({ ...r, perKg: r.perKg === true })).sort((x, y) => x.zone.localeCompare(y.zone) || x.weightUpto - y.weightUpto),
    overflow: [...b.overflow].sort((x, y) => x.zone.localeCompare(y.zone)),
  });
  for (const lang of ['tr', 'en']) {
    it(`${lang} arayüz: sunucudaki tarife açılıp değiştirilmeden kayda çevrilince aynı gövde çıkar`, async () => {
      const F = await import('../src/lib/format.ts');
      F.setFormatLocale(lang);
      try {
        const t = server();
        const body = ok(D.fromTariff(t));
        assert.deepEqual(canon(body), canon(t));
      } finally {
        F.setFormatLocale('tr');
      }
    });
  }
  it('ülke eşlemesi sütuna göre gelir ve aynı bölge adıyla geri yazılır', () => {
    const d = D.fromTariff(server());
    assert.deepEqual(d.zones, ['A', 'B', 'C']);
    assert.deepEqual(d.countryZones, [{ country: '*', zone: 2 }, { country: 'DE', zone: 0 }, { country: 'FR', zone: 1 }, { country: 'US', zone: 2 }]);
  });
});

describe('sütun işlemleri ülke eşlemesini kaydırmaz (10-B1)', () => {
  const zonesOf = (d: Draft) => D.toBody(d).body!.zones.map((z) => `${z.country}>${z.zone}`);
  it('başlıkta sütunların yeri değişirse ülke kendi bölgesinin yeni sütununa gider', () => {
    const d = D.pasteBlock(base(), 0, 0, 'B\tA\n20\t10\n', true)!;
    assert.deepEqual(d.zones, ['B', 'A']);
    assert.deepEqual(zonesOf(d), ['DE>A', 'FR>B', '*>A']);
  });
  it('başlıksız yapıştırma sağa sütun eklese de eşleme yerinde kalır', () => {
    const d = D.pasteBlock(base(), 0, 0, '10\t20\t30\n', false)!;
    assert.deepEqual(d.zones, ['A', 'B', 'C']);
    assert.deepEqual(d.countryZones, base().countryZones);
  });
  it('ilk sütun silinince sağdaki sütunun ülkeleri onunla birlikte kayar', () => {
    const d = D.removeZone(base(), 0);
    assert.deepEqual(d.zones, ['B']);
    assert.deepEqual(zonesOf(d), ['FR>B']);
  });
  it('yeni sütun adı var olan bölgeyle (büyük/küçük harf ya da "Zone" öneki) çakışmaz', () => {
    assert.equal(D.nextZoneName(['a']), 'B');
    assert.equal(D.nextZoneName(['Zone A', 'b']), 'C');
    assert.equal(D.nextZoneName(['A', 'B']), 'C');
  });
});

describe('aynı ek ücret iki kez girilmez (02-B10)', () => {
  it('aynı kod (büyük/küçük harf ve eş anlamlı kod dahil) kaydı durdurur', () => {
    const s = (code: string) => ({ code, name: '', kind: 'FIXED' as const, amount: '10' });
    fails({ ...base(), surcharges: [s('RES'), s('res')] }, /RES ek ücreti iki kez girilmiş/);
    assert.equal(ok({ ...base(), surcharges: [s('RES'), s('ODA')] }).surcharges.length, 2);
  });
});

describe('sunucudaki değişiklik açık taslağı ezmez (10-B17)', () => {
  const t = (updatedAt?: string) => ({ ...ok(base()), id: 't', ...(updatedAt ? { updatedAt } : {}) });
  it('taslak temizse yeni hâl yüklenir', () => assert.equal(D.incomingTariff({ dirty: false, baseUpdatedAt: 'x' }, t('y')), 'load'));
  it('taslakta değişiklik varken başka sürüm gelirse yüklenmez, bant çıkar', () => assert.equal(D.incomingTariff({ dirty: true, baseUpdatedAt: '1' }, t('2')), 'remote'));
  it('taslakta değişiklik varken aynı sürüm gelirse dokunulmaz', () => assert.equal(D.incomingTariff({ dirty: true, baseUpdatedAt: '1' }, t('1')), 'keep'));
  it('sürüm bilgisi yoksa (eski API) bugünkü gibi davranılır ama taslak ezilmez', () => assert.equal(D.incomingTariff({ dirty: true, baseUpdatedAt: undefined }, t()), 'keep'));
});

describe('poşet (Pak) ve zarf fiyatları koli tablosundan ayrı durur', () => {
  const tariff = () => ({
    ...ok(base()),
    id: 't',
    pakDiscountPct: 10,
    envelopeDiscountPct: null,
    rates: [
      { zone: 'A', weightUpto: 1, price: 10, packaging: 'OWN' as const },
      { zone: 'B', weightUpto: 1, price: 20, packaging: 'OWN' as const },
      { zone: 'A', weightUpto: 1, price: 7, packaging: 'PAK' as const },
      { zone: 'B', weightUpto: 1, price: 8, packaging: 'PAK' as const },
      { zone: 'A', weightUpto: 99999, price: 5, packaging: 'ENVELOPE' as const },
    ],
  });
  it('aynı bölge + ağırlıktaki Pak fiyatı koli tablosuna karışmaz, kayıtta ambalajıyla geri yazılır', () => {
    const d = D.fromTariff(tariff());
    assert.deepEqual(d.rows.map((r) => r.prices), [['10', '20']]);
    assert.deepEqual(d.packRows.map((r) => [r.packaging, r.upto, r.prices]), [['PAK', '1', ['7', '8']], ['ENVELOPE', '', ['5', '']]]);
    const b = ok(d);
    assert.deepEqual(b.rates.filter((r) => r.packaging).map((r) => `${r.packaging}|${r.zone}|${r.weightUpto}|${r.price}`), ['PAK|A|1|7', 'PAK|B|1|8', 'ENVELOPE|A|99999|5']);
    assert.equal(b.rates.filter((r) => !r.packaging).length, 2);
    assert.equal(b.pakDiscountPct, 10);
    assert.equal('envelopeDiscountPct' in b, false);
  });
  it('boşaltılan indirim null (tarifenin indirimi) gider; okunamayan indirim kaydı durdurur', () => {
    assert.equal(ok({ ...D.fromTariff(tariff()), pakDiscountPct: '' }).pakDiscountPct, null);
    fails({ ...D.fromTariff(tariff()), pakDiscountPct: '1o' }, /indirimi okunamadı/);
  });
  it('aynı ambalajda aynı ağırlık iki kez girilmez', () => {
    const d = D.fromTariff(tariff());
    fails({ ...d, packRows: [...d.packRows, { packaging: 'PAK', upto: '1', prices: ['9', ''] }] }, /iki kez girilmiş/);
  });
  it('bölge sütunu silinince poşet fiyatları da o sütunu bırakır', () => {
    assert.deepEqual(D.removeZone(D.fromTariff(tariff()), 0).packRows.map((r) => r.prices), [['8'], ['']]);
  });
});
