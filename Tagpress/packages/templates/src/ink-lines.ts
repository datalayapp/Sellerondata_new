import type { Box } from "@tagpress/domain";

/**
 * Yüklenen bitmiş etiketten mürekkep satırları (sitede tasarım dili oluşturma, plan §4.4). Deterministik görüntü
 * işleme; AI piksel koordinatı üretmez, burada hiçbir değer tahminle doldurulmaz: ayrılamayan görsel `null`/boş döner.
 *
 * Üç adım, hepsi saf (ham RGB üstünde; dosya okuma ve yeniden kodlama sunucuda, sharp ile):
 *  1. Mürekkep maskesi:
 *     - şablonla (`alignTemplate` + `templateInk`): şablon görseli örneğin üstüne hizalanır (eş ölçek + kayma; döndürme
 *       yok), şablonun örnek çözünürlüğüne alan ortalamasıyla çevrilmiş hâli çıkarılır. Sonuç = şablon + mürekkep:
 *       şablon pikselinin 1 px komşuluğuyla açıklanamayan her piksel mürekkeptir (alt piksel kayma ve JPEG kenarı tolere).
 *     - düz zeminde (`plainInk`): baskın kâğıt rengi ve ondan uzaklık eşiği. Zemin düz değilse (fotoğraf, doku, dekor)
 *       ayrılamaz → `plain: false`.
 *  2. Satırlar (`inkLines`): yatay izdüşümde boş satırlarla ayrılan bantlar; nokta/şapka gibi küçük bantlar komşusuna
 *     katılır; üst üste binen satırlar (el yazısı uzantıları) izdüşüm vadisinden bölünür ve her bağlı bileşen piksellerinin
 *     çoğunun düştüğü satıra verilir. Satır kutusu = bileşenlerinin birleşimi (piksel kenarı; kutu üst üste binebilir).
 *  3. Satır kutusu, yükseklik, görünen boşluk, blok: çağıran (`apps/server/src/services/builder/samples.ts`).
 *
 * Eşikler mürekkep karşıtlığına göre uyarlanır (koyu mürekkep / açık yaldız aynı kuralla). Birim: görsel pikseli.
 */

/** Ham RGB görüntü (3 kanal, satır satır). Saydam görseller çağıranda beyaza düzleştirilir. */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

// ================================================================ ortak yardımcılar

const dist3 = (a: Uint8Array | Float32Array, i: number, b: Uint8Array | Float32Array, j: number) => {
  const d0 = a[3 * i]! - b[3 * j]!;
  const d1 = a[3 * i + 1]! - b[3 * j + 1]!;
  const d2 = a[3 * i + 2]! - b[3 * j + 2]!;
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
};

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Baskın renk (5 bitlik kutularda en kalabalık kutu ve komşularının medyanı) ve ona yakın piksel oranı. */
export function paperColor(img: RgbImage, tol = 30): { color: [number, number, number]; share: number } {
  const n = img.width * img.height;
  const d = img.data;
  const bins = new Uint32Array(32768);
  for (let i = 0; i < n; i++) bins[((d[3 * i]! >> 3) << 10) | ((d[3 * i + 1]! >> 3) << 5) | (d[3 * i + 2]! >> 3)]!++;
  let top = 0;
  for (let b = 1; b < bins.length; b++) if (bins[b]! > bins[top]!) top = b;
  const tr = top >> 10;
  const tg = (top >> 5) & 31;
  const tb = top & 31;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = d[3 * i]!;
    const g = d[3 * i + 1]!;
    const b = d[3 * i + 2]!;
    if (Math.abs((r >> 3) - tr) > 1 || Math.abs((g >> 3) - tg) > 1 || Math.abs((b >> 3) - tb) > 1) continue;
    hist[0][r]!++;
    hist[1][g]!++;
    hist[2][b]!++;
    count++;
  }
  const median = (h: Uint32Array) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v]!;
      if (acc * 2 >= count) return v;
    }
    return 255;
  };
  const color: [number, number, number] = [median(hist[0]), median(hist[1]), median(hist[2])];
  let near = 0;
  const c = Uint8Array.from(color);
  for (let i = 0; i < n; i++) if (dist3(d, i, c, 0) < tol) near++;
  return { color, share: n ? near / n : 0 };
}

/** Kutu (piksel kenarı) birleşimi. */
export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

interface Component {
  /** Piksel kenarı kutu. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

/** 8 komşulu bağlı bileşenler: etiket dizisi (−1 = boş) ve bileşen kutuları. */
function components(mask: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(mask.length).fill(-1);
  const comps: Component[] = [];
  const stack = new Int32Array(mask.length);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s]! >= 0) continue;
    const id = comps.length;
    const c: Component = { x0: w, y0: h, x1: 0, y1: 0, area: 0 };
    let top = 0;
    stack[top++] = s;
    labels[s] = id;
    while (top) {
      const i = stack[--top]!;
      const x = i % w;
      const y = (i / w) | 0;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (y < c.y0) c.y0 = y;
      if (x + 1 > c.x1) c.x1 = x + 1;
      if (y + 1 > c.y1) c.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((!dx && !dy) || nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (mask[j] && labels[j]! < 0) {
            labels[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/**
 * Çift eşikli maske: güçlü pikselle bağlı zayıf pikseller (kenar yumuşatması) de mürekkeptir. Yalnız zayıf piksellerden
 * oluşan bileşenler (JPEG gürültüsü, silik iz) atılır.
 */
function hysteresis(d: Float32Array, w: number, h: number, strong: number, weak: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) {
    if (d[i]! >= strong) {
      out[i] = 1;
      stack[top++] = i;
    }
  }
  while (top) {
    const i = stack[--top]!;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const j = ny * w + nx;
        if (!out[j] && d[j]! >= weak) {
          out[j] = 1;
          stack[top++] = j;
        }
      }
    }
  }
  return out;
}

/** Mürekkep karşıtlığı: belirgin farkların 95. yüzdeliği (koyu mürekkepte yüksek, açık yaldızda düşük). */
function inkContrast(d: Float32Array, floor: number): number | null {
  const hist = new Uint32Array(512);
  let count = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!;
    if (v <= floor) continue;
    hist[Math.min(511, Math.round(v))]!++;
    count++;
  }
  if (!count) return null;
  let acc = 0;
  for (let v = 0; v < 512; v++) {
    acc += hist[v]!;
    if (acc >= 0.95 * count) return v;
  }
  return 511;
}

