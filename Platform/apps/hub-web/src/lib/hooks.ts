import { useQuery } from '@tanstack/react-query';
import i18next from 'i18next';
import { useEffect, useRef, useState , useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, currentLocale, useMe } from '@sellerondata/shell';
import { ERROR_MESSAGES, type ApiErrorCode, type SignupMode } from '@sellerondata/contracts';
import { client } from './session.ts';

/** Sorgu anahtarının ortak öneki: firma ve dil değişince her şey yeniden gelir (etiketler sunucuda yerelleşir). */
export function useScope() {
  const { me } = useMe();
  const { i18n } = useTranslation();
  return [me?.activeOrg?.id ?? 'none', i18n.language] as const;
}

/** Sunucunun yerelleşmiş metni; yoksa ortak hata metni; o da yoksa verilen yedek. */
export function apiMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION' && Array.isArray(e.details)) {
      const issues = e.details as { code?: string; message?: string }[];
      if (issues.some((i) => i.code === 'weak_password')) return i18next.t('auth.weakPassword');
      // Hangi alanın neden reddedildiği genel "alanları kontrol edin"den iyidir.
      if (issues[0]?.message) return issues[0].message;
    }
    // Sınıra takılınca bekleme süresi söylenir (Retry-After; en az 1 dakika).
    if (e.code === 'TOO_MANY_ATTEMPTS' && e.retryAfterSeconds) return i18next.t('auth.login.tooManyIn', { minutes: Math.max(1, Math.ceil(e.retryAfterSeconds / 60)) });
    if (e.message && e.code !== 'UNKNOWN') return e.message;
    const m = ERROR_MESSAGES[e.code as ApiErrorCode];
    if (m) return m[currentLocale()];
  }
  return fallback;
}

/** Kapsayıcının genişliği. Grafikler bununla çizilir. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const PHONE_QUERY = '(max-width: 767px)';
/** Telefon genişliği mi? Düzen değil içerik değiştiğinde (kart / tablo, alt sayfa) kullanılır. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (on) => {
      const mq = window.matchMedia(PHONE_QUERY);
      mq.addEventListener('change', on);
      return () => mq.removeEventListener('change', on);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
  );
}

/** Kurulumun açık bilgileri (`GET /catalog`). Alan gelmezse açık sayılır: eski sürümle uyumlu. */
export function useCatalog() {
  const q = useQuery({
    queryKey: ['catalog'],
    queryFn: () => client.get<{ registrationEnabled?: boolean; mailEnabled?: boolean; signupMode?: SignupMode }>('/api/account/catalog', { noRefresh: true }),
    retry: false,
    staleTime: 60_000,
  });
  // `inviteOnly`: kapalı deneme (SIGNUP_MODE=invite); kayıt yalnız `/register?invite=` bağlantısıyla.
  return { registrationClosed: q.data?.registrationEnabled === false, mailOff: q.data?.mailEnabled === false, inviteOnly: q.data?.signupMode === 'invite' };
}
