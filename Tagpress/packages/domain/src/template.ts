import { z } from "zod";
import { type TemplateCut, type TemplateCutInput, OWN_CUT_MARGIN_RATIO, TemplateCutSchema, cutShapePx, cutSizeId, normalizeCut } from "./cut.ts";
import { type Bitmap, type Box, BoxSchema, type Point, PointSchema, type Shape, ShapeSchema, shapeBounds } from "./geometry.ts";
import type { Profile } from "./profile.ts";

export * from "./cut.ts";

/**
 * Şablon kaydı. Bütün konumlar tasarım alanının kenarına göre 0..1 orandır.
 *
 * "Yazı alanı" (area) yazının girebileceği sınırdır; "hedef merkez" (textCenter) kullanıcının yazıyı
 * tipik olarak koyduğu noktadır. İkisi AYRI kavramdır (eski sistemin ölçümü): alan geniş olabilir ama
 * yazı alışkanlıkla belirli bir noktaya oturur.
 */
export const TemplateAreaSchema = z.discriminatedUnion("mode", [
  /** Program dekor maskesinden alan önerir. */
  z.object({ mode: z.literal("auto") }),
  /** Kullanıcının çizdiği şekil (oran). */
  z.object({ mode: z.literal("manual"), shape: ShapeSchema }),
]);
export type TemplateArea = z.infer<typeof TemplateAreaSchema>;

export const TemplateSchema = z.object({
  key: z.string().min(1),
  languageId: z.string().min(1),
  /** label: normal etiket; sticker: sayfa sticker'ı (zeminsiz); generated: görüntü modeliyle üretilmiş şablon. */
  kind: z.enum(["label", "sticker", "generated"]).default("label"),
  /**
   * Kesim şekli ve fiziksel ölçüsü (mm). null = tasarım dilinin kesimi (`output.cut`) ve boyut listesi (eski kayıtlar).
   * Bkz. `cut.ts`.
   */
  cut: TemplateCutSchema.nullable().default(null),
  /** Tasarım dilinin şablon klasöründeki dosya adı (PNG, şablon kutusunun 2 katı çözünürlük önerilir). */
  file: z.string().min(1),
  hash: z.string().default(""),
  /** Görselin piksel boyutu. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * Görselin tasarım alanındaki yeri (px). null = profilin `output.templateBox`'ı (şablonun kendi kesimi varsa kesimin
   * kutusu: görsel etiketin tamamını kaplar). Şablon görselinin çizimi
   * kutusundan taşıyorsa (dışa aktarılan PNG daha büyük ve kaymışsa) bu doldurulur; ör. kutu 10,10,420 iken
   * 17 px sola taşan görsel → { x: -7, y: 10, w: 437, h: 420 }.
   */
  imageBox: BoxSchema.nullable().default(null),
  area: TemplateAreaSchema.default({ mode: "auto" }),
  /** Üstte kurdele bandı: kesim çapının bu oranı yazıya kapalı. */
  ribbonTop: z.number().min(0).max(0.6).default(0),
  /** Hedef yazı merkezi (oran). null = alanın merkezi. */
  textCenter: PointSchema.nullable().default(null),
  /** Elle çizilen alanın tamamına yazılabilir (içindeki dekor engel sayılmaz). */
  ignoreDecorationInArea: z.boolean().default(false),
  decoration: z
    .object({
      /** alpha: saydam PNG'de dolu pikseller dekor; color: zemin renginden farklı pikseller dekor. */
      source: z.enum(["auto", "alpha", "color"]).default("auto"),
      /** Renk farkı eşiği (ΔE). */
      threshold: z.number().positive().default(18),
      /** Dekorun çevresine eklenecek genişletme (tasarım alanı px). */
      dilatePx: z.number().min(0).default(3),
    })
    .prefault({}),
  /** Şablonda basılı yazı var (AI ve denetçi bilsin). */
  printedText: z.boolean().default(false),
  /** AI'a gidecek kısa tarif (ör. "çiçek çelengi, iç alan dairesel"). */
  notes: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** Ayarların kaynağı (ölçüm, kullanıcı, öğrenme) — iz sürmek için. */
  provenance: z
    .array(z.object({ field: z.string(), source: z.enum(["user", "measured", "learned", "migrated", "auto"]), samples: z.number().optional(), at: z.string() }))
    .default([]),
  /** Görüntü modeliyle üretilmiş şablonun tarifi. */
  generatedFrom: z.object({ prompt: z.string(), model: z.string(), at: z.string() }).nullable().default(null),
});
export type Template = z.infer<typeof TemplateSchema>;

