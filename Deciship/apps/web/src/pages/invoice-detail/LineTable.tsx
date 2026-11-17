import { showsDecision } from "./decisionVisible";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { InvoiceLine } from "../../api/types";
import { usePermission } from "../../auth/AuthContext";
import {
  DecisionTag,
  DiffTags,
  Empty,
  StatusTag,
  rowProps,
} from "../../components/ui";
import { fmtDate, fmtDims, fmtKg, fmtMoney, fmtMoneySigned } from "../../lib/format";
import { DECISION_LABEL } from "../../lib/labels";
import { i18n } from "../../i18n";
import { OutcomeTag } from "../disputes/parts";
import { isPakNote } from "@deciship/core";
import { flagText } from "../invoice-upload/uploadUtils";
import {
  badFields,
  billedDims,
  fxTitle,
  hardFlagsOf,
  needsReadCheck,
  type Tab,
} from "./lineUtils";
import { pendingKey } from "./recalc";

export function EmptyTab({
  tab,
  filtered,
  compared,
}: {
  tab: Tab;
  filtered: boolean;
  /** matched + diff lines; 0 → nothing has been compared yet */
  compared?: number;
}) {
  const { t } = useTranslation("invoiceDetail");
  if (!filtered && tab === "DIFF" && compared === 0)
    return (
      <Empty icon="doc" title={t("empty.noMeasured.title")}>
        {t("empty.noMeasured.body")}
      </Empty>
    );
  if (filtered)
    return (
      <Empty icon="search" title={t("empty.filtered.title")}>
        {t("empty.filtered.body")}
      </Empty>
    );
  const map: Record<Tab, [string, string]> = {
    DIFF: [t("empty.DIFF.title"), t("empty.DIFF.body")],
    UNMATCHED: [t("empty.UNMATCHED.title"), t("empty.UNMATCHED.body")],
    MATCH: [t("empty.MATCH.title"), t("empty.MATCH.body")],
    NO_TARIFF: [t("empty.NO_TARIFF.title"), ""],
    FLAGGED: [t("empty.FLAGGED.title"), t("empty.FLAGGED.body")],
    ALL: [t("empty.ALL.title"), t("empty.ALL.body")],
  };
  return (
    <Empty icon={tab === "DIFF" ? "ok" : "doc"} title={map[tab][0]}>
      {map[tab][1]}
    </Empty>
  );
}

const NB = "\u00a0";
/**
 * "İncele" ipucundaki neden: kısa etiket (`reviewCode`) ve fiyat görene ayrıntılı gerekçe. Gerekçe tutar içerebilir
 * (ör. başka faturadaki farklı tutar); fiyat izni olmayan yalnız kısa etiketi görür.
 */
export function reviewReason(l: InvoiceLine, showPrices: boolean): string {
  const label = l.reviewCode ? i18n.t(`reviewCode.${l.reviewCode}`) : null;
  const detail = showPrices ? (l.confidenceReason ?? null) : null;
  // etiket ile ayrıntı aynıysa neden bir kez yazılır
  const parts = [label, detail && detail !== label ? detail : null].filter(Boolean);
  return parts.length ? `: ${parts.join(" — ")}` : "";
}

/** Dar sütunda "ücretli 6,0 kg" bölünmez; satır yalnız ayraçtan kırılır. */
const keepKg = (s: string) => s.replaceAll(" ", NB).replaceAll(`${NB}·${NB}`, `${NB}· `);

/** Satır seçim kutusu (Mesaj 14): kutuya tıklamak satırı açmaz; uygun olmayan satırın kutusu kapalıdır ve nedeni ipucunda yazar. */
export interface LineBox {
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

/** Tek kutu: satırda ya da başlıkta (`mixed`: sayfada bazı satırlar seçili). */
export function SelectBox({ label, title, checked, mixed, disabled, onChange }: { label: string; title?: string; checked: boolean; mixed?: boolean; disabled?: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(mixed) && !checked;
  }, [mixed, checked]);
  return (
    <label className={`ln-sel${disabled ? " off" : ""}`} title={title}>
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} />
    </label>
  );
}

