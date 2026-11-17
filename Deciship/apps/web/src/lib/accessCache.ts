import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Rol kapanınca açık sekmeye bildirim gelmez. Ürün API'si eski jetonu, Hesap'tan olay gelene dek (en az bir dağıtım turu) kabul eder;
 * sayfa önbelleği de 30 saniye istek atmadan çizer. Kesin bilgi Hesap'ın `/me` yanıtındadır: gezinmede ve sekmeye dönüşte sorulur.
 */
export const ACCESS_RECHECK_GAP_MS = 5_000;

/** `/me` son yanıtı bu aralıktan eskiyse yeniden ister. Süren istek kesilmez, oturum yoksa sorulmaz. true: istek başladı. */
export function recheckAccess(qc: QueryClient, meKey: QueryKey, now = Date.now()): boolean {
  const state = qc.getQueryState(meKey);
  if (!state?.data || state.fetchStatus !== 'idle' || now - state.dataUpdatedAt < ACCESS_RECHECK_GAP_MS) return false;
  void qc.invalidateQueries({ queryKey: meKey }, { cancelRefetch: false });
  return true;
}

export const permissionLost = (before: readonly string[], after: readonly string[]) => before.some((p) => !after.includes(p));

/**
 * Yetki azaldı: artık ekranda olmayan sayfa verisi atılır, geri dönüşte önbellekten çizilmez. Oturum sorguları kalır.
 * Açık sayfanın verisine dokunulmaz: o sayfa hâlâ izinliyse yeniden okuma yarım kalmış formun üzerine yazardı.
 */
export function dropInactiveData(qc: QueryClient, isSession: (key: QueryKey) => boolean) {
  qc.removeQueries({ predicate: (q) => !isSession(q.queryKey) && q.getObserversCount() === 0 });
}
