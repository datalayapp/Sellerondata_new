import { PRINTER_MARGIN_MM, type PrintSlot } from "@tagpress/domain";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { formatMm } from "../../../i18n/bicim.ts";
import { type Pt, type Rect, rectFromPoints } from "../../../tezgah/tuval/canvas-math.ts";
import { boxSelect, clickSelect, pressSelect } from "../mantik/selection.ts";
import { type AlignMode, hitSlot, moveSlots, nextSlotIds, r2, slotBounds, slotFromDrag, slotsInRect } from "../mantik/slot-geometry.ts";
import type { TemplateDraft } from "../mantik/sablon/draft.ts";
import { DRAG_MIN_PX, dragDelta, numbersReadable, SAMPLE_CELL_LABEL, selectionBounds, slotNumberFontMm, type SlotTool } from "../mantik/sablon/editor.ts";
import { ptToMm, registrationMarks, sampleCellLabel } from "../mantik/sablon/marks.ts";
import { commonGaps, type Guide, type GuideLabel, type Measure, SNAP_PX, type SnapItem, snapMove } from "../mantik/sablon/yapisma.ts";
import type { CenterAxes } from "../mantik/sablon/yerlesim.ts";
import {
  Artboard,
  Button,
  CanvasViewport,
  CenterColumn,
  IconButton,
  Menu,
  type MenuItem,
  SelectionBar,
  StatusBar,
  Switch,
  ToolDivider,
  ToolGroup,
  ToolLabel,
  ToolSpacer,
  ToolStrip,
  type View,
  type ViewApi,
  ZoomControl,
} from "../../../tezgah/index.ts";

/** Rayın araçları: yuva araçları ve Kaydır (Boşluk ile de). */
export type Tool = SlotTool | "pan";

export type Arrange = { align: AlignMode } | { distribute: "x" | "y" };

type Mods = { shift: boolean; ctrl: boolean };
type Drag =
  | {
      mode: "move";
      start: Pt;
      ids: Set<string>;
      moved: boolean;
      dx: number;
      dy: number;
      pressed: PrintSlot;
      wasSelected: boolean;
      mods: Mods;
      /** Taşınan seçimin sınır kutusu, yerinde duranlar ve kâğıtta kullanılan aralıklar (sürükleme başında bir kez). */
      box: Rect;
      others: SnapItem[];
      gaps: { x: number[]; y: number[] };
    }
  | { mode: "box"; start: Pt; mods: Mods }
  | { mode: "create"; start: Pt; shape: PrintSlot["shape"] }
  | { mode: "pan"; x: number; y: number; view: View };

/** Kâğıda ortalandıktan sonra kâğıt ortası kılavuzu bu kadar görünür (ms). */
const FLASH_MS = 1100;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface KagitProps {
  api: ViewApi;
  draft: TemplateDraft;
  selected: string[];
  onSelect(ids: string[]): void;
  tool: Tool;
  onTool(t: Tool): void;
  onCommit(next: TemplateDraft, key?: string): void;
  warnIds: ReadonlySet<string>;
  /** Yuvasız şablonda dizilişin önizlemesi (kesikli). */
  ghost: PrintSlot[] | null;
  defaultSize: { w: number; h: number };
  numbers: boolean;
  onNumbers(v: boolean): void;
  /** Okuma sırası numaraları (kılavuz etiketi ve seçim adı da bunu kullanır). */
  readingNo: ReadonlyMap<string, number>;
  /** Kılavuz ve yapışma açık mı (Alt basılıyken geçici olarak kapalı). */
  snap: boolean;
  onSnap(v: boolean): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onArrange(how: Arrange): void;
  /** Ortala: seçim varsa seçim, yoksa bütün yerleşim. */
  onCenter(axes: CenterAxes): void;
  /** Değişince (sayaç) kâğıt ortası kılavuzu kısa süre görünür. */
  centerFlash: number;
  onDuplicate(): void;
  onRemove(): void;
}

