/**
 * Üretim ekranına bırakılan dosyanın masaya geçişi: Üretim `setPendingImport(dosya)` deyip `#/uretim/ice-aktar`'a gider,
 * masa açılınca dosyayı bir kez alır (`takePendingImport`). Adres yalnız rota taşır; dosya bellekte kalır.
 */
let pending: File | null = null;

export function setPendingImport(file: File): void {
  pending = file;
}

export function takePendingImport(): File | null {
  const f = pending;
  pending = null;
  return f;
}
