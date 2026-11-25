import { useEffect, useRef } from 'react';
import i18next from 'i18next';
import type { Locale } from '@deciship/core';
import { getFormatLocale } from './format';
import { relocalizeMeasureText, relocalizeNumberText } from './weightChoice';

/**
 * Arayüz dili değişince çağrılır (`from` → `to`). Ekranda metin olarak duran ve arayüz diliyle okunan sayılar (`parseTrNumber`)
 * dil değişince anlam değiştirmesin diye formlar bununla metinlerini çevirir (K36 incelemesi: Türkçe "6.000" bölen İngilizcede
 * 6 okunurdu). `format.ts` dili kendi dinleyicisiyle önce günceller; burada `getFormatLocale()` yeni dildir.
 */
export function useLocaleSwitch(onSwitch: (from: Locale, to: Locale) => void): void {
  const cb = useRef(onSwitch);
  useEffect(() => {
    cb.current = onSwitch;
  });
  useEffect(() => {
    let prev = getFormatLocale();
    const on = () => {
      const next = getFormatLocale();
      if (next === prev) return;
      const from = prev;
      prev = next;
      cb.current(from, next);
    };
    i18next.on('languageChanged', on);
    return () => i18next.off('languageChanged', on);
  }, []);
}

/**
 * Nesnenin sayı metni alanlarını çevirir: `numbers` arayüz diliyle okunanlar (tutar, yüzde, bölen), `measures` binliksiz
 * okunanlar (ölçü toleransları, `parseMeasure`). Öbür alanlara dokunmaz.
 */
export function relocalizeFields<T extends object>(
  o: T,
  numbers: readonly (keyof T)[],
  measures: readonly (keyof T)[],
  from: Locale,
  to: Locale,
): T {
  if (from === to) return o;
  const out = { ...o } as Record<keyof T, unknown>;
  for (const k of numbers) if (typeof out[k] === 'string') out[k] = relocalizeNumberText(out[k] as string, from, to);
  for (const k of measures) if (typeof out[k] === 'string') out[k] = relocalizeMeasureText(out[k] as string, from, to);
  return out as T;
}
