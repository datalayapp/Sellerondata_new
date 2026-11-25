import type { JobLog, LayoutResult, VariantDetail, VariantSummary } from "@tagpress/domain";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber, formatUsd, sumUsd } from "../../i18n/bicim.ts";
import { issueText } from "../../i18n/sunucu.ts";
import { variantsByNo } from "./mantik/jobs.ts";
import { Button } from "../../tezgah/index.ts";
import { clockText } from "./metin.ts";
import { KIND_KEY } from "./parcalar.tsx";

const ROLES = new Set(["name", "connector", "greeting", "message", "date", "place", "title", "other"]);
const TIERS = new Set(["primary", "secondary", "tertiary", "connector"]);

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ur-det-s">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** Kapalı "Ayrıntılar": satırlar, maliyet, AI gerekçesi, görsel sorunları, teknik puan, üretim günlüğü, sürümler. */
export function Details({ variant, variants, focusedId, onFocus, log, logLoading }: { variant: VariantDetail | undefined; variants: VariantSummary[]; focusedId: string | null; onFocus(id: string): void; log?: JobLog; logLoading: boolean }) {
  const { t } = useTranslation("production");
  const layout = (variant?.layout ?? null) as LayoutResult | null;
  const critique = (variant?.issues ?? []).filter((i) => i.code === "critique-issue" || i.code === "image-text-mismatch" || i.code === "image-template-changed");
  // Tutar platformda yalnız Yöneticiye gelir (öbürüne `null`): toplam da "—" olur, "$0" değil.
  const callsCost = log ? sumUsd(log.aiCalls.map((c) => c.costUsd)) : null;
  const rationale = variant?.rationale || variant?.intent?.rationale || "";
  const fmt = (n: number, d = 1) => formatNumber(n, { maximumFractionDigits: d });
  const role = (r: string) => (ROLES.has(r) ? t(`details.role.${r}`) : r);
  const tier = (r: string) => (TIERS.has(r) ? t(`details.tier.${r}`) : r);

  return (
    <div className="ur-det">
      <Block title={variant ? t("details.rowsOf", { no: variant.no }) : t("details.rows")}>
        {layout?.lines?.length ? (
          <table className="ur-tbl">
            <thead>
              <tr>
                <th>{t("details.colText")}</th>
                <th>{t("details.colFont")}</th>
                <th className="ur-r">{t("details.colSize")}</th>
                <th>{t("details.colRole")}</th>
              </tr>
            </thead>
            <tbody>
              {layout.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.text}</td>
                  <td>{[...new Set(l.runs.map((r) => `${r.family} ${r.style}`.trim()))].join(", ")}</td>
                  <td className="ur-r tz-mono">{t("details.px", { v: fmt(l.sizePx) })}</td>
                  <td>
                    {role(l.role)} · {tier(l.tier)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : variant?.image ? (
          <p>
            {t("details.imageRows")} {variant.image.readText ? t("details.readText", { text: variant.image.readText }) : ""}
          </p>
        ) : (
          <p>{t("details.noRows")}</p>
        )}
      </Block>

      <Block title={t("details.cost")}>
        <dl className="ur-dl">
          <dt>{t("details.thisVariant")}</dt>
          <dd>{formatUsd(variant?.snapshot.costUsd)}</dd>
          <dt>{t("details.jobTotal")}</dt>
          <dd>{logLoading ? "…" : formatUsd(callsCost)}</dd>
          <dt>{t("details.model")}</dt>
          <dd>{variant?.snapshot.model ?? "—"}</dd>
          <dt>{t("details.profileVersion")}</dt>
          <dd className="tz-mono">{variant?.snapshot.profileVersion ? `v${variant.snapshot.profileVersion}` : "—"}</dd>
        </dl>
      </Block>

      <Block title={t("details.rationale")}>
        <p>{rationale || t("details.noRationale")}</p>
      </Block>

      <Block title={t("details.imageIssues")}>
        {critique.length ? (
          <ul>
            {critique.map((c, i) => (
              <li key={i}>{issueText(c)}</li>
            ))}
          </ul>
        ) : (
          <p>{t("details.noImageIssues")}</p>
        )}
      </Block>

      <Block title={t("details.score")}>
        {variant?.score !== null && variant?.score !== undefined ? (
          <>
            <p>
              {t("details.total", { v: fmt(variant.score, 2) })}
              {layout?.fill ? ` · ${t("details.fill", { v: fmt(layout.fill * 100, 0) })}` : ""}
            </p>
            {layout?.score?.parts && (
              <p className="ur-mut tz-mono">
                {Object.entries(layout.score.parts)
                  .map(([k, v]) => `${k} ${fmt(v, 2)}`)
                  .join(" · ")}
              </p>
            )}
            {layout?.notes?.length ? <p>{t("details.engine", { notes: layout.notes.join(" · ") })}</p> : null}
          </>
        ) : (
          <p>{t("details.noScore")}</p>
        )}
      </Block>

      <Block title={t("details.log")}>
        {logLoading ? (
          <p>…</p>
        ) : log && (log.steps.length > 0 || log.aiCalls.length > 0) ? (
          <>
            <ol className="ur-log">
              {log.steps.map((s, i) => (
                <li key={i} className={s.step === "error" ? "is-err" : undefined}>
                  <time dateTime={s.at} className="tz-mono">
                    {clockText(new Date(s.at), true)}
                  </time>
                  <span>{s.message}</span>
                </li>
              ))}
            </ol>
            {log.aiCalls.length > 0 && (
              <table className="ur-tbl">
                <thead>
                  <tr>
                    <th>{t("details.colPurpose")}</th>
                    <th>{t("details.model")}</th>
                    <th className="ur-r">{t("details.colTokens")}</th>
                    <th className="ur-r">{t("details.cost")}</th>
                    <th className="ur-r">{t("details.colTime")}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.aiCalls.map((c) => (
                    <tr key={c.id} className={c.error ? "is-err" : undefined} title={c.error ?? c.summary}>
                      <td>{c.purpose}</td>
                      <td>{c.model}</td>
                      <td className="ur-r tz-mono">
                        {c.inputTokens} / {c.outputTokens}
                      </td>
                      <td className="ur-r tz-mono">{formatUsd(c.costUsd)}</td>
                      <td className="ur-r tz-mono">{t("details.seconds", { v: fmt(c.durationMs / 1000) })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p>{t("details.noLog")}</p>
        )}
      </Block>

      <Block title={t("details.versions")}>
        {variants.length === 0 ? (
          <p>{t("details.noVersions")}</p>
        ) : (
          <ul className="ur-vers">
            {variantsByNo(variants).map((v) => (
              <li key={v.id}>
                <b className="tz-mono">V{v.no}</b>
                <span className="ur-grow">
                  {t(KIND_KEY[v.kind])}
                  {v.stale && ` · ${t("details.staleV")}`}
                  {v.approved && ` · ${t("details.approvedV")}`}
                  {v.score !== null && ` · ${t("details.scoreV", { v: fmt(v.score, 2) })}`}
                </span>
                <time dateTime={v.createdAt} className="tz-mono ur-mut">
                  {clockText(new Date(v.createdAt))}
                </time>
                <Button size="mini" variant="quiet" disabled={v.id === focusedId} onClick={() => onFocus(v.id)}>
                  {v.id === focusedId ? t("details.selected") : t("details.select")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
