import type { Bitmap, Box, Shape } from "@tagpress/domain";

/**
 * Düşük düzey raster yardımcıları. Bütün maskeler 0/1 değerli `Uint8Array`, satır satır (y * w + x).
 * Uzaklıklar piksel cinsindendir (maskenin kendi çözünürlüğünde).
 */

export interface Grid {
  w: number;
  h: number;
}

/** sRGB (0..255) → CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 renk farkı (ΔE). Eşikler bu ölçüde verilir. */
export function deltaE(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number): number {
  const dl = l1 - l2, da = a1 - a2, db = b1 - b2;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** RGB tamponunu (3 kanal) Lab'a çevirir; aynı renkler önbellekten gelir. */
export function toLab(rgb: Uint8Array, n: number): Float32Array {
  const lab = new Float32Array(n * 3);
  const cache = new Map<number, [number, number, number]>();
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (!v) {
      v = rgbToLab(r, g, b);
      cache.set(key, v);
    }
    lab[i * 3] = v[0];
    lab[i * 3 + 1] = v[1];
    lab[i * 3 + 2] = v[2];
  }
  return lab;
}

/** Ayrılabilir kutu bulanıklığı (kanal sayısı `ch`, yarıçap `r`). */
export function boxBlur(src: Float32Array, g: Grid, ch: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < g.h; y++) {
    for (let c = 0; c < ch; c++) {
      let sum = 0, cnt = 0;
      for (let x = 0; x <= Math.min(g.w - 1, r - 1); x++) { sum += src[(y * g.w + x) * ch + c]!; cnt++; }
      for (let x = 0; x < g.w; x++) {
        const add = x + r;
        if (add < g.w) { sum += src[(y * g.w + add) * ch + c]!; cnt++; }
        const rem = x - r - 1;
        if (rem >= 0) { sum -= src[(y * g.w + rem) * ch + c]!; cnt--; }
        tmp[(y * g.w + x) * ch + c] = sum / cnt;
      }
    }
  }
  for (let x = 0; x < g.w; x++) {
    for (let c = 0; c < ch; c++) {
      let sum = 0, cnt = 0;
      for (let y = 0; y <= Math.min(g.h - 1, r - 1); y++) { sum += tmp[(y * g.w + x) * ch + c]!; cnt++; }
      for (let y = 0; y < g.h; y++) {
        const add = y + r;
        if (add < g.h) { sum += tmp[(add * g.w + x) * ch + c]!; cnt++; }
        const rem = y - r - 1;
        if (rem >= 0) { sum -= tmp[(rem * g.w + x) * ch + c]!; cnt--; }
        out[(y * g.w + x) * ch + c] = sum / cnt;
      }
    }
  }
  return out;
}

const INF = 1e20;

/** Tek boyutlu kare uzaklık dönüşümü (Felzenszwalb–Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/**
 * Her pikselin en yakın "dolu" (mask=1) piksele kare Öklid uzaklığı. Dolu piksel yoksa çok büyük değer.
 * `outsideIsSet`: ızgara dışı dolu sayılsın mı (kenara uzaklık için).
 */
export function squaredDistance(mask: Uint8Array, g: Grid, outsideIsSet = false): Float64Array {
  const W = outsideIsSet ? g.w + 2 : g.w;
  const H = outsideIsSet ? g.h + 2 : g.h;
  const o = outsideIsSet ? 1 : 0;
  const grid = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ix = x - o, iy = y - o;
      const inside = ix >= 0 && iy >= 0 && ix < g.w && iy < g.h;
      grid[y * W + x] = (inside ? mask[iy * g.w + ix] === 1 : true) ? 0 : INF;
    }
  }
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x]!;
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y]!;
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x]!;
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) grid[y * W + x] = d[x]!;
  }
  if (!outsideIsSet) return grid;
  const out = new Float64Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) out[y * g.w + x] = grid[(y + 1) * W + x + 1]!;
  return out;
}

/** Maskeyi `r` piksel genişletir (Öklid). */
export function dilate(mask: Uint8Array, g: Grid, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const d2 = squaredDistance(mask, g);
  const r2 = r * r;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = d2[i]! <= r2 ? 1 : 0;
  return out;
}

/** Maskeyi `r` piksel daraltır (ızgara dışı boş sayılır). */
export function erode(mask: Uint8Array, g: Grid, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const d2 = squaredDistance(inv, g, true);
  const r2 = r * r;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] && d2[i]! > r2 ? 1 : 0;
  return out;
}