/** Yuva şekli (mm; kağıt koordinatı). `grow`: her yönde büyütme (taşma payı). */
function Shape({ s, grow = 0, className, stroke, strokeWidth }: { s: PrintSlot; grow?: number; className: string; stroke?: string; strokeWidth?: number }) {
  const w = s.w + 2 * grow;
  const h = s.h + 2 * grow;
  const transform = s.rotation ? `rotate(${s.rotation} ${s.cx} ${s.cy})` : undefined;
  if (s.shape === "rect") {
    const r = Math.min(r2(s.cornerRadius + grow), w / 2, h / 2);
    return <rect className={className} x={s.cx - w / 2} y={s.cy - h / 2} width={w} height={h} rx={r} ry={r} transform={transform} stroke={stroke} strokeWidth={strokeWidth} />;
  }
  return <ellipse className={className} cx={s.cx} cy={s.cy} rx={w / 2} ry={h / 2} transform={transform} stroke={stroke} strokeWidth={strokeWidth} />;
}

/**
 * Orta sütun: araç şeridi (geri al, ileri al, okuma sırası numaraları, "Kılavuz ve yapışma"), hep görünen Ortala şeridi
 * (seçim yoksa bütün yerleşim: Yatayda, Dikeyde, Kâğıda tam ortala; Hizala; seçim varsa çoğalt, sil), cetvelli tuvalde
 * kağıt ve yuvalar, durum satırı.
 *
 * Tuval: dünya katmanında 1 birim = 1 mm; kağıt tek SVG (görünüm kutusu mm). Sürüklerken seçili yuvalar ayrı bir
 * katmanda SVG dönüşümüyle kayar; kılavuz çizgileri, ölçüler ve konum etiketi ayrı katmanlarda elle çizilir (ekran
 * yeniden çizilmez); bırakınca tek değişiklik. İsabet testi geometriyle (DOM olaylarıyla değil).
 */
