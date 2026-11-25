import type { BuildQuality, RevisionDetail } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { formatValue, labelFor } from "../tasarim-dili/mantik/diffView.ts";
import { CollapsedGroup, cx, Panel, StatusDot } from "../../tezgah/index.ts";
import { groupLabel } from "../tasarim-dili/profilMetni.ts";
import { summaryGroups } from "./akis.ts";
import { builderApi, keys } from "./api.ts";
import { kaynakMetni } from "./metin.ts";

export interface OzetProps {
  lang: string;
  buildId: string;
  rev: number;
  current: number;
  detail: RevisionDetail | undefined;
  loading: boolean;
  /** Alttaki eylemler (önceki sürüme dön, Yayınla). */
  footer?: ReactNode;
}

/**
 * Sağ panel (maket 5): gösterilen sürümün okunur özeti. Her grupta birkaç temel kural; bu sürümde değişen kurallar
 * vurgulu, eski değer üstü çizili, kaynağı (ölçüm, cevabınız, düzeltmeniz) yanında. Altta ücretsiz kalite kartı.
 */
export function Ozet({ lang, buildId, rev, current, detail, loading, footer }: OzetProps) {
  const { t, i18n } = useTranslation("builder");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dil değişince yeniden hesaplanır: summaryGroups metinleri ortak i18n örneğinden okur
  const groups = useMemo(() => summaryGroups(detail?.profile, detail?.changes ?? []), [detail, i18n.language]);
  const sub = rev === 0 ? t("rev.base") : rev === current ? t("rev.draft", { n: rev }) : t("rev.n", { n: rev });
  return (
    <Panel side="right" title={t("summary.title")} actions={<span className="ol-mut">{sub}</span>} footer={footer}>
      {loading && !detail ? (
        <div className="ol-pad">
          <StatusDot tone="busy" label={t("loading")} />
        </div>
      ) : (
        <div className="ol-ozet">
          {groups.map((g) => (
            <section key={g.group} className="ol-sg" aria-label={groupLabel(g.group)}>
              <h3 className="ol-sh">{groupLabel(g.group)}</h3>
              {g.rows.map((r) => (
                <div key={r.path} className={cx("ol-kv", r.change && "is-chg")}>
                  <span>{labelFor(r.path)}</span>
                  <b>
                    {r.change && <s>{formatValue(r.path, r.change.from)}</s>}
                    {r.change && " "}
                    {formatValue(r.path, r.value)}
                    {r.change && <em>{kaynakMetni(r.change)}</em>}
                    {r.change?.warning && <em className="is-uyari">{t("summary.outside")}</em>}
                  </b>
                </div>
              ))}
            </section>
          ))}
          {rev > 0 && <Kalite lang={lang} buildId={buildId} rev={rev} />}
        </div>
      )}
    </Panel>
  );
}

/** Kalite kartı (ücretsiz motor denemesi ayrılmış örneklerde; açılınca okunur). */
function Kalite({ lang, buildId, rev }: { lang: string; buildId: string; rev: number }) {
  const { t } = useTranslation("builder");
  return (
    <CollapsedGroup title={t("quality.title")} persistKey="olustur.kalite">
      <KaliteIc lang={lang} buildId={buildId} rev={rev} />
    </CollapsedGroup>
  );
}

function KaliteIc({ lang, buildId, rev }: { lang: string; buildId: string; rev: number }) {
  const { t } = useTranslation("builder");
  const q = useQuery({ queryKey: keys.quality(lang, buildId, rev), queryFn: () => builderApi.quality(buildId, rev), staleTime: Infinity, retry: false });
  if (q.isLoading) return <StatusDot tone="busy" label={t("loading")} />;
  if (!q.data) return <p className="ol-not">{t("quality.none")}</p>;
  const d: BuildQuality = q.data;
  const inv = d.invariants.unsupportedValues + d.invariants.textChanged + d.invariants.outsideSchema;
  return (
    <div className="ol-kalite">
      {d.test ? (
        <>
          <div className="ol-kv">
            <span>{t("quality.within10")}</span>
            <b className="ol-mono">{t("quality.ofN", { k: d.test.within10, n: d.test.n })}</b>
          </div>
          {d.test.failed > 0 && (
            <div className="ol-kv">
              <span>{t("quality.failed")}</span>
              <b className="ol-mono">{d.test.failed}</b>
            </div>
          )}
          {d.test.positionPx !== null && (
            <div className="ol-kv">
              <span>{t("quality.position")}</span>
              <b className="ol-mono">{t("quality.px", { v: formatNumber(d.test.positionPx, { maximumFractionDigits: 1 }) })}</b>
            </div>
          )}
        </>
      ) : (
        <p className="ol-not">{t(`quality.reason.${d.testReason ?? "no-measurable"}`)}</p>
      )}
      <StatusDot tone={inv === 0 ? "ok" : "error"} label={inv === 0 ? t("quality.invariantsOk") : t("quality.invariantsBad", { count: inv })} />
    </div>
  );
}
