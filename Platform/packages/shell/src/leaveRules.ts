// Sayfadan çıkış koruması: saf kurallar ve sekme kapanış uyarısının ortak durumu. React'e bağlı değil
// (DeciShip `web/test/*.test.ts` bunu `node --test` ile `@sellerondata/shell/leave-rules` yolundan yükler).
// Durum modül düzeyindedir: uygulamada tek kopya kalsın diye uygulamalar bu dosyayı paket yolundan alır, göreli yoldan değil.

/** Gezinti engellensin mi? Yalnız yol (pathname) değişimi sayılır; sorgu değişimi serbesttir. */
export function shouldBlockLeave(s: { dirty: boolean; released: boolean; from: string; to: string }): boolean {
  return s.dirty && !s.released && s.from !== s.to;
}

// Kişi yazdıklarının gideceğini zaten onayladı (güncelleme bandı "Yenile", dil ya da firma değişimi): tarayıcı ikinci kez sormaz.
let skipPrompt = false;
/** Şu an kaydedilmemiş değişiklik bildiren form sayısı. */
let dirtyForms = 0;

/**
 * Kaydedilmemiş değişiklik var: sekme kapanır ya da yenilenirken tarayıcı uyarır. Dönen işlev uyarıyı kaldırır.
 * `useUnsavedChangesPrompt` (LeaveGuard.tsx) bunu `dirty` doğruyken çağırır.
 */
export function holdUnload(): () => void {
  dirtyForms++;
  const h = (e: BeforeUnloadEvent) => {
    if (!skipPrompt) e.preventDefault();
  };
  window.addEventListener('beforeunload', h);
  return () => {
    dirtyForms--;
    window.removeEventListener('beforeunload', h);
  };
}

/** Kaydedilmemiş değişiklik bildiren form sayısı. */
export function dirtyFormCount(): number {
  return dirtyForms;
}

/** Sayfayı baştan yükleyen işlerde, kişi zaten onayladıysa tarayıcı ikinci kez sormaz; iş başarısız olursa geri alınır. */
export function allowUnload(on: boolean) {
  skipPrompt = on;
}

/** Kişi yazdıklarının gideceğini kabul etti: tarayıcı ikinci kez sormaz. */
export function leaveDiscardingChanges(href: string) {
  skipPrompt = true;
  window.location.replace(href);
}

/** Kişi yazdıklarının gideceğini kabul ettikten sonra yenile: tarayıcı ikinci kez sormaz. */
export function reloadDiscardingChanges() {
  skipPrompt = true;
  window.location.reload();
}
