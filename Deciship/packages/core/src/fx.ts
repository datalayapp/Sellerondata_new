import { round2 } from './calc';
import { fmtDate, fmtNumber } from './format';
import { DEFAULT_LOCALE, t, type Locale } from './i18n/index';

/** Fatura karşılaştırmasında kur desteği (SPEC §FX). */

/** Varsayılan kur toleransı (%): çevrilmiş beklenen tutarın bu yüzdesi kadar fark "kur farkı" sayılır. */
export const DEFAULT_FX_TOLERANCE_PCT = 1.5;

/** Kur kaynağının kullanıcıya gösterilen adı. */
export const FX_SOURCE_LABEL = t('tr', 'fx.sourceLabel');

/** `FX_SOURCE_LABEL` istenen dilde. */
export function fxSourceLabel(locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, 'fx.sourceLabel');
}

/**
 * 1 `base` = `rate` `quote` (ör. 1 USD = 41,2345 TRY). `date`: kurun ait olduğu (yayın) günü, ISO.
 * `stale` (Y18): istenen günün kuru alınamadı (TCMB yanıt vermedi), saklı en yakın önceki günün kuru verildi (en çok 7 gün
 * geriye). Satır bununla hesaplanır, notunda "Kur gg.aa.yyyy tarihli" yazar ve sonuç `fxStale` işaretini taşır.
 */
export type FxRate = { base: string; quote: string; rate: number; date: string; source: string; stale?: true };

/** Bir satır için istenen kur: `date` istenen gün (sevk ya da fatura tarihi); `rate` bulunamadıysa null. */
export type FxInput = { date: string; rate: FxRate | null };

/**
 * Tutar toleransının (firma para biriminde) satır para birimine çevrildiği kur (Y18). Çevrim API'de yapılır
 * (`amountTolIn`); çekirdek yalnız kurun yokluğunu ve bayatlığını bilir: `rate` null ise satır fiyat karşılaştırmasına
 * girmez (NO_TARIFF + "Kur bulunamadı/alınamadı", kesin fazla ödemeye girmez). Sabit yedek oran yoktur.
 */
export type TolFxInput = { base: string; quote: string; date: string; rate: FxRate | null };

/** Satıra uygulanan çevrim: beklenen tutar tarife para biriminde `expected`, satır para biriminde `converted`. */
export type FxApplied = FxRate & { requestedDate: string; expected: number; converted: number };

/**
 * `unchecked`: faturadaki, tarifede tanımlı olmayan ek ücret (satır para biriminde). Tarifeyle kontrol edilemez;
 * Beklenen'e faturadaki tutarıyla eklenir, böylece farka etkisi olmaz.
 */
export type BreakdownLine = {
  label: string;
  amount: number;
  currency?: string;
  fx?: FxApplied;
  unchecked?: boolean;
  /** Yalnız bilgi (ör. faturadaki fiyatla hesaplanan satırda "Tarifeye göre olurdu"); Beklenen'e girmez. */
  info?: boolean;
};

/** Döküm içindeki "tarifede tanımlı olmayan" (kontrol edilmeyen) ek ücretlerin toplamı. */
export function uncheckedSurchargeTotal(breakdown: unknown): number {
  if (!Array.isArray(breakdown)) return 0;
  let cents = 0;
  for (const b of breakdown) {
    if (b && typeof b === 'object' && (b as BreakdownLine).unchecked && typeof (b as BreakdownLine).amount === 'number') {
      cents += Math.round((b as BreakdownLine).amount * 100);
    }
  }
  return cents / 100;
}

export function convertMoney(amount: number, rate: number): number {
  return round2(amount * rate);
}

/** "41,2345" */
export function fmtFxRate(rate: number, locale: Locale = DEFAULT_LOCALE): string {
  return fmtNumber(rate, 4, locale);
}

/** "TCMB 03.06.2025" ya da tatil/hafta sonu düşüşünde "TCMB 06.06.2025, 07.06.2025 için". */
export function fxSourceText(fx: Pick<FxApplied, 'source' | 'date' | 'requestedDate'>, locale: Locale = DEFAULT_LOCALE): string {
  const base = `${fx.source} ${fmtDate(fx.date, locale)}`;
  return fx.requestedDate && fx.requestedDate !== fx.date ? t(locale, 'fx.sourceFor', { source: base, date: fmtDate(fx.requestedDate, locale) }) : base;
}

/** Döküm satırlarında saklanan kur bilgisini bulur (DB'de ayrı kolon yok; breakdown JSON'unda durur). */
export function fxFromBreakdown(breakdown: unknown): FxApplied | null {
  if (!Array.isArray(breakdown)) return null;
  for (const b of breakdown) {
    const fx = b && typeof b === 'object' ? (b as { fx?: unknown }).fx : undefined;
    if (fx && typeof fx === 'object' && typeof (fx as FxApplied).rate === 'number') return fx as FxApplied;
  }
  return null;
}
