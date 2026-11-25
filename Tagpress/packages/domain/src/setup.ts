import { z } from "zod";
import {
  effectiveFeatures,
  FEATURE_KEYS,
  FeatureKeySchema,
  FeaturesPatchBodySchema,
  FeaturesResponseSchema,
  type FeatureExplicit,
  type FeatureKey,
} from "./features.ts";
import type { REGISTRATION_STYLES } from "./print.ts";
import { BLEED_MM, BLEED_WITH_CUTTER_MM, DEFAULT_PAPER, mmToPt, PAPER_SIZE_IDS, PAPER_SIZES, type PaperSizeId } from "./units.ts";

// ================================================================ Kurulum (SUNUCU-PLANI §3.2, §3.4)

/** Adım 1'deki etiket türleri (görünen adlar arayüz sözlüğünde). */
export const LABEL_TYPES = ["wedding", "baptism", "birthday", "thanks", "product", "sticker"] as const;
export type LabelType = (typeof LABEL_TYPES)[number];
export const LabelTypeSchema = z.enum(LABEL_TYPES);

/** Kurulumda sorulan baskı seçenekleri (görünen adlar arayüz sözlüğünde). */
export const SETUP_PAPER_TYPES = ["plain", "precut"] as const;
export const SETUP_CUTTERS = ["silhouette", "cricut", "scanncut", "plotter", "other"] as const;
/** Sticker'ın varsayılan en büyük ölçüsü (mm): 3,8 cm etiketle aynı. */
export const STICKER_DEFAULT_MM = 38;

export const SetupAnswersSchema = z.object({
  labelTypes: z.array(LabelTypeSchema),
  language: z.object({ choice: z.enum(["build", "default"]) }).optional(),
  print: z
    .object({
      /** Kağıt: `PAPER_SIZES` kimliği ("a4", "letter", …). Bilinmeyen kimlik A4 sayılır. */
      paperPreset: z.string().optional(),
      /** Kesimi bir kesim makinesi mi yapıyor (yoksa makas ya da hazır kesimli kağıt). */
      usesCutter: z.boolean().optional(),
      /** Kağıt türü: düz yapışkanlı kağıt (çizgi basılır, kesilir) ya da hazır kesimli etiket kağıdı (çizgi basılmaz). */
      paperType: z.enum(SETUP_PAPER_TYPES).optional(),
      /** Kesim makinesi ailesi: kayıt işareti düzenini belirler (`printDefaultsFromSetup`). */
      cutter: z.enum(SETUP_CUTTERS).optional(),
      /** Sticker'ın en büyük genişliği (mm); yuvarlak sticker'da çap. Yoksa 38 mm (3,8 cm etiketle aynı). */
      stickerSizeMm: z.number().min(10).max(200).optional(),
    })
    .optional(),
});
export type SetupAnswers = z.infer<typeof SetupAnswersSchema>;

/**
 * Kurulumdaki baskı cevaplarından sayfa şablonu ve sticker varsayılanları (mm). Sorulmayan her şey standarttır
 * (`units.ts`): A4, kesim çizgisi 0,25 mm, taşma 0, 300 dpi.
 * - Hazır kesimli kağıt: kesim çizgisi basılmaz (yalnız ekranda kılavuz).
 * - Silhouette / Cricut: kayıt işaretini makinenin kendi yazılımı ekler → uygulama işaret basmaz; kesim dosyası (SVG)
 *   verilir, taşma payı 1 mm (kesim kaymasında beyaz kenar kalmasın).
 * - Optik gözlü plotter (Graphtec vb.): dört köşede L işareti (kenardan 10 mm, 5 mm, 0,5 mm), taşma 1 mm.
 * - Tarayıcılı makine (Brother ScanNCut) ve diğerleri: çizgi basılır, işaret yok.
 */
export function printDefaultsFromSetup(answers: Pick<SetupAnswers, "print">): {
  paper: { wMm: number; hMm: number };
  cut: { outlineVisible: boolean; cutFile: boolean; bleedMm: number; registration: { enabled: boolean; style: (typeof REGISTRATION_STYLES)[number] } };
  sticker: { shape: "circle"; maxW: number; maxH: number };
} {
  const p = answers.print ?? {};
  const paperId = (PAPER_SIZE_IDS as readonly string[]).includes(p.paperPreset ?? "") ? (p.paperPreset as PaperSizeId) : DEFAULT_PAPER;
  const cutter = p.usesCutter === false ? null : (p.cutter ?? (p.usesCutter ? "other" : null));
  const marks = cutter === "plotter";
  const software = cutter === "silhouette" || cutter === "cricut";
  const stickerPt = mmToPt(p.stickerSizeMm ?? STICKER_DEFAULT_MM);
  return {
    paper: { ...PAPER_SIZES[paperId] },
    cut: {
      outlineVisible: p.paperType !== "precut",
      cutFile: software || marks,
      bleedMm: software || marks ? BLEED_WITH_CUTTER_MM : BLEED_MM,
      registration: { enabled: marks, style: "corners-l" },
    },
    sticker: { shape: "circle", maxW: stickerPt, maxH: stickerPt },
  };
}

