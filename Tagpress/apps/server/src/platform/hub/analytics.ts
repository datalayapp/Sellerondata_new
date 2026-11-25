import type { HubAnalytics, HubKpi, HubSection, HubWidget } from "@sellerondata/contracts";
import { previousPeriod, type Period } from "@sellerondata/product-kit/pure";
import type { HubKey } from "../../i18n/hub.ts";
import { type Ctx, PRODUCT, hub, languageFilter, languageFilterDef, languageName, pct, range, seriesOf, tagpress, wantsCompare } from "./common.ts";
import { HubFacts, type HubSqlDb } from "./sql.ts";

const BREAKDOWN_N = 8;

/** Yapay zekâ amaçlarının Merkez grupları (`ai_calls.purpose`: `design`, `rank`, `builder-turn`, `sablon-*`, `deneme-*` …). */
export function purposeGroup(purpose: string): "design" | "rank" | "transcribe" | "builder" | "template" | "trial" | "image" | "other" {
  if (purpose === "design" || purpose === "rank" || purpose === "transcribe") return purpose;
  if (purpose.startsWith("builder-")) return "builder";
  if (purpose.startsWith("sablon-")) return "template";
  if (purpose.startsWith("deneme-")) return "trial";
  if (purpose.startsWith("image")) return "image";
  return "other";
}

const withPrev = (kpi: HubKpi, prev: number | null, compare: boolean): HubKpi => (compare ? { ...kpi, previous: prev } : kpi);

