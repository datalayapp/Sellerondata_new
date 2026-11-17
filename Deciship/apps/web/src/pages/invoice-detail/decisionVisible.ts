import type { InvoiceLine } from "../../api/types";

/** Karar rozeti yalnız itiraz kapsamındaki (DIFF) satırlarda gösterilir; Uyumlu'ya dönen satırın eski kararı sunucuda da sayılmaz. */
export function showsDecision(l: Pick<InvoiceLine, "status" | "decision">): boolean {
  return l.status === "DIFF" && l.decision !== "OPEN";
}
