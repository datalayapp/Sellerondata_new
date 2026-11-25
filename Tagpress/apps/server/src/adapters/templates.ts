import { buildGeometry, buildStickerGeometry, renderOverlay, templateKeyFromInput } from "@tagpress/templates";
import type { GeometryProvider, TemplateResolver } from "../ports.ts";
import { basicTemplateResolver } from "../wiring.ts";

/**
 * templates paketine bağlantı. Şablon çözümü paketin `templateKeyFromInput`'u ile yapılır; paket bilinmeyen
 * anahtar için null döndüğünden, "şablon yok" (template-unknown) mesajı için anahtarın yazıldığı hâl ve profilde
 * olmayan boyut sade çözücüden alınır.
 */
export const templatesResolver: TemplateResolver = {
  resolve(input, ctx) {
    const r = templateKeyFromInput(input, ctx.keys, ctx.sizes);
    if (r.key) return { key: r.key, size: r.size, unknownSize: null, suggestions: [] };
    const basic = basicTemplateResolver.resolve(input, ctx);
    return { key: basic.key, size: r.size ?? basic.size, unknownSize: r.size ? null : basic.unknownSize, suggestions: r.suggestions };
  },
};

/** Şablon geometrisi (sticker sayfası dahil: zeminsiz, dikdörtgen ya da daire yazı alanı) ve alan bindirmesi. */
export const templatesGeometry: GeometryProvider = {
  forTemplate: ({ template, imagePath, profile }) => buildGeometry(template, profile, { imagePath }),
  forSticker: async ({ sheet, profile }) => buildStickerGeometry(sheet, profile),
  overlay: async ({ template, imagePath, profile }) => renderOverlay(await buildGeometry(template, profile, { imagePath })),
};
