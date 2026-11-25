import { readFile } from "node:fs/promises";
import zlib from "node:zlib";
import sharp, { type OverlayOptions } from "sharp";
import {
  type Box,
  type LayoutResult,
  type PrintCellLabel,
  type PrintCut,
  type PrintSlot,
  type Profile,
  type Shape,
  type TemplateGeometry,
  type VariantAdjust,
  MM_PER_INCH,
  PRINT_DPI,
  applyAdjustToLayout,
  shapeBounds,
} from "@tagpress/domain";
import type { FontRegistry } from "@tagpress/typeset";
import { textLayerSvg } from "./render.ts";
import {
  type CellLabelFont,
  type Mat,
  type VecShape,
  apply,
  cellLabelShapes,
  defaultCellLabelFont,
  growShape,
  mul,
  pathD,
  registrationMarks,
  rotate,
  scaleMat,
  shapeCmds,
  slotCmds,
  slotOutlines,
  translate,
  vecSvg,
} from "./print-vector.ts";

/**
 * Baskı render'ı (baskı masası): bir baskı sayfasını SVG (mm), PNG (dpi), kesim dosyası (SVG) ve küçük resim
 * olarak üretir; PDF `print-pdf.ts`'tedir. Girdi SAFTIR (veritabanı bilmez): sunucu kayıtları `PrintPageRenderInput`'a
 * çevirir. Birim her yerde mm, koordinat kağıdın sol üstünden (domain `print.ts` sözleşmesi).
 *
 * Katman sırası (alttan üste): zemin → etiketler (girdi sırasıyla) → hücre etiketleri → kayıt işaretleri → yuva kesim
 * çizgileri. Kesim çizgisi her zaman YUVA sınırındadır; taşma payı (`cut.bleedMm`) yalnızca etiket görselini büyütür.
 *
 * Etiket içi kırpma: etiket görseli (şablon + yazı) kesim şeklinin (`LabelArt.clip`, profil `output.cut`) taşma payı
 * kadar büyütülmüş hâliyle kırpılır. Eski düzen kırpmıyordu, ama kesim dışındaki mürekkep
 * kağıtta zaten atılır; kırpmamak köşesi dolu şablonlarda (ör. alfa 0 olmayan köşeler) komşu yuvaya taşan mürekkep
 * demektir. Sticker'da kırpma yoktur (`clip: null`).
 */

// ---------------------------------------------------------------- girdi tipi (sunucu doldurur)

/** Görsel kaynağı: dosya yolu ya da görsel baytları (PNG/JPEG/WebP). */
export type ImageSource = string | Buffer;

/**
 * Etiketin yazı katmanı (tasarım alanı koordinatı):
 * - `svg`: motorun `textLayerSvg` çıktısı (viewBox = tasarım alanı, glifler yol). Metin modu ve "temadan şablon üret"
 *   varyasyonları; DÜZELTİLMİŞ yerleşimden üretilmelidir (`applyAdjustToLayout`; bkz. `labelArtFor`).
 * - `png`: görüntü modu ("şablona yaz") varyasyonunun ayrılmış yazı katmanı (`<id>.text.png`, şablon görseliyle aynı
 *   piksel boyutunda) → `box` = şablonun kutusu (`templateBox`). Şablon pikseline dokunulmaz: şablon ayrı katmandır.
 */
export type LabelTextLayer = { kind: "svg"; svg: string } | { kind: "png"; source: ImageSource; box: Box };

/**
 * Bir etiketin (ya da sticker'ın) tek başına çizimi, tasarım alanı px'inde (`designFramePx` kenarlı kare, 440).
 * Sayfadaki her kopya aynı `LabelArt`'ı paylaşabilir; `key` aynıysa çizim bir kez hazırlanır.
 */
export interface LabelArt {
  /** Tekilleştirme anahtarı: aynı anahtar = aynı çizim (ör. `${variantId}:${adjustSürümü}`). */
  key: string;
  /** Tasarım alanı kenarı (px): profil `output.designFramePx` (geometri `framePx`). */
  designFramePx: number;
  /** Şablon görseli ve tasarım alanındaki kutusu (geometri `imagePath` + `templateBox`). Sticker'da null. */
  template?: { source: ImageSource; box: Box } | null;
  /** Yazı katmanı; yoksa yalnızca şablon basılır. */
  text?: LabelTextLayer | null;
  /** Kırpma şekli (tasarım px): etiketlerde geometri `cut` (profil `output.cut`); sticker'da null (kırpılmaz). */
  clip?: Shape | null;
  /**
   * Öğenin (xMm, yMm) noktasına oturan tasarım alanı noktası (px). Varsayılan alanın merkezi (etiket yuvaya
   * ortalanır). Sticker sayfalarında planlayıcı mürekkep kutusunun merkezini verir → yerleşimin `ink` merkezi.
   */
  anchor?: { x: number; y: number } | null;
}

