/**
 * Dekor maskesi YAKLAŞIĞI (tarayıcıda canlı önizleme). Kesin hesap sunucudadır ("Sunucu bindirmesi" katmanı);
 * burada amaç eşik/genişletme kaydırılırken dekorun nereye düştüğünü anında göstermektir.
 * Kural sunucuyla aynı: alpha → dolu pikseller; color → beyaz kâğıda göre renk farkı (ΔE) eşik üstü.
 */

export interface DecorOptions {
  source: "auto" | "alpha" | "color";
  /** Renk farkı eşiği (ΔE). */
  threshold: number;
  /** Dekorun çevresine eklenecek genişletme (piksel; çağıran ölçekle çarpar). */
  dilatePx: number;
}

type Lab = [number, number, number];

function rgbToLab(r: number, g: number, b: number): Lab {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const WHITE_LAB = rgbToLab(255, 255, 255);

/**
 * "auto": görselin çoğu saydamsa (yalnızca süs kesilmiş PNG) alpha, değilse color. Kesim dışındaki köşe
 * saydamlığı (yuvarlak PNG) görseli "saydam" yapmaz: o durumda dolu pikseller renkle değerlendirilir.
 */
export function resolveSource(rgba: ArrayLike<number>, n: number, source: DecorOptions["source"]): "alpha" | "color" {
  if (source !== "auto") return source;
  let transparent = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3]! < 250) transparent++;
  return transparent / Math.max(1, n) >= 0.5 ? "alpha" : "color";
}

/** Saydam olmayan piksellerin baskın rengi (kâğıt beyazından farklıysa ikinci "zemin"; kraft, renkli kâğıt). */
function dominantSurface(rgba: ArrayLike<number>, n: number): Lab | null {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3]! < 250) continue;
    opaque++;
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
  if (!best || best.n < opaque * 0.25) return null;
  const lab = rgbToLab(best.r / best.n, best.g / best.n, best.b / best.n);
  return Math.hypot(lab[0] - WHITE_LAB[0], lab[1] - WHITE_LAB[1], lab[2] - WHITE_LAB[2]) < 5 ? null : lab;
}

/**
 * RGBA → 0/1 dekor maskesi (genişletme dahil). Saydam pikseller (alfa < %5) hiçbir zaman dekor değildir;
 * color kipinde dolu pikseller beyaz kâğıda (ve varsa baskın zemin rengine) göre ΔE eşiğiyle ayrılır.
 */
export function decorationMask(rgba: ArrayLike<number>, w: number, h: number, opts: DecorOptions): Uint8Array {
  const n = w * h;
  const src = resolveSource(rgba, n, opts.source);
  const mask = new Uint8Array(n);
  const refs: Lab[] = [WHITE_LAB];
  if (src === "color") {
    const dom = dominantSurface(rgba, n);
    if (dom) refs.push(dom);
  }
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    if (src === "alpha") {
      mask[i] = a >= 0.5 ? 1 : 0;
    } else {
      if (a < 0.05) continue;
      // Beyaz kâğıt üstüne bindir, zeminlerle farkına bak.
      const r = rgba[i * 4]! * a + 255 * (1 - a);
      const g = rgba[i * 4 + 1]! * a + 255 * (1 - a);
      const b = rgba[i * 4 + 2]! * a + 255 * (1 - a);
      const [L, A, B] = rgbToLab(r, g, b);
      let d = Infinity;
      for (const ref of refs) d = Math.min(d, Math.hypot(L - ref[0], A - ref[1], B - ref[2]));
      mask[i] = d >= opts.threshold ? 1 : 0;
    }
  }
  return dilateBox(mask, w, h, Math.round(opts.dilatePx));
}

/** Kare çekirdekle genişletme (ayrılabilir, ön toplamlı). r ≤ 0 ise aynen döner. */
export function dilateBox(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const horiz = new Uint8Array(mask.length);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x]! + mask[y * w + x]!;
    for (let x = 0; x < w; x++) horiz[y * w + x] = pre[Math.min(w, x + r + 1)]! - pre[Math.max(0, x - r)]! > 0 ? 1 : 0;
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y]! + horiz[y * w + x]!;
    for (let y = 0; y < h; y++) out[y * w + x] = pre[Math.min(h, y + r + 1)]! - pre[Math.max(0, y - r)]! > 0 ? 1 : 0;
  }
  return out;
}

/** Maskeyi tek renkli yarı saydam RGBA'ya çevirir (`rgb` + alfa 0..255). */
export function tintMask(mask: Uint8Array, rgb: [number, number, number], alpha: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = alpha;
  }
  return out;
}