/** Mürekkep sayılan farkın eşikleri (karşıtlığa göre). */
export const INK_THRESHOLDS = {
  /** Bu farkın altındaki her şey zemin (JPEG ve yeniden örnekleme gürültüsü). */
  floor: 40,
  /** Güçlü piksel: karşıtlığın bu oranı (en az `strongMin`). */
  strongRatio: 0.45,
  strongMin: 50,
  /** Kenar yumuşatması: güçlü piksele bağlıysa bu oran (en az `weakMin`). */
  weakRatio: 0.18,
  weakMin: 24,
} as const;

function thresholdInk(d: Float32Array, w: number, h: number): { mask: Uint8Array; contrast: number } | null {
  const contrast = inkContrast(d, INK_THRESHOLDS.floor);
  if (contrast === null) return null;
  const strong = Math.max(INK_THRESHOLDS.strongMin, INK_THRESHOLDS.strongRatio * contrast);
  const weak = Math.max(INK_THRESHOLDS.weakMin, INK_THRESHOLDS.weakRatio * contrast);
  return { mask: hysteresis(d, w, h, strong, weak), contrast };
}

// ================================================================ düz zemin

export interface PlainInkResult {
  /** Zemin düz ve mürekkep ayrılabildi mi. Değilse `mask` boştur ve `reason` nedeni söyler. */
  plain: boolean;
  reason: "not-plain" | "textured" | "no-ink" | "too-much-ink" | "decoration" | "multi-color" | "thick" | null;
  paper: [number, number, number];
  /** Kâğıt rengine yakın piksel oranı. */
  paperShare: number;
  /** Kâğıtta mürekkep kenarı olmayan ara tonların oranı (fotoğraf/doku göstergesi). */
  texture: number;
  /** Tek mürekkep rengiyle (kâğıt + örtme × mürekkep) açıklanamayan mürekkep piksellerinin oranı (renkli dekor). */
  multiColor: number;
  /** Yazı çizgisinden kalın (aşındırmaya dayanan) mürekkep oranı (dolu çiçek, yaprak, leke). */
  thick: number;
  mask: Uint8Array;
  /** Mürekkep piksellerinin oranı. */
  coverage: number;
}

/** Düz zemin sınırları. */
export const PLAIN_LIMITS = {
  /** Kâğıt rengine yakın (ΔRGB < 30) piksel en az bu oranda. */
  minPaperShare: 0.55,
  /** Mürekkebe 2 px'ten uzak ara ton (ΔRGB 18..floor) en çok bu oranda. */
  maxTexture: 0.02,
  /** Mürekkep en çok bu oranda (fazlası dekor/fotoğraf). */
  maxCoverage: 0.35,
  /** Görselin iki yönde de bu oranından büyük tek bileşen dekordur (çelenk, çerçeve). */
  decorationSpan: 0.6,
  /** Tek renk modelinden sapan (ΔRGB > 50) mürekkep en çok bu oranda. */
  maxMultiColor: 0.08,
  /** Aşındırma yarıçapı (uzun kenarın oranı) ve ona dayanan mürekkebin en çok oranı. */
  thickRadius: 0.01,
  maxThick: 0.03,
} as const;

/**
 * Düz zeminli görselde eşikleme ile mürekkep. Zemin düz değilse ya da mürekkep yazıya benzemiyorsa (renkli ya da kalın
 * dekor, görseli saran bileşen) `plain: false`: o görsel şablonsuz ölçülemez.
 */
