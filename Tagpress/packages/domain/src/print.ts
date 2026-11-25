import { z } from "zod";
import { TemplateCutSchema } from "./cut.ts";
import { MessageParamsSchema } from "./messages.ts";
import { BLEED_MM, CUT_LINE_MM, PRINT_DPI_MAX, PRINT_DPI_MIN, REGISTRATION_INSET_MM, REGISTRATION_SIZE_MM, REGISTRATION_THICKNESS_MM } from "./units.ts";

/**
 * Baskı masası sözleşmesi: uygulama içi baskı sayfaları (etiket sayfası daireleri, sticker sayfaları), yerleşim ve çıktı.
 *
 * Birim her yerde **mm**; koordinat kağıdın sol üst köşesinden (0,0), x sağa, y aşağı. Motor etiketleri 440'lık tasarım
 * alanında çizmeye devam eder; mm'ye çevirme yalnızca baskı render'ında ve tuvalde yapılır.
 *
 * Kullanıcı kararları (2026-10-09):
 * - Çıktı PDF ve PNG (ikisi de). Aynı sayfa birden çok basılacaksa PDF'te sayfa bir kez yer alır, kopya sayısı yazılır.
 * - Kesim makinesi: yuva çizgileri baskıda görünür ve makine onları keser (varsayılan). Başka kesim tarzları
 *   (kayıt işaretleri, taşma payı, ayrı kesim dosyası, hazır kesimli kağıt için görünmez çizgi) şablon başına seçilir.
 * - Sayfa şablonları uygulamada elle kurulur (ızgara üreteci ve ön ayarlar yalnızca başlangıç değeri verir).
 * - Sipariş adı (hücre etiketi) sayfa başına açılıp kapanır.
 * - Fazlalık kuralları tasarım dili ayarı olarak (`profile.printing`).
 * - Basılan sayfalar "basıldı" olarak arşive geçer, aranıp yeniden basılabilir; hiçbir şey silinmez.
 */

export const PRINT_KINDS = ["label", "sticker"] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

/** Kağıttaki bir yuva (etiketin oturduğu daire/elips/dikdörtgen). Merkez ve ölçü mm. */
export const PrintSlotSchema = z.object({
  id: z.string().min(1),
  shape: z.enum(["circle", "ellipse", "rect"]).default("circle"),
  /** Merkez (mm). */
  cx: z.number(),
  cy: z.number(),
  /** Genişlik / yükseklik (mm). Dairede ikisi de çaptır. */
  w: z.number().positive(),
  h: z.number().positive(),
  /** Derece, saat yönünde. */
  rotation: z.number().default(0),
  /** Dikdörtgende köşe yuvarlaklığı (mm). */
  cornerRadius: z.number().min(0).default(0),
});
export type PrintSlot = z.infer<typeof PrintSlotSchema>;

/** Kayıt (registration) işareti tarzı: kesim makinelerinin baskıyı hizalamak için okuduğu işaretler. */
export const REGISTRATION_STYLES = ["corners-l", "corner-square", "crosshair"] as const;

/** Kesim ve baskı işaretleri: şablon başına; varsayılan "yuva çizgisi görünür, makine onu keser". */
export const PrintCutSchema = z
  .object({
    /** Yuva çizgileri baskıda görünür (kesim makinesi çizgiyi keser). Kapalıysa yalnızca ekranda kılavuz. */
    outlineVisible: z.boolean().default(true),
    outlineColor: z.string().default("#000000"),
    outlineWidthMm: z.number().positive().default(CUT_LINE_MM),
    /** Kayıt işaretleri (print & cut). */
    registration: z
      .object({
        enabled: z.boolean().default(false),
        style: z.enum(REGISTRATION_STYLES).default("corners-l"),
        /** Kağıt kenarından içeri (mm). */
        insetMm: z.number().min(0).default(REGISTRATION_INSET_MM),
        sizeMm: z.number().positive().default(REGISTRATION_SIZE_MM),
        thicknessMm: z.number().positive().default(REGISTRATION_THICKNESS_MM),
      })
      .prefault({}),
    /** Taşma payı (mm): etiket görseli yuvanın bu kadar dışına taşar (kesim kaymasına karşı). 0 = yok. */
    bleedMm: z.number().min(0).default(BLEED_MM),
    /** Yuva yollarını ayrı bir kesim dosyası (SVG) olarak da ver. */
    cutFile: z.boolean().default(false),
  })
  .prefault({});
export type PrintCut = z.infer<typeof PrintCutSchema>;

/** Hücre etiketi (sipariş adı, ör. "4849_36adet"): sayfada siparişin ilk yuvasının yanında. */
export const PrintCellLabelSchema = z
  .object({
    /** Yeni sayfalarda varsayılan olarak basılsın mı (sayfa başına değiştirilir). */
    enabledByDefault: z.boolean().default(true),
    fontFamily: z.string().default("Inter"),
    fontWeight: z.number().int().default(700),
    sizePt: z.number().positive().default(8.4),
    color: z.string().default("#1A4DB3"),
    /** Yuvanın sağ alt köşesine göre konum (mm). */
    dxMm: z.number().default(-11.3),
    dyMm: z.number().default(-1.6),
  })
  .prefault({});
