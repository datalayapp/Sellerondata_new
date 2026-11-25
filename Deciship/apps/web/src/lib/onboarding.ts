/**
 * İlk kurulum yönlendirmesi: kurulum gerekiyorsa (`me.onboarding.required`) Pano bir oturumda yalnız bir kez
 * /setup'a yönlendirir; kullanıcı menüden çıkarsa tekrar zorlanmaz. Girişte ve "Sistemi sıfırla"da işaret silinir.
 */
const KEY = 'deciship.kurulum.yonlendirildi';

export function onboardingRedirected(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markOnboardingRedirected(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* gizli sekme vb.: yönlendirme yine bir kez olur (bellekte) */
  }
}

export function clearOnboardingRedirect(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* yok say */
  }
}

/**
 * Menüdeki "Kurulum" etiketi. Tanım API'dedir (`me.onboarding.completed`): burada kural yok.
 * Yanıt gelene kadar son bilinen değer: etiket her açılışta yanıp sönmesin.
 */
export function isSetupPending(canManage: boolean, onboarding: { completed: boolean } | undefined, lastKnown: boolean): boolean {
  if (!canManage) return false;
  return onboarding ? !onboarding.completed : lastKnown;
}
