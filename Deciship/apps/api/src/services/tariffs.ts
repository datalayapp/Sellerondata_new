import { firmCurrency } from '../lib/settings.ts';
import { DEFAULT_TIME_ZONE, isTimeZone } from '../lib/time.ts';
import { currentLocale, m } from '../i18n/index.ts';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalSurchargeCode, carrierScope, countryAdjustmentLabel, countryName, intlLocale, scopeFuelVariable, zoneKey, type Locale } from '@deciship/core';
import { prisma, Prisma } from '../db.ts';
import { AppError, badRequest, notFound } from '../errors.ts';
import { num, parseDayInput } from '../lib/util.ts';
import type { TariffWithRelations } from './compare.ts';

const dateish = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'v.invalidDate')
  .nullable()
  .optional();

/** Decimal(14,2) sütunlarına sığan tutar (10^12'nin altı); daha büyüğü 400. */
const money = z.number().min(-999_999_999_999).max(999_999_999_999);

export const weightStepsSchema = z.array(
  z.object({ upto: z.number().positive().max(99999).nullable(), step: z.number().min(0.001).max(1000) }),
);

export const countryAdjustmentSchema = z.object({
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'v.countryCode'),
  /** işaretli yüzde: -15,45 → %15,45 daha ucuz */
  pct: z.number().min(-90).max(200),
  note: z.string().trim().max(300).nullable().optional(),
  source: z.enum(['manual', 'invoice']).default('manual'),
  invoiceId: z.string().max(100).nullable().optional(),
});
export type CountryAdjustment = z.infer<typeof countryAdjustmentSchema>;

export const tariffBody = z.object({
  carrierId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  service: z.string().trim().max(200).nullable().optional(),
  /** Verilmezse yeni tarifede firmanın para birimi, düzenlemede tarifenin kendi para birimi. */
  currency: z.string().trim().length(3).toUpperCase().optional(),
  divisor: z.number().int().min(1000).max(10000),
  edgeRounding: z.enum(['CEIL_CM', 'NONE']).default('CEIL_CM'),
  weightSteps: weightStepsSchema.default([]),
  discountPct: z.number().min(0).max(100).default(0),
  fuelPct: z.number().min(0).max(1000).default(0),
  /**
   * Yakıt değişken mi (faturadaki oran kabul edilir) yoksa sözleşmede sabit mi. Verilmezse yeni tarifede taşıyıcıya göre
   * (yurt dışı: değişken, yurt içi: sabit), düzenlemede tarifenin mevcut değeri kalır.
   */
  fuelVariable: z.boolean().optional(),
  validFrom: dateish,
  validTo: dateish,
  active: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  zones: z.array(z.object({ country: z.string().trim().min(1).max(3).toUpperCase(), zone: z.string().trim().min(1).max(40) })).default([]),
  rates: z
    .array(
      z.object({
        zone: z.string().trim().min(1).max(40),
        weightUpto: z.number().positive().max(99999),
        price: money.min(0),
        /** kg başı fiyat bandı: beklenen = fiyat × ücretli kg */
        perKg: z.boolean().default(false),
      }),
    )
    .default([]),
  overflow: z.array(z.object({ zone: z.string().trim().min(1).max(40), perUnit: money.min(0) })).default([]),
  surcharges: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(60),
        name: z.string().trim().max(200).default(''),
        kind: z.enum(['FIXED', 'PCT', 'PER_KG']),
        amount: money,
      }),
    )
    .default([]),
  /** SPEC §3.8: ülke istisnaları (ülke başına bir; aynı ülke tekrar ederse sonuncusu kalır) */
  countryAdjustments: z.array(countryAdjustmentSchema).default([]),
});
export type TariffBody = z.infer<typeof tariffBody>;

/**
 * Yazma uçlarının (POST/PUT /tariffs) ek denetimi; `tariffBody`'ye konmaz, çünkü eski sürüm anlık görüntüleri de onunla
 * okunur. Aynı bölge (zoneKey: "a" = "A" = "Zone A") ve ağırlık için ikinci fiyat ya da aynı gruptaki ikinci ek ücret
 * (canonicalSurchargeCode) 400: hesap motoru ilk eşleşeni alır, hangisinin geçerli olduğu okuma sırasına kalırdı (rapor 02-B10).
 */
