import { z } from "zod";
import { ApiErrorSchema, OkSchema, ProfileTryResponseSchema } from "./api.ts";
import {
  BUILDER_FEATURE,
  BUILDER_SAMPLE_LIMITS,
  BUILD_LABEL_TYPES,
  BUILD_MESSAGE_KINDS,
  BUILD_STATES,
  BuildAnswerInputSchema,
  BuildEntrySchema,
  BuildErrorSchema,
  BuildLabelTypeSchema,
  BuildSchema,
  BuildStateSchema,
  KeySourceSchema,
  RevisionReasonSchema,
  RevisionSummarySchema,
  RuleChangeSchema,
  SampleSchema,
  type BuildState,
} from "./builder.ts";
import { BUILDER_TOOL_NAMES } from "./builder-tools.ts";
import { MessageParamsSchema } from "./messages.ts";
import { ProfileRecordSchema, ProfileSchema } from "./profile.ts";

/**
 * Oluşturucu uçları (`BUILDER_API`), istek/yanıt gövdeleri, hata gövdeleri ve oturum akışı (SSE) olayları.
 * Genel kurallar `api.ts` ile aynıdır (`X-Studio: 1`, `ApiError`, ISO tarih). Yol doldurma `apiPath`.
 * Durum dışı çağrı 409 `build-state` (gövdede `state`); çalışan tur varken tur başlatan çağrı 409 `build-busy`.
 */

// ================================================================ ortak

const IdParams = z.object({ id: z.string().min(1) });
const LangParams = z.object({ lang: z.string().min(1) });
const SampleParams = IdParams.extend({ sid: z.string().min(1) });
const RevParams = IdParams.extend({ rev: z.coerce.number().int().nonnegative() });
const ShowcaseImageParams = RevParams.extend({ item: z.string().min(1) });

/** Örnek etiketlerin metin dili (önceden hazır örnek metinler bu dilde seçilir). */
export const ShowcaseLocaleSchema = z.enum(["tr", "en"]);

// ================================================================ maliyet

export const BuildEstimateRequestSchema = z.strictObject({
  languageId: z.string().min(1),
  /** Yüklenecek örnek sayısı (0 = örneksiz). */
  samples: z.number().int().min(0).max(BUILDER_SAMPLE_LIMITS.maxFiles),
});
export type BuildEstimateRequest = z.input<typeof BuildEstimateRequestSchema>;

/** Başlamadan tahmin (ücretsiz; önek `count_tokens` ile sayılır). `keySource` null = anahtar yok. */
export const BuildEstimateSchema = z.object({
  lowUsd: z.number().nonnegative(),
  highUsd: z.number().nonnegative(),
  sessionCapUsd: z.number().positive(),
  monthUsd: z.number().nonnegative(),
  monthLimitUsd: z.number().positive(),
  /** Aylık harcama sınırın `warnRatio` oranını geçti. */
  monthWarn: z.boolean(),
  keySource: KeySourceSchema.nullable(),
});
export type BuildEstimate = z.infer<typeof BuildEstimateSchema>;

/** 409 `budget-exceeded`: tur başlamadı. `scope: "session"` ve `canRaise` ise `raiseBudget` bir kez artırır. */
export const BudgetExceededErrorSchema = ApiErrorSchema.extend({
  code: z.literal("budget-exceeded"),
  scope: z.enum(["session", "month"]),
  usedUsd: z.number().nonnegative(),
  limitUsd: z.number().positive(),
  /** Başlatılmak istenen işin tahmini. */
  estimateUsd: z.number().nonnegative(),
  canRaise: z.boolean(),
  buildId: z.string().optional(),
});
export type BudgetExceededError = z.infer<typeof BudgetExceededErrorSchema>;

/** 409 `missing-key`: oturum ya da tur başlamadı (bugünkü biçim + anahtar kaynağı). */
export const MissingKeyErrorSchema = ApiErrorSchema.extend({
  code: z.literal("missing-key"),
  provider: z.literal("anthropic"),
  keySource: KeySourceSchema,
});
export type MissingKeyError = z.infer<typeof MissingKeyErrorSchema>;

