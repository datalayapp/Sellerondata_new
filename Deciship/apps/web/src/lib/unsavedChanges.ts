import { dirtyFormCount } from '@sellerondata/shell/leave-rules';

// Sekme kapanış uyarısı ve "kişi zaten onayladı" durumu kabukta (`@sellerondata/shell/leave-rules`); `useLeaveGuard` de oradan.
// Paket kökü (.tsx içerir) yerine saf alt yol: `node --test` yükleyebilsin ve uygulamada durum tek kopya kalsın.
export { allowUnload, leaveDiscardingChanges, reloadDiscardingChanges } from '@sellerondata/shell/leave-rules';

/**
 * Yazılmış ama kaydedilmemiş alanlar. Modal ve sihirbaz formları `useUnsavedChangesPrompt` kullanmaz; hepsine dokunmak yerine
 * belge düzeyinde izlenir. Süzgeç ve arama yazıları iş kaybı değildir, sayılmaz. Başarılı kayıt listeyi temizler (`App.tsx`).
 */
const typedFields = new Set<HTMLElement>();
const IGNORED_FIELDS = '.search, .filters, [role="search"]';

function onFieldInput(e: Event) {
  const el = e.target as HTMLElement | null;
  if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest(IGNORED_FIELDS)) return;
  const type = (el as HTMLInputElement).type;
  if (type === 'file' || type === 'checkbox' || type === 'radio') return;
  typedFields.add(el);
}

/** Kabuk bir kez çağırır; dönen işlev dinlemeyi kaldırır. */
export function trackTypedFields(): () => void {
  document.addEventListener('input', onFieldInput, true);
  return () => document.removeEventListener('input', onFieldInput, true);
}

export function clearTypedFields() {
  typedFields.clear();
}

export function hasUnsavedChanges(): boolean {
  for (const el of typedFields) if (!el.isConnected) typedFields.delete(el);
  return dirtyFormCount() > 0 || typedFields.size > 0;
}

/** Ekranda sayı alanı var mı? Metni açık dille yazılmıştır: `1,234` TR'de 1,234 iken EN'de 1234 okunur. */
export function hasNumberField(): boolean {
  return !!document.querySelector('input.num, input[inputmode="decimal"], input[inputmode="numeric"]');
}

export type LocaleChangePlan = 'cancel' | 'switch' | 'switch-and-reload';

/**
 * Dil değişimi: sayı alanlarındaki metin eski dille yazılmış olabilir, sessizce yeniden yorumlatılmaz.
 *  - Kaydedilmemiş değişiklik varsa kişiye sorulur; hayır derse hiçbir şey değişmez.
 *  - Evet derse ya da ekranda sayı alanı varsa sayfa yeni dille baştan yüklenir, alanlar kayıtlı değerden gelir.
 */
export function planLocaleChange(s: { unsaved: boolean; numberField: boolean; confirm: () => boolean }): LocaleChangePlan {
  if (s.unsaved && !s.confirm()) return 'cancel';
  return s.unsaved || s.numberField ? 'switch-and-reload' : 'switch';
}
