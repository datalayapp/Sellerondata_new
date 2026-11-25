import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { CLIENT_HEADER, DEFAULT_LOCALE, errorMessage, type AuthResponse, type ProductKey } from '@sellerondata/contracts';
import { claimsSignature, decodeClaims, sameScope, scopeFromClaims, type SessionScope, type TokenClaims } from '../auth/token';
import { i18n } from '../i18n';
import { clientHeader } from '../version/client';
import { getUpgradeState, POLICY_TIMEOUT_MS, setUpgradeRequired } from '../version/policy';
import { DEFAULT_SERVER_URL, LOCAL_SERVER_URLS, normalizeServerUrl, SERVER_EDITABLE } from './serverUrl';

export { DEFAULT_SERVER_URL, LOCAL_SERVER_URLS, SERVER_EDITABLE };

/** Eski sürümün anahtarları (`serverUrl`, `accessToken`, `refreshToken`) okunmaz: taban ve jeton biçimi değişti. */
const K_SERVER = 'sod_gateway_url';
const K_ACCESS = 'sod_access_token';
const K_REFRESH = 'sod_refresh_token';
/**
 * Yoldaki yenilemenin tekrar anahtarı (6.8), `<jetonun SHA-256 özeti>:<anahtar>`. Elimizdeki yenileme jetonuna aittir; jeton değişince
 * silinir, açılışta özet depodaki jetonla tutmazsa atılır.
 */
const K_RETRY = 'sod_refresh_retry';

/** Anahtarın ait olduğu jetonu tanıtan özet (onaltılık). */
function tokenTag(token: string): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, token);
}

/** Depodaki kaydın anahtarı, ancak depodaki jetona aitse. */
async function storedRetryKey(stored: string | null, token: string | null): Promise<string | null> {
  if (!stored || !token) return null;
  const sep = stored.indexOf(':');
  if (sep <= 0) return null;
  try {
    return stored.slice(0, sep) === (await tokenTag(token)) ? stored.slice(sep + 1) || null : null;
  } catch {
    return null;
  }
}
export const K_REMEMBER = 'sod_remember';