/** 409 `build-active`: dilde etkin oturum var. */
export const BuildActiveErrorSchema = ApiErrorSchema.extend({ code: z.literal("build-active"), buildId: z.string() });
/** 409 `build-state`: uç bu durumda çağrılamaz. */
export const BuildStateErrorSchema = ApiErrorSchema.extend({ code: z.literal("build-state"), state: BuildStateSchema });

/**
 * Oluşturucunun HTTP hata kodları (`ApiError.code`). `ERROR_MESSAGES`'a eklenmeleri gerekir; `missing-key`, `not-found`
 * ve `feature-off` zaten var.
 */
export const BUILDER_HTTP_ERROR_CODES = {
  "build-active": 409,
  "build-state": 409,
  "build-busy": 409,
  "build-no-revision": 409,
  "budget-exceeded": 409,
  "budget-raise-used": 409,
  /** Yayında: oturum sürerken dilin başka bir sürümü yayınlandı ya da taslak dışarıdan değişti (`overwrite` ile geçilir). */
  "build-base-changed": 409,
  "sample-limit": 409,
  "sample-too-large": 413,
  "sample-type": 415,
  "question-unknown": 400,
  "message-kind": 409,
} as const;
export type BuilderHttpErrorCode = keyof typeof BUILDER_HTTP_ERROR_CODES;

// ================================================================ oturum

export const BuildCreateSchema = z.strictObject({
  base: z.enum(["published", "default"]),
  fromSetup: z.boolean().optional(),
  /** Kurulumun ya da girişin etiket türleri; verilir ve `fromSetup` ise durum doğrudan `samples`. */
  labelTypes: z.array(BuildLabelTypeSchema).max(BUILD_LABEL_TYPES.length).optional(),
});
export type BuildCreate = z.input<typeof BuildCreateSchema>;

export const BuildIntakeSchema = z.strictObject({ labelTypes: z.array(BuildLabelTypeSchema).min(1).max(BUILD_LABEL_TYPES.length) });
export type BuildIntake = z.input<typeof BuildIntakeSchema>;

export const BuildMessagesQuerySchema = z.object({
  /** Bu kimlikten SONRAKİ girdiler (0 = baştan). */
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const BuildMessagesResponseSchema = z.object({ entries: z.array(BuildEntrySchema) });
export type BuildMessagesResponse = z.infer<typeof BuildMessagesResponseSchema>;

/**
 * Kullanıcı iletisi. Durum başına izinli türler `BUILD_MESSAGE_KINDS_BY_STATE`; dışı 409 `message-kind`.
 * - `answer`: `answers` (her bekleyen soru için en çok bir) ve/veya `text`.
 * - `correction`: `text` zorunlu.
 * - `note`: `text` zorunlu; tur başlatmaz (200, `turn: null`).
 */
export const BuildMessageSchema = z
  .strictObject({
    kind: z.enum(BUILD_MESSAGE_KINDS),
    text: z.string().trim().min(1).max(4000).optional(),
    answers: z.array(BuildAnswerInputSchema).min(1).max(20).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.kind !== "answer" && m.answers) ctx.addIssue({ code: "custom", path: ["answers"], message: "Cevaplar yalnız cevap iletisinde." });
    if (m.kind === "answer" && !m.answers && !m.text) ctx.addIssue({ code: "custom", path: ["answers"], message: "Cevap ya da metin gerekli." });
    if (m.kind !== "answer" && !m.text) ctx.addIssue({ code: "custom", path: ["text"], message: "Metin gerekli." });
    const ids = (m.answers ?? []).map((a) => a.questionId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["answers"], message: "Bir soruya bir cevap." });
  });
export type BuildMessage = z.input<typeof BuildMessageSchema>;

/** 202 (tur başladı) ya da 200 (not). `entries`: bu iletiyle yazılan girdiler (cevap başına bir girdi). */
export const BuildMessageResponseSchema = z.object({
  turn: z.object({ seq: z.number().int().nonnegative() }).nullable(),
  entries: z.array(BuildEntrySchema),
});
export type BuildMessageResponse = z.infer<typeof BuildMessageResponseSchema>;

