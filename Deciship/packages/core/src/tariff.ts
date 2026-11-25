import { type EdgeRounding, type WeightStep, overflowUnits, pctOf, round2, round3, stepFor, subMoney, sumMoney } from './calc';
import { canonicalCountryCode, countryName, COUNTRY_CODE_ALIASES } from './countryNames';
import { fmtKg, fmtPct } from './format';
import { DEFAULT_LOCALE, t, type Locale } from './i18n/index';
import type { Packaging } from './packaging';
import { canonicalSurchargeCode, normalizeSurchargeCode } from './surcharges';

export type SurchargeKind = 'FIXED' | 'PCT' | 'PER_KG';
export type TariffSurchargeInput = { code: string; name: string; kind: SurchargeKind; amount: number };

/**
 * Ülke istisnası: tarifenin o varış ülkesindeki taşıma bedeline (indirimden sonra, yakıttan önce) uygulanan işaretli
 * yüzde. -15,45 → %15,45 daha ucuz. `source: 'invoice'` → fatura "Tarife uyumu" raporundan uygulandı (`invoiceId`).
 */
export type CountryAdjustment = { country: string; pct: number; note?: string | null; source: 'manual' | 'invoice'; invoiceId?: string | null };

export type TariffInput = {
  id: string;
  currency: string;
  divisor: number;
  edgeRounding: EdgeRounding;
  weightSteps: WeightStep[];
  discountPct: number;
  fuelPct: number;
  /**
   * Yakıt oranı sözleşmede sabit değil, taşıyıcının güncel oranına bağlı (KARARLAR "Yakıt"). Açıkken ve fatura yakıtı ayrı
   * yazıyorsa beklenen yakıt faturadaki oranla hesaplanır; kapalıyken (ya da yoksa) tarifedeki oranla.
   */
  fuelVariable?: boolean;
  /** Tarifenin hizmeti (serbest metin; boş olabilir). Satırın hizmeti bundan farklıysa fark "İncele"ye düşer. */
  service?: string | null;
  zones: Record<string, string>;
  /**
   * perKg=true: satır bir kg başı fiyat bandıdır (fiyat × ücretli kg); false/yok: sabit fiyat. `packaging`: satırın ambalajı
   * (yok = `OWN`); Pak ve Zarf satırları yalnız o ambalajın fiyatıdır, kendi ambalajı hesabına girmez.
   */
  rates: { zone: string; weightUpto: number; price: number; perKg?: boolean; packaging?: Packaging }[];
  overflowPerUnit?: Record<string, number>;
  surcharges: TariffSurchargeInput[];
  /** Ülke istisnaları (ülke başına en çok bir; yoksa boş). Yalnız kendi ambalajı fiyatına uygulanır. */
  countryAdjustments?: CountryAdjustment[];
  /** Pak fiyatlarının indirimi (%); null/yok = `discountPct`. */
  pakDiscountPct?: number | null;
  /** Zarf fiyatlarının indirimi (%); null/yok = `discountPct`. */
  envelopeDiscountPct?: number | null;
};

export type ExpectedChargeOk = {
  ok: true;
  zone: string;
  lines: { label: string; amount: number }[];
  base: number;
  discount: number;
  /** Ülke istisnası tutarı (işaretli; indirimden sonraki tutar üstünden), yoksa 0. */
  adjustment: number;
  /** Uygulanan ülke istisnası yüzdesi (yoksa 0). */
  adjustmentPct: number;
  /** Taşıma = liste − indirim + ülke istisnası (yakıt ve ek ücretler hariç). */
  freight: number;
  fuel: number;
  surcharges: number;
  total: number;
  /** Pak ya da Zarf fiyatıyla hesaplandıysa o ambalaj; kendi ambalajında alan yok. */
  packaging?: Exclude<Packaging, 'OWN'>;
};
/**
 * `noPackagingRates`: istenen ambalajın (Pak/Zarf) tarifede hiç fiyat satırı yok; karşılaştırma bunu "Pak/zarf kapsam dışı"
 * davranışına çevirir. Bölgede satır yoksa (başka bölgelerde var) bayrak yoktur, neden bölgeyi söyler.
 */