/** Sayfadaki bir etiket/sticker kopyası. */
export interface PrintRenderItem {
  /** `art.anchor` noktasının sayfadaki yeri (mm). */
  xMm: number;
  yMm: number;
  /** Derece, saat yönünde. */
  rotation?: number;
  /** Ek ölçek (1 = doğal). */
  scale?: number;
  /**
   * Tasarım alanı karesinin (`designFramePx`) fiziksel kenarı (mm). Baskı şablonunun `labelDiameterMm`'i, yoksa yuva
   * genişliği; şablonda bilgi yoksa `labelDiameterMm(profile, sizeId)` (profilin boyut tablosundan).
   */
  diameterMm: number;
  art: LabelArt;
}

/** Hücre etiketi (sipariş adı). (xMm, yMm) yazının SOL ÜST köşesi; bkz. `cellLabelAnchor`. */
export interface PrintRenderCellLabel {
  text: string;
  xMm: number;
  yMm: number;
  style: Pick<PrintCellLabel, "sizePt" | "color"> & Partial<PrintCellLabel>;
}

/**
 * Bir baskı sayfasının render girdisi (saf veri). Sayfanın `showCellLabels` kapalıysa `cellLabels` boş verilir.
 * `slots` kesim çizgileri ve kesim dosyası içindir; etiketlerin yeri `items`'tadır (serbest öğe yuvasız olabilir).
 */
export interface PrintPageRenderInput {
  paper: { wMm: number; hMm: number };
  slots: readonly PrintSlot[];
  cut: PrintCut;
  cellLabels: readonly PrintRenderCellLabel[];
  items: readonly PrintRenderItem[];
  /** Kağıt zemini; varsayılan beyaz. */
  background?: string;
}

export interface PrintRenderOptions {
  /** Hücre etiketi fontu; varsayılan Inter Bold (`defaultCellLabelFont`). */
  cellLabelFont?: CellLabelFont;
  /**
   * Yuva çizgileri baskıda görünmüyorsa (`outlineVisible: false`) ekranda kılavuz olarak kesikli gri çizilsin mi.
   * Yalnızca önizleme içindir; PNG/PDF baskı çıktısında kapalı bırakın.
   */
  guides?: boolean;
}

export const DEFAULT_PRINT_DPI = PRINT_DPI;
/** Bir sayfanın en çok piksel sayısı (A4 @ 1200 dpi ≈ 139 M). Bellek bantlarla sınırlı; bu sınır süreyi korur. */
export const MAX_PRINT_PAGE_PIXELS = 200_000_000;
/** Bir bandın en çok piksel sayısı (RGBA ≈ 16 MB). */
const BAND_PIXELS = 4_000_000;

// ---------------------------------------------------------------- sunucu yardımcıları

/**
 * Etiket boyutunun (ör. "3.8") tasarım alanı karesinin fiziksel kenarı (mm): etiket çerçevesi `cm` boyutundadır,
 * içerik `contentScale` ile ölçeklenir (profil `output.sizes`; yoksa framePx / designFramePx → tam `cm × 10`).
 */
export function labelDiameterMm(profile: Profile, sizeId: string | null): number {
  const sizes = profile.output.sizes;
  const s = sizes.find((x) => x.id === sizeId) ?? sizes.find((x) => x.id === profile.output.defaultSize) ?? sizes[0];
  if (!s) return 38;
  const F = profile.output.designFramePx;
  const contentScale = s.contentScale ?? s.framePx / F;
  return ((s.cm * 10) / s.framePx) * F * contentScale;
}

/** Hücre etiketinin sol üst köşesi: yuvanın (döndürülmemiş) sağ alt köşesi + (dxMm, dyMm). */
export function cellLabelAnchor(slot: Pick<PrintSlot, "cx" | "cy" | "w" | "h">, style: Pick<PrintCellLabel, "dxMm" | "dyMm">): { xMm: number; yMm: number } {
  return { xMm: slot.cx + slot.w / 2 + style.dxMm, yMm: slot.cy + slot.h / 2 + style.dyMm };
}

