import type { ParsedInvoiceLine, PdfWeightAmbiguity } from "../../api/types";
import { numToInput, parseMeasure, parseTrNumber } from "../../lib/format";
import { getFormatLocale } from "../../lib/format";
import { relocalizeNumberText, relocalizeWeightText, weightChoice, type WeightReadings } from "../../lib/weightChoice";
import { uiAmbiguousSeparator, weightAs, type Locale, type WeightFormat } from "@deciship/core";

/**
 * PDF fatura adımının düzenlenebilir satırı ve okuma kuralı (saf; tarayıcısız sınanır, 10-B7).
 * Tutar `parseTrNumber` (binlik var); kg ve kenarlar `parseMeasure` (binlik yok; ölçüm formu ve mobil ile aynı).
 * K36 (kullanıcı kararı 2026-11-14): Türkçe arayüzde "1.500" kg 1,5 kg da 1500 kg da olabilir: hücre kırmızı, içe aktarma
 * kapalı, tablonun üstünde bir kez sorulur (`pdfWeightAmbiguity`, `applyPdfWeightChoice`). Kenarlarda (cm) soru yok.
 */
export interface PdfRow {
  key: string;
  rowIndex: number;
  rawHash: string;
  trackingNo: string;
  shipDate: string;
  destCountry: string;
  service: string;
  actualKg: string;
  billedKg: string;
  l: string;
  w: string;
  h: string;
  netAmount: string;
  surcharges: ParsedInvoiceLine["surcharges"];
  extra: Partial<ParsedInvoiceLine>;
  /**
   * K36: sunucunun metin denetimi bu ağırlığı PDF'te "1.500" gibi iki türlü basılı buldu (`pdfCheck.rows[].weightAmbiguity`).
   * `text`: işaretlendiğindeki hücre metni; `done`: kullanıcı seçti. Hücre metni değiştiyse (elle düzeltildi) soru kalkar.
   */
  weightAsk?: Partial<Record<"actualKg" | "billedKg", { readings: WeightReadings & { sep?: "." | ","; text?: string }; text: string; done?: boolean }>>;
}

const EDGES = ["l", "w", "h"] as const;
type Edge = (typeof EDGES)[number];
const isEdge = (k: keyof PdfRow): k is Edge => (EDGES as readonly string[]).includes(k);

// Sunucunun satır şemasıyla aynı sınırlar (`apps/api/src/routes/invoices.ts` `lineSchema`: takip no en çok 200 karakter,
// kg 0..9.999.999, cm > 0 ve ≤ 999.999, tutar ±999.999.999.999). Aşan hücre burada kırmızı yanar; yoksa içe aktarma hangi
// hücre olduğu söylenmeden düşerdi.
const MAX_TRACKING = 200;
const MAX_KG = 9_999_999;
const MAX_CM = 999_999;
const MAX_AMOUNT = 999_999_999_999;

const WEIGHTS = ["actualKg", "billedKg"] as const;
type WeightKey = (typeof WEIGHTS)[number];
const isWeight = (k: keyof PdfRow): k is WeightKey => (WEIGHTS as readonly string[]).includes(k);

/**
 * K36: ağırlık hücresi sorulmalı mı: yazılan metin iki türlü okunuyor ("1.500"; Türkçe arayüzde) ya da sunucu PDF'te iki türlü
 * basılı buldu ve kullanıcı henüz seçmedi, hücreyi de değiştirmedi. Okumaları, değilse null.
 */
export function pdfCellWeightChoice(r: PdfRow, k: keyof PdfRow): WeightReadings | null {
  if (!isWeight(k)) return null;
  const typed = weightChoice(r[k]);
  if (typed) return typed;
  const ask = r.weightAsk?.[k];
  return ask && !ask.done && r[k] === ask.text ? ask.readings : null;
}

/**
 * K36: arayüz dili değişince ekrandaki hücreler anlamını korur: tutar eski dilde okunup yeni dilde yazılır, kg ve kenarlar
 * binliksiz; seçilmemiş iki okumalı kg ("1.500" Türkçe) yeni dilin aynı yazımına geçer ("1,500" İngilizce), soru kalır.
 * Sunucunun sorusunun hücre metni de birlikte çevrilir. `key`siz satır da olur (değişiklik tabanı, `rowsKey`).
 */
