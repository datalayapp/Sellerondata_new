import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { AuthResponse, JoinPreview, Locale, MeResponse } from '@sellerondata/contracts';
import { Api, type BoxPreset, type CompanySettings } from '../api/endpoints';
import { EDGE_WARN_CM, plausibilityLimits, WEIGHT_WARN_KG } from '../lib/plausibility';
import {
  accountJson,
  ApiError,
  applyAuthResponse,
  currentPersonId,
  currentSessionScope,
  currentSessionSignature,
  hasSession,
  loadSession,
  onForcedLogout,
  onSessionChanged,
  setServerUrl,
  settleRefresh,
  signOut,
  signOutCount,
} from '../api/client';
import { serverCandidates } from '../api/serverUrl';
import { hubCacheGuard } from '../hub/sessionGuard';
import { clearHubCache } from '../hub/store';
import { i18n, setLocale } from '../i18n';
import { setFormatTimeZone } from '../lib/format';
import { measurementCache } from '../lib/measurementCache';
import { kvDelete, kvGet, kvSet } from '../queue/db';
import { activeOrgs, decishipAccess, tabsFor, withoutClosedOrgs, type TabsVisibility, type ToolAccess } from './access';
import { normalizeIdentifierInput, normalizeJoinCodeInput } from './errors';
import { createLocaleSync, isPermanentLocaleError, type LocaleSyncResult } from './localeSync';
import { sameScope, scopeKey, type SessionScope } from './token';

type Status = 'loading' | 'signedOut' | 'signedIn';

export type JoinAcceptInput = { phone: string; code: string; name?: string; password: string };

type AuthState = {
  status: Status;
  /** Oturum sunucu tarafından düşürüldü (süre doldu / geçersiz); giriş ekranı nedenini söyler. */
  expired: boolean;
  me: MeResponse | null;
  /** Etkin kişi + firma. Kuyruk, önbellek ve taslak buna bağlıdır. Firması yoksa null. */
  scope: SessionScope | null;
  /** Girişten sonra firma seçilmeli, ya da etkin firma yok. */
  needsOrgChoice: boolean;
  /** Profil hiç okunamadı ve önbellekte yok. */
  profileFailed: boolean;
  access: ToolAccess;
  tabs: TabsVisibility;
  settings: CompanySettings;
  presets: BoxPreset[];
  login: (serverUrl: string, identifier: string, password: string) => Promise<void>;
  joinPreview: (serverUrl: string, phone: string, code: string) => Promise<JoinPreview>;
  joinAccept: (input: JoinAcceptInput) => Promise<void>;
  /** Yeni profili döner; zaten etkinse null. */
  switchOrg: (orgId: string) => Promise<MeResponse | null>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Dil seçimi: hemen uygulanır, kişi ayarına yazılır; çevrimdışıysa bağlantı gelince. */
  changeLocale: (locale: Locale) => Promise<LocaleSyncResult>;
  /** Seçilen dil henüz sunucuya yazılmadı. */
  localePending: boolean;
};

const DEFAULT_SETTINGS: CompanySettings = { desiDivisor: 3000, requiredBoxPhotos: 1, warnEdgeCm: EDGE_WARN_CM, warnWeightKg: WEIGHT_WARN_KG, scaleAiRead: false };
const DEFAULT_PRESETS: BoxPreset[] = [];
const FOREGROUND_REFRESH_MS = 60_000;

/** Kişiye bağlı önbellek. Çıkışta silinir. */
const K_ME = 'session:me';
/** Firmaya bağlı önbellek. Firma değişince başkasının ayarı ve kolisi görünmez. */
const kSettings = (key: string) => `settings:${key}`;
const kPresets = (key: string) => `presets:${key}`;

const kLocale = (personId: string) => `locale:pending:${personId}`;

const localeSync = createLocaleSync({
  read: (personId) => kvGet<Locale>(kLocale(personId)),
  write: (personId, locale) => (locale ? kvSet(kLocale(personId), locale) : kvDelete(kLocale(personId))),
  // Yanıttaki jeton kullanılmaz: dil yetkiyi etkilemez, istemci dili Accept-Language ile söyler. Firma değişimiyle yarışmaz.
  // `requirePerson`: 401 tekrarı başka kişinin jetonuyla gidip onun dilini değiştirmesin.
  send: (locale) => accountJson('/me', { method: 'PATCH', json: { locale }, timeoutMs: 8000, requirePerson: currentPersonId() ?? undefined }),
  currentPerson: currentPersonId,
  isPermanent: isPermanentLocaleError,
  // Çevrimdışı açılışta önbellekteki eski dil geri gelmesin.
  onSynced: async (personId, locale) => {
    const cached = await kvGet<MeResponse>(K_ME);
    if (cached?.person.id === personId) await kvSet(K_ME, { ...cached, person: { ...cached.person, locale } });
  },
});