export type ExpectedChargeResult = ExpectedChargeOk | { ok: false; reason: string; noPackagingRates?: Exclude<Packaging, 'OWN'> };

export function findTariffSurcharge(tariff: TariffInput, code: string): TariffSurchargeInput | undefined {
  const n = normalizeSurchargeCode(code);
  const exact = tariff.surcharges.find((s) => normalizeSurchargeCode(s.code) === n);
  if (exact) return exact;
  const c = canonicalSurchargeCode(code);
  return tariff.surcharges.find((s) => canonicalSurchargeCode(s.code) === c);
}

/** Tarifedeki bir ek ücretin beklenen tutarı (indirim/yakıt uygulanmaz): FIXED = tutar, PER_KG = tutar × ücretli kg, PCT = tutar% × liste fiyatı (base). */
export function surchargeAmount(s: TariffSurchargeInput, ctx: { base: number; chargeableKg: number }): number {
  switch (s.kind) {
    case 'FIXED':
      return round2(s.amount);
    case 'PCT':
      return pctOf(ctx.base, s.amount);
    case 'PER_KG':
      return round2(s.amount * round3(ctx.chargeableKg));
  }
}

const ZONE_WORD = /^(?:zone|b[öo]lge|region)(?:[\s_-]+(\S.*)|(\d+))$/iu;
/** "A BÖLGESİ", "A Bölgesi", "A Zone" → "A" (bölge adı tek kelimeyse). */
const ZONE_SUFFIX = /^(\S+)[\s_-]+(?:b[öoÖO]lges[iİIı]|zone|region)$/iu;

/**
 * Bölge adının görünen temiz hâli: boşlukları toplar, baştaki "Zone"/"Bölge"/"Region" kelimesini atar.
 * "Zone A " → "A", "Bölge 3" → "3", "ZONE-B" → "B"; "Z1", "EU", "WW", "*" olduğu gibi kalır.
 */
export function cleanZoneLabel(z: string): string {
  const t = String(z ?? '').replace(/\s+/g, ' ').trim();
  const suf = ZONE_SUFFIX.exec(t);
  if (suf) return suf[1]!;
  const m = ZONE_WORD.exec(t);
  if (!m) return t;
  return (m[1] ?? m[2] ?? t).trim();
}

/**
 * Yurt içi mesafe bölgeleri (Türk kargo liste fiyatlarında "Desi | Şehir içi | Yakın | Orta | Uzak",
 * "Kısa / Orta / Uzun Mesafe", "Mahalli / Bölge içi …" sütunları) → kısa kod. Kod da kendisine döner.
 */
const DISTANCE_ZONES: [RegExp, string][] = [
  [/^(?:sehir\s*ici|sehirici)$/, 'SEHIRICI'],
  [/^sehir\s*(?:ler)?\s*arasi$/, 'SEHIRLERARASI'],
  [/^mahalli$/, 'MAHALLI'],
  [/^(?:bolge\s*ici|bolgeici)$/, 'BOLGEICI'],
  [/^kisa(?:\s*mesafe)?$/, 'KISA'],
  [/^yakin(?:\s*mesafe)?$/, 'YAKIN'],
  [/^orta(?:\s*mesafe)?$/, 'ORTA'],
  [/^uzun(?:\s*mesafe)?$/, 'UZUN'],
  [/^uzak(?:\s*mesafe)?$/, 'UZAK'],
  [/^(?:cok\s*uzak|cokuzak)(?:\s*mesafe)?$/, 'COKUZAK'],
  [/^il\s*ici$/, 'ILICI'],
  [/^il\s*disi$/, 'ILDISI'],
  [/^uzun\s*hat$/, 'UZUNHAT'],
];

