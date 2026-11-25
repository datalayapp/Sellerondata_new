import {
  type AdjustCheckResponse,
  type AdjustRelayoutRequest,
  type CenterAxis,
  type CenterTarget,
  editsKey,
  IDENTITY_ADJUST,
  type Issue,
  normalizeAdjust,
  stripPlaced,
  type VariantAdjust,
  type VariantAdjustRequest,
  type VariantEditModel,
} from "@tagpress/domain";
import { type FontScopeKind, fontPlaceholder, fontScopeLabel, targetLabel } from "../metin.ts";
import { trimRange, withLineFont, withSpanFont, withText } from "./adjust-edit.ts";
import { sameAdjust, scaleKeyStep } from "./adjust-math.ts";
import { isSelected, type Sel, STROKE_STEP, toggleSel } from "./adjust-select.ts";

/**
 * Düzelt oturumunun saf mantığı (eski `AdjustDialog` içinden çıkarıldı; yeni Düzelt ekranı da kullanır):
 * yerinde metin düzenleme, font kapsamı, kirli durum ve kaydetme gövdesi, otomatik denetim sonucunun işlenmesi,
 * tuvale basınca seçim kararı ve eski pencerenin klavye eşlemesi. DOM ve React yok.
 */

/** Düzenleme yokken yazı katmanının anahtarı. */
export const BASE_TEXT_KEY = editsKey(undefined);

// ---------------------------------------------------------------- metin düzenleme

/** Yerinde metin düzenleme: satır, taslak ve taslaktaki seçim aralığı (UTF-16). */
export interface Editing {
  index: number;
  draft: string;
  /** Düzenlemeye başlarken görünen metin (parça fontları buna göre taşınır). */
  current: string;
  start: number;
  end: number;
}

/** Satırın düzenlemesini başlatır: taslak görünen metin, bütün metin seçili. Satır yoksa null. */
export function beginEditing(lines: ReadonlyArray<{ text: string }>, index: number): Editing | null {
  const line = lines[index];
  if (!line) return null;
  return { index, draft: line.text, current: line.text, start: 0, end: line.text.length };
}

/** Taslak ve seçim değişti. */
export function editDraft(ed: Editing, draft: string, start: number, end: number): Editing {
  return { ...ed, draft, start, end };
}

/** Yalnız seçim değişti. */
export function editRange(ed: Editing, start: number, end: number): Editing {
  return ed.start === start && ed.end === end ? ed : { ...ed, start, end };
}

/** Taslakta metnin bir KISMI seçiliyse düzenleme (font o parçaya uygulanır); bütün metin ya da hiçbiri seçiliyse null. */
export function partialRange(ed: Editing | null): Editing | null {
  return ed && ed.end > ed.start && !(ed.start === 0 && ed.end >= ed.draft.length) ? ed : null;
}

/** Fontun uygulanacağı yer: seçili parça, bütün yazı, birkaç satır ya da tek satır. */
export type FontScope = { kind: "span"; text: string } | { kind: "all" } | { kind: "lines"; count: number } | { kind: "line" };

export function fontScope(ed: Editing | null, sel: Sel): FontScope {
  const r = partialRange(ed);
  if (r) return { kind: "span", text: r.draft.slice(r.start, r.end) };
  if (sel === null) return { kind: "all" };
  return sel.length > 1 ? { kind: "lines", count: sel.length } : { kind: "line" };
}

/** "Font (seçili parça)" ve benzeri. */
export function fontScopeText(s: FontScope): string {
  return fontScopeLabel(s.kind as FontScopeKind, s.kind === "lines" ? s.count : 0);
}

/** Font seçicisinin boş seçeneği: parçada "“Ke” için font seç", karışıkta "Karışık". */
export function fontEmptyText(s: FontScope): string {
  return fontPlaceholder(s.kind === "span" ? s.text : null);
}

export type DraftResult = { ok: true; next: VariantAdjust } | { ok: false; reason: "empty" };

