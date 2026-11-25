import type { PrintSlot, PrintTemplate } from "@tagpress/domain";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LabelImage } from "../../../ortak/index.ts";
import type { Rect } from "../../../tezgah/tuval/canvas-math.ts";
import { artBox, type CellLabelView, type ItemSizes, itemSize, type Page, slotOf } from "../mantik/desk-model.ts";
import { pageFill } from "../mantik/masa.ts";
import { ptToMm, registrationMarks } from "../mantik/sablon/marks.ts";
import { Artboard, CropMarks, CutPath, cx, Icon } from "../../../tezgah/index.ts";

/** Ayrıntı düzeyi: `none` tuval boyutu bilinmeden (yalnız kağıt), `thumb` sunucunun sayfa resmi, `detail` etiketler. */
export type Lod = "none" | "thumb" | "detail";

export interface SayfaProps {
  page: Page;
  template: PrintTemplate | undefined;
  /** Masadaki yeri (mm). */
  at: Rect;
  lod: Lod;
  thumbUrl: string | null;
  onThumbError(pageId: string): void;
  sizes: ItemSizes;
  /** Bu sayfadaki seçili öğeler, virgülle (memo karşılaştırması ucuz kalsın). */
  selectedKey: string;
  active: boolean;
  preview: boolean;
  previewOf(variantId: string): string;
  labels: CellLabelView[];
}

/** Yuvanın kesim çizgisi (döndürülmüş yuvada yol; köşesi yuvarlak dikdörtgende yol). `d` kutunun sol üstüne göre. */
function cutOf(s: PrintSlot): { shape: "circle" | "rect" | "path"; d?: string; rect: Rect } {
  const rect = { x: s.cx - s.w / 2, y: s.cy - s.h / 2, w: s.w, h: s.h };
  const rx = s.w / 2;
  const ry = s.h / 2;
  if (s.shape !== "rect" && !s.rotation) return { shape: "circle", rect };
  if (s.shape === "rect" && !s.rotation && !s.cornerRadius) return { shape: "rect", rect };
  if (s.shape !== "rect") {
    // Döndürülmüş elips: iki yay (kutu merkezine göre).
    const a = (s.rotation * Math.PI) / 180;
    const ex = rx * Math.cos(a);
    const ey = rx * Math.sin(a);
    return { shape: "path", rect, d: `M${rx - ex} ${ry - ey}A${rx} ${ry} ${s.rotation} 1 0 ${rx + ex} ${ry + ey}A${rx} ${ry} ${s.rotation} 1 0 ${rx - ex} ${ry - ey}Z` };
  }
  const r = Math.min(s.cornerRadius, rx, ry);
  const pts = (x: number, y: number) => {
    const a = (s.rotation * Math.PI) / 180;
    return `${rx + x * Math.cos(a) - y * Math.sin(a)} ${ry + x * Math.sin(a) + y * Math.cos(a)}`;
  };
  if (!r) return { shape: "path", rect, d: `M${pts(-rx, -ry)}L${pts(rx, -ry)}L${pts(rx, ry)}L${pts(-rx, ry)}Z` };
  const arc = `A${r} ${r} 0 0 1`;
  return {
    shape: "path",
    rect,
    d: `M${pts(-rx + r, -ry)}L${pts(rx - r, -ry)}${arc} ${pts(rx, -ry + r)}L${pts(rx, ry - r)}${arc} ${pts(rx - r, ry)}L${pts(-rx + r, ry)}${arc} ${pts(-rx, ry - r)}L${pts(-rx, -ry + r)}${arc} ${pts(-rx + r, -ry)}Z`,
  };
}

/** Kesikli yuva kılavuzu (yalnız ekranda; düzenleme görünümü). */
function SlotGuides({ t, w, h }: { t: PrintTemplate; w: number; h: number }) {
  return (
    <svg className="bm-guides" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {t.slots.map((s) =>
        s.shape === "rect" ? (
          <rect key={s.id} x={s.cx - s.w / 2} y={s.cy - s.h / 2} width={s.w} height={s.h} rx={s.cornerRadius} transform={s.rotation ? `rotate(${s.rotation} ${s.cx} ${s.cy})` : undefined} />
        ) : (
          <ellipse key={s.id} cx={s.cx} cy={s.cy} rx={s.w / 2} ry={s.h / 2} transform={s.rotation ? `rotate(${s.rotation} ${s.cx} ${s.cy})` : undefined} />
        ),
      )}
    </svg>
  );
}

