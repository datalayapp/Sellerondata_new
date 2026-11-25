import * as F from '@sellerondata/format';
import { addDays, zonedDay } from '@sellerondata/format/zoned';
import type { HubKpi, HubValue, HubValueFormat } from './contracts';

/**
 * Para, sayı, tarih: etkin dil (ARCHITECTURE §9). İnce sarmalayıcı: yazımı `@sellerondata/format` yapar
 * (Hermes uyumlu: sayıda Intl yok, tarihte yalnız temel Intl.DateTimeFormat). Saf işlevler, RN bağımlılığı yok.
 * Ekran metni: eksi Unicode `−`, geçersiz değer ya da tarih uzun çizgi.
 */
export type FormatCtx = {
  lng: string;
  /** Çeviriden gelen birimler (i18n: hub:unit.*). */
  units: { days: string; points: string; thousand: string; million: string };
  /** Firma saat dilimi (IANA); yoksa telefonun saati. Tarih-saat değerleri bu dilimde yazılır (Y132). */
  timeZone?: string;
};

export const EMPTY_VALUE = F.EMPTY;
/** Birim ayırıcı: düz boşluk (bugünkü yazım). */
const SP = ' ';
const loc = (lng: string) => F.fmtLocale(lng);

export const number = (value: number, lng: string, maximumFractionDigits = 2, minimumFractionDigits = 0) =>
  F.num(value, loc(lng), { max: maximumFractionDigits, min: minimumFractionDigits });

/** Türkçede "2.143,20 ₺" (DESIGN.md), İngilizcede "₺2,143.20"; bilinmeyen kod "CHF 2.50". */
export function money(value: number, currency: string | undefined, lng: string): string {
  return F.money(value, currency, loc(lng));
}

/** `value` 0-100 arasıdır: 86.4 = %86,4. */
export const percent = (value: number, lng: string, maxFraction = 1) => F.percent(value, loc(lng), { max: maxFraction });

// Saat dilimi (Y132): an olan değer firmanın saat diliminde yazılır (`timeZone`; `lib/format` `getFormatTimeZone`), yoksa
// telefonun saatinde. Yalnız gün olan değer ("2026-10-27") takvim günüdür, saat dilimi onu kaydırmaz.
export const date = (iso: string, lng: string, timeZone?: string) => F.dateShort(iso, loc(lng), { timeZone });
export const dateTime = (iso: string, lng: string, timeZone?: string) => F.dateTime(iso, loc(lng), { timeZone });
export const dayMonth = (iso: string, lng: string) => F.dayMonth(iso, loc(lng));

/** "7 Eki – 6 Kas 2026". */
export function dateRange(from: string, to: string, lng: string): string {
  return `${dayMonth(from, lng)} – ${date(to, lng)}`;
}

/** Son güncelleme: bugünse saat, değilse gün + saat (firmanın saat diliminde). */
export function updatedAt(at: number, lng: string, now = Date.now(), timeZone?: string): string {
  const sameDay = zonedDay(at, timeZone) === zonedDay(now, timeZone);
  return sameDay ? F.time(at, loc(lng), { timeZone }) : F.dateTime(at, loc(lng), { year: false, timeZone });
}

export type Ago = { unit: 'now' | 'minutes' | 'hours' | 'days'; n: number } | { unit: 'date'; text: string };

/** Göreli zaman parçaları. Metni çeviri kurar: hub:ago.* */
export function ago(iso: string, lng: string, now = Date.now(), timeZone?: string): Ago {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { unit: 'date', text: EMPTY_VALUE };
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return { unit: 'now', n: 0 };
  if (min < 60) return { unit: 'minutes', n: min };
  if (min < 60 * 24) return { unit: 'hours', n: Math.floor(min / 60) };
  if (min < 60 * 24 * 30) return { unit: 'days', n: Math.floor(min / (60 * 24)) };
  return { unit: 'date', text: date(iso, lng, timeZone) };
}

