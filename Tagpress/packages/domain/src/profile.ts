import { z } from "zod";
import { BoxSchema, ShapeSchema } from "./geometry.ts";
import { PRINT_DPI, PRINT_DPI_MAX, PRINT_DPI_MIN, ptToMm } from "./units.ts";

/**
 * Tasarım dili (profil), sürüm 2.
 *
 * İlkeler:
 * - Kullanıcının tarzı BURADADIR, kodda değil. Kod hiçbir font adı, bağlaç, eşik ya da sayfa adı bilmez.
 * - Her kavram tek yerde durur (eski sistemde satır aralığı, doluluk ve bağlaç boyutu 2-3 yerdeydi).
 * - Her alanın kimin tarafından uygulandığı `profile-docs.ts`'te yazılıdır: "motor" (kesin) ya da "ai" (yol gösterir).
 * - Oranlar: punto oranları ana satıra (primary) göre; boşluklar ilgili küçük satırın puntosuna göre;
 *   harf yüksekliği sınırı ve kurdele payı kesim çapına göre.
 */

export const FontKindSchema = z.enum(["script", "serif", "sans", "display"]);
export type FontKind = z.infer<typeof FontKindSchema>;

export const FontRoleSchema = z.enum(["primary", "secondary", "accent"]);
export type FontRole = z.infer<typeof FontRoleSchema>;

export const FontEntrySchema = z.object({
  /** Kararlı kimlik: "Aile/Stil" (ör. "Great Vibes/Regular"). Fontun aile ve stil adıyla aynıdır. */
  id: z.string().min(1),
  family: z.string().min(1),
  style: z.string().default("Regular"),
  /** Tasarım dilinin font klasöründeki dosya adı. */
  file: z.string().optional(),
  /** El yazısı mı? Bağlaç kayması ve harf aralığı kilidi bunu kullanır (ad tahmini YOK). */
  kind: FontKindSchema,
  /** Hangi satır rollerinde kullanılabilir. Boş = yalnızca glif kuralları için. */
  roles: z.array(FontRoleSchema).default([]),
  enabled: z.boolean().default(true),
  /** Metinde art arda bu sayıdan çok büyük harf varsa font o işte kullanılmaz. null = sınır yok. */
  maxUppercaseRun: z.number().int().positive().nullable().default(null),
  /** Harf aralığına dokunulmaz (el yazısında bitişik harfler bozulmasın). */
  lockTracking: z.boolean().default(false),
  /** AI'a ve kullanıcıya gösterilecek kısa not. */
  note: z.string().default(""),
});
export type FontEntry = z.infer<typeof FontEntrySchema>;

export const GlyphMatchSchema = z.discriminatedUnion("type", [
  /** Bu karakterlerden herhangi biri. */
  z.object({ type: z.literal("chars"), chars: z.string().min(1) }),
  /** Kelime başındaki büyük harf (isteğe bağlı olarak yalnızca şu harfler). */
  z.object({ type: z.literal("word-initial-upper"), letters: z.string().default("") }),
  /** Satır başındaki büyük harf. */
  z.object({ type: z.literal("line-initial-upper"), letters: z.string().default("") }),
  z.object({ type: z.literal("digits") }),
]);

/** Özel karakter kuralı. HER satırda ve HER rolde geçerlidir (eski hata: yalnızca birincil rolde çalışıyordu). */
export const GlyphRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  match: GlyphMatchSchema,
  fontId: z.string().min(1),
  /** Satır puntosuna oran. */
  scale: z.number().positive().default(1),
  /** Taban çizgisi kayması, em (pozitif = yukarı). */
  baselineShiftEm: z.number().default(0),
  /** Yalnızca satırın ana fontu bunlardan biriyse uygulanır. Boş = her fontta. */
  onlyWithFonts: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
export type GlyphRule = z.infer<typeof GlyphRuleSchema>;

export const TierSchema = z.enum(["primary", "secondary", "tertiary", "connector"]);
export type Tier = z.infer<typeof TierSchema>;

