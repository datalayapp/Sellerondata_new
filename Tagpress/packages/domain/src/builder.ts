import { z } from "zod";
import { BoxSchema } from "./geometry.ts";
import { MessageParamsSchema } from "./messages.ts";
import { PROFILE_DOCS, PROFILE_GROUPS, type ProfileGroup } from "./profile-docs.ts";

/**
 * Sitede yapay zekâ ile tasarım dili oluşturma ("Oluştur", plan C) — sözleşmenin çekirdeği: durumlar ve geçişler,
 * oturum (`Build`), soldaki akışın girdileri, sorular ve cevaplar, örnekler, revizyonlar ve değişen kurallar, örnek
 * etiketler, maliyet ve kalite kartı. Araç girdileri `builder-tools.ts`'te, uçlar ve akış olayları `builder-api.ts`'te.
 *
 * KULLANIM NOTU (arayüz ve sunucu ajanları için)
 *
 * Tipik oturum, uç ve olay sırası:
 *  1. Başlamadan: `estimate` (ücretsiz; tahmin, sınırlar, anahtar kaynağı). Anahtar yoksa `keySource: null` gelir;
 *     oturum açma isteği zaten `409 missing-key` döner.
 *  2. `createBuild` → `Build` (201). Kurulumdan gelindiyse (`fromSetup` ve tür seçimi var) durum `samples`, yoksa
 *     `intake`. `intake`'te arayüz etiket türlerini sorar → `putIntake` → `samples`. Dilde etkin oturum varsa 409
 *     `build-active` (gövdede `buildId`); arayüz önce `currentBuild` ile bakar.
 *  3. `samples`: `uploadSamples` (en çok `BUILDER_SAMPLE_LIMITS.maxFiles` dosya, istek en çok `maxRequestBytes`),
 *     gerekirse `patchSample` (şablon, satır metni, font, dışarıda bırak), `deleteSample`. "Örneğim yok":
 *     `skipSamples` → doğrudan `drafting`.
 *  4. `analyze` (202) → `analyzing`. Akışta `step` (transcribe / measure, `sampleId` ile), bitince `status`.
 *     İlk ölçüm bitince sunucu modelin ilk turunu kendiliğinden başlatır → `drafting`.
 *  5. `drafting`: akışta `text` parçaları, `step` (araç adları), `revision` (her `propose_changes`), `cost`, sonunda
 *     `question` (model `ask_user` dedi → `awaiting-user`) ya da `done` (`review`).
 *  6. `awaiting-user`: `Build.pendingQuestions` gösterilir; cevap `postMessage { kind: "answer", answers }` → 202,
 *     yeni tur (`drafting` ya da `revising`). Not (`kind: "note"`) tur başlatmaz (200).
 *  7. `review`: ortada `showcase` (revizyon başına örnek etiketler, `changed` + `note`), sağda `revision`
 *     (profil + `changes`), sürüm geçişi `revisions`, fark `diff`, kendi metniyle `tryText` (motor ücretsiz; AI önce
 *     `confirm: false` ile tahmin). Düzeltme `postMessage { kind: "correction", text }` → `revising` → `review`.
 *     "Sürüm 2'ye dön" `restore { rev: 2 }` (yeni revizyon yazar, geçmiş silinmez). Örnek eklemek: `uploadSamples`
 *     + `analyze` (`review`'a döner, model bir sonraki turda haberi alır).
 *  8. `publish` → `ProfileRecord`, durum `published`. Ya da `close` → `closed`.
 *  Hata: süreç kapanırsa açılışta `interrupted`, açık nedenle `failed` (`Build.error`); ikisinde de `resume`
 *  (yalnız `error.retryable` ise anlamlı). Çalışan tur `cancel` ile kesilir.
 *
 * Akış (`stream`, SSE): olay kimliği `"<bootId>:<n>"` (bkz. `BUILD_STREAM`). Arayüz akış olmadan da çalışır:
 * `getBuild` + `listMessages?after=<son girdi>` sorgular. Genel olay yolunda `{ type: "build", buildId, languageId,
 * state }` (`BuildBusEventSchema`) yayınlanır.
 *
 * Değişmezler (şemaya yansır):
 *  - Model profili doğrudan yazamaz; yalnız kanıtlı `propose_changes` önerir. Yayın ve ücretli deneme modelin aracı
 *    değildir (`builder-tools.ts`: sekiz araç, başka yok). Yayını yalnız kullanıcı yapar (`publish`).
 *  - Uydurma değer yok: her değişikliğin kanıtı ölçüm anahtarı, kullanıcı girdisi ya da "varsayılana bırak"tır.
 *    `value_json` ayrıştırılır, taslağa birleştirilir ve `ProfileSchema` ile doğrulanır; ölçülmeyen değer boş kalır.
 *  - Müşteri metni değişmez: `lineBreaking.examples` satırları birleşince metin harfi harfine aynı olmalı.
 *  - AI piksel koordinatı üretmez: örneklerin satır kutuları deterministik ölçümden gelir (`SampleLine.ink`).
 *  - Görünen metin sözleşmede yoktur: soru cümlesi ve seçenek adı modelin metnidir; sabit metinler (bildirimler,
 *    hatalar, türler, kurallar) kod + parametre olarak gelir ve arayüz sözlüğünde karşılanır.
 */

