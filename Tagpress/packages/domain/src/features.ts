import { z } from "zod";

// ================================================================ Özellik kaydı (SUNUCU-PLANI §3.1)
//
// Metinler arayüz sözlüğünde (`setup:features.<anahtar>`); burada yalnız anahtar, grup, varsayılan, ücret, bağımlılık.

export const FEATURE_KEYS = [
  "core.production",
  "import.json",
  "jobs.manual",
  "adjust",
  "revise",
  "image.onTemplate",
  "image.themeTemplate",
  "learn",
  "print",
  "print.stickers",
  "templates.editor",
  "language.builder",
  "language.rules",
  "language.multi",
  "language.package",
  "text.languages",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export const FeatureKeySchema = z.enum(FEATURE_KEYS);

export const FEATURE_GROUPS = ["production", "import", "image", "learn", "print", "templates", "language"] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export const FEATURE_PAID = ["none", "haiku", "opus", "gemini"] as const;
export type FeaturePaid = (typeof FEATURE_PAID)[number];

/**
 * Kurulum ekranındaki yeri: `core` adım 1'in ortak kümesi (her etiket türüyle önerilir, kullanıcı onaylar); `optional`
 * isteğe bağlı açılabilenler (hiçbir tür kendiliğinden açmaz; sticker türü yalnız `print.stickers`'ı önerir);
 * `hidden` kurulumda gösterilmez (her zaman açık olan).
 */
export const FEATURE_SETUP_PLACES = ["core", "optional", "hidden"] as const;
export type FeatureSetupPlace = (typeof FEATURE_SETUP_PLACES)[number];

export const FeatureDefSchema = z.object({
  key: FeatureKeySchema,
  group: z.enum(FEATURE_GROUPS),
  defaultOn: z.boolean(),
  paid: z.enum(FEATURE_PAID),
  dependsOn: z.array(FeatureKeySchema).optional(),
  always: z.boolean().optional(),
  /** Kurulum ekranındaki yeri (yoksa `optional`; eski yanıtlarla uyum). */
  setup: z.enum(FEATURE_SETUP_PLACES).optional(),
});
export type FeatureDef = z.infer<typeof FeatureDefSchema>;

export const FEATURES: Record<FeatureKey, FeatureDef> = {
  "core.production": { key: "core.production", group: "production", defaultOn: true, paid: "haiku", always: true, setup: "hidden" },
  "import.json": { key: "import.json", group: "import", defaultOn: true, paid: "none", setup: "core" },
  "jobs.manual": { key: "jobs.manual", group: "production", defaultOn: true, paid: "none", setup: "core" },
  adjust: { key: "adjust", group: "production", defaultOn: true, paid: "none", setup: "core" },
  revise: { key: "revise", group: "production", defaultOn: true, paid: "haiku", setup: "core" },
  "image.onTemplate": { key: "image.onTemplate", group: "image", defaultOn: false, paid: "gemini", setup: "optional" },
  "image.themeTemplate": { key: "image.themeTemplate", group: "image", defaultOn: false, paid: "gemini", setup: "optional" },
  learn: { key: "learn", group: "learn", defaultOn: false, paid: "none", setup: "optional" },
  print: { key: "print", group: "print", defaultOn: true, paid: "none", setup: "core" },
  "print.stickers": { key: "print.stickers", group: "print", defaultOn: false, paid: "none", dependsOn: ["print"], setup: "optional" },
  "templates.editor": { key: "templates.editor", group: "templates", defaultOn: true, paid: "none", setup: "core" },
  "language.builder": { key: "language.builder", group: "language", defaultOn: true, paid: "opus", setup: "core" },
  "language.rules": { key: "language.rules", group: "language", defaultOn: false, paid: "none", setup: "optional" },
  "language.multi": { key: "language.multi", group: "language", defaultOn: false, paid: "none", setup: "optional" },
  "language.package": { key: "language.package", group: "language", defaultOn: false, paid: "none", setup: "optional" },
  "text.languages": { key: "text.languages", group: "language", defaultOn: false, paid: "none", setup: "optional" },
};

// ================================================================ Saklanan seçim

export const FEATURE_CHOICE_BY = ["setup", "user", "migration"] as const;
export const FeatureChoiceSchema = z.object({
  on: z.boolean(),
  by: z.enum(FEATURE_CHOICE_BY),
  at: z.string(),
});
export type FeatureChoice = z.infer<typeof FeatureChoiceSchema>;

/** Açık seçimler (yalnız dokunulan anahtarlar). */
export type FeatureExplicit = Partial<Record<FeatureKey, FeatureChoice>>;

const isFeatureKey = (k: string): k is FeatureKey => (FEATURE_KEYS as readonly string[]).includes(k);

/** Okurken bilinmeyen anahtarlar sessizce atılır; bilinen anahtarın seçimi bozuksa hata verir. */
export const FeatureStateSchema = z.record(z.string(), z.unknown()).transform((raw, ctx): FeatureExplicit => {
  const out: FeatureExplicit = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isFeatureKey(k)) continue;
    const r = FeatureChoiceSchema.safeParse(v);
    if (!r.success) {
      ctx.addIssue({ code: "custom", message: `Geçersiz özellik seçimi: ${k}`, path: [k] });
      return z.NEVER;
    }
    out[k] = r.data;
  }
  return out;
});

