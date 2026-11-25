import { type Profile, type Reference, type Template, cutDiameter, effectiveCut, shapeCutDiameter } from "@tagpress/domain";
import { aggregate } from "./aggregate.ts";
import { type RefDiff, diffAll } from "./diff.ts";
import { findingsOf } from "./run.ts";
import { type Robust, countBy, percentile, robust, round } from "./stats.ts";

/**
 * Referanslardan ölçülmüş tarz özeti (tasarım dili becerisinin `olcum_ozeti` aracı). Yalnızca ölçüm: hiçbir değer
 * uydurulmaz, örnek sayısı her değerin yanında durur.
 *
 * Yüklenen örnekler (`source: "uploaded"`, plan §4.4) aynı özete yalnız ölçülen kadarıyla katılır (`refUse`):
 * `none` ve `approx` yalnız satır bölme örneğidir; `ink` metin sayıları ve (fontu onaylıysa) oranlar; `exact` bunlara ek
 * doluluk, şablon merkezi ve (fontu onaylıysa) boşluk ve en büyük punto. Bir değere katılmayan kayıt o değerin `n`'ine
 * de girmez.
 */

/** Bir kaydın katkı yapabileceği ölçüler. */
export interface RefUse {
  /** Satır bölme örnekleri (`examples`). */
  examples: boolean;
  /** Metinden sayılanlar: satır sayısı ve uzunluğu, büyük harf, uzun metin, bağlaç sayıları. */
  text: boolean;
  /** Puntoya dayananlar: oranlar, glif oranları, bağlaç kayması, fontlar. */
  sizes: boolean;
  /** Görünen boşluklar (punto ve gerçek satır kutusu ister). */
  gaps: boolean;
  /** Tasarım alanına bağlı olanlar: doluluk, şablon merkezi, kurdele. */
  frame: boolean;
}

const ALL_USES: RefUse = { examples: true, text: true, sizes: true, gaps: true, frame: true };

/** Kaliteye göre katkı (yapılandırılmış kayıt: hepsi). */
export function refUse(ref: Pick<Reference, "quality" | "approx" | "sizesKnown">): RefUse {
  if (ref.quality === undefined) return ALL_USES;
  if (ref.quality === "none" || ref.approx === true) return { examples: true, text: false, sizes: false, gaps: false, frame: false };
  const sizes = ref.sizesKnown !== false;
  const exact = ref.quality === "exact";
  return { examples: true, text: true, sizes, gaps: exact && sizes, frame: exact };
}

export interface Compact {
  n: number;
  median: number;
  q1: number;
  q3: number;
  p10: number;
  p90: number;
}

const compact = (r: Robust | null): Compact | null =>
  r ? { n: r.n, median: round(r.median, 3), q1: round(r.q1, 3), q3: round(r.q3, 3), p10: round(r.p10, 3), p90: round(r.p90, 3) } : null;

const share = (rows: Array<{ key: string; count: number }>, total: number) => rows.map((r) => ({ ...r, share: total ? round(r.count / total, 3) : 0 }));

export interface StyleMeasurement {
  refs: {
    total: number;
    usable: number;
    train: number;
    test: number;
    withImage: number;
    withProgram: number;
    otherFrame: number;
    /** Yüklenen örnekler: kaliteye göre; `approx` ve `sizesUnknown` sayısal ölçüye katılmayanları açıklar. */
    uploaded: { total: number; exact: number; ink: number; none: number; approx: number; sizesUnknown: number };
  };
  lineCount: Array<{ lines: number; count: number }>;
  lineLength: { p50: number; p90: number; max: number; longest: string[] };
  ratios: { secondary: Compact | null; tertiary: Compact | null; connector: Compact | null; byConnector: Record<string, Compact | null>; glyphs: Record<string, Compact | null> };
  gaps: { normal: Compact | null; beforeLast: Compact | null; connector: Compact | null; approxExcluded: Record<string, number>; withApprox: Record<string, Compact | null> };
  fill: { largestPx: Compact | null; blockWidthOfCut: Compact | null; blockHeightOfCut: Compact | null };
  fonts: {
    /** Etiketin en büyük satırının fontu. */
    byLabel: Array<{ key: string; count: number; share: number }>;
    byLine: Array<{ key: string; count: number; share: number }>;
    /** Bir etikette birden çok asıl font ailesi olan etiket sayısı. */
    mixedLabels: number;
    glyphSegments: Array<{ key: string; count: number }>;
  };
  connectors: {
    standalone: Array<{ key: string; count: number }>;
    inline: Array<{ key: string; count: number }>;
    stackedLabels: number;
    inlineLabels: number;
    shiftEm: Compact | null;
  };
  examples: Array<{ text: string; lines: string[]; fonts: string[]; template: string | null }>;
  uppercase: { labels: number; fonts: Array<{ key: string; count: number }>; examples: Array<{ text: string; lines: string[]; font: string }> };
  longText: { labels: number; threshold: number; lineCount: Array<{ lines: number; count: number }>; fonts: Array<{ key: string; count: number }>; examples: Array<{ text: string; lines: string[] }> };
  templates: Array<{
    key: string;
    n: number;
    center: { x: number; y: number };
    textCenter: { x: number; y: number } | null;
    ribbonTop: number | null;
    ribbonViolations: number;
    area: string | null;
  }>;
  programVsUser: { compared: number; sameBreaks: number; scale: Compact | null; separatorsOnly: number; textEdited: number; fontChanges: Array<{ from: string; to: string; count: number }> };
  findings: string[];
}