export function plainInk(img: RgbImage): PlainInkResult {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const { color: paper, share } = paperColor(img);
  const base = { paper, paperShare: share, texture: 0, multiColor: 0, thick: 0, coverage: 0 };
  const empty = (reason: PlainInkResult["reason"], extra: Partial<PlainInkResult> = {}): PlainInkResult => ({ ...base, ...extra, plain: false, reason, mask: new Uint8Array(n) });
  if (share < PLAIN_LIMITS.minPaperShare) return empty("not-plain");
  const p = Uint8Array.from(paper);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = dist3(img.data, i, p, 0);
  const t = thresholdInk(d, w, h);
  if (!t) return empty("no-ink");
  // Doku: mürekkebin kenarı olmayan ara tonlar (fotoğrafta ışık geçişi, kâğıt dokusu, gürültü).
  const near = dilateBox(t.mask, w, h, 2);
  let mid = 0;
  for (let i = 0; i < n; i++) if (!near[i] && d[i]! > 18 && d[i]! <= INK_THRESHOLDS.floor) mid++;
  const texture = mid / n;
  if (texture > PLAIN_LIMITS.maxTexture) return empty("textured", { texture });
  let inked = 0;
  for (let i = 0; i < n; i++) inked += t.mask[i]!;
  const coverage = inked / n;
  if (!inked) return empty("no-ink", { texture });
  if (coverage > PLAIN_LIMITS.maxCoverage) return empty("too-much-ink", { texture, coverage });
  // Tek renk modeli: piksel = kâğıt + a · (mürekkep − kâğıt). Mürekkep rengi = güçlü piksellerin medyanı.
  const strong = Math.max(INK_THRESHOLDS.strongMin, INK_THRESHOLDS.strongRatio * t.contrast);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;
  let ns = 0;
  for (let i = 0; i < n; i++) {
    if (!t.mask[i] || d[i]! < strong) continue;
    for (let c = 0; c < 3; c++) hist[c]![img.data[3 * i + c]!]!++;
    ns++;
  }
  const med = (hh: Uint32Array) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hh[v]!) * 2 >= ns) return v;
    return 255;
  };
  const C = [med(hist[0]), med(hist[1]), med(hist[2])];
  const v = [C[0]! - p[0]!, C[1]! - p[1]!, C[2]! - p[2]!];
  const vv = v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]! || 1;
  let off = 0;
  for (let i = 0; i < n; i++) {
    if (!t.mask[i]) continue;
    const g0 = img.data[3 * i]! - p[0]!;
    const g1 = img.data[3 * i + 1]! - p[1]!;
    const g2 = img.data[3 * i + 2]! - p[2]!;
    const a = Math.max(0, Math.min(1, (g0 * v[0]! + g1 * v[1]! + g2 * v[2]!) / vv));
    if (Math.hypot(g0 - a * v[0]!, g1 - a * v[1]!, g2 - a * v[2]!) > 50) off++;
  }
  const multiColor = off / inked;
  if (multiColor > PLAIN_LIMITS.maxMultiColor) return empty("multi-color", { texture, coverage, multiColor });
  // Kalınlık: yazı çizgisi ince; aşındırmaya dayanan mürekkep dolu dekordur.
  const r = Math.max(2, Math.round(PLAIN_LIMITS.thickRadius * Math.max(w, h)));
  const eroded = erodeBox(t.mask, w, h, r);
  let kept = 0;
  for (let i = 0; i < n; i++) kept += eroded[i]!;
  const thick = kept / inked;
  if (thick > PLAIN_LIMITS.maxThick) return empty("thick", { texture, coverage, multiColor, thick });
  const { comps } = components(t.mask, w, h);
  if (comps.some((c) => c.x1 - c.x0 > PLAIN_LIMITS.decorationSpan * w && c.y1 - c.y0 > PLAIN_LIMITS.decorationSpan * h)) return empty("decoration", { texture, coverage, multiColor, thick });
  return { plain: true, reason: null, paper, paperShare: share, texture, multiColor, thick, mask: t.mask, coverage };
}

/** Kare aşındırma: genişletmenin tersi (maske dışı genişletilir). */
function erodeBox(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const grown = dilateBox(inv, w, h, r);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = grown[i] ? 0 : 1;
  return out;
}

/** Kare (Chebyshev) genişletme, ayrılabilir kayan pencere. */
function dilateBox(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    let c = 0;
    const row = y * w;
    for (let x = 0; x < Math.min(w, r); x++) c += mask[row + x]!;
    for (let x = 0; x < w; x++) {
      if (x + r < w) c += mask[row + x + r]!;
      if (x - r - 1 >= 0) c -= mask[row + x - r - 1]!;
      tmp[row + x] = c > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < Math.min(h, r); y++) c += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      if (y + r < h) c += tmp[(y + r) * w + x]!;
      if (y - r - 1 >= 0) c -= tmp[(y - r - 1) * w + x]!;
      out[y * w + x] = c > 0 ? 1 : 0;
    }
  }
  return out;
}

// ================================================================ şablon hizalama

/** Şablon görseli pikseli p (sürekli koordinat) → örnek pikseli q = scale · p + (dx, dy). */
export interface Alignment {
  scale: number;
  dx: number;
  dy: number;
}

export interface AlignmentResult extends Alignment {
  /** Hizalanmış şablonun dekor piksellerinden örnekte karşılığı olmayanların oranı (0 = birebir). */
  mismatch: number;
  /** Ortalama kesik fark (0..1; düşük = iyi). */
  cost: number;
  /** Hizalama tuttu mu (`mismatch` sınırın altında ve şablonda yeterli dekor var). */
  ok: boolean;
  reason: "featureless" | "mismatch" | null;
}

export const ALIGN_LIMITS = {
  /** Şablonda dekor (kâğıttan farklı) piksel en az bu oranda; yoksa hizalama belirsizdir. */
  minStructure: 0.002,
  /** Hizalanmış dekor piksellerinin en çok bu oranı karşılıksız kalabilir (yazının dekora bindiği yerler dahil). */
  maxMismatch: 0.2,
} as const;

interface Gray {
  w: number;
  h: number;
  /** Bu düzeyin bir pikseli kaç tam çözünürlük pikseli. */
  f: number;
  v: Float32Array;
}

function toGray(img: RgbImage): Gray {
  const n = img.width * img.height;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = luma(img.data[3 * i]!, img.data[3 * i + 1]!, img.data[3 * i + 2]!);
  return { w: img.width, h: img.height, f: 1, v };
}

/** Tam sayı çarpanla alan ortalaması (kenarda eksik bloklar kendi pikselleriyle). */
function downscale(g: Gray, k: number): Gray {
  if (k <= 1) return g;
  const w = Math.ceil(g.w / k);
  const h = Math.ceil(g.h / k);
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let yy = y * k; yy < Math.min(g.h, (y + 1) * k); yy++) {
        for (let xx = x * k; xx < Math.min(g.w, (x + 1) * k); xx++) {
          s += g.v[yy * g.w + xx]!;
          c++;
        }
      }
      v[y * w + x] = s / c;
    }
  }
  return { w, h, f: g.f * k, v };
}