/**
 * Taslağı düzeltmeye yazar (henüz motorla ölçülmemiş niyet). Satır sonları boşluğa döner, kenar boşlukları atılır;
 * boş satır yazılmaz. `font` verilirse: bütün metin seçiliyse satırın fontu, bir kısmı seçiliyse yalnız o parçanın fontu.
 * `original`: motorun özgün satır metni (aynıysa metin düzenlemesi kalkar).
 */
export function applyDraft(present: VariantAdjust, ed: Editing, original: string, font: string | undefined, baseFont: (i: number) => string | undefined): DraftResult {
  const t = trimRange(ed.draft.replace(/[\r\n]+/g, " "), ed.start, ed.end);
  if (!t.text) return { ok: false, reason: "empty" };
  let next = withText(present, ed.index, t.text, original, ed.current);
  if (font && t.start === 0 && t.end === t.text.length) next = withLineFont(next, [ed.index], font, baseFont);
  else if (font && t.end > t.start) next = withSpanFont(next, ed.index, t.start, t.end, font, t.text.length);
  return { ok: true, next };
}

/**
 * Font seçilince ne yapılır: taslakta seçim varsa taslak ve font TEK adımda yazılır; açık taslak varsa önce taslak,
 * font onun sonucunun üstüne (iki istek yarışmasın); taslak yoksa seçili satırlara (bütün yazıda hepsine).
 */
export type FontPlan = "draft-with-font" | "draft-then-lines" | "lines";

export function fontPlan(ed: Editing | null): FontPlan {
  if (ed && ed.end > ed.start) return "draft-with-font";
  return ed ? "draft-then-lines" : "lines";
}

/** Model fontunun görünen adı: "Great Vibes", "Inter Bold"; listede yoksa kimlik ("/Regular" atılır). */
export function fontLabel(fonts: VariantEditModel["fonts"], id: string): string {
  const f = fonts?.find((x) => x.id === id);
  return f ? (f.style && f.style !== "Regular" ? `${f.family} ${f.style}` : f.family) : id.replace(/\/Regular$/, "");
}

// ---------------------------------------------------------------- kirli durum, gövdeler

/** Kayıtlıdan farklı mı (kayıt biçimine göre)? */
export function isDirty(cur: VariantAdjust, saved: VariantAdjust | null | undefined): boolean {
  return !sameAdjust(cur, saved);
}

/** Kaydet düğmesi açık mı: değişiklik (ya da açık taslak) var, kayıt ve ölçüm sürmüyor. */
export function canSave(s: { dirty: boolean; editing: boolean; saving: boolean; busy: boolean }): boolean {
  return (s.dirty || s.editing) && !s.saving && !s.busy;
}

/** PUT `variantAdjust` gövdesi: normalleştirilmiş düzeltme; etkisizse kimlik (sunucuda "kaldır" sayılır). */
export function saveBody(a: VariantAdjust): VariantAdjustRequest {
  return { adjust: normalizeAdjust(a) ?? IDENTITY_ADJUST };
}

/** POST `variantAdjustCheck` gövdesi. */
export function checkBody(a: VariantAdjust): VariantAdjustRequest {
  return { adjust: a };
}

/** POST `variantEditRelayout` gövdesi (`placed` atılır; motor yeniden ölçer). */
export function relayoutBody(a: VariantAdjust): AdjustRelayoutRequest {
  return { edits: stripPlaced(a.edits) };
}

/** Geçmiş adımlarının birleştirme anahtarı: aynı işlem + aynı seçim (ok tuşu dizisi tek adım olsun). */
export function mergeKey(key: string | undefined, sel: Sel): string | null {
  return key ? `${key}:${sel ? sel.join(",") : "b"}` : null;
}

// ---------------------------------------------------------------- otomatik denetim

export interface CheckView {
  /** Gösterilecek sorunlar (denetim + metin düzenlemesinin notları, tekrarsız). */
  issues: Issue[];
  /** Denetim geldi ve çarpışma yok: "Yazı kesimin içinde ve süslemeye değmiyor." */
  contained: boolean;
  /** Metin elle değişti ve iş metninden farklı (`text-edited`). */
  textEdited: boolean;
}

