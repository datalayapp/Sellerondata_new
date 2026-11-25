import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { registerPanels, useDrawers, useScreenLayout } from "../cerceve/duzen.ts";
import { cx } from "../cx.ts";
import { IconButton } from "../dugme/Button.tsx";
import { arrowTarget } from "../dugme/gezin.ts";
import { Checkbox } from "../form/form.tsx";
import { Icon, type IconName } from "../ikon/Icon.tsx";
import { Menu, type MenuItem, Tooltip } from "../katman/Popover.tsx";
import { type CommandId, useCommand } from "../kisayol/kayit.ts";
import "./yerlesim.css";

// ---------------------------------------------------------------- çalışma alanı ızgarası

export interface WorkspaceProps {
  rail?: ReactNode;
  left?: ReactNode;
  leftWidth?: 240 | 260 | 270 | 280 | 300 | 330;
  right?: ReactNode;
  rightWidth?: 300 | 310 | 330 | 340;
  /** Orta sütun (çoğunlukla `CenterColumn`). */
  children: ReactNode;
}

/**
 * Ray 48 · sol panel · esnek orta · sağ panel. Yükseklik = pencere − bant (AppFrame içinde %100).
 * Dar ekran (ARAYUZ-PLANI "Yerleşim"): çalışma ekranında tablette (761–1023 px) tuval tam genişlik, paneller iş
 * satırındaki düğmeyle tuvalin üstüne açılan çekmece (`duzen.ts`); sütun ekranında telefonda paneller alt alta.
 */
export function Workspace({ rail, left, leftWidth = 280, right, rightWidth = 300, children }: WorkspaceProps) {
  const kind = useScreenLayout()?.kind;
  const drawers = kind === "work";
  const d = useDrawers();
  const hasLeft = !!left;
  const hasRight = !!right;
  useEffect(() => (drawers ? registerPanels(hasLeft, hasRight) : undefined), [drawers, hasLeft, hasRight]);
  const cols = [rail ? "var(--tz-rail-w)" : null, left ? `${leftWidth}px` : null, "minmax(0, 1fr)", right ? `${rightWidth}px` : null].filter(Boolean).join(" ");
  const style = {
    "--tz-ws-cols": cols,
    // Tablet çekmecesi: yalnız ray ve tuval ızgarada kalır.
    "--tz-ws-cols-narrow": rail ? "var(--tz-rail-w) minmax(0, 1fr)" : "minmax(0, 1fr)",
    // Telefonda sütun ekranı: paneller içerik boyunda, orta kalan yükseklikte.
    "--tz-ws-rows-stack": [left ? "auto" : null, "minmax(0, 1fr)", right ? "auto" : null].filter(Boolean).join(" "),
  } as CSSProperties;
  const side = (s: "l" | "r", node: ReactNode, w: number) =>
    drawers ? (
      <div className={`tz-ws-side tz-ws-side--${s}`} style={{ "--tz-ws-side-w": `${w}px` } as CSSProperties}>
        {node}
      </div>
    ) : (
      node
    );
  return (
    <div className={cx("tz-ws", drawers && "tz-ws--drawers", !!rail && "tz-ws--rail", kind === "column" && "tz-ws--col")} style={style} data-drawer={drawers ? (d.open ?? undefined) : undefined}>
      {rail}
      {left && side("l", left, leftWidth)}
      <div className="tz-ws-c">{children}</div>
      {right && side("r", right, rightWidth)}
    </div>
  );
}

// ---------------------------------------------------------------- ray

export interface RailItem {
  id: string;
  icon: IconName;
  command: CommandId;
}

function RailButton({ item, on, onPick }: { item: RailItem; on: boolean; onPick: () => void }) {
  const c = useCommand(item.command);
  return (
    <Tooltip command={item.command}>
    <button
      type="button"
      className={cx("tz-rail-b", on && "is-on")}
      aria-pressed={on}
      aria-label={c.label}
      aria-keyshortcuts={c.ariaKeyShortcuts || undefined}
      tabIndex={on ? 0 : -1}
      data-rail-id={item.id}
      onClick={onPick}
    >
      <Icon name={item.icon} />
    </button>
    </Tooltip>
  );
}

/** Araç rayı: yalnız ikon, adı ve kısayolu ipucunda; ↑ ↓ (Home, End) ile gezilir, Enter/Boşluk seçer. */
export function Rail({ label, items, value, onChange }: { label: string; items: (RailItem | "divider")[]; value: string; onChange(id: string): void }) {
  return (
    <div
      className="tz-rail"
      role="toolbar"
      aria-label={label}
      aria-orientation="vertical"
      onKeyDown={(e) => {
        const to = arrowTarget(e, ".tz-rail-b", "vertical");
        to?.items[to.index]?.focus();
      }}
    >
      {items.map((it, i) => (it === "divider" ? <hr key={`d${i}`} /> : <RailButton key={it.id} item={it} on={it.id === value} onPick={() => onChange(it.id)} />))}
    </div>
  );
}

// ---------------------------------------------------------------- paneller

export interface PanelProps {
  side: "left" | "right";
  title?: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  /** Altta sabit (birincil eylem burada). */
  footer?: ReactNode;
  children: ReactNode;
}

