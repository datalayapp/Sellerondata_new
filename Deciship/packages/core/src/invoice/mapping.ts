import { detectChargePairs } from './charges';
import { detectMetaColumns } from './meta';
import { normalizeHeader } from './normalize';
import { SURCHARGE_SYNONYMS, surchargeCodeFromHeader } from '../surcharges';
import { parsePackaging } from '../packaging';
import { CARRIER_PRESETS, GENERIC_SYNONYMS, PACKAGING_SYNONYMS } from './presets';
import { emptyMapping, MAPPING_FIELDS, REQUIRED_MAPPING_FIELDS, type CarrierCode, type ColumnMapping, type MappingField, type Table } from './types';
import { suggestedVatEvidence } from './vat';

export { normalizeHeader };

const VAT = /\b(kdv|vat|tax|vergi|otv)\b/;
const VAT_EXCL = /\b(haric|excl|excluding|exclusive|without|matrah)\b/;
const VAT_INCL = /\b(dahil|incl|including|inclusive|kdvli)\b/;
const NOT_MONEY = /\b(desi|kg|agirlik|weight|adet|pieces|parca|koli|count|sayisi|qty|quantity|oran|orani|rate|pct|percent|yuzde)\b/;

/** Birim sütunları ("Boyut Birimi", "Actual Weight Units") ölçü/ağırlık/tutar alanına eşlenmez. */
const UNIT = /\b(birim|birimi|birimleri|unit|units|uom)\b/;
/** Fatura düzeyindeki toplamlar (her satırda tekrarlanır): satır tutarı değildir. */
const INVOICE_LEVEL = /\b(orijinal|original|balance|bakiye|alternatif|alternate)\b|^toplam (standart|indirimler|ek ucretler|vergiler)\b/;

const EXCLUDE: Partial<Record<MappingField, RegExp[]>> = {
  trackingNo: [/\b(fatura|invoice|reference|referans|siparis|order|musteri|customer|account|hesap|master|ana)\b/],
  netAmount: [/\b(surcharge|yakit|fuel|indirim|discount|iskonto|incentive|ek|currency|doviz|birimi)\b/, NOT_MONEY, UNIT, INVOICE_LEVEL],
  baseAmount: [NOT_MONEY, /\b(net|toplam|total)\b/, UNIT, INVOICE_LEVEL],
  discountAmount: [NOT_MONEY, UNIT, INVOICE_LEVEL],
  fuelAmount: [NOT_MONEY, UNIT, INVOICE_LEVEL],
  shipDate: [/\b(fatura|invoice|due|vade|delivery|delivered|teslimat|odeme|payment|pod)\b/, /^teslim tarihi$/, /^son tarih/],
  destCountry: [/\b(shipper|origin|sender|gonderici|gondericinin|cikis|from|cikan|faturalama|billing)\b/],
  actualKg: [/\b(rated|billed|billable|chargeable|ucretli|faturalanan|ucretlendirilen|desi|dim|hacimsel|volumetric)\b/, UNIT],
  billedKg: [/\b(bolen|boleni|divisor)\b/, UNIT],
  // Ambalaj sütunu ("Service Packaging", "Paketleme") hizmet değildir; ayrı önerilir (`suggestPackagingColumn`)
  service: [/\b(charge|ucret|ucreti|tutar|amount|tutari|bedel|bedeli|fiyat|fiyati)\b/, /\b(packaging|paketleme|ambalaj)\b/],
  reference: [/\b(tracking|takip|barkod)\b/],
  dimL: [/\b(divisor|bolen)\b/, UNIT],
  dimW: [/\b(divisor|bolen)\b/, UNIT],
  dimH: [/\b(divisor|bolen)\b/, UNIT],
  // "Ölçü (cm) / En" (iki katlı başlığın kenar sütunu) tek hücre ölçü değildir.
  dims: [UNIT, /\b(en|boy|yukseklik|uzunluk|genislik|length|width|height)\b/],
  billedDivisor: [UNIT],
  currency: [/\b(rate|kur|kuru|alternatif|alternate|exchange)\b/],
  actualKgUnit: [/\b(rated|billed|ucretli|ucretlendirilen|faturalanan)\b/],
};