/**
 * Varyasyondan `LabelArt` kurar (sunucu kolaylığı):
 * - metin modu: `layout` (+ `adjust`) → `textLayerSvg` (düzeltilmiş yerleşim; önizlemeyle aynı);
 * - görüntü modu: `textLayerPng` (yazı katmanı PNG'si) şablon kutusuna;
 * - sticker: şablonsuz, kırpmasız, çapa = mürekkep kutusunun merkezi.
 */
export function labelArtFor(o: {
  key: string;
  geometry: Pick<TemplateGeometry, "framePx" | "cut" | "imagePath" | "templateBox">;
  kind?: "label" | "sticker";
  layout?: LayoutResult | null;
  adjust?: VariantAdjust | null;
  fonts?: FontRegistry;
  profile?: Profile;
  textLayerPng?: ImageSource | null;
}): LabelArt {
  const g = o.geometry;
  const sticker = o.kind === "sticker";
  const eff = o.layout ? applyAdjustToLayout(o.layout, o.adjust ?? null) : null;
  let text: LabelTextLayer | null = null;
  if (o.textLayerPng) text = { kind: "png", source: o.textLayerPng, box: g.templateBox };
  else if (eff) {
    if (!o.fonts) throw new Error("labelArtFor: yazı katmanı için font kaydı gerekli.");
    text = { kind: "svg", svg: textLayerSvg(eff, o.fonts, { framePx: g.framePx, ...(o.profile ? { profile: o.profile } : {}) }) };
  }
  return {
    key: o.key,
    designFramePx: g.framePx,
    template: !sticker && g.imagePath ? { source: g.imagePath, box: g.templateBox } : null,
    text,
    clip: sticker ? null : g.cut,
    anchor: sticker && eff ? { x: eff.ink.x + eff.ink.w / 2, y: eff.ink.y + eff.ink.h / 2 } : null,
  };
}

// ---------------------------------------------------------------- görseller

interface ImageInfo {
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
}

/** Bir render çağrısı boyunca görselleri bir kez okur/küçültür (aynı şablon her kopyada yeniden okunmaz). */
export class PrintImageStore {
  private readonly infos = new Map<string, Promise<ImageInfo>>();
  private readonly resizedCache = new Map<string, Promise<Buffer>>();
  private readonly bufIds = new WeakMap<Buffer, string>();
  private nextId = 0;

  id(src: ImageSource): string {
    if (typeof src === "string") return `f:${src}`;
    let id = this.bufIds.get(src);
    if (!id) {
      id = `b:${this.nextId++}`;
      this.bufIds.set(src, id);
    }
    return id;
  }

  info(src: ImageSource): Promise<ImageInfo> {
    const id = this.id(src);
    let p = this.infos.get(id);
    if (!p) {
      p = (async () => {
        let bytes: Buffer;
        try {
          bytes = typeof src === "string" ? await readFile(src) : src;
        } catch {
          throw new Error(`Baskı görseli okunamadı: ${src as string}`);
        }
        const meta = await sharp(bytes).metadata();
        let mime = sniffMime(bytes);
        if (!mime) {
          bytes = await sharp(bytes).png().toBuffer();
          mime = "image/png";
        }
        return { bytes, mime, width: meta.width ?? 1, height: meta.height ?? 1 };
      })();
      this.infos.set(id, p);
    }
    return p;
  }

  /** Hedef piksel boyutuna (lanczos) küçültülmüş PNG. */
  resized(src: ImageSource, w: number, h: number): Promise<Buffer> {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    const key = `${this.id(src)}|${W}x${H}`;
    let p = this.resizedCache.get(key);
    if (!p) {
      p = this.info(src).then((i) => sharp(i.bytes).resize(W, H, { fit: "fill", kernel: "lanczos3" }).png({ compressionLevel: 3 }).toBuffer());
      this.resizedCache.set(key, p);
    }
    return p;
  }
}

