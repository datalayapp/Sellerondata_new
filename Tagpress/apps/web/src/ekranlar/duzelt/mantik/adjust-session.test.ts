import "../../../i18n/test.ts";
import { type AdjustCheckResponse, IDENTITY_ADJUST, type Issue, type VariantAdjust } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { setTestLocale } from "../../../i18n/test.ts";
import { editOf } from "./adjust-edit.ts";
import {
  applyDraft,
  beginEditing,
  canSave,
  centerTargets,
  checkBody,
  checkView,
  editDraft,
  editRange,
  fontEmptyText,
  fontLabel,
  fontPlan,
  fontScope,
  fontScopeText,
  isDirty,
  type KeyInput,
  keyAction,
  marqueeEnd,
  mergeKey,
  partialRange,
  pressPlan,
  relayoutBody,
  saveBody,
} from "./adjust-session.ts";

const LINES = [{ text: "Elif" }, { text: "&" }, { text: "Kerem" }];
const base = (i: number) => ["Sans", "Sans", "Script"][i];

describe("metin düzenleme", () => {
  it("düzenleme bütün metin seçili başlar; satır yoksa null", () => {
    expect(beginEditing(LINES, 2)).toEqual({ index: 2, draft: "Kerem", current: "Kerem", start: 0, end: 5 });
    expect(beginEditing(LINES, 9)).toBeNull();
  });

  it("kısmi seçim yalnız metnin bir parçası seçiliyken", () => {
    const ed = beginEditing(LINES, 2)!;
    expect(partialRange(ed)).toBeNull(); // bütün metin
    expect(partialRange(editRange(ed, 2, 2))).toBeNull(); // imleç
    expect(partialRange(editRange(ed, 0, 2))?.start).toBe(0);
    expect(partialRange(null)).toBeNull();
    expect(editRange(ed, 0, 5)).toBe(ed);
  });

  it("font kapsamı: parça, bütün yazı, birkaç satır, satır (TR metinler)", () => {
    const ed = editRange(beginEditing(LINES, 2)!, 0, 2);
    expect(fontScope(ed, [2])).toEqual({ kind: "span", text: "Ke" });
    expect(fontScope(null, null)).toEqual({ kind: "all" });
    expect(fontScope(null, [0, 2])).toEqual({ kind: "lines", count: 2 });
    expect(fontScope(beginEditing(LINES, 2), [2])).toEqual({ kind: "line" });
    expect(fontScopeText(fontScope(ed, [2]))).toBe("Font (seçili parça)");
    expect(fontScopeText({ kind: "all" })).toBe("Font (bütün yazı)");
    expect(fontScopeText({ kind: "lines", count: 3 })).toBe("Font (3 satır)");
    expect(fontScopeText({ kind: "line" })).toBe("Font (satır)");
    expect(fontEmptyText(fontScope(ed, [2]))).toBe("“Ke” için font seç");
    expect(fontEmptyText({ kind: "line" })).toBe("Karışık");
  });

  it("EN metinler sözlükten", () => {
    setTestLocale("en");
    try {
      expect(fontScopeText({ kind: "lines", count: 3 })).toBe("Font (3 lines)");
      expect(fontEmptyText({ kind: "all" })).toBe("Mixed");
    } finally {
      setTestLocale("tr");
    }
  });

  it("taslak: kenar boşluğu ve satır sonu temizlenir; boş satır yazılmaz", () => {
    const ed = editDraft(beginEditing(LINES, 2)!, "  Kerem\nA. ", 0, 0);
    const r = applyDraft(IDENTITY_ADJUST, ed, "Kerem", undefined, base);
    expect(r.ok && editOf(r.next, 2)?.text).toBe("Kerem A.");
    expect(applyDraft(IDENTITY_ADJUST, editDraft(ed, "   ", 0, 0), "Kerem", undefined, base)).toEqual({ ok: false, reason: "empty" });
  });

  it("taslak özgün metne dönünce metin düzenlemesi kalkar", () => {
    const ed = editDraft(beginEditing(LINES, 2)!, "Kerem", 0, 5);
    const r = applyDraft(IDENTITY_ADJUST, ed, "Kerem", undefined, base);
    expect(r.ok && r.next.edits).toBeUndefined();
  });

  it("font: bütün metin seçiliyse satır fontu, bir kısmı seçiliyse parça fontu", () => {
    const all = beginEditing(LINES, 2)!;
    const r1 = applyDraft(IDENTITY_ADJUST, all, "Kerem", "Sans", base);
    expect(r1.ok && editOf(r1.next, 2)).toEqual({ index: 2, fontId: "Sans" });
    const part = editRange(all, 0, 2);
    const r2 = applyDraft(IDENTITY_ADJUST, part, "Kerem", "Sans", base);
    expect(r2.ok && editOf(r2.next, 2)?.spans).toEqual([{ start: 0, end: 2, fontId: "Sans" }]);
    // Satırın kendi fontu seçilirse düzenleme gerekmez.
    const r3 = applyDraft(IDENTITY_ADJUST, all, "Kerem", "Script", base);
    expect(r3.ok && r3.next.edits).toBeUndefined();
  });

  it("font planı", () => {
    const ed = beginEditing(LINES, 0)!;
    expect(fontPlan(ed)).toBe("draft-with-font");
    expect(fontPlan(editRange(ed, 2, 2))).toBe("draft-then-lines");
    expect(fontPlan(null)).toBe("lines");
  });

  it("font adı: aile + stil; Regular yazılmaz; listede yoksa kimlik", () => {
    const fonts = [
      { id: "GreatVibes/Regular", family: "Great Vibes", style: "Regular", kind: "script" },
      { id: "Inter/Bold", family: "Inter", style: "Bold", kind: "sans" },
    ];
    expect(fontLabel(fonts, "GreatVibes/Regular")).toBe("Great Vibes");
    expect(fontLabel(fonts, "Inter/Bold")).toBe("Inter Bold");
    expect(fontLabel(fonts, "Lora/Regular")).toBe("Lora");
    expect(fontLabel(undefined, "Lora/Italic")).toBe("Lora/Italic");
  });
});

