import "./kisayollar.ts";
import "./duzelt.css";
import type { VariantEditModel } from "@tagpress/domain";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { alignment, sameAdjust, SCALE_STEP } from "./mantik/adjust-math.ts";
import { fullSummary, STROKE_STEP } from "./mantik/adjust-select.ts";
import { alignEpsilon, fineStep } from "./mantik/adjust-view.ts";
import {
  Button,
  CenterColumn,
  IconButton,
  IssueBox,
  Rail,
  type RailItem,
  StatusBar,
  ToolDivider,
  ToolGroup,
  ToolSpacer,
  ToolStrip,
  Tooltip,
  useCommand,
  useCommands,
  useToast,
  useViewport,
  Workspace,
  ZoomControl,
} from "../../tezgah/index.ts";
import { boxToMm, fitZoomFor, mmPerPx } from "./olcu.ts";
import { OzellikPaneli } from "./OzellikPaneli.tsx";
import { Sahne, type Tool } from "./Sahne.tsx";
import { SatirPaneli } from "./SatirPaneli.tsx";
import { type Duzelt, useDuzelt } from "./useDuzelt.ts";

/**
 * Enter'ın hedefi klavyeyle odaklanmış bir denetimse (düğme, sekme…) tuş onundur. Fareyle tıklanıp odakta kalan
 * düğmede (satır listesi, araç düğmeleri) Enter yine metni düzenler: bugünkü pencerede de fareyle basılan düğmeden
 * sonra Enter düğmeyi tekrarlamıyordu.
 */
const CONTROL = "button, a[href], summary, [role=checkbox], [role=tab], [role=menuitem], [role=option], [role=radio], [role=switch]";
function onKeyboardControl(e: KeyboardEvent): boolean {
  const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(CONTROL);
  if (!el) return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}
/** Okları kendisi kullanan denetimler (ray, sayı adımlayıcı, sekme, açılır kutu). */
const OWN_ARROWS = "[role=spinbutton], [role=toolbar][aria-orientation=vertical], [role=tablist], [role=radiogroup], [role=listbox], [role=menu], select, input, textarea";
const ownsArrows = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.(OWN_ARROWS);
const isField = (el: EventTarget | null) => {
  const h = el as HTMLElement | null;
  return !!h && (h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable);
};

/** Açılamayan düzeltmenin iletisi (sayfa ve pencere). */
export function Hata({ title, body, onBack }: { title: string; body: string; onBack(): void }) {
  const { t } = useTranslation("adjust");
  return (
    <div className="dz-msg">
      <IssueBox
        tone="warn"
        fixes={
          <Button size="mini" onClick={onBack}>
            {t("error.back")}
          </Button>
        }
      >
        <b>{title}</b> {body}
      </IssueBox>
    </div>
  );
}

const RAIL: (RailItem | "divider")[] = [
  { id: "select", icon: "cursor", command: "duzelt.toolSelect" },
  { id: "marquee", icon: "marq", command: "duzelt.toolMarquee" },
  { id: "pan", icon: "hand", command: "canvas.pan" },
  { id: "text", icon: "type", command: "duzelt.editText" },
  "divider",
  { id: "zoom", icon: "zin", command: "duzelt.toolZoom" },
];

export interface DuzeltCalismaProps {
  variantId: string;
  model: VariantEditModel;
  frameMm: number;
  /** Kaydet, Vazgeç ya da düzeltmeyi kaldırdıktan sonra; `saved`: sunucuya yazıldı mı. */
  onLeave(saved: boolean): void;
  /**
   * Büyük pencere: kısayollar alt kip (`modal`) olarak bağlanır (alttaki ekranınkiler kapalı; tuval kısayolları da
   * buradan), Vazgeç / Kaydet özellik panelinde değil pencerenin altında.
   */
  modal?: boolean;
  /** Kısayollar etkin mi (pencerenin üstünde onay açıkken kapalı). */
  active?: boolean;
  /** Çalışma alanını çerçeveye koyar (sayfa: `AppFrame`; pencere: alt şeritle birlikte). */
  wrap(body: ReactNode, d: Duzelt): ReactNode;
}

