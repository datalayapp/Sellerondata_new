import { emptyProfile, type Enforcement, type FieldDoc, PROFILE_DOCS, PROFILE_GROUPS, type ProfileGroup } from "@tagpress/domain";
import { tt } from "../dil.ts";
import { fieldHelp, fieldLabel, groupLabel as groupLabelText } from "../profilMetni.ts";
import { getPath } from "./profilePath.ts";

/**
 * Profil formunun tanımı. Alan listesi, etiketler, yardım, rozet ve seviye `PROFILE_DOCS`'tan gelir;
 * kontrol türü varsayılan profildeki değerin türünden çıkarılır. Yalnızca seçenek adları, sınırlar ve özel düzenleyiciler
 * burada elle yazılıdır (şemada okunabilir karşılıkları yok).
 */

export type EditorId =
  | "fonts"
  | "glyphs"
  | "connectorScales"
  | "chips"
  | "pair"
  | "examples"
  | "cut"
  | "box"
  | "sizes"
  | "defaultSize"
  | "sheets";

export interface SelectOption {
  value: string;
  label: string;
}

export type Control =
  | { kind: "toggle" }
  | { kind: "segmented"; options: SelectOption[] }
  | { kind: "number"; min?: number; max?: number; step: number; percent?: boolean; suffix?: string; nullable?: boolean }
  | { kind: "text" }
  | { kind: "textarea" }
  | { kind: "color" }
  | { kind: "custom"; editor: EditorId };

export interface FieldSpec {
  path: string;
  doc: FieldDoc;
  control: Control;
}

/** Seçenek: `label` okunduğu anda etkin dile göre sözlükten gelir (`designLanguage:enums.<alan>.<değer>`). */
const opt = (path: string, value: string): SelectOption => ({
  value,
  get label() {
    return tt(`designLanguage:enums.${path}.${value}`);
  },
});

export const ENUMS: Record<string, SelectOption[]> = {
  "fonts.mixing": [opt("fonts.mixing", "single"), opt("fonts.mixing", "two"), opt("fonts.mixing", "free")],
  "spacing.align": [opt("spacing.align", "center"), opt("spacing.align", "left"), opt("spacing.align", "right")],
  "lineBreaking.coupleStack": [opt("lineBreaking.coupleStack", "always"), opt("lineBreaking.coupleStack", "option"), opt("lineBreaking.coupleStack", "never")],
  "lineBreaking.customerBreaks": [opt("lineBreaking.customerBreaks", "hint"), opt("lineBreaking.customerBreaks", "strict"), opt("lineBreaking.customerBreaks", "ignore")],
  "weight.mode": [opt("weight.mode", "stroke"), opt("weight.mode", "real"), opt("weight.mode", "none")],
  "weight.align": [opt("weight.align", "outside"), opt("weight.align", "center")],
  "stickers.detect": [opt("stickers.detect", "empty-template"), opt("stickers.detect", "product-field")],
};

interface Bounds {
  min?: number;
  max?: number;
  step: number;
}
const B = (min: number | undefined, max: number | undefined, step: number): Bounds => ({ min, max, step });
export const BOUNDS: Record<string, Bounds> = {
  "sizing.fill": B(0.3, 1, 0.01),
  "sizing.tiers.primary": B(0.05, 2, 0.01),
  "sizing.tiers.secondary": B(0.05, 2, 0.01),
  "sizing.tiers.tertiary": B(0.05, 2, 0.01),
  "sizing.tiers.connector": B(0.05, 2, 0.01),
  "sizing.maxCapHeight": B(0.02, 0.6, 0.01),
  "sizing.minPt": B(0.5, 200, 0.5),
  "sizing.maxPt": B(0.5, 200, 0.5),
  "sizing.breathing": B(0, 0.2, 0.005),
  "sizing.edgeMargin": B(0, 0.2, 0.005),
  "sizing.initials.maxCapHeight": B(0.02, 0.8, 0.01),
  "spacing.inkGaps.normal": B(0, 2, 0.01),
  "spacing.inkGaps.beforeLast": B(0, 2, 0.01),
  "spacing.inkGaps.connector": B(0, 2, 0.01),
  "spacing.beforeLastRatio": B(0, 1, 0.01),
  "connectors.shiftEm": B(-2, 2, 0.01),
  "lineBreaking.maxLineChars": B(1, 200, 1),
  "lineBreaking.maxLines": B(1, 20, 1),
  "weight.widthEm": B(0, 0.1, 0.001),
  "weight.minPx": B(0, 50, 0.1),
  "weight.maxPx": B(0, 50, 0.1),
  "output.designFramePx": B(100, 4000, 1),
  "quality.suspectScore": B(0, 100, 1),
  "quality.readableMinPt": B(0.5, 50, 0.5),
};