/** Bilinear okuma; dışarıda null. Koordinat bu düzeyin piksel merkezine göre (sürekli, piksel i = [i, i+1)). */
function sampleGray(g: Gray, x: number, y: number): number | null {
  const fx = x - 0.5;
  const fy = y - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > g.w - 0.5 || fy > g.h - 0.5) return null;
  const x0 = Math.max(0, Math.min(g.w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(g.h - 1, Math.floor(fy)));
  const x1 = Math.min(g.w - 1, x0 + 1);
  const y1 = Math.min(g.h - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, fx - x0));
  const ay = Math.max(0, Math.min(1, fy - y0));
  const a = g.v[y0 * g.w + x0]!;
  const b = g.v[y0 * g.w + x1]!;
  const c = g.v[y1 * g.w + x0]!;
  const d = g.v[y1 * g.w + x1]!;
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}

interface Points {
  /** Tam çözünürlük şablon koordinatı (sürekli). */
  x: Float32Array;
  y: Float32Array;
  v: Float32Array;
  n: number;
}

/** Şablondan hizalama noktaları: dekor ve kenar pikselleri (çoğunluk) + düzenli aralıklı kâğıt noktaları. */
function templatePoints(t: Gray, paperY: number, max: number): Points {
  const strongIdx: number[] = [];
  const paperIdx: number[] = [];
  for (let y = 1; y < t.h - 1; y++) {
    for (let x = 1; x < t.w - 1; x++) {
      const i = y * t.w + x;
      const gx = t.v[i + 1]! - t.v[i - 1]!;
      const gy = t.v[i + t.w]! - t.v[i - t.w]!;
      if (Math.abs(t.v[i]! - paperY) > 25 || Math.abs(gx) + Math.abs(gy) > 16) strongIdx.push(i);
      else paperIdx.push(i);
    }
  }
  const pick = (idx: number[], k: number) => {
    if (idx.length <= k) return idx;
    const out: number[] = [];
    const step = idx.length / k;
    for (let j = 0; j < k; j++) out.push(idx[Math.floor(j * step)]!);
    return out;
  };
  const nStrong = Math.min(strongIdx.length, Math.round(max * 0.75));
  const all = [...pick(strongIdx, nStrong), ...pick(paperIdx, max - nStrong)];
  const pts: Points = { x: new Float32Array(all.length), y: new Float32Array(all.length), v: new Float32Array(all.length), n: all.length };
  all.forEach((i, j) => {
    pts.x[j] = ((i % t.w) + 0.5) * t.f;
    pts.y[j] = (((i / t.w) | 0) + 0.5) * t.f;
    pts.v[j] = t.v[i]!;
  });
  return pts;
}

const TRUNC = 60;

function alignCost(s: Gray, pts: Points, a: Alignment): number {
  let sum = 0;
  for (let j = 0; j < pts.n; j++) {
    const q = sampleGray(s, (a.scale * pts.x[j]! + a.dx) / s.f, (a.scale * pts.y[j]! + a.dy) / s.f);
    sum += q === null ? TRUNC : Math.min(TRUNC, Math.abs(q - pts.v[j]!));
  }
  return sum / (pts.n * TRUNC);
}

/** Örüntü araması: her parametrede ±adım; iyileşme yoksa adım yarıya. */
function patternSearch(cost: (a: Alignment) => number, start: Alignment, step: { s: number; t: number }, minT: number): { a: Alignment; c: number } {
  let best = start;
  let bc = cost(start);
  let ss = step.s;
  let ts = step.t;
  for (let guard = 0; guard < 400 && ts >= minT; guard++) {
    let improved = false;
    const trials: Alignment[] = [
      { ...best, scale: best.scale * (1 + ss) },
      { ...best, scale: best.scale * (1 - ss) },
      { ...best, dx: best.dx + ts },
      { ...best, dx: best.dx - ts },
      { ...best, dy: best.dy + ts },
      { ...best, dy: best.dy - ts },
    ];
    for (const t of trials) {
      const c = cost(t);
      if (c < bc - 1e-9) {
        bc = c;
        best = t;
        improved = true;
      }
    }
    if (!improved) {
      ss /= 2;
      ts /= 2;
    }
  }
  return { a: best, c: bc };
}

export interface AlignOptions {
  /** Ek başlangıç tahminleri (ör. "örnek = tasarım alanı, şablon kendi kutusunda"). */
  guesses?: Alignment[];
}

/**
 * Şablonu örneğe hizalar: eş ölçek + kayma (döndürme yok). Başlangıç tahminleri (çağıranın verdikleri, şablon = örnek,
 * dekor kutusu eşlemesi) kaba düzeyde ızgarayla, sonra iki düzeyde örüntü aramasıyla inceltilir. Ölçü: şablonun dekor ve
 * kâğıt noktalarında kesik parlaklık farkı (yazı bindiği yerde sınırlı ceza). Tutmayan hizalama `ok: false` döner.
 */
