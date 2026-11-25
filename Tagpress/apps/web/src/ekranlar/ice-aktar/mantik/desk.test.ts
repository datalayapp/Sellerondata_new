import type { ImportPreviewResponse, ImportRow, Issue } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import {
  applyPatches,
  baseName,
  blankRow,
  bulkCounts,
  bumpRevs,
  commitBody,
  deskKey,
  type DeskKeyInput,
  excludePatches,
  fieldStates,
  fixTextPreview,
  getRow,
  includeAllPatches,
  isAcceptedFile,
  isErrorRow,
  isTypingTarget,
  mappingSummary,
  nextMapping,
  previewBody,
  problemStep,
  readImportFile,
  restoreRows,
  selectRow,
  selectVisible,
  setIncludePatches,
  settledIndexes,
  snapshotRows,
  stepActive,
  templatePatches,
  validateBody,
  validationIndexes,
  visibleSelection,
} from "./desk.ts";

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

describe("dosya kabulü", () => {
  it("uzantı (büyük/küçük harf fark etmez) ve dosya adı kökü", () => {
    expect(isAcceptedFile("Etiketler.JSON")).toBe(true);
    expect(isAcceptedFile("a.ndjson")).toBe(true);
    expect(isAcceptedFile("a.txt")).toBe(true);
    expect(isAcceptedFile("a.csv")).toBe(false);
    expect(baseName("Etiketler.json")).toBe("Etiketler");
    expect(baseName("a.b.ndjson")).toBe("a.b");
  });

  it("okuma: tür, okunamayan ve boş dosya ayrı nedenle döner", async () => {
    expect(await readImportFile({ name: "x.csv", text: async () => "[]" })).toEqual({ ok: false, problem: "type" });
    expect(
      await readImportFile({
        name: "x.json",
        text: async () => {
          throw new Error("kilitli");
        },
      }),
    ).toEqual({ ok: false, problem: "unreadable" });
    expect(await readImportFile({ name: "x.json", text: async () => "  \n" })).toEqual({ ok: false, problem: "empty" });
    expect(await readImportFile({ name: "x.json", text: async () => "[1]" })).toEqual({ ok: true, content: "[1]" });
  });

  it("yazı alanı: input, textarea, select ve düzenlenebilir öğe", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as Element)).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" } as unknown as Element)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as Element)).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as Element)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("yamalar ve geri alma", () => {
  const rows = [row({ index: 0 }), row({ index: 1, include: false }), row({ index: 2, issues: [issue("template-missing", "error")] })];

  it("yamalar yalnız hedef satırları değiştirir; geri alma önceki hâle döner", () => {
    const patches = [{ index: 0, patch: { text: "Yeni" } }, { index: 2, patch: { include: false } }];
    const before = snapshotRows(rows, patches.map((p) => p.index));
    const after = applyPatches(rows, patches);
    expect(after[0]?.text).toBe("Yeni");
    expect(after[1]).toBe(rows[1]);
    expect(after[2]?.include).toBe(false);
    const back = restoreRows(after, before);
    expect(back).toEqual(rows);
    expect(validationIndexes(patches)).toEqual([0]);
  });

  it("dahil et / hariç tut: zaten o durumda olan atlanır; toplu hariç yalnız dahil satırlarda", () => {
    expect(setIncludePatches(rows, [0, 1], false)).toEqual([{ index: 0, patch: { include: false } }]);
    expect(setIncludePatches(rows, new Set([0, 1]), true)).toEqual([{ index: 1, patch: { include: true } }]);
    expect(excludePatches(rows, isErrorRow)).toEqual([{ index: 2, patch: { include: false } }]);
    expect(includeAllPatches(rows)).toEqual([{ index: 1, patch: { include: true } }]);
    expect(templatePatches(new Set([0, 2]), "b03")).toEqual([
      { index: 0, patch: { templateKey: "b03" } },
      { index: 2, patch: { templateKey: "b03" } },
    ]);
    expect(templatePatches([0], null)).toEqual([{ index: 0, patch: { templateKey: null } }]);
  });

  it("toplu sayılar yalnız dahil satırları sayar; hariç sayısı ayrı", () => {
    const rs = [
      row({ index: 0, issues: [issue("template-missing", "error")] }),
      row({ index: 1, issues: [issue("order-missing", "warning"), issue("duplicate-in-file", "warning")] }),
      row({ index: 2, include: false, issues: [issue("template-missing", "error")] }),
      row({ index: 3, issues: [issue("sticker-detected", "info")] }),
    ];
    expect(bulkCounts(rs)).toEqual({ errors: 1, problems: 2, duplicates: 1, excluded: 1 });
  });

  it("satır bulma sıra numarasıyla (dizide yeri kaymış olsa da)", () => {
    const rs = [row({ index: 5 }), row({ index: 2 })];
    expect(getRow(rs, 2)?.index).toBe(2);
    expect(getRow(rs, 9)).toBeUndefined();
  });

  it("satır ekle: boş, dahil, sıra numarası en büyüğün bir fazlası", () => {
    const b = blankRow([row({ index: 0 }), row({ index: 7 })]);
    expect(b.index).toBe(8);
    expect(b.text).toBe("");
    expect(b.include).toBe(true);
    expect(blankRow([]).index).toBe(0);
  });

  it("düzeltme önizlemesi: düz harfe çevir yeni metni, olduğu gibi bas bugünkü metni gösterir", () => {
    const r = row({ index: 0, text: "𝓢𝓮𝓵𝓲𝓷 & Mert" });
    const styled = issue("text-unicode-styled", "warning");
    expect(fixTextPreview(r, styled, { kind: "convert-unicode", label: "x", value: "Selin & Mert" })).toBe("Selin & Mert");
    expect(fixTextPreview(r, styled, { kind: "convert-unicode", label: "x" })).toBe("Selin & Mert");
    expect(fixTextPreview(r, styled, { kind: "dismiss", label: "Olduğu gibi bas" })).toBe("𝓢𝓮𝓵𝓲𝓷 & Mert");
    expect(r.text).toBe("𝓢𝓮𝓵𝓲𝓷 & Mert");
  });
});

