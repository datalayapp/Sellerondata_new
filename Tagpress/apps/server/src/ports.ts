import type {
  Box,
  DesignIntent,
  Issue,
  LabelSize,
  LayoutResult,
  LineEdit,
  Profile,
  StickerSheet,
  Template,
  TemplateGeometry,
  Usage,
} from "@tagpress/domain";
import type { PrintPlanner, PrintRenderer } from "./services/print/ports.ts";

/**
 * Sunucunun diğer paketlere bağlandığı arayüzler (portlar). Sunucu bu paketleri doğrudan çağırmaz:
 * `wiring.ts` gerçek uygulamaları (engine, typeset, templates, ai) buraya bağlar. Bağlı olmayan port
 * `null` kalır ve ilgili uç açık bir mesajla 501/hata döner; testler sahte uygulamalar kullanır.
 */

// ---------------------------------------------------------------- içe aktarma

export interface TemplateResolution {
  /** Çözülen şablon anahtarı (küçük harf); bulunamadıysa null. */
  key: string | null;
  /** Değerden ayrılan etiket boyutu kimliği (profil `output.sizes[].id`), yoksa null. */
  size: string | null;
  /** Boyuta benzeyen ama profilde olmayan değer ("4.5"), yoksa null. */
  unknownSize: string | null;
  /** `key` bilinen anahtarlar arasında değilse yakın adaylar (en iyisi başta). */
  suggestions: string[];
}

/** Ham şablon alanını ("A01 5.2", "a1 (2,5 cm)") anahtar + boyuta çevirir. templates paketi: `templateKeyFromInput`. */
export interface TemplateResolver {
  resolve(input: string, ctx: { keys: readonly string[]; sizes: readonly LabelSize[] }): TemplateResolution;
}

export interface CoverageResult {
  /** Profil fontlarında yok ama yedek fontla basılacak karakterler (Arapça, emoji…). */
  fallback: string[];
  /** Hiçbir fontta (yedekler dahil) olmayan karakterler. */
  missing: string[];
  /** Fontta tek parça olmayan, bileşenleri yan yana basılacak kümeler (ör. yeni ZWJ emojisi). */
  partial?: string[];
  /** Renkli fontta olmayan, tek renk basılacak emoji kümeleri. */
  monochrome?: string[];
}

/** Glif kapsamı (typeset paketi). */
export interface FontCoverage {
  check(text: string, ctx: { languageId: string; profile: Profile; fontsDir: string; sharedFontsDir: string }): CoverageResult;
}

// ---------------------------------------------------------------- geometri ve motor

export interface GeometryProvider {
  forTemplate(req: { template: Template; imagePath: string; profile: Profile }): Promise<TemplateGeometry>;
  forSticker(req: { sheet: StickerSheet; profile: Profile }): Promise<TemplateGeometry>;
  /** Yazı alanı/dekor bindirmesi (PNG). */
  overlay?(req: { template: Template; imagePath: string; profile: Profile }): Promise<Buffer>;
}

export interface Engine {
  /** Niyet + profil + geometri → yerleşim (deterministik). */
  layout(req: { intent: DesignIntent; text: string; profile: Profile; geometry: TemplateGeometry; fontsDir: string }): Promise<LayoutResult> | LayoutResult;
  /** Önizleme PNG'si (şablon + yazı). `fontsDir`: yerleşimin yapıldığı font klasörü (gerçek motor fontları buradan yükler). */
  render(req: { layout: LayoutResult; geometry: TemplateGeometry; profile: Profile; templatePath: string | null; fontsDir?: string }): Promise<Buffer>;
  /**
   * Hafif düzeltme: (düzeltilmiş) yerleşimin raster denetimi (isteğe bağlı). Sorunlar `field: "adjust"` taşır.
   * Bağlı değilse düzeltme denetimsiz kaydedilir.
   */
  checkPlacement?(req: { layout: LayoutResult; geometry: TemplateGeometry; profile: Profile; fontsDir: string }): Promise<PlacementCheckResult>;
  /** Hafif düzeltme: yalnızca yazı katmanı, saydam SVG (viewBox = tasarım alanı; satırlar `<g data-line="i">`). */
  textLayerSvg?(req: { layout: LayoutResult; profile: Profile; fontsDir: string }): string;
  /**
   * Hafif düzeltme: ELLE metin/font düzenlemesi (isteğe bağlı). Düzenlenen satırları aynı puntoda yeniden ölçer
   * (`placed` doldurur, etkisizleri atar) ve denetler (iş metniyle karşılaştırma, satır kuralları yeni metinle, aile
   * sayısı, yedek font). Seçilemeyen font → `HttpError(400, code "edit-font")`.
   */
  editLines?(req: { layout: LayoutResult; edits: readonly LineEdit[]; profile: Profile; fontsDir: string; jobText: string }): EditLinesResult;
  /** Elle seçilebilir satır fontları ve yerleşimin satır başına ana fontu (isteğe bağlı). */
  editFonts?(req: { layout: LayoutResult; profile: Profile; fontsDir: string }): { fonts: EditableFont[]; lineFonts: string[] };
}

