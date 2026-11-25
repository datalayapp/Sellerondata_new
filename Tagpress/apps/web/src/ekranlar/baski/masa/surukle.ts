import type { ShelfRow } from "../mantik/shelf.ts";

/**
 * Raftan sürüklenen satır. `dragover` sırasında `dataTransfer` okunamadığı için modül düzeyinde tutulur (eski masayla
 * aynı yol); raf `dragstart`'ta yazar, tuval bırakınca okur ve siler.
 */
export const shelfDrag: { current: ShelfRow | null } = { current: null };
export const SHELF_MIME = "application/x-etiket-raf";
