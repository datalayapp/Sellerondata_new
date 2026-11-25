import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import {
  BUILDER_HOLDOUT,
  BUILDER_SAMPLE_LIMITS,
  type Box,
  BoxSchema,
  type FontEntry,
  type Reference,
  ReferenceSchema,
  type Sample,
  type SampleLine,
  SampleLineSchema,
  type SampleQuality,
  SampleQualitySchema,
  holdoutCount,
} from "@tagpress/domain";
import { type RgbImage, alignTemplate, gapsAbove, inkLines, plainInk, templateInk } from "@tagpress/templates";
import { type FontRegistry, shapeRun } from "@tagpress/typeset";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { writeAtomic } from "../../util/files.ts";
import { PNG, safeJoin } from "../../util/safe-path.ts";

/**
 * Yüklenen bitmiş etiketler (tasarım dili oluşturucu, plan §4.4): güvenli kabul, deterministik ölçüm, okuma ile
 * eşleme, ayrılmış küme ve ölçüm özetine katılan referans biçimi. Depolamadan bağımsız saf çekirdek (girdi bayt +
 * seçenekler; çıktı ölçüm kaydı + yazılacak dosya) ve ince bir dosya katmanı (`SampleFiles`). Tablo ve uçlar C3'te.
 *
 * Değişmezler: AI piksel koordinatı üretmez (kutular `@tagpress/templates` `ink-lines` ile ölçülür; AI yalnız satır
 * metnini okur, `SampleTranscriber`); ölçülemeyen değer boş kalır (kalite `none` → hiçbir sayı); font adı üretilmez
 * (kullanıcı/onay sonradan ekler); okunan metin olduğu gibi saklanır (müşteri metni).
 */

// ================================================================ kabul (yükleme)

/** Kabul sınırları. Piksel sınırı dekompresyon bombasına karşıdır (sharp açmadan önce başlıktan denetler). */
export const SAMPLE_ACCEPT_LIMITS = {
  maxFileBytes: BUILDER_SAMPLE_LIMITS.maxFileBytes,
  /** Kaynak görselde en çok piksel (ör. 8000 × 5000). */
  maxInputPixels: 40_000_000,
  /** En kısa kenar (px): daha küçüğünde yazı ölçülemez. */
  minEdgePx: 64,
  storeEdgePx: BUILDER_SAMPLE_LIMITS.storeEdgePx,
} as const;

export type SampleRejectCode = "sample-type" | "sample-too-large" | "sample-unreadable";

export type SampleAcceptResult =
  | {
      ok: true;
      /** Saklanacak görsel: yeniden kodlanmış PNG (EXIF ve diğer üst veri yok, yön uygulanmış, beyaza düzleştirilmiş). */
      png: Buffer;
      w: number;
      h: number;
      /** İçerikten bulunan kaynak biçim (uzantıya bakılmaz). */
      format: "png" | "jpeg" | "pdf";
    }
  | { ok: false; code: SampleRejectCode; params?: Record<string, string | number> };

/** İçerik imzasından biçim (uzantı ve istemcinin bildirdiği tür yok sayılır). */
export function sniffFormat(bytes: Uint8Array): "png" | "jpeg" | "pdf" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf";
  return null;
}

/** Kurulu sharp PDF okuyabiliyor mu (bugünkü önceden derlenmiş sharp'ta hayır: libvips poppler/pdfium'suz). */
export const PDF_SUPPORTED = Boolean((sharp.format as unknown as Record<string, { input?: { buffer?: boolean } } | undefined>).pdf?.input?.buffer);

/**
 * Yüklenen dosyayı güvenilmez girdi olarak kabul eder: boyut, içerik imzası, piksel sınırı; sonra yeniden kodlar
 * (yön uygulanır, üst veri atılır, en uzun kenar `storeEdgePx`, beyaza düzleştirilir, PNG). PDF'de yalnız ilk sayfa;
 * sharp PDF okuyamıyorsa açık ret (`sample-type`, `format: "pdf"`).
 */
