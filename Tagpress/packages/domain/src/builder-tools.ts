import { z } from "zod";
import {
  BUILDER_LOOP,
  BUILDER_SAMPLE_LIMITS,
  BUILDER_WRITABLE_PATHS,
  BuildQuestionGroupSchema,
  EvidenceKindSchema,
  PROFILE_GROUP_IDS,
  RuleChangeSchema,
  type Evidence,
} from "./builder.ts";
import { MessageParamsSchema } from "./messages.ts";

/**
 * Oluşturucu modelinin araç girdileri (plan §4.3). `packages/ai` araç tanımını, sunucu (`tools-exec.ts`) doğrulamayı
 * bu şemalardan yapar; iki taraf aynı şemayı kullanır.
 *
 * Katı araç (strict) kuralları: şemalarda yalnız nesne, dizi, dize, sayı, boolean ve enum vardır; her nesne katıdır
 * (`additionalProperties: false`); varsayılan, birleşim, null ve sayı/uzunluk sınırı JSON şemasına yazılmaz. Sınırlar
 * `refine` ile yalnız zod doğrulamasında durur (katı tanıma çevrilmez). Serbest değerler `value_json: string` olarak
 * taşınır. `builderToolJsonSchema(ad)` katı tanımın `input_schema`'sını verir ve izin verilmeyen bir anahtar görürse
 * hata fırlatır. Alan açıklamaları (modelin okuyacağı metin) istemin işidir (C1, `studio-builder-v1`).
 *
 * Değişmez: modelin yayın aracı ve ücretli deneme aracı YOKTUR. Liste bu sekiz araçtır; eklenecek her araç bu
 * dosyada ve testte görünür.
 */

const int = (min: number, max: number) =>
  z.number().refine((v) => Number.isInteger(v) && v >= min && v <= max, { message: `${min}–${max} arası tam sayı olmalı.` });
const text = (max: number) => z.string().refine((s) => s.trim().length > 0 && s.length <= max, { message: `Boş olmayan, en çok ${max} karakter.` });
const list = <T extends z.ZodType>(item: T, min: number, max: number) =>
  z.array(item).refine((a) => a.length >= min && a.length <= max, { message: `${min}–${max} öğe.` });

const ProfileGroupEnum = z.enum(PROFILE_GROUP_IDS);
const WritablePathEnum = z.enum(BUILDER_WRITABLE_PATHS);

// ---------------------------------------------------------------- girdiler

export const ReadProfileInputSchema = z.strictObject({
  /** draft: oturumun son revizyonu; base: revizyon 0 (taban). */
  source: z.enum(["draft", "base"]),
  group: ProfileGroupEnum.optional(),
});

export const ProfileSchemaInputSchema = z.strictObject({ group: ProfileGroupEnum.optional() });

/** Yüklenen örnekler ve firmanın referansları. Ayrılmış küme (`test`) hiç dönmez; `ids` içinde olsa da atlanır. */
export const GetSamplesInputSchema = z.strictObject({
  limit: int(1, BUILDER_SAMPLE_LIMITS.maxFiles),
  ids: list(text(80), 1, BUILDER_SAMPLE_LIMITS.maxFiles).optional(),
});

export const GetMeasurementsInputSchema = z.strictObject({});

export const GetTemplatesInputSchema = z.strictObject({ keys: list(text(80), 1, 60).optional() });

/**
 * Kanıt (modelin girdisi; düz nesne, katı tanıma uygun). Türe göre zorunlu alanlar `refine` ile denetlenir;
 * `toEvidence` sunucunun saklı biçimine (`EvidenceSchema`) çevirir.
 */
