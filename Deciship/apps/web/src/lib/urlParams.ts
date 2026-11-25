/**
 * Adres çubuğundan gelen süzgeç değerleri. Kişi adresi elle yazabilir (`?tab=all`, `?page=-2`): bilinmeyen değer API'ye
 * gitmez (400, "Veriler yüklenemedi") ve ekranı çökertmez; bilinen değere büyük/küçük harf duyarsız eşlenir, yoksa varsayılan.
 */
export function enumParam<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T;
export function enumParam<T extends string>(raw: string | null, allowed: readonly T[], fallback: ''): T | '';
export function enumParam<T extends string>(raw: string | null, allowed: readonly T[], fallback: T | ''): T | '' {
  if (!raw) return fallback;
  const v = raw.trim().toUpperCase();
  return allowed.find((a) => a.toUpperCase() === v) ?? fallback;
}

/** Sayfa numarası: pozitif tam sayı, değilse 1. */
export function pageParam(raw: string | null): number {
  const n = Number(raw ?? 1);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
