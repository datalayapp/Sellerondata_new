import { z } from "zod";
import { type Box, BoxSchema, type Point } from "./geometry.ts";
import { LineRoleSchema } from "./intent.ts";
import type { LayoutResult, PlacedLine } from "./layout.ts";
import { TierSchema } from "./profile.ts";

/**
 * Hafif düzeltme (kullanıcı isteği 2026-10-09): üretilen varyasyonda yazı bloğunu elle kaydırma ve
 * büyütme/küçültme. AI yok, metin değişmez; yalnızca motorun yerleşimi doğrusal olarak dönüştürülür.
 *
 * Birim: tasarım alanı px (profil `output.designFramePx`, varsayılan 440). Dönüşüm sırası:
 *  1. (isteğe bağlı) satır düzeltmesi: satır, KENDİ özgün mürekkep kutusunun merkezi etrafında `scale`
 *     ile ölçeklenir, sonra (dx, dy) kaydırılır;
 *  2. blok düzeltmesi: bütün yazı, özgün (düzeltmesiz) blok mürekkep kutusunun merkezi `c0` etrafında
 *     `scale` ile ölçeklenir, sonra (dx, dy) kaydırılır.
 * Yani bir nokta için: p' = c0 + scale · (p − c0) + (dx, dy). Arayüz bunu CSS'te
 * `transform-origin: c0; transform: translate(dx, dy) scale(scale)` olarak birebir uygulayabilir.
 *
 * Kalınlık (2. sürüm): `strokePx` kontur FARKIDIR (tasarım px; blokta bütün yazıya, satırda o satıra eklenir).
 * Satırın etkin konturu = max(0, temel · blokÖlçeği · satırÖlçeği + blok.strokePx + satır.strokePx); temel kontur
 * satırın `strokePx`'i, yoksa yerleşimin `strokePx`'i (bkz. `effectiveLineStroke`). Kontur yazının kendi rengiyle,
 * profilin `weight.align` hizasıyla çizilir; profil kalınlığı kapalı (`weight.mode: "none"`) olsa da uygulanır.
 *
 * Metin ve font (3. sürüm, `edits`): kullanıcı bir satırın metnini ELLE değiştirebilir ya da satırın (veya satır içindeki
 * bir parçanın) fontunu tasarım dilinin font kataloğundan seçebilir. Bu bir otomatik adım değildir; işin müşteri metni
 * (`jobs.text`) DEĞİŞMEZ, düzenleme yalnızca bu varyasyona aittir ve düzeltmeyle birlikte geri alınır/kaldırılır.
 * Motor düzenlenen satırı aynı puntoda yeniden şekillendirir (glif kuralları, yedek font; fontta olmayan karakter
 * yedek fontla basılır, silinmez), taban çizgisini korur ve profil hizasına göre eski yerine oturtur. Sonuç `placed`
 * olarak saklanır (sunucu doldurur), böylece önizleme, baskı ve öğrenme yazı tipine erişmeden aynı satırı
 * kullanır. Dönüşüm sırası: önce düzenlenen satırlar yerleşimdeki satırların yerine geçer, sonra yukarıdaki
 * satır/blok dönüşümleri uygulanır. Blok ölçeğinin merkezi DÜZENLENMEMİŞ yerleşimin merkezidir (metin değişince
 * blok kaymaz).
 */

/** Makul sınırlar: çok uç değerler hatalı sürükleme sayılır. */
export const ADJUST_LIMITS = { scaleMin: 0.5, scaleMax: 1.5, shiftMaxPx: 500, maxLines: 50, strokeMaxPx: 20 } as const;

const shift = z.number().min(-ADJUST_LIMITS.shiftMaxPx).max(ADJUST_LIMITS.shiftMaxPx);
const factor = z.number().min(ADJUST_LIMITS.scaleMin).max(ADJUST_LIMITS.scaleMax);
/** Kontur farkı (tasarım px), −20..+20. */
const strokeDelta = z.number().min(-ADJUST_LIMITS.strokeMaxPx).max(ADJUST_LIMITS.strokeMaxPx);

/** Kontur hizası (profil `weight.align`). */
export type StrokeAlign = "outside" | "center";