export const EvidenceInputSchema = z
  .strictObject({
    kind: EvidenceKindSchema,
    /** measurement: son ölçümdeki anahtar. */
    key: z.string().optional(),
    /** measurement: modelin gördüğü örnek sayısı (sunucu ölçümdekiyle değiştirir). */
    n: z.number().optional(),
    /** answer / correction: bu oturumun kullanıcı girdisi. */
    entryId: z.number().optional(),
  })
  .superRefine((e, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (e.kind === "measurement") {
      if (!e.key?.trim()) bad("key", "Ölçüm kanıtında anahtar gerekli.");
      if (e.n !== undefined && !(Number.isInteger(e.n) && e.n >= 0)) bad("n", "n negatif olmayan tam sayı olmalı.");
      if (e.entryId !== undefined) bad("entryId", "Ölçüm kanıtında girdi kimliği olmaz.");
    } else if (e.kind === "answer" || e.kind === "correction") {
      if (e.entryId === undefined || !Number.isInteger(e.entryId) || e.entryId < 1) bad("entryId", "Kullanıcı girdisinin kimliği gerekli.");
      if (e.key !== undefined) bad("key", "Cevap kanıtında ölçüm anahtarı olmaz.");
    } else if (e.key !== undefined || e.entryId !== undefined) {
      bad("kind", "Varsayılan kanıtı alan taşımaz.");
    }
  });
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

/** Modelin kanıt girdisini saklı biçime çevirir (girdi önce `EvidenceInputSchema` ile doğrulanmış olmalı). */
export function toEvidence(e: EvidenceInput): Evidence {
  switch (e.kind) {
    case "measurement":
      return { kind: "measurement", key: e.key!.trim(), n: e.n ?? 0 };
    case "answer":
    case "correction":
      return { kind: e.kind, entryId: e.entryId! };
    case "default":
      return { kind: "default" };
  }
}

/**
 * Önerilen tek değişiklik. `value_json` JSON metnidir; `"null"` alanı varsayılana bırakır (yalnız `default` kanıtıyla).
 * Sunucu sırasıyla: yol izinli mi → `value_json` ayrışıyor mu → kanıt geçerli mi (ölçüm anahtarı son ölçümde, girdi bu
 * oturumda) → taslağa birleştirilmiş profil `ProfileSchema`'dan geçiyor mu → `lineBreaking.examples` metni korunuyor mu
 * (`checkTextPreserved`) → ölçülen çeyrekler dışındaysa uyarı.
 */
export const ProposedChangeInputSchema = z
  .strictObject({
    path: WritablePathEnum,
    value_json: z.string(),
    evidence: EvidenceInputSchema,
  })
  .superRefine((c, ctx) => {
    const parsed = parseValueJson(c.value_json);
    if (!parsed.ok) ctx.addIssue({ code: "custom", path: ["value_json"], message: "Geçerli JSON değil." });
    else if (c.evidence.kind === "default" && parsed.value !== null) ctx.addIssue({ code: "custom", path: ["value_json"], message: 'Varsayılan kanıtında değer "null" olmalı.' });
    else if (c.evidence.kind !== "default" && parsed.value === null) ctx.addIssue({ code: "custom", path: ["evidence"], message: 'Alanı varsayılana bırakmak için kanıt "default" olmalı.' });
  });
export type ProposedChangeInput = z.infer<typeof ProposedChangeInputSchema>;

export const ProposeChangesInputSchema = z.strictObject({
  /** Revizyonun kısa özeti (soldaki akışta ve sürüm listesinde görünür). */
  note: text(500),
  changes: list(ProposedChangeInputSchema, 1, BUILDER_LOOP.maxChangesPerProposal),
});
export type ProposeChangesInput = z.infer<typeof ProposeChangesInputSchema>;

/** Ücretsiz motor denemesi. `test`'te yalnız toplu ölçüler döner (örnek metni ve görseli yok). */
export const EngineTrialInputSchema = z.strictObject({
  split: z.enum(["test", "all"]),
  limit: int(1, 60),
});

