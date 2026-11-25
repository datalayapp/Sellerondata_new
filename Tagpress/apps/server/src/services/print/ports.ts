import type {
  Box,
  LayoutResult,
  PrintCellLabel,
  PrintCut,
  PrintKind,
  PrintSlot,
  PrintTemplate,
  Profile,
  Shape,
  TemplateGeometry,
  VariantKind,
} from "@tagpress/domain";

/**
 * Baskı masasının diğer paketlere bağlandığı arayüzler:
 * - planlayıcı: `@tagpress/print` (`planLabelPages` / `planStickerPages` / `neededCount`)
 * - çizim: `@tagpress/engine` baskı render'ı (`packages/engine/src/print.ts`)
 * Bağlı değilse ilgili uç 501 döner; testler sahte uygulamalar verir. Bağlantı `adapters/` içinde yapılır.
 */

export type PrintRules = Profile["printing"];

/** Planlayıcıya giden sipariş (bir iş = bir sipariş satırı). */
export interface PlanOrder {
  jobId: string;
  variantId: string;
  /** Sipariş no (yoksa "#<sıra>"). */
  orderNo: string;
  quantity: number;
  /** Tasarım (şablon) numarası: aynı numaralı farklı siparişler aynı karışık sayfaya girmez. */
  designKey: string | null;
}

/** Sticker siparişi: mürekkep ölçüsü (mm). */
export interface PlanStickerOrder extends PlanOrder {
  wMm: number;
  hMm: number;
}

export interface PlannedItem {
  jobId: string;
  variantId: string;
  slotId: string | null;
  /** Etiketin (sticker'da mürekkebin) merkezi, mm. */
  xMm: number;
  yMm: number;
  extra: boolean;
}

export interface PlannedPage {
  name: string;
  kind: "full" | "mixed" | "manual";
  copies: number;
  items: PlannedItem[];
  /** Planlayıcının hücre etiketi önerisi; sunucu saklamaz, çizimde sayfadan yeniden türetir (`render-input.ts`). */
  cellLabels?: unknown;
}

/** Yeniden planlama girdisindeki sayfa (oturumdaki sırayla). */
export interface ReflowInputPage {
  locked: boolean;
  copies: number;
  /** false: korunsa da boş yuvalarına yeni öğe konmaz (sayfanın şablonu planın şablonundan farklı). */
  fill: boolean;
  items: (PlannedItem & { manual: boolean })[];
}

/** Yeniden planlama çıktısı: kilitsiz kümenin yeni hâli. `fromIndex`: korunan giriş sayfası; yeni sayfada null/yok. */
export interface ReflowedPage extends PlannedPage {
  items: (PlannedItem & { manual?: boolean })[];
  fromIndex?: number | null;
}

export interface PrintPlanner {
  planLabelPages(req: { orders: PlanOrder[]; template: PrintTemplate; rules: PrintRules }): PlannedPage[];
  planStickerPages(req: { orders: PlanStickerOrder[]; template: PrintTemplate; rules: PrintRules }): PlannedPage[];
  /**
   * Yeniden planlama (`@tagpress/print` `reflowPages`): kilitli sayfalar ve elle öğeler yerleşmiş sayılır; sipariş başına
   * kalan = ilk plandaki toplam (adet + fazlalık) − yerleşmiş, kalana yeni fazlalık eklenmez. Sticker'da `orders`
   * `PlanStickerOrder`'dır. Yoksa sunucu yaklaşık yola düşer (bkz. `PrintSessionService.replan`).
   */
  reflowPages?(req: { pages: ReflowInputPage[]; orders: PlanOrder[]; template: PrintTemplate; rules: PrintRules }): ReflowedPage[];
  /** Adet + plana göre fazlalık (raf `needed`). Yoksa `needed = quantity`. */
  neededCount?(req: { kind: PrintKind; quantity: number; template: PrintTemplate | null; rules: PrintRules }): number;
}

// ---------------------------------------------------------------- çizim girdisi

/**
 * Sayfadaki tek etiket/sticker'ın çizim girdisi. Tasarım alanı (`framePx` × `framePx`, varyasyonun motor alanı)
 * `mmPerPx` ölçeğiyle mm'ye çevrilir; tasarım alanındaki `anchorPx` noktası kağıtta `centerMm`'e oturur ve
 * `rotation` derece (saat yönünde) bu nokta etrafında döner.
 */
export interface PrintRenderItem {
  itemId: string;
  jobId: string;
  variantId: string;
  orderNo: string | null;
  variantKind: VariantKind;
  printKind: PrintKind;
  centerMm: { x: number; y: number };
  rotation: number;
  /** Tasarım px → mm (öğe ölçeği dahil). */
  mmPerPx: number;
  /** Tasarım alanının kenarı (px; genelde 440). */
  framePx: number;
  /** Kağıtta `centerMm`'e oturan tasarım noktası (px): etikette tasarım karesinin merkezi, sticker'da mürekkep merkezi. */
  anchorPx: { x: number; y: number };
  /** Tasarım karesinin fiziksel kenarı (mm) = framePx × mmPerPx (motorun `diameterMm`'i; etikette yuva ölçüsü). */
  diameterMm: number;
  /** Taşma payı (mm, şablondan): görsel kesimin bu kadar dışına taşabilir. */
  bleedMm: number;
  /** Önizlemeyle aynı yerleşim: motor yerleşimi + hafif düzeltme (`applyAdjustToLayout`). Görüntü modunda null. */
  layout: LayoutResult | null;
  /** Hedef geometri (kesim, şablon kutusu, şablon görseli yolu); templates bağlı değilse null. */
  geometry: TemplateGeometry | null;
  /** Şablon PNG'si (etiket; sticker'da null). */
  templatePath: string | null;
  templateBox: Box | null;
  /** Kesim şekli (tasarım px). */
  cut: Shape | null;
  /** Varyasyonun profili (sürümü) ve font klasörü: motor yazıyı bunlarla yeniden çizer. */
  profile: Profile;
  profileVersion: number | null;
  fontsDir: string;
  /** Hazır önizleme PNG'si (yedek; görüntü modunda asıl görsel) ve görüntü modunun saydam yazı katmanı. */
  previewPath: string | null;
  textLayerPath: string | null;
  textBox: Box | null;
  extra: boolean;
  z: number;
}

/** Hücre etiketi (sipariş adı): metin kutusunun SOL ÜST köşesi (mm), eklentideki gibi. */
export interface PrintRenderCellLabel {
  text: string;
  xMm: number;
  yMm: number;
  slotId: string | null;
}

export interface PrintRenderPage {
  pageId: string;
  sessionId: string;
  name: string;
  index: number;
  copies: number;
  templateId: string;
  templateName: string;
  printKind: PrintKind;
  paper: { wMm: number; hMm: number };
  slots: PrintSlot[];
  cut: PrintCut;
  cellLabel: PrintCellLabel & { show: boolean };
  cellLabels: PrintRenderCellLabel[];
  /** z sırasına göre (küçük önce). */
  items: PrintRenderItem[];
}

export interface PrintRenderer {
  /** Tek sayfa PNG. `widthPx` verilirse küçük resim (dpi yok sayılır). */
  renderPagePng(req: { page: PrintRenderPage; dpi: number; widthPx?: number }): Promise<Buffer>;
  /** Çok sayfalı PDF: her sayfa bir kez; kopya sayısı sayfada/üst bilgide yazılır. */
  renderPdf?(req: { pages: PrintRenderPage[]; dpi: number; mode?: "raster" | "vector"; title?: string; onPage?: (done: number, total: number) => void }): Promise<Buffer>;
}