export const EDITORS: Record<string, EditorId> = {
  "fonts.list": "fonts",
  glyphRules: "glyphs",
  "sizing.connectorScales": "connectorScales",
  "connectors.words": "chips",
  "lineBreaking.noLoneWords": "chips",
  "lineBreaking.typicalLines": "pair",
  "lineBreaking.examples": "examples",
  "output.cut": "cut",
  "output.templateBox": "box",
  "output.sizes": "sizes",
  "output.defaultSize": "defaultSize",
  "stickers.sheets": "sheets",
};

const TEXTAREAS = new Set(["description", "ai.instructions", "lineBreaking.notes"]);
const COLORS = new Set(["color.text", "color.onDark"]);
const NULLABLE_NUMBERS = new Set(["sizing.initials.maxCapHeight"]);

/** Birim adı: em, px, pt aynen; "karakter" ve "satır" sözlükten (`designLanguage:diff.unit.*`). */
export function unitSuffix(unit: string): string {
  return unit === "karakter" || unit === "satır" ? tt(`designLanguage:diff.unit.${unit === "satır" ? "satir" : unit}`) : unit; // i18n-ok: "karakter" ve "satır" profil belgesindeki birim kimlikleri, metin sözlükten
}

const DEFAULTS = emptyProfile("x");

export function controlFor(path: string): Control {
  const doc = PROFILE_DOCS[path];
  const editor = EDITORS[path];
  if (editor) return { kind: "custom", editor };
  const enumOptions = ENUMS[path];
  if (enumOptions) return { kind: "segmented", options: enumOptions };
  if (TEXTAREAS.has(path)) return { kind: "textarea" };
  if (COLORS.has(path)) return { kind: "color" };
  const sample = getPath(DEFAULTS, path);
  if (typeof sample === "boolean") return { kind: "toggle" };
  if (typeof sample === "number" || NULLABLE_NUMBERS.has(path)) {
    const b = BOUNDS[path] ?? { step: 1 };
    const percent = doc?.unit === "oran";
    return {
      kind: "number",
      min: b.min,
      max: b.max,
      step: b.step,
      percent,
      suffix: percent ? "%" : doc?.unit ? unitSuffix(doc.unit) : undefined,
      nullable: NULLABLE_NUMBERS.has(path),
    };
  }
  if (typeof sample === "string") return { kind: "text" };
  throw new Error(`Form tanımı yok: ${path}`); // i18n-ok: geliştirici hatası, arayüzde gösterilmez
}

/** Bir grubun alanları, `PROFILE_DOCS` sırasıyla (arayüzde gizli alanlar hariç). */
export function groupFields(group: ProfileGroup): FieldSpec[] {
  return Object.entries(PROFILE_DOCS)
    .filter(([, d]) => d.group === group && !d.hidden)
    .map(([path, doc]) => ({ path, doc, control: controlFor(path) }));
}

export function allFields(): FieldSpec[] {
  return PROFILE_GROUPS.flatMap((g) => groupFields(g.id));
}

const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i");

/** Etiket, yardım ve grup adında arar (Türkçe harf duyarsız). */
export function searchFields(query: string): FieldSpec[] {
  const q = fold(query.trim());
  if (!q) return [];
  return allFields().filter((f) => fold(`${fieldLabel(f.path)} ${fieldHelp(f.path)} ${groupLabelText(f.doc.group)}`).includes(q));
}

/** Alanı kimin uyguladığı: rozet adı ve ipucu (`designLanguage:enforcement.<tür>.{label,hint}`). */
const enforcementView = (kind: Enforcement) => ({
  get label() {
    return tt(`designLanguage:enforcement.${kind}.label`);
  },
  get hint() {
    return tt(`designLanguage:enforcement.${kind}.hint`);
  },
});
export const ENFORCEMENT_VIEW: Record<Enforcement, { label: string; hint: string }> = {
  motor: enforcementView("motor"),
  ai: enforcementView("ai"),
  ikisi: enforcementView("ikisi"),
  sistem: enforcementView("sistem"),
};

export function groupLabel(id: string): string {
  return groupLabelText(id);
}
