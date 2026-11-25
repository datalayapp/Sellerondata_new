import {
  LineJoinStyle,
  PDFDocument,
  PDFHexString,
  PDFName,
  type PDFImage,
  type PDFOperator,
  type PDFPage,
  appendBezierCurve,
  clip,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endPath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setGraphicsState,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "pdf-lib";
import sharp from "sharp";
import { MM_PER_INCH, mmToPt, ptToMm } from "@tagpress/domain";
import {
  DEFAULT_PRINT_DPI,
  type ImageSource,
  type LabelArt,
  PrintImageStore,
  type PrintPageRenderInput,
  type PrintRenderItem,
  type PrintRenderOptions,
  bleedTemplateMatrix,
  itemMatrix,
  itemMetrics,
  pageVectors,
  rasterizePage,
} from "./print.ts";
import { type Mat, type PathCmd, type VecShape, cellLabelShape, cellLabelShapes, cmdsBounds, defaultCellLabelFont, mul, parsePathD, scaleMat, shapeCmds, translate } from "./print-vector.ts";

/**
 * Baskı PDF'i (pdf-lib). Sayfa gerçek mm boyutundadır (pt = mm · 72 / 25,4); her baskı sayfası PDF'te BİR KEZ yer alır,
 * adı ve kopya sayısı sayfa etiketinde (PageLabels: görüntüleyicinin sayfa kutusunda "4849_3sayfa · 2 kopya") ve belge
 * konusunda (Subject) yazılıdır — kağıda basılmaz (isteğe bağlı `printNote` ile alt kenar boşluğuna küçük not).
 *
 * İki kip:
 * - `raster` (varsayılan): etiketler + hücre etiketleri tek sayfa görseli (dpi, kayıpsız Flate + PNG öngörücüsü);
 *   yuva kesim çizgileri ve kayıt işaretleri VEKTÖR (kesim makinesi keskin çizgi okur). Böylece belgedeki tek vektör
 *   yollar kesim/kayıt yollarıdır (PDF kesim yazılımına alınırsa yalnızca onlar kesim yolu olur).
 * - `vector`: şablon görseli raster (dpi'de küçültülmüş, etiket başına bir kez gömülü), yazı glifleri, hücre
 *   etiketleri, kesim çizgileri ve kayıt işaretleri vektör. Yazı katmanı çözülemezse (beklenmeyen SVG) o etiketin
 *   yazısı raster'a düşer.
 */

export interface PrintPdfPage extends PrintPageRenderInput {
  /** Sayfa adı ("4849_3sayfa"). */
  name: string;
  /** Bu sayfadan kaç kopya basılacak (PDF'te sayfa bir kez yer alır). */
  copies: number;
}

export interface PrintPdfOptions extends PrintRenderOptions {
  dpi?: number;
  mode?: "raster" | "vector";
  /** Belge başlığı (ör. baskı oturumunun adı). */
  title?: string;
  /** Sayfa adı ve kopya sayısını alt kenar boşluğuna küçük yazıyla bas (varsayılan kapalı; boş yer yoksa üst kenar, o da yoksa basılmaz). */
  printNote?: boolean;
  images?: PrintImageStore;
}

const PT_PER_MM = mmToPt(1);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function pageLabel(p: Pick<PrintPdfPage, "name" | "copies">): string {
  return `${p.name} · ${p.copies} kopya`;
}

export async function printPdf(pages: readonly PrintPdfPage[], opts: PrintPdfOptions = {}): Promise<Uint8Array> {
  const dpi = opts.dpi ?? DEFAULT_PRINT_DPI;
  const mode = opts.mode ?? "raster";
  const store = opts.images ?? new PrintImageStore();
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title ?? "Baskı");
  doc.setCreator("TagPress");
  doc.setProducer("TagPress baskı masası (pdf-lib)");
  doc.setSubject(pages.map(pageLabel).join("; "));
  doc.setKeywords(pages.map((p) => `${p.name}=${p.copies}`));
  const embedded = new Map<string, Promise<PDFImage>>();

  for (const p of pages) {
    const page = doc.addPage([p.paper.wMm * PT_PER_MM, p.paper.hMm * PT_PER_MM]);
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(PT_PER_MM, 0, 0, -PT_PER_MM, 0, p.paper.hMm * PT_PER_MM)];
    const vec = pageVectors(p, opts);

    if (mode === "raster") {
      const r = await rasterizePage(p, { ...opts, dpi, images: store, vectors: { cellLabels: true, registration: false, outlines: false } });
      const stream = doc.context.stream(r.zdata, {
        Type: "XObject",
        Subtype: "Image",
        Width: r.widthPx,
        Height: r.heightPx,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
        Filter: "FlateDecode",
        DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: r.widthPx },
      });
      const name = page.node.newXObject("Sayfa", doc.context.register(stream));
      const wMm = r.widthPx / r.pxPerMm;
      const hMm = r.heightPx / r.pxPerMm;
      ops.push(pushGraphicsState(), concatTransformationMatrix(wMm, 0, 0, -hMm, 0, hMm), drawObject(name), popGraphicsState());
    } else {
      const bg = parseColor(p.background ?? "#ffffff");
      if (bg && !(bg.r === 1 && bg.g === 1 && bg.b === 1)) {
        ops.push(setFillingRgbColor(bg.r, bg.g, bg.b), ...pathOps([{ t: "M", x: 0, y: 0 }, { t: "L", x: p.paper.wMm, y: 0 }, { t: "L", x: p.paper.wMm, y: p.paper.hMm }, { t: "L", x: 0, y: p.paper.hMm }, { t: "Z" }]), fill());
      }
      for (const item of p.items) append(ops, await itemVectorOps(doc, page, item, p.cut.bleedMm, dpi, store, embedded, p.background ?? "#ffffff"));
      for (const c of vec.cellLabels) for (const sh of [c.shape, ...c.colors]) append(ops, shapeOps(page, doc, sh));
    }

    for (const r of vec.registration) append(ops, shapeOps(page, doc, r));
    for (const o of vec.outlines) append(ops, shapeOps(page, doc, o.shape));
    if (opts.printNote) {
      for (const note of noteShapes(p, opts)) append(ops, shapeOps(page, doc, note));
    }
    ops.push(popGraphicsState());
    // Büyük diziler yayılırsa (`...`) yığın taşar: parça parça.
    for (let i = 0; i < ops.length; i += 8192) page.pushOperators(...ops.slice(i, i + 8192));
  }

  // Sayfa etiketleri: görüntüleyicide sayfa numarası yerine "ad · N kopya".
  const nums: unknown[] = [];
  pages.forEach((p, i) => nums.push(i, doc.context.obj({ P: PDFHexString.fromText(pageLabel(p)) })));
  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: nums as never }));
  return doc.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- vektör yardımcıları

