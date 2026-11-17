import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MappingDiagnostics, RowFlag } from "@deciship/core";
import type { MappingIssues } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Card, Modal, ModalAction, StatusPill } from "../../components/ui";
import { fmtMoney, fmtNum } from "../../lib/format";
import { flagText, isHard } from "./uploadUtils";

export function IssuesModal({
  title,
  intro,
  issues,
  extra,
  backText,
  confirmText,
  checkText,
  loading,
  onBack,
  onConfirm,
}: {
  title: string;
  intro: string;
  issues: MappingIssues;
  extra?: string;
  backText?: string;
  confirmText: string;
  checkText: string;
  loading?: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("invoiceUpload");
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    // Varsayılan odak "Geri dön ve düzelt" (Modal ilk kontrolü odaklar; bu ondan sonra çalışır).
    const timer = setTimeout(
      () =>
        document.querySelector<HTMLButtonElement>("[data-gate-back]")?.focus(),
      0,
    );
    return () => clearTimeout(timer);
  }, []);
  return (
    <Modal
      title={title}
      label={t("verify.label")}
      onClose={onBack}
      size="wide"
      actions={
        <>
          <ModalAction
            kind="dark"
            className="pa dark warn-act"
            icon="warn"
            disabled={!seen}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmText}
          </ModalAction>
          <ModalAction kind="prim" data-gate-back icon="back" onClick={onBack}>
            {backText ?? t("verify.backDefault")}
          </ModalAction>
        </>
      }
    >
      <p className="t2">{intro}</p>
      <ul className="issue-list">
        {issues.issues.map((msg, i) => (
          <li key={i}>
            <Icon name="warn" /> <span>{msg}</span>
          </li>
        ))}
      </ul>
      {issues.examples.length > 0 && (
        <div className="issue-ex">
          <div className="lbl">
            {t("verify.examples", { count: issues.flaggedRows, n: fmtNum(issues.flaggedRows) })}
          </div>
          <ul>
            {issues.examples.slice(0, 5).map((r) => (
              <li key={r.rowIndex}>
                <span className="mono">{t("verify.row", { n: fmtNum(r.rowIndex + 1) })}</span> ·{" "}
                {r.codes.filter(isHard).map(flagText).join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {extra && <p className="t3 s13 mt8">{extra}</p>}
      <label className="check mt16">
        <input
          type="checkbox"
          checked={seen}
          onChange={(e) => setSeen(e.target.checked)}
        />{" "}
        {checkText}
      </label>
    </Modal>
  );
}

/** "Kontrol sonuçları": takip no doluluğu, ücret kalemleri, fatura toplamı farkı, sorunlu satırlar. */
export function VerificationCard({
  diag,
  verifying,
  currency,
}: {
  diag?: MappingDiagnostics;
  verifying: boolean;
  currency?: string;
}) {
  const { t } = useTranslation("invoiceUpload");
  const v = diag?.verification;
  if (!v) return null;
  const c = v.checks;
  const soft = v.rowFlags.filter((r) => !r.codes.some(isHard)).length;
  const examples = v.rowFlags.filter((r) => r.codes.some(isHard));
  const tFill = c.tracking.total > 0 ? c.tracking.filled / c.tracking.total : 0;
  const items: { ok: boolean | null; label: string; value: string }[] = [
    {
      ok: c.tracking.filled > 0 && v.fields.trackingNo?.status === "ok",
      label: t("verify.tracking.label"),
      value:
        !v.fields.trackingNo || v.fields.trackingNo.status === "missing"
          ? t("verify.tracking.noColumn")
          : c.tracking.filled > 0
            ? t("verify.tracking.summary", {
                filled: fmtNum(c.tracking.filled),
                total: fmtNum(c.tracking.total),
                formatOk: fmtNum(c.tracking.formatOk),
                unique: fmtNum(c.tracking.unique),
              })
            : t("verify.tracking.empty"),
    },
    {
      ok:
        c.charges.rowsChecked === 0
          ? null
          : c.charges.rowsMatching === c.charges.rowsChecked,
      label: t("verify.charges.label"),
      value:
        c.charges.rowsChecked === 0
          ? t("verify.charges.noBase")
          : t("verify.charges.summary", {
              matching: fmtNum(c.charges.rowsMatching),
              checked: fmtNum(c.charges.rowsChecked),
            }),
    },
    {
      ok: c.invoiceTotal ? Math.abs(c.invoiceTotal.difference) <= 1 : null,
      label: t("verify.total.label"),
      value: c.invoiceTotal
        ? Math.abs(c.invoiceTotal.difference) <= 1
          ? t("verify.total.match", { value: fmtMoney(c.invoiceTotal.value, currency) })
          : t("verify.total.diff", {
              diff: fmtMoney(c.invoiceTotal.difference, currency),
              lines: fmtMoney(c.invoiceTotal.linesTotal, currency),
              value: fmtMoney(c.invoiceTotal.value, currency),
            })
        : t("verify.total.none"),
    },
    {
      ok: v.flaggedRows === 0,
      label: t("verify.flagged.label"),
      value: v.flaggedRows
        ? t("verify.flagged.some", { count: v.flaggedRows, n: fmtNum(v.flaggedRows) })
        : soft
          ? t("verify.flagged.noneWithNotes", { count: soft, n: fmtNum(soft) })
          : t("verify.flagged.none"),
    },
  ];
  return (
    <Card
      className="vcard"
      title={t("verify.title")}
      description={t("verify.desc")}
      actions={
        verifying ? (
          <span className="t3 s12 row center-y gap8">
            <Icon name="spin" className="spin" size={14} /> {t("verify.checking")}
          </span>
        ) : v.verdict === "ok" ? (
          <StatusPill tone="green">{t("verify.ok")}</StatusPill>
        ) : (
          <StatusPill tone="yellow">
            {t("verify.toCheck", { count: v.issues.length, n: fmtNum(v.issues.length) })}
          </StatusPill>
        )
      }
    >
      <ul className="vchecks" data-testid="map-verify">
        {items.map((it) => (
          <li
            key={it.label}
            className={it.ok === null ? "na" : it.ok ? "ok" : "bad"}
          >
            <Icon name={it.ok === null ? "info" : it.ok ? "ok" : "warn"} />
            <span className="vl">{it.label}</span>
            <span className="vv">{it.value}</span>
          </li>
        ))}
      </ul>
      {tFill > 0 && v.issues.length > 0 && (
        <ul className="issue-list compact">
          {v.issues.map((msg, i) => (
            <li key={i}>
              <Icon name="warn" /> <span>{msg}</span>
            </li>
          ))}
        </ul>
      )}
      {(examples.length > 0 || soft > 0) && (
        <details className="vex">
          <summary>
            <Icon name="chev" className="raw-chev" /> {t("verify.showExamples")}
          </summary>
          <ul>
            {[...examples, ...v.rowFlags.filter((r) => !r.codes.some(isHard))]
              .slice(0, 20)
              .map((r: RowFlag) => (
                <li key={r.rowIndex}>
                  <span className="mono">{t("verify.row", { n: fmtNum(r.rowIndex + 1) })}</span>
                  <span>
                    {r.codes.map((code) => (
                      <span
                        key={code}
                        className={`tag sm nodot ${isHard(code) ? "yellow" : "gray"}`}
                      >
                        {flagText(code)}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