export const AskUserQuestionInputSchema = z
  .strictObject({
    id: text(40),
    group: BuildQuestionGroupSchema,
    text: text(600),
    /** Ölçülen değeri göstermek için yalnız anahtar; değer ve n'yi sunucu ölçümden yazar. */
    measured: z.strictObject({ key: text(120) }).optional(),
    /** Önerilen seçeneğin sırası (0'dan). */
    suggestion: z.number().optional(),
    options: list(z.strictObject({ label: text(120), value_json: z.string().optional() }), 0, BUILDER_LOOP.maxOptionsPerQuestion),
    free: z.boolean(),
    paths: list(WritablePathEnum, 1, 10).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.suggestion !== undefined && !(Number.isInteger(q.suggestion) && q.suggestion >= 0 && q.suggestion < q.options.length))
      ctx.addIssue({ code: "custom", path: ["suggestion"], message: "Öneri bir seçeneğin sırası olmalı." });
    if (!q.free && q.options.length < 2) ctx.addIssue({ code: "custom", path: ["options"], message: "Serbest cevapsız soruda en az iki seçenek gerekli." });
    q.options.forEach((o, i) => {
      if (o.value_json !== undefined && !parseValueJson(o.value_json).ok) ctx.addIssue({ code: "custom", path: ["options", i, "value_json"], message: "Geçerli JSON değil." });
    });
  });

/** Turu bitirir; durum `awaiting-user`. */
export const AskUserInputSchema = z
  .strictObject({ questions: list(AskUserQuestionInputSchema, 1, BUILDER_LOOP.maxQuestionsPerAsk) })
  .superRefine((a, ctx) => {
    const ids = a.questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["questions"], message: "Soru kimlikleri benzersiz olmalı." });
  });
export type AskUserInput = z.infer<typeof AskUserInputSchema>;

// ---------------------------------------------------------------- araç kaydı

export const BUILDER_TOOL_NAMES = [
  "read_profile",
  "profile_schema",
  "get_samples",
  "get_measurements",
  "get_templates",
  "propose_changes",
  "engine_trial",
  "ask_user",
] as const;
export type BuilderToolName = (typeof BUILDER_TOOL_NAMES)[number];

/**
 * Araçların etkisi: `read` hiçbir şey yazmaz; `draft` revizyon yazar (yalnız `propose_changes`); `ends-turn` turu bitirir
 * (yalnız `ask_user`). Hiçbir araç yayın yapmaz, ücret harcamaz ya da müşteri metnini değiştirmez.
 */
export const BUILDER_TOOLS = {
  read_profile: { input: ReadProfileInputSchema, effect: "read" },
  profile_schema: { input: ProfileSchemaInputSchema, effect: "read" },
  get_samples: { input: GetSamplesInputSchema, effect: "read" },
  get_measurements: { input: GetMeasurementsInputSchema, effect: "read" },
  get_templates: { input: GetTemplatesInputSchema, effect: "read" },
  propose_changes: { input: ProposeChangesInputSchema, effect: "draft" },
  engine_trial: { input: EngineTrialInputSchema, effect: "read" },
  ask_user: { input: AskUserInputSchema, effect: "ends-turn" },
} as const satisfies Record<BuilderToolName, { input: z.ZodType; effect: "read" | "draft" | "ends-turn" }>;

export type BuilderToolInput<N extends BuilderToolName> = z.infer<(typeof BUILDER_TOOLS)[N]["input"]>;

/** Model girdisini doğrular (araç çalıştırılmadan önce; kesik ya da bozuk girdi `is_error` sonucu olur). */
export function parseBuilderToolInput<N extends BuilderToolName>(name: N, input: unknown): z.ZodSafeParseResult<BuilderToolInput<N>> {
  const schema: z.ZodType = BUILDER_TOOLS[name].input;
  return schema.safeParse(input) as z.ZodSafeParseResult<BuilderToolInput<N>>;
}

/** `value_json` ayrıştırma: profil şemasıyla doğrulama bundan SONRA, taslağa birleştirilmiş hâlde yapılır. */
export function parseValueJson(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------- katı araç tanımına çevirme

/** Katı tanımda izinli JSON şeması anahtarları ve türleri. */
const STRICT_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "description"]);
const STRICT_TYPES = new Set(["object", "array", "string", "number", "boolean"]);

