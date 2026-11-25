import { checkEdits, checkPlacement, EditFontError, editableFonts, layout, lineBaseFont, renderPreview, resolveEdits, textLayerSvg } from "@tagpress/engine";
import type { Engine } from "../ports.ts";
import { HttpError } from "../util/errors.ts";
import type { FontRegistryCache } from "./fonts.ts";

/** Önizleme ölçeği: 440 px tasarım alanı → 660 px görsel (karşılaştırma ekranında net, dosya küçük). */
export const PREVIEW_SCALE = 1.5;

/** engine paketine bağlantı: yerleşim, önizleme, yerleşim denetimi ve satır düzenleme. */
export function createEngineAdapter(fonts: FontRegistryCache, opts: { previewScale?: number } = {}): Engine {
  const scale = opts.previewScale ?? PREVIEW_SCALE;
  return {
    layout: ({ intent, text, profile, geometry, fontsDir }) => layout({ text, intent, profile, geometry, fonts: fonts.forProfile(fontsDir, profile) }),
    async render({ layout: result, geometry, profile, fontsDir }) {
      const ids = [...new Set(result.lines.flatMap((l) => l.runs.map((r) => r.fontId)))];
      const reg = fontsDir ? fonts.forProfile(fontsDir, profile) : fonts.findWith(ids);
      if (!reg) throw new Error("Önizleme için yerleşimin fontları bulunamadı.");
      return renderPreview(result, geometry, reg, { scale, profile });
    },
    checkPlacement: ({ layout: result, geometry, profile, fontsDir }) => checkPlacement(result, geometry, fonts.forProfile(fontsDir, profile), profile),
    textLayerSvg: ({ layout: result, profile, fontsDir }) => textLayerSvg(result, fonts.forProfile(fontsDir, profile), { profile }),
    editLines({ layout: base, edits, profile, fontsDir, jobText }) {
      const reg = fonts.forProfile(fontsDir, profile);
      try {
        const r = resolveEdits(base, edits, profile, reg);
        const c = checkEdits({ base, edited: r.layout, edits: r.edits, jobText, profile, unprintable: r.unprintable, partialChars: r.partialChars, monochromeChars: r.monochromeChars, lineFont: (i) => lineBaseFont(r.layout, i, profile, reg) });
        return { edits: r.edits, layout: r.layout, issues: c.issues, textEdited: c.textEdited, linesChanged: c.linesChanged };
      } catch (e) {
        if (e instanceof EditFontError) throw new HttpError(400, e.message, undefined, "edit-font", { detail: e.message });
        throw e;
      }
    },
    editFonts({ layout: result, profile, fontsDir }) {
      const reg = fonts.forProfile(fontsDir, profile);
      const list = editableFonts(profile, reg).map((f) => ({ id: f.id, family: f.family, style: f.style, kind: f.kind }));
      const lineFonts = result.lines.map((_, i) => {
        try {
          return lineBaseFont(result, i, profile, reg);
        } catch {
          return "";
        }
      });
      return { fonts: list, lineFonts };
    },
  };
}
