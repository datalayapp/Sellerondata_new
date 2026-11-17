/**
 * Fatura satırlarının toplu yazımı. Binlerce satırda Prisma'nın createMany / satır başına update'i hem sorgu
 * derleyicisinde hem veritabanı gidiş-dönüşünde saniyeler harcıyordu; burada her parça tek SQL ifadesi ve tek
 * JSON parametresidir (jsonb_to_recordset). Yazılan değerler Prisma ile yazılanlarla aynıdır.
 */
import crypto from 'node:crypto';
import type { ParsedInvoiceLine } from '@deciship/core';
import { prisma, Prisma } from '../db.ts';
import { num } from '../lib/util.ts';
import type { PrevResult, RecalcPendingCause, resultToLineData } from './compare.ts';

type Db = Pick<Prisma.TransactionClient, '$executeRawUnsafe'>;
type LineRow = Prisma.InvoiceLineGetPayload<object>;
type LineResultData = ReturnType<typeof resultToLineData>;
export type LineResultUpdate = LineResultData & {
  id: string;
  keepNote: boolean;
  /** Verilirse satırın bir önceki sonucu olarak yazılır; verilmezse kayıtlı `prevResult` olduğu gibi kalır. */
  prevResult?: PrevResult;
};
/** Donmuş satırda bekleyen değişiklik işareti; `cause: null` işareti siler. */
export type RecalcPendingMark = { id: string; cause: RecalcPendingCause | null };

const CHUNK = 2000;

/**
 * createdAt/updatedAt: Prisma gibi uygulama saatiyle, UTC (ör. "2026-11-06 01:02:03.456"). Veritabanının now()'ı
 * `timestamp without time zone` sütununa oturumun TimeZone ayarıyla yazılır; sunucu UTC değilse saatler kayardı.
 */
const utcNow = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/** JSON'a çevrilince sessizce null olacak sayıları (NaN/Infinity) yakalar — Prisma da bunları reddeder. */
function finite(v: number | null | undefined, field: string): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v)) throw new Error(`Geçersiz sayı (${field}): ${v}`);
  return v;
}

/**
 * Decimal sütun değeri: Prisma JS sayısını 16 anlamlı basamakla ondalığa çevirir, sütun ölçeğine yuvarlama ondan
 * sonra olur. Sayı JSON'daki en kısa biçimiyle verilseydi yarıma denk gelen değerler başka yöne yuvarlanırdı
 * (270.17499999999995 → 270.17, Prisma 270.18; 31.749999999999996 cm → 31.7, Prisma 31.8).
 */
function dec(v: number | null | undefined, field: string): string | null {
  const n = finite(v, field);
  return n == null ? null : n.toPrecision(16);
}

/**
 * Sayının veritabanına yazılınca alacağı değer: `dec` ile aynı 16 anlamlı basamak, sonra sütun ölçeğine Postgres
 * `numeric` gibi yarım sıfırdan uzağa (31.749999999999996 → 31.8, 33.02 → 33.0). Sayı değilse dokunmaz.
 */
export function storedNumber(v: number, scale: number): number {
  if (!Number.isFinite(v)) return v;
  const r = new Prisma.Decimal(v.toPrecision(16)).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  return r === 0 ? 0 : r;
}

/**
 * Kenarı 0,1 cm'ye yukarı (sıfırdan uzağa) yuvarlar; kayan nokta gürültüsü önce 12 anlamlı basamakla temizlenir (core
 * `roundEdges` gibi: 33.019999999999996 → 33.02 → 33.1, 40.00000000000001 → 40). Sonuç zaten 1 ondalıktır: veritabanı
 * aynen saklar. Neden yarım-yukarı değil: tarifenin "kenar yukarı tam cm" kuralında (CEIL_CM, varsayılan) 0,1'e yukarı
 * yuvarlanan kenar aynı tam cm'yi verir; yarım-yukarı 13 inç = 33,02 cm'yi 33,0 yapıp kenarı 34 yerine 33 sayıyordu
 * (taşıyıcının doğru faturası "fiyat farkı" görünürdü). 0,1 cm'lik ölçüm eşiklerini de yanlış yönde aşmaz.
 */