export const SetupStepSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const SetupStateSchema = z.object({
  status: z.enum(["pending", "in-progress", "completed"]),
  step: SetupStepSchema,
  answers: SetupAnswersSchema,
  completedAt: z.string().nullable(),
  skipped: z.boolean(),
});
export type SetupState = z.infer<typeof SetupStateSchema>;

// ================================================================ Tür → özellik eşlemesi

/**
 * Eşleme tablosu: `always` her cevapta açılır; `byType` yalnız o tür seçiliyse ekler.
 * Ürün etiketi ve diğer türler özellik açmaz. Ücretli görüntü özellikleri hiçbir seçimle açılmaz.
 */
export const SETUP_FEATURE_RULES: {
  always: readonly FeatureKey[];
  byType: Record<LabelType, readonly FeatureKey[]>;
} = {
  always: [
    "core.production",
    "import.json",
    "jobs.manual",
    "adjust",
    "revise",
    "print",
    "templates.editor",
    "language.builder",
  ],
  byType: {
    wedding: [],
    baptism: [],
    birthday: [],
    thanks: [],
    product: [],
    sticker: ["print.stickers"],
  },
};

/** Cevaplardan önerilen özellikler (kayıt sırasıyla, tekrarsız). */
export function suggestFeatures(answers: SetupAnswers): FeatureKey[] {
  const set = new Set<FeatureKey>(SETUP_FEATURE_RULES.always);
  for (const t of answers.labelTypes) for (const k of SETUP_FEATURE_RULES.byType[t]) set.add(k);
  return FEATURE_KEYS.filter((k) => set.has(k));
}

/**
 * Öneriyi açık seçimin üstüne uygular: önerilenler açık, önerilmeyenler kapalı;
 * kullanıcının elle ya da göçle açtığı (`by: 'user' | 'migration'`, `on: true`) özellik kapatılmaz.
 */
export function proposedExplicit(answers: SetupAnswers, explicit: FeatureExplicit, at: string): FeatureExplicit {
  const suggested = new Set(suggestFeatures(answers));
  const out: FeatureExplicit = { ...explicit };
  for (const key of FEATURE_KEYS) {
    const cur = explicit[key];
    if (suggested.has(key)) out[key] = { on: true, by: "setup", at };
    else if (!(cur?.on && (cur.by === "user" || cur.by === "migration"))) out[key] = { on: false, by: "setup", at };
  }
  return out;
}

/** Kaydetmeden önizleme: önerilen etkin durum ve bugünküne göre farklar. */
export function previewSetup(
  answers: SetupAnswers,
  explicit: FeatureExplicit,
  at: string,
): { features: Record<FeatureKey, boolean>; changes: { key: FeatureKey; from: boolean; to: boolean }[] } {
  const from = effectiveFeatures(explicit);
  const features = effectiveFeatures(proposedExplicit(answers, explicit, at));
  const changes = FEATURE_KEYS.filter((k) => from[k] !== features[k]).map((key) => ({
    key,
    from: from[key],
    to: features[key],
  }));
  return { features, changes };
}

// ================================================================ API

export const SetupChangeSchema = z.object({ key: FeatureKeySchema, from: z.boolean(), to: z.boolean() });
export const SetupPreviewBodySchema = z.object({ answers: SetupAnswersSchema });
export const SetupPreviewResponseSchema = z.object({
  features: z.record(FeatureKeySchema, z.boolean()),
  changes: z.array(SetupChangeSchema),
});
export const SetupAnswersPutBodySchema = z.object({ step: SetupStepSchema, answers: SetupAnswersSchema });
/** `features`: kullanıcının onayladığı açık özellikler listesi. */
export const SetupCompleteBodySchema = z.object({ answers: SetupAnswersSchema, features: z.array(FeatureKeySchema) });
export const SetupResultSchema = z.object({ setup: SetupStateSchema, features: FeaturesResponseSchema });

/** Kurulum ve özellik uçları. `request`: gövde şeması (null = gövdesiz); `response`: başarı yanıtı. */
export const SETUP_API = {
  featuresGet: { method: "GET", path: "/api/features", request: null, response: FeaturesResponseSchema },
  featuresPatch: {
    method: "PATCH",
    path: "/api/features",
    request: FeaturesPatchBodySchema,
    response: FeaturesResponseSchema,
  },
  setupGet: { method: "GET", path: "/api/setup", request: null, response: SetupStateSchema },
  preview: {
    method: "POST",
    path: "/api/setup/preview",
    request: SetupPreviewBodySchema,
    response: SetupPreviewResponseSchema,
  },
  answers: { method: "PUT", path: "/api/setup/answers", request: SetupAnswersPutBodySchema, response: SetupStateSchema },
  complete: { method: "POST", path: "/api/setup/complete", request: SetupCompleteBodySchema, response: SetupResultSchema },
  skip: { method: "POST", path: "/api/setup/skip", request: null, response: SetupResultSchema },
  restart: { method: "POST", path: "/api/setup/restart", request: null, response: SetupStateSchema },
} as const;
