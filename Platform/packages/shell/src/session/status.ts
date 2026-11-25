/** Etkin firma başka sekmede değişti. `current`: şu anki firma; öğrenilemediyse null. */
export type OrgChange = {
  current: { id: string | null; name: string | null } | null;
  /** Bu sekmenin firmasındaki üyelik bitti ya da askıya alındı: "devam et" yalan olur. */
  ended?: boolean;
  /** Üyelik silinmedi, askıya alındı: metin "sona erdi" demez. */
  suspended?: boolean;
  /** Geçilebilecek etkin firmalar. */
  others?: { id: string; name: string }[];
};
export type SessionStatus = { offline: boolean; orgChange: OrgChange | null; /** 429: sistem yoğun, istek kendisi yeniden deneniyor. */ busy: boolean };

let state: SessionStatus = { offline: false, orgChange: null, busy: false };
const listeners = new Set<() => void>();

/**
 * Oturum istemcisinin ekrana söylemek istedikleri. Kabuk bu depoyu okur ve uyarıyı çizer; istemcinin React'e
 * bağımlılığı olmaz. `retry` ve `resumeOrg` istemci kurulurken bağlanır.
 */
export const sessionStatus = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  update(patch: Partial<SessionStatus>) {
    const next = { ...state, ...patch };
    if (next.offline === state.offline && next.orgChange === state.orgChange && next.busy === state.busy) return;
    state = next;
    listeners.forEach((fn) => fn());
  },
  /** Sunucuya yeniden ulaşmayı dener. Ulaşırsa true. */
  retry: async (): Promise<boolean> => false,
  /** Bu sekmenin firmasına geri döner, sayfa yenilenmez. Hata verirse atar. */
  resumeOrg: async (): Promise<void> => undefined,
  /** Başka firmaya geçer; sayfayı çağıran yeniler. */
  switchOrg: async (_orgId: string): Promise<void> => undefined,
};
