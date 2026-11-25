import type { JobStatus, JobSummary, VariantSummary } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import {
  afterApprove,
  allState,
  boardOf,
  isProblem,
  jobType,
  matchesQuery,
  pruneIds,
  relativeDay,
  relativeStamp,
  sectionCounts,
  sectionOf,
  shownVariant,
  sortJobs,
  stepIn,
  toggleId,
  typeCounts,
  variantAtKey,
} from "./jobs.ts";

function variant(over: Partial<VariantSummary> = {}): VariantSummary {
  return {
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
  };
}

let seqCounter = 0;
function job(over: Partial<JobSummary> = {}): JobSummary {
  seqCounter++;
  return {
    id: `j${seqCounter}`,
    batchId: "b1",
    languageId: "l",
    seq: seqCounter,
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
    createdAt: `2026-10-09T10:00:${String(seqCounter).padStart(2, "0")}.000Z`,
    updatedAt: "2026-10-09T10:00:00.000Z",
    ...over,
  };
}
const withStatus = (status: JobStatus, over: Partial<JobSummary> = {}) => job({ status, ...over });

describe("bölümler", () => {
  it("durumdan bölüm: yeni, sırada, üretiliyor ve üretilemedi bekleyenlerde", () => {
    const of = (s: JobStatus) => sectionOf({ status: s });
    expect(["new", "queued", "generating", "failed"].map((s) => of(s as JobStatus))).toEqual(["pending", "pending", "pending", "pending"]);
    expect(of("ready")).toBe("edit");
    expect(of("approved")).toBe("approved");
    expect(sectionCounts([withStatus("new"), withStatus("failed"), withStatus("ready"), withStatus("approved")])).toEqual({ pending: 2, edit: 1, approved: 1 });
  });
  it("sorunlu: uyarı, hata ya da üretilemedi; onaylının sorunu sayılmaz", () => {
    expect(isProblem(withStatus("ready", { worst: "warning" }))).toBe(true);
    expect(isProblem(withStatus("new", { worst: "error" }))).toBe(true);
    expect(isProblem(withStatus("failed"))).toBe(true);
    expect(isProblem(withStatus("approved", { worst: "error" }))).toBe(false);
    expect(isProblem(withStatus("ready"))).toBe(false);
  });
  it("ızgara: arama, sorunlu ve tip süzgeci; bölüm içinde sıralı", () => {
    const jobs = [
      withStatus("new", { id: "a", orderNo: "3", text: "Zeynep & Can", worst: "warning" }),
      withStatus("new", { id: "b", orderNo: "1", kind: "sticker" }),
      withStatus("ready", { id: "c", orderNo: "2", labelSize: "5.2" }),
      withStatus("approved", { id: "d", orderNo: "4" }),
    ];
    const ids = (f: Partial<Parameters<typeof boardOf>[1]>) => {
      const b = boardOf(jobs, { query: "", problems: false, type: null, sort: "order", dir: "asc", defaultSize: "3.8", ...f });
      return { pending: b.pending.map((j) => j.id), edit: b.edit.map((j) => j.id), approved: b.approved.map((j) => j.id) };
    };
    expect(ids({})).toEqual({ pending: ["b", "a"], edit: ["c"], approved: ["d"] });
    expect(ids({ query: "zeynep" })).toEqual({ pending: ["a"], edit: [], approved: [] });
    expect(ids({ problems: true })).toEqual({ pending: ["a"], edit: [], approved: [] });
    expect(ids({ type: "sticker" })).toEqual({ pending: ["b"], edit: [], approved: [] });
    expect(ids({ type: "size:3.8" })).toEqual({ pending: ["a"], edit: [], approved: ["d"] });
  });
});