function sniffMime(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const dataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

// ---------------------------------------------------------------- etiket geometrisi

const f3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const matAttr = (m: Mat) => `matrix(${m.map((v) => f3(v)).join(" ")})`;

/** Öğenin mm başına tasarım px'i ve taşma payının tasarım px karşılığı. */
export function itemMetrics(item: PrintRenderItem, bleedMm: number): { mmPerPx: number; bleedPx: number } {
  const mmPerPx = (item.diameterMm * (item.scale ?? 1)) / item.art.designFramePx;
  return { mmPerPx, bleedPx: item.art.clip && bleedMm > 0 ? bleedMm / mmPerPx : 0 };
}

/** Tasarım px → sayfa mm dönüşümü (öğe merkezi/çapası, dönüş, ölçek). */
export function itemMatrix(item: PrintRenderItem): Mat {
  const F = item.art.designFramePx;
  const a = item.art.anchor ?? { x: F / 2, y: F / 2 };
  const k = (item.diameterMm * (item.scale ?? 1)) / F;
  return mul(mul(translate(item.xMm, item.yMm), rotate(item.rotation ?? 0)), mul(scaleMat(k), translate(-a.x, -a.y)));
}

/**
 * Taşma payı için şablonun büyütme dönüşümü (tasarım px): kırpma merkezine göre eksen başına (W/2 + b) / (W/2) ve
 * (H/2 + b) / (H/2); her kenar tam taşma payı kadar dışarı çıkar (dikdörtgen/oval etikette kısa kenarın oranı uzun
 * kenarı aşırı büyütüp çerçeveyi kesim çizgisine bindirmez). Dairede iki oran eşittir: (R + b) / R.
 */
export function bleedTemplateMatrix(clip: Shape | null | undefined, bleedPx: number): Mat {
  if (!clip || !(bleedPx > 0)) return [1, 0, 0, 1, 0, 0];
  const b = shapeBounds(clip);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const kx = b.w > 0 ? (b.w / 2 + bleedPx) / (b.w / 2) : 1;
  const ky = b.h > 0 ? (b.h / 2 + bleedPx) / (b.h / 2) : 1;
  return mul(translate(cx, cy), mul(scaleMat(kx, ky), translate(-cx, -cy)));
}

/** Çizimin tasarım px'indeki kapsamı (kırpma varsa büyütülmüş kırpma kutusu). */
function artBounds(art: LabelArt, bleedPx: number): Box {
  if (art.clip) return shapeBounds(growShape(art.clip, bleedPx));
  const F = art.designFramePx;
  const boxes: Box[] = [{ x: -0.02 * F, y: -0.02 * F, w: 1.04 * F, h: 1.04 * F }];
  if (art.template) boxes.push(art.template.box);
  if (art.text?.kind === "png") boxes.push(art.text.box);
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** textLayerSvg belgesini iç içe `<svg>` olarak tasarım alanına yerleştirir. */
function nestTextSvg(svg: string, F: number): string {
  const m = svg.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/);
  if (!m) return "";
  const attrs = m[1]!;
  const vb = attrs.match(/viewBox="([^"]+)"/)?.[1];
  const w = attrs.match(/\bwidth="([\d.]+)"/)?.[1];
  const h = attrs.match(/\bheight="([\d.]+)"/)?.[1];
  const viewBox = vb ?? `0 0 ${w ?? F} ${h ?? F}`;
  return `<svg x="0" y="0" width="${F}" height="${F}" viewBox="${viewBox}" overflow="visible">${m[2]}</svg>`;
}

/** Görselin tasarım px'indeki kutuya yerleşimi (SVG öğesi). */
type ImagePlacer = (src: ImageSource, box: Box, extra: Mat | null) => Promise<string>;

/** Etiket çiziminin SVG içeriği (tasarım px): kırpma → şablon (taşma payıyla büyütülmüş) → yazı. */
async function artMarkup(art: LabelArt, bleedPx: number, id: string, place: ImagePlacer): Promise<string> {
  let defs = "";
  let body = "";
  if (art.template) {
    const bm = bleedTemplateMatrix(art.clip, bleedPx);
    body += await place(art.template.source, art.template.box, bm[0] === 1 && bm[4] === 0 && bm[5] === 0 ? null : bm);
  }
  if (art.text?.kind === "svg") body += nestTextSvg(art.text.svg, art.designFramePx);
  else if (art.text?.kind === "png") body += await place(art.text.source, art.text.box, null);
  if (art.clip) {
    defs = `<clipPath id="${id}-clip"><path d="${pathD(shapeCmds(art.clip, bleedPx))}"/></clipPath>`;
    body = `<g clip-path="url(#${id}-clip)">${body}</g>`;
  }
  return (defs ? `<defs>${defs}</defs>` : "") + body;
}

// ---------------------------------------------------------------- vektör katmanlar

/** Sayfanın vektör katmanları (mm): hücre etiketleri, kayıt işaretleri, yuva çizgileri. */
export interface PageVectors {
  /** `shape`: yazı renginde tek renkli yollar; `colors`: renkli emoji katmanları (kendi renkleriyle). */
  cellLabels: Array<{ text: string; shape: VecShape; colors: VecShape[] }>;
  registration: VecShape[];
  /** Yuva kesim çizgileri (yalnızca `outlineVisible` ise). */
  outlines: Array<{ slotId: string; shape: VecShape }>;
  /** Ekran kılavuzu (görünmez çizgi + `guides`). */
  guides: Array<{ slotId: string; shape: VecShape }>;
}