export type PrintCellLabel = z.infer<typeof PrintCellLabelSchema>;

/**
 * Sticker sayfası akış parametreleri (mm): sticker'lar yuva yerine satırlara dizilir (eklentideki planlayıcı).
 * Etiket şablonlarında yok.
 */
export const StickerFlowSchema = z.object({
  marginTopMm: z.number().min(0),
  marginBottomMm: z.number().min(0),
  marginSideMm: z.number().min(0),
  minGapXMm: z.number().min(0),
  minRowGapMm: z.number().min(0),
  /** Son (karışık) sayfada satır arası en çok (mm). */
  maxRowGapLastMm: z.number().min(0),
  /**
   * Satırın yayıldığı genişlik (mm; ilk sticker'ın solu → son sticker'ın sağı). Boşsa `kağıt genişliği - 2 × marginSideMm`.
   * Eklentide 538 pt (kenar payı 20 pt'ten dar): tam eşitlik için saklanır.
   */
  rowSpanMm: z.number().positive().optional(),
});
export type StickerFlow = z.infer<typeof StickerFlowSchema>;

export const PrintTemplateSchema = z.object({
  id: z.string().min(1),
  languageId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(PRINT_KINDS),
  paper: z.object({ wMm: z.number().positive(), hMm: z.number().positive() }),
  /** Etiket şablonunda hangi etiket boyutu için ("3.8"); sticker şablonunda sticker sayfa kimliği (profil `stickers.sheets[].id`). */
  sizeId: z.string().nullable().default(null),
  /** Okuma sırasında (üstten alta, soldan sağa) yuvalar. Sticker şablonunda boş olabilir (akış). */
  slots: z.array(PrintSlotSchema).default([]),
  stickerFlow: StickerFlowSchema.nullable().default(null),
  cut: PrintCutSchema,
  cellLabel: PrintCellLabelSchema,
  /** Etiket görselinin fiziksel çapı (mm); boşsa yuva genişliği. Etiket yuvaya ortalanır. */
  labelDiameterMm: z.number().positive().nullable().default(null),
  source: z.enum(["manual", "svg", "grid"]).default("manual"),
  /** Arşivlenmiş (kullanılmayan) şablon listede gizlenir; silinmez. */
  archived: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PrintTemplate = z.infer<typeof PrintTemplateSchema>;
export type PrintTemplateInput = z.input<typeof PrintTemplateSchema>;

/** Baskı oturumu: bir baskı turu (bir ya da birden çok sayfa). Basılınca arşive geçer. */
export const PrintSessionSchema = z.object({
  id: z.string().min(1),
  languageId: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["draft", "printed"]).default("draft"),
  /** İyimser eşzamanlılık: her yamada artar. */
  version: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  printedAt: z.string().nullable().default(null),
});
export type PrintSession = z.infer<typeof PrintSessionSchema>;

export const PrintPageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  templateId: z.string().min(1),
  /** Oturum içindeki sıra. */
  index: z.number().int().nonnegative(),
  /** "4849_3sayfa", "4849_4850_1sayfa" gibi (eklentideki adlandırma). */
  name: z.string(),
  /** Bu sayfadan kaç kopya basılacak (PDF'te sayfa bir kez yer alır). */
  copies: z.number().int().positive().default(1),
  kind: z.enum(["full", "mixed", "manual"]).default("manual"),
  /** Sipariş adı (hücre etiketi) basılsın mı. */
  showCellLabels: z.boolean().default(true),
  /** Kilitli sayfa yeniden planlamada değişmez. */
  locked: z.boolean().default(false),
});
export type PrintPage = z.infer<typeof PrintPageSchema>;

/**
 * Sayfadaki bir etiket/sticker: bir varyasyona REFERANS (kopya değil) — Düzelt'te yapılan değişiklik bütün kopyalara
 * yansır. Konum etiketin merkezi (mm).
 */
export const PrintItemSchema = z.object({
  id: z.string().min(1),
  pageId: z.string().min(1),
  jobId: z.string().min(1),
  variantId: z.string().min(1),
  /** Oturduğu yuva; serbest konumdaysa null. */
  slotId: z.string().nullable().default(null),
  xMm: z.number(),
  yMm: z.number(),
  rotation: z.number().default(0),
  /** Yuvaya göre ek ölçek (1 = yuvaya/etiket boyutuna göre doğal). */
  scale: z.number().positive().default(1),
  /** Sipariş adedinin üstündeki fazlalık. */
  extra: z.boolean().default(false),
  /** Elle konmuş/taşınmış: yeniden planlama dokunmaz. */
  manual: z.boolean().default(false),
  z: z.number().int().default(0),
});
export type PrintItem = z.infer<typeof PrintItemSchema>;

/** Sayfa + öğeleri (istemciye giden bütün). */
export const PrintPageFullSchema = PrintPageSchema.extend({ items: z.array(PrintItemSchema) });
export type PrintPageFull = z.infer<typeof PrintPageFullSchema>;

export const PrintSessionFullSchema = PrintSessionSchema.extend({ pages: z.array(PrintPageFullSchema) });
export type PrintSessionFull = z.infer<typeof PrintSessionFullSchema>;