export interface MeasureOptions {
  /** "Uzun metin" eşiği (karakter). */
  longText?: number;
  examples?: number;
}

export function measureStyle(refs: readonly Reference[], profile: Profile, templates: readonly Template[] = [], opts: MeasureOptions = {}): StyleMeasurement {
  const tmap = new Map(templates.map((t) => [t.key, t]));
  const diffs = diffAll(refs, profile, tmap);
  const uses = new Map(refs.map((r) => [r.id, refUse(r)]));
  const may = (k: keyof RefUse) => (d: RefDiff) => (uses.get(d.id) ?? ALL_USES)[k];
  const ok = diffs.filter((d) => d.usable);
  // Her ölçü yalnız ona katılabilen kayıtlardan; yüklenen örnek yoksa bütün kümeler aynıdır (bugünkü davranış).
  const okText = ok.filter(may("text"));
  const okSizes = ok.filter(may("sizes"));
  const okFrame = ok.filter(may("frame"));
  const okExamples = ok.filter(may("examples"));
  const aggText = aggregate(diffs.filter(may("text")), { profile });
  const aggSizes = aggregate(diffs.filter(may("sizes")), { profile });
  const aggGaps = aggregate(diffs.filter(may("gaps")), { profile });
  const aggFrame = aggregate(diffs.filter(may("frame")), { profile });
  const agg = { ...aggText, gaps: aggGaps.gaps, gapsWithApprox: aggGaps.gapsWithApprox, gapsApprox: aggGaps.gapsApprox, ribbonViolations: aggFrame.ribbonViolations };
  // Kesim çapı etiketin şablonundan (kendi kesimi ya da profilin `output.cut`'ı; kesimsiz şablonda `cutDiameter(profile)`).
  const profileD = cutDiameter(profile);
  const D = (d: RefDiff) => {
    const t = d.templateKey ? tmap.get(d.templateKey) : undefined;
    return t?.cut ? shapeCutDiameter(effectiveCut(t, profile).shape) : profileD;
  };
  const lines = okText.flatMap((d) => d.user.lines);
  const sizedLines = okSizes.flatMap((d) => d.user.lines);
  const words = new Set(profile.connectors.words.map((w) => w.toLowerCase()));
  const longT = opts.longText ?? 40;

  const tokenize = (s: string) => s.toLowerCase().split(/\s+/u).filter(Boolean);
  const inline = okText.flatMap((d) =>
    d.user.lines
      .filter((l) => !l.connector)
      .flatMap((l) => {
        const t = tokenize(l.text);
        // Bitişik sembol bağlaç ("Mina&Ali") da sayılır.
        const syms = [...words].filter((w) => !/[\p{L}\p{N}]/u.test(w) && l.text.includes(w) && !t.includes(w));
        return [...t.filter((x) => words.has(x)), ...syms];
      }),
  );
  const stacked = okText.filter((d) => d.user.lines.some((l) => l.connector));

  // Örnek bölmeler: farklı satır sayılarından, sırayla.
  const nEx = opts.examples ?? 12;
  const byCount = new Map<number, typeof ok>();
  for (const d of okExamples) byCount.set(d.user.lines.length, [...(byCount.get(d.user.lines.length) ?? []), d]);
  const examples: StyleMeasurement["examples"] = [];
  for (let round_ = 0; examples.length < nEx && round_ < 20; round_++) {
    for (const [, ds] of [...byCount].sort((a, b) => a[0] - b[0])) {
      const d = ds[round_];
      // Fontu bilinmeyen yüklenen örnekte font adı yazılmaz (boş aile atlanır).
      if (d && examples.length < nEx) examples.push({ text: d.text, lines: d.user.lines.map((l) => l.text), fonts: [...new Set(d.user.lines.map((l) => l.family).filter(Boolean))], template: d.templateKey });
    }
  }

  const upper = okText.filter((d) => d.user.lines.some((l) => l.allCaps && !l.connector));
  const long = okText.filter((d) => [...d.text].length > longT);
  const lengths = lines.map((l) => l.chars);
  const tplRows = Object.values(aggFrame.templates)
    .sort((a, b) => b.n - a.n)
    .map((ta) => {
      const t = tmap.get(ta.key);
      return {
        key: ta.key,
        n: ta.n,
        center: { x: round(ta.centerX.median / profile.output.designFramePx, 3), y: round(ta.centerY.median / profile.output.designFramePx, 3) },
        textCenter: t?.textCenter ?? null,
        ribbonTop: t ? t.ribbonTop : null,
        ribbonViolations: ta.ribbonViolations,
        area: t ? (t.area.mode === "manual" ? `elle (${t.area.shape.kind})` : "otomatik") : null,
      };
    });
  const uploaded = refs.filter((r) => r.source === "uploaded");

  return {
    refs: {
      total: refs.length,
      usable: ok.length,
      train: refs.filter((r) => r.split === "train").length,
      test: refs.filter((r) => r.split === "test").length,
      withImage: refs.filter((r) => r.image).length,
      withProgram: refs.filter((r) => r.program?.length).length,
      otherFrame: diffs.length - ok.length,
      uploaded: {
        total: uploaded.length,
        exact: uploaded.filter((r) => r.quality === "exact").length,
        ink: uploaded.filter((r) => r.quality === "ink").length,
        none: uploaded.filter((r) => r.quality === "none").length,
        approx: uploaded.filter((r) => r.approx === true).length,
        sizesUnknown: uploaded.filter((r) => r.quality !== "none" && r.approx !== true && r.sizesKnown === false).length,
      },
    },
    lineCount: countBy(okText, (d) => String(d.user.lines.length))
      .map((r) => ({ lines: Number(r.key), count: r.count }))
      .sort((a, b) => a.lines - b.lines),
    lineLength: {
      p50: Math.round(percentile(lengths, 0.5)),
      p90: Math.round(percentile(lengths, 0.9)),
      max: Math.max(0, ...lengths),
      longest: [...lines].sort((a, b) => b.chars - a.chars).slice(0, 5).map((l) => l.text),
    },
    ratios: {
      secondary: compact(aggSizes.ratios.secondary),
      tertiary: compact(aggSizes.ratios.tertiary),
      connector: compact(aggSizes.ratios.connector),
      byConnector: Object.fromEntries(Object.entries(aggSizes.ratios.byConnector).map(([k, v]) => [k, compact(v)])),
      glyphs: Object.fromEntries(Object.entries(aggSizes.ratios.glyphs).map(([k, v]) => [k, compact(v)])),
    },
    gaps: {
      normal: compact(agg.gaps.normal),
      beforeLast: compact(agg.gaps.beforeLast),
      connector: compact(agg.gaps.connector),
      approxExcluded: { ...agg.gapsApprox },
      withApprox: { normal: compact(agg.gapsWithApprox.normal), beforeLast: compact(agg.gapsWithApprox.beforeLast), connector: compact(agg.gapsWithApprox.connector) },
    },
    fill: {
      largestPx: compact(robust(okFrame.filter(may("sizes")).map((d) => d.user.maxSize))),
      blockWidthOfCut: compact(robust(okFrame.map((d) => d.user.block.w / D(d)))),
      blockHeightOfCut: compact(robust(okFrame.map((d) => d.user.block.h / D(d)))),
    },
    fonts: {
      byLabel: share(countBy(okSizes, (d) => d.user.mainFont), okSizes.length),
      byLine: share(countBy(sizedLines, (l) => `${l.family}/${l.style}`), sizedLines.length),
      mixedLabels: okSizes.filter((d) => d.user.families.length > 1).length,
      glyphSegments: countBy(
        sizedLines.flatMap((l) => l.glyphs),
        (g) => `${g.text} → ${g.family}`,
      ),
    },
    connectors: {
      standalone: countBy(
        lines.filter((l) => l.connector),
        (l) => l.text.toLowerCase(),
      ),
      inline: countBy(inline, (x) => x),
      stackedLabels: stacked.length,
      inlineLabels: okText.filter((d) => !stacked.includes(d) && d.user.lines.some((l) => tokenize(l.text).some((x) => words.has(x)))).length,
      shiftEm: compact(aggSizes.connectorShiftEm),
    },
    examples,
    uppercase: {
      labels: upper.length,
      fonts: countBy(upper, (d) => d.user.lines.find((l) => l.allCaps)!.family),
      examples: upper.slice(0, 6).map((d) => ({ text: d.text, lines: d.user.lines.map((l) => l.text), font: d.user.mainFont })),
    },
    longText: {
      labels: long.length,
      threshold: longT,
      lineCount: countBy(long, (d) => String(d.user.lines.length))
        .map((r) => ({ lines: Number(r.key), count: r.count }))
        .sort((a, b) => a.lines - b.lines),
      fonts: countBy(long, (d) => d.user.mainFont),
      examples: long.slice(0, 6).map((d) => ({ text: d.text, lines: d.user.lines.map((l) => l.text) })),
    },
    templates: tplRows,
    programVsUser: {
      compared: agg.sameBreaks.n,
      sameBreaks: agg.sameBreaks.same,
      scale: compact(agg.scale),
      separatorsOnly: agg.separatorsOnly,
      textEdited: agg.textEdited,
      fontChanges: agg.fontChanges,
    },
    findings: findingsOf(agg),
  };
}