export function Kagit(p: KagitProps) {
  const { t } = useTranslation("printTemplates");
  const { api, draft } = p;
  const cv = api.canvas;
  const W = draft.paper.wMm;
  const H = draft.paper.hMm;
  const drag = useRef<Drag | null>(null);
  const moveLayer = useRef<SVGGElement | null>(null);
  const guideLayer = useRef<SVGGElement | null>(null);
  const labelLayer = useRef<HTMLDivElement | null>(null);
  const createRef = useRef<SVGRectElement | null>(null);
  const marqueeRef = useRef<HTMLDivElement | null>(null);

  // Bırakmadan sonra yeni koordinatlar çizilince taşıma katmanının geçici dönüşümü kalkar.
  useLayoutEffect(() => {
    moveLayer.current?.removeAttribute("transform");
  }, [draft.slots]);

  const sel = useMemo(() => new Set(p.selected), [p.selected]);
  const unselected = draft.slots.filter((s) => !sel.has(s.id));
  const selectedSlots = draft.slots.filter((s) => sel.has(s.id));
  const numberFont = useMemo(() => slotNumberFontMm(draft.slots), [draft.slots]);
  const numbersOn = p.numbers && numbersReadable(api.view.zoom, numberFont);
  const marks = useMemo(() => registrationMarks(draft.paper, draft.cut.registration), [draft.paper, draft.cut.registration]);
  const cellPos = useMemo(() => (draft.cellLabel.enabledByDefault && draft.kind !== "sticker" ? sampleCellLabel(draft) : null), [draft]);
  const bounds = selectionBounds(selectedSlots);
  const highlight = bounds ? { x: [bounds.x, bounds.x + bounds.w] as [number, number], y: [bounds.y, bounds.y + bounds.h] as [number, number] } : undefined;
  const slotName = (id: string) => String(p.readingNo.get(id) ?? id);

  // ---------------------------------------------------------------- kılavuzlar (elle çizilir)

  const guideText = (l: GuideLabel) =>
    l.kind === "paperCenter"
      ? t("guide.paperCenter")
      : l.kind === "paperEdge"
        ? t("guide.paperEdge")
        : l.kind === "slot"
          ? t("guide.slot", { n: slotName(l.ref) })
          : l.kind === "gap"
            ? t("guide.gap", { mm: formatMm(l.mm, 1) })
            : t("guide.equal");

  const clearGuides = () => {
    guideLayer.current?.replaceChildren();
    labelLayer.current?.replaceChildren();
  };
  const pill = (x: number, y: number, text: string, tone: "guide" | "pos") => {
    const el = document.createElement("span");
    el.className = `bs-pill is-${tone}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    labelLayer.current?.appendChild(el);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("class", cls);
    l.setAttribute("x1", String(x1));
    l.setAttribute("y1", String(y1));
    l.setAttribute("x2", String(x2));
    l.setAttribute("y2", String(y2));
    guideLayer.current?.appendChild(l);
  };
  const paintGuides = (guides: Guide[], measures: Measure[], pos: (Pt & { at: Pt }) | null) => {
    clearGuides();
    for (const g of guides) {
      if (g.axis === "x") line(g.at, g.from, g.at, g.to, "bs-gl");
      else line(g.from, g.at, g.to, g.at, "bs-gl");
      if (g.axis === "x") pill(g.at, g.from, guideText(g.label), "guide");
      else pill(g.to, g.at, guideText(g.label), "guide");
    }
    for (const m of measures) {
      if (m.edge) continue;
      if (m.axis === "x") line(m.from, m.at, m.to, m.at, "bs-ml");
      else line(m.at, m.from, m.at, m.to, "bs-ml");
      const mid = (m.from + m.to) / 2;
      if (m.axis === "x") pill(mid, m.at, t("guide.mm", { mm: formatMm(m.mm, 1) }), "guide");
      else pill(m.at, mid, t("guide.mm", { mm: formatMm(m.mm, 1) }), "guide");
    }
    // Konum: taşınan yuvanın merkezi (mm), etiketi yuvanın sağ alt köşesinde.
    if (pos) pill(pos.at.x, pos.at.y, t("guide.pos", { x: formatMm(pos.x, 1), y: formatMm(pos.y, 1) }), "pos");
  };

  // Ortaladıktan sonra kâğıt ortası kılavuzu kısa süre görünür.
  useEffect(() => {
    if (!p.centerFlash) return;
    paintGuides(
      [
        { axis: "x", at: W / 2, from: 0, to: H, label: { kind: "paperCenter" } },
        { axis: "y", at: H / 2, from: 0, to: W, label: { kind: "paperCenter" } },
      ],
      [],
      null,
    );
    const id = window.setTimeout(clearGuides, FLASH_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnız sayaç değişince; çizim işlevleri her çizimde yeni
  }, [p.centerFlash]);

  const showMarquee = (r: Rect | null) => {
    const m = marqueeRef.current;
    if (!m) return;
    m.hidden = !r;
    if (r) Object.assign(m.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  };
  const showCreate = (s: Omit<PrintSlot, "id"> | null) => {
    const g = createRef.current;
    if (!g) return;
    g.style.display = s ? "block" : "none";
    if (!s) return;
    g.setAttribute("x", String(s.cx - s.w / 2));
    g.setAttribute("y", String(s.cy - s.h / 2));
    g.setAttribute("width", String(s.w));
    g.setAttribute("height", String(s.h));
    g.setAttribute("rx", s.shape === "rect" ? "0" : String(s.w / 2));
    g.setAttribute("ry", s.shape === "rect" ? "0" : String(s.h / 2));
  };
  const cancel = () => {
    drag.current = null;
    showMarquee(null);
    showCreate(null);
    clearGuides();
    moveLayer.current?.removeAttribute("transform");
  };

  // ---------------------------------------------------------------- fare

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-tz-overlay], button, a, input, select")) return;
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (p.tool === "pan") {
      drag.current = { mode: "pan", x: e.clientX, y: e.clientY, view: cv.get() };
      return;
    }
    const pt = cv.clientToWorld(e.clientX, e.clientY);
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (p.tool !== "select") {
      drag.current = { mode: "create", start: pt, shape: p.tool };
      return;
    }
    const hit = hitSlot(draft.slots, pt);
    if (hit) {
      const next = pressSelect(p.selected, hit.id, mods);
      if (next.join() !== p.selected.join()) p.onSelect(next);
      const ids = new Set(next);
      const moving = draft.slots.filter((s) => ids.has(s.id));
      const others = draft.slots.filter((s) => !ids.has(s.id)).map((s) => ({ id: s.id, r: slotBounds(s) }));
      drag.current = {
        mode: "move",
        start: pt,
        ids,
        moved: false,
        dx: 0,
        dy: 0,
        pressed: hit,
        wasSelected: p.selected.includes(hit.id),
        mods,
        box: selectionBounds(moving) ?? slotBounds(hit),
        others,
        gaps: { x: commonGaps(others, "x"), y: commonGaps(others, "y") },
      };
    } else {
      drag.current = { mode: "box", start: pt, mods };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "pan") {
      cv.set({ ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y });
      return;
    }
    const pt = cv.clientToWorld(e.clientX, e.clientY);
    const zoom = cv.get().zoom;
    if (d.mode === "move") {
      const rx = pt.x - d.start.x;
      const ry = pt.y - d.start.y;
      if (!d.moved && Math.hypot(rx, ry) * zoom < DRAG_MIN_PX) return;
      const m = dragDelta(rx, ry, e.shiftKey);
      // Shift: tek eksen; kilitli eksen yapışmaz. Alt: yapışma geçici olarak kapalı.
      const axes = e.shiftKey ? { x: m.x !== 0, y: m.y !== 0 } : { x: true, y: true };
      const r = snapMove({ moving: d.box, others: d.others, paper: draft.paper, dx: m.x, dy: m.y, tol: SNAP_PX / zoom, snap: p.snap && !e.altKey, axes, gaps: d.gaps });
      d.moved = true;
      d.dx = r.dx;
      d.dy = r.dy;
      moveLayer.current?.setAttribute("transform", `translate(${r.dx} ${r.dy})`);
      const b = slotBounds(d.pressed);
      const pos = { x: r2(d.pressed.cx + r.dx), y: r2(d.pressed.cy + r.dy), at: { x: b.x + b.w + r.dx, y: b.y + b.h + r.dy } };
      paintGuides(r.guides, r.measures, pos);
    } else if (d.mode === "box") {
      const r = rectFromPoints(d.start, pt);
      if (r.w * zoom >= DRAG_MIN_PX || r.h * zoom >= DRAG_MIN_PX) showMarquee(r);
    } else {
      showCreate(slotFromDrag(d.start, pt, d.shape, p.defaultSize, { square: e.shiftKey }));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    clearGuides();
    if (!d || d.mode === "pan") return;
    const pt = cv.clientToWorld(e.clientX, e.clientY);
    const zoom = cv.get().zoom;
    if (d.mode === "move") {
      if (d.moved && (d.dx !== 0 || d.dy !== 0)) {
        p.onCommit({ ...draft, slots: moveSlots(draft.slots, d.ids, d.dx, d.dy) });
        return;
      }
      moveLayer.current?.removeAttribute("transform");
      // Sürüklemeden tıklama: Shift/Ctrl ile seçili olan seçimden çıkar; seçili gruptakine düz tık yalnız onu seçer.
      if ((d.mods.shift || d.mods.ctrl) && d.wasSelected) p.onSelect(clickSelect(p.selected, d.pressed.id, d.mods));
      else if (!d.mods.shift && !d.mods.ctrl && p.selected.length > 1) p.onSelect([d.pressed.id]);
    } else if (d.mode === "box") {
      showMarquee(null);
      const r = rectFromPoints(d.start, pt);
      if (r.w * zoom < DRAG_MIN_PX && r.h * zoom < DRAG_MIN_PX) p.onSelect(clickSelect(p.selected, null, d.mods));
      else p.onSelect(boxSelect(p.selected, slotsInRect(draft.slots, r), d.mods));
    } else {
      showCreate(null);
      const s = slotFromDrag(d.start, pt, d.shape, p.defaultSize, { square: e.shiftKey });
      const id = nextSlotIds(draft.slots, 1)[0]!;
      p.onCommit({ ...draft, slots: [...draft.slots, { ...s, id }] });
      p.onSelect([id]);
      p.onTool("select");
    }
  };

  // ---------------------------------------------------------------- şeritler

  const count = selectedSlots.length;
  const single = count === 1;
  const alignItems: (MenuItem | "sep")[] = [
    { label: single ? t("align.paperLeft") : t("align.left"), icon: "dl", onSelect: () => p.onArrange({ align: "left" }) },
    { label: single ? t("align.paperHcenter") : t("align.hcenter"), icon: "ah", onSelect: () => p.onArrange({ align: "hcenter" }) },
    { label: single ? t("align.paperRight") : t("align.right"), icon: "dr", onSelect: () => p.onArrange({ align: "right" }) },
    { label: single ? t("align.paperTop") : t("align.top"), icon: "dt", onSelect: () => p.onArrange({ align: "top" }) },
    { label: single ? t("align.paperVcenter") : t("align.vcenter"), icon: "av", onSelect: () => p.onArrange({ align: "vcenter" }) },
    { label: single ? t("align.paperBottom") : t("align.bottom"), icon: "db", onSelect: () => p.onArrange({ align: "bottom" }) },
    "sep",
    { label: t("align.distributeX"), icon: "dx", disabled: count < 3, onSelect: () => p.onArrange({ distribute: "x" }) },
    { label: t("align.distributeY"), icon: "dy", disabled: count < 3, onSelect: () => p.onArrange({ distribute: "y" }) },
  ];

  const strip = (
    <ToolStrip label={t("strip.label")}>
      <ToolGroup>
        <IconButton icon="undo" command="baskiSablon.undo" disabled={!p.canUndo} onClick={p.onUndo} />
        <IconButton icon="redo" command="baskiSablon.redo" disabled={!p.canRedo} onClick={p.onRedo} />
      </ToolGroup>
      <ToolDivider />
      <IconButton icon="list" pressed={p.numbers} label={t("strip.numbers")} onClick={() => p.onNumbers(!p.numbers)} />
      <ToolSpacer />
      <span className="bs-snap">
        <Switch showLabel checked={p.snap} label={t("strip.snap")} onChange={p.onSnap} />
      </span>
    </ToolStrip>
  );

  const none = count === 0;
  const empty = !draft.slots.length;
  const selLabel = none ? t("selection.none") : single ? t("selection.one", { n: slotName(selectedSlots[0]!.id) }) : t("selection.count", { count });
  // Ortala şeridi hep görünür: seçim yokken bütün yerleşime uygulanır (temizle düğmesi gizli).
  const selectionBar = (
    <div className={none ? "bs-selbar is-none" : "bs-selbar"}>
      <SelectionBar label={selLabel} onClear={() => p.onSelect([])}>
        <ToolLabel>{t("center.label")}</ToolLabel>
        <Button size="mini" icon="ah" disabled={empty} onClick={() => p.onCenter("x")}>
          {t("center.x")}
        </Button>
        <Button size="mini" icon="av" disabled={empty} onClick={() => p.onCenter("y")}>
          {t("center.y")}
        </Button>
        <Button size="mini" icon="cross" disabled={empty} onClick={() => p.onCenter("xy")}>
          {none ? t("center.allLayout") : t("center.xy")}
        </Button>
        <ToolDivider />
        <Menu
          align="start"
          items={alignItems}
          trigger={(tp) => (
            <Button {...tp} size="mini" icon="dl" chevron disabled={none}>
              {single ? t("align.menuPaper") : t("align.menu")}
            </Button>
          )}
        />
        {!none && (
          <>
            <ToolSpacer />
            <IconButton icon="copy" command="baskiSablon.duplicate" onClick={p.onDuplicate} />
            <IconButton icon="trash" command="baskiSablon.delete" onClick={p.onRemove} />
          </>
        )}
      </SelectionBar>
    </div>
  );

  const status = (
    <StatusBar end={<ZoomControl api={api} presets={["fit", "actual"]} onSelection={() => api.fit(bounds ?? { x: 0, y: 0, w: W, h: H })} />}>
      <span className="tz-mono bs-st-fix">{t("status.paper", { w: formatMm(W), h: formatMm(H), count: draft.slots.length })}</span>
      <span className="tz-mono">{t("status.nudge", { small: formatMm(0.1), big: formatMm(1) })}</span>
    </StatusBar>
  );

  const outline = draft.cut.outlineVisible;
  const bleed = draft.cut.bleedMm;
  const renderSlot = (s: PrintSlot, selected: boolean) => {
    const warn = p.warnIds.has(s.id);
    const no = numbersOn ? p.readingNo.get(s.id) : undefined;
    return (
      <g key={s.id} data-slot={s.id}>
        {bleed > 0 && <Shape s={s} grow={bleed} className="bs-bleed" />}
        {outline ? <Shape s={s} className="bs-cutline" stroke={draft.cut.outlineColor} strokeWidth={draft.cut.outlineWidthMm} /> : <Shape s={s} className="bs-guide" />}
        {(selected || warn) && <Shape s={s} className={selected ? "bs-ring is-sel" : "bs-ring is-warn"} />}
        {no !== undefined && (
          <text className="bs-no" x={s.cx} y={s.cy} fontSize={numberFont} textAnchor="middle" dominantBaseline="central">
            {no}
          </text>
        )}
      </g>
    );
  };

  const cursor = p.tool === "pan" ? "is-pan" : p.tool !== "select" ? "is-draw" : undefined;

  return (
    <CenterColumn strip={strip} selectionBar={selectionBar} status={status}>
      <div
        className={["bs-stage", cursor].filter(Boolean).join(" ")}
        tabIndex={0}
        role="application"
        aria-label={t("canvas.label", { name: draft.name, w: formatMm(W), h: formatMm(H), count: draft.slots.length })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancel}
      >
        <CanvasViewport api={api} rulers highlight={highlight}>
          <Artboard x={0} y={0} w={W} h={H} name={null}>
            <div className="bs-paper" style={{ width: W, height: H }} />
            <svg className="bs-sheet" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
              {W > 2 * PRINTER_MARGIN_MM && H > 2 * PRINTER_MARGIN_MM && (
                <rect className="bs-safe" x={PRINTER_MARGIN_MM} y={PRINTER_MARGIN_MM} width={W - 2 * PRINTER_MARGIN_MM} height={H - 2 * PRINTER_MARGIN_MM} />
              )}
              {marks.length > 0 && (
                <g className="bs-reg" data-layer="registration">
                  {marks.map((m, i) =>
                    m.kind === "rect" ? (
                      <rect key={i} x={m.x} y={m.y} width={m.w} height={m.h} />
                    ) : m.kind === "line" ? (
                      <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} strokeWidth={m.width} />
                    ) : (
                      <circle key={i} cx={m.cx} cy={m.cy} r={m.r} strokeWidth={m.width} />
                    ),
                  )}
                </g>
              )}
              {unselected.map((s) => renderSlot(s, false))}
              <g ref={moveLayer}>{selectedSlots.map((s) => renderSlot(s, true))}</g>
              {cellPos && (
                <text
                  className="bs-cell"
                  x={cellPos.xMm}
                  y={cellPos.yMm}
                  fontSize={ptToMm(draft.cellLabel.sizePt)}
                  fontFamily={draft.cellLabel.fontFamily}
                  fontWeight={draft.cellLabel.fontWeight}
                  fill={draft.cellLabel.color}
                  dominantBaseline="hanging"
                >
                  {SAMPLE_CELL_LABEL}
                </text>
              )}
              {p.ghost?.map((s) => <Shape key={`g${s.id}`} s={s} className="bs-ghost" />)}
              <rect ref={createRef} className="bs-new" style={{ display: "none" }} />
              <g ref={guideLayer} className="bs-guides" data-layer="guides" />
            </svg>
            <div ref={labelLayer} className="bs-pills" aria-hidden="true" />
            <div ref={marqueeRef} className="bs-marq" hidden />
          </Artboard>
        </CanvasViewport>
        {p.tool === "select" && !empty && <span className="bs-cvhint">{t("canvas.hint")}</span>}
      </div>
    </CenterColumn>
  );
}