describe("kirli durum ve gövdeler", () => {
  const moved: VariantAdjust = { dx: 2, dy: 0, scale: 1 };

  it("kayıtlıyla aynı biçimdeyse kirli değil", () => {
    expect(isDirty(IDENTITY_ADJUST, null)).toBe(false);
    expect(isDirty({ dx: 0.001, dy: 0, scale: 1 }, null)).toBe(false);
    expect(isDirty(moved, null)).toBe(true);
    expect(isDirty(moved, moved)).toBe(false);
  });

  it("kaydet: değişiklik ya da açık taslak; kayıt ve ölçüm sürerken kapalı", () => {
    expect(canSave({ dirty: true, editing: false, saving: false, busy: false })).toBe(true);
    expect(canSave({ dirty: false, editing: true, saving: false, busy: false })).toBe(true);
    expect(canSave({ dirty: false, editing: false, saving: false, busy: false })).toBe(false);
    expect(canSave({ dirty: true, editing: false, saving: true, busy: false })).toBe(false);
    expect(canSave({ dirty: true, editing: false, saving: false, busy: true })).toBe(false);
  });

  it("kayıt gövdesi normalleşir; etkisizse kimlik (sunucuda kaldır)", () => {
    expect(saveBody(moved)).toEqual({ adjust: { dx: 2, dy: 0, scale: 1 } });
    expect(saveBody(IDENTITY_ADJUST)).toEqual({ adjust: IDENTITY_ADJUST });
    expect(checkBody(moved)).toEqual({ adjust: moved });
  });

  it("yeniden yerleşim gövdesi `placed` taşımaz", () => {
    const a: VariantAdjust = { ...IDENTITY_ADJUST, edits: [{ index: 0, text: "Ana", placed: { text: "Ana" } as never }] };
    expect(relayoutBody(a)).toEqual({ edits: [{ index: 0, text: "Ana" }] });
    expect(relayoutBody(IDENTITY_ADJUST)).toEqual({ edits: [] });
  });

  it("birleştirme anahtarı seçime bağlı", () => {
    expect(mergeKey("ok", null)).toBe("ok:b");
    expect(mergeKey("ok", [0, 2])).toBe("ok:0,2");
    expect(mergeKey(undefined, [1])).toBeNull();
  });
});

