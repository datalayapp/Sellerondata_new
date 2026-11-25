import {
  type Box,
  type DesignIntent,
  type Issue,
  type LayoutResult,
  type PlacedLine,
  type Profile,
  type TemplateGeometry,
  fixMsg,
  isInitialsOnly,
  issueMsg,
  ptToPx,
} from "@tagpress/domain";
import { type FontRegistry, strokeOutset } from "@tagpress/typeset";
import { type Block, buildBlock, type FitModel, issue, prepareIntent, type ResolvedLine, resolveLines } from "./compose.ts";
import { freeRows, maxScale, type Placement, placeBlock } from "./fit.ts";
import { checkFontPolicy, checkIntentRules, checkLayoutIssues, glyphWarnings } from "./rules.ts";
import { scoreLayout } from "./score.ts";
import { shapeDiameter } from "./shapes.ts";
import { type PositionedRun, verifyRaster } from "./verify.ts";

export interface LayoutInput {
  text: string;
  intent: DesignIntent;
  profile: Profile;
  geometry: TemplateGeometry;
  fonts: FontRegistry;
  /** Sığdırma modeli (bkz. `FitModel`). Varsayılan: "glyph". */
  fit?: FitModel;
}

/** Sığmayınca satır oranlarının 1'e doğru yumuşatılma adımları (1 = profil/niyet oranı). */
const SOFTEN_STEPS = [1, 0.75, 0.5, 0.25, 0] as const;
/** Çarpışmada küçültme çarpanı ve en fazla deneme. */
const SHRINK = 0.96;
const MAX_VERIFY = 8;

const r2 = (v: number) => Math.round(v * 100) / 100;
const toBox = (b: { x0: number; y0: number; x1: number; y1: number }): Box => ({ x: r2(b.x0), y: r2(b.y0), w: r2(b.x1 - b.x0), h: r2(b.y1 - b.y0) });

/** Kontur genişliği (px): ana puntonun `widthEm`'i, piksel sınırlarına kırpılmış (0 = sınır yok). Etiket başına tek değer. */
export function strokeWidthPx(profile: Profile, basePx: number): number {
  const w = profile.weight;
  let px = w.widthEm * basePx;
  if (w.minPx > 0) px = Math.max(px, w.minPx);
  if (w.maxPx > 0) px = Math.min(px, w.maxPx);
  return px;
}

export function textColor(profile: Profile, g: TemplateGeometry): string {
  return profile.color.autoContrast && g.background.dark ? profile.color.onDark : profile.color.text;
}

/** "real" kalınlık: her run'ın aynı ailede daha ağır stili varsa ve metni basabiliyorsa o stile geçer; biri bile yoksa null. */
function heavierLines(lines: ResolvedLine[], fonts: FontRegistry): ResolvedLine[] | null {
  const swap = new Map<string, string>();
  for (const l of lines)
    for (const r of l.runs) {
      if (r.fallback || swap.has(r.fontId)) continue;
      const h = fonts.heavier(r.fontId);
      if (!h) return null;
      swap.set(r.fontId, h.id);
    }
  const out = lines.map((l) => ({ ...l, runs: l.runs.map((r) => ({ ...r, fontId: r.fallback ? r.fontId : swap.get(r.fontId)! })) }));
  for (const l of out) for (const r of l.runs) if (fonts.missing(r.fontId, r.text).length) return null;
  return out;
}

function positionRuns(block: Block, p: Placement): PositionedRun[] {
  const out: PositionedRun[] = [];
  block.lines.forEach((line, i) => {
    const lx = p.x + block.xs[i]!;
    const base = p.y + block.baselines[i]!;
    for (const r of line.runs) out.push({ shaped: r.shaped, x: lx + r.x, baseline: base + r.dy });
  });
  return out;
}

/**
 * Ana motor: niyet + profil + geometri → yerleşim. Adımlar: ön işlem → kurallar → run çözümü → kalınlık →
 * analitik sığdırma (en büyük ölçek, sonra harf yüksekliği tavanı, azami punto ve doluluk) → tek raster doğrulama.
 */
