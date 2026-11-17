import i18next from 'i18next';
import type { EdgeRounding, ImportIssue, SurchargeKind, Tariff, TariffBody } from '../../api/types';
import { getFormatLocale, numToInput, parseTrNumber } from '../../lib/format';
import { relocalizeNumberText, relocalizeWeightText, weightChoice, weightChoiceLabel } from '../../lib/weightChoice';
import type { Locale, TariffScope } from '@deciship/core';
import { INTERNATIONAL_DIVISOR, canonicalSurchargeCode, carrierScope, currencySymbol, cleanZoneLabel, convertPastedNumber, otherCurrencyCheckSection, parseNumberAs, parseTrNumber as coreParseNumber, readPastedNumbers, scopeDivisor, scopeFuelVariable, zoneKey } from '@deciship/core';

const tr = (key: string, opts?: Record<string, unknown>) => i18next.t(key, { ns: 'tariffEditor', ...opts });

export interface Draft {
  carrierId: string;
  name: string;
  service: string;
  currency: string;
  divisor: string;
  edgeRounding: EdgeRounding;
  steps: { upto: string; step: string }[];
  discountPct: string;
  fuelPct: string;
  /** undefined = seçilmedi (yeni tarife; sunucu taşıyıcıya göre atar). */
  fuelVariable?: boolean;
  /**
   * Yalnız yeni tarifede: bölen ve yakıt türünün dayandığı kapsam (yurt içi 3000 + sabit, yurt dışı 5000 + değişken;
   * KALANLAR 1.1). Taşıyıcı yüklenince ya da kişi seçince dolar; kayıtlı tarifede yok (gövdeye girmez).
   */
  scope?: TariffScope;
  validFrom: string;
  validTo: string;
  active: boolean;
  isDefault: boolean;
  zones: string[];
  rows: Row[];
  overflow: string[];
  /**
   * Ülke → bölge SÜTUNU (`zones` içindeki sıra; -1 = tabloda olmayan bölge). Ada değil sütuna bağlıdır: bölge adı yazılırken
   * bir an başka bölgenin adına denk gelse de ülkeler yer değiştirmez (rapor 10-B1). Ad yalnız kayıtta (`toBody`) yazılır.
   */
  countryZones: { country: string; zone: number }[];
  surcharges: { code: string; name: string; kind: SurchargeKind; amount: string }[];
  /** SPEC §3.8 ülke istisnaları; `pct` işaretli yüzde metni ("-15,45") */
  adjustments: { country: string; pct: string; note: string; source: 'manual' | 'invoice'; invoiceId: string | null }[];
}

interface Row {
  upto: string;
  prices: string[];
  /** fiyatlar bu bantta kg başı (ör. 71–99 kg: 7,27 $/kg) */
  perKg: boolean;
}
export const emptyRow = (n = 0): Row => ({ upto: '', prices: Array.from({ length: n }, () => ''), perKg: false });

/** Yakıt varsayılanı: yurt içi taşıyıcılarda sözleşmede sabit, yurt dışında değişken (core `carrierScope`; "Diğer" adıyla). */
export const defaultFuelVariable = (carrier: { code: string; name?: string } | undefined): boolean | undefined =>
  carrier === undefined ? undefined : scopeFuelVariable(carrierScope(carrier));

/** Kapsam seçimi yalnız kapsamı koddan belli olmayan taşıyıcıda görünür: PTT (yurt dışı gönderisi de var) ve "Diğer". */
export const scopeChoosable = (code: string | undefined) => code === 'ptt' || code === 'generic';

/** Kapsamın bölen ve yakıt türü taslağa yazılır (kişinin seçimi ya da taşıyıcının varsayılanı). */
export function applyScope(d: Draft, scope: TariffScope): Draft {
  return { ...d, scope, divisor: String(scopeDivisor(scope)), fuelVariable: scopeFuelVariable(scope) };
}

/**
 * Yeni tarifede taşıyıcı (ilk yüklenen ya da seçilen): bölen ve yakıt kapsamın varsayılanında duruyorsa (kişi elle
 * değiştirmediyse) yeni taşıyıcının kapsamına geçer; değiştirdiyse yalnız taşıyıcı değişir.
 */