export function alignTemplate(sample: RgbImage, template: RgbImage, opts: AlignOptions = {}): AlignmentResult {
  const S = toGray(sample);
  const T = toGray(template);
  const tPaper = paperColor(template);
  const paperY = luma(...tPaper.color);
  let structure = 0;
  for (let i = 0; i < T.v.length; i++) if (Math.abs(T.v[i]! - paperY) > 25) structure++;
  const fail = (reason: AlignmentResult["reason"]): AlignmentResult => ({ scale: 1, dx: 0, dy: 0, mismatch: 1, cost: 1, ok: false, reason });
  if (structure / T.v.length < ALIGN_LIMITS.minStructure) return fail("featureless");

  // Başlangıç tahminleri.
  const guesses: Alignment[] = [...(opts.guesses ?? [])];
  guesses.push({ scale: sample.width / template.width, dx: 0, dy: (sample.height - template.height * (sample.width / template.width)) / 2 });
  const tb = structureBox(T, paperY);
  const sp = paperColor(sample);
  const sb = structureBox(S, luma(...sp.color));
  if (tb && sb) {
    const sc = (sb.w / tb.w + sb.h / tb.h) / 2;
    guesses.push({ scale: sc, dx: sb.x - sc * tb.x, dy: sb.y - sc * tb.y });
  }

  // Kaba düzey: örnek ~160 px; şablon düzeyi ölçeğe göre seçilir (iki tarafın bulanıklığı benzer olsun).
  const level = (target: number, scale: number) => {
    const ks = Math.max(1, Math.round(Math.max(S.w, S.h) / target));
    const kt = Math.max(1, Math.round(ks / scale));
    return { s: downscale(S, ks), t: downscale(T, kt) };
  };
  type Cand = { a: Alignment; c: number };
  const coarse: Cand[] = [];
  const seen: Alignment[] = [];
  for (const g of guesses) {
    if (!(g.scale > 0) || !Number.isFinite(g.dx) || !Number.isFinite(g.dy)) continue;
    // Birbirine çok yakın tahminler bir kez denenir.
    if (seen.some((s) => Math.abs(s.scale / g.scale - 1) < 0.02 && Math.abs(s.dx - g.dx) < 4 && Math.abs(s.dy - g.dy) < 4)) continue;
    seen.push(g);
    const L = level(160, g.scale);
    const pts = templatePoints(L.t, paperY, 1200);
    const tStep = 2 * L.s.f;
    let best: Cand | null = null;
    for (let k = -4; k <= 4; k++) {
      const scale = g.scale * (1 + 0.03 * k);
      for (let iy = -4; iy <= 4; iy++) {
        for (let ix = -4; ix <= 4; ix++) {
          const a = { scale, dx: g.dx + ix * tStep, dy: g.dy + iy * tStep };
          const c = alignCost(L.s, pts, a);
          if (!best || c < best.c) best = { a, c };
        }
      }
    }
    if (best) coarse.push(patternSearch((a) => alignCost(L.s, pts, a), best.a, { s: 0.015, t: L.s.f }, 0.5 * L.s.f));
  }
  if (!coarse.length) return fail("mismatch");
  coarse.sort((x, y) => x.c - y.c);

  // Orta düzey (~400 px) ve tam çözünürlük: örüntü araması, en iyi iki adaydan.
  let final: (Cand & { pts: Points; s: Gray }) | null = null;
  for (const c of coarse.slice(0, 2)) {
    const M = level(400, c.a.scale);
    const pm = templatePoints(M.t, paperY, 3000);
    const mid = patternSearch((a) => alignCost(M.s, pm, a), c.a, { s: 0.005, t: M.s.f }, 0.25);
    const F = level(Infinity, mid.a.scale);
    const pf = templatePoints(F.t, paperY, 6000);
    const fin = patternSearch((a) => alignCost(F.s, pf, a), mid.a, { s: 0.002, t: 0.5 }, 0.1);
    if (!final || fin.c < final.c) final = { ...fin, pts: pf, s: F.s };
  }
  const a = final!.a;
  const mismatch = pointMismatch(final!.s, final!.pts, a, paperY);
  const ok = mismatch <= ALIGN_LIMITS.maxMismatch;
  return { ...a, mismatch, cost: final!.c, ok, reason: ok ? null : "mismatch" };
}

/**
 * Hizalanmış şablonun dekor noktalarından örnekte karşılığı olmayanların oranı: noktanın parlaklığı örnekte 1 px
 * komşulukta bulunmuyorsa (fark > 45) karşılıksızdır. Yazının dekora bindiği yerler de sayılır (sınır bunu kaldırır).
 */
function pointMismatch(s: Gray, pts: Points, a: Alignment, paperY: number): number {
  let deco = 0;
  let bad = 0;
  for (let j = 0; j < pts.n; j++) {
    const v = pts.v[j]!;
    if (Math.abs(v - paperY) <= 25) continue;
    deco++;
    const qx = (a.scale * pts.x[j]! + a.dx) / s.f;
    const qy = (a.scale * pts.y[j]! + a.dy) / s.f;
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const q = sampleGray(s, qx + dx, qy + dy);
        if (q !== null) best = Math.min(best, Math.abs(q - v));
      }
    }
    if (best > 45) bad++;
  }
  return deco ? bad / deco : 1;
}

/** Kâğıttan belirgin farklı piksellerin kutusu (piksel kenarı). */
function structureBox(g: Gray, paperY: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = g.w;
  let y0 = g.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (Math.abs(g.v[y * g.w + x]! - paperY) <= 25) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 + 1 - x0, h: y1 + 1 - y0 };
}

// ================================================================ şablonu örnek çözünürlüğüne çevirme

/**
 * Şablonu örnek ızgarasına çevirir: her örnek pikselinin şablondaki ayak izinin alan ortalaması (toplam tablosu,
 * kesirli kenarlar bilinear). Şablon görselinin dışı `outside` rengidir (bitmiş etiketin zemini; varsayılan beyaz).
 * `inside`: örnek pikseli şablon görselinin içinde mi.
 */
