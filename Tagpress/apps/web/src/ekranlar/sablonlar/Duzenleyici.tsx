import type { Point, Shape } from "@tagpress/domain";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import {
  addVertexStep,
  areaForMode,
  deleteStep,
  type EditorCtx,
  enterStep,
  escapeStep,
  type Interaction,
  keysActive,
  nudgeStep,
  onToolChange,
  removeVertexStep,
  roundTarget,
  type Step,
  type Tool,
  validVertex,
} from "./mantik/editor.ts";
import { areaCenter, cropBox, nudgeStep as pxStep } from "./mantik/shapeMath.ts";
import {
  Button,
  CenterColumn,
  Checkbox,
  EmptyState,
  Icon,
  Popover,
  Rail,
  type RailItem,
  type Rect,
  StatusBar,
  Switch,
  ToolLabel,
  ToolSpacer,
  ToolStrip,
  useCommands,
  useLeaveGuard,
  useViewport,
  type ViewApi,
  Workspace,
  ZoomControl,
} from "../../tezgah/index.ts";
import { Dene } from "./Dene.tsx";
import { LAYER_IDS, type Layers, type RailTool, SablonTuvali } from "./SablonTuvali.tsx";
import { SagPanel } from "./SagPanel.tsx";
import { useSablon } from "./useSablon.ts";

const RAIL: (RailItem | "divider")[] = [
  { id: "select", icon: "cursor", command: "sablonlar.toolSelect" },
  { id: "ellipse", icon: "ellipse", command: "sablonlar.toolEllipse" },
  { id: "rect", icon: "rect", command: "sablonlar.toolRect" },
  { id: "polygon", icon: "node", command: "sablonlar.toolPolygon" },
  "divider",
  { id: "pan", icon: "hand", command: "canvas.pan" },
];

/** Okları kendisi kullanan denetimler (ray, sayı adımlayıcı, sekme, açılır kutu, yazı alanı). */
const OWN_ARROWS = "[role=spinbutton], [role=toolbar][aria-orientation=vertical], [role=tablist], [role=radiogroup], [role=listbox], [role=menu], select, input, textarea";
const ownsArrows = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.(OWN_ARROWS);

/**
 * Şablon düzenleyici (maket 1): rayda araçlar, solda kütüphane, ortada cetvelli tuvalde şablon görseli + yazı alanı +
 * kesim çizgisi (mm), altta "Bu şablonla dene", sağda alanın ayarları. Kaydedilmemiş değişiklikte ayrılmak onay ister.
 */
export function Duzenleyici({
  lang,
  templateKey,
  left,
  frame,
  onNotFound,
}: {
  lang: string;
  templateKey: string;
  left: ReactNode;
  /** İş satırını ve çerçeveyi ekran kurar; düzenleyici kirli durumu ve başlığı verir. */
  frame(body: ReactNode, info: { title: string | null; dirty: boolean; labels: string[] }): ReactNode;
  onNotFound(): void;
}) {
  const { t } = useTranslation("templates");
  const s = useSablon(lang, templateKey);
  useLeaveGuard(s.dirty, { body: t("leave.body", { fields: s.labels.join(", ") }) });

  if (s.tq.isError || (!s.tq.isLoading && !s.item)) {
    return frame(
      <Workspace left={left} leftWidth={280}>
        <CenterColumn>
          <EmptyState
            icon="img"
            title={t("editor.notFound", { key: templateKey })}
            body={t("editor.notFoundBody")}
            action={
              <Button variant="secondary" icon="left" onClick={onNotFound}>
                {t("editor.backToLibrary")}
              </Button>
            }
          />
        </CenterColumn>
      </Workspace>,
      { title: null, dirty: false, labels: [] },
    );
  }
  if (s.tq.isPending || s.pq.isPending || !s.item) {
    return frame(
      <Workspace left={left} leftWidth={280}>
        <CenterColumn>
          <div className="sb-wait" aria-busy="true" />
        </CenterColumn>
      </Workspace>,
      { title: null, dirty: false, labels: [] },
    );
  }
  return <Masa s={s} lang={lang} templateKey={templateKey} left={left} frame={frame} />;
}

