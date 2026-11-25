import { PRINTER_MARGIN_MM, REGISTRATION_STYLES, type PrintPreset, type PrintSlot, type PrintTemplateWarning } from "@tagpress/domain";
import { clearingInset, defaultStickerFlow, MARK_SAFE_MM, markOverlappingSlots } from "@tagpress/print";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatMm, formatNumber } from "../../../i18n/bicim.ts";
import { i18n } from "../../../i18n/index.ts";
import { PAPER_PRESETS, paperPresetId } from "../mantik/grid.ts";
import { commonValue, patchSlots, r2 } from "../mantik/slot-geometry.ts";
import type { TemplateDraft } from "../mantik/sablon/draft.ts";
import { markFixInset, type Orientation, orientationOf, warningText, withOrientation } from "../mantik/sablon/editor.ts";
import { gapFromPitch, type Layout, layoutCount, layoutMargins } from "../mantik/sablon/yerlesim.ts";
import { Button, CollapsedGroup, Icon, IconButton, IssueBox, PanelSection, PropPair, PropRow, Segmented, Select, Switch, TextField, Tooltip } from "../../../tezgah/index.ts";
import { OlcuAlani, RenkAlani } from "./Alanlar.tsx";

export type Commit = (next: TemplateDraft, key?: string) => void;
type Paper = TemplateDraft["paper"];

const SHAPES: readonly PrintSlot["shape"][] = ["circle", "ellipse", "rect"];
const WEIGHTS = ["400", "500", "600", "700", "800", "900"] as const;
/** Açıklama metni ekranda durmaz: ilgili anahtarın ya da alanın ipucunda görünür. */
function Hint({ text, children }: { text: ReactNode; children: ReactNode }) {
  return (
    <Tooltip content={text}>
      <div>{children}</div>
    </Tooltip>
  );
}

const positive = (v: number) => v > 0;
const nonNegative = (v: number) => v >= 0;
const count = (v: number) => v >= 1 && v <= 200;

/** Kağıt seçimi: ön ayarlar ve "Özel ölçü". */
function usePaperOptions() {
  const { t } = useTranslation("printTemplates");
  return [...PAPER_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: "ozel", label: t("paper.custom") }];
}

// ---------------------------------------------------------------- uyarılar (Temel sekmesinin sonunda)

/**
 * Şablon uyarıları: metin sözlükten (`printTemplates:warnings.<messageKey>`), "Seç" uyarılı yuvaları seçer; kayıt
 * işareti çakışmasında önerilen düzeltme ("Kenardan payını 8 mm yap") tek tıkla uygulanır.
 */
export function Uyarilar({ draft, warnings, onSelect, onCommit }: { draft: TemplateDraft; warnings: PrintTemplateWarning[]; onSelect(ids: string[]): void; onCommit: Commit }) {
  const { t } = useTranslation("printTemplates");
  if (!warnings.length) return null;
  const fix = markFixInset(draft);
  return (
    <PanelSection>
      {warnings.map((w) => {
        const hintKey = `printTemplates:warnHint.${w.code}`;
        const markFix = w.code === "mark-overlap" && fix !== null;
        return (
          <IssueBox
            key={w.messageKey ?? w.code}
            tone={w.code === "no-slots" ? "info" : w.code === "slot-in-printer-margin" ? "warn" : "error"}
            fixes={
              w.slotIds.length > 0 || markFix ? (
                <>
                  {w.slotIds.length > 0 && (
                    <Button size="mini" onClick={() => onSelect(w.slotIds)}>
                      {t("warn.select")}
                    </Button>
                  )}
                  {markFix && (
                    <Button size="mini" onClick={() => onCommit({ ...draft, cut: { ...draft.cut, registration: { ...draft.cut.registration, insetMm: fix } } }, "cut:reg:inset")}>
                      {t("warn.fixInset", { mm: formatMm(fix, 2) })}
                    </Button>
                  )}
                </>
              ) : undefined
            }
          >
            {warningText(w)}
            {i18n.exists(hintKey) && <span className="bs-hint">{i18n.t(hintKey)}</span>}
            {w.code === "mark-overlap" && fix === null && <span className="bs-hint">{t("warn.noInset")}</span>}
          </IssueBox>
        );
      })}
    </PanelSection>
  );
}

// ---------------------------------------------------------------- Temel

