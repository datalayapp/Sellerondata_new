import type { PrintTemplateCreate, PrintTemplatePatch, PrintTemplateView } from "@tagpress/domain";
import { defaultStickerFlow } from "@tagpress/print";
import { i18n } from "../../../../i18n/index.ts";

/** Sayfa şablonu düzenleyicisinin taslağı: kaydedilene kadar istemcide (geri al / ileri al bunun üstünde). */
export type TemplateDraft = Pick<PrintTemplateView, "name" | "kind" | "paper" | "sizeId" | "slots" | "stickerFlow" | "cut" | "cellLabel" | "labelDiameterMm">;

export function draftOf(t: PrintTemplateView): TemplateDraft {
  return {
    name: t.name,
    kind: t.kind,
    paper: t.paper,
    sizeId: t.sizeId,
    slots: t.slots,
    stickerFlow: t.stickerFlow,
    cut: t.cut,
    cellLabel: t.cellLabel,
    labelDiameterMm: t.labelDiameterMm,
  };
}

/** Kayıt biçimine göre eşit mi (alan sırası önemsiz). */
export function sameDraft(a: TemplateDraft, b: TemplateDraft): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => p.localeCompare(q))) : x,
  );
}

/** Kaydet: yalnızca değişen üst alanlar gider (yuvalar değiştiyse tamamı; `cut`/`cellLabel` tam nesne — sunucu derin birleştirir). */
export function draftPatch(saved: TemplateDraft, d: TemplateDraft): PrintTemplatePatch {
  const out: PrintTemplatePatch = {};
  if (d.name !== saved.name) out.name = d.name.trim() || saved.name;
  if (d.kind !== saved.kind) out.kind = d.kind;
  if (stable(d.paper) !== stable(saved.paper)) out.paper = d.paper;
  if (d.sizeId !== saved.sizeId) out.sizeId = d.sizeId;
  if (stable(d.slots) !== stable(saved.slots)) out.slots = d.slots;
  if (stable(d.stickerFlow) !== stable(saved.stickerFlow)) out.stickerFlow = d.stickerFlow;
  if (stable(d.cut) !== stable(saved.cut)) out.cut = d.cut;
  if (stable(d.cellLabel) !== stable(saved.cellLabel)) out.cellLabel = d.cellLabel;
  if (d.labelDiameterMm !== saved.labelDiameterMm) out.labelDiameterMm = d.labelDiameterMm;
  return out;
}

/**
 * Yeni boş şablon (yuvasız; ızgara üreteciyle ya da elle doldurulur). Kağıt gönderilmez: sunucu firmanın kurulumdaki
 * kağıdını koyar (`print.defaults`, yoksa A4); kesim ve hücre etiketi de kurulum/sunucu varsayılanı.
 * Sticker sayfası satır akışıyla (eklentideki değerler) başlar: akışsız sticker şablonu planlanamaz.
 */
export function newTemplateBody(languageId: string, kind: "label" | "sticker", n: number): PrintTemplateCreate {
  return {
    languageId,
    name: i18n.t(kind === "label" ? "printTemplates:newName.label" : "printTemplates:newName.sticker", { n }),
    kind,
    slots: [],
    ...(kind === "sticker" ? { stickerFlow: defaultStickerFlow() } : {}),
  };
}