export async function acceptSampleFile(bytes: Buffer, limits: Partial<Record<keyof typeof SAMPLE_ACCEPT_LIMITS, number>> = {}): Promise<SampleAcceptResult> {
  const L = { ...SAMPLE_ACCEPT_LIMITS, ...limits };
  if (bytes.length > L.maxFileBytes) return { ok: false, code: "sample-too-large", params: { maxBytes: L.maxFileBytes } };
  const format = sniffFormat(bytes);
  if (!format) return { ok: false, code: "sample-type" };
  if (format === "pdf" && !PDF_SUPPORTED) return { ok: false, code: "sample-type", params: { format: "pdf" } };
  const input = { limitInputPixels: L.maxInputPixels, failOn: "error" as const, ...(format === "pdf" ? { page: 0, pages: 1, density: 200 } : {}) };
  let meta: Metadata;
  try {
    // Yalnız başlık okunur (çözülmez): piksel sınırı burada, açmadan önce denetlenir.
    meta = await sharp(bytes, { ...input, limitInputPixels: false }).metadata();
  } catch {
    return { ok: false, code: "sample-unreadable" };
  }
  const expected = format === "jpeg" ? "jpeg" : format;
  if (meta.format !== expected) return { ok: false, code: "sample-type" };
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;
  if (w0 * h0 > L.maxInputPixels) return { ok: false, code: "sample-too-large", params: { maxPixels: L.maxInputPixels } };
  if (Math.min(w0, h0) < L.minEdgePx) return { ok: false, code: "sample-unreadable", params: { minEdgePx: L.minEdgePx } };
  try {
    const { data, info } = await sharp(bytes, { ...input, animated: false })
      .rotate()
      .resize({ width: L.storeEdgePx, height: L.storeEdgePx, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .png()
      .toBuffer({ resolveWithObject: true });
    if (Math.min(info.width, info.height) < Math.min(L.minEdgePx, 16)) return { ok: false, code: "sample-unreadable" };
    return { ok: true, png: data, w: info.width, h: info.height, format };
  } catch {
    return { ok: false, code: "sample-unreadable" };
  }
}

// ================================================================ okuma (AI) portu

/**
 * Satır okuma portu (Haiku `transcribe`; gerçek bağlantı C1/C3'te, `@tagpress/ai` `transcribe` ile uyumlu biçim).
 * Girdi: en uzun kenarı `transcribeEdgePx` olan PNG. Çıktı: yukarıdan aşağı okunan satırlar. AI yalnız metin üretir.
 */
export interface SampleTranscriber {
  transcribe(png: Buffer, opts: { signal?: AbortSignal }): Promise<{ ok: boolean; lines: string[] }>;
}

/** Okuma için görsel (en uzun kenar `transcribeEdgePx`). */
export async function transcribePng(png: Buffer): Promise<Buffer> {
  const E = BUILDER_SAMPLE_LIMITS.transcribeEdgePx;
  return sharp(png).resize({ width: E, height: E, fit: "inside", withoutEnlargement: true }).png().toBuffer();
}

// ================================================================ ölçüm

/** Örnek görseli pikseli → tasarım alanı px: `x' = x · kx + dx`, `y' = y · ky + dy` (yalnız `exact`). */
export const SampleFrameSchema = z.object({ kx: z.number(), ky: z.number(), dx: z.number(), dy: z.number() });
export type SampleFrame = z.infer<typeof SampleFrameSchema>;

/** Ölçülemeyen ya da kalitenin düşme nedeni (arayüz sözlüğünde `builder:measure.<kod>`). */
export const SAMPLE_MEASURE_REASONS = [
  /** Şablon hizalanamadı (başka şablon, döndürülmüş ya da kırpılmış görsel). */
  "template-mismatch",
  /** Şablonda hizalanacak dekor yok (boş görsel). */
  "template-featureless",
  /** Zemin düz değil (fotoğraf, doku, degrade). */
  "not-plain",
  /** Mürekkep tek renk değil ya da kalın dolu şekiller var: dekor sayılır. */
  "decoration",
  "no-ink",
  "too-much-ink",
] as const;
export type SampleMeasureReason = (typeof SAMPLE_MEASURE_REASONS)[number];

/**
 * Saklanan ölçüm kaydı (C3: `design_samples.lines` JSON'u ya da ayrı sütun). `lines` arayüzün gördüğü satırlardır
 * (okuma ve kullanıcı düzeltmesiyle değişir); `ink` ölçülen mürekkep kutuları (yeniden eşleme için hep saklanır).
 */
export const SampleMeasurementSchema = z.object({
  v: z.literal(1),
  quality: SampleQualitySchema,
  approx: z.boolean(),
  reason: z.enum(SAMPLE_MEASURE_REASONS).nullable(),
  templateKey: z.string().nullable(),
  templateMatch: z.enum(["user", "uploaded-blank", "auto"]).nullable(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  /** Mürekkep satır kutuları (saklanan görsel px, yukarıdan aşağı). `none`'da boş. */
  ink: z.array(BoxSchema),
  lines: z.array(SampleLineSchema),
  /** Okuma (AI) sonucu, olduğu gibi; okunmadıysa null. */
  transcript: z.array(z.string()).nullable(),
  frame: SampleFrameSchema.nullable(),
  /** Yazı bloğu (saklanan görsel px). */
  block: BoxSchema.nullable(),
  /** Blok / kesim çapı ve blok merkezi (tasarım px); yalnız `exact`. */
  fill: z.object({ widthOfCut: z.number(), heightOfCut: z.number(), center: z.object({ x: z.number(), y: z.number() }) }).nullable(),
  diagnostics: z.record(z.string(), z.unknown()),
});
export type SampleMeasurement = z.infer<typeof SampleMeasurementSchema>;

/** Hizalanacak şablon: görsel dosyasının baytları ve tasarım alanındaki kutusu (`imageBoxOf(template, profile)`). */
export interface SampleTemplateInput {
  /** Şablon anahtarı; yüklenen boş şablonda null. */
  key: string | null;
  png: Buffer;
  /** Şablon görselinin tasarım alanındaki kutusu (px). Yüklenen boş şablon bütün etiketse `{0,0,F,F}`. */
  imageBox: Box;
  match: "user" | "uploaded-blank" | "auto";
}

export interface AnalyzeSampleInput {
  /** Saklanan görsel (`acceptSampleFile` çıktısı). */
  png: Buffer;
  /** Kullanıcının seçtiği ya da yüklediği şablon. */
  template?: SampleTemplateInput | null;
  /** Şablon verilmediyse denenecek adaylar (otomatik eşleşme; ilk tutan değil en iyi hizalanan). */
  candidates?: readonly SampleTemplateInput[];
  /** Profilden: tasarım alanı ve kesim çapı (`cutDiameter(profile)`, tasarım px). */
  designFramePx: number;
  cutDiameterPx: number;
  transcriber?: SampleTranscriber | null;
  signal?: AbortSignal;
}

async function toRgb(png: Buffer): Promise<RgbImage> {
  const { data, info } = await sharp(png).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Bir örneği ölçer (deterministik; okuma portu verilirse satır metinleri de okunur).
 *  1. Şablon (verilen ya da adaylar): hizala → tutarsa şablon + mürekkep ayrımı → `exact` (çerçeve, doluluk).
 *  2. Tutmazsa ya da şablon yoksa: düz zemin eşiği → `ink` (yalnız oranlar).
 *  3. İkisi de değilse `none`: hiçbir kutu ve sayı yazılmaz; okunan satırlar yalnız niteliksel kullanılır.
 */
export async function analyzeSample(input: AnalyzeSampleInput): Promise<SampleMeasurement> {
  const t0 = Date.now();
  const sample = await toRgb(input.png);
  const W = sample.width;
  const H = sample.height;
  const F = input.designFramePx;
  const diagnostics: Record<string, unknown> = {};
  let quality: SampleQuality = "none";
  let reason: SampleMeasureReason | null = null;
  let mask: Uint8Array | null = null;
  let frame: SampleFrame | null = null;
  let chosen: SampleTemplateInput | null = null;

  const tried = input.template ? [input.template] : [...(input.candidates ?? [])];
  let best: { t: SampleTemplateInput; a: ReturnType<typeof alignTemplate>; T: RgbImage } | null = null;
  for (const t of tried) {
    if (input.signal?.aborted) throw new Error("aborted");
    const T = await toRgb(t.png);
    // Tahmin: örnek = bütün etiket (tasarım alanı), şablon kendi kutusunda.
    const s0 = (Math.max(W, H) / F) * (t.imageBox.w / T.width);
    const a = alignTemplate(sample, T, { guesses: [{ scale: s0, dx: t.imageBox.x * (Math.max(W, H) / F), dy: t.imageBox.y * (Math.max(W, H) / F) }] });
    if (!best || (a.ok && !best.a.ok) || (a.ok === best.a.ok && a.cost < best.a.cost)) best = { t, a, T };
  }
  if (best) {
    diagnostics.alignment = { key: best.t.key, scale: r2(best.a.scale * 1e4) / 1e4, dx: r2(best.a.dx), dy: r2(best.a.dy), mismatch: r2(best.a.mismatch * 1e3) / 1e3, cost: r2(best.a.cost * 1e3) / 1e3, ok: best.a.ok };
    if (best.a.ok) {
      const sep = templateInk(sample, best.T, best.a);
      diagnostics.coverage = r2(sep.coverage * 1e4) / 1e4;
      if (!sep.coverage) reason = "no-ink";
      else if (sep.coverage > 0.35) reason = "too-much-ink";
      else {
        quality = "exact";
        mask = sep.mask;
        chosen = best.t;
        const kx = best.t.imageBox.w / (best.T.width * best.a.scale);
        const ky = best.t.imageBox.h / (best.T.height * best.a.scale);
        frame = { kx, ky, dx: best.t.imageBox.x - best.a.dx * kx, dy: best.t.imageBox.y - best.a.dy * ky };
      }
    } else reason = best.a.reason === "featureless" ? "template-featureless" : "template-mismatch";
  }
  if (!mask) {
    const p = plainInk(sample);
    diagnostics.plain = { paperShare: r2(p.paperShare * 1e3) / 1e3, texture: r2(p.texture * 1e4) / 1e4, multiColor: r2(p.multiColor * 1e3) / 1e3, thick: r2(p.thick * 1e3) / 1e3, coverage: r2(p.coverage * 1e4) / 1e4, reason: p.reason };
    if (p.plain) {
      quality = "ink";
      mask = p.mask;
    } else {
      reason ??= p.reason === "textured" || p.reason === "not-plain" ? "not-plain" : p.reason === "no-ink" ? "no-ink" : p.reason === "too-much-ink" ? "too-much-ink" : "decoration";
    }
  }

  let ink: Box[] = [];
  let block: Box | null = null;
  if (mask) {
    const found = inkLines(mask, W, H);
    diagnostics.lines = { found: found.lines.length, dropped: found.dropped, splits: found.splits };
    if (found.lines.length) {
      ink = found.lines.map((l) => l.box);
      block = found.block;
    } else {
      quality = "none";
      reason ??= "no-ink";
      frame = null;
    }
  }
  if (quality !== "exact") frame = null;

  let transcript: string[] | null = null;
  if (input.transcriber) {
    if (input.signal?.aborted) throw new Error("aborted");
    const read = await input.transcriber.transcribe(await transcribePng(input.png), input.signal ? { signal: input.signal } : {});
    transcript = read.ok ? read.lines.map((l) => l.trim()).filter(Boolean) : null;
  }
  const paired = pairLines(quality, ink, transcript ? transcript.map((text) => ({ text, fontFile: null, source: "transcribe" as const })) : null);
  diagnostics.ms = Date.now() - t0;
  const keepTemplate = input.template ?? (quality === "exact" ? chosen : null);
  return {
    v: 1,
    quality,
    approx: paired.approx,
    reason: quality === "exact" ? null : reason,
    templateKey: keepTemplate?.key ?? null,
    templateMatch: keepTemplate?.match ?? null,
    w: W,
    h: H,
    ink,
    lines: paired.lines,
    transcript,
    frame,
    block: quality === "none" ? null : block,
    fill: quality === "exact" && frame && block ? fillOf(block, frame, input.cutDiameterPx) : null,
    diagnostics,
  };
}

function fillOf(block: Box, f: SampleFrame, D: number): NonNullable<SampleMeasurement["fill"]> {
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    widthOfCut: r4((block.w * f.kx) / D),
    heightOfCut: r4((block.h * f.ky) / D),
    center: { x: r2((block.x + block.w / 2) * f.kx + f.dx), y: r2((block.y + block.h / 2) * f.ky + f.dy) },
  };
}

/**
 * Mürekkep kutularıyla satır metinlerini sırayla eşler. Sayılar farklıysa `approx` (eşleme güvenilmez: fazla metne
 * kutu yok, fazla kutuya metin yok). `none`'da kutu yoktur: yalnız metinler, `approx` anlamsızdır (false).
 */
export function pairLines(
  quality: SampleQuality,
  ink: readonly Box[],
  texts: ReadonlyArray<{ text: string; fontFile: string | null; source: "transcribe" | "user" }> | null,
): { lines: SampleLine[]; approx: boolean } {
  if (quality === "none") {
    return { lines: (texts ?? []).map((t) => ({ text: t.text, ink: null, gapAbovePx: null, fontFile: t.fontFile, textSource: t.source })), approx: false };
  }
  const gaps = gapsAbove(ink.map((box) => ({ box, mass: 0 })));
  const n = Math.max(ink.length, texts?.length ?? 0);
  const lines: SampleLine[] = [];
  for (let i = 0; i < n; i++) {
    const box = ink[i] ?? null;
    const t = texts?.[i] ?? null;
    lines.push({ text: t?.text ?? null, ink: box, gapAbovePx: box ? (gaps[i] ?? null) : null, fontFile: t?.fontFile ?? null, textSource: t ? t.source : null });
  }
  return { lines, approx: texts !== null && texts.length !== ink.length };
}

/**
 * Kullanıcı düzeltmesi (`patchSample { lines }`): metinler ve fontlar sırayla yeniden eşlenir; sayı mürekkep
 * satırlarından farklıysa `approx`. Kutular değişmez (ölçümden).
 */
export function applyUserLines(m: SampleMeasurement, lines: ReadonlyArray<{ text: string; fontFile?: string | null }>): SampleMeasurement {
  const paired = pairLines(
    m.quality,
    m.ink,
    lines.map((l) => ({ text: l.text, fontFile: l.fontFile ?? null, source: "user" as const })),
  );
  return { ...m, lines: paired.lines, approx: paired.approx };
}

/** Ölçümden arayüzün `Sample` alanları (kimlik, ad, adres, ayrılmış küme ve dışarıda bırakma C3'te). */
export function sampleFields(m: SampleMeasurement): Pick<Sample, "w" | "h" | "status" | "quality" | "approx" | "templateKey" | "templateMatch" | "lines"> {
  return {
    w: m.w,
    h: m.h,
    status: m.quality === "none" ? "qualitative" : "measured",
    quality: m.quality,
    approx: m.approx,
    templateKey: m.templateKey,
    templateMatch: m.templateMatch,
    lines: m.lines,
  };
}

// ================================================================ ayrılmış küme

/** Ayrılmış küme girdisi. `split`: bugünkü atama; `shown`: örnek modele gösterildi mi (`shown_at`). */
export interface SplitInput {
  id: string;
  createdAt: string;
  quality: SampleQuality | null;
  excluded?: boolean;
  split?: "train" | "test" | null;
  shown?: boolean;
}

/**
 * Ayrılmış küme (plan §4.4, `BUILDER_HOLDOUT`). Ölçülebilir (`exact` / `ink`, dışarıda bırakılmamış) örnekler yükleme
 * sırasına (eşitlikte kimliğe) dizilir; hedef `holdoutCount(n)` test örneğidir.
 *
 * Kural: MODELE BİR KEZ GÖSTERİLMİŞ ÖRNEK ASLA `test` OLMAZ (`shown`); `test` yalnız hiç gösterilmemiş örneklerden
 * seçilir. Bu yüzden hedefe her zaman ulaşılmayabilir (az test, ama hiçbiri modelin gördüğü örnek değil).
 *  1. Bugün `test` olan ve gösterilmemiş örnekler test kalır (kayma yok); hedeften fazlaysa en yeniler `train`e geçer.
 *  2. Eksik varsa gösterilmemiş adaylardan seçilir: önce düzenli aralık konumundakiler (`⌊(i+1)·oran⌋ > ⌊i·oran⌋`,
 *     %25'te her 4. örnek; ilk atamada bugünkü davranışın aynısı), sonra en yeniden eskiye.
 * Deterministik. Ölçülemeyen, dışarıda bırakılan ve eşiğin altındaki örnekler null.
 */
export function assignSplits(samples: ReadonlyArray<SplitInput>): Map<string, "train" | "test" | null> {
  const out = new Map<string, "train" | "test" | null>(samples.map((s) => [s.id, null]));
  const measurable = samples
    .filter((s) => (s.quality === "exact" || s.quality === "ink") && !s.excluded)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const target = holdoutCount(measurable.length);
  if (!target) return out;
  const ratio = BUILDER_HOLDOUT.ratio;
  const onGrid = (i: number) => Math.floor((i + 1) * ratio + 1e-9) > Math.floor(i * ratio + 1e-9);
  const test = new Set(measurable.filter((s) => s.split === "test" && !s.shown).slice(0, target).map((s) => s.id));
  if (test.size < target) {
    const free = measurable.map((s, i) => ({ s, i })).filter(({ s }) => !s.shown && !test.has(s.id));
    const ordered = [...free.filter((x) => onGrid(x.i)), ...free.filter((x) => !onGrid(x.i)).reverse()];
    for (const { s } of ordered) {
      if (test.size >= target) break;
      test.add(s.id);
    }
  }
  for (const s of measurable) out.set(s.id, test.has(s.id) ? "test" : "train");
  return out;
}

// ================================================================ ölçüm özetine katılım (referans biçimi)

/** Onaylanan fontun ölçüsü: metnin 1 px puntodaki mürekkep yüksekliği ve font adı; ölçülemezse null. */
export type SampleFontMetrics = (text: string, fontFile: string) => { family: string; style: string; inkEm: number } | null;

/** Font kaydıyla ölçü: metin 100 px'te şekillendirilir; fontta olmayan karakter varsa ölçülmez (null). */
export function fontMetricsFrom(fonts: FontRegistry, entries: readonly FontEntry[]): SampleFontMetrics {
  return (text, fontFile) => {
    const e = entries.find((x) => x.file === fontFile);
    if (!e) return null;
    try {
      const run = shapeRun(fonts, text, { fontId: e.id, sizePx: 100 });
      if (!run.ink || run.notdef > 0) return null;
      const em = (run.ink.y1 - run.ink.y0) / 100;
      return em > 0 ? { family: e.family, style: e.style, inkEm: em } : null;
    } catch {
      return null;
    }
  };
}

export interface SampleReferenceInput {
  id: string;
  languageId: string;
  createdAt: string;
  split: "train" | "test" | null;
  measurement: SampleMeasurement;
  /** Örneğin varsayılan fontu (`Sample.fontFile`); satırda yoksa bu. */
  fontFile: string | null;
  designFramePx: number;
  /** Onaylanan fontların ölçüsü; yoksa puntolar ölçülmez (`sizesKnown: false`). */
  fonts?: SampleFontMetrics | null;
}

const ZERO: Box = { x: 0, y: 0, w: 0, h: 0 };

/**
 * Yüklenen örneği ölçüm özetine (`measureStyle`) katılacak referans biçimine çevirir (`source: "uploaded"`).
 * - `exact`: kutular tasarım alanına çevrilir (çerçeve). `ink`: uzun kenarı tasarım alanına sığan sahte çerçeve (yalnız
 *   oranlar anlamlıdır; `measureStyle` çerçeveye bağlı değerleri okumaz).
 * - Punto yalnız font onaylıysa ölçülür: mürekkep yüksekliği / fontun o metindeki 1 px mürekkep yüksekliği (kontur
 *   payı bilinmez; ayrıca dikkate alınmaz). Bir satırda bile font yoksa `sizesKnown: false` ve puntolar 0.
 * - `none` ve `approx`: kutular 0, yalnız metin. Metni olmayan örnek null (katacak bir şey yok).
 */
export function sampleReference(input: SampleReferenceInput): Reference | null {
  const m = input.measurement;
  const texts = m.lines.filter((l): l is SampleLine & { text: string } => typeof l.text === "string" && l.text.trim() !== "");
  if (!texts.length) return null;
  const numeric = m.quality !== "none" && !m.approx;
  const F = input.designFramePx;
  const k = Math.max(m.w, m.h);
  const frame: SampleFrame | null = !numeric ? null : m.quality === "exact" && m.frame ? m.frame : { kx: F / k, ky: F / k, dx: 0, dy: 0 };
  const toDesign = (b: Box): Box => (frame ? { x: b.x * frame.kx + frame.dx, y: b.y * frame.ky + frame.dy, w: b.w * frame.kx, h: b.h * frame.ky } : ZERO);
  const sized = texts.map((l) => {
    const file = l.fontFile ?? input.fontFile;
    const box = numeric && l.ink ? toDesign(l.ink) : ZERO;
    const met = numeric && file && l.ink && input.fonts ? input.fonts(l.text, file) : null;
    return { l, box, met };
  });
  const sizesKnown = numeric && sized.every((s) => s.met !== null);
  const user = sized.map(({ l, box, met }) => {
    const family = sizesKnown ? met!.family : "";
    const style = sizesKnown ? met!.style : "";
    const sizePx = sizesKnown ? Math.round((box.h / met!.inkEm) * 100) / 100 : 0;
    return { text: l.text, family, style, sizePx, segments: [{ text: l.text, family, style, sizePx }], ink: box };
  });
  return ReferenceSchema.parse({
    id: input.id,
    languageId: input.languageId,
    source: "uploaded",
    quality: m.quality,
    approx: m.approx,
    sizesKnown,
    orderNo: null,
    quantity: null,
    templateKey: m.templateKey,
    labelFramePx: F,
    text: texts.map((l) => l.text).join(" "),
    user,
    program: null,
    programMeta: null,
    image: null,
    split: input.split ?? "train",
    createdAt: input.createdAt,
  });
}

// ================================================================ dosya katmanı

const SAMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

/**
 * Örnek görselleri: bir oturumun örnek klasörü (`…/tasarim-oturumlari/<oturum>/ornekler/`, kökü çağıran verir).
 * Dosya adı yalnız örnek kimliğinden kurulur (`<id>.png`); yol `safeJoin` ile denetlenir.
 */
export class SampleFiles {
  constructor(private readonly root: string) {}

  /** Örneğin dosya yolu; kimlik geçersizse ya da yol kökten kaçıyorsa hata. */
  path(id: string): string {
    const file = SAMPLE_ID.test(id) ? safeJoin(this.root, `${id}.png`, { ext: PNG }) : null;
    if (!file) throw new Error(`Geçersiz örnek kimliği: ${JSON.stringify(id)}`);
    return file;
  }

  async write(id: string, png: Buffer): Promise<string> {
    const file = this.path(id);
    await writeAtomic(file, png);
    return file;
  }

  async read(id: string): Promise<Buffer | null> {
    const file = this.path(id);
    return existsSync(file) ? readFile(file) : null;
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}