export const LabelSizeSchema = z.object({
  /** JSON'daki gösterimle eşleşen kimlik: "2.5", "3.8", "5.2". */
  id: z.string().min(1),
  cm: z.number().positive(),
  /** Etiket çerçevesinin kenarı (px). */
  framePx: z.number().positive(),
  /**
   * Şablon VE yazının bu boyutta ölçeklenme oranı (tasarım 440'lık alanda yapılır, sonra merkez etrafında
   * ölçeklenir). Yoksa `framePx / designFramePx` (kullanıcı kararı 2026-10-09: 2,5 / 5,2 cm orantılı büyür/küçülür).
   */
  contentScale: z.number().positive().optional(),
});
export type LabelSize = z.infer<typeof LabelSizeSchema>;

export const StickerSheetSchema = z.object({
  id: z.string().min(1),
  /** Sayfanın adı. */
  frameName: z.string().min(1),
  /** Ürün adında bunlardan biri geçerse bu sayfa (küçük/büyük harf duyarsız). Boş = varsayılan sayfa. */
  productKeywords: z.array(z.string()).default([]),
  shape: z.enum(["rect", "circle"]).default("rect"),
  /**
   * Sticker'ın baskıdaki en büyük ölçüsü, **pt** (1/72 inç; eski Figma sayfasının "px"i: 108 = 38,1 mm). Yuvarlakta
   * maxW çaptır. Tasarım (440'lık alanda) baskıda mürekkebi bu kutuya sığacak biçimde ölçeklenir
   * (`@tagpress/print` `stickerMmPerPx`); mm karşılığı `stickerSheetAreaMm`.
   */
  maxW: z.number().positive(),
  maxH: z.number().positive(),
  /** Eski Figma sayfasındaki yuva ölçüsü (pt; baskı masası kullanmaz, sayfa akışı baskı şablonundadır). */
  slotW: z.number().positive(),
  slotH: z.number().positive(),
  gap: z.number().min(0).default(0),
  padding: z.number().min(0).default(0),
});
export type StickerSheet = z.infer<typeof StickerSheetSchema>;