export function pageVectors(input: PrintPageRenderInput, opts: PrintRenderOptions = {}): PageVectors {
  const font = input.cellLabels.length ? (opts.cellLabelFont ?? defaultCellLabelFont()) : null;
  const cellLabels = input.cellLabels.map((l) => {
    const [shape, ...colors] = cellLabelShapes(l.text, l.xMm, l.yMm, l.style, font!);
    return { text: l.text, shape: shape!, colors };
  });
  const registration = registrationMarks(input.paper, input.cut.registration);
  const lines = slotOutlines(input.slots, input.cut);
  const visible = input.cut.outlineVisible;
  return {
    cellLabels,
    registration,
    outlines: visible ? lines.map((shape, i) => ({ slotId: input.slots[i]!.id, shape })) : [],
    guides:
      !visible && opts.guides
        ? // Kılavuz rengi: DESIGN.md `label-guide`.
          input.slots.map((s) => ({ slotId: s.id, shape: { cmds: slotCmds(s), fill: null, stroke: "#a7aca7", strokeWidth: 0.2 } }))
        : [],
  };
}

function vectorsSvg(v: PageVectors, parts: { cellLabels: boolean; registration: boolean; outlines: boolean }): string {
  let out = "";
  if (parts.cellLabels && v.cellLabels.length)
    out += `<g data-layer="cell-labels">${v.cellLabels.map((c) => vecSvg(c.shape, ` data-cell-label="${escapeAttr(c.text)}"`) + c.colors.map((x) => vecSvg(x)).join("")).join("")}</g>`;
  if (parts.registration && v.registration.length) out += `<g data-layer="registration">${v.registration.map((r) => vecSvg(r)).join("")}</g>`;
  if (parts.outlines) {
    if (v.outlines.length) out += `<g data-layer="cut">${v.outlines.map((o) => vecSvg(o.shape, ` data-slot="${escapeAttr(o.slotId)}"`)).join("")}</g>`;
    if (v.guides.length)
      out += `<g data-layer="guides" stroke-dasharray="1 0.8">${v.guides.map((o) => vecSvg(o.shape, ` data-slot="${escapeAttr(o.slotId)}"`)).join("")}</g>`;
  }
  return out;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------- sayfa SVG (mm)

/**
 * Sayfanın tam SVG'si: `width/height` mm, viewBox mm. Görseller veri URI'si olarak gömülür (her kaynak bir kez,
 * `<defs>`), her etiket çizimi bir kez tanımlanıp `<use>` ile kopyalanır. Öğeler `data-item`, kesim çizgileri
 * `data-slot`, hücre etiketleri `data-cell-label` taşır.
 */
export async function printPageSvg(input: PrintPageRenderInput, opts: PrintRenderOptions & { images?: PrintImageStore } = {}): Promise<string> {
  const store = opts.images ?? new PrintImageStore();
  const { wMm, hMm } = input.paper;
  const imgIds = new Map<string, string>();
  let imgDefs = "";
  const place: ImagePlacer = async (src, box, extra) => {
    const info = await store.info(src);
    const sid = store.id(src);
    let iid = imgIds.get(sid);
    if (!iid) {
      iid = `img${imgIds.size}`;
      imgIds.set(sid, iid);
      imgDefs += `<image id="${iid}" width="${info.width}" height="${info.height}" preserveAspectRatio="none" href="${dataUri(info.mime, info.bytes)}"/>`;
    }
    const m = mul(extra ?? [1, 0, 0, 1, 0, 0], mul(translate(box.x, box.y), scaleMat(box.w / info.width, box.h / info.height)));
    return `<use href="#${iid}" transform="${matAttr(m)}"/>`;
  };
  const bleedMm = input.cut.bleedMm;
  const artIds = new Map<string, string>();
  let artDefs = "";
  let items = "";
  for (const [i, item] of input.items.entries()) {
    const { bleedPx } = itemMetrics(item, bleedMm);
    const k = `${item.art.key}|${f3(bleedPx)}`;
    let aid = artIds.get(k);
    if (!aid) {
      aid = `art${artIds.size}`;
      artIds.set(k, aid);
      artDefs += `<g id="${aid}">${await artMarkup(item.art, bleedPx, aid, place)}</g>`;
    }
    items += `<use data-item="${i}" href="#${aid}" transform="${matAttr(itemMatrix(item))}"/>`;
  }
  const vec = vectorsSvg(pageVectors(input, opts), { cellLabels: true, registration: true, outlines: true });
  const bg = `<rect width="${f3(wMm)}" height="${f3(hMm)}" fill="${input.background ?? "#ffffff"}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f3(wMm)}mm" height="${f3(hMm)}mm" viewBox="0 0 ${f3(wMm)} ${f3(hMm)}">` +
    `<defs>${imgDefs}${artDefs}</defs>${bg}<g data-layer="items">${items}</g>${vec}</svg>`
  );
}

