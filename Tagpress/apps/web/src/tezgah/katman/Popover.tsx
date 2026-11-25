import {
  cloneElement,
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx.ts";
import { Icon, type IconName } from "../ikon/Icon.tsx";
import { type CommandId, useCommand } from "../kisayol/kayit.ts";
import { focusables, insideLayer, isTopLayer, lastInputWasKeyboard, portalHost, pushLayer, trackInputModality, useAnchoredPosition } from "./ortak.ts";
import "./katman.css";

/** Tetikleyiciye verilecek öznitelikler: `<button {...p}>`. */
export interface TriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu" | "dialog";
  "aria-controls": string | undefined;
}

export interface PopoverProps {
  trigger(p: TriggerProps, open: boolean): ReactNode;
  align?: "start" | "end";
  /** Panel genişliği (px); verilmezse içeriğe göre. */
  width?: number;
  open?: boolean;
  onOpenChange?(o: boolean): void;
  children(close: () => void): ReactNode;
  /** İçerik menüyse "menu" (Menu bileşeni verir). */
  role?: "dialog" | "menu";
}

/**
 * Açılır katman. Ekrana göre sabit konumlanır (taşan kaydırma alanında kesilmez): altta yer yoksa üste çevrilir,
 * yatayda tetikleyiciye hizalanır, pencere kenarından 8 px içeride kalır. Tetikleyici açık bir pencerenin
 * (`<dialog>`) içindeyse panel o pencerenin içine konur (üst katmanda kalır, pencerenin odak tuzağına girer).
 *
 * Kapanış: Esc (yalnız en üstteki katman; odak tetikleyiciye döner), dışa tıklama (odak tıklanan yerde kalır),
 * ilk/son öğeden Tab (odak tetikleyiciye). Açılınca odak paneldeki ilk öğeye gider. Açıkken ekran kısayolları
 * çalışmaz (`data-tz-layer`).
 */
export function Popover({ trigger, align = "start", width, open: controlled, onOpenChange, children, role = "dialog" }: PopoverProps) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const changeRef = useRef(onOpenChange);
  changeRef.current = onOpenChange;
  const setOpen = useCallback((v: boolean) => {
    setInner(v);
    changeRef.current?.(v);
  }, []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const id = useId();

  const close = useCallback(
    (focusTrigger = true) => {
      setOpen(false);
      if (focusTrigger) triggerRef.current?.focus({ preventScroll: true });
    },
    [setOpen],
  );
  const closeAndFocus = useCallback(() => close(true), [close]);

  // Portal hedefi açılış anında, tetikleyicinin yerine göre.
  useLayoutEffect(() => {
    setHost(open ? portalHost(triggerRef.current) : null);
  }, [open]);

  useAnchoredPosition(open, triggerRef, panelRef, { side: "bottom", align }, host);

  // Katman yığını, Esc, dışa tıklama. `useLayoutEffect`: panel, odak ona geçmeden (aşağıdaki odak etkisi) yığına
  // girmeli; yoksa içinde açılan ikinci panele geçen odak dıştakinin `onBlur`'unda "dışarı gitti" sayılır ve dıştaki kapanır.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !host || !panel) return;
    const drop = pushLayer(panel);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (insideLayer(panel, t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isTopLayer(panel)) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      drop();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, host, close]);

  // Açılınca odak panele.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !host || !panel) return;
    const first = panel.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)") ?? focusables(panel)[0] ?? panel;
    first.focus({ preventScroll: true });
  }, [open, host]);

  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || e.defaultPrevented) return;
    const list = focusables(e.currentTarget);
    const at = document.activeElement;
    const edge = list.length === 0 || (e.shiftKey ? at === list[0] || at === e.currentTarget : at === list[list.length - 1]);
    if (!edge) return;
    e.preventDefault();
    close(true);
  };

  return (
    <>
      {trigger({ ref: triggerRef, onClick: () => setOpen(!open), "aria-expanded": open, "aria-haspopup": role, "aria-controls": open ? id : undefined }, open)}
      {open &&
        host &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role={role === "menu" ? undefined : "dialog"}
            className={cx("tz-pop", role === "menu" && "tz-pop--menu")}
            style={{ width }}
            tabIndex={-1}
            data-tz-layer=""
            onKeyDown={onPanelKey}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (next && !insideLayer(e.currentTarget, next) && !triggerRef.current?.contains(next)) close(false);
            }}
          >
            {children(closeAndFocus)}
          </div>,
          host,
        )}
    </>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  command?: CommandId;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

