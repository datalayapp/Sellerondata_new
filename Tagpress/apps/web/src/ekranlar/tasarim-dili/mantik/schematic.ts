import type { Profile, Tier } from "@tagpress/domain";
import { pct, tt } from "../dil.ts";

/**
 * Özet sayfasındaki ölçü çizgili örnek etiketin geometrisi. Gerçek motor değil, profil oranlarının şemasıdır:
 * satır boyutları sınıf oranlarından, aralıklar "görünen boşluk = oran × küçük satırın puntosu" kuralından gelir.
 */

export const CAP_HEIGHT = 0.7; // büyük harf yüksekliği / punto (şematik sabit)

export interface SchLine {
  label: string;
  tier: Tier;
  sizePx: number;
  /** Ana satıra oran (0..). */
  ratio: number;
  capTop: number;
  baseline: number;
}

export interface SchGap {
  y1: number;
  y2: number;
  /** Küçük satırın puntosuna oran. */
  ratio: number;
  kind: "normal" | "beforeLast" | "connector";
  label: string;
}

export interface Schematic {
  lines: SchLine[];
  gaps: SchGap[];
  /** İçeriğin toplam yüksekliği. */
  height: number;
  base: number;
}

export function buildSchematic(p: Profile, base = 40): Schematic {
  const t = p.sizing.tiers;
  const connectorWord = p.connectors.words[0] ?? "&";
  const seq: Array<{ label: string; tier: Tier }> = [
    { label: tt("designLanguage:schema.primary"), tier: "primary" },
    { label: connectorWord, tier: "connector" },
    { label: tt("designLanguage:schema.primary"), tier: "primary" },
    { label: tt("designLanguage:schema.secondary"), tier: "secondary" },
    { label: tt("designLanguage:schema.tertiary"), tier: "tertiary" },
  ];
  const lines: SchLine[] = [];
  const gaps: SchGap[] = [];
  let y = 0;
  seq.forEach((s, i) => {
    const ratio = t[s.tier] / t.primary;
    const sizePx = base * ratio;
    const prev = lines[i - 1];
    if (prev) {
      const isConn = prev.tier === "connector" || s.tier === "connector";
      const isLast = i === seq.length - 1;
      const kind: SchGap["kind"] = isConn ? "connector" : isLast && sizePx < prev.sizePx * p.spacing.beforeLastRatio ? "beforeLast" : "normal";
      const gapRatio = p.spacing.inkGaps[kind];
      const gap = gapRatio * Math.min(prev.sizePx, sizePx);
      gaps.push({ y1: prev.baseline, y2: prev.baseline + gap, ratio: gapRatio, kind, label: pct(gapRatio) });
      y = prev.baseline + gap;
    }
    lines.push({ label: s.label, tier: s.tier, sizePx, ratio, capTop: y, baseline: y + CAP_HEIGHT * sizePx });
  });
  const last = lines[lines.length - 1];
  return { lines, gaps, height: last ? last.baseline : 0, base };
}