/**
 * Başlıktan "KDV dahil" tahmini (eskisi gibi dar): tam "Toplam", "Genel Toplam", "Total"… ve yanında tam "KDV"/"VAT" sütunu.
 * Veri varsa karar `vat.ts` sınamasınındır; bu tahmin veriyle desteklenmezse okuma kontrolü sorar (KALANLAR 1.3).
 */
const TOTAL_LIKE = /^(genel toplam|toplam|toplam tutar|total|total amount|grand total|odenecek tutar|fatura tutari)$/;
function isVatHeaderStrict(nh: string): boolean {
  return /^(kdv|vat|tax|kdv tutari|vat amount|tax amount)( \d+)?$/.test(nh);
}
/** Navlun dışında tanınmayan tutar sütunu olabilecek başlık ("Hizmet Bedeli", "Ek Ücret Tutarı"). */
const MONEY_WORD = /\b(bedel|bedeli|ucret|ucreti|tutar|tutari|fiyat|fiyati|fee|fees|charge|charges|amount|toplam|total)\b/;

const MONEY_FIELDS: MappingField[] = ['netAmount', 'baseAmount', 'discountAmount', 'fuelAmount'];

function containsWords(header: string, syn: string): boolean {
  return (' ' + header + ' ').includes(' ' + syn + ' ');
}

function synonymScore(nh: string, syns: string[], weight: number): number {
  let best = 0;
  for (const [pos, raw] of syns.entries()) {
    const s = normalizeHeader(raw);
    if (!s) continue;
    if (nh === s) return weight * (1 - Math.min(pos, 25) * 0.002);
    if (containsWords(nh, s)) best = Math.max(best, weight * (0.5 + 0.4 * (s.length / nh.length)));
  }
  return best;
}

function fieldScore(field: MappingField, nh: string, carrier: CarrierCode, ctx: { hasVatColumn: boolean }): number {
  if (!nh) return 0;
  const preset = CARRIER_PRESETS[carrier] ?? CARRIER_PRESETS.generic;
  const exact = [...(carrier === 'generic' ? [] : (preset.synonyms[field] ?? [])), ...(GENERIC_SYNONYMS[field] ?? [])].some(
    (s) => normalizeHeader(s) === nh,
  );
  if (!exact) {
    for (const re of EXCLUDE[field] ?? []) if (re.test(nh)) return 0;
    if (field !== 'fuelAmount' && isKnownSurchargeHeader(nh)) return 0;
  }
  let factor = ctx.hasVatColumn && field === 'netAmount' && TOTAL_LIKE.test(nh) ? 0.9 : 1;
  if (MONEY_FIELDS.includes(field) && VAT.test(nh) && !VAT_EXCL.test(nh)) {
    if (field === 'netAmount' && VAT_INCL.test(nh)) factor = 0.5;
    else return 0;
  }
  const own = carrier === 'generic' ? 0 : synonymScore(nh, preset.synonyms[field] ?? [], 1);
  const gen = synonymScore(nh, GENERIC_SYNONYMS[field] ?? [], 0.95);
  return Math.max(own, gen) * factor;
}

function isKnownSurchargeHeader(nh: string): boolean {
  return SURCHARGE_SYNONYMS.some((s) => s.synonyms.some((syn) => containsWords(nh, normalizeHeader(syn))));
}

/** Başlık ek ücret sütunu gibi görünüyorsa kodunu döner ("Kapıda Ödeme Bedeli" → "KAPIDA_ODEME"). */
export function surchargeCodeForHeader(header: string): string | null {
  const nh = normalizeHeader(header);
  if (!nh || VAT.test(nh) || /\b(fuel|yakit|akaryakit)\b/.test(nh)) return null;
  if (isKnownSurchargeHeader(nh) || /\b(surcharge|ek ucret|ek ucreti|ek hizmet)\b/.test(nh)) {
    return surchargeCodeFromHeader(header) || null;
  }
  return null;
}