describe("seçim", () => {
  const order = [3, 1, 4, 0];

  it("düz tıklama tek satır seçer, yine tıklanınca kaldırır", () => {
    const a = selectRow(new Set(), order, null, 1, { shift: false, ctrl: false });
    expect([...a.selected]).toEqual([1]);
    expect(a.anchor).toBe(1);
    const b = selectRow(a.selected, order, a.anchor, 1, { shift: false, ctrl: false });
    expect(b.selected.size).toBe(0);
    const c = selectRow(new Set([3, 4]), order, 3, 1, { shift: false, ctrl: false });
    expect([...c.selected]).toEqual([1]);
  });

  it("Ctrl ekler/çıkarır ve çapa olur; Shift görünen sırada aralık ekler, çapa kalır", () => {
    const a = selectRow(new Set([3]), order, 3, 4, { shift: false, ctrl: true });
    expect([...a.selected].sort()).toEqual([3, 4]);
    expect(a.anchor).toBe(4);
    const b = selectRow(a.selected, order, 4, 4, { shift: false, ctrl: true });
    expect([...b.selected]).toEqual([3]);
    const c = selectRow(new Set(), order, 3, 4, { shift: true, ctrl: false });
    expect([...c.selected].sort()).toEqual([1, 3, 4]);
    expect(c.anchor).toBe(3);
    // çapa yoksa Shift düz tıklama gibidir
    expect([...selectRow(new Set(), order, null, 0, { shift: true, ctrl: false }).selected]).toEqual([0]);
  });

  it("başlıktaki kutu: görünenlerin hepsi, bir kısmı ya da hiçbiri; görünmeyen seçim korunur", () => {
    expect(visibleSelection(new Set(), [1, 2])).toBe(false);
    expect(visibleSelection(new Set([1]), [1, 2])).toBe("mixed");
    expect(visibleSelection(new Set([1, 2, 9]), [1, 2])).toBe(true);
    expect(visibleSelection(new Set([1]), [])).toBe(false);
    expect([...selectVisible(new Set([9]), [1, 2], true)].sort()).toEqual([1, 2, 9]);
    expect([...selectVisible(new Set([1, 2, 9]), [1, 2], false)]).toEqual([9]);
  });
});