export function storedEdge(v: number): number {
  if (!Number.isFinite(v)) return v;
  const r = new Prisma.Decimal(v.toPrecision(12)).toDecimalPlaces(LINE_SCALE.cm, Prisma.Decimal.ROUND_UP).toNumber();
  return r === 0 ? 0 : r;
}

/** `InvoiceLine` sayı sütunlarının ölçeği (schema.prisma: kg Decimal(10,3), cm Decimal(8,1), tutar Decimal(14,2), bölen Int). */
export const LINE_SCALE = { kg: 3, cm: 1, amount: 2, divisor: 0 } as const;

/**
 * DENETIM-2 01-B7: içe aktarılan satırı veritabanının saklayacağı hassasiyete getirir. İçe aktarma karşılaştırmayı bu satırla
 * yapar ve onu yazar; "Yeniden karşılaştır" aynı sayıyı veritabanından okur, sonuç kendiliğinden değişmez. Eskiden 13 in =
 * 33,02 cm içe aktarmada 33,02 ile, yeniden karşılaştırmada saklanan 33,0 ile hesaplanıyordu. Kenarlar 0,1 cm'ye yukarı
 * (`storedEdge`: 33,02 → 33,1), kg (3), tutar (2) ve bölen (tam sayı) veritabanının yarım-yukarı kuralıyla (`storedNumber`).
 * Göç yerine (ölçeği büyütmek) bu seçildi. Ek ücretler JSON'dadır, olduğu gibi saklanır: dokunulmaz. Zaten bu ölçekteki
 * satır aynen döner.
 */
export function atStoredPrecision<T extends ParsedInvoiceLine>(l: T): T {
  const opt = (v: number | undefined, scale: number) => (v == null ? v : storedNumber(v, scale));
  const out: T = { ...l, netAmount: storedNumber(l.netAmount, LINE_SCALE.amount) };
  if (l.actualKg != null) out.actualKg = opt(l.actualKg, LINE_SCALE.kg);
  if (l.billedKg != null) out.billedKg = opt(l.billedKg, LINE_SCALE.kg);
  if (l.dims) out.dims = { l: storedEdge(l.dims.l), w: storedEdge(l.dims.w), h: storedEdge(l.dims.h) };
  if (l.billedDivisor != null) out.billedDivisor = opt(l.billedDivisor, LINE_SCALE.divisor);
  if (l.baseAmount != null) out.baseAmount = opt(l.baseAmount, LINE_SCALE.amount);
  if (l.discountAmount != null) out.discountAmount = opt(l.discountAmount, LINE_SCALE.amount);
  if (l.fuelAmount != null) out.fuelAmount = opt(l.fuelAmount, LINE_SCALE.amount);
  return out;
}

const RESULT_COLUMNS = `
  "measurementId" text, "tariffId" text, "tariffRevisionId" text, "status" text, "diffTypes" jsonb,
  "ourChargeableKg" numeric, "billedChargeableKg" numeric, "expectedAmount" numeric, "diffAmount" numeric,
  "breakdown" jsonb, "pricing" jsonb, "note" text`;

/** jsonb dizisini sırası korunarak text[]'e çevirir. */
const textArray = (col: string) => `ARRAY(SELECT t.e FROM jsonb_array_elements_text(${col}) WITH ORDINALITY AS t(e, i) ORDER BY t.i)`;

function resultJson(d: LineResultData) {
  return {
    measurementId: d.measurementId,
    tariffId: d.tariffId,
    tariffRevisionId: d.tariffRevisionId ?? null,
    status: d.status,
    diffTypes: d.diffTypes,
    ourChargeableKg: dec(d.ourChargeableKg, 'ourChargeableKg'),
    billedChargeableKg: dec(d.billedChargeableKg, 'billedChargeableKg'),
    expectedAmount: dec(d.expectedAmount, 'expectedAmount'),
    diffAmount: dec(d.diffAmount, 'diffAmount'),
    breakdown: d.breakdown ?? [],
    pricing: d.pricing ?? null,
    note: d.note,
  };
}

export type NewInvoiceLine = LineResultData & {
  companyId: string;
  rowIndex: number;
  trackingNo: string;
  shipDate: Date | null;
  service: string | null;
  destCountry: string | null;
  actualKg: number | null;
  billedKg: number | null;
  dimL: number | null;
  dimW: number | null;
  dimH: number | null;
  billedDivisor: number | null;
  baseAmount: number | null;
  discountAmount: number | null;
  fuelAmount: number | null;
  surcharges: unknown;
  netAmount: number;
  currency: string | null;
  reference: string | null;
  rawHash: string;
  parseFlags: string[];
  decision: 'OPEN' | 'VERIFIED' | 'ACCEPTED';
};

