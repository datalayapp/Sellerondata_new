import type { Profile, Reference } from "@tagpress/domain";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { referenceImageUrl } from "../mantik/contract.ts";
import "./ornekler.css";

/** Etiketin gerçek çapı (mm): tasarım karesi = varsayılan boyutun çapı (ör. 3,8 cm → 38 mm). */
export function labelMm(p: Profile | null | undefined): number {
  const size = p?.output.sizes.find((s) => s.id === p.output.defaultSize) ?? p?.output.sizes[0];
  return (size?.cm ?? 3.8) * 10;
}

export type RefSide = "user" | "program";

/**
 * Bitmiş etiket (referans) görseli, `mm` kenarlı kâğıtta (tuvalde 1 birim = 1 mm, dışında gerçek mm). Görsel yoksa ya da
 * yüklenemezse satırların yerini ve boyutunu gösteren çizim; satır bölmesi yine okunur. `side="program"`: programın önerisi.
 */
export function RefGorsel({ reference, side = "user", mm, alt }: { reference: Reference; side?: RefSide; mm: number; alt?: string }) {
  const { t } = useTranslation("designLanguageLab");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [reference.id]);
  const lines = side === "program" ? (reference.program ?? []) : reference.user;
  const useImage = side === "user" && !!reference.image && !failed;
  const frame = reference.labelFramePx || 440;
  return (
    <span className="td-ref" style={{ width: `calc(${mm} * var(--tz-mm))`, height: `calc(${mm} * var(--tz-mm))` }}>
      {useImage ? (
        <img src={referenceImageUrl(reference.id)} alt={alt ?? reference.text} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <svg viewBox={`0 0 ${frame} ${frame}`} role="img" aria-label={t("ref.sketch", { lines: lines.map((l) => l.text).join(" / ") })}>
          {lines.map((l, i) => (
            <g key={i}>
              <rect x={l.ink.x} y={l.ink.y} width={l.ink.w} height={l.ink.h} className="td-ref-kutu" />
              <text x={l.ink.x} y={l.ink.y + l.ink.h * 0.82} fontSize={Math.max(8, Math.min(l.sizePx, l.ink.h * 1.1))} textLength={l.ink.w} lengthAdjust="spacingAndGlyphs" className="td-ref-yazi">
                {l.text}
              </text>
            </g>
          ))}
        </svg>
      )}
    </span>
  );
}
