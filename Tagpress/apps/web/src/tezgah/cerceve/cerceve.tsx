import { type BandSize, type IconName as ShellIconName, useHeadSlot } from "@sellerondata/shell";
import { API, type QueueStatus } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AccessNeed } from "../../lib/access.ts";
import { api } from "../../lib/api.ts";
import { isPlatform } from "../../lib/platform.ts";
import { useConnection } from "../../lib/events.ts";
import { activeTab, type EkranProps, TABS, type Tab } from "../../lib/route.ts";
import { LOCAL_ORG_KEY, useSetupPending } from "../../lib/setupMenu.ts";
import { type DrawerSide, toggleDrawer, useDrawers, useScreenLayout } from "./duzen.ts";
import { DesignLanguageSwitcher } from "../../ortak/index.ts";
import { cx } from "../cx.ts";
import { Kbd, NeedGate } from "../dugme/Button.tsx";
import { arrowTarget } from "../dugme/gezin.ts";
import { StatusDot } from "../durum/durum.tsx";
import { Icon, type IconName } from "../ikon/Icon.tsx";
import { Menu, type MenuItem, Popover, Tooltip } from "../katman/Popover.tsx";
import { NAV_COMMAND } from "../kisayol/genel.ts";
import { type CommandId, setShortcutsOpen, useCommand } from "../kisayol/kayit.ts";
import markUrl from "./tagpress-mark.svg";
import "./cerceve.css";

export type NavId = Tab;

const NAV_KEY: Record<NavId, string> = {
  uretim: "nav.production",
  "tasarim-dili": "nav.designLanguage",
  sablonlar: "nav.templates",
  baski: "nav.print",
  ayarlar: "nav.settings",
};
/** Menü sırası (maket): Üretim, Tasarım dili, Şablonlar, Baskı, Ayarlar. */
const NAV_ORDER: NavId[] = ["uretim", "tasarim-dili", "sablonlar", "baski", "ayarlar"];

/**
 * Ortak kabuğun menü simgeleri (A · bölmeli sekmeler; yalnız kabuğun simge adları, `Platform/packages/shell/src/icons.tsx`).
 * Kabukta yazıcı, kitap ya da şablon çizimi yok: en yakınları seçildi.
 */
const NAV_ICON: Record<NavId, ShellIconName> = {
  uretim: "spark",
  "tasarim-dili": "edit",
  sablonlar: "copy",
  baski: "doc",
  ayarlar: "gear",
};
/** "Kurulum · Eksik" simgesi: DeciShip'teki gibi bayrak. */
export const SETUP_NAV_ICON: ShellIconName = "flag";

export interface Crumb {
  label: string;
  onClick?(): void;
  /** Açılır menü (parti seçimi gibi); `close` menüyü kapatır. */
  menu?: (close: () => void) => ReactNode;
  /** Yerinde yeniden adlandırma. */
  rename?: { value: string; onRename(v: string): void };
}

export interface FlowStep {
  id: string;
  label: string;
  count?: number;
  error?: boolean;
  active?: boolean;
  /** İpucu (adımın kısa açıklaması; "3 işte sorun var" gibi). */
  hint?: string;
  onClick(): void;
}

export interface BandTabs {
  items: { id: string; label: string; count?: number }[];
  value: string;
  onChange(id: string): void;
}

// ---------------------------------------------------------------- üst satır

function NavLink({ id, active }: { id: NavId; active: boolean }) {
  const { t } = useTranslation("frame");
  const c = useCommand(NAV_COMMAND[id]);
  return (
    <Tooltip command={NAV_COMMAND[id]} content={t(NAV_KEY[id])}>
      <a href={`#/${id}`} className={cx("tz-nv-i", active && "is-on")} aria-current={active ? "page" : undefined} aria-keyshortcuts={c.ariaKeyShortcuts || undefined}>
        {t(NAV_KEY[id])}
      </a>
    </Tooltip>
  );
}

