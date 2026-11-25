import { APP_ENV, BUILD_API_URL } from '../version/client';

/** Tek taban: gateway. `/api/account` ve `/api/deciship` kökleri buna eklenir. */
export const GATEWAY_PORT = 8088;
/** Geliştirme: USB (adb reverse) ile hem emülatörde hem gerçek telefonda çalışır. */
const DEV_SERVER_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

/** Derleme ortamından gelen adres. Metro yalnız bu noktalı yazımı derleme anında yerleştirir. */
const ENV_SERVER_URL = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '') || null;

/**
 * Derleme anındaki adres: `EXPO_PUBLIC_API_URL`, yoksa `app.config.js` `extra.sod.apiUrl`, yoksa geliştirme adresi.
 * Üretim ve önizleme derlemesinde `app.config.js` https adresi olmadan derlemeyi durdurur (Mesaj 13 §3.1).
 */
export const DEFAULT_SERVER_URL = ENV_SERVER_URL ?? BUILD_API_URL ?? DEV_SERVER_URL;

/**
 * Sunucu adresi alanı yalnız geliştirme derlemesinde (`APP_ENV=development`) görünür ve değiştirilebilir.
 * Üretim ve önizlemede adres derleme anında sabittir: kayıtlı ya da yazılan adres yok sayılır (09-B2).
 */
export const SERVER_EDITABLE = APP_ENV === 'development';
/** Yerel geliştirme adresleri: biri ulaşılamazsa giriş sırasında diğerleri sırayla denenir. */
export const LOCAL_SERVER_URLS = [`http://127.0.0.1:${GATEWAY_PORT}`, `http://10.0.2.2:${GATEWAY_PORT}`, `http://localhost:${GATEWAY_PORT}`];

/**
 * Yazılanı tabana indirger: boşluk, sondaki `/`, alışkanlıkla eklenen `/api` veya `/api/deciship` atılır,
 * şema yoksa `http://` eklenir. Boşsa varsayılan adres. Geliştirme dışında her zaman derleme adresi.
 */
export function normalizeServerUrl(input: string): string {
  if (!SERVER_EDITABLE) return DEFAULT_SERVER_URL;
  let url = input.trim().replace(/\/+$/, '');
  if (!url) return DEFAULT_SERVER_URL;
  url = url.replace(/\/api(\/[a-z]+)?$/i, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

export function serverCandidates(input: string): string[] {
  const clean = normalizeServerUrl(input);
  return LOCAL_SERVER_URLS.includes(clean) ? [clean, ...LOCAL_SERVER_URLS.filter((u) => u !== clean)] : [clean];
}