export function LineRow({
  l,
  cur,
  selected,
  compact,
  box,
  onOpen,
}: {
  l: InvoiceLine;
  cur: string;
  selected: boolean;
  compact: boolean;
  /** Verilirse satırın başında seçim kutusu çizilir. */
  box?: LineBox;
  onOpen: () => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const showPrices = usePermission("deciship.prices.view");
  const m = l.measurement;
  const c = l.currency ?? cur;
  const bad = badFields(l);
  const over = l.diffAmount != null && l.diffAmount > 0 && l.status === "DIFF";
  // SPEC §3.8: tahmini (LOW güvenli) fark Fazla ödeme'ye girmez
  const estimated = l.status === "DIFF" && l.confidence === "LOW";
  // Mesaj 5 (Y2): "İncele" rozeti güveni düşük her satırda; uyumlu çıkan satırda da (ör. hizmeti tarifeden farklı)
  const review = l.confidence === "LOW";
  return (
    <tr {...rowProps(onOpen, selected)}>
      {box && (
        // kutu satırı açmaz: tıklama ve tuş buradan satıra yükselmez
        <td className="ln-c-sel" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <SelectBox
            label={`${t("bulk.selectLine")} ${l.trackingNo}`}
            title={box.disabled ? t("bulk.notEligible") : undefined}
            checked={box.checked}
            disabled={box.disabled}
            onChange={box.onToggle}
          />
        </td>
      )}
      <td className="card-title">
        <span className="ln-id" title={l.service ?? undefined}>
          <span className="id mono">{l.trackingNo}</span>
          <span className="sub">
            {[l.destCountry, l.shipDate && fmtDate(l.shipDate)]
              .filter(Boolean)
              .join(" · ") || t("line.rowNo", { n: l.rowIndex + 1 })}
          </span>
        </span>
      </td>
      <td data-label={t("line.status")} className="ln-status">
        <span className="ln-tags">
          {l.status === "DIFF" && l.diffTypes.length ? (
            <DiffTags types={l.diffTypes} />
          ) : (
            <StatusTag status={l.status} />
          )}
          {needsReadCheck(l) && (
            <span
              className="tag yellow"
              title={hardFlagsOf(l)
                .map((c) => flagText(c))
                .join("\n")}
            >
              {t("line.readCheck")}
            </span>
          )}
          {review && (
            <span
              className="tag sm nodot yellow ln-est"
              title={t(estimated ? "line.estimatedTitle" : "line.reviewTitle", { reason: reviewReason(l, showPrices) })}
            >
              {t("line.estimated")}
            </span>
          )}
          {l.recalcPending && (
            <span
              className="tag sm nodot yellow ln-recalc"
              title={l.recalcPendingAt ? t("recalc.pendingSince", { date: fmtDate(l.recalcPendingAt) }) : undefined}
            >
              {t(pendingKey(l.recalcPending))}
            </span>
          )}
          {!compact && !showPrices && showsDecision(l) && (
            <span className="ln-dec-inline">
              {l.dispute ? <OutcomeTag outcome={l.dispute.outcome} line /> : <DecisionTag decision={l.decision} />}
            </span>
          )}
          {l.fx && (
            <span className="tag sm gray ln-fx" title={fxTitle(l.fx)}>
              {t("line.fx")}
            </span>
          )}
        </span>
        {l.note && !compact && (
          <span className="sub ellipsis ln-note" title={l.note}>
            {l.note}
          </span>
        )}
      </td>
      <td data-label={t("cols.ourMeasurement")} className="r num">
        {m ? (
          <span className="ln-dim">
            <span className="mono">
              {fmtDims(m.lengthCm, m.widthCm, m.heightCm)}
            </span>
            <span className="sub">
              <span className="ln-kg-actual">
                {keepKg(fmtKg(m.weightKg))}
                {NB}·{" "}
              </span>
              {keepKg(t("line.billable"))}
              {NB}
              {keepKg(fmtKg(l.ourChargeableKg))}
            </span>
          </span>
        ) : (
          // pak/zarf satırına koli ölçümü aranmaz (core PAK_NOTE)
          <span className="t3">{isPakNote(l.note) ? t("line.outOfScope") : t("line.noMeasurement")}</span>
        )}
      </td>
      <td data-label={t("cols.billedMeasurement")} className="r num">
        <span className="ln-dim">
          <span className={`mono${bad.dims ? " bad" : ""}`}>
            {billedDims(l) ?? "—"}
          </span>
          <span className="sub">
            <span className={`ln-kg-actual${bad.actual ? " keep" : ""}`}>
              <span className={bad.actual ? "bad" : undefined}>
                {keepKg(l.actualKg != null ? fmtKg(l.actualKg) : "—")}
              </span>
              {NB}·{" "}
            </span>
            {keepKg(t("line.billable"))}
            {NB}
            <span className={bad.chargeable ? "bad" : undefined}>
              {keepKg(fmtKg(l.billedChargeableKg ?? l.billedKg))}
            </span>
          </span>
        </span>
      </td>
      {!compact && showPrices && (
        <td data-label={t("cols.expected")} className="r num col-amt">
          {fmtMoney(l.expectedAmount, c)}
        </td>
      )}
      {!compact && showPrices && (
        <td data-label={t("cols.billed")} className="r num col-amt">
          {fmtMoney(l.netAmount, c)}
        </td>
      )}
      {showPrices && (
        <td
          data-label={t("cols.discrepancy")}
          className={`r num ln-diff ${over ? (estimated ? "sb" : "red sb") : l.diffAmount != null && l.diffAmount < 0 ? "green" : ""}`}
        >
          {l.diffAmount != null ? fmtMoneySigned(l.diffAmount, c) : "—"}
          {!compact && (showsDecision(l) || l.status === "DIFF") && (
            <span className="ln-dec-sub">
              {l.dispute
                ? i18n.t(l.dispute.outcome === "PENDING" ? "card.lockedDecision" : `outcome.${l.dispute.outcome}`, { ns: "disputes" })
                : l.decision === "OPEN"
                  ? t("filters.pending")
                  : DECISION_LABEL[l.decision]}
            </span>
          )}
        </td>
      )}
      {!compact && (
        <td
          data-label={t("cols.decision")}
          className={
            (l.decision === "OPEN" || !showsDecision(l)) && l.status !== "DIFF"
              ? "ln-c-dec ln-nodec"
              : "ln-c-dec"
          }
        >
          {l.dispute ? (
            <OutcomeTag outcome={l.dispute.outcome} line />
          ) : l.decision === "OPEN" ? (
            l.status === "DIFF" ? (
              <span className="await">{t("filters.pending")}</span>
            ) : null
          ) : !showsDecision(l) ? null : (
            <DecisionTag decision={l.decision} />
          )}
        </td>
      )}
    </tr>
  );
}