/** Bağlantı yalnız koptuğunda görünür (ilk bağlanma için kısa süre beklenir). */
function useOffline(): boolean {
  const online = useConnection();
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setGrace(false), 4000);
    return () => window.clearTimeout(id);
  }, []);
  return !online && !grace;
}

function Activity() {
  const { t } = useTranslation("frame");
  const offline = useOffline();
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => api.get<QueueStatus>(API.generateStatus), refetchInterval: 15_000 });
  const running = queue.data?.running ?? 0;
  const queued = queue.data?.queued ?? 0;
  return (
    <div className="tz-tr-st" aria-live="polite">
      {offline && (
        <Tooltip content={t("top.offlineHint")}>
          <span className="tz-tr-off" tabIndex={0}>
            <StatusDot tone="error" label={t("top.offline")} />
          </span>
        </Tooltip>
      )}
      {running + queued > 0 && (
        <StatusDot tone="busy" label={queued > 0 ? `${t("top.producing", { running })} · ${t("top.queued", { queued })}` : t("top.producing", { running })} />
      )}
    </div>
  );
}

/** "Eksik" rozeti (DeciShip `ds-setup-tag`): menüdeki Kurulum öğesinin sağında, ölçü sarısı. */
export function SetupTag() {
  const { t } = useTranslation("frame");
  return <span className="tz-setup-tag">{t("nav.setupPending")}</span>;
}

/** Yerel üst satırda "Kurulum · Eksik" (kural `lib/setupMenu.ts`); Kurulum ekranındayken seçili. */
function SetupNavLink() {
  const { t } = useTranslation("frame");
  const pending = useSetupPending(LOCAL_ORG_KEY);
  const on = useScreenLayout()?.routeId === "kurulum";
  if (!pending) return null;
  return (
    <a href="#/kurulum" className={cx("tz-nv-i", on && "is-on")} aria-current={on ? "page" : undefined}>
      {t("nav.setup")}
      <SetupTag />
    </a>
  );
}

/**
 * Yerel kipin üst satırı (72 px): marka kilidi, menü (kurulum bitmediyse başında "Kurulum · Eksik"), sağ küme. Kabukla
 * aynı ölçüler (platform DESIGN §4). Yerelde ⊞ (uygulamalar) ve hesap yok; platformda üst satırı ortak kabuk çizer.
 */
