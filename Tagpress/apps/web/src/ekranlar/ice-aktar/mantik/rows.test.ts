import type { ImportRow, Issue } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { setTestLocale } from "../../../i18n/test.ts";
import {
  displaySegments,
  filterCounts,
  filterRows,
  fixesFor,
  ISSUE_SHORT,
  issueShort,
  isTextEdited,
  mergeValidated,
  nextProblemPos,
  parseQuantity,
  patchNeedsValidation,
  plainLetterPatches,
  quotesStripped,
  ROW_FILTERS,
  resolveFix,
  rowToInput,
  SHORT_CODES,
  sortIssues,
  tallyRows,
  templateSuggestions,
} from "./rows.ts";

const issue = (code: Issue["code"], severity: Issue["severity"], fixes: Issue["fixes"] = []): Issue => ({ code, severity, message: code, fixes });

function row(over: Partial<ImportRow> & { index: number }): ImportRow {
  return {
    raw: {},
    include: true,
    textRaw: "Ayşe",
    text: "Ayşe",
    segments: ["Ayşe"],
    templateInput: "a15",
    templateKey: "a15",
    labelSize: "3.8",
    orderNo: "1001",
    quantity: 10,
    product: null,
    kind: "label",
    aiNote: "",
    dismissed: [],
    issues: [],
    dedupeKey: `k${over.index}`,
    ...over,
  };
}

describe("özet ve süzgeç", () => {
  const rows = [
    row({ index: 0 }),
    row({ index: 1, issues: [issue("order-missing", "warning")] }),
    row({ index: 2, issues: [issue("template-missing", "error")] }),
    row({ index: 3, include: false, issues: [issue("duplicate-in-file", "warning")] }),
    row({ index: 4, kind: "sticker", issues: [issue("sticker-detected", "info")] }),
    row({ index: 5, text: "  ", issues: [issue("text-missing", "error")] }),
  ];

  it("sayıları çıkarır; hatalı satırlar içe aktarılır ama 'üretime girmez' diye ayrı sayılır", () => {
    expect(tallyRows(rows)).toEqual({
      total: 6,
      included: 5,
      excluded: 1,
      errors: 2,
      warnings: 2,
      duplicates: 1,
      stickers: 1,
      importable: 4, // 5 dahil, biri metinsiz
      blocked: 1, // şablonsuz hatalı satır (metinsiz olan zaten alınmaz)
    });
  });

  it("süzgeçler: bilgi notu sorun sayılmaz", () => {
    expect(filterRows(rows, "issues").map((r) => r.index)).toEqual([1, 2, 3, 5]);
    expect(filterRows(rows, "duplicates").map((r) => r.index)).toEqual([3]);
    expect(filterRows(rows, "excluded").map((r) => r.index)).toEqual([3]);
    expect(filterRows(rows, "all")).toHaveLength(6);
    expect(filterCounts(rows)).toEqual({ all: 6, issues: 4, duplicates: 1, excluded: 1 });
  });

  it("sonraki/önceki sorunlu satır görünen sırada gezer ve sarar", () => {
    expect(nextProblemPos(rows, -1, 1)).toBe(1);
    expect(nextProblemPos(rows, 1, 1)).toBe(2);
    expect(nextProblemPos(rows, 5, 1)).toBe(1);
    expect(nextProblemPos(rows, 1, -1)).toBe(5);
    expect(nextProblemPos([row({ index: 0 })], 0, 1)).toBeNull();
    expect(nextProblemPos([], 0, 1)).toBeNull();
  });
});

describe("sorun sıralama", () => {
  it("hata, uyarı, bilgi; eşitlikte sıra korunur", () => {
    const a = issue("order-missing", "warning");
    const b = issue("sticker-detected", "info");
    const c = issue("template-missing", "error");
    const d = issue("quantity-missing", "warning");
    expect(sortIssues([b, a, c, d]).map((i) => i.code)).toEqual(["template-missing", "order-missing", "quantity-missing", "sticker-detected"]);
  });
});