/** Kayıt işaretleri (kesim makinesinin okuduğu; baskı önizlemesinde). */
function RegMarks({ t, w, h }: { t: PrintTemplate; w: number; h: number }) {
  const marks = useMemo(() => registrationMarks(t.paper, t.cut.registration), [t]);
  if (!marks.length) return null;
  return (
    <svg className="bm-reg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {marks.map((m, i) =>
        m.kind === "rect" ? (
          <rect key={i} x={m.x} y={m.y} width={m.w} height={m.h} />
        ) : m.kind === "line" ? (
          <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} strokeWidth={m.width} />
        ) : (
          <circle key={i} cx={m.cx} cy={m.cy} r={m.r} strokeWidth={m.width} />
        ),
      )}
    </svg>
  );
}

/**
 * Tek sayfa (masada `at`): kağıt, yuva kılavuzu ya da baskı önizlemesi (kesim çizgisi, kesim ve kayıt işaretleri),
 * etiketler, hücre etiketleri. `memo`: yalnız kendi verisi değişince yeniden çizilir; görünür alan dışındayken
 * `Artboard` içeriği hiç çizmez.
 */
export const Sayfa = memo(function Sayfa({ page, template, at, lod, thumbUrl, onThumbError, sizes, selectedKey, active, preview, previewOf, labels }: SayfaProps) {
  const { t } = useTranslation("printDesk");
  const sel = new Set(selectedKey ? selectedKey.split(",") : []);
  const fill = pageFill(page, template);
  const { w, h } = at;
  // Seçili öğeler en üstte: görsel kutusu komşusunu örten sticker'larda seçim çerçevesi görünür kalsın.
  const items = sel.size ? [...page.items.filter((i) => !sel.has(i.id)), ...page.items.filter((i) => sel.has(i.id))] : page.items;
  const cutVisible = preview && !!template?.cut.outlineVisible;

  return (
    <Artboard
      x={at.x}
      y={at.y}
      w={w}
      h={h}
      selected={active}
      name={
        <>
          <b className="bm-pg-n">{page.name}</b>
          {page.copies > 1 && <span className="tz-mono">{t("page.copiesTag", { n: page.copies })}</span>}
          {page.locked && (
            <span className="bm-lock" role="img" aria-label={t("page.lockedTag")}>
              <Icon name="lock" size={12} />
            </span>
          )}
        </>
      }
      tag={
        <span className="bm-fill tz-mono">
          {fill.capacity === null ? t("page.fillFree", { count: fill.count }) : t("page.fill", { n: fill.count, capacity: fill.capacity })}
          {fill.extras > 0 && ` · ${t("page.extras", { count: fill.extras })}`}
        </span>
      }
    >
      <div className={cx("bm-paper", active && "is-act")} style={{ width: w, height: h }} />
      {lod === "thumb" && thumbUrl && <img className="bm-thumb" src={thumbUrl} alt="" draggable={false} style={{ width: w, height: h }} onError={() => onThumbError(page.id)} />}
      {lod === "detail" && (
        <>
          {template && !preview && <SlotGuides t={template} w={w} h={h} />}
          {items.map((it) => {
            const s = itemSize(it, template, sizes);
            const art = artBox(it, template, sizes);
            const isSel = sel.has(it.id);
            const slot = isSel ? slotOf(template, it.slotId) : undefined;
            const free = template?.kind === "sticker" && !it.slotId;
            return (
              <div key={it.id} className={cx("bm-it", isSel && "is-sel")} data-item={it.id} style={{ left: it.xMm, top: it.yMm }}>
                <span className="bm-art" style={{ left: art.x, top: art.y }}>
                  <LabelImage src={previewOf(it.variantId)} widthMm={art.w} heightMm={art.h} alt="" />
                </span>
                {isSel && <span className={cx("bm-ring", free && "is-rect")} style={{ left: -s.w / 2, top: -s.h / 2, width: s.w, height: s.h }} />}
                {it.extra && (isSel || active) && <span className="bm-extra" style={{ left: s.w / 2 - 2.4, top: -s.h / 2 }} />}
                {/* Yuvadaki seçili öğe: yuvanın merkezi (ince ayarda referans). */}
                {slot && <span className="bm-xh" style={{ left: slot.cx - it.xMm, top: slot.cy - it.yMm }} />}
              </div>
            );
          })}
          {cutVisible && template && template.slots.map((s) => <CutPath key={s.id} {...cutOf(s)} />)}
          {template &&
            labels.map((l) => (
              <span
                key={l.jobId}
                className="bm-cl"
                style={{
                  left: l.xMm,
                  top: l.yMm,
                  fontSize: ptToMm(template.cellLabel.sizePt),
                  fontFamily: `"${template.cellLabel.fontFamily}", ui-sans-serif, system-ui, sans-serif`,
                  fontWeight: template.cellLabel.fontWeight,
                  color: template.cellLabel.color,
                }}
              >
                {l.text}
              </span>
            ))}
        </>
      )}
      {preview && template && lod === "detail" && <RegMarks t={template} w={w} h={h} />}
      {preview && <CropMarks rect={{ x: 0, y: 0, w, h }} />}
    </Artboard>
  );
});