describe("otomatik denetim", () => {
  const issue = (code: string, message = code): Issue => ({ code, message, severity: "warning", field: "adjust" }) as Issue;
  const check = (issues: Issue[]): AdjustCheckResponse => ({ adjust: null, ink: { x: 0, y: 0, w: 1, h: 1 }, lineInks: [], lineStrokes: [], issues, collision: null, ms: 1 });

  it("çarpışma yoksa 'kesimin içinde'; denetim yoksa hiçbir şey", () => {
    expect(checkView(null, IDENTITY_ADJUST)).toEqual({ issues: [], contained: false, textEdited: false });
    expect(checkView(check([]), IDENTITY_ADJUST).contained).toBe(true);
    expect(checkView(check([issue("collision")]), IDENTITY_ADJUST).contained).toBe(false);
  });

  it("metin notları eklenir, aynı not bir kez", () => {
    const v = checkView(check([issue("collision")]), IDENTITY_ADJUST, [issue("text-fallback-font", "yedek"), issue("collision")]);
    expect(v.issues.map((i) => i.code)).toEqual(["collision", "text-fallback-font"]);
  });

  it("'metin elle düzenlendi' yalnız metin düzenlemesi ve text-edited notu varken", () => {
    const edited: VariantAdjust = { ...IDENTITY_ADJUST, edits: [{ index: 0, text: "Ana" }] };
    expect(checkView(check([issue("text-edited")]), edited).textEdited).toBe(true);
    expect(checkView(check([issue("text-edited")]), IDENTITY_ADJUST).textEdited).toBe(false);
    expect(checkView(check([]), edited, [issue("text-edited")]).textEdited).toBe(true);
  });

  it("ortalama hedefleri: şablonda hedef varsa üç seçenek, yoksa iki", () => {
    const c = { textCenter: { x: 1, y: 1, source: "template" as const }, area: { x: 2, y: 2 }, cut: { x: 3, y: 3 } };
    expect(centerTargets(c)).toEqual([
      { value: "textCenter", label: "Şablondaki hedef merkez" },
      { value: "area", label: "Yazı alanının merkezi" },
      { value: "cut", label: "Kesim merkezi" },
    ]);
    expect(centerTargets({ ...c, textCenter: { ...c.textCenter, source: "area" } }).map((o) => o.label)).toEqual(["Yazı alanının merkezi", "Kesim merkezi"]);
  });
});

describe("tuvale basma", () => {
  const p = { hit: null as number | null, add: false, sel: null as readonly number[] | null, lineCount: 3, inBlock: false, inSel: false };

  it("satıra basınca seçilir ve taşınır; seçiliyse seçim korunur", () => {
    expect(pressPlan({ ...p, hit: 1 })).toEqual({ sel: [1], drag: "move" });
    expect(pressPlan({ ...p, hit: 1, sel: [0, 1] })).toEqual({ sel: [0, 1], drag: "move" });
  });

  it("Ctrl ile ekle/çıkar; çıkarılan satır sürüklenmez", () => {
    expect(pressPlan({ ...p, hit: 2, add: true, sel: [0] })).toEqual({ sel: [0, 2], drag: "move" });
    expect(pressPlan({ ...p, hit: 2, add: true, sel: [0, 2] })).toEqual({ sel: [0], drag: null });
  });

  it("boşlukta seçim kutusu; blokta bütün yazı; seçim kutusunun içinde seçim korunur", () => {
    expect(pressPlan({ ...p, sel: [1] })).toEqual({ sel: [1], drag: "marquee" });
    expect(pressPlan({ ...p, add: true, inBlock: true, sel: [1] })).toEqual({ sel: [1], drag: "marquee" });
    expect(pressPlan({ ...p, inBlock: true, sel: [1] })).toEqual({ sel: null, drag: "move" });
    expect(pressPlan({ ...p, inSel: true, sel: [0, 1] })).toEqual({ sel: [0, 1], drag: "move" });
  });

  it("seçim kutusu: sürüklemeden tık bütün yazıyı seçer", () => {
    expect(marqueeEnd({ moved: false, add: false, sel: [1] })).toBeNull();
    expect(marqueeEnd({ moved: true, add: false, sel: [1] })).toEqual([1]);
    expect(marqueeEnd({ moved: false, add: true, sel: [1] })).toEqual([1]);
  });
});