describe("düzeltmeler", () => {
  const r = row({ index: 0, text: "𝐀𝐲𝐬𝐞 & Can", textRaw: "𝐀𝐲𝐬𝐞 & Can" });

  it("convert-unicode değeri uygular; değer yoksa yalnızca özel harfleri çevirir", () => {
    const o = resolveFix(r, issue("text-unicode-styled", "warning"), { kind: "convert-unicode", label: "x", value: "Ayse & Can" });
    expect(o).toEqual({ type: "patch", patch: { text: "Ayse & Can" } });
    const o2 = resolveFix(r, issue("text-unicode-styled", "warning"), { kind: "convert-unicode", label: "x" });
    expect(o2).toEqual({ type: "patch", patch: { text: "Ayse & Can" } });
  });

  it("şablon: değer varsa uygular, yoksa seçici açar", () => {
    expect(resolveFix(r, issue("template-missing", "error"), { kind: "choose-template", label: "a15", value: "a15" })).toEqual({ type: "patch", patch: { templateKey: "a15" } });
    expect(resolveFix(r, issue("template-missing", "error"), { kind: "choose-template", label: "Şablon seç" })).toEqual({ type: "pick-template" });
  });

  it("adet/sipariş/boyut: değer yoksa alana odaklanır; adet metni sayıya çevrilir", () => {
    expect(resolveFix(r, issue("quantity-missing", "warning"), { kind: "set-quantity", label: "Adet yaz", value: "1" })).toEqual({ type: "patch", patch: { quantity: 1 } });
    expect(resolveFix(r, issue("quantity-invalid", "error"), { kind: "set-quantity", label: "x" })).toEqual({ type: "focus", field: "quantity" });
    expect(resolveFix(r, issue("order-missing", "warning"), { kind: "set-order", label: "x" })).toEqual({ type: "focus", field: "orderNo" });
    expect(resolveFix(r, issue("size-unknown", "warning"), { kind: "set-size", label: "5,2 cm", value: "5.2" })).toEqual({ type: "patch", patch: { labelSize: "5.2" } });
  });

  it("skip satırı hariç tutar; dismiss kodu bir kez ekler", () => {
    expect(resolveFix(r, issue("duplicate-in-file", "warning"), { kind: "skip", label: "x" })).toEqual({ type: "patch", patch: { include: false } });
    const w = issue("text-suspicious", "warning");
    expect(resolveFix(r, w, { kind: "dismiss", label: "x" })).toEqual({ type: "patch", patch: { dismissed: ["text-suspicious"] } });
    const again = row({ index: 0, dismissed: ["text-suspicious"] });
    expect(resolveFix(again, w, { kind: "dismiss", label: "x" })).toEqual({ type: "patch", patch: { dismissed: ["text-suspicious"] } });
  });

  it("edit-text değerli ise uygular, değersizse düzenlemeyi başlatır", () => {
    expect(resolveFix(r, issue("text-unprintable", "error"), { kind: "edit-text", label: "x" })).toEqual({ type: "edit-text" });
    expect(resolveFix(r, issue("text-unprintable", "error"), { kind: "edit-text", label: "x", value: "Ayşe" })).toEqual({ type: "patch", patch: { text: "Ayşe" } });
  });

  it("fixesFor: üretim eylemleri çıkar, uyarılara 'yok say' ve dahil satırlara 'hariç tut' eklenir; hatalar yok sayılamaz", () => {
    const warn = issue("order-missing", "warning", [{ kind: "set-order", label: "Sipariş no yaz" }, { kind: "regenerate", label: "Yeniden üret" }]);
    expect(fixesFor({ include: true }, warn).map((f) => f.kind)).toEqual(["set-order", "dismiss", "skip"]);
    expect(fixesFor({ include: false }, warn).map((f) => f.kind)).toEqual(["set-order", "dismiss"]);
    const err = issue("template-missing", "error", [{ kind: "choose-template", label: "Şablon seç" }]);
    expect(fixesFor({ include: true }, err).map((f) => f.kind)).toEqual(["choose-template", "skip"]);
  });

  it("şablon önerileri tekrarsız, üstte gösterilmek üzere toplanır", () => {
    const rr = row({
      index: 0,
      issues: [
        issue("template-unknown", "error", [{ kind: "choose-template", label: "a15", value: "a15" }, { kind: "choose-template", label: "a16", value: "a16" }]),
        issue("template-missing", "error", [{ kind: "choose-template", label: "a15", value: "a15" }]),
      ],
    });
    expect(templateSuggestions(rr)).toEqual(["a15", "a16"]);
  });
});

describe("toplu çeviri ve metin işaretleri", () => {
  it("yalnızca özel harf içeren satırlara yama üretir, gerisine dokunmaz", () => {
    const rows = [row({ index: 0, text: "𝓐𝔂𝓼̧e" }), row({ index: 1, text: "Çiğdem & Can" }), row({ index: 2, text: "ＡＢＣ 1" })];
    const p = plainLetterPatches(rows);
    expect(p.map((x) => x.index)).toEqual([0, 2]);
    expect(p[1]?.patch.text).toBe("ABC 1");
  });

  it("dış tırnak işareti yalnızca düzenlenmemiş metinde; düzenlenince 'düzenlendi'", () => {
    const stripped = row({ index: 0, textRaw: '"Ayşe & Can"', text: "Ayşe & Can" });
    expect(quotesStripped(stripped)).toBe(true);
    expect(isTextEdited(stripped)).toBe(false);
    const edited = { ...stripped, text: "Ayşe ve Can" };
    expect(quotesStripped(edited)).toBe(false);
    expect(isTextEdited(edited)).toBe(true);
  });

  it("satır ipuçları güncel metinden çıkar", () => {
    expect(displaySegments({ text: "Ayşe\nve  Can" })).toEqual(["Ayşe", "ve", "Can"]);
  });
});

