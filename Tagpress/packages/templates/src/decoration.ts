import sharp from "sharp";
import type { Box } from "@tagpress/domain";
import { type Grid, boxBlur, components, deltaE, removeSmall, squaredDistance, toLab } from "./raster.ts";

/**
 * Şablon görselini tasarım alanına yerleştirir ve dekor maskesini çıkarır.
 *
 * Yaklaşım (sade): görsel kâğıt beyazı üstüne bindirilir; kesim içindeki baskın renkler "zemin" adayıdır.
 * Bir zemin parçası, içine sığan en büyük dairenin yarıçapı kesim çapının %4'ü kadarsa yazı taşıyabilir
 * (geniş leke, kraft doku); daha ince olanlar (halka, çerçeve, yaprak arası boşluk) zemin sayılmaz.
 * Zemin olmayan ve zeminden belirgin farklı (ΔE ≥ eşik) pikseller dekordur.
 */

export const PAPER_WHITE = 255;
/** Yazı taşıyabilecek zemin kalınlığı: içine sığan dairenin yarıçapı ≥ kesim çapının bu oranı. */
export const WRITABLE_THICKNESS = 0.04;
/** Doku zeminlerinde (ana zemin dışındaki yazılabilir zeminler) renk eşiği bu kadar gevşek. */
const TEXTURE_LOOSEN = 1.6;
/**
 * Doku zemini ana zeminle benzer açıklıkta olmalı (|ΔL*| ≤ bu): aynı yazı rengi ikisinde de okunur. Koyu, dolu
 * bir dekor lekesi (yeşil yaprak kümesi, kahverengi bant) kalın olsa da zemin sayılmaz.
 */
const TEXTURE_MAX_DL = 35;
/** Zemin adayı olmak için kesim alanının en az bu oranını kaplamak gerekir. */
const SEED_MIN_SHARE = 0.02;
/** Birbirine bundan yakın zemin renkleri tek zemindir (ΔE). */
const SEED_MERGE = 10;
const MAX_SEEDS = 6;
/** Saydamlık "anlamlı" sayılır: kesim içindeki piksellerin bu oranı (neredeyse) tamamen saydamsa. */
const MEANINGFUL_TRANSPARENCY = 0.05;

export interface Composite {
  grid: Grid;
  scale: number;
  /** Kâğıt beyazı üstüne bindirilmiş RGB (3 kanal). */
  rgb: Uint8Array;
  /** Görselin alfa kanalı (görsel dışı 0). */
  alpha: Uint8Array;
}

