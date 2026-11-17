import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse as SessionMe, Permission } from '@sellerondata/contracts';
import { ME_QUERY_KEY, useMe as useSessionMe } from '@sellerondata/shell';
import { ApiError } from '../api/client';
import { auth } from '../api/endpoints';
import type { MeResponse } from '../api/types';
import { sessionLostState, subscribeSessionLost } from '../lib/sessionLost';
import { hasPermission, hasWebAccess, holdsPermission, productOf } from '../lib/permissions';
import { dropInactiveData, permissionLost, recheckAccess } from '../lib/accessCache';

const NO_PERMISSIONS: readonly string[] = [];

/**
 * Oturum kabuğun; burada iki kaynak birleşir:
 *  - `person`: Merkez `GET /api/account/me` (kişi, firmalar, etkin firma, izinler). Jeton tutmaz, çerezle gelir.
 *  - `me`: DeciShip `GET /api/deciship/me` (firmanın DeciShip ayarları ve kurulum durumu).
 *
 * Hesap kesikken `person` son bilinen kişidir (`useMe`): DeciShip verisi çalışmaya devam eder, kabuk "Bağlantı yok" der.
 * Firma başka sekmede değişirse bu sekme kendi firmasında kalır, kabuk uyarır ve yazmalar reddedilir (`SessionBanner`, ORG_MISMATCH).
 *
 * offline: oturum kapanmadı ama gösterilecek veri yok. no-org: etkin firma yok. no-access: bu firmada DeciShip web izni yok.
 */
type Status = 'loading' | 'authed' | 'anon' | 'offline' | 'no-org' | 'no-access';

interface AuthState {
  status: Status;
  person: SessionMe | null;
  me: MeResponse | null;
  refreshMe: () => Promise<void>;
  retry: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export const PRODUCT_ME_KEY = ['deciship', 'me'] as const;

/** Oturum sorguları: kişi ve firmanın DeciShip kaydı. Sayfa verisi değildir. */
export const isSessionQuery = (key: readonly unknown[]) => key[0] === ME_QUERY_KEY[0] || (key[0] === PRODUCT_ME_KEY[0] && key[1] === PRODUCT_ME_KEY[1]);

/** Hesap'a sorar: gezinmede (`navKey` değişince, aynı sayfaya tıklama dahil) ve sekmeye dönüşte. Router içinde çağrılır. */
export function useAccessRecheck(navKey: string) {
  const qc = useQueryClient();
  useEffect(() => {
    recheckAccess(qc, ME_QUERY_KEY);
  }, [qc, navKey]);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      recheckAccess(qc, ME_QUERY_KEY);
      // Firma ülkesi Merkez'de başka sekmede değişmiş olabilir: ürün ayarı da (TTK etiketi buna bağlı) yenilensin
      const productKey = qc.getQueryCache().find({ queryKey: PRODUCT_ME_KEY })?.queryKey;
      if (productKey) recheckAccess(qc, productKey);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [qc]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useSessionMe();
  // Oturum sona erdi ama kişinin kaydedilmemiş yazısı var: karar verene kadar sayfa ve form yerinde kalır.
  const lost = useSyncExternalStore(subscribeSessionLost, sessionLostState) !== 'none';
  const lastPerson = useRef(session.me);
  if (session.me) lastPerson.current = session.me;
  const person = session.me ?? (lost ? lastPerson.current : null);
  const activeOrgId = person?.activeOrg?.id ?? null;
  const webAccess = hasWebAccess(person);

  const product = useQuery({
    queryKey: [...PRODUCT_ME_KEY, activeOrgId],
    queryFn: async () => {
      try {
        return await auth.me();
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'NO_PRODUCT_ACCESS') throw e;
        // Rol az önce değişmiş olabilir: kişiyi bir kez sessizce yenile, bir kez daha dene. Yine reddederse sonuç kesindir.
        await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
        return await auth.me();
      }
    },
    enabled: !!activeOrgId && webAccess,
    meta: { silent: true },
  });

  const refreshProduct = product.refetch;
  const refreshMe = useCallback(async () => {
    await refreshProduct();
  }, [refreshProduct]);

  const refreshSession = session.refetch;
  const retry = useCallback(async () => {
    await refreshSession();
    await qc.invalidateQueries({ queryKey: PRODUCT_ME_KEY });
  }, [refreshSession, qc]);

  const status = useMemo<Status>(() => {
    if (!person) {
      if (session.isError) return 'offline';
      return session.isPending ? 'loading' : 'anon';
    }
    if (!person.activeOrg) return 'no-org';
    if (!webAccess) return 'no-access';
    const err = product.error;
    if (err instanceof ApiError) {
      if (err.code === 'ORG_REQUIRED') return 'no-org';
      if (err.code === 'NO_PRODUCT_ACCESS') return 'no-access';
    }
    if (product.data) return 'authed';
    return err && !(err instanceof ApiError && err.status === 401) ? 'offline' : 'loading';
  }, [person, session.isError, session.isPending, webAccess, product.data, product.error]);

  // Etki, sayfa ayrıldıktan sonra çalışır: az önce kapanan sayfanın verisi de atılır. Rol geri gelince taze okunur.
  const permissions = productOf(person)?.permissions ?? NO_PERMISSIONS;
  const lastPermissions = useRef<readonly string[]>(permissions);
  useEffect(() => {
    const lost = permissionLost(lastPermissions.current, permissions);
    lastPermissions.current = permissions;
    if (lost || status === 'no-access') dropInactiveData(qc, isSessionQuery);
  }, [qc, permissions, status]);

  const value = useMemo<AuthState>(
    () => ({ status, person, me: product.data ?? null, refreshMe, retry }),
    [status, person, product.data, refreshMe, retry],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}

/** Firmanın DeciShip tarafı. Firma adı Merkez'den gelir: ad değişimi tek yerden görünür. */
export function useProductMe(): MeResponse {
  const { me, person } = useAuth();
  if (!me) throw new Error('not authenticated');
  const name = person?.activeOrg?.name ?? me.company.name;
  return name === me.company.name ? me : { ...me, company: { ...me.company, name } };
}

/** Kod rol adına değil izne bakar (`deciship.invoices.upload` gibi). Abonelik salt okunursa yazma izinleri kapalıdır. */
export function usePermission(permission: Permission): boolean {
  const { person } = useAuth();
  return hasPermission(person, permission);
}

/** Rol bu izni veriyor mu (abonelikten bağımsız): kayda giden bağlantılar. */
export function useHoldsPermission(permission: Permission): boolean {
  const { person } = useAuth();
  return holdsPermission(person, permission);
}