describe("eski pencerenin tuşları", () => {
  const k = (over: Partial<KeyInput>): KeyInput => ({
    key: "",
    code: "",
    ctrl: false,
    meta: false,
    shift: false,
    alt: false,
    tag: "DIV",
    editable: false,
    inEditor: false,
    editing: false,
    hasSel: false,
    ready: true,
    stageFocused: true,
    single: null,
    canEditText: true,
    ...over,
  });

  it("Esc: düzenlemeden, seçimden, pencereden çıkar; düzenleme kutusu kendi tuşlarını işler", () => {
    expect(keyAction(k({ key: "Escape", editing: true }))).toEqual({ kind: "cancelEdit" });
    expect(keyAction(k({ key: "Escape", hasSel: true }))).toEqual({ kind: "clearSel" });
    expect(keyAction(k({ key: "Escape" }))).toEqual({ kind: "close" });
    expect(keyAction(k({ key: "Escape", ready: false }))).toEqual({ kind: "close" });
    expect(keyAction(k({ key: "Escape", editing: true, inEditor: true }))).toBeNull();
  });

  it("Ctrl S / Ctrl Enter kaydeder, yazı alanında da; Ctrl = - 0 yakınlaştırır", () => {
    expect(keyAction(k({ key: "s", ctrl: true, tag: "INPUT" }))).toEqual({ kind: "save" });
    expect(keyAction(k({ key: "Enter", meta: true }))).toEqual({ kind: "save" });
    expect(keyAction(k({ key: "=", ctrl: true }))).toEqual({ kind: "zoomIn" });
    expect(keyAction(k({ key: "x", code: "NumpadAdd", ctrl: true }))).toEqual({ kind: "zoomIn" });
    expect(keyAction(k({ key: "-", ctrl: true }))).toEqual({ kind: "zoomOut" });
    expect(keyAction(k({ key: "0", ctrl: true }))).toEqual({ kind: "zoomFit" });
    expect(keyAction(k({ key: "s", ctrl: true, alt: true }))).toBeNull();
  });

  it("yazı alanında tek tuşlar çalışmaz; hazır değilken Esc dışında hiçbiri", () => {
    expect(keyAction(k({ key: "h", tag: "INPUT" }))).toBeNull();
    expect(keyAction(k({ key: "h", editable: true }))).toBeNull();
    expect(keyAction(k({ key: "h", ready: false }))).toBeNull();
  });

  it("geri al, ileri al, hepsini seç", () => {
    expect(keyAction(k({ key: "z", ctrl: true }))).toEqual({ kind: "undo" });
    expect(keyAction(k({ key: "Z", ctrl: true, shift: true }))).toEqual({ kind: "redo" });
    expect(keyAction(k({ key: "y", ctrl: true }))).toEqual({ kind: "redo" });
    expect(keyAction(k({ key: "a", ctrl: true }))).toEqual({ kind: "selectAll" });
  });

  it("kalınlık: [ ] (AltGr ile de) ve , .", () => {
    expect(keyAction(k({ key: "[", ctrl: true, alt: true }))).toEqual({ kind: "stroke", step: -0.2 });
    expect(keyAction(k({ key: "]" }))).toEqual({ kind: "stroke", step: 0.2 });
    expect(keyAction(k({ key: "," }))).toEqual({ kind: "stroke", step: -0.2 });
    expect(keyAction(k({ key: "." }))).toEqual({ kind: "stroke", step: 0.2 });
  });

  it("Tab yalnız sahnede satırlarda gezer; Boşluk düğmede düğmenin", () => {
    expect(keyAction(k({ key: "Tab", shift: true }))).toEqual({ kind: "cycle", back: true });
    expect(keyAction(k({ key: "Tab", stageFocused: false }))).toBeNull();
    expect(keyAction(k({ key: " " }))).toEqual({ kind: "panStart" });
    expect(keyAction(k({ key: " ", tag: "BUTTON" }))).toBeNull();
  });

  it("oklar, boyut, ortalama, sıfırla, gerçek boyut, Shift 1 / 2", () => {
    expect(keyAction(k({ key: "ArrowLeft", shift: true }))).toEqual({ kind: "nudge", key: "ArrowLeft", shift: true });
    expect(keyAction(k({ key: "-" }))).toEqual({ kind: "scale", step: -0.02 });
    expect(keyAction(k({ key: "+" }))).toEqual({ kind: "scale", step: 0.02 });
    expect(keyAction(k({ key: "H" }))).toEqual({ kind: "center", axis: "x" });
    expect(keyAction(k({ key: "v" }))).toEqual({ kind: "center", axis: "y" });
    expect(keyAction(k({ key: "c" }))).toEqual({ kind: "center", axis: "both" });
    expect(keyAction(k({ key: "0" }))).toEqual({ kind: "reset" });
    expect(keyAction(k({ key: "1" }))).toEqual({ kind: "zoomActual" });
    expect(keyAction(k({ key: "!", code: "Digit1", shift: true }))).toEqual({ kind: "zoomFit" });
    expect(keyAction(k({ key: "'", code: "Digit2", shift: true }))).toEqual({ kind: "zoomSelection" });
    expect(keyAction(k({ key: "h", alt: true }))).toBeNull();
  });

  it("Enter: tek satırda metni düzenler, değilse kaydeder; düğmede düğmenin", () => {
    expect(keyAction(k({ key: "Enter", single: 2 }))).toEqual({ kind: "editText", index: 2 });
    expect(keyAction(k({ key: "Enter", single: 2, canEditText: false }))).toEqual({ kind: "save" });
    expect(keyAction(k({ key: "Enter" }))).toEqual({ kind: "save" });
    expect(keyAction(k({ key: "Enter", tag: "BUTTON" }))).toBeNull();
  });
});