/** Bütün oluşturucu uçlarının bağlı olduğu özellik anahtarı (`features.ts`'teki kayıtla aynı dize). */
export const BUILDER_FEATURE = "language.builder" as const;

// ================================================================ durumlar ve geçişler

export const BUILD_STATES = [
  "intake",
  "samples",
  "analyzing",
  "drafting",
  "review",
  "revising",
  "awaiting-user",
  "published",
  "closed",
  "interrupted",
  "failed",
] as const;
export const BuildStateSchema = z.enum(BUILD_STATES);
export type BuildState = z.infer<typeof BuildStateSchema>;

/** Bitmiş oturum: hiçbir geçiş yok. Bir dilde aynı anda bunların dışında en çok bir oturum olur. */
export const BUILD_TERMINAL_STATES = ["published", "closed"] as const satisfies readonly BuildState[];
/** Sunucunun çalıştığı durumlar (ölçüm ya da model turu): arayüz bekleme gösterir, `cancel` çalışır. */
export const BUILD_RUNNING_STATES = ["analyzing", "drafting", "revising"] as const satisfies readonly BuildState[];
/** `interrupted` / `failed` sonrası `resume`'un dönebileceği durumlar. */
export const BUILD_RESUMABLE_STATES = BUILD_RUNNING_STATES;

export const isBuildTerminal = (s: BuildState): boolean => (BUILD_TERMINAL_STATES as readonly BuildState[]).includes(s);
export const isBuildRunning = (s: BuildState): boolean => (BUILD_RUNNING_STATES as readonly BuildState[]).includes(s);
/** Etkin oturum: bitmemiş her durum (`failed` ve `interrupted` dahil; kapatılana kadar dilin oturumu odur). */
export const isBuildActive = (s: BuildState): boolean => !isBuildTerminal(s);

/** Oturum açılınca ilk durum: kurulumdan tür seçimiyle gelindiyse giriş soruları atlanır. */
export function initialBuildState(opts: { fromSetup: boolean; hasLabelTypes: boolean }): BuildState {
  return opts.fromSetup && opts.hasLabelTypes ? "samples" : "intake";
}

/**
 * Geçiş olayları (sunucu tetikler; arayüz yalnız uçları çağırır):
 * - `start-samples`: giriş bitti (`putIntake`).
 * - `skip-samples`: "örneğim yok" (`skipSamples`); ölçümsüz ilk tur.
 * - `analyze`: ölçüm başladı (`analyze`).
 * - `analysis-done` / `analysis-failed`: ölçüm bitti / tümden başarısız (tek örneğin hatası örnekte kalır).
 * - `ask`: model `ask_user` dedi.
 * - `turn-end`: model turu soru sormadan bitti.
 * - `answer`: kullanıcı bekleyen soruya cevap ya da düzeltme yazdı (`postMessage`, `awaiting-user`'da).
 * - `correct`: kullanıcı incelemede düzeltme istedi (`postMessage { kind: "correction" }`).
 * - `cancel`: kullanıcı çalışan işi kesti (`cancel`).
 * - `interrupt`: süreç tur ya da ölçüm sırasında kapandı (açılışta işaretlenir).
 * - `fail`: model turu açık nedenle bitti (ret, kota, anahtar, denemeler tükendi).
 * - `resume`: "Devam et" (`resume`); `interrupted` ya da `failed`'den kesildiği duruma.
 * - `publish`: kullanıcı yayınladı (en az bir revizyon gerekir).
 * - `close`: kullanıcı kapattı.
 */
export const BUILD_EVENTS = [
  "start-samples",
  "skip-samples",
  "analyze",
  "analysis-done",
  "analysis-failed",
  "ask",
  "turn-end",
  "answer",
  "correct",
  "cancel",
  "interrupt",
  "fail",
  "resume",
  "publish",
  "close",
] as const;
export const BuildEventSchema = z.enum(BUILD_EVENTS);
export type BuildEvent = z.infer<typeof BuildEventSchema>;

