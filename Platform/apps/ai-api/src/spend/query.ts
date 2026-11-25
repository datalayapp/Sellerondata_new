import type { FastifyRequest } from 'fastify';
import {
  AI_CALL_STATUSES,
  AI_SPEND_MAX_MONTHS_BACK,
  AI_SPEND_MEMBER_NONE,
  AI_TRY_PER_USD_DEFAULT,
  aiMicrosToAmount,
  aiMicroUsdToMicroTry,
  aiProductKeys,
  isAiPurposeOf,
  requestLocaleOf,
  type AiCallStatus,
  type Locale,
  type ProductKey,
} from '@sellerondata/contracts';
import type { Principal } from '../auth/platform.ts';
import type { PrismaClient } from '../db.ts';
import { AppError, forbidden, invalidField } from '../errors.ts';
import { tryPerUsd } from '../ledger/pricing.ts';
import { safeTimeZone } from '../limits/periods.ts';
import { translator, type Translate } from './text.ts';

/**
 * Merkez harcama görünümünün ortak kuralları (sözleşme `aiSpend.ts`): kim neyi görür, sorgu süzgeçleri, dönem pencereleri, para birimi.
 *
 * Erişim:
 * - Firma görünümü (`scope` yok ya da `org`): jetondaki etkin firmanın OWNER'ı ya da ADMIN'i. Firma kimliği YALNIZ jetondan gelir;
 *   sorgudaki `org` firma görünümünde `400 VALIDATION` (başka firmayı seçmenin yolu yok). Diğer üyeler ve firmasız jeton `403 FORBIDDEN`.
 * - Platform görünümü (`scope=platform`): yalnız `op`; bütün firmalar, `org` süzgeciyle.
 * Tutar firma görünümünde TL (kur `AI_PRICE_TRY_PER_USD`, ekran kuru, bütün satırlara aynı) [V]; platformda TL (varsayılan) ya da USD.
 */

export type SpendScope = 'org' | 'platform';

export type SpendFilters = {
  product?: ProductKey;
  purpose?: string;
  model?: string;
  status?: Exclude<AiCallStatus, 'pending'>;
  /** Firma görünümü: `Membership.id` ya da `AI_SPEND_MEMBER_NONE`. */
  member?: string;
  /** Platform görünümü: firma kimliği. */
  org?: string;
};

/** Gün aralığı ve karşılık gelen anlar: [`start`, `end`). Günler `timeZone`'da. */
export type DayWindow = { from: string; to: string; start: Date; end: Date; days: string[] };

export type SpendContext = {
  scope: SpendScope;
  principal: Principal;
  /** Firma görünümünde etkin firma; platformda `org` süzgeci (yoksa null). */
  orgId: string | null;
  locale: Locale;
  t: Translate;
  /** Firma görünümünde firmanın saat dilimi, platformda UTC. */
  timeZone: string;
  window: DayWindow;
  previous: DayWindow;
  filters: SpendFilters;
  currency: 'TRY' | 'USD';
  /** Ekran kuru (1 USD = ? TL). */
  rate: number;
};

export const ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Aralık en çok bu kadar gün (sözleşme). */
export const AI_SPEND_MAX_RANGE_DAYS = 366;

const FINAL_STATUSES = AI_CALL_STATUSES.filter((s): s is Exclude<AiCallStatus, 'pending'> => s !== 'pending');

// ---------- Takvim günü ve saat dilimi ----------

/** `YYYY-MM-DD` geçerli takvim günü mü. */
function validDay(s: string): boolean {
  if (!DAY_PATTERN.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Saat diliminin o andaki farkı, ms (yerel = UTC + fark). */
function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at / 1000) * 1000;
}

/** Günün ilk anı, verilen saat diliminde (UTC an). */
export function zonedDayStart(day: string, timeZone: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`);
  if (timeZone === 'UTC') return new Date(wall);
  let utc = wall - offsetMs(wall, timeZone);
  const again = wall - offsetMs(utc, timeZone);
  if (again !== utc) utc = again;
  return new Date(utc);
}

/** Anın takvim günü (`YYYY-MM-DD`) verilen saat diliminde. */
export function zonedDay(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const v = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** Anın duvar saati `YYYY-MM-DD HH:mm` verilen saat diliminde (dışa aktarma). */
export function zonedDateTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const v = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}`;
}

export function dayWindow(from: string, to: string, timeZone: string): DayWindow {
  const n = dayDiff(from, to);
  const days = Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
  return { from, to, start: zonedDayStart(from, timeZone), end: zonedDayStart(addDays(to, 1), timeZone), days };
}

// ---------- Sorgu ----------

function text(query: Record<string, unknown>, name: string): string | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw invalidField(name, 'invalid_type');
  const s = v.trim();
  return s === '' ? undefined : s;
}

function oneOf<T extends string>(query: Record<string, unknown>, name: string, values: readonly T[]): T | undefined {
  const v = text(query, name);
  if (v === undefined) return undefined;
  if (!(values as readonly string[]).includes(v)) throw invalidField(name, 'invalid_value');
  return v as T;
}

/** Sayfa numarası gibi pozitif tamsayı; yoksa varsayılan. */
export function positiveInt(query: Record<string, unknown>, name: string, fallback: number, max = 1_000_000): number {
  const v = text(query, name);
  if (v === undefined) return fallback;
  if (!/^\d{1,7}$/.test(v)) throw invalidField(name, 'invalid_value');
  const n = Number(v);
  if (n < 1 || n > max) throw invalidField(name, 'invalid_value');
  return n;
}