const INSERT_SQL = `
  INSERT INTO "InvoiceLine" (
    "id", "invoiceId", "companyId", "rowIndex", "trackingNo", "shipDate", "service", "destCountry",
    "actualKg", "billedKg", "dimL", "dimW", "dimH", "billedDivisor", "baseAmount", "discountAmount", "fuelAmount",
    "surcharges", "netAmount", "currency", "reference", "rawHash", "parseFlags", "decision",
    "measurementId", "tariffId", "tariffRevisionId", "status", "diffTypes", "ourChargeableKg", "billedChargeableKg", "expectedAmount",
    "diffAmount", "breakdown", "pricing", "note", "createdAt", "updatedAt"
  )
  SELECT
    v."id", $2, v."companyId", v."rowIndex", v."trackingNo", v."shipDate", v."service", v."destCountry",
    v."actualKg", v."billedKg", v."dimL", v."dimW", v."dimH", v."billedDivisor", v."baseAmount", v."discountAmount", v."fuelAmount",
    v."surcharges", v."netAmount", v."currency", v."reference", v."rawHash", ${textArray('v."parseFlags"')}, v."decision"::"Decision",
    v."measurementId", v."tariffId", v."tariffRevisionId", v."status"::"LineStatus", ${textArray('v."diffTypes"')}, v."ourChargeableKg", v."billedChargeableKg",
    v."expectedAmount", v."diffAmount", v."breakdown", v."pricing", v."note", $3::timestamp(3), $3::timestamp(3)
  FROM jsonb_to_recordset($1::jsonb) AS v(
    "id" text, "companyId" text, "rowIndex" integer, "trackingNo" text, "shipDate" timestamp(3), "service" text,
    "destCountry" text, "actualKg" numeric, "billedKg" numeric, "dimL" numeric, "dimW" numeric, "dimH" numeric,
    "billedDivisor" integer, "baseAmount" numeric, "discountAmount" numeric, "fuelAmount" numeric, "surcharges" jsonb,
    "netAmount" numeric, "currency" text, "reference" text, "rawHash" text, "parseFlags" jsonb, "decision" text,
    ${RESULT_COLUMNS}
  )`;

/** Yeni faturanın satırlarını toplu ekler (createMany yerine; aynı işlem içinde çağrılır). */
export async function insertInvoiceLines(db: Db, invoiceId: string, lines: NewInvoiceLine[]) {
  const now = utcNow();
  for (const c of chunks(lines)) {
    const rows = c.map((l) => ({
      id: crypto.randomUUID(),
      companyId: l.companyId,
      rowIndex: l.rowIndex,
      trackingNo: l.trackingNo,
      shipDate: l.shipDate ? l.shipDate.toISOString() : null,
      service: l.service,
      destCountry: l.destCountry,
      actualKg: dec(l.actualKg, 'actualKg'),
      billedKg: dec(l.billedKg, 'billedKg'),
      dimL: dec(l.dimL, 'dimL'),
      dimW: dec(l.dimW, 'dimW'),
      dimH: dec(l.dimH, 'dimH'),
      billedDivisor: finite(l.billedDivisor, 'billedDivisor'),
      baseAmount: dec(l.baseAmount, 'baseAmount'),
      discountAmount: dec(l.discountAmount, 'discountAmount'),
      fuelAmount: dec(l.fuelAmount, 'fuelAmount'),
      surcharges: l.surcharges ?? [],
      netAmount: dec(l.netAmount, 'netAmount'),
      currency: l.currency,
      reference: l.reference,
      rawHash: l.rawHash,
      parseFlags: l.parseFlags,
      decision: l.decision,
      ...resultJson(l),
    }));
    await db.$executeRawUnsafe(INSERT_SQL, JSON.stringify(rows), invoiceId, now);
  }
}