describe("adet ve gönderim", () => {
  it("adet: boş null, tam sayı sayı, gerisi yazıldığı gibi", () => {
    expect(parseQuantity("  ")).toBeNull();
    expect(parseQuantity("30")).toBe(30);
    expect(parseQuantity("3 adet")).toBe("3 adet");
    expect(parseQuantity("2,5")).toBe("2,5");
  });

  it("rowToInput hesaplanan alanları taşımaz", () => {
    const i = rowToInput(row({ index: 3, issues: [issue("order-missing", "warning")] }));
    expect(i).not.toHaveProperty("issues");
    expect(i).not.toHaveProperty("segments");
    expect(i).not.toHaveProperty("dedupeKey");
    expect(i.index).toBe(3);
  });

  it("dahil et dışındaki her değişiklik yeniden doğrulanır", () => {
    expect(patchNeedsValidation({ include: false })).toBe(false);
    expect(patchNeedsValidation({ text: "x" })).toBe(true);
    expect(patchNeedsValidation({ include: false, templateKey: "a1" })).toBe(true);
  });
});

describe("metinler sözlükten (bugünkü Türkçe aynen; EN de var)", () => {
  afterEach(() => setTestLocale("tr"));

  it("kısa sorun adları, süzgeç adları ve masanın eklediği düzeltmeler TR'de bugünkü metin", () => {
    expect(ISSUE_SHORT["text-unicode-styled"]).toBe("Özel harf");
    expect(ISSUE_SHORT["order-missing"]).toBe("Sipariş no yok");
    expect(ISSUE_SHORT["no-layout"]).toBeUndefined();
    expect(Object.keys(ISSUE_SHORT)).toEqual([...SHORT_CODES]);
    expect(ROW_FILTERS.map((f) => f.label)).toEqual(["Hepsi", "Yalnızca sorunlu", "Tekrarlar", "Hariç tutulanlar"]);
    const fixes = fixesFor({ include: true }, issue("order-missing", "warning"));
    expect(fixes.map((f) => f.label)).toEqual(["Yok say", "Satırı hariç tut"]);
  });

  it("kısa adı olmayan sorunda sunucunun cümlesi (uzunsa kısaltılır)", () => {
    expect(issueShort({ code: "no-layout", message: "Yerleşim yok" })).toBe("Yerleşim yok");
    expect(issueShort({ code: "no-layout", message: "a".repeat(40) })).toBe(`${"a".repeat(27)}…`);
  });

  it("EN'de aynı anahtarlar İngilizce", () => {
    setTestLocale("en");
    expect(ISSUE_SHORT["text-missing"]).toBe("No text");
    expect(ROW_FILTERS[0]?.label).toBe("All");
    expect(fixesFor({ include: true }, issue("order-missing", "warning")).map((f) => f.label)).toEqual(["Ignore", "Exclude row"]);
  });
});

describe("doğrulama yanıtını birleştirme (yarış koruması)", () => {
  const cur = [row({ index: 0, text: "yeni" }), row({ index: 1 }), row({ index: 2 })];
  const fresh = (i: number, issues: Issue[]) => row({ index: i, text: "ESKİ METİN", issues, segments: ["s"], dedupeKey: "yeni-anahtar" });

  it("sürümü aynı satırın sorunlarını alır, kullanıcının metnini ezmez", () => {
    const out = mergeValidated(cur, [fresh(0, [issue("order-missing", "warning")])], new Map([[0, 2]]), new Map([[0, 2]]));
    expect(out[0]?.issues).toHaveLength(1);
    expect(out[0]?.text).toBe("yeni");
    expect(out[0]?.dedupeKey).toBe("yeni-anahtar");
  });

  it("yanıt beklenirken satır tekrar düzenlendiyse eski yanıt atılır", () => {
    const out = mergeValidated(cur, [fresh(0, [issue("order-missing", "warning")])], new Map([[0, 2]]), new Map([[0, 3]]));
    expect(out[0]?.issues).toEqual([]);
  });

  it("dahil et durumu yanıt beklenirken değişse bile korunur; yanıtta olmayan satırlara dokunulmaz", () => {
    const c = [row({ index: 0, include: false }), row({ index: 1 })];
    const out = mergeValidated(c, [fresh(0, [])], new Map([[0, 1]]), new Map([[0, 1]]));
    expect(out[0]?.include).toBe(false);
    expect(out[1]).toBe(c[1]);
  });
});
