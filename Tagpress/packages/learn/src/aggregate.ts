import type { Box, Profile } from "@tagpress/domain";
import type { RefDiff } from "./diff.ts";
import { boxCenter, type GapKind, unionBox } from "./lines.ts";
import { type Robust, countBy, kMedians, robust } from "./stats.ts";

/**
 * Farkların toplanması. Sağlam istatistik (medyan, IQR) ve en az örnek eşikleri: eşiğin altındaki bir istatistik
 * raporlanır ama öneriye dönüşmez.
 */

export interface AggregateOptions {
  /** Genel profil önerisi için en az örnek. */
  minProfile?: number;
  /** Şablon alanı / kurdele önerisi için şablon başına en az örnek. */
  minTemplate?: number;
  /** Hedef merkez önerisi için şablon başına en az örnek. */
  minCenter?: number;
  /** Satır sınıfı kümelerinin tohumları (yoksa profilden). */
  profile?: Profile | null;
}

export const DEFAULT_THRESHOLDS = { minProfile: 15, minTemplate: 3, minCenter: 2 } as const;

export interface TemplateAggregate {
  key: string;
  n: number;
  /** Kullanıcının blok merkezleri (px). */
  centerX: Robust;
  centerY: Robust;
  /** Bütün kullanıcı bloklarının birleşimi (px). */
  blocks: Box;
  /** Kullanıcının en üstteki yazı kenarı (px). */
  userTop: number;
  ribbonY: number | null;
  ribbonViolations: number;
  enoughCenter: boolean;
  enoughTemplate: boolean;
  ids: string[];
}

export interface Aggregate {
  thresholds: { minProfile: number; minTemplate: number; minCenter: number };
  n: number;
  usable: number;
  withProgram: number;
  sameBreaks: { n: number; same: number };
  /** Kullanıcı / program en büyük satır (satır bölmesi aynı olanlarda). */
  scale: Robust | null;
  /** Kullanıcının satır oranları (en büyük satıra). İkincil/üçüncül, profil oranlarından başlayan k-medyanla ayrılır. */
  ratios: {
    secondary: Robust | null;
    tertiary: Robust | null;
    connector: Robust | null;
    byConnector: Record<string, Robust>;
    /** Satır içi glif kuralı segmentleri (ör. "&") asıl puntoya oranı, karakter başına. */
    glyphs: Record<string, Robust>;
  };
  /** Görünen boşluklar, yaklaşık satırlar HARİÇ. */
  gaps: Record<GapKind, Robust | null>;
  /** Aynı ölçü, yaklaşık satırlar DAHİL (bulguyu göstermek için). */
  gapsWithApprox: Record<GapKind, Robust | null>;
  /** Türüne göre atılan yaklaşık boşluk sayısı. */
  gapsApprox: Record<GapKind, number>;
  connectorShiftEm: Robust | null;
  /** Kullanıcı − program blok merkezi (px). */
  center: { dx: Robust | null; dy: Robust | null };
  fontChanges: Array<{ from: string; to: string; count: number }>;
  separatorsOnly: number;
  textEdited: number;
  ribbonViolations: number;
  approxLines: number;
  templates: Record<string, TemplateAggregate>;
  enough: { profile: boolean };
}

const KINDS: GapKind[] = ["normal", "beforeLast", "connector"];

