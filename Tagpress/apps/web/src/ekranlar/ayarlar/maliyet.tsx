import { API, type CostSummary } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCan } from "../../lib/access.ts";
import { api, withQuery } from "../../lib/api.ts";
import { useLanguage } from "../../lib/language.tsx";
import { barPercent, dayLabel, fillDays, formatUsd, modelLabel } from "./mantik/format.ts";
import { cx, EmptyState, IssueBox, PanelSection, Segmented } from "../../tezgah/index.ts";
import { purposeLabel } from "./metin.ts";
import { Giris, Yukleniyor, YuklemeHatasi } from "./veri.tsx";

export default function Maliyet() {
  const { t } = useTranslation("settings");
  const { current } = useLanguage();
  // Tutarlar yalnız yönetebilene (platformda `GET /api/costs` öbürüne 403; bölüm de gizli). Sorgu hiç gitmez.
  const manage = useCan("manage");
  const q = useQuery({
    queryKey: ["costs", current?.id],
    enabled: !!current && manage,
    queryFn: () => api.get<CostSummary>(withQuery(API.costs, { languageId: current?.id })),
  });
  const c = q.data;

  return (
    <>
      <Giris>{current ? t("cost.introFor", { name: current.name }) : t("cost.intro")}</Giris>
      {q.isLoading && <Yukleniyor />}
      {q.error && <YuklemeHatasi error={q.error} retry={() => void q.refetch()} />}
      {c && (
        <>
          {/* `Num` bileşeni henüz yok: sayılar `.tz-mono` ile tablo hizalı. */}
          <dl className="ay-totals">
            <Toplam label={t("cost.today")} usd={c.todayUsd} />
            <Toplam label={t("cost.month")} usd={c.monthUsd} />
            <Toplam label={t("cost.total")} usd={c.totalUsd} />
          </dl>

          {c.unpricedCalls > 0 && (
            <IssueBox tone="warn">
              <b>{t("cost.unpricedTitle", { count: c.unpricedCalls })}</b> {t("cost.unpricedBody")}
            </IssueBox>
          )}

          <GunGrafigi byDay={c.byDay} />

          <div className="ay-split">
            <Dokum title={t("cost.byModel")} rows={c.byModel.map((r) => ({ key: r.model, label: modelLabel(r.model), usd: r.usd, calls: r.calls }))} />
            <Dokum title={t("cost.byPurpose")} rows={c.byPurpose.map((r) => ({ key: r.purpose, label: purposeLabel(r.purpose), usd: r.usd, calls: r.calls }))} />
          </div>
        </>
      )}
    </>
  );
}

function Toplam({ label, usd }: { label: string; usd: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="tz-mono">{formatUsd(usd)}</dd>
    </div>
  );
}

function GunGrafigi({ byDay }: { byDay: CostSummary["byDay"] }) {
  const { t } = useTranslation("settings");
  const [view, setView] = useState<"chart" | "table">("chart");
  const [hover, setHover] = useState<number | null>(null);
  // Sunucu günleri UTC tarihiyle saklar.
  const days = useMemo(() => fillDays(byDay, new Date().toISOString().slice(0, 10), 31), [byDay]);
  const max = Math.max(0, ...days.map((d) => d.usd));
  const total = days.reduce((s, d) => s + d.usd, 0);
  const h = hover === null ? null : days[hover];

  return (
    <PanelSection
      heading={t("cost.days.title")}
      aside={
        <Segmented
          aria-label={t("cost.days.view")}
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: t("cost.days.chart") },
            { value: "table", label: t("cost.days.table") },
          ]}
        />
      }
    >
      <p className="ay-note tz-mono">{t("cost.days.total", { usd: formatUsd(total) })}</p>
      {total === 0 ? (
        <EmptyState icon="tag" title={t("cost.days.empty")} />
      ) : view === "chart" ? (
        <figure style={{ margin: 0 }} aria-label={t("cost.days.figure")}>
          <div className="ay-hover tz-mono" aria-live="polite">
            {h ? t("cost.days.point", { day: dayLabel(h.day), usd: formatUsd(h.usd), count: h.calls }) : t("cost.days.peak", { usd: formatUsd(max) })}
          </div>
          <div className="ay-bars" onMouseLeave={() => setHover(null)}>
            {days.map((d, i) => (
              <div
                key={d.day}
                role="img"
                aria-label={t("cost.days.pointLabel", { day: dayLabel(d.day), usd: formatUsd(d.usd), count: d.calls })}
                onMouseEnter={() => setHover(i)}
                className={cx("ay-bar", hover === i && "is-hot", d.usd <= 0 && "is-zero")}
              >
                <i style={{ height: `${barPercent(d.usd, max)}%` }} />
              </div>
            ))}
          </div>
          <div className="ay-axis tz-mono">
            <span>{dayLabel(days[0]?.day ?? "2000-01-01")}</span>
            <span>{dayLabel(days[15]?.day ?? "2000-01-01")}</span>
            <span>{dayLabel(days[30]?.day ?? "2000-01-01")}</span>
          </div>
        </figure>
      ) : (
        <div className="ay-tablewrap">
          <table className="ay-table">
            <thead>
              <tr>
                <th scope="col">{t("cost.days.colDay")}</th>
                <th scope="col" className="is-n">
                  {t("cost.days.colAmount")}
                </th>
                <th scope="col" className="is-n">
                  {t("cost.days.colCalls")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{dayLabel(d.day)}</td>
                  <td className="is-n tz-mono">{formatUsd(d.usd)}</td>
                  <td className="is-n tz-mono">{d.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelSection>
  );
}

function Dokum({ title, rows }: { title: string; rows: Array<{ key: string; label: string; usd: number; calls: number }> }) {
  const { t } = useTranslation("settings");
  const sorted = [...rows].sort((a, b) => b.usd - a.usd);
  const max = Math.max(0, ...sorted.map((r) => r.usd));
  return (
    <PanelSection heading={title}>
      {sorted.length === 0 ? (
        <p className="ay-note">{t("cost.noCalls")}</p>
      ) : (
        <div>
          {sorted.map((r) => (
            <div key={r.key} className="ay-brk">
              <div className="ay-brk-h">
                <span>{r.label}</span>
                <span className="tz-mono">{formatUsd(r.usd)}</span>
              </div>
              <div className="ay-brk-b">
                <div className="ay-brk-bar" aria-hidden="true">
                  <i style={{ width: `${barPercent(r.usd, max)}%` }} />
                </div>
                <span className="ay-brk-c tz-mono">{t("cost.calls", { count: r.calls })}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelSection>
  );
}