export function TopRow({ active }: { active: NavId | null }) {
  const { t } = useTranslation("frame");
  return (
    <div className="tz-top">
      <a href="#/uretim" className="tz-br" aria-label={t("brand.home")}>
        <img src={markUrl} width={28} height={28} alt="" />
        <span className="tz-br-t">
          <b>{t("brand.name")}</b>
          <small>{t("brand.parent")}</small>
        </span>
      </a>
      <nav className="tz-nv" aria-label={t("nav.label")}>
        <SetupNavLink />
        {NAV_ORDER.map((id) => (
          <NavLink key={id} id={id} active={active === id} />
        ))}
      </nav>
      <div className="tz-tr">
        <Activity />
        <DesignLanguageSwitcher />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bant düğmesi

export interface BandButtonProps {
  label: string;
  icon?: IconName;
  command?: CommandId;
  /** Bantta beyaz birincil ("En iyilerini onayla"). */
  cta?: boolean;
  /** Çerçevesiz; ikon varsa varsayılan olarak yalnız ikon (ad ipucunda; bkz. `iconOnly`). */
  quiet?: boolean;
  /** Yalnız ikon mu? Varsayılan: `quiet` ve `icon` birlikteyse evet. `false`: sessiz düğmede ikon + yazı. */
  iconOnly?: boolean;
  disabled?: boolean;
  /** Verilirse düğme bu menüyü açar (sağda ⌄); `onClick` o zaman isteğe bağlıdır ve açılışta çağrılır. */
  menuItems?: (MenuItem | "sep")[];
  /** Eylemin gerektirdiği yetki (`Button need` ile aynı): yoksa pasif, ipucunda neden. */
  need?: AccessNeed;
  onClick?(): void;
}

/** Bant düğmesi. İpucu (`Tooltip`): ad + kısayol; yalnız ikonken ad. Pasif düğmede de görünür. */
export function BandButton({ need, ...props }: BandButtonProps) {
  if (!need || !isPlatform()) return <PlainBandButton {...props} />;
  return <NeedGate need={need}>{(denied) => <PlainBandButton {...props} disabled={props.disabled || !!denied} deniedHint={denied} />}</NeedGate>;
}

function PlainBandButton({ label, icon, command, cta, quiet, iconOnly: only, disabled, menuItems, onClick, deniedHint }: BandButtonProps & { deniedHint?: string | null }) {
  const c = useCommand(command ?? "");
  const iconOnly = !!icon && (only ?? !!quiet);
  const body = (
    <>
      {icon && <Icon name={icon} size={15} />}
      {!iconOnly && label}
      {command && c.showBadge && !iconOnly && <Kbd command={command} on={cta ? undefined : "band"} />}
      {menuItems && !iconOnly && <Icon name="chev" size={12} />}
    </>
  );
  const attrs = {
    type: "button" as const,
    className: cx("tz-cb", cta && "is-cta", quiet && "is-q"),
    "aria-label": iconOnly ? label : undefined,
    "aria-keyshortcuts": command ? c.ariaKeyShortcuts || undefined : undefined,
    disabled,
  };
  const wrap = (button: ReactElement<Record<string, unknown>>) =>
    !command && !iconOnly && !deniedHint ? (
      button
    ) : (
      <Tooltip command={command} content={deniedHint ? `${label} · ${deniedHint}` : label}>
        {button}
      </Tooltip>
    );
  if (menuItems) {
    return (
      <Menu
        align="end"
        items={menuItems}
        trigger={(p) =>
          wrap(
            <button
              {...attrs}
              {...p}
              onClick={() => {
                onClick?.();
                p.onClick();
              }}
            >
              {body}
            </button>,
          )
        }
      />
    );
  }
  return wrap(
    <button {...attrs} onClick={onClick}>
      {body}
    </button>,
  );
}

// ---------------------------------------------------------------- iş satırı

function CrumbView({ crumb, last }: { crumb: Crumb; last: boolean }) {
  const { t } = useTranslation("frame");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(crumb.rename?.value ?? "");
  if (crumb.rename && editing) {
    const done = (save: boolean) => {
      setEditing(false);
      const v = draft.trim();
      if (save && v && v !== crumb.rename?.value) crumb.rename?.onRename(v);
    };
    return (
      <input
        className="tz-cr-in"
        aria-label={t("work.rename")}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") done(true);
          else if (e.key === "Escape") {
            e.stopPropagation();
            done(false);
          }
        }}
      />
    );
  }
  const Tag = last ? "b" : "span";
  if (crumb.menu) {
    return (
      <Popover
        trigger={(p) => (
          <button type="button" className={cx("tz-cr-b tz-cr-m", last && "is-last")} {...p}>
            <b>{crumb.label}</b>
            <Icon name="chev" size={15} />
          </button>
        )}
      >
        {(close) => crumb.menu?.(close)}
      </Popover>
    );
  }
  if (crumb.rename) {
    return (
      <Tooltip content={t("work.rename")}>
        <button
          type="button"
          className={cx("tz-cr-b", last && "is-last")}
          onClick={() => {
            setDraft(crumb.rename?.value ?? "");
            setEditing(true);
          }}
        >
          <Tag>{crumb.label}</Tag>
        </button>
      </Tooltip>
    );
  }
  if (crumb.onClick && !last) {
    return (
      <button type="button" className="tz-cr-b" onClick={crumb.onClick}>
        {crumb.label}
      </button>
    );
  }
  return <Tag aria-current={last ? "page" : undefined}>{crumb.label}</Tag>;
}