/** Her sütunun kaç satırda dolu olduğu (başlık sırasıyla). */
export function columnFillCounts(table: { headers: string[]; rows: string[][] }): number[] {
  return table.headers.map((_, i) => table.rows.reduce((n, r) => n + (String(r[i] ?? '').trim() !== '' ? 1 : 0), 0));
}

type ColumnStats = { filled: number; distinct: number; withDigit: number };

function columnStats(rows: string[][], idx: number): ColumnStats {
  const seen = new Set<string>();
  let filled = 0;
  let withDigit = 0;
  for (const r of rows) {
    const v = String(r[idx] ?? '').trim();
    if (!v) continue;
    filled++;
    if (/\d/.test(v)) withDigit++;
    if (seen.size < 2) seen.add(v);
  }
  return { filled, distinct: seen.size, withDigit };
}

/**
 * Veriye bakarak aday puanını düzeltir: tüm satırlarda boş sütun hiçbir alana önerilmez;
 * takip no / net tutar için rakam içermeyen sütun elenir; her satırda aynı değeri taşıyan sütun
 * (fatura düzeyi toplam, tek bir numara…) yarım puan alır.
 */
function dataFactor(field: MappingField, st: ColumnStats, rowCount: number): number {
  if (st.filled === 0) return 0;
  if (field === 'trackingNo' || field === 'netAmount') {
    if (st.withDigit === 0) return 0;
    const minRows = field === 'trackingNo' ? 3 : 5;
    if (rowCount >= minRows && st.filled >= minRows && st.distinct === 1) return 0.5;
  }
  return 1;
}

/**
 * Başlıklardan (ve verildiyse satırlardan) önerilen eşleme. `rows` verilirse hep boş sütunlar elenir;
 * böylece ör. FedEx'in boş "MPS Paketi Takip Numarası" sütunu takip no seçilmez.
 * Etiket/tutar çiftleri (`chargePairs`) başlıklardan bulunur ve başka alana eşlenmez.
 */