// ================================================================ örnekler

/** Yükleme: dosyalar base64 (data: öneki yok). Toplam gövde `maxRequestBytes`; oturumda en çok `maxFiles`. */
export const SampleUploadSchema = z.strictObject({
  files: z
    .array(z.strictObject({ name: z.string().trim().min(1).max(200), dataBase64: z.string().min(1) }))
    .min(1)
    .max(BUILDER_SAMPLE_LIMITS.maxFiles),
  /** Hepsi aynı şablondansa. */
  templateKey: z.string().min(1).optional(),
});
export type SampleUpload = z.input<typeof SampleUploadSchema>;

/** Kabul edilenler `samples`'ta (`uploaded`); reddedilenler adıyla ve koduyla (`sample-type`, `sample-too-large`, `sample-limit`, `sample-unreadable`). */
export const SampleUploadResponseSchema = z.object({
  samples: z.array(SampleSchema),
  rejected: z.array(z.object({ name: z.string(), code: z.string(), params: MessageParamsSchema.optional() })),
});
export type SampleUploadResponse = z.infer<typeof SampleUploadResponseSchema>;

/**
 * Kullanıcı düzeltmesi (cevap sayılır: akışa `sample-edit` girdisi düşer, kanıt olarak gösterilebilir).
 * `lines` verilirse satır metinleri ve fontları sırayla değişir; sayı mürekkep satırlarından farklıysa örnek `approx`.
 * `templateKey` değişince örnek yeniden ölçülmek üzere `uploaded` olur (`analyze` gerekir).
 */
export const SamplePatchSchema = z
  .strictObject({
    templateKey: z.string().min(1).nullable(),
    lines: z.array(z.strictObject({ text: z.string().max(500), fontFile: z.string().min(1).nullable().optional() })).max(40),
    fontFile: z.string().min(1).nullable(),
    exclude: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "En az bir alan gerekli." });
export type SamplePatch = z.input<typeof SamplePatchSchema>;

// ================================================================ revizyonlar, örnek etiketler, deneme, kalite

export const RevisionListResponseSchema = z.object({ revisions: z.array(RevisionSummarySchema) });
export type RevisionListResponse = z.infer<typeof RevisionListResponseSchema>;

/** Revizyon: tam profil + bir önceki revizyona göre değişen kurallar (revizyon 0'da boş). */
export const RevisionDetailSchema = z.object({
  rev: z.number().int().nonnegative(),
  at: z.string(),
  reason: RevisionReasonSchema.nullable(),
  summary: z.string(),
  profile: ProfileSchema,
  changes: z.array(RuleChangeSchema),
});
export type RevisionDetail = z.infer<typeof RevisionDetailSchema>;

export const RevisionDiffQuerySchema = z.object({ from: z.coerce.number().int().nonnegative(), to: z.coerce.number().int().nonnegative() });
export const RevisionDiffSchema = z.object({ from: z.number().int(), to: z.number().int(), changes: z.array(RuleChangeSchema) });
export type RevisionDiff = z.infer<typeof RevisionDiffSchema>;

export const RestoreSchema = z.strictObject({ rev: z.number().int().nonnegative() });

/** Not parçası: "Tarih küçüldü" = `{ label: "sizing.tiers.tertiary", direction: "down" }`; cümleyi arayüz kurar. */
export const ShowcaseNoteSchema = z.object({ label: z.string(), direction: z.enum(["up", "down", "changed"]) });

/**
 * Örnek etiket (ücretsiz motor). Başlık arayüzde: `labelType` varsa türün adı, yoksa örneğin adı (`sampleId`).
 * - `source`: `sample` yüklenen örneğin satırlarıyla (`referenceToIntent`), `reference` firmanın referansı, `preset`
 *   türe göre hazır örnek metin (deterministik niyet).
 * - `changed`: önceki revizyona göre yerleşim imzası değişti; `note` değişen kurallardan (boşsa not yok).
 * - `text` müşteri metni / örnek metindir (içerik; çevrilmez).
 */