export function assertNoDuplicateRows(body: Pick<TariffBody, 'rates' | 'surcharges'>) {
  const rates = new Map<string, number>();
  body.rates.forEach((r, i) => {
    const k = `${zoneKey(r.zone)}|${r.weightUpto}`;
    if (rates.has(k)) {
      const message = m('tariff.rateDuplicate', { zone: r.zone, weight: r.weightUpto });
      throw badRequest('VALIDATION', message, [{ path: `rates.${i}`, message }]);
    }
    rates.set(k, i);
  });
  const codes = new Set<string>();
  body.surcharges.forEach((s, i) => {
    const k = canonicalSurchargeCode(s.code);
    if (codes.has(k)) {
      const message = m('tariff.surchargeDuplicate', { code: s.code });
      throw badRequest('VALIDATION', message, [{ path: `surcharges.${i}`, message }]);
    }
    codes.add(k);
  });
}

/** Ülke istisnaları: ülke başına bir (sonuncusu kalır), 0 olanlar atılır, ülkeye göre sıralı. */
export function normalizeAdjustments(list: CountryAdjustment[]): CountryAdjustment[] {
  const m = new Map<string, CountryAdjustment>();
  for (const a of list) if (a.pct !== 0) m.set(a.country, a);
  return [...m.values()].sort((a, b) => a.country.localeCompare(b.country));
}