export function Panel({ side, title, count, actions, footer, children }: PanelProps) {
  const id = useId();
  return (
    <section className={cx("tz-pnl", side === "left" ? "tz-pnl--l" : "tz-pnl--r")} aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <div className="tz-pnl-h">
          {title && (
            <h2 id={id} className="tz-pnl-t">
              {title}
            </h2>
          )}
          {count !== undefined && <span className="tz-pnl-c">{count}</span>}
          <span className="tz-sp" />
          {actions}
        </div>
      )}
      <div className="tz-pnl-b">{children}</div>
      {footer && <div className="tz-pnl-f">{footer}</div>}
    </section>
  );
}

export function PanelSection({ heading, aside, children }: { heading?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="tz-sec">
      {(heading || aside) && (
        <div className="tz-sec-h">
          {heading && <h3>{heading}</h3>}
          <span className="tz-sp" />
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}

/** Etiket (96 px) + denetim. */
export function PropRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="tz-pr">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      <div className="tz-pr-v">{children}</div>
    </div>
  );
}

/** İki sütun (Sipariş no · Adet gibi). */
export function PropPair({ children }: { children: ReactNode }) {
  return <div className="tz-pr2">{children}</div>;
}

const groupKey = (k: string) => `tagpress.grup.${k}`;

/** Kapalı grup: nadir ayarlar; tek tıkla açılır. `persistKey` verilirse açık/kapalı durumu yerel kayıtta kalır. */
export function CollapsedGroup({ title, summary, defaultOpen = false, persistKey, children }: { title: string; summary?: ReactNode; defaultOpen?: boolean; persistKey?: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    if (!persistKey) return defaultOpen;
    try {
      const v = localStorage.getItem(groupKey(persistKey));
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const id = useId();
  useEffect(() => {
    if (!persistKey) return;
    try {
      localStorage.setItem(groupKey(persistKey), open ? "1" : "0");
    } catch {
      /* gizli pencere */
    }
  }, [open, persistKey]);
  return (
    <div className={cx("tz-gc", open && "is-open")}>
      <button type="button" className="tz-gc-h" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <b>{title}</b>
        {!open && summary && <span className="tz-gc-v">{summary}</span>}
      </button>
      <div id={id} className="tz-gc-b" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- orta sütun

export function CenterColumn({ strip, selectionBar, status, children }: { strip?: ReactNode; selectionBar?: ReactNode; status?: ReactNode; children: ReactNode }) {
  return (
    <div className="tz-cc">
      {strip}
      {selectionBar}
      <div className="tz-cc-b">{children}</div>
      {status}
    </div>
  );
}

export function ToolStrip({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="tz-tb" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}
export function ToolGroup({ children }: { children?: ReactNode }) {
  return <div className="tz-tb-g">{children}</div>;
}
export function ToolDivider() {
  return <span className="tz-tb-vl" aria-hidden="true" />;
}
export function ToolSpacer() {
  return <span className="tz-sp" />;
}
export function ToolLabel({ children }: { children?: ReactNode }) {
  return <span className="tz-tb-lb">{children}</span>;
}

/**
 * Seçim şeridi: seçime bağlı araçlar yalnız burada. Esc seçimi kaldırır (yazı alanında ve açık pencerede değil;
 * kısayol kaydı Esc'i işlediyse burası çalışmaz).
 */
export function SelectionBar({ label, onClear, children }: { label: string; onClear(): void; children: ReactNode }) {
  const { t } = useTranslation("common");
  const clear = useRef(onClear);
  clear.current = onClear;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      clear.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  return (
    <div className="tz-selbar" role="region" aria-label={label}>
      <b aria-live="polite">{label}</b>
      <span className="tz-selbar-vl" aria-hidden="true" />
      {children}
      <span className="tz-sp" />
      <IconButton icon="x" size={28} label={t("actions.clearSelection")} title={`${t("actions.clearSelection")} · Esc`} onClick={onClear} />
    </div>
  );
}

/**
 * Durum satırı (28 px): birim, son değişiklik, kayıt durumu; sağ uçta yakınlaştırma. `end` verilirse araya esnek
 * boşluk girer; verilmezse boşluğu (sağa dayalı metin için `ToolSpacer`) ekran kendisi koyar. Dar ekranda metin
 * üç noktayla kısalır, `end` kısalmaz.
 */
export function StatusBar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="tz-sb" role="status">
      {children}
      {end && (
        <>
          <span className="tz-sp" />
          <span className="tz-sb-end">{end}</span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- liste ve sekmeler

export interface ListRowProps {
  leading?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  trailing?: ReactNode;
  current?: boolean;
  /** Çoklu seçimde seçili (açık mor zemin). */
  multi?: boolean;
  checkbox?: { checked: boolean; onChange(v: boolean): void; label?: string };
  /**
   * Yoğunluk. `fixed` (varsayılan): 46 px, ad ve alt satır tek satır (sığmazsa üç nokta). `auto`: yükseklik içeriğe
   * göre, 10/12 px iç boşluk, alt satır kırılabilir (maket `.vrow`: sürümler, sayfa şablonları). `compact`: 34 px,
   * çizgisiz, 8 px köşeli; seçili satır açık mor zemin ve mor yazı, sondaki sayaç soluk mono (maket `.glist`: grup ve
   * bölüm listeleri; öndeki ikon 15 px). `card`: kart satırı (maket `.ln`: Düzelt satır listesi): yükseklik içeriğe
   * göre, 7/8 px iç boşluk, çizgisiz, 8 px köşe; seçili satır açık mor zemin ve ince mor çerçeve. Kart listesini
   * saran öğe 6 px iç boşluk verir.
   */
  density?: "fixed" | "auto" | "compact" | "card";
  /** Olay verilir: Ctrl/⌘ ya da Shift ile tıklama ekranda doğrudan okunur (`e.ctrlKey`, `e.shiftKey`). */
  onClick(e: React.MouseEvent<HTMLButtonElement>): void;
}

/** Liste satırı (varsayılan 46 px; bkz. `density`). Satır bir düğmedir; içindeki onay kutusu satırı açmaz. */
export function ListRow({ leading, title, sub, trailing, current, multi, checkbox, density = "fixed", onClick }: ListRowProps) {
  const { t } = useTranslation("frame");
  return (
    <div className={cx("tz-lr", density !== "fixed" && `tz-lr--${density}`, current && "is-cur", multi && "is-multi")}>
      {checkbox && (
        <span className="tz-lr-cb">
          <Checkbox checked={checkbox.checked} onChange={checkbox.onChange} label={checkbox.label ?? (typeof title === "string" ? title : t("list.select"))} />
        </span>
      )}
      <button type="button" className="tz-lr-b" aria-current={current || undefined} onClick={onClick}>
        {leading && <span className="tz-lr-l">{leading}</span>}
        <span className="tz-lr-t">
          <b>{title}</b>
          {sub && <small>{sub}</small>}
        </span>
        {trailing && <span className="tz-lr-r">{trailing}</span>}
      </button>
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  /** Sekmede ⌄ işareti. `menuItems` verilirse sekme bir menü açar ("Diğer": seyrek süzgeçler gibi). */
  menu?: boolean;
  /** Menü sekmesinin öğeleri; tıklama, Enter ya da ↓ menüyü açar (sekmenin kendisi seçilmez; seçimi öğe yapar). */
  menuItems?: (MenuItem | "sep")[];
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange(id: string): void;
  label?: string;
  /**
   * `filter` (varsayılan): hap görünümlü süzgeç sekmesi. `underline`: özellik paneli sekmeleri (maket `.ftabs`): 32 px,
   * zeminsiz, seçili sekmede koyu yarı kalın yazı ve altında 2 px mor çizgi; altta panel çizgisi.
   */
  variant?: "filter" | "underline";
}

/**
 * Panel içi sekmeler (süzgeç). ← → (Home, End) ile gezilir; odak ve seçim birlikte gider. Menü sekmesi (`menuItems`)
 * oklarla gelince seçilmez: Enter ya da ↓ menüsünü açar, öğe seçince odak sekmeye döner.
 */
export function Tabs({ items, value, onChange, label, variant = "filter" }: TabsProps) {
  // Sekme sırasındaki tek odak: seçili sekme; seçili sekme listede yoksa ilki.
  const focusId = items.some((it) => it.id === value) ? value : items[0]?.id;
  return (
    <div
      className={cx("tz-tabs", variant === "underline" && "tz-tabs--ul")}
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        // Portaldaki menüden React ağacında kabarcıklanan tuşlar sekmelere ait değil.
        if (!e.currentTarget.contains(e.target as Node)) return;
        const here = (e.target as HTMLElement).closest<HTMLElement>("[role=tab]");
        if (here?.dataset.tabMenu !== undefined && (e.key === "Enter" || e.key === "ArrowDown")) {
          e.preventDefault();
          here.click();
          return;
        }
        const to = arrowTarget(e, "[role=tab]", "horizontal");
        if (!to) return;
        const el = to.items[to.index];
        el?.focus();
        if (el?.dataset.tabId && el.dataset.tabMenu === undefined) onChange(el.dataset.tabId);
      }}
    >
      {items.map((it) => {
        const on = it.id === value;
        const inner = (
          <>
            {it.label}
            {it.count !== undefined && <i className="tz-mono">{it.count}</i>}
            {(it.menu || it.menuItems) && <Icon name="chev" size={12} />}
          </>
        );
        if (it.menuItems) {
          return (
            <Menu
              key={it.id}
              align="start"
              items={it.menuItems}
              trigger={(p) => (
                <button {...p} type="button" role="tab" data-tab-id={it.id} data-tab-menu="" aria-selected={on} tabIndex={it.id === focusId ? 0 : -1} className={cx(on && "is-on")}>
                  {inner}
                </button>
              )}
            />
          );
        }
        return (
          <button key={it.id} type="button" role="tab" data-tab-id={it.id} aria-selected={on} tabIndex={it.id === focusId ? 0 : -1} className={cx(on && "is-on")} onClick={() => onChange(it.id)}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}
