import { z } from "zod";
import { SampleQualitySchema } from "./builder.ts";
import { BoxSchema } from "./geometry.ts";

/**
 * Referans: kullanıcının son hâlini verdiği bitmiş bir etiket (`source`: nereden geldiği; "figma" = eski sistemden aktarılan). "Düzeltmelerimden öğren" ve kabul testleri
 * bunu hedef olarak kullanır. Program önerisi (varsa) aynı kayıtta saklanır ki fark çıkarılabilsin.
 * Konumlar tasarım alanı px'idir (440'lık frame; farklı boyuttaki frame'ler ortalanarak çevrilir).
 */
export const RefLineSchema = z.object({
  text: z.string(),
  /** Satırdaki baskın font (aile/stil) ve punto (px). */
  family: z.string(),
  style: z.string(),
  sizePx: z.number(),
  /** Satırdaki bütün segmentler (glif kuralları dahil). */
  segments: z.array(z.object({ text: z.string(), family: z.string(), style: z.string(), sizePx: z.number() })),
  ink: BoxSchema,
});
export type RefLine = z.infer<typeof RefLineSchema>;

/**
 * Kaynaklar: `figma` eski sistemden aktarılan, `migrated` taşınan, `printed` basılan, `uploaded` sitede yüklenen bitmiş
 * etiket görselinden ölçülen (tasarım dili oluşturucu, `services/builder/samples.ts`).
 *
 * Yüklenen örnekte (`uploaded`) sayılar görüntüden ölçülür ve ne kadarının ölçüldüğü kayıtta durur; ölçülmeyen hiçbir
 * değer tahminle doldurulmaz, `measureStyle` onu okumaz:
 * - `quality`: `exact` (şablon ayrıldı; kutular tasarım alanı px'i), `ink` (düz zemin; kutular görselin uzun kenarı
 *   tasarım alanına sığacak biçimde ölçeklenmiş sahte çerçevede: yalnız oranlar anlamlı), `none` (ayrılamadı: kutular
 *   ve puntolar 0, yalnız satır metinleri).
 * - `approx`: okunan satır sayısı mürekkep satırlarıyla eşleşmedi; satır ↔ kutu eşlemesi yok (kutular 0).
 * - `sizesKnown: false`: satırların fontu onaylanmadı; `sizePx` 0'dır (punto ölçülmedi).
 * Eski kayıtlarda bu alanlar yoktur: yapılandırılmış, tam ölçüm. Bu alanları okumayan tüketiciler (öğrenme koşusu,
 * motor denemesi) `quality` alanı olan kaydı kullanmamalıdır.
 */
export const ReferenceSchema = z.object({
  id: z.string(),
  languageId: z.string(),
  source: z.enum(["figma", "migrated", "printed", "uploaded"]),
  quality: SampleQualitySchema.optional(),
  approx: z.boolean().optional(),
  sizesKnown: z.boolean().optional(),
  orderNo: z.string().nullable(),
  quantity: z.number().nullable(),
  templateKey: z.string().nullable(),
  labelFramePx: z.number(),
  /** Müşteri metni (satır sonlarıyla değil, normal metin). */
  text: z.string(),
  /** Kullanıcının son hâli. */
  user: z.array(RefLineSchema).min(1),
  /** Programın önerisi (onaylanan varyasyon), varsa. */
  program: z.array(RefLineSchema).nullable(),
  programMeta: z.object({ variantId: z.string().nullable(), engine: z.string(), profileVersion: z.number().nullable() }).nullable(),
  /** Kullanıcının hâlinin yazı katmanı görseli (varsa, data klasörüne göre yol). */
  image: z.string().nullable(),
  /** Değerlendirme kümesi: train (öğrenmede kullanılır) / test (ayrılmış, yalnızca ölçüm). */
  split: z.enum(["train", "test"]),
  createdAt: z.string(),
});
export type Reference = z.infer<typeof ReferenceSchema>;