// ================================================================ Saf işlevler

export class FeatureError extends Error {
  constructor(
    public readonly code: "always-on",
    public readonly feature: FeatureKey,
  ) {
    super(`${code}: ${feature}`);
    this.name = "FeatureError";
  }
}

/** Kayıt varsayılanı + açık seçim; `always` hep açık; bağımlısı kapalı olan kapalı sayılır. */
export function effectiveFeatures(explicit: FeatureExplicit): Record<FeatureKey, boolean> {
  const memo = new Map<FeatureKey, boolean>();
  const resolve = (key: FeatureKey): boolean => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const def = FEATURES[key];
    let on = def.always ? true : (explicit[key]?.on ?? def.defaultOn);
    if (on && !def.always) for (const d of def.dependsOn ?? []) if (!resolve(d)) on = false;
    memo.set(key, on);
    return on;
  };
  const out = {} as Record<FeatureKey, boolean>;
  for (const key of FEATURE_KEYS) out[key] = resolve(key);
  return out;
}

/** `key`'in bağımlılık zinciri (kendisi hariç). */
function dependencyChain(key: FeatureKey): FeatureKey[] {
  const seen = new Set<FeatureKey>();
  const walk = (k: FeatureKey): void => {
    for (const d of FEATURES[k].dependsOn ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      walk(d);
    }
  };
  walk(key);
  return [...seen];
}

/** `key`'e doğrudan ya da dolaylı bağlı olanlar (kendisi hariç). */
function dependentChain(key: FeatureKey): FeatureKey[] {
  return FEATURE_KEYS.filter((k) => k !== key && dependencyChain(k).includes(key));
}

/**
 * Bir anahtarı açar ya da kapatır. Açarken bağımlılık zinciri de açılır; kapatırken ona bağlı olanlar da kapanır.
 * `changed`: etkin değeri değişen anahtarlar. İstenen anahtar değişmese bile açık seçim olarak yazılır.
 */
export function applyToggle(
  explicit: FeatureExplicit,
  key: FeatureKey,
  on: boolean,
  by: FeatureChoice["by"],
  at: string,
): { explicit: FeatureExplicit; changed: FeatureKey[] } {
  if (!on && FEATURES[key].always) throw new FeatureError("always-on", key);
  const before = effectiveFeatures(explicit);
  const targets = on ? [key, ...dependencyChain(key)] : [key, ...dependentChain(key)];
  const next: FeatureExplicit = { ...explicit };
  for (const t of targets) {
    if (t === key || before[t] !== on) next[t] = { on, by, at };
  }
  const after = effectiveFeatures(next);
  const changed = FEATURE_KEYS.filter((k) => before[k] !== after[k]);
  return { explicit: next, changed };
}

// ================================================================ API şekilleri

export const FeaturesResponseSchema = z.object({
  registry: z.array(FeatureDefSchema),
  effective: z.record(FeatureKeySchema, z.boolean()),
  explicit: z.partialRecord(FeatureKeySchema, FeatureChoiceSchema),
});
export type FeaturesResponse = z.infer<typeof FeaturesResponseSchema>;

export const FeaturesPatchBodySchema = z.partialRecord(FeatureKeySchema, z.boolean());
export type FeaturesPatchBody = z.infer<typeof FeaturesPatchBodySchema>;

/** Kapalı özelliğin yazma/harcama ucu: 409. */
export const FeatureOffErrorSchema = z.object({
  code: z.literal("feature-off"),
  feature: FeatureKeySchema,
});
export type FeatureOffError = z.infer<typeof FeatureOffErrorSchema>;
