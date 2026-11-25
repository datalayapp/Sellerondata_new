import type { HubFilterDef, HubSeries } from "@sellerondata/contracts";
import type { HubCtx } from "@sellerondata/product-kit";
import { KitError, kitMessage } from "@sellerondata/product-kit";
import { bucketize, type Period } from "@sellerondata/product-kit/pure";
import { zonedDate } from "@sellerondata/product-kit/pure";
import { type HubKey, type HubTranslate, hubTranslator } from "../../i18n/hub.ts";
import type { HubSqlDb, LanguageRow } from "./sql.ts";
import { countByDay, zonedIsoRange } from "./time.ts";

export const PRODUCT = "tagpress";

/** Merkez izinleri (kayıt `hub`): Genel Bakış, Analiz, Veriler, Etkinlik `reports.view`; CSV `data.export`. */
export const P = { reports: "tagpress.reports.view", export: "tagpress.data.export" } as const;

/** Sağlayıcının iç bağlamı: Merkez bağlamı + çevirici + firmanın bugünü. */
export type Ctx = HubCtx & { t: HubTranslate; today: string };

export function withT(ctx: HubCtx): Ctx {
  return { ...ctx, t: hubTranslator(ctx.locale), today: zonedDate(ctx.now, ctx.timeZone) };
}

/** Araçtaki kayıtlara derin bağlantılar (web hash rotaları, `apps/web/src/lib/route.ts`). İş araçta yapılır. */
export const tagpress = {
  production: "/tagpress/#/uretim",
  job: (id: string) => `/tagpress/#/uretim?is=${encodeURIComponent(id)}`,
  importJobs: "/tagpress/#/uretim/ice-aktar",
  languages: "/tagpress/#/tasarim-dili",
  setup: "/tagpress/#/kurulum",
  printDesk: "/tagpress/#/baski/masa",
  printSession: (id: string) => `/tagpress/#/baski/masa/${encodeURIComponent(id)}`,
  template: (key: string) => `/tagpress/#/sablonlar/${encodeURIComponent(key)}`,
};

/** Merkez'in kendi sayfaları. */
export const hub = {
  analytics: "/analytics/tagpress",
  data(dataset: string, filters: Record<string, string | undefined | null>, p?: Period): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.append(`filter.${k}`, v);
    if (p) {
      q.append("filter.from", p.from);
      q.append("filter.to", p.to);
    }
    const s = q.toString();
    return `/data/tagpress/${dataset}${s ? `?${s}` : ""}`;
  },
};

export const range = (ctx: HubCtx, p: Period) => zonedIsoRange(p.from, p.to, ctx.timeZone);

/** Günlük sayımdan grafik serisi (firmanın gününe göre; bugünden sonrası boş). */
export function seriesOf(ctx: Ctx, p: Period, id: string, label: string, isos: readonly string[], weights?: readonly number[], role?: HubSeries["role"]): HubSeries {
  const byDay = countByDay(isos, ctx.timeZone, weights);
  return { id, label, points: bucketize(p, (d) => byDay.get(d) ?? 0, { today: ctx.today }), ...(role ? { role } : {}) };
}

export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]).filter(Boolean);

export const wantsCompare = (q: Record<string, unknown>): boolean => {
  const v = q.compare;
  return v !== undefined && v !== "" && v !== "0" && v !== "false" && v !== "none";
};

export const validation = (ctx: HubCtx, name: string) => new KitError(400, "VALIDATION", kitMessage("filter", ctx.locale, { name }));

/** Yüzde (0–100, bir hane); bütün yoksa null. */
export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export const languageName = (ctx: Ctx, languages: readonly LanguageRow[], id: string | null | undefined): string =>
  (id && languages.find((l) => l.id === id)?.name) || ctx.t("unknownLanguage");

/** Süzgeçteki dil: yalnız firmanın silinmemiş dili; tanınmayan değer 400. */
export function languageFilter(ctx: Ctx, languages: readonly LanguageRow[], query: Record<string, unknown>): string | null {
  const v = asList(query["filter.language"])[0];
  if (!v) return null;
  if (!languages.some((l) => l.id === v && !l.deleted)) throw validation(ctx, "language");
  return v;
}

export function languageFilterDef(ctx: Ctx, languages: readonly LanguageRow[]): HubFilterDef {
  return { id: "language", kind: "select", label: ctx.t("filter.language"), options: languages.filter((l) => !l.deleted).map((l) => ({ value: l.id, label: l.name })) };
}

export const select = (ctx: Ctx, id: string, label: HubKey, options: { value: string; label: string }[], multiple = false): HubFilterDef => ({
  id,
  kind: "select",
  label: ctx.t(label),
  options,
  ...(multiple ? { multiple } : {}),
});
export const text = (ctx: Ctx, id: string, label: HubKey): HubFilterDef => ({ id, kind: "text", label: ctx.t(label) });

export type Deps = { db: HubSqlDb };
