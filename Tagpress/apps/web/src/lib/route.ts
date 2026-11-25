import { useCallback, useEffect, useState } from "react";

/**
 * Karma (hash) yönlendirme: `#/uretim`, `#/uretim/ice-aktar`, `#/tasarim-dili/kurallar`, `#/sablonlar/a15`, `#/baski/masa`, `#/ayarlar`.
 * Sorgu: `#/uretim?parti=…&is=…`. Yenilemede yer korunur. Menü adları sözlükte (`frame:nav.*`).
 */
export type Tab = "uretim" | "tasarim-dili" | "sablonlar" | "baski" | "ayarlar";
export const TABS: Array<{ id: Tab; key: string }> = [
  { id: "uretim", key: "1" },
  { id: "tasarim-dili", key: "2" },
  { id: "sablonlar", key: "3" },
  // Baskı masası (sayfa düzeni ve çıktı): eski kısayollar değişmesin diye Alt+5; Ayarlar sonda kalır.
  { id: "baski", key: "5" },
  { id: "ayarlar", key: "4" },
];

/** Tezgâh rota kimliği: beş menü sekmesi + tam ekran Düzelt, Kurulum ve geliştirmedeki bileşen vitrini. */
export type RouteId = Tab | "duzelt" | "kurulum" | "vitrin";
const ROUTE_IDS: readonly RouteId[] = [...TABS.map((t) => t.id), "duzelt", "kurulum", "vitrin"];

export type Query = Record<string, string | null | undefined>;

export interface AppRoute {
  id: RouteId;
  /** Rota kimliğinden sonraki parçalar (ör. `#/baski/masa/abc` → ["masa", "abc"]). */
  rest: string[];
  query: URLSearchParams;
}

export type Go = (id: RouteId, rest?: string[], query?: Query, replace?: boolean) => void;

/** Her Tezgâh ekranının (`src/ekranlar/<ekran>/index.tsx`) aldığı özellikler. */
export interface EkranProps {
  route: AppRoute;
  go: Go;
}

/**
 * Karma adresi çözer. Bilinmeyen adres Üretim'e düşer. Eski bağlantılar: `#/uretim/karsilastir?is=` → `#/uretim?is=`.
 */
export function parseHash(hash: string): AppRoute {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart = "", q = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const first = parts[0] as RouteId | undefined;
  const known = !!first && ROUTE_IDS.includes(first);
  const id: RouteId = known ? first : "uretim";
  let rest = known ? parts.slice(1) : [];
  if (id === "uretim" && rest[0] === "karsilastir") rest = rest.slice(1);
  return { id, rest, query: new URLSearchParams(q) };
}

export function routeHash(id: RouteId, rest: string[] = [], query?: Query): string {
  const sp = new URLSearchParams();
  if (query) for (const [k, v] of Object.entries(query)) if (v) sp.set(k, v);
  const qs = sp.toString();
  return `#/${[id, ...rest].map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}`;
}

/**
 * Üst menüde etkin sekme. Düzelt kendi sekmesi değildir: `don` (geri dönülecek adres) hangi sekmedeyse o; yoksa Üretim.
 * Kurulum ve vitrinde etkin sekme yok.
 */
export function activeTab(route: AppRoute): Tab | null {
  if (route.id === "duzelt") {
    const back = route.query.get("don");
    const tab = back ? parseHash(back).id : "uretim";
    return TABS.some((t) => t.id === tab) ? (tab as Tab) : "uretim";
  }
  if (route.id === "kurulum" || route.id === "vitrin") return null;
  return route.id;
}

/**
 * Ekran türü (yerleşimin tek kaynağı; ARAYUZ-PLANI "Yerleşim"): `work` çalışma ekranı, kenardan kenara (tuval, paneller);
 * `column` form ve liste ekranı, Merkez ve DeciShip'in sütununda (en çok 1240 px, kenar 32, telefonda 16; ortada).
 * Platformda kabuğa `AppShell column` olarak, yerelde çerçeveye (`AppFrame`) gider; telefonda çalışma ekranı yerine not çıkar.
 */
export type ScreenKind = "work" | "column";

/** Tasarım dili bölümlerinden telefona sığmayanlar (sütunda durur ama telefonda not gösterir: `phoneNote`). */
const WIDE_DESIGN_SECTIONS = new Set(["kurallar", "dene", "olustur"]);

export function screenKind(route: AppRoute): ScreenKind {
  const [first, second] = route.rest;
  switch (route.id) {
    case "ayarlar":
    case "kurulum":
      return "column";
    case "tasarim-dili":
      // Bütün bölümler sütunda (sahip kararı 2026-11-22: Kurallar, Dene, Oluştur da ortalı).
      return "column";
    case "sablonlar":
      // Anahtarsız adres kütüphane ızgarası (liste), anahtarlı adres düzenleyici.
      return first ? "work" : "column";
    case "baski":
      if (first === "arsiv") return "column";
      if (first === "sablonlar") return second ? "work" : "column";
      return "work";
    case "uretim":
      // Üretim kartlı liste, sağ panel ızgaranın üstüne biner (sahip kararı 2026-11-24); İçe aktarma masası kenardan kenara.
      return first === "ice-aktar" ? "work" : "column";
    default:
      return "work";
  }
}

/** Telefonda ekran yerine "geniş ekranda açın" notu: çalışma ekranları, Üretim ve Tasarım dili › Kurallar, Dene, Oluştur. */
export function phoneNote(route: AppRoute): boolean {
  if (screenKind(route) === "work") return true;
  const [first] = route.rest;
  // Üretim sütunda durur ama düzenleme paneli (küçük tezgâh) telefona sığmaz.
  if (route.id === "uretim") return true;
  return route.id === "tasarim-dili" && !!first && WIDE_DESIGN_SECTIONS.has(first);
}

export function useAppRoute(): [AppRoute, Go] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback<Go>((id, rest = [], query, replace = false) => {
    const h = routeHash(id, rest, query);
    if (replace) {
      history.replaceState(null, "", h);
      setRoute(parseHash(h));
    } else window.location.hash = h;
  }, []);
  return [route, go];
}