/** Geçişin hedefini belirleyen bağlam (oturum kaydından okunur). */
export interface BuildTransitionContext {
  /** Model en az bir revizyon yazdı mı (`currentRev > 0`). */
  hasRevision: boolean;
  /** `interrupted` / `failed`'de kesilen durum (`Build.resumeState`). */
  resumeState?: BuildState | null;
}

/** Her olayın kabul edildiği kaynak durumlar. Tablo dışı her çift reddedilir (409 `build-state`). */
export const BUILD_TRANSITIONS: Record<BuildEvent, readonly BuildState[]> = {
  "start-samples": ["intake"],
  "skip-samples": ["intake", "samples"],
  analyze: ["samples", "review"],
  "analysis-done": ["analyzing"],
  "analysis-failed": ["analyzing"],
  ask: ["drafting", "revising"],
  "turn-end": ["drafting", "revising"],
  answer: ["awaiting-user"],
  correct: ["review"],
  cancel: ["analyzing", "drafting", "revising"],
  interrupt: ["analyzing", "drafting", "revising"],
  fail: ["drafting", "revising"],
  resume: ["interrupted", "failed"],
  publish: ["review", "awaiting-user"],
  close: ["intake", "samples", "analyzing", "drafting", "review", "revising", "awaiting-user", "interrupted", "failed"],
};

/** Olay bu durumdan kabul edilir mi (bağlamdan bağımsız ön denetim). */
export function canTransition(from: BuildState, event: BuildEvent): boolean {
  return BUILD_TRANSITIONS[event].includes(from);
}

/**
 * Geçişin hedefi; geçersizse null. Saf işlev: sunucu durum yazmadan önce bunu çağırır, testler tabloyu bununla denetler.
 * - Ölçüm bitince: revizyon yoksa ilk tur (`drafting`), varsa incelemeye döner (`review`).
 * - Soru sormadan biten tur: revizyon varsa `review`, yoksa `awaiting-user` (model metinle bir şey istedi).
 * - Cevap: revizyon yoksa `drafting`, varsa `revising`.
 * - İptal: ölçümde `samples` / `review`; turda revizyon varsa `review`, yoksa `awaiting-user`.
 * - Devam: `resumeState` çalışan bir durum olmalı.
 * - Yayın: revizyon şart.
 */
export function nextBuildState(from: BuildState, event: BuildEvent, ctx: BuildTransitionContext): BuildState | null {
  if (!canTransition(from, event)) return null;
  const { hasRevision } = ctx;
  switch (event) {
    case "start-samples":
      return "samples";
    case "skip-samples":
      return "drafting";
    case "analyze":
      return "analyzing";
    case "analysis-done":
      return hasRevision ? "review" : "drafting";
    case "analysis-failed":
      return hasRevision ? "review" : "samples";
    case "ask":
      return "awaiting-user";
    case "turn-end":
      return from === "revising" || hasRevision ? "review" : "awaiting-user";
    case "answer":
      return hasRevision ? "revising" : "drafting";
    case "correct":
      return "revising";
    case "cancel":
      if (from === "analyzing") return hasRevision ? "review" : "samples";
      return hasRevision ? "review" : "awaiting-user";
    case "interrupt":
      return "interrupted";
    case "fail":
      return "failed";
    case "resume": {
      const r = ctx.resumeState ?? null;
      return r && (BUILD_RESUMABLE_STATES as readonly BuildState[]).includes(r) ? r : null;
    }
    case "publish":
      return hasRevision ? "published" : null;
    case "close":
      return "closed";
  }
}

// ================================================================ sabitler (varsayılanlar; [V] değerlendirmeyle ayarlanır)

/** Örnek yükleme sınırları. Bayt sınırı isteğin tamamı içindir (base64 dahil). */
export const BUILDER_SAMPLE_LIMITS = {
  /** Oturumda en çok örnek (silinenler sayılmaz). */
  maxFiles: 24,
  /** Tek yükleme isteğinin gövdesi (bayt). */
  maxRequestBytes: 60 * 1024 * 1024,
  /** Tek dosya (çözülmüş, bayt). */
  maxFileBytes: 20 * 1024 * 1024,
  /** Kabul edilen türler; PDF'nin yalnız ilk sayfası alınır. */
  mimeTypes: ["image/png", "image/jpeg", "application/pdf"],
  /** Saklanan görselin en uzun kenarı (px; yeniden kodlanır, EXIF silinir). */
  storeEdgePx: 2000,
  /** Modele giden görselin en uzun kenarı (px). */
  modelEdgePx: 768,
  /** Satır okuma (Haiku) için en uzun kenar (px). */
  transcribeEdgePx: 1024,
} as const;

/** Ayrılmış küme: en az `minMeasurable` ölçülebilir örnekte `ratio` kadarı `test`; model bu kümeyi görmez. */
export const BUILDER_HOLDOUT = { minMeasurable: 8, ratio: 0.25 } as const;