/**
 * Raf öğesi: basılmayı bekleyen onaylı iş (etiket ya da sticker) ve sayfalara ne kadarının yerleştiği.
 * `needed` = adet + plana göre fazlalık; `placed` = taslak oturumlardaki yerleşim sayısı.
 */
export const ShelfItemSchema = z.object({
  jobId: z.string(),
  variantId: z.string(),
  orderNo: z.string().nullable(),
  kind: z.enum(PRINT_KINDS),
  /** Etiket boyutu ("3.8") ya da sticker sayfa kimliği. */
  sizeId: z.string().nullable(),
  quantity: z.number().int().nonnegative(),
  needed: z.number().int().nonnegative(),
  placed: z.number().int().nonnegative(),
  /** Tasarım (şablon) numarası: aynı numaralı siparişler aynı karışık sayfaya girmez. */
  designKey: z.string().nullable(),
  previewUrl: z.string(),
  /** İşin ürün adı (siparişin ürün alanı); yoksa null. Raf kartında sipariş numarasının yanında. */
  product: z.string().nullable(),
  /**
   * `needed` yaklaşık mı: şablon bilinmiyorsa kural formülü (adet + fazlalık, "≈"); biliniyorsa ilk planın gerçek
   * toplamı (yeniden planlamanın kullandığı sayı: taslaktaysa o oturumun planı, değilse grubun bu şablonla planı).
   */
  neededApprox: z.boolean().optional(),
  /** Siparişte adet yok: baskıda planlanmaz (Planla / yeniden planla / oturuma ekle atlar); `quantity` 0 gelir. */
  quantityMissing: z.boolean().optional(),
  /** Sticker: mürekkep kutusu ölçüsü (mm; planlayıcının kullandığı). Etikette yok. */
  wMm: z.number().positive().optional(),
  hMm: z.number().positive().optional(),
  /**
   * Etiket: onaylı varyasyonun şablonunun (varyasyon başka şablonda üretildiyse o) KENDİ kesimi (mm). Yoksa alan yok:
   * tasarım dilinin kesimi (eski daire boyutları). Raf, sunucunun `pageTemplateFor` kuralıyla aynı ayrımı bununla yapar
   * (daire kesiminin boyut kimliği "3.8" eski boyutla aynı biçimdedir).
   */
  cut: TemplateCutSchema.optional(),
});
export type ShelfItem = z.infer<typeof ShelfItemSchema>;

/**
 * Sticker öğesinin tuvaldeki ölçüsü (mm): mürekkep kutusu (`wMm × hMm`, öğe merkezi = mürekkep merkezi) ve önizleme
 * görselinin (tasarım karesi) öğe merkezine göre kutusu (`art`).
 */
export const PrintItemSizeSchema = z.object({
  wMm: z.number().positive(),
  hMm: z.number().positive(),
  art: z.object({ xMm: z.number(), yMm: z.number(), wMm: z.number().positive(), hMm: z.number().positive() }).nullable(),
  /** "label": şablonun kendi kesimi olan etiket (kesim ölçüsünde basılır; masa yuva yerine bunu çizer). Yoksa sticker. */
  kind: z.literal("label").optional(),
});
export type PrintItemSize = z.infer<typeof PrintItemSizeSchema>;

// ---------------------------------------------------------------- yardımcılar

/** Okuma sırası: satırlar (merkez y farkı < tol mm) üstten alta, satır içinde soldan sağa. */
export function slotsInReadingOrder<T extends { cx: number; cy: number }>(slots: readonly T[], rowTolMm = 2): T[] {
  const sorted = [...slots].sort((a, b) => a.cy - b.cy);
  const rows: T[][] = [];
  for (const s of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.cy - s.cy) < rowTolMm) row.push(s);
    else rows.push([s]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.cx - b.cx));
}

// mm ↔ px/pt çevirileri ve baskı standartları: `units.ts` (tek kaynak).
export * from "./units.ts";

// ================================================================ API (sunucu uçları; baskı masası)
//
// Sayfa şablonları uygulamada ELLE kurulur (kullanıcı kararı 2026-10-09). Izgara üreteci ve
// ön ayarlar yalnızca başlangıç değeri verir; her değer sonradan elle düzenlenir. Doğrulama uyarıdır, engellemez.