const AuthCtx = createContext<AuthState | null>(null);

function scopeOfMe(me: MeResponse | null): SessionScope | null {
  return me?.activeOrg ? { personId: me.person.id, orgId: me.activeOrg.id } : null;
}

function normalizeSettings(s: Partial<CompanySettings> | null | undefined): CompanySettings {
  // Uyarı eşikleri gelmediyse (eski sunucu ya da önbellekteki eski ayar) bugünkü sabitler.
  const limits = plausibilityLimits(s);
  return {
    desiDivisor: Number(s?.desiDivisor) > 0 ? Number(s?.desiDivisor) : DEFAULT_SETTINGS.desiDivisor,
    requiredBoxPhotos: Number.isFinite(Number(s?.requiredBoxPhotos)) && s?.requiredBoxPhotos != null ? Number(s.requiredBoxPhotos) : DEFAULT_SETTINGS.requiredBoxPhotos,
    warnEdgeCm: limits.edgeCm,
    warnWeightKg: limits.weightKg,
    // Tartı okuması yalnız sunucu açıkça açık derse (eski sunucu ya da eski önbellek: kapalı, ağırlık elle).
    scaleAiRead: s?.scaleAiRead === true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [expired, setExpired] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [scope, setScope] = useState<SessionScope | null>(null);
  const [chooseOrg, setChooseOrg] = useState(false);
  const [profileFailed, setProfileFailed] = useState(false);
  const [settings, setSettings] = useState<CompanySettings>(DEFAULT_SETTINGS);
  const [presets, setPresets] = useState<BoxPreset[]>(DEFAULT_PRESETS);
  const [localePending, setLocalePending] = useState(false);
  const signature = useRef('');
  /** Oturum yanıtı işlenirken profil zaten elimizde: jeton olayı ikinci kez okutmasın. */
  const adopting = useRef(false);
  const lastRefresh = useRef(0);
  /** Dil seçimi sayacı: seçimden önce başlamış profil okuması eski dili geri getirmesin. */
  const localeChanges = useRef(0);
  // Firma saat dilimi biçimlemeye (11-B7). Çizim sırasında: çocuklar aynı çizimde "bugün"ü firmanın gününe göre
  // hesaplasın (etki bir çizim geç kalırdı). Aynı değeri yeniden yazmak zararsız; yoksa telefonun saati.
  setFormatTimeZone(me?.activeOrg?.timeZone);

  /** Bekleyen seçimi gönderir. Sonuç başarılıysa ekrandaki profil de yeni dili bilir. */
  const syncLocale = useCallback(async (personId: string, run: () => Promise<LocaleSyncResult>) => {
    const result = await run().catch((): LocaleSyncResult => 'pending');
    setLocalePending(result === 'pending');
    if (result === 'synced') {
      const locale = (await kvGet<MeResponse>(K_ME))?.person.locale;
      if (locale) setMe((cur) => (cur?.person.id === personId ? { ...cur, person: { ...cur.person, locale } } : cur));
    }
    return result;
  }, []);

  const adoptMe = useCallback(
    async (fetched: MeResponse) => {
      const m = withoutClosedOrgs(fetched);
      setMe(m);
      setProfileFailed(false);
      setLocale(await localeSync.effective(m.person.id, m.person.locale));
      await kvSet(K_ME, m);
      void syncLocale(m.person.id, () => localeSync.flush(m.person.id));
    },
    [syncLocale],
  );

  const changeLocale = useCallback(
    async (locale: Locale): Promise<LocaleSyncResult> => {
      const personId = currentPersonId();
      const serverLocale = me?.person.locale;
      localeChanges.current += 1;
      void setLocale(locale);
      if (!personId) return 'none';
      setLocalePending(true);
      const result = await syncLocale(personId, () => localeSync.choose(personId, locale));
      if (result === 'rejected' && serverLocale) void setLocale(serverLocale);
      return result;
    },
    [me, syncLocale],
  );

  /** Firmaya bağlı ayar ve koliler: önce önbellek, sonra sunucu. Oturum bu arada değiştiyse sonuç atılır. */
  const loadToolData = useCallback(async (m: MeResponse) => {
    const sc = scopeOfMe(m);
    const key = scopeKey(sc);
    if (!key || !decishipAccess(m).canUse) {
      setSettings(DEFAULT_SETTINGS);
      setPresets(DEFAULT_PRESETS);
      return;
    }
    const stillCurrent = () => scopeKey(currentSessionScope()) === key;
    const [cachedSettings, cachedPresets] = await Promise.all([kvGet<CompanySettings>(kSettings(key)), kvGet<BoxPreset[]>(kPresets(key))]);
    if (!stillCurrent()) return;
    setSettings(normalizeSettings(cachedSettings));
    setPresets(cachedPresets ?? DEFAULT_PRESETS);
    await Promise.all([
      Api.companySettings()
        .then(async (s) => {
          if (!stillCurrent()) return;
          const next = normalizeSettings(s);
          setSettings(next);
          await kvSet(kSettings(key), next);
        })
        .catch(() => undefined /* çevrimdışı: önbellek kullanılır */),
      Api.boxPresets()
        .then(async (p) => {
          if (!stillCurrent()) return;
          setPresets(p);
          await kvSet(kPresets(key), p);
        })
        .catch(() => undefined /* çevrimdışı: önbellek kullanılır */),
    ]);
  }, []);

  const refreshProfile = useCallback(async () => {
    lastRefresh.current = Date.now();
    const changesAtStart = localeChanges.current;
    // Okuma sürerken kişi çıkıp başka hesapla girdiyse yanıt öncekinindir: yeni oturuma yazılmaz, hata da gösterilmez.
    const signOutsAtStart = signOutCount();
    const stale = () => !hasSession() || signOutCount() !== signOutsAtStart;
    try {
      const fetched = await accountJson<MeResponse>('/me');
      if (stale() || fetched.person.id !== currentPersonId()) return;
      const m: MeResponse =
        changesAtStart === localeChanges.current ? fetched : { ...fetched, person: { ...fetched.person, locale: i18n.language === 'en' ? 'en' : 'tr' } };
      await adoptMe(m);
      await loadToolData(m);
    } catch (e) {
      if (stale()) return;
      if (!(e instanceof ApiError) || !e.isNetwork) console.warn('me', e);
      setProfileFailed(true);
    }
  }, [adoptMe, loadToolData]);

  useEffect(() => {
    const offSession = onSessionChanged(() => {
      hubCacheGuard.onChange();
      const next = currentSessionScope();
      setScope((prev) => (sameScope(prev, next) || (!prev && !next) ? prev : next));
      const sig = currentSessionSignature();
      if (sig === signature.current) return;
      signature.current = sig;
      // Yenilemede firma veya yetki değişmiş olabilir (üyelik bitti, rol değişti): profil yeniden okunur.
      if (!adopting.current && hasSession()) void refreshProfile();
    });
    const offLogout = onForcedLogout(() => {
      setExpired(true);
      setMe(null);
      setChooseOrg(false);
      setProfileFailed(false);
      setStatus('signedOut');
      void kvDelete(K_ME);
      void clearHubCache();
    });
    (async () => {
      adopting.current = true;
      await loadSession();
      adopting.current = false;
      hubCacheGuard.arm();
      signature.current = currentSessionSignature();
      const sc = currentSessionScope();
      setScope(sc);
      if (!hasSession()) {
        setStatus('signedOut');
        return;
      }
      // Önbellekteki profil yalnız elimizdeki jetonun sahibine aitse kullanılır.
      const cached = await kvGet<MeResponse>(K_ME);
      const usable = cached && (sc ? sameScope(scopeOfMe(cached), sc) : !cached.activeOrg);
      if (usable) {
        setMe(cached);
        setLocale(await localeSync.effective(cached.person.id, cached.person.locale));
        const key = scopeKey(sc);
        if (key) {
          const [cs, cp] = await Promise.all([kvGet<CompanySettings>(kSettings(key)), kvGet<BoxPreset[]>(kPresets(key))]);
          setSettings(normalizeSettings(cs));
          if (cp) setPresets(cp);
        }
      }
      setStatus('signedIn');
      void refreshProfile();
    })();
    const appSub = AppState.addEventListener('change', (st) => {
      // Yetki ve abonelik değişimi uygulama açıkken de gelir. Çevrimdışıyken önbellek kalır.
      if (st === 'active' && hasSession() && Date.now() - lastRefresh.current > FOREGROUND_REFRESH_MS) void refreshProfile();
    });
    // Çevrimdışı seçilen dil bağlantı gelince yazılır.
    let wasOnline = true;
    const offNet = NetInfo.addEventListener((s) => {
      const online = !!s.isConnected && s.isInternetReachable !== false;
      const person = currentPersonId();
      if (online && !wasOnline && person) void syncLocale(person, () => localeSync.flush(person));
      wasOnline = online;
    });
    return () => {
      offSession();
      offLogout();
      appSub.remove();
      offNet();
    };
  }, [refreshProfile, syncLocale]);

  // Bellekteki ölçümler firmaya aittir.
  const sessionKey = scopeKey(scope);
  useEffect(() => {
    measurementCache.clear();
  }, [sessionKey]);

  const completeSession = useCallback(
    async (res: AuthResponse, options: { offerOrgChoice: boolean }): Promise<MeResponse> => {
      adopting.current = true;
      try {
        await applyAuthResponse(res);
        signature.current = currentSessionSignature();
        const m = res.me ?? (await accountJson<MeResponse>('/me'));
        await adoptMe(m);
        await loadToolData(m);
        setExpired(false);
        setChooseOrg(options.offerOrgChoice && activeOrgs(m).length > 1);
        setStatus('signedIn');
        return m;
      } finally {
        adopting.current = false;
      }
    },
    [adoptMe, loadToolData],
  );

  /** Yerel adreslerden biri girildiyse ve ulaşılamıyorsa diğerleri sırayla denenir. Çalışan adres kaydedilir. */
  const withServerFallback = useCallback(async <T,>(serverUrl: string, run: () => Promise<T>): Promise<T> => {
    const candidates = serverCandidates(serverUrl);
    let lastErr: unknown;
    for (const url of candidates) {
      await setServerUrl(url);
      try {
        return await run();
      } catch (e) {
        lastErr = e;
        const unreachable = e instanceof ApiError && (e.isNetwork || e.code === 'TIMEOUT');
        if (!unreachable) break;
      }
    }
    if (lastErr instanceof ApiError && (lastErr.isNetwork || lastErr.code === 'TIMEOUT')) await setServerUrl(candidates[0]!);
    throw lastErr;
  }, []);

  const login = useCallback(
    async (serverUrl: string, identifier: string, password: string) => {
      const res = await withServerFallback(serverUrl, () =>
        accountJson<AuthResponse>('/auth/login', {
          method: 'POST',
          json: { identifier: normalizeIdentifierInput(identifier), password, client: 'mobile' },
          auth: false,
        }),
      );
      await completeSession(res, { offerOrgChoice: true });
    },
    [completeSession, withServerFallback],
  );

  const joinPreview = useCallback(
    (serverUrl: string, phone: string, code: string) =>
      withServerFallback(serverUrl, () =>
        accountJson<JoinPreview>('/auth/join/preview', { method: 'POST', json: { phone: phone.trim(), code: normalizeJoinCodeInput(code) }, auth: false }),
      ),
    [withServerFallback],
  );

  const joinAccept = useCallback(
    async (input: JoinAcceptInput) => {
      const res = await accountJson<AuthResponse>('/auth/join/accept', {
        method: 'POST',
        json: {
          phone: input.phone.trim(),
          code: normalizeJoinCodeInput(input.code),
          ...(input.name?.trim() ? { name: input.name.trim() } : {}),
          password: input.password,
          client: 'mobile',
        },
        auth: false,
      });
      // Katıldığı firma etkin gelir: seçim sorulmaz.
      await completeSession(res, { offerOrgChoice: false });
    },
    [completeSession],
  );

  const switchOrg = useCallback(
    async (orgId: string) => {
      if (currentSessionScope()?.orgId === orgId) {
        setChooseOrg(false);
        return null;
      }
      await settleRefresh();
      const signOuts = signOutCount();
      const res = await accountJson<AuthResponse>('/auth/switch-org', { method: 'POST', json: { orgId } });
      // Yanıt gelene dek kişi çıktıysa yeni jeton yazılmaz: çıkılmış oturum geri gelmez.
      if (signOutCount() !== signOuts) return null;
      return completeSession(res, { offerOrgChoice: false });
    },
    [completeSession],
  );

  const logout = useCallback(async () => {
    // Jetonlar telefondan hemen silinir; sunucuya bildirim beklenmez (`signOut`). Kuyruğa dokunulmaz: kayıtlar sahibinin girişini bekler.
    await signOut();
    // Kendi isteğiyle çıktı: giriş ekranı "Oturum sona erdi" demez.
    setExpired(false);
    await kvDelete(K_ME);
    // Sonraki kişi çevrimdışı bile önceki kişinin Merkez verisini görmesin.
    await clearHubCache();
    setMe(null);
    setChooseOrg(false);
    setProfileFailed(false);
    setLocalePending(false);
    setStatus('signedOut');
  }, []);

  const access = useMemo(() => decishipAccess(me), [me]);
  const tabs = useMemo(() => tabsFor(me), [me]);
  const needsOrgChoice = status === 'signedIn' && (chooseOrg || (me !== null && me.activeOrg === null));

  const value = useMemo(
    () => ({
      status,
      expired,
      me,
      scope,
      needsOrgChoice,
      profileFailed,
      access,
      tabs,
      settings,
      presets,
      login,
      joinPreview,
      joinAccept,
      switchOrg,
      logout,
      refreshProfile,
      changeLocale,
      localePending,
    }),
    [status, expired, me, scope, needsOrgChoice, profileFailed, access, tabs, settings, presets, login, joinPreview, joinAccept, switchOrg, logout, refreshProfile, changeLocale, localePending],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('AuthProvider eksik');
  return v;
}