export function localeOf(req: FastifyRequest): Locale {
  return requestLocaleOf(req.headers['accept-language'] as string | undefined, req.principal?.locale);
}

/** Ekran kuru. G2'nin satıra yazdığı kurla aynı kaynak (`AI_PRICE_TRY_PER_USD`). */
export function screenRate(): number {
  const r = tryPerUsd();
  return Number.isFinite(r) && r > 0 ? r : AI_TRY_PER_USD_DEFAULT;
}

/** Firma görünümünde erişim: OWNER / ADMIN ve etkin firma. Platform yöneticisi de bu kurala uyar (kendi firması için). */
export function requireOrgAdmin(principal: Principal): string {
  if (!principal.orgId || (principal.orgRole !== 'OWNER' && principal.orgRole !== 'ADMIN')) throw forbidden();
  return principal.orgId;
}

export async function orgTimeZone(prisma: PrismaClient, orgId: string): Promise<string> {
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { timeZone: true } });
  return safeTimeZone(org?.timeZone);
}

/**
 * İstekten görünüm bağlamı. Yetki burada denetlenir (kancalardan sonra: `authenticate` principal'ı yazdı).
 * `now`: testler için.
 */
export async function spendContext(req: FastifyRequest, prisma: PrismaClient, now = new Date()): Promise<SpendContext> {
  const principal = req.principal;
  if (!principal) throw new AppError(401, 'UNAUTHORIZED');
  const query = (req.query ?? {}) as Record<string, unknown>;
  const scope = oneOf(query, 'scope', ['org', 'platform'] as const) ?? 'org';
  let orgId: string | null;
  let timeZone: string;
  if (scope === 'platform') {
    if (!principal.operator) throw forbidden();
    const org = text(query, 'org');
    if (org !== undefined && !ORG_ID_PATTERN.test(org)) throw invalidField('org', 'invalid_value');
    orgId = org ?? null;
    timeZone = 'UTC';
  } else {
    orgId = requireOrgAdmin(principal);
    if (query.org !== undefined) throw invalidField('org', 'not_allowed');
    timeZone = await orgTimeZone(prisma, orgId);
  }

  const locale = localeOf(req);
  const filters: SpendFilters = {};
  const product = text(query, 'product');
  if (product !== undefined) {
    if (!(aiProductKeys() as string[]).includes(product)) throw invalidField('product', 'invalid_value');
    filters.product = product as ProductKey;
  }
  const purpose = text(query, 'purpose');
  if (purpose !== undefined) {
    const known = aiProductKeys().some((p) => isAiPurposeOf(p, purpose));
    if (!known || (filters.product && !isAiPurposeOf(filters.product, purpose))) throw invalidField('purpose', 'invalid_value');
    filters.purpose = purpose;
  }
  const model = text(query, 'model');
  if (model !== undefined) {
    if (!MODEL_PATTERN.test(model)) throw invalidField('model', 'invalid_value');
    filters.model = model;
  }
  const status = oneOf(query, 'status', FINAL_STATUSES);
  if (status) filters.status = status;
  const member = text(query, 'member');
  if (member !== undefined) {
    if (scope === 'platform') throw invalidField('member', 'not_allowed');
    if (member !== AI_SPEND_MEMBER_NONE && !MEMBER_ID_PATTERN.test(member)) throw invalidField('member', 'invalid_value');
    filters.member = member;
  }
  if (scope === 'platform' && orgId) filters.org = orgId;

  const currencyRaw = oneOf(query, 'currency', ['TRY', 'USD'] as const);
  if (scope === 'org' && currencyRaw === 'USD') throw invalidField('currency', 'invalid_value');
  const currency = currencyRaw ?? 'TRY';

  // Dönem: yoksa bu ayın başından bugüne; en çok 12 ay geri (ayın ilk günü), aralık en çok 366 gün.
  const today = zonedDay(now, timeZone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [y, m] = today.split('-').map(Number) as [number, number];
  const back = new Date(Date.UTC(y, m - 1 - AI_SPEND_MAX_MONTHS_BACK, 1)).toISOString().slice(0, 10);
  const from = text(query, 'from') ?? monthStart;
  const to = text(query, 'to') ?? (from <= today ? today : from);
  if (!validDay(from)) throw invalidField('from', 'invalid_value');
  if (!validDay(to)) throw invalidField('to', 'invalid_value');
  if (to < from) throw invalidField('to', 'before_from');
  if (from < back) throw invalidField('from', 'too_old');
  if (dayDiff(from, to) + 1 > AI_SPEND_MAX_RANGE_DAYS) throw invalidField('to', 'range_too_long');
  const window = dayWindow(from, to, timeZone);
  const len = window.days.length;
  const previous = dayWindow(addDays(from, -len), addDays(from, -1), timeZone);

  return { scope, principal, orgId, locale, t: translator(locale), timeZone, window, previous, filters, currency, rate: screenRate() };
}

// ---------- Para ----------

/** Mikro USD → ekrandaki tutar, bağlamın biriminde (2 hane). */
export function amountOf(microUsd: number, currency: 'TRY' | 'USD', rate: number): number {
  return currency === 'USD' ? aiMicrosToAmount(microUsd) : aiMicrosToAmount(aiMicroUsdToMicroTry(microUsd, rate));
}
