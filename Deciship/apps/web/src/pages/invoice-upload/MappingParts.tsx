import { Trans, useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import type { AiMappingResult, InvoicePreviewTable } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Button, errorMessage } from "../../components/ui";
import { fmtNum } from "../../lib/format";

// ---------------- Step 2: mapping ----------------
/** Eşleme tanılaması: takip no / net tutar doluluğu (seçime göre canlı), ücret çiftleri ve sunucu uyarıları. */
/** "Yapay zekâ ile eşle": normalde ikincil; otomatik eşleme emin değilse vurgulu bilgi bandında. */
export function AiBar({
  suggest,
  available,
  busy,
  error,
  ai,
  onAi,
}: {
  suggest: boolean;
  available: boolean;
  busy: boolean;
  error: unknown;
  ai: AiMappingResult | null;
  onAi: () => void;
}) {
  const { t } = useTranslation("invoiceUpload");
  const off =
    (error instanceof ApiError && error.code === "AI_DISABLED") || !available;
  const fromAi = ai
    ? Object.values(ai.fieldSources ?? {}).filter((x) => x === "ai").length
    : 0;
  const btn = (
    <Button
      kind="secondary"
      icon={busy ? undefined : "spark"}
      loading={busy}
      disabled={busy || off}
      className={`ai-btn${suggest ? " hl" : ""}`}
      onClick={onAi}
    >
      {busy ? t("ai.mapping") : ai ? t("ai.remap") : t("ai.map")}
    </Button>
  );
  return (
    <div className="ai-bar" aria-live="polite">
      {busy ? (
        <div className="notif info ai-wait">
          <Icon name="spin" className="spin" />
          <span>
            <Trans t={t} i18nKey="ai.wait" components={{ b: <b /> }} />
          </span>
        </div>
      ) : ai ? (
        <div
          className={`notif ${ai.diagnostics.verification.verdict === "ok" ? "ok" : "warn"}`}
        >
          <Icon
            name={ai.diagnostics.verification.verdict === "ok" ? "ok" : "warn"}
          />
          <span>
            <Trans
              t={t}
              i18nKey="ai.applied"
              count={fromAi}
              values={{ n: fmtNum(fromAi) }}
              components={{ b: <b /> }}
            />
            {ai.dropped.length > 0 &&
              ` ${t("ai.dropped", { count: ai.dropped.length, n: fmtNum(ai.dropped.length) })}`}{" "}
            {t("ai.sourcesBelow")}
          </span>
        </div>
      ) : suggest ? (
        <div className="notif info ai-suggest">
          <Icon name="info" />
          <span>
            <Trans t={t} i18nKey="ai.unsure" components={{ b: <b /> }} />{" "}
            {off ? t("ai.checkBelow") : t("ai.tryAi")}
          </span>
        </div>
      ) : null}
      {Boolean(error) && !busy && (
        <div className="notif err" role="alert">
          <Icon name="err" />
          <span>
            {off ? (
              t("ai.offError")
            ) : (
              <>
                {t("ai.failed")} {errorMessage(error)}
              </>
            )}
          </span>
        </div>
      )}
      {!(off && !ai) && (
      <div className="ai-row">
        {btn}
        <span className="t3 s12">
          {off ? t("ai.off") : t("ai.note")}
        </span>
      </div>
      )}
    </div>
  );
}

/** Katlı "Dosya önizlemesi": ilk satırlar, eşlenen sütunlar mavi. */
export function FilePreview({
  preview,
  mappedBy,
}: {
  preview: InvoicePreviewTable;
  mappedBy: Map<string, string>;
}) {
  const { t } = useTranslation("invoiceUpload");
  const headers = preview.headers;
  return (
    <details className="card flush raw">
      <summary>
        <Icon name="table" />
        <span className="grow">
          {t("preview.title")}
          <span className="t3 s12">
            {" "}
            · {t("preview.sub", { count: preview.sampleRows.length, n: fmtNum(preview.sampleRows.length) })}
          </span>
        </span>
        <Icon name="chev" className="raw-chev" />
      </summary>
      <div className="table-wrap bare raw-wrap">
        <table className="dt compact">
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h} className={mappedBy.has(h) ? "mapped" : ""}>
                  {h}
                  <span className="sub">{mappedBy.get(h) ?? "—"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.sampleRows.map((r, i) => (
              <tr key={i}>
                {headers.map((h, j) => (
                  <td
                    key={j}
                    className={mappedBy.has(h) ? "mapped mono" : "mono t3"}
                  >
                    {r[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
