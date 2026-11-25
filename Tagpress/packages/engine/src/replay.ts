import type { DesignIntent, IntentLine, Profile, Reference, TemplateGeometry, Tier } from "@tagpress/domain";
import type { FontRegistry } from "@tagpress/typeset";
import { type FitModel, type GapKind, isConnectorText } from "./compose.ts";
import { layout } from "./layout.ts";

/**
 * AI'sız tekrar düzeneği: kullanıcının bitmiş etiketteki (referans) satırları (metin, baskın font, sınıf) niyet yapılıp motora
 * verilir; motorun seçtiği boyut, blok konumu ve görünen satır aralıkları kullanıcınınkiyle karşılaştırılır.
 * Yalnızca motor ayarlarını (profil + geometri) ölçer.
 */

export interface ReplayGap {
  kind: GapKind;
  /** Görünen boşluk / iki satırdan küçüğünün puntosu. */
  user: number;
  engine: number;
}

export interface ReplayMetrics {
  id: string;
  templateKey: string | null;
  ok: boolean;
  reason?: string;
  lines: number;
  /** Motorun en büyük satırı / kullanıcınınki. */
  sizeRatio: number;
  within10: boolean;
  /** Blok mürekkep merkezi farkı (motor − kullanıcı, px). */
  dx: number;
  dy: number;
  /** Blok mürekkep yüksekliği oranı (motor / kullanıcı). */
  heightRatio: number;
  gaps: ReplayGap[];
  ms: number;
}

const norm = (s: string) => s.replace(/\s+/gu, " ").trim();

/** Kullanıcının satırlarından niyet: baskın font → profil font kimliği, sınıf = en büyük satıra orana en yakın tier. */
export function referenceToIntent(ref: Reference, profile: Profile): { intent: DesignIntent; text: string } {
  const lines = ref.user.map((l) => ({ ...l, text: norm(l.text) })).filter((l) => l.text);
  const maxSize = Math.max(...lines.map((l) => l.sizePx));
  const entries = profile.fonts.list;
  const usable = (id: string) => (entries.find((e) => e.id === id)?.roles.length ?? 0) > 0;
  const lookup = (family: string, style: string) =>
    entries.find((e) => e.family === family && e.style === style)?.id ?? entries.find((e) => e.family === family)?.id ?? null;
  const largest = [...lines].sort((a, b) => b.sizePx - a.sizePx)[0]!;
  const fallbackId =
    [largest, ...lines].map((l) => lookup(l.family, l.style)).find((id): id is string => !!id && usable(id)) ??
    entries.find((e) => e.roles.includes("primary") && e.enabled)?.id ??
    entries[0]?.id ??
    "";
  const t = profile.sizing.tiers;
  const tierOf = (ratio: number): Tier => {
    const cands: Tier[] = ["primary", "secondary", "tertiary"];
    return cands.reduce((best, c) => (Math.abs(t[c] / t.primary - ratio) < Math.abs(t[best] / t.primary - ratio) ? c : best), "primary" as Tier);
  };
  const intentLines: IntentLine[] = lines.map((l) => {
    const id = lookup(l.family, l.style);
    const fontId = id && usable(id) ? id : fallbackId;
    const ratio = l.sizePx / maxSize;
    const connector = lines.length > 1 && isConnectorText(l.text, profile);
    return {
      text: l.text,
      role: connector ? "connector" : l === largest ? "name" : "other",
      tier: connector ? "connector" : tierOf(ratio),
      fontId,
      size: Math.min(1.5, Math.max(0.05, ratio)),
    };
  });
  return { intent: { lines: intentLines, rationale: "tekrar" }, text: lines.map((l) => l.text).join(" ") };
}

function userGapKind(lines: Reference["user"], i: number, profile: Profile): GapKind {
  const a = lines[i - 1]!, b = lines[i]!;
  if (isConnectorText(a.text, profile) || isConnectorText(b.text, profile)) return "connector";
  if (i === lines.length - 1 && b.sizePx < profile.spacing.beforeLastRatio * a.sizePx) return "beforeLast";
  return "normal";
}

export interface ReplayOptions {
  /**
   * true: oran kilidi kapatılır, motor kullanıcının kendi satır oranlarını kullanır (eski sistemin ölçüm düzeneği
   * böyleydi). false (varsayılan): profil sınıf oranları uygulanır.
   */
  userRatios?: boolean;
  /** Sığdırma modeli (varsayılan "glyph"; "line" eski sistemin satır kutusu modeli). */
  fit?: FitModel;
}