export function withCarrier(d: Draft, carrier: { id: string; code: string; name?: string }): Draft {
  const next = { ...d, carrierId: carrier.id };
  const untouched = d.scope === undefined || (d.divisor === String(scopeDivisor(d.scope)) && d.fuelVariable === scopeFuelVariable(d.scope));
  return untouched ? applyScope(next, carrierScope(carrier)) : next;
}

export function newDraft(carrierId: string, currency: string): Draft {
  return {
    carrierId,
    name: '',
    service: '',
    currency,
    divisor: String(INTERNATIONAL_DIVISOR),
    edgeRounding: 'CEIL_CM',
    steps: [
      { upto: '20', step: '0,5' },
      { upto: '', step: '1' },
    ],
    discountPct: '0',
    fuelPct: '0',
    validFrom: '',
    validTo: '',
    active: true,
    isDefault: true,
    zones: ['A', 'B'],
    rows: [0.5, 1, 1.5, 2, 2.5].map((w) => ({ upto: numToInput(w), prices: ['', ''], perKg: false })),
    overflow: ['', ''],
    countryZones: [{ country: '*', zone: 0 }],
    surcharges: [],
    adjustments: [],
  };
}

export function fromTariff(t: Tariff): Draft {
  // "Zone A" (older imports) and "A" (country mapping) are the same zone → one column, labelled "A"
  const labels = new Map<string, string>();
  const lab = (z: string) => {
    const k = zoneKey(z);
    if (!labels.has(k)) labels.set(k, cleanZoneLabel(z));
    return labels.get(k)!;
  };
  const zones: string[] = [];
  const add = (z: string) => {
    if (z && !zones.includes(lab(z))) zones.push(lab(z));
  };
  t.rates.forEach((r) => add(r.zone));
  t.zones.forEach((z) => add(z.zone));
  t.overflow.forEach((o) => add(o.zone));
  if (!zones.length) zones.push('A');
  const weights = Array.from(new Set(t.rates.map((r) => r.weightUpto))).sort((a, b) => a - b);
  const price = (z: string, w: number) => t.rates.find((r) => lab(r.zone) === z && r.weightUpto === w)?.price;
  return {
    carrierId: t.carrierId,
    name: t.name,
    service: t.service ?? '',
    currency: t.currency,
    divisor: String(t.divisor),
    edgeRounding: t.edgeRounding ?? 'CEIL_CM',
    steps: (t.weightSteps ?? []).map((s) => ({ upto: s.upto == null ? '' : numToInput(s.upto), step: numToInput(s.step) })),
    discountPct: numToInput(t.discountPct ?? 0),
    fuelPct: numToInput(t.fuelPct ?? 0),
    fuelVariable: t.fuelVariable,
    validFrom: t.validFrom?.slice(0, 10) ?? '',
    validTo: t.validTo?.slice(0, 10) ?? '',
    active: t.active,
    isDefault: t.isDefault,
    zones,
    rows: weights.length
      ? weights.map((w) => ({ upto: numToInput(w), prices: zones.map((z) => numToInput(price(z, w), 2)), perKg: t.rates.some((r) => r.weightUpto === w && r.perKg) }))
      : [emptyRow(zones.length)],
    overflow: zones.map((z) => numToInput(t.overflow.find((o) => lab(o.zone) === z)?.perUnit, 2)),
    countryZones: t.zones.map((z) => ({ country: z.country, zone: zones.indexOf(lab(z.zone)) })),
    surcharges: t.surcharges.map((s) => ({ code: s.code, name: s.name, kind: s.kind, amount: numToInput(s.amount, 2) })),
    adjustments: (t.countryAdjustments ?? []).map((a) => ({
      country: a.country,
      pct: numToInput(a.pct, 2),
      note: a.note ?? '',
      source: a.source,
      invoiceId: a.invoiceId ?? null,
    })),
  };
}

type Errors = string[];