export interface TemelProps {
  draft: TemplateDraft;
  layout: Layout;
  selected: string[];
  /** Okuma sırası numarası (tuvaldeki numarayla aynı). */
  readingNo: ReadonlyMap<string, number>;
  warnings: PrintTemplateWarning[];
  /** Diziliş ızgaraya dönüşmüyorsa (ör. geçersiz ölçü) hata metni. */
  layoutError: string | null;
  onCommit: Commit;
  onSelect(ids: string[]): void;
  /** Kâğıt değişti (ortalı tutuluyorsa yerleşim yeni kâğıda ortalanır). */
  onPaper(paper: Paper, key: string): void;
  /** Etiket ya da diziliş değişti: yuvalar yeniden dizilir. */
  onLayout(patch: Partial<Layout>, key: string): void;
  onKeepCentered(v: boolean): void;
  /** Yuvasız şablonda dizilişi uygula. */
  onPlace(): void;
  onAdvanced(): void;
}

/** Temel sekme (maket ekran 5): Kâğıt, Etiket, Diziliş, Seçili yuva, uyarılar. */
export function TemelPaneli(p: TemelProps) {
  const { t } = useTranslation("printTemplates");
  const { draft, layout } = p;
  const paperOptions = usePaperOptions();
  const setPaper = (paper: Paper, key: string) => p.onPaper(paper, `paper:${key}`);
  const flowOnly = draft.kind === "sticker" && !!draft.stickerFlow && !draft.slots.length;
  const margins = layoutMargins(draft.slots, draft.paper);
  const n = draft.slots.length || layoutCount(layout);
  const L = (patch: Partial<Layout>, key: string) => p.onLayout(patch, `layout:${key}`);
  return (
    <>
      <PanelSection heading={t("paper.label")}>
        <PropRow label={t("paper.preset")}>
          <Select
            value={paperPresetId(draft.paper)}
            options={paperOptions}
            aria-label={t("paper.preset")}
            onChange={(id) => {
              const x = PAPER_PRESETS.find((y) => y.id === id);
              if (x) setPaper({ wMm: x.wMm, hMm: x.hMm }, "preset");
            }}
          />
        </PropRow>
        <PropRow label={t("paper.orientation")}>
          <Segmented<Orientation>
            value={orientationOf(draft.paper)}
            aria-label={t("paper.orientation")}
            options={[
              { value: "portrait", label: t("paper.portrait") },
              { value: "landscape", label: t("paper.landscape") },
            ]}
            onChange={(o) => setPaper(withOrientation(draft.paper, o), "orientation")}
          />
        </PropRow>
        <PropPair>
          <label>
            {t("paper.width")}
            <OlcuAlani label={t("paper.width")} value={draft.paper.wMm} accept={positive} onChange={(v) => setPaper({ ...draft.paper, wMm: v }, "w")} />
          </label>
          <label>
            {t("paper.height")}
            <OlcuAlani label={t("paper.height")} value={draft.paper.hMm} accept={positive} onChange={(v) => setPaper({ ...draft.paper, hMm: v }, "h")} />
          </label>
        </PropPair>
      </PanelSection>

      {flowOnly ? (
        <PanelSection heading={t("label.heading")}>
          <p className="bs-mut">{t("label.flowOnly")}</p>
          <Button size="mini" variant="link" onClick={p.onAdvanced}>
            {t("label.toAdvanced")}
          </Button>
        </PanelSection>
      ) : (
        <>
          <PanelSection heading={t("label.heading")}>
            <PropRow label={t("label.shape")}>
              <Segmented
                value={layout.shape}
                aria-label={t("label.shape")}
                options={SHAPES.map((s) => ({ value: s, label: t(`shape.${s}`) }))}
                onChange={(v) => L(v === "circle" ? { shape: v, hMm: layout.wMm } : { shape: v }, "shape")}
              />
            </PropRow>
            <PropPair>
              {layout.shape === "circle" ? (
                <label>
                  {t("label.diameter")}
                  <OlcuAlani label={t("label.diameter")} value={layout.wMm} accept={positive} onChange={(v) => L({ wMm: v, hMm: v }, "d")} />
                </label>
              ) : (
                <>
                  <label>
                    {t("label.width")}
                    <OlcuAlani label={t("label.width")} value={layout.wMm} accept={positive} onChange={(v) => L({ wMm: v }, "w")} />
                  </label>
                  <label>
                    {t("label.height")}
                    <OlcuAlani label={t("label.height")} value={layout.hMm} accept={positive} onChange={(v) => L({ hMm: v }, "h")} />
                  </label>
                </>
              )}
              {layout.shape !== "rect" && (
                <label>
                  {t("label.count")}
                  <TextField className="tz-mono" value={formatNumber(n)} readOnly aria-label={t("label.count")} onChange={() => {}} />
                </label>
              )}
            </PropPair>
            {layout.shape === "rect" && (
              <PropPair>
                <label>
                  {t("label.corner")}
                  <OlcuAlani label={t("label.corner")} value={layout.cornerRadiusMm} accept={nonNegative} onChange={(v) => L({ cornerRadiusMm: v }, "corner")} />
                </label>
                <label>
                  {t("label.count")}
                  <TextField className="tz-mono" value={formatNumber(n)} readOnly aria-label={t("label.count")} onChange={() => {}} />
                </label>
              </PropPair>
            )}
          </PanelSection>

          <PanelSection heading={t("layout.heading")}>
            <PropPair>
              <label>
                {t("layout.columns")}
                <OlcuAlani label={t("layout.columns")} value={layout.columns} unit="" digits={0} accept={count} onChange={(v) => L({ columns: Math.round(v) }, "cols")} />
              </label>
              <label>
                {t("layout.rows")}
                <OlcuAlani label={t("layout.rows")} value={layout.rows} unit="" digits={0} accept={count} onChange={(v) => L({ rows: Math.round(v) }, "rows")} />
              </label>
            </PropPair>
            <PropPair>
              <label>
                {t("layout.gapX")}
                <OlcuAlani label={t("layout.gapX")} value={layout.gapXMm} accept={nonNegative} onChange={(v) => L({ gapXMm: v }, "gx")} />
              </label>
              <label>
                {t("layout.gapY")}
                <OlcuAlani label={t("layout.gapY")} value={layout.gapYMm} accept={nonNegative} onChange={(v) => L({ gapYMm: v }, "gy")} />
              </label>
            </PropPair>
            <span className="bs-keep">
              <Switch showLabel checked={layout.center} label={t("layout.keepCentered")} onChange={p.onKeepCentered} />
              <span className="bs-mut">{t("layout.keepCenteredHint")}</span>
            </span>
            {margins && (
              <div className="bs-mgn" role="group" aria-label={t("layout.margins")}>
                {(["left", "right", "top", "bottom"] as const).map((k) => (
                  <span key={k}>
                    {t(`layout.${k}`)}
                    <b className="tz-mono">{formatMm(margins[k], 1)}</b>
                  </span>
                ))}
              </div>
            )}
            {p.layoutError && <IssueBox tone="error">{p.layoutError}</IssueBox>}
            {!draft.slots.length && !p.layoutError && (
              <div className="bs-acts">
                <Button need="edit" icon="grid" onClick={p.onPlace}>
                  {t("layout.place", { count: layoutCount(layout) })}
                </Button>
                <span className="bs-mut">{t("layout.ghost")}</span>
              </div>
            )}
          </PanelSection>
        </>
      )}

      <SeciliYuva draft={draft} selected={p.selected} readingNo={p.readingNo} onCommit={p.onCommit} onSelect={p.onSelect} />

      {p.warnings.length ? (
        <Uyarilar draft={draft} warnings={p.warnings} onSelect={p.onSelect} onCommit={p.onCommit} />
      ) : draft.slots.length ? (
        <PanelSection>
          <span className="bs-ok">
            <Icon name="okc" size={15} />
            {t("warn.ok")}
          </span>
        </PanelSection>
      ) : null}
    </>
  );
}