export const LineAdjustSchema = z.object({
  /** Yerleşimdeki satır sırası (0'dan). */
  index: z.number().int().min(0).max(ADJUST_LIMITS.maxLines - 1),
  dx: shift.default(0),
  dy: shift.default(0),
  scale: factor.default(1),
  /** Bu satır için ek kontur farkı (bloğunkine eklenir). Yok = 0. */
  strokePx: strokeDelta.optional(),
});
export type LineAdjust = z.infer<typeof LineAdjustSchema>;

/** Elle düzenleme sınırları. */
export const EDIT_LIMITS = { textMax: 500, spansMax: 50, fontIdMax: 200 } as const;

/** Motorun yerleştirdiği satır (`PlacedLine` ile aynı biçim; düzenlenen satırın kaydı için). */
export const PlacedRunSchema = z.object({
  text: z.string(),
  fontId: z.string(),
  family: z.string(),
  style: z.string(),
  sizePx: z.number(),
  baselineShiftPx: z.number(),
  fallback: z.boolean(),
  trackingEm: z.number(),
});
export const PlacedLineSchema = z.object({
  text: z.string(),
  role: LineRoleSchema,
  tier: TierSchema,
  sizePx: z.number(),
  runs: z.array(PlacedRunSchema),
  baselineY: z.number(),
  x: z.number(),
  advance: z.number(),
  ink: BoxSchema,
  strokePx: z.number().optional(),
});

/**
 * Satır içi parça fontu: `[start, end)` aralığı, satırın (düzenlenmiş ya da özgün) metninde UTF-16 ofsetleri.
 * Motor aralığı grafem sınırlarına oturtur.
 */
export const FontSpanSchema = z
  .object({
    start: z.number().int().min(0).max(EDIT_LIMITS.textMax),
    end: z.number().int().min(1).max(EDIT_LIMITS.textMax),
    fontId: z.string().min(1).max(EDIT_LIMITS.fontIdMax),
  })
  .refine((s) => s.end > s.start, { message: "Parçanın sonu başından sonra olmalı." });
export type FontSpan = z.infer<typeof FontSpanSchema>;

/**
 * Bir satırın elle düzenlenmesi. `text`: yeni metin (yoksa özgün metin; satır sonu içeremez); `fontId`: bütün satırın
 * fontu (profil font kimliği; yoksa özgün); `spans`: satır içi parça fontları. `placed`: motorun yeniden ölçtüğü satır
 * (SUNUCU doldurur; istemcinin gönderdiği yok sayılır ve yeniden hesaplanır).
 */
export const LineEditSchema = z.object({
  index: z.number().int().min(0).max(ADJUST_LIMITS.maxLines - 1),
  text: z
    .string()
    .max(EDIT_LIMITS.textMax)
    .refine((t) => t.trim().length > 0, { message: "Satır boş olamaz." })
    .refine((t) => !/[\r\n]/.test(t), { message: "Satır metni satır sonu içeremez." })
    .optional(),
  fontId: z.string().min(1).max(EDIT_LIMITS.fontIdMax).optional(),
  spans: z.array(FontSpanSchema).max(EDIT_LIMITS.spansMax).optional(),
  placed: PlacedLineSchema.optional(),
});
export type LineEdit = z.infer<typeof LineEditSchema>;

export const VariantAdjustSchema = z
  .object({
    dx: shift.default(0),
    dy: shift.default(0),
    /** Bütün blok için çarpan (1 = değişmez). */
    scale: factor.default(1),
    /** Bütün blok için kontur farkı (tasarım px). Yok = 0. */
    strokePx: strokeDelta.optional(),
    lines: z.array(LineAdjustSchema).max(ADJUST_LIMITS.maxLines).optional(),
    /** Elle metin/font düzenlemeleri (3. sürüm; yoksa yok). */
    edits: z.array(LineEditSchema).max(ADJUST_LIMITS.maxLines).optional(),
  })
  .superRefine((a, ctx) => {
    const seen = new Set<number>();
    for (const [i, l] of (a.lines ?? []).entries()) {
      if (seen.has(l.index)) ctx.addIssue({ code: "custom", path: ["lines", i, "index"], message: `Satır ${l.index} iki kez düzeltilmiş.` });
      seen.add(l.index);
    }
    const edited = new Set<number>();
    for (const [i, e] of (a.edits ?? []).entries()) {
      if (edited.has(e.index)) ctx.addIssue({ code: "custom", path: ["edits", i, "index"], message: `Satır ${e.index} iki kez düzenlenmiş.` });
      edited.add(e.index);
    }
  });
