import type { BatchSummary, ImportPreviewResponse, ImportRow, Issue } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { lastUpload, looksLikeOrders, uploadPlan } from "./yukle.ts";

const issue = (code: Issue["code"], severity: Issue["severity"] = "warning"): Issue => ({ code, severity, message: code, fixes: [] });

const row = (index: number, over: Partial<ImportRow> = {}): ImportRow => ({
  index,
  raw: {},
  include: true,
  textRaw: `Metin ${index}`,
  text: `Metin ${index}`,
  segments: [],
  templateInput: null,
  templateKey: "a15",
  labelSize: null,
  orderNo: String(100 + index),
  quantity: 10,
  product: null,
  kind: "label",
  aiNote: "",
  dismissed: [],
  issues: [],
  dedupeKey: `k${index}`,
  ...over,
});

const preview = (rows: ImportRow[], text: string | null = "metin"): ImportPreviewResponse => ({
  languageId: "dil-1",
  fileName: "siparisler.json",
  fields: ["metin"],
  mapping: { text, orderNo: null, quantity: null, template: null, size: null, product: null },
  mappingSource: { text: "name", orderNo: null, quantity: null, template: null, size: null, product: null },
  format: "array",
  rows,
  warnings: [],
  summary: { total: rows.length, included: rows.length, errors: 0, warnings: 0, duplicates: 0, stickers: 0, byCode: {} },
  templateKeys: [],
  labelSizes: [],
});

describe("dosyadan listeye (üretimsiz)", () => {
  it("sorunlu satırlar da alınır, kayıt üretim başlatmaz, metin dokunulmaz", () => {
    const rows = [row(0), row(1, { issues: [issue("template-missing", "error")] }), row(2, { text: "Ayşe  &  Can\n12.06" })];
    const plan = uploadPlan(preview(rows));
    expect(plan.kind).toBe("commit");
    if (plan.kind !== "commit") return;
    expect(plan.take).toBe(3);
    expect(plan.body.generate).toBe(false);
    expect(plan.body.batchName).toBe("siparisler");
    expect(plan.body.rows.map((r) => r.text)).toEqual(["Metin 0", "Metin 1", "Ayşe  &  Can\n12.06"]);
    expect(plan.body.rows.every((r) => r.include !== false)).toBe(true);
  });

  it("tekrarlar ve metinsizler sunucunun dediği gibi alınmaz, sayılır", () => {
    const rows = [row(0), row(1, { include: false, issues: [issue("duplicate-existing")] }), row(2, { include: false, text: "  ", textRaw: "" })];
    const plan = uploadPlan(preview(rows));
    expect(plan).toMatchObject({ kind: "commit", take: 1, duplicates: 1, blank: 1 });
  });

  it("hiçbir satır alınmıyorsa kayıt yok; metin alanı bulunamadıysa ayrıntılı masa", () => {
    expect(uploadPlan(preview([row(0, { include: false, issues: [issue("duplicate-in-file")] })]))).toEqual({ kind: "nothing", duplicates: 1, blank: 0 });
    expect(uploadPlan(preview([row(0)], null))).toEqual({ kind: "no-text" });
  });

  it("yapıştırılan metin yalnız JSON gibiyse yüklenir", () => {
    expect(looksLikeOrders('  [{"metin":"a"}]')).toBe(true);
    expect(looksLikeOrders('{"metin":"a"}\n{"metin":"b"}')).toBe(true);
    expect(looksLikeOrders("merhaba")).toBe(false);
  });

  it("son yükleme: dosyalı en yeni parti", () => {
    const b = (id: string, createdAt: string, sourceFile: string | null): BatchSummary => ({ id, languageId: "l", name: id, sourceFile, createdAt, total: 3, byStatus: {}, withIssues: 0, approved: 0 });
    expect(lastUpload([b("a", "2026-11-20", "a.json"), b("elle", "2026-11-24", null), b("c", "2026-11-22", "c.json")])?.id).toBe("c");
    expect(lastUpload([])).toBeNull();
    expect(lastUpload(undefined)).toBeNull();
  });
});