export interface EditableFont {
  id: string;
  family: string;
  style: string;
  kind: string;
}

export interface EditLinesResult {
  /** Çözülmüş düzenlemeler (`placed` dolu). */
  edits: LineEdit[];
  /** Düzenlenmiş, düzeltmesiz yerleşim. */
  layout: LayoutResult;
  /** Düzenlemeden doğan sorunlar (metin farkı, yeniden hesaplanan satır kuralları, aile sayısı, yedek font). */
  issues: Issue[];
  /** Satırlar iş metninden farklı mı? */
  textEdited: boolean;
  /** Satır metinleri değişti mi (satır kuralları yeniden hesaplandı)? */
  linesChanged: boolean;
}

export interface PlacementCheckResult {
  report: { inkPx: number; outsideCutPx: number; decorationPx: number; outsideFreePx: number; ok: boolean };
  issues: Issue[];
  ms: number;
}

// ---------------------------------------------------------------- AI

/** Tek AI çağrısının kaydı. Tam istem SAKLANMAZ: `summary` kısa özet, `response` ham yanıt. */
export interface AiCallRecord {
  purpose: string;
  model: string;
  summary: string;
  response: string;
  error?: string | null;
  usage?: Usage | null;
  durationMs: number;
  /** Platform kipi: geçidin çağrı kimliği (başarısız çağrıda da; başarılıda `usage.gatewayCallId` ile aynı). */
  gatewayCallId?: string | null;
}

/** AI portunun fırlattığı hata, yapılan çağrıları taşıyabilir (maliyet kaybolmasın). */
export interface AiErrorLike extends Error {
  calls?: AiCallRecord[];
}

export interface DesignRequest {
  jobId: string;
  text: string;
  segments: string[];
  aiNote: string;
  kind: "label" | "sticker";
  profile: Profile;
  profileVersion: number;
  template: Template | null;
  sticker: StickerSheet | null;
  geometry: TemplateGeometry;
  /** Bu işin önceki varyasyonlarının niyetleri (tekrar etmesin). */
  previous: DesignIntent[];
  /** Revizyon: kaynak niyet + kullanıcının isteği. */
  revision: { intent: DesignIntent | null; request: string } | null;
  /** İstenen aday sayısı. */
  candidates: number;
  /** Canlı günlük satırı. */
  log: (step: string, message: string) => void;
  /** Dilin font klasörü (glif kapsamı için; isteğe bağlı). */
  fontsDir?: string;
  /** Dil kimliği (referans görselleri için; isteğe bağlı). */
  languageId?: string;
  /**
   * Deneme/kabul ölçümü: bu referansın kendisi benzer örnek havuzuna ve referans görsellerine girmez
   * (öğrenme kümesinde ölçerken cevabın istemde görünmemesi için).
   */
  excludeReferenceId?: string;
}

export interface DesignResponse {
  candidates: DesignIntent[];
  model: string;
  promptVersion: string;
  calls: AiCallRecord[];
}

export interface PickRequest {
  jobId: string;
  text: string;
  profile: Profile;
  candidates: { intent: DesignIntent; layout: LayoutResult; preview: Buffer }[];
  log: (step: string, message: string) => void;
}

export interface PickResponse {
  /** Aday dizinleri, en iyisi başta. */
  ranking: number[];
  reason: string;
  calls: AiCallRecord[];
  /** İsteğe bağlı: aday dizinine göre gerekçeler ve sıralamanın özeti (deneme hata ayıklaması). */
  reasons?: string[];
  summary?: string;
}

export interface Designer {
  design(req: DesignRequest): Promise<DesignResponse>;
  pick(req: PickRequest): Promise<PickResponse>;
}

export interface ImageOnTemplateResult {
  /** Önizleme: orijinal şablon + ayrılmış yazı katmanı (şablon pikseli değişmez). */
  composite: Buffer;
  /** Saydam yazı katmanı ve tasarım alanındaki kutusu. */
  textLayer: Buffer;
  textBox: Box;
  /** Görselde okunan yazı (müşteri metniyle karşılaştırılır); okunamadıysa null. */
  readText: string | null;
  /** Şablon pikselleri orijinalle birebir aynı mı (doğrulandı)? */
  templateUntouched: boolean;
  model: string;
  promptVersion: string;
  calls: AiCallRecord[];
}