const foldTr = (s: string) =>
  String(s ?? '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** "Şehir İçi" → "SEHIRICI", "Kısa Mesafe" → "KISA", "YAKIN" → "YAKIN"; mesafe bölgesi değilse null. */
export function distanceZoneCode(label: string): string | null {
  const t = foldTr(label).replace(/\s*(?:bolgesi|b[oö]lge)$/, '');
  const named = DISTANCE_ZONES.find(([re]) => re.test(t))?.[1];
  if (named) return named;
  // km kademeleri: "0-200 km" → "0-200KM", "1000 km üzeri" / "1000+ km" → "1000KM+"
  const range = /^(\d+)\s*[-–]\s*(\d+)\s*km$/.exec(t);
  if (range) return `${range[1]}-${range[2]}KM`;
  const over = /^(\d+)\s*(?:\+\s*km|km\s*(?:\+|uzeri|ustu))$/.exec(t);
  return over ? `${over[1]}KM+` : null;
}

const distanceZoneCache = new WeakMap<TariffInput['rates'], { length: number; count: number }>();

/**
 * Tarifenin fiyat satırlarındaki ayrı yurt içi mesafe bölgesi sayısı ("Şehir içi", "Yakın", "Uzak", "0-200 km" …;
 * `distanceZoneCode`). İki ya da daha çoksa gönderinin bölgesi faturadan doğrulanamaz: bölge yalnız varış ülkesinden ya
 * da `*`'dan bulunur, il ve mesafe kullanılmaz (KALANLAR 1.9; karşılaştırmada fiyat farkı "İncele", `ZONE_DISTANCE`).
 */
export function distanceZoneCount(tariff: Pick<TariffInput, 'rates'>): number {
  const cached = distanceZoneCache.get(tariff.rates);
  if (cached && cached.length === tariff.rates.length) return cached.count;
  const codes = new Set<string>();
  for (const r of tariff.rates) {
    const c = distanceZoneCode(r.zone);
    if (c) codes.add(c);
  }
  distanceZoneCache.set(tariff.rates, { length: tariff.rates.length, count: codes.size });
  return codes.size;
}

/** zoneKey sonuçları (saf fonksiyon; tarife başına birkaç bölge adı binlerce satırda tekrar tekrar sorulur). */
const zoneKeyCache = new Map<string, string>();

/** Bölge karşılaştırma anahtarı (büyük/küçük harf duyarsız; "Zone A" = "A"). */
export function zoneKey(z: string): string {
  const s = String(z ?? '');
  let k = zoneKeyCache.get(s);
  if (k === undefined) {
    k = cleanZoneLabel(s).toLocaleUpperCase('en-US');
    if (zoneKeyCache.size >= 5000) zoneKeyCache.clear();
    zoneKeyCache.set(s, k);
  }
  return k;
}

export function sameZone(a: string, b: string): boolean {
  return zoneKey(a) === zoneKey(b);
}

function overflowFor(tariff: TariffInput, zone: string): number | undefined {
  const map = tariff.overflowPerUnit;
  if (!map) return undefined;
  if (map[zone] != null) return map[zone];
  const k = zoneKey(zone);
  for (const [z, v] of Object.entries(map)) if (zoneKey(z) === k) return v;
  return undefined;
}

export function resolveZone(tariff: TariffInput, destCountry?: string): string | null {
  const c = destCountry?.trim().toUpperCase();
  if (c && tariff.zones[c] != null) return tariff.zones[c]!;
  if (c) {
    // 04-B14: "UK" ↔ "GB", "EL" ↔ "GR" (faturada ya da tarifede ISO olmayan takma ad)
    const iso = canonicalCountryCode(c);
    if (tariff.zones[iso] != null) return tariff.zones[iso]!;
    for (const [alias, target] of Object.entries(COUNTRY_CODE_ALIASES)) {
      if (target === iso && tariff.zones[alias] != null) return tariff.zones[alias]!;
    }
  }
  if (tariff.zones['*'] != null) return tariff.zones['*']!;
  return null;
}

type RateRow = TariffInput['rates'][number];
type RateIndex = { length: number; byZone: Map<string, RateRow[]>; packagings: Set<Packaging> };
/** Fiyat satırlarının bölge anahtarına göre gruplanmış, ağırlığa göre sıralı hâli; aynı `rates` dizisi için bir kez kurulur. */
const rateIndexCache = new WeakMap<TariffInput['rates'], RateIndex>();

const packagingOf = (r: RateRow): Packaging => r.packaging ?? 'OWN';
/** Dizin anahtarı: kendi ambalajında yalnız bölge (bugünkü), Pak/Zarf'ta ambalaj + bölge. */
const indexKey = (packaging: Packaging, key: string) => (packaging === 'OWN' ? key : `${packaging}|${key}`);

function rateIndex(tariff: Pick<TariffInput, 'rates'>): RateIndex {
  let idx = rateIndexCache.get(tariff.rates);
  if (!idx || idx.length !== tariff.rates.length) {
    const byZone = new Map<string, RateRow[]>();
    const packagings = new Set<Packaging>();
    for (const r of tariff.rates) {
      const p = packagingOf(r);
      packagings.add(p);
      const k = indexKey(p, zoneKey(r.zone));
      const list = byZone.get(k);
      if (list) list.push(r);
      else byZone.set(k, [r]);
    }
    for (const list of byZone.values()) list.sort((a, b) => a.weightUpto - b.weightUpto);
    idx = { length: tariff.rates.length, byZone, packagings };
    rateIndexCache.set(tariff.rates, idx);
  }
  return idx;
}

/**
 * Ambalajın (yok = kendi ambalajı) satırlarında `rates.filter(zoneKey eşit).sort(weightUpto)` ile birebir aynı sonuç
 * (sıralama kararlı, gruplar dizideki sırayla doldurulur). Dizinin boyu değişirse (sonradan eklenen satır) yeniden kurulur.
 */
function ratesForZone(tariff: TariffInput, key: string, packaging: Packaging = 'OWN'): RateRow[] {
  return rateIndex(tariff).byZone.get(indexKey(packaging, key)) ?? [];
}

/** Tarifede bu ambalajın fiyat satırı var mı: `zone` verilirse o bölgede, yoksa herhangi bir bölgede. */
export function tariffHasPackaging(tariff: Pick<TariffInput, 'rates'>, packaging: Packaging, zone?: string | null): boolean {
  const idx = rateIndex(tariff);
  if (zone == null) return idx.packagings.has(packaging);
  return (idx.byZone.get(indexKey(packaging, zoneKey(zone)))?.length ?? 0) > 0;
}

/**
 * Pak/Zarf ağırlığının o ambalajın satırına yuvarlanmışı: bölgedeki satırlardan ağırlığı kapsayan ilkinin üst sınırı
 * (kg başı satırda ağırlığın kendisi); kapsayan satır yoksa ağırlığın kendisi (fiyat bulunamaz). Kendi ambalajının
 * basamakları (`weightSteps`) Pak/Zarf'a uygulanmaz: 1 kg basamaklı tarifede 0,4 kg Pak 0,5 kg satırından fiyatlanır.
 */
export function packagingRowKg(tariff: TariffInput, zone: string | null, packaging: Packaging, kg: number): number {
  const value = round3(kg);
  if (zone == null) return value;
  const g = Math.round(value * 1000);
  const hit = ratesForZone(tariff, zoneKey(zone), packaging).find((r) => Math.round(round3(r.weightUpto) * 1000) >= g);
  return hit && !hit.perKg ? round3(hit.weightUpto) : value;
}

/** Ambalajın indirim oranı (%): Pak/Zarf için ayrı oran verilmişse o, yoksa tarifenin indirimi. */
export function packagingDiscountPct(tariff: Pick<TariffInput, 'discountPct' | 'pakDiscountPct' | 'envelopeDiscountPct'>, packaging: Packaging = 'OWN'): number {
  const own = packaging === 'PAK' ? tariff.pakDiscountPct : packaging === 'ENVELOPE' ? tariff.envelopeDiscountPct : null;
  return own != null && Number.isFinite(own) ? own : tariff.discountPct;
}

/**
 * Bölge + ücretli kg için liste fiyatı; kg başı bantta fiyat × kg; tablo üstündeyse taşma birim fiyatıyla. `packaging`
 * (yok = kendi ambalajı): yalnız o ambalajın satırları; Pak ve Zarf'ta taşma yoktur (son satırın üstü fiyatsız).
 */
export function ratePrice(
  tariff: TariffInput,
  zone: string,
  chargeableKg: number,
  locale: Locale = DEFAULT_LOCALE,
  packaging: Packaging = 'OWN',
): { ok: true; price: number; label: string } | { ok: false; reason: string; noPackagingRates?: Exclude<Packaging, 'OWN'> } {
  const rows = ratesForZone(tariff, zoneKey(zone), packaging);
  if (rows.length === 0) {
    if (packaging === 'OWN') return { ok: false, reason: t(locale, 'tariff.noRateRows', { zone }) };
    if (!tariffHasPackaging(tariff, packaging)) return { ok: false, reason: t(locale, `tariff.noPackagingRates.${packaging}`), noPackagingRates: packaging };
    return { ok: false, reason: t(locale, `tariff.noPackagingZone.${packaging}`, { zone }) };
  }
  const g = Math.round(round3(chargeableKg) * 1000);
  const hit = rows.find((r) => Math.round(round3(r.weightUpto) * 1000) >= g);
  if (hit?.perKg) {
    const kg = round3(chargeableKg);
    return {
      ok: true,
      price: round2(hit.price * kg),
      label: t(locale, 'tariff.price.perKg', { zone, price: locale === 'en' ? String(round2(hit.price)) : String(round2(hit.price)).replace('.', ','), kg: fmtKg(kg, locale) }),
    };
  }
  if (hit) {
    const key = packaging === 'OWN' ? 'tariff.price' : (`tariff.price.${packaging}` as const);
    return { ok: true, price: round2(hit.price), label: t(locale, key, { zone, kg: fmtKg(chargeableKg, locale) }) };
  }
  const last = rows[rows.length - 1]!;
  if (last.perKg) {
    return { ok: false, reason: t(locale, 'tariff.overPerKgBand', { kg: fmtKg(chargeableKg, locale), limit: fmtKg(last.weightUpto, locale) }) };
  }
  const perUnit = packaging === 'OWN' ? overflowFor(tariff, zone) : undefined;
  if (perUnit == null) {
    return { ok: false, reason: t(locale, 'tariff.overMax', { kg: fmtKg(chargeableKg, locale), limit: fmtKg(last.weightUpto, locale) }) };
  }
  const units = overflowUnits(chargeableKg, last.weightUpto, stepFor(chargeableKg, tariff.weightSteps), tariff.weightSteps, tariff.rates);
  const price = round2(last.price + units * perUnit);
  return { ok: true, price, label: t(locale, 'tariff.price.overflow', { zone, kg: fmtKg(chargeableKg, locale), units }) };
}

/** Varış ülkesinin istisnası (ISO-2, büyük/küçük harf duyarsız; UK/EL gibi takma adlar GB/GR sayılır; yüzdesi 0 olan yok sayılır); yoksa undefined. */
export function findCountryAdjustment(tariff: Pick<TariffInput, 'countryAdjustments'>, destCountry?: string | null): CountryAdjustment | undefined {
  const c = destCountry?.trim() ? canonicalCountryCode(destCountry) : '';
  if (!c || !tariff.countryAdjustments?.length) return undefined;
  return tariff.countryAdjustments.find((a) => canonicalCountryCode(a.country) === c && Number.isFinite(a.pct) && a.pct !== 0);
}

/** "İspanya istisnası −%15,45" / "Almanya istisnası +%3" */
export function countryAdjustmentLabel(a: Pick<CountryAdjustment, 'country' | 'pct'>, locale: Locale = DEFAULT_LOCALE): string {
  const sign = a.pct < 0 ? '−' : '+';
  return t(locale, 'tariff.adjustment', { country: countryName(a.country, locale), sign, pct: fmtPct(Math.abs(a.pct), locale) });
}

export function expectedCharge(i: {
  tariff: TariffInput;
  chargeableKg: number;
  destCountry?: string;
  surchargeCodes?: string[];
  /** Tarifedeki yakıt oranı yerine kullanılacak oran (%): yakıtı değişken tarifede faturadaki oran. */
  fuelPct?: number;
  /** Yalnız etiket ve sebep metinleri; tutarlar her dilde aynı. */
  locale?: Locale;
  /**
   * Fiyatın alınacağı ambalaj (yok = `OWN`, bugünkü hesap). Pak/Zarf: o ambalajın satırları ve indirimi
   * (`packagingDiscountPct`), ülke istisnası uygulanmaz; ücretli kg'ı çağıran verir (sınır içindeki Pak'ta gerçek kg,
   * basamaklı; sınır denetimi `packaging.ts`). Tarifede o ambalajın satırı yoksa `ok: false` + `noPackagingRates`.
   */
  packaging?: Packaging;
}): ExpectedChargeResult {
  const { tariff } = i;
  const locale = i.locale ?? DEFAULT_LOCALE;
  const packaging: Packaging = i.packaging ?? 'OWN';
  const zone = resolveZone(tariff, i.destCountry);
  if (zone == null) {
    return { ok: false, reason: i.destCountry ? t(locale, 'tariff.noZone', { country: i.destCountry.toUpperCase() }) : t(locale, 'tariff.noCountry') };
  }
  const rate = ratePrice(tariff, zone, i.chargeableKg, locale, packaging);
  if (!rate.ok) return rate;

  const base = rate.price;
  const discountPct = packagingDiscountPct(tariff, packaging);
  const discount = pctOf(base, discountPct);
  const afterDiscount = subMoney(base, discount);
  const adj = packaging === 'OWN' ? findCountryAdjustment(tariff, i.destCountry) : undefined;
  const adjustment = adj ? pctOf(afterDiscount, adj.pct) : 0;
  const freight = sumMoney([afterDiscount, adjustment]);
  const fuelOverridden = i.fuelPct != null && Number.isFinite(i.fuelPct) && i.fuelPct !== tariff.fuelPct;
  const fuelPct = fuelOverridden ? i.fuelPct! : tariff.fuelPct;
  const fuel = pctOf(freight, fuelPct);

  const lines: { label: string; amount: number }[] = [{ label: rate.label, amount: base }];
  if (discount !== 0) lines.push({ label: t(locale, 'tariff.discount', { pct: fmtPct(discountPct, locale) }), amount: -discount });
  if (adj && adjustment !== 0) lines.push({ label: countryAdjustmentLabel(adj, locale), amount: adjustment });
  if (fuelOverridden) {
    // tutar 0 olsa da yazılır: tarifede yakıt varken faturada yoksa kalemin neden düştüğü görünür
    lines.push({ label: t(locale, 'tariff.fuelInvoice', { pct: fmtPct(fuelPct, locale), tariff: fmtPct(tariff.fuelPct, locale) }), amount: fuel });
  } else if (fuel !== 0) lines.push({ label: t(locale, 'tariff.fuel', { pct: fmtPct(tariff.fuelPct, locale) }), amount: fuel });

  const seen = new Set<string>();
  const surchargeAmounts: number[] = [];
  for (const code of i.surchargeCodes ?? []) {
    const s = findTariffSurcharge(tariff, code);
    if (!s) continue;
    const key = normalizeSurchargeCode(s.code);
    if (seen.has(key)) continue;
    seen.add(key);
    const amount = surchargeAmount(s, { base, chargeableKg: i.chargeableKg });
    surchargeAmounts.push(amount);
    lines.push({ label: s.name || s.code, amount });
  }
  const surcharges = sumMoney(surchargeAmounts);
  const total = sumMoney([freight, fuel, surcharges]);
  const adjustmentPct = adj && adjustment !== 0 ? adj.pct : 0;
  return { ok: true, zone, lines, base, discount, adjustment, adjustmentPct, freight, fuel, surcharges, total, ...(packaging !== 'OWN' ? { packaging } : {}) };
}