/** Uzun dizileri yaymadan ekler (yığın taşmasın). */
function append<T>(to: T[], from: readonly T[]): void {
  for (const x of from) to.push(x);
}

function pathOps(cmds: readonly PathCmd[]): PDFOperator[] {
  const out: PDFOperator[] = [];
  for (const c of cmds) {
    if (c.t === "M") out.push(moveTo(r3(c.x), r3(c.y)));
    else if (c.t === "L") out.push(lineTo(r3(c.x), r3(c.y)));
    else if (c.t === "C") out.push(appendBezierCurve(r3(c.x1), r3(c.y1), r3(c.x2), r3(c.y2), r3(c.x), r3(c.y)));
    else out.push(closePath());
  }
  return out;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff" };

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb()", "rgba()", "black", "white"; "none"/"transparent" → null. Bilinmeyen → undefined. */
export function parseColor(c: string): Rgba | null | undefined {
  const s = (NAMED[c.trim().toLowerCase()] ?? c).trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1]!.split("").map((h) => parseInt(h + h, 16) / 255) as [number, number, number];
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) {
    const v = m[1]!;
    return { r: parseInt(v.slice(0, 2), 16) / 255, g: parseInt(v.slice(2, 4), 16) / 255, b: parseInt(v.slice(4, 6), 16) / 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1]!.split(",").map((x) => Number(x.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((x) => Number.isFinite(x)))
      return { r: parts[0]! / 255, g: parts[1]! / 255, b: parts[2]! / 255, a: parts[3] !== undefined && Number.isFinite(parts[3]) ? parts[3] : 1 };
  }
  return undefined;
}