export function Crumbs({ crumbs, label }: { crumbs: Crumb[]; label?: string }) {
  return (
    <nav className="tz-cr" aria-label={label}>
      {crumbs.map((c, i) => (
        <span key={`${c.label}${i}`} className="tz-cr-p">
          {i > 0 && (
            <span className="tz-cr-sep" aria-hidden="true">
              /
            </span>
          )}
          <CrumbView crumb={c} last={i === crumbs.length - 1} />
        </span>
      ))}
    </nav>
  );
}

export interface WorkRowProps {
  back?: { command: CommandId; onClick(): void };
  crumbs: Crumb[];
  tabs?: BandTabs;
  /**
   * Sekmeler yer adından önce: `sekmeler | yer adı · meta` (maket Baskı masası: "Masa · Sayfa şablonları · Arşiv |
   * <oturum adı> 3 sayfa · 127 etiket"). Varsayılan: `yer adı | sekmeler`. Yer adı boşsa ayraç da çizilmez.
   */
  tabsFirst?: boolean;
  flow?: FlowStep[];
  meta?: ReactNode;
  actions?: ReactNode;
}

function BackButton({ command, onClick }: { command: CommandId; onClick(): void }) {
  const { t } = useTranslation("frame");
  const c = useCommand(command);
  const label = c.label === command ? t("work.back") : c.label;
  return (
    <Tooltip command={command} content={label}>
      <button type="button" className="tz-cb is-q" aria-label={label} aria-keyshortcuts={c.ariaKeyShortcuts || undefined} onClick={onClick}>
        <Icon name="left" size={15} />
      </button>
    </Tooltip>
  );
}

/** İş satırındaki sekmeler: etkin sekme odak sırasında, ← → ile gezilir (odak ve seçim birlikte gider). */
function BandTabsView({ tabs, label }: { tabs: BandTabs; label: string }) {
  return (
    <div
      className="tz-btabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        const to = arrowTarget(e, "[role=tab]", "horizontal");
        if (!to) return;
        const el = to.items[to.index];
        el?.focus();
        if (el?.dataset.tabId) tabs.onChange(el.dataset.tabId);
      }}
    >
      {tabs.items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          data-tab-id={it.id}
          aria-selected={it.id === tabs.value}
          tabIndex={it.id === tabs.value ? 0 : -1}
          className={cx(it.id === tabs.value && "is-on")}
          onClick={() => tabs.onChange(it.id)}
        >
          {it.label}
          {it.count !== undefined && <b className="tz-mono">{it.count}</b>}
        </button>
      ))}
    </div>
  );
}

/** İş satırı (44 px): yer, sayfa adı, sekmeler ya da akış, sayfa düzeyi eylemler; en sağda her zaman `?`. */
function FlowButton({ step: s }: { step: FlowStep }) {
  const button = (
    <button type="button" className={cx(s.active && "is-on", s.error && "is-err")} aria-current={s.active ? "step" : undefined} onClick={s.onClick}>
      {s.label}
      {s.count !== undefined && <b className="tz-mono">{s.count}</b>}
    </button>
  );
  return s.hint ? <Tooltip content={s.hint}>{button}</Tooltip> : button;
}

/**
 * Tablette (761–1023 px) çalışma ekranının yan paneli tuvalin üstüne açılır: iş satırında solda sol panelin, sağda
 * sağ panelin düğmesi. Yalnız çalışma ekranında ve paneli olan çalışma alanında çizilir; tablet dışında CSS gizler.
 */
function DrawerButton({ side }: { side: DrawerSide }) {
  const { t } = useTranslation("frame");
  const d = useDrawers();
  const label = t(side === "left" ? "work.leftPanel" : "work.rightPanel");
  const open = d.open === side;
  return (
    <Tooltip content={label}>
      <button type="button" className={cx("tz-cb tz-ctx-dr", open && "is-on")} aria-label={label} aria-expanded={open} onClick={() => toggleDrawer(side)}>
        <Icon name={side === "left" ? "pnll" : "pnlr"} size={15} />
      </button>
    </Tooltip>
  );
}