export type VariantAdjust = z.infer<typeof VariantAdjustSchema>;
export type VariantAdjustInput = z.input<typeof VariantAdjustSchema>;

const round = (v: number, d: number) => {
  const k = 10 ** d;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r; // -0 olmasın
};
const r2 = (v: number) => round(v, 2);

export const IDENTITY_ADJUST: VariantAdjust = { dx: 0, dy: 0, scale: 1 };

function lineIsIdentity(l: Pick<LineAdjust, "dx" | "dy" | "scale" | "strokePx">): boolean {
  return Math.abs(l.dx) < 0.005 && Math.abs(l.dy) < 0.005 && Math.abs(l.scale - 1) < 0.00005 && Math.abs(l.strokePx ?? 0) < 0.005;
}

/** Kontur farkı yalnızca etkiliyse yazılır (kayıt biçimi sade kalsın). */
function strokeField(v: number | undefined): { strokePx?: number } {
  const r = r2(v ?? 0);
  return r !== 0 ? { strokePx: r } : {};
}

/** Düzenleme bir şey söylüyor mu (metin, satır fontu ya da parça fontu)? */
export function editIsEffective(e: Pick<LineEdit, "text" | "fontId" | "spans">): boolean {
  return e.text !== undefined || e.fontId !== undefined || (e.spans?.length ?? 0) > 0;
}

/**
 * Parça fontlarını sıralar, metin dışına taşanları kırpar, çakışanlarda SONRAKİ kazanır, aynı fontlu bitişikleri
 * birleştirir. `textLength`: satırın metin uzunluğu (UTF-16).
 */
export function normalizeSpans(spans: readonly FontSpan[] | undefined, textLength: number): FontSpan[] {
  let out: FontSpan[] = [];
  for (const raw of spans ?? []) {
    const start = Math.max(0, Math.min(textLength, raw.start));
    const end = Math.max(0, Math.min(textLength, raw.end));
    if (end <= start) continue;
    // Sonraki kazanır: yeni parça öncekilerin üstüne yazılır.
    const next: FontSpan[] = [];
    for (const o of out) {
      if (o.end <= start || o.start >= end) next.push(o);
      else {
        if (o.start < start) next.push({ ...o, end: start });
        if (o.end > end) next.push({ ...o, start: end });
      }
    }
    next.push({ start, end, fontId: raw.fontId });
    out = next.sort((x, y) => x.start - y.start);
  }
  const merged: FontSpan[] = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && last.end === s.start && last.fontId === s.fontId) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged;
}

/** Düzeltme hiçbir şeyi değiştirmiyor mu? */
export function isIdentityAdjust(a: VariantAdjust | null | undefined): boolean {
  if (!a) return true;
  return lineIsIdentity(a) && (a.lines ?? []).every(lineIsIdentity) && !(a.edits ?? []).some(editIsEffective);
}

/**
 * Kayıt biçimi: px 0,01'e, ölçek 0,0001'e yuvarlanır; etkisiz satırlar atılır, satırlar sıralanır.
 * Hiçbir şeyi değiştirmiyorsa null (= düzeltme yok).
 */
export function normalizeAdjust(a: VariantAdjust | null | undefined): VariantAdjust | null {
  if (!a) return null;
  const lines = (a.lines ?? [])
    .map((l): LineAdjust => ({ index: l.index, dx: r2(l.dx), dy: r2(l.dy), scale: round(l.scale, 4), ...strokeField(l.strokePx) }))
    .filter((l) => !lineIsIdentity(l))
    .sort((x, y) => x.index - y.index);
  const edits = (a.edits ?? [])
    .map((e): LineEdit => {
      const text = e.text ?? e.placed?.text;
      // Satırın fontuyla aynı fontlu parça etkisizdir.
      const spans = normalizeSpans(e.spans, text?.length ?? EDIT_LIMITS.textMax).filter((sp) => sp.fontId !== e.fontId);
      return {
        index: e.index,
        ...(e.text !== undefined ? { text: e.text } : {}),
        ...(e.fontId !== undefined ? { fontId: e.fontId } : {}),
        ...(spans.length ? { spans } : {}),
        ...(e.placed ? { placed: e.placed } : {}),
      };
    })
    .filter(editIsEffective)
    .sort((x, y) => x.index - y.index);
  const out: VariantAdjust = {
    dx: r2(a.dx),
    dy: r2(a.dy),
    scale: round(a.scale, 4),
    ...strokeField(a.strokePx),
    ...(lines.length ? { lines } : {}),
    ...(edits.length ? { edits } : {}),
  };
  return isIdentityAdjust(out) ? null : out;
}