/** Baskı masası uçları. Açıklamadaki biçim: YÖNTEM gövde → yanıt. */
export const PRINT_API = {
  /** GET ?languageId=&archived=1 → { templates: PrintTemplateView[] } · POST PrintTemplateCreate → PrintTemplateView */
  templates: "/api/print/templates",
  /** POST PrintGridRequest → PrintGridResponse (dryRun: yalnızca yuvalar + uyarılar; templateId: o şablonun yuvaları değişir). */
  templateGrid: "/api/print/templates/grid",
  /**
   * GET → PrintTemplateView · PATCH PrintTemplatePatch → PrintTemplateView (derin birleştirme; slots verilirse tamamı
   * değişir) · DELETE → PrintTemplateDeleteResponse (kullanılmamışsa kalıcı silinir, kullanılmışsa arşivlenir).
   */
  template: "/api/print/templates/:id",
  /** POST PrintTemplateArchive → PrintTemplateView (arşivlenen listede gizlenir; geri alınabilir). */
  templateArchive: "/api/print/templates/:id/archive",
  /** POST PrintTemplateDuplicate → PrintTemplateView (yeni kimlik, "… (kopya)"). */
  templateDuplicate: "/api/print/templates/:id/duplicate",
  /** GET ?languageId= → { presets: PrintPreset[] } · POST PrintPresetCreate → PrintPreset */
  presets: "/api/print/presets",
  /** PATCH PrintPresetPatch → PrintPreset · DELETE ?languageId= → { ok } */
  preset: "/api/print/presets/:id",
  /** GET ?languageId= → { items: ShelfItem[] } (onaylı, basılmamış işler). */
  shelf: "/api/print/shelf",
  /** GET ?languageId=&status=&q=&limit= → { sessions: PrintSessionSummary[] } · POST PrintSessionCreate → PrintSessionCreateResponse */
  sessions: "/api/print/sessions",
  /** GET → PrintSessionDetail · PATCH PrintSessionPatch → PrintSessionPatchResponse (sürüm çakışmasında 409) · DELETE → UndoToken */
  session: "/api/print/sessions/:id",
  /** POST PrintReplan → PrintSessionPatchResponse (kilitli sayfalar ve elle konmuş öğeler korunur). */
  sessionReplan: "/api/print/sessions/:id/replan",
  /**
   * POST PrintAddJobs → PrintSessionPatchResponse: raftaki işleri açık taslağa ekler. Sayfadaki her şey olduğu gibi
   * kalır; planlayıcı yalnızca yeni işleri boş yuvalara (kilitsiz, tek kopyalı, aynı şablonlu sayfalarda) ve yeni
   * sayfalara yerleştirir. Uymayan / adedi olmayan işler `skipped`.
   */
  sessionAddJobs: "/api/print/sessions/:id/jobs",
  /** POST PrintMarkPrinted → PrintSessionDetail (basıldı → arşiv, şablonların anlık kopyası alınır; printed:false geri alır, kopya bırakılır). */
  sessionPrinted: "/api/print/sessions/:id/printed",
  /**
   * POST PrintReprint → PrintSessionDetail (oturumun kopyası, yeni taslak). Basılmış oturumda sayfalar basıldığı
   * andaki şablonla gelir: güncel şablon farklıysa anlık kopya arşivli yeni şablon olarak eklenir (güncele geçmek için
   * `setPageTemplate`).
   */
  sessionReprint: "/api/print/sessions/:id/reprint",
  /** POST PrintExportRequest → PrintExport (202; ilerleme SSE `printExport`). Motor bağlı değilse 501. */
  sessionExport: "/api/print/sessions/:id/export",
  /** GET ?w= → PNG küçük resim (motor bağlı değilse 501). */
  pagePreview: "/api/print/pages/:id/preview.png",
  /** GET → PrintExport */
  export: "/api/print/exports/:id",
  /** GET → dosya (PDF ya da PNG; indirme). */
  exportFile: "/api/print/exports/:id/files/:index",
} as const;

/** Şablon doğrulama uyarısı (engellemez). */
export const PrintTemplateWarningSchema = z.object({
  code: z.enum(["no-slots", "slot-outside", "slot-overlap", "slot-duplicate-id", "label-larger-than-slot", "mark-overlap", "slot-in-printer-margin"]),
  message: z.string(),
  /** Cümlenin sözlük anahtarı (`PRINT_WARNING_MESSAGES`) ve parametreleri. */
  messageKey: z.string().optional(),
  params: MessageParamsSchema.optional(),
  slotIds: z.array(z.string()).default([]),
});
export type PrintTemplateWarning = z.infer<typeof PrintTemplateWarningSchema>;

/** İstemciye giden şablon: kayıt + doğrulama uyarıları + kapasite (yuva sayısı). */
export const PrintTemplateViewSchema = PrintTemplateSchema.extend({
  warnings: z.array(PrintTemplateWarningSchema),
  capacity: z.number().int().nonnegative(),
  /** Kaç baskı oturumunda kullanıldı (silinmiş/geri alınabilir oturumlar dahil; silme ucundaki `inUse` ile aynı tanım). Sunucu her görünümde doldurur; eski istemci verisinde olmayabilir. */
  usedIn: z.number().int().nonnegative().optional(),
});
export type PrintTemplateView = z.infer<typeof PrintTemplateViewSchema>;

/** Yuva girdisi: kimlik verilmezse sunucu verir ("s12"). Kayıtta yuvalar okuma sırasına dizilir. */
export const PrintSlotInputSchema = PrintSlotSchema.extend({ id: z.string().min(1).optional() });
export type PrintSlotInput = z.input<typeof PrintSlotInputSchema>;

const PaperSchema = z.object({ wMm: z.number().positive().max(2000), hMm: z.number().positive().max(2000) });
const TemplateNameSchema = z.string().trim().min(1).max(120);

