import { Trans, useTranslation } from "react-i18next";
import type { InvoicePdfCheck } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Button, Empty } from "../../components/ui";
import { WeightFormatChoice } from "../../components/WeightChoice";
import { fmtMoney, fmtNum } from "../../lib/format";
import { applyPdfWeightChoice, pdfCellInvalid, pdfCellWeightChoice, pdfRowCurrency, pdfTotalsByCurrency, pdfWeightAmbiguity, type PdfRow } from "./pdfRowParse";
import { nextPdfRowIndex } from "./pdfRows";
import { flagText } from "./uploadUtils";

// ---------------- Step 2: PDF ----------------
// Satır tipi ve okuma kuralı (kg/ölçü `parseMeasure`, tutar `parseTrNumber`; 10-B7; "1.500" kg sorusu K36) saf dosyada: `pdfRowParse.ts`.
export { fromPdfRow, pdfRowInvalid, pdfWeightConfirmed, relocalizePdfRows, toPdfRow, withPdfWeightAsks, type PdfRow } from "./pdfRowParse";

/** PDF metin denetiminin bayrağı → işaretlenen hücreler (§3.15; ağırlık, ölçü 05-B4). */
const UNVERIFIED_CELLS: Record<string, readonly (keyof PdfRow)[]> = {
  PDF_TRACKING_UNVERIFIED: ["trackingNo"],
  PDF_AMOUNT_UNVERIFIED: ["netAmount"],
  PDF_WEIGHT_UNVERIFIED: ["actualKg", "billedKg"],
  PDF_DIMS_UNVERIFIED: ["l", "w", "h"],
};