function MenuRow({ item, close }: { item: MenuItem; close: () => void }) {
  const c = useCommand(item.command ?? "");
  const keys = item.command ? c.keysText : "";
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cx("tz-menu-i", item.danger && "is-danger")}
      disabled={item.disabled}
      aria-keyshortcuts={item.command ? c.ariaKeyShortcuts || undefined : undefined}
      onClick={() => {
        close();
        item.onSelect();
      }}
    >
      {item.icon ? <Icon name={item.icon} size={15} /> : <span className="tz-menu-sp" />}
      <span className="tz-menu-l">{item.label}</span>
      {keys && <span className="tz-menu-k">{keys}</span>}
    </button>
  );
}

/** Eylem menüsü (⋯). Oklar, Home/End ile gezilir; Enter/Boşluk seçer; Esc ve Tab kapatır, odak tetikleyiciye döner. */
export function Menu({ trigger, items, align = "end" }: { trigger(p: TriggerProps): ReactNode; items: (MenuItem | "sep")[]; align?: "start" | "end" }) {
  return (
    <Popover trigger={(p) => trigger(p)} align={align} role="menu">
      {(close) => (
        <div
          role="menu"
          className="tz-menu"
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              close();
              return;
            }
            const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
            if (!list.length) return;
            const i = list.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              e.key === "ArrowDown" ? (i + 1) % list.length : e.key === "ArrowUp" ? (i - 1 + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
            if (next < 0) return;
            e.preventDefault();
            list[next]?.focus();
          }}
        >
          {items.map((it, i) => (it === "sep" ? <hr key={`s${i}`} className="tz-menu-sep" /> : <MenuRow key={`${it.label}${i}`} item={it} close={close} />))}
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------- ipucu

/** Üzerine gelince bekleme (ms). Bir ipucu az önce açıksa sonraki gecikmesiz açılır (araç şeridinde gezinirken). */
const HOVER_DELAY = 500;
const FOCUS_DELAY = 150;
const WARM_MS = 400;
const HIDE_GRACE = 120;
let lastHidden = 0;

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (el: T | null) => {
    for (const r of refs) {
      if (typeof r === "function") r(el);
      else if (r) (r as RefObject<T | null>).current = el;
    }
  };
}

type ChildProps = Record<string, unknown> & { ref?: Ref<HTMLElement> };

/** İç içe ipucu olmasın: `Tooltip` içindeki `Button`/`IconButton` kendi ipucunu açmaz. */
const TooltipScope = createContext(false);

/**
 * İpucu: tarayıcının `title`'ı yerine gerçek ipucu (koyu kutu, üstte; yer yoksa altta). Üzerine gelince 500 ms sonra,
 * klavye odağında hemen sonra görünür; Esc, dışarı çıkma ve odak kaybı kapatır; imleç ipucunun üstüne geçebilir.
 * `command` verilirse ad + kısayol ("Sığdır · Shift 1"); `content` verilirse o (komutla birlikte: içerik + kısayol).
 * Çocuğun `title`'ı bastırılır (çift ipucu olmasın). `Button`, `IconButton`, `BandButton` ve ray düğmesi ipucunu
 * kendisi taşır; bu bileşen başka öğeler içindir (iç içe verilirse dıştaki geçerli olur).
 *
 * Çocuk `display: contents` bir `<span>` ile sarılır (yerleşimi değiştirmez); çocuk devre dışıyken (`disabled`) bu
 * sarmalayıcı kutu olur ve fareyi o yakalar: pasif düğmede de ipucu görünür.
 */
export function Tooltip({ content, command, children }: { content?: ReactNode; command?: CommandId; children: ReactElement<Record<string, unknown>> }) {
  const nested = useContext(TooltipScope);
  const c = useCommand(command ?? "");
  const props = children.props as ChildProps;
  const ownTitle = typeof props.title === "string" && props.title ? props.title : undefined;
  const label: ReactNode = content ?? (command ? c.label : ownTitle);
  const keys = command ? c.keysText : "";
  const disabled = props.disabled === true;
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const childRef = useRef<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const anchorRef = useRef<Element | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const id = useId();

  useEffect(() => trackInputModality(), []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = useCallback((delay: number) => {
    window.clearTimeout(timer.current);
    const d = Date.now() - lastHidden < WARM_MS ? 0 : delay;
    const go = () => {
      anchorRef.current = disabledRef.current ? wrapRef.current : childRef.current;
      setHost(portalHost(anchorRef.current));
      setOpen(true);
    };
    if (d === 0) go();
    else timer.current = window.setTimeout(go, d);
  }, []);
  const hide = useCallback((grace = 0) => {
    window.clearTimeout(timer.current);
    const go = () => {
      setOpen((o) => {
        if (o) lastHidden = Date.now();
        return false;
      });
    };
    if (grace) timer.current = window.setTimeout(go, grace);
    else go();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, hide]);

  // Düğme açıkken devre dışı kalırsa ipucu kapanır (odak gider, ayrılma olayı gelmez).
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (disabled && !wasDisabled.current) hide();
    wasDisabled.current = disabled;
  }, [disabled, hide]);

  useAnchoredPosition(open, anchorRef, tipRef, { side: "top", align: "center", gap: 6, limitHeight: false }, host);

  const has = !nested && label !== undefined && label !== null && label !== "";
  if (!has) return children;

  const call = (name: string, e: unknown) => (props[name] as ((e: unknown) => void) | undefined)?.(e);
  // Açıklama yalnız adı tekrarlamıyorsa bağlanır (ikon düğmesinin adı zaten aria-label'da).
  const describes = open && content !== undefined && content !== props["aria-label"];
  const enter = (e: { pointerType?: string }) => {
    if (e.pointerType !== "touch") show(HOVER_DELAY);
  };
  const clone = cloneElement(children, {
    ref: mergeRefs<HTMLElement>(childRef, props.ref),
    title: undefined,
    "aria-describedby": describes ? [props["aria-describedby"], id].filter(Boolean).join(" ") : props["aria-describedby"],
    "aria-keyshortcuts": (props["aria-keyshortcuts"] as string | undefined) ?? (command ? c.ariaKeyShortcuts || undefined : undefined),
    onPointerEnter: (e: PointerEvent) => {
      call("onPointerEnter", e);
      enter(e);
    },
    onPointerLeave: (e: PointerEvent) => {
      call("onPointerLeave", e);
      hide(HIDE_GRACE);
    },
    onPointerDown: (e: PointerEvent) => {
      call("onPointerDown", e);
      hide();
    },
    onFocus: (e: FocusEvent) => {
      call("onFocus", e);
      if (lastInputWasKeyboard()) show(FOCUS_DELAY);
    },
    onBlur: (e: FocusEvent) => {
      call("onBlur", e);
      hide();
    },
  });

  return (
    <TooltipScope.Provider value>
      <span
        ref={wrapRef}
        className={cx("tz-tip-host", disabled && "is-off")}
        onPointerEnter={disabled ? enter : undefined}
        onPointerLeave={disabled ? () => hide(HIDE_GRACE) : undefined}
      >
        {clone}
      </span>
      {open &&
        host &&
        createPortal(
          <div ref={tipRef} id={id} role="tooltip" className="tz-tip" onPointerEnter={() => window.clearTimeout(timer.current)} onPointerLeave={() => hide(HIDE_GRACE)}>
            <span>{label}</span>
            {keys && <kbd className="tz-tip-k">{keys}</kbd>}
          </div>,
          host,
        )}
    </TooltipScope.Provider>
  );
}