export function suggestMapping(
  headers: string[],
  carrierCode: CarrierCode,
  rows?: string[][],
): { mapping: ColumnMapping; confidence: number; missing: string[] } {
  const carrier: CarrierCode = CARRIER_PRESETS[carrierCode] ? carrierCode : 'generic';
  const normalized = headers.map(normalizeHeader);
  const hasVatColumn = normalized.some(isVatHeaderStrict);
  const chargePairs = detectChargePairs(headers);
  const pairCols = new Set<number>();
  for (const p of chargePairs) {
    pairCols.add(headers.indexOf(p.label));
    pairCols.add(headers.indexOf(p.amount));
  }
  const useData = Array.isArray(rows) && rows.length > 0;
  const stats = useData ? headers.map((_, i) => columnStats(rows!, i)) : [];
  const candidates: { field: MappingField; idx: number; score: number }[] = [];
  MAPPING_FIELDS.forEach((field) => {
    normalized.forEach((nh, idx) => {
      if (pairCols.has(idx)) return;
      let score = fieldScore(field, nh, carrier, { hasVatColumn });
      if (score > 0 && useData) score *= dataFactor(field, stats[idx]!, rows!.length);
      if (score > 0) candidates.push({ field, idx, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score || MAPPING_FIELDS.indexOf(a.field) - MAPPING_FIELDS.indexOf(b.field) || a.idx - b.idx);

  const mapping = emptyMapping();
  mapping.chargePairs = chargePairs;
  const usedHeaders = new Set<number>(pairCols);
  const scores: Partial<Record<MappingField, number>> = {};
  for (const c of candidates) {
    if (mapping[c.field] != null || usedHeaders.has(c.idx)) continue;
    mapping[c.field] = headers[c.idx]!;
    scores[c.field] = c.score;
    usedHeaders.add(c.idx);
  }

  // Tek hücre ölçü ile ayrı kenar sütunları birlikte varsa ayrı sütunlar yeğlenir.
  if (mapping.dims && mapping.dimL && mapping.dimW && mapping.dimH) delete mapping.dims;

  // Ambalaj sütunu (Pak/Zarf): eşleme ekranının alanı değildir, yalnız başlıktan önerilir
  // Sayısal ambalaj kodları yalnız FedEx ve UPS kalıbında okunur (genel kalıpta ve diğer taşıyıcılarda yalnız metin)
  const packagingCodes = carrier === 'ups' ? 'ups' : carrier === 'fedex' ? 'fedex' : undefined;
  const packagingIdx = suggestPackagingColumn(normalized, usedHeaders, useData ? rows! : null, packagingCodes);
  if (packagingIdx != null) {
    mapping.packaging = headers[packagingIdx]!;
    if (packagingCodes) mapping.packagingCodes = packagingCodes;
    usedHeaders.add(packagingIdx);
  }

  // Fatura düzeyi sütunlar (fatura no / tarih / toplam): satır alanı değildir, yalnız meta ve tanılama için.
  Object.assign(mapping, detectMetaColumns(headers, rows));

  headers.forEach((h, idx) => {
    if (usedHeaders.has(idx)) return;
    const code = surchargeCodeForHeader(h);
    if (code) mapping.surchargeColumns.push({ header: h, code });
  });

  // 1.5: net tutar bulunamadı ama tek tutar sütunu navlunsa (yakıt, indirim, ek ücret ve tanınmayan başka tutar sütunu yok)
  // navlun nettir. "Hizmet Bedeli" gibi tanınmayan bir tutar sütunu varsa net boş kalır (kullanıcı seçer).
  const metaHeaders = new Set([mapping.invoiceNo, mapping.invoiceDate, mapping.invoiceTotal].filter(Boolean));
  const otherMoney = headers.some((h, idx) => {
    if (usedHeaders.has(idx) || metaHeaders.has(h)) return false;
    const nh = normalized[idx]!;
    if (!MONEY_WORD.test(nh) || VAT.test(nh) || NOT_MONEY.test(nh) || UNIT.test(nh)) return false;
    return !useData || rows!.some((r) => /\d/.test(String(r[idx] ?? '')));
  });
  if (!mapping.netAmount && mapping.baseAmount && !mapping.fuelAmount && !mapping.discountAmount && !mapping.surchargeColumns.length && !chargePairs.length && !otherMoney) {
    mapping.netAmount = mapping.baseAmount;
    scores.netAmount = scores.baseAmount;
    delete mapping.baseAmount;
    delete scores.baseAmount;
  }

  if (mapping.netAmount) {
    const nh = normalizeHeader(mapping.netAmount);
    if ((VAT.test(nh) && VAT_INCL.test(nh)) || (hasVatColumn && TOTAL_LIKE.test(nh) && !VAT_EXCL.test(nh))) mapping.amountsIncludeVat = true;
    // 1.3: KDV sütunu varsa karar veriyle: bütün satırlarda KDV ≈ (tutar − KDV) × oran → KDV dahil (oranıyla); KDV ≈ tutar × oran
    // ya da hep 0 → hariç. Kanıt yoksa ya da anlaşılmazsa başlık tahmini kalır; okuma kontrolü "KDV dahil" tahminini sorar.
    if (useData) {
      const ev = suggestedVatEvidence({ headers, rows: rows! }, mapping);
      if (ev?.verdict === 'incl') {
        mapping.amountsIncludeVat = true;
        mapping.vatPct = ev.pct!;
      } else if (ev?.verdict === 'excl' || ev?.verdict === 'zero') mapping.amountsIncludeVat = false;
    }
  }
  if (mapping.billedKg && /\bdesi\b/.test(normalizeHeader(mapping.billedKg))) mapping.desiAsWeight = true;

  // Başlıktaki birim ipucu ("Weight (lbs)", "Dimensions (in)"): birim sütunu yoksa sabit birim olarak alınır.
  const unitHint = (fields: (string | undefined)[], re: RegExp) => fields.some((h) => h && re.test(normalizeHeader(h)));
  if (!mapping.actualKgUnit && !mapping.billedKgUnit && unitHint([mapping.actualKg, mapping.billedKg], /\b(lb|lbs|pound|pounds)\b/)) {
    mapping.defaultWeightUnit = 'lb';
  }
  if (!mapping.dimUnit && unitHint([mapping.dims, mapping.dimL, mapping.dimW, mapping.dimH], /\b(in|inch|inches)\b/)) mapping.defaultDimUnit = 'in';

  const missing = REQUIRED_MAPPING_FIELDS.filter((f) => !mapping[f]);
  const matched = Object.values(scores) as number[];
  const avg = matched.length ? matched.reduce((a, b) => a + b, 0) / matched.length : 0;
  let confidence: number;
  if (missing.length) {
    confidence = 0.3 * ((REQUIRED_MAPPING_FIELDS.length - missing.length) / REQUIRED_MAPPING_FIELDS.length) * avg;
  } else {
    const req = Math.min(scores.trackingNo ?? 0, scores.netAmount ?? 0);
    const hasWeight = mapping.billedKg || mapping.actualKg || mapping.dims || (mapping.dimL && mapping.dimW && mapping.dimH);
    confidence = 0.4 + 0.3 * req + 0.2 * avg * Math.min(1, matched.length / 6) + (hasWeight ? 0.1 : 0);
  }
  return { mapping, confidence: Math.round(Math.min(1, confidence) * 100) / 100, missing };
}

/**
 * Ambalaj sütunu: başlığı `PACKAGING_SYNONYMS`ten biri (normalleştirilmiş, tam eşleşme; sıradaki ilk) olan, başka alana
 * eşlenmemiş sütun. Satırlar verildiyse en az bir hücresi ambalaj olarak okunmalı (`parsePackaging`).
 */
function suggestPackagingColumn(normalized: string[], used: Set<number>, rows: string[][] | null, codes: 'fedex' | 'ups' | undefined): number | null {
  for (const syn of PACKAGING_SYNONYMS) {
    const idx = normalized.findIndex((nh, i) => nh === syn && !used.has(i));
    if (idx < 0) continue;
    if (rows && !rows.some((r) => parsePackaging(String(r[idx] ?? ''), codes) != null)) continue;
    return idx;
  }
  return null;
}

/** Okunmayan XLSX sayfası (KALANLAR 1.6): `invoiceLike` ise gönderi satırları taşıyor, okuma kontrolü onay ister. */
export type UnreadSheetInfo = { name: string; rows: number; invoiceLike: boolean };

/**
 * Tablonun okunmayan sayfaları. Fatura satırı taşıyor sayılır: veri satırı var ve okunan sayfanın takip no sütunu o sayfada
 * da var (aynı düzen: "Yurtiçi" + "Yurtdışı") ya da genel kalıp o sayfada takip no ile net tutar buluyor. "Özet", "Notlar"
 * gibi sayfalar yalnız bilgi olarak söylenir.
 */
export function unreadSheetsOf(t: Pick<Table, 'sheets'>, m?: Pick<ColumnMapping, 'trackingNo'>): UnreadSheetInfo[] {
  return (t.sheets?.unread ?? []).map((s) => {
    const sameLayout = !!m?.trackingNo && s.headers.includes(m.trackingNo);
    const invoiceLike = s.rows > 0 && (sameLayout || suggestMapping(s.headers, 'generic', s.sample).missing.length === 0);
    return { name: s.name, rows: s.rows, invoiceLike };
  });
}