export function toBody(d: Draft): { body: TariffBody | null; errors: Errors } {
  const errors: Errors = [];
  const n = (s: string) => parseTrNumber(s);
  if (!d.name.trim()) errors.push(tr('draft.errors.nameRequired'));
  if (!d.carrierId) errors.push(tr('draft.errors.carrierRequired'));
  const divisor = n(d.divisor);
  if (!divisor || divisor <= 0) errors.push(tr('draft.errors.divisorPositive'));
  // Boş oran %0'dır; dolu ama okunamayan oran %0 sayılmaz, kayıt durur (rapor 10-B6).
  const discountState = pctFieldState(d.discountPct);
  const fuelState = pctFieldState(d.fuelPct);
  const discountPct = n(d.discountPct) ?? 0;
  const fuelPct = n(d.fuelPct) ?? 0;
  if (discountState) errors.push(tr(discountState === 'unreadable' ? 'draft.errors.discountUnreadable' : 'draft.errors.discountRange'));
  if (fuelState) errors.push(tr(fuelState === 'unreadable' ? 'draft.errors.fuelUnreadable' : 'draft.errors.fuelRange'));
  const steps = d.steps
    .filter((s) => s.upto.trim() || s.step.trim())
    .map((s) => ({ upto: s.upto.trim() ? n(s.upto) : null, step: n(s.step), uptoUnreadable: Boolean(s.upto.trim()) && n(s.upto) === null }));
  // okunamayan sınır "sınırsız" (null) sayılmaz
  if (steps.some((s) => s.step === null || s.step <= 0 || s.uptoUnreadable || (s.upto !== null && s.upto <= 0))) errors.push(tr('draft.errors.weightSteps'));
  // K36 (kullanıcı kararı 2026-11-14): "1.500" ağırlık 1,5 kg da 1500 kg da olabilir; alanın altında seçilene dek kayıt yok.
  const askedWeights = new Set<string>();
  for (const w of [...d.steps.flatMap((s) => [s.upto, s.step]), ...d.rows.map((r) => r.upto)]) {
    const r = weightChoice(w);
    if (!r || askedWeights.has(w.trim())) continue;
    askedWeights.add(w.trim());
    errors.push(tr('draft.errors.weightAmbiguous', { value: w.trim(), decimal: weightChoiceLabel(r, 'decimal'), thousands: weightChoiceLabel(r, 'thousands') }));
  }
  const zoneNames = d.zones.map((z) => z.trim());
  if (zoneNames.some((z) => !z)) errors.push(tr('draft.errors.zoneNameRequired'));
  // Hesap motoru bölgeleri zoneKey ile eşler ("a" = "A" = "Zone A"): aynı anahtarlı iki sütun tek bölge olurdu.
  for (const c of duplicateZoneColumns(zoneNames)) errors.push(tr('draft.errors.zoneNameDuplicate', { zone: zoneNames[c] }));
  const rates: TariffBody['rates'] = [];
  const seen = new Set<number>();
  d.rows.forEach((r, i) => {
    const hasPrices = r.prices.some((p) => p.trim());
    if (!r.upto.trim() && !hasPrices) return;
    const w = n(r.upto);
    if (w === null || w <= 0) {
      errors.push(tr('draft.errors.rowWeightInvalid', { n: i + 1 }));
      return;
    }
    if (seen.has(w)) errors.push(tr('draft.errors.weightDuplicate', { weight: numToInput(w) }));
    seen.add(w);
    r.prices.forEach((p, j) => {
      if (!p.trim()) return;
      const v = n(p);
      if (v === null || v < 0) errors.push(tr('draft.errors.priceInvalid', { weight: numToInput(w), zone: zoneNames[j] }));
      else rates.push(r.perKg ? { zone: zoneNames[j], weightUpto: w, price: v, perKg: true } : { zone: zoneNames[j], weightUpto: w, price: v });
    });
  });
  if (!rates.length) errors.push(tr('draft.errors.pricesRequired'));
  const overflow: TariffBody['overflow'] = [];
  d.overflow.forEach((o, j) => {
    if (!o.trim()) return;
    const v = n(o);
    if (v === null || v < 0) errors.push(tr('draft.errors.overflowInvalid', { zone: zoneNames[j] }));
    else overflow.push({ zone: zoneNames[j], perUnit: v });
  });
  const mapped = d.countryZones.filter((z) => z.country.trim());
  if (mapped.some((z) => !(z.zone >= 0 && z.zone < zoneNames.length))) errors.push(tr('draft.errors.zoneMapUnknown'));
  const zones = mapped.map((z) => ({ country: z.country.trim().toUpperCase(), zone: zoneNames[z.zone] ?? '' }));
  if (zones.some((z) => z.country !== '*' && !/^[A-Z]{2}$/.test(z.country))) errors.push(tr('draft.errors.countryCode'));
  if (new Set(zones.map((z) => z.country)).size !== zones.length) errors.push(tr('draft.errors.countryOneZone'));
  const surcharges = d.surcharges
    .filter((s) => s.code.trim() || s.amount.trim())
    .map((s) => ({ code: s.code.trim().toUpperCase(), name: s.name.trim() || s.code.trim(), kind: s.kind, amount: n(s.amount) ?? NaN }));
  if (surcharges.some((s) => !s.code || Number.isNaN(s.amount))) errors.push(tr('draft.errors.surchargeRequired'));
  // Hesap aynı gruptaki ilk ek ücreti alır: ikinci satır ya ölü durur ya da hangisinin geçerli olduğu belirsizleşir (rapor 02-B10).
  const surchargeSeen = new Set<string>();
  for (const s of surcharges) {
    if (!s.code) continue;
    const k = canonicalSurchargeCode(s.code);
    if (surchargeSeen.has(k)) errors.push(tr('draft.errors.surchargeDuplicate', { code: s.code }));
    surchargeSeen.add(k);
  }
  const countryAdjustments = (d.adjustments ?? [])
    .filter((a) => a.country.trim() || a.pct.trim())
    .map((a) => ({
      country: a.country.trim().toUpperCase(),
      pct: n(a.pct) ?? NaN,
      note: a.note.trim() || null,
      source: a.source,
      invoiceId: a.invoiceId,
    }));
  if (countryAdjustments.some((a) => !/^[A-Z]{2}$/.test(a.country))) errors.push(tr('draft.errors.adjCountryCode'));
  if (countryAdjustments.some((a) => Number.isNaN(a.pct) || a.pct < -90 || a.pct > 200)) errors.push(tr('draft.errors.adjPctRange'));
  if (new Set(countryAdjustments.map((a) => a.country)).size !== countryAdjustments.length) errors.push(tr('draft.errors.adjOnePerCountry'));
  if (d.validFrom && d.validTo && d.validFrom > d.validTo) errors.push(tr('draft.errors.validityOrder'));
  if (errors.length) return { body: null, errors };
  return {
    body: {
      carrierId: d.carrierId,
      name: d.name.trim(),
      service: d.service.trim() || null,
      currency: d.currency,
      divisor: divisor!,
      edgeRounding: d.edgeRounding,
      weightSteps: steps.map((s) => ({ upto: s.upto, step: s.step as number })),
      discountPct,
      fuelPct,
      ...(d.fuelVariable === undefined ? {} : { fuelVariable: d.fuelVariable }),
      validFrom: d.validFrom || null,
      validTo: d.validTo || null,
      active: d.active,
      isDefault: d.isDefault,
      zones,
      rates,
      overflow,
      surcharges,
      countryAdjustments,
    },
    errors,
  };
}

