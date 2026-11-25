import { type Box, type Point, type Profile, type Reference, type Template, effectiveCut, shapeBounds, shapeCutDiameter } from "@tagpress/domain";
import {
  type GapInfo,
  type LineCtx,
  type LineInfo,
  analyzeLines,
  boxCenter,
  breakKey,
  connectorShiftEm,
  gapsOf,
  lineCtx,
  normSpace,
  strictTextKey,
  unionBox,
} from "./lines.ts";

/**
 * Program ↔ kullanıcı farkı (tek referans). Programın önerisi yoksa (ör. elle tasarlanmış etiket) yalnızca kullanıcı
 * tarafı çözümlenir; öğrenme bunu da kullanır (oranlar, boşluklar, merkez).
 */

export interface SideSummary {
  lines: LineInfo[];
  gaps: GapInfo[];
  block: Box;
  center: Point;
  maxSize: number;
  /** En büyük satırın asıl fontu (aile/stil). */
  mainFont: string;
  /** Kullanılan asıl font aileleri (glif kuralı fontları hariç). */
  families: string[];
  connectorShiftEm: number | null;
}

export interface RibbonCheck {
  /** Kurdele bandının alt sınırı (px). */
  ribbonY: number;
  /** Kullanıcının yazısının üst kenarı (px). */
  userTop: number;
  /** Kullanıcı yazısı banda giriyor mu ve ne kadar (px). */
  violation: boolean;
  overPx: number;
}

export interface RefDiff {
  id: string;
  templateKey: string | null;
  split: Reference["split"];
  text: string;
  framePx: number;
  /** Profilin tasarım alanıyla aynı boyutta mı (değilse istatistikte kullanılmaz). */
  usable: boolean;
  reason: string | null;
  user: SideSummary;
  program: SideSummary | null;
  /** Satır bölmesi aynı mı (boşluk, kenar ayırıcıları "-", ",", "~", "•" ve büyük/küçük harf yok sayılır). */
  sameBreaks: boolean | null;
  breaks: { user: string[]; program: string[] } | null;
  /** Kullanıcının metni programınkinden yalnızca ayırıcı/boşlukla mı ayrılıyor (ve ayrılıyor mu). */
  separatorsOnly: boolean;
  /** Kullanıcının metni müşteri metninden ayırıcı/boşluk dışında farklı mı (elle düzeltme; büyük/küçük harf dahil). */
  textEdited: boolean;
  /** Kullanıcının en büyük satırı / programınki. */
  scale: number | null;
  /** Blok merkezi farkı, kullanıcı − program (px). */
  center: { dx: number; dy: number } | null;
  connectorShift: { user: number | null; program: number | null } | null;
  /** En büyük satırın fontu değişti mi. */
  fontChange: { from: string; to: string } | null;
  ribbon: RibbonCheck | null;
  /** Yaklaşık (çok satırlı katmandan bölünmüş) kullanıcı satırı sayısı. */
  approxLines: number;
}

export interface DiffContext {
  profile?: Profile | null;
  template?: Template | null;
  /** Önceden kurulmuş satır bağlamı (çok sayıda referansta tekrar kurulmasın). */
  lineCtx?: LineCtx;
}

function side(lines: Reference["user"], ctx: LineCtx): SideSummary | null {
  const info = analyzeLines(lines, ctx);
  if (!info.length) return null;
  const block = unionBox(info.map((l) => l.ink));
  const largest = info.reduce((a, b) => (b.sizePx > a.sizePx ? b : a));
  return {
    lines: info,
    gaps: gapsOf(info, ctx),
    block,
    center: boxCenter(block),
    maxSize: largest.sizePx,
    mainFont: `${largest.family}/${largest.style}`,
    families: [...new Set(info.filter((l) => !ctx.glyphOnlyFamilies.has(l.family)).map((l) => l.family))],
    connectorShiftEm: connectorShiftEm(info),
  };
}

export function ribbonCheck(block: Box, profile: Profile, template: Template): RibbonCheck | null {
  if (!(template.ribbonTop > 0)) return null;
  // Şablonun etkin kesimi (kendi kesimi ya da profilin `output.cut`'ı); motorun kurdele bandıyla aynı kural.
  const cut = effectiveCut(template, profile).shape;
  const ribbonY = shapeBounds(cut).y + template.ribbonTop * shapeCutDiameter(cut);
  const overPx = Math.max(0, ribbonY - block.y);
  return { ribbonY, userTop: block.y, violation: overPx > 0.5, overPx };
}

export function diffReference(ref: Reference, dctx: DiffContext = {}): RefDiff {
  const profile = dctx.profile ?? null;
  const ctx = dctx.lineCtx ?? lineCtx(profile);
  const user = side(ref.user, ctx);
  if (!user) throw new Error(`Referans ${ref.id}: kullanıcı satırı yok.`);
  const program = ref.program?.length ? side(ref.program, ctx) : null;
  const framePx = profile?.output.designFramePx ?? 440;
  const usable = ref.labelFramePx === framePx;
  const ub = user.lines.map((l) => breakKey(l.text)).filter(Boolean);
  const pb = program ? program.lines.map((l) => breakKey(l.text)).filter(Boolean) : null;
  const sameBreaks = pb ? ub.length === pb.length && ub.every((k, i) => k === pb[i]) : null;
  const userText = user.lines.map((l) => l.text).join(" ");
  const progText = program ? program.lines.map((l) => l.text).join(" ") : null;
  const separatorsOnly = progText !== null && normSpace(userText) !== normSpace(progText) && strictTextKey(userText) === strictTextKey(progText);
  return {
    id: ref.id,
    templateKey: ref.templateKey,
    split: ref.split,
    text: ref.text,
    framePx: ref.labelFramePx,
    usable,
    reason: usable ? null : `etiket ${ref.labelFramePx} px (tasarım alanı ${framePx} px)`,
    user,
    program,
    sameBreaks,
    breaks: program && sameBreaks === false ? { user: user.lines.map((l) => l.text), program: program.lines.map((l) => l.text) } : null,
    separatorsOnly,
    textEdited: strictTextKey(userText) !== strictTextKey(ref.text),
    scale: program ? user.maxSize / program.maxSize : null,
    center: program ? { dx: user.center.x - program.center.x, dy: user.center.y - program.center.y } : null,
    connectorShift: program ? { user: user.connectorShiftEm, program: program.connectorShiftEm } : null,
    fontChange: program && program.mainFont !== user.mainFont ? { from: program.mainFont, to: user.mainFont } : null,
    ribbon: profile && dctx.template ? ribbonCheck(user.block, profile, dctx.template) : null,
    approxLines: user.lines.filter((l) => l.approx).length,
  };
}

/** Birçok referans için fark (şablonlar anahtarla eşlenir). */
export function diffAll(refs: readonly Reference[], profile: Profile | null, templates: ReadonlyMap<string, Template> = new Map()): RefDiff[] {
  const ctx = lineCtx(profile);
  const out: RefDiff[] = [];
  for (const ref of refs) {
    try {
      out.push(diffReference(ref, { profile, template: ref.templateKey ? (templates.get(ref.templateKey) ?? null) : null, lineCtx: ctx }));
    } catch {
      /* satırsız referans: atlanır */
    }
  }
  return out;
}