export type StrictJsonSchema = {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: Record<string, StrictJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: StrictJsonSchema;
  enum?: (string | number)[];
  description?: string;
};

/** JSON şeması katı araç kurallarına uyuyor mu; uymayan ilk yolu ve nedeni döner (uyuyorsa null). */
export function strictSchemaProblem(node: unknown, path = "$"): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return `${path}: nesne değil`;
  const n = node as Record<string, unknown>;
  for (const k of Object.keys(n)) if (!STRICT_KEYS.has(k)) return `${path}: izinsiz anahtar "${k}"`;
  if (typeof n.type !== "string" || !STRICT_TYPES.has(n.type)) return `${path}: izinsiz tür ${JSON.stringify(n.type)}`;
  if (n.enum !== undefined && (!Array.isArray(n.enum) || n.enum.length === 0)) return `${path}: boş enum`;
  if (n.type === "object") {
    if (n.additionalProperties !== false) return `${path}: additionalProperties false değil`;
    const props = (n.properties ?? {}) as Record<string, unknown>;
    const req = (n.required ?? []) as unknown[];
    if (!Array.isArray(req) || req.some((r) => typeof r !== "string" || !(r in props))) return `${path}: required özelliklerle uyuşmuyor`;
    for (const [k, v] of Object.entries(props)) {
      const p = strictSchemaProblem(v, `${path}.${k}`);
      if (p) return p;
    }
  } else if (n.properties !== undefined || n.required !== undefined || n.additionalProperties !== undefined) {
    return `${path}: nesne olmayan türde nesne anahtarı`;
  }
  if (n.type === "array") {
    if (!n.items) return `${path}: dizinin öğe şeması yok`;
    return strictSchemaProblem(n.items, `${path}[]`);
  } else if (n.items !== undefined) {
    return `${path}: dizi olmayan türde items`;
  }
  return null;
}

/** Aracın katı `input_schema`'sı (`strict: true` ile kullanılır). Kurala uymazsa hata fırlatır. */
export function builderToolJsonSchema(name: BuilderToolName): StrictJsonSchema {
  const raw = z.toJSONSchema(BUILDER_TOOLS[name].input, { io: "input", unrepresentable: "throw" }) as Record<string, unknown>;
  delete raw.$schema;
  const problem = strictSchemaProblem(raw);
  if (problem) throw new Error(`${name}: katı araç şemasına çevrilemez (${problem})`);
  return raw as StrictJsonSchema;
}

// ---------------------------------------------------------------- araç sonuçları (sunucu → döngü)

/** `propose_changes` reddinin kodu (değişiklik başına; model düzeltip yeniden önerir). */
export const PROPOSAL_REJECT_CODES = [
  "path-not-allowed",
  "invalid-json",
  "schema-invalid",
  "unknown-measurement",
  "unknown-entry",
  "default-not-null",
  "text-not-preserved",
  "no-change",
] as const;

/**
 * `propose_changes`'in yapılandırılmış sonucu (C3 üretir, C1 modele metin olarak biçimler). En az bir değişiklik
 * kabul edildiyse yeni revizyon yazılır (`rev`); hiçbiri kabul edilmediyse `rev` null ve araç sonucu `is_error`.
 */
export const ProposeChangesResultSchema = z.object({
  rev: z.number().int().positive().nullable(),
  applied: z.array(RuleChangeSchema),
  rejected: z.array(z.object({ index: z.number().int().nonnegative(), path: z.string(), code: z.enum(PROPOSAL_REJECT_CODES), params: MessageParamsSchema.optional() })),
  /** Üst üste başarısız öneri sayısı (`BUILDER_LOOP.maxFailedProposals`'a ulaşınca tur biter). */
  failedStreak: z.number().int().nonnegative(),
});
export type ProposeChangesResult = z.infer<typeof ProposeChangesResultSchema>;