describe("ürün tipi (şimdilik işin verisinden)", () => {
  it("sticker, etiket ölçüsü, yoksa dilin varsayılanı, o da yoksa tipsiz", () => {
    expect(jobType({ kind: "sticker", labelSize: "3.8" })).toEqual({ key: "sticker", label: "Sticker" });
    expect(jobType({ kind: "label", labelSize: "5.2" })).toEqual({ key: "size:5.2", label: "5,2 cm" });
    expect(jobType({ kind: "label", labelSize: null }, "3.8")).toEqual({ key: "size:3.8", label: "3,8 cm" });
    expect(jobType({ kind: "label", labelSize: null })).toBeNull();
  });
  it("tip çipleri çoktan aza", () => {
    const t = typeCounts([job({ labelSize: "5.2" }), job({ kind: "sticker" }), job({ labelSize: "5.2" }), job({ labelSize: null })], "3.8");
    expect(t.map((x) => [x.label, x.count])).toEqual([
      ["5,2 cm", 2],
      ["3,8 cm", 1],
      ["Sticker", 1],
    ]);
  });
});

describe("seçim ve panelde gezinme", () => {
  it("onay kutusu, hepsini seç durumu, ayıklama", () => {
    let ids: ReadonlySet<string> = new Set();
    ids = toggleId(ids, "a");
    ids = toggleId(ids, "b");
    expect([...ids]).toEqual(["a", "b"]);
    expect(allState(ids, ["a", "b", "c"])).toBe("mixed");
    expect(allState(ids, ["a", "b"])).toBe(true);
    expect(allState(new Set(), ["a"])).toBe(false);
    expect(toggleId(ids, "a").has("a")).toBe(false);
    expect([...pruneIds(ids, ["b", "c"])]).toEqual(["b"]);
    expect(pruneIds(ids, ["a", "b", "c"])).toBe(ids);
  });
  it("önceki/sonraki bölüm içinde dolanır; tek işte null", () => {
    const order = ["a", "b", "c"];
    expect(stepIn(order, "b", 1)).toBe("c");
    expect(stepIn(order, "c", 1)).toBe("a");
    expect(stepIn(order, "a", -1)).toBe("c");
    expect(stepIn(order, "x", 1)).toBe("a");
    expect(stepIn(["a"], "a", 1)).toBeNull();
    expect(stepIn([], null, 1)).toBeNull();
  });
  it("onaydan sonra: sonraki, sonda önceki, tek işte null", () => {
    expect(afterApprove(["a", "b", "c"], "b")).toBe("c");
    expect(afterApprove(["a", "b", "c"], "c")).toBe("b");
    expect(afterApprove(["a"], "a")).toBeNull();
  });
});

describe("arama", () => {
  it("aramada Türkçe büyük/küçük harf ve çoklu sözcük", () => {
    const j = job({ text: "IŞIL ve İpek", orderNo: "77", templateKey: "a15", product: "Düğün" });
    expect(matchesQuery(j, "ışıl")).toBe(true);
    expect(matchesQuery(j, "ipek ışıl")).toBe(true);
    expect(matchesQuery(j, "düğün a15")).toBe(true);
    expect(matchesQuery(j, "77")).toBe(true);
    expect(matchesQuery(j, "yok")).toBe(false);
    expect(matchesQuery(j, "   ")).toBe(true);
  });
});