/** Ayrılacak test örneği sayısı (aşağı yuvarlanır; eşiğin altında 0). */
export function holdoutCount(measurable: number): number {
  return measurable >= BUILDER_HOLDOUT.minMeasurable ? Math.floor(measurable * BUILDER_HOLDOUT.ratio) : 0;
}

/**
 * Bütçe varsayılanları (USD). Firma ayarı (`org_settings.ai.limits`) değiştirebilir; burada yalnız varsayılan durur.
 * Oturum sınırı aşılacaksa tur başlamaz (409 `budget-exceeded`, `scope: "session"`); kullanıcı onaylarsa sınır bir kez
 * `sessionRaiseUsd` kadar artar (`raiseBudget`). Aylık sınır aşılınca bütün harcama uçları 409.
 */
export const BUILDER_BUDGET_DEFAULTS = {
  sessionUsd: 3,
  sessionRaiseUsd: 3,
  monthlyUsd: 20,
  /** Aylık sınırın bu oranında uyarı (`BuildEstimate.monthWarn`). */
  warnRatio: 0.8,
} as const;

/** Tahmin dayanakları (USD; plan §4.6). Sahte sunucu ve `estimate` aralığı bunlardan kurulur. */
export const BUILDER_COST_HINTS = {
  firstDraftUsd: 0.5, // gerçek oturumda ölçüldü (2026-11-22): ~0,47
  questionTurnUsd: 0.11, // ölçüldü: ~0,11
  correctionTurnUsd: 0.08,
  transcribePerSampleUsd: 0.001,
  typicalLowUsd: 0.9,
  typicalHighUsd: 1.3,
} as const;

/** Döngü sınırları (C1'in ve C3'ün ortak sayıları). */
export const BUILDER_LOOP = {
  /** Tur başına en çok araç adımı. */
  maxToolStepsPerTurn: 8,
  /** Doğrulamayı üst üste geçemeyen öneri sayısı: bu kadar olunca tur biter, taslak bozulmaz. */
  maxFailedProposals: 3,
  /** Ağ, 5xx ve 429'da en çok deneme. */
  maxRetries: 3,
  maxTokens: 32_000,
  /** `ask_user` çağrısında en çok soru, soruda en çok seçenek. */
  maxQuestionsPerAsk: 6,
  maxOptionsPerQuestion: 6,
  /** Tek `propose_changes` çağrısında en çok değişiklik. */
  maxChangesPerProposal: 40,
} as const;

export const KEY_SOURCES = ["org", "product"] as const;
/** AI anahtarının kaynağı: firmanın kendi anahtarı ya da (2. aşamada) ürünün anahtarı. */
export const KeySourceSchema = z.enum(KEY_SOURCES);
export type KeySource = z.infer<typeof KeySourceSchema>;

// ================================================================ ortak parçalar

/** Etiket türleri (kurulum adım 1 ile aynı değerler; `setup.ts` `LABEL_TYPES`). Örnek etiketleri ve soru gruplarını tohumlar. */
export const BUILD_LABEL_TYPES = ["wedding", "baptism", "birthday", "thanks", "product", "sticker"] as const;
export const BuildLabelTypeSchema = z.enum(BUILD_LABEL_TYPES);
export type BuildLabelType = z.infer<typeof BuildLabelTypeSchema>;

/** Soru grupları (beceri `SKILL.md`'nin 11 grubu + ürün etiketi için ölçüler). Görünen ad arayüz sözlüğünde. */
export const BUILD_QUESTION_GROUPS = [
  "satir-bolme",
  "boyut",
  "baglaclar",
  "ozel-karakterler",
  "fontlar",
  "bosluk",
  "doluluk",
  "sablon-yerlesim",
  "kalinlik-renk",
  "sticker",
  "genel",
  "cikti",
] as const;
export const BuildQuestionGroupSchema = z.enum(BUILD_QUESTION_GROUPS);
export type BuildQuestionGroup = z.infer<typeof BuildQuestionGroupSchema>;

export const PROFILE_GROUP_IDS = PROFILE_GROUPS.map((g) => g.id) as [ProfileGroup, ...ProfileGroup[]];
export const ProfileGroupSchema = z.enum(PROFILE_GROUP_IDS);

/**
 * Modelin önerebileceği profil yolları: `PROFILE_DOCS` anahtarları; gizli (eski) alanlar, dilin adı ve hesap tabanı
 * olan tasarım alanı hariç. Yol bir anahtar ya da onun altındaki yapraktır (bkz. `isWritableProfilePath`).
 */
