import { z } from "zod";
import { LineEditSchema, VariantAdjustSchema } from "./adjust.ts";
import { BuildBusEventSchema } from "./builder.ts";
import { BoxSchema, ShapeSchema } from "./geometry.ts";
import { DesignIntentSchema } from "./intent.ts";
import { IssueCodeSchema, IssueSchema, IssueSeveritySchema } from "./issues.ts";
import { MessageParamsSchema } from "./messages.ts";
import { LabelSizeSchema, ProfileRecordSchema } from "./profile.ts";
import { ReferenceSchema } from "./reference.ts";
import { TemplateCutSchema } from "./cut.ts";
import { TemplateSchema } from "./template.ts";

/**
 * Arayüz ↔ sunucu sözleşmesi: bütün istek/yanıt gövdeleri, uç nokta yolları (`API`) ve SSE olayları.
 *
 * Genel kurallar:
 * - Bütün yollar `/api` altında. Değiştiren her istek (POST/PUT/PATCH/DELETE) `X-Studio: 1` başlığı taşır;
 *   yoksa sunucu 403 döner. Gövde JSON'dur (`content-type: application/json`).
 * - Hata yanıtı her zaman `ApiError` biçimindedir (4xx/5xx). Doğrulama hatalarında `fields` alan yollarını verir.
 * - Tarihler ISO 8601 metindir. Görsel uçları PNG döner (`image/png`).
 * - Silme işlemleri yumuşaktır: yanıt `{ undoToken }` verir; `POST /api/undo/:token` geri alır (30 gün).
 */

// ---------------------------------------------------------------- ortak

export const ApiErrorSchema = z.object({
  error: z.string(),
  /** Doğrulama hataları: alan yolu ("sizing.fill", "rows.3.text") ve Türkçe mesaj. */
  fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  /** Kararlı hata kodu (`ERROR_MESSAGES`); arayüz `errors:<code>` sözlük anahtarına bakar. */
  code: z.string().optional(),
  /** Hata cümlesindeki değişkenler (sayılar sayı olarak). */
  params: MessageParamsSchema.optional(),
  /** `code: "missing-key"` iken eksik anahtarın sağlayıcısı ("anthropic" | "gemini"). */
  provider: z.string().optional(),
  /** `code: "feature-off"` iken kapalı özelliğin anahtarı (`FeatureKey`, ör. "learn"). */
  feature: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const OkSchema = z.object({ ok: z.literal(true) });
export const UndoTokenSchema = z.object({
  undoToken: z.string(),
  /** Kullanıcıya gösterilecek kısa açıklama ("3 iş silindi"; geriye uyum). */
  label: z.string(),
  /** Açıklamanın kodu (`UNDO_MESSAGES`) ve parametreleri. */
  code: z.string().optional(),
  params: MessageParamsSchema.optional(),
  expiresAt: z.string(),
});
export type UndoToken = z.infer<typeof UndoTokenSchema>;

export const UndoResultSchema = z.object({ ok: z.literal(true), restored: z.object({ jobs: z.number(), batches: z.number(), variants: z.number(), languages: z.number() }) });
export type UndoResult = z.infer<typeof UndoResultSchema>;

export const IdsSchema = z.object({ ids: z.array(z.string()).min(1) });
export type Ids = z.infer<typeof IdsSchema>;

export const SkippedSchema = z.object({ id: z.string(), reason: z.string() });
export type Skipped = z.infer<typeof SkippedSchema>;

// ---------------------------------------------------------------- tasarım dilleri

export const LanguageSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Etkin (yayınlanmış en yüksek) profil sürümü; yoksa null. */
  activeVersion: z.number().nullable(),
  hasDraft: z.boolean(),
  templateCount: z.number(),
  isDefault: z.boolean(),
  createdAt: z.string(),
});
export type Language = z.infer<typeof LanguageSchema>;

export const CreateLanguageSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** İsteğe bağlı kimlik (küçük harf, rakam, tire). Verilmezse addan üretilir. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).optional(),
  /** Profili şu dilin etkin sürümünden kopyala. */
  copyFrom: z.string().optional(),
});
export type CreateLanguage = z.infer<typeof CreateLanguageSchema>;

export const RenameLanguageSchema = z.object({ name: z.string().trim().min(1).max(80) });

// ---------------------------------------------------------------- profil

