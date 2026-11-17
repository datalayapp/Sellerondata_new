// DeciShip sample data generator. Run: node generate.mjs  (from samples/tools)
// Deterministic: no randomness. Writes ../seed-tariffs.json, ../seed-measurements.json, ../invoices/*,
// ../expected.json, ../EXPECTED.md, ../tariff-template-example.xlsx
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const w = (rel, data) => fs.writeFileSync(path.join(ROOT, rel), data);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };

// ---------------------------------------------------------------- money helpers (integer cents)
const C = (x) => Math.round(x * 100);            // number -> cents
const E = (c) => c / 100;                        // cents -> number
const pct10 = (p) => Math.round(p * 10);         // 27.5 -> 275
const mulPct = (cents, p) => Math.floor((cents * pct10(p) + 500) / 1000); // half-up round2 of cents*p/100
const tr = (n) => { // 1234.5 -> "1.234,50"
  const s = n.toFixed(2); const [i, d] = s.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d;
};
const trKg = (n) => String(n).replace('.', ',');

// ---------------------------------------------------------------- tariffs
const STEPS_STD = [{ upto: 20, step: 0.5 }, { upto: null, step: 1 }];
const STEPS_DHL = [{ upto: 30, step: 0.5 }, { upto: null, step: 1 }];
const STEPS_DESI = [{ upto: null, step: 1 }];
const W_INTL = [...Array.from({ length: 40 }, (_, i) => (i + 1) / 2), ...Array.from({ length: 10 }, (_, i) => 21 + i)]; // 0.5..20, 21..30
const W_DHL = Array.from({ length: 60 }, (_, i) => (i + 1) / 2); // 0.5..30
const W_DESI = Array.from({ length: 30 }, (_, i) => i + 1);

function interp(anchors, x) {
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i], [x1, y1] = anchors[i + 1];
    if (x <= x1) return Math.round(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  return anchors.at(-1)[1];
}
// FedEx zone A anchors (cents). 5.0, 5.5, 6.0, 9.5, 15.0 are pinned to the wiki examples.
const FEDEX_A = [[0.5, 65000], [5, 132077], [5.5, 144516], [6, 152775], [9.5, 211935], [15, 363226], [20, 463200], [30, 690000]];
const curveIntl = (f) => (x) => Math.round(interp(FEDEX_A, x) * f);

function mkRates(weights, zoneFactors, base) {
  const rates = [];
  for (const [zone, f] of Object.entries(zoneFactors)) {
    for (const wt of weights) rates.push({ zone, weightUpto: wt, price: E(Math.round(base(wt) * f)) });
  }
  return rates;
}
const zonesFrom = (map) => Object.entries(map).flatMap(([zone, cs]) => cs.map((country) => ({ country, zone })));
const EU = ['FR', 'DE', 'NL', 'BE', 'IT', 'ES'];

const desiBase = (d) => Math.round((70 + 8.4 * (d - 1) + 0.12 * (d - 1) ** 2) * 100);

