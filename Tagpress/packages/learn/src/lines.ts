import type { Box, Profile, RefLine } from "@tagpress/domain";

/**
 * Referans satırlarının çözümlemesi: satırın asıl puntosu, bağlaç mı, "yaklaşık" mı (çok satırlı tek katmandan
 * bölünmüş), satırlar arası görünen boşluk ve türü.
 *
 * "Yaklaşık" satır: eski sistemden aktarılan referanslarda tek yazı katmanında alt alta yazılmış satırların her biri için
 * ayrı mürekkep kutusu yoktur. Aktarım okuyucusu katmanın mürekkep kutusunu puntolara göre dilimler:
 * dilimlerin x/genişliği katmanınkiyle AYNI ve aralarındaki boşluk TAM 0'dır. Bu satırların boşluğu ve yatay
 * konumu gerçek ölçüm değildir; istatistikten çıkarılır (bkz. "bağlaç çevresi 0,00" bulgusu).
 */

export type GapKind = "normal" | "beforeLast" | "connector";

export interface LineCtx {
  /** Bağlaç sayılan kelimeler (küçük harf). Profil yoksa boş: kod bağlaç bilmez. */
  connectors: Set<string>;
  /** Yalnızca glif kuralında kullanılan fontların aileleri (rolü boş fontlar: "&" için IM FELL gibi). */
  glyphOnlyFamilies: Set<string>;
  beforeLastRatio: number;
}

export function lineCtx(profile?: Profile | null): LineCtx {
  return {
    connectors: new Set((profile?.connectors.words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)),
    glyphOnlyFamilies: new Set((profile?.fonts.list ?? []).filter((f) => f.roles.length === 0).map((f) => f.family)),
    beforeLastRatio: profile?.spacing.beforeLastRatio ?? 0.85,
  };
}

export const normSpace = (s: string) => s.replace(/\s+/gu, " ").trim();

/** Satır başı/sonundaki ayırıcılar: kullanıcı bitmiş etikette bunları siliyor; sistem metni değiştirmez, karşılaştırmada yok sayılır. */
const EDGE_SEPARATORS = /^[\s\-–—,~•·]+|[\s\-–—,~•·]+$/gu;
export const stripSeparators = (s: string) => normSpace(s).replace(EDGE_SEPARATORS, "");

/** Satır bölmesi karşılaştırma anahtarı: boşluk, kenar ayırıcıları ve büyük/küçük harf farkı yok sayılır. */
export const breakKey = (s: string) => stripSeparators(s).toLocaleLowerCase("tr");

/** Metin karşılaştırma anahtarı: bütün boşluklar ve ayırıcılar (her yerde) atılır; büyük/küçük harf korunur. */
export const strictTextKey = (s: string) => s.replace(/[\s\-–—,~•·]+/gu, "");
/** Aynısı, küçük harf (örnek bölme tekrarını yakalamak için). */
export const textKey = (s: string) => strictTextKey(s).toLocaleLowerCase("tr");

export interface LineInfo {
  /** Boşluğu sadeleşmiş metin. */
  text: string;
  family: string;
  style: string;
  /** Asıl punto: boşluk segmentleri ve (başka segment varsa) glif kuralı fontları hariç en büyük segment. */
  sizePx: number;
  /** En büyük satıra oran. */
  ratio: number;
  connector: boolean;
  /** Etiketin en büyük satırı mı (≥ %97). */
  largest: boolean;
  ink: Box;
  /** Çok satırlı tek katmandan bölünmüş (mürekkep kutusu yaklaşık). */
  approx: boolean;
  chars: number;
  /** Harflerin hepsi büyük mü (en az 2 harf). */
  allCaps: boolean;
  /** Satırdaki glif kuralı segmentleri (ör. "&" IM FELL ile): karakter ve asıl puntoya oranı. */
  glyphs: Array<{ text: string; family: string; ratio: number }>;
}

export interface GapInfo {
  /** i-1 ile i arasındaki boşluk. */
  index: number;
  kind: GapKind;
  /** Görünen boşluk / iki satırdan küçüğünün puntosu. */
  value: number;
  /** Gerçek ölçüm değil (aynı katmandan bölünmüş iki satır). */
  approx: boolean;
}

const LETTER = /\p{L}/gu;

