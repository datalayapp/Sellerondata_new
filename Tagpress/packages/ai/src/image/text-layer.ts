import type { Box } from "@tagpress/domain";
import { flattenOnWhite, type RawImage } from "../images.ts";

/**
 * Görüntü modelinin şablon üstüne yazdığı görselden yazıyı saydam katman olarak ayırır.
 *
 * Model: her piksel "şablon + tek renkli mürekkep × örtme oranı":
 *     G = T + a · (C − T)   ⇒   a = ((G − T) · (C − T)) / |C − T|²
 * C (mürekkep rengi) zemine (kâğıt rengine) dönmeyen büyük değişikliklerin en kalabalık renk kümesidir:
 * model yazıya yer açmak için dekoru kâğıt rengine boyayabilir, bu "silme" mürekkep sayılmaz.
 * Bu modele uymayan değişiklikler atılır: kalıntısı büyük ya da örtmesi zayıf pikseller, küçük kümeler, içi
 * dolu olmayan silik izler (model koyu dekoru hafifçe yeniden çizince oluşur) ve yazı bloğundan uzak izler.
 *
 * SONUÇ DAİMA ORİJİNAL ŞABLON + BU KATMANDIR: modelin arka planı hiçbir pikselde kullanılmaz (`composeOnTemplate`).
 * Güven ölçüleri (`drift`, `edited`) modelin şablonu değiştirip değiştirmediğini söyler; çağıran reddeder.
 */

export interface LayerThresholds {
  /** Güçlü yazı pikseli örtme oranı. */
  strong: number;
  /** Bunun altındaki örtme yok sayılır. */
  weak: number;
  /** Tek renkli mürekkep modelinden en fazla sapma (RGB uzaklığı). */
  maxResidual: number;
  /** Mürekkep ile zemin bu kadar yakınsa ayırt edilemez. */
  minContrast: number;
}

export const DEFAULT_LAYER_THRESHOLDS: LayerThresholds = { strong: 0.35, weak: 0.12, maxResidual: 48, minContrast: 28 };

export interface TextLayer {
  width: number;
  height: number;
  /** Piksel başına örtme (0..255). */
  alpha: Uint8Array;
  /** Mürekkep rengi. */
  ink: [number, number, number];
  /** Yazı kutusu (piksel). Yazı yoksa null. */
  box: Box | null;
  /** Güçlü yazı piksellerinin analiz bölgesine oranı. */
  coverage: number;
  /** Yazı kutusu DIŞINDA belirgin değişen piksellerin oranı (model şablonu kaydırdı/yeniden çizdi mi?). */
  drift: number;
  /** Yazının çevresi dışında, küme hâlinde değişen piksellerin oranı (dekor silme/taşıma). */
  edited: number;
  /** Yazı piksellerinin, şablonda dekor (kâğıt rengi olmayan) üstüne düşen oranı. */
  overDecoration: number;
  regionPixels: number;
}

const maxDiff = (a: Uint8Array, b: Uint8Array, i: number) =>
  Math.max(Math.abs(a[3 * i]! - b[3 * i]!), Math.abs(a[3 * i + 1]! - b[3 * i + 1]!), Math.abs(a[3 * i + 2]! - b[3 * i + 2]!));

const bin = (buf: Uint8Array, i: number) => ((buf[3 * i]! >> 3) << 10) | ((buf[3 * i + 1]! >> 3) << 5) | (buf[3 * i + 2]! >> 3);
const binCenter = (b: number): [number, number, number] => [((b >> 10) << 3) + 4, (((b >> 5) & 31) << 3) + 4, ((b & 31) << 3) + 4];

