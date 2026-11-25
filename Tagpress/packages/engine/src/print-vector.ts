import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as fontkit from "fontkit";
import type { PrintCellLabel, PrintCut, PrintSlot, Shape } from "@tagpress/domain";
import { ptToMm, shapeBounds } from "@tagpress/domain";
import { graphemes } from "@tagpress/domain";
import { FontRegistry, SYSTEM_BOLD_FALLBACKS, colorLayers, findSystemFonts, glyphCommands, isEmojiGrapheme, shapeRun } from "@tagpress/typeset";
import { insetShape } from "./shapes.ts";

/**
 * Baskı render'ının vektör yardımcıları: tek yol modeli (mutlak M/L/C/Z), yuva yolları, kayıt işaretleri, hücre etiketi
 * glifleri. Aynı yollar sayfa SVG'sinde, PNG'de (librsvg), kesim dosyasında ve PDF'te (vektör operatörleri) kullanılır;
 * böylece bütün çıktılar aynı geometriyi basar.
 */

// ---------------------------------------------------------------- yol modeli

export type PathCmd =
  | { t: "M" | "L"; x: number; y: number }
  | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: "Z" };

/** Dolgulu ya da konturlu vektör şekil (koordinatlar kullanıldığı yerin biriminde; sayfada mm). */
export interface VecShape {
  cmds: PathCmd[];
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
}