// ---------------------------------------------------------------- kesim dosyası

/**
 * Kesim dosyası (`cut.cutFile`): yalnızca yuva yolları (kontur, dolgusuz) ve kayıt işaretleri; mm ölçekli SVG
 * (`width="210mm"`), kesim yazılımına doğrudan alınır. Yuva çizgileri baskıda görünmese de burada vardır.
 */
export function printCutSvg(input: Pick<PrintPageRenderInput, "paper" | "slots" | "cut">): string {
  const { wMm, hMm } = input.paper;
  const reg = registrationMarks(input.paper, input.cut.registration).map((r) => vecSvg(r)).join("");
  const lines = slotOutlines(input.slots, input.cut)
    .map((s, i) => vecSvg(s, ` id="${escapeAttr(`yuva-${input.slots[i]!.id}`)}"`))
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f3(wMm)}mm" height="${f3(hMm)}mm" viewBox="0 0 ${f3(wMm)} ${f3(hMm)}">` +
    (reg ? `<g id="kayit-isaretleri">${reg}</g>` : "") +
    `<g id="kesim">${lines}</g></svg>\n`
  );
}

// ---------------------------------------------------------------- raster (bantlar)

export interface RasterPage {
  widthPx: number;
  heightPx: number;
  /** Sayfa pikselinin mm karşılığı (yatay ve dikey aynı). */
  pxPerMm: number;
  /** PNG "Up" süzgeçli satırların zlib akışı (PNG IDAT'ı ve PDF FlateDecode + Predictor 15 aynı veriyi kullanır). */
  zdata: Buffer;
}

interface Tile {
  raw: Buffer;
  width: number;
  height: number;
  /** Öğe merkezine (tam piksele yuvarlanmış) göre sol üst (px). */
  ox: number;
  oy: number;
}

interface PlacedTile {
  key: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  item: PrintRenderItem;
}

/** Sayfa piksel boyutu (dpi). */
export function pagePixelSize(paper: { wMm: number; hMm: number }, dpi: number): { widthPx: number; heightPx: number; pxPerMm: number } {
  const pxPerMm = dpi / MM_PER_INCH;
  return { widthPx: Math.max(1, Math.round(paper.wMm * pxPerMm)), heightPx: Math.max(1, Math.round(paper.hMm * pxPerMm)), pxPerMm };
}

/** Etiketin raster karosu (döndürülmüş, kırpılmış, RGBA). Konum öğe merkezine göredir; merkez tam piksele oturur (≤ ½ px). */
function tileFrame(item: PrintRenderItem, bleedMm: number, pxPerMm: number): { k: number; bleedPx: number; local: Mat; ox: number; oy: number; width: number; height: number } {
  const art = item.art;
  const { mmPerPx, bleedPx } = itemMetrics(item, bleedMm);
  const k = pxPerMm * mmPerPx; // sayfa pikseli / tasarım px
  const F = art.designFramePx;
  const a = art.anchor ?? { x: F / 2, y: F / 2 };
  // Tasarım px → öğe merkezine göre sayfa pikseli.
  const local = mul(rotate(item.rotation ?? 0), mul(scaleMat(k), translate(-a.x, -a.y)));
  const b = artBounds(art, bleedPx);
  const pts = [apply(local, b.x, b.y), apply(local, b.x + b.w, b.y), apply(local, b.x, b.y + b.h), apply(local, b.x + b.w, b.y + b.h)];
  const ox = Math.floor(Math.min(...pts.map((p) => p[0]))) - 1;
  const oy = Math.floor(Math.min(...pts.map((p) => p[1]))) - 1;
  const width = Math.ceil(Math.max(...pts.map((p) => p[0]))) + 1 - ox;
  const height = Math.ceil(Math.max(...pts.map((p) => p[1]))) + 1 - oy;
  return { k, bleedPx, local, ox, oy, width, height };
}

