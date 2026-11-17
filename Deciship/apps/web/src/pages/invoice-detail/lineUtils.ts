import type { QueryClient } from "@tanstack/react-query";
import { i18n } from "../../i18n";
import { DECISION_LABEL, DIFF_LABEL, STATUS_LABEL } from "../../lib/labels";
import type { Decision, DiffType, Invoice, InvoiceLine, InvoiceTotals, LineStatus, Page } from "../../api/types";
import {
  HARD_ROW_FLAGS,
  fmtFxRate,
  fxSourceText,
  type FxApplied,
  type RowFlagCode,
} from "@deciship/core";
import { fmtDims, getFormatLocale } from "../../lib/format";

export const PAGE_SIZE = 50;
export type Tab = "DIFF" | "UNMATCHED" | "MATCH" | "NO_TARIFF" | "FLAGGED" | "ALL";

/** SPEC §11: okuma kontrolü bayrakları (sert olanlar rozet ve "Kontrol edilecek" sekmesini belirler). */
export const hardFlagsOf = (l: InvoiceLine) =>
  (l.parseFlags ?? []).filter((c) => HARD_ROW_FLAGS.includes(c as RowFlagCode));
export const needsReadCheck = (l: InvoiceLine) =>
  !l.parseChecked && hardFlagsOf(l).length > 0;
/** SPEC §FX: "1 USD = 41,2345 TRY · TCMB 03.06.2025" */
export const fxTitle = (fx: FxApplied) =>
  i18n.t("invoiceDetail:fxTitle", {
    base: fx.base,
    rate: fmtFxRate(fx.rate, getFormatLocale()),
    quote: fx.quote,
    source: fxSourceText(fx, getFormatLocale()),
  });

/** Durum, fark türü ve karar etiketleri: anahtarlı çeviri; ortak Türkçe etiket yalnız yedek. */
export const statusLabel = (s: LineStatus): string =>
  i18n.t(`invoiceDetail:status.${s}`, { defaultValue: STATUS_LABEL[s] });
export const diffLabel = (k: DiffType): string =>
  i18n.t(`invoiceDetail:diffType.${k}`, { defaultValue: DIFF_LABEL[k] });
export const decisionLabel = (k: Decision): string =>
  i18n.t(`invoiceDetail:decision.${k}`, { defaultValue: DECISION_LABEL[k] });


export function billedDims(l: InvoiceLine) {
  return l.dimL != null && l.dimW != null && l.dimH != null
    ? fmtDims(l.dimL, l.dimW, l.dimH)
    : null;
}

/** Which billed values disagree with our measurement (drives red highlighting). */
export function badFields(l: InvoiceLine) {
  const m = l.measurement;
  const dim = l.diffTypes.includes("DIMENSION");
  const wt = l.diffTypes.includes("WEIGHT");
  const billedCh = l.billedChargeableKg ?? l.billedKg;
  const differs = (a?: number | null, b?: number | null) =>
    a != null && b != null && Math.abs(a - b) > 0.049;
  return {
    dims: dim,
    actual: wt && Boolean(m) && differs(l.actualKg, m?.weightKg),
    chargeable: (dim || wt) && (differs(billedCh, l.ourChargeableKg) || !m),
  };
}

/** Write a PATCH /invoice-lines response into the caches right away, then refetch everything it touches. */
export function applyLinePatch(
  qc: QueryClient,
  invoiceId: string,
  line: InvoiceLine,
  totals?: InvoiceTotals,
) {
  qc.setQueriesData<Page<InvoiceLine>>(
    { queryKey: ["invoice", invoiceId, "lines"] },
    (old) =>
      old
        ? {
            ...old,
            items: old.items.map((x) =>
              x.id === line.id ? { ...x, ...line } : x,
            ),
          }
        : old,
  );
  if (totals)
    qc.setQueryData<Invoice>(["invoice", invoiceId], (old) =>
      old ? { ...old, totals } : old,
    );
  qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
  qc.invalidateQueries({ queryKey: ["invoices"] });
  qc.invalidateQueries({ queryKey: ["dashboard"] });
  qc.invalidateQueries({ queryKey: ["measurements"] });
  qc.invalidateQueries({ queryKey: ["measurement"] });
}
