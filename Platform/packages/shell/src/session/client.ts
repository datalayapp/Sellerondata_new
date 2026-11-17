import i18next from 'i18next';
import { COOKIE_LANG, DEFAULT_LOCALE, ERROR_MESSAGES, ORG_HEADER } from '@sellerondata/contracts';
import type { ApiErrorBody } from '@sellerondata/contracts';
import { sessionStatus } from './status.ts';
import { endSessionEpoch } from './epoch.ts';

/** Tüm servislerde aynı hata. İstemci mantığı `code`'a bakar, metin `message`'dan gösterilir. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** `Retry-After`, varsa: "kaç dakika sonra" yazılabilsin. */
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, details?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type SessionClientOptions = {
  /** Etkin dil. Her isteğe Accept-Language olarak konur. */
  getLocale?: () => string;
  /** Yenileme ucu kesin 401 verdiyse bir kez çağrılır (ör. /login yönlendirmesi). Ağ hatası ve 5xx oturum kaybı sayılmaz. */
  onSessionLost?: () => void;
  refreshPath?: string;
  fetchImpl?: typeof fetch;
};

export type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  /** true ise 401 yenileme denemesi yapılmaz (giriş, kayıt gibi). */
  noRefresh?: boolean;
  /** false ise `X-SOD-Org` gönderilmez. Yalnız firmayı öğrenmek için. */
  orgGuard?: boolean;
};

const REFRESH_LOCK = 'sod-refresh';
const REFRESH_STAMP = 'sod_refreshed_at';
/** Başka sekme bu kadar kısa süre önce yenilediyse aynı yenileme jetonu ikinci kez gönderilmez. */
const REFRESH_FRESH_MS = 5000;
const SESSION_CODES = new Set(['UNAUTHORIZED', 'TOKEN_EXPIRED', 'TOKEN_STALE']);
/** Oturumun kendisini yöneten uçlar firmaya bağlı değil: eski sekmeden çıkış ve firma değiştirme çalışmalı. */
const SESSION_PATHS = /^\/api\/account\/auth\//;
const ORG_CHANNEL = 'sod-session';
/** Kabuğun ilk karesi için `/me` önbelleği (sekmeye özgü). Çıkışta silinir. */
export const ME_CACHE_KEY = 'sod_me_cache';
const ME_PATH = '/api/account/me';
const ACCOUNT_PREFIX = '/api/account/';
/** Ağ geçidi yukarı akışa ulaşamayınca bunları döner (`SERVICE_UNAVAILABLE`). */
const GATEWAY_DOWN = new Set([502, 503, 504]);
/** Bundan uzun bekleme istenirse kendi kendine denenmez, hata kişiye söylenir. */
const RATE_RETRY_MAX_SECONDS = 60;
/** Erişim reddinde sessiz yenileme aralığı: rol gerçekten yoksa döngü olmaz. */
const ACCESS_REFRESH_GAP_MS = 30_000;

type RefreshResult = 'ok' | 'denied' | 'unavailable';