/** Kesim ayarlarının kısmi yaması (derin birleşir). */
export const PrintCutPatchSchema = z
  .object({
    outlineVisible: z.boolean(),
    outlineColor: z.string(),
    outlineWidthMm: z.number().positive(),
    registration: z
      .object({ enabled: z.boolean(), style: z.enum(REGISTRATION_STYLES), insetMm: z.number().min(0), sizeMm: z.number().positive(), thicknessMm: z.number().positive() })
      .partial(),
    bleedMm: z.number().min(0),
    cutFile: z.boolean(),
  })
  .partial();

/**
 * Yeni şablon. `paper` verilmezse firmanın kurulumdaki kağıdı (`print.defaults`; yoksa A4); `cut` verilen alanlar
 * kurulumun kesim varsayılanlarının (yoksa şemanın) üstüne derin birleşir.
 */
export const PrintTemplateCreateSchema = z.object({
  languageId: z.string().min(1),
  name: TemplateNameSchema,
  kind: z.enum(PRINT_KINDS).default("label"),
  paper: PaperSchema.optional(),
  sizeId: z.string().nullable().default(null),
  slots: z.array(PrintSlotInputSchema).max(5000).default([]),
  stickerFlow: StickerFlowSchema.nullable().default(null),
  cut: PrintCutPatchSchema.optional(),
  cellLabel: PrintCellLabelSchema,
  labelDiameterMm: z.number().positive().nullable().default(null),
});
export type PrintTemplateCreate = z.input<typeof PrintTemplateCreateSchema>;

export const PrintCellLabelPatchSchema = z
  .object({
    enabledByDefault: z.boolean(),
    fontFamily: z.string(),
    fontWeight: z.number().int(),
    sizePt: z.number().positive(),
    color: z.string(),
    dxMm: z.number(),
    dyMm: z.number(),
  })
  .partial();

/** Şablon yaması: verilen alanlar değişir; `cut`/`cellLabel` derin birleşir; `slots` verilirse yuvaların tamamı değişir. */
export const PrintTemplatePatchSchema = z
  .object({
    name: TemplateNameSchema,
    kind: z.enum(PRINT_KINDS),
    paper: PaperSchema,
    sizeId: z.string().nullable(),
    slots: z.array(PrintSlotInputSchema).max(5000),
    stickerFlow: StickerFlowSchema.nullable(),
    cut: PrintCutPatchSchema,
    cellLabel: PrintCellLabelPatchSchema,
    labelDiameterMm: z.number().positive().nullable(),
    archived: z.boolean(),
  })
  .partial()
  .strict();
export type PrintTemplatePatch = z.input<typeof PrintTemplatePatchSchema>;

export const PrintTemplateArchiveSchema = z.object({ archived: z.boolean().default(true) });
export const PrintTemplateDuplicateSchema = z.object({ name: TemplateNameSchema.optional() });
/**
 * Silme yanıtı: hiç kullanılmamış şablon kalıcı silinir (`deleted`); bir baskı oturumunda ya da sayfasında (silinmiş,
 * geri alınabilir olanlar ve basılmış oturumun anlık kopyası dahil) geçiyorsa yalnız arşivlenir (`archived`).
 */
export const PrintTemplateDeleteResponseSchema = z.object({ result: z.enum(["deleted", "archived"]) });
export type PrintTemplateDeleteResponse = z.infer<typeof PrintTemplateDeleteResponseSchema>;

/**
 * Izgara üreteci: kağıt + sütun × satır + yuva ölçüsü + kenar/adım → yuvalar (mm). Boşluk/adım verilmezse yuvalar
 * kenar payları arasında (o da yoksa kağıtta) eşit aralıkla dağıtılır.
 */
export const PrintGridSpecSchema = z.object({
  paper: PaperSchema,
  columns: z.number().int().min(1).max(200),
  rows: z.number().int().min(1).max(200),
  shape: z.enum(["circle", "ellipse", "rect"]).default("circle"),
  /** Daire çapı (mm). Elips/dikdörtgende `wMm` × `hMm` (verilmezse ikisi de çap). */
  diameterMm: z.number().positive().optional(),
  wMm: z.number().positive().optional(),
  hMm: z.number().positive().optional(),
  cornerRadiusMm: z.number().min(0).default(0),
  /** Kağıdın sol/üst kenarından ilk yuvanın kenarına (mm). */
  marginLeftMm: z.number().min(0).optional(),
  marginTopMm: z.number().min(0).optional(),
  /** Yatay/dikey adım: merkezden merkeze (mm). */
  pitchXMm: z.number().positive().optional(),
  pitchYMm: z.number().positive().optional(),
  /** Ya da yuvalar arası boşluk: kenardan kenara (mm). Adım verilmişse adım geçerlidir. */
  gapXMm: z.number().min(0).optional(),
  gapYMm: z.number().min(0).optional(),
  /** Izgarayı kağıda ortala (sol/üst kenar yok sayılır). */
  center: z.boolean().default(false),
  /** Kaydırmalı (şaşırtmalı) dizilim: 2., 4., … satırlar `offsetXMm` kayar (varsayılan yarım adım); `dropLast`: o satırlarda son yuva yok. */
  stagger: z
    .object({ enabled: z.boolean().default(false), offsetXMm: z.number().optional(), dropLast: z.boolean().default(false) })
    .prefault({}),
});
export type PrintGridSpec = z.infer<typeof PrintGridSpecSchema>;
export type PrintGridSpecInput = z.input<typeof PrintGridSpecSchema>;

