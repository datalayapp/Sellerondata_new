import { type Box, effectiveCut, type LabelSize, type Profile, type Shape, type TemplateCut, templateImageBox } from "@tagpress/domain";
import { frameSideMm } from "../../duzelt/olcu.ts";

/**
 * Şablon tuvalinin ölçüleri (saf). Şablon kayıtlarının birimi tasarım alanı pikseli (`designFramePx` kenarlı kare) ve
 * orandır; tuvalin dünya birimi mm. Ölçek: şablonun kendi kesimi varsa ondan (`effectiveCut().mmPerPx`), yoksa
 * tasarım dilinin varsayılan etiket boyutundan (Düzelt'teki formülle aynı).
 */

/** Profil okunamadıysa ya da eksikse kullanılan değerler (şemanın varsayılanları). */
export const OUTPUT_DEFAULTS = {
  designFramePx: 440,
  cut: { kind: "circle", cx: 219.82, cy: 219.82, r: 218.82 } as Shape,
  templateBox: { x: 10, y: 10, w: 420, h: 420 } as Box,
  sizes: [] as LabelSize[],
  defaultSize: "3.8",
};

export type OutputLike = typeof OUTPUT_DEFAULTS;

/** Profilin çıktı ayarları, eksik alanlar varsayılanla. */
export function outputOf(profile: { output?: Partial<Profile["output"]> } | null | undefined): OutputLike {
  const o = profile?.output ?? {};
  return {
    designFramePx: o.designFramePx && o.designFramePx > 0 ? o.designFramePx : OUTPUT_DEFAULTS.designFramePx,
    cut: o.cut ?? OUTPUT_DEFAULTS.cut,
    templateBox: o.templateBox ?? OUTPUT_DEFAULTS.templateBox,
    sizes: o.sizes ?? OUTPUT_DEFAULTS.sizes,
    defaultSize: o.defaultSize ?? OUTPUT_DEFAULTS.defaultSize,
  };
}

export interface TemplateScale {
  /** Tasarım alanı kenarı (px). */
  framePx: number;
  /** mm / tasarım pikseli. */
  mmPerPx: number;
  /** Tasarım alanının fiziksel kenarı (mm): tuvalin dünyası. */
  frameMm: number;
  /** Etkin kesim (tasarım px). */
  cutPx: Shape;
  /** Görselin tasarım alanındaki kutusu (px). */
  imageBox: Box;
}

/** Şablonun tuval ölçüleri: kesim (şablonun ya da dilin), görsel kutusu ve mm ölçeği. */
export function templateScale(out: OutputLike, template: { cut: TemplateCut | null; imageBox: Box | null }): TemplateScale {
  const profile = { output: out } as unknown as Pick<Profile, "output">;
  const eff = effectiveCut({ cut: template.cut }, profile);
  const F = out.designFramePx;
  const mmPerPx = eff.mmPerPx ?? frameSideMm({ sizes: out.sizes, defaultSize: out.defaultSize, designFramePx: F }) / F;
  return { framePx: F, mmPerPx, frameMm: F * mmPerPx, cutPx: eff.shape, imageBox: templateImageBox({ imageBox: template.imageBox, cut: template.cut }, profile) };
}