/** Kare (Chebyshev) genişletme, ayrılabilir kayan pencereyle O(n). */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = 0; x < Math.min(w, r); x++) count += mask[row + x] ? 1 : 0;
    for (let x = 0; x < w; x++) {
      const add = x + r;
      if (add < w && mask[row + add]) count++;
      const rem = x - r - 1;
      if (rem >= 0 && mask[row + rem]) count--;
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(h, r); y++) count += tmp[y * w + x] ? 1 : 0;
    for (let y = 0; y < h; y++) {
      const add = y + r;
      if (add < h && tmp[add * w + x]) count++;
      const rem = y - r - 1;
      if (rem >= 0 && tmp[rem * w + x]) count--;
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Bağlı bileşenler (8 komşu). Her bileşen için piksel listesi verir. */
function components(mask: Uint8Array, w: number, h: number, visit: (pixels: number[]) => void, eight = true): void {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp: number[] = [];
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top]!;
      comp.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!eight && dx && dy)) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    visit(comp);
  }
}

function dropSmall(mask: Uint8Array, w: number, h: number, min: number): void {
  components(mask, w, h, (c) => {
    if (c.length < min) for (const i of c) mask[i] = 0;
  });
}

export interface ExtractOptions {
  /** Analiz bölgesi (kesim şekli maskesi, 0 = dışarıda). Yoksa bütün görsel. */
  region?: Uint8Array;
  thresholds?: Partial<LayerThresholds>;
}

/**
 * Orijinal şablon ile model görselinden yazı katmanını çıkarır. İki görsel aynı boyutta olmalı.
 * RGBA girdiler beyaza düzleştirilerek karşılaştırılır.
 */