const CARRIERS = [
  {
    code: 'fedex', name: 'FedEx', tariffs: [{
      name: 'FedEx International Economy 2026', service: 'International Economy', currency: 'TRY', divisor: 5000, edgeRounding: 'CEIL_CM',
      weightSteps: STEPS_STD, discountPct: 38, fuelPct: 25, fuelVariable: false, validFrom: '2026-01-01', validTo: '2026-12-31', active: true, isDefault: true,
      zones: zonesFrom({ A: EU, B: ['GB', 'CH'], D: ['US', 'CA'] }),
      rates: mkRates(W_INTL, { A: 1, B: 1.18, D: 1.55 }, (x) => interp(FEDEX_A, x)),
      overflow: [{ zone: 'A', perUnit: 150 }, { zone: 'B', perUnit: 170 }, { zone: 'D', perUnit: 230 }],
      surcharges: [
        { code: 'REMOTE_AREA', name: 'Uzak bölge ek ücreti', kind: 'PER_KG', amount: 18.5 },
        { code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', kind: 'FIXED', amount: 285 },
      ],
    }],
  },
  {
    code: 'ups', name: 'UPS', tariffs: [{
      name: 'UPS Express Saver 2026', service: 'Express Saver', currency: 'TRY', divisor: 5000, edgeRounding: 'CEIL_CM',
      weightSteps: STEPS_STD, discountPct: 32, fuelPct: 22, fuelVariable: false, validFrom: '2026-01-01', validTo: '2026-12-31', active: true, isDefault: true,
      zones: zonesFrom({ Z1: EU, Z2: ['GB', 'CH'], Z3: ['US', 'CA'] }),
      rates: mkRates(W_INTL, { Z1: 0.93, Z2: 1.12, Z3: 1.48 }, (x) => interp(FEDEX_A, x)),
      overflow: [{ zone: 'Z1', perUnit: 140 }, { zone: 'Z2', perUnit: 165 }, { zone: 'Z3', perUnit: 220 }],
      surcharges: [
        { code: 'DELIVERY_AREA', name: 'Teslimat bölgesi ek ücreti', kind: 'PER_KG', amount: 17 },
        { code: 'LARGE_PACKAGE', name: 'Büyük paket ek ücreti', kind: 'FIXED', amount: 310 },
      ],
    }],
  },
  {
    code: 'dhl', name: 'DHL Express', tariffs: [{
      name: 'DHL Express Worldwide 2026', service: 'Express Worldwide', currency: 'TRY', divisor: 5000, edgeRounding: 'CEIL_CM',
      weightSteps: STEPS_DHL, discountPct: 35, fuelPct: 24, fuelVariable: false, validFrom: '2026-01-01', validTo: '2026-12-31', active: true, isDefault: true,
      zones: zonesFrom({ EU, UK: ['GB', 'CH'], WW: ['US', 'CA'] }),
      rates: mkRates(W_DHL, { EU: 0.97, UK: 1.15, WW: 1.52 }, (x) => interp(FEDEX_A, x)),
      overflow: [{ zone: 'EU', perUnit: 145 }, { zone: 'UK', perUnit: 168 }, { zone: 'WW', perUnit: 225 }],
      surcharges: [
        { code: 'REMOTE_AREA', name: 'Uzak bölge teslimat', kind: 'FIXED', amount: 240 },
        { code: 'INSURANCE', name: 'Sigorta (gönderi bedeli %)', kind: 'PCT', amount: 1 },
      ],
    }],
  },
  {
    code: 'aras', name: 'Aras Kargo', tariffs: [{
      name: 'Aras Desi 2026', service: 'Yurtiçi Standart', currency: 'TRY', divisor: 3000, edgeRounding: 'CEIL_CM',
      weightSteps: STEPS_DESI, discountPct: 10, fuelPct: 0, fuelVariable: false, validFrom: '2026-01-01', validTo: '2026-12-31', active: true, isDefault: true,
      zones: [{ country: '*', zone: '*' }],
      rates: mkRates(W_DESI, { '*': 1 }, desiBase),
      overflow: [{ zone: '*', perUnit: 13.5 }],
      surcharges: [{ code: 'KAPIDA_ODEME', name: 'Kapıda ödeme hizmet bedeli', kind: 'FIXED', amount: 14.5 }],
    }],
  },
  {
    code: 'yurtici', name: 'Yurtiçi Kargo', tariffs: [{
      name: 'Yurtiçi Desi 2026', service: 'Standart', currency: 'TRY', divisor: 3000, edgeRounding: 'CEIL_CM',
      weightSteps: STEPS_DESI, discountPct: 15, fuelPct: 5, fuelVariable: false, validFrom: '2026-01-01', validTo: '2026-12-31', active: true, isDefault: true,
      zones: [{ country: '*', zone: '*' }],
      rates: mkRates(W_DESI, { '*': 1.08 }, desiBase),
      overflow: [{ zone: '*', perUnit: 14.8 }],
      surcharges: [{ code: 'KAPIDA_ODEME', name: 'Kapıda ödeme hizmet bedeli', kind: 'FIXED', amount: 16 }],
    }],
  },
  {
    code: 'mng', name: 'MNG Kargo', tariffs: [{
      name: 'MNG Desi 2026', service: 'Standart', currency: 'TRY', divisor: 3000, edgeRounding: 'CEIL_CM',
      weightSteps: STEPS_DESI, discountPct: 8, fuelPct: 3, fuelVariable: false, validFrom: '2026-01-01', validTo: '2026-12-31', active: true, isDefault: true,
      zones: [{ country: '*', zone: '*' }],
      rates: mkRates(W_DESI, { '*': 0.96 }, desiBase),
      overflow: [{ zone: '*', perUnit: 12.9 }],
      surcharges: [{ code: 'KAPIDA_ODEME', name: 'Kapıda ödeme hizmet bedeli', kind: 'FIXED', amount: 15 }],
    }],
  },
];
// monotonic sanity
for (const c of CARRIERS) for (const t of c.tariffs) {
  const byZone = {};
  for (const r of t.rates) (byZone[r.zone] ??= []).push(r);
  for (const rs of Object.values(byZone)) for (let i = 1; i < rs.length; i++) assert(rs[i].price > rs[i - 1].price && rs[i].weightUpto > rs[i - 1].weightUpto, `monotonic ${t.name}`);
}
// internal TariffInput form
const TARIFF = {};
for (const c of CARRIERS) {
  const t = c.tariffs[0];
  TARIFF[c.code] = {
    ...t, zoneMap: Object.fromEntries(t.zones.map((z) => [z.country, z.zone])),
    overflowMap: Object.fromEntries(t.overflow.map((o) => [o.zone, o.perUnit])),
    surMap: Object.fromEntries(t.surcharges.map((s) => [s.code, s])),
  };
}

// ---------------------------------------------------------------- calc (independent implementation of SPEC §3)
const stepBand = (t, kg) => t.weightSteps.find((s) => s.upto == null || kg <= s.upto) ?? null;
function roundUpMilli(t, milli) {
  const b = stepBand(t, milli / 1000);
  if (!b) return milli;
  const sm = Math.round(b.step * 1000);
  return Math.ceil(milli / sm) * sm;
}
function chargeableOf(t, dims, kg) {
  const e = t.edgeRounding === 'CEIL_CM' ? dims.map(Math.ceil) : dims;
  const vol = e[0] * e[1] * e[2] * 1000 / t.divisor;
  const volMilli = Math.round(vol);
  const rawMilli = Math.max(volMilli, Math.round(kg * 1000));
  const ch = roundUpMilli(t, rawMilli);
  // guard: using unrounded volumetric must give the same chargeable
  const ch2 = roundUpMilli(t, Math.max(Math.ceil(vol - 1e-9), Math.round(kg * 1000)));
  assert(ch === ch2 || Math.abs(vol - volMilli) < 1e-9, `volumetric rounding sensitive ${dims} ${kg}`);
  return { volumetric: volMilli / 1000, chargeable: ch / 1000, edges: e };
}
function priceCents(t, zone, chargeable, o = {}) {
  const discountPct = o.discountPct ?? t.discountPct, fuelPct = o.fuelPct ?? t.fuelPct;
  const rows = t.rates.filter((r) => r.zone === zone).sort((a, b) => a.weightUpto - b.weightUpto);
  let row = rows.find((r) => r.weightUpto >= chargeable - 1e-9), base;
  if (row) base = C(row.price);
  else {
    const last = rows.at(-1), per = t.overflowMap[zone];
    if (per == null) return null;
    const b = stepBand(t, chargeable), st = b ? b.step : 1;
    base = C(last.price) + Math.ceil((chargeable - last.weightUpto) / st - 1e-9) * C(per);
  }
  const disc = mulPct(base, discountPct), after = base - disc, fuel = mulPct(after, fuelPct);
  return { base, disc, after, fuel, total: after + fuel };
}
function surchargeCents(t, code, chargeable, afterDiscount) {
  const s = t.surMap[code]; if (!s) return null;
  if (s.kind === 'FIXED') return C(s.amount);
  if (s.kind === 'PER_KG') return Math.round(C(s.amount) * chargeable);
  return mulPct(afterDiscount, s.amount);
}
function paddedChargeable(t, dims, kg) {
  const e = t.edgeRounding === 'CEIL_CM' ? dims.map(Math.ceil) : dims;
  const volMilli = Math.round((e[0] * e[1] * e[2] * 1000) / t.divisor);
  return roundUpMilli(t, Math.max(volMilli, Math.round(kg * 1000))) / 1000;
}
const zoneOf = (t, dest) => t.zoneMap[dest] ?? t.zoneMap['*'] ?? null;

// ---------------------------------------------------------------- compare (SPEC §3.4) ; variants for ambiguity checks
const TOL = { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5 };
function compareOne(L, meas, t, isDup, variant) {
  const billed = L.netC;
  if (isDup) return { status: 'DIFF', diffTypes: ['DUPLICATE'], ourChargeableKg: null, billedChargeableKg: L.billedCh ?? null, expectedC: null, billedC: billed, diffC: billed };
  if (!meas) return { status: 'UNMATCHED', diffTypes: [], ourChargeableKg: null, billedChargeableKg: L.billedCh ?? null, expectedC: null, billedC: billed, diffC: null };
  const zone = zoneOf(t, L.dest);
  const our = chargeableOf(t, meas.dims, meas.kg);
  // KARARLAR "Ölçüm sınırı" (2026-11-10): ölçümün her kenarına tolerans kadar pay eklenir; taşıyıcının ağırlığı bu payın
  // içindeyse fark sayılmaz, beklenen taşıyıcının ağırlığında hesaplanır.
  const bchRaw = L.billedCh;
  const over = bchRaw != null && bchRaw > our.chargeable + TOL.weightTolKg + 1e-9;
  let pricingCh = our.chargeable;
  if (over) {
    const padded = paddedChargeable(t, meas.dims.map((x) => x + TOL.edgeTolCm), meas.kg);
    if (bchRaw <= padded + TOL.weightTolKg + 1e-9) pricingCh = Math.max(our.chargeable, Math.min(bchRaw, padded));
  }
  const withinTol = pricingCh !== our.chargeable;
  const p = zone ? priceCents(t, zone, pricingCh) : null;
  if (!p) return { status: 'NO_TARIFF', diffTypes: [], ourChargeableKg: our.chargeable, billedChargeableKg: L.billedCh ?? null, expectedC: null, billedC: billed, diffC: null, note: zone ? 'Fiyat satırı yok' : 'Bölge yok' };
  const types = [];
  const bch = L.billedCh;
  if (over && !withinTol) {
    let dimT = false;
    if (L.billedDims) {
      const ours = [...(variant.edgeBase === 'ceil' ? our.edges : meas.dims)].sort((a, b) => a - b);
      const theirs = [...L.billedDims].sort((a, b) => a - b);
      const edgeBigger = theirs.some((v, i) => v > ours[i] + TOL.edgeTolCm + 1e-9);
      const bvol = (L.billedDims[0] * L.billedDims[1] * L.billedDims[2]) / (L.billedDivisor ?? t.divisor);
      const volBigger = bvol > meas.kg + 1e-9;
      dimT = variant.prec === 'A' ? (edgeBigger || volBigger) : (edgeBigger || volBigger); // dims present guards both
    }
    types.push(dimT ? 'DIMENSION' : 'WEIGHT');
  }
  let exp = p.total, surDiffFlag = false;
  for (const [code, amt] of Object.entries(L.surchargesC)) {
    const e = surchargeCents(t, code, pricingCh, p.after);
    if (e == null) surDiffFlag = true;
    else { exp += e; if (amt - e > C(TOL.amountTol)) surDiffFlag = true; }
  }
  if (surDiffFlag) types.push('SURCHARGE');
  const diff = billed - exp;
  // KARARLAR "Parasız fark": ağırlık/ölçü farkının tutara etkisi tolerans içindeyse satır uyumlu
  if (types.length && !types.includes('SURCHARGE') && diff <= C(TOL.amountTol)) types.length = 0;
  if (diff > C(TOL.amountTol) && types.length === 0) types.push('PRICE');
  let note;
  if (withinTol) note = 'Ağırlık farkı ölçüm toleransı içinde';
  if (types.length === 0 && diff < -C(TOL.amountTol)) note = 'Lehimize fark';
  return { status: types.length ? 'DIFF' : 'MATCH', diffTypes: types, ourChargeableKg: our.chargeable, billedChargeableKg: bch ?? null, expectedC: exp, billedC: billed, diffC: diff, note };
}
function compare(L, meas, t, isDup) {
  const vs = [];
  for (const edgeBase of ['raw', 'ceil']) vs.push(compareOne(L, meas, t, isDup, { edgeBase, prec: 'A' }));
  for (const v of vs) assert(v.status === vs[0].status && v.diffTypes.join() === vs[0].diffTypes.join(), `interpretation-sensitive line ${L.trackingNo}`);
  return vs[0];
}

// ---------------------------------------------------------------- measurement + line specs
const D = (md) => { // "10-22 14:12" -> shipDate + ISO
  const [d, hm] = md.split(' '); const [mo, da] = d.split('-');
  return { date: `2026-${mo}-${da}`, iso: `2026-${mo}-${da}T${hm}:00+03:00` };
};
const barcode34 = (t12) => '96' + '1102' + '3456789012345678' + t12;
const SCEN_STATUS = { MATCH_MEASURE_TOL: 'MATCH', MATCH: 'MATCH', MATCH_TOL: 'MATCH', MATCH_FAVOR: 'MATCH', MATCH_DIMS: 'MATCH', MATCH_SURCH: 'MATCH', DIMENSION: 'DIFF', WEIGHT: 'DIFF', SURCHARGE: 'DIFF', PRICE: 'DIFF', COMBO: 'DIFF', SURCH_EXCESS: 'DIFF', DUP: 'DIFF', UNMATCHED: 'UNMATCHED', NO_TARIFF: 'NO_TARIFF' };

/** spec fields: key, trk (invoice tracking), raw?, dest, dims[l,w,h] (measured), kg, at "MM-DD HH:mm", dm, wm, preset?, sc, + scenario params */
const INV = []; // invoice definitions, filled below
const MEAS = []; // measurement list in order
const seenMeas = new Set();

function defineInvoice(def) { INV.push(def); }

// ---- FedEx 9-482-11735 (wiki)
const fx = (n) => '79481234' + n;
defineInvoice({
  id: 'fedex-9-482-11735', file: 'fedex-9-482-11735.csv', carrier: 'fedex', invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', format: 'csv',
  lines: [
    { key: 'f5305', trk: fx(5305), dest: 'FR', dims: [40, 30, 25], kg: 4.0, at: '10-22 14:12', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'DIMENSION', billedDims: [45, 35, 30], billedActual: 4.0, wiki: '#5305 ölçü farkı' },
    { key: 'f5302', trk: fx(5302), dest: 'GB', dims: [30, 20, 15], kg: 3.2, at: '10-22 11:03', dm: 'PRESET', wm: 'MANUAL', preset: 'K1', sc: 'MATCH' },
    { key: 'f5301', trk: fx(5301), raw: '7948 1234 5301', dest: 'US', dims: [50, 40, 30], kg: 9.6, at: '10-22 10:41', dm: 'PRESET', wm: 'OCR', preset: 'K3', sc: 'MATCH' },
    { key: 'f5299', trk: fx(5299), raw: barcode34(fx(5299)), dest: 'DE', dims: [32, 24, 20], kg: 4.8, at: '10-21 16:20', dm: 'MANUAL', wm: 'OCR', sc: 'WEIGHT', billedActual: 5.4, billedDimsSame: true, wiki: '#5299 ağırlık farkı' },
    { key: 'f5300', trk: fx(5300), dest: 'CH', dims: [28, 22, 18], kg: 2.6, at: '10-22 09:55', dm: 'MANUAL', wm: 'MANUAL', sc: 'MATCH_TOL', tolC: 200 },
    { key: 'f5297', trk: fx(5297), raw: barcode34(fx(5297)), dest: 'IT', dims: [44.6, 34.8, 29.7], kg: 6.0, at: '10-21 15:12', dm: 'LIDAR', wm: 'OCR', sc: 'MATCH_SURCH', sur: ['REMOTE_AREA'] },
    { key: 'f5293', trk: fx(5293), dest: 'NL', dims: [36, 26, 22], kg: 3.9, at: '10-21 13:48', dm: 'MANUAL', wm: 'OCR', sc: 'SURCHARGE', extra: { ADDRESS_CORRECTION: 412 }, wiki: '#5293 ek ücret' },
    { key: 'f5296', trk: fx(5296), dest: 'ES', dims: [30, 20, 15], kg: 4.0, at: '10-21 12:30', dm: 'PRESET', wm: 'MANUAL', preset: 'K1', sc: 'MATCH_DIMS', billedDims: [34, 24, 17] },
    { key: 'f5295', trk: fx(5295), dest: 'DE', dims: [40, 30, 25], kg: 3.5, at: '10-21 10:05', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'MATCH' },
    { key: 'f5294', trk: fx(5294), dest: 'CA', dims: [55, 45, 35], kg: 14.8, at: '10-20 17:44', dm: 'AR', wm: 'MANUAL', sc: 'MATCH_SURCH', sur: ['ADDITIONAL_HANDLING'] },
    { key: 'f5290', trk: fx(5290), raw: barcode34(fx(5290)), dest: 'BE', dims: [59.6, 49.8, 25], kg: 12.4, at: '10-20 15:31', dm: 'LIDAR', wm: 'OCR', sc: 'PRICE', fuelPct: 27.5, wiki: '#5290 fiyat farkı (yakıt %27,5)' },
    { key: 'f5292', trk: fx(5292), dest: 'FR', dims: [25, 20, 15], kg: 1.2, at: '10-20 14:02', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH_FAVOR', favorC: 1200 },
    { key: 'f5288', trk: fx(5288), dest: 'FR', dims: [35, 28, 25], kg: 5.2, at: '10-20 11:20', dm: 'AR', wm: 'OCR', sc: 'MATCH', wiki: '#5288 (ilk görünüm)' },
    { key: 'f5291', trk: fx(5291), dest: 'NL', dims: [42, 32, 28], kg: 6.9, at: '10-19 16:15', dm: 'REFERENCE', wm: 'MANUAL', sc: 'MATCH' },
    { key: 'f5289', trk: fx(5289), dest: 'GB', dims: [36, 30, 20], kg: 4.4, at: '10-19 14:40', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH' },
    { key: 'f5287', trk: fx(5287), dest: 'DE', dims: [34, 27, 21], kg: 3.1, at: '10-19 11:09', dm: 'MANUAL', wm: 'MANUAL', sc: 'MATCH' },
    { key: 'f5288d', trk: fx(5288), dest: 'FR', sc: 'DUP', dupOf: 'f5288', wiki: '#5288 mükerrer (ikinci görünüm)' },
    { key: 'fU', trk: '774012346105', dest: 'FR', sc: 'UNMATCHED', billedActual: 2.0, billedDims: [25, 20, 15], wiki: 'eşleşmeyen' },
  ],
});
// ---- FedEx 9-482-11736 (xlsx)
defineInvoice({
  id: 'fedex-9-482-11736', file: 'fedex-9-482-11736.xlsx', carrier: 'fedex', invoiceNo: '9-482-11736', invoiceDate: '2026-11-03', format: 'xlsx',
  lines: [
    { key: 'f5286', trk: fx(5286), dest: 'DE', dims: [38, 28, 22], kg: 4.1, at: '10-23 10:12', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH' },
    { key: 'f5285', trk: fx(5285), dest: 'FR', dims: [30, 22, 18], kg: 2.2, at: '10-23 11:30', dm: 'MANUAL', wm: 'OCR', sc: 'COMBO', billedDims: [36, 28, 22], extra: { RESIDENTIAL: 96.5 } },
    { key: 'f5284', trk: fx(5284), dest: 'US', dims: [45, 35, 30], kg: 9.2, at: '10-23 13:05', dm: 'LIDAR', wm: 'OCR', sc: 'SURCH_EXCESS', sur: ['ADDITIONAL_HANDLING'], surOverride: { ADDITIONAL_HANDLING: 385 } },
    { key: 'f5283', trk: fx(5283), dest: 'GB', dims: [40, 30, 25], kg: 5.0, at: '10-23 15:45', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'PRICE', discountPct: 35 },
    { key: 'f5282', trk: fx(5282), dest: 'CH', dims: [30, 20, 15], kg: 7.4, at: '10-24 09:20', dm: 'PRESET', wm: 'MANUAL', preset: 'K1', sc: 'WEIGHT', billedActual: 8.3, billedDimsSame: true },
    { key: 'f5281', trk: fx(5281), dest: 'IT', dims: [40, 30, 25], kg: 5.4, at: '10-24 10:50', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'MATCH_SURCH', sur: ['REMOTE_AREA'] },
    { key: 'f5287x', trk: fx(5287), dest: 'DE', sc: 'DUP', dupOf: 'f5287', crossInvoice: '9-482-11735', wiki: 'önceki faturada (11735) zaten faturalanmış' },
    { key: 'fU2', trk: '794812346201', dest: 'NL', sc: 'UNMATCHED', billedActual: 3.0, billedDims: [30, 20, 20] },
    { key: 'f5280', trk: fx(5280), dest: 'ES', dims: [33, 25, 20], kg: 3.3, at: '10-25 08:40', dm: 'MANUAL', wm: 'MANUAL', sc: 'MATCH_TOL', tolC: 350 },
  ],
});
// ---- UPS
const ups = (n) => '1Z9X4A7103' + n;
defineInvoice({
  id: 'ups-0000F4A71X', file: 'ups-0000F4A71X.xlsx', carrier: 'ups', invoiceNo: '0000F4A71X', invoiceDate: '2026-10-30', format: 'xlsx',
  lines: [
    { key: 'u1', trk: ups('41007731'), dest: 'DE', dims: [38, 28, 22], kg: 4.1, at: '10-20 10:15', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH' },
    { key: 'u2', trk: ups('41007742'), dest: 'FR', dims: [40, 30, 25], kg: 3.8, at: '10-20 11:40', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'MATCH_SURCH', sur: ['DELIVERY_AREA'] },
    { key: 'u3', trk: ups('41007753'), dest: 'US', dims: [70, 50, 40], kg: 21.0, at: '10-21 09:30', dm: 'AR', wm: 'MANUAL', sc: 'MATCH_SURCH', sur: ['LARGE_PACKAGE'] },
    { key: 'u4', trk: ups('41007764'), dest: 'GB', dims: [35, 25, 20], kg: 3.0, at: '10-21 14:10', dm: 'MANUAL', wm: 'OCR', sc: 'DIMENSION', billedDims: [42, 32, 24], billedActual: 3.0 },
    { key: 'u5', trk: ups('41007775'), dest: 'NL', dims: [30, 20, 15], kg: 7.4, at: '10-22 08:50', dm: 'PRESET', wm: 'OCR', preset: 'K1', sc: 'WEIGHT', billedActual: 8.3, billedDimsSame: true },
    { key: 'u6', trk: ups('41007786'), dest: 'IT', dims: [40, 30, 25], kg: 5.0, at: '10-22 13:25', dm: 'PRESET', wm: 'MANUAL', preset: 'K2', sc: 'PRICE', discountPct: 28 },
    { key: 'u7', trk: ups('41007797'), dest: 'ES', dims: [32, 24, 20], kg: 3.6, at: '10-23 10:05', dm: 'LIDAR', wm: 'OCR', sc: 'SURCHARGE', extra: { ADDRESS_CORRECTION: 395 } },
    { key: 'u1d', trk: ups('41007731'), dest: 'DE', sc: 'DUP', dupOf: 'u1' },
    { key: 'uU', trk: ups('41007808'), dest: 'FR', sc: 'UNMATCHED', billedActual: 2.4, billedDims: [28, 20, 15] },
    { key: 'u10', trk: ups('41007819'), dest: 'AU', dims: [33, 23, 18], kg: 2.1, at: '10-24 15:00', dm: 'MANUAL', wm: 'MANUAL', sc: 'NO_TARIFF' },
  ],
});
// ---- DHL
const dhl = (n) => '48219' + n;
defineInvoice({
  id: 'dhl-SIN-4471029', file: 'dhl-SIN-4471029.csv', carrier: 'dhl', invoiceNo: 'SIN-4471029', invoiceDate: '2026-10-28', format: 'csv',
  lines: [
    { key: 'd1', trk: dhl('07315'), dest: 'DE', dims: [31, 26, 21], kg: 2.9, at: '10-19 12:00', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH' },
    { key: 'd2', trk: dhl('07326'), dest: 'US', dims: [45, 35, 30], kg: 9.2, at: '10-19 13:30', dm: 'LIDAR', wm: 'OCR', sc: 'MATCH' },
    { key: 'd3', trk: dhl('07337'), dest: 'FR', dims: [36, 26, 20], kg: 4.4, at: '10-20 09:10', dm: 'MANUAL', wm: 'MANUAL', sc: 'MATCH_SURCH', sur: ['REMOTE_AREA'] },
    { key: 'd4', trk: dhl('07348'), dest: 'NL', dims: [30, 22, 18], kg: 2.2, at: '10-20 10:45', dm: 'MANUAL', wm: 'OCR', sc: 'DIMENSION', billedDims: [36, 28, 22], billedActual: 2.2 },
    { key: 'd5', trk: dhl('07359'), dest: 'BE', dims: [28, 20, 15], kg: 6.1, at: '10-21 16:35', dm: 'MANUAL', wm: 'OCR', sc: 'WEIGHT', billedActual: 7.2, billedDimsSame: true },
    { key: 'd6', trk: dhl('07360'), dest: 'ES', dims: [40, 30, 25], kg: 4.0, at: '10-22 09:00', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'PRICE', fuelPct: 26.5 },
    { key: 'd7', trk: dhl('07371'), dest: 'FR', dims: [33, 33, 33], kg: 6.5, at: '10-23 14:20', dm: 'REFERENCE', wm: 'OCR', sc: 'SURCHARGE', extra: { EMERGENCY_SITUATION: 185 } },
    { key: 'd2d', trk: dhl('07326'), dest: 'US', sc: 'DUP', dupOf: 'd2' },
    { key: 'dU', trk: dhl('07382'), dest: 'DE', sc: 'UNMATCHED', billedActual: 1.8, billedDims: [25, 18, 12] },
  ],
});
// ---- Aras
const aras = (n) => '34125500' + n;
defineInvoice({
  id: 'aras-ARS-2026-004871', file: 'aras-ARS-2026-004871.xlsx', carrier: 'aras', invoiceNo: 'ARS-2026-004871', invoiceDate: '2026-10-27', format: 'xlsx',
  lines: [
    { key: 'a1', trk: aras('10231'), dest: null, city: 'İstanbul', dims: [40, 30, 25], kg: 6.2, at: '10-21 10:30', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'MATCH' },
    { key: 'a2', trk: aras('10242'), dest: null, city: 'Ankara', dims: [30, 20, 15], kg: 2.1, at: '10-21 11:15', dm: 'PRESET', wm: 'MANUAL', preset: 'K1', sc: 'MATCH_SURCH', sur: ['KAPIDA_ODEME'] },
    { key: 'a3', trk: aras('10253'), dest: null, city: 'İzmir', dims: [35, 25, 20], kg: 4.0, at: '10-22 09:45', dm: 'MANUAL', wm: 'OCR', sc: 'DIMENSION', billedDims: [44, 34, 26], billedActual: 4.0 },
    { key: 'a4', trk: aras('10264'), dest: null, city: 'Bursa', dims: [30, 20, 15], kg: 4.2, at: '10-22 12:20', dm: 'MANUAL', wm: 'OCR', sc: 'WEIGHT', billedActual: 6.3, billedDimsSame: true },
    { key: 'a5', trk: aras('10275'), dest: null, city: 'Antalya', dims: [45, 40, 30], kg: 12.0, at: '10-23 08:55', dm: 'LIDAR', wm: 'OCR', sc: 'PRICE', discountPct: 5 },
    { key: 'a6', trk: aras('10286'), dest: null, city: 'Konya', dims: [32, 22, 18], kg: 3.0, at: '10-23 15:10', dm: 'MANUAL', wm: 'MANUAL', sc: 'SURCHARGE', extra: { ADRES_DUZELTME: 38 } },
    { key: 'a1d', trk: aras('10231'), dest: null, city: 'İstanbul', sc: 'DUP', dupOf: 'a1' },
    { key: 'aU', trk: aras('10297'), dest: null, city: 'Adana', sc: 'UNMATCHED', billedActual: 2.5, billedDims: [30, 20, 15] },
  ],
});
// ---- Yurtiçi
const yk = (n) => '6200318' + n;
defineInvoice({
  id: 'yurtici-YK-2026-118833', file: 'yurtici-YK-2026-118833.xlsx', carrier: 'yurtici', invoiceNo: 'YK-2026-118833', invoiceDate: '2026-10-29', format: 'xlsx',
  lines: [
    { key: 'y1', trk: yk('40101'), dest: null, city: 'İstanbul', dims: [28, 22, 18], kg: 2.5, at: '10-19 10:00', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH' },
    { key: 'y2', trk: yk('40112'), dest: null, city: 'Kayseri', dims: [70, 50, 40], kg: 28.0, at: '10-19 12:30', dm: 'AR', wm: 'MANUAL', sc: 'MATCH' },
    { key: 'y3', trk: yk('40123'), dest: null, city: 'Samsun', dims: [38, 30, 20], kg: 5.2, at: '10-20 09:40', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH_SURCH', sur: ['KAPIDA_ODEME'] },
    { key: 'y4', trk: yk('40134'), dest: null, city: 'Eskişehir', dims: [30, 30, 20], kg: 5.5, at: '10-21 11:05', dm: 'MANUAL', wm: 'OCR', sc: 'DIMENSION', billedDims: [36, 36, 26], billedActual: 5.5 },
    { key: 'y5', trk: yk('40145'), dest: null, city: 'Trabzon', dims: [32, 24, 18], kg: 6.4, at: '10-22 14:50', dm: 'MANUAL', wm: 'OCR', sc: 'WEIGHT', billedActual: 8.6, billedDimsSame: true },
    { key: 'y6', trk: yk('40156'), dest: null, city: 'Mersin', dims: [50, 40, 30], kg: 14.0, at: '10-23 10:25', dm: 'LIDAR', wm: 'MANUAL', sc: 'PRICE', fuelPct: 10 },
    { key: 'y7', trk: yk('40167'), dest: null, city: 'Gaziantep', dims: [35, 25, 20], kg: 3.4, at: '10-24 09:15', dm: 'PRESET', wm: 'OCR', preset: 'K1', sc: 'SURCHARGE', extra: { ADRES_DEGISIKLIGI: 35 } },
    { key: 'y3d', trk: yk('40123'), dest: null, city: 'Samsun', sc: 'DUP', dupOf: 'y3' },
    { key: 'yU', trk: yk('40178'), dest: null, city: 'Bolu', sc: 'UNMATCHED', billedActual: 3.0, billedDims: [30, 20, 20] },
  ],
});
// ---- MNG
const mng = (n) => '5710' + n;
defineInvoice({
  id: 'mng-MNG-2026-77120', file: 'mng-MNG-2026-77120.csv', carrier: 'mng', invoiceNo: 'MNG-2026-77120', invoiceDate: '2026-10-30', format: 'csv',
  lines: [
    { key: 'g1', trk: mng('88001201'), dest: null, city: 'İstanbul', dims: [40, 30, 25], kg: 7.3, at: '10-22 10:20', dm: 'PRESET', wm: 'OCR', preset: 'K2', sc: 'MATCH', noDims: true },
    { key: 'g2', trk: mng('88001212'), dest: null, city: 'Ankara', dims: [36, 28, 20], kg: 4.0, at: '10-22 11:35', dm: 'MANUAL', wm: 'OCR', sc: 'MATCH_SURCH', sur: ['KAPIDA_ODEME'], noDims: true },
    { key: 'g3', trk: mng('88001223'), dest: null, city: 'İzmir', dims: [34, 25, 15], kg: 3.5, at: '10-23 09:00', dm: 'MANUAL', wm: 'OCR', sc: 'WEIGHT', billedActual: 5.9, noDims: true },
    { key: 'g4', trk: mng('88001234'), dest: null, city: 'Bursa', dims: [45, 30, 20], kg: 5.0, at: '10-23 13:45', dm: 'LIDAR', wm: 'MANUAL', sc: 'MATCH_MEASURE_TOL', billedActual: 5.0, billedDeci: 10, noDims: true },
    { key: 'g5', trk: mng('88001245'), dest: null, city: 'Adana', dims: [42, 32, 28], kg: 11.0, at: '10-24 10:10', dm: 'REFERENCE', wm: 'OCR', sc: 'PRICE', discountPct: 0, noDims: true },
    { key: 'g6', trk: mng('88001256'), dest: null, city: 'Denizli', dims: [30, 25, 20], kg: 3.8, at: '10-25 08:30', dm: 'MANUAL', wm: 'MANUAL', sc: 'SURCHARGE', extra: { ADRES_DUZELTME: 40 }, noDims: true },
    { key: 'g1d', trk: mng('88001201'), dest: null, city: 'İstanbul', sc: 'DUP', dupOf: 'g1', noDims: true },
    { key: 'gU', trk: mng('88001267'), dest: null, city: 'Muğla', sc: 'UNMATCHED', billedActual: 2.2, noDims: true },
  ],
});

// ---------------------------------------------------------------- build billed lines + measurements
const MEAS_BY_KEY = {}, LINE_BY_KEY = {};
let uid = 0;
for (const inv of INV) {
  const t = TARIFF[inv.carrier];
  const domestic = ['aras', 'yurtici', 'mng'].includes(inv.carrier);
  inv.built = [];
  for (const s of inv.lines) {
    const sd = s.at ? D(s.at) : null;
    if (s.dims && !seenMeas.has(s.key)) {
      seenMeas.add(s.key);
      const m = {
        trackingRaw: s.raw ?? s.trk, lengthCm: s.dims[0], widthCm: s.dims[1], heightCm: s.dims[2], weightKg: s.kg,
        dimMethod: s.dm, weightMethod: s.wm, measuredAt: sd.iso, measuredByUsername: 'mehmet', ...(s.preset ? { boxPreset: s.preset } : {}),
      };
      MEAS.push(m);
      MEAS_BY_KEY[s.key] = { dims: s.dims, kg: s.kg, at: sd, trk: s.trk, measRef: m };
    }
    const L = { key: s.key, spec: s, trackingNo: s.trk, dest: s.dest, city: s.city, surchargesC: {}, reference: 'SIP-' + (s.trk.slice(-4)) + (s.sc === 'DUP' ? '-R' : '') };
    const base = s.dupOf ? LINE_BY_KEY[s.dupOf] : null;
    if (s.sc === 'DUP') {
      Object.assign(L, { ...base, key: s.key, spec: s, reference: base.reference + '-R', dupOf: s.dupOf });
      L.surchargesC = { ...base.surchargesC };
    } else if (s.sc === 'UNMATCHED') {
      // billed from the invoice's own (unknown) measurements, standard tariff
      const bd = s.billedDims ?? null, ba = s.billedActual;
      const bch = chargeableOf(t, bd ?? [1, 1, 1], ba);
      const zone = zoneOf(t, s.dest);
      const p = priceCents(t, zone, bch.chargeable);
      Object.assign(L, { shipDate: '2026-10-' + String(20 + (uid++ % 5)), billedActual: ba, billedDims: bd, billedCh: bch.chargeable, billedDivisor: domestic ? undefined : t.divisor, baseC: p.base, discC: p.disc, fuelC: p.fuel, netC: p.total });
    } else {
      const m = MEAS_BY_KEY[s.key];
      const our = chargeableOf(t, m.dims, m.kg);
      const ceilDims = m.dims.map(Math.ceil);
      let bDims = s.noDims ? null : ceilDims, bActual = m.kg;
      if (s.billedDims) bDims = s.billedDims;
      if (s.billedActual != null) bActual = s.billedActual;
      let bch;
      if (s.billedDeci != null) bch = { chargeable: s.billedDeci };
      else bch = chargeableOf(t, bDims ?? ceilDims, bActual); // billed uses its own dims (or ours when not reported)
      const dest = s.dest ?? '*';
      const zone = zoneOf(t, s.dest ?? '*');
      const pOpt = { discountPct: s.discountPct, fuelPct: s.fuelPct };
      const p = zone ? priceCents(t, zone, bch.chargeable, pOpt) : null;
      assert(p || s.sc === 'NO_TARIFF', 'price ' + s.key);
      let baseC, discC, fuelC, netC;
      if (p) { baseC = p.base; discC = p.disc; fuelC = p.fuel; netC = p.total; }
      else { // NO_TARIFF: carrier billed as if some zone-1 price
        const pz = priceCents(t, Object.values(t.zoneMap)[0], bch.chargeable); baseC = Math.round(pz.base * 1.7); discC = mulPct(baseC, t.discountPct); fuelC = mulPct(baseC - discC, t.fuelPct); netC = baseC - discC + fuelC;
      }
      if (s.tolC) { fuelC += s.tolC; netC += s.tolC; }
      if (s.favorC) { discC += s.favorC; netC -= s.favorC; }
      // surcharges
      const afterC = baseC - discC;
      for (const code of s.sur ?? []) {
        let amt = surchargeCents(t, code, bch.chargeable, afterC);
        if (s.surOverride?.[code] != null) amt = C(s.surOverride[code]);
        L.surchargesC[code] = amt; netC += amt;
      }
      for (const [code, amt] of Object.entries(s.extra ?? {})) { L.surchargesC[code] = C(amt); netC += C(amt); }
      Object.assign(L, {
        shipDate: m.at.date, billedActual: bActual, billedDims: bDims, billedCh: bch.chargeable,
        billedDivisor: domestic ? undefined : t.divisor, baseC, discC, fuelC, netC,
      });
      if (s.billedDeci != null) L.billedDeciOverride = true;
    }
    LINE_BY_KEY[s.key] = L;
    inv.built.push(L);
  }
}

// ---------------------------------------------------------------- run comparison
const seenTracking = new Map(); // across invoices in upload order: tracking -> invoiceId
const RESULTS = {};
// KALANLAR 1.8 (kullanıcı kararı 2026-11-14, KARARLAR "Çok koli şüphesi"): takip no aynı dosyada birden çok ücret satırındaysa
// (artı tutarlı) o satırların hiçbir farkı kesin değildir: fark türü olan satır "İncele" (LOW, MULTI_PARCEL), mükerreri de
// "İncele" (LOW, DUPLICATE); tutarlar ve durum değişmez, yalnız Fazla ödeme (kesin) dışında kalır. Önceki faturadaki mükerrer
// aynı taşıyıcı, aynı tutar ve aynı açıklamayla (hizmet + ek ücret kodları; örnekte kopya satır) kesindir. Ölçüm tekrarı
// ("Yeniden ölç") örnek ölçümlerde yok (takip no başına tek ölçüm).
function confidenceOf(L, r, isDup, localDup, repeated) {
  if (r.status !== 'DIFF') return null;
  if (isDup) {
    const prior = LINE_BY_KEY[L.spec.dupOf];
    if (localDup || repeated) return { confidence: 'LOW', reviewCode: 'DUPLICATE' };
    if (!prior || prior.netC !== L.netC) return { confidence: 'LOW', reviewCode: 'DUPLICATE' };
    return null;
  }
  if (repeated && r.diffTypes.length) return { confidence: 'LOW', reviewCode: 'MULTI_PARCEL' };
  return null;
}
function runInvoice(inv, crossInvoice) {
  const t = TARIFF[inv.carrier];
  const out = [];
  const seenLocal = new Set();
  const inFile = new Map();
  for (const L of inv.built) if (L.netC > 0) inFile.set(L.trackingNo, (inFile.get(L.trackingNo) ?? 0) + 1);
  inv.built.forEach((L, i) => {
    const m = MEAS_BY_KEY[L.spec.dupOf ?? L.key];
    const meas = L.spec.sc === 'UNMATCHED' ? null : (m ? { dims: m.dims, kg: m.kg } : null);
    const localDup = seenLocal.has(L.trackingNo);
    const isDup = localDup || (crossInvoice && seenTracking.has(L.trackingNo) && seenTracking.get(L.trackingNo) !== inv.id);
    // when evaluating the dup line itself, billed comps equal the original
    const r = compare(L, meas, t, isDup);
    const c = confidenceOf(L, r, isDup, localDup, (inFile.get(L.trackingNo) ?? 0) > 1);
    if (c) Object.assign(r, c);
    seenLocal.add(L.trackingNo);
    const exp = SCEN_STATUS[L.spec.sc];
    out.push({ L, r, i, isDup });
    if (!crossInvoice) return;
    assert(r.status === exp, `${inv.id} ${L.key} expected ${exp} got ${r.status} ${r.diffTypes} diff=${r.diffC}`);
  });
  return out;
}
// standalone run (no cross-invoice dups) then ordered run
const ORDER = ['fedex-9-482-11735', 'fedex-9-482-11736', 'ups-0000F4A71X', 'dhl-SIN-4471029', 'aras-ARS-2026-004871', 'yurtici-YK-2026-118833', 'mng-MNG-2026-77120'];
const standalone = {};
for (const inv of INV) standalone[inv.id] = runInvoice({ ...inv, built: inv.built.map((L) => ({ ...L })) }, false).map((x) => x.r);
for (const id of ORDER) {
  const inv = INV.find((x) => x.id === id);
  RESULTS[id] = runInvoice(inv, true);
  for (const L of inv.built) if (!seenTracking.has(L.trackingNo)) seenTracking.set(L.trackingNo, inv.id);
}

// wiki pins
{
  const R = RESULTS['fedex-9-482-11735'];
  const g = (k) => R.find((x) => x.L.key === k).r;
  assert(g('f5305').expectedC === 118400 && g('f5305').billedC === 164250 && g('f5305').diffC === 45850, '5305');
  assert(g('f5299').diffC === 9640, '5299 ' + g('f5299').diffC);
  assert(g('f5293').diffC === 41200, '5293');
  assert(g('f5290').diffC === 5630, '5290 ' + g('f5290').diffC);
  assert(g('f5288d').diffC === 112000 && g('f5288').expectedC === 112000, '5288');
  const over = R.filter((x) => x.r.status === 'DIFF').reduce((a, x) => a + x.r.diffC, 0);
  assert(over === 214320, 'all diffs 2143.20 got ' + over);
  // KALANLAR 1.8: #5288'in ikinci satırı aynı dosyada → "İncele"; Fazla ödeme (kesin) 1.023,20, İncele 1.120,00
  assert(g('f5288d').confidence === 'LOW', '5288 review');
  const firm = R.filter((x) => x.r.status === 'DIFF' && x.r.confidence !== 'LOW').reduce((a, x) => a + x.r.diffC, 0);
  assert(firm === 102320, 'firm overcharge 1023.20 got ' + firm);
  // önceki faturadaki aynı tutarlı mükerrer (11736 #7, 11735'te 5287) kesin kalır
  assert(RESULTS['fedex-9-482-11736'].find((x) => x.L.key === 'f5287x').r.confidence == null, '5287x firm');
  assert(g('f5295').expectedC === 118400, '6kg A');
  assert(priceCents(TARIFF.fedex, 'A', 6.0).total === 118400 && priceCents(TARIFF.fedex, 'A', 6.0).base === 152775, 'pin');
}

// ---------------------------------------------------------------- writers: tariffs / measurements
w('seed-tariffs.json', JSON.stringify(CARRIERS, null, 2) + '\n');
w('seed-measurements.json', JSON.stringify(MEAS, null, 2) + '\n');

// ---------------------------------------------------------------- invoice files
const PII = [
  ['Jean Dupont', '12 Rue de la Paix', 'Paris', '75002'], ['Anna Schmidt', 'Hauptstrasse 45', 'Berlin', '10115'], ['Pieter de Vries', 'Keizersgracht 210', 'Amsterdam', '1016'],
  ['Marco Rossi', 'Via Roma 8', 'Milano', '20121'], ['John Smith', '455 Madison Ave', 'New York', '10022'], ['Emily Clark', '22 Baker Street', 'London', 'NW1 6XE'],
  ['Lucia Garcia', 'Calle Mayor 17', 'Madrid', '28013'], ['Hans Keller', 'Bahnhofstrasse 3', 'Zurich', '8001'], ['Sophie Martin', '5 Avenue Louise', 'Brussels', '1050'],
];
const pii = (i) => PII[i % PII.length];
const TRNAMES = ['Ayşe Yılmaz', 'Mehmet Kaya', 'Fatma Demir', 'Ali Çelik', 'Zeynep Şahin', 'Mustafa Öztürk', 'Elif Arslan', 'Hüseyin Doğan', 'Merve Aydın'];
const trName = (i) => TRNAMES[i % TRNAMES.length];
const COUNTRY_NAME = { FR: 'France', DE: 'Germany', NL: 'Netherlands', BE: 'Belgium', IT: 'Italy', ES: 'Spain', GB: 'United Kingdom', CH: 'Switzerland', US: 'United States', CA: 'Canada', AU: 'Australia' };
const f2 = (c) => E(c);
const csvCell = (v, d) => { const s = v == null ? '' : String(v); return /["\n\r]/.test(s) || s.includes(d) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows, d = ',') => rows.map((r) => r.map((c) => csvCell(c, d)).join(d)).join('\r\n') + '\r\n';

async function writeXlsx(rel, sheetName, rowsArr, opts = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rowsArr.forEach((r) => ws.addRow(r));
  if (opts.headerRow) { const hr = ws.getRow(opts.headerRow); hr.font = { bold: true }; }
  (opts.widths ?? []).forEach((wd, i) => { ws.getColumn(i + 1).width = wd; });
  (opts.dateCols ?? []).forEach((c) => { ws.getColumn(c).numFmt = 'dd.mm.yyyy'; });
  await wb.xlsx.writeFile(path.join(ROOT, rel));
}
const utcDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const trDate = (iso) => iso.split('-').reverse().join('.');

const MAPPINGS = {};
const FILEINFO = {};

async function buildFedexCsv(inv) {
  const H = ['Invoice Number', 'Invoice Date', 'Tracking ID', 'Shipment Date', 'Service Type', 'Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient Postal Code', 'Recipient Country/Territory', 'Actual Weight', 'Rated Weight', 'Dim Length', 'Dim Width', 'Dim Height', 'Dim Divisor', 'Transportation Charge Amount', 'Discount', 'Fuel Surcharge', 'Address Correction', 'Remote Area Surcharge', 'Additional Handling', 'Net Charge Amount', 'Currency', 'Customer Reference'];
  const rows = [H];
  inv.built.forEach((L, i) => {
    const p = pii(i), sc = L.surchargesC;
    rows.push([inv.invoiceNo, inv.invoiceDate, L.trackingNo, L.shipDate, 'FedEx International Economy', p[0], p[1], p[2], p[3], L.dest, f2(C(L.billedActual)).toFixed(1), L.billedCh.toFixed(1),
      L.billedDims?.[0] ?? '', L.billedDims?.[1] ?? '', L.billedDims?.[2] ?? '', 5000, f2(L.baseC).toFixed(2), (-f2(L.discC)).toFixed(2), f2(L.fuelC).toFixed(2),
      sc.ADDRESS_CORRECTION != null ? f2(sc.ADDRESS_CORRECTION).toFixed(2) : '', sc.REMOTE_AREA != null ? f2(sc.REMOTE_AREA).toFixed(2) : '', sc.ADDITIONAL_HANDLING != null ? f2(sc.ADDITIONAL_HANDLING).toFixed(2) : '',
      f2(L.netC).toFixed(2), 'TRY', L.reference]);
  });
  w('invoices/' + inv.file, '\uFEFF' + toCsv(rows));
  MAPPINGS[inv.id] = { trackingNo: 'Tracking ID', netAmount: 'Net Charge Amount', shipDate: 'Shipment Date', service: 'Service Type', destCountry: 'Recipient Country/Territory', actualKg: 'Actual Weight', billedKg: 'Rated Weight', dimL: 'Dim Length', dimW: 'Dim Width', dimH: 'Dim Height', billedDivisor: 'Dim Divisor', baseAmount: 'Transportation Charge Amount', discountAmount: 'Discount', fuelAmount: 'Fuel Surcharge', currency: 'Currency', reference: 'Customer Reference', surchargeColumns: [{ header: 'Address Correction', code: 'ADDRESS_CORRECTION' }, { header: 'Remote Area Surcharge', code: 'REMOTE_AREA' }, { header: 'Additional Handling', code: 'ADDITIONAL_HANDLING' }] };
  FILEINFO[inv.id] = { delimiter: ',', encoding: 'utf-8 (BOM)', numberFormat: 'dot-decimal', dateFormat: 'YYYY-MM-DD', piiColumns: ['Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient Postal Code'], notes: 'Discount column is NEGATIVE (FedEx style).' };
}
async function buildFedexXlsx(inv) {
  const H = ['Invoice Number', 'Invoice Date', 'Express or Ground Tracking ID', 'Shipment Date', 'Service Type', 'Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient Postal Code', 'Recipient Country', 'Actual Weight', 'Rated Weight', 'Dim Length', 'Dim Width', 'Dim Height', 'Dim Divisor', 'Transportation Charge', 'Discount', 'Fuel Surcharge', 'Address Correction', 'Residential Surcharge', 'Remote Area Surcharge', 'Additional Handling', 'Net Charge Amount', 'Currency', 'Customer Reference'];
  const rows = [H];
  inv.built.forEach((L, i) => {
    const p = pii(i + 3), sc = L.surchargesC, n = (c) => (c != null ? f2(c) : null);
    rows.push([inv.invoiceNo, inv.invoiceDate, L.trackingNo, L.shipDate, 'FedEx International Economy', p[0], p[1], p[2], p[3], L.dest, L.billedActual, L.billedCh,
      L.billedDims?.[0] ?? null, L.billedDims?.[1] ?? null, L.billedDims?.[2] ?? null, 5000, f2(L.baseC), -f2(L.discC), f2(L.fuelC), n(sc.ADDRESS_CORRECTION), n(sc.RESIDENTIAL), n(sc.REMOTE_AREA), n(sc.ADDITIONAL_HANDLING), f2(L.netC), 'TRY', L.reference]);
  });
  await writeXlsx('invoices/' + inv.file, 'Invoice Detail', rows, { headerRow: 1, widths: H.map(() => 18) });
  MAPPINGS[inv.id] = { trackingNo: 'Express or Ground Tracking ID', netAmount: 'Net Charge Amount', shipDate: 'Shipment Date', service: 'Service Type', destCountry: 'Recipient Country', actualKg: 'Actual Weight', billedKg: 'Rated Weight', dimL: 'Dim Length', dimW: 'Dim Width', dimH: 'Dim Height', billedDivisor: 'Dim Divisor', baseAmount: 'Transportation Charge', discountAmount: 'Discount', fuelAmount: 'Fuel Surcharge', currency: 'Currency', reference: 'Customer Reference', surchargeColumns: [{ header: 'Address Correction', code: 'ADDRESS_CORRECTION' }, { header: 'Residential Surcharge', code: 'RESIDENTIAL' }, { header: 'Remote Area Surcharge', code: 'REMOTE_AREA' }, { header: 'Additional Handling', code: 'ADDITIONAL_HANDLING' }] };
  FILEINFO[inv.id] = { sheet: 'Invoice Detail', numbers: 'numeric cells', dates: 'ISO text', piiColumns: ['Recipient Name', 'Recipient Address', 'Recipient City', 'Recipient Postal Code'], notes: 'Discount column is NEGATIVE. Empty surcharge cells are blank.' };
}
async function buildUps(inv) {
  const H = ['Invoice Number', 'Invoice Date', 'Tracking Number', 'Pickup Date', 'Service', 'Receiver Name', 'Receiver Address', 'Receiver City', 'Receiver Country', 'Entered Weight', 'Billed Weight', 'Length', 'Width', 'Height', 'Published Charge', 'Incentive Credit', 'Fuel Surcharge', 'Delivery Area Surcharge', 'Large Package Surcharge', 'Address Correction', 'Net Amount', 'Currency', 'Reference 1'];
  const rows = [H];
  inv.built.forEach((L, i) => {
    const p = pii(i + 5), sc = L.surchargesC, n = (c) => (c != null ? f2(c) : null);
    rows.push([inv.invoiceNo, inv.invoiceDate, L.trackingNo, L.shipDate, 'UPS Express Saver', p[0], p[1], p[2], L.dest, L.billedActual, L.billedCh, L.billedDims?.[0] ?? null, L.billedDims?.[1] ?? null, L.billedDims?.[2] ?? null,
      f2(L.baseC), -f2(L.discC), f2(L.fuelC), n(sc.DELIVERY_AREA), n(sc.LARGE_PACKAGE), n(sc.ADDRESS_CORRECTION), f2(L.netC), 'TRY', L.reference]);
  });
  await writeXlsx('invoices/' + inv.file, 'Charges', rows, { headerRow: 1, widths: H.map(() => 18) });
  MAPPINGS[inv.id] = { trackingNo: 'Tracking Number', netAmount: 'Net Amount', shipDate: 'Pickup Date', service: 'Service', destCountry: 'Receiver Country', actualKg: 'Entered Weight', billedKg: 'Billed Weight', dimL: 'Length', dimW: 'Width', dimH: 'Height', baseAmount: 'Published Charge', discountAmount: 'Incentive Credit', fuelAmount: 'Fuel Surcharge', currency: 'Currency', reference: 'Reference 1', surchargeColumns: [{ header: 'Delivery Area Surcharge', code: 'DELIVERY_AREA' }, { header: 'Large Package Surcharge', code: 'LARGE_PACKAGE' }, { header: 'Address Correction', code: 'ADDRESS_CORRECTION' }] };
  FILEINFO[inv.id] = { sheet: 'Charges', piiColumns: ['Receiver Name', 'Receiver Address', 'Receiver City'], notes: 'Incentive Credit is NEGATIVE. No Dim Divisor column (tariff divisor 5000 applies).' };
}
async function buildDhl(inv) {
  const H = ['Invoice Number', 'Invoice Date', 'Waybill Number', 'Shipment Date', 'Product', 'Consignee Name', 'Consignee Address', 'Consignee City', 'Destination Country', 'Actual Weight (kg)', 'Chargeable Weight (kg)', 'Length (cm)', 'Width (cm)', 'Height (cm)', 'Weight Charge', 'Discount', 'Fuel Surcharge', 'Remote Area Delivery', 'Emergency Situation', 'Total Amount (excl. VAT)', 'Currency', 'Shipper Reference'];
  const rows = [H];
  inv.built.forEach((L, i) => {
    const p = pii(i + 1), sc = L.surchargesC, n = (c) => (c != null ? f2(c).toFixed(2) : '');
    rows.push([inv.invoiceNo, inv.invoiceDate, L.trackingNo, L.shipDate, 'EXPRESS WORLDWIDE', p[0], p[1], p[2], L.dest, L.billedActual.toFixed(1), L.billedCh.toFixed(1), L.billedDims?.[0] ?? '', L.billedDims?.[1] ?? '', L.billedDims?.[2] ?? '',
      f2(L.baseC).toFixed(2), (-f2(L.discC)).toFixed(2), f2(L.fuelC).toFixed(2), n(sc.REMOTE_AREA), n(sc.EMERGENCY_SITUATION), f2(L.netC).toFixed(2), 'TRY', L.reference]);
  });
  w('invoices/' + inv.file, toCsv(rows));
  MAPPINGS[inv.id] = { trackingNo: 'Waybill Number', netAmount: 'Total Amount (excl. VAT)', shipDate: 'Shipment Date', service: 'Product', destCountry: 'Destination Country', actualKg: 'Actual Weight (kg)', billedKg: 'Chargeable Weight (kg)', dimL: 'Length (cm)', dimW: 'Width (cm)', dimH: 'Height (cm)', baseAmount: 'Weight Charge', discountAmount: 'Discount', fuelAmount: 'Fuel Surcharge', currency: 'Currency', reference: 'Shipper Reference', surchargeColumns: [{ header: 'Remote Area Delivery', code: 'REMOTE_AREA' }, { header: 'Emergency Situation', code: 'EMERGENCY_SITUATION' }] };
  FILEINFO[inv.id] = { delimiter: ',', encoding: 'utf-8', numberFormat: 'dot-decimal', dateFormat: 'YYYY-MM-DD', piiColumns: ['Consignee Name', 'Consignee Address', 'Consignee City'], notes: 'Discount is NEGATIVE.' };
}

const VAT = 1.2;
const withVat = (c) => Math.round(c * VAT); // cents; round-trips through /1.2 back to the same net cent
function domesticParts(L) {
  const sc = L.surchargesC;
  const sur = Object.values(sc).reduce((a, b) => a + b, 0);
  const navlun = L.netC - sur; // freight (after discount + fuel)
  const net = L.netC;
  const tot = withVat(net);
  assert(Math.round(tot / VAT) === net, 'vat roundtrip');
  return { navlun, sur, net, tot, kdv: tot - net };
}
async function buildAras(inv) {
  const pre = [['ARAS KARGO A.Ş. - FATURA DÖKÜMÜ'], ['Fatura No: ' + inv.invoiceNo], ['Fatura Tarihi: ' + trDate(inv.invoiceDate)], ['Müşteri: Demo İhracat'], []];
  const H = ['Gönderi No', 'Çıkış Tarihi', 'Alıcı', 'Alıcı İl', 'Ölçü (cm)', 'Kg', 'Desi', 'Navlun', 'Kapıda Ödeme Bedeli', 'Adres Düzeltme Bedeli', 'KDV', 'Toplam', 'Referans'];
  const rows = [...pre, H];
  let sN = 0, sK = 0, sT = 0;
  inv.built.forEach((L, i) => {
    const d = domesticParts(L), sc = L.surchargesC;
    sN += d.navlun; sK += d.kdv; sT += d.tot;
    rows.push([L.trackingNo, trDate(L.shipDate), trName(i), L.city, L.billedDims ? L.billedDims.join('x') : '', trKg(L.billedActual.toFixed(2)), L.billedCh, tr(f2(d.navlun)),
      sc.KAPIDA_ODEME != null ? tr(f2(sc.KAPIDA_ODEME)) : '', sc.ADRES_DUZELTME != null ? tr(f2(sc.ADRES_DUZELTME)) : '', tr(f2(d.kdv)), tr(f2(d.tot)), L.reference]);
  });
  rows.push(['', '', 'TOPLAM', '', '', '', '', tr(f2(sN)), '', '', tr(f2(sK)), tr(f2(sT)), '']);
  await writeXlsx('invoices/' + inv.file, 'Fatura', rows, { headerRow: pre.length + 1, widths: [18, 12, 18, 12, 14, 8, 8, 12, 14, 14, 10, 12, 16] });
  MAPPINGS[inv.id] = { trackingNo: 'Gönderi No', netAmount: 'Toplam', amountsIncludeVat: true, vatPct: 20, shipDate: 'Çıkış Tarihi', actualKg: 'Kg', billedKg: 'Desi', desiAsWeight: true, dims: 'Ölçü (cm)', reference: 'Referans', surchargeColumns: [{ header: 'Kapıda Ödeme Bedeli', code: 'KAPIDA_ODEME' }, { header: 'Adres Düzeltme Bedeli', code: 'ADRES_DUZELTME' }] };
  FILEINFO[inv.id] = { sheet: 'Fatura', headerRowIndex1Based: pre.length + 1, preambleRows: pre.length, totalRow: true, numbers: 'TEXT cells in Turkish format "1.234,56"', dates: 'TEXT "27.10.2026"', amountsIncludeVat: true, piiColumns: ['Alıcı', 'Alıcı İl'], notes: 'netAmount mapped to "Toplam" (KDV dahil, 20%); core must divide by 1,2. Surcharge columns are KDV hariç. Dims in a single cell "45x35x30" (empty when not reported).' };
}
async function buildYurtici(inv) {
  const H = ['Takip No', 'Gönderi Tarihi', 'Alıcı Adı', 'Varış Şehri', 'En', 'Boy', 'Yükseklik', 'Gerçek Ağırlık (kg)', 'Desi', 'Taşıma Bedeli', 'Kapıda Ödeme Hizmeti', 'Adres Değişikliği', 'Tutar (KDV Hariç)', 'KDV (%20)', 'Genel Toplam', 'Müşteri Referansı'];
  const rows = [H];
  let sT = 0, sK = 0, sG = 0;
  inv.built.forEach((L, i) => {
    const d = domesticParts(L), sc = L.surchargesC;
    sT += d.net; sK += d.kdv; sG += d.tot;
    rows.push([L.trackingNo, utcDate(L.shipDate), trName(i + 2), L.city, L.billedDims?.[0] ?? null, L.billedDims?.[1] ?? null, L.billedDims?.[2] ?? null, L.billedActual, L.billedCh, f2(d.navlun),
      sc.KAPIDA_ODEME != null ? f2(sc.KAPIDA_ODEME) : null, sc.ADRES_DEGISIKLIGI != null ? f2(sc.ADRES_DEGISIKLIGI) : null, f2(d.net), f2(d.kdv), f2(d.tot), L.reference]);
  });
  rows.push([null, null, 'GENEL TOPLAM', null, null, null, null, null, null, null, null, null, f2(sT), f2(sK), f2(sG), null]);
  await writeXlsx('invoices/' + inv.file, 'Fatura Detay', rows, { headerRow: 1, dateCols: [2], widths: H.map(() => 16) });
  MAPPINGS[inv.id] = { trackingNo: 'Takip No', netAmount: 'Tutar (KDV Hariç)', amountsIncludeVat: false, shipDate: 'Gönderi Tarihi', actualKg: 'Gerçek Ağırlık (kg)', billedKg: 'Desi', desiAsWeight: true, dimL: 'En', dimW: 'Boy', dimH: 'Yükseklik', reference: 'Müşteri Referansı', surchargeColumns: [{ header: 'Kapıda Ödeme Hizmeti', code: 'KAPIDA_ODEME' }, { header: 'Adres Değişikliği', code: 'ADRES_DEGISIKLIGI' }] };
  FILEINFO[inv.id] = { sheet: 'Fatura Detay', numbers: 'real numeric cells', dates: 'real Date cells formatted dd.mm.yyyy', amountsIncludeVat: false, totalRow: true, piiColumns: ['Alıcı Adı', 'Varış Şehri'], notes: 'Net = "Tutar (KDV Hariç)"; also has KDV and Genel Toplam. "Taşıma Bedeli" is freight excluding surcharges.' };
}
async function buildMng(inv) {
  const H = ['Gönderi No', 'Tarih', 'Alıcı Adı', 'Alıcı Adresi', 'Gerçek Kg', 'Desi', 'Tutar', 'Kapıda Ödeme', 'Adres Düzeltme', 'KDV', 'Toplam', 'Referans No'];
  const rows = [H];
  let sT = 0, sK = 0, sG = 0;
  inv.built.forEach((L, i) => {
    const d = domesticParts(L), sc = L.surchargesC;
    sT += d.net; sK += d.kdv; sG += d.tot;
    rows.push([L.trackingNo, trDate(L.shipDate), trName(i + 4), L.city + ' Mah. No:' + (10 + i), trKg(L.billedActual.toFixed(2)), L.billedCh, tr(f2(d.net)),
      sc.KAPIDA_ODEME != null ? tr(f2(sc.KAPIDA_ODEME)) : '', sc.ADRES_DUZELTME != null ? tr(f2(sc.ADRES_DUZELTME)) : '', tr(f2(d.kdv)), tr(f2(d.tot)), L.reference]);
  });
  rows.push(['', '', 'TOPLAM', '', '', '', tr(f2(sT)), '', '', tr(f2(sK)), tr(f2(sG)), '']);
  w('invoices/' + inv.file, '\uFEFF' + toCsv(rows, ';'));
  MAPPINGS[inv.id] = { trackingNo: 'Gönderi No', netAmount: 'Tutar', amountsIncludeVat: false, shipDate: 'Tarih', actualKg: 'Gerçek Kg', billedKg: 'Desi', desiAsWeight: true, reference: 'Referans No', surchargeColumns: [{ header: 'Kapıda Ödeme', code: 'KAPIDA_ODEME' }, { header: 'Adres Düzeltme', code: 'ADRES_DUZELTME' }] };
  FILEINFO[inv.id] = { delimiter: ';', encoding: 'utf-8 (BOM)', numberFormat: 'Turkish "1.234,56"', dateFormat: 'DD.MM.YYYY', amountsIncludeVat: false, totalRow: true, piiColumns: ['Alıcı Adı', 'Alıcı Adresi'], notes: 'Net = "Tutar" (KDV hariç); KDV and Toplam columns also present. No dimension columns.' };
}

const BUILDERS = { 'fedex-9-482-11735': buildFedexCsv, 'fedex-9-482-11736': buildFedexXlsx, 'ups-0000F4A71X': buildUps, 'dhl-SIN-4471029': buildDhl, 'aras-ARS-2026-004871': buildAras, 'yurtici-YK-2026-118833': buildYurtici, 'mng-MNG-2026-77120': buildMng };
fs.mkdirSync(path.join(ROOT, 'invoices'), { recursive: true });
for (const inv of INV) await BUILDERS[inv.id](inv);

// ---------------------------------------------------------------- expected.json / EXPECTED.md
const SC_NOTE = { DIMENSION: 'DIMENSION', WEIGHT: 'WEIGHT', SURCHARGE: 'SURCHARGE', PRICE: 'PRICE', DUP: 'DUPLICATE' };
const EXPECTED = { generatedBy: 'samples/tools/generate.mjs', tolerances: TOL, uploadOrder: ORDER, currency: 'TRY', invoices: [] };
const md = [];
md.push('# EXPECTED — golden data for the sample invoices\n');
md.push('Generated by `samples/tools/generate.mjs` (do not edit by hand). Tolerances: edgeTolCm=1, weightTolKg=0.1, amountTol=5. All amounts TRY, KDV hariç (net).\n');
md.push('Upload order assumed for cross-invoice duplicate detection: ' + ORDER.join(' -> ') + '. Every other invoice is independent of the rest.\n');
md.push('Definitions: `billedTotal` = sum of all line net amounts; `expectedTotal` = sum of non-null expectedAmount; `overchargeTotal` = sum of positive diffAmount over firm DIFF lines (MATCH lines with small +/- diff and "İncele" lines are not counted); `verifiedTotal` = 0 (no decisions). `reviewTotals.estimatedOverchargeTotal` / `estimatedLines` = the same sum / count over "İncele" (`confidence: LOW`) DIFF lines.\n');
md.push('"İncele" (KALANLAR 1.8, owner decision 2026-11-14): a tracking number on more than one charge line of the same file makes none of its differences firm. Every sample file repeats one tracking number, so its second line (DUPLICATE) is "İncele" (`reviewCode` DUPLICATE) and stays out of `overchargeTotal`; the first line is MATCH and is not flagged. The cross-invoice duplicate in 11736 (same carrier, amount and description as in 11735) stays firm.\n');
for (const id of ORDER) {
  const inv = INV.find((x) => x.id === id);
  const res = RESULTS[id];
  const lines = res.map(({ L, r, i }) => {
    const st = standalone[id][i];
    const o = {
      row: i + 1, trackingNo: L.trackingNo, scenario: L.spec.sc, status: r.status, diffTypes: r.diffTypes,
      ourChargeableKg: r.ourChargeableKg, billedChargeableKg: r.billedChargeableKg,
      expectedAmount: r.expectedC == null ? null : E(r.expectedC), billedAmount: E(r.billedC), diffAmount: r.diffC == null ? null : E(r.diffC),
    };
    if (r.note) o.note = r.note;
    if (r.confidence === 'LOW') { o.confidence = 'LOW'; o.reviewCode = r.reviewCode; }
    if (L.spec.sc === 'DUP') o.duplicateOfRow = inv.built.findIndex((x) => x.key === L.spec.dupOf) + 1 || null;
    if (L.spec.crossInvoice) { o.crossInvoiceDuplicateOf = L.spec.crossInvoice; o.standaloneStatus = st.status; o.standaloneDiffTypes = st.diffTypes; o.standaloneExpectedAmount = st.expectedC == null ? null : E(st.expectedC); o.standaloneDiffAmount = st.diffC == null ? null : E(st.diffC); }
    if (L.spec.wiki) o.wiki = L.spec.wiki;
    return o;
  });
  const cnt = (s) => lines.filter((l) => l.status === s).length;
  const totals = {
    lines: lines.length, match: cnt('MATCH'), diff: cnt('DIFF'), unmatched: cnt('UNMATCHED'), noTariff: cnt('NO_TARIFF'),
    billedTotal: E(res.reduce((a, x) => a + x.r.billedC, 0)),
    expectedTotal: E(res.reduce((a, x) => a + (x.r.expectedC ?? 0), 0)),
    overchargeTotal: E(res.filter((x) => x.r.status === 'DIFF' && x.r.confidence !== 'LOW' && x.r.diffC > 0).reduce((a, x) => a + x.r.diffC, 0)),
    verifiedTotal: 0,
  };
  const review = res.filter((x) => x.r.status === 'DIFF' && x.r.confidence === 'LOW');
  const reviewTotals = { estimatedOverchargeTotal: E(review.filter((x) => x.r.diffC > 0).reduce((a, x) => a + x.r.diffC, 0)), estimatedLines: review.length };
  const entry = {
    id, file: 'invoices/' + inv.file, carrierCode: inv.carrier, tariff: TARIFF[inv.carrier].name, invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, currency: 'TRY',
    suggestedMapping: MAPPINGS[id], fileInfo: FILEINFO[id], lines, totals, reviewTotals,
  };
  EXPECTED.invoices.push(entry);
  // markdown
  md.push(`\n## ${inv.file}  (${inv.carrier}, fatura ${inv.invoiceNo}, ${inv.invoiceDate})\n`);
  md.push(`Tariff: ${TARIFF[inv.carrier].name}. Totals: lines ${totals.lines}, match ${totals.match}, diff ${totals.diff}, unmatched ${totals.unmatched}, noTariff ${totals.noTariff}; billed ${totals.billedTotal.toFixed(2)}, expected ${totals.expectedTotal.toFixed(2)}, overcharge ${totals.overchargeTotal.toFixed(2)}; İncele ${reviewTotals.estimatedOverchargeTotal.toFixed(2)} (${reviewTotals.estimatedLines} line).\n`);
  md.push('| # | Tracking | Status | Types | Our kg | Billed kg | Expected | Billed | Diff | Note |');
  md.push('|--:|---|---|---|--:|--:|--:|--:|--:|---|');
  const n2 = (v) => (v == null ? '-' : v.toFixed(2)), k = (v) => (v == null ? '-' : v.toFixed(1));
  for (const l of lines) md.push(`| ${l.row} | ${l.trackingNo} | ${l.status} | ${l.diffTypes.join('+') || '-'} | ${k(l.ourChargeableKg)} | ${k(l.billedChargeableKg)} | ${n2(l.expectedAmount)} | ${n2(l.billedAmount)} | ${n2(l.diffAmount)} | ${[l.confidence === 'LOW' ? 'İncele (' + l.reviewCode + ')' : '', l.note, l.wiki, l.crossInvoiceDuplicateOf ? 'dup of ' + l.crossInvoiceDuplicateOf + ' (standalone: ' + l.standaloneStatus + ')' : ''].filter(Boolean).join('; ')} |`);
}
w('expected.json', JSON.stringify(EXPECTED, null, 2) + '\n');
w('EXPECTED.md', md.join('\n') + '\n');

// ---------------------------------------------------------------- tariff template example (SPEC §5.7)
{
  const t = CARRIERS[0].tariffs[0];
  const zonesList = [...new Set(t.rates.map((r) => r.zone))];
  const wts = [...new Set(t.rates.map((r) => r.weightUpto))].sort((a, b) => a - b);
  const wb = new ExcelJS.Workbook();
  const f = wb.addWorksheet('Fiyatlar');
  f.addRow(['Ağırlık (kg/desi) ≤', ...zonesList]);
  for (const wt of wts) f.addRow([wt, ...zonesList.map((z) => t.rates.find((r) => r.zone === z && r.weightUpto === wt).price)]);
  f.getRow(1).font = { bold: true }; f.columns.forEach((c) => (c.width = 20));
  const b = wb.addWorksheet('Bölgeler'); b.addRow(['Ülke kodu', 'Bölge']); t.zones.forEach((z) => b.addRow([z.country, z.zone])); b.getRow(1).font = { bold: true }; b.columns.forEach((c) => (c.width = 14));
  const e = wb.addWorksheet('Ek ücretler'); e.addRow(['Kod', 'Ad', 'Tür', 'Tutar']); t.surcharges.forEach((s) => e.addRow([s.code, s.name, s.kind, s.amount])); e.getRow(1).font = { bold: true }; e.columns.forEach((c) => (c.width = 28));
  await wb.xlsx.writeFile(path.join(ROOT, 'tariff-template-example.xlsx'));
}

console.log('OK', { measurements: MEAS.length, invoices: EXPECTED.invoices.map((i) => `${i.id}: ${JSON.stringify({ ...i.totals, ...i.reviewTotals })}`) });
