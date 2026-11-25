import type { Shape } from "@tagpress/domain";
import sharp from "sharp";

/**
 * Görsel yardımcıları: modele gidecek görseli küçültme, PNG ↔ ham piksel, kesim şekli maskesi.
 * Görüntü işleme (yazı katmanı ayırma, maskeleme) saf fonksiyonlarla ham RGBA üstünde yapılır; sharp yalnızca
 * PNG çözme/kodlama ve yeniden boyutlandırma için kullanılır.
 */

export interface RawImage {
  width: number;
  height: number;
  /** 3 (RGB) ya da 4 (RGBA) kanal, satır satır. */
  channels: 3 | 4;
  data: Uint8Array;
}

const resizedCache = new WeakMap<Buffer, Map<number, Promise<string>>>();

/** PNG'yi en uzun kenarı `maxSide`'ı geçmeyecek şekilde küçültüp base64 döner (büyütmez). Aynı Buffer önbelleklenir. */
export function pngForModel(png: Buffer, maxSide = 768): Promise<string> {
  let byBuf = resizedCache.get(png);
  if (!byBuf) {
    byBuf = new Map();
    resizedCache.set(png, byBuf);
  }
  let p = byBuf.get(maxSide);
  if (!p) {
    p = sharp(png)
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer()
      .then((b) => b.toString("base64"));
    byBuf.set(maxSide, p);
  }
  return p;
}

/** PNG → 8 bit RGBA ham piksel. */
export async function decodeRgba(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: 4, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** PNG → verilen boyuta (oran bozulsa da tam) yeniden boyutlandırılmış, beyaza düzleştirilmiş RGB. */
export async function decodeRgbResized(png: Buffer, width: number, height: number): Promise<RawImage> {
  const { data, info } = await sharp(png)
    .flatten({ background: "#ffffff" })
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: 3, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** Ham RGBA → PNG (kayıpsız). */
export function encodeRgba(img: RawImage): Promise<Buffer> {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .png()
    .toBuffer();
}

/** RGBA'yı beyaz zemine düzleştirir (karşılaştırma için). */
export function flattenOnWhite(img: RawImage): RawImage {
  if (img.channels === 3) return img;
  const n = img.width * img.height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.data[4 * i + 3]! / 255;
    for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(img.data[4 * i + c]! * a + 255 * (1 - a));
  }
  return { width: img.width, height: img.height, channels: 3, data: out };
}

/** Beyaz zemine düzleştirilmiş, verilen kare boyuta getirilmiş PNG (modele gidecek şablon). */
export async function pngFlatResized(png: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(png).flatten({ background: "#ffffff" }).resize(width, height, { fit: "fill" }).png().toBuffer();
}

/** Nokta şeklin içinde mi? (polygon: çift-tek kuralı) */
export function pointInShape(s: Shape, x: number, y: number): boolean {
  switch (s.kind) {
    case "circle":
      return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
    case "ellipse":
      return ((x - s.cx) / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 <= 1;
    case "rect": {
      if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) return false;
      const r = Math.min(s.radius, s.w / 2, s.h / 2);
      if (r <= 0) return true;
      const cx = Math.min(Math.max(x, s.x + r), s.x + s.w - r);
      const cy = Math.min(Math.max(y, s.y + r), s.y + s.h - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    }
    case "polygon": {
      let inside = false;
      const p = s.points;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i]!;
        const b = p[j]!;
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    }
  }
}

/**
 * Şekil maskesi (0..255), piksel başına 4 alt örnekle kenar yumuşatmalı. Piksel merkezi (x+0.5, y+0.5).
 */
export function shapeMask(s: Shape, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const offs = [0.25, 0.75];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0;
      for (const oy of offs) for (const ox of offs) if (pointInShape(s, x + ox, y + oy)) hit++;
      out[y * width + x] = hit === 4 ? 255 : Math.round((hit / 4) * 255);
    }
  }
  return out;
}

/** Şekli SVG öğesine çevirir (kılavuz tuval çizimi). */
export function shapeSvg(s: Shape, attrs: string): string {
  switch (s.kind) {
    case "circle":
      return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${attrs}/>`;
    case "ellipse":
      return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" ${attrs}/>`;
    case "rect":
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.radius}" ${attrs}/>`;
    case "polygon":
      return `<polygon points="${s.points.map((p) => `${p.x},${p.y}`).join(" ")}" ${attrs}/>`;
  }
}

/** Görüntü modelinin desteklediği en yakın en-boy oranı. */
export function nearestAspect(width: number, height: number): string {
  const options: Array<[string, number]> = [
    ["1:1", 1],
    ["4:5", 0.8],
    ["5:4", 1.25],
    ["3:4", 0.75],
    ["4:3", 4 / 3],
    ["2:3", 2 / 3],
    ["3:2", 1.5],
    ["9:16", 9 / 16],
    ["16:9", 16 / 9],
  ];
  const r = width / height;
  return options.reduce((a, b) => (Math.abs(Math.log(b[1] / r)) < Math.abs(Math.log(a[1] / r)) ? b : a))[0];
}