function Masa({ s, lang, templateKey, left, frame }: { s: ReturnType<typeof useSablon>; lang: string; templateKey: string; left: ReactNode; frame: Parameters<typeof Duzenleyici>[0]["frame"] }) {
  const { t } = useTranslation("templates");
  const { eff, scale } = s;
  const world = useMemo(() => ({ x: 0, y: 0, w: scale.frameMm, h: scale.frameMm }), [scale.frameMm]);
  const api = useViewport({ world });
  const [tool, setTool] = useState<RailTool>("select");
  const [it, setIt] = useState<Interaction | null>(null);
  const [selRaw, setSel] = useState<number | null>(null);
  const [layers, setLayers] = useState<Layers>({ area: true, decoration: true, ribbon: true, target: true, cut: true, server: false });
  const [toTarget, setToTarget] = useState(false);
  const lastManual = useRef<Shape | null>(null);
  const zoomId = useId();

  const manual = eff.area.mode === "manual";
  const area = eff.area.mode === "manual" ? eff.area.shape : null;
  if (area) lastManual.current = area;
  const selVertex = validVertex(area, selRaw);
  const editTool: Tool = tool === "pan" ? "select" : tool;
  const ctx: EditorCtx = { manual, tool: editTool, area, targetLayer: layers.target, it, selVertex };
  const fallback = areaCenter(area, s.cutRatio);
  const overlayStatus = useImageStatus(s.overlayUrl, layers.server);

  const setArea = (shape: Shape, merge: string | null = null) => {
    s.setGhost(null);
    s.set("area", { mode: "manual", shape }, merge);
  };
  const setTarget = (p: Point, merge: string | null = null) => s.set("textCenter", roundTarget(p), merge);
  const pick = (next: RailTool) => {
    setIt((cur) => onToolChange(cur));
    if (next !== "pan" && next !== "select" && !manual) switchMode("manual");
    setTool(next);
  };
  const switchMode = (mode: "auto" | "manual") => {
    s.setGhost(null);
    setTool("select");
    setIt(null);
    s.set("area", areaForMode(mode, lastManual.current, s.cutRatio));
  };
  const apply = (step: Step | null, merge: string | null) => {
    if (!step) return;
    if ("it" in step) setIt(step.it ?? null);
    if ("selVertex" in step) setSel(step.selVertex ?? null);
    if (step.area) setArea(step.area, merge);
    if (step.target) setTarget(step.target, merge);
    if (step.tool) setTool(step.tool);
  };

  // Sığdır, alttaki yüzen deneme kutusunun (CanvasDock) üstünde kalır: etiketin altı kutunun altında kalmasın.
  const fitAbove = (r: Rect = world) => api.fit(aboveDock(api, r));
  const zoomApi = useMemo<ViewApi>(() => ({ ...api, fit: (r) => api.fit(aboveDock(api, r ?? world)) }), [api, world]);

  // Hedefe yakınlaş: hedef merkezin çevresi (tasarım alanının yarısı) sığdırılır; kapanınca bütün alan.
  const target = eff.textCenter ?? fallback;
  const fitTarget = (on: boolean) => {
    setToTarget(on);
    if (!on) return fitAbove();
    const b = cropBox({ x: target.x * scale.frameMm, y: target.y * scale.frameMm }, scale.frameMm / 2, scale.frameMm);
    fitAbove(b);
  };
  // Kesim değişince tasarım alanının ölçüsü değişir: bütün alanı sığdır. Tuval ilk kez boyut alınca da (ilk
  // sığdırma kutuyu bilmez) bir kez daha, kutunun üstüne sığdırılır.
  const sized = api.size.w > 0 && api.size.h > 0;
  useEffect(() => {
    if (!toTarget) fitAbove();
  }, [scale.frameMm, sized]); // eslint-disable-line react-hooks/exhaustive-deps -- yalnız kesim ölçüsü değişince ya da tuval ilk boyutunu alınca sığdırılır; fitAbove her çizimde yeni, toTarget eklenirse seçim her değişimde sıfırlanır

  const step = pxStep(scale.framePx, false);
  const keys = keysActive(ctx);
  useCommands("sablonlar", {
    "sablonlar.toolSelect": () => pick("select"),
    "sablonlar.toolEllipse": () => pick("ellipse"),
    "sablonlar.toolRect": () => pick("rect"),
    "sablonlar.toolPolygon": () => pick("polygon"),
    "sablonlar.cancel": () => (keys ? apply(escapeStep(ctx), null) : false),
    "sablonlar.finish": () => {
      const st = enterStep(ctx);
      if (!st) return false;
      apply(st, null);
    },
    "sablonlar.deleteVertex": () => {
      const st = keys ? deleteStep(ctx) : null;
      if (!st) return false;
      apply(st, null);
    },
    "sablonlar.left": (e) => nudge(e, -1, 0),
    "sablonlar.right": (e) => nudge(e, 1, 0),
    "sablonlar.up": (e) => nudge(e, 0, -1),
    "sablonlar.down": (e) => nudge(e, 0, 1),
    "sablonlar.save": () => void s.doSave(),
    "sablonlar.undo": () => (s.canUndo ? s.undo() : false),
  });
  function nudge(e: KeyboardEvent, dx: number, dy: number) {
    if (ownsArrows(e) || !keys) return false;
    const st = nudgeStep(ctx, dx, dy, e.shiftKey ? step * 10 : step);
    if (!st) return false;
    apply(st, "nudge");
  }

  // Seçili yazı alanının mm sınırları cetvelde açık mor bant olur.
  const highlight = useMemo(() => {
    if (!area) return undefined;
    const b = areaBounds(area);
    return { x: [b.x0 * scale.frameMm, b.x1 * scale.frameMm] as [number, number], y: [b.y0 * scale.frameMm, b.y1 * scale.frameMm] as [number, number] };
  }, [area, scale.frameMm]);

  const areaName = area ?t(`status.shapes.${area.kind}`) : null;
  const strip = (
    <ToolStrip label={t("strip.label")}>
      <Popover
        align="start"
        width={260}
        trigger={(p) => (
          <Button {...p} size="mini" icon="eye" chevron>
            {t("layers.title")}
          </Button>
        )}
      >
        {() => (
          <div className="sb-layers" role="group" aria-label={t("layers.title")}>
            {LAYER_IDS.map((id) => (
              <div key={id} className="sb-layer">
                <Checkbox checked={layers[id]} label={t(`layers.${id}`)} onChange={(v) => setLayers((l) => ({ ...l, [id]: v }))} />
                <span>
                  {t(`layers.${id}`)}
                  {(id === "decoration" || id === "server") && <small>{t(`layers.${id}Hint`)}</small>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Popover>
      <ToolLabel>{manual && tool !== "select" && tool !== "pan" ? t(`tools.hint.${tool}`) : LAYER_IDS.filter((id) => layers[id]).map((id) => t(`layers.${id}`).toLocaleLowerCase()).join(", ")}</ToolLabel>
      <ToolSpacer />
      <span className="sb-row">
        <Switch id={zoomId} checked={toTarget} label={t("strip.zoomTarget")} onChange={fitTarget} />
        <label htmlFor={zoomId} className="sb-strip-l">
          {t("strip.zoomTarget")}
        </label>
      </span>
    </ToolStrip>
  );

  const status = (
    <StatusBar end={<ZoomControl api={zoomApi} presets={["fit", "actual"]} />}>
      <span className="sb-st">{area ? t("status.areaManual", { shape: areaName }) : t("status.areaAuto")}</span>
      <span className="sb-st">{t("status.ribbon", { pct: formatNumber(Math.round(eff.ribbonTop * 100)) })}</span>
    </StatusBar>
  );

  const notes = (
    <>
      {layers.server && overlayStatus === "error" && (
        <div className="sb-ov-note">
          <Icon name="warn" size={15} />
          {t("layers.serverFailed")}
        </div>
      )}
      {layers.server && overlayStatus === "ok" && s.dirty && (
        <div className="sb-ov-note">
          <Icon name="info" size={15} />
          {t("layers.serverStale")}
        </div>
      )}
    </>
  );

  return frame(
    <Workspace rail={<Rail label={t("rail.label")} items={RAIL} value={tool} onChange={(id) => pick(id as RailTool)} />} left={left} leftWidth={280} right={
      <SagPanel
        s={s}
        templateKey={templateKey}
        area={area}
        selVertex={selVertex}
        onMode={switchMode}
        onArea={(shape) => setArea(shape)}
        onAddVertex={() => apply(addVertexStep(area), null)}
        onRemoveVertex={() => apply(removeVertexStep(area, selVertex), null)}
      />
    } rightWidth={310}>
      <CenterColumn strip={strip} status={status}>
        <SablonTuvali
          api={api}
          scale={scale}
          ctx={ctx}
          tool={tool}
          apply={apply}
          layers={layers}
          imageUrl={s.imageUrl}
          overlayUrl={overlayStatus === "ok" ? s.overlayUrl : null}
          ghost={s.ghost}
          ribbonTop={eff.ribbonTop}
          target={eff.textCenter}
          targetFallback={fallback}
          decor={s.decor}
          highlight={highlight}
          overlay={
            <>
              {notes}
              <Dene languageId={lang} templateKey={templateKey} patch={s.patch} />
            </>
          }
        />
      </CenterColumn>
    </Workspace>,
    { title: templateKey, dirty: s.dirty, labels: s.labels },
  );
}

/** Alan şeklinin sınır kutusu (oran, 0–1). */
function areaBounds(s: Shape): { x0: number; y0: number; x1: number; y1: number } {
  switch (s.kind) {
    case "rect":
      return { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h };
    case "circle":
      return { x0: s.cx - s.r, y0: s.cy - s.r, x1: s.cx + s.r, y1: s.cy + s.r };
    case "ellipse":
      return { x0: s.cx - s.rx, y0: s.cy - s.ry, x1: s.cx + s.rx, y1: s.cy + s.ry };
    default: {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
  }
}

/** `useViewport`'un varsayılan kenar payı (px). */
const FIT_PAD = 40;
/** Etiketin altıyla deneme kutusunun üstü arasındaki boşluk (px). */
const DOCK_GAP = 16;

/**
 * Sığdırılacak dikdörtgen, alttaki yüzen kutunun yüksekliği kadar aşağı uzatılır: ortalanan dikdörtgenin üst kısmında
 * `r` durur, kutu uzatılan payın üstüne biner. Kutu yoksa ya da ölçülemiyorsa `r` olduğu gibi döner.
 */
function aboveDock(api: ViewApi, r: Rect): Rect {
  const box = api.canvas.containerRef.current;
  const dock = box?.querySelector<HTMLElement>(".tz-dock");
  if (!box || !dock) return r;
  const reserve = box.getBoundingClientRect().bottom - dock.getBoundingClientRect().top + DOCK_GAP - FIT_PAD;
  const { w, h } = api.canvas.size();
  if (reserve <= 0 || !w || !h || r.w <= 0 || r.h <= 0) return r;
  const zoom = Math.min(Math.max(1, w - 2 * FIT_PAD) / r.w, Math.max(1, h - 2 * FIT_PAD - reserve) / r.h);
  return { ...r, h: r.h + reserve / zoom };
}

/** Sunucu bindirmesi görseli yüklenebildi mi (katman açıkken bakılır). */
function useImageStatus(url: string | null, enabled: boolean): "idle" | "loading" | "ok" | "error" {
  const [state, setState] = useState<{ url: string; s: "loading" | "ok" | "error" } | null>(null);
  useEffect(() => {
    if (!enabled || !url || typeof Image === "undefined") return;
    let dead = false;
    setState({ url, s: "loading" });
    const img = new Image();
    img.onload = () => !dead && setState({ url, s: "ok" });
    img.onerror = () => !dead && setState({ url, s: "error" });
    img.src = url;
    return () => {
      dead = true;
    };
  }, [url, enabled]);
  if (!enabled || !url || !state || state.url !== url) return enabled && url ? "loading" : "idle";
  return state.s;
}