export function relocalizePdfRows<R extends Omit<PdfRow, "key">>(rows: readonly R[], from: Locale, to: Locale): R[] {
  if (from === to) return [...rows];
  const kg = (v: string) => relocalizeWeightText(v, from, to, true);
  const cm = (v: string) => relocalizeWeightText(v, from, to, true);
  return rows.map((r) => {
    let weightAsk = r.weightAsk;
    if (weightAsk) {
      weightAsk = { ...weightAsk };
      for (const k of WEIGHTS) {
        const a = weightAsk[k];
        if (a) weightAsk[k] = { ...a, text: kg(a.text) };
      }
    }
    return {
      ...r,
      actualKg: kg(r.actualKg),
      billedKg: kg(r.billedKg),
      l: cm(r.l),
      w: cm(r.w),
      h: cm(r.h),
      netAmount: relocalizeNumberText(r.netAmount, from, to),
      ...(weightAsk ? { weightAsk } : {}),
    };
  });
}

/** K36: sunucunun PDF denetimindeki ağırlık sorularını satırlara ekler (hücrenin bugünkü metniyle; önceki seçim sıfırlanır). */
export function withPdfWeightAsks(rows: readonly PdfRow[], checks: readonly { rowIndex: number; weightAmbiguity?: PdfWeightAmbiguity }[]): PdfRow[] {
  const by = new Map(checks.filter((c) => c.weightAmbiguity).map((c) => [c.rowIndex, c.weightAmbiguity!]));
  if (!by.size) return [...rows];
  return rows.map((r) => {
    const amb = by.get(r.rowIndex);
    if (!amb) return r;
    const weightAsk: NonNullable<PdfRow["weightAsk"]> = { ...r.weightAsk };
    for (const k of WEIGHTS) {
      const readings = amb[k];
      if (readings) weightAsk[k] = { readings, text: r[k] };
    }
    return { ...r, weightAsk };
  });
}

/** K36: sunucuya bildirilecek satırlar: sorulan her ağırlığı seçilmiş ya da elle değiştirilmiş satırların no'ları. */
export function pdfWeightConfirmed(rows: readonly PdfRow[]): number[] {
  return rows
    .filter((r) => {
      const asks = WEIGHTS.map((k) => [k, r.weightAsk?.[k]] as const).filter(([, a]) => a);
      return asks.length > 0 && asks.every(([k, a]) => a!.done || r[k] !== a!.text);
    })
    .map((r) => r.rowIndex);
}

/** K36: sorulan hücrenin yazımı: okumaları, ayırıcısı ve gösterilecek yazım (sunucunun sorusunda PDF'te basılı olan). */
export type PdfWeightSample = { text: string; readings: WeightReadings; sep: "." | "," };

function cellSample(r: PdfRow, k: WeightKey): PdfWeightSample | null {
  const w = pdfCellWeightChoice(r, k);
  if (!w) return null;
  const ask = r.weightAsk?.[k];
  const fromServer = !weightChoice(r[k]) && ask;
  if (fromServer) {
    const text = ask.readings.text ?? r[k].trim();
    return { text, readings: w, sep: ask.readings.sep ?? (text.includes(",") ? "," : ".") };
  }
  return { text: r[k].trim(), readings: w, sep: uiAmbiguousSeparator(getFormatLocale()) };
}

/**
 * K36: tablodaki iki türlü okunan ağırlık hücreleri (tek soru için): her ayırıcıdan ilk örnek ("1.500" ve "1,500" birlikte
 * geçiyorsa ikisi de gösterilir) ve hücre sayısı.
 */
export function pdfWeightAmbiguity(rows: readonly PdfRow[]): { samples: PdfWeightSample[]; cells: number } | null {
  const samples: PdfWeightSample[] = [];
  let cells = 0;
  for (const r of rows)
    for (const k of WEIGHTS) {
      const s = cellSample(r, k);
      if (!s) continue;
      cells++;
      if (!samples.some((x) => x.sep === s.sep)) samples.push(s);
    }
  return samples.length ? { samples, cells } : null;
}

/**
 * K36: seçilen yazım biçimini (`tr`: "1.500" = 1500, "1,500" = 1,5; `en` tersi) bütün iki türlü okunan ağırlık hücrelerine
 * uygular; her hücre kendi ayırıcısına göre okunur, iki türlü okunmayan metinle yazılır ("1,5" / "1500").
 */
export function applyPdfWeightChoice(rows: readonly PdfRow[], fmt: WeightFormat): PdfRow[] {
  return rows.map((r) => {
    let out = r;
    for (const k of WEIGHTS) {
      const s = cellSample(r, k);
      if (!s) continue;
      out = { ...out, [k]: numToInput(weightAs(s.readings, s.sep, fmt)) };
      const ask = r.weightAsk?.[k];
      if (ask) out = { ...out, weightAsk: { ...out.weightAsk, [k]: { ...ask, done: true } } };
    }
    return out;
  });
}

const edgeOk = (s: string) => {
  const v = parseMeasure(s);
  return v !== null && v > 0 && v <= MAX_CM;
};