/**
 * Düzelt'in tam düzenleyicisi (maket 2): ray, solda satırlar, ortada cetvelli tuval, sağda özellik paneli, kısayollar.
 * `#/duzelt` sayfası ve büyük pencere aynı bileşeni kullanır.
 */
export function DuzeltCalisma({ variantId, model, frameMm, onLeave, modal = false, active = true, wrap }: DuzeltCalismaProps) {
  const { t } = useTranslation("adjust");
  const toast = useToast();
  const d = useDuzelt({ variantId, model, onLeave });
  const k = mmPerPx(frameMm, model.framePx);
  const world = useMemo(() => ({ x: 0, y: 0, w: frameMm, h: frameMm }), [frameMm]);
  const api = useViewport({ world });
  const [tool, setTool] = useState<Tool>("select");
  const stageRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const stageFocused = useRef(false);
  const focusStage = () => stageRef.current?.focus({ preventScroll: true });
  const cx = useCommand("duzelt.centerX");
  const cy = useCommand("duzelt.centerY");
  const cb = useCommand("duzelt.centerBoth");

  // Açılınca odak tuvalde: oklar ve kısayollar hemen çalışsın.
  useEffect(() => {
    focusStage();
  }, []);

  const fitZoom = fitZoomFor(frameMm, api.size.w, api.size.h);
  // Ok adımı: sığdırılmışta 1 px, yakınlaştırdıkça incelir (tuval ölçülmeden önce 1 px).
  const step = api.size.w > 0 ? fineStep(api.view.zoom, fitZoom) : 1;
  // Seçimin merkezi hedefe oturmuş mu (eşik yakınlaştırınca küçülür): ortalama düğmeleri basılı, tuvalde kılavuz.
  const goalAligned = alignment(d.selCenter, d.goal, alignEpsilon(api.view.zoom, fitZoom));
  const fitSelection = () => api.fit(boxToMm(d.selBox, k));

  /** Satırın metnini düzenle (sağ paneldeki alan odak alır); satır seçili değilse ipucu. */
  const edit = (i: number | null) => {
    const idx = i ?? (d.layout.lines.length === 1 ? 0 : null);
    if (idx === null) {
      toast({ message: t("text.pickLine") });
      return;
    }
    d.startEdit(idx);
  };

  useCommands(
    "duzelt",
    {
      "duzelt.save": () => void d.save(),
      "duzelt.saveEnter": () => void d.save(),
      "duzelt.cancel": (e) => {
        if (d.editing) {
          d.cancelEdit();
          focusStage();
        } else if (isField(e.target)) {
          (e.target as HTMLElement).blur();
          focusStage();
        } else if (d.sel !== null) d.setSel(null);
        else void d.exit();
      },
      "duzelt.undo": () => d.undo(),
      "duzelt.redo": () => d.redo(),
      "duzelt.reset": () => d.reset(),
      "duzelt.editText": (e) => {
        if (onKeyboardControl(e)) return false; // klavyeyle odaklanmış düğmenin kendi Enter'ı
        edit(d.single);
      },
      "duzelt.centerX": () => d.center("x"),
      "duzelt.centerY": () => d.center("y"),
      "duzelt.centerBoth": () => d.center("both"),
      "duzelt.left": (e) => (ownsArrows(e) ? false : d.nudge(e.key, e.shiftKey, step)),
      "duzelt.right": (e) => (ownsArrows(e) ? false : d.nudge(e.key, e.shiftKey, step)),
      "duzelt.up": (e) => (ownsArrows(e) ? false : d.nudge(e.key, e.shiftKey, step)),
      "duzelt.down": (e) => (ownsArrows(e) ? false : d.nudge(e.key, e.shiftKey, step)),
      "duzelt.scaleDown": () => d.scale(-SCALE_STEP),
      "duzelt.scaleUp": () => d.scale(SCALE_STEP),
      "duzelt.strokeDown": () => d.stroke(-STROKE_STEP),
      "duzelt.strokeUp": () => d.stroke(STROKE_STEP),
      // Tab yalnız odak tuvaldeyken satırlarda gezer; başka yerde odağı taşır.
      "duzelt.nextLine": () => (stageFocused.current ? d.cycle(false) : false),
      "duzelt.prevLine": () => (stageFocused.current ? d.cycle(true) : false),
      "duzelt.selectAll": () => d.setSel(null),
      // Pencerede alt kip açıkken `tuval` kapsamı (yakınlaştırma çubuğunun kaydı) çalışmaz: aynı işler buradan.
      ...(modal
        ? {
            "canvas.zoomIn": () => api.zoomIn(),
            "canvas.zoomOut": () => api.zoomOut(),
            "canvas.fit": () => api.fit(),
            "canvas.actual": () => api.actual(),
            "canvas.selection": () => fitSelection(),
          }
        : {}),
    },
    { modal, enabled: active },
  );

  const pickTool = (id: string) => {
    const next = id as Tool;
    setTool(next);
    if (next === "text" && d.single !== null) d.startEdit(d.single);
  };

  const strip = (
    <ToolStrip label={t("strip.label")}>
      <ToolGroup>
        <IconButton icon="undo" command="duzelt.undo" disabled={!d.canUndo} onClick={d.undo} />
        <IconButton icon="redo" command="duzelt.redo" disabled={!d.canRedo} onClick={d.redo} />
        <IconButton icon="reset" command="duzelt.reset" disabled={sameAdjust(d.cur, null)} onClick={d.reset} />
      </ToolGroup>
      <ToolDivider />
      {/* Maket .tb: H ve V çerçevesiz; basılıyken yalnız açık mor zemin (çerçeve yok, duzelt.css .dz-center). */}
      <span className="dz-center">
        <Button variant="quiet" icon="ah" command="duzelt.centerX" aria-pressed={goalAligned.x} onClick={() => d.center("x")}>
          <span className="tz-sr">{cx.label}</span>
        </Button>
        <Button variant="quiet" icon="av" command="duzelt.centerY" aria-pressed={goalAligned.y} onClick={() => d.center("y")}>
          <span className="tz-sr">{cy.label}</span>
        </Button>
        <Button variant="quiet" icon="cross" command="duzelt.centerBoth" aria-pressed={goalAligned.x && goalAligned.y} onClick={() => d.center("both")}>
          <span className="tz-sr">{cb.label}</span>
        </Button>
      </span>
      <ToolSpacer />
    </ToolStrip>
  );

  const status = (
    <StatusBar end={<ZoomControl api={api} presets={["fit", "actual", "selection"]} labels={{ actual: t("zoom.actual") }} onSelection={fitSelection} />}>
      <Tooltip content={fullSummary(d.cur)}>
        <span className="dz-sb-sum">{fullSummary(d.cur)}</span>
      </Tooltip>
      <span className="dz-sb-k">{t("status.step", { v: formatNumber(step) })}</span>
    </StatusBar>
  );

  return wrap(
    <Workspace
      rail={<Rail label={t("rail.label")} items={RAIL} value={tool} onChange={pickTool} />}
      left={<SatirPaneli d={d} />}
      leftWidth={240}
      right={<OzellikPaneli d={d} editorRef={editorRef} onStage={focusStage} footer={!modal} />}
      rightWidth={300}
    >
      <CenterColumn strip={strip} status={status}>
        <Sahne
          d={d}
          api={api}
          k={k}
          frameMm={frameMm}
          tool={tool}
          aligned={goalAligned}
          stageRef={stageRef}
          onEdit={edit}
          onStageFocus={(v) => {
            stageFocused.current = v;
          }}
        />
      </CenterColumn>
    </Workspace>,
    d,
  );
}
