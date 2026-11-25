import type { HubAlert, HubKpi, HubOverview, HubSetupStep } from "@sellerondata/contracts";
import { previousPeriod, type Period } from "@sellerondata/product-kit/pure";
import { type Ctx, PRODUCT, hub, range, seriesOf, tagpress } from "./common.ts";
import { HubFacts, type HubSqlDb } from "./sql.ts";

/** Bu süreden uzun süren üretim görevi ya da baskı çıktısı "takılmış" sayılır [V]. */
export const STUCK_MINUTES = 15;

/**
 * Genel Bakış (plan §S7). KPI sırası önem sırasıdır, ilk üçü kayıttaki `hub.headline`: `approved` (dönemde onaylanan), `pending`
 * (onay bekleyen, anlık), `printed` (dönemde basılan sayfa), `jobs` (dönemde gelen), `queue` (üretimde + sırada, anlık),
 * `ai_calls` (dönemde yapay zekâ çağrısı). Baş rakamın seyri (`trend`) dönem ve önceki dönem. Anlık değerler (bekleyen,
 * kuyruk, uyarılar) dönemden bağımsızdır; Merkez sayfayı yeniledikçe güncellenir.
 */
export function buildOverview(db: HubSqlDb, ctx: Ctx, p: Period): HubOverview {
  const f = new HubFacts(db);
  const { t } = ctx;
  const prev = previousPeriod(p);
  const cur = range(ctx, p);
  const before = range(ctx, prev);

  const approved = f.approved(cur);
  const approvedPrev = f.approved(before);
  const printed = f.printed(cur);
  const printedPrev = f.printed(before);
  const sheets = (rows: { sheets: number }[]) => rows.reduce((a, r) => a + r.sheets, 0);
  const jobs = f.created(cur).length;
  const jobsPrev = f.created(before).length;
  const ai = f.aiCalls(cur).length;
  const aiPrev = f.aiCalls(before).length;
  const pending = f.pending();
  const queue = f.queue();

  const kpis: HubKpi[] = [
    {
      id: "approved",
      label: t("kpi.approved"),
      hint: t("kpi.approved.hint"),
      value: approved.length,
      format: "number",
      previous: approvedPrev.length,
      goodDirection: "up",
      tone: approved.length > 0 ? "good" : "neutral",
      href: hub.analytics,
      trend: [
        seriesOf(ctx, p, "current", t("trend.current"), approved.map((r) => r.at), undefined, "current"),
        seriesOf(ctx, prev, "previous", t("trend.previous"), approvedPrev.map((r) => r.at), undefined, "previous"),
      ],
    },
    {
      id: "pending",
      label: t("kpi.pending"),
      hint: t("kpi.pending.hint"),
      value: pending,
      format: "number",
      goodDirection: "none",
      tone: pending > 0 ? "warning" : "neutral",
      href: hub.data("jobs", { status: "ready" }),
    },
    {
      id: "printed",
      label: t("kpi.printed"),
      hint: t("kpi.printed.hint"),
      value: sheets(printed),
      format: "number",
      previous: sheets(printedPrev),
      goodDirection: "up",
      href: hub.data("prints", { status: "printed" }, p),
    },
    { id: "jobs", label: t("kpi.jobs"), hint: t("kpi.jobs.hint"), value: jobs, format: "number", previous: jobsPrev, goodDirection: "none", href: hub.data("jobs", {}, p) },
    {
      id: "queue",
      label: t("kpi.queue"),
      hint: t("kpi.queue.hint"),
      value: queue,
      format: "number",
      goodDirection: "none",
      tone: queue > 0 ? "info" : "neutral",
      href: tagpress.production,
    },
    { id: "ai_calls", label: t("kpi.aiCalls"), hint: t("kpi.aiCalls.hint"), value: ai, format: "number", previous: aiPrev, goodDirection: "none", href: hub.analytics },
  ];

  const languages = f.languages();
  const out: HubOverview = { product: PRODUCT, from: p.from, to: p.to, kpis, alerts: alerts(f, ctx, languages.some((l) => !l.deleted && l.published)) };
  out.setup = setup(f, ctx, languages.some((l) => !l.deleted && l.published));
  return out;
}

function alerts(f: HubFacts, ctx: Ctx, hasLanguage: boolean): HubAlert[] {
  const { t } = ctx;
  const out: HubAlert[] = [];
  const failed = f.failedJobs();
  if (failed > 0) {
    out.push({ id: "failed-jobs", tone: "bad", title: t("alert.failed.title", { count: failed }), body: t("alert.failed.body"), href: tagpress.production, actionLabel: t("action.openProduction") });
  }
  const dropped = f.droppedApprovals();
  if (dropped > 0) {
    out.push({ id: "approval-dropped", tone: "warning", title: t("alert.dropped.title", { count: dropped }), body: t("alert.dropped.body"), href: tagpress.production, actionLabel: t("action.openProduction") });
  }
  const stuck = f.stuckTasks(new Date(ctx.now.getTime() - STUCK_MINUTES * 60_000).toISOString());
  if (stuck > 0) {
    out.push({ id: "stuck-task", tone: "warning", title: t("alert.stuck.title", { count: stuck }), body: t("alert.stuck.body"), href: tagpress.production, actionLabel: t("action.openProduction") });
  }
  if (!hasLanguage) {
    out.push({ id: "no-language", tone: "warning", title: t("alert.noLanguage.title"), body: t("alert.noLanguage.body"), href: tagpress.languages, actionLabel: t("action.openLanguages") });
  }
  return out;
}

/**
 * Kurulum listesi: adımlar firmanın verisinden. `completed` TagPress kurulumunun (`org_settings.setup`) tamamlanmasıdır; Merkez
 * onayı yoksa product-kit çatısı `false`a çevirir. "Ekibi davet et"i Merkez ekler.
 */
function setup(f: HubFacts, ctx: Ctx, hasLanguage: boolean): NonNullable<HubOverview["setup"]> {
  const { t } = ctx;
  const state = f.setup();
  const done = state?.status === "completed";
  const step = (id: string, label: Parameters<typeof t>[0], href: string, ok: boolean, required: boolean): HubSetupStep => ({ id, label: t(label), done: ok, href, required });
  return {
    completed: done,
    href: tagpress.setup,
    label: t("setup.label"),
    steps: [
      step("setup", "setup.step.setup", tagpress.setup, done, true),
      step("language", "setup.step.language", tagpress.languages, hasLanguage, true),
      step("first-job", "setup.step.firstJob", tagpress.importJobs, f.anyJob(), true),
      step("first-print", "setup.step.firstPrint", tagpress.printDesk, f.anyPrinted(), false),
    ],
  };
}