/** Görseli `box` (tasarım px) içine yerleştirip `framePx × scale` boyutlu tuvale bindirir. */
export async function compositeTemplate(image: Buffer | string, box: Box, framePx: number, scale: number): Promise<Composite> {
  const size = Math.round(framePx * scale);
  const grid = { w: size, h: size };
  const tw = Math.max(1, Math.round(box.w * scale));
  const th = Math.max(1, Math.round(box.h * scale));
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .resize(tw, th, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ox = Math.round(box.x * scale);
  const oy = Math.round(box.y * scale);
  const rgb = new Uint8Array(size * size * 3).fill(PAPER_WHITE);
  const alpha = new Uint8Array(size * size);
  for (let ty = 0; ty < info.height; ty++) {
    const y = ty + oy;
    if (y < 0 || y >= size) continue;
    for (let tx = 0; tx < info.width; tx++) {
      const x = tx + ox;
      if (x < 0 || x >= size) continue;
      const s = (ty * info.width + tx) * 4;
      const a = data[s + 3]!;
      if (a === 0) continue;
      const i = y * size + x;
      alpha[i] = a;
      const k = a / 255;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(data[s + c]! * k + PAPER_WHITE * (1 - k));
    }
  }
  return { grid, scale, rgb, alpha };
}

export interface DecorationOptions {
  source: "auto" | "alpha" | "color";
  threshold: number;
  /** Kesim çapı (maske pikseli). */
  cutDiameterPx: number;
}

export interface DecorationResult {
  /** Dekor (genişletilmemiş, gürültüsü atılmış). */
  mask: Uint8Array;
  /** Hangi yöntem uygulandı. */
  method: "alpha" | "color";
  /** Zemin renkleri (Lab) ve yazı taşıyıp taşımadıkları — açıklama/test için. */
  surfaces: Array<{ lab: [number, number, number]; writable: boolean; share: number }>;
}

export function decorationMask(c: Composite, cut: Uint8Array, opts: DecorationOptions): DecorationResult {
  const { grid, scale } = c;
  const N = grid.w * grid.h;
  const minNoise = Math.max(4, Math.round(2 * scale * scale));
  let labelArea = 0;
  let transparent = 0;
  for (let i = 0; i < N; i++) {
    if (!cut[i]) continue;
    labelArea++;
    if (c.alpha[i]! < 8) transparent++;
  }

  if (opts.source === "alpha") {
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = cut[i] && c.alpha[i]! >= 128 ? 1 : 0;
    return { mask: removeSmall(m, grid, minNoise), method: "alpha", surfaces: [] };
  }

  // Saydam zeminli görsellerde (A serisi) saydam pikseller hiçbir zaman dekor değildir; dolu piksellerin
  // hepsi de dekor değildir (beyaz kare zemin, doku), o yüzden yine renkle karar verilir.
  const alphaAware = opts.source === "auto" && labelArea > 0 && transparent / labelArea >= MEANINGFUL_TRANSPARENCY;

  const lab = toLab(c.rgb, N);
  const blurR = Math.max(1, Math.round(scale));
  const labB = boxBlur(boxBlur(lab, grid, 3, blurR), grid, 3, blurR);

  // 1) Zemin renkleri: bulanık Lab histogramının tepeleri.
  const bins = new Map<number, { n: number; L: number; a: number; b: number }>();
  for (let i = 0; i < N; i++) {
    if (!cut[i]) continue;
    const L = labB[i * 3]!, A = labB[i * 3 + 1]!, B = labB[i * 3 + 2]!;
    const key = (Math.floor(L / 6) * 64 + Math.floor((A + 128) / 6)) * 64 + Math.floor((B + 128) / 6);
    const bin = bins.get(key) ?? { n: 0, L: 0, a: 0, b: 0 };
    bin.n++;
    bin.L += L;
    bin.a += A;
    bin.b += B;
    bins.set(key, bin);
  }
  const seeds: Array<[number, number, number]> = [];
  for (const bin of [...bins.values()].sort((p, q) => q.n - p.n)) {
    if (seeds.length >= MAX_SEEDS || bin.n < labelArea * SEED_MIN_SHARE) break;
    const s: [number, number, number] = [bin.L / bin.n, bin.a / bin.n, bin.b / bin.n];
    if (seeds.some((t) => deltaE(s[0], s[1], s[2], t[0], t[1], t[2]) < SEED_MERGE)) continue;
    seeds.push(s);
  }
  if (!seeds.length) seeds.push([100, 0, 0]);

  // 2) Her pikseli (bulanık rengine göre) en yakın zemine ata.
  const surfaceOf = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!cut[i]) continue;
    let best = 0, bestD = opts.threshold;
    for (let s = 0; s < seeds.length; s++) {
      const t = seeds[s]!;
      const d = deltaE(labB[i * 3]!, labB[i * 3 + 1]!, labB[i * 3 + 2]!, t[0], t[1], t[2]);
      if (d < bestD) { bestD = d; best = s + 1; }
    }
    surfaceOf[i] = best;
  }

  // 3) Zemin parçalarının kalınlığı: ince olanlar yazı taşımaz.
  const minThick2 = (WRITABLE_THICKNESS * opts.cutDiameterPx) ** 2;
  const writablePx = new Uint8Array(N);
  const stats = seeds.map((lab) => ({ lab, writable: false, share: 0 }));
  let anyWritable = false;
  let largest: { s: number; comp: number; area: number; labels: Int32Array } | null = null;
  for (let s = 1; s <= seeds.length; s++) {
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = surfaceOf[i] === s ? 1 : 0;
    const { labels, count, areas } = components(m, grid);
    if (!count) continue;
    const inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = m[i] ? 0 : 1;
    const d2 = squaredDistance(inv, grid, true);
    const thick = new Float64Array(count + 1);
    for (let i = 0; i < N; i++) if (labels[i] && d2[i]! > thick[labels[i]!]!) thick[labels[i]!] = d2[i]!;
    for (let k = 1; k <= count; k++) {
      if (!largest || areas[k]! > largest.area) largest = { s, comp: k, area: areas[k]!, labels };
    }
    for (let i = 0; i < N; i++) {
      const k = labels[i]!;
      if (k && thick[k]! >= minThick2) {
        writablePx[i] = s;
        stats[s - 1]!.share++;
        anyWritable = true;
      }
    }
  }
  // Hiçbir zemin yeterince kalın değilse en büyük parça zemin sayılır (alan hiç bulunamamasındansa).
  if (!anyWritable && largest) {
    for (let i = 0; i < N; i++) if (largest.labels[i] === largest.comp) writablePx[i] = largest.s;
  }
  for (const st of stats) {
    st.share = labelArea ? Math.round((st.share / labelArea) * 1000) / 1000 : 0;
    st.writable = st.share > 0;
  }
  // Ana zemin: en çok yer kaplayan yazılabilir zemin; diğer yazılabilir zeminler dokudur.
  let main = 1, mainShare = -1;
  stats.forEach((st, k) => {
    if (st.share > mainShare) { mainShare = st.share; main = k + 1; }
  });
  // Ana zeminden çok farklı açıklıktaki "doku" zemin değil, dekordur.
  const mainL = seeds[main - 1]![0];
  const darkTexture = seeds.map((s, k) => k + 1 !== main && Math.abs(s[0] - mainL) > TEXTURE_MAX_DL);
  if (darkTexture.some(Boolean)) {
    for (let i = 0; i < N; i++) if (writablePx[i] && darkTexture[writablePx[i]! - 1]) writablePx[i] = 0;
    darkTexture.forEach((dark, k) => {
      if (dark) { stats[k]!.writable = false; stats[k]!.share = 0; }
    });
  }

  // 4) Sınıflandırma: ham renge göre (ince altın çizgiler bulanıkta kaybolmasın diye).
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!cut[i]) continue;
    if (alphaAware && c.alpha[i]! < 8) continue;
    const s = writablePx[i]!;
    if (!s) { mask[i] = 1; continue; }
    const t = seeds[s - 1]!;
    const d = deltaE(lab[i * 3]!, lab[i * 3 + 1]!, lab[i * 3 + 2]!, t[0], t[1], t[2]);
    const limit = s === main ? opts.threshold : opts.threshold * TEXTURE_LOOSEN;
    if (d >= limit) mask[i] = 1;
  }
  return {
    mask: removeSmall(mask, grid, minNoise),
    method: "color",
    surfaces: stats.map((s) => ({ lab: [round1(s.lab[0]), round1(s.lab[1]), round1(s.lab[2])], writable: s.writable, share: s.share })),
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Maskedeki piksellerin ortalama L* değeri (0..1). */
export function meanLightness(c: Composite, mask: Uint8Array): number {
  let sum = 0, n = 0;
  const N = c.grid.w * c.grid.h;
  const cache = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const r = c.rgb[i * 3]!, g = c.rgb[i * 3 + 1]!, b = c.rgb[i * 3 + 2]!;
    const key = (r << 16) | (g << 8) | b;
    let L = cache.get(key);
    if (L === undefined) {
      L = toLab(new Uint8Array([r, g, b]), 1)[0]!;
      cache.set(key, L);
    }
    sum += L;
    n++;
  }
  return n ? sum / n / 100 : 1;
}