export const ShowcaseItemSchema = z.object({
  id: z.string(),
  labelType: BuildLabelTypeSchema.nullable(),
  sampleId: z.string().nullable(),
  text: z.string(),
  templateKey: z.string().nullable(),
  /** Etiket boyutu kimliği ("3.8"). */
  size: z.string().nullable(),
  /** Gösterim için ölçü (mm) ve kesim; "Ø 38 mm", "63,5 × 38,1 mm". */
  sizeMm: z.object({ shape: z.enum(["circle", "ellipse", "rect"]), w: z.number().positive(), h: z.number().positive() }).nullable(),
  previewUrl: z.string(),
  changed: z.boolean(),
  note: z.array(ShowcaseNoteSchema),
  source: z.enum(["sample", "reference", "preset"]),
  /** Yerleşemedi: önizleme yok, kod + parametre. */
  error: z.object({ code: z.string(), params: MessageParamsSchema.optional() }).nullable(),
});
export type ShowcaseItem = z.infer<typeof ShowcaseItemSchema>;

export const ShowcaseQuerySchema = z.object({ locale: ShowcaseLocaleSchema.default("tr") });
export const ShowcaseResponseSchema = z.object({ items: z.array(ShowcaseItemSchema) });
export type ShowcaseResponse = z.infer<typeof ShowcaseResponseSchema>;

/** Dilin özeti ve kurulumdaki "Varsayılanla başla" (oturumsuz). */
export const LanguageShowcaseRequestSchema = z.strictObject({ source: z.enum(["published", "draft"]), locale: ShowcaseLocaleSchema.optional() });

/**
 * Kendi metniyle deneme. `mode: "engine"` ücretsiz. `mode: "ai"` (Haiku): `confirm` yoksa yalnız tahmin döner
 * (`estimateUsd`, `costUsd: 0`, sonuç yok); `confirm: true` çalıştırır. `rev` yoksa son revizyon.
 */
export const BuildTryRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  templateKey: z.string().min(1).optional(),
  size: z.string().min(1).optional(),
  rev: z.number().int().nonnegative().optional(),
  mode: z.enum(["engine", "ai"]),
  confirm: z.boolean().optional(),
});
export type BuildTryRequest = z.input<typeof BuildTryRequestSchema>;

/**
 * Kalite kartı (revizyon başına). `test`: ayrılmış kümede ücretsiz motor denemesi; küme yoksa null ve `testReason`.
 * `ai`: isteğe bağlı Haiku denemesi (`qualityAi`); yapılmadıysa null. `invariants` her revizyonda sıfır olmalıdır.
 */
export const BuildQualitySchema = z.object({
  rev: z.number().int().nonnegative(),
  test: z
    .object({
      n: z.number().int().nonnegative(),
      /** Yerleşemeyen örnek sayısı. */
      failed: z.number().int().nonnegative(),
      /** En büyük satırı ±%10 içinde olan örnek sayısı. */
      within10: z.number().int().nonnegative(),
      /** Blok merkezi uzaklığı ortancası (px). */
      positionPx: z.number().nullable(),
      /** Görünen boşluk farkı ortancası (|motor − kullanıcı|, em). */
      gaps: z.object({ normal: z.number().nullable(), beforeLast: z.number().nullable(), connector: z.number().nullable() }),
    })
    .nullable(),
  /** Test örneklerinin hiçbiri motorla yeniden çizilemiyorsa (şablon yok, ölçüm kesin değil) `test: null`, `testReason: "not-replayable"`. */
  testReason: z.enum(["too-few-samples", "no-measurable", "not-replayable"]).nullable(),
  ai: z
    .object({
      n: z.number().int().nonnegative(),
      /** Satır bölmesi aynı olanların oranı (0..1). */
      sameBreaks: z.number().min(0).max(1),
      /** En büyük satır boyut farkı ortancası (oran, 0.1 = %10). */
      sizeDiff: z.number().nullable(),
      costUsd: z.number().nonnegative(),
      at: z.string(),
    })
    .nullable(),
  invariants: z.object({
    unsupportedValues: z.number().int().nonnegative(),
    textChanged: z.number().int().nonnegative(),
    outsideSchema: z.number().int().nonnegative(),
  }),
});
export type BuildQuality = z.infer<typeof BuildQualitySchema>;