export const PrintGridRequestSchema = PrintGridSpecSchema.extend({
  languageId: z.string().min(1),
  /** Verilirse o şablonun kağıdı ve yuvaları değişir; yoksa yeni şablon (`source: "grid"`). */
  templateId: z.string().min(1).optional(),
  name: TemplateNameSchema.optional(),
  kind: z.enum(PRINT_KINDS).default("label"),
  sizeId: z.string().nullable().optional(),
  labelDiameterMm: z.number().positive().nullable().optional(),
  /** Yalnızca önizleme: hiçbir şey kaydedilmez. */
  dryRun: z.boolean().default(false),
});
export type PrintGridRequest = z.input<typeof PrintGridRequestSchema>;

export const PrintGridResponseSchema = z.object({
  slots: z.array(PrintSlotSchema),
  warnings: z.array(PrintTemplateWarningSchema),
  /** dryRun'da null. */
  template: PrintTemplateViewSchema.nullable(),
});
export type PrintGridResponse = z.infer<typeof PrintGridResponseSchema>;

/**
 * Hazır ön ayar: ızgara üretecinin BAŞLANGIÇ değerleri (tasarım dili verisi; kullanıcı düzeltir/ekler/siler).
 * Ölçülmemiş değerler `note`'ta belirtilir.
 */
export const PrintPresetSchema = z.object({
  id: z.string().min(1),
  name: TemplateNameSchema,
  kind: z.enum(PRINT_KINDS).default("label"),
  sizeId: z.string().nullable().default(null),
  labelDiameterMm: z.number().positive().nullable().default(null),
  grid: PrintGridSpecSchema,
  note: z.string().max(500).default(""),
});
export type PrintPreset = z.infer<typeof PrintPresetSchema>;