const gsCache = new WeakMap<PDFPage, Map<number, PDFName>>();
function alphaState(page: PDFPage, doc: PDFDocument, a: number): PDFName {
  let m = gsCache.get(page);
  if (!m) gsCache.set(page, (m = new Map()));
  const k = Math.round(a * 1000) / 1000;
  let n = m.get(k);
  if (!n) {
    n = page.node.newExtGState("GS", doc.context.obj({ Type: "ExtGState", ca: k, CA: k }));
    m.set(k, n);
  }
  return n;
}

/** Dolgu/kontur şekli: SVG `paint-order="stroke"` gibi önce kontur, sonra dolgu. */
function shapeOps(page: PDFPage, doc: PDFDocument, v: VecShape, strokeFirst = true, alpha = 1): PDFOperator[] {
  if (!v.cmds.length) return [];
  const out: PDFOperator[] = [pushGraphicsState()];
  if (alpha < 1) out.push(setGraphicsState(alphaState(page, doc, alpha)));
  const f = v.fill ? parseColor(v.fill) : null;
  const s = v.stroke && v.strokeWidth > 0 ? parseColor(v.stroke) : null;
  const doStroke = () => {
    if (!s) return;
    out.push(setStrokingRgbColor(s.r, s.g, s.b), setLineWidth(r3(v.strokeWidth)), setLineJoin(LineJoinStyle.Round));
    append(out, pathOps(v.cmds));
    out.push(stroke());
  };
  const doFill = () => {
    if (!f) return;
    out.push(setFillingRgbColor(f.r, f.g, f.b));
    append(out, pathOps(v.cmds));
    out.push(fill());
  };
  if (strokeFirst) {
    doStroke();
    doFill();
  } else {
    doFill();
    doStroke();
  }
  out.push(popGraphicsState());
  return out;
}

// ---------------------------------------------------------------- yazı katmanı SVG'si (vektör kip)

interface TextPath {
  shape: VecShape;
  alpha: number;
  strokeFirst: boolean;
}

/**
 * `textLayerSvg` çıktısını vektör yollara çözer: yalnızca `svg`, `g`, `path` öğeleri ve `fill`, `stroke`,
 * `stroke-width`, `paint-order`, `stroke-linejoin` öznitelikleri (motorun ürettiği biçim). Başka bir şey
 * (dönüşüm, görsel, metin, opaklık) görülürse null → çağıran yazıyı raster çizer.
 */
