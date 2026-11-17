import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PRODUCTS, type AuthResponse, type CreateOrgBody, type LeaveOrgBody, type Locale, type MeResponse, type ProductKey } from '@sellerondata/contracts';
import { ApiError, ME_CACHE_KEY, type SessionClient } from './client.ts';
import { endSessionEpoch, loggedOutSince, sessionEpoch } from './epoch.ts';
import { setShellLocale } from '../i18n/setup.ts';
import { setShellTimeZone } from '../timeZone.ts';

export type LogoutResult = { serverEnded: boolean };

const Ctx = createContext<SessionClient | null>(null);

export function SessionProvider({ client, children }: { client: SessionClient; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useSessionClient(): SessionClient {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider eksik');
  return c;
}

export const ME_QUERY_KEY = ['sod', 'me'] as const;
const ME_CACHE = ME_CACHE_KEY;

/**
 * Yalnız kabuğun ilk karesi için: ad, firma ve izinler. Jeton içermez (§5). Oturum kapanınca silinir.
 * Firma saat dilimi de buradan atanır: ilk karedeki tarihler ve "bugün" `/me` beklenmeden firma saatinde yazılır.
 */
function readCachedMe(): MeResponse | undefined {
  try {
    const raw = sessionStorage.getItem(ME_CACHE);
    const me = raw ? (JSON.parse(raw) as MeResponse) : undefined;
    if (me) setShellTimeZone(me.activeOrg?.timeZone);
    return me;
  } catch {
    return undefined;
  }
}

const PENDING_LOCALE = 'sod_locale_pending';
/** Kaydı beklenen dil bu süreden sonra unutulur: hesaptaki dil yine geçerli olur. */
const PENDING_LOCALE_MS = 30_000;

/** Kişinin az önce seçtiği, hesaba henüz yazılmamış dil. Sayfa geçişinde de yaşar (aynı köken, iki uygulama). */
function readPendingLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(PENDING_LOCALE);
    if (!raw) return null;
    const { locale, at } = JSON.parse(raw) as { locale: Locale; at: number };
    if (Date.now() - at < PENDING_LOCALE_MS) return locale;
    localStorage.removeItem(PENDING_LOCALE);
    return null;
  } catch {
    return null;
  }
}

function writePendingLocale(locale: Locale) {
  try {
    localStorage.setItem(PENDING_LOCALE, JSON.stringify({ locale, at: Date.now() }));
  } catch {
    /* depo kapalı olabilir */
  }
}

/** Yalnız yazılan dil hâlâ bekleyen dilse siler: üst üste iki seçimde eski yanıt yenisini silmesin. */
function clearPendingLocale(locale?: Locale) {
  try {
    if (!locale || readPendingLocale() === locale) localStorage.removeItem(PENDING_LOCALE);
  } catch {
    /* depo kapalı olabilir */
  }
}

export function clearMeCache() {
  try {
    sessionStorage.removeItem(ME_CACHE);
  } catch {
    /* depo kapalı olabilir */
  }
}

/**
 * Giriş, kayıt ya da davetle katılma oturumu açtı: önceki oturumun izleri silinir, sonraki `/me` firmayı yeniden belirler.
 * Çıkış yapılmış sekmede süren eski `/me`nin geç 401'i yeni kişinin belleğini ve firmasını silmez (6.19).
 */
export function beginSession(client: SessionClient) {
  endSessionEpoch('login');
  clearMeCache();
  client.resetLost();
  client.forgetOrg();
}

/**
 * Etkin firma değişti, sayfa baştan yüklenecek (firma kapatma, uyarıdaki "yenile" ve "şuna geç"): kişi önbelleği silinir.
 * Süren eski `/me` yanıtı eski firmayı belleğe geri yazmaz (6.19).
 */
export function beginOrgChange() {
  endSessionEpoch('org');
  clearMeCache();
}