export function aggregate(diffs: readonly RefDiff[], opts: AggregateOptions = {}): Aggregate {
  const thresholds = {
    minProfile: opts.minProfile ?? DEFAULT_THRESHOLDS.minProfile,
    minTemplate: opts.minTemplate ?? DEFAULT_THRESHOLDS.minTemplate,
    minCenter: opts.minCenter ?? DEFAULT_THRESHOLDS.minCenter,
  };
  const ok = diffs.filter((d) => d.usable);
  const withProgram = ok.filter((d) => d.program);
  const same = withProgram.filter((d) => d.sameBreaks);

  // Satır oranları: en büyük satır ve bağlaçlar dışındaki satırlar iki kümeye.
  const tiers = opts.profile?.sizing.tiers ?? { primary: 1, secondary: 0.75, tertiary: 0.6, connector: 0.55 };
  const other = ok.flatMap((d) => d.user.lines.filter((l) => !l.largest && !l.connector).map((l) => l.ratio));
  const split = kMedians(other, [tiers.secondary / tiers.primary, tiers.tertiary / tiers.primary]);
  const connLines = ok.flatMap((d) => d.user.lines.filter((l) => l.connector));
  const byConnector: Record<string, Robust> = {};
  for (const { key } of countBy(connLines, (l) => l.text.toLowerCase())) {
    const r = robust(connLines.filter((l) => l.text.toLowerCase() === key).map((l) => l.ratio));
    if (r) byConnector[key] = r;
  }
  const glyphSegs = ok.flatMap((d) => d.user.lines.filter((l) => !l.connector).flatMap((l) => l.glyphs));
  const glyphs: Record<string, Robust> = {};
  for (const { key } of countBy(glyphSegs, (g) => g.text)) {
    const r = robust(glyphSegs.filter((g) => g.text === key).map((g) => g.ratio));
    if (r) glyphs[key] = r;
  }

  const gaps = {} as Record<GapKind, Robust | null>;
  const gapsWithApprox = {} as Record<GapKind, Robust | null>;
  const gapsApprox = {} as Record<GapKind, number>;
  for (const k of KINDS) {
    const all = ok.flatMap((d) => d.user.gaps.filter((g) => g.kind === k));
    gaps[k] = robust(all.filter((g) => !g.approx).map((g) => g.value));
    gapsWithApprox[k] = robust(all.map((g) => g.value));
    gapsApprox[k] = all.filter((g) => g.approx).length;
  }

  const fontChanges = countBy(
    withProgram.filter((d) => d.fontChange),
    (d) => `${d.fontChange!.from}→${d.fontChange!.to}`,
  ).map(({ key, count }) => {
    const [from, to] = key.split("→") as [string, string];
    return { from, to, count };
  });

  const templates: Record<string, TemplateAggregate> = {};
  const byTpl = new Map<string, RefDiff[]>();
  for (const d of ok) if (d.templateKey) byTpl.set(d.templateKey, [...(byTpl.get(d.templateKey) ?? []), d]);
  for (const [key, ds] of byTpl) {
    const centers = ds.map((d) => boxCenter(d.user.block));
    const ribbon = ds.find((d) => d.ribbon)?.ribbon ?? null;
    templates[key] = {
      key,
      n: ds.length,
      centerX: robust(centers.map((c) => c.x))!,
      centerY: robust(centers.map((c) => c.y))!,
      blocks: unionBox(ds.map((d) => d.user.block)),
      userTop: Math.min(...ds.map((d) => d.user.block.y)),
      ribbonY: ribbon?.ribbonY ?? null,
      ribbonViolations: ds.filter((d) => d.ribbon?.violation).length,
      enoughCenter: ds.length >= thresholds.minCenter,
      enoughTemplate: ds.length >= thresholds.minTemplate,
      ids: ds.map((d) => d.id),
    };
  }

  return {
    thresholds,
    n: diffs.length,
    usable: ok.length,
    withProgram: withProgram.length,
    sameBreaks: { n: withProgram.length, same: same.length },
    scale: robust(same.map((d) => d.scale!)),
    ratios: {
      secondary: robust(split.groups[0]!),
      tertiary: robust(split.groups[1]!),
      connector: robust(connLines.map((l) => l.ratio)),
      byConnector,
      glyphs,
    },
    gaps,
    gapsWithApprox,
    gapsApprox,
    connectorShiftEm: robust(ok.map((d) => d.user.connectorShiftEm).filter((x): x is number => x !== null)),
    center: { dx: robust(same.map((d) => d.center!.dx)), dy: robust(same.map((d) => d.center!.dy)) },
    fontChanges,
    separatorsOnly: withProgram.filter((d) => d.separatorsOnly).length,
    textEdited: ok.filter((d) => d.textEdited).length,
    ribbonViolations: ok.filter((d) => d.ribbon?.violation).length,
    approxLines: ok.reduce((a, d) => a + d.approxLines, 0),
    templates,
    enough: { profile: ok.length >= thresholds.minProfile },
  };
}