export function extractTextLayer(original: RawImage, generated: RawImage, opts: ExtractOptions = {}): TextLayer {
  if (original.width !== generated.width || original.height !== generated.height) throw new Error("extractTextLayer: görsellerin boyutu farklı.");
  const th = { ...DEFAULT_LAYER_THRESHOLDS, ...opts.thresholds };
  const w = original.width;
  const h = original.height;
  const n = w * h;
  const T = flattenOnWhite(original).data;
  const G = flattenOnWhite(generated).data;
  const region = opts.region;
  const inside = (i: number) => !region || region[i]! > 127;
  let regionPixels = 0;
  for (let i = 0; i < n; i++) if (inside(i)) regionPixels++;
  const empty: TextLayer = { width: w, height: h, alpha: new Uint8Array(n), ink: [0, 0, 0], box: null, coverage: 0, drift: 0, edited: 0, overDecoration: 0, regionPixels };
  if (!regionPixels) return empty;
  const scale = w / 1024;

  // 1) Kâğıt rengi: şablonun bölge içindeki en yaygın renk kümesi.
  const paperCount = new Map<number, number>();
  for (let i = 0; i < n; i++) if (inside(i)) paperCount.set(bin(T, i), (paperCount.get(bin(T, i)) ?? 0) + 1);
  let paperBin = 0;
  let best = -1;
  for (const [b, c] of paperCount) if (c > best) [paperBin, best] = [b, c];
  const paper = binCenter(paperBin);
  const nearPaper = (buf: Uint8Array, i: number, tol: number) =>
    Math.hypot(buf[3 * i]! - paper[0], buf[3 * i + 1]! - paper[1], buf[3 * i + 2]! - paper[2]) < tol;

  // 2) Mürekkep rengi: kâğıda dönmeyen büyük değişikliklerin en kalabalık kümesinin medyanı.
  const inkBins = new Map<number, number>();
  const changed: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!inside(i) || maxDiff(G, T, i) <= 90 || nearPaper(G, i, 60)) continue;
    changed.push(i);
    inkBins.set(bin(G, i), (inkBins.get(bin(G, i)) ?? 0) + 1);
  }
  if (!changed.length) return empty;
  let top = 0;
  best = -1;
  for (const [b, c] of inkBins) if (c > best) [top, best] = [b, c];
  const tr = top >> 10;
  const tg = (top >> 5) & 31;
  const tb = top & 31;
  const picks: [number[], number[], number[]] = [[], [], []];
  for (const i of changed) {
    const b = bin(G, i);
    if (Math.abs((b >> 10) - tr) <= 1 && Math.abs(((b >> 5) & 31) - tg) <= 1 && Math.abs((b & 31) - tb) <= 1) for (let c = 0; c < 3; c++) picks[c]!.push(G[3 * i + c]!);
  }
  const median = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1]! : 0);
  const ink: [number, number, number] = [median(picks[0]), median(picks[1]), median(picks[2])];

  // 3) Piksel başına örtme oranı.
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!inside(i)) continue;
    const v0 = ink[0] - T[3 * i]!;
    const v1 = ink[1] - T[3 * i + 1]!;
    const v2 = ink[2] - T[3 * i + 2]!;
    const vv = v0 * v0 + v1 * v1 + v2 * v2;
    if (vv < th.minContrast ** 2) continue; // mürekkep zeminle aynı renk: ne ayırt edilir ne görünür
    const g0 = G[3 * i]! - T[3 * i]!;
    const g1 = G[3 * i + 1]! - T[3 * i + 1]!;
    const g2 = G[3 * i + 2]! - T[3 * i + 2]!;
    const a = Math.min(1, Math.max(0, (g0 * v0 + g1 * v1 + g2 * v2) / vv));
    if (a < th.weak) continue;
    if (Math.hypot(g0 - a * v0, g1 - a * v1, g2 - a * v2) > th.maxResidual) continue;
    alpha[i] = a;
  }

  // 4) Güçlü pikseller ve süzgeçler.
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (alpha[i]! >= th.strong) strong[i] = 1;
  dropSmall(strong, w, h, Math.max(5, Math.round(scale * scale * 14)));
  dropFaint(strong, w, h, alpha, (i) => maxDiff(G, T, i));
  keepTextBlocks(strong, w, h, Math.max(4, Math.round(w / 64)));

  // 5) Kenar yumuşatma: zayıf pikseller yalnızca güçlü bir yazı pikseline 2 px yakınsa.
  const near = dilate(strong, w, h, 2);
  const out = new Uint8Array(n);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let strongCount = 0;
  let overDeco = 0;
  for (let i = 0; i < n; i++) {
    if (!near[i] || alpha[i]! <= 0) continue;
    out[i] = Math.max(1, Math.round(alpha[i]! * 255));
    const x = i % w;
    const y = (i / w) | 0;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (strong[i]) {
      strongCount++;
      if (!nearPaper(T, i, 60)) overDeco++;
    }
  }
  const box: Box | null = x1 < 0 ? null : { x: Math.max(0, x0 - 2), y: Math.max(0, y0 - 2), w: Math.min(w, x1 + 3) - Math.max(0, x0 - 2), h: Math.min(h, y1 + 3) - Math.max(0, y0 - 2) };

  // 6) Güven ölçüleri.
  const inked = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (out[i]) inked[i] = 1;
  const textArea = dilate(inked, w, h, Math.max(2, Math.round(3 * scale)));
  const editedMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (inside(i) && !textArea[i] && maxDiff(G, T, i) > 40) editedMask[i] = 1;
  dropSmall(editedMask, w, h, Math.max(8, Math.round(scale * scale * 30)));
  let edited = 0;
  let moved = 0;
  for (let i = 0; i < n; i++) {
    edited += editedMask[i]!;
    if (!inside(i)) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
    if (maxDiff(G, T, i) > 60) moved++;
  }
  return {
    width: w,
    height: h,
    alpha: out,
    ink,
    box,
    coverage: strongCount / regionPixels,
    drift: moved / regionPixels,
    edited: edited / regionPixels,
    overDecoration: strongCount ? overDeco / strongCount : 0,
    regionPixels,
  };
}

/**
 * Silik kalıntılar: gerçek harfin içi tam dolu mürekkeptir ve şablona göre büyük değişimdir. Model koyu dekoru
 * hafifçe yeniden çizince oluşan izlerin örtme oranı (mürekkebe yakın renk yüzünden) yüksek çıkar ama değişimi
 * küçük ve içi dolu değildir. Ölçü: tam dolu (a ≥ 0,85) piksellerin medyan değişimi.
 */
function dropFaint(mask: Uint8Array, w: number, h: number, alpha: Float32Array, change: (i: number) => number): void {
  const solid: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] && alpha[i]! >= 0.85) solid.push(change(i));
  if (!solid.length) return;
  solid.sort((a, b) => a - b);
  const ref = solid[solid.length >> 1]!;
  components(mask, w, h, (comp) => {
    let ch = 0;
    let full = 0;
    for (const i of comp) {
      ch += change(i);
      if (alpha[i]! >= 0.85) full++;
    }
    const fill = full / comp.length;
    if ((ch / comp.length < 0.45 * ref && fill < 0.3) || (comp.length >= 40 && fill < 0.12)) for (const i of comp) mask[i] = 0;
  });
}