/** Seçili yuva: merkez X / Y (mm); şekil, ölçü ve döndürme kapalı grupta. Çoklu seçimde ortak değer. */
function SeciliYuva({ draft, selected, readingNo, onCommit, onSelect }: { draft: TemplateDraft; selected: string[]; readingNo: ReadonlyMap<string, number>; onCommit: Commit; onSelect(ids: string[]): void }) {
  const { t } = useTranslation("printTemplates");
  const ids = new Set(selected);
  const sel = draft.slots.filter((s) => ids.has(s.id));
  if (!sel.length) {
    return (
      <PanelSection heading={t("slot.heading")}>
        <p className="bs-mut">{t("slot.none")}</p>
        {draft.slots.length > 0 && (
          <Button size="mini" command="baskiSablon.selectAll" kbd={false} onClick={() => onSelect(draft.slots.map((s) => s.id))}>
            {t("slot.selectAll")}
          </Button>
        )}
      </PanelSection>
    );
  }
  const cv = <K extends keyof PrintSlot>(f: K) => commonValue(sel.map((s) => s[f]));
  const set = (patch: Partial<Omit<PrintSlot, "id">>, key: string) => onCommit({ ...draft, slots: patchSlots(draft.slots, ids, patch) }, `slot:${key}:${selected.join(",")}`);
  const shape = cv("shape");
  const mixed = t("slot.mixed");
  const shapeOptions: { value: string; label: string }[] = [...(shape === null ? [{ value: "", label: mixed }] : []), ...SHAPES.map((s) => ({ value: s, label: t(`shape.${s}`) }))];
  const one = sel.length === 1 ? sel[0]! : null;
  const heading = one ? t("slot.one", { n: readingNo.get(one.id) ?? one.id }) : t("slot.many", { count: sel.length });
  return (
    <>
      <PanelSection heading={heading} aside={sel.length > 1 ? <span className="bs-aside">{t("slot.common")}</span> : undefined}>
        <PropPair>
          <label>
            {t("slot.cx")}
            <OlcuAlani label={t("slot.cx")} value={cv("cx")} placeholder={mixed} onChange={(v) => set({ cx: r2(v) }, "cx")} />
          </label>
          <label>
            {t("slot.cy")}
            <OlcuAlani label={t("slot.cy")} value={cv("cy")} placeholder={mixed} onChange={(v) => set({ cy: r2(v) }, "cy")} />
          </label>
        </PropPair>
        <p className="bs-mut">{t("slot.origin")}</p>
      </PanelSection>
      <CollapsedGroup title={t("slot.more")} summary={shape ? t(`shape.${shape}`) : mixed} persistKey="baski.sablon.yuva">
        <PanelSection>
          <PropRow label={t("slot.shape")}>
            <Select<string> value={shape ?? ""} options={shapeOptions} aria-label={t("slot.shape")} onChange={(v) => v && set({ shape: v as PrintSlot["shape"] }, "shape")} />
          </PropRow>
          <PropPair>
            {shape === "circle" ? (
              <label>
                {t("slot.diameter")}
                <OlcuAlani label={t("slot.diameter")} value={cv("w")} placeholder={mixed} accept={positive} onChange={(v) => set({ w: r2(v) }, "w")} />
              </label>
            ) : (
              <>
                <label>
                  {t("slot.width")}
                  <OlcuAlani label={t("slot.width")} value={cv("w")} placeholder={mixed} accept={positive} onChange={(v) => set({ w: r2(v) }, "w")} />
                </label>
                <label>
                  {t("slot.height")}
                  <OlcuAlani label={t("slot.height")} value={cv("h")} placeholder={mixed} accept={positive} onChange={(v) => set({ h: r2(v) }, "h")} />
                </label>
              </>
            )}
          </PropPair>
          <PropPair>
            <label>
              {t("slot.rotation")}
              <OlcuAlani label={t("slot.rotation")} value={cv("rotation")} unit="°" digits={1} placeholder={mixed} accept={(v) => v >= -360 && v <= 360} onChange={(v) => set({ rotation: v }, "rotation")} />
            </label>
            {shape === "rect" && (
              <label>
                {t("slot.corner")}
                <OlcuAlani label={t("slot.corner")} value={cv("cornerRadius")} placeholder={mixed} accept={nonNegative} onChange={(v) => set({ cornerRadius: v }, "corner")} />
              </label>
            )}
          </PropPair>
        </PanelSection>
      </CollapsedGroup>
    </>
  );
}