export function parseTextLayerSvg(svg: string): { viewBox: [number, number, number, number]; paths: TextPath[] } | null {
  const root = svg.match(/<svg\b([^>]*)>/);
  if (!root) return null;
  const vb = root[1]!.match(/viewBox="([^"]+)"/)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const w = Number(root[1]!.match(/\bwidth="([\d.]+)"/)?.[1] ?? NaN);
  const h = Number(root[1]!.match(/\bheight="([\d.]+)"/)?.[1] ?? NaN);
  const viewBox = (vb && vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, w, h]) as [number, number, number, number];
  if (!viewBox.every(Number.isFinite)) return null;
  type Inh = { fill: string; stroke: string; strokeWidth: number; paintOrder: string };
  const stack: Inh[] = [{ fill: "#000000", stroke: "none", strokeWidth: 1, paintOrder: "normal" }];
  const paths: TextPath[] = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = re.exec(svg))) {
    const [, closing, tag, attrStr, selfClose] = m;
    if (first) {
      first = false;
      if (tag !== "svg") return null;
      continue;
    }
    if (closing) {
      if (tag === "g") stack.pop();
      continue;
    }
    const attrs = parseAttrs(attrStr!);
    if (attrs.transform || attrs.opacity || attrs["fill-opacity"] || attrs["stroke-opacity"] || attrs.style || attrs["clip-path"] || attrs.mask) return null;
    const cur = stack[stack.length - 1]!;
    const next: Inh = {
      fill: attrs.fill ?? cur.fill,
      stroke: attrs.stroke ?? cur.stroke,
      strokeWidth: attrs["stroke-width"] !== undefined ? Number(attrs["stroke-width"]) : cur.strokeWidth,
      paintOrder: attrs["paint-order"] ?? cur.paintOrder,
    };
    if (tag === "g") {
      if (!selfClose) stack.push(next);
      continue;
    }
    if (tag === "svg" && closing) continue;
    if (tag !== "path") return null;
    const cmds = parsePathD(attrs.d ?? "");
    if (!cmds) return null;
    const fc = parseColor(next.fill);
    const sc = parseColor(next.stroke);
    if (fc === undefined || sc === undefined || !Number.isFinite(next.strokeWidth)) return null;
    const alpha = Math.min(fc?.a ?? 1, sc && next.strokeWidth > 0 ? sc.a : 1);
    paths.push({
      shape: { cmds, fill: fc ? next.fill : null, stroke: sc && next.strokeWidth > 0 ? next.stroke : null, strokeWidth: next.strokeWidth },
      alpha,
      strokeFirst: /^\s*stroke/.test(next.paintOrder),
    });
  }
  return { viewBox, paths };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

// ---------------------------------------------------------------- etiket (vektör kip)

/**
 * Görseli dpi'deki piksel boyutuna küçültüp gömer (aynı kaynak + boyut bir kez). `flatten`: saydamlığı kağıt rengine
 * düzleştir — şablon görselinde SMask kenarlarında görüntüleyicilerin çizdiği gri saçak oluşmaz, dosya küçülür
 * (şablon zaten kağıdın üstünde ve kesim şekliyle kırpılı). Yazı katmanı PNG'si saydam kalır.
 */
async function embedImage(
  doc: PDFDocument,
  store: PrintImageStore,
  cache: Map<string, Promise<PDFImage>>,
  src: ImageSource,
  wPx: number,
  hPx: number,
  flatten: string | null,
): Promise<PDFImage> {
  const W = Math.max(1, Math.round(wPx));
  const H = Math.max(1, Math.round(hPx));
  const key = `${store.id(src)}|${W}x${H}|${flatten ?? ""}`;
  let p = cache.get(key);
  if (!p) {
    p = store
      .resized(src, W, H)
      .then((png) => (flatten ? sharp(png).flatten({ background: flatten }).png({ compressionLevel: 6 }).toBuffer() : png))
      .then((png) => doc.embedPng(png));
    cache.set(key, p);
  }
  return p;
}

const xobjNames = new WeakMap<PDFPage, Map<PDFImage, PDFName>>();

/** Görseli tasarım px kutusuna çizer (geçerli CTM y aşağı; PDF görsel uzayı y yukarı → dikey çevrilir). */
function imageOps(page: PDFPage, img: PDFImage, box: { x: number; y: number; w: number; h: number }, extra: Mat | null): PDFOperator[] {
  let names = xobjNames.get(page);
  if (!names) xobjNames.set(page, (names = new Map()));
  let name = names.get(img);
  if (!name) {
    name = page.node.newXObject("Im", img.ref);
    names.set(img, name);
  }
  const ops: PDFOperator[] = [pushGraphicsState()];
  if (extra) ops.push(concatTransformationMatrix(...(extra as [number, number, number, number, number, number])));
  ops.push(concatTransformationMatrix(r3(box.w), 0, 0, r3(-box.h), r3(box.x), r3(box.y + box.h)), drawObject(name), popGraphicsState());
  return ops;
}