export const BUILDER_EXCLUDED_PATHS = ["name", "output.designFramePx"] as const;
export const BUILDER_WRITABLE_PATHS = Object.entries(PROFILE_DOCS)
  .filter(([k, d]) => !d.hidden && !(BUILDER_EXCLUDED_PATHS as readonly string[]).includes(k))
  .map(([k]) => k) as [string, ...string[]];

/** Yaprak yolun en uzun belgeli öneki (`PROFILE_DOCS` anahtarı); yoksa null. Etiket, grup ve birim buradan. */
export function profileDocKey(path: string): string | null {
  const parts = path.split(".");
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join(".");
    if (Object.hasOwn(PROFILE_DOCS, key)) return key;
  }
  return null;
}

/** Yol modelin önerebileceği alanlardan mı (anahtarın kendisi ya da altındaki yaprak). */
export function isWritableProfilePath(path: string): boolean {
  const key = profileDocKey(path);
  return key !== null && (BUILDER_WRITABLE_PATHS as readonly string[]).includes(key);
}

/** Kod + parametre: görünen cümle arayüz sözlüğünde (`builder:<code>`). */
const CodedSchema = z.object({ code: z.string().min(1), params: MessageParamsSchema.optional() });

// ================================================================ kanıt

export const EVIDENCE_KINDS = ["measurement", "answer", "correction", "default"] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/**
 * Bir değerin kanıtı (sunucunun saklı ve doğrulanmış biçimi; modelin girdisi `builder-tools.ts`'te düz nesnedir).
 * - `measurement`: `key` son ölçümde var olmalı; `n` ölçümdeki örnek sayısıdır (sunucu ölçümden yazar).
 * - `answer` / `correction`: `entryId` bu oturumun kullanıcı girdisi olmalı (`answer`, `sample-edit` ya da
 *   `correction` / `note`).
 * - `default`: yalnız alanı varsayılana bırakmak için (`value_json` = `"null"`).
 */
