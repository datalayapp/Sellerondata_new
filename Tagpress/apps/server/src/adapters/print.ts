import { PrintImageStore, type PrintPdfPage, labelArtFor, printPagePng, printPageThumbnail, printPdf } from "@tagpress/engine";
import { neededCount, planLabelPages, planStickerPages, reflowPages } from "@tagpress/print";
import type { PrintPlanner, PrintRenderPage, PrintRenderer } from "../services/print/ports.ts";
import type { FontRegistryCache } from "./fonts.ts";

/** `@tagpress/print` planlayıcısına bağlantı (imzalar aynı; `neededCount` sayfa kapasitesi istemez). */
export function createPrintPlanner(): PrintPlanner {
  return {
    planLabelPages: (req) => planLabelPages(req),
    planStickerPages: (req) => planStickerPages(req),
    reflowPages: (req) => reflowPages(req),
    neededCount: ({ kind, quantity, rules }) => neededCount(quantity, rules, kind),
  };
}

/**
 * engine baskı render'ına bağlantı: sunucunun çizim girdisi (`PrintRenderPage`) → motorun `PrintPageRenderInput`'u.
 * Metin modunda yazı, varyasyonun (düzeltilmiş) yerleşiminden motorla yeniden çizilir (profil sürümünün fontları);
 * görüntü modunda ayrılmış yazı katmanı PNG'si şablon kutusuna konur (şablon pikseline dokunulmaz).
 */
export function createPrintRenderer(fonts: FontRegistryCache): PrintRenderer {
  const toInput = (page: PrintRenderPage): PrintPdfPage => ({
    name: page.name,
    copies: page.copies,
    paper: page.paper,
    slots: page.slots,
    cut: page.cut,
    cellLabels: page.cellLabels.map((c) => ({ text: c.text, xMm: c.xMm, yMm: c.yMm, style: page.cellLabel })),
    items: page.items.map((it) => {
      const imageMode = it.variantKind === "image-on-template" && !!it.textLayerPath;
      const art = labelArtFor({
        key: `${it.variantId}:${it.printKind}`,
        geometry: {
          framePx: it.framePx,
          cut: it.cut ?? it.profile.output.cut,
          imagePath: it.templatePath ?? "",
          templateBox: it.templateBox ?? it.profile.output.templateBox,
        },
        kind: it.printKind,
        layout: imageMode ? null : it.layout,
        adjust: null,
        ...(it.layout && !imageMode ? { fonts: fonts.forProfile(it.fontsDir, it.profile) } : {}),
        profile: it.profile,
        textLayerPng: imageMode ? it.textLayerPath : null,
      });
      return { xMm: it.centerMm.x, yMm: it.centerMm.y, rotation: it.rotation, scale: 1, diameterMm: it.diameterMm, art: { ...art, anchor: it.anchorPx } };
    }),
  });
  return {
    async renderPagePng({ page, dpi, widthPx }) {
      const input = toInput(page);
      return widthPx ? printPageThumbnail(input, { widthPx }) : printPagePng(input, { dpi });
    },
    async renderPdf({ pages, dpi, mode, title, onPage }) {
      const images = new PrintImageStore();
      const pdf = await printPdf(pages.map(toInput), { dpi, images, ...(mode ? { mode } : {}), ...(title ? { title } : {}) });
      onPage?.(pages.length, pages.length);
      return Buffer.from(pdf);
    },
  };
}
