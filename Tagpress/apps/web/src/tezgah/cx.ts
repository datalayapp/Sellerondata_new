/** Sınıf adlarını birleştirir (yanlış değerler atlanır). Tezgâh clsx'e bağlı değil. */
export function cx(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(" ");
}
