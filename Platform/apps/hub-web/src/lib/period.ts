import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { addDays, zonedDay } from '@sellerondata/format/zoned';
// Kabuğun ana girişi değil (`.tsx`, React): birim testi bu dosyayı düz Node ile yükler.
import { shellTimeZone } from '@sellerondata/shell/time-zone';

export type RangeKey = '7d' | '30d' | 'mtd' | '90d' | 'custom';
export const RANGE_PRESETS: Exclude<RangeKey, 'custom'>[] = ['7d', '30d', 'mtd', '90d'];

/**
 * Anın firma saat dilimindeki takvim günü, "YYYY-AA-GG" (rapor Y132). Sunucu dönemleri firma saatiyle sayar; ekrandaki
 * "bugün" de öyle olmalı. Saat dilimi bilinmiyorsa (`/me` gelmedi, firma yok) tarayıcının saati: bugünkü davranış.
 */
export const isoDay = (d: Date, timeZone: string | undefined = shellTimeZone()): string => zonedDay(d, timeZone);

/** Hazır aralık, firma saat diliminde: bitiş bugün, başlangıç takvim günü olarak geri sayılır (yaz saati etkilemez). */
export function rangeDates(key: RangeKey, now = new Date(), timeZone: string | undefined = shellTimeZone()): { from: string; to: string } {
  const to = zonedDay(now, timeZone);
  const from = key === 'mtd' ? `${to.slice(0, 8)}01` : addDays(to, -((key === '7d' ? 7 : key === '90d' ? 90 : 30) - 1));
  return { from, to };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Tarih aralığı adreste durur: sayfa paylaşılabilir, geri düğmesi çalışır. */
export function usePeriod() {
  const [params, setParams] = useSearchParams();
  const rawRange = params.get('range') as RangeKey | null;
  const from = params.get('from');
  const to = params.get('to');
  // `/me` gelince saat dilimi değişebilir; sayfa `useMe` ile yeniden çizilir, aralık da yeniden hesaplanır.
  const timeZone = shellTimeZone();
  const period = useMemo(() => {
    if (rawRange === 'custom' && from && to && DAY.test(from) && DAY.test(to) && from <= to) {
      return { range: 'custom' as RangeKey, from, to };
    }
    const range: RangeKey = rawRange && RANGE_PRESETS.includes(rawRange as never) ? rawRange : '30d';
    return { range, ...rangeDates(range, new Date(), timeZone) };
  }, [rawRange, from, to, timeZone]);

  const setRange = useCallback(
    (range: RangeKey, custom?: { from: string; to: string }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('range', range);
          if (range === 'custom' && custom) {
            next.set('from', custom.from);
            next.set('to', custom.to);
          } else {
            next.delete('from');
            next.delete('to');
          }
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { ...period, setRange };
}

/**
 * İtiraz son gününün saat dilimi: firma saati değil, bilerek sabit Türkiye. Sunucu itiraz sürelerini Türkiye günüyle
 * hesaplıyor (`Deciship/apps/api` `disputes.ts`, `invoiceHints`; para etkili, rapor Y132); rozet aynı günü saymalı.
 */
export const DUE_DATE_TIME_ZONE = 'Europe/Istanbul';

/**
 * Son güne kaç takvim günü var: milisaniye farkı değil. Akşam 23:00'te "yarın" 1 gündür, 2 değil.
 * `dueAt` gün (`2026-11-07`) ya da an olabilir; an ise `DUE_DATE_TIME_ZONE`'da güne çevrilir.
 */
export function daysUntil(dueAt: string, now: Date = new Date(), timeZone: string = DUE_DATE_TIME_ZONE): number {
  const target = /^\d{4}-\d{2}-\d{2}$/.test(dueAt) ? dueAt : zonedDay(new Date(dueAt), timeZone);
  const asUtc = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((asUtc(target) - asUtc(zonedDay(now, timeZone))) / 86_400_000);
}