/** Ağ düştü ya da yenileme ucuna ulaşılamadı. Oturum düşmedi: durum 0, kişi girişe gönderilmez. */
function unavailableError() {
  const message = i18next.isInitialized ? i18next.t('session.offlineError', { ns: 'shell' }) : 'Network unavailable';
  return new ApiError(0, 'NETWORK_UNAVAILABLE', message);
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export type SessionClient = ReturnType<typeof createSessionClient>;

/**
 * Oturum istemcisi. Jeton tarayıcı deposunda durmaz, HttpOnly çerezdedir (ARCHITECTURE §5).
 * - Her istek: çerez, Accept-Language; durum değiştirenlerde `X-SOD-CSRF: 1`.
 * - 401 (TOKEN_STALE, TOKEN_EXPIRED, UNAUTHORIZED): tek seferlik yenile + tekrar dene.
 * - Çıkış yalnız yenileme ucunun kesin 401'inde. Ağ hatası ve 5xx: `NETWORK_UNAVAILABLE`, kabuk "Bağlantı yok" der, yazı kaybolmaz.
 * - Firma biliniyorsa `X-SOD-Org` (sunucu yazmalarda zorunlu kılar). Yanıt 409 ORG_MISMATCH ise tekrar edilmez: kabuk uyarır (§5, `SessionBanner`).
 *   Sekmeler `BroadcastChannel` ile birbirine duyurur; eski sekme kayıt denemeden önce de haberdar olur.
 * - Çıkış da duyurulur (`announceLogout`): öbür sekmeler bir sonraki isteği beklemeden `onSessionLost` ile girişe gider.
 * - Yenileme jetonu her kullanımda döner, eskisi tekrar gelirse aile iptal edilir. Bu yüzden
 *   yenileme hem sekme içinde tek uçuşludur hem de sekmeler arası Web Locks ile sıraya girer.
 */
export function createSessionClient(options: SessionClientOptions = {}) {
  const refreshPath = options.refreshPath ?? '/api/account/auth/refresh';
  const doFetch = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let inflight: Promise<RefreshResult> | null = null;
  let lost = false;
  /** Bu sayfanın firması. undefined: henüz bilinmiyor; null: kişinin etkin firması yok. */
  let activeOrg: string | null | undefined;
  /** false: önbellekten alındı, `/me` henüz doğrulamadı. İlk `/me` sessizce düzeltir: yeni yüklenen sayfada eski sekme yoktur. */
  let orgConfirmed = false;
  /** Yenileme bu sekmeyi başka firmaya taşıdı, uyarı henüz açılmadı. O arada okuma tekrarlanmaz: yanıt başka firmanın verisi olur. */
  let orgMoved = false;
  const orgAdoptedListeners = new Set<() => void>();
  let busyCount = 0;
  let accessRefresh: Promise<RefreshResult> | null = null;
  let accessRefreshedAt = 0;
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(ORG_CHANNEL) : null;
  /** Neden "Bağlantı yok": ağ düştüyse her başarılı yanıt, Hesap kesikse yalnız Hesap'ın yanıtı kaldırır (DeciShip çalışırken uyarı sönmesin). */
  let offlineCause: 'network' | 'account' | null = null;

  function markOffline(cause: 'network' | 'account') {
    offlineCause = cause;
    sessionStatus.update({ offline: true });
  }

  /** Oturum servisi kesikse kabuk söyler. Ürün servisinin 503'ü o bölümün hatasıdır, genel uyarı değil. */
  function noteResponse(path: string, res: Response) {
    const account = path.startsWith(ACCOUNT_PREFIX);
    if (account && GATEWAY_DOWN.has(res.status)) markOffline('account');
    else if (res.ok && (account || offlineCause !== 'account')) {
      offlineCause = null;
      sessionStatus.update({ offline: false });
    }
  }

  const locale = () => options.getLocale?.() ?? readCookie(COOKIE_LANG) ?? DEFAULT_LOCALE;

  async function refreshOnce(force: boolean): Promise<RefreshResult> {
    const run = async (): Promise<RefreshResult> => {
      const stamp = Number(localStorage.getItem(REFRESH_STAMP) ?? 0);
      if (!force && Date.now() - stamp < REFRESH_FRESH_MS) return 'ok';
      const res = await doFetch(refreshPath, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-SOD-CSRF': '1', 'Accept-Language': locale(), Accept: 'application/json' },
      });
      if (res.ok) {
        localStorage.setItem(REFRESH_STAMP, String(Date.now()));
        // Yenileme başka firmaya düştüyse (çıkarıldı, askıya alındı) sekme bilsin: sessizce başka firmanın verisini göstermesin.
        const next = (await res.clone().json().catch(() => null)) as { activeOrgId?: string | null } | null;
        // Firmasız sayfa (askı, davet bekleyen) uyarılmaz: ekranda başka firmanın verisi yok, sonraki `/me` firmayı alır.
        if (orgConfirmed && activeOrg !== null && next && 'activeOrgId' in next && next.activeOrgId !== activeOrg) {
          orgMoved = true;
          void checkOrgChange(true);
        }
        return 'ok';
      }
      if (res.status === 401) return 'denied';
      // Hesap burada çerezleri siler: oturum gerçekten bitti, kişi girişte "e-postanızı doğrulayın" okur.
      const code = ((await res.json().catch(() => null)) as ApiErrorBody | null)?.error?.code;
      return code === 'EMAIL_NOT_VERIFIED' ? 'denied' : 'unavailable';
    };
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(REFRESH_LOCK, run) : run();
  }

  function refresh(force = false): Promise<RefreshResult> {
    inflight ??= refreshOnce(force)
      .catch((): RefreshResult => 'unavailable')
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const { body, noRefresh, orgGuard, headers, ...rest } = opts;
    const method = (rest.method ?? 'GET').toUpperCase();
    const h = new Headers(headers);
    h.set('Accept-Language', locale());
    if (!h.has('Accept')) h.set('Accept', 'application/json');
    if (method !== 'GET' && method !== 'HEAD') h.set('X-SOD-CSRF', '1');
    if (orgGuard !== false && typeof activeOrg === 'string' && !SESSION_PATHS.test(path)) h.set(ORG_HEADER, activeOrg);
    // Sunucu yalnız yazmaları denetler. Uyarı açıkken okuma gönderilmez: yanıt başka firmanın verisidir, bu sekmede o firmanın adıyla görünürdü.
    const guardedRead = method === 'GET' && orgGuard !== false && !SESSION_PATHS.test(path);
    const orgMismatch = () => new ApiError(409, 'ORG_MISMATCH', ERROR_MESSAGES.ORG_MISMATCH[locale() === 'en' ? 'en' : 'tr']);
    if (guardedRead && sessionStatus.get().orgChange) throw orgMismatch();
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      if (typeof body === 'string' || body instanceof FormData || body instanceof Blob) payload = body;
      else {
        h.set('Content-Type', 'application/json');
        payload = JSON.stringify(body);
      }
    }
    const send = async () => {
      try {
        const res = await doFetch(path, { ...rest, method, headers: h, body: payload, credentials: 'include' });
        noteResponse(path, res);
        return res;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        markOffline('network');
        throw unavailableError();
      }
    };

    /** Yenilemeden sonraki tekrar: yenileme firmayı değiştirdiyse okuma gitmez. */
    const resend = async () => {
      if (guardedRead && (orgMoved || sessionStatus.get().orgChange)) throw orgMismatch();
      return send();
    };

    const startedAt = Date.now();
    let res = await send();
    if (res.status === 401 && !noRefresh && (await isSessionFailure(res))) {
      let outcome = await refresh();
      if (outcome === 'ok') {
        res = await resend();
        // Yenilemeyi başka sekme yapmış sanıldıysa ve jeton yine bayatsa gerçekten yenilenir.
        if (res.status === 401 && (await isSessionFailure(res))) {
          outcome = await refresh(true);
          if (outcome === 'ok') res = await resend();
        }
      }
      if (outcome === 'unavailable') {
        markOffline('account');
        throw unavailableError();
      }
      if (outcome === 'denied' && !lost) {
        lost = true;
        options.onSessionLost?.();
      }
    }
    // Rol az önce verilmiş olabilir, jeton eskidir: bir kez sessizce yenile ve yeniden dene. Aralık içinde tekrar reddedilirse kişiye söylenir.
    if (res.status === 403 && !noRefresh && (await isRefreshableDenial(res))) {
      let fresh = accessRefreshedAt >= startedAt;
      if (!fresh && Date.now() - accessRefreshedAt >= ACCESS_REFRESH_GAP_MS) {
        accessRefresh ??= refresh(true).finally(() => {
          accessRefreshedAt = Date.now();
          accessRefresh = null;
        });
        fresh = (await accessRefresh) === 'ok';
      }
      if (fresh) res = await resend();
    }
    if (res.status === 409 && (await isOrgMismatch(res))) void checkOrgChange(true);
    // Okuma sınıra takıldı: bölüm hatası değil. Sunucunun söylediği kadar bekle, bir kez yeniden dene. Yazma tekrarlanmaz.
    if (res.status === 429 && method === 'GET') {
      const wait = Number(res.headers.get('Retry-After'));
      if (wait > 0 && wait <= RATE_RETRY_MAX_SECONDS) {
        busyCount += 1;
        sessionStatus.update({ busy: true });
        try {
          await new Promise((resolve) => setTimeout(resolve, wait * 1000));
          if (!rest.signal?.aborted) res = await send();
        } finally {
          busyCount -= 1;
          if (!busyCount) sessionStatus.update({ busy: false });
        }
      }
    }
    return res;
  }

  async function isRefreshableDenial(res: Response): Promise<boolean> {
    try {
      const body = (await res.clone().json()) as { error?: { code?: string; details?: { refreshable?: boolean } } };
      return body?.error?.code === 'NO_PRODUCT_ACCESS' && body.error.details?.refreshable === true;
    } catch {
      return false;
    }
  }

  async function isOrgMismatch(res: Response): Promise<boolean> {
    try {
      return ((await res.clone().json()) as { error?: { code?: string } })?.error?.code === 'ORG_MISMATCH';
    } catch {
      return false;
    }
  }

  /** Oturumun firmasını sorar. Bu sekmeninkinden farklıysa kabuk uyarır; aynıysa uyarı kalkar. */
  async function checkOrgChange(rejected: boolean) {
    try {
      const res = await raw(ME_PATH, { orgGuard: false });
      if (!res.ok) throw new Error(String(res.status));
      const me = (await res.json()) as { activeOrg?: { id: string; name: string } | null; orgs?: { id: string; name: string; status: string }[] };
      const current = me.activeOrg ?? null;
      // Firma henüz öğrenilmemişken yazıldı: uyuşmazlık değil, bundan sonra başlık gider.
      if (activeOrg === undefined) activeOrg = current?.id ?? null;
      if (!orgConfirmed) {
        // Doğrulanmamış önbellek farklı çıktı: uyuşmazlık değil, firma güncellendi.
        activeOrg = current?.id ?? null;
        orgConfirmed = true;
        sessionStatus.update({ orgChange: null });
        return;
      }
      // Firmasız sekme firmaya kavuştu (askı kalktı, başka sekme firma açtı): ekranda başka firmanın verisi yok, uyarıya gerek yok.
      if (activeOrg === null && current) {
        activeOrg = current.id;
        sessionStatus.update({ orgChange: null });
        orgAdoptedListeners.forEach((fn) => fn());
        return;
      }
      if ((current?.id ?? null) === activeOrg) sessionStatus.update({ orgChange: null });
      else {
        const orgs = me.orgs ?? [];
        const ended = typeof activeOrg === 'string' && !orgs.some((o) => o.id === activeOrg && o.status === 'ACTIVE');
        const suspended = ended && orgs.some((o) => o.id === activeOrg && o.status === 'SUSPENDED');
        const others = orgs.filter((o) => o.id !== activeOrg && o.status === 'ACTIVE').map(({ id, name }) => ({ id, name }));
        sessionStatus.update({ orgChange: { current: { id: current?.id ?? null, name: current?.name ?? null }, ended, suspended, others } });
      }
    } catch {
      // Sunucu reddettiyse uyarı kalır. Yalnız duyuru geldiyse ve Hesap'a ulaşılamıyorsa firma bilinmiyor: "Bağlantı yok" yeterli.
      if (rejected && activeOrg !== undefined) sessionStatus.update({ orgChange: { current: null } });
    } finally {
      // Sonuç artık uyarıda: açıksa okumaları o durdurur, firma aynı çıktıysa durdurulacak bir şey yok.
      orgMoved = false;
    }
  }

  /**
   * `/me` geldikçe çağrılır. İlk çağrı sayfanın firmasını belirler ve öbür sekmelere duyurur.
   * Sonraki bir çağrı başka firma getirirse (eski sekme) false: veri bu firmaya ait değildir, kullanılmaz.
   */
  function noteActiveOrg(orgId: string | null): boolean {
    // Firmasızdan firmaya geçiş eski sekme değildir: askı kalktı ya da davet kabul edildi, kişi firmasına döner.
    if (activeOrg === undefined || !orgConfirmed || (activeOrg === null && orgId !== null)) {
      activeOrg = orgId;
      orgConfirmed = true;
      channel?.postMessage({ type: 'org', orgId });
      return true;
    }
    if (activeOrg === orgId) return true;
    void checkOrgChange(true);
    return false;
  }

  /** Sayfa açılırken önbellekteki firma: ekranda o firma görünür, ilk yazma başlıksız gitmesin. Duyurulmaz; sonraki `/me` düzeltir, sunucu yine başlıkla korur. */
  function adoptCachedOrg(orgId: string | null | undefined) {
    if (activeOrg === undefined && orgId !== undefined) activeOrg = orgId;
  }

  /** Başka sekme çıkış yaptı: oturum çerezi bütün sekmelerde gitti. Bu sekme de girişe gider (bir kez). */
  function onLogoutElsewhere() {
    if (lost) return;
    lost = true;
    endSessionEpoch('logout');
    try {
      sessionStorage.removeItem(ME_CACHE_KEY);
    } catch {
      /* depo kapalı olabilir */
    }
    options.onSessionLost?.();
  }

  if (channel) {
    channel.onmessage = (e: MessageEvent<{ type?: string; orgId?: string | null }>) => {
      if (e.data?.type === 'logout') {
        onLogoutElsewhere();
        return;
      }
      if (e.data?.type !== 'org' || activeOrg === undefined || e.data.orgId === activeOrg) return;
      void checkOrgChange(false);
    };
  }
  sessionStatus.retry = async () => {
    try {
      const res = await raw(ME_PATH, { orgGuard: false });
      return res.ok;
    } catch {
      return false;
    }
  };
  sessionStatus.switchOrg = async (orgId) => {
    const res = await raw('/api/account/auth/switch-org', { method: 'POST', body: { orgId } });
    if (!res.ok) throw await toError(res);
  };
  sessionStatus.resumeOrg = async () => {
    if (typeof activeOrg !== 'string') return;
    const res = await raw('/api/account/auth/switch-org', { method: 'POST', body: { orgId: activeOrg } });
    if (!res.ok) throw await toError(res);
    sessionStatus.update({ orgChange: null });
    channel?.postMessage({ type: 'org', orgId: activeOrg });
  };

  /**
   * Her 401 oturum sorunu değildir: yanlış mevcut şifre de 401 INVALID_CREDENTIALS döner ve kişiyi
   * girişe atmamalı. Gövde okunamazsa oturum sorunu sayılır.
   */
  async function isSessionFailure(res: Response): Promise<boolean> {
    try {
      const body = (await res.clone().json()) as ApiErrorBody;
      return !body?.error?.code || SESSION_CODES.has(body.error.code);
    } catch {
      return true;
    }
  }

  async function toError(res: Response): Promise<ApiError> {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* gövde JSON değil */
    }
    // Ağ geçidinin 503'ünde metin yok: İngilizce durum satırı yerine aynı anlaşılır uyarı.
    const fallback = GATEWAY_DOWN.has(res.status) ? unavailableError().message : res.statusText;
    const retryAfter = Number(res.headers.get('Retry-After'));
    return new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? fallback, body?.error?.details, retryAfter > 0 ? retryAfter : undefined);
  }

  /** JSON yanıtlı istek. 2xx dışı her durum ApiError atar. */
  async function request<T>(path: string, opts?: RequestOptions): Promise<T> {
    const res = await raw(path, opts);
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Dosya indirme (CSV). Çerezle gider, hata JSON ise ApiError atar. */
  async function download(path: string, fallbackName: string): Promise<void> {
    const res = await raw(path, { headers: { Accept: 'text/csv, */*' } });
    if (!res.ok) throw await toError(res);
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const name = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    saveBlob(await res.blob(), name ? decodeURIComponent(name) : fallbackName);
  }

  return {
    request,
    download,
    raw,
    get: <T,>(path: string, opts?: RequestOptions) => request<T>(path, { ...opts, method: 'GET' }),
    post: <T,>(path: string, body?: unknown, opts?: RequestOptions) => request<T>(path, { ...opts, method: 'POST', body }),
    patch: <T,>(path: string, body?: unknown, opts?: RequestOptions) => request<T>(path, { ...opts, method: 'PATCH', body }),
    delete: <T,>(path: string, opts?: RequestOptions) => request<T>(path, { ...opts, method: 'DELETE' }),
    /** Yenileme akışını dışarıdan tetikler (ör. firma değişiminden sonra). */
    refresh: async (force = false) => (await refresh(force)) === 'ok',
    noteActiveOrg,
    adoptCachedOrg,
    /** Firmasız sekme firmaya kavuşunca çağrılır: `/me` yeniden sorulsun. Dönen işlev aboneliği bitirir. */
    onOrgAdopted: (fn: () => void) => {
      orgAdoptedListeners.add(fn);
      return () => {
        orgAdoptedListeners.delete(fn);
      };
    },
    /** Çıkışta ve girişte: sonraki `/me` sayfanın firmasını yeniden belirler. */
    forgetOrg: () => {
      activeOrg = undefined;
      orgConfirmed = false;
      orgMoved = false;
      sessionStatus.update({ orgChange: null });
    },
    /** Çıkış bitti (sunucu oturumu kapattı): öbür sekmelere duyurulur. Bu sekme kendi yönlendirmesini yapar. */
    announceLogout: () => {
      channel?.postMessage({ type: 'logout' });
    },
    /** Yeniden giriş sonrası "oturum kayıp" bayrağını sıfırlar. */
    resetLost: () => {
      lost = false;
    },
  };
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