export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("measurement"), key: z.string().min(1), n: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("answer"), entryId: z.number().int().positive() }),
  z.object({ kind: z.literal("correction"), entryId: z.number().int().positive() }),
  z.object({ kind: z.literal("default") }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

// ================================================================ değişen kurallar ve revizyonlar

export const RULE_CHANGE_SOURCE_KINDS = [...EVIDENCE_KINDS, "restore", "manual"] as const;
export const RULE_CHANGE_WARNINGS = ["outside-measured-range"] as const;

/**
 * Değişen kural (yaprak düzeyi). Kaynak `diffLeaves` + `PROFILE_DOCS`; okunur cümleyi arayüz `describe.ts` ile kurar.
 * - `label`: etiket ANAHTARI = `PROFILE_DOCS` anahtarı (`profileDocKey(path)`); görünen ad arayüzde bu anahtardan.
 * - `source.ref`: ölçümde ölçüm anahtarı, cevap/düzeltmede girdi kimliği (metin), geri dönüşte kaynak revizyon
 *   numarası (metin), `default` ve `manual`'da null. `n` yalnız ölçümde.
 * - `warning`: ölçülen çeyrekler aralığının dışında (`params`: `q1`, `q3`, `n`); değer yine kabul edilmiştir.
 */
export const RuleChangeSchema = z.object({
  path: z.string().min(1),
  group: ProfileGroupSchema,
  label: z.string().min(1),
  unit: z.enum(["oran", "em", "px", "pt", "karakter", "satır"]).nullable(),
  from: z.unknown(),
  to: z.unknown(),
  source: z.object({
    kind: z.enum(RULE_CHANGE_SOURCE_KINDS),
    ref: z.string().nullable(),
    n: z.number().int().nonnegative().optional(),
  }),
  warning: z.object({ code: z.enum(RULE_CHANGE_WARNINGS), params: MessageParamsSchema.optional() }).optional(),
});
export type RuleChange = z.infer<typeof RuleChangeSchema>;

/**
 * Revizyon nedeni. Revizyon 0 tabandır (oturumun başladığı yayınlanmış sürüm ya da varsayılan; saklanmaz, hep
 * okunabilir); modelin ilk yazdığı revizyon 1'dir (`initial`). `restore` eski revizyonun verisini YENİ revizyon olarak
 * yazar; `manual` oturum açıkken kuralların elle düzenlenmesidir.
 */
export const REVISION_REASONS = ["initial", "answer", "correction", "restore", "manual"] as const;
export const RevisionReasonSchema = z.enum(REVISION_REASONS);
export type RevisionReason = z.infer<typeof RevisionReasonSchema>;

/** Revizyon 0: taban. */
export const BASE_REV = 0;

export const RevisionSummarySchema = z.object({
  rev: z.number().int().nonnegative(),
  at: z.string(),
  reason: RevisionReasonSchema,
  /** Modelin `propose_changes.note` metni (geri dönüşte boş; arayüz `reason`'dan kurar). */
  summary: z.string(),
  changeCount: z.number().int().nonnegative(),
  /** Bu revizyonu üreten turun maliyeti (geri dönüşte 0). */
  costUsd: z.number().nonnegative(),
  /** Geri dönüşse kaynak revizyon. */
  restoredFrom: z.number().int().nonnegative().nullable(),
});
export type RevisionSummary = z.infer<typeof RevisionSummarySchema>;

// ================================================================ örnekler

export const SAMPLE_STATUSES = ["uploaded", "measured", "qualitative", "failed"] as const;
export const SampleStatusSchema = z.enum(SAMPLE_STATUSES);
/**
 * Ölçüm kalitesi: `exact` şablon ayrıldı ve satırlar eşleşti (oran, boşluk, doluluk); `ink` düz zemin (yalnız
 * oranlar); `none` fotoğraf ya da ayrılamayan (yalnız niteliksel; hiçbir sayısal ölçüm yazılmaz). Ölçülmeden null.
 */
export const SAMPLE_QUALITIES = ["exact", "ink", "none"] as const;
export const SampleQualitySchema = z.enum(SAMPLE_QUALITIES);
export type SampleQuality = z.infer<typeof SampleQualitySchema>;

/** Örnekte bir satır: kutusu mürekkepten (deterministik), metni okumadan ya da kullanıcıdan. Px, saklanan görsele göre. */
export const SampleLineSchema = z.object({
  /** Okunan / düzeltilen metin; okunamadıysa null. */
  text: z.string().nullable(),
  /** Mürekkep kutusu; kullanıcı satır eklediyse (ölçümde yok) null. */
  ink: BoxSchema.nullable(),
  /** Üstteki satırla arasındaki görünen boşluk (px); ilk satırda null. */
  gapAbovePx: z.number().nullable(),
  /** Kullanıcının seçtiği ya da onayladığı font dosyası (`FontItem.file`); yoksa örneğin fontu. */
  fontFile: z.string().nullable(),
  /** Metin nereden: okuma (Haiku) ya da kullanıcı düzeltmesi. */
  textSource: z.enum(["transcribe", "user"]).nullable(),
});
export type SampleLine = z.infer<typeof SampleLineSchema>;

/** Yüklenen bitmiş etiket. */
export const SampleSchema = z.object({
  id: z.string(),
  buildId: z.string(),
  /** Yüklenen dosyanın adı (müşteri verisi olabilir; olduğu gibi). */
  name: z.string(),
  /** Saklanan görselin ölçüsü (px). */
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  status: SampleStatusSchema,
  quality: SampleQualitySchema.nullable(),
  /** Okunan satır sayısı mürekkep satırlarıyla eşleşmedi: yaklaşık (boşluk ölçümüne katılmaz). */
  approx: z.boolean(),
  /** Eşleşen ya da kullanıcının seçtiği şablon. */
  templateKey: z.string().nullable(),
  /** Şablon nasıl bulundu: kullanıcı seçti, yüklenen boş şablon, otomatik eşleşme; yoksa null. */
  templateMatch: z.enum(["user", "uploaded-blank", "auto"]).nullable(),
  lines: z.array(SampleLineSchema),
  /** Örneğin varsayılan fontu (`FontItem.file`); satırda yoksa bu. */
  fontFile: z.string().nullable(),
  /** Ayrılmış küme: `test` modelden saklanır, kalite kartında kullanılır. Ölçülmeden ya da eşik altında null. */
  split: z.enum(["train", "test"]).nullable(),
  /** Kullanıcı dışarıda bıraktı (ölçüme ve modele girmez; silinmez). */
  excluded: z.boolean(),
  /** Yayından sonra referans olarak saklandıysa kaydı (ürün kararı §8.2). */
  referenceId: z.string().nullable(),
  /** Görsel adresi (`sampleImage`). */
  imageUrl: z.string(),
  /** Bu örneğin ölçüm hatası (kod + parametre); diğer örnekler etkilenmez. */
  error: CodedSchema.nullable(),
  createdAt: z.string(),
});
export type Sample = z.infer<typeof SampleSchema>;

// ================================================================ sorular, cevaplar, akış girdileri

/** Sorudaki ölçülen değer: sunucu ölçümden doldurur (model yalnız anahtarı verir; değer uyduramaz). */
export const MeasuredValueSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  n: z.number().int().nonnegative(),
  q1: z.number().nullable(),
  q3: z.number().nullable(),
});
export type MeasuredValue = z.infer<typeof MeasuredValueSchema>;