export const PrintPresetCreateSchema = PrintPresetSchema.omit({ id: true }).extend({ languageId: z.string().min(1) });
/** Ön ayar yaması (varsayılan doldurmaz): `grid` kısmi verilir, mevcut değerlerle derin birleşip tam doğrulanır. */
export const PrintPresetPatchSchema = z
  .object({
    languageId: z.string().min(1),
    name: TemplateNameSchema.optional(),
    kind: z.enum(PRINT_KINDS).optional(),
    sizeId: z.string().nullable().optional(),
    labelDiameterMm: z.number().positive().nullable().optional(),
    grid: z.custom<Partial<PrintGridSpecInput>>((v) => !!v && typeof v === "object" && !Array.isArray(v), "Izgara bir nesne olmalı.").optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const PrintShelfResponseSchema = z.object({ items: z.array(ShelfItemSchema) });
export type PrintShelfResponse = z.infer<typeof PrintShelfResponseSchema>;

export const PrintSessionCreateSchema = z.object({
  languageId: z.string().min(1),
  templateId: z.string().min(1),
  /** Verilmezse raftaki uygun (şablonun türü/boyutu), hiçbir taslağa girmemiş bütün işler. */
  jobIds: z.array(z.string().min(1)).min(1).max(2000).optional(),
  name: z.string().trim().min(1).max(160).optional(),
});
export type PrintSessionCreate = z.input<typeof PrintSessionCreateSchema>;

export const PrintSkippedSchema = z.object({ jobId: z.string(), reason: z.string() });
export type PrintSkipped = z.infer<typeof PrintSkippedSchema>;

/** Oturum ayrıntısı (GET/PATCH yanıtları): `PrintSessionFull` + planın şablonu, kaynak oturum, planlanan işler. */
export const PrintSessionNoticeSchema = z.object({
  code: z.enum(["plan-stale", "printed-old-scale", "sticker-small-text"]),
  /** Bugünkü Türkçe cümle (geriye uyum); arayüz sözlüğü önce gelir. */
  message: z.string(),
  params: MessageParamsSchema.optional(),
});
export type PrintSessionNotice = z.infer<typeof PrintSessionNoticeSchema>;

export const PrintSessionDetailSchema = PrintSessionFullSchema.extend({
  /** Oturum kurulurken seçilen şablon (yeniden planlama bunu kullanır). */
  templateId: z.string().nullable(),
  /** Yeniden basımsa kopyalandığı oturum. */
  sourceSessionId: z.string().nullable(),
  /** Planlanan işler (yeniden planlamada sayfadaki işlerle birlikte kullanılır). */
  jobIds: z.array(z.string()),
  /**
   * Basılmış oturumda sayfa şablonlarının "basıldı" anındaki anlık kopyası (şablon kimliği → şablon). Önizleme, çıktı
   * ve yeniden basım bunu kullanır; şablon sonradan değişse de arşivdeki oturum basıldığı gibi kalır. Taslakta null.
   */
  templateSnapshots: z.record(z.string(), PrintTemplateSchema).nullable().optional(),
  /** Sticker öğelerinin ölçüleri (varyasyon kimliği → ölçü); tuval yer tutucu yerine bunu çizer. */
  itemSizes: z.record(z.string(), PrintItemSizeSchema).optional(),
  /**
   * Oturumun bütününe dair bildirimler (kod + parametre; `PRINT_NOTICE_MESSAGES`): eski ölçüyle dizilmiş taslak
   * (`plan-stale`: masa "Yeniden planla" önerir, "Dosyayı üret" onay sorar), eski ölçüyle basılmış arşiv, okunmaz küçük
   * sticker yazısı.
   */
  notices: z.array(PrintSessionNoticeSchema).default([]),
});
export type PrintSessionDetail = z.infer<typeof PrintSessionDetailSchema>;

export const PrintSessionCreateResponseSchema = z.object({
  session: PrintSessionDetailSchema,
  skipped: z.array(PrintSkippedSchema),
  warnings: z.array(z.string()),
});
export type PrintSessionCreateResponse = z.infer<typeof PrintSessionCreateResponseSchema>;

/** Arşiv/liste satırı. */
export const PrintSessionSummarySchema = PrintSessionSchema.extend({
  pageCount: z.number().int(),
  /** Kopyalar dahil basılacak kağıt sayısı. */
  sheetCount: z.number().int(),
  itemCount: z.number().int(),
  jobCount: z.number().int(),
  orderNos: z.array(z.string()),
  /** Yeniden basımsa kaynak oturum. */
  sourceSessionId: z.string().nullable(),
  /**
   * Ucuz hesaplanan bildirim kodları (ayrıntıdaki `notices` ile aynı kural): `plan-stale` (taslak), `printed-old-scale`
   * (arşiv). Parametreli metin ve `sticker-small-text` yalnız ayrıntıda (`GET …/sessions/:id`).
   */
  noticeCodes: z.array(z.enum(["plan-stale", "printed-old-scale"])).default([]),
});
export type PrintSessionSummary = z.infer<typeof PrintSessionSummarySchema>;

export const PrintSessionListQuerySchema = z.object({
  languageId: z.string().min(1).optional(),
  status: z.enum(["draft", "printed"]).optional(),
  /** Oturum adı, sayfa adı, sipariş no ya da metinde arar (büyük/küçük harf duyarsız). */
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const ItemNumbers = {
  rotation: z.number().min(-360).max(360),
  scale: z.number().positive().max(10),
  z: z.number().int(),
  extra: z.boolean(),
  /**
   * Elle konmuş mu (varsayılan true). Geri al / ileri al planlayıcının koyduğu öğeyi geri getirirken `false` gönderir
   * ki öğe yeniden "plan öğesi" olsun (yeniden planlama ona yine dokunabilsin).
   */
  manual: z.boolean(),
};

/**
 * Toplu yama işlemleri (tek işlemde, hepsi ya da hiçbiri). Elle yapılan öğe işlemleri öğeyi `manual` yapar
 * (`manual` açıkça verilmedikçe).
 *
 * Yuva içinde ince ayar: yuvadaki öğenin konumu yuva merkezinden farklı olabilir (ofset; etiket yuvarlağın içinde
 * elle hizalanır). `moveItem` aynı yuvada kalırken verilen xMm/yMm korunur; yuva değişince öğe yeni yuvanın
 * merkezine oturur. Planlayıcı ve yeniden planlama elle öğelere (ofsetliler dahil) dokunmaz.
 */
export const PrintPatchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("addItem"),
    /** İstemcinin verdiği kimlik (aynı yamada başvurmak için); yoksa sunucu verir. */
    id: z.string().min(1).max(80).optional(),
    pageId: z.string().min(1),
    jobId: z.string().min(1),
    /** Varsayılan: işin onaylı varyasyonu. */
    variantId: z.string().min(1).optional(),
    /** Yuva; verilmez ve konum da yoksa ilk boş yuva. null = serbest konum. */
    slotId: z.string().min(1).nullable().optional(),
    xMm: z.number().optional(),
    yMm: z.number().optional(),
    ...partialOf(ItemNumbers),
  }),
  z.object({
    op: z.literal("moveItem"),
    itemId: z.string().min(1),
    /** Başka sayfaya taşı. */
    pageId: z.string().min(1).optional(),
    /**
     * Hedef yuva (doluysa iki öğe yer değiştirir; yerinden edilen öğe eski yuvanın merkezine geçer); null = serbest
     * konum (xMm/yMm gerekir). Öğenin kendi yuvasıysa xMm/yMm (verildiyse) korunur: yuva içinde ofset.
     */
    slotId: z.string().min(1).nullable().optional(),
    xMm: z.number().optional(),
    yMm: z.number().optional(),
    manual: z.boolean().optional(),
  }),
  z.object({ op: z.literal("updateItem"), itemId: z.string().min(1), variantId: z.string().min(1).optional(), ...partialOf(ItemNumbers) }),
  z.object({ op: z.literal("removeItem"), itemId: z.string().min(1) }),
  z.object({
    op: z.literal("addPage"),
    id: z.string().min(1).max(80).optional(),
    /** Varsayılan: son sayfanın şablonu. */
    templateId: z.string().min(1).optional(),
    /** Sıra (varsayılan: sona). */
    index: z.number().int().min(0).optional(),
    name: z.string().max(160).optional(),
    copies: z.number().int().min(1).max(10000).optional(),
  }),
  /** Sayfa silme geri alınabilir (yanıttaki `undo`). */
  z.object({ op: z.literal("removePage"), pageId: z.string().min(1) }),
  z.object({
    op: z.literal("updatePage"),
    pageId: z.string().min(1),
    name: z.string().max(160).optional(),
    copies: z.number().int().min(1).max(10000).optional(),
    locked: z.boolean().optional(),
    showCellLabels: z.boolean().optional(),
    index: z.number().int().min(0).optional(),
  }),
  /** Şablon değiştir: yuvadaki öğeler okuma sırasına göre yeni yuvalara geçer; sığmayanlar sayfadan çıkar (uyarı). */
  z.object({ op: z.literal("setPageTemplate"), pageId: z.string().min(1), templateId: z.string().min(1) }),
  z.object({ op: z.literal("renameSession"), name: z.string().trim().min(1).max(160) }),
]);
export type PrintPatchOp = z.infer<typeof PrintPatchOpSchema>;