export const BuildQualityQuerySchema = z.object({ rev: z.coerce.number().int().nonnegative().optional() });
/** AI kalite denemesi: `confirm` yoksa yalnız tahmin (`{ estimateUsd }`), `confirm: true` çalıştırır. */
export const BuildQualityAiRequestSchema = z.strictObject({ rev: z.number().int().nonnegative().optional(), confirm: z.boolean().optional() });
export const BuildQualityAiResponseSchema = z.object({ estimateUsd: z.number().nonnegative(), quality: BuildQualitySchema.nullable() });

/**
 * Yayın gövdesi. `overwrite: true`: oturum sürerken dilin başka bir sürümü yayınlandıysa ya da taslak bu oturumun
 * dışında değiştiyse (409 `build-base-changed`) kullanıcı onayıyla yine de oturumun son revizyonunu yayınlar.
 */
export const BuildPublishSchema = z.strictObject({ note: z.string().max(500).optional(), overwrite: z.boolean().optional() });

// ================================================================ akış (SSE)

/**
 * Oturum akışı (`GET /api/builds/:id/stream`, text/event-stream). Her ileti: `id: <bootId>:<n>`, `event: <type>`,
 * `data: <JSON>` (JSON'da `type` de vardır). Olay kimliği kuralı `BUILD_STREAM`'de.
 */
export const BUILD_STREAM = {
  /**
   * Kimlik `"<bootId>:<n>"`: `bootId` sunucu açılışının kimliği, `n` oturum başına 1'den artan sayı. `Last-Event-ID`
   * aynı açılışa aitse ve tampondaysa sonraki olaylar sırayla gönderilir; değilse önce bir `status` anlık görüntüsü
   * gelir ve arayüz `getBuild` + `listMessages?after=` ile eşitlenir.
   */
  replayBuffer: 500,
  heartbeatMs: 15_000,
} as const;

export function formatBuildEventId(bootId: string, n: number): string {
  return `${bootId}:${n}`;
}
export function parseBuildEventId(id: string | null | undefined): { bootId: string; n: number } | null {
  const m = /^([A-Za-z0-9_-]{1,64}):(\d{1,15})$/.exec(id ?? "");
  return m ? { bootId: m[1]!, n: Number(m[2]) } : null;
}

/** `step` adımları: modelin araçları + sunucunun kendi adımları. */
export const BUILD_STEP_NAMES = [...BUILDER_TOOL_NAMES, "transcribe", "measure", "showcase", "retry-wait"] as const;

/** `budget`: kalan pay (oturum ya da aylık sınır) tur içinde doldu; yeni model isteği gönderilmedi (bildirim `budget-stopped`). */
export const BUILD_STOP_REASONS = ["end_turn", "ask_user", "cancelled", "failed", "max_steps", "proposal_failed", "budget", "analysis"] as const;