describe("gezinme ve klavye", () => {
  const visible = [row({ index: 4 }), row({ index: 1, issues: [issue("order-missing", "warning")] }), row({ index: 7 }), row({ index: 2, issues: [issue("template-missing", "error")] })];
  const idx = visible.map((r) => r.index);

  it("oklar görünen sırada bir adım; uçlarda durur; etkin yoksa ilk satır", () => {
    expect(stepActive(idx, null, 1)).toBe(4);
    expect(stepActive(idx, null, -1)).toBe(4);
    expect(stepActive(idx, 4, 1)).toBe(1);
    expect(stepActive(idx, 2, 1)).toBe(2);
    expect(stepActive(idx, 4, -1)).toBe(4);
    expect(stepActive([], null, 1)).toBeNull();
  });

  it("sonraki/önceki sorun sarar; sorun yoksa null", () => {
    expect(problemStep(visible, null, 1)).toBe(1);
    expect(problemStep(visible, 1, 1)).toBe(2);
    expect(problemStep(visible, 2, 1)).toBe(1);
    expect(problemStep(visible, 1, -1)).toBe(2);
    expect(problemStep([row({ index: 0 })], 0, 1)).toBeNull();
  });

  const k = (over: Partial<DeskKeyInput>): DeskKeyInput => ({ key: "", ctrl: false, alt: false, shift: false, typing: false, inLayer: false, onControl: false, busy: false, ...over });

  it("eski masanın tuşları", () => {
    expect(deskKey(k({ key: "Enter", ctrl: true }))).toBe("commit");
    expect(deskKey(k({ key: "Escape" }))).toBe("close");
    expect(deskKey(k({ key: "ArrowDown" }))).toBe("down");
    expect(deskKey(k({ key: "ArrowUp", onControl: true }))).toBe("up");
    expect(deskKey(k({ key: "Enter" }))).toBe("edit");
    expect(deskKey(k({ key: " " }))).toBe("toggle");
    expect(deskKey(k({ key: "n" }))).toBe("next-problem");
    expect(deskKey(k({ key: "N", shift: true }))).toBe("prev-problem");
  });

  it("yazarken, katmanda, düzenleme sürerken hiçbiri; düğmedeyken Enter/Space/N düğmenin", () => {
    expect(deskKey(k({ key: "n", typing: true }))).toBeNull();
    expect(deskKey(k({ key: "Escape", inLayer: true }))).toBeNull();
    expect(deskKey(k({ key: "Enter", ctrl: true, busy: true }))).toBeNull();
    expect(deskKey(k({ key: "Enter", onControl: true }))).toBeNull();
    expect(deskKey(k({ key: " ", onControl: true }))).toBeNull();
    expect(deskKey(k({ key: "n", onControl: true }))).toBeNull();
    expect(deskKey(k({ key: "n", ctrl: true }))).toBeNull();
    expect(deskKey(k({ key: "n", alt: true }))).toBeNull();
  });
});

describe("doğrulama sürümleri ve gövdeler", () => {
  it("yanıt beklerken yeniden düzenlenen satırın bekleme işareti kalkmaz", () => {
    const revs = new Map<number, number>();
    bumpRevs(revs, [0, 1]);
    const sent = new Map([...revs]);
    bumpRevs(revs, [1]);
    expect(revs.get(1)).toBe(2);
    expect(settledIndexes(sent, revs)).toEqual([0]);
  });

  const rows = [row({ index: 0, issues: [issue("order-missing", "warning")] }), row({ index: 1, include: false })];
  const preview = { fileName: "Etiketler.json", languageId: "dil-1", mapping: { text: "metin", template: null, orderNo: null, quantity: null, product: null, size: null } };

  it("doğrulama gövdesi yalnız istenen satırları hesaplanmış alanlar olmadan taşır", () => {
    const b = validateBody(null, rows, [1, 9]);
    expect(b.languageId).toBeUndefined();
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).not.toHaveProperty("issues");
    expect(b.rows[0]?.include).toBe(false);
    expect(previewBody("a.json", "[]", "dil-1")).toEqual({ fileName: "a.json", content: "[]", languageId: "dil-1", mapping: undefined });
  });

  it("gönderim gövdesi: bütün satırlar (hariç olanlar dahil), boş parti adı gönderilmez", () => {
    const b = commitBody(preview, "  ", rows, true);
    expect(b).toMatchObject({ fileName: "Etiketler.json", languageId: "dil-1", generate: true, batchName: undefined, mapping: preview.mapping });
    expect(b.rows).toHaveLength(2);
    expect(b.rows[0]).not.toHaveProperty("issues");
    expect(commitBody(preview, " 21 Kasım ", rows, false).batchName).toBe("21 Kasım");
  });
});

describe("alan eşlemesi", () => {
  const preview: Pick<ImportPreviewResponse, "mapping" | "mappingSource"> = {
    mapping: { text: null, template: "sablon", orderNo: "no", quantity: null, product: null, size: null },
    mappingSource: { text: null, template: "name", orderNo: "content", quantity: null, product: null, size: null },
  };

  it("alanlar gösterim sırasında; metin eşlenmemişse eksik", () => {
    const s = fieldStates(preview);
    expect(s.map((x) => x.field)).toEqual(["text", "orderNo", "quantity", "template", "size", "product"]);
    expect(s[0]).toEqual({ field: "text", current: null, source: null, missing: true });
    expect(s[1]).toEqual({ field: "orderNo", current: "no", source: "content", missing: false });
    expect(mappingSummary(preview)).toEqual({ mapped: 2, textMissing: true });
  });

  it("yeni eşleme yalnız verilen alanı değiştirir", () => {
    const m = nextMapping({ ...preview.mapping }, "text", "metin");
    expect(m).toEqual({ ...preview.mapping, text: "metin" });
    expect(preview.mapping.text).toBeNull();
  });
});