/** Düzenlemelerin kimlik anahtarı (`placed` hariç): aynı anahtar = aynı yazı katmanı. */
export function editsKey(edits: readonly LineEdit[] | undefined): string {
  return JSON.stringify(
    (edits ?? [])
      .filter(editIsEffective)
      .map((e) => [e.index, e.text ?? null, e.fontId ?? null, (e.spans ?? []).map((s) => [s.start, s.end, s.fontId])])
      .sort((x, y) => (x[0] as number) - (y[0] as number)),
  );
}

/** Düzenlemelerden `placed` alanlarını atar (istemciden gelen değer yok sayılır, sunucu yeniden hesaplar). */
export function stripPlaced(edits: readonly LineEdit[] | undefined): LineEdit[] {
  return (edits ?? []).map(({ placed: _placed, ...e }) => e);
}

export function boxCenter(b: Box): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Tek ölçek + kaydırma: p' = o + s · (p − o) + d. */
interface Affine {
  ox: number;
  oy: number;
  s: number;
  dx: number;
  dy: number;
}
const mapX = (t: Affine, x: number) => t.ox + t.s * (x - t.ox) + t.dx;
const mapY = (t: Affine, y: number) => t.oy + t.s * (y - t.oy) + t.dy;
const mapBox = (t: Affine, b: Box): Box => ({ x: mapX(t, b.x), y: mapY(t, b.y), w: b.w * t.s, h: b.h * t.s });

/** Kontur hesabı için gereken en az yerleşim: temel kontur (yerleşimin ya da satırın). */
export type StrokeLayout = { strokePx?: number; lines: ReadonlyArray<{ strokePx?: number }> };
/**
 * Mürekkep kutusu hesabı için gereken en az yerleşim (`LayoutResult` ya da düzenleme modeli uyar). `origin`: blok
 * ölçeğinin merkezi; yoksa `ink`'in merkezi (metin düzenlenince düzenlenmemiş yerleşimin merkezi verilir).
 */
type InkLayout = { ink: Box; origin?: Point; strokePx?: number; lines: ReadonlyArray<{ ink: Box; strokePx?: number }> };

/** Satırın düzeltmesiz (temel) konturu: satırın kendi değeri, yoksa yerleşiminki, o da yoksa 0. */
export function baseLineStroke(layout: StrokeLayout, index: number): number {
  return layout.lines[index]?.strokePx ?? layout.strokePx ?? 0;
}

/**
 * Satırın etkin kontur genişliği (tasarım px, 0,01'e yuvarlı):
 * max(0, temel · blokÖlçeği · satırÖlçeği + blok.strokePx + satır.strokePx). Arayüz de bunu kullanır.
 */
export function effectiveLineStroke(layout: StrokeLayout, adjust: VariantAdjust | null | undefined, index: number): number {
  const a = adjust ?? IDENTITY_ADJUST;
  const la = a.lines?.find((l) => l.index === index);
  const v = baseLineStroke(layout, index) * a.scale * (la?.scale ?? 1) + (a.strokePx ?? 0) + (la?.strokePx ?? 0);
  return r2(Math.max(0, v));
}

/** Konturun mürekkebe kattığı çıkıntı: dışa hizada genişlik kadar, ortada yarısı (typeset `strokeOutset` ile aynı). */
export function strokeOutsetPx(widthPx: number, align: StrokeAlign): number {
  if (!(widthPx > 0)) return 0;
  return align === "outside" ? widthPx : widthPx / 2;
}

/**
 * Yazı katmanı SVG'sinde satır grubunun `stroke-width` değeri. Dışa hizalı kontur SVG'de `paint-order="stroke"`
 * ile dolgunun altına 2× genişlikte çizilir (içteki yarısı dolgunun altında kalır); ortada hizalı 1×. `k`: o gruba
 * (ya da atalarına) istemcinin uyguladığı toplam ölçek (blokÖlçeği · satırÖlçeği). SVG konturu da dönüşümle
 * ölçeklendiği için genişlik `k`'ye bölünür.
 */