// ---------------------------------------------------------------- Gelişmiş

export interface GelismisProps {
  draft: TemplateDraft;
  layout: Layout;
  onCommit: Commit;
  onLayout(patch: Partial<Layout>, key: string): void;
  /** Bütün yerleşimi sol ya da üst kenar payına getir (ortalı tutma kapanır). */
  onMargin(edge: "left" | "top", mm: number): void;
  /** Kâğıda eşit dağıt (kenar payı = aralık). */
  onEven(): void;
  presets: PrintPreset[];
  onPreset(p: PrintPreset): void;
  onSavePreset(): void;
  onDeletePreset(p: PrintPreset): void;
}

/**
 * Gelişmiş sekme (maket ekran 5): seyrek değişen ayarlar kapalı gruplarda, özet sağda. Kesim, kayıt işaretleri,
 * hücre etiketi (etiket sayfası), sticker akışı (sticker sayfası), kenar payları ve adım, kaydırmalı dizilim, hazır
 * ayarlar, kimlikler.
 */
export function GelismisPaneli(p: GelismisProps) {
  const { t } = useTranslation("printTemplates");
  const { draft, layout } = p;
  const c = draft.cut;
  const on = (v: boolean) => (v ? t("adv.on") : t("adv.off"));
  const margins = layoutMargins(draft.slots, draft.paper);
  const st = layout.stagger;
  const L = (patch: Partial<Layout>, key: string) => p.onLayout(patch, `layout:${key}`);
  return (
    <div className="bs-adv">
      <CollapsedGroup title={t("cut.heading")} summary={t("adv.cutSummary", { line: c.outlineVisible ? t("adv.cutLine") : t("adv.cutGuide"), mm: formatMm(c.bleedMm, 2) })} persistKey="baski.sablon.kesim">
        <KesimAyarlari draft={draft} onCommit={p.onCommit} />
      </CollapsedGroup>
      <CollapsedGroup title={t("cut.marks")} summary={on(c.registration.enabled)} persistKey="baski.sablon.kayit">
        <KayitIsaretleri draft={draft} onCommit={p.onCommit} />
      </CollapsedGroup>
      {draft.kind === "label" && (
        <CollapsedGroup title={t("cell.heading")} summary={on(draft.cellLabel.enabledByDefault)} persistKey="baski.sablon.hucre">
          <HucreAyarlari draft={draft} onCommit={p.onCommit} />
        </CollapsedGroup>
      )}
      {draft.kind === "sticker" && (
        <CollapsedGroup title={t("flow.heading")} summary={on(!!draft.stickerFlow)} persistKey="baski.sablon.akis">
          <AkisAyarlari draft={draft} onCommit={p.onCommit} />
        </CollapsedGroup>
      )}
      <CollapsedGroup title={t("adv.margins")} summary={t("adv.printerMargin", { mm: formatMm(PRINTER_MARGIN_MM) })} persistKey="baski.sablon.pay">
        <PanelSection>
          <PropPair>
            <label>
              {t("adv.marginLeft")}
              <OlcuAlani label={t("adv.marginLeft")} value={margins?.left ?? null} disabled={!margins} accept={nonNegative} onChange={(v) => p.onMargin("left", v)} />
            </label>
            <label>
              {t("adv.marginTop")}
              <OlcuAlani label={t("adv.marginTop")} value={margins?.top ?? null} disabled={!margins} accept={nonNegative} onChange={(v) => p.onMargin("top", v)} />
            </label>
          </PropPair>
          <Hint text={t("adv.pitchHint")}>
            <PropPair>
              <label>
                {t("adv.pitchX")}
                <OlcuAlani label={t("adv.pitchX")} value={r2(layout.wMm + layout.gapXMm)} accept={positive} onChange={(v) => L({ gapXMm: gapFromPitch(v, layout.wMm) }, "gx")} />
              </label>
              <label>
                {t("adv.pitchY")}
                <OlcuAlani label={t("adv.pitchY")} value={r2(layout.hMm + layout.gapYMm)} accept={positive} onChange={(v) => L({ gapYMm: gapFromPitch(v, layout.hMm) }, "gy")} />
              </label>
            </PropPair>
          </Hint>
          <div className="bs-acts">
            <Button size="mini" need="edit" onClick={p.onEven}>
              {t("adv.even")}
            </Button>
          </div>
          <p className="bs-mut">{t("cut.printerMargin", { mm: formatMm(PRINTER_MARGIN_MM) })}</p>
        </PanelSection>
      </CollapsedGroup>
      <CollapsedGroup title={t("grid.stagger")} summary={on(st.enabled)} persistKey="baski.sablon.kaydirma">
        <PanelSection>
          <Hint text={t("grid.staggerHint")}>
            <Switch showLabel checked={st.enabled} label={t("grid.stagger")} onChange={(v) => L({ stagger: { ...st, enabled: v, offsetXMm: v ? st.offsetXMm : undefined } }, "stagger")} />
          </Hint>
          {st.enabled && (
            <PropPair>
              <label>
                {t("grid.staggerOffset")}
                <OlcuAlani label={t("grid.staggerOffset")} value={st.offsetXMm ?? null} placeholder={t("grid.halfPitch")} onChange={(v) => L({ stagger: { ...st, offsetXMm: v } }, "stagger:x")} />
              </label>
              <span className="bs-sw">
                <Switch showLabel checked={st.dropLast} label={t("grid.dropLast")} onChange={(v) => L({ stagger: { ...st, dropLast: v } }, "stagger:drop")} />
              </span>
            </PropPair>
          )}
        </PanelSection>
      </CollapsedGroup>
      <CollapsedGroup title={t("grid.presets")} summary={t("adv.presetCount", { count: p.presets.length })} persistKey="baski.sablon.hazir">
        <PanelSection>
          {p.presets.length > 0 && (
            <PropRow label={t("grid.preset")}>
              <Select<string>
                value=""
                aria-label={t("grid.preset")}
                options={[{ value: "", label: t("grid.presetPick") }, ...p.presets.map((x) => ({ value: x.id, label: x.name }))]}
                onChange={(id) => {
                  const x = p.presets.find((y) => y.id === id);
                  if (x) p.onPreset(x);
                }}
              />
            </PropRow>
          )}
          <div className="bs-acts">
            <Button size="mini" onClick={p.onSavePreset}>
              {t("grid.savePreset")}
            </Button>
          </div>
          {p.presets.length > 0 && (
            <ul className="bs-presets">
              {p.presets.map((x) => (
                <li key={x.id}>
                  {x.note ? (
                    <Tooltip content={x.note}>
                      <span>{x.name}</span>
                    </Tooltip>
                  ) : (
                    <span>{x.name}</span>
                  )}
                  <IconButton icon="trash" size={26} label={t("grid.deletePreset", { name: x.name })} onClick={() => p.onDeletePreset(x)} />
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      </CollapsedGroup>
      <CollapsedGroup title={t("adv.ids")} summary={draft.sizeId ? `${t(`kind.${draft.kind}`)} · ${draft.sizeId}` : t(`kind.${draft.kind}`)} persistKey="baski.sablon.kimlik">
        <Kimlikler draft={draft} onCommit={p.onCommit} />
      </CollapsedGroup>
    </div>
  );
}

// ---------------------------------------------------------------- Kesim ve kayıt işaretleri

const REG_KEY: Record<(typeof REGISTRATION_STYLES)[number], string> = { "corners-l": "cut.regCornersL", "corner-square": "cut.regCornerSquare", crosshair: "cut.regCrosshair" };

function KesimAyarlari({ draft, onCommit }: { draft: TemplateDraft; onCommit: Commit }) {
  const { t } = useTranslation("printTemplates");
  const c = draft.cut;
  const set = (patch: Partial<TemplateDraft["cut"]>, key: string) => onCommit({ ...draft, cut: { ...c, ...patch } }, `cut:${key}`);
  return (
    <PanelSection>
      <Hint text={`${c.outlineVisible ? t("cut.outlineOn") : t("cut.outlineOff")} ${t("cut.printerMargin", { mm: formatMm(PRINTER_MARGIN_MM) })}`}>
        <Switch showLabel checked={c.outlineVisible} label={t("cut.outline")} onChange={(v) => set({ outlineVisible: v }, "visible")} />
      </Hint>
      {c.outlineVisible && (
        <PropPair>
          <label>
            {t("cut.color")}
            <RenkAlani label={t("cut.color")} pickerLabel={t("cut.colorPicker")} value={c.outlineColor} onChange={(v) => set({ outlineColor: v }, "color")} />
          </label>
          <label>
            {t("cut.width")}
            <OlcuAlani label={t("cut.width")} value={c.outlineWidthMm} accept={positive} onChange={(v) => set({ outlineWidthMm: v }, "width")} />
          </label>
        </PropPair>
      )}
      <PropPair>
        <Tooltip content={t("cut.bleedHint")}>
          <label>
            {t("cut.bleed")}
            <OlcuAlani label={t("cut.bleed")} value={c.bleedMm} accept={nonNegative} onChange={(v) => set({ bleedMm: v }, "bleed")} />
          </label>
        </Tooltip>
      </PropPair>
      <Hint text={t("cut.fileHint")}>
        <Switch showLabel checked={c.cutFile} label={t("cut.file")} onChange={(v) => set({ cutFile: v }, "file")} />
      </Hint>
    </PanelSection>
  );
}

function KayitIsaretleri({ draft, onCommit }: { draft: TemplateDraft; onCommit: Commit }) {
  const { t } = useTranslation("printTemplates");
  const c = draft.cut;
  const reg = c.registration;
  const setReg = (patch: Partial<typeof reg>, key: string) => onCommit({ ...draft, cut: { ...c, registration: { ...reg, ...patch } } }, `cut:reg:${key}`);
  const near = reg.enabled ? markOverlappingSlots(draft.paper, c, draft.slots) : [];
  const fixInset = near.length ? clearingInset(draft.paper, c, draft.slots) : null;
  return (
    <PanelSection>
      <Hint text={t("cut.marksHint")}>
        <Switch showLabel checked={reg.enabled} label={t("cut.marksOn")} onChange={(v) => setReg({ enabled: v }, "on")} />
      </Hint>
      {reg.enabled && (
        <>
          <PropRow label={t("cut.regStyle")}>
            <Segmented value={reg.style} aria-label={t("cut.regStyle")} options={REGISTRATION_STYLES.map((s) => ({ value: s, label: t(REG_KEY[s]) }))} onChange={(v) => setReg({ style: v }, "style")} />
          </PropRow>
          <div className="bs-tri">
            <label>
              {t("cut.inset")}
              <OlcuAlani label={t("cut.inset")} value={reg.insetMm} accept={nonNegative} onChange={(v) => setReg({ insetMm: v }, "inset")} />
            </label>
            <label>
              {t("cut.size")}
              <OlcuAlani label={t("cut.size")} value={reg.sizeMm} accept={positive} onChange={(v) => setReg({ sizeMm: v }, "size")} />
            </label>
            <label>
              {t("cut.thickness")}
              <OlcuAlani label={t("cut.thickness")} value={reg.thicknessMm} accept={positive} onChange={(v) => setReg({ thicknessMm: v }, "thick")} />
            </label>
          </div>
          {near.length > 0 && (
            <IssueBox
              tone="warn"
              fixes={
                fixInset === null ? undefined : (
                  <Button size="mini" onClick={() => setReg({ insetMm: fixInset }, "inset")}>
                    {t("warn.fixInset", { mm: formatMm(fixInset, 2) })}
                  </Button>
                )
              }
            >
              {t("cut.near", { count: near.length, safe: formatMm(MARK_SAFE_MM) })}
              {fixInset === null && <span className="bs-hint">{t("warn.noInset")}</span>}
            </IssueBox>
          )}
        </>
      )}
    </PanelSection>
  );
}

// ---------------------------------------------------------------- Hücre etiketi

function HucreAyarlari({ draft, onCommit }: { draft: TemplateDraft; onCommit: Commit }) {
  const { t } = useTranslation("printTemplates");
  const c = draft.cellLabel;
  const set = (patch: Partial<TemplateDraft["cellLabel"]>, key: string) => onCommit({ ...draft, cellLabel: { ...c, ...patch } }, `cell:${key}`);
  return (
    <PanelSection>
      <Hint text={t("cell.enabledHint")}>
        <Switch showLabel checked={c.enabledByDefault} label={t("cell.enabled")} onChange={(v) => set({ enabledByDefault: v }, "on")} />
      </Hint>
      <PropRow label={t("cell.font")}>
        <TextField value={c.fontFamily} aria-label={t("cell.font")} onChange={(v) => set({ fontFamily: v }, "font")} />
      </PropRow>
      <PropPair>
        <label>
          {t("cell.weight")}
          <Select value={String(c.fontWeight)} aria-label={t("cell.weight")} options={WEIGHTS.map((w) => ({ value: w, label: w }))} onChange={(v) => set({ fontWeight: Number(v) }, "weight")} />
        </label>
        <label>
          {t("cell.size")}
          <OlcuAlani label={t("cell.size")} value={c.sizePt} unit="pt" digits={1} accept={positive} onChange={(v) => set({ sizePt: v }, "size")} />
        </label>
      </PropPair>
      <PropRow label={t("cell.color")}>
        <RenkAlani label={t("cell.color")} pickerLabel={t("cell.colorPicker")} value={c.color} onChange={(v) => set({ color: v }, "color")} />
      </PropRow>
      <Hint text={t("cell.positionHint")}>
        <PropPair>
          <label>
            {t("cell.dx")}
            <OlcuAlani label={t("cell.dx")} value={c.dxMm} onChange={(v) => set({ dxMm: v }, "dx")} />
          </label>
          <label>
            {t("cell.dy")}
            <OlcuAlani label={t("cell.dy")} value={c.dyMm} onChange={(v) => set({ dyMm: v }, "dy")} />
          </label>
        </PropPair>
      </Hint>
    </PanelSection>
  );
}

// ---------------------------------------------------------------- Sticker akışı

function AkisAyarlari({ draft, onCommit }: { draft: TemplateDraft; onCommit: Commit }) {
  const { t } = useTranslation("printTemplates");
  const flow = draft.stickerFlow;
  const set = (stickerFlow: TemplateDraft["stickerFlow"], key: string) => onCommit({ ...draft, stickerFlow }, `flow:${key}`);
  const setFlow = (patch: Partial<NonNullable<TemplateDraft["stickerFlow"]>>, key: string) => flow && set({ ...flow, ...patch }, key);
  return (
    <PanelSection>
      <Hint text={t("flow.hint")}>
        <Switch showLabel checked={!!flow} label={t("flow.on")} onChange={(v) => set(v ? defaultStickerFlow() : null, "flow")} />
      </Hint>
      {flow && (
        <>
          <PropPair>
            <label>
              {t("flow.top")}
              <OlcuAlani label={t("flow.top")} value={r2(flow.marginTopMm)} accept={nonNegative} onChange={(v) => setFlow({ marginTopMm: v }, "top")} />
            </label>
            <label>
              {t("flow.bottom")}
              <OlcuAlani label={t("flow.bottom")} value={r2(flow.marginBottomMm)} accept={nonNegative} onChange={(v) => setFlow({ marginBottomMm: v }, "bottom")} />
            </label>
          </PropPair>
          <PropPair>
            <label>
              {t("flow.side")}
              <OlcuAlani label={t("flow.side")} value={r2(flow.marginSideMm)} accept={nonNegative} onChange={(v) => setFlow({ marginSideMm: v }, "side")} />
            </label>
            <label>
              {t("flow.gapX")}
              <OlcuAlani label={t("flow.gapX")} value={r2(flow.minGapXMm)} accept={nonNegative} onChange={(v) => setFlow({ minGapXMm: v }, "gapx")} />
            </label>
          </PropPair>
          <PropPair>
            <label>
              {t("flow.row")}
              <OlcuAlani label={t("flow.row")} value={r2(flow.minRowGapMm)} accept={nonNegative} onChange={(v) => setFlow({ minRowGapMm: v }, "row")} />
            </label>
            <label>
              {t("flow.rowLast")}
              <OlcuAlani label={t("flow.rowLast")} value={r2(flow.maxRowGapLastMm)} accept={nonNegative} onChange={(v) => setFlow({ maxRowGapLastMm: v }, "rowlast")} />
            </label>
          </PropPair>
        </>
      )}
    </PanelSection>
  );
}

// ---------------------------------------------------------------- Kimlikler

function Kimlikler({ draft, onCommit }: { draft: TemplateDraft; onCommit: Commit }) {
  const { t } = useTranslation("printTemplates");
  const set = (patch: Partial<TemplateDraft>, key: string) => onCommit({ ...draft, ...patch }, `tpl:${key}`);
  const label = draft.kind === "label";
  return (
    <PanelSection>
      <PropRow label={t("tpl.name")}>
        <TextField value={draft.name} aria-label={t("tpl.name")} onChange={(v) => set({ name: v }, "name")} />
      </PropRow>
      <PropRow label={t("tpl.kind")}>
        <Segmented
          value={draft.kind}
          aria-label={t("tpl.kind")}
          options={[
            { value: "label", label: t("tpl.kindLabel") },
            { value: "sticker", label: t("tpl.kindSticker") },
          ]}
          onChange={(v) => set({ kind: v }, "kind")}
        />
      </PropRow>
      <Hint text={label ? t("tpl.sizeHint") : t("tpl.sheetIdHint")}>
        <PropRow label={label ? t("tpl.size") : t("tpl.sheetId")}>
          <TextField value={draft.sizeId ?? ""} placeholder={t("tpl.sizePlaceholder")} aria-label={label ? t("tpl.size") : t("tpl.sheetId")} onChange={(v) => set({ sizeId: v.trim() || null }, "size")} />
        </PropRow>
      </Hint>
      <PropPair>
        <Tooltip content={t("tpl.labelDiameterHint")}>
          <label>
            {t("tpl.labelDiameter")}
            <OlcuAlani label={t("tpl.labelDiameter")} value={draft.labelDiameterMm} placeholder={t("tpl.labelDiameterAuto")} accept={nonNegative} onChange={(v) => set({ labelDiameterMm: v > 0 ? v : null }, "label")} />
          </label>
        </Tooltip>
      </PropPair>
    </PanelSection>
  );
}