export const ProfileSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  name: z.string().min(1),
  description: z.string().default(""),

  output: z
    .object({
      designFramePx: z.number().positive().default(440),
      /** Kesim şekli, tasarım alanı px. */
      cut: ShapeSchema.default({ kind: "circle", cx: 219.82, cy: 219.82, r: 218.82 }),
      /** Şablon görselinin tasarım alanındaki yeri (px). */
      templateBox: BoxSchema.default({ x: 10, y: 10, w: 420, h: 420 }),
      sizes: z.array(LabelSizeSchema).default([
        { id: "2.5", cm: 2.5, framePx: 300 },
        { id: "3.8", cm: 3.8, framePx: 440 },
        { id: "5.2", cm: 5.2, framePx: 590 },
      ]),
      defaultSize: z.string().default("3.8"),
    })
    .prefault({}),

  fonts: z
    .object({
      list: z.array(FontEntrySchema).default([]),
      /** Bir etikette kaç font ailesi olabilir (glif kuralları sayılmaz). */
      mixing: z.enum(["single", "two", "free"]).default("single"),
    })
    .prefault({}),

  glyphRules: z.array(GlyphRuleSchema).default([]),

  sizing: z
    .object({
      /** Yazı, sığabileceği en büyük boyutun bu oranında. */
      fill: z.number().min(0.3).max(1).default(0.9),
      /** true: her tasarımda `fill` kullanılır; false: AI 'fill' önerebilir. */
      fillLocked: z.boolean().default(true),
      /** Satır sınıfı → ana satıra punto oranı. */
      tiers: z
        .object({
          primary: z.number().positive().default(1),
          secondary: z.number().positive().default(0.75),
          tertiary: z.number().positive().default(0.6),
          connector: z.number().positive().default(0.55),
        })
        .prefault({}),
      /** true: motor sınıf oranlarını uygular, AI yalnızca sınıf seçer. */
      tiersLocked: z.boolean().default(true),
      /** Bağlaca özel oran (anahtar küçük harf bağlaç). Yoksa `tiers.connector`. */
      connectorScales: z.record(z.string(), z.number().positive()).default({}),
      /** Büyük harf yüksekliği en fazla kesim çapının bu oranı. */
      maxCapHeight: z.number().min(0.02).max(0.6).default(0.18),
      minPt: z.number().positive().default(4),
      maxPt: z.number().positive().default(40),
      /** Dekora bırakılacak nefes payı, kesim çapına oran (kesim çizgisi payı: edgeMargin). */
      breathing: z.number().min(0).max(0.2).default(0.03),
      /** Kesim çizgisine bırakılacak pay, kesim çapına oran (dekor payından ayrı: el yazısı kesime dekordan daha uzak durur). */
      edgeMargin: z.number().min(0).max(0.2).default(0.03),
      initials: z
        .object({
          /** Yalnızca baş harf ("A & M") asla alt alta dizilmez. */
          oneLine: z.boolean().default(true),
          /** Yalnızca baş harf olan etikette harf yüksekliği sınırı. null = genel sınır. */
          maxCapHeight: z.number().min(0.02).max(0.8).nullable().default(null),
        })
        .prefault({}),
    })
    .prefault({}),

  spacing: z
    .object({
      align: z.enum(["center", "left", "right"]).default("center"),
      /** Satırlar arası GÖRÜNEN (mürekkep) boşluk, iki satırdan küçüğünün puntosuna oran. */
      inkGaps: z
        .object({
          normal: z.number().min(0).default(0.15),
          /** Son küçük satırdan (tarih/yer) önce. */
          beforeLast: z.number().min(0).default(0.25),
          /** Tek başına bağlaç satırının çevresinde. */
          connector: z.number().min(0).default(0.1),
        })
        .prefault({}),
      /** Son satır, üstündekinin bu oranından küçükse "son küçük satır" sayılır. */
      beforeLastRatio: z.number().min(0).max(1).default(0.85),
    })
    .prefault({}),

  connectors: z
    .object({
      /** Bağlaç sayılan kelime ve semboller (küçük harf). */
      words: z.array(z.string()).default(["&"]),
      /** Tek başına bağlaç satırı iki el yazısı ismin arasındaysa mürekkep ortasından şu kadar sağa (em, isim puntosu). */
      shiftEm: z.number().default(0),
      /** Satır başında/sonunda asılı kalan bağlacı kendi satırına al ("Elena" / "e Martina" olmaz). */
      separateDangling: z.boolean().default(true),
      /** Sembol bağlaçların (&, +) çevresine boşluk eklenebilir ("Mina&Ali" → "Mina & Ali"). */
      allowSymbolSpacing: z.boolean().default(true),
    })
    .prefault({}),

  lineBreaking: z
    .object({
      maxLineChars: z.number().int().positive().default(32),
      typicalLines: z.tuple([z.number().int().positive(), z.number().int().positive()]).default([1, 4]),
      maxLines: z.number().int().positive().default(6),
      nameOwnLine: z.boolean().default(true),
      /** Çift isimlerinde isim / bağlaç / isim dizilişi: her zaman, adaylardan biri, asla. */
      coupleStack: z.enum(["always", "option", "never"]).default("option"),
      keepShortGreetings: z.boolean().default(true),
      dateOwnLine: z.boolean().default(true),
      /** Müşterinin çift boşluk / satır sonu ile verdiği bölmeler. */
      customerBreaks: z.enum(["hint", "strict", "ignore"]).default("hint"),
      /** Tek başına satır olamayan kelimeler (edat, tanımlık), küçük harf. */
      noLoneWords: z.array(z.string()).default([]),
      /** Serbest açıklama (AI okur). */
      notes: z.string().default(""),
      /** Örnek bölmeler: AI'a gösterilir, kural yazmaktan daha güçlüdür. */
      examples: z.array(z.object({ text: z.string(), lines: z.array(z.string()).min(1) })).default([]),
    })
    .prefault({}),

  weight: z
    .object({
      /** stroke: yazının kendi rengiyle kontur (sahte kalın); real: fontun ağır stili; none: yok. */
      mode: z.enum(["stroke", "real", "none"]).default("stroke"),
      widthEm: z.number().min(0).max(0.1).default(0.01),
      minPx: z.number().min(0).default(0),
      maxPx: z.number().min(0).default(0),
      align: z.enum(["outside", "center"]).default("outside"),
    })
    .prefault({}),

  color: z
    .object({
      text: z.string().default("#000000"),
      onDark: z.string().default("#FFFFFF"),
      autoContrast: z.boolean().default(true),
    })
    .prefault({}),

  stickers: z
    .object({
      enabled: z.boolean().default(false),
      /** product-field: JSON'da ürün alanı VARSA (boş olsa bile) sticker. empty-template: şablon alanı boşsa sticker. */
      detect: z.enum(["product-field", "empty-template"]).default("empty-template"),
      sheets: z.array(StickerSheetSchema).default([]),
    })
    .prefault({}),

  ai: z
    .object({
      /** Ayarla söylenemeyen tarz (AI okur). Kesin kurallar buraya değil, ilgili ayara yazılır. */
      instructions: z.string().default(""),
    })
    .prefault({}),

  /** Baskı masası: sayfa planlama kuralları (fazlalık vb.). Sayfa geometrisi baskı şablonlarındadır (`print.ts`). */
  printing: z
    .object({
      /** Etiket: sipariş adedinin üstüne en az / en çok fazlalık. */
      labelExtraMin: z.number().int().min(0).default(5),
      labelExtraMax: z.number().int().min(0).default(10),
      /** Kalan adet tam sayfaya en çok bu kadar eksikse sayfa tamamlanır. */
      labelRoundUpMaxExtra: z.number().int().min(0).default(5),
      /** Fazlalık bu adet aralığında en azdan en çoğa ölçeklenir. */
      labelExtraScaleLow: z.number().int().min(0).default(20),
      labelExtraScaleHigh: z.number().int().min(1).default(150),
      /** Aynı tasarım (şablon) numaralı siparişler aynı karışık sayfaya girmez. */
      separateSameDesign: z.boolean().default(true),
      /** Sticker: en az / en çok fazlalık. */
      stickerExtraMin: z.number().int().min(0).default(5),
      stickerExtraMax: z.number().int().min(0).default(10),
      /** PNG çıktısı ve raster PDF çözünürlüğü (etiket sayfaları). */
      dpi: z.number().int().min(PRINT_DPI_MIN).max(PRINT_DPI_MAX).default(PRINT_DPI),
      /**
       * Sticker sayfalarının PNG / raster PDF çözünürlüğü. Sticker'ın fiziksel boyutu bundan BAĞIMSIZDIR (mm). Eski
       * 72 dpi ("1 px = 1 pt") değeri baskı için düşüktü; `upgradeProfileInput` ve taslak göç 150'nin altını kaldırır.
       */
      stickerDpi: z.number().int().min(PRINT_DPI_MIN).max(PRINT_DPI_MAX).default(PRINT_DPI),
      /**
       * Baskı sayfasındaki sipariş adı (hücre etiketi) deseni: {orderNo}, {quantity}, {template}, {size}, {seq} ve JSON
       * alan adları. Boşsa sipariş adı basılmaz. Eski adı `figma.frameName` (`upgradeProfileInput`, göç 8).
       */
      orderNamePattern: z.string().default("{orderNo}_{quantity}adet"),
    })
    .prefault({}),

  quality: z
    .object({
      /** Bu puanın altındaki varyasyon "kontrol et" işaretlenir. */
      suspectScore: z.number().min(0).max(100).default(70),
      /** En küçük satır bu puntonun altındaysa okunurluk uyarısı. */
      readableMinPt: z.number().positive().default(4.5),
    })
    .prefault({}),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileInput = z.input<typeof ProfileSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Eski adlı alanları bugünkü adına çevirir (şemadan ÖNCE çağrılır; şema bilinmeyen alanı sessizce atar).
 * Saklı profiller göç 8 ile çevrildi; bu işlev dışarıdan gelen eski veri (dil paketi, aktarım paketi, eski taslak) için.
 * - `printing.stickerDpi` < 150 (eski 72) silinir (varsayılan 300).
 * - `figma.frameName` → `printing.orderNamePattern`; yenisi zaten varsa da ESKİ ADLA gelen değer yazılır (eski adı
 *   yalnız eski bir istemci gönderir ve o anki niyeti odur; ör. MCP `taslak_yaz` yaması tabanla birleşince ikisi birden
 *   bulunur, yama kazanmalı). `figma` bölümü (ölü `maxShrink`, `maxShiftPx` dahil) atılır.
 * Girdiyi değiştirmez; çevrilecek bir şey yoksa aynı nesneyi döner.
 */
