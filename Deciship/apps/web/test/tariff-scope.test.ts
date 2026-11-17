// KALANLAR 1.1: yeni tarifenin kapsamı (draft.ts). Yurt içi taşıyıcı (Aras, Yurtiçi, MNG, PTT, "Diğer" adla Sürat, HepsiJet…)
// 3000 bölen ve sabit yakıtla, yurt dışı (FedEx, UPS, DHL, "Diğer" adla TNT, Aramex…) 5000 ve değişken yakıtla başlar.
// Kapsam seçimi PTT ve "Diğer"de görünür; kişinin elle değiştirdiği bölen/yakıt taşıyıcı değişince ezilmez.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { before, describe, it } from 'node:test';

// draft.ts uzantısız içe aktarır (Vite çözer, düz Node çözmez): tariff-draft.test.ts ile aynı çözümleyici kancası.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const i18next = (await import('i18next')).default;
const D = await import('../src/pages/tariff-editor/draft.ts');

const dict = (lang: string) => JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}/tariffEditor.json`, import.meta.url), 'utf8'));

before(async () => {
  await i18next.init({ lng: 'tr', fallbackLng: false, resources: { tr: { tariffEditor: dict('tr') }, en: { tariffEditor: dict('en') } }, interpolation: { escapeValue: false } });
});

const ARAS = { id: 'c-aras', code: 'aras', name: 'Aras Kargo' };
const FEDEX = { id: 'c-fedex', code: 'fedex', name: 'FedEx' };
const PTT = { id: 'c-ptt', code: 'ptt', name: 'PTT Kargo' };
const SURAT = { id: 'c-surat', code: 'generic', name: 'Sürat Kargo' };
const TNT = { id: 'c-tnt', code: 'generic', name: 'TNT Express' };

describe('yeni tarifenin bölen ve yakıt varsayılanı', () => {
  it('taşıyıcı yüklenince kapsamı yazılır: yurt içi 3000 + sabit, yurt dışı 5000 + değişken', () => {
    const d = D.newDraft('', 'TRY');
    assert.equal(d.scope, undefined);
    for (const [c, divisor, fuel, scope] of [
      [ARAS, '3000', false, 'domestic'],
      [PTT, '3000', false, 'domestic'],
      [SURAT, '3000', false, 'domestic'],
      [FEDEX, '5000', true, 'international'],
      [TNT, '5000', true, 'international'],
    ] as const) {
      const x = D.withCarrier(d, c);
      assert.deepEqual([x.carrierId, x.divisor, x.fuelVariable, x.scope], [c.id, divisor, fuel, scope], c.name);
    }
  });

  it('kayıt gövdesine bölen ve yakıt gider, kapsam gitmez', () => {
    const d = {
      ...D.withCarrier(D.newDraft('', 'TRY'), SURAT),
      name: 'Sürat 2026',
      zones: ['TR'],
      rows: [{ upto: '1', prices: ['60'], perKg: false }],
      overflow: [''],
      countryZones: [{ country: '*', zone: 0 }],
    };
    const r = D.toBody(d);
    assert.deepEqual(r.errors, []);
    assert.equal(r.body!.divisor, 3000);
    assert.equal(r.body!.fuelVariable, false);
    assert.equal('scope' in r.body!, false);
  });

  it('kişi kapsamı seçer: PTT yurt dışı → 5000 + değişken; geri yurt içi → 3000 + sabit', () => {
    const d = D.withCarrier(D.newDraft('', 'TRY'), PTT);
    const intl = D.applyScope(d, 'international');
    assert.deepEqual([intl.scope, intl.divisor, intl.fuelVariable], ['international', '5000', true]);
    const back = D.applyScope(intl, 'domestic');
    assert.deepEqual([back.scope, back.divisor, back.fuelVariable], ['domestic', '3000', false]);
  });

  it('taşıyıcı değişince kapsam izlenir; elle yazılmış bölen ya da yakıt korunur', () => {
    const aras = D.withCarrier(D.newDraft('', 'TRY'), ARAS);
    const fedex = D.withCarrier(aras, FEDEX);
    assert.deepEqual([fedex.divisor, fedex.fuelVariable, fedex.scope], ['5000', true, 'international']);
    const custom = D.withCarrier({ ...aras, divisor: '4000' }, FEDEX);
    assert.deepEqual([custom.carrierId, custom.divisor, custom.fuelVariable], [FEDEX.id, '4000', false]);
    const fuelPicked = D.withCarrier({ ...aras, fuelVariable: true }, SURAT);
    assert.deepEqual([fuelPicked.divisor, fuelPicked.fuelVariable], ['3000', true]);
  });

  it('kapsam seçimi yalnız PTT ve "Diğer"de; yakıt varsayılanı adla', () => {
    assert.deepEqual(['ptt', 'generic', 'aras', 'fedex', undefined].map(D.scopeChoosable), [true, true, false, false, false]);
    assert.equal(D.defaultFuelVariable(PTT), false);
    assert.equal(D.defaultFuelVariable(SURAT), false);
    assert.equal(D.defaultFuelVariable(TNT), true);
    assert.equal(D.defaultFuelVariable(FEDEX), true);
    assert.equal(D.defaultFuelVariable(undefined), undefined);
  });

  it('ekrandaki her taşıyıcı seçimi kapsamdan geçer (oluşturma kutusu ve genel bölüm; inceleme bulgusu)', () => {
    // Aras seçilen yeni tarife FedEx'in 5000 + değişken yakıtıyla kaydedilmesin: taşıyıcı yazan her satır withCarrier'dan geçer
    for (const file of ['../src/pages/TariffEditor.tsx', '../src/pages/tariff-editor/BasicSections.tsx']) {
      const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      const writes = src.split(/\r?\n/).filter((l) => /carrierId:\s*(e\.target\.value|cs\.data)/.test(l));
      assert.ok(writes.length > 0, file);
      for (const l of writes) assert.match(l, /withCarrier\(/, `${file}: ${l.trim()}`);
    }
    const fedexFirst = D.withCarrier(D.newDraft('', 'TRY'), FEDEX);
    const aras = D.withCarrier(fedexFirst, ARAS);
    assert.deepEqual([aras.carrierId, aras.divisor, aras.fuelVariable], [ARAS.id, '3000', false]);
  });

  it('kayıtlı tarife kapsamsız açılır (bölen ve yakıt olduğu gibi)', () => {
    const d = D.fromTariff({
      id: 't',
      carrierId: 'c-ptt',
      name: 'PTT eski',
      service: null,
      currency: 'TRY',
      divisor: 5000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [],
      discountPct: 0,
      fuelPct: 0,
      fuelVariable: true,
      validFrom: null,
      validTo: null,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'A' }],
      rates: [{ zone: 'A', weightUpto: 1, price: 10 }],
      overflow: [],
      surcharges: [],
      countryAdjustments: [],
      updatedAt: '2026-11-01T00:00:00Z',
    } as never);
    assert.deepEqual([d.scope, d.divisor, d.fuelVariable], [undefined, '5000', true]);
  });
});