export function warpTemplate(template: RgbImage, width: number, height: number, a: Alignment, outside: [number, number, number] = [255, 255, 255]): { rgb: Float32Array; inside: Uint8Array } {
  const tw = template.width;
  const th = template.height;
  // Toplam tablosu (tw+1)×(th+1)×3.
  const W1 = tw + 1;
  const sat = new Float64Array(W1 * (th + 1) * 3);
  for (let y = 0; y < th; y++) {
    for (let c = 0; c < 3; c++) {
      let row = 0;
      for (let x = 0; x < tw; x++) {
        row += template.data[3 * (y * tw + x) + c]!;
        sat[3 * ((y + 1) * W1 + x + 1) + c] = sat[3 * (y * W1 + x + 1) + c]! + row;
      }
    }
  }
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  const inside = new Uint8Array(n);
  const inv = 1 / a.scale;
  // Ayak izi en az 1 şablon pikseli (büyütmede bilinear benzeri yumuşak okuma).
  const half = Math.max(0.5, inv / 2);
  // Sütun ve satır başına ayak izi kenarları: tam sayı kısım + kesir (toplam tablosunda bilinear okuma için).
  const edges = (count: number, off: number, lim: number) => {
    const i0 = new Int32Array(count);
    const f0 = new Float64Array(count);
    const i1 = new Int32Array(count);
    const f1 = new Float64Array(count);
    const span = new Float64Array(count);
    const ok = new Uint8Array(count);
    for (let k = 0; k < count; k++) {
      const p = (k + 0.5 - off) * inv;
      if (p < 0 || p >= lim) continue;
      ok[k] = 1;
      const lo = Math.max(0, p - half);
      const hi = Math.min(lim, p + half);
      i0[k] = Math.min(lim - 1, Math.floor(lo));
      f0[k] = lo - i0[k]!;
      i1[k] = Math.min(lim - 1, Math.floor(hi));
      f1[k] = hi - i1[k]!;
      span[k] = hi - lo;
    }
    return { i0, f0, i1, f1, span, ok };
  };
  const X = edges(width, a.dx, tw);
  const Y = edges(height, a.dy, th);
  const corner = (xi: number, ax: number, yi: number, ay: number, c: number) => {
    const b = 3 * (yi * W1 + xi) + c;
    const r = 3 * W1;
    return (sat[b]! * (1 - ax) + sat[b + 3]! * ax) * (1 - ay) + (sat[b + r]! * (1 - ax) + sat[b + r + 3]! * ax) * ay;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!X.ok[x] || !Y.ok[y]) {
        rgb[3 * i] = outside[0];
        rgb[3 * i + 1] = outside[1];
        rgb[3 * i + 2] = outside[2];
        continue;
      }
      inside[i] = 1;
      const area = X.span[x]! * Y.span[y]!;
      const xa = X.i0[x]!, fa = X.f0[x]!, xb = X.i1[x]!, fb = X.f1[x]!;
      const ya = Y.i0[y]!, ga = Y.f0[y]!, yb = Y.i1[y]!, gb = Y.f1[y]!;
      for (let c = 0; c < 3; c++) {
        rgb[3 * i + c] = (corner(xb, fb, yb, gb, c) - corner(xa, fa, yb, gb, c) - corner(xb, fb, ya, ga, c) + corner(xa, fa, ya, ga, c)) / area;
      }
    }
  }
  return { rgb, inside };
}

/** Örnek pikselinin, hizalanmış şablonun 3×3 komşuluğundaki en yakın renge uzaklığı. */
function residual(sample: RgbImage, warped: Float32Array): Float32Array {
  const w = sample.width;
  const h = sample.height;
  const s = sample.data;
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - 1);
    const yb = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = s[3 * i]!;
      const g = s[3 * i + 1]!;
      const b = s[3 * i + 2]!;
      const xa = Math.max(0, x - 1);
      const xb = Math.min(w - 1, x + 1);
      let best = Infinity;
      for (let ny = ya; ny <= yb; ny++) {
        for (let nx = xa; nx <= xb; nx++) {
          const j = 3 * (ny * w + nx);
          const d0 = r - warped[j]!;
          const d1 = g - warped[j + 1]!;
          const d2 = b - warped[j + 2]!;
          const v = d0 * d0 + d1 * d1 + d2 * d2;
          if (v < best) best = v;
        }
      }
      d[i] = Math.sqrt(best);
    }
  }
  return d;
}

export interface TemplateInkResult {
  mask: Uint8Array;
  /** Mürekkep piksellerinin oranı. */
  coverage: number;
  contrast: number | null;
}

/** Hizalanmış şablonla yazı katmanını ayırır (sonuç = şablon + mürekkep). */
export function templateInk(sample: RgbImage, template: RgbImage, a: Alignment): TemplateInkResult {
  const { rgb } = warpTemplate(template, sample.width, sample.height, a);
  const d = residual(sample, rgb);
  const t = thresholdInk(d, sample.width, sample.height);
  if (!t) return { mask: new Uint8Array(d.length), coverage: 0, contrast: null };
  let inked = 0;
  for (let i = 0; i < t.mask.length; i++) inked += t.mask[i]!;
  return { mask: t.mask, coverage: inked / t.mask.length, contrast: t.contrast };
}

// ================================================================ satırlar

export interface InkLine {
  /** Mürekkep kutusu (görsel pikseli, piksel kenarı). */
  box: Box;
  /** Mürekkep piksel sayısı. */
  mass: number;
}

export interface InkLinesResult {
  /** Yukarıdan aşağı. */
  lines: InkLine[];
  /** Bütün satırların birleşimi. */
  block: Box | null;
  mass: number;
  /** Gürültü sayılıp atılan küçük parça sayısı. */
  dropped: number;
  /** Boş satırla ayrılmayan (üst üste binen) satır ayrımı sayısı. */
  splits: number;
}

export const LINE_LIMITS = {
  /** 1000 px'lik görselde en küçük bileşen (px; alanla ölçeklenir). */
  minComponent: 4,
  /** Bant içinde kümelemeye giren "büyük" bileşen: bandın en uzun bileşeninin en az bu oranı (küçükler sonradan katılır). */
  majorSize: 0.25,
  /** Nokta/şapka bandı: bileşenleri komşu bandın yüksekliğinin bu oranından küçük. */
  dotSize: 0.3,
  /** Nokta bandının komşusuna en çok uzaklığı (komşunun yüksekliğine oran). */
  dotGap: 0.6,
  /** Nokta bandı komşusuna öbür yandaki banttan en çok bu oranda uzak olabilir. */
  dotGapAsymmetry: 0.5,
  /** Aynı satır: iki büyük bileşenin dikey örtüşmesi küçüğünün yüksekliğinin en az bu oranı. */
  sameLineOverlap: 0.5,
  /** İşaret kümesi ("°", aksan): bindiği kümenin yüksekliğinin en çok bu oranı ve kütlesinin en çok `markMass` oranı. */
  markSize: 0.35,
  markMass: 0.15,
  /** Altındaki harfe yapışık işaret: aradaki boşluk işaret yüksekliğinin en çok bu oranı. */
  markGap: 0.5,
  /** Toplam kütlenin bu oranından küçük yalnız satır gürültüdür. */
  noiseMass: 0.003,
} as const;

