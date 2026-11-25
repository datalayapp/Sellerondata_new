import { normalizeCut, type TemplateCutInput, type TemplateCutShape } from "@tagpress/domain";
import { formatNumber } from "../../i18n/bicim.ts";
import { i18n } from "../../i18n/index.ts";

/**
 * Şablonlar ekranının sözlük metinleri (`templates` ad alanı). Saf mantık dosyaları (`mantik/*.ts`) metni
 * buradan alır; eski ve yeni ekran aynı sözlüğü okur, testler TR sözlüğüyle bugünkü Türkçe sonucu denetler.
 */

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts) as string;

/** Süzgecin adı ("Hepsi", "Elle alan"…). */
export function filterLabel(id: string): string {
  return t(`templates:filters.${id}`);
}

const SORT_KEY: Record<string, string> = { key: "key", "key-desc": "keyDesc", updated: "updated" };

/** Sıralamanın adı; `id` "key", "key-desc", "updated". */
export function sortLabel(id: string): string {
  return t(`templates:sorts.${SORT_KEY[id] ?? id}`);
}

/** Değişen alanın adı ("Kurdele", "Kesim"…). */
export function fieldLabel(field: string): string {
  return t(`templates:fields.${field}`);
}

/** Değişiklik kaynağının adı ("elle", "ölçülmüş"…). */
export function sourceLabel(source: string): string {
  return t(`templates:sources.${source}`);
}

/** Hedef merkez var ama geçmişte satırı yok. */
export function unknownSourceText(): string {
  return t("templates:center.unknownSource");
}

/** Uç sunucuda yoksa (404/405/501) gösterilen not. */
export function unsupportedText(): string {
  return t("templates:unsupported.body");
}

/** Şablon türünün adı ("Etiket", "Sticker", "Üretilmiş"). */
export function kindLabel(kind: string): string {
  return t(`templates:kinds.${kind}`);
}

/** Kesim şeklinin adı ("Daire", "Köşesi yuvarlak"…); "inherit" = tasarım dilindeki. */
export function cutShapeLabel(shape: TemplateCutShape | "inherit"): string {
  return t(`templates:cut.shapes.${shape}`);
}

const mm = (v: number) => formatNumber(v, { maximumFractionDigits: 2 });

/** Kesimin boyut adı, etkin dilin ondalık ayırıcısıyla: "Ø38 mm", "63,5 × 38,1 mm". */
export function cutSizeText(cut: TemplateCutInput): string {
  const c = normalizeCut(cut);
  if (c.shape === "circle") return t("templates:cut.sizeCircle", { d: mm(c.wMm) });
  return t("templates:cut.size", { w: mm(c.wMm), h: mm(c.hMm) });
}