/**
 * Hücre kayda olduğu gibi gidemez mi (kırmızı + içe aktarma kapalı): takip no boş; net tutar okunamıyor ya da sınır dışı;
 * kg dolu ama okunamıyor, eksi, sınır dışı ya da iki türlü okunuyor (K36, "1.500"); kenar dolu ama okunamıyor, sıfır/eksi ya da sınır dışı; ya da bir kenar
 * dolu iken öteki kenar boş (üç kenar birlikte yoksa ölçü kaydedilmez, sessizce düşmesin).
 */
export function pdfCellInvalid(r: PdfRow, k: keyof PdfRow): boolean {
  const v = typeof r[k] === "string" ? (r[k] as string) : "";
  if (k === "trackingNo") return !v.trim() || v.trim().length > MAX_TRACKING;
  if (k === "netAmount") {
    const n = parseTrNumber(v);
    return n === null || Math.abs(n) > MAX_AMOUNT;
  }
  if (k === "actualKg" || k === "billedKg") {
    if (!v.trim()) return false;
    if (pdfCellWeightChoice(r, k)) return true;
    const n = parseMeasure(v);
    return n === null || n < 0 || n > MAX_KG;
  }
  if (isEdge(k)) {
    if (v.trim()) return !edgeOk(v);
    return EDGES.some((e) => r[e].trim() !== "");
  }
  return false;
}

const CHECKED: (keyof PdfRow)[] = ["trackingNo", "netAmount", "actualKg", "billedKg", ...EDGES];

/** Satırda içe aktarmayı durduran hücre var mı. */
export function pdfRowInvalid(r: PdfRow): boolean {
  return CHECKED.some((k) => pdfCellInvalid(r, k));
}

export function toPdfRow(l: ParsedInvoiceLine, i: number): PdfRow {
  const {
    rowIndex,
    rawHash,
    trackingNo,
    shipDate,
    destCountry,
    service,
    actualKg,
    billedKg,
    dims,
    netAmount,
    surcharges,
    ...extra
  } = l;
  return {
    key: `${i}-${rawHash}`,
    rowIndex: rowIndex ?? i,
    rawHash,
    trackingNo: trackingNo ?? "",
    shipDate: shipDate ?? "",
    destCountry: destCountry ?? "",
    service: service ?? "",
    actualKg: numToInput(actualKg),
    billedKg: numToInput(billedKg),
    l: numToInput(dims?.l, 1),
    w: numToInput(dims?.w, 1),
    h: numToInput(dims?.h, 1),
    netAmount: numToInput(netAmount, 2),
    surcharges: surcharges ?? [],
    extra,
  };
}

export function fromPdfRow(r: PdfRow): ParsedInvoiceLine {
  const m = (s: string) => parseMeasure(s) ?? undefined;
  const l = m(r.l);
  const w = m(r.w);
  const h = m(r.h);
  return {
    ...r.extra,
    rowIndex: r.rowIndex,
    rawHash: r.rawHash,
    trackingNo: r.trackingNo.trim(),
    shipDate: r.shipDate || undefined,
    destCountry: r.destCountry.trim().toUpperCase() || undefined,
    service: r.service.trim() || undefined,
    actualKg: m(r.actualKg),
    billedKg: m(r.billedKg),
    dims: l && w && h && l > 0 && w > 0 && h > 0 ? { l, w, h } : undefined,
    netAmount: parseTrNumber(r.netAmount) ?? 0,
    surcharges: r.surcharges,
  };
}

/** 01-B8: satırın para birimi (okumanın yazdığı, ISO kodu); yazmıyorsa faturanınki. */
export function pdfRowCurrency(r: Pick<PdfRow, "extra">, invoiceCurrency: string): string {
  const c = typeof r.extra.currency === "string" ? r.extra.currency.trim().toUpperCase() : "";
  return c || invoiceCurrency.trim().toUpperCase();
}

/**
 * 01-B8: PDF adımının toplamı para birimine göre (USD fatura, 3 EUR satır: iki toplam; farklı paralar toplanmaz). Önce
 * faturanın para birimi, sonra öbürleri alfabe sırasıyla. Okunamayan tutar 0 sayılır (hücre zaten kırmızı).
 */
export function pdfTotalsByCurrency(
  rows: readonly Pick<PdfRow, "extra" | "netAmount">[],
  invoiceCurrency: string,
): { currency: string; total: number; count: number }[] {
  const inv = invoiceCurrency.trim().toUpperCase();
  const by = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const c = pdfRowCurrency(r, inv);
    const e = by.get(c) ?? { total: 0, count: 0 };
    e.total += parseTrNumber(r.netAmount) ?? 0;
    e.count += 1;
    by.set(c, e);
  }
  return [...by]
    .map(([currency, e]) => ({ currency, total: Math.round(e.total * 100) / 100, count: e.count }))
    .sort((a, b) => (a.currency === inv ? -1 : b.currency === inv ? 1 : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}