/** Şablonun etkin kesimi: tasarım px şekli, fiziksel ölçek (mm/px; profil kesiminde null) ve boyut kimliği. */
export interface EffectiveCut {
  /** Kesim şekli (tasarım px). */
  shape: Shape;
  /** Şablonun kendi kesimi (mm) ya da null (profil kesimi). */
  cut: TemplateCut | null;
  /** 1 tasarım px kaç mm; profil kesiminde null (fiziksel ölçü baskı yuvasından/boyut listesinden gelir). */
  mmPerPx: number | null;
  /** Boyut kimliği (`cutSizeId`); profil kesiminde null (işin `labelSize`'ı geçer). */
  sizeId: string | null;
}

/** Şablonun etkin kesimi. Şablonda kesim yoksa profilin `output.cut`'ı AYNEN (eski çıktı piksel piksel aynı). */
export function effectiveCut(template: { cut?: TemplateCutInput | null } | null | undefined, profile: Pick<Profile, "output">): EffectiveCut {
  const own = template?.cut ? normalizeCut(template.cut) : null;
  if (!own) return { shape: profile.output.cut, cut: null, mmPerPx: null, sizeId: null };
  const F = profile.output.designFramePx;
  // Kenar payı tasarım alanına orantılı sabit (440'ta 1 px; varsayılan profil kesimiyle aynı): kendi kesimi olan
  // şablonun tasarım px şekli tasarım dilinin kesimine bağlı değildir (dilin kesimi değişince bu şablonun yerleşimi kaymaz).
  const { shape, mmPerPx } = cutShapePx(own, F, F * OWN_CUT_MARGIN_RATIO);
  return { shape, cut: own, mmPerPx, sizeId: cutSizeId(own) };
}

/** Görselin tasarım alanındaki kutusu: şablona özel kutu; yoksa kendi kesimi varsa kesim kutusu, yoksa profilin şablon kutusu. */
export function templateImageBox(template: Pick<Template, "imageBox"> & { cut?: TemplateCutInput | null }, profile: Pick<Profile, "output">): Box {
  if (template.imageBox) return template.imageBox;
  if (template.cut) return shapeBounds(effectiveCut(template, profile).shape);
  return profile.output.templateBox;
}

/**
 * Motorun kullandığı hazır geometri (templates paketi üretir, engine tüketir). Birim: tasarım alanı px,
 * maskeler `scale` kat çözünürlükte.
 */
export interface TemplateGeometry {
  key: string;
  framePx: number;
  /** Kesim şekli (px): şablonun kendi kesimi ya da profilin `output.cut`'ı (`effectiveCut`). */
  cut: Shape;
  /**
   * Fiziksel ölçek (mm / tasarım px) — şablonun kendi kesimi varsa; baskıda etiket bu ölçüde basılır (yuvaya
   * ölçeklenmez). Yoksa (null/eksik) eski kural: tasarım karesi yuva çapına / profil boyutuna ölçeklenir.
   */
  mmPerPx?: number | null;
  /** Yazının girebileceği pikseller (kesim içi ∧ alan ∧ kurdele dışı ∧ dekordan nefes payı kadar uzak). */
  free: Bitmap;
  /** Kesin dekor (çarpışma denetimi). */
  decoration: Bitmap;
  /** Her piksel satırı (tasarım px, `free` çözünürlüğünde) için serbest [x0, x1) aralıkları. */
  rows: Array<Array<[number, number]>>;
  /** Alan sınırı (px). */
  areaBounds: Box;
  /** Hedef yazı merkezi (px). */
  target: Point;
  /** Alan kullanıcı tarafından mı çizildi? */
  manualArea: boolean;
  /** Yazı alanındaki zeminin ortalama parlaklığı (0..1) ve koyu mu. */
  background: { luminance: number; dark: boolean };
  /** Şablonun tasarım alanında çizilecek hali için (önizleme). */
  imagePath: string;
  templateBox: Box;
}