/** DB'deki JSON → istisna listesi (bozuk kayıtlar atlanır). */
export function readAdjustments(v: unknown): CountryAdjustment[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const p = countryAdjustmentSchema.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

/** Geçerlilik günü: Türkiye günü, UTC gece yarısı (bkz. parseDayInput; saatli değer bir önceki güne kaymaz). */
function dateOrNull(s: string | null | undefined) {
  return parseDayInput(s) ?? null;
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const m = new Map<string, T>();
  for (const it of items) m.set(key(it), it);
  return [...m.values()];
}

function children(companyId: string, body: Pick<TariffBody, 'zones' | 'rates' | 'overflow' | 'surcharges'>) {
  return {
    zones: { create: dedupe(body.zones, (z) => z.country).map((z) => ({ ...z, companyId })) },
    rates: { create: body.rates.map((r) => ({ ...r, companyId })) },
    overflow: { create: dedupe(body.overflow, (o) => o.zone).map((o) => ({ ...o, companyId })) },
    surcharges: { create: body.surcharges.map((c) => ({ ...c, companyId })) },
  };
}

/**
 * Taşıyıcı yurt içi mi: aras, yurtici, mng, ptt kodla; "Diğer" (generic) yalnız adıyla (core `carrierScope`; TNT, Aramex
 * yurt dışı, Sürat yurt içi). Adsız "Diğer" ya da bilinmeyen kod yurt içi sayılmaz (eski davranış).
 */
export function isDomesticCarrier(code: string | null | undefined, name?: string | null): boolean {
  const c = (code ?? '').trim().toLowerCase();
  if (c === 'generic') return !!name?.trim() && carrierScope({ code: c, name }) === 'domestic';
  return ['aras', 'yurtici', 'mng', 'ptt'].includes(c);
}

function scalars(body: TariffBody) {
  return {
    name: body.name,
    service: body.service ?? null,
    currency: body.currency,
    divisor: body.divisor,
    edgeRounding: body.edgeRounding,
    weightSteps: body.weightSteps,
    discountPct: body.discountPct,
    fuelPct: body.fuelPct,
    ...(body.fuelVariable !== undefined ? { fuelVariable: body.fuelVariable } : {}),
    validFrom: dateOrNull(body.validFrom),
    validTo: dateOrNull(body.validTo),
    active: body.active,
    isDefault: body.isDefault,
    countryAdjustments: normalizeAdjustments(body.countryAdjustments ?? []),
  };
}

/**
 * İşlem içinde çağrılır; ilişkileri (bölge/fiyat/…) geri okumaz. İşlem içinde birden çok ilişkiyi `include` ile
 * okumak Prisma'nın aynı bağlantıda paralel sorgu atmasına yol açıyor (pg: "client.query() when the client is
 * already executing a query", pg 9'da hata) ve işlemi uzatıyor. Tam tarifeyi işlemden sonra okuyun.
 * İşlem süreleri: db.ts TX_DEFAULTS.
 */
export async function createTariff(companyId: string, body: TariffBody, tx?: Prisma.TransactionClient) {
  // Sürüm tarifeyle aynı işlemde doğar: işlem verilmezse burada açılır.
  return tx ? createTariffTx(companyId, body, tx) : prisma.$transaction((t) => createTariffTx(companyId, body, t));
}

/**
 * Taşıyıcıda tek varsayılan: varsayılan işaretini değiştiren her işlem (yeni/kaydedilen varsayılan tarife, "Varsayılan yap")
 * önce bu kilidi alır. Önceki varsayılan `isDefault: true` süzgeciyle bulunduğu için kilitsiz iki eşzamanlı işlem birbirinin
 * henüz kaydedilmemiş işaretini göremez ve iki varsayılan bırakırdı (rapor 02-B10). Tarife satır kilidinden ÖNCE alınır.
 */
export async function lockCarrierDefault(tx: Prisma.TransactionClient, companyId: string, carrierId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tariff-default:${companyId}:${carrierId}`}, 0))`;
}

async function createTariffTx(companyId: string, body: TariffBody, tx: Prisma.TransactionClient) {
  if (body.isDefault) {
    await lockCarrierDefault(tx, companyId, body.carrierId);
    // yalnız önceki varsayılan: işareti değişmeyen tarifenin `updatedAt`'i oynamasın (düzenleyende sahte STALE olmasın)
    await tx.tariff.updateMany({ where: { companyId, carrierId: body.carrierId, isDefault: true }, data: { isDefault: false } });
  }
  const currency = body.currency ?? (await firmCurrency(companyId, tx));
  let fuelVariable = body.fuelVariable;
  if (fuelVariable === undefined) {
    // gövde yakıtı söylemiyorsa yeni tarifenin kapsamından (core `carrierScope`: yurt içi sabit, yurt dışı değişken; KALANLAR 1.1)
    const carrier = await tx.carrier.findFirst({ where: { id: body.carrierId, companyId }, select: { code: true, name: true } });
    fuelVariable = scopeFuelVariable(carrierScope(carrier));
  }
  const created = await tx.tariff.create({
    data: { companyId, carrierId: body.carrierId, ...scalars(body), fuelVariable, currency, ...children(companyId, body) },
  });
  const rev = await ensureTariffRevision(tx, created.id, companyId);
  return { ...created, currentRevisionId: rev.id };
}

export async function replaceTariff(id: string, companyId: string, body: TariffBody) {
  return prisma.$transaction(async (tx) => {
    if (body.isDefault) await lockCarrierDefault(tx, companyId, body.carrierId);
    return replaceTariffTx(tx, id, companyId, body);
  });
}

/** `body.isDefault` ise çağıran `lockCarrierDefault`'u (tarife satır kilidinden önce) almış olmalı. */
async function replaceTariffTx(tx: Prisma.TransactionClient, id: string, companyId: string, body: TariffBody) {
  if (body.isDefault) {
    await tx.tariff.updateMany({
      where: { companyId, carrierId: body.carrierId, id: { not: id }, isDefault: true },
      data: { isDefault: false },
    });
  }
  await tx.tariffZone.deleteMany({ where: { tariffId: id } });
  await tx.tariffRate.deleteMany({ where: { tariffId: id } });
  await tx.tariffOverflow.deleteMany({ where: { tariffId: id } });
  await tx.tariffSurcharge.deleteMany({ where: { tariffId: id } });
  const updated = await tx.tariff.update({
    where: { id },
    data: { carrierId: body.carrierId, ...scalars(body), ...children(companyId, body) },
  });
  const rev = await ensureTariffRevision(tx, id, companyId);
  return { ...updated, currentRevisionId: rev.id };
}

/**
 * Tarifeyi tümüyle değiştirir; değişiklikten önceki hâl aynı işlemde, tarife satırı kilitlendikten sonra okunup sürüm
 * olarak saklanır (rapor 02-B4: eşzamanlı iki kayıtta ara hâl de geri alınabilir kalır). `expectedUpdatedAt` verilirse
 * kilit altındaki `updatedAt` ile karşılaştırılır; tutmazsa 409 STALE (`details.updatedAt` = sunucudaki an) ve hiçbir şey
 * yazılmaz (rapor 10-B17). Verilmezse son kaydeden kazanır (eski istemci; içe aktarma ve geri yükleme).
 */
export async function replaceTariffVersioned(
  id: string,
  companyId: string,
  body: TariffBody,
  o: { userId: string | null; reason: 'IMPORT' | 'EDIT' | 'RESTORE'; label: string; expectedUpdatedAt?: Date },
): Promise<{ versionId: string }> {
  return prisma.$transaction(async (tx) => {
    // kilit sırası: önce taşıyıcının varsayılan kilidi, sonra tarife satırı ("Varsayılan yap" ile aynı sıra; kilitlenme olmaz)
    if (body.isDefault) await lockCarrierDefault(tx, companyId, body.carrierId);
    const [locked] = await tx.$queryRaw<{ updatedAt: Date }[]>`
      SELECT "updatedAt" FROM "Tariff" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`;
    if (!locked) throw notFound(m('invoice.tariffNotFound'));
    if (o.expectedUpdatedAt && locked.updatedAt.getTime() !== o.expectedUpdatedAt.getTime()) {
      throw new AppError(409, 'STALE', m('tariff.stale'), { updatedAt: locked.updatedAt.toISOString() });
    }
    const before = await readTariffInTx(tx, id, companyId);
    if (!before) throw notFound(m('invoice.tariffNotFound'));
    const version = await saveTariffVersion(serializeTariffFull(before), companyId, o.userId, o.reason, o.label, tx);
    await replaceTariffTx(tx, id, companyId, body);
    return { versionId: version.id };
  });
}

/**
 * Ülke istisnası ekler/günceller/kaldırır (pct 0). Önceki hâl ve yeni liste aynı işlemde, tarife satırı kilitlendikten
 * sonra okunur: eşzamanlı bir kayıt ya da ikinci istisna arada yazılmışsa üzerine eski listeyle yazılmaz (kayıp
 * güncelleme yok) ve geri alma sürümü gerçekten ezilen hâli saklar (rapor 02-B4 ile aynı kural).
 */
export async function applyCountryAdjustment(
  id: string,
  companyId: string,
  adjustment: CountryAdjustment,
  o: { userId: string | null; label: string },
): Promise<{ versionId: string }> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Tariff" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`;
    if (!locked) throw notFound(m('invoice.tariffNotFound'));
    const cur = await readTariffInTx(tx, id, companyId);
    if (!cur) throw notFound(m('invoice.tariffNotFound'));
    const before = serializeTariffFull(cur);
    const version = await saveTariffVersion(before, companyId, o.userId, 'EDIT', o.label, tx);
    const next = normalizeAdjustments([...before.countryAdjustments.filter((a) => a.country !== adjustment.country), adjustment]);
    await tx.tariff.update({ where: { id }, data: { countryAdjustments: next } });
    await ensureTariffRevision(tx, id, companyId);
    return { versionId: version.id };
  });
}