const UPDATE_SQL = `
  UPDATE "InvoiceLine" AS l SET
    "measurementId" = v."measurementId",
    "tariffId" = v."tariffId",
    "tariffRevisionId" = v."tariffRevisionId",
    "prevResult" = CASE WHEN v."setPrev" THEN v."prevResult" ELSE l."prevResult" END,
    "recalcPending" = NULL,
    "recalcPendingAt" = NULL,
    "status" = v."status"::"LineStatus",
    "diffTypes" = ${textArray('v."diffTypes"')},
    "ourChargeableKg" = v."ourChargeableKg",
    "billedChargeableKg" = v."billedChargeableKg",
    "expectedAmount" = v."expectedAmount",
    "diffAmount" = v."diffAmount",
    "breakdown" = v."breakdown",
    "pricing" = v."pricing",
    "note" = CASE WHEN v."keepNote" THEN l."note" ELSE v."note" END,
    "updatedAt" = $2::timestamp(3)
  FROM jsonb_to_recordset($1::jsonb) AS v("id" text, "keepNote" boolean, "setPrev" boolean, "prevResult" jsonb, ${RESULT_COLUMNS})
  WHERE l."id" = v."id"`;

/**
 * Yeniden karşılaştırma sonuçlarını toplu yazar; tüm parçalar tek işlemde (yarım kalan karşılaştırma olmaz).
 * `keepNote`: yöneticinin yazdığı not korunur. `tx` verilirse çağıranın işleminde yazar (fatura kilidi altında, toplamla birlikte).
 * Yazılan satır artık güncel sonucu taşır: sürümü (`tariffRevisionId`) hesabın sürümü olur, bekleyen değişiklik işareti
 * (`recalcPending`) silinir; `prevResult` yalnız verildiyse değişir.
 */
export async function writeLineResults(updates: LineResultUpdate[], tx?: Db) {
  if (!updates.length) return;
  const now = utcNow();
  const write = async (db: Db) => {
    for (const c of chunks(updates)) {
      await db.$executeRawUnsafe(UPDATE_SQL, JSON.stringify(c.map((u) => ({ id: u.id, keepNote: u.keepNote, setPrev: u.prevResult !== undefined, prevResult: u.prevResult ?? null, ...resultJson(u) }))), now);
    }
  };
  if (tx) await write(tx);
  else await prisma.$transaction(write);
}

const PENDING_SQL = `
  UPDATE "InvoiceLine" AS l SET
    "recalcPending" = v."cause",
    "recalcPendingAt" = CASE WHEN v."cause" IS NULL THEN NULL ELSE $2::timestamp(3) END,
    "updatedAt" = $2::timestamp(3)
  FROM jsonb_to_recordset($1::jsonb) AS v("id" text, "cause" text)
  WHERE l."id" = v."id"`;

/**
 * Donmuş satırlarda bekleyen değişiklik işaretini toplu yazar ya da siler; satırın sonucuna dokunmaz. Fatura kilidi
 * altında, sonuç yazımıyla aynı işlemde çağrılır.
 */
export async function writeRecalcPending(marks: RecalcPendingMark[], tx: Db) {
  if (!marks.length) return;
  const now = utcNow();
  for (const c of chunks(marks)) await tx.$executeRawUnsafe(PENDING_SQL, JSON.stringify(c), now);
}

/** Anahtar sırasından bağımsız JSON (jsonb anahtarları yeniden sıralar). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const sameNum = (a: Prisma.Decimal | null, b: number | null) => (a == null ? b == null : b != null && num(a) === b);

/** Kayıtlı satır sonucu yeni karşılaştırmadan farklı mı? Şüphede "farklı" der (yeniden yazılır). */
export function lineResultChanged(row: LineRow, d: LineResultData): boolean {
  return !(
    row.measurementId === d.measurementId &&
    row.tariffId === d.tariffId &&
    row.tariffRevisionId === (d.tariffRevisionId ?? null) &&
    row.status === d.status &&
    row.diffTypes.join(',') === d.diffTypes.join(',') &&
    sameNum(row.ourChargeableKg, d.ourChargeableKg) &&
    sameNum(row.billedChargeableKg, d.billedChargeableKg) &&
    sameNum(row.expectedAmount, d.expectedAmount) &&
    sameNum(row.diffAmount, d.diffAmount) &&
    (row.noteManual || row.note === d.note) &&
    stableJson(row.breakdown) === stableJson(d.breakdown) &&
    stableJson(row.pricing) === stableJson(d.pricing)
  );
}