export const BuildStreamEventSchema = z.discriminatedUnion("type", [
  /** Durum değişti (ve bağlanınca ilk olay). */
  z.object({ type: z.literal("status"), state: BuildStateSchema, resumeState: BuildStateSchema.nullable(), running: z.boolean(), lastEntryId: z.number().int().nonnegative() }),
  /** Modelin metin parçası (tur bitince `text` girdisi olarak kaydedilir). `index` içerik bloğunun sırası. */
  z.object({ type: z.literal("text"), turnSeq: z.number().int().nonnegative(), index: z.number().int().nonnegative(), delta: z.string() }),
  /** Araç ya da sunucu adımı başladı / bitti. */
  z.object({
    type: z.literal("step"),
    turnSeq: z.number().int().nonnegative().nullable(),
    step: z.enum(BUILD_STEP_NAMES),
    phase: z.enum(["start", "end"]),
    ok: z.boolean().optional(),
    sampleId: z.string().optional(),
    attempt: z.number().int().positive().optional(),
    waitMs: z.number().int().nonnegative().optional(),
  }),
  /** Soru girdisi yazıldı (her soru için bir olay). */
  z.object({ type: z.literal("question"), entry: BuildEntrySchema }),
  /** Yeni revizyon yazıldı. */
  z.object({ type: z.literal("revision"), rev: z.number().int().positive(), reason: RevisionReasonSchema, changeCount: z.number().int().nonnegative(), summary: z.string(), entryId: z.number().int().positive() }),
  /** Harcama güncellendi (tur içinde ve sonunda). */
  z.object({
    type: z.literal("cost"),
    costUsd: z.number().nonnegative(),
    turnUsd: z.number().nonnegative(),
    budgetUsd: z.number().positive(),
    monthUsd: z.number().nonnegative(),
    monthLimitUsd: z.number().positive(),
  }),
  z.object({ type: z.literal("error"), error: BuildErrorSchema }),
  /** Tur ya da ölçüm bitti; girdiler artık `listMessages`'ta. Ölçümde `turnSeq` null, `stopReason: "analysis"`. */
  z.object({ type: z.literal("done"), turnSeq: z.number().int().nonnegative().nullable(), state: BuildStateSchema, stopReason: z.enum(BUILD_STOP_REASONS) }),
]);
export type BuildStreamEvent = z.infer<typeof BuildStreamEventSchema>;
export const BUILD_STREAM_EVENT_TYPES = ["status", "text", "step", "question", "revision", "cost", "error", "done"] as const;

// ================================================================ uçlar

export type BuilderAccess = "read" | "write" | "spend";
export type BuilderHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface BuilderRouteDef {
  method: BuilderHttpMethod;
  path: `/api/${string}`;
  /** `read` özellik kapalıyken de açık; `write` ve `spend` kapalıyken 409 `feature-off`. `spend` bütçe denetiminden geçer. */
  access: BuilderAccess;
  feature: typeof BUILDER_FEATURE;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** `json`: `response` şeması; `sse`: `BuildStreamEventSchema` olayları; `png`: image/png. */
  kind: "json" | "sse" | "png";
  response: z.ZodType | null;
  /** Başarı kodu. */
  status: 200 | 201 | 202;
  /** Çağrılabildiği oturum durumları; null = her durumda (oturumsuz uçlarda da null). */
  states: readonly BuildState[] | null;
  /** Bu uca özgü hata kodları (`ApiError.code`; `not-found`, `feature-off`, doğrulama hatası her uçta olabilir). */
  errors: readonly string[];
}

const ALL_ACTIVE = BUILD_STATES.filter((s) => s !== "published" && s !== "closed");
const NO_TURN = ["build-busy"] as const;
const SPEND_ERRORS = ["budget-exceeded", "missing-key", "build-busy"] as const;

const route = <T extends Omit<BuilderRouteDef, "feature" | "status" | "states" | "errors"> & Partial<Pick<BuilderRouteDef, "status" | "states" | "errors">>>(r: T) =>
  ({ feature: BUILDER_FEATURE, status: 200, states: null, errors: [], ...r }) as T & BuilderRouteDef;

/**
 * Oluşturucu uçları. Hepsi `language.builder` özelliğine bağlıdır. Sunucunun uç tablosu (`features/route-map.ts`)
 * `METOT yol → { feature, access }` satırlarını buradan üretebilir.
 */
