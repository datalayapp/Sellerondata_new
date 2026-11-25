import { parseHash, type Query, type RouteId } from "../../lib/route.ts";

/**
 * Kaydet ya da Vazgeç'ten sonra dönülecek yer: `don` adresi (Üretim ve Baskı masası verir). Yoksa, Tezgâh adresi
 * değilse ya da yine Düzelt'i gösteriyorsa Üretim.
 */
export function backRoute(don: string | null | undefined): { id: RouteId; rest: string[]; query: Query } {
  const home = { id: "uretim" as const, rest: [], query: {} };
  if (!don || !don.startsWith("#/")) return home;
  const r = parseHash(don);
  if (r.id === "duzelt") return home;
  return { id: r.id, rest: r.rest, query: Object.fromEntries(r.query) };
}
