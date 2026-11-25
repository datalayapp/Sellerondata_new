import type { Box, Point, Template, TemplateArea, TemplateCut, TemplatePatch } from "@tagpress/domain";
import { fieldLabel, sourceLabel, unknownSourceText } from "../metin.ts";

/**
 * Düzenleme taslağı. Sunucudan gelen kayıt (`orig`) ile kullanıcının DOKUNDUĞU alanlar (`changes`) ayrı tutulur:
 * kayıt sırasında yalnızca dokunulan ve gerçekten değişen alanlar gönderilir. Eski sistemin hatası, kayıt güncellemesinin
 * ölçülmüş alanları (hedef merkez, geçmiş) silmesiydi; burada hiçbir zaman tam kayıt üzerine yazılmaz.
 * Sunucu arada başka bir alanı güncellerse (ör. öğrenilen merkez) kullanıcının taslağı onu ezmez.
 */

export type DecorationSettings = { source: "auto" | "alpha" | "color"; threshold: number; dilatePx: number };
export type TemplateKind = "label" | "sticker" | "generated";

export interface EditState {
  kind: TemplateKind;
  area: TemplateArea;
  ribbonTop: number;
  textCenter: Point | null;
  ignoreDecorationInArea: boolean;
  decoration: DecorationSettings;
  printedText: boolean;
  notes: string;
  tags: string[];
  imageBox: Box | null;
  /** Şablonun kendi kesimi (mm); null = tasarım dilinin kesimi. */
  cut: TemplateCut | null;
}

/** Kullanıcının dokunduğu alanlar; `decoration` alt anahtar bazında. */
export type EditChanges = Partial<Omit<EditState, "decoration">> & { decoration?: Partial<DecorationSettings> };

export const DECORATION_DEFAULTS: DecorationSettings = { source: "auto", threshold: 18, dilatePx: 3 };

/** Şablon kaydından düzenlenebilir görünüm (eksik alanlara şema varsayılanları). */
export function editStateOf(t: Partial<Template>): EditState {
  return {
    kind: t.kind ?? "label",
    area: t.area ?? { mode: "auto" },
    ribbonTop: t.ribbonTop ?? 0,
    textCenter: t.textCenter ?? null,
    ignoreDecorationInArea: t.ignoreDecorationInArea ?? false,
    decoration: { ...DECORATION_DEFAULTS, ...(t.decoration ?? {}) },
    printedText: t.printedText ?? false,
    notes: t.notes ?? "",
    tags: t.tags ?? [],
    imageBox: t.imageBox ?? null,
    cut: t.cut ?? null,
  };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Sunucu kaydı + dokunulan alanlar = ekranda gösterilen durum. */
export function effective(orig: EditState, ch: EditChanges): EditState {
  return { ...orig, ...ch, decoration: { ...orig.decoration, ...(ch.decoration ?? {}) } } as EditState;
}

/** Bir alanı değiştir. Özgün değere geri dönülürse dokunma kaydı silinir. */
export function setField<K extends keyof Omit<EditState, "decoration">>(orig: EditState, ch: EditChanges, key: K, value: EditState[K]): EditChanges {
  const next: EditChanges = { ...ch };
  if (deepEqual(orig[key], value)) delete next[key];
  else (next as Record<string, unknown>)[key] = value;
  return next;
}

export function setDecoration(orig: EditState, ch: EditChanges, key: keyof DecorationSettings, value: DecorationSettings[keyof DecorationSettings]): EditChanges {
  const dec: Partial<DecorationSettings> = { ...(ch.decoration ?? {}) };
  if (deepEqual(orig.decoration[key], value)) delete dec[key];
  else (dec as Record<string, unknown>)[key] = value;
  const next: EditChanges = { ...ch };
  if (Object.keys(dec).length) next.decoration = dec;
  else delete next.decoration;
  return next;
}

/** Sunucuya gidecek KISMİ nesne: yalnızca özgünden farklı olan, dokunulmuş alanlar. Boşsa `{}`. */
export function buildPatch(orig: EditState, ch: EditChanges): TemplatePatch {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ch)) {
    if (k === "decoration") continue;
    if (!deepEqual((orig as unknown as Record<string, unknown>)[k], v)) patch[k] = v;
  }
  if (ch.decoration) {
    const dec: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ch.decoration)) {
      if (!deepEqual((orig.decoration as Record<string, unknown>)[k], v)) dec[k] = v;
    }
    if (Object.keys(dec).length) patch.decoration = dec;
  }
  return patch;
}

export const isDirty = (orig: EditState, ch: EditChanges) => Object.keys(buildPatch(orig, ch)).length > 0;

/** Sözlükteki adı okunan alanlar (`templates:fields.<alan>`). */
const FIELD_KEYS = ["kind", "area", "ribbonTop", "textCenter", "ignoreDecorationInArea", "decoration", "printedText", "notes", "tags", "imageBox", "cut"] as const;

/**
 * Bir anahtar kümesinden sözlük okuyan salt okunur tablo: `TABLO[k] ?? k` kullanımı aynı kalır, ad okunduğu anda
 * etkin dilde gelir (bilinmeyen anahtar `undefined`).
 */
function labelTable(keys: readonly string[], read: (k: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) Object.defineProperty(out, k, { get: () => read(k), enumerable: true });
  return out;
}

/** Değişen alanların kullanıcıya gösterilecek adları (`templates:fields.*`). */
export const FIELD_LABELS: Record<string, string> = labelTable(FIELD_KEYS, fieldLabel);

export function changedLabels(patch: TemplatePatch): string[] {
  return Object.keys(patch).map((k) => FIELD_LABELS[k] ?? k);
}

// ---------------------------------------------------------------- geçmiş (provenance)

/** Değişiklik kaynaklarının adları (`templates:sources.*`). */
export const SOURCE_LABELS: Record<string, string> = labelTable(["user", "measured", "learned", "migrated", "auto"], sourceLabel);

/** Hedef merkezin kaynağı: kayıttaki en son `textCenter` satırı; merkez yoksa null. */
export function centerSource(t: Partial<Template>): { label: string; source: string; samples?: number } | null {
  if (!t.textCenter) return null;
  const rows = (t.provenance ?? []).filter((p) => p.field === "textCenter");
  const last = rows[rows.length - 1];
  if (!last) return { label: unknownSourceText(), source: "unknown" };
  return { label: SOURCE_LABELS[last.source] ?? last.source, source: last.source, samples: last.samples };
}

// ---------------------------------------------------------------- tarayıcıda taslağı koruma

const KEY = (lang: string, key: string) => `studio.sablon.taslak:${lang}:${key}`;

export function saveDraft(lang: string, key: string, updatedAt: string, ch: EditChanges) {
  try {
    if (Object.keys(ch).length === 0) sessionStorage.removeItem(KEY(lang, key));
    else sessionStorage.setItem(KEY(lang, key), JSON.stringify({ updatedAt, ch }));
  } catch {
    /* gizli pencere */
  }
}

export function loadDraft(lang: string, key: string, updatedAt: string): EditChanges | null {
  try {
    const raw = sessionStorage.getItem(KEY(lang, key));
    if (!raw) return null;
    const v = JSON.parse(raw) as { updatedAt: string; ch: EditChanges };
    // Kayıt arada değiştiyse eski taslak güvenilir değil: at.
    return v.updatedAt === updatedAt ? v.ch : null;
  } catch {
    return null;
  }
}

export function clearDraft(lang: string, key: string) {
  try {
    sessionStorage.removeItem(KEY(lang, key));
  } catch {
    /* gizli pencere */
  }
}