const ACCOUNT_ROOT = '/api/account';
const productRoot = (product: ProductKey) => `/api/${product}`;

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** Sunucunun `retry-after` başlığı (ms). Kuyruk bu süre dolmadan yeniden göndermez (11-B1). */
  retryAfterMs?: number;
  constructor(status: number, code: string, message: string, details?: unknown, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

type Session = { serverUrl: string; accessToken: string | null; refreshToken: string | null };

const session: Session = { serverUrl: DEFAULT_SERVER_URL, accessToken: null, refreshToken: null };
/** Elimizdeki yenileme jetonu için üretilmiş tekrar anahtarı: aynı jetonla her denemede aynısı gider (`refreshTokens`). */
let retry: { token: string; key: string } | null = null;
const logoutListeners = new Set<() => void>();
const sessionListeners = new Set<() => void>();
let decoded: { token: string | null; claims: TokenClaims | null } = { token: null, claims: null };

/** Oturum sunucu tarafından düşürüldü (yenileme jetonu geçersiz). */
export function onForcedLogout(fn: () => void): () => void {
  logoutListeners.add(fn);
  return () => logoutListeners.delete(fn);
}

/** Jeton değişti: giriş, çıkış, yenileme, firma değişimi. */
export function onSessionChanged(fn: () => void): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export async function loadSession(): Promise<Session> {
  const [url, access, refresh, remember, storedRetry] = await Promise.all([
    SecureStore.getItemAsync(K_SERVER),
    SecureStore.getItemAsync(K_ACCESS),
    SecureStore.getItemAsync(K_REFRESH),
    SecureStore.getItemAsync(K_REMEMBER),
    SecureStore.getItemAsync(K_RETRY),
  ]);
  session.serverUrl = (SERVER_EDITABLE && url) || DEFAULT_SERVER_URL;
  if (remember === '0') {
    await setTokens(null, null);
    return { ...session };
  }
  // Depodan okunan jetonun telefona ne zaman geldiği bilinmez: süresi telefon saatiyle değerlendirilir.
  accessReceivedAt = null;
  session.accessToken = access;
  session.refreshToken = refresh;
  // Uygulama yenileme yanıtını depoya yazamadan kapandıysa elde eski jeton ve onun anahtarı kalır: açılıştaki ilk yenileme aynı
  // anahtarla gider, sunucu süre aramadan kabul eder (6.8).
  // Başka jetona ait (jeton yazıldı, eski anahtar silinemeden kapandı) ya da bozuk kayıt atılır.
  const retryKey = await storedRetryKey(storedRetry, refresh);
  retry = refresh && retryKey ? { token: refresh, key: retryKey } : null;
  if (storedRetry && !retry) {
    const drop = persisting.then(() => SecureStore.deleteItemAsync(K_RETRY));
    persisting = drop.catch(() => undefined);
  }
  sessionListeners.forEach((fn) => fn());
  return { ...session };
}

export function getServerUrl(): string {
  return session.serverUrl;
}

export function hasSession(): boolean {
  return !!session.refreshToken;
}

/** Geliştirme dışında adres derleme anındaki adrestir: yazılan adres yok sayılır, saklanmaz. */
export async function setServerUrl(url: string): Promise<void> {
  session.serverUrl = SERVER_EDITABLE ? normalizeServerUrl(url) : DEFAULT_SERVER_URL;
  if (SERVER_EDITABLE) await SecureStore.setItemAsync(K_SERVER, session.serverUrl);
}

/** Güvenli depoya yazımlar sırayla: üst üste gelen iki çağrının (yenileme ve çıkış) yazımları karışmasın. */
let persisting: Promise<void> = Promise.resolve();

/** Elimizdeki erişim jetonunun telefona geldiği an (telefon saati). Depodan okunduysa bilinmez. */
let accessReceivedAt: number | null = null;

/** Süresi dolmak üzere sayılan jeton: yolda geçen süre ve küçük saat farkı için pay. */
export const ACCESS_EXPIRY_MARGIN_MS = 15_000;

/**
 * Erişim jetonunun süresi yerelde bilindiği kadarıyla doldu mu (exp)? Ömür (exp − iat) telefona geliş anından sayılır:
 * telefon saati sunucudan farklı olsa da yanılmaz. Geliş anı bilinmiyorsa (açılışta depodan okundu) exp telefon saatiyle
 * karşılaştırılır; telefon saati geliş anından geriye alındıysa da öyle. Süre bilinmiyorsa (exp yok) dolmamış sayılır: bugünkü
 * 401 + yenileme yolu kalır.
 */
function accessLikelyExpired(now: number): boolean {
  const c = currentClaims();
  if (!c?.exp) return false;
  if (accessReceivedAt !== null && c.iat !== undefined && now >= accessReceivedAt) {
    return now >= accessReceivedAt + (c.exp - c.iat) * 1000 - ACCESS_EXPIRY_MARGIN_MS;
  }
  return now >= c.exp * 1000 - ACCESS_EXPIRY_MARGIN_MS;
}

async function persistTokens(accessToken: string | null, refreshToken: string | null, refreshChanged: boolean): Promise<void> {
  if (!accessToken && !refreshToken) {
    // Çıkış: erişim jetonu silinemese de yenileme jetonu yine silinir (yoksa açılışta oturum geri gelirdi). İlk hata döner.
    const results = await Promise.allSettled([
      SecureStore.deleteItemAsync(K_ACCESS),
      SecureStore.deleteItemAsync(K_REFRESH),
      SecureStore.deleteItemAsync(K_RETRY),
    ]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    return;
  }
  if (accessToken) await SecureStore.setItemAsync(K_ACCESS, accessToken);
  else await SecureStore.deleteItemAsync(K_ACCESS);
  if (refreshToken) await SecureStore.setItemAsync(K_REFRESH, refreshToken);
  else await SecureStore.deleteItemAsync(K_REFRESH);
  // Anahtar eski jetona aitti. Yeni jeton yazılmadan silinmez: arada kapanan uygulama eski jetonu anahtarıyla bulur.
  if (refreshChanged) await SecureStore.deleteItemAsync(K_RETRY);
}

/**
 * Bellek hemen değişir; güvenli depo çağrı sırasıyla yazılır. Yazımlar sıraya girmeseydi çıkışın silmesi, o sırada süren
 * yenilemenin yazımından önce bitebilirdi: bellek boş, depoda yenileme jetonu; uygulama yeniden açılınca çıkılmış oturum
 * geri gelirdi. Yazım hatası yalnız bu çağrıya döner, sıradakileri durdurmaz.
 */
export function setTokens(accessToken: string | null, refreshToken: string | null): Promise<void> {
  if (accessToken !== session.accessToken) accessReceivedAt = accessToken ? Date.now() : null;
  const refreshChanged = refreshToken !== session.refreshToken;
  if (refreshChanged) retry = null;
  session.accessToken = accessToken;
  session.refreshToken = refreshToken;
  if (scopeFromClaims(decodeClaims(accessToken))) orgRecoveryAt = 0;
  // Bellek hemen değişir: bundan sonraki istek yeni jetonu ve yeni kapsamı görür.
  sessionListeners.forEach((fn) => fn());
  const write = persisting.then(() => persistTokens(accessToken, refreshToken, refreshChanged));
  persisting = write.catch(() => undefined);
  return write;
}

/** Çıkış bildiriminin zaman aşımı. Çıkış bunu beklemez. */
export const LOGOUT_NOTIFY_TIMEOUT_MS = 5000;

let signOuts = 0;

/** Kişinin kendi çıkışı kaç kez oldu. Çıkıştan önce başlamış bir oturum yanıtı (firma değişimi) bununla atılır. */
export function signOutCount(): number {
  return signOuts;
}

/**
 * Kişinin kendi çıkışı. Önce telefondaki jetonlar silinir (bellek hemen, güvenli depo `setTokens` yazım sırasıyla; bekleyen
 * yazımlardan sonra çalışır, onları geri getirmez), sonra sunucuya yenileme jetonunun iptali bildirilir, beklenmeden.
 * Eskiden bildirim önceydi: sunucu yanıt vermezken uygulama kapatılırsa jetonlar depoda kalıyor, açılışta oturum geri
 * geliyordu (hayalet oturum). Bildirim yerel silme bittikten sonra çıkar: silme bitmeden kapanan uygulamada sunucu jetonu
 * iptal etmiş, depo da tutmuş olmasın (açılışta "Oturum sona erdi"). Bildirim gitmezse jeton sunucuda süresi dolunca düşer.
 */
export async function signOut(): Promise<void> {
  signOuts += 1;
  const rt = session.refreshToken;
  try {
    await setTokens(null, null);
  } catch (e) {
    // Depo silinemedi: bellek yine boş, kişi çıkmış sayılır. Bildirim sunucuda jetonu iptal eder.
    console.warn('logout persist', e);
  }
  if (!rt) return;
  void rawFetch(`${ACCOUNT_ROOT}/auth/logout`, { method: 'POST', json: { refreshToken: rt }, auth: false, timeoutMs: LOGOUT_NOTIFY_TIMEOUT_MS }).catch(
    () => undefined,
  );
}

/** Giriş, katılım, firma değişimi yanıtı. `refreshToken` yoksa elimizdeki korunur (`contracts/AuthResponse`). */
export async function applyAuthResponse(res: AuthResponse): Promise<void> {
  await setTokens(res.accessToken ?? session.accessToken, res.refreshToken ?? session.refreshToken);
}

export function getRefreshToken(): string | null {
  return session.refreshToken;
}

function currentClaims(): TokenClaims | null {
  if (decoded.token !== session.accessToken) decoded = { token: session.accessToken, claims: decodeClaims(session.accessToken) };
  return decoded.claims;
}

/** Elimizdeki jetonun kişi + firması. Firması olmayan jetonda null. */
export function currentSessionScope(): SessionScope | null {
  return scopeFromClaims(currentClaims());
}

export function currentPersonId(): string | null {
  return currentClaims()?.sub ?? null;
}

export function currentSessionSignature(): string {
  return claimsSignature(currentClaims());
}

export type FetchInit = Omit<RequestInit, 'body'> & {
  body?: BodyInit | null;
  /** JSON gövde. */
  json?: unknown;
  /** Çok parçalı gövde. */
  form?: FormData;
  /** false: Bearer eklenmez, 401'de yenileme denenmez. */
  auth?: boolean;
  timeoutMs?: number;
  /**
   * İstek yalnız jeton bu kişi + firmaya aitse çıkar. Kuyruk kullanır: kayıt, başka kişinin veya firmanın
   * jetonuyla asla gönderilmez. Denetim her denemede, başlık yazılmadan hemen önce yapılır.
   */
  requireScope?: SessionScope;
  /** İstek yalnız jeton bu kişiye aitse çıkar; firmadan bağımsız kişi ayarları için. Denetim her denemede yapılır. */
  requirePerson?: string;
  /**
   * KALANLAR 6.7-b: her denemede, jeton yenilemesinden sonra, gövde gönderilmeden hemen önce telefonun o anki saati
   * `X-SOD-Sent-At` başlığına yazılır (ölçüm kaydı). Sunucu cihaz saati farkını bununla ölçer.
   */
  stampSentAt?: boolean;
};

/** Gönderim anındaki cihaz saati başlığı (`apps/api` `routes/measurements.ts` `SENT_AT_HEADER`). */
export const SENT_AT_HEADER = 'X-SOD-Sent-At';

/** Jeton, istenen kapsama ait değil. Ağ hatası değildir: kayıt kuyrukta kalır, deneme sayılmaz. */
export const SCOPE_MISMATCH = 'SCOPE_MISMATCH';

/** Sunucu bu uygulama sürümünü artık kabul etmiyor (426). Kuyruk kaydı bekler, deneme sayılmaz (Mesaj 13 §3.5). */
export const UPGRADE_REQUIRED = 'UPGRADE_REQUIRED';

/** `426 UPGRADE_REQUIRED` yanıtı güncelleme durumunu açar. JSON olmayan ya da başka kodlu 426 açmaz. */
async function noteUpgrade(res: Response): Promise<boolean> {
  if (res.status !== 426) return false;
  try {
    const body = (await res.clone().json()) as { error?: { code?: string; details?: unknown } } | null;
    if (body?.error?.code !== UPGRADE_REQUIRED) return false;
    void setUpgradeRequired(body.error.details);
    return true;
  } catch {
    return false;
  }
}

/** Yenileme 426 aldığında isteğin yerine dönen yanıt: çağıran (kuyruk) `UPGRADE_REQUIRED` görür, oturum durur. */
function upgradeResponse(): Response {
  const s = getUpgradeState();
  const details = s.required ? { minVersion: s.minVersion, updateUrl: s.updateUrl } : { minVersion: null, updateUrl: null };
  const message = errorMessage(UPGRADE_REQUIRED, i18n.language === 'en' ? 'en' : 'tr');
  return new Response(JSON.stringify({ error: { code: UPGRADE_REQUIRED, message, details } }), {
    status: 426,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function rawFetch(path: string, init: FetchInit): Promise<Response> {
  if (init.requireScope && !sameScope(currentSessionScope(), init.requireScope)) {
    throw new ApiError(-1, SCOPE_MISMATCH, SCOPE_MISMATCH);
  }
  if (init.requirePerson && currentPersonId() !== init.requirePerson) {
    throw new ApiError(-1, SCOPE_MISMATCH, SCOPE_MISMATCH);
  }
  const { json, form, auth, timeoutMs, requireScope: _scope, requirePerson: _person, stampSentAt, headers: extra, body: rawBody, signal, ...rest } = init;
  // Çağıranın başlığı önceliklidir (ör. `Accept-Language`).
  const headers = new Headers(extra ?? undefined);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', i18n.language || DEFAULT_LOCALE);
  let body: BodyInit | null | undefined = rawBody;
  if (form) body = form;
  else if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  if (auth !== false && session.accessToken) headers.set('Authorization', `Bearer ${session.accessToken}`);
  // Sürüm başlığı her isteğe; çağıran ezemez. Sürüm okunamadıysa gönderilmez (sunucu başlıksız isteği denetlemez).
  const ch = clientHeader();
  if (ch) headers.set(CLIENT_HEADER, ch);
  else headers.delete(CLIENT_HEADER);
  const ctrl = new AbortController();
  signal?.addEventListener('abort', () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 20000);
  const url = session.serverUrl + path;
  if (stampSentAt) headers.set(SENT_AT_HEADER, new Date().toISOString());
  let res: Response;
  try {
    res = await fetch(url, { ...rest, method: init.method ?? 'GET', headers, body: body as BodyInit, signal: ctrl.signal });
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    if (__DEV__) console.warn('fetch failed', url, String(e));
    throw new ApiError(0, aborted ? 'TIMEOUT' : 'NETWORK', i18n.t(aborted ? 'auth:errors.TIMEOUT' : 'auth:errors.NETWORK'));
  } finally {
    clearTimeout(timer);
  }
  await noteUpgrade(res);
  return res;
}

/** `upgrade`: hesap servisi bu sürümü reddetti (426). Oturum silinmez; güncelleme kurulunca aynı oturumla sürer. */
type RefreshOutcome = 'ok' | 'revoked' | 'unavailable' | 'upgrade';

let refreshing: Promise<RefreshOutcome> | null = null;

/**
 * Yenileme ile hesap servisinin "aynı jetonu yeniden kullanma" hoşgörüsü (11-B3, 04-B1, 6.8). Sunucu döndürülmüş eski jetonu, yeni
 * jeton henüz kullanılmadıysa, aynı tekrar anahtarıyla (`retryKeyFor`) geldiğinde süre aramadan kabul eder; anahtarsız ya da başka
 * anahtarla yalnız döndürme anından `REFRESH_REUSE_GRACE_SECONDS` (60 sn) içinde. Kayıp yanıt bu yüzden sonraki istekte, hatta
 * uygulama yeniden açıldıktan sonra da oturumu düşürmez. Uçuş içindeki kısa tekrarlar yine durur (kişi beklemesin):
 * - İlk deneme `REFRESH_TIMEOUT_MS` (6 sn) bekler (eskiden 15 sn: tekrar zaten hoşgörü dışına düşüyordu).
 * - Sonucu belirsiz deneme (ağ hatası, zaman aşımı, ağ geçidinin 502/504'ü: istek sunucuya ulaşmış olabilir) aynı eski jetonla
 *   kısa aralıkla tekrarlanır; tekrar yalnız ilk denemenin başlangıcından `REFRESH_RETRY_WINDOW_MS` (7 sn) içinde başlar.
 *   Oturumun düşmemesi artık buna bağlı değil; istek beklemeden toparlanır.
 * - Kesin cevaplar (401, 403, 426, 429, 500, 503) tekrarlanmaz: sunucu döndürmedi ya da oturum bitti.
 */
export const REFRESH_TIMEOUT_MS = 6000;
export const REFRESH_RETRY_TIMEOUT_MS = 8000;
export const REFRESH_RETRY_WINDOW_MS = 7000;
export const REFRESH_RETRY_DELAYS_MS = [300, 1200] as const;

/** Sonucu belirsiz yenileme yanıtı: ağ geçidi isteği iletmiş, hesap servisi jetonu döndürmüş olabilir. */
const AMBIGUOUS_REFRESH_STATUSES = new Set([502, 504]);

/** Yenileme isteği. Belirsiz sonuçta (ağ, zaman aşımı, 502/504) hoşgörü penceresi içinde aynı jetonla yeniden dener. */
async function postRefresh(sent: string, retryKey: string): Promise<Response> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const delay = attempt > 0 ? REFRESH_RETRY_DELAYS_MS[attempt - 1] : 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const last = attempt >= REFRESH_RETRY_DELAYS_MS.length;
    try {
      const res = await rawFetch(`${ACCOUNT_ROOT}/auth/refresh`, {
        method: 'POST',
        json: { refreshToken: sent, retryKey },
        auth: false,
        timeoutMs: attempt === 0 ? REFRESH_TIMEOUT_MS : REFRESH_RETRY_TIMEOUT_MS,
      });
      if (!AMBIGUOUS_REFRESH_STATUSES.has(res.status) || last) return res;
    } catch (e) {
      if (last) throw e;
    }
    // Bu arada çıkış ya da hesap değişimi olduysa eski jeton bir daha gönderilmez.
    if (session.refreshToken !== sent) throw new ApiError(0, 'NETWORK', 'NETWORK');
    const nextStart = Date.now() + REFRESH_RETRY_DELAYS_MS[attempt]!;
    if (nextStart - started >= REFRESH_RETRY_WINDOW_MS) throw new ApiError(0, 'TIMEOUT', 'TIMEOUT');
  }
}

/**
 * Bu jetonun tekrar anahtarı (6.8). İlk yenilemeden önce üretilir ve jetondan sonra güvenli depoya yazılır (yazım sırasıyla), sonra
 * istek çıkar. Jeton değişene dek her deneme (bu uçuştaki tekrarlar, sonraki istekler, uygulamanın yeniden açılışı) aynı anahtarı
 * gönderir: sunucu aynı eski jetonu aynı anahtarla süre aramadan kabul eder. Depoya yazılamazsa bellektekiyle sürer.
 */
async function retryKeyFor(token: string): Promise<string> {
  if (retry?.token === token) return retry.key;
  const key = Array.from(getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
  retry = { token, key };
  const write = persisting.then(async () => SecureStore.setItemAsync(K_RETRY, `${await tokenTag(token)}:${key}`));
  persisting = write.catch(() => undefined);
  await write.catch((e) => console.warn('retry key persist', e));
  return key;
}

/** Tek uçuş: aynı anda gelen 401'ler aynı yenilemeyi bekler; jeton döndüğü için ikinci yenileme hatadır. */
function refreshTokens(): Promise<RefreshOutcome> {
  const sent = session.refreshToken;
  if (!sent) return Promise.resolve('revoked');
  if (!refreshing) {
    refreshing = (async (): Promise<RefreshOutcome> => {
      try {
        const retryKey = await retryKeyFor(sent);
        // Anahtar yazılırken çıkış yapıldıysa eski jeton gönderilmez.
        if (session.refreshToken !== sent) return 'revoked';
        const res = await postRefresh(sent, retryKey);
        // 403 EMAIL_NOT_VERIFIED (Y35): hesap bu yenilemeyi oturum bitti sayar, yeniden denemek düzeltmez. Oturum kapanır; kişi
        // girişte "e-postanızı doğrulayın" okur. Başka 403 oturumu kapatmaz.
        const unverified = res.status === 403 && (await readErrorCode(res)) === 'EMAIL_NOT_VERIFIED';
        // Bu arada çıkış veya hesap değişimi olduysa yanıt yok sayılır: eski oturum geri gelmez.
        if (session.refreshToken !== sent) return 'revoked';
        if (res.status === 426) return 'upgrade';
        if (res.status === 401 || unverified) {
          await setTokens(null, null);
          logoutListeners.forEach((fn) => fn());
          return 'revoked';
        }
        // 429, 5xx: oturum duruyor. Sunucu toparlanınca yeniden denenir.
        if (!res.ok) return 'unavailable';
        const body = (await res.json()) as AuthResponse;
        // Gövde okunurken çıkış yapılmış olabilir: yeni jeton yazılsaydı çıkıştan sonra oturum geri gelirdi (hayalet oturum).
        if (session.refreshToken !== sent) return 'revoked';
        if (!body.accessToken) return 'unavailable';
        // Bellek yeni jetondadır; güvenli depoya yazılamadıysa (depolama dolu) bu istek yine geçer: hata 503 sayılmaz.
        await setTokens(body.accessToken, body.refreshToken ?? sent).catch((e) => console.warn('token persist', e));
        return 'ok';
      } catch {
        return 'unavailable';
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** Firmasız jetonda yenileme denemeleri arası. Jeton her yenilemede döner; firma gelmeyen oturum sürekli döndürülmez. */
export const ORG_RECOVERY_INTERVAL_MS = 60_000;

let orgRecoveryAt = 0;

/** Firmasız jetonu bir kez yeniler. Aralık dolmadıysa ağa çıkmaz. */
function refreshForOrg(): Promise<RefreshOutcome | 'throttled'> {
  const now = Date.now();
  if (now - orgRecoveryAt < ORG_RECOVERY_INTERVAL_MS) return Promise.resolve('throttled');
  orgRecoveryAt = now;
  return refreshTokens();
}

/**
 * Jeton firmasızsa (`org: null`) oturumu toparlamayı dener: askı kalkmış ya da davet başka cihazda kabul edilmiş olabilir.
 * Firma geldiyse kapsamı döner. Kapsam değişimini `onSessionChanged` dinleyenler de görür.
 */
export async function recoverOrgSession(): Promise<SessionScope | null> {
  const scope = currentSessionScope();
  if (scope || !hasSession()) return scope;
  await refreshForOrg();
  return currentSessionScope();
}

/** Yoldaki yenileme bitene kadar bekler. Firma değişimi yanıtını eski yanıt ezmesin. */
export async function settleRefresh(): Promise<void> {
  if (refreshing) await refreshing;
}

async function readError(res: Response): Promise<{ code: string; details: unknown }> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: string; details?: unknown } } | null;
    return { code: body?.error?.code ?? '', details: body?.error?.details };
  } catch {
    return { code: '', details: undefined };
  }
}

async function readErrorCode(res: Response): Promise<string> {
  return (await readError(res)).code;
}

/**
 * `403 NO_PRODUCT_ACCESS` + `details.refreshable: true` (auth-kit `productAuth.ts`): rol jetondan sonra verildi, ürün olayı henüz
 * işlemedi. Sözleşme (ARCHITECTURE §6) istemcinin bir kez sessizce yenilemesini ister (04-B11); web istemcisiyle aynı aralık.
 */
export const ACCESS_REFRESH_INTERVAL_MS = 30_000;

let accessRefreshAt = 0;

function isRefreshableDenial(status: number, code: string, details: unknown): boolean {
  return status === 403 && code === 'NO_PRODUCT_ACCESS' && (details as { refreshable?: unknown } | null | undefined)?.refreshable === true;
}

/** Giriş bilgisi hataları oturumla ilgili değildir: şifre yanlışsa yenileme denenmez. */
const NOT_A_SESSION_ERROR = new Set(['INVALID_CREDENTIALS', 'LOGIN_REQUIRED']);

/** Hesap servisine ulaşılamıyor: oturum kapanmaz, çağıran 503 görür. */
function authUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: { code: 'AUTH_UNAVAILABLE', message: i18n.t('auth:errors.AUTH_UNAVAILABLE') } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 401'de (TOKEN_STALE, TOKEN_EXPIRED, UNAUTHORIZED) ve `403 ORG_REQUIRED`te jetonu bir kez yeniler, isteği bir kez tekrarlar.
 * ORG_REQUIRED yetki aşamasında döner, istek işlenmemiştir; tekrar yalnız kişide firma varsa yapılır.
 * Kuyruk isteğinin `requireScope` denetimi tekrarda da çalışır: yenileme başka firma verirse kayıt çıkmaz.
 */
async function authedFetchOnce(path: string, init: FetchInit): Promise<Response> {
  // Çok parçalı yükleme (kuyruktaki fotoğraflı ölçüm) süresi dolmuş jetonla çıkmaz: 401 alıp fotoğrafları ikinci kez
  // yüklemek yerine önce yenilenir. Yenilenemezse yükleme hiç yapılmaz.
  if (init.form && init.auth !== false && session.refreshToken && accessLikelyExpired(Date.now())) {
    const outcome = await refreshTokens();
    if (outcome === 'upgrade') return upgradeResponse();
    if (outcome === 'unavailable') return authUnavailableResponse();
  }
  const used = session.accessToken;
  const res = await rawFetch(path, init);
  if (init.auth === false || (res.status !== 401 && res.status !== 403)) return res;
  const { code, details } = await readError(res);
  const needsOrg = res.status === 403 && code === 'ORG_REQUIRED';
  const refreshable = isRefreshableDenial(res.status, code, details);
  if (!needsOrg && !refreshable && (res.status !== 401 || NOT_A_SESSION_ERROR.has(code))) return res;
  if (refreshable) {
    // 30 sn'de en çok bir kez: rol gerçekten yoksa her istek jetonu döndürmesin. Tekrar da 403 alırsa çağırana döner.
    const now = Date.now();
    // Saat geri alındıysa (`now < accessRefreshAt`) aralık sayılmaz: yenileme uzun süre kilitlenmesin.
    if (session.accessToken === used && now >= accessRefreshAt && now - accessRefreshAt < ACCESS_REFRESH_INTERVAL_MS) return res;
    accessRefreshAt = now;
  }
  // Başka istek bu arada yenilediyse yeni jetonla tekrar etmek yeter.
  if (session.accessToken === used) {
    const outcome = needsOrg ? await refreshForOrg() : await refreshTokens();
    if (refreshable && outcome !== 'ok') return outcome === 'upgrade' ? upgradeResponse() : res;
    if (outcome === 'revoked' || outcome === 'throttled') return res;
    if (outcome === 'upgrade') return upgradeResponse();
    if (outcome === 'unavailable') return authUnavailableResponse();
  }
  if (needsOrg && !currentSessionScope()) return res;
  return rawFetch(path, init);
}

/** Kısa süreli yoğunlukta GET'in tek yeniden denemesinden önceki bekleme. */
export const BUSY_RETRY_MS = 1500;

/** 503 DB_UNAVAILABLE ve 503 AUTH_UNAVAILABLE geçicidir, oturumu etkilemez. */
async function isBusy(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const code = await readErrorCode(res);
  return code === 'DB_UNAVAILABLE' || code === 'AUTH_UNAVAILABLE';
}

/**
 * `fetch` gibi: `Response` döner, yalnız ağ hatasında atar. Hata gövdesini çağıran okur.
 * Yalnız GET meşgul yanıtında BİR kez tekrar denenir. POST/PATCH/PUT/DELETE ve çok parçalı yüklemeler ASLA otomatik
 * tekrarlanmaz (kuyruk kendi tekrarını yapar; clientId çift kaydı önler).
 */
async function authedFetch(path: string, init: FetchInit): Promise<Response> {
  const res = await authedFetchOnce(path, init);
  const isGet = (init.method ?? 'GET') === 'GET' && !init.form && init.json === undefined && init.body == null;
  if (!isGet || !(await isBusy(res))) return res;
  await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
  return authedFetchOnce(path, init);
}

/**
 * En düşük sürüm politikası (`GET /api/account/client-policy`): oturumsuz, girişten önce de çalışır, `POLICY_TIMEOUT_MS` zaman aşımı.
 * `version/policy.ts` `checkPolicy` ile kullanılır; ağ hatasında atar, politika durumu değişmez.
 */
export function fetchClientPolicy(): Promise<Response> {
  // Android'in HTTP önbelleği (OkHttp) yanıtı tutmasın: "Yeniden denetle" sunucunun son kararını görür.
  return rawFetch(`${ACCOUNT_ROOT}/client-policy`, { auth: false, timeoutMs: POLICY_TIMEOUT_MS, cache: 'no-store' });
}

/**
 * Sunucuya ulaşılıyor mu (KALANLAR 4.9, `queue/reach.ts`): DeciShip sağlık ucu (`GET /api/deciship/health`; ağ geçidinde hız
 * sınırı dışında, 426 denetiminden muaf). Oturumsuz, önbelleksiz, kısa zaman aşımı. Yalnız `{ ok: true }` ulaşıldı sayılır:
 * otel/depo Wi-Fi'ının karşılama sayfası ya da ağ geçidinin 502'si sayılmaz. Hata atmaz.
 */
export async function pingServer(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await rawFetch(`${productRoot('deciship')}/health`, { auth: false, timeoutMs, cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** `/api/account` + path. */
export function accountFetch(path: string, init: FetchInit = {}): Promise<Response> {
  return authedFetch(ACCOUNT_ROOT + path, init);
}

/** `/api/<ürün>` + path. */
export function productFetch(product: ProductKey, path: string, init: FetchInit = {}): Promise<Response> {
  return authedFetch(productRoot(product) + path, init);
}

/**
 * `retry-after` başlığı (saniye ya da HTTP tarihi) → ms. Okunamayan, geçmişteki ya da eksi değer `undefined`.
 * Üst sınırı çağıran koyar (kuyruk `schedule.ts` `RETRY_AFTER_CAP_MS`).
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at) || at <= now) return undefined;
  return at - now;
}

async function toError(res: Response): Promise<ApiError> {
  const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown }; message?: string; detail?: string };
    if (!body?.error && (body?.message || typeof body?.detail === 'string')) {
      return new ApiError(res.status, 'HTTP_' + res.status, (body.message ?? body.detail)!, undefined, retryAfterMs);
    }
    if (body?.error) {
      const message = body.error.message ?? i18n.t('auth:errors.HTTP', { status: res.status });
      return new ApiError(res.status, body.error.code ?? 'ERROR', message, body.error.details, retryAfterMs);
    }
  } catch {
    /* gövde JSON değil */
  }
  return new ApiError(res.status, 'HTTP_' + res.status, i18n.t('auth:errors.HTTP', { status: res.status }), undefined, retryAfterMs);
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** `accountFetch` + gövde okuma; başarısız yanıtta `ApiError` atar. */
export async function accountJson<T>(path: string, init: FetchInit = {}): Promise<T> {
  return readJson<T>(await accountFetch(path, init));
}

/** `productFetch` + gövde okuma; başarısız yanıtta `ApiError` atar. */
export async function productJson<T>(product: ProductKey, path: string, init: FetchInit = {}): Promise<T> {
  return readJson<T>(await productFetch(product, path, init));
}