/** 2B afin dönüşüm [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG ve PDF `cm` ile aynı). */
export type Mat = readonly [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 ∘ m2: önce m2, sonra m1. */
export function mul(m1: Mat, m2: Mat): Mat {
  const [a, b, c, d, e, f] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scaleMat = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
/** Derece; y aşağı eksende pozitif açı saat yönündedir (domain sözleşmesi). */
export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function transformCmds(cmds: readonly PathCmd[], m: Mat): PathCmd[] {
  return cmds.map((c) => {
    if (c.t === "Z") return c;
    if (c.t === "C") {
      const [x1, y1] = apply(m, c.x1, c.y1);
      const [x2, y2] = apply(m, c.x2, c.y2);
      const [x, y] = apply(m, c.x, c.y);
      return { t: "C", x1, y1, x2, y2, x, y };
    }
    const [x, y] = apply(m, c.x, c.y);
    return { t: c.t, x, y };
  });
}

const num = (v: number, dp: number) => {
  const k = 10 ** dp;
  const r = Math.round(v * k) / k;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/** SVG `d` verisi (mutlak komutlar). */
export function pathD(cmds: readonly PathCmd[], dp = 3): string {
  let d = "";
  for (const c of cmds) {
    if (c.t === "Z") d += "Z";
    else if (c.t === "C") d += `C${num(c.x1, dp)} ${num(c.y1, dp)} ${num(c.x2, dp)} ${num(c.y2, dp)} ${num(c.x, dp)} ${num(c.y, dp)}`;
    else d += `${c.t}${num(c.x, dp)} ${num(c.y, dp)}`;
  }
  return d;
}

/**
 * Mutlak komutlu SVG yol verisini çözer (M, L, H, V, Q, C, Z; typeset glif yolları ve bu modülün çıktısı bu biçimdedir).
 * Göreli (küçük harf) ya da yay (A) komutu varsa null: çağıran raster yedeğe düşer.
 */
export function parsePathD(d: string): PathCmd[] | null {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return [];
  const out: PathCmd[] = [];
  let i = 0;
  let cmd = "";
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const n = () => {
    const t = tokens[i++];
    if (t === undefined || /[A-Za-z]/.test(t)) throw new Error("yol");
    return Number(t);
  };
  try {
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (/[A-Za-z]/.test(t)) {
        cmd = t;
        i++;
        if (cmd === "Z" || cmd === "z") {
          out.push({ t: "Z" });
          cx = sx;
          cy = sy;
          continue;
        }
      }
      switch (cmd) {
        case "M": {
          cx = sx = n();
          cy = sy = n();
          out.push({ t: "M", x: cx, y: cy });
          cmd = "L"; // M'den sonraki çiftler L sayılır
          break;
        }
        case "L":
          cx = n();
          cy = n();
          out.push({ t: "L", x: cx, y: cy });
          break;
        case "H":
          cx = n();
          out.push({ t: "L", x: cx, y: cy });
          break;
        case "V":
          cy = n();
          out.push({ t: "L", x: cx, y: cy });
          break;
        case "Q": {
          const qx = n(), qy = n(), x = n(), y = n();
          out.push({ t: "C", x1: cx + (2 / 3) * (qx - cx), y1: cy + (2 / 3) * (qy - cy), x2: x + (2 / 3) * (qx - x), y2: y + (2 / 3) * (qy - y), x, y });
          cx = x;
          cy = y;
          break;
        }
        case "C": {
          const x1 = n(), y1 = n(), x2 = n(), y2 = n(), x = n(), y = n();
          out.push({ t: "C", x1, y1, x2, y2, x, y });
          cx = x;
          cy = y;
          break;
        }
        default:
          return null;
      }
    }
  } catch {
    return null;
  }
  return out;
}

export function cmdsBounds(cmds: readonly PathCmd[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const c of cmds) {
    if (c.t === "Z") continue;
    if (c.t === "C") {
      add(c.x1, c.y1);
      add(c.x2, c.y2);
    }
    add(c.x, c.y);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------- şekiller

/** Çeyrek daire Bézier sabiti. */
const KAPPA = 0.5522847498307936;

/** Elips (merkez, yarıçaplar), `rot` derece saat yönünde. 4 kübik Bézier. */
export function ellipseCmds(cx: number, cy: number, rx: number, ry: number, rot = 0): PathCmd[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const raw: PathCmd[] = [
    { t: "M", x: rx, y: 0 },
    { t: "C", x1: rx, y1: ky, x2: kx, y2: ry, x: 0, y: ry },
    { t: "C", x1: -kx, y1: ry, x2: -rx, y2: ky, x: -rx, y: 0 },
    { t: "C", x1: -rx, y1: -ky, x2: -kx, y2: -ry, x: 0, y: -ry },
    { t: "C", x1: kx, y1: -ry, x2: rx, y2: -ky, x: rx, y: 0 },
    { t: "Z" },
  ];
  return transformCmds(raw, mul(translate(cx, cy), rotate(rot)));
}

/** Köşesi yuvarlatılmış dikdörtgen (merkez, ölçü, köşe yarıçapı), `rot` derece. */
export function roundRectCmds(cx: number, cy: number, w: number, h: number, radius: number, rot = 0): PathCmd[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  const k = r * KAPPA;
  const raw: PathCmd[] =
    r <= 0
      ? [{ t: "M", x: x0, y: y0 }, { t: "L", x: x1, y: y0 }, { t: "L", x: x1, y: y1 }, { t: "L", x: x0, y: y1 }, { t: "Z" }]
      : [
          { t: "M", x: x0 + r, y: y0 },
          { t: "L", x: x1 - r, y: y0 },
          { t: "C", x1: x1 - r + k, y1: y0, x2: x1, y2: y0 + r - k, x: x1, y: y0 + r },
          { t: "L", x: x1, y: y1 - r },
          { t: "C", x1: x1, y1: y1 - r + k, x2: x1 - r + k, y2: y1, x: x1 - r, y: y1 },
          { t: "L", x: x0 + r, y: y1 },
          { t: "C", x1: x0 + r - k, y1: y1, x2: x0, y2: y1 - r + k, x: x0, y: y1 - r },
          { t: "L", x: x0, y: y0 + r },
          { t: "C", x1: x0, y1: y0 + r - k, x2: x0 + r - k, y2: y0, x: x0 + r, y: y0 },
          { t: "Z" },
        ];
  return transformCmds(raw, mul(translate(cx, cy), rotate(rot)));
}

/** Yuvanın kesim yolu (sayfa mm). `growMm` > 0 yolu her yönde büyütür (taşma payı). */
export function slotCmds(slot: PrintSlot, growMm = 0): PathCmd[] {
  const w = slot.w + 2 * growMm;
  const h = slot.h + 2 * growMm;
  if (slot.shape === "rect") return roundRectCmds(slot.cx, slot.cy, w, h, slot.cornerRadius > 0 ? slot.cornerRadius + growMm : 0, slot.rotation);
  return ellipseCmds(slot.cx, slot.cy, w / 2, h / 2, slot.rotation);
}

/** Domain şeklini (tasarım px) yola çevirir; `grow` px kadar dışa büyütür (çokgen sınır kutusunun merkezine göre ölçeklenir). */
export function shapeCmds(s: Shape, grow = 0): PathCmd[] {
  const g = grow > 0 ? growShape(s, grow) : s;
  switch (g.kind) {
    case "circle":
      return ellipseCmds(g.cx, g.cy, g.r, g.r);
    case "ellipse":
      return ellipseCmds(g.cx, g.cy, g.rx, g.ry);
    case "rect":
      return roundRectCmds(g.x + g.w / 2, g.y + g.h / 2, g.w, g.h, g.radius);
    case "polygon": {
      const [p0, ...rest] = g.points;
      return [{ t: "M", x: p0!.x, y: p0!.y }, ...rest.map((p) => ({ t: "L" as const, x: p.x, y: p.y })), { t: "Z" }];
    }
  }
}

/** Şekli `d` kadar dışa büyütür. Çokgende sınır kutusu merkezine göre orantılı ölçek (yaklaşık ofset). */
export function growShape(s: Shape, d: number): Shape {
  if (s.kind !== "polygon") return insetShape(s, -d);
  const b = shapeBounds(s);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const kx = b.w > 0 ? (b.w + 2 * d) / b.w : 1;
  const ky = b.h > 0 ? (b.h + 2 * d) / b.h : 1;
  return { kind: "polygon", points: s.points.map((p) => ({ x: cx + (p.x - cx) * kx, y: cy + (p.y - cy) * ky })) };
}

// ---------------------------------------------------------------- kayıt işaretleri

/**
 * Kayıt (registration) işaretleri, sayfa mm. Tarzlar (`PrintCut.registration.style`):
 * - `corners-l`: dört köşede içe bakan L (kol uzunluğu `sizeMm`, kalınlık `thicknessMm`), dolgu.
 * - `corner-square`: sol üstte dolu kare (`sizeMm`; yön işareti), diğer üç köşede L (Silhouette "Print & Cut" düzeni).
 * - `crosshair`: dört köşede artı + daire (hedef işareti), kontur `thicknessMm`; merkez kenardan `insetMm + sizeMm/2`.
 * Hepsi kağıt kenarından `insetMm` içeride başlar. Renk her zaman siyah (optik sensör siyahı okur).
 */
export function registrationMarks(paper: { wMm: number; hMm: number }, reg: PrintCut["registration"]): VecShape[] {
  if (!reg.enabled) return [];
  const { insetMm: i, sizeMm: s, thicknessMm: t } = reg;
  const W = paper.wMm;
  const H = paper.hMm;
  const black = "#000000";
  // Köşe: (ox, oy) dış köşe, (sx, sy) içe doğru yön (+1/-1).
  const corners: Array<{ ox: number; oy: number; sx: number; sy: number }> = [
    { ox: i, oy: i, sx: 1, sy: 1 },
    { ox: W - i, oy: i, sx: -1, sy: 1 },
    { ox: i, oy: H - i, sx: 1, sy: -1 },
    { ox: W - i, oy: H - i, sx: -1, sy: -1 },
  ];
  const lShape = (c: (typeof corners)[number]): VecShape => {
    const p = (dx: number, dy: number) => ({ x: c.ox + c.sx * dx, y: c.oy + c.sy * dy });
    const pts = [p(0, 0), p(s, 0), p(s, t), p(t, t), p(t, s), p(0, s)];
    return { cmds: polyCmds(pts), fill: black, stroke: null, strokeWidth: 0 };
  };
  const square = (c: (typeof corners)[number]): VecShape => {
    const p = (dx: number, dy: number) => ({ x: c.ox + c.sx * dx, y: c.oy + c.sy * dy });
    return { cmds: polyCmds([p(0, 0), p(s, 0), p(s, s), p(0, s)]), fill: black, stroke: null, strokeWidth: 0 };
  };
  if (reg.style === "corners-l") return corners.map(lShape);
  if (reg.style === "corner-square") return corners.map((c, k) => (k === 0 ? square(c) : lShape(c)));
  // crosshair
  const out: VecShape[] = [];
  for (const c of corners) {
    const mx = c.ox + (c.sx * s) / 2;
    const my = c.oy + (c.sy * s) / 2;
    out.push({
      cmds: [
        { t: "M", x: mx - s / 2, y: my },
        { t: "L", x: mx + s / 2, y: my },
        { t: "M", x: mx, y: my - s / 2 },
        { t: "L", x: mx, y: my + s / 2 },
      ],
      fill: null,
      stroke: black,
      strokeWidth: t,
    });
    out.push({ cmds: ellipseCmds(mx, my, s * 0.3, s * 0.3), fill: null, stroke: black, strokeWidth: t });
  }
  return out;
}

function polyCmds(pts: Array<{ x: number; y: number }>): PathCmd[] {
  const [p0, ...rest] = pts;
  return [{ t: "M", x: p0!.x, y: p0!.y }, ...rest.map((p) => ({ t: "L" as const, x: p.x, y: p.y })), { t: "Z" }];
}

/** Yuva kesim çizgileri (sayfa mm, kontur). */
export function slotOutlines(slots: readonly PrintSlot[], cut: Pick<PrintCut, "outlineColor" | "outlineWidthMm">): VecShape[] {
  return slots.map((s) => ({ cmds: slotCmds(s), fill: null, stroke: cut.outlineColor, strokeWidth: cut.outlineWidthMm }));
}

// ---------------------------------------------------------------- hücre etiketi yazısı (Inter Bold, glif yolu)

type FkFont = fontkit.Font;

/**
 * Hücre etiketi fontu: bir ya da birkaç yüz (karakter ilk basabilen yüzden çizilir). Hiçbir yüzün basamadığı küme
 * (emoji, Arapça, ★) etiket yazısıyla aynı yedek zinciriyle (`fallback`: typeset `FontRegistry`, uygulamayla gelen ve
 * sistem yedekleri) çizilir; emoji renkli katmanlarıyla.
 */
export interface CellLabelFont {
  faces: FkFont[];
  /** Raporlama için: kullanılan dosyalar. */
  files: string[];
  /** Küme düzeyi yedek zinciri; yoksa yalnız `faces`. */
  fallback?: FontRegistry;
}

const req = createRequire(import.meta.url);
let defaultFont: CellLabelFont | null = null;

/**
 * Varsayılan hücre etiketi fontu: projeye bağımlılık olarak eklenen Inter Bold (`@fontsource/inter`, OFL).
 * Alt kümeler (latin, latin-ext, kiril, yunan, vietnam) sırayla denenir; hiçbiri
 * basamıyorsa sistemdeki kalın yedekler (Windows Arial Bold / Segoe UI Bold, macOS Arial Bold, Linux DejaVu Sans Bold /
 * Liberation Sans Bold; yalnız bulunanlar, `TAGPRESS_SYSTEM_FONT_DIRS` ile değişir) denenir (karakter silinmez).
 */
export function defaultCellLabelFont(): CellLabelFont {
  if (defaultFont) return defaultFont;
  const files: string[] = [];
  try {
    const dir = path.dirname(req.resolve("@fontsource/inter/files/inter-latin-700-normal.woff"));
    const order = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "greek-ext", "vietnamese"];
    const present = new Set(readdirSync(dir));
    for (const sub of order) {
      const f = `inter-${sub}-700-normal.woff`;
      if (present.has(f)) files.push(path.join(dir, f));
    }
  } catch {
    /* paket yoksa sistem yedeğine düşülür */
  }
  files.push(...findSystemFonts(SYSTEM_BOLD_FALLBACKS));
  defaultFont = { ...loadCellLabelFont(files), fallback: FontRegistry.createSync({}) };
  return defaultFont;
}

/** Font dosyalarından (ttf/otf/woff/woff2) ya da baytlarından hücre etiketi fontu. */
export function loadCellLabelFont(sources: ReadonlyArray<string | Buffer>): CellLabelFont {
  const faces: FkFont[] = [];
  const files: string[] = [];
  for (const src of sources) {
    try {
      const f = (typeof src === "string" ? fontkit.openSync(src) : fontkit.create(src)) as FkFont & { fonts?: FkFont[] };
      faces.push(f.fonts ? f.fonts[0]! : f);
      files.push(typeof src === "string" ? src : "(bellek)");
    } catch {
      /* okunamayan dosya atlanır */
    }
  }
  if (!faces.length) throw new Error("Hücre etiketi için font yüklenemedi (Inter Bold ya da yedek font bulunamadı).");
  return { faces, files };
}

/**
 * Hücre etiketi metnini glif yolları olarak çizer. (xMm, yMm) yazı kutusunun SOL ÜST köşesidir:
 * taban çizgisi = yMm + ascender. Boyut `style.sizePt` (pt → mm), renk `style.color`. Renkli (emoji) katmanlar dahil
 * değildir; onlar için `cellLabelShapes`.
 */
export function cellLabelShape(text: string, xMm: number, yMm: number, style: Pick<PrintCellLabel, "sizePt" | "color">, font: CellLabelFont): VecShape {
  return cellLabelShapes(text, xMm, yMm, style, font)[0]!;
}

/**
 * Hücre etiketinin bütün şekilleri: ilki yazı renginde tek renkli yollar (Inter ve yedek fontların düz glifleri),
 * ardından renkli emoji katmanları (kendi renkleriyle, çizim sırasıyla).
 */
export function cellLabelShapes(text: string, xMm: number, yMm: number, style: Pick<PrintCellLabel, "sizePt" | "color">, font: CellLabelFont): VecShape[] {
  const sizeMm = ptToMm(style.sizePt);
  const main = font.faces[0]!;
  const baseline = yMm + (main.ascent / main.unitsPerEm) * sizeMm;
  const cmds: PathCmd[] = [];
  const colored: VecShape[] = [];
  let pen = xMm;
  for (const run of splitRuns(text, font)) {
    if (run.kind === "face") {
      const face = run.face;
      const s = sizeMm / face.unitsPerEm;
      const laid = face.layout(run.text);
      laid.glyphs.forEach((g, k) => {
        const pos = laid.positions[k]!;
        const ox = pen + pos.xOffset * s;
        const oy = baseline - pos.yOffset * s;
        cmds.push(...glyphCmds(g.path.commands, ox, oy, s));
        pen += pos.xAdvance * s;
      });
      continue;
    }
    const reg = font.fallback!;
    const shaped = shapeRun(reg, run.text, { fontId: run.fontId, sizePx: sizeMm });
    const s = sizeMm / reg.get(run.fontId).upem;
    for (const g of shaped.glyphs) {
      const ox = pen + g.x;
      const oy = baseline + g.y;
      const layers = colorLayers(reg, run.fontId, g.gid);
      if (!layers) cmds.push(...hbCmds(glyphCommands(reg, run.fontId, g.gid), ox, oy, s));
      else for (const l of layers) colored.push({ cmds: hbCmds(glyphCommands(reg, run.fontId, l.gid), ox, oy, s), fill: l.color ?? style.color, stroke: null, strokeWidth: 0 });
    }
    pen += shaped.advance;
  }
  return [{ cmds, fill: style.color, stroke: null, strokeWidth: 0 }, ...colored.filter((c) => c.cmds.length)];
}

/** Hücre etiketinde hiçbir fontun (yedekler dahil) basamadığı kümeler (boş kutu basılır); boşluklar hariç. */
export function cellLabelMissing(text: string, font: CellLabelFont): string[] {
  return [...new Set(splitRuns(text, font).flatMap((r) => (r.kind === "face" && r.missing ? graphemes(r.text) : [])))];
}

type CellRun = { kind: "face"; face: FkFont; text: string; missing: boolean } | { kind: "fallback"; fontId: string; text: string };

/** Kapsamda sayılmayan kod noktaları (birleştirici, varyasyon seçicisi, etiket). */
const ignorable = (cp: number) => cp === 0x200c || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0020 && cp <= 0xe007f);
const SPACE = /^\s+$/u;

/** Küme düzeyinde font: emoji kümesi ve hiçbir yüzün tamamını basamadığı küme yedek zincirinden (etiket yazısıyla aynı). */
function splitRuns(text: string, font: CellLabelFont): CellRun[] {
  const runs: CellRun[] = [];
  for (const g of graphemes(text)) {
    const cps = [...g].map((ch) => ch.codePointAt(0)!).filter((cp) => !ignorable(cp));
    const face = isEmojiGrapheme(g) ? undefined : font.faces.find((f) => cps.every((cp) => f.hasGlyphForCodePoint(cp)));
    const space = SPACE.test(g);
    const fb = face || space ? null : (font.fallback?.fallbackFor(g) ?? null);
    const next: CellRun = fb ? { kind: "fallback", fontId: fb, text: g } : { kind: "face", face: face ?? font.faces[0]!, text: g, missing: !face && !space };
    const last = runs[runs.length - 1];
    if (last && last.kind === "face" && next.kind === "face" && last.face === next.face && last.missing === next.missing) last.text += g;
    else if (last && last.kind === "fallback" && next.kind === "fallback" && last.fontId === next.fontId) last.text += g;
    else runs.push(next);
  }
  return runs;
}

/** typeset glif komutları (font birimi, y yukarı; M/L/Q/C/Z) → sayfa komutları (mm, y aşağı). */
function hbCmds(commands: ReadonlyArray<{ type: string; values: number[] }>, ox: number, oy: number, s: number): PathCmd[] {
  const out: PathCmd[] = [];
  const X = (v: number) => ox + v * s;
  const Y = (v: number) => oy - v * s;
  let cx = 0, cy = 0;
  for (const { type, values: a } of commands) {
    if (type === "M" || type === "L") {
      cx = X(a[0]!);
      cy = Y(a[1]!);
      out.push({ t: type, x: cx, y: cy });
    } else if (type === "Q") {
      const qx = X(a[0]!), qy = Y(a[1]!), x = X(a[2]!), y = Y(a[3]!);
      out.push({ t: "C", x1: cx + (2 / 3) * (qx - cx), y1: cy + (2 / 3) * (qy - cy), x2: x + (2 / 3) * (qx - x), y2: y + (2 / 3) * (qy - y), x, y });
      cx = x;
      cy = y;
    } else if (type === "C") {
      const x = X(a[4]!), y = Y(a[5]!);
      out.push({ t: "C", x1: X(a[0]!), y1: Y(a[1]!), x2: X(a[2]!), y2: Y(a[3]!), x, y });
      cx = x;
      cy = y;
    } else if (type === "Z") out.push({ t: "Z" });
  }
  return out;
}

/** fontkit yol komutları (font birimi, y yukarı) → sayfa komutları (mm, y aşağı). */
function glyphCmds(commands: ReadonlyArray<{ command: string; args: number[] }>, ox: number, oy: number, s: number): PathCmd[] {
  const out: PathCmd[] = [];
  const X = (v: number) => ox + v * s;
  const Y = (v: number) => oy - v * s;
  let cx = 0, cy = 0;
  for (const { command, args: a } of commands) {
    switch (command) {
      case "moveTo":
        cx = X(a[0]!);
        cy = Y(a[1]!);
        out.push({ t: "M", x: cx, y: cy });
        break;
      case "lineTo":
        cx = X(a[0]!);
        cy = Y(a[1]!);
        out.push({ t: "L", x: cx, y: cy });
        break;
      case "quadraticCurveTo": {
        const qx = X(a[0]!), qy = Y(a[1]!), x = X(a[2]!), y = Y(a[3]!);
        out.push({ t: "C", x1: cx + (2 / 3) * (qx - cx), y1: cy + (2 / 3) * (qy - cy), x2: x + (2 / 3) * (qx - x), y2: y + (2 / 3) * (qy - y), x, y });
        cx = x;
        cy = y;
        break;
      }
      case "bezierCurveTo": {
        const x = X(a[4]!), y = Y(a[5]!);
        out.push({ t: "C", x1: X(a[0]!), y1: Y(a[1]!), x2: X(a[2]!), y2: Y(a[3]!), x, y });
        cx = x;
        cy = y;
        break;
      }
      case "closePath":
        out.push({ t: "Z" });
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- SVG öğesi

/** Vektör şekli SVG `<path>` öğesine çevirir (sayfa mm). */
export function vecSvg(v: VecShape, extra = ""): string {
  if (!v.cmds.length) return "";
  const fill = v.fill ?? "none";
  const stroke = v.stroke ? ` stroke="${v.stroke}" stroke-width="${num(v.strokeWidth, 4)}" stroke-linejoin="round"` : "";
  return `<path d="${pathD(v.cmds)}" fill="${fill}"${stroke}${extra}/>`;
}