/** Karoyu çizer (yalnızca ilk kez gerektiği bantta; ölçüsü `tileFrame`'den önceden bilinir). */
async function renderTile(item: PrintRenderItem, bleedMm: number, pxPerMm: number, store: PrintImageStore): Promise<Tile> {
  const art = item.art;
  const { k, bleedPx, local, ox, oy, width, height } = tileFrame(item, bleedMm, pxPerMm);
  const place: ImagePlacer = async (src, box, extra) => {
    const ek = extra ? extra[0] : 1;
    const png = await store.resized(src, box.w * k * ek, box.h * k * ek);
    const t = extra ? ` transform="${matAttr(extra)}"` : "";
    return `<image x="${f3(box.x)}" y="${f3(box.y)}" width="${f3(box.w)}" height="${f3(box.h)}" preserveAspectRatio="none"${t} href="${dataUri("image/png", png)}"/>`;
  };
  const inner = await artMarkup(art, bleedPx, "t", place);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g transform="${matAttr(mul(translate(-ox, -oy), local))}">${inner}</g></svg>`;
  const raw = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
  return { raw, width, height, ox, oy };
}

const tileKey = (item: PrintRenderItem, bleedMm: number) =>
  `${item.art.key}|${f3(item.diameterMm * (item.scale ?? 1))}|${f3(item.rotation ?? 0)}|${f3(bleedMm)}|${item.art.anchor ? `${f3(item.art.anchor.x)},${f3(item.art.anchor.y)}` : "c"}`;

export interface RasterOptions extends PrintRenderOptions {
  dpi?: number;
  /** Raster'a hangi vektör katmanları girsin (PDF raster modunda kesim/kayıt vektör olarak ayrıca çizilir). */
  vectors?: { cellLabels: boolean; registration: boolean; outlines: boolean };
  images?: PrintImageStore;
}

/**
 * Sayfayı yatay bantlar hâlinde rasterleştirir ve satırları akışla sıkıştırır: bellek bant boyutuyla (≈ 16 MB) ve
 * o banttaki etiket karolarıyla sınırlıdır (A4 600 dpi da güvenli). Karolar aynı çizim için bir kez üretilir,
 * son kullanan banttan sonra bellekten atılır.
 */
export async function rasterizePage(input: PrintPageRenderInput, opts: RasterOptions = {}): Promise<RasterPage> {
  const dpi = opts.dpi ?? DEFAULT_PRINT_DPI;
  const { widthPx: W, heightPx: H, pxPerMm } = pagePixelSize(input.paper, dpi);
  if (W * H > MAX_PRINT_PAGE_PIXELS) throw new Error(`Sayfa ${W}×${H} px (${dpi} dpi) çok büyük; dpi'yi düşürün.`);
  const store = opts.images ?? new PrintImageStore();
  const bleedMm = input.cut.bleedMm;
  const bg = input.background ?? "#ffffff";

  // Karo ölçüsü hesaptan bilinir; çizim ilk kez gerektiği bantta yapılır, son kullanan banttan sonra atılır.
  const tiles = new Map<string, Promise<Tile>>();
  const placed: PlacedTile[] = [];
  for (const item of input.items) {
    const key = tileKey(item, bleedMm);
    const t = tileFrame(item, bleedMm, pxPerMm);
    const left = Math.round(item.xMm * pxPerMm) + t.ox;
    const top = Math.round(item.yMm * pxPerMm) + t.oy;
    placed.push({ key, left, top, right: left + t.width, bottom: top + t.height, item });
  }
  // Ham karo verisini yalnızca gerektiği bantlara kadar tut.
  const lastUse = new Map<string, number>();
  for (const p of placed) lastUse.set(p.key, Math.max(lastUse.get(p.key) ?? 0, p.bottom));

  const vec = vectorsSvg(pageVectors(input, opts), opts.vectors ?? { cellLabels: true, registration: true, outlines: true });
  const bandRows = Math.max(16, Math.floor(BAND_PIXELS / W));
  const deflate = zlib.createDeflate({ level: 6, memLevel: 9 });
  const out: Buffer[] = [];
  deflate.on("data", (c: Buffer) => out.push(c));
  const done = new Promise<void>((res, rej) => {
    deflate.on("end", res);
    deflate.on("error", rej);
  });
  let prev: Buffer = Buffer.alloc(W * 3);
  for (let y0 = 0; y0 < H; y0 += bandRows) {
    const rows = Math.min(bandRows, H - y0);
    const layers: OverlayOptions[] = [];
    for (const p of placed) {
      if (p.bottom <= y0 || p.top >= y0 + rows) continue;
      if (p.left >= W || p.right <= 0) continue;
      if (!tiles.has(p.key)) tiles.set(p.key, renderTile(p.item, bleedMm, pxPerMm, store));
      const t = await tiles.get(p.key)!;
      layers.push(clipOverlay(t, p.left, p.top - y0, W, rows));
    }
    if (vec) {
      const vb = `0 ${f3(y0 / pxPerMm)} ${f3(W / pxPerMm)} ${f3(rows / pxPerMm)}`;
      layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${rows}" viewBox="${vb}" preserveAspectRatio="none">${vec}</svg>`), left: 0, top: 0 });
    }
    const band = await sharp({ create: { width: W, height: rows, channels: 3, background: bg } })
      .composite(layers.filter(Boolean))
      .removeAlpha()
      .raw()
      .toBuffer();
    // PNG "Up" süzgeci: her satır bir önceki satırdan farkı (beyaz alanlar sıfır → iyi sıkışır).
    const stride = W * 3;
    const filtered = Buffer.allocUnsafe(rows * (stride + 1));
    for (let r = 0; r < rows; r++) {
      const o = r * (stride + 1);
      filtered[o] = 2;
      const cur = band.subarray(r * stride, (r + 1) * stride);
      for (let i = 0; i < stride; i++) filtered[o + 1 + i] = (cur[i]! - prev[i]!) & 0xff;
      prev = cur;
    }
    prev = Buffer.from(prev); // bant arabelleği bırakılabilsin
    await new Promise<void>((res, rej) => deflate.write(filtered, (e) => (e ? rej(e) : res())));
    for (const [key, bottom] of lastUse) {
      if (bottom <= y0 + rows) {
        tiles.delete(key);
        lastUse.delete(key);
      }
    }
  }
  deflate.end();
  await done;
  return { widthPx: W, heightPx: H, pxPerMm, zdata: Buffer.concat(out) };
}