export function useMe() {
  const client = useSessionClient();
  const qc = useQueryClient();
  // Birden çok bileşen dinler: süren sorgu kesilmez, tek istek gider.
  useEffect(() => client.onOrgAdopted(() => void qc.invalidateQueries({ queryKey: ME_QUERY_KEY }, { cancelRefetch: false })), [client, qc]);
  const query = useQuery<MeResponse | null>({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const epoch = sessionEpoch();
      // Önbellekle çizilen ekranda ilk yazma da başlık taşısın. /me farklı dönerse düzeltilir, sunucu yine denetler.
      const cached = readCachedMe();
      if (cached) client.adoptCachedOrg(cached.activeOrg?.id ?? null);
      try {
        const fetched = await client.get<MeResponse>('/api/account/me');
        // İstek sürerken çıkış ya da firma değişimi oldu: yanıt eski kişinin/firmanın, hiçbir yere yazılmaz (6.19).
        if (sessionEpoch() !== epoch) return loggedOutSince(epoch) ? null : fetched;
        // Dil az önce değişti, PATCH bitmeden sayfa değiştiyse /me eski dili getirir: kişinin seçimi ezilmez, kayıt yeniden gönderilir.
        const pending = readPendingLocale();
        if (pending === fetched.person.locale) clearPendingLocale();
        else if (pending) {
          void client
            .patch('/api/account/me', { locale: pending }, { keepalive: true })
            .then(() => clearPendingLocale(pending))
            .catch(() => undefined);
        }
        const me: MeResponse = pending ? { ...fetched, person: { ...fetched.person, locale: pending } } : fetched;
        // Eski sekme: oturum başka firmaya geçmiş. Ekrandaki veri eski firmanın, kişi eski firmayı görmeye devam eder; kabuk uyarır.
        if (!client.noteActiveOrg(me.activeOrg?.id ?? null)) return qc.getQueryData<MeResponse | null>(ME_QUERY_KEY) ?? me;
        try {
          sessionStorage.setItem(ME_CACHE, JSON.stringify(me));
        } catch {
          /* depo kapalı olabilir */
        }
        setShellLocale(me.person.locale);
        // Firma saat dilimi (Y132): yoksa (firmasız kişi, alanı göndermeyen sunucu) tarayıcı saatine dönülür.
        setShellTimeZone(me.activeOrg?.timeZone);
        return me;
      } catch (e) {
        // Eski isteğin 401'i yeni oturumun belleğini ve firmasını silmesin.
        if (sessionEpoch() !== epoch) {
          if (loggedOutSince(epoch)) return null;
          throw e;
        }
        if (e instanceof ApiError && e.status === 401) {
          clearMeCache();
          setShellTimeZone(undefined);
          client.forgetOrg();
          return null;
        }
        throw e;
      }
    },
    placeholderData: readCachedMe,
    staleTime: 60_000,
    // Firmasız ekranda bekleyen kişi (askı, davet): sekmeye dönünce sorulur, askı kalktıysa yenilemeden firmasına geçer.
    refetchOnWindowFocus: (q) => (q.state.data && !q.state.data.activeOrg ? 'always' : false),
  });
  // Hesap'a ulaşılamadıysa kişi çıkarılmaz: kabuk son bilinen kişiyle açık kalır.
  return { ...query, me: query.data ?? (query.isError ? (readCachedMe() ?? null) : null) };
}

export function useSessionActions() {
  const client = useSessionClient();
  const qc = useQueryClient();
  /**
   * Hata fırlatmaz. Sunucu oturumu bitirdiyse (2xx, ya da 4xx: 408 ve 429 hariç) yerel durum silinir ve çıkış öbür sekmelere
   * duyurulur (onlar da girişe gider); yoksa kişi oturumda kalır.
   */
  const logout = useCallback(async (): Promise<LogoutResult> => {
    let serverEnded: boolean;
    try {
      await client.post('/api/account/auth/logout', undefined, { noRefresh: true });
      serverEnded = true;
    } catch (e) {
      serverEnded = e instanceof ApiError && e.status >= 400 && e.status <= 499 && e.status !== 408 && e.status !== 429;
    }
    if (serverEnded) {
      endSessionEpoch('logout');
      clearMeCache();
      clearPendingLocale();
      setShellTimeZone(undefined);
      client.forgetOrg();
      qc.clear();
      client.announceLogout();
    }
    return { serverEnded };
  }, [client, qc]);
  /** Etkin firma değişir; her ürünün verisi değiştiği için sayfa baştan yüklenir. */
  const switchOrg = useCallback(
    async (orgId: string, redirect = '/home') => {
      await client.post('/api/account/auth/switch-org', { orgId });
      beginOrgChange();
      qc.clear();
      window.location.assign(redirect);
    },
    [client, qc],
  );
  /** Etkin firma değişir: önbellek temizlenir, sayfa baştan yüklenir. Yeni firma etkin olur. */
  const createOrg = useCallback(
    async (body: CreateOrgBody, redirect = '/home') => {
      const res = await client.post<AuthResponse>('/api/account/orgs', body);
      beginOrgChange();
      qc.clear();
      window.location.assign(redirect);
      return res;
    },
    [client, qc],
  );
  /** Etkin firmadan ayrılır. Sonraki firmaya geçilir; firma kalmadıysa `activeOrg` null olur. */
  const leaveOrg = useCallback(
    async (body: LeaveOrgBody = {}, redirect = '/home') => {
      const res = await client.post<AuthResponse>('/api/account/org/leave', body);
      beginOrgChange();
      qc.clear();
      window.location.assign(redirect);
      return res;
    },
    [client, qc],
  );
  const changeLocale = useCallback(
    async (locale: Locale) => {
      writePendingLocale(locale);
      setShellLocale(locale);
      // keepalive: kişi hemen başka uygulamaya geçse de istek yarıda kalmaz.
      await client
        .patch('/api/account/me', { locale }, { keepalive: true })
        .then(() => clearPendingLocale(locale))
        .catch(() => undefined);
      await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    [client, qc],
  );
  return useMemo(() => ({ logout, switchOrg, changeLocale, createOrg, leaveOrg }), [logout, switchOrg, changeLocale, createOrg, leaveOrg]);
}

/** Kişinin bu araçta web'e erişimi var mı. Kod rol adına bakmaz, izne bakar. */
export function hasWebAccess(me: MeResponse | null, product: ProductKey): boolean {
  const p = me?.products.find((x) => x.key === product);
  const web = PRODUCTS[product].webAccess;
  return !!web && !!p?.permissions.includes(web);
}