async function itemVectorOps(
  doc: PDFDocument,
  page: PDFPage,
  item: PrintRenderItem,
  bleedMm: number,
  dpi: number,
  store: PrintImageStore,
  cache: Map<string, Promise<PDFImage>>,
  background: string,
): Promise<PDFOperator[]> {
  const art: LabelArt = item.art;
  const { mmPerPx, bleedPx } = itemMetrics(item, bleedMm);
  const k = (dpi / MM_PER_INCH) * mmPerPx; // görsel pikseli / tasarım px
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...(itemMatrix(item) as [number, number, number, number, number, number]))];
  if (art.clip) {
    append(ops, pathOps(shapeCmds(art.clip, bleedPx)));
    ops.push(clip(), endPath());
  }
  if (art.template) {
    const bm = bleedTemplateMatrix(art.clip, bleedPx);
    const img = await embedImage(doc, store, cache, art.template.source, art.template.box.w * k * bm[0], art.template.box.h * k * bm[0], background);
    ops.push(...imageOps(page, img, art.template.box, bm));
  }
  const F = art.designFramePx;
  if (art.text?.kind === "png") {
    const img = await embedImage(doc, store, cache, art.text.source, art.text.box.w * k, art.text.box.h * k, null);
    ops.push(...imageOps(page, img, art.text.box, null));
  } else if (art.text?.kind === "svg") {
    const parsed = parseTextLayerSvg(art.text.svg);
    if (parsed) {
      const [vx, vy, vw, vh] = parsed.viewBox;
      const m = mul(scaleMat(F / vw, F / vh), translate(-vx, -vy));
      ops.push(pushGraphicsState(), concatTransformationMatrix(...(m as [number, number, number, number, number, number])));
      for (const p of parsed.paths) append(ops, shapeOps(page, doc, p.shape, p.strokeFirst, p.alpha));
      ops.push(popGraphicsState());
    } else {
      // Beklenmeyen SVG: yazı katmanı raster (dpi) olarak.
      const px = Math.max(1, Math.round(F * k));
      const png = await sharp(Buffer.from(art.text.svg)).resize(px, px, { fit: "fill" }).png().toBuffer();
      const img = await doc.embedPng(png);
      ops.push(...imageOps(page, img, { x: 0, y: 0, w: F, h: F }, null));
    }
  }
  ops.push(popGraphicsState());
  return ops;
}

// ---------------------------------------------------------------- basılı not (isteğe bağlı)

/** Sayfa adı + kopya: alt kenar boşluğunda ortalı, 6 pt koyu; yer yoksa üstte; o da yoksa boş (emoji renkli katmanlarıyla). */
function noteShapes(p: PrintPdfPage, opts: PrintRenderOptions): VecShape[] {
  const font = opts.cellLabelFont ?? defaultCellLabelFont();
  // Renk: DESIGN.md `label-ink` (kağıt üstü yazı).
  const style = { sizePt: 6, color: "#141414" };
  const probe = cellLabelShape(pageLabel(p), 0, 0, style, font);
  const b = cmdsBounds(probe.cmds);
  if (!b) return [];
  const textH = ptToMm(style.sizePt);
  // Dolu alan: yuvalar (taşma payıyla), kayıt işaretleri.
  let top = Infinity;
  let bottom = -Infinity;
  for (const s of p.slots) {
    const r = Math.max(s.w, s.h) / 2 + p.cut.bleedMm;
    top = Math.min(top, s.cy - r);
    bottom = Math.max(bottom, s.cy + r);
  }
  for (const it of p.items) {
    const r = (it.diameterMm * (it.scale ?? 1)) / 2 + p.cut.bleedMm;
    top = Math.min(top, it.yMm - r);
    bottom = Math.max(bottom, it.yMm + r);
  }
  if (p.cut.registration.enabled) {
    const reg = p.cut.registration;
    top = Math.min(top, reg.insetMm + reg.sizeMm);
    bottom = Math.max(bottom, p.paper.hMm - reg.insetMm - reg.sizeMm);
  }
  const gap = 1;
  const x = (p.paper.wMm - (b.x1 - b.x0)) / 2 - b.x0;
  if (p.paper.hMm - bottom >= textH + 2 * gap + 3) return cellLabelShapes(pageLabel(p), x, p.paper.hMm - 3 - textH - gap, style, font);
  if (top >= textH + 2 * gap + 3) return cellLabelShapes(pageLabel(p), x, 3, style, font);
  return [];
}