/** Yüzde alanı (indirim, yakıt): `unreadable` = dolu ama sayı okunamıyor, `range` = 0–100 dışında, null = geçerli ya da boş. */
export function pctFieldState(s: string): 'unreadable' | 'range' | null {
  if (!s.trim()) return null;
  const v = parseTrNumber(s);
  if (v === null) return 'unreadable';
  return v < 0 || v > 100 ? 'range' : null;
}

/** Adı kendinden önceki bir sütunla aynı bölge anahtarına düşen sütunlar ("a" = "A" = "Zone A"); boş adlar sayılmaz. */
export function duplicateZoneColumns(names: string[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  names.forEach((z, i) => {
    if (!z.trim()) return;
    const k = zoneKey(z);
    if (seen.has(k)) out.push(i);
    seen.add(k);
  });
  return out;
}

/** Sütunun adını değiştirir; ülke eşlemesi sütuna bağlı olduğu için dokunulmaz (rapor 10-B1). */
export function renameZone(d: Draft, c: number, name: string): Draft {
  return { ...d, zones: d.zones.map((z, j) => (j === c ? name : z)) };
}

/** Sütunu siler: o bölgenin ülkeleri eşlemeden çıkar, sağdaki sütunlara bağlı ülkeler kendi sütunlarında kalır. */
export function removeZone(d: Draft, c: number): Draft {
  return {
    ...d,
    zones: d.zones.filter((_, j) => j !== c),
    rows: d.rows.map((r) => ({ ...r, prices: r.prices.filter((_, j) => j !== c) })),
    overflow: d.overflow.filter((_, j) => j !== c),
    countryZones: d.countryZones.filter((cz) => cz.zone !== c).map((cz) => (cz.zone > c ? { ...cz, zone: cz.zone - 1 } : cz)),
  };
}

/**
 * Sunucudan tarife geldiğinde (yeniden okuma, başka sekmede kayıt): `load` = taslağa yükle, `remote` = taslakta kaydedilmemiş
 * değişiklik var ve tarife başka yerde değişti (taslak ezilmez, "siz bakarken değişti" bandı), `keep` = dokunma (rapor 10-B17).
 */
export function incomingTariff(s: { dirty: boolean; baseUpdatedAt: string | undefined }, t: Tariff): 'load' | 'remote' | 'keep' {
  if (!s.dirty) return 'load';
  return t.updatedAt && s.baseUpdatedAt && t.updatedAt !== s.baseUpdatedAt ? 'remote' : 'keep';
}

export function nextZoneName(zones: string[]): string {
  // kayıttaki teklik denetimiyle aynı anahtar: "a" ya da "Zone A" varken yeni sütun "A" olmaz
  const used = new Set(zones.filter((z) => z.trim()).map(zoneKey));
  for (let i = 0; i < 26; i++) {
    const z = String.fromCharCode(65 + i);
    if (!used.has(zoneKey(z))) return z;
  }
  return tr('draft.zoneFallback', { n: zones.length + 1 });
}

export function normalize(d: Draft): Draft {
  const nz = d.zones.length;
  return {
    ...d,
    rows: d.rows.map((r) => ({ ...r, prices: Array.from({ length: nz }, (_, i) => r.prices[i] ?? '') })),
    overflow: Array.from({ length: nz }, (_, i) => d.overflow[i] ?? ''),
  };
}

function readPaste(text: string, c0: number, headerRow: boolean) {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const grid = lines.map((l) => l.split('\t'));
  const first = grid[0] ?? [];
  const looksHeader = headerRow || first.slice(c0 === -1 ? 1 : 0).some((s) => s.trim() && parseTrNumber(s) === null);
  return { grid, first, looksHeader, numbers: readPastedNumbers((looksHeader ? grid.slice(1) : grid).flat()) };
}

/**
 * The block's number format cannot be told and some cells read differently in Turkish and English ("1.234").
 * The caller must ask; `pasteBlock` then takes the answer as `format`.
 */
export function pasteAmbiguity(text: string, c0: number, headerRow: boolean): { example: string; asTr: number; asEn: number } | null {
  const example = readPaste(text, c0, headerRow).numbers.ambiguous[0];
  return example ? { example, asTr: coreParseNumber(example, 'tr')!, asEn: coreParseNumber(example, 'en')! } : null;
}

/**
 * Pastes a tab/newline separated block (copied from Excel) at (r0, c0); c0 = -1 is the weight column. Numbers are read in
 * the block's own format (not the interface language) and written in the active language.
 */
export function pasteBlock(d: Draft, r0: number, c0: number, text: string, headerRow: boolean, format?: 'tr' | 'en'): Draft | null {
  const pasted = readPaste(text, c0, headerRow);
  let { grid } = pasted;
  const { first, looksHeader, numbers } = pasted;
  if (!grid.length || (grid.length === 1 && grid[0].length === 1 && !headerRow && !format)) return null;
  const from = format ?? numbers.format;
  const cell = (v: string) => (from ? convertPastedNumber(v.trim(), from, getFormatLocale()) : v.trim());
  // K36: biçimi belli blokta ağırlık binliksiz yazılır (Türkçe blokta "1.500" → "1500"): alanda iki türlü okunan yazım kalmaz
  const weightCell = (v: string) => {
    const n = from ? parseNumberAs(v.trim(), from) : null;
    return n === null ? v.trim() : numToInput(n, 6);
  };
  const zones = [...d.zones];
  const rows = d.rows.map((r) => ({ ...r, prices: [...r.prices] }));
  const oldNames = [...d.zones];
  if (looksHeader) {
    const names = c0 === -1 ? first.slice(1) : first;
    const start = Math.max(c0, 0);
    names.forEach((nm, i) => {
      zones[start + i] = nm.trim() || zones[start + i] || nextZoneName(zones);
    });
    grid = grid.slice(1);
    if (headerRow) r0 = 0;
  }
  grid.forEach((cells, i) => {
    const r = r0 + i;
    while (rows.length <= r) rows.push(emptyRow());
    cells.forEach((v, j) => {
      const c = c0 + j;
      if (c === -1) rows[r].upto = weightCell(v);
      else {
        while (zones.length <= c) zones.push(nextZoneName(zones));
        rows[r].prices[c] = cell(v);
      }
    });
  });
  // Yapıştırılan başlık tablonun kendisidir: ülke, eski bölge adının yeni tablodaki sütununa gider; o ad yoksa işaretlenir (-1).
  const countryZones = looksHeader
    ? d.countryZones.map((cz) => {
        const name = oldNames[cz.zone];
        return { ...cz, zone: name === undefined ? -1 : zones.findIndex((z) => zoneKey(z) === zoneKey(name)) };
      })
    : d.countryZones;
  return normalize({ ...d, zones, rows, countryZones });
}

/**
 * Arayüz dili değişince kaydedilmemiş taslağın sayı metinleri anlamını korur (K36 inceleme: Türkçe "1,500" kg = 1,5 kg dil
 * değişince 1500 olmasın). Ağırlıkta seçilmemiş iki okumalı yazım yeni dilin aynı yazımına geçer (soru kalır).
 */
export function relocalizeDraft(d: Draft, from: Locale, to: Locale): Draft {
  if (from === to) return d;
  const n = (v: string) => relocalizeNumberText(v, from, to);
  const w = (v: string) => relocalizeWeightText(v, from, to);
  return {
    ...d,
    divisor: n(d.divisor),
    discountPct: n(d.discountPct),
    fuelPct: n(d.fuelPct),
    steps: d.steps.map((s) => ({ upto: w(s.upto), step: w(s.step) })),
    rows: d.rows.map((r) => ({ ...r, upto: w(r.upto), prices: r.prices.map(n) })),
    overflow: d.overflow.map(n),
    surcharges: d.surcharges.map((s) => ({ ...s, amount: n(s.amount) })),
    adjustments: d.adjustments.map((a) => ({ ...a, pct: n(a.pct) })),
  };
}

export interface Notice {
  kind: 'import' | 'restore' | 'created' | 'saved';
  versionId: string | null;
  affected: number;
  other?: number;
  recompared?: { invoices: number; lines: number; skipped?: { inDispute: number; stale: number } };
  fileName?: string;
  /** para birimi değişti, dosyada olmayan sabit tutarlar eski para biriminde kaldı: kontrol edilecek bölüm */
  check?: AfterImportCheck;
}

export type AfterImportCheck = 'surcharges' | 'overflow';

/** İçe aktarma kontrollerinden: para birimi değiştiyse kontrol edilecek bölüm (core SURCHARGES_OTHER_CURRENCY). */
export function afterImportCheck(checks: ImportIssue[]): AfterImportCheck | undefined {
  const c = checks.find((x) => x.code === 'SURCHARGES_OTHER_CURRENCY');
  return c ? (otherCurrencyCheckSection(c) ?? undefined) : undefined;
}

export const curSym = (c: string) => currencySymbol(c);

export interface CreatedState {
  created?: { fileName: string; affected: number; other: number };
}