/** 4-komşu bağlı bileşenler. `labels` 1'den başlar; 0 = boş. */
export function components(mask: Uint8Array, g: Grid): { labels: Int32Array; count: number; areas: number[] } {
  const labels = new Int32Array(mask.length);
  const areas: number[] = [0];
  const stack = new Int32Array(mask.length);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    count++;
    let sp = 0, area = 0;
    stack[sp++] = i;
    labels[i] = count;
    while (sp > 0) {
      const p = stack[--sp]!;
      area++;
      const x = p % g.w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = count; stack[sp++] = p - 1; }
      if (x < g.w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = count; stack[sp++] = p + 1; }
      if (p >= g.w && mask[p - g.w] && !labels[p - g.w]) { labels[p - g.w] = count; stack[sp++] = p - g.w; }
      if (p + g.w < mask.length && mask[p + g.w] && !labels[p + g.w]) { labels[p + g.w] = count; stack[sp++] = p + g.w; }
    }
    areas.push(area);
  }
  return { labels, count, areas };
}

/** Alanı `minArea`'dan küçük bileşenleri siler. */
export function removeSmall(mask: Uint8Array, g: Grid, minArea: number): Uint8Array {
  const { labels, areas } = components(mask, g);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) if (mask[i] && areas[labels[i]!]! >= minArea) out[i] = 1;
  return out;
}

/** Yalnızca en büyük bağlı bileşeni bırakır. */
export function largestComponent(mask: Uint8Array, g: Grid): Uint8Array {
  const { labels, count, areas } = components(mask, g);
  if (count <= 1) return mask.slice();
  let best = 1;
  for (let k = 2; k <= count; k++) if (areas[k]! > areas[best]!) best = k;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) if (labels[i] === best) out[i] = 1;
  return out;
}

/**
 * Şekli maskeye çizer (piksel merkezi şeklin içindeyse 1). `k`: şekil biriminden maske pikseline çarpan
 * (ör. oran şekli için designFramePx × scale, px şekli için scale).
 */
export function rasterizeShape(shape: Shape, g: Grid, k: number): Uint8Array {
  const out = new Uint8Array(g.w * g.h);
  const inside = shapeTester(shape, k);
  const b = shapeBoundsScaled(shape, k);
  const y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(g.h, Math.ceil(b.y + b.h));
  const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(g.w, Math.ceil(b.x + b.w));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (inside(x + 0.5, y + 0.5)) out[y * g.w + x] = 1;
  return out;
}

function shapeBoundsScaled(s: Shape, k: number): Box {
  switch (s.kind) {
    case "circle":
      return { x: (s.cx - s.r) * k, y: (s.cy - s.r) * k, w: 2 * s.r * k, h: 2 * s.r * k };
    case "ellipse":
      return { x: (s.cx - s.rx) * k, y: (s.cy - s.ry) * k, w: 2 * s.rx * k, h: 2 * s.ry * k };
    case "rect":
      return { x: s.x * k, y: s.y * k, w: s.w * k, h: s.h * k };
    case "polygon": {
      const xs = s.points.map((p) => p.x * k), ys = s.points.map((p) => p.y * k);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

/** Bir noktanın (maske pikseli biriminde) şeklin içinde olup olmadığını söyleyen fonksiyon. */
export function shapeTester(s: Shape, k: number): (x: number, y: number) => boolean {
  switch (s.kind) {
    case "circle": {
      const cx = s.cx * k, cy = s.cy * k, r2 = (s.r * k) ** 2;
      return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r2;
    }
    case "ellipse": {
      const cx = s.cx * k, cy = s.cy * k, rx = s.rx * k, ry = s.ry * k;
      return (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    }
    case "rect": {
      const x0 = s.x * k, y0 = s.y * k, x1 = (s.x + s.w) * k, y1 = (s.y + s.h) * k;
      const r = Math.min((s.radius ?? 0) * k, (x1 - x0) / 2, (y1 - y0) / 2);
      return (x, y) => {
        if (x < x0 || x > x1 || y < y0 || y > y1) return false;
        if (r <= 0) return true;
        // Köşe yuvarlaklığı: köşe karesindeyse köşe dairesine bak.
        const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
        const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      };
    }
    case "polygon": {
      const pts = s.points.map((p) => ({ x: p.x * k, y: p.y * k }));
      return (x, y) => {
        // Çift-tek kuralı (ışın atma).
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[i]!, b = pts[j]!;
          if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
      };
    }
  }
}

/** Maskedeki dolu piksellerin sınır kutusu (maske pikseli). */
export function maskBounds(mask: Uint8Array, g: Grid): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < g.h; y++) {
    const row = y * g.w;
    for (let x = 0; x < g.w; x++) {
      if (!mask[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) return null;
  return { x: x0, y: y0, w: x1 + 1 - x0, h: y1 + 1 - y0 };
}

export function countSet(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i]!;
  return n;
}

export function and(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! & b[i]!;
  return out;
}

export function andNot(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0;
  return out;
}

export function toBitmap(data: Uint8Array, g: Grid, scale: number): Bitmap {
  return { width: g.w, height: g.h, scale, data };
}

/**
 * Morfolojik açma: `r` pikselden ince şeritleri atar (daralt → genişlet), sonra özgün maskeyle kesişir.
 */
export function open(mask: Uint8Array, g: Grid, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  return and(dilate(erode(mask, g, r), g, r), mask);
}
