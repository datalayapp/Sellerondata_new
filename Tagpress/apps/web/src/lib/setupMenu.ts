import { useEffect } from "react";
import { useOrg } from "./features.ts";
import { isPlatform } from "./platform.ts";

/**
 * Menüdeki "Kurulum · Eksik" (DeciShip deseni, `Deciship/apps/web/src/lib/onboarding.ts`): firmanın kurulumu bitmemişse
 * (`GET /api/org` → `setup.status` `completed` değil; atlanan kurulum da `completed`) ve kişi kurulumu yapabiliyorsa
 * (`access.manage`; yerel kipte her zaman) menünün başında. Tanım sunucudadır; burada yalnız görünürlük.
 * Yanıt gelene kadar bu sekmede son bilinen değer okunur: öğe her açılışta bir an görünüp kaybolmaz (ya da tersi).
 */
const KEY = "tagpress.setup.pending";

/** Yerel kipin (tek firma) saklama anahtarı. */
export const LOCAL_ORG_KEY = "yerel";

export function setupPendingFrom(state: { status: string; manage: boolean } | undefined, lastKnown: boolean): boolean {
  if (!state) return lastKnown;
  return state.manage && state.status !== "completed";
}

export function readSetupPending(orgKey: string): boolean {
  try {
    return sessionStorage.getItem(KEY) === orgKey;
  } catch {
    return false;
  }
}

export function writeSetupPending(orgKey: string, pending: boolean): void {
  try {
    if (pending) sessionStorage.setItem(KEY, orgKey);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* depo kapalı olabilir (gizli pencere) */
  }
}

/** `orgKey` yoksa (oturum kapısı açılmadı) sorgu gitmez, öğe yok. */
export function useSetupPending(orgKey: string | null): boolean {
  const org = useOrg({ enabled: !!orgKey });
  const data = org.data;
  const status = data?.setup.status;
  const manage = data ? (isPlatform() ? (data.access?.manage ?? false) : true) : undefined;
  const state = status !== undefined && manage !== undefined ? { status, manage } : undefined;
  const pending = !!orgKey && setupPendingFrom(state, readSetupPending(orgKey));
  useEffect(() => {
    if (orgKey && status !== undefined && manage !== undefined) writeSetupPending(orgKey, setupPendingFrom({ status, manage }, false));
  }, [orgKey, status, manage]);
  return pending;
}