function partialOf<T extends Record<string, z.ZodType>>(shape: T): { [K in keyof T]: z.ZodOptional<T[K]> } {
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> };
}

export const PrintSessionPatchSchema = z.object({
  /** İstemcinin bildiği sürüm; sunucudakinden farklıysa 409 (code "version-conflict"). */
  version: z.number().int().nonnegative(),
  ops: z.array(PrintPatchOpSchema).min(1).max(2000),
});
export type PrintSessionPatch = z.input<typeof PrintSessionPatchSchema>;

export const PrintSessionPatchResponseSchema = z.object({
  session: PrintSessionDetailSchema,
  warnings: z.array(z.string()),
  /** Sayfa silindiyse geri alma anahtarı (UndoToken); yoksa null. */
  undo: z.object({ undoToken: z.string(), label: z.string(), expiresAt: z.string() }).nullable(),
  /** Yeniden planlama / iş eklemede planlanmayan işler ve nedeni (ör. adet yok, şablona uymuyor). */
  skipped: z.array(PrintSkippedSchema).optional(),
  /**
   * Toplu yamada istemcinin `addPage`/`addItem`'a verdiği kimlik → kayıttaki gerçek kimlik (yalnız yama yanıtında;
   * SUNUCU-PLANI §10.3). İstemci kimliği her zaman GEÇİCİ başvurudur: sunucu her eklemeye yeni UUIDv7 verir (dil
   * kimliğindeki kural; başka firmadaki kimliğin varlığı hiçbir yanıttan okunamaz). İstemci yerel durumunu, geçmişini
   * ve seçimini bu eşlemeyle çevirir; aynı yamadaki sonraki işlemler geçici kimlikle başvurabilir (sunucu çevirir).
   * Aynı yamada iki eklemeye aynı geçici kimlik: 400 `id-in-use`.
   */
  ids: z.record(z.string(), z.string()).optional(),
});
export type PrintSessionPatchResponse = z.infer<typeof PrintSessionPatchResponseSchema>;

export const PrintReplanSchema = z.object({ version: z.number().int().nonnegative() });
export const PrintAddJobsSchema = z.object({ version: z.number().int().nonnegative(), jobIds: z.array(z.string().min(1)).min(1).max(2000) });
export type PrintAddJobs = z.input<typeof PrintAddJobsSchema>;
export const PrintMarkPrintedSchema = z.object({ printed: z.boolean().default(true), version: z.number().int().nonnegative().optional() });
export const PrintReprintSchema = z.object({ name: z.string().trim().min(1).max(160).optional() });

export const PrintExportRequestSchema = z.object({
  format: z.enum(["pdf", "png"]),
  /** Yalnızca bu sayfalar (kimlik); yoksa hepsi. */
  pages: z.array(z.string().min(1)).min(1).optional(),
  /** Varsayılan: profil `printing.dpi` (sticker sayfasında `printing.stickerDpi`). 150'nin altı baskıda bulanıktır. */
  dpi: z.number().int().min(PRINT_DPI_MIN).max(PRINT_DPI_MAX).optional(),
  /**
   * PDF türü: "raster" (varsayılan; sayfa tek görsel) ya da "vector" (yuva/kesim çizgileri, kayıt işaretleri ve yazı
   * vektör; şablon görseli raster). PNG'de yok sayılır.
   */
  pdfMode: z.enum(["raster", "vector"]).optional(),
});
export type PrintExportRequest = z.input<typeof PrintExportRequestSchema>;

export const PRINT_EXPORT_STATUSES = ["queued", "running", "done", "failed", "interrupted"] as const;

export const PrintExportSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  format: z.enum(["pdf", "png"]),
  status: z.enum(PRINT_EXPORT_STATUSES),
  done: z.number().int(),
  total: z.number().int(),
  files: z.array(z.object({ name: z.string(), url: z.string(), bytes: z.number().int() })),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type PrintExport = z.infer<typeof PrintExportSchema>;