/** En büyük N + "Diğer": kırılım toplamı bütüne eşittir. Eşitlikte ada göre (sıra istekten isteğe değişmez). */
function breakdown(ctx: Ctx, entries: [string, string, number][]): Extract<HubWidget, { kind: "breakdown" }>["items"] {
  const positive = entries.filter(([, , v]) => v > 0).sort((a, b) => b[2] - a[2] || a[1].localeCompare(b[1], ctx.locale) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = positive.reduce((a, [, , v]) => a + v, 0);
  const shown = positive.slice(0, BREAKDOWN_N);
  const rest = positive.slice(BREAKDOWN_N).reduce((a, [, , v]) => a + v, 0);
  const items = shown.map(([key, label, value]) => ({ key, label, value, share: pct(value, total) ?? 0 }));
  if (rest > 0) items.push({ key: "other", label: ctx.t("other"), value: rest, share: pct(rest, total) ?? 0 });
  return items;
}

function empty(ctx: Ctx, id: string): HubWidget {
  return { kind: "empty", id, title: ctx.t("empty.period.title"), body: ctx.t("empty.period.body"), href: tagpress.production, actionLabel: ctx.t("action.openProduction") };
}

function section(ctx: Ctx, id: string, key: HubKey, widgets: HubWidget[], finding?: string): HubSection {
  return { id, title: ctx.t(key), description: ctx.t(`${key}.description` as HubKey), ...(finding ? { finding: { text: finding } } : {}), widgets };
}

/**
 * Analiz (plan §S7): `production` (gelen/onaylanan seri + KPI), `languages` (dile göre onaylanan), `print` (basılan sayfa
 * serisi), `ai` (amaca göre çağrı sayısı). Süzgeç `language` (tek dil). `compare` açıksa KPI'larda önceki dönem.
 */
export function buildAnalytics(db: HubSqlDb, ctx: Ctx, p: Period, query: Record<string, unknown>): HubAnalytics {
  const f = new HubFacts(db);
  const { t } = ctx;
  const languages = f.languages();
  const language = languageFilter(ctx, languages, query);
  const compare = wantsCompare(query);
  const prev = previousPeriod(p);
  const cur = range(ctx, p);
  const before = range(ctx, prev);

  const created = f.created(cur, language);
  const approved = f.approved(cur, language);
  const printed = f.printed(cur, language);
  const ai = f.aiCalls(cur, language);
  const old = compare
    ? { created: f.created(before, language), approved: f.approved(before, language), printed: f.printed(before, language), ai: f.aiCalls(before, language) }
    : null;
  const sheets = (rows: { sheets: number }[]) => rows.reduce((a, r) => a + r.sheets, 0);
  const approvedOfCreated = (rows: { status: string }[]) => rows.filter((r) => r.status === "approved").length;
  const dataFilters = { language };

  // Üretim
  const production: HubWidget[] =
    created.length || approved.length
      ? [
          {
            kind: "kpis",
            id: "production-kpis",
            items: [
              withPrev({ id: "jobs", label: t("kpi.jobs"), hint: t("kpi.jobs.hint"), value: created.length, format: "number", goodDirection: "none", href: hub.data("jobs", dataFilters, p) }, old?.created.length ?? null, compare),
              withPrev({ id: "approved", label: t("kpi.approved"), hint: t("kpi.approved.hint"), value: approved.length, format: "number", goodDirection: "up" }, old?.approved.length ?? null, compare),
              withPrev(
                { id: "approval-rate", label: t("kpi.approvalRate"), hint: t("kpi.approvalRate.hint"), value: pct(approvedOfCreated(created), created.length), format: "percent", goodDirection: "up" },
                old ? pct(approvedOfCreated(old.created), old.created.length) : null,
                compare,
              ),
            ],
          },
          {
            kind: "timeseries",
            id: "production-series",
            title: t("widget.production.series"),
            chart: "line",
            format: "number",
            series: [
              seriesOf(ctx, p, "jobs", t("series.jobs"), created.map((r) => r.at)),
              seriesOf(ctx, p, "approved", t("series.approved"), approved.map((r) => r.at)),
            ],
          },
        ]
      : [empty(ctx, "production-empty")];

  // Tasarım dilleri
  const byLanguage = new Map<string, number>();
  for (const r of approved) byLanguage.set(r.language, (byLanguage.get(r.language) ?? 0) + 1);
  const languageItems = breakdown(ctx, [...byLanguage].map(([id, n]) => [id, languageName(ctx, languages, id), n]));
  const languageWidgets: HubWidget[] = languageItems.length
    ? [{ kind: "breakdown", id: "languages-breakdown", title: t("widget.languages.breakdown"), format: "number", items: languageItems }]
    : [empty(ctx, "languages-empty")];

  // Baskı
  const printWidgets: HubWidget[] = printed.length
    ? [
        {
          kind: "kpis",
          id: "print-kpis",
          items: [
            withPrev({ id: "printed", label: t("kpi.printed"), hint: t("kpi.printed.hint"), value: sheets(printed), format: "number", goodDirection: "up" }, old ? sheets(old.printed) : null, compare),
            withPrev({ id: "sessions", label: t("kpi.sessions"), value: printed.length, format: "number", goodDirection: "none", href: hub.data("prints", { status: "printed", ...dataFilters }, p) }, old?.printed.length ?? null, compare),
          ],
        },
        {
          kind: "timeseries",
          id: "print-series",
          title: t("widget.print.series"),
          chart: "bar",
          format: "number",
          series: [seriesOf(ctx, p, "printed", t("series.printed"), printed.map((r) => r.at), printed.map((r) => r.sheets))],
        },
      ]
    : [empty(ctx, "print-empty")];

  // Yapay zekâ
  const byPurpose = new Map<string, number>();
  for (const c of ai) {
    const g = purposeGroup(c.purpose);
    byPurpose.set(g, (byPurpose.get(g) ?? 0) + 1);
  }
  const aiWidgets: HubWidget[] = ai.length
    ? [
        {
          kind: "kpis",
          id: "ai-kpis",
          items: [
            withPrev({ id: "ai_calls", label: t("kpi.aiCalls"), hint: t("kpi.aiCalls.hint"), value: ai.length, format: "number", goodDirection: "none" }, old?.ai.length ?? null, compare),
            withPrev({ id: "failed-calls", label: t("kpi.failedCalls"), value: ai.filter((c) => c.failed).length, format: "number", goodDirection: "down" }, old ? old.ai.filter((c) => c.failed).length : null, compare),
          ],
        },
        { kind: "breakdown", id: "ai-breakdown", title: t("widget.ai.breakdown"), format: "number", items: breakdown(ctx, [...byPurpose].map(([g, n]) => [g, t(`purpose.${g}` as HubKey), n])) },
      ]
    : [empty(ctx, "ai-empty")];

  const top = languageItems[0];
  return {
    product: PRODUCT,
    from: p.from,
    to: p.to,
    ...(compare ? { compare: { from: prev.from, to: prev.to } } : {}),
    filters: [languageFilterDef(ctx, languages)],
    sections: [
      section(ctx, "production", "section.production", production, created.length || approved.length ? t("finding.production", { jobs: created.length, approved: approved.length }) : undefined),
      section(ctx, "languages", "section.languages", languageWidgets, top && top.key !== "other" ? t("finding.languages", { name: top.label }) : undefined),
      section(ctx, "print", "section.print", printWidgets, printed.length ? t("finding.print", { pages: sheets(printed) }) : undefined),
      section(ctx, "ai", "section.ai", aiWidgets, ai.length ? t("finding.ai", { count: ai.length }) : undefined),
    ],
  };
}
