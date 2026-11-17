import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImportReport } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/ui";
import { fmtMoney, fmtNum } from "../../lib/format";
import { IMPORT_REPORT_ROW_LIMIT, importReportNotice, skippedValue } from "./reportLogic";

/** Özet kartında fazla ödemenin altında tek satır: alınmayan satırlar, PDF'te doğrulanamayanlar. Rapor yoksa hiçbir şey çizmez. */
export function ImportReportNotice({ report, currency }: { report?: ImportReport | null; currency: string }) {
  const { t } = useTranslation("invoiceDetail");
  const [open, setOpen] = useState(false);
  const n = importReportNotice(report);
  if (!n || !report) return null;
  const parts: string[] = [];
  if (n.skipped > 0) parts.push(t("importReport.notice", { count: n.skipped, n: fmtNum(n.skipped) }));
  if (n.noTracking > 0) {
    const key = n.noTrackingAmount != null ? "importReport.noTracking" : "importReport.noTrackingNoAmount";
    parts.push(t(key, { count: n.noTracking, n: fmtNum(n.noTracking), amount: fmtMoney(n.noTrackingAmount ?? 0, currency) }));
  }
  if (n.pdfUnverified > 0) parts.push(t("importReport.pdfUnverified", { count: n.pdfUnverified, n: fmtNum(n.pdfUnverified) }));
  if (n.pdfNone) parts.push(t("importReport.pdfNone"));
  if (n.pdfSkipped) parts.push(t("importReport.pdfSkipped"));
  if (n.pdfMissed > 0) parts.push(t("importReport.pdfMissed", { count: n.pdfMissed, n: fmtNum(n.pdfMissed) }));
  if (n.pdfMissedTooLarge) parts.push(t("importReport.pdfMissedTooLarge"));
  for (const r of n.readNotes) {
    parts.push(t(`importReport.read.${r.key}`, { pct: r.pct != null ? fmtNum(r.pct) : "", count: r.n ?? 0, n: fmtNum(r.n ?? 0) }));
  }
  const missed = report.pdfMissed?.trackings ?? [];
  return (
    <>
      <span className="inv-sum-warn" role="status">
        <Icon name="warn" />
        <span>
          {parts.join(" · ")}
          {(report.skippedRows.length > 0 || missed.length > 0) && (
            <>
              {" — "}
              <button type="button" className="link-btn" onClick={() => setOpen(true)}>
                {t("importReport.details")}
              </button>
            </>
          )}
        </span>
      </span>
      {open && <ImportReportModal report={report} currency={currency} onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportReportModal({ report, currency, onClose }: { report: ImportReport; currency: string; onClose: () => void }) {
  const { t } = useTranslation("invoiceDetail");
  const rows = report.skippedRows.slice(0, IMPORT_REPORT_ROW_LIMIT);
  // Y31: PDF'te geçen ama okunmamış olabilecek takip no'lar; dosyadaki satır no'ları bilinmez
  const missed = report.pdfMissed?.trackings ?? [];
  return (
    <Modal title={t("importReport.title")} size="wide" onClose={onClose}>
      <div className="inv-ir-wrap">
        <table className="inv-ir">
          <thead>
            <tr>
              <th>{t("importReport.col.row")}</th>
              <th>{t("importReport.col.reason")}</th>
              <th>{t("importReport.col.value")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const v = skippedValue(r);
              return (
                <tr key={`${r.row}-${i}`}>
                  <td className="num">{r.row}</td>
                  <td>{t(`importReport.reason.${r.reason}`)}</td>
                  <td className="num">{v.kind === "amount" ? fmtMoney(v.amount, currency) : (v.text ?? "")}</td>
                </tr>
              );
            })}
            {missed.map((tracking) => (
              <tr key={`missed-${tracking}`}>
                <td className="num">—</td>
                <td>{t("importReport.reason.PDF_NOT_READ")}</td>
                <td className="num">{tracking}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.skippedCount > rows.length && (
        <p className="inv-sum-fine">{t("importReport.more", { n: fmtNum(report.skippedCount - rows.length) })}</p>
      )}
    </Modal>
  );
}