export const ProfileVersionSummarySchema = z.object({
  version: z.number(),
  status: z.enum(["draft", "published"]),
  note: z.string(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  active: z.boolean(),
});
export type ProfileVersionSummary = z.infer<typeof ProfileVersionSummarySchema>;

/** Taslak yazma: `data` tam profil (eksik alanlar varsayılanla dolar). Geçersizse 400 + `fields`. */
export const SaveDraftSchema = z.object({ data: z.unknown(), note: z.string().max(500).optional() });
export type SaveDraft = z.infer<typeof SaveDraftSchema>;

export const PublishSchema = z.object({ note: z.string().max(500).optional() });
export const RevertProfileSchema = z.object({ version: z.number().int().positive(), note: z.string().max(500).optional() });

export const ProfileDiffSchema = z.object({
  from: z.number(),
  to: z.number(),
  changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
});
export type ProfileDiff = z.infer<typeof ProfileDiffSchema>;

// ---------------------------------------------------------------- şablonlar

export const TemplateItemSchema = z.object({
  template: TemplateSchema.loose(),
  /** Kayıt var ama PNG klasörde yok (kayıt silinmez). */
  fileMissing: z.boolean(),
  imageUrl: z.string(),
  overlayUrl: z.string(),
  updatedAt: z.string(),
});
export type TemplateItem = z.infer<typeof TemplateItemSchema>;

/**
 * Şablon kaydı güncellemesi: KISMİ nesne. Sunucu mevcut kayıtla derin birleştirir ve tam `TemplateSchema` ile
 * doğrular; gönderilmeyen hiçbir alan (ölçülmüş textCenter, provenance, bilinmeyen alanlar) kaybolmaz.
 * `key`, `languageId`, `file`, `hash`, `width`, `height` değiştirilemez.
 */
export const TemplatePatchSchema = z.record(z.string(), z.unknown());
export type TemplatePatch = z.infer<typeof TemplatePatchSchema>;

/**
 * Kesim değişikliği önizlemesi (kaydetmeden önce): `cut` PATCH'teki `cut` alanıyla aynı biçim; `null` = şablonun kendi
 * kesimi kalkar, tasarım dilinin kesimine düşer.
 */
export const TemplateCutPreviewRequestSchema = z.object({ cut: TemplateCutSchema.nullable() });
export type TemplateCutPreviewRequest = z.input<typeof TemplateCutPreviewRequestSchema>;
/**
 * `changed`: etkin kesim değişiyor mu. `approvals`: kayıt yapılırsa onayı düşecek (onaylı, basılmamış, silinmemiş)
 * etiket işi sayısı; değişiklik yoksa 0.
 */
export const TemplateCutPreviewResponseSchema = z.object({ changed: z.boolean(), approvals: z.number().int().nonnegative() });
export type TemplateCutPreviewResponse = z.infer<typeof TemplateCutPreviewResponseSchema>;

export const UploadTemplateSchema = z.object({
  /** Verilmezse dosya adından (küçük harf). */
  key: z.string().optional(),
  fileName: z.string().min(1),
  /** PNG, base64 (data: öneki olabilir). */
  png: z.string().min(1),
  kind: z.enum(["label", "sticker", "generated"]).optional(),
});
export type UploadTemplate = z.infer<typeof UploadTemplateSchema>;

export const TemplateSyncResultSchema = z.object({ added: z.array(z.string()), updated: z.array(z.string()), missing: z.array(z.string()) });
export type TemplateSyncResult = z.infer<typeof TemplateSyncResultSchema>;

// ---------------------------------------------------------------- fontlar

export const FontItemSchema = z.object({
  file: z.string(),
  /** "dil" = tasarım dilinin klasörü, "ortak" = yedek fontlar. */
  scope: z.enum(["language", "shared"]),
  family: z.string().nullable(),
  style: z.string().nullable(),
  /** Profildeki font kimliği (bu dosyayı kullanan kayıt), yoksa null. */
  profileFontId: z.string().nullable(),
  size: z.number(),
  specimenUrl: z.string(),
});
export type FontItem = z.infer<typeof FontItemSchema>;

export const FontListSchema = z.object({
  files: z.array(FontItemSchema),
  /** Profilde olup dosyası bulunmayan fontlar. */
  missing: z.array(z.object({ fontId: z.string(), file: z.string().nullable() })),
});
export type FontList = z.infer<typeof FontListSchema>;

export const UploadFontSchema = z.object({ fileName: z.string().min(1), data: z.string().min(1) });

// ---------------------------------------------------------------- ayarlar

export const AI_PROVIDERS = ["anthropic", "gemini"] as const;
export const AiProviderSchema = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const AppSettingsSchema = z.object({
  defaultLanguageId: z.string().nullable().default(null),
  /** Aynı anda kaç iş üretilir. */
  concurrency: z.number().int().min(1).max(8).default(2),
  /** Bir üretim turunda kaç varyasyon kaydedilir (adaylar AI sıralamasıyla). */
  variantsPerRun: z.number().int().min(1).max(3).default(1),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/** Kısmi ayar güncellemesi (gönderilmeyen ayar değişmez). */
export const SettingsPatchSchema = z
  .object({
    defaultLanguageId: z.string().nullable(),
    concurrency: z.number().int().min(1).max(8),
    variantsPerRun: z.number().int().min(1).max(3),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const ApiKeyStatusSchema = z.object({
  provider: AiProviderSchema,
  label: z.string(),
  /** Sabit adres; değiştirilemez. */
  baseUrl: z.string(),
  hasKey: z.boolean(),
  /** Diskte şifreli mi (AES-256-GCM; yalnız taşınmamış eski düz kayıtta false). false ise uyarı gösterilir. */
  encrypted: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;

export const SettingsViewSchema = z.object({ settings: AppSettingsSchema, keys: z.array(ApiKeyStatusSchema), warnings: z.array(z.string()) });
export type SettingsView = z.infer<typeof SettingsViewSchema>;

/** Anahtar girişi. Adres (baseUrl) KABUL EDİLMEZ (strict). */
export const SetApiKeySchema = z.object({ apiKey: z.string().trim().min(8).max(500) }).strict();

// ---------------------------------------------------------------- içe aktarma

export const IMPORT_FIELDS = ["text", "template", "orderNo", "quantity", "product", "size"] as const;
export const ImportFieldSchema = z.enum(IMPORT_FIELDS);
export type ImportField = z.infer<typeof ImportFieldSchema>;

/** Hangi JSON alanı hangi role eşlendi (null = yok). */
export const FieldMapSchema = z.object({
  text: z.string().nullable(),
  template: z.string().nullable(),
  orderNo: z.string().nullable(),
  quantity: z.string().nullable(),
  product: z.string().nullable(),
  size: z.string().nullable(),
});
export type FieldMap = z.infer<typeof FieldMapSchema>;

export const JobKindSchema = z.enum(["label", "sticker"]);
export type JobKind = z.infer<typeof JobKindSchema>;

/** İnceleme masasındaki bir satır (sunucunun hesapladığı hâli). */
export const ImportRowSchema = z.object({
  /** Dosyadaki sıra (0'dan). */
  index: z.number().int(),
  raw: z.record(z.string(), z.unknown()),
  /** Partiye alınacak mı (tekrarlar varsayılan olarak hariç). */
  include: z.boolean(),
  /** Dosyadaki metin (dokunulmamış). */
  textRaw: z.string(),
  /** Üretimde kullanılacak metin (kullanıcı düzenleyebilir). */
  text: z.string(),
  /** Müşterinin satır ipuçları. */
  segments: z.array(z.string()),
  /** Dosyadaki şablon değeri (ham). */
  templateInput: z.string().nullable(),
  templateKey: z.string().nullable(),
  labelSize: z.string().nullable(),
  orderNo: z.string().nullable(),
  /** Sayı; geçersizse kullanıcının/dosyanın yazdığı metin olduğu gibi kalır (quantity-invalid). */
  quantity: z.union([z.number(), z.string(), z.null()]),
  product: z.string().nullable(),
  kind: JobKindSchema,
  aiNote: z.string(),
  /** Kullanıcının "yok say" dediği sorun kodları (yalnızca uyarı/bilgi yok sayılabilir). */
  dismissed: z.array(IssueCodeSchema),
  issues: z.array(IssueSchema),
  /** Tekrar anahtarı (sipariş + şablon + boyut + metin). */
  dedupeKey: z.string(),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;

/** Arayüzün geri gönderdiği (düzenlenmiş) satır. Hesaplanan alanlar (issues, segments, dedupeKey) yok sayılır. */
export const ImportRowInputSchema = z.object({
  index: z.number().int(),
  raw: z.record(z.string(), z.unknown()).default({}),
  include: z.boolean().default(true),
  textRaw: z.string().default(""),
  text: z.string(),
  templateInput: z.string().nullable().default(null),
  templateKey: z.string().nullable().default(null),
  labelSize: z.string().nullable().default(null),
  orderNo: z.string().nullable().default(null),
  /** Sayı ya da kullanıcının yazdığı metin (geçersizse quantity-invalid). */
  quantity: z.union([z.number(), z.string(), z.null()]).default(null),
  product: z.string().nullable().default(null),
  kind: JobKindSchema.optional(),
  aiNote: z.string().default(""),
  dismissed: z.array(IssueCodeSchema).default([]),
});
export type ImportRowInput = z.input<typeof ImportRowInputSchema>;

export const ImportSummarySchema = z.object({
  total: z.number(),
  included: z.number(),
  errors: z.number(),
  warnings: z.number(),
  duplicates: z.number(),
  stickers: z.number(),
  /** Sorun koduna göre satır sayısı. */
  byCode: z.record(z.string(), z.number()),
});
export type ImportSummary = z.infer<typeof ImportSummarySchema>;

export const ImportPreviewRequestSchema = z.object({
  fileName: z.string().default("yapistirilan.json"),
  content: z.string().min(1),
  languageId: z.string().optional(),
  /** Kullanıcının elle seçtiği eşleme (verilen alanlar tahmini ezer). */
  mapping: FieldMapSchema.partial().optional(),
});
export type ImportPreviewRequest = z.input<typeof ImportPreviewRequestSchema>;

export const ImportPreviewResponseSchema = z.object({
  languageId: z.string(),
  fileName: z.string(),
  /** Dosyadaki bütün alan adları (eşleme seçicisi için). */
  fields: z.array(z.string()),
  mapping: FieldMapSchema,
  /** Eşleme nasıl bulundu: "name" (alan adı), "content" (içerikten tahmin), "user", null (bulunamadı). */
  mappingSource: z.record(ImportFieldSchema, z.enum(["name", "content", "user"]).nullable()),
  /** Dosya biçimi. */
  format: z.enum(["array", "wrapped", "ndjson", "object"]),
  rows: z.array(ImportRowSchema),
  warnings: z.array(z.string()),
  summary: ImportSummarySchema,
  /** Şablon seçicisi için dilin şablon anahtarları (sticker sayfaları `sticker-<id>` olarak dahil). */
  templateKeys: z.array(z.string()),
  labelSizes: z.array(LabelSizeSchema),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponseSchema>;

export const ImportValidateRequestSchema = z.object({ languageId: z.string().optional(), rows: z.array(ImportRowInputSchema) });
export type ImportValidateRequest = z.input<typeof ImportValidateRequestSchema>;
export const ImportValidateResponseSchema = z.object({ rows: z.array(ImportRowSchema), summary: ImportSummarySchema });
export type ImportValidateResponse = z.infer<typeof ImportValidateResponseSchema>;

export const ImportCommitRequestSchema = z.object({
  fileName: z.string().default("yapistirilan.json"),
  languageId: z.string().optional(),
  /** Parti adı (verilmezse dosya adı + tarih). */
  batchName: z.string().max(120).optional(),
  mapping: FieldMapSchema,
  rows: z.array(ImportRowInputSchema),
  /** true: oluşan işlerden üretilebilenler hemen üretim kuyruğuna alınır. */
  generate: z.boolean().default(false),
});
export type ImportCommitRequest = z.input<typeof ImportCommitRequestSchema>;

export const ImportCommitResponseSchema = z.object({
  batchId: z.string(),
  jobIds: z.array(z.string()),
  created: z.number(),
  /** Hariç tutulan ya da metni boş olduğu için alınmayan satırlar. */
  skipped: z.array(z.object({ index: z.number(), reason: z.string() })),
  queued: z.array(z.string()),
  /**
   * `generate: true` iken üretim başlatılamadıysa neden (işler yine açıldı, kuyruğa girmedi; `queued: []`): `missing-key`
   * (yerel kip), `ai-unavailable`, `ai-paused`, `budget-exceeded` (platform kipi). `message` kullanıcıya gösterilebilir.
   */
  notQueued: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ImportCommitResponse = z.infer<typeof ImportCommitResponseSchema>;

// ---------------------------------------------------------------- işler, partiler, varyasyonlar

export const JOB_STATUSES = [
  "new",
  "queued",
  "generating",
  "ready",
  "failed",
  "approved",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const VariantKindSchema = z.enum(["text", "image-on-template", "generated-template"]);
export type VariantKind = z.infer<typeof VariantKindSchema>;

export const VariantSnapshotSchema = z.object({
  languageId: z.string(),
  profileVersion: z.number().nullable(),
  templateKey: z.string().nullable(),
  labelSize: z.string().nullable(),
  /** Varyasyon üretildiğindeki metin (iş metni sonradan değişirse varyasyon "eski" sayılır). */
  text: z.string(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  costUsd: z.number().nullable(),
  revision: z.object({ fromVariantId: z.string(), request: z.string() }).nullable(),
});
export type VariantSnapshot = z.infer<typeof VariantSnapshotSchema>;

export const VariantSummarySchema = z.object({
  id: z.string(),
  jobId: z.string(),
  /** V1, V2… (iş içinde artan). */
  no: z.number(),
  kind: VariantKindSchema,
  score: z.number().nullable(),
  /** AI'ın kendi turundaki sırası (1 = ilk tercih), yoksa null. */
  aiRank: z.number().nullable(),
  /** Kontrol işareti: "en iyiyi onayla" bunu seçmez. */
  suspect: z.boolean(),
  approved: z.boolean(),
  /** İş metni/şablonu varyasyondan sonra değişti. */
  stale: z.boolean(),
  previewUrl: z.string(),
  worst: IssueSeveritySchema.nullable(),
  /** Bilgi notları hariç sorun sayısı (hata + uyarı). */
  issueCount: z.number().int().min(0).default(0),
  /** Elle düzeltildi (hafif düzeltme kayıtlı). Eski yanıtlarda yok = false. */
  adjusted: z.boolean().optional(),
  /** Hafif düzeltmede satır metni elle düzenlendi ve iş metninden farklı (`text-edited` sorunu). Yok = false. */
  textEdited: z.boolean().optional(),
  createdAt: z.string(),
});
export type VariantSummary = z.infer<typeof VariantSummarySchema>;

export const VariantDetailSchema = VariantSummarySchema.extend({
  intent: DesignIntentSchema.nullable(),
  /** Motor yerleşimi (LayoutResult; görüntü modunda null). */
  layout: z.unknown().nullable(),
  snapshot: VariantSnapshotSchema,
  issues: z.array(IssueSchema),
  rationale: z.string(),
  /** Görüntü modunda yazı katmanı. */
  image: z.object({ textLayerUrl: z.string().nullable(), textBox: BoxSchema.nullable(), readText: z.string().nullable() }).nullable(),
  /**
   * Hafif düzeltme (tasarım alanı px). `layout` HER ZAMAN motorun düzeltmesiz yerleşimidir; önizleme ve baskı
   * bu düzeltmeyi uygular. null/yok = düzeltme yok.
   */
  adjust: VariantAdjustSchema.nullable().optional(),
});
export type VariantDetail = z.infer<typeof VariantDetailSchema>;

export const JobSummarySchema = z.object({
  id: z.string(),
  batchId: z.string(),
  languageId: z.string(),
  seq: z.number(),
  orderNo: z.string().nullable(),
  quantity: z.number().nullable(),
  templateKey: z.string().nullable(),
  labelSize: z.string().nullable(),
  product: z.string().nullable(),
  text: z.string(),
  segments: z.array(z.string()),
  kind: JobKindSchema,
  aiNote: z.string(),
  status: JobStatusSchema,
  /** Son hata (ör. AI hatası) kısa metni. */
  error: z.string().nullable(),
  approvedVariantId: z.string().nullable(),
  issues: z.array(IssueSchema),
  /** Sorunların en ağırı (bilgi notları hariç değil). */
  worst: IssueSeveritySchema.nullable(),
  variants: z.array(VariantSummarySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const JobDetailSchema = JobSummarySchema.extend({
  raw: z.record(z.string(), z.unknown()),
  textRaw: z.string(),
  dismissed: z.array(IssueCodeSchema),
  batchName: z.string(),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;

export const JOB_SORTS = ["created", "order", "status", "template"] as const;
export const JobListQuerySchema = z.object({
  languageId: z.string().optional(),
  batchId: z.string().optional(),
  /** Virgülle birden çok durum. */
  status: z.string().optional(),
  /** yes: hata/uyarı olanlar, no: olmayanlar (bilgi notları sayılmaz). */
  issues: z.enum(["yes", "no"]).optional(),
  /** Metin, sipariş no, şablon ve üründe arar. */
  q: z.string().optional(),
  sort: z.enum(JOB_SORTS).default("created"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type JobListQuery = z.input<typeof JobListQuerySchema>;
export const JobListResponseSchema = z.object({ jobs: z.array(JobSummarySchema), total: z.number() });
export type JobListResponse = z.infer<typeof JobListResponseSchema>;

/** İş düzenleme (kısmi). Sorunlar yeniden hesaplanır. */
export const JobPatchSchema = z
  .object({
    text: z.string(),
    templateKey: z.string().nullable(),
    labelSize: z.string().nullable(),
    quantity: z.union([z.number(), z.string(), z.null()]),
    orderNo: z.string().nullable(),
    product: z.string().nullable(),
    aiNote: z.string().max(2000),
    kind: JobKindSchema,
    dismissed: z.array(IssueCodeSchema),
  })
  .partial()
  .strict();
export type JobPatch = z.infer<typeof JobPatchSchema>;

export const BulkJobPatchSchema = z.object({
  ids: z.array(z.string()).min(1),
  patch: z.object({ templateKey: z.string().nullable(), labelSize: z.string().nullable(), aiNote: z.string().max(2000), kind: JobKindSchema }).partial().strict(),
});

export const ManualJobSchema = z.object({
  languageId: z.string().optional(),
  /** Verilmezse günün "Elle eklenenler" partisi. */
  batchId: z.string().optional(),
  text: z.string().min(1),
  templateKey: z.string().nullable().default(null),
  labelSize: z.string().nullable().default(null),
  orderNo: z.string().nullable().default(null),
  quantity: z.union([z.number(), z.string(), z.null()]).default(null),
  product: z.string().nullable().default(null),
  aiNote: z.string().default(""),
  kind: JobKindSchema.optional(),
  generate: z.boolean().default(false),
});
export type ManualJob = z.input<typeof ManualJobSchema>;

export const ApproveSchema = z.object({ variantId: z.string().nullable() });
export const ApproveBestResponseSchema = z.object({ approved: z.array(z.object({ jobId: z.string(), variantId: z.string() })), skipped: z.array(SkippedSchema) });
export type ApproveBestResponse = z.infer<typeof ApproveBestResponseSchema>;

export const VariantPatchSchema = z.object({ suspect: z.boolean() }).partial().strict();

// ---------------------------------------------------------------- hafif düzeltme

/** PUT `variantAdjust` ve POST `variantAdjustCheck` gövdesi. Kimlik düzeltmesi (0, 0, 1) PUT'ta "kaldır" sayılır. */
export const VariantAdjustRequestSchema = z.object({ adjust: VariantAdjustSchema }).strict();
export type VariantAdjustRequest = z.input<typeof VariantAdjustRequestSchema>;

/** POST `variantEditRelayout` gövdesi: düzenlemeler (`placed` yok sayılır). */
export const AdjustRelayoutRequestSchema = z.object({ edits: z.array(LineEditSchema).max(50) }).strict();
export type AdjustRelayoutRequest = z.input<typeof AdjustRelayoutRequestSchema>;

/**
 * Elle metin/font düzenlemesinin motor sonucu (kaydetmez): `placed` doldurulmuş, etkisizleri atılmış düzenlemeler ve
 * düzenlenmiş (düzeltmesiz) yazı katmanı SVG'si (`variantEditText` ile aynı biçim). `issues`: düzenlemeden doğan
 * notlar (metin farkı, yedek font, basılamayan karakter, font ailesi sayısı).
 */
export const AdjustRelayoutResponseSchema = z.object({
  edits: z.array(LineEditSchema),
  textSvg: z.string(),
  issues: z.array(IssueSchema),
});
export type AdjustRelayoutResponse = z.infer<typeof AdjustRelayoutResponseSchema>;

/** Çarpışma denetiminin ham sayıları (denetim ölçeğinde piksel). */
export const AdjustCollisionSchema = z.object({ inkPx: z.number(), outsideCutPx: z.number(), decorationPx: z.number(), outsideFreePx: z.number() });

/** Hızlı denetim (kaydetmeden): düzeltilmiş mürekkep kutuları + sorunlar. */
export const AdjustCheckResponseSchema = z.object({
  /** Normalleştirilmiş düzeltme (null = etkisiz). */
  adjust: VariantAdjustSchema.nullable(),
  /** Düzeltilmiş bütün yazının ve satırların mürekkep kutuları (tasarım px). */
  ink: BoxSchema,
  lineInks: z.array(BoxSchema),
  /** Satırların etkin kontur genişlikleri (tasarım px, `effectiveLineStroke` ile aynı). */
  lineStrokes: z.array(z.number()),
  /** Yalnızca düzeltmeden doğan sorunlar (`field: "adjust"`): kesim dışı taşma (hata), süsleme çarpışması (uyarı), küçük punto (uyarı). */
  issues: z.array(IssueSchema),
  /** Motor denetimi bağlı değilse null (o zaman sorun listesi boş döner). */
  collision: AdjustCollisionSchema.nullable(),
  ms: z.number(),
});
export type AdjustCheckResponse = z.infer<typeof AdjustCheckResponseSchema>;

/** Kaydet / kaldır yanıtı: güncel varyasyon + geri alma anahtarı (`POST /api/undo/:token` önceki hâle döndürür). */
export const AdjustSaveResponseSchema = z.object({ variant: VariantDetailSchema, undo: UndoTokenSchema });
export type AdjustSaveResponse = z.infer<typeof AdjustSaveResponseSchema>;

/**
 * Düzenleme katmanının ihtiyaç duyduğu her şey. Bütün koordinatlar tasarım alanı px (0..framePx kare).
 * Düzeltilemeyen varyasyon (görüntü modu, yerleşimsiz) için uç 422 + `code: "not-adjustable"` döner.
 */
export const VariantEditModelSchema = z.object({
  variantId: z.string(),
  jobId: z.string(),
  framePx: z.number(),
  /** Şablon görseli ve tasarım alanındaki kutusu (görsel bu kutuya `fill` ile gerilir; sticker'da null). */
  templateImageUrl: z.string().nullable(),
  templateBox: BoxSchema,
  /** Kesim şekli ve kutusu. */
  cut: ShapeSchema,
  cutBox: BoxSchema,
  /** Yazı alanı kutusu. */
  areaBox: BoxSchema,
  /** Ortalama hedefleri. `textCenter.source`: "template" = şablonda kayıtlı hedef merkez, "area" = yazı alanından hesaplandı. */
  centers: z.object({
    textCenter: z.object({ x: z.number(), y: z.number(), source: z.enum(["template", "area"]) }),
    area: z.object({ x: z.number(), y: z.number() }),
    cut: z.object({ x: z.number(), y: z.number() }),
  }),
  /** Blok ölçeğinin merkezi (düzeltmesiz mürekkep kutusunun merkezi). */
  origin: z.object({ x: z.number(), y: z.number() }),
  /** Düzeltmesiz bütün yazının mürekkep kutusu ve satırlar. */
  ink: BoxSchema,
  /**
   * `strokePx`: satırın temel (düzeltmesiz) konturu, tasarım px. Etkin kontur için domain `effectiveLineStroke`.
   * `fontId`: satırın ana fontu (glif kuralı ve yedek font run'ları hariç en uzun run), yoksa yok.
   */
  lines: z.array(z.object({ index: z.number(), text: z.string(), sizePx: z.number(), ink: BoxSchema, strokePx: z.number(), fontId: z.string().optional() })),
  /**
   * Elle font seçimi için tasarım dilinin satır fontları (açık, satır rolü olan, dosyası yüklü) ve aile kuralı
   * (`fonts.mixing`). Eski yanıtlarda yok.
   */
  fonts: z.array(z.object({ id: z.string(), family: z.string(), style: z.string(), kind: z.string() })).optional(),
  fontMixing: z.enum(["single", "two", "free"]).optional(),
  /** İşin (müşterinin) metni: elle metin düzenlemesinde karşılaştırma için. */
  jobText: z.string().optional(),
  /** Yerleşimin temel konturu (tasarım px; 0 = kalınlık yok) ve profilin kontur hizası (`weight.align`). */
  strokePx: z.number(),
  strokeAlign: z.enum(["outside", "center"]),
  /**
   * Yalnızca YAZI katmanı (saydam SVG, viewBox 0 0 framePx framePx, DÜZELTMESİZ). Satırlar `<g data-line="i">`;
   * kontur grup özniteliğindedir (`stroke-width` = `svgStrokeWidth(etkinKontur, strokeAlign, ölçek)`).
   */
  textLayerUrl: z.string().nullable(),
  /** Kayıtlı düzeltme ve onun uygulanmış mürekkep kutusu. */
  adjust: VariantAdjustSchema.nullable(),
  adjustedInk: BoxSchema,
  /** Varyasyonun güncel sorunları ve önizlemesi. */
  issues: z.array(IssueSchema),
  previewUrl: z.string(),
  limits: z.object({ scaleMin: z.number(), scaleMax: z.number(), shiftMaxPx: z.number(), strokeMaxPx: z.number() }),
});
export type VariantEditModel = z.infer<typeof VariantEditModelSchema>;

export const BatchSummarySchema = z.object({
  id: z.string(),
  languageId: z.string(),
  name: z.string(),
  sourceFile: z.string().nullable(),
  createdAt: z.string(),
  total: z.number(),
  /** Duruma göre iş sayısı. */
  byStatus: z.record(z.string(), z.number()),
  withIssues: z.number(),
  approved: z.number(),
});
export type BatchSummary = z.infer<typeof BatchSummarySchema>;
export const RenameBatchSchema = z.object({ name: z.string().trim().min(1).max(120) });

// ---------------------------------------------------------------- üretim

export const GenerateRequestSchema = z.object({
  jobIds: z.array(z.string()).min(1),
  mode: VariantKindSchema.default("text"),
  /** generated-template modunda tema/tarif. */
  theme: z.string().max(1000).optional(),
  /** generated-template: üretilen şablon kütüphanede kalıcı olsun mu (false = yalnızca bu iş için). */
  keepTemplate: z.boolean().default(true),
});
export type GenerateRequest = z.input<typeof GenerateRequestSchema>;
export const GenerateResponseSchema = z.object({ queued: z.array(z.string()), skipped: z.array(SkippedSchema) });
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

export const ReviseRequestSchema = z.object({ request: z.string().trim().min(1).max(1000) });
export const CancelGenerationSchema = z.object({ jobIds: z.array(z.string()).optional() });

export const QueueStatusSchema = z.object({ running: z.number(), queued: z.number(), concurrency: z.number(), runningJobIds: z.array(z.string()) });
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

export const ProgressStepSchema = z.object({
  jobId: z.string(),
  taskId: z.string().nullable(),
  /** context | ai | layout | pick | critique | image | save | done | error | info */
  step: z.string(),
  message: z.string(),
  at: z.string(),
});
export type ProgressStep = z.infer<typeof ProgressStepSchema>;

export const AiCallSummarySchema = z.object({
  id: z.string(),
  purpose: z.string(),
  model: z.string(),
  summary: z.string(),
  error: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  durationMs: z.number(),
  createdAt: z.string(),
});
export type AiCallSummary = z.infer<typeof AiCallSummarySchema>;

export const JobLogSchema = z.object({ steps: z.array(ProgressStepSchema), aiCalls: z.array(AiCallSummarySchema), running: z.boolean() });
export type JobLog = z.infer<typeof JobLogSchema>;

// ---------------------------------------------------------------- referanslar ve öğrenme

export const ReferenceInputSchema = ReferenceSchema.omit({ id: true, createdAt: true }).extend({ languageId: z.string().optional() });
export const ReferencePatchSchema = z.object({ split: z.enum(["train", "test"]), text: z.string(), templateKey: z.string().nullable() }).partial().strict();

export const LearnProposalStatusSchema = z.enum(["open", "accepted", "rejected"]);
export const LearnProposalSchema = z.object({
  id: z.string(),
  languageId: z.string(),
  status: LearnProposalStatusSchema,
  title: z.string(),
  summary: z.string(),
  /** Önerilen profil/şablon yaması (biçim öğrenme paketiyle belirlenecek). */
  patch: z.unknown(),
  /** Kanıt: örnekler, istatistik, önce/sonra ölçümü. */
  evidence: z.unknown(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type LearnProposal = z.infer<typeof LearnProposalSchema>;
export const LearnProposalInputSchema = z.object({
  languageId: z.string().optional(),
  title: z.string().min(1).max(200),
  summary: z.string().default(""),
  patch: z.unknown().default(null),
  evidence: z.unknown().default(null),
});
export const LearnProposalPatchSchema = z.object({ status: LearnProposalStatusSchema, title: z.string(), summary: z.string() }).partial().strict();

/**
 * Öğrenme koşusu ("Düzeltmelerimden öğren"): referanslardan ve uygulamadaki elle düzeltmelerden (adjust_log) öneri üretir
 * (uzun sürer → 202 + SSE `learn`).
 * Üretilen önerilerin `patch` biçimi: `[{ target: "profile", path, from, to } | { target: "template", key, field, path: "template:<anahtar>.<alan>", from, to }]`.
 * `evidence`: `{ source: "learn-run", slug, kind: "motor"|"ai", count, stats, examples, primary, verdict, weak, reason,
 *   heldOut: { n, before, after, full } | null, previews: [{ referenceId, url }], runId }` (heldOut = ayrılmış test kümesinde AI'sız tekrar).
 * Elle düzeltme önerilerinde ayrıca `origin: "adjust"`, `variants: [{ variantId, jobId, url }]` ve `heldOut.folds`
 * (dışarıda tutulan iş katları); referans (bitmiş etiket) kaynaklılarda `origin: "reference"`.
 */
export const LearnRunRequestSchema = z
  .object({
    /** Önerilerin tabanı: taslak (varsayılan; yoksa yayınlanan) ya da yayınlanan profil. */
    base: z.enum(["draft", "published"]),
    /** En az örnek eşikleri (varsayılan 15 / 3 / 2). */
    minProfile: z.number().int().min(2).max(500),
    minTemplate: z.number().int().min(1).max(100),
    minCenter: z.number().int().min(1).max(100),
    /** Elle düzeltme eşikleri (varsayılan 4 varyasyon / 3 farklı iş / 0,01 alan oranı kayma / işlerin %60'ı aynı yönde). */
    minAdjust: z.number().int().min(1).max(500),
    minAdjustJobs: z.number().int().min(1).max(500),
    minAdjustShift: z.number().min(0.001).max(0.2),
    minAdjustAgreement: z.number().min(0.5).max(1),
  })
  .partial();
export type LearnRunRequest = z.infer<typeof LearnRunRequestSchema>;

export const LearnRunStatusSchema = z.object({
  id: z.string(),
  languageId: z.string(),
  status: z.enum(["running", "done", "failed", "cancelled", "interrupted"]),
  base: z.enum(["draft", "published"]),
  profileVersion: z.number(),
  /** fark · olcum · oneri · test · deneme · onizleme · bitti */
  step: z.string(),
  done: z.number(),
  total: z.number(),
  message: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  result: z
    .object({
      /** Oluşturulan öneri kimlikleri. */
      proposals: z.array(z.string()),
      /** Ayrılmış kümede kötüleştirdiği için düşürülenler. */
      dropped: z.array(z.object({ slug: z.string(), title: z.string(), reason: z.string() })),
      /** İnsan diline çevrilmiş bulgular. */
      findings: z.array(z.string()),
      baseline: z.unknown(),
      counts: z.unknown(),
      ms: z.number(),
    })
    .nullable(),
});
export type LearnRunStatus = z.infer<typeof LearnRunStatusSchema>;

/** Öneriyi uygula / geri al yanıtı: profil değişiklikleri taslağa, şablon değişiklikleri kayda (provenance "learned"). */
export const LearnApplyResultSchema = z.object({
  proposal: LearnProposalSchema,
  draft: ProfileRecordSchema.nullable(),
  /** Değişen şablon anahtarları. */
  templates: z.array(z.string()),
});
export type LearnApplyResult = z.infer<typeof LearnApplyResultSchema>;

/** Motor denemesi (AI'sız, ücretsiz): referansların kullanıcı satırları taslak/yayınlanan profille motora verilir. */
export const LearnReplayRequestSchema = z.object({
  source: z.enum(["draft", "published", "both"]).default("draft"),
  limit: z.number().int().min(1).max(300).default(40),
  split: z.enum(["train", "test", "all"]).default("test"),
  template: z.string().min(1).optional(),
  /** Önce/sonra önizleme sayısı. */
  previews: z.number().int().min(0).max(8).default(3),
});
export type LearnReplayRequest = z.infer<typeof LearnReplayRequestSchema>;

// ---------------------------------------------------------------- tasarım dili oturumu (Claude Code becerisi + MCP)

export const DesignSessionEntryKindSchema = z.enum(["question", "answer", "draft-write", "trial", "note"]);
export const DesignSessionStatusSchema = z.enum(["idle", "asking", "drafting", "trying", "done"]);

export const DesignSessionEntrySchema = z.object({
  id: z.number(),
  at: z.string(),
  kind: DesignSessionEntryKindSchema,
  text: z.string(),
  /** Soru grubu (satır bölme, boyut, bağlaçlar…). */
  group: z.string().nullable(),
  /** draft-write: taslakta değişen alan yolları. */
  paths: z.array(z.string()).optional(),
});
export type DesignSessionEntry = z.infer<typeof DesignSessionEntrySchema>;

export const DesignSessionSchema = z.object({
  id: z.string().nullable(),
  title: z.string(),
  status: DesignSessionStatusSchema,
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  entries: z.array(DesignSessionEntrySchema),
});
export type DesignSession = z.infer<typeof DesignSessionSchema>;

export const DesignSessionStartSchema = z.object({ title: z.string().max(200).default("") });
export const DesignSessionEntryInputSchema = z.object({
  kind: DesignSessionEntryKindSchema,
  text: z.string().trim().min(1).max(20000),
  group: z.string().trim().max(80).optional(),
  paths: z.array(z.string()).max(500).optional(),
  /** Oturum durumunu açıkça değiştir (ör. bitince "done"); yoksa girdi türünden çıkarılır. */
  status: DesignSessionStatusSchema.optional(),
});
export type DesignSessionEntryInput = z.infer<typeof DesignSessionEntryInputSchema>;

/** Taslağa kısmi yama: nesneler derin birleşir, diziler bütün değişir, `null` alanı varsayılana bırakır. */
export const DesignDraftWriteSchema = z.object({ patch: z.record(z.string(), z.unknown()), note: z.string().max(500).optional() });
export const DesignDraftWriteResultSchema = z.object({
  draft: ProfileRecordSchema,
  changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
});
export type DesignDraftWriteResult = z.infer<typeof DesignDraftWriteResultSchema>;

// ---------------------------------------------------------------- maliyet ve durum

export const CostSummarySchema = z.object({
  todayUsd: z.number(),
  monthUsd: z.number(),
  totalUsd: z.number(),
  /** Son 31 gün. */
  byDay: z.array(z.object({ day: z.string(), usd: z.number(), calls: z.number() })),
  byModel: z.array(z.object({ model: z.string(), usd: z.number(), calls: z.number() })),
  byPurpose: z.array(z.object({ purpose: z.string(), usd: z.number(), calls: z.number() })),
  /** Fiyatı bilinmeyen modelle yapılan çağrı sayısı (tutara dahil değil). */
  unpricedCalls: z.number(),
});
export type CostSummary = z.infer<typeof CostSummarySchema>;

export const HealthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  /** Bağlı olmayan yetenekler (ör. "designer", "engine"): arayüz ilgili düğmeleri açıklamayla kapatır. */
  missingPorts: z.array(z.string()),
  languages: z.number(),
});
export type Health = z.infer<typeof HealthSchema>;

// ---------------------------------------------------------------- şablon araçları

/** Yazı alanı önerisi: dekor ayarları kayda yazılmadan geçici uygulanır. */
export const SuggestAreaRequestSchema = z.object({
  decoration: z
    .object({ source: z.enum(["auto", "alpha", "color"]).optional(), threshold: z.number().positive().optional(), dilatePx: z.number().min(0).optional() })
    .optional(),
});
export type SuggestAreaRequest = z.input<typeof SuggestAreaRequestSchema>;
/** `shape`: tasarım alanına ORAN (0..1); doğrudan `area: { mode: "manual", shape }` olarak kaydedilebilir. */
export const SuggestAreaResponseSchema = z.object({ shape: ShapeSchema });
export type SuggestAreaResponse = z.infer<typeof SuggestAreaResponseSchema>;

/**
 * Şablonda AI'sız deneme: metin deterministik basit niyetle (müşteri satır ipuçları; isim/bağlaç sezgisi) gerçek
 * motora verilir. `patch` şablon kaydına YAZILMADAN geçici uygulanır.
 */
export const TemplateTryRequestSchema = z.object({
  text: z.string().trim().min(1).max(500),
  patch: TemplatePatchSchema.optional(),
  profile: z.enum(["draft", "published"]).default("published"),
});
export type TemplateTryRequest = z.input<typeof TemplateTryRequestSchema>;
export const TemplateTryResponseSchema = z.object({
  /** Önizleme PNG'si (base64, data: öneki yok). */
  png: z.string(),
  lines: z.array(z.string()),
  /** Ana satır puntosu (pt). */
  basePt: z.number(),
  /** Satır puntoları (tasarım alanı px). */
  sizesPx: z.array(z.number()).default([]),
  issues: z.array(IssueSchema),
});
export type TemplateTryResponse = z.infer<typeof TemplateTryResponseSchema>;

/** Temadan yeni şablon (görüntü modeli, ücretli). Kuyruğa alınır; bitince şablon `kind: generated` olarak eklenir (SSE `template`). */
export const GenerateTemplateRequestSchema = z.object({
  theme: z.string().trim().min(1).max(1000),
  /** Verilirse üretilen şablonda bu metinle AI'sız deneme önizlemesi hazırlanır. */
  sampleText: z.string().trim().max(500).optional(),
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/).optional(),
  /** false: geçici (etiketlenir, kütüphanede "geçici" görünür). */
  keep: z.boolean().default(true),
});
export type GenerateTemplateRequest = z.input<typeof GenerateTemplateRequestSchema>;
/** `interrupted`: sunucu yeniden başlarken yarım kalmış (kesildi). */
export const TemplateTaskStatusSchema = z.enum(["queued", "running", "done", "failed", "interrupted"]);
export const TemplateTaskSchema = z.object({
  id: z.string(),
  languageId: z.string(),
  status: TemplateTaskStatusSchema,
  theme: z.string(),
  /** Üretilen şablonun anahtarı (bitince). */
  key: z.string().nullable(),
  error: z.string().nullable(),
  costUsd: z.number().nullable(),
  /** `sampleText` verildiyse deneme önizlemesi (base64 PNG). */
  samplePng: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TemplateTask = z.infer<typeof TemplateTaskSchema>;

// ---------------------------------------------------------------- bağlantı denemesi

/** Anahtar denemesi: sağlayıcıya çok küçük gerçek bir istek. */
export const KeyTestResponseSchema = z.object({ ok: z.boolean(), message: z.string(), model: z.string() });
export type KeyTestResponse = z.infer<typeof KeyTestResponseSchema>;

// ---------------------------------------------------------------- tasarım dili paketi (dışa/içe aktarma)

export const LANGUAGE_PACKAGE_FORMAT = "etiket-studio-dil" as const;
export const LanguagePackageSchema = z.object({
  format: z.literal(LANGUAGE_PACKAGE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  language: z.object({ id: z.string(), name: z.string() }),
  /** Etkin (yayınlanmış) profil verisi ve sürümü. */
  profile: z.unknown(),
  profileVersion: z.number().nullable(),
  /** Varsa taslak profil verisi. */
  draft: z.unknown().nullable().default(null),
  /** Şablon kayıtları ve PNG'leri (base64; dosya yoksa null). */
  templates: z.array(z.object({ record: z.record(z.string(), z.unknown()), png: z.string().nullable() })),
  /** Tasarım dilinin font dosyaları (base64). Ortak yedek fontlar dahil değildir. */
  fonts: z.array(z.object({ file: z.string(), data: z.string() })),
});
export type LanguagePackage = z.infer<typeof LanguagePackageSchema>;
/** İçe aktarma: paket + isteğe bağlı yeni ad/kimlik (kimlik çakışırsa sonuna sayı eklenir). */
export const LanguageImportRequestSchema = LanguagePackageSchema.extend({
  name: z.string().trim().min(1).max(80).optional(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).optional(),
});
export type LanguageImportRequest = z.input<typeof LanguageImportRequestSchema>;
export const LanguageImportResponseSchema = z.object({
  language: LanguageSchema,
  templates: z.number(),
  fonts: z.number(),
  warnings: z.array(z.string()),
});
export type LanguageImportResponse = z.infer<typeof LanguageImportResponseSchema>;

// ---------------------------------------------------------------- tasarım dili denemesi ("Dene")

export const ProfileTrySampleSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(500),
  templateKey: z.string().nullable(),
  labelSize: z.string().nullable().optional(),
  /** Varsa son hâl (referans; kullanıcının bitmiş etiketi): karşılaştırma ve `engine` modunda satırlar bundan gelir. */
  referenceId: z.string().nullable().optional(),
});
export type ProfileTrySample = z.input<typeof ProfileTrySampleSchema>;

/**
 * Örnek siparişleri yayınlanmış ve/veya taslak profille dener. Kalıcı varyasyon OLUŞTURMAZ; önizlemeler geçici
 * dosyadır (`trialPreview`, 24 saat). `mode: "ai"` gerçek tasarımcıyla (ücretli; yanıt maliyeti döner),
 * `mode: "engine"` AI'sız (referans varsa onun satırlarıyla motor tekrarı, yoksa basit deterministik niyet).
 * `dryRun: true` yalnızca tahmini maliyeti döner.
 */
export const ProfileTryRequestSchema = z.object({
  samples: z.array(ProfileTrySampleSchema).min(1).max(40),
  profiles: z.array(z.enum(["published", "draft"])).min(1).default(["published"]),
  dryRun: z.boolean().default(false),
  mode: z.enum(["ai", "engine"]).default("ai"),
  /** Hata ayıklama (yalnızca `mode: "ai"`): yanıt bütün adayları, motor puanlarını ve sıralamayı da taşır. */
  debug: z.boolean().optional(),
});
export type ProfileTryRequest = z.input<typeof ProfileTryRequestSchema>;

/** Deneme hata ayıklaması: AI'ın bütün aday niyetleri, motor sonucu ve aday seçiminin sırası/gerekçesi. */
export const ProfileTryDebugSchema = z.object({
  candidates: z.array(
    z.object({
      lines: z.array(z.string()),
      fonts: z.array(z.string()),
      tiers: z.array(z.string()),
      rationale: z.string(),
      /** Motor yerleştirebildi mi (yerleşmeyen ya da öncekiyle aynı aday sıralamaya girmez). */
      placed: z.boolean(),
      /** Motor puanı (yerleştiyse). */
      score: z.number().nullable(),
      sizesPx: z.array(z.number()),
      /** Neden elendi (yerleşmedi / öncekiyle aynı). */
      note: z.string().optional(),
    }),
  ),
  /** Aday dizinleri (`candidates`), en iyisi başta; yalnızca yerleşenler. */
  ranking: z.array(z.number()),
  /** Aday dizinine göre sıralama gerekçesi (yoksa boş). */
  reasons: z.array(z.string()),
  rankSummary: z.string(),
  /** Seçilen aday dizini. */
  chosen: z.number(),
});
export type ProfileTryDebug = z.infer<typeof ProfileTryDebugSchema>;

export const ProfileTrySideSchema = z.object({
  previewUrl: z.string(),
  lines: z.array(z.string()),
  /** Satır puntoları (tasarım alanı px). */
  sizesPx: z.array(z.number()),
  /** Hata + uyarı sayısı (bilgi notları hariç). */
  issues: z.number(),
  issueList: z.array(IssueSchema),
  costUsd: z.number().nullable(),
  /** Referans verildiyse: satır bölmesi aynı mı, en büyük satır boyut farkı (oran, 0.1 = %10). */
  sameBreaksAsReference: z.boolean().nullable(),
  sizeDiffVsReference: z.number().nullable(),
  /** Yalnızca `debug: true` istendiyse. */
  debug: ProfileTryDebugSchema.optional(),
});
export type ProfileTrySide = z.infer<typeof ProfileTrySideSchema>;
export const ProfileTryResultSchema = z.object({
  sampleId: z.string(),
  published: ProfileTrySideSchema.nullable(),
  draft: ProfileTrySideSchema.nullable(),
  error: z.string().nullable().optional(),
});
export type ProfileTryResult = z.infer<typeof ProfileTryResultSchema>;
export const ProfileTryResponseSchema = z.object({
  /** Tahmini maliyet (USD); engine modunda 0. */
  estimateUsd: z.number().nullable(),
  /** Gerçekleşen maliyet (dryRun'da 0). */
  costUsd: z.number(),
  mode: z.enum(["ai", "engine"]),
  results: z.array(ProfileTryResultSchema),
});
export type ProfileTryResponse = z.infer<typeof ProfileTryResponseSchema>;

// ---------------------------------------------------------------- SSE olayları

/** `GET /api/events` (text/event-stream). Her mesajın `data` alanı bir `ServerEvent` JSON'udur. */
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job"), jobId: z.string(), status: JobStatusSchema.optional() }),
  z.object({ type: z.literal("jobs"), batchId: z.string().nullable() }),
  z.object({ type: z.literal("batch"), batchId: z.string() }),
  z.object({ type: z.literal("variant"), jobId: z.string(), variantId: z.string() }),
  z.object({ type: z.literal("progress"), step: ProgressStepSchema }),
  z.object({ type: z.literal("queue"), status: QueueStatusSchema }),
  z.object({ type: z.literal("template"), languageId: z.string(), key: z.string() }),
  z.object({ type: z.literal("profile"), languageId: z.string(), version: z.number() }),
  z.object({ type: z.literal("language"), languageId: z.string() }),
  z.object({ type: z.literal("settings") }),
  z.object({ type: z.literal("reference"), languageId: z.string() }),
  /** Tasarım dili oturumu değişti (soru/cevap/taslak/deneme). */
  z.object({ type: z.literal("session"), languageId: z.string() }),
  /** Öğrenme koşusu ilerlemesi. */
  z.object({
    type: z.literal("learn"),
    languageId: z.string(),
    runId: z.string(),
    status: z.enum(["running", "done", "failed", "cancelled", "interrupted"]),
    step: z.string(),
    done: z.number(),
    total: z.number(),
  }),
  /** Oluşturucu oturumunun durumu değişti (`BuildBusEventSchema`, builder.ts). */
  BuildBusEventSchema,
  /** Baskı masası: şablon/ön ayar/oturum değişti (sessionId null = şablon ya da ön ayar). */
  z.object({ type: z.literal("print"), languageId: z.string(), sessionId: z.string().nullable() }),
  /** Baskı çıktısı (PDF/PNG) ilerlemesi. */
  z.object({
    type: z.literal("printExport"),
    exportId: z.string(),
    sessionId: z.string(),
    status: z.enum(["queued", "running", "done", "failed", "interrupted"]),
    done: z.number(),
    total: z.number(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ---------------------------------------------------------------- uç noktalar

/**
 * Arayüzün kullandığı uç noktalar. `:lang` = tasarım dili kimliği, `:id` = kayıt kimliği.
 * Açıklamadaki biçim: YÖNTEM gövde → yanıt.
 */
export const API = {
  /** GET → Health */
  health: "/api/health",
  /** GET → SSE akışı (ServerEvent). */
  events: "/api/events",

  /** GET → { languages: Language[] } · POST CreateLanguage → Language (v1 boş profil yayınlanmış olarak). */
  languages: "/api/languages",
  /** PATCH RenameLanguage → Language · DELETE → UndoToken (yumuşak silme). */
  language: "/api/languages/:lang",
  /** POST → Language (varsayılan dil yapar). */
  languageDefault: "/api/languages/:lang/default",

  /** GET → ProfileRecord (etkin = yayınlanmış en yüksek sürüm). */
  profile: "/api/languages/:lang/profile",
  /** GET → ProfileRecord | null · PUT SaveDraft → ProfileRecord (geçersizse 400 + fields) · DELETE → { ok } (taslağı at). */
  profileDraft: "/api/languages/:lang/profile/draft",
  /** POST Publish → ProfileRecord (taslak yayınlanır, etkin olur). */
  profilePublish: "/api/languages/:lang/profile/publish",
  /** GET → { versions: ProfileVersionSummary[] } */
  profileVersions: "/api/languages/:lang/profile/versions",
  /** GET → ProfileRecord */
  profileVersion: "/api/languages/:lang/profile/versions/:version",
  /** GET ?from=&to= → ProfileDiff (yaprak alan farkları). */
  profileDiff: "/api/languages/:lang/profile/diff",
  /** POST RevertProfile → ProfileRecord (eski sürümün verisiyle YENİ yayınlanmış sürüm; geçmiş silinmez). */
  profileRevert: "/api/languages/:lang/profile/revert",
  /** GET → { docs: PROFILE_DOCS } alan açıklamaları. */
  profileDocs: "/api/profile-docs",

  /** GET → { templates: TemplateItem[] } · POST UploadTemplate → TemplateItem (var olanı önce yedekler). */
  templates: "/api/languages/:lang/templates",
  /** POST → TemplateSyncResult (klasörü tarar; dosyası kaybolan kayıt silinmez, "dosya eksik" olur). */
  templatesSync: "/api/languages/:lang/templates/sync",
  /** GET → TemplateItem · PATCH TemplatePatch → TemplateItem (derin birleştirme, alan kaybı yok). */
  template: "/api/languages/:lang/templates/:key",
  /**
   * POST TemplateCutPreviewRequest → TemplateCutPreviewResponse (kayda yazmaz): kesim kaydedilirse kaç onaylı iş yeniden
   * kontrol isteyecek. Kayıt (PATCH `template`) sonrası onaylar düşer, işlere `template-cut-changed`, taslak baskı
   * oturumlarına `plan-stale` eklenir; PATCH yanıtı değişmez.
   */
  templateCutPreview: "/api/languages/:lang/templates/:key/cut-preview",
  /** GET → PNG (şablon görseli). */
  templateImage: "/api/languages/:lang/templates/:key/image.png",
  /** GET → PNG (yazı alanı/dekor maskesi bindirmesi; templates paketi bağlı değilse 501). */
  templateOverlay: "/api/languages/:lang/templates/:key/overlay.png",
  /** POST SuggestAreaRequest → SuggestAreaResponse (kayda yazılmaz). */
  templateSuggestArea: "/api/languages/:lang/templates/:key/suggest-area",
  /** POST TemplateTryRequest → TemplateTryResponse (AI'sız deneme; patch geçici). */
  templateTry: "/api/languages/:lang/templates/:key/try",
  /** POST GenerateTemplateRequest → TemplateTask (kuyruğa alındı; ücretli görüntü üretimi). */
  templatesGenerate: "/api/languages/:lang/templates/generate",
  /** GET → TemplateTask */
  templateTask: "/api/template-tasks/:id",
  /** GET → LanguagePackage (profil + şablonlar + PNG'ler + fontlar, base64). */
  languageExport: "/api/languages/:lang/export",
  /** POST LanguageImportRequest → LanguageImportResponse (yeni dil; 100 MB'a kadar). */
  languagesImport: "/api/languages/import",
  /** POST ProfileTryRequest → ProfileTryResponse (kalıcı varyasyon üretmez). */
  profileTry: "/api/languages/:lang/profile/try",
  /** GET → PNG (deneme önizlemesi, geçici). */
  trialPreview: "/api/trials/:id/preview.png",

  /** GET → FontList · POST UploadFont → FontItem */
  fonts: "/api/languages/:lang/fonts",
  /** GET ?scope=language|shared&text= → PNG örnek (typeset bağlı değilse 501). */
  fontSpecimen: "/api/languages/:lang/fonts/:file/specimen.png",

  /** GET → SettingsView · PATCH SettingsPatch → SettingsView */
  settings: "/api/settings",
  /** PUT SetApiKey → ApiKeyStatus · DELETE → ApiKeyStatus (`:provider` = anthropic | gemini). */
  settingsKey: "/api/settings/keys/:provider",
  /** POST → KeyTestResponse (sağlayıcıya çok küçük gerçek istek). */
  settingsKeyTest: "/api/settings/keys/:provider/test",

  /** POST ImportPreviewRequest → ImportPreviewResponse (hiçbir şey kaydedilmez). */
  importPreview: "/api/import/preview",
  /** POST ImportValidateRequest → ImportValidateResponse (düzenlenen satırları hızlıca yeniden doğrular). */
  importValidate: "/api/import/validate",
  /** POST ImportCommitRequest → ImportCommitResponse (parti + işler; istenirse üretim kuyruğu). */
  importCommit: "/api/import/commit",

  /** GET ?JobListQuery → JobListResponse (tek sorguda; sayfalama yok). */
  jobs: "/api/jobs",
  /** POST ManualJob → JobDetail */
  jobsManual: "/api/jobs/manual",
  /** POST BulkJobPatch → { jobs: JobDetail[] } */
  jobsBulk: "/api/jobs/bulk",
  /** POST Ids → UndoToken (çoklu yumuşak silme). */
  jobsDelete: "/api/jobs/delete",
  /** POST Ids → ApproveBestResponse (AI sırası + puan; kontrol işaretli varyasyon seçilmez). */
  jobsApproveBest: "/api/jobs/approve-best",
  /** GET → JobDetail · PATCH JobPatch → JobDetail · DELETE → UndoToken */
  job: "/api/jobs/:id",
  /** POST Approve → JobDetail (variantId null = onayı kaldır). */
  jobApprove: "/api/jobs/:id/approve",
  /** GET → JobLog (adım günlüğü + AI çağrı özetleri). */
  jobLog: "/api/jobs/:id/log",
  /** GET → AiCallSummary & { response: string|null } (ham yanıt; tam istem saklanmaz). */
  aiCall: "/api/ai-calls/:id",

  /** GET ?languageId= → { batches: BatchSummary[] } (en yeni üstte). */
  batches: "/api/batches",
  /** PATCH RenameBatch → BatchSummary · DELETE → UndoToken (partideki işlerle birlikte). */
  batch: "/api/batches/:id",

  /** GET → VariantDetail · PATCH VariantPatch → VariantDetail · DELETE → UndoToken */
  variant: "/api/variants/:id",
  /** GET → PNG önizleme. */
  variantPreview: "/api/variants/:id/preview.png",
  /** GET → PNG (görüntü modunda ayrılmış saydam yazı katmanı). */
  variantTextLayer: "/api/variants/:id/text-layer.png",
  /** POST ReviseRequest → GenerateResponse ("şunu değiştir": yeni varyasyon, kaynak kalır). */
  variantRevise: "/api/variants/:id/revise",
  /** GET → VariantEditModel (hafif düzeltme katmanı için şablon, kesim, alan, hedefler, mürekkep kutuları). */
  variantEdit: "/api/variants/:id/edit",
  /** GET → SVG (yalnızca yazı, saydam, düzeltmesiz; tasarım alanı viewBox'ı). */
  variantEditText: "/api/variants/:id/edit/text.svg",
  /** POST VariantAdjustRequest → AdjustCheckResponse (kaydetmez; sürükleme bırakılınca). */
  variantAdjustCheck: "/api/variants/:id/adjust/check",
  /** POST AdjustRelayoutRequest → AdjustRelayoutResponse (elle metin/font düzenlemesini motorla ölçer; kaydetmez). */
  variantEditRelayout: "/api/variants/:id/edit/relayout",
  /** PUT VariantAdjustRequest → AdjustSaveResponse · DELETE → AdjustSaveResponse (düzeltmeyi kaldır). İkisi de geri alınabilir. */
  variantAdjust: "/api/variants/:id/adjust",

  /** POST GenerateRequest → GenerateResponse */
  generate: "/api/generate",
  /** POST CancelGeneration → { cancelled: number } (bekleyenler; jobIds yoksa hepsi). */
  generateCancel: "/api/generate/cancel",
  /** GET → QueueStatus */
  generateStatus: "/api/generate/status",

  /** POST { token } — `POST /api/undo/:token` → UndoResult (süresi dolmuşsa 410). */
  undo: "/api/undo/:token",

  /** GET ?languageId=&split= → { references: Reference[] } · POST ReferenceInput → Reference */
  references: "/api/references",
  /** GET → Reference · PATCH ReferencePatch → Reference · DELETE → { ok } */
  reference: "/api/references/:id",
  /** GET → PNG (referansın kullanıcı yazı katmanı görseli; `Reference.image` yoksa 404). */
  referenceImage: "/api/references/:id/image.png",
  /** GET ?languageId=&status= → { proposals: LearnProposal[] } · POST LearnProposalInput → LearnProposal */
  learnProposals: "/api/learn/proposals",
  /** GET → LearnProposal · PATCH LearnProposalPatch → LearnProposal · DELETE → { ok } */
  learnProposal: "/api/learn/proposals/:id",
  /** POST LearnRunRequest → 202 LearnRunStatus (arka planda; SSE "learn") · GET → LearnRunStatus | null (son koşu) · DELETE → durdur. */
  learnRun: "/api/languages/:lang/learn/run",
  /** POST → LearnApplyResult (profil değişiklikleri taslağa, şablon değişiklikleri kayda; öneri "accepted"). */
  learnApply: "/api/learn/proposals/:id/apply",
  /** POST → LearnProposal ("rejected"). */
  learnReject: "/api/learn/proposals/:id/reject",
  /** POST → LearnApplyResult (uygulananı geri alır; öneri yeniden "open"). */
  learnRevert: "/api/learn/proposals/:id/revert",
  /** GET ?source=published|draft → { source, profileVersion, measurement } (referanslardan ölçülmüş tarz özeti). */
  learnMeasure: "/api/languages/:lang/learn/measure",
  /** GET ?limit=&template=&split=&w= → { total, samples } (referanslar: müşteri metni, kullanıcının satırları, görsel adresi). */
  learnSamples: "/api/languages/:lang/learn/samples",
  /** POST LearnReplayRequest → motor denemesi (AI'sız): profil başına ölçüler + önizleme adresleri. */
  learnReplay: "/api/languages/:lang/learn/replay",
  /** GET → PNG (öğrenme / motor denemesi önizlemesi). */
  learnPreview: "/api/learn/previews/:dir/:file",
  /** GET ?w=&template=1 → PNG (referans görseli; template=1: şablon + kullanıcının yazısı, w: küçültülmüş). */
  learnReferenceThumb: "/api/learn/references/:id/thumb.png",
  /** GET ?w= → PNG (şablonun küçük görseli). */
  learnTemplateThumb: "/api/languages/:lang/learn/templates/:key/thumb.png",
  /** GET → DesignSession (son oturum) · POST DesignSessionStart → DesignSession (yeni oturum). */
  designSession: "/api/languages/:lang/design-session",
  /** POST DesignSessionEntryInput → DesignSessionEntry (oturum yoksa açılır). */
  designSessionEntries: "/api/languages/:lang/design-session/entries",
  /** POST DesignDraftWrite → DesignDraftWriteResult (taslağa yama; geçersizse 400 + fields; oturuma "draft-write" düşer). */
  designSessionDraft: "/api/languages/:lang/design-session/draft",

  /** GET ?languageId= → CostSummary */
  costs: "/api/costs",
} as const;

/** `:param` yer tutucularını doldurur (değerler URL kodlanır). */
export function apiPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/:([a-zA-Z]+)/g, (m, k: string) => (k in params ? encodeURIComponent(String(params[k])) : m));
}