/** Sözleşmedeki ham değer + `format` → metin. Değer yoksa uzun çizgi. */
export function hubValue(v: HubValue, ctx: FormatCtx): string {
  const { value, format, currency } = v;
  if (value === null || value === undefined || value === '') return EMPTY_VALUE;
  if (typeof value === 'number' && !Number.isFinite(value)) return EMPTY_VALUE;
  switch (format) {
    case 'money':
      return typeof value === 'number' ? money(value, currency, ctx.lng) : String(value);
    case 'number':
      return typeof value === 'number' ? number(value, ctx.lng) : String(value);
    case 'percent':
      return typeof value === 'number' ? percent(value, ctx.lng) : String(value);
    case 'duration_days':
      return typeof value === 'number' ? `${number(value, ctx.lng, 1)}${SP}${ctx.units.days}` : String(value);
    case 'date':
      return date(String(value), ctx.lng);
    case 'datetime':
      return dateTime(String(value), ctx.lng, ctx.timeZone);
    default:
      return String(value);
  }
}

/** Eksen için kısa sayı: 10.000 altı tam, üstü "18,5 B". Para birimi eksende yazmaz, başlık ve okuma satırı söyler. */
export function axisValue(v: number, format: HubValueFormat, ctx: FormatCtx): string {
  if (format === 'percent') return percent(v, ctx.lng, 0);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${number(v / 1_000_000, ctx.lng, 1)}${SP}${ctx.units.million}`;
  if (abs >= 10_000) return `${number(v / 1_000, ctx.lng, 1)}${SP}${ctx.units.thousand}`;
  return number(v, ctx.lng, abs < 10 ? 1 : 0);
}

export type Delta = { dir: 'up' | 'down' | 'flat'; tone: 'good' | 'bad' | 'neutral'; amount: string; previous: string };

/** Önceki döneme göre fark. Yüzde KPI'larda fark puan olarak okunur; önceki 0 ise tutar. Web ile aynı kural. */
export function kpiDelta(kpi: Pick<HubKpi, 'value' | 'previous' | 'goodDirection' | 'format' | 'currency'>, ctx: FormatCtx): Delta | null {
  const { value, previous } = kpi;
  if (typeof value !== 'number' || typeof previous !== 'number') return null;
  const diff = value - previous;
  const dir = Math.abs(diff) < 1e-9 ? 'flat' : diff > 0 ? 'up' : 'down';
  const good = kpi.goodDirection ?? 'none';
  const tone = dir === 'flat' || good === 'none' ? 'neutral' : (dir === 'up') === (good === 'up') ? 'good' : 'bad';
  let amount: string;
  if (kpi.format === 'percent') amount = `${number(Math.abs(diff), ctx.lng, 1)}${SP}${ctx.units.points}`;
  else if (previous === 0) amount = hubValue({ value: Math.abs(diff), format: kpi.format, currency: kpi.currency }, ctx);
  else amount = percent((Math.abs(diff) / Math.abs(previous)) * 100, ctx.lng, Math.abs(diff / previous) < 0.1 ? 1 : 0);
  return { dir, tone, amount, previous: hubValue({ value: previous, format: kpi.format, currency: kpi.currency }, ctx) };
}

export type RangeKey = '7d' | '30d' | 'mtd' | '90d';
export const RANGE_KEYS: readonly RangeKey[] = ['7d', '30d', 'mtd', '90d'];

/** Anın takvim günü, firmanın saat diliminde (yoksa telefonun): "2026-11-07". */
export const isoDay = (d: Date, timeZone?: string) => zonedDay(d, timeZone);

/** Web `rangeDates` ile aynı: firmanın saat diliminde, bitiş bugün, başlangıç takvim günü olarak geri sayılır. */
export function rangeDates(key: RangeKey, now = new Date(), timeZone?: string): { from: string; to: string } {
  const to = zonedDay(now, timeZone);
  const from = key === 'mtd' ? `${to.slice(0, 8)}01` : addDays(to, -((key === '7d' ? 7 : key === '90d' ? 90 : 30) - 1));
  return { from, to };
}