export function serializeTariffFull(t: TariffWithRelations & { carrier?: { id: string; name: string; code: string } }) {
  return {
    id: t.id,
    carrierId: t.carrierId,
    carrier: t.carrier ? { id: t.carrier.id, name: t.carrier.name, code: t.carrier.code } : undefined,
    name: t.name,
    service: t.service,
    currency: t.currency,
    divisor: t.divisor,
    edgeRounding: t.edgeRounding,
    weightSteps: t.weightSteps,
    discountPct: num(t.discountPct),
    fuelPct: num(t.fuelPct),
    fuelVariable: t.fuelVariable,
    validFrom: t.validFrom ? t.validFrom.toISOString().slice(0, 10) : null,
    validTo: t.validTo ? t.validTo.toISOString().slice(0, 10) : null,
    active: t.active,
    isDefault: t.isDefault,
    zones: [...t.zones].sort((a, b) => a.country.localeCompare(b.country)).map((z) => ({ country: z.country, zone: z.zone })),
    rates: [...t.rates]
      .sort((a, b) => a.zone.localeCompare(b.zone) || num(a.weightUpto) - num(b.weightUpto))
      .map((r) => ({ zone: r.zone, weightUpto: num(r.weightUpto), price: num(r.price), perKg: r.perKg })),
    overflow: t.overflow.map((o) => ({ zone: o.zone, perUnit: num(o.perUnit) })),
    surcharges: t.surcharges.map((s) => ({ code: s.code, name: s.name, kind: s.kind, amount: num(s.amount) })),
    countryAdjustments: readAdjustments(t.countryAdjustments),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ---------- Sürümler (geri alma) ----------

type VersionLabelKey = 'version.edit' | 'version.import' | 'version.restore' | 'version.adjustmentRemoved' | 'version.adjustmentApplied';

/** Sürüm etiketi kayıtta anahtar + değerlerdir: dil değişince doğru okunur. */
export function versionLabel(k: VersionLabelKey, p: Record<string, string | number> = {}): string {
  return JSON.stringify({ k, p });
}

/**
 * `timeZone`: geri alma etiketindeki saatin yazıldığı saat dilimi; firmanın saat dilimi verilir (rapor Y132).
 * Yalnız gösterim: kayıtta an (`p.at`, ISO) durur, okurken çevrilir.
 */
export function readVersionLabel(raw: string, locale: Locale = currentLocale(), timeZone: string = DEFAULT_TIME_ZONE): string {
  let parsed: { k?: VersionLabelKey; p?: Record<string, string | number> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const { k, p = {} } = parsed;
  switch (k) {
    case 'version.adjustmentRemoved':
      return m(k, { country: countryName(String(p.country), locale) }, locale);
    case 'version.adjustmentApplied':
      return m(k, { label: countryAdjustmentLabel({ country: String(p.country), pct: Number(p.pct) }, locale) }, locale);
    case 'version.restore':
      return m(k, { when: new Date(String(p.at)).toLocaleString(intlLocale(locale), { timeZone: isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }, locale);
    case 'version.edit':
    case 'version.import':
      return m(k, p, locale);
    default:
      return raw;
  }
}

export type TariffFull = ReturnType<typeof serializeTariffFull>;

/** Tam tarife → tariffBody biçiminde anlık görüntü (geri yükleme = replaceTariff(tariffBody.parse(snapshot))). */
export function tariffSnapshot(full: TariffFull): TariffBody {
  const { id: _id, carrier: _c, createdAt: _ca, updatedAt: _ua, ...rest } = full;
  return tariffBody.parse({ ...rest, weightSteps: Array.isArray(rest.weightSteps) ? rest.weightSteps : [] });
}

export const VERSION_KEEP = 50;

/** Değişiklikten ÖNCEKİ hâli saklar; tarife başına en yeni 50 sürüm tutulur. */
export async function saveTariffVersion(
  full: TariffFull,
  companyId: string,
  userId: string | null,
  reason: 'IMPORT' | 'EDIT' | 'RESTORE',
  label: string,
  tx?: Prisma.TransactionClient,
) {
  const db = tx ?? prisma;
  const snapshot = tariffSnapshot(full);
  const v = await db.tariffVersion.create({
    data: {
      companyId,
      tariffId: full.id,
      userId,
      reason,
      label,
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      rateCount: snapshot.rates.length,
      zoneCount: new Set(snapshot.rates.map((r) => r.zone)).size,
      countryCount: snapshot.zones.length,
      currency: full.currency,
    },
  });
  const old = await db.tariffVersion.findMany({
    where: { tariffId: full.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: VERSION_KEEP,
    select: { id: true },
  });
  if (old.length) await db.tariffVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return v;
}

// ---------- Fiyat sürümü (faturanın dayanağı) ----------
//
// TariffRevision, tarifenin fiyat içeriğinin değişmez anlık görüntüsüdür: fatura hesaplandığı sürüme bağlanır ve tarife
// sonradan değişse ya da silinse de aynı rakamda kalır. Geri alma için tutulan TariffVersion'dan ayrıdır (o, değişiklikten
// önceki hâli saklar ve budanır; bu hiç silinmez, güncellenmez; istisna: contentHash etiketi ve güncel sürümün adı).

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 15.50 = 15.5, -0 = 0; sayı olmayan değer olduğu gibi kalır (özet yine belirlenimlidir). */
const canonNum = (x: unknown) => {
  const v = typeof x === 'number' ? x : Number(x);
  if (!Number.isFinite(v)) return null;
  return Object.is(v, -0) ? 0 : v;
};

/**
 * Sürümü belirleyen alanların kanonik özeti (sha256, hex): fiyatı etkileyen alanlar ve taşıyıcı. Taşıyıcı girer çünkü
 * sürüm bir taşıyıcının fiyatıdır: tarife başka taşıyıcıya taşınınca yeni sürüm doğar, eski taşıyıcının faturaları eski
 * sürümde kalır (`revisionOfCarrier` sürümün taşıyıcısını okur). Ad, etkinlik, varsayılan, geçerlilik tarihleri, ek
 * ücretin adı ve ülke istisnasının notu/kaynağı girmez (hesap bunları kullanmaz). Hesap motorunda sırası önemsiz olan
 * diziler sıralanır; sırası önemli olanlar korunur: ağırlık basamakları (ilk eşleşen basamak), aynı bölge + ağırlıktaki
 * fiyat satırları ve aynı kanonik koddaki ek ücretler (ilk eşleşen) dizideki göreli sırasını korur (kararlı sıralama).
 */
export function tariffContentHash(snapshot: TariffBody): string {
  const s = snapshot;
  const service = typeof s.service === 'string' && s.service.trim() ? s.service.trim() : null;
  const zones = dedupe(s.zones ?? [], (z) => z.country.trim().toUpperCase())
    .map((z) => [z.country.trim().toUpperCase(), z.zone] as const)
    .sort((a, b) => cmp(a[0], b[0]));
  const rates = [...(s.rates ?? [])]
    .map((r) => [r.zone, canonNum(r.weightUpto), canonNum(r.price), r.perKg === true] as const)
    .sort((a, b) => cmp(a[0], b[0]) || (a[1] ?? 0) - (b[1] ?? 0));
  const overflow = dedupe(s.overflow ?? [], (o) => o.zone)
    .map((o) => [o.zone, canonNum(o.perUnit)] as const)
    .sort((a, b) => cmp(a[0], b[0]));
  const surcharges = [...(s.surcharges ?? [])]
    .map((c) => ({ key: canonicalSurchargeCode(c.code), row: [c.code, c.kind, canonNum(c.amount)] as const }))
    .sort((a, b) => cmp(a.key, b.key))
    .map((x) => x.row);
  const adjustments = normalizeAdjustments(
    (s.countryAdjustments ?? []).map((a) => ({ ...a, country: a.country.trim().toUpperCase() })),
  ).map((a) => [a.country, canonNum(a.pct)] as const);
  const canonical = {
    v: 2,
    carrierId: s.carrierId,
    currency: (s.currency ?? '').trim().toUpperCase(),
    divisor: canonNum(s.divisor),
    edgeRounding: s.edgeRounding ?? 'CEIL_CM',
    weightSteps: (Array.isArray(s.weightSteps) ? s.weightSteps : []).map((w) => [w.upto == null ? null : canonNum(w.upto), canonNum(w.step)]),
    discountPct: canonNum(s.discountPct ?? 0),
    fuelPct: canonNum(s.fuelPct ?? 0),
    fuelVariable: s.fuelVariable === true,
    service,
    zones,
    rates,
    overflow,
    surcharges,
    countryAdjustments: adjustments,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Tarifeyi işlem içinde, alt tablolarını sırayla okuyarak tam hâliyle kurar (`include` yok: createTariff üstündeki uyarı).
 * Satırların okuma sırası canlı okumayla (`include`) aynıdır: sıralama verilmez.
 */
async function readTariffInTx(tx: Prisma.TransactionClient, tariffId: string, companyId: string): Promise<TariffWithRelations | null> {
  const t = await tx.tariff.findFirst({ where: { id: tariffId, companyId } });
  if (!t) return null;
  const zones = await tx.tariffZone.findMany({ where: { tariffId } });
  const rates = await tx.tariffRate.findMany({ where: { tariffId } });
  const overflow = await tx.tariffOverflow.findMany({ where: { tariffId } });
  const surcharges = await tx.tariffSurcharge.findMany({ where: { tariffId } });
  return { ...t, zones, rates, overflow, surcharges };
}

/** Tarifenin bugünkü fiyat içeriğinin değişmez sürümünü döndürür; içerik son sürümle aynıysa yeni sürüm açmaz. */
export async function ensureTariffRevision(
  tx: Prisma.TransactionClient,
  tariffId: string,
  companyId: string,
): Promise<{ id: string; created: boolean }> {
  // Eşzamanlı iki düzenleme aynı içerik için iki sürüm açmasın: tarife satırı işlem sonuna dek kilitli.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tariff" WHERE "id" = ${tariffId} AND "companyId" = ${companyId} FOR UPDATE`;
  if (!locked.length) throw new Error(`ensureTariffRevision: tariff ${tariffId} not found`);
  const t = await readTariffInTx(tx, tariffId, companyId);
  if (!t) throw new Error(`ensureTariffRevision: tariff ${tariffId} not found`);
  const snapshot = tariffSnapshot(serializeTariffFull(t));
  const contentHash = tariffContentHash(snapshot);

  if (t.currentRevisionId) {
    const cur = await tx.tariffRevision.findFirst({
      where: { id: t.currentRevisionId, companyId },
      select: { id: true, contentHash: true, snapshot: true, tariffName: true },
    });
    let same = !!cur && cur.contentHash === contentHash;
    // Özet boşsa (göçte doldurulan sürüm) ya da başka kuralla yazılmışsa (özete giren alanlar değişti) karşılaştırma
    // sürümün kendi anlık görüntüsünden bugünkü kuralla yapılır: içerik aynıysa yeni sürüm açılmaz, etiket düzelir.
    if (cur && !same) {
      const parsed = tariffBody.safeParse(cur.snapshot);
      same = parsed.success && tariffContentHash(parsed.data) === contentHash;
    }
    if (cur && same) {
      // Sürümün fiyat içeriği değişmez. Yalnız iki etiket güncellenir: boş ya da eski kurallı özet ve güncel sürümün adı
      // (tarife yeniden adlandırılınca; silinen tarifenin faturalarında bu ad görünür).
      const data = {
        ...(cur.contentHash !== contentHash ? { contentHash } : {}),
        ...(cur.tariffName !== t.name ? { tariffName: t.name } : {}),
      };
      if (Object.keys(data).length) await tx.tariffRevision.updateMany({ where: { id: cur.id, companyId }, data });
      return { id: cur.id, created: false };
    }
  }

  const rev = await tx.tariffRevision.create({
    data: {
      companyId,
      tariffId,
      tariffName: t.name,
      contentHash,
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      currency: snapshot.currency ?? t.currency,
    },
    select: { id: true },
  });
  // Ham SQL: Prisma'nın update'i updatedAt'i oynatır; varsayılan tarife seçimi (defaultTariff) bu sütuna bakar.
  await tx.$executeRaw`UPDATE "Tariff" SET "currentRevisionId" = ${rev.id} WHERE "id" = ${tariffId} AND "companyId" = ${companyId}`;
  return { id: rev.id, created: true };
}
