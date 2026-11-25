import type { Profile } from "@tagpress/domain";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { buildSchematic } from "../mantik/schematic.ts";
import { pct } from "../dil.ts";
import "./sema.css";

/** Çizim alanı: solda kesim şekli ve satır çubukları, sağda oran sütunu (maket "Satır oranları"). */
const W = 280;
const H = 220;
const CX = 110;
const CY = H / 2;
const R = 100;
/** Çubukların kapladığı en büyük yükseklik (kesimin içinde kalır). */
const BODY = 132;
/** Ana satır çubuğunun genişliği; diğerleri oranla daralır. */
const BAR = 104;

/**
 * Satır oranları şeması: her satır gri bir çubuk (yüksekliği büyük harf boyu), sağda ana satıra oranı; satırlar arası
 * görünen boşluk mor ölçüyle. Gerçek motor değil, profil oranlarının şemasıdır (geometri `../mantik/schematic.ts`).
 * Çubuklar boşlukla ayrıldığı için satırlar üst üste binmez.
 */
export function Sema({ profile, caption = true }: { profile: Profile; caption?: boolean }) {
  const { t } = useTranslation("designLanguage");
  const s = useMemo(() => buildSchematic(profile, 40), [profile]);
  const k = s.height > 0 ? BODY / s.height : 1;
  const top = CY - (s.height * k) / 2;
  const cut = profile.output.cut;
  const widest = Math.max(...s.lines.map((l) => (l.tier === "connector" ? 0 : barWidth(l.ratio))), BAR);
  const gapX = CX + widest / 2 + 8;
  return (
    <figure className="td-sema">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("schema.label")}>
        {cut.kind === "rect" ? (
          <rect className="td-sema-kesim" x={CX - R} y={CY - R} width={2 * R} height={2 * R} rx={6} />
        ) : (
          <circle className="td-sema-kesim" cx={CX} cy={CY} r={R} />
        )}
        {s.lines.map((l, i) => {
          const y = top + l.capTop * k;
          const h = Math.max(2, (l.baseline - l.capTop) * k);
          const w = l.tier === "connector" ? Math.max(10, h * 1.4) : barWidth(l.ratio);
          return (
            <g key={i}>
              <rect className="td-sema-cubuk" x={CX - w / 2} y={y} width={w} height={h} rx={2} />
              <text className="td-sema-oran" fontSize={10} x={CX + R + 10} y={y + h / 2 + 3.5}>
                {pct(l.ratio)}
              </text>
            </g>
          );
        })}
        {s.gaps.map((g, i) => {
          const y1 = top + g.y1 * k;
          const y2 = top + g.y2 * k;
          return (
            <g key={i} className="td-sema-bosluk">
              <path d={`M${gapX} ${y1}V${y2}M${gapX - 3} ${y1}h6M${gapX - 3} ${y2}h6`} />
              <text fontSize={9} x={gapX + 6} y={(y1 + y2) / 2 + 3}>
                {g.label}
              </text>
            </g>
          );
        })}
      </svg>
      {caption && <figcaption>{t("schema.caption")}</figcaption>}
    </figure>
  );
}

/** Çubuk genişliği: ana satır BAR, küçük satırlar oranla (çok küçülmesin diye tabanı var). */
function barWidth(ratio: number): number {
  return BAR * (0.35 + 0.65 * Math.min(1, ratio));
}