/**
 * Denetim yanıtını görünüme çevirir. `extra`: elle metin/font düzenlemesinin motordan gelen notları (yedek font,
 * basılamayan karakter, aile sayısı); aynı kod ve cümle bir kez gösterilir.
 */
export function checkView(check: AdjustCheckResponse | null, cur: VariantAdjust, extra: readonly Issue[] = []): CheckView {
  const seen = new Set<string>();
  const issues = [...(check?.issues ?? []), ...extra].filter((i) => {
    const k = `${i.code}\u0000${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    issues,
    contained: !!check && !issues.some((i) => i.code === "collision"),
    textEdited: (cur.edits ?? []).some((x) => x.text !== undefined) && issues.some((i) => i.code === "text-edited"),
  };
}

/** Ortalama hedefi seçenekleri: şablonda hedef merkez kayıtlıysa o ve yazı alanı ayrı; kesim merkezi her zaman. */
export function centerTargets(centers: VariantEditModel["centers"]): { value: CenterTarget; label: string }[] {
  const src = centers.textCenter.source;
  return [
    { value: "textCenter", label: targetLabel("textCenter", src) },
    ...(src === "template" ? [{ value: "area" as const, label: targetLabel("area", src) }] : []),
    { value: "cut", label: targetLabel("cut", src) },
  ];
}

// ---------------------------------------------------------------- tuvale basma

export interface PressPlan {
  /** Basıştan sonraki seçim. */
  sel: Sel;
  /** Başlayan sürükleme: taşıma, seçim kutusu ya da yok (Ctrl ile çıkarılan satır sürüklenmez). */
  drag: "move" | "marquee" | null;
}

/**
 * Tuvale (sol tuşla) basınca: satıra basıldıysa seçilir (Ctrl/Shift ile eklenir ya da çıkarılır) ve taşıma başlar;
 * boşluğa basıldıysa (ya da Ctrl/Shift basılıyken yazı dışına) seçim kutusu; bloğun içine ama satır dışına basıldıysa
 * bütün yazı seçilir ve taşınır; seçim kutusunun içine basıldıysa seçim korunur.
 */
export function pressPlan(p: { hit: number | null; add: boolean; sel: Sel; lineCount: number; inBlock: boolean; inSel: boolean }): PressPlan {
  if (p.hit !== null) {
    let sel = p.sel;
    if (p.add) sel = toggleSel(p.sel, p.hit, p.lineCount);
    else if (!isSelected(p.sel, p.hit)) sel = [p.hit];
    if (p.add && !isSelected(sel, p.hit)) return { sel, drag: null };
    return { sel, drag: "move" };
  }
  if (p.add || (!p.inBlock && !p.inSel)) return { sel: p.sel, drag: "marquee" };
  return { sel: p.inSel ? p.sel : null, drag: "move" };
}

/** Seçim kutusu bırakılınca: sürüklemeden tık (ekleme değilse) bütün yazıyı seçer. */
export function marqueeEnd(p: { moved: boolean; add: boolean; sel: Sel }): Sel {
  return !p.moved && !p.add ? null : p.sel;
}

// ---------------------------------------------------------------- eski pencerenin klavyesi

export interface KeyInput {
  key: string;
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** Odaktaki öğenin etiketi (BUTTON, INPUT…) ve düzenlenebilirliği. */
  tag: string | null;
  editable: boolean;
  /** Olay yerinde düzenleme kutusundan mı (kutu kendi tuşlarını işler). */
  inEditor: boolean;
  editing: boolean;
  /** Satır seçimi var mı (bütün yazı değil). */
  hasSel: boolean;
  ready: boolean;
  /** Odak sahnede mi (Tab satırlarda gezsin). */
  stageFocused: boolean;
  /** Tek satır seçiliyse sırası. */
  single: number | null;
  canEditText: boolean;
}

export type KeyAction =
  | { kind: "cancelEdit" | "clearSel" | "close" | "save" | "zoomIn" | "zoomOut" | "zoomFit" | "zoomSelection" | "zoomActual" | "selectAll" | "undo" | "redo" | "panStart" | "reset" }
  | { kind: "stroke"; step: number }
  | { kind: "cycle"; back: boolean }
  | { kind: "nudge"; key: string; shift: boolean }
  | { kind: "scale"; step: number }
  | { kind: "center"; axis: CenterAxis }
  | { kind: "editText"; index: number };

/**
 * Eski Düzelt penceresinin tuş eşlemesi (yeni ekran kısayol kaydını kullanır). Dönen eylemin olayı durdurulur;
 * null: pencere bu tuşa karışmaz. Sıra önemlidir (ör. Ctrl S yazı alanında da çalışır, Esc her zaman).
 */
export function keyAction(k: KeyInput): KeyAction | null {
  if (k.editing && k.inEditor) return null;
  if (k.key === "Escape") return { kind: k.editing ? "cancelEdit" : k.hasSel ? "clearSel" : "close" };
  if (!k.ready) return null;
  const typing = k.editable || k.tag === "INPUT" || k.tag === "TEXTAREA" || k.tag === "SELECT";
  const mod = k.ctrl || k.meta;
  const lower = k.key.toLowerCase();
  if (mod && !k.alt) {
    if (lower === "s" || k.key === "Enter") return { kind: "save" };
    // Yakınlaştırma: Ctrl + = / + büyütür, Ctrl + - küçültür, Ctrl + 0 sığdırır (tarayıcının sayfa yakınlaştırması yerine).
    if (k.key === "=" || k.key === "+" || k.code === "NumpadAdd") return { kind: "zoomIn" };
    if (k.key === "-" || k.key === "_" || k.code === "NumpadSubtract") return { kind: "zoomOut" };
    if (k.key === "0" || k.code === "Digit0" || k.code === "Numpad0") return { kind: "zoomFit" };
  }
  if (typing) return null;
  if (mod && !k.alt && lower === "a") return { kind: "selectAll" };
  if (mod && !k.alt && (lower === "z" || lower === "y")) return { kind: lower === "y" || k.shift ? "redo" : "undo" };
  // Kalınlık: [ ] (Türkçe klavyede AltGr ile gelir, bu yüzden değiştirici tuşlara bakılmaz) ya da , .
  if (k.key === "[" || k.key === "]" || (!mod && !k.alt && (k.key === "," || k.key === "."))) {
    return { kind: "stroke", step: k.key === "[" || k.key === "," ? -STROKE_STEP : STROKE_STEP };
  }
  if (k.key === "Tab" && k.stageFocused && !mod && !k.alt) return { kind: "cycle", back: k.shift };
  // Boşluk basılıyken sürükleme kaydırır (düğmedeyken düğmenin kendi Boşluk'u çalışır).
  if (k.key === " " && !mod && k.tag !== "BUTTON") return { kind: "panStart" };
  if (mod || k.alt) return null;
  // Shift + 1 sığdır, Shift + 2 seçime yakınlaştır (klavye düzeninden bağımsız: tuş kodu).
  if (k.shift && k.code === "Digit1") return { kind: "zoomFit" };
  if (k.shift && k.code === "Digit2") return { kind: "zoomSelection" };
  if (k.key.startsWith("Arrow")) return { kind: "nudge", key: k.key, shift: k.shift };
  const s = scaleKeyStep(k.key);
  if (s !== null) return { kind: "scale", step: s };
  switch (lower) {
    case "h":
      return { kind: "center", axis: "x" };
    case "v":
      return { kind: "center", axis: "y" };
    case "c":
      return { kind: "center", axis: "both" };
    case "0":
      return { kind: "reset" };
    case "1":
      return { kind: "zoomActual" };
    case "enter":
      if (k.tag === "BUTTON") return null; // düğmenin kendi Enter'ı
      // Tek satır seçiliyken Enter metni düzenler; değilse kaydeder.
      return k.single !== null && k.canEditText ? { kind: "editText", index: k.single } : { kind: "save" };
  }
  return null;
}
