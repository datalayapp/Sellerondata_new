import { fmtDate, fmtMoney } from './format';
import { DEFAULT_LOCALE, t, type Locale } from './i18n/index';

/**
 * Fatura ayrıntısındaki küçük ipuçları (SPEC "Wiki'den eklenenler"): itiraz süresi, WhatsApp mesajı, tarife şüphesi.
 * Hepsi saf fonksiyon; arayüz ve API yalnızca sonucu gösterir.
 */

/** TTK m.21/2: faturayı alan tacir 8 gün içinde itiraz etmezse içeriği kabul etmiş sayılabilir. */
export const TTK_DISPUTE_DAYS = 8;
/** FedEx fatura düzeltme talebi penceresi (fatura tarihinden itibaren). */
export const FEDEX_CORRECTION_DAYS = 30;
/** Türkiye 2016'dan beri yıl boyu UTC+3 (yaz saati yok). */
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DeadlineInfo = {
  /** Kanun/taşıyıcı süresi (gün). */
  days: number;
  /** Son gün, YYYY-MM-DD (fatura tarihi + days). */
  lastDay: string;
  /** Bugünden son güne kalan gün (0 = bugün son gün, negatif = geçti). */
  daysLeft: number;
  expired: boolean;
};

/** `ttk` yalnız ülkesi Türkiye olan firmada, `carrier` yalnız FedEx'te. İkisi de yoksa bilinen bir süre yoktur. */
export type DisputeDeadlines = { ttk?: DeadlineInfo; carrier?: DeadlineInfo };

/** Türk Ticaret Kanunu süresi yalnız ülkesi Türkiye olan firmaya söylenir: ülke bilinmiyorsa da söylenmez. */
export function ttkApplies(country: string | null | undefined): boolean {
  return country === 'TR';
}

/** "YYYY-MM-DD" → UTC gece yarısı ms; geçersizse null. */
function dayMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Verilen anın Türkiye (UTC+3) yerel tarihi, YYYY-MM-DD. */
export function turkeyDate(now: Date): string {
  return isoOf(now.getTime() + TR_OFFSET_MS);
}

function deadline(invoiceMs: number, todayMs: number, days: number): DeadlineInfo {
  const last = invoiceMs + days * DAY_MS;
  const daysLeft = Math.round((last - todayMs) / DAY_MS);
  return { days, lastDay: isoOf(last), daysLeft, expired: daysLeft < 0 };
}

/**
 * İtiraz süreleri. `invoiceDate` YYYY-MM-DD (fatura tarihi); `today` bir an (Date, Türkiye yerel gününe çevrilir)
 * ya da doğrudan YYYY-MM-DD. TTK 8 gün yalnız Türkiye firmasında ve her taşıyıcı için; 30 günlük düzeltme süresi
 * taşıyıcının kendi kuralıdır, ülkeden bağımsız, yalnızca FedEx için. `country` firmanın ülkesi (ISO-2): zorunlu, çağıran unutmasın.
 * Fatura tarihi yoksa/geçersizse null.
 */
export function disputeDeadlines(
  invoiceDate: string | null | undefined,
  carrierCode: string | null | undefined,
  today: Date | string,
  country: string | null | undefined,
): DisputeDeadlines | null {
  const inv = invoiceDate ? dayMs(invoiceDate) : null;
  const now = dayMs(typeof today === 'string' ? today : turkeyDate(today));
  if (inv == null || now == null) return null;
  const out: DisputeDeadlines = ttkApplies(country) ? { ttk: deadline(inv, now, TTK_DISPUTE_DAYS) } : {};
  if ((carrierCode ?? '').trim().toLowerCase().startsWith('fedex')) out.carrier = deadline(inv, now, FEDEX_CORRECTION_DAYS);
  return out;
}

/** Tarife şüphesi eşiği: en az bu kadar karşılaştırılan satır ve bunların bu oranından fazlasında fiyat farkı. */
export const TARIFF_SUSPECT_MIN_LINES = 5;
export const TARIFF_SUSPECT_PRICE_SHARE = 0.3;

/**
 * Tarife yanlış ya da eskiyse neredeyse her satır "Fiyat farkı" üretir. `compared` = karşılaştırılan (eşleşmiş,
 * tarifesi bulunan: Uyumlu + Fark var) satırlar; `priceDiff` = bunlardan fark türü PRICE olanlar.
 */
export function isTariffSuspect(compared: number, priceDiff: number): boolean {
  if (compared < TARIFF_SUSPECT_MIN_LINES) return false;
  return priceDiff / compared > TARIFF_SUSPECT_PRICE_SHARE;
}

export type WhatsAppSummaryInput = {
  carrierName: string;
  invoiceNo: string;
  invoiceDate?: string | null;
  currency: string;
  lines: number;
  diff: number;
  unmatched: number;
  overchargeTotal: number;
  /** TTK son günü (YYYY-MM-DD); süre geçtiyse ya da firma Türkiye'de değilse verilmez. */
  disputeLastDay?: string | null;
};

/**
 * WhatsApp'ta paylaşılacak kısa özet. Yalnızca sayılar: müşteri adı, adres, takip no yok.
 * Örn. "DeciShip · FedEx fatura 9-482-11735 (27.10.2026): 18 gönderi, 4 fark, 1 eşleşmedi. Fazla ödeme 1.731,20 ₺. İtiraz için son gün 04.11.2026."
 */
export function buildWhatsAppText(s: WhatsAppSummaryInput, locale: Locale = DEFAULT_LOCALE): string {
  const head = t(locale, 'hints.whatsapp.head', { carrier: s.carrierName, invoiceNo: s.invoiceNo, date: s.invoiceDate ? ` (${fmtDate(s.invoiceDate, locale)})` : '' });
  const counts = [t(locale, 'hints.whatsapp.lines', { count: s.lines }), t(locale, 'hints.whatsapp.diff', { count: s.diff })];
  if (s.unmatched > 0) counts.push(t(locale, 'hints.whatsapp.unmatched', { count: s.unmatched }));
  const parts = [t(locale, 'hints.whatsapp.counts', { head, counts: counts.join(', ') })];
  if (s.overchargeTotal > 0) {
    parts.push(t(locale, 'hints.whatsapp.overcharge', { amount: fmtMoney(s.overchargeTotal, s.currency, locale) }));
    if (s.disputeLastDay) parts.push(t(locale, 'hints.whatsapp.lastDay', { date: fmtDate(s.disputeLastDay, locale) }));
  } else {
    parts.push(t(locale, 'hints.whatsapp.noOvercharge'));
  }
  return parts.join(' ');
}

/** wa.me bağlantısı (alıcı seçilmeden): WhatsApp hazır mesajla açılır, "Gönder"e insan basar. */
export function whatsAppUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