describe("sıralama", () => {
  it("sipariş no sayı duyarlı, boşlar hep sonda", () => {
    const a = job({ orderNo: "10" });
    const b = job({ orderNo: "9" });
    const c = job({ orderNo: null });
    const d = job({ orderNo: "100" });
    expect(sortJobs([a, b, c, d], "order", "asc").map((j) => j.orderNo)).toEqual(["9", "10", "100", null]);
    expect(sortJobs([a, b, c, d], "order", "desc").map((j) => j.orderNo)).toEqual(["100", "10", "9", null]);
  });
  it("eklenme sırası", () => {
    const a = job();
    const b = job();
    const c = job();
    expect(sortJobs([a, c, b], "created", "asc").map((j) => j.id)).toEqual([a.id, b.id, c.id]);
    expect(sortJobs([a, c, b], "created", "desc").map((j) => j.id)).toEqual([c.id, b.id, a.id]);
  });
  it("durum: sorunlular önce; eşitlikte iş sırası", () => {
    const ready = withStatus("ready");
    const failed = withStatus("failed");
    const fresh = withStatus("new");
    const fresh2 = withStatus("new");
    expect(sortJobs([ready, fresh2, failed, fresh], "status", "asc").map((j) => j.id)).toEqual([failed.id, fresh.id, fresh2.id, ready.id]);
  });
  it("şablon ve girdiyi değiştirmez", () => {
    const a = job({ templateKey: "b2" });
    const b = job({ templateKey: "a15" });
    const c = job({ templateKey: null });
    const input = [a, b, c];
    expect(sortJobs(input, "template", "asc").map((j) => j.templateKey)).toEqual(["a15", "b2", null]);
    expect(sortJobs(input, "template", "desc").map((j) => j.templateKey)).toEqual(["b2", "a15", null]);
    expect(input[0]).toBe(a);
  });
});

describe("gösterilecek varyasyon", () => {
  it("onaylı > AI sırası > puan > sonuncu; eski ve kontrol işaretlileri geride", () => {
    expect(shownVariant({ variants: [], approvedVariantId: null })).toBeNull();
    const v1 = variant({ id: "1", no: 1, aiRank: 2, score: 0.5 });
    const v2 = variant({ id: "2", no: 2, aiRank: 1, score: 0.4 });
    const v3 = variant({ id: "3", no: 3, aiRank: 3, approved: true });
    expect(shownVariant({ variants: [v1, v2, v3], approvedVariantId: "3" })?.id).toBe("3");
    expect(shownVariant({ variants: [v1, v2], approvedVariantId: null })?.id).toBe("2");
    expect(shownVariant({ variants: [{ ...v2, suspect: true }, v1], approvedVariantId: null })?.id).toBe("1");
    expect(shownVariant({ variants: [{ ...v2, aiRank: null, score: 0.1 }, { ...v1, aiRank: null, score: 0.9 }], approvedVariantId: null })?.id).toBe("1");
    expect(shownVariant({ variants: [{ ...v1, stale: true }, v2], approvedVariantId: null })?.id).toBe("2");
    expect(shownVariant({ variants: [variant({ id: "x", no: 1 }), variant({ id: "y", no: 2 })], approvedVariantId: null })?.id).toBe("y");
  });
  it("1–9 kısayolu konuma göre", () => {
    const vs = [variant({ id: "b", no: 2 }), variant({ id: "a", no: 1 })];
    expect(variantAtKey(vs, 1)?.id).toBe("a");
    expect(variantAtKey(vs, 2)?.id).toBe("b");
    expect(variantAtKey(vs, 3)).toBeNull();
  });
});

describe("göreli tarih", () => {
  const now = new Date(2026, 9, 9, 15, 0); // 9 Ekim 2026
  const at = (y: number, m: number, d: number, h = 14, min = 20) => new Date(y, m, d, h, min).toISOString();
  it("bugün, dün, gün adı, tarih", () => {
    expect(relativeDay(at(2026, 9, 9), now)).toBe("Bugün");
    expect(relativeDay(at(2026, 9, 8, 23, 50), now)).toBe("Dün");
    expect(relativeDay(at(2026, 9, 6), now)).toBe("Salı");
    expect(relativeDay(at(2026, 9, 2), now)).toBe("2 Eki");
    expect(relativeDay(at(2025, 11, 30), now)).toContain("2025");
    expect(relativeDay("bozuk", now)).toBe("");
  });
  it("damga: bugün ve dün saatli", () => {
    expect(relativeStamp(at(2026, 9, 9), now)).toBe("Bugün 14:20");
    expect(relativeStamp(at(2026, 9, 8, 9, 5), now)).toBe("Dün 09:05");
    expect(relativeStamp(at(2026, 8, 7), now)).toBe("7 Eyl");
  });
});