/** Karo bandın dışına taşıyorsa kırpar (sharp bindirmesi tuvalden büyük olamaz). */
function clipOverlay(t: Tile, left: number, top: number, W: number, H: number): OverlayOptions {
  const x0 = Math.max(0, -left);
  const y0 = Math.max(0, -top);
  const x1 = Math.min(t.width, W - left);
  const y1 = Math.min(t.height, H - top);
  if (x0 === 0 && y0 === 0 && x1 === t.width && y1 === t.height) return { input: t.raw, raw: { width: t.width, height: t.height, channels: 4 }, left, top };
  const w = x1 - x0;
  const h = y1 - y0;
  const buf = Buffer.allocUnsafe(w * h * 4);
  for (let r = 0; r < h; r++) t.raw.copy(buf, r * w * 4, ((y0 + r) * t.width + x0) * 4, ((y0 + r) * t.width + x1) * 4);
  return { input: buf, raw: { width: w, height: h, channels: 4 }, left: left + x0, top: top + y0 };
}

// ---------------------------------------------------------------- PNG

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Raster sayfayı PNG'ye sarar (RGB 8 bit, pHYs = dpi). */
export function encodePng(r: RasterPage, dpi: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.widthPx, 0);
  ihdr.writeUInt32BE(r.heightPx, 4);
  ihdr[8] = 8; // bit derinliği
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const phys = Buffer.alloc(9);
  const ppm = Math.round((dpi * 1000) / MM_PER_INCH); // piksel / metre
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1; // metre
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("pHYs", phys),
    pngChunk("IDAT", r.zdata),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Sayfanın baskı PNG'si: dpi (varsayılan 300; profil `printing.dpi`), boyut = mm·dpi/25.4 (yuvarlanmış), PNG'de dpi
 * meta verisi (pHYs). Bütün katmanlar raster (kesim çizgisi görünürse dahil).
 */
export async function printPagePng(input: PrintPageRenderInput, opts: PrintRenderOptions & { dpi?: number; images?: PrintImageStore } = {}): Promise<Buffer> {
  const dpi = opts.dpi ?? DEFAULT_PRINT_DPI;
  return encodePng(await rasterizePage(input, { ...opts, dpi }), dpi);
}

/** Hızlı küçük resim (sayfa önizlemesi): `widthPx` genişliğinde PNG. Varsayılan: görünmez yuva çizgileri kılavuz olarak. */
export async function printPageThumbnail(input: PrintPageRenderInput, opts: PrintRenderOptions & { widthPx?: number; images?: PrintImageStore } = {}): Promise<Buffer> {
  const w = Math.max(16, Math.round(opts.widthPx ?? 320));
  const dpi = (w * MM_PER_INCH) / input.paper.wMm;
  return encodePng(await rasterizePage(input, { ...opts, guides: opts.guides ?? true, dpi }), dpi);
}