export function svgStrokeWidth(effectivePx: number, align: StrokeAlign, k = 1): number {
  if (!(effectivePx > 0) || !(k > 0)) return 0;
  return ((align === "outside" ? 2 : 1) * effectivePx) / k;
}

/** Blok dönüşümünün merkezi: düzeltmesiz (ve düzenlenmemiş) yerleşimin mürekkep kutusu merkezi. */
export function adjustOrigin(layout: InkLayout): Point {
  return layout.origin ?? boxCenter(layout.ink);
}

/**
 * Düzenlenen satırları (`placed`) yerleşime yerleştirir: satırlar değişir, bütün yazının mürekkep kutusu satırların
 * birleşimi olur. Dönüşüm yok. `placed`'i olmayan düzenleme (henüz motordan geçmemiş) yok sayılır.
 */
export function applyLineEdits(layout: LayoutResult, edits: readonly LineEdit[] | undefined): LayoutResult {
  const byIndex = new Map((edits ?? []).filter((e) => e.placed && e.index < layout.lines.length).map((e) => [e.index, e.placed!] as const));
  if (!byIndex.size) return layout;
  const lines = layout.lines.map((l, i): PlacedLine => {
    const p = byIndex.get(i);
    if (!p) return l;
    const { strokePx, ...rest } = p;
    const s = strokePx ?? l.strokePx;
    return { ...rest, ...(s !== undefined ? { strokePx: s } : {}) };
  });
  const ink = unionBoxes(lines.map((l) => l.ink)) ?? layout.ink;
  return { ...layout, lines, ink: { x: r2(ink.x), y: r2(ink.y), w: r2(ink.w), h: r2(ink.h) } };
}

/**
 * Düzenleme modelinin (istemci) karşılığı: satır kutularının yerine düzenlenmiş satırlarınkini koyar, bütün yazının
 * kutusu satırların birleşimi olur, blok merkezi (`origin`) düzenlenmemiş yerleşiminki kalır.
 */
export function editedInkLayout<L extends { ink: Box; text: string; sizePx: number }, T extends { ink: Box; origin?: Point; lines: readonly L[] }>(
  layout: T,
  edits: readonly LineEdit[] | undefined,
): Omit<T, "lines" | "origin"> & { origin: Point; lines: L[] } {
  const origin = adjustOrigin(layout);
  const byIndex = new Map((edits ?? []).filter((e) => e.placed && e.index < layout.lines.length).map((e) => [e.index, e.placed!] as const));
  if (!byIndex.size) return { ...layout, origin, lines: [...layout.lines] };
  const lines = layout.lines.map((l, i): L => {
    const p = byIndex.get(i);
    return p ? { ...l, text: p.text, sizePx: p.sizePx, ink: p.ink } : l;
  });
  return { ...layout, origin, lines, ink: unionBoxes(lines.map((l) => l.ink)) ?? layout.ink };
}

function lineAffine(line: { ink: Box }, la: LineAdjust | undefined): Affine {
  const c = boxCenter(line.ink);
  return { ox: c.x, oy: c.y, s: la?.scale ?? 1, dx: la?.dx ?? 0, dy: la?.dy ?? 0 };
}

function blockAffine(layout: InkLayout, a: VariantAdjust): Affine {
  const c = adjustOrigin(layout);
  return { ox: c.x, oy: c.y, s: a.scale, dx: a.dx, dy: a.dy };
}

function lineAdjustMap(a: VariantAdjust): Map<number, LineAdjust> {
  return new Map((a.lines ?? []).map((l) => [l.index, l]));
}