export interface ImageGenerator {
  /** "Şablona yaz": şablon OLDUĞU GİBİ kalır, yalnızca yazı katmanı üretilir. */
  onTemplate(req: {
    jobId: string;
    text: string;
    aiNote: string;
    profile: Profile;
    template: Template;
    templatePath: string;
    geometry: TemplateGeometry;
    /** Revizyon: istek + (varsa) kaynak varyasyonun önizlemesi. */
    revision: { request: string; currentPng?: Buffer | null } | null;
    log: (step: string, message: string) => void;
  }): Promise<ImageOnTemplateResult>;
  /** "Temadan şablon üret": yazısız yeni şablon PNG'si. */
  newTemplate(req: {
    jobId: string;
    theme: string;
    profile: Profile;
    width: number;
    height: number;
    log: (step: string, message: string) => void;
  }): Promise<{ png: Buffer; model: string; prompt: string; calls: AiCallRecord[] }>;
}

// ---------------------------------------------------------------- fontlar

export interface FontCatalog {
  /** Font dosyasının aile/stil adı. */
  describe(file: string): Promise<{ family: string; style: string } | null>;
  /** Örnek görsel. */
  specimen?(file: string, text: string, sizePx: number): Promise<Buffer>;
}

// ---------------------------------------------------------------- bağlantı denemesi

/** API anahtarı denemesi: sağlayıcıya çok küçük, ücretsiz/ucuz gerçek istek. */
export type KeyTester = (provider: "anthropic" | "gemini", apiKey: string) => Promise<{ ok: boolean; message: string; model: string }>;

// ---------------------------------------------------------------- toplu

export interface Ports {
  templateResolver: TemplateResolver;
  fontCoverage: FontCoverage;
  geometry: GeometryProvider | null;
  engine: Engine | null;
  designer: Designer | null;
  imageGenerator: ImageGenerator | null;
  fontCatalog: FontCatalog | null;
  /** İsteğe bağlı: anahtar denemesi (bağlı değilse uç 501 döner). */
  keyTester?: KeyTester | null;
  /** İsteğe bağlı: baskı masası sayfa planlayıcısı (`@tagpress/print`; bağlı değilse oturum kurma/planlama 501). */
  printPlanner?: PrintPlanner | null;
  /** İsteğe bağlı: baskı sayfası çizimi (engine; bağlı değilse önizleme/çıktı 501). */
  printRenderer?: PrintRenderer | null;
}

/**
 * Gerçek bağlantıların ihtiyaç duyduğu sunucu olanakları (bağlam kurulurken verilir). Testler ve `main.ts`
 * `productionPorts()` fabrikasını kullanır; fabrika bu olanaklarla çağrılır.
 */
export interface PortDeps {
  /** Veri klasörü yolları (`root`: geçerli firmanın kökü, her erişimde; firma bağlamı yoksa hata). */
  paths: { readonly root: string; fonts(languageId: string): string; sharedFonts: string; language(id: string): string };
  dataDir: string;
  /** Yerel kip: çözülmüş API anahtarı (yoksa null). Platform kipinde çağrılmaz (`platformAi`). */
  apiKey(provider: "anthropic" | "gemini"): string | null;
  /**
   * Platform kipi: yapay zekâ geçidi (`adapters/ai-gateway.ts`). Alan varsa istemciler yalnız geçide gider (anahtar okunmaz);
   * `gateway` null ise (adres boş) her yapay zekâ çağrısı 409 `ai-unavailable`.
   */
  platformAi?: { gateway: import("./adapters/ai-gateway.ts").AiGateway | null };
  /** Dilin, verilen şablondaki eğitim referans görselleri (kullanıcının bitmiş etiketlerinin yazı katmanı), en yenisi başta. */
  referenceImages?(languageId: string, templateKey: string, limit: number, excludeId?: string): Promise<Buffer[]>;
  /**
   * Dilin eğitim referanslarından satır bölme örnekleri havuzu (müşteri metni → kullanıcının bölmesi, müşteri
   * metninin karakterleriyle). Ayrılmış (test) küme ASLA girmez.
   */
  breakExamples?(languageId: string): Array<{ text: string; lines: string[]; templateKey?: string | null; referenceId?: string }>;
  /**
   * Şablonun serbest yazı alanı en/boy oranı (bu profille hesaplanan geometriden; piksel değil). Benzer örneklere
   * eklenir: alana bağlı alışkanlıklar (ör. çift dizilişi) için. Şablon ya da görseli yoksa undefined.
   */
  templateAspect?(languageId: string, templateKey: string, profile: Profile): Promise<number | undefined>;
}

export type PortsFactory = (deps: PortDeps) => Partial<Ports>;

/** Bağlı olmayan yeteneklerin adları (sağlık ucunda gösterilir). */
export function missingPorts(p: Ports): string[] {
  return (["geometry", "engine", "designer", "imageGenerator", "fontCatalog"] as const).filter((k) => !p[k]);
}
