import { loginHref } from './base';
import { hasUnsavedChanges, leaveDiscardingChanges } from './unsavedChanges';

let leavingForLogin = false;
/** Kişi kararını verdi ya da kaybedecek yazısı yok: girişe gider. Tek yönlendirme (bkz. `goToLogin`). */
export function leaveForLogin(): void {
  if (leavingForLogin) return;
  leavingForLogin = true;
  leaveDiscardingChanges(loginHref(window.location.pathname, window.location.search));
}

type SessionLost = 'none' | 'ask' | 'stayed';
let sessionLost: SessionLost = 'none';
const sessionLostListeners = new Set<() => void>();
export const sessionLostState = () => sessionLost;
export function subscribeSessionLost(cb: () => void) {
  sessionLostListeners.add(cb);
  return () => sessionLostListeners.delete(cb);
}
export function setSessionLost(next: SessionLost) {
  sessionLost = next;
  sessionLostListeners.forEach((cb) => cb());
}

/**
 * Oturum yok. İstek katmanı ve kabuk aynı anda fark eder; ikinci yönlendirme birincisini iptal ederse başlamış görünüm geçişi
 * "Transition was skipped" hatasıyla düşer: yönlendirme tektir. Kaydedilmemiş yazı varsa sessizce gidilmez, kişiye sorulur.
 */
export function goToLogin(): void {
  if (sessionLost !== 'none') return;
  if (hasUnsavedChanges()) setSessionLost('ask');
  else leaveForLogin();
}