export const BUILDER_API = {
  /** Başlamadan tahmin (ücretsiz). */
  estimate: route({ method: "POST", path: "/api/builds/estimate", access: "read", kind: "json", body: BuildEstimateRequestSchema, response: BuildEstimateSchema }),
  /** Oturum aç. Anahtar yoksa 409 `missing-key`; etkin oturum varsa 409 `build-active`. */
  createBuild: route({
    method: "POST",
    path: "/api/languages/:lang/builds",
    access: "write",
    kind: "json",
    params: LangParams,
    body: BuildCreateSchema,
    response: BuildSchema,
    status: 201,
    errors: ["missing-key", "build-active"],
  }),
  /** Dilin etkin oturumu (yoksa null). */
  currentBuild: route({ method: "GET", path: "/api/languages/:lang/builds/current", access: "read", kind: "json", params: LangParams, response: BuildSchema.nullable() }),
  getBuild: route({ method: "GET", path: "/api/builds/:id", access: "read", kind: "json", params: IdParams, response: BuildSchema }),
  /** Soldaki akış. */
  listMessages: route({ method: "GET", path: "/api/builds/:id/messages", access: "read", kind: "json", params: IdParams, query: BuildMessagesQuerySchema, response: BuildMessagesResponseSchema }),
  /** Cevap, düzeltme ya da not. Tur başlarsa 202, notta 200. */
  postMessage: route({
    method: "POST",
    path: "/api/builds/:id/messages",
    access: "spend",
    kind: "json",
    params: IdParams,
    body: BuildMessageSchema,
    response: BuildMessageResponseSchema,
    status: 202,
    states: ["intake", "samples", "review", "awaiting-user"],
    errors: [...SPEND_ERRORS, "message-kind", "question-unknown"],
  }),
  /** Giriş: etiket türleri → `samples`. `samples`'ta türleri değiştirir. */
  putIntake: route({ method: "PUT", path: "/api/builds/:id/intake", access: "write", kind: "json", params: IdParams, body: BuildIntakeSchema, response: BuildSchema, states: ["intake", "samples"] }),
  uploadSamples: route({
    method: "POST",
    path: "/api/builds/:id/samples",
    access: "write",
    kind: "json",
    params: IdParams,
    body: SampleUploadSchema,
    response: SampleUploadResponseSchema,
    states: ["intake", "samples", "review", "awaiting-user"],
    errors: ["sample-limit", "sample-too-large", ...NO_TURN],
  }),
  patchSample: route({
    method: "PATCH",
    path: "/api/builds/:id/samples/:sid",
    access: "write",
    kind: "json",
    params: SampleParams,
    body: SamplePatchSchema,
    response: SampleSchema,
    states: ["samples", "review", "awaiting-user"],
    errors: NO_TURN,
  }),
  deleteSample: route({
    method: "DELETE",
    path: "/api/builds/:id/samples/:sid",
    access: "write",
    kind: "json",
    params: SampleParams,
    response: OkSchema,
    states: ["samples", "review", "awaiting-user"],
    errors: NO_TURN,
  }),
  sampleImage: route({ method: "GET", path: "/api/builds/:id/samples/:sid/image.png", access: "read", kind: "png", params: SampleParams, query: z.object({ w: z.coerce.number().int().min(32).max(2000).optional() }), response: null }),
  /** "Örneğim yok": ölçümsüz ilk tur (202). */
  skipSamples: route({ method: "POST", path: "/api/builds/:id/skip-samples", access: "spend", kind: "json", params: IdParams, response: BuildSchema, status: 202, states: ["intake", "samples"], errors: SPEND_ERRORS }),
  /** Ölçüm (ücretsiz ölçüm + Haiku okuma); ilk ölçümden sonra model turu kendiliğinden başlar. */
  analyze: route({ method: "POST", path: "/api/builds/:id/analyze", access: "spend", kind: "json", params: IdParams, response: BuildSchema, status: 202, states: ["samples", "review"], errors: SPEND_ERRORS }),
  /** Çalışan ölçümü ya da turu keser; harcanan tutar yazılır. */
  cancel: route({ method: "POST", path: "/api/builds/:id/cancel", access: "write", kind: "json", params: IdParams, response: BuildSchema, states: ["analyzing", "drafting", "revising"] }),
  /** "Devam et": kesilen isteği yeniden gönderir. */
  resume: route({ method: "POST", path: "/api/builds/:id/resume", access: "spend", kind: "json", params: IdParams, response: BuildSchema, status: 202, states: ["interrupted", "failed"], errors: SPEND_ERRORS }),
  /** Oturum sınırını bir kez `sessionRaiseUsd` kadar artırır (kullanıcı onayı). */
  raiseBudget: route({ method: "POST", path: "/api/builds/:id/budget/raise", access: "write", kind: "json", params: IdParams, response: BuildSchema, states: ALL_ACTIVE, errors: ["budget-raise-used"] }),
  stream: route({ method: "GET", path: "/api/builds/:id/stream", access: "read", kind: "sse", params: IdParams, response: null }),
  revisions: route({ method: "GET", path: "/api/builds/:id/revisions", access: "read", kind: "json", params: IdParams, response: RevisionListResponseSchema }),
  /** Revizyon 0 = taban. */
  revision: route({ method: "GET", path: "/api/builds/:id/revisions/:rev", access: "read", kind: "json", params: RevParams, response: RevisionDetailSchema }),
  diff: route({ method: "GET", path: "/api/builds/:id/diff", access: "read", kind: "json", params: IdParams, query: RevisionDiffQuerySchema, response: RevisionDiffSchema }),
  showcase: route({ method: "GET", path: "/api/builds/:id/revisions/:rev/showcase", access: "read", kind: "json", params: RevParams, query: ShowcaseQuerySchema, response: ShowcaseResponseSchema }),
  showcaseImage: route({ method: "GET", path: "/api/builds/:id/revisions/:rev/showcase/:item", access: "read", kind: "png", params: ShowcaseImageParams, response: null }),
  /** Kendi metniyle deneme (bugünkü `ProfileTryResponse`). AI kipi yalnız `confirm: true` ile harcar. */
  tryText: route({ method: "POST", path: "/api/builds/:id/try", access: "spend", kind: "json", params: IdParams, body: BuildTryRequestSchema, response: ProfileTryResponseSchema, errors: [...SPEND_ERRORS, "build-no-revision", "build-state"] }),
  /** Eski revizyonun verisiyle yeni revizyon ("Sürüm 2'ye dön"). */
  restore: route({ method: "POST", path: "/api/builds/:id/restore", access: "write", kind: "json", params: IdParams, body: RestoreSchema, response: RevisionDetailSchema, states: ["review", "awaiting-user"], errors: NO_TURN }),
  /** Son revizyonu yayınlar (`profiles.publish`; not verilmezse oturum özeti). */
  publish: route({
    method: "POST",
    path: "/api/builds/:id/publish",
    access: "write",
    kind: "json",
    params: IdParams,
    body: BuildPublishSchema,
    response: ProfileRecordSchema,
    states: ["review", "awaiting-user"],
    errors: [...NO_TURN, "build-no-revision", "build-base-changed"],
  }),
  /** Kalite kartı (motor kısmı ücretsiz, istekte hesaplanır). */
  quality: route({ method: "GET", path: "/api/builds/:id/quality", access: "read", kind: "json", params: IdParams, query: BuildQualityQuerySchema, response: BuildQualitySchema, errors: ["build-no-revision"] }),
  /** İsteğe bağlı AI kalite denemesi (Haiku; önce tahmin). */
  qualityAi: route({ method: "POST", path: "/api/builds/:id/quality/ai", access: "spend", kind: "json", params: IdParams, body: BuildQualityAiRequestSchema, response: BuildQualityAiResponseSchema, errors: [...SPEND_ERRORS, "build-no-revision", "build-state"] }),
  close: route({ method: "POST", path: "/api/builds/:id/close", access: "write", kind: "json", params: IdParams, response: BuildSchema, states: ALL_ACTIVE }),
  /** Oturumsuz örnek etiketler (Özet; kurulumda "Varsayılanla başla"). */
  languageShowcase: route({ method: "POST", path: "/api/languages/:lang/showcase", access: "read", kind: "json", params: LangParams, body: LanguageShowcaseRequestSchema, response: ShowcaseResponseSchema }),
} as const;

export type BuilderRouteName = keyof typeof BUILDER_API;

/** Uç tablosu satırları (`METOT yol`), sunucunun özellik eşlemesi için. */
export function builderRouteTable(): Array<{ key: `${BuilderHttpMethod} ${string}`; feature: typeof BUILDER_FEATURE; access: BuilderAccess }> {
  return Object.values(BUILDER_API).map((r: BuilderRouteDef) => ({ key: `${r.method} ${r.path}` as const, feature: r.feature, access: r.access }));
}