export async function layout(input: LayoutInput): Promise<LayoutResult> {
  const t0 = performance.now();
  const { profile, geometry: g, fonts } = input;
  const notes: string[] = [];
  const issues: Issue[] = [];
  const color = textColor(profile, g);
  const fail = (extra: Issue[]): LayoutResult => ({
    ok: false,
    lines: [],
    basePx: 0,
    strokePx: 0,
    color,
    ink: { x: 0, y: 0, w: 0, h: 0 },
    fill: 0,
    score: { total: 0, parts: {} },
    issues: [...issues, ...extra],
    notes,
    ms: Math.round(performance.now() - t0),
  });

  // 1-2. Metin koruma ve ön işlem.
  const prep = prepareIntent(input.intent.lines, input.text, profile);
  if (prep.problem) return fail([issue("text-changed", "error", prep.problemText ?? prep.problem, "text", [fixMsg("regenerate")])]);
  notes.push(...prep.notes);
  const intent: DesignIntent = { ...input.intent, lines: prep.lines };

  issues.push(...checkIntentRules(intent, input.text, profile).filter((i) => i.code !== "text-changed"));
  const policy = checkFontPolicy(intent, input.text, profile, fonts);
  issues.push(...policy);
  if (policy.some((i) => i.severity === "error")) return fail([]);

  // 3. Run çözümü.
  const res = resolveLines(intent.lines, profile, fonts);
  if (res.unprintable.length)
    issues.push(issue("text-unprintable", "error", issueMsg("text-unprintable-layout", { chars: res.unprintable.join(" ") }), "text", [fixMsg("fix-text")]));
  issues.push(...glyphWarnings(res.partialChars, res.monochromeChars));

  // 9. Kalınlık.
  let lines = res.lines;
  let useStroke = profile.weight.mode === "stroke";
  if (profile.weight.mode === "real") {
    const heavy = heavierLines(lines, fonts);
    if (heavy) {
      lines = heavy;
      notes.push("Kalınlık için fontun kalın stili kullanıldı.");
    } else {
      useStroke = true;
      notes.push("Fontun kalın stili yok; kalınlık konturla yapıldı.");
    }
  }
  const strokeFor = (k: number) => (useStroke ? strokeWidthPx(profile, k) : 0);
  const outsetFor = (k: number) => strokeOutset(strokeFor(k), profile.weight.align);

  // 7. Sığdırma.
  const fr = freeRows(g);
  const minPx = ptToPx(profile, profile.sizing.minPt);
  const maxPx = ptToPx(profile, profile.sizing.maxPt);
  const build = (ls: ResolvedLine[], k: number) => buildBlock(fonts, ls, k, outsetFor(k), profile, input.fit ?? "glyph");

  let chosen: { ls: ResolvedLine[]; kMax: number; minRatio: number } | null = null;
  let lastKMax = 0;
  for (const soft of SOFTEN_STEPS) {
    const ls = soft === 1 ? lines : lines.map((l) => ({ ...l, ratio: 1 - (1 - l.ratio) * soft }));
    const kMax = maxScale((k) => placeBlock(fr, build(ls, k), g.target, true) !== null, 1, g.framePx);
    lastKMax = Math.max(lastKMax, kMax);
    if (kMax === 0) break;
    const minRatio = Math.min(...ls.map((l) => l.ratio));
    if (kMax * minRatio >= minPx) {
      chosen = { ls, kMax, minRatio };
      if (soft !== 1) notes.push("En küçük satır okunur kalsın diye satır oranları yumuşatıldı.");
      break;
    }
  }
  if (!chosen) {
    return lastKMax === 0
      ? fail([issue("no-layout", "error", issueMsg("no-layout"), "text", [fixMsg("revise"), fixMsg("fix-text-area")])])
      : fail([issue("text-too-small", "error", issueMsg("text-too-small-min", { min: profile.sizing.minPt }), "lines", [fixMsg("revise")])]);
  }
  const { ls, kMax, minRatio } = chosen;

  // Harf yüksekliği tavanı (baş harf etiketinde ayrı sınır), azami punto, doluluk.
  const initials = isInitialsOnly(input.text, profile.connectors.words);
  const capRatio = initials && profile.sizing.initials.maxCapHeight !== null ? profile.sizing.initials.maxCapHeight : profile.sizing.maxCapHeight;
  const maxCapPx = capRatio * shapeDiameter(g.cut);
  let capPerK = 0;
  for (const l of ls)
    for (const r of l.runs) {
      if (r.fallback) continue;
      const f = fonts.get(r.fontId);
      capPerK = Math.max(capPerK, (f.capHeight / f.upem) * l.ratio * r.scale);
    }
  const kCap = capPerK > 0 ? maxCapPx / capPerK : Infinity;
  const fill = profile.sizing.fillLocked ? profile.sizing.fill : (input.intent.fill ?? profile.sizing.fill);
  const kFill = kMax * fill;
  let k = Math.min(kFill, kCap, maxPx);
  if (k < kFill - 0.01) notes.push(kCap <= maxPx ? "Kısa metin: harf yüksekliği sınırı uygulandı." : "En büyük punto sınırı uygulandı.");
  if (k * minRatio < minPx) {
    k = Math.min(kMax, minPx / minRatio);
    notes.push("En küçük punto sınırı için yazı büyütüldü.");
  }
  const expected = k;

  // 8. Raster doğrulama; gerekirse küçült.
  for (let attempt = 0; attempt < MAX_VERIFY; attempt++) {
    const block = build(ls, k);
    const p = placeBlock(fr, block, g.target);
    if (p) {
      const runs = positionRuns(block, p);
      const strokePx = strokeFor(k);
      const report = await verifyRaster(fonts, g, runs, strokePx > 0 ? { widthPx: strokePx, align: profile.weight.align } : null);
      if (report.ok) {
        if (attempt > 0) notes.push(`Dekor çarpışması için yazı %${Math.round((1 - k / expected) * 100)} küçültüldü.`);
        return finish(block, p, k, strokePx, report.inkPx, report.outsideFreePx);
      }
    }
    k *= SHRINK;
    if (k * minRatio < minPx * 0.999) break;
  }
  return fail([issue("collision", "error", issueMsg("collision"), "layout", [fixMsg("fix-text-area"), fixMsg("revise")])]);

  function finish(block: Block, p: Placement, k: number, strokePx: number, inkPx: number, outsideFreePx: number): LayoutResult {
    const placed: PlacedLine[] = block.lines.map((line, i) => {
      const lx = p.x + block.xs[i]!;
      const base = p.y + block.baselines[i]!;
      return {
        text: line.src.text,
        role: line.src.role,
        tier: line.src.tier,
        sizePx: r2(line.sizePx),
        runs: line.runs.map((r) => {
          const f = fonts.get(r.src.fontId);
          return {
            text: r.src.text,
            fontId: r.src.fontId,
            family: f.family,
            style: f.style,
            sizePx: r2(r.shaped.sizePx),
            baselineShiftPx: r2(-r.dy),
            fallback: r.src.fallback,
            trackingEm: 0,
          };
        }),
        baselineY: r2(base),
        x: r2(lx),
        advance: r2(line.advance),
        ink: toBox({ x0: line.ink.x0 + lx, x1: line.ink.x1 + lx, y0: line.ink.y0 + base, y1: line.ink.y1 + base }),
      };
    });
    const ink = toBox({ x0: block.ink.x0 + p.x, x1: block.ink.x1 + p.x, y0: block.ink.y0 + p.y, y1: block.ink.y1 + p.y });
    const smallest = Math.min(...block.lines.map((l) => l.sizePx));
    const all = [...issues, ...checkLayoutIssues(profile, smallest, res.fallbackChars)];
    const score = scoreLayout({
      basePx: k,
      expectedPx: expected,
      ink,
      target: g.target,
      area: g.areaBounds,
      inkPx,
      outsideFreePx,
      smallestPx: smallest,
      readablePx: ptToPx(profile, profile.quality.readableMinPt),
    });
    return {
      ok: !all.some((i) => i.severity === "error"),
      lines: placed,
      basePx: r2(k),
      strokePx: r2(strokePx),
      color,
      ink,
      fill: r2(k / kMax),
      score,
      issues: all,
      notes,
      ms: Math.round(performance.now() - t0),
    };
  }
}
