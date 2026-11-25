import type { Issue, JobSummary, VariantSummary } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import { approveCheck, fixStep, focusedVariant, freshestJob, mergeIssues, orderNoValue, textCommit } from "./masa.ts";

const variant = (over: Partial<VariantSummary> = {}): VariantSummary => ({
  id: "v1",
  jobId: "j",
  no: 1,
  kind: "text",
  score: null,
  aiRank: null,
  suspect: false,
  approved: false,
  stale: false,
  previewUrl: "/p.png",
  worst: null,
  issueCount: 0,
  createdAt: "2026-10-09T10:00:00.000Z",
  ...over,
});

let seq = 0;
const job = (over: Partial<JobSummary> = {}): JobSummary => {
  seq++;
  return {
    id: `j${seq}`,
    batchId: "b1",
    languageId: "l",
    seq,
    orderNo: null,
    quantity: null,
    templateKey: null,
    labelSize: null,
    product: null,
    text: "Metin",
    segments: [],
    kind: "label",
    aiNote: "",
    status: "new",
    error: null,
    approvedVariantId: null,
    issues: [],
    worst: null,
    variants: [],
    createdAt: `2026-10-09T10:00:${String(seq).padStart(2, "0")}.000Z`,
    updatedAt: "2026-10-09T10:00:00.000Z",
    ...over,
  };
};
const issue = (over: Partial<Issue> = {}): Issue => ({ code: "text-missing", severity: "warning", message: "m", fixes: [], ...over });

describe("iş ve varyasyon", () => {
  it("en yeni hâl: ayrıntı eskiyse liste üste yazılır", () => {
    const list = job({ text: "yeni", updatedAt: "2026-10-09T11:00:00.000Z" });
    const detail = { ...list, text: "eski", updatedAt: "2026-10-09T10:00:00.000Z", textRaw: "ham" };
    const r = freshestJob(detail, list);
    expect(r.text).toBe("yeni");
    expect(r.textRaw).toBe("ham");
    expect(freshestJob({ ...detail, updatedAt: "2026-10-09T12:00:00.000Z" }, list).text).toBe("eski");
    expect(freshestJob(undefined, list)).toEqual(list);
  });
  it("seçili varyasyon: seçilen, yoksa öne çıkan", () => {
    const vs = [variant({ id: "a", no: 1, aiRank: 2 }), variant({ id: "b", no: 2, aiRank: 1 })];
    const j = { variants: vs, approvedVariantId: null };
    expect(focusedVariant(vs, "a", j)?.id).toBe("a");
    expect(focusedVariant(vs, "silinmis", j)?.id).toBe("b");
    expect(focusedVariant([], null, { variants: [], approvedVariantId: null })).toBeNull();
  });
  it("onay öncesi denetim", () => {
    expect(approveCheck(null)).toBe("skip");
    expect(approveCheck(variant({ approved: true }))).toBe("skip");
    expect(approveCheck(variant({ stale: true }))).toBe("confirm-stale");
    expect(approveCheck(variant())).toBe("ok");
  });
  it("sorunlar birleşir, ağır olan önce", () => {
    const a = issue({ code: "text-missing", severity: "info", message: "x" });
    const b = issue({ code: "quantity-missing", severity: "error", message: "y" });
    expect(mergeIssues([a, b], [a]).map((i) => i.code)).toEqual(["quantity-missing", "text-missing"]);
  });
  it("metin ve sipariş no alanı", () => {
    expect(textCommit("a", "a")).toBe("same");
    expect(textCommit("  ", "a")).toBe("empty");
    expect(textCommit("b", "a")).toBe("save");
    expect(orderNoValue("  ")).toBeNull();
    expect(orderNoValue(" 77 ")).toBe("77");
  });
});

describe("sorun düzeltme", () => {
  const j = { text: "𝓔𝓵𝓲𝓯", templateKey: "a15", dismissed: ["sticker-detected" as const] };
  it("değerli düzeltmeler doğrudan uygulanır, değersizler alana götürür", () => {
    expect(fixStep(issue(), { kind: "edit-text" }, j, true)).toEqual({ do: "focus", field: "text" });
    expect(fixStep(issue(), { kind: "convert-unicode", value: "Elif" }, j, true)).toEqual({ do: "patch", patch: { text: "Elif" }, undo: { text: "𝓔𝓵𝓲𝓯" } });
    expect(fixStep(issue(), { kind: "convert-unicode" }, j, true)).toEqual({ do: "focus", field: "text" });
    expect(fixStep(issue(), { kind: "choose-template", value: "b2" }, j, true)).toEqual({ do: "patch", patch: { templateKey: "b2" } });
    expect(fixStep(issue(), { kind: "choose-template" }, j, true)).toEqual({ do: "pickTemplate" });
    expect(fixStep(issue(), { kind: "set-size", value: "3.8" }, j, true)).toEqual({ do: "patch", patch: { labelSize: "3.8" } });
    expect(fixStep(issue(), { kind: "set-size" }, j, true)).toEqual({ do: "focus", field: "size" });
    expect(fixStep(issue(), { kind: "set-quantity", value: "60" }, j, true)).toEqual({ do: "patch", patch: { quantity: 60 } });
    expect(fixStep(issue(), { kind: "set-quantity" }, j, true)).toEqual({ do: "focus", field: "quantity" });
    expect(fixStep(issue(), { kind: "set-order" }, j, true)).toEqual({ do: "focus", field: "order" });
  });
  it("şablonu aç, yeniden üret, şunu değiştir", () => {
    expect(fixStep(issue(), { kind: "open-template" }, j, true)).toEqual({ do: "openTemplate", key: "a15" });
    expect(fixStep(issue(), { kind: "open-template", value: "c3" }, j, true)).toEqual({ do: "openTemplate", key: "c3" });
    expect(fixStep(issue(), { kind: "open-template" }, { ...j, templateKey: null }, true)).toEqual({ do: "none" });
    expect(fixStep(issue(), { kind: "regenerate" }, j, true)).toEqual({ do: "regenerate" });
    expect(fixStep(issue(), { kind: "revise", value: "küçült" }, j, true)).toEqual({ do: "revise", request: "küçült" });
    expect(fixStep(issue(), { kind: "revise", value: "küçült" }, j, false)).toEqual({ do: "draftRevise", request: "küçült" });
    expect(fixStep(issue(), { kind: "revise" }, j, true)).toEqual({ do: "draftRevise", request: undefined });
  });
  it("yok say: hata yok sayılamaz; uyarı listeye bir kez eklenir", () => {
    expect(fixStep(issue({ severity: "error" }), { kind: "dismiss" }, j, true)).toEqual({ do: "refuse" });
    expect(fixStep(issue({ code: "sticker-detected" }), { kind: "skip" }, j, true)).toEqual({ do: "patch", patch: { dismissed: ["sticker-detected"] } });
    expect(fixStep(issue({ code: "text-missing" }), { kind: "dismiss" }, j, true)).toEqual({ do: "patch", patch: { dismissed: ["sticker-detected", "text-missing"] } });
  });
});
