// Sekme başlığı: "Sayfa · DeciShip". Shell sayfa adını (Faturalar), ayrıntı sayfası kendi başlığını (Fatura 123) verir;
// ayrıntı başlığı önceliklidir. Ayrıntı sayfasından çıkınca Shell'in adı geri yazılır: /invoices/123 → /invoices
// geçişinde Shell'in sayfa adı değişmediği için onun efekti yeniden çalışmaz, başlığı burası düzeltmeli.
let shellPage: string | null = null;
let detailTitle: string | null = null;
const listeners = new Set<() => void>();

function apply() {
  const p = detailTitle ?? shellPage;
  document.title = p ? `${p} · DeciShip` : 'DeciShip';
  listeners.forEach((fn) => fn());
}

/** Shell / hata sayfasının adı. */
export function setShellTitle(page: string | null | undefined) {
  shellPage = page || null;
  apply();
}

/** Ayrıntı sayfasının başlığı; null = ayrıntı sayfasından çıkıldı (Shell'in adı geri gelir). */
export function setDetailTitle(detail: string | null | undefined) {
  detailTitle = detail || null;
  apply();
}

/** Kabuk (AppShell) sekme başlığını kendisi de yazar; aynı değeri alsın diye `useSyncExternalStore` ile okunur. */
export const currentPageTitle = () => detailTitle ?? shellPage;
export function subscribePageTitle(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