/** Arayüzün gösterdiği soru (modelin `ask_user` girdisinden sunucunun kurduğu biçim). */
export const BuildQuestionSchema = z.object({
  /** Oturum içinde benzersiz (modelin verdiği kimlik; çakışırsa sunucu `-2` ekler). */
  id: z.string().min(1),
  /** Sorunun akıştaki girdisi. */
  entryId: z.number().int().positive(),
  group: BuildQuestionGroupSchema,
  /** Modelin soru cümlesi (sözlükte değil; model kullanıcının dilinde yazar). */
  text: z.string(),
  measured: MeasuredValueSchema.nullable(),
  /** Önerilen seçeneğin sırası (0'dan); yoksa null. */
  suggestion: z.number().int().nonnegative().nullable(),
  /** Hazır cevaplar. `value` seçilince cevabın değeri (ayrıştırılmış JSON); yoksa null. */
  options: z.array(z.object({ label: z.string(), value: z.unknown().nullable() })),
  /** Serbest metin cevap kabul edilir mi. */
  free: z.boolean(),
  /** Sorunun ilgili olduğu profil yolları (model verdiyse; arayüz vurgular). */
  paths: z.array(z.string()),
  answered: z.boolean(),
});
export type BuildQuestion = z.infer<typeof BuildQuestionSchema>;