/** Kutuyu her yandan `g` kadar büyütür (g < 0 küçültür; boyut 0'ın altına inmez, merkez korunur). */
function growBox(b: Box, g: number): Box {
  if (!g) return b;
  const w = Math.max(0, b.w + 2 * g);
  const h = Math.max(0, b.h + 2 * g);
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

/** Düzeltme seçenekleri: kontur hizası, mürekkep kutusunun kalınlıkla ne kadar büyüdüğünü belirler (varsayılan dışa). */
export interface AdjustOptions {
  strokeAlign?: StrokeAlign;
}

/**
 * Kalınlık farkının mürekkep kutusuna etkisi (her yandan): etkin konturun çıkıntısı − ölçeklenmiş temel konturun
 * çıkıntısı (temel kontur zaten kutuda ve ölçekle birlikte büyür). Kalınlık farkı yoksa 0.
 */
function strokeGrowth(layout: StrokeLayout, a: VariantAdjust, la: LineAdjust | undefined, index: number, align: StrokeAlign): number {
  if (!a.strokePx && !la?.strokePx) return 0;
  const scaled = baseLineStroke(layout, index) * a.scale * (la?.scale ?? 1);
  return strokeOutsetPx(effectiveLineStroke(layout, a, index), align) - strokeOutsetPx(scaled, align);
}

/** Düzeltilmiş satır mürekkep kutuları (yuvarlanmamış; kalınlık farkı dahil). */
export function adjustedLineInks(layout: InkLayout, adjust: VariantAdjust | null | undefined, opts: AdjustOptions = {}): Box[] {
  const a = adjust ?? IDENTITY_ADJUST;
  const block = blockAffine(layout, a);
  const per = lineAdjustMap(a);
  const align = opts.strokeAlign ?? "outside";
  return layout.lines.map((l, i) =>
    growBox(mapBox(block, mapBox(lineAffine(l, per.get(i)), l.ink)), strokeGrowth(layout, a, per.get(i), i, align)),
  );
}

/**
 * Düzeltilmiş bütün yazının mürekkep kutusu. Satır düzeltmesi yoksa blok kutusunun dönüşümüdür; varsa
 * düzeltilmiş satır kutularının birleşimi.
 */
export function adjustedInk(layout: InkLayout, adjust: VariantAdjust | null | undefined, opts: AdjustOptions = {}): Box {
  const a = adjust ?? IDENTITY_ADJUST;
  if (!layout.lines.length || (!a.lines?.length && !a.strokePx)) return mapBox(blockAffine(layout, a), layout.ink);
  return unionBoxes(adjustedLineInks(layout, a, opts)) ?? mapBox(blockAffine(layout, a), layout.ink);
}

/**
 * Yerleşime düzeltmeyi uygular (saf). Satır başı, taban çizgisi ve mürekkep kutuları dönüştürülür; punto,
 * run puntoları, taban kayması ve ilerleme ölçekle çarpılır. Her satırın etkin konturu kendi `strokePx`'ine
 * yazılır (`effectiveLineStroke`); mürekkep kutusu kalınlık farkı kadar büyür/küçülür. Yerleşimin `strokePx`'i
 * bloğun konturudur (max(0, temel · blokÖlçeği + blok.strokePx)); ana punto blok ölçeğiyle değişir. Metin, font,
 * renk, puan ve sorunlar DEĞİŞMEZ. `opts.strokeAlign`: profilin `weight.align`'ı (mürekkep büyümesi için).
 */
export function applyAdjustToLayout(input: LayoutResult, adjust: VariantAdjust | null | undefined, opts: AdjustOptions = {}): LayoutResult {
  const a = normalizeAdjust(adjust);
  if (!a || !input.lines.length) return input;
  // Önce elle düzenlenen satırlar yerine geçer; blok merkezi düzenlenmemiş yerleşiminki kalır.
  const edited = applyLineEdits(input, a.edits);
  const layout: LayoutResult & { origin: Point } = { ...edited, origin: adjustOrigin(input) };
  const block = blockAffine(layout, a);
  const per = lineAdjustMap(a);
  const inks = adjustedLineInks(layout, a, opts);
  const lines: PlacedLine[] = layout.lines.map((line, i) => {
    const la = lineAffine(line, per.get(i));
    const k = la.s * block.s;
    const X = (x: number) => mapX(block, mapX(la, x));
    const Y = (y: number) => mapY(block, mapY(la, y));
    const ink = inks[i]!;
    return {
      ...line,
      sizePx: r2(line.sizePx * k),
      runs: line.runs.map((r) => ({ ...r, sizePx: r2(r.sizePx * k), baselineShiftPx: r2(r.baselineShiftPx * k) })),
      baselineY: r2(Y(line.baselineY)),
      x: r2(X(line.x)),
      advance: r2(line.advance * k),
      ink: { x: r2(ink.x), y: r2(ink.y), w: r2(ink.w), h: r2(ink.h) },
      strokePx: effectiveLineStroke(layout, a, i),
    };
  });
  const ink = adjustedInk(layout, a, opts);
  const weight = !!a.strokePx || !!a.lines?.some((l) => l.strokePx);
  const notes = [...edited.notes, weight ? "Elle düzeltildi (konum/boyut/kalınlık)." : "Elle düzeltildi (konum/boyut)."];
  const applied = (a.edits ?? []).filter((e) => e.placed);
  if (applied.some((e) => e.text !== undefined)) notes.push("Satır metni elle düzenlendi.");
  if (applied.some((e) => e.fontId !== undefined || e.spans?.length)) notes.push("Font elle değiştirildi.");
  return {
    ...edited,
    lines,
    basePx: r2(edited.basePx * a.scale),
    strokePx: r2(Math.max(0, edited.strokePx * a.scale + (a.strokePx ?? 0))),
    ink: { x: r2(ink.x), y: r2(ink.y), w: r2(ink.w), h: r2(ink.h) },
    notes,
  };
}

// ---------------------------------------------------------------- ortalama

export type CenterAxis = "x" | "y" | "both";
/** textCenter: şablonun hedef merkezi (yoksa yazı alanından hesaplanan merkez) · area: yazı alanı kutusunun merkezi · cut: kesim kutusunun merkezi. */
export type CenterTarget = "textCenter" | "area" | "cut";

/** Ortalama hedefleri (tasarım px). Sunucunun düzenleme modeli bunları `centers` altında verir. */
export interface CenterPoints {
  textCenter: Point;
  area: Point;
  cut: Point;
}

/**
 * Düzeltilmiş mürekkep kutusunun merkezini seçilen hedefe oturtan YENİ düzeltme. Yalnızca blok kaydırması
 * değişir; ölçek ve satır düzeltmeleri korunur (kaydırma en son uygulandığı için sonuç tam oturur).
 */
export function centerAdjust(
  layout: InkLayout,
  centers: CenterPoints,
  current: VariantAdjust | null | undefined,
  opts: { axis: CenterAxis; target?: CenterTarget },
): VariantAdjust {
  const a: VariantAdjust = current ? { ...current } : { ...IDENTITY_ADJUST };
  const target = centers[opts.target ?? "textCenter"];
  const c = boxCenter(adjustedInk(layout, a));
  const clamp = (v: number) => Math.max(-ADJUST_LIMITS.shiftMaxPx, Math.min(ADJUST_LIMITS.shiftMaxPx, v));
  if (opts.axis !== "y") a.dx = r2(clamp(a.dx + target.x - c.x));
  if (opts.axis !== "x") a.dy = r2(clamp(a.dy + target.y - c.y));
  return a;
}

/**
 * Kontur farkını sınırlar içinde toplamsal adımla değiştirir: `stepStroke(a, +0.5)` bütün blok,
 * `stepStroke(a, +0.5, 2)` yalnızca 2. satır. Kaydırma, ölçek ve öbür satırlar korunur.
 */
export function stepStroke(current: VariantAdjust | null | undefined, step: number, lineIndex?: number): VariantAdjust {
  const a: VariantAdjust = current ? { ...current } : { ...IDENTITY_ADJUST };
  const clamp = (v: number) => r2(Math.max(-ADJUST_LIMITS.strokeMaxPx, Math.min(ADJUST_LIMITS.strokeMaxPx, v)));
  if (lineIndex === undefined) {
    a.strokePx = clamp((a.strokePx ?? 0) + step);
    return a;
  }
  const lines = [...(a.lines ?? [])];
  const at = lines.findIndex((l) => l.index === lineIndex);
  const prev: LineAdjust = at >= 0 ? lines[at]! : { index: lineIndex, dx: 0, dy: 0, scale: 1 };
  const next: LineAdjust = { ...prev, strokePx: clamp((prev.strokePx ?? 0) + step) };
  if (at >= 0) lines[at] = next;
  else lines.push(next);
  a.lines = lines.sort((x, y) => x.index - y.index);
  return a;
}

/** Ölçeği sınırlar içinde toplamsal adımla değiştirir (ör. %2: `stepScale(a, +0.02)` → 1 → 1,02 → 1,04); kaydırma korunur. */
export function stepScale(current: VariantAdjust | null | undefined, step: number): VariantAdjust {
  const a: VariantAdjust = current ? { ...current } : { ...IDENTITY_ADJUST };
  a.scale = round(Math.max(ADJUST_LIMITS.scaleMin, Math.min(ADJUST_LIMITS.scaleMax, a.scale + step)), 4);
  return a;
}