export function upgradeProfileInput(raw: unknown): unknown {
  return upgradeStickerDpi(upgradeFigma(raw));
}

/**
 * `printing.stickerDpi` 150'nin altındaysa (eski varsayılan 72 = "1 px 1 pt") silinir: şema varsayılanı (300) geçer.
 * Saklı profillerde aynı çeviriyi taslak göç `taslak-baski-olculeri.ts` yapar.
 */
function upgradeStickerDpi(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.printing)) return raw;
  const dpi = raw.printing.stickerDpi;
  if (typeof dpi !== "number" || dpi >= PRINT_DPI_MIN) return raw;
  const { stickerDpi: _old, ...printing } = raw.printing;
  return { ...raw, printing };
}

function upgradeFigma(raw: unknown): unknown {
  if (!isRecord(raw) || !("figma" in raw)) return raw;
  const { figma, ...rest } = raw;
  const frameName = isRecord(figma) ? figma.frameName : undefined;
  if (typeof frameName !== "string") return rest;
  const printing = rest.printing === undefined ? {} : rest.printing;
  if (!isRecord(printing)) return rest;
  return { ...rest, printing: { ...printing, orderNamePattern: frameName } };
}

/** Varsayılanları doldurulmuş boş profil. */
export function emptyProfile(name: string): Profile {
  return ProfileSchema.parse({ name });
}