/**
 * Yazı sıkı bir bloktur; modelin dekorda bıraktığı izler dağınıktır. Maske `gap` kadar genişletilip bloklara
 * ayrılır; en büyük bloğun %8'inden az yazı pikseli taşıyan bloklar silinir.
 */
function keepTextBlocks(mask: Uint8Array, w: number, h: number, gap: number): void {
  const grown = dilate(mask, w, h, gap);
  const label = new Int32Array(mask.length).fill(-1);
  const weights: number[] = [];
  components(
    grown,
    w,
    h,
    (comp) => {
      const id = weights.length;
      let wsum = 0;
      for (const i of comp) {
        label[i] = id;
        if (mask[i]) wsum++;
      }
      weights.push(wsum);
    },
    false,
  );
  const max = Math.max(0, ...weights);
  for (let i = 0; i < mask.length; i++) if (mask[i] && weights[label[i]!]! < 0.08 * max) mask[i] = 0;
}

const hex = (c: [number, number, number]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
export const inkHex = hex;

/**
 * Yazı katmanını ORİJİNAL şablonun üstüne koyar. Katman alfası 0 olan her pikselde çıktı, orijinal RGBA'nın
 * bayt bayt kopyasıdır (yapı gereği şablon değişmez). Ayrıca saydam yazı katmanını (RGBA) döner.
 */
export function composeOnTemplate(template: RawImage, layer: TextLayer): { layer: RawImage; composite: RawImage } {
  const w = template.width;
  const h = template.height;
  if (layer.width !== w || layer.height !== h) throw new Error("composeOnTemplate: boyut farklı.");
  const n = w * h;
  const src = template.channels === 4 ? template.data : toRgba(template).data;
  const comp = new Uint8Array(src); // kopya: alfa 0 olan pikseller dokunulmadan kalır
  const lay = new Uint8Array(n * 4);
  const [cr, cg, cb] = layer.ink;
  for (let i = 0; i < n; i++) {
    const a8 = layer.alpha[i]!;
    if (!a8) continue;
    lay[4 * i] = cr;
    lay[4 * i + 1] = cg;
    lay[4 * i + 2] = cb;
    lay[4 * i + 3] = a8;
    const a = a8 / 255;
    const ta = src[4 * i + 3]! / 255;
    const oa = a + ta * (1 - a);
    const mix = (c: number, t: number) => Math.round((c * a + t * ta * (1 - a)) / oa);
    comp[4 * i] = mix(cr, src[4 * i]!);
    comp[4 * i + 1] = mix(cg, src[4 * i + 1]!);
    comp[4 * i + 2] = mix(cb, src[4 * i + 2]!);
    comp[4 * i + 3] = Math.round(oa * 255);
  }
  return { layer: { width: w, height: h, channels: 4, data: lay }, composite: { width: w, height: h, channels: 4, data: comp } };
}

/** Doğrulama: katman alfası 0 olan her piksel orijinalle bayt bayt aynı mı? (İlke 4: ayrıca doğrulanır.) */
export function templateUntouched(template: RawImage, composite: RawImage, alpha: Uint8Array): boolean {
  const src = template.channels === 4 ? template.data : toRgba(template).data;
  const n = template.width * template.height;
  for (let i = 0; i < n; i++) {
    if (alpha[i]) continue;
    for (let c = 0; c < 4; c++) if (src[4 * i + c] !== composite.data[4 * i + c]) return false;
  }
  return true;
}

function toRgba(img: RawImage): RawImage {
  const n = img.width * img.height;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[4 * i] = img.data[3 * i]!;
    out[4 * i + 1] = img.data[3 * i + 1]!;
    out[4 * i + 2] = img.data[3 * i + 2]!;
    out[4 * i + 3] = 255;
  }
  return { width: img.width, height: img.height, channels: 4, data: out };
}