export async function replayReference(ref: Reference, profile: Profile, geometry: TemplateGeometry, fonts: FontRegistry, opts: ReplayOptions = {}): Promise<ReplayMetrics> {
  if (opts.userRatios) profile = { ...profile, sizing: { ...profile.sizing, tiersLocked: false } };
  const { intent, text } = referenceToIntent(ref, profile);
  const user = ref.user.map((l) => ({ ...l, text: norm(l.text) })).filter((l) => l.text);
  const base = { id: ref.id, templateKey: ref.templateKey, lines: user.length };
  const out = await layout({ text, intent, profile, geometry, fonts, fit: opts.fit ?? "glyph" });
  if (!out.lines.length) {
    const reason = out.issues.find((i) => i.severity === "error")?.message ?? "yerleşmedi";
    return { ...base, ok: false, reason, sizeRatio: NaN, within10: false, dx: NaN, dy: NaN, heightRatio: NaN, gaps: [], ms: out.ms };
  }
  const uMax = Math.max(...user.map((l) => l.sizePx));
  const eMax = Math.max(...out.lines.map((l) => l.sizePx));
  const ub = user.reduce(
    (b, l) => ({ x0: Math.min(b.x0, l.ink.x), y0: Math.min(b.y0, l.ink.y), x1: Math.max(b.x1, l.ink.x + l.ink.w), y1: Math.max(b.y1, l.ink.y + l.ink.h) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  const eb = out.ink;
  const gaps: ReplayGap[] = [];
  if (out.lines.length === user.length) {
    for (let i = 1; i < user.length; i++) {
      const a = user[i - 1]!, b = user[i]!;
      const ea = out.lines[i - 1]!, ebl = out.lines[i]!;
      gaps.push({
        kind: userGapKind(user, i, profile),
        user: (b.ink.y - (a.ink.y + a.ink.h)) / Math.min(a.sizePx, b.sizePx),
        engine: (ebl.ink.y - (ea.ink.y + ea.ink.h)) / Math.min(ea.sizePx, ebl.sizePx),
      });
    }
  }
  const sizeRatio = eMax / uMax;
  return {
    ...base,
    ok: out.ok,
    ...(out.ok ? {} : { reason: out.issues.find((i) => i.severity === "error")?.message ?? "" }),
    sizeRatio,
    within10: Math.abs(sizeRatio - 1) <= 0.1,
    dx: eb.x + eb.w / 2 - (ub.x0 + ub.x1) / 2,
    dy: eb.y + eb.h / 2 - (ub.y0 + ub.y1) / 2,
    heightRatio: eb.h / (ub.y1 - ub.y0),
    gaps,
    ms: out.ms,
  };
}

export interface Quantiles {
  p10: number;
  med: number;
  p90: number;
}

export interface ReplaySummary {
  n: number;
  failed: number;
  /** ±%10 içindeki etiket sayısı (yerleşenler arasında). */
  within10: number;
  sizeRatio: Quantiles;
  dx: Quantiles;
  dy: Quantiles;
  heightRatio: Quantiles;
  gaps: Partial<Record<GapKind, { n: number; user: number; engine: number }>>;
  ms: { med: number; max: number };
}

export function quantile(xs: readonly number[], p: number): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.floor(p * (s.length - 1))]!;
}

const q3 = (xs: number[]): Quantiles => ({ p10: quantile(xs, 0.1), med: quantile(xs, 0.5), p90: quantile(xs, 0.9) });

export function summarizeReplays(metrics: readonly ReplayMetrics[]): ReplaySummary {
  const placed = metrics.filter((m) => Number.isFinite(m.sizeRatio));
  const gaps: ReplaySummary["gaps"] = {};
  for (const kind of ["normal", "beforeLast", "connector"] as const) {
    const g = placed.flatMap((m) => m.gaps.filter((x) => x.kind === kind));
    if (g.length) gaps[kind] = { n: g.length, user: quantile(g.map((x) => x.user), 0.5), engine: quantile(g.map((x) => x.engine), 0.5) };
  }
  return {
    n: metrics.length,
    failed: metrics.length - placed.length,
    within10: placed.filter((m) => m.within10).length,
    sizeRatio: q3(placed.map((m) => m.sizeRatio)),
    dx: q3(placed.map((m) => m.dx)),
    dy: q3(placed.map((m) => m.dy)),
    heightRatio: q3(placed.map((m) => m.heightRatio)),
    gaps,
    ms: { med: quantile(metrics.map((m) => m.ms), 0.5), max: Math.max(0, ...metrics.map((m) => m.ms)) },
  };
}

/** Özetin okunur hâli (konsol için). */
export function formatReplaySummary(s: ReplaySummary): string {
  const f = (q: Quantiles, d = 2) => `p10 ${q.p10.toFixed(d)} · med ${q.med.toFixed(d)} · p90 ${q.p90.toFixed(d)}`;
  const lines = [
    `${s.n} etiket (${s.failed} yerleşmedi) · ±%10 boyut: ${s.within10}/${s.n - s.failed}`,
    `  boyut motor/kullanıcı   ${f(s.sizeRatio)}`,
    `  blok yüksekliği oranı   ${f(s.heightRatio)}`,
    `  blok merkezi dx (px)    ${f(s.dx, 1)}`,
    `  blok merkezi dy (px)    ${f(s.dy, 1)}`,
  ];
  for (const [kind, g] of Object.entries(s.gaps)) lines.push(`  boşluk ${kind.padEnd(10)}       kullanıcı med ${g.user.toFixed(2)} · motor med ${g.engine.toFixed(2)} (n=${g.n})`);
  lines.push(`  süre (ms)               med ${s.ms.med} · en çok ${s.ms.max}`);
  return lines.join("\n");
}