/** Profil kayıt zarfı (sunucu). */
export const ProfileRecordSchema = z.object({
  id: z.string(),
  languageId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "published"]),
  data: ProfileSchema,
  note: z.string().default(""),
  createdAt: z.string(),
});
export type ProfileRecord = z.infer<typeof ProfileRecordSchema>;

/** Kesim çapı (px): daire/elipste genişlik, dikdörtgende kısa kenar. Oranlar buna göre. */
export function cutDiameter(p: Profile): number {
  const c = p.output.cut;
  switch (c.kind) {
    case "circle":
      return 2 * c.r;
    case "ellipse":
      return 2 * Math.min(c.rx, c.ry);
    case "rect":
      return Math.min(c.w, c.h);
    case "polygon": {
      const xs = c.points.map((q) => q.x);
      const ys = c.points.map((q) => q.y);
      return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
  }
}

/** Punto → tasarım alanı px. Etiketin fiziksel çapı varsayılan boyuttan gelir (tasarım karesi = etiket çapı). */
export function ptToPx(p: Profile, pt: number): number {
  const size = p.output.sizes.find((s) => s.id === p.output.defaultSize) ?? p.output.sizes[0];
  const diameterMm = (size?.cm ?? 3.8) * 10;
  return (ptToMm(pt) * p.output.designFramePx) / diameterMm;
}

/** Sticker sayfasının baskıdaki en büyük ölçüsü (mm; profilde pt). Yuvarlakta `wMm` çaptır (`hMm` = `wMm`). */
export function stickerSheetAreaMm(sheet: Pick<StickerSheet, "shape" | "maxW" | "maxH">): { wMm: number; hMm: number } {
  const wMm = ptToMm(sheet.maxW);
  return { wMm, hMm: sheet.shape === "circle" ? wMm : ptToMm(sheet.maxH) };
}