function mainSize(line: RefLine, ctx: LineCtx): number {
  const visible = line.segments.filter((s) => s.text.trim());
  if (!visible.length) return line.sizePx;
  const own = visible.filter((s) => !ctx.glyphOnlyFamilies.has(s.family));
  return Math.max(...(own.length ? own : visible).map((s) => s.sizePx));
}

function mainFamily(line: RefLine, ctx: LineCtx): { family: string; style: string } {
  const visible = line.segments.filter((s) => s.text.trim());
  const own = visible.filter((s) => !ctx.glyphOnlyFamilies.has(s.family));
  const pool = own.length ? own : visible;
  if (!pool.length) return { family: line.family, style: line.style };
  const dom = pool.reduce((a, b) => (b.text.trim().length > a.text.trim().length ? b : a));
  return { family: dom.family, style: dom.style };
}

const sameColumn = (a: Box, b: Box) => Math.abs(a.x - b.x) < 0.05 && Math.abs(a.w - b.w) < 0.05;
const rawGap = (a: Box, b: Box) => b.y - (a.y + a.h);

/** Boş satırları atar, sıralamaya dokunmaz (okuyucu yukarıdan aşağı sıralı verir). */
export function analyzeLines(lines: readonly RefLine[], ctx: LineCtx): LineInfo[] {
  const kept = lines.filter((l) => normSpace(l.text));
  const sizes = kept.map((l) => mainSize(l, ctx));
  const max = Math.max(...sizes, 0) || 1;
  const multi = kept.length > 1;
  const approx = kept.map(() => false);
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1]!.ink;
    const b = kept[i]!.ink;
    if (sameColumn(a, b) && Math.abs(rawGap(a, b)) < 0.05) approx[i - 1] = approx[i] = true;
  }
  return kept.map((l, i) => {
    const text = normSpace(l.text);
    const size = sizes[i]!;
    const letters = text.match(LETTER) ?? [];
    const { family, style } = mainFamily(l, ctx);
    return {
      text,
      family,
      style,
      sizePx: size,
      ratio: size / max,
      connector: multi && ctx.connectors.has(text.toLowerCase()),
      largest: size >= 0.97 * max,
      ink: l.ink,
      approx: approx[i]!,
      chars: [...text].length,
      allCaps: letters.length >= 2 && letters.every((c) => c === c.toLocaleUpperCase("tr") && c !== c.toLocaleLowerCase("tr")),
      glyphs: l.segments
        .filter((s) => s.text.trim() && ctx.glyphOnlyFamilies.has(s.family) && s.family !== family)
        .map((s) => ({ text: s.text.trim(), family: s.family, ratio: s.sizePx / size })),
    };
  });
}

/** Satırlar arası görünen boşluklar (motorun boşluk modeliyle aynı türler). */
export function gapsOf(lines: readonly LineInfo[], ctx: LineCtx): GapInfo[] {
  const out: GapInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!;
    const b = lines[i]!;
    const kind: GapKind =
      a.connector || b.connector ? "connector" : i === lines.length - 1 && b.sizePx < ctx.beforeLastRatio * a.sizePx ? "beforeLast" : "normal";
    const g = rawGap(a.ink, b.ink);
    out.push({ index: i, kind, value: g / Math.min(a.sizePx, b.sizePx), approx: sameColumn(a.ink, b.ink) && Math.abs(g) < 0.05 });
  }
  return out;
}

export function unionBox(boxes: readonly Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const boxCenter = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * Tek başına bağlaç satırı iki satırın (isimlerin) arasındaysa: bağlaç mürekkep merkezinin, iki ismin mürekkep
 * merkezlerinin ortasına göre yatay kayması (em, üst ismin puntosu; + sağa). Yaklaşık satırlarda ölçülemez.
 */
export function connectorShiftEm(lines: readonly LineInfo[]): number | null {
  const shifts: number[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const [a, c, b] = [lines[i - 1]!, lines[i]!, lines[i + 1]!];
    if (!c.connector || a.connector || b.connector || a.approx || b.approx || c.approx) continue;
    const mid = (boxCenter(a.ink).x + boxCenter(b.ink).x) / 2;
    shifts.push((boxCenter(c.ink).x - mid) / a.sizePx);
  }
  return shifts.length ? shifts[0]! : null;
}