/** Cevap gövdesi (bir soru). `option` ya da `text`ten en az biri. */
export const BuildAnswerInputSchema = z
  .object({
    questionId: z.string().min(1),
    option: z.number().int().nonnegative().optional(),
    text: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((a) => a.option !== undefined || a.text !== undefined, { message: "Seçenek ya da metin gerekli.", path: ["option"] });
export type BuildAnswerInput = z.input<typeof BuildAnswerInputSchema>;

/** Saklanan cevap (girdide). */
export const BuildAnswerSchema = z.object({
  questionId: z.string(),
  option: z.number().int().nonnegative().nullable(),
  text: z.string().nullable(),
  /** Seçilen seçeneğin değeri (varsa). */
  value: z.unknown().nullable(),
});
export type BuildAnswer = z.infer<typeof BuildAnswerSchema>;

export const BUILD_ENTRY_ROLES = ["user", "assistant", "system"] as const;
/**
 * Girdi türleri ve rolleri:
 * - assistant: `text` (modelin metni), `question` (bir soru; `question` dolu), `revision` (`rev` dolu; `text` = not).
 * - user: `answer` (`answer` dolu), `correction`, `note` (`text` dolu), `sample-edit` (örnek düzeltmesi = cevap;
 *   `sampleEdit` dolu).
 * - system: `notice` (`code` + `params`), `error` (`code` + `params`).
 */
export const BUILD_ENTRY_KINDS = ["text", "question", "revision", "answer", "correction", "note", "sample-edit", "notice", "error"] as const;
export const BuildEntryKindSchema = z.enum(BUILD_ENTRY_KINDS);
export type BuildEntryKind = z.infer<typeof BuildEntryKindSchema>;

/** Sistem bildirimleri (`notice` girdisinin kodu). Cümle arayüz sözlüğünde `builder:notice.<code>`. */
export const BUILD_NOTICE_CODES = [
  /** `params.count` */
  "samples-added",
  /** `params.measured`, `params.qualitative`, `params.failed` */
  "analysis-done",
  /** `params.paths` (virgüllü): üst üste doğrulamayı geçemeyen alanlar; taslak bozulmadı. */
  "proposal-failed",
  /** `params.rev`, `params.from` */
  "restored",
  /** `params.version` */
  "published",
  /** `params.limitUsd` */
  "budget-raised",
  /** `params.monthUsd`, `params.limitUsd`: aylık sınırın %80'i. */
  "budget-warning",
  "cancelled",
  "resumed",
  /** `params.waitMs`, `params.attempt` */
  "retrying",
  /** Revizyon 0 varsayılandan başladı (dilin yayınlanmış sürümü yok ya da `base: "default"`). */
  "base-default",
  /** `params.scope` (session | month), `params.usedUsd`, `params.limitUsd`: kalan pay tur içinde doldu, tur durdu. */
  "budget-stopped",
  /** `params.rev`: taslak bu oturumun dışında değişmişti; o hâli `manual` revizyon olarak saklandı, sonra üstüne yazıldı. */
  "draft-replaced",
] as const;

export const BuildEntrySchema = z.object({
  id: z.number().int().positive(),
  at: z.string(),
  role: z.enum(BUILD_ENTRY_ROLES),
  kind: BuildEntryKindSchema,
  /** Girdiyi üreten ya da başlatan tur (sistem girdilerinde null olabilir). */
  turnSeq: z.number().int().nonnegative().nullable(),
  /** Model ya da kullanıcı metni; sistem girdilerinde null. */
  text: z.string().nullable(),
  group: BuildQuestionGroupSchema.nullable(),
  question: BuildQuestionSchema.optional(),
  answer: BuildAnswerSchema.optional(),
  rev: z.number().int().nonnegative().optional(),
  sampleEdit: z.object({ sampleId: z.string(), fields: z.array(z.string()) }).optional(),
  code: z.string().optional(),
  params: MessageParamsSchema.optional(),
});
export type BuildEntry = z.infer<typeof BuildEntrySchema>;

export const BUILD_MESSAGE_KINDS = ["answer", "correction", "note"] as const;
/**
 * Hangi durumda hangi ileti türü kabul edilir. `note` tur başlatmaz (bir sonraki turda modele gider).
 * `awaiting-user`'da `correction` de cevap sayılır (olay `answer`).
 */
export const BUILD_MESSAGE_KINDS_BY_STATE: Partial<Record<BuildState, readonly (typeof BUILD_MESSAGE_KINDS)[number][]>> = {
  intake: ["note"],
  samples: ["note"],
  review: ["correction", "note"],
  "awaiting-user": ["answer", "correction", "note"],
};

// ================================================================ hata ve oturum

/** Oturuma yazılan hata (`failed` / `interrupted` / ölçüm hatası). Cümle sözlükte `builder:error.<code>`. */
export const BUILD_ERROR_CODES = [
  /** Model reddetti (`stop_reason: refusal`); yeniden denemek çoğunlukla aynı sonucu verir. */
  "refusal",
  /** Ağ / 5xx, denemeler tükendi. */
  "provider-unavailable",
  /** 429, denemeler tükendi. */
  "rate-limited",
  /** Sağlayıcı kotası ya da bakiyesi bitti. */
  "quota-exceeded",
  /** Anahtar geçersiz ya da yetkisiz. */
  "key-invalid",
  "missing-key",
  /** Çıktı `max_tokens`'ta kesildi. */
  "max-tokens",
  /** Süreç tur sırasında kapandı. */
  "interrupted",
  /** Ölçüm tümden başarısız. */
  "analysis-failed",
  "internal",
] as const;
export const BuildErrorCodeSchema = z.enum(BUILD_ERROR_CODES);

export const BuildErrorSchema = z.object({
  code: BuildErrorCodeSchema,
  params: MessageParamsSchema.optional(),
  /** "Devam et" anlamlı mı (ret ve geçersiz anahtarda false). */
  retryable: z.boolean(),
  at: z.string(),
});
export type BuildError = z.infer<typeof BuildErrorSchema>;

/** Oturum (arayüzün tek okuma birimi). */
export const BuildSchema = z.object({
  id: z.string(),
  languageId: z.string(),
  /** `site` = bu akış; `mcp` = Claude Code becerisi (sahip ve geliştirici yolu; aynı günlük). */
  mode: z.enum(["site", "mcp"]),
  state: BuildStateSchema,
  /** `interrupted` / `failed`'de kesilen durum; diğer durumlarda null. */
  resumeState: BuildStateSchema.nullable(),
  /** Taban: yayınlanmış sürüm ya da ürünün varsayılanı. */
  base: z.enum(["published", "default"]),
  /** Başladığı yayınlanmış sürüm; varsayılandan başladıysa null. */
  baseVersion: z.number().int().positive().nullable(),
  /** Son revizyon (0 = model henüz yazmadı; taslak her zaman son revizyondur). */
  currentRev: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Bu oturumun sınırı (USD; artırıldıysa artmış hâli). */
  budgetUsd: z.number().positive(),
  /** Sınır bir kez artırıldı mı (ikinci kez artırılmaz). */
  budgetRaised: z.boolean(),
  fromSetup: z.boolean(),
  labelTypes: z.array(BuildLabelTypeSchema),
  /** Cevap bekleyen sorular (`awaiting-user`'da; diğer durumlarda boş). */
  pendingQuestions: z.array(BuildQuestionSchema),
  /** Silinmemiş örnekler (dışarıda bırakılanlar dahil). */
  samples: z.array(SampleSchema),
  /** Çalışan tur; yoksa null. Bir oturumda aynı anda tek tur. */
  turn: z.object({ seq: z.number().int().nonnegative(), startedAt: z.string() }).nullable(),
  /** Son girdinin kimliği (`listMessages?after=` için). */
  lastEntryId: z.number().int().nonnegative(),
  error: BuildErrorSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Build = z.infer<typeof BuildSchema>;

/** Genel olay yolundaki (`GET /api/events`) oturum olayı; `ServerEventSchema`'ya eklenir. */
export const BuildBusEventSchema = z.object({
  type: z.literal("build"),
  buildId: z.string(),
  languageId: z.string(),
  state: BuildStateSchema,
});
export type BuildBusEvent = z.infer<typeof BuildBusEventSchema>;