export function WorkRow({ back, crumbs, tabs, tabsFirst, flow, meta, actions }: WorkRowProps) {
  const { t } = useTranslation("frame");
  const help = useCommand("help");
  const drawers = useDrawers();
  const work = useScreenLayout()?.kind === "work";
  const vl = <span className="tz-ctx-vl" aria-hidden="true" />;
  const tabsView = tabs && <BandTabsView tabs={tabs} label={t("work.tabs")} />;
  const flowView = flow && (
    <ol className="tz-flow" aria-label={t("work.flow")}>
      {flow.map((s, i) => (
        <li key={s.id}>
          {i > 0 && <i aria-hidden="true" />}
          <FlowButton step={s} />
        </li>
      ))}
    </ol>
  );
  const crumbsView = <Crumbs crumbs={crumbs} label={t("work.location")} />;
  return (
    <div className="tz-ctx">
      {back && <BackButton command={back.command} onClick={back.onClick} />}
      {work && drawers.left > 0 && <DrawerButton side="left" />}
      {tabsFirst && tabs ? (
        <>
          {tabsView}
          {crumbs.length > 0 && (
            <>
              {vl}
              {crumbsView}
            </>
          )}
          {flowView && (
            <>
              {vl}
              {flowView}
            </>
          )}
        </>
      ) : (
        <>
          {crumbsView}
          {(tabs || flow) && vl}
          {tabsView}
          {flowView}
        </>
      )}
      {meta}
      <span className="tz-sp" />
      {actions}
      {work && drawers.right > 0 && <DrawerButton side="right" />}
      <BandButton label={help.label} icon="kbd" command="help" quiet onClick={() => setShortcutsOpen(true)} />
    </div>
  );
}

// ---------------------------------------------------------------- tam bant (kılavuzlu akış)

export function FullBand({ kicker, title, sub, aside }: { kicker: Crumb[]; title: string; sub?: string; aside?: ReactNode }) {
  return (
    <div className="tz-hd">
      <div>
        <div className="tz-kick">
          <Crumbs crumbs={kicker} />
        </div>
        <h1 className="tz-ttl">{title}</h1>
        {sub && <p className="tz-sub">{sub}</p>}
      </div>
      {aside}
    </div>
  );
}

/** Banda binen kart. */
export function BandCard({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="tz-kcard">
      <div className="tz-kcard-b">{children}</div>
      {footer && <div className="tz-kcard-f">{footer}</div>}
    </div>
  );
}

