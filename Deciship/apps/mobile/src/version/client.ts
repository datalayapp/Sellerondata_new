import Constants from 'expo-constants';
import { formatClientHeader } from '@sellerondata/contracts';

/**
 * Uygulamanın kendi sürümü ve derleme profili (Mesaj 13 §3.3).
 * Kaynak `app.config.js` çıktısı: `version`, `android.versionCode`, `extra.sod = { appEnv, apiUrl, versionCode }`.
 * Release APK'da yapılandırma APK'ya gömülüdür; dev client'ta Metro'dan gelir. Yeni yerel modül yok (`expo-application` yok):
 * mevcut dev APK yeni JS ile çalışmaya devam eder.
 */

export type AppEnv = 'development' | 'preview' | 'production';

type SodExtra = { appEnv?: unknown; apiUrl?: unknown; versionCode?: unknown };

const config = Constants.expoConfig ?? null;
const sod: SodExtra = (config?.extra as { sod?: SodExtra } | undefined)?.sod ?? {};

const VERSION_RE = /^\d+(\.\d+){0,2}$/;
const rawVersion = typeof config?.version === 'string' ? config.version.trim() : '';

/** Sürüm okunabildi mi. Okunamayan sürümle başlık gönderilmez, politika denetimi kilitlemez. */
export const VERSION_KNOWN = VERSION_RE.test(rawVersion);

export const APP_VERSION: string = VERSION_KNOWN ? rawVersion : '0.0.0';

function asBuild(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export const BUILD: number | null = asBuild(config?.android?.versionCode) ?? asBuild(sod.versionCode);

/**
 * Derleme profili. Yapılandırmada hiç yoksa geliştirme (plan §3.3). Tanınmayan bir değer üretim sayılır:
 * şüphede sunucu adresi alanı açılmaz, şifresiz adres kabul edilmez.
 */
export const APP_ENV: AppEnv =
  sod.appEnv === undefined || sod.appEnv === null
    ? 'development'
    : sod.appEnv === 'development' || sod.appEnv === 'preview' || sod.appEnv === 'production'
      ? sod.appEnv
      : 'production';

/** Derleme anındaki API adresi (`extra.sod.apiUrl`). */
export const BUILD_API_URL: string | null = typeof sod.apiUrl === 'string' && sod.apiUrl.trim() ? sod.apiUrl.trim().replace(/\/+$/, '') : null;

function platformName(): string | null {
  // Metro `process.env.EXPO_OS` değerini derleme anında yerleştirir; yoksa expo-constants'ın platform alanı.
  const os = process.env.EXPO_OS;
  if (os) return os;
  const p = Constants.platform as Record<string, unknown> | undefined;
  if (p?.android) return 'android';
  if (p?.ios) return 'ios';
  return null;
}

const HEADER = VERSION_KNOWN ? formatClientHeader({ kind: 'mobile', version: APP_VERSION, build: BUILD, platform: platformName() }) : null;

/** `X-SOD-Client` değeri, ör. "mobile/1.1.0+2 (android)". Sürüm okunamadıysa null (başlık gönderilmez). */
export function clientHeader(): string | null {
  return HEADER;
}