export function PdfLinesStep({
  warning,
  rows,
  setRows,
  currency,
  pdfCheck,
  aiSkipped,
  aiCached,
  onReread,
}: {
  pdfCheck?: InvoicePdfCheck;
  aiSkipped?: { count: number; amount?: number };
  /** okuma önceki sonuçtan geldi (ücretsiz) */
  aiCached?: boolean;
  /** Y62-E3 "Yeniden oku" (ücretli); yoksa bağlantı çıkmaz (okuma kapalı ya da hak doldu) */
  onReread?: () => void;
  warning?: string;
  rows: PdfRow[];
  setRows: (r: PdfRow[]) => void;
  currency: string;
}) {
  const { t } = useTranslation("invoiceUpload");
  const set = (i: number, k: keyof PdfRow, v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const codesByRow = new Map((pdfCheck?.rows ?? []).map((x) => [x.rowIndex, x.codes as string[]]));
  const surchargeUnverified = (r: PdfRow) => codesByRow.get(r.rowIndex)?.includes("PDF_SURCHARGE_UNVERIFIED") ?? false;
  // 01-B8: toplam para birimine göre ayrı (farklı paralar toplanmaz); faturanınkinden farklı satır varsa uyarı
  const totals = pdfTotalsByCurrency(rows, currency);
  const invoiceCur = currency.trim().toUpperCase();
  const foreign = totals.filter((x) => x.currency !== invoiceCur);
  const foreignCount = foreign.reduce((n, x) => n + x.count, 0);
  // K36: "1.500" kg gibi iki türlü okunan ağırlıklar: tek soru, seçim hepsine uygulanır
  const weightAmb = pdfWeightAmbiguity(rows);
  const cols: {
    k: keyof PdfRow;
    label: string;
    w?: number;
    num?: boolean;
    mono?: boolean;
  }[] = [
    { k: "trackingNo", label: t("pdf.cols.trackingNo"), w: 170, mono: true },
    { k: "shipDate", label: t("pdf.cols.date"), w: 110 },
    { k: "destCountry", label: t("pdf.cols.country"), w: 56 },
    { k: "service", label: t("pdf.cols.service"), w: 120 },
    { k: "actualKg", label: t("pdf.cols.actualKg"), w: 80, num: true },
    { k: "billedKg", label: t("pdf.cols.billedKg"), w: 80, num: true },
    { k: "l", label: t("pdf.cols.length"), w: 56, num: true },
    { k: "w", label: t("pdf.cols.width"), w: 56, num: true },
    { k: "h", label: t("pdf.cols.height"), w: 56, num: true },
    { k: "netAmount", label: t("pdf.cols.netAmount"), w: 110, num: true },
  ];
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="notif warn">
        <Icon name="warn" />
        <span>
          <b>{warning ?? t("pdf.defaultWarning")}.</b> {t("pdf.editHint")}
          {aiCached && <> {t("pdf.cachedNote")}</>}
        </span>
        {onReread && (
          <button type="button" className="link-btn act" onClick={onReread} data-testid="pdf-reread">
            <Icon name="refresh" /> {t("pdf.reread")}
          </button>
        )}
      </div>
      {pdfCheck && pdfCheck.unverified > 0 && (
        <div className="notif warn">
          <Icon name="warn" />
          <span>{t("pdf.unverified", { count: pdfCheck.unverified })}</span>
        </div>
      )}
      {pdfCheck?.method === "none" && (
        <div className="notif warn">
          <Icon name="warn" />
          <span>{t("pdf.noTextLayer")}</span>
        </div>
      )}
      {foreignCount > 0 && (
        <div className="notif warn" data-testid="pdf-currency-mixed">
          <Icon name="warn" />
          <span>
            {t("pdf.currencyMixed", {
              count: foreignCount,
              n: fmtNum(foreignCount),
              parts: foreign.map((x) => `${fmtNum(x.count)} ${x.currency}`).join(", "),
              invoice: invoiceCur,
            })}
          </span>
        </div>
      )}
      {weightAmb && (
        <div className="notif warn" data-testid="pdf-weight-ambiguous">
          <Icon name="warn" />
          <div>
            {t("pdf.weightAmbiguous", { sample: weightAmb.samples.map((s) => s.text).join(", ") })}
            <WeightFormatChoice samples={weightAmb.samples} onPick={(fmt) => setRows(applyPdfWeightChoice(rows, fmt))} />
          </div>
        </div>
      )}
      {aiSkipped && aiSkipped.count > 0 && (
        <div className="notif warn">
          <Icon name="warn" />
          <span>
            {t("pdf.aiSkipped", {
              count: aiSkipped.count,
              n: fmtNum(aiSkipped.count),
              amount: aiSkipped.amount != null ? fmtMoney(aiSkipped.amount, currency) : "",
            })}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty
          compact
          icon="doc"
          title={t("pdf.emptyTitle")}
          actions={
            <Button icon="plus" onClick={() => setRows([blankRow(nextPdfRowIndex(rows))])}>
              {t("pdf.addRow")}
            </Button>
          }
        >
          {t("pdf.emptyBody")}
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="dt edit-grid">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                {cols.map((c) => (
                  <th
                    key={c.k}
                    className={c.num ? "r" : ""}
                    style={{ width: c.w }}
                  >
                    {c.label}
                  </th>
                ))}
                <th className="r" style={{ width: 110 }}>
                  {t("pdf.cols.surcharge")}
                </th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td className="ro num">{i + 1}</td>
                  {cols.map((c) => {
                    const v = r[c.k] as string;
                    const invalid = pdfCellInvalid(r, c.k);
                    const codes = codesByRow.get(r.rowIndex);
                    const unverified = codes?.some((code) => UNVERIFIED_CELLS[code]?.includes(c.k)) ?? false;
                    const ambiguous = pdfCellWeightChoice(r, c.k) !== null;
                    return (
                      <td key={c.k}>
                        <input
                          aria-label={t("pdf.cellLabel", { row: i + 1, col: c.label })}
                          title={ambiguous ? t("pdf.cellWeightAmbiguous") : unverified ? t("pdf.cellUnverified") : undefined}
                          className={`cell${c.num ? " num" : ""}${c.mono ? " mono" : ""}${invalid || unverified ? " invalid" : ""}`}
                          type={c.k === "shipDate" ? "date" : "text"}
                          inputMode={c.num ? "decimal" : undefined}
                          value={v}
                          onChange={(e) => set(i, c.k, e.target.value)}
                        />
                      </td>
                    );
                  })}
                  {/* Ek ücretin düzenlenecek hücresi yok: metinde bulunamadıysa yalnız etiket (ipucu) ve uyarı rengi */}
                  <td
                    className={`ro r num${surchargeUnverified(r) ? " warn-t" : ""}`}
                    title={[
                      ...(surchargeUnverified(r) ? [flagText("PDF_SURCHARGE_UNVERIFIED")] : []),
                      ...r.surcharges.map((s) => `${s.code}: ${fmtMoney(s.amount, pdfRowCurrency(r, currency))}`),
                    ].join("\n")}
                  >
                    {r.surcharges.length
                      ? fmtMoney(
                          r.surcharges.reduce((s, x) => s + x.amount, 0),
                          pdfRowCurrency(r, currency),
                        )
                      : "—"}
                  </td>
                  <td>
                    <Button
                      kind="plain"
                      small
                      icon="trash"
                      aria-label={t("pdf.deleteRow", { row: i + 1 })}
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row center-y">
        <Button
          kind="secondary"
          small
          icon="plus"
          onClick={() => setRows([...rows, blankRow(nextPdfRowIndex(rows))])}
        >
          {t("pdf.addRow")}
        </Button>
        <span className="muted" style={{ marginLeft: "auto" }}>
          <Trans
            t={t}
            i18nKey="pdf.total"
            count={rows.length}
            values={{
              n: fmtNum(rows.length),
              total: totals.length ? totals.map((x) => fmtMoney(x.total, x.currency)).join(" + ") : fmtMoney(0, currency),
            }}
            components={{ b: <b className="num" /> }}
          />
        </span>
      </div>
    </div>
  );
}

/** `rowIndex`: `nextPdfRowIndex` (okunan satırlarla çakışmaz, Y23). */
function blankRow(rowIndex: number): PdfRow {
  const id = crypto.randomUUID();
  return {
    key: id,
    rowIndex,
    rawHash: `manual-${id}`,
    trackingNo: "",
    shipDate: "",
    destCountry: "",
    service: "",
    actualKg: "",
    billedKg: "",
    l: "",
    w: "",
    h: "",
    netAmount: "",
    surcharges: [],
    extra: {},
  };
}