/** Adım çipleri; `current` sıfırdan başlar. */
export function StepChips({ steps, current }: { steps: string[]; current: number }) {
  const { t } = useTranslation("frame");
  return (
    <ol className="tz-steps" aria-label={t("steps.label")}>
      {steps.map((s, i) => (
        <li key={s} className={cx(i === current && "is-on")} aria-current={i === current ? "step" : undefined}>
          <i aria-hidden="true">{i + 1}</i>
          {/* Telefonda yalnız etkin adımın adı görünür; diğerlerininki ekran okuyucuda kalır. */}
          <span className="tz-steps-l">{s}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- çerçeve

export interface AppFrameProps {
  /** `work`: 72 + 44 px alçak bant (çalışma ekranları); `full`: 240 px bant ve banda binen kart (kılavuzlu akış). */
  band: "work" | "full";
  /** Etkin menü; Kurulum ve vitrinde null. */
  active: NavId | null;
  workRow?: ReactNode;
  fullBand?: ReactNode;
  children: ReactNode;
}

/**
 * Çerçeve. Yerel kipte üst satır (`TopRow`) + iş satırı ya da tam bant kendi başlığında. Platform kipinde üst satırı
 * ortak kabuk (`AppShell workspace`, `oturum/Kabuk.tsx`) çizer; iş satırı ve tam bant kabuğun baş yuvasına taşınır.
 */
export function AppFrame(props: AppFrameProps) {
  return isPlatform() ? <ShellFrame {...props} /> : <LocalFrame {...props} />;
}

/**
 * Ekran türüne göre çerçeve sınıfı (`lib/route.ts` `screenKind`, `TezgahApp` verir): `tz-app--col` form ve liste
 * ekranı (içerik Merkez/DeciShip sütununda), `tz-app--work` çalışma ekranı (kenardan kenara). Tür bilinmiyorsa ikisi de yok.
 */
function useKindClass(): string | false {
  const kind = useScreenLayout()?.kind;
  return kind === "column" ? "tz-app--col" : kind === "work" ? "tz-app--work" : false;
}

function LocalFrame({ band, active, workRow, fullBand, children }: AppFrameProps) {
  const kind = useKindClass();
  return (
    <div className={cx("tz-app", band === "full" && "tz-app--full", kind)}>
      <header className="tz-bd">
        <TopRow active={active} />
        {band === "work" ? workRow : fullBand}
      </header>
      <main className="tz-main">{children}</main>
    </div>
  );
}

// ---------------------------------------------------------------- platform: kabuk içinde

/** Kabuğun baş yuvasına taşınan bant içeriği; bandın boyunu bildirir (`work` 72 + 44 px, `standard` tam bant). */
export function BandSlot({ size = "work", children }: { size?: BandSize; children: ReactNode }) {
  const slot = useHeadSlot();
  const setSize = slot?.setSize;
  useLayoutEffect(() => {
    if (!setSize) return;
    setSize(size);
    return () => setSize(null);
  }, [setSize, size]);
  return slot?.el ? createPortal(children, slot.el) : null;
}

/** Platform: etkin menüyü kabuk adresten bulur (`oturum/Kabuk.tsx`, `activeTab`); `active` burada kullanılmaz. */
function ShellFrame({ band, workRow, fullBand, children }: AppFrameProps) {
  const kind = useKindClass();
  return (
    <div className={cx("tz-app tz-app--shell", band === "full" && "tz-app--full", kind)}>
      <BandSlot size={band === "work" ? "work" : "standard"}>{band === "work" ? workRow : fullBand}</BandSlot>
      <div className="tz-main">{children}</div>
    </div>
  );
}

/** Kabuğun sağ kümesine (`headerSlot`) giden Tezgâh öğeleri: üretim etkinliği ve tasarım dili seçici. */
export function ShellHeaderSlot({ extra }: { extra?: ReactNode }) {
  return (
    <div className="tz-tr tz-tr--shell">
      {extra}
      <Activity />
      <DesignLanguageSwitcher />
    </div>
  );
}

/** Kabuğun menüsü için sekmeler (sıra ve adlar üst satırla aynı; geniş ekranda simgeli). */
export function shellNavItems(t: (key: string) => string, base: string): { href: string; label: string; icon: ShellIconName }[] {
  return NAV_ORDER.map((id) => ({ href: `${base}/#/${id}`, label: t(NAV_KEY[id]), icon: NAV_ICON[id] }));
}

// ---------------------------------------------------------------- telefon: çalışma ekranı yerine not

/**
 * Telefonda (≤ 760 px) çalışma ekranları (tuval ve iki panel 390 px'e sığmaz) yerine kısa not; `TezgahApp` seçer.
 * Bant ve menü yerinde kalır, iş satırında ekranın menü adı.
 */
export function NarrowNote({ route }: EkranProps) {
  const { t } = useTranslation("frame");
  const tab = activeTab(route);
  return (
    <AppFrame band="work" active={tab} workRow={<WorkRow crumbs={tab ? [{ label: t(NAV_KEY[tab]) }] : []} />}>
      <div className="tz-narrow">
        <div className="tz-narrow-c" role="note">
          <span className="tz-narrow-ic">
            <Icon name="wide" />
          </span>
          <h2>{t("narrow.title")}</h2>
          <p>{t("narrow.body")}</p>
        </div>
      </div>
    </AppFrame>
  );
}

/** `TABS` ile menü sırası aynı kümeyi taşır mı (test ve geliştirici güvencesi). */
export const NAV_IDS: readonly NavId[] = NAV_ORDER.filter((id) => TABS.some((t) => t.id === id));