interface Band {
  y0: number;
  /** Hariç. */
  y1: number;
  comps: number[];
}

/**
 * Mürekkep maskesinden satırlar (yatay izdüşüm + bağlı bileşenler). Saf; maske 0/1, satır satır.
 */
export function inkLines(mask: Uint8Array, w: number, h: number): InkLinesResult {
  const { labels, comps } = components(mask, w, h);
  const scale = Math.max(w, h) / 1000;
  const minArea = Math.max(2, Math.round(LINE_LIMITS.minComponent * scale * scale));
  const keep = comps.map((c) => c.area >= minArea);
  let dropped = keep.filter((k) => !k).length;

  // Satır profili (yalnız kalan bileşenler).
  const prof = new Float64Array(h);
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i]!;
    if (l >= 0 && keep[l]) prof[(i / w) | 0]!++;
  }
  // Boş satırlarla ayrılan bantlar.
  let bands: Band[] = [];
  for (let y = 0; y < h; ) {
    if (!prof[y]) {
      y++;
      continue;
    }
    const y0 = y;
    while (y < h && prof[y]) y++;
    bands.push({ y0, y1: y, comps: [] });
  }
  const bandOf = (c: Component) => bands.findIndex((b) => c.y0 >= b.y0 && c.y1 <= b.y1);
  comps.forEach((c, id) => {
    if (!keep[id]) return;
    const b = bandOf(c);
    if (b >= 0) bands[b]!.comps.push(id);
  });

  // Nokta, şapka, alt çizgi bantları (i noktası, "È" aksanı, "_") en yakın komşuya katılır: alçak bileşenler, komşunun
  // yatay uzanımında ve komşuya öbür yandakinden belirgin yakın (iki satırın ortasındaki küçük bağlaç satırı katılmaz).
  const bandH = (b: Band) => b.y1 - b.y0;
  for (let changed = true; changed && bands.length > 1; ) {
    changed = false;
    for (let k = 0; k < bands.length; k++) {
      const b = bands[k]!;
      const nb = [k - 1, k + 1].filter((j) => j >= 0 && j < bands.length).map((j) => ({ j, gap: j < k ? b.y0 - bands[j]!.y1 : bands[j]!.y0 - b.y1 }));
      nb.sort((x, y) => x.gap - y.gap);
      const near = nb[0];
      if (!near) continue;
      const far = nb[1];
      const ref = bands[near.j]!;
      const H = bandH(ref);
      const m = LINE_LIMITS.dotSize * H;
      const rx0 = Math.min(...ref.comps.map((id) => comps[id]!.x0)) - m;
      const rx1 = Math.max(...ref.comps.map((id) => comps[id]!.x1)) + m;
      const dotLike = b.comps.every((id) => {
        const c = comps[id]!;
        return c.y1 - c.y0 <= m && c.x1 > rx0 && c.x0 < rx1;
      });
      const closer = !far || near.gap <= LINE_LIMITS.dotGapAsymmetry * far.gap;
      if (dotLike && closer && bandH(b) <= m && near.gap <= LINE_LIMITS.dotGap * H) {
        const merged: Band = { y0: Math.min(b.y0, ref.y0), y1: Math.max(b.y1, ref.y1), comps: [...ref.comps, ...b.comps] };
        bands = bands.filter((_, j) => j !== k && j !== near.j);
        bands.push(merged);
        bands.sort((x, y) => x.y0 - y.y0);
        changed = true;
        break;
      }
    }
  }

  // Üst üste binen satırlar (el yazısı uzantıları boş satır bırakmaz): bant içinde bileşenler kümelenir.
  //  - Büyük bileşenler (bandın en uzununun `majorSize` oranından uzun) dikey uzanımları küçüğünün yarısından çok
  //    örtüşüyorsa aynı satırdır (uzantıların örtüşmesi azdır).
  //  - Küçükler (nokta, virgül) "çekirdeği" (piksellerinin dikey çeyrekler aralığı) en yakın satıra katılır.
  //  - Küçük bir küme ("°", aksan, kesme işareti) dikeyde bindiği büyük kümeye katılır.
  let splits = 0;
  const lines: Band[] = [];
  const coreOf = (id: number) => {
    const c = comps[id]!;
    const rows = new Float64Array(c.y1 - c.y0);
    for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (labels[y * w + x] === id) rows[y - c.y0]!++;
    let acc = 0;
    let q1 = c.y0;
    let q3 = c.y1;
    let got1 = false;
    for (let r = 0; r < rows.length; r++) {
      acc += rows[r]!;
      if (!got1 && acc >= 0.25 * c.area) {
        q1 = c.y0 + r;
        got1 = true;
      }
      if (acc >= 0.75 * c.area) {
        q3 = c.y0 + r + 1;
        break;
      }
    }
    return { q1, q3 };
  };
  const hOf = (id: number) => comps[id]!.y1 - comps[id]!.y0;
  const overlapY = (a: { y0: number; y1: number }, b: { y0: number; y1: number }) => Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const cluster = (b: Band) => {
    if (b.comps.length < 2) {
      lines.push(b);
      return;
    }
    const H = Math.max(...b.comps.map(hOf));
    const isMajor = (id: number) => hOf(id) >= LINE_LIMITS.majorSize * H;
    const major = b.comps.filter(isMajor);
    const minor = b.comps.filter((id) => !isMajor(id));
    const parent = major.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < major.length; i++) {
      for (let j = i + 1; j < major.length; j++) {
        const ci = comps[major[i]!]!;
        const cj = comps[major[j]!]!;
        if (overlapY(ci, cj) >= LINE_LIMITS.sameLineOverlap * Math.min(hOf(major[i]!), hOf(major[j]!))) parent[find(i)] = find(j);
      }
    }
    type Group = { ids: number[]; q1: number; q3: number; y0: number; y1: number; mass: number };
    const byRoot = new Map<number, Group>();
    major.forEach((id, i) => {
      const r = find(i);
      const k = coreOf(id);
      const c = comps[id]!;
      const g = byRoot.get(r) ?? { ids: [], q1: k.q1, q3: k.q3, y0: c.y0, y1: c.y1, mass: 0 };
      g.ids.push(id);
      g.q1 = Math.min(g.q1, k.q1);
      g.q3 = Math.max(g.q3, k.q3);
      g.y0 = Math.min(g.y0, c.y0);
      g.y1 = Math.max(g.y1, c.y1);
      g.mass += c.area;
      byRoot.set(r, g);
    });
    let groups = [...byRoot.values()];
    /**
     * İşaret mi ("°", aksan, kesme): büyük kümenin çekirdeğinin altında değil ve ya yanında durur (sütunlarının altında
     * kümenin pikseli yok, yüksekliğinin yarısından çoğu kümenin içinde) ya da altındaki harfe yapışıktır (boşluk
     * yüksekliğinin yarısından az). İki satırın arasındaki bağlaç ("&", "e") altındaki satırın gövdesinden uzaktır.
     */
    const markOf = (g: Group, o: Group): boolean => {
      const gx0 = Math.min(...g.ids.map((id) => comps[id]!.x0));
      const gx1 = Math.max(...g.ids.map((id) => comps[id]!.x1));
      const gh = g.y1 - g.y0;
      const cy = (g.y0 + g.y1) / 2;
      if (cy > o.q3) return false;
      let top = Infinity;
      for (const id of o.ids) {
        const c = comps[id]!;
        const xa = Math.max(gx0, c.x0);
        const xb = Math.min(gx1, c.x1);
        if (xa >= xb) continue;
        for (let y = Math.max(c.y0, Math.ceil(cy)); y < c.y1 && y < top; y++) {
          let hit = false;
          for (let x = xa; x < xb; x++) if (labels[y * w + x] === id) hit = true;
          if (hit) top = y;
        }
      }
      if (top === Infinity) return overlapY(g, o) >= LINE_LIMITS.sameLineOverlap * gh;
      return top - g.y1 <= LINE_LIMITS.markGap * gh;
    };
    // Küçük kümeler bindikleri büyük kümeye.
    for (let changed = true; changed && groups.length > 1; ) {
      changed = false;
      for (const g of groups) {
        const others = groups.filter((o) => o !== g && o.y0 - g.y1 <= LINE_LIMITS.markGap * (g.y1 - g.y0) && g.y0 < o.y1 && g.y1 - g.y0 <= LINE_LIMITS.markSize * (o.y1 - o.y0) && g.mass < LINE_LIMITS.markMass * o.mass && markOf(g, o));
        if (!others.length) continue;
        const o = others.reduce((x, y) => (overlapY(g, y) > overlapY(g, x) ? y : x));
        o.ids.push(...g.ids);
        o.q1 = Math.min(o.q1, g.q1);
        o.q3 = Math.max(o.q3, g.q3);
        o.y0 = Math.min(o.y0, g.y0);
        o.y1 = Math.max(o.y1, g.y1);
        o.mass += g.mass;
        groups = groups.filter((x) => x !== g);
        changed = true;
        break;
      }
    }
    for (const id of minor) {
      const c = comps[id]!;
      const cy = (c.y0 + c.y1) / 2;
      let best = groups[0]!;
      let bd = Infinity;
      for (const g of groups) {
        const d = cy < g.q1 ? g.q1 - cy : cy > g.q3 ? cy - g.q3 : 0;
        if (d < bd) [best, bd] = [g, d];
      }
      best.ids.push(id);
    }
    splits += groups.length - 1;
    for (const g of groups) lines.push({ y0: Math.min(...g.ids.map((id) => comps[id]!.y0)), y1: Math.max(...g.ids.map((id) => comps[id]!.y1)), comps: g.ids });
  };
  for (const b of bands) cluster(b);

  // Kutular ve gürültü.
  const built = lines
    .filter((l) => l.comps.length)
    .map((l) => {
      const cs = l.comps.map((id) => comps[id]!);
      const x0 = Math.min(...cs.map((c) => c.x0));
      const y0 = Math.min(...cs.map((c) => c.y0));
      const x1 = Math.max(...cs.map((c) => c.x1));
      const y1 = Math.max(...cs.map((c) => c.y1));
      return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, mass: cs.reduce((a, c) => a + c.area, 0) };
    });
  const total = built.reduce((a, l) => a + l.mass, 0);
  const kept = built.filter((l) => l.mass >= LINE_LIMITS.noiseMass * total || built.length === 1);
  dropped += built.length - kept.length;
  kept.sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
  return { lines: kept, block: unionBoxes(kept.map((l) => l.box)), mass: kept.reduce((a, l) => a + l.mass, 0), dropped, splits };
}

/** Satırlar arası görünen boşluk (px; üst satırın altından alt satırın üstüne, binmede negatif). İlk satırda null. */
export function gapsAbove(lines: readonly InkLine[]): Array<number | null> {
  return lines.map((l, i) => (i ? l.box.y - (lines[i - 1]!.box.y + lines[i - 1]!.box.h) : null));
}
