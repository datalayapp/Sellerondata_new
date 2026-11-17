import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { sessionStatus } from './session/status.ts';
import { Icon, type IconName } from './icons.tsx';
import { useHeadSlot } from './headSlot.ts';
import { closeDecision, isTrackedField, type CloseSource } from './modalGuard.ts';
import { placeMenu, visibleBounds } from './menuPlacement.ts';

export { closeDecision, isTrackedField, type CloseDecision, type CloseSource } from './modalGuard.ts';

/*
 * Temel bileşenler: Merkez ve DeciShip paneli aynı bileşeni kullanır (DeciShip `components/ui.tsx` buradan yeniden dışa aktarır).
 * Sınıf adları e2e seçicilerine bağlıdır; değişmez. Sınıf CSS'i `primitives.css` içindedir (DESIGN.md).
 */

// ---------- Button ----------
// primary = sayfanın tek ana eylemi · secondary = beyaz + çerçeve · ghost/plain = çerçevesiz
// danger = dolu kırmızı · danger-outline = kırmızı çerçeve. `dark` ve `tert` secondary'nin eski takma adları (DeciShip).
type BtnKind = 'primary' | 'secondary' | 'ghost' | 'plain' | 'danger' | 'danger-outline' | 'dark' | 'tert';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: BtnKind;
  icon?: IconName;
  small?: boolean;
  loading?: boolean;
}
export function Button({ kind = 'primary', icon, small, loading, children, className, disabled, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', kind === 'plain' ? 'btn-ghost plain' : `btn-${kind}`, small ? 'btn-sm' : '', !children ? 'btn-icon' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Icon name="spin" className="spin" /> : icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

// ---------- ActionMenu ----------
export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Devre dışı ise nedeni (görünür metin). */
  hint?: string;
}
export interface ActionMenuProps {
  /** Düğme metni; `iconOnly` ise erişilebilir ad. Verilmezse "Diğer". */
  label?: string;
  items: MenuItem[];
  className?: string;
  /** Yalnız "⋯" düğmesi (nadir eylemler). */
  iconOnly?: boolean;
  disabled?: boolean;
  /** İşlem sürüyor: düğme kapalı, ikon döner. */
  busy?: boolean;
  /**
   * Liste `document.body`'ye çizilir ve düğmeye göre konumlanır (varsayılan; tablo gibi kaydırılan kapsayıcıda kırpılmaz).
   * `false`: liste `.amenu` içinde kalır, konumu CSS verir (DeciShip paneli bugün böyle).
   */
  portal?: boolean;
  /** `iconOnly` düğmenin biçimi: `icon` = `.icon-btn` (Merkez), `button` = `.btn.btn-secondary.btn-icon.amenu-dots` (DeciShip). */
  dotsTrigger?: 'icon' | 'button';
  /** `iconOnly` düğmenin ikonu (varsayılan `dots`). */
  dotsIcon?: IconName;
  /** Listenin başındaki bilgi satırı (ör. rol adı ve türü). Seçilemez; ekran okuyucu listenin adından okur. */
  header?: ReactNode;
  /** Küçük liste: tek satırlık öğeler, tehlikeli öğenin önünde ayraç (Merkez rol menüsü). */
  compact?: boolean;
  /** Liste düğmenin hangi kenarına hizalanır (portal). Varsayılan `right`: liste düğmenin sağ kenarından sola açılır. */
  align?: 'left' | 'right';
}

/** Klavye: ↑/↓ gezinir, Esc kapatır ve odağı düğmeye döndürür, Tab ve dışarı tıklama kapatır. */
export function ActionMenu({
  label: labelProp,
  items,
  className,
  iconOnly,
  disabled,
  busy,
  portal = true,
  dotsTrigger = 'icon',
  dotsIcon = 'dots',
  header,
  compact,
  align = 'right',
}: ActionMenuProps) {
  const { t } = useTranslation('shell');
  const label = labelProp ?? t('common.more');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const menuItems = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  // Menü tablo gibi kaydırılan kapsayıcıların dışına çizilir, yoksa alt satırlarda kırpılır. Liste hiçbir zaman ekrandan
  // taşmaz (`placeMenu`): altta yer yoksa yukarı, yanda yer yoksa öbür yana kayar; iki yanda da sığmazsa kendi içinde kayar.
  useLayoutEffect(() => {
    if (!open || !portal || !trigger.current || !list.current) return;
    const el = list.current;
    const p = placeMenu(trigger.current.getBoundingClientRect(), { width: el.offsetWidth, height: el.scrollHeight }, visibleBounds(), align);
    setPos({
      position: 'fixed',
      top: p.top,
      left: p.left,
      right: 'auto',
      bottom: 'auto',
      zIndex: 70,
      ...(p.maxHeight === undefined ? {} : { maxHeight: p.maxHeight, overflowY: 'auto' }),
    });
  }, [open, portal, align]);

  useEffect(() => {
    if (!open) return;
    // Satır içi liste sayfayla birlikte kayar: ilk öğeye odaklanınca görünür alana gelsin (DeciShip davranışı).
    menuItems()[0]?.focus(portal ? { preventScroll: true } : undefined);
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    if (!portal) return () => document.removeEventListener('pointerdown', onDown);
    // Sabit konumlu liste düğmeden kopmasın: kaydırma ya da boyut değişince kapanır.
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [open, portal]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = menuItems();
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      all[e.key === 'ArrowDown' ? (i + 1) % all.length : (i - 1 + all.length) % all.length]?.focus();
    }
  };

  return (
    <div className={`amenu${className ? ` ${className}` : ''}`} ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={iconOnly ? (dotsTrigger === 'button' ? 'btn btn-secondary btn-icon amenu-dots' : 'icon-btn') : 'btn btn-secondary'}
        aria-label={iconOnly ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {iconOnly ? busy ? <Icon name="spin" className="spin" /> : <Icon name={dotsIcon} /> : label}
        {!iconOnly && (busy ? <Icon name="spin" className="spin" /> : <Icon name="chev" />)}
      </button>
      {open && (portal ? createPortal(menu(pos), document.body) : menu(undefined))}
    </div>
  );

  // Klavye olayları portaldan da React ağacında `.amenu`'ya kabarır: listeye ayrı dinleyici konmaz (↓ iki öğe atlardı).
  function menu(style: CSSProperties | undefined) {
    return (
      <div ref={list} className={`amenu-list${compact ? ' compact' : ''}`} role="menu" id={id} aria-label={label} style={style}>
        {header && (
          <div className="amenu-head" aria-hidden="true">
            {header}
          </div>
        )}
        {items.map((it, i) => [
          compact && it.danger && i > 0 && !items[i - 1]!.danger ? <div key={`sep-${it.label}`} className="amenu-sep" role="separator" /> : null,
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            className={it.danger ? 'danger' : undefined}
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
              it.onSelect();
            }}
          >
            {it.icon && <Icon name={it.icon} />}
            <span className="amenu-text">
              {it.label}
              {it.hint && <small>{it.hint}</small>}
            </span>
          </button>,
        ])}
      </div>
    );
  }
}

// ---------- Tag ----------
export type Tone = 'green' | 'red' | 'yellow' | 'blue' | 'gray' | 'purple' | 'teal' | 'outline';
export function Tag({ tone, children, small }: { tone: Tone; children: ReactNode; small?: boolean }) {
  return <span className={`tag ${tone}${small ? ' sm' : ''}`}>{children}</span>;
}

// ---------- Page header ----------
export type PageHeaderProps = {
  title: ReactNode;
  sub?: ReactNode;
  /** `sub` ile aynı (DeciShip `ui.tsx` uyumu). */
  description?: ReactNode;
  /** Başlığın üstünde küçük satır (Mono 13, büyük harf). Tarih, üst bölüm. */
  eyebrow?: ReactNode;
  crumbs?: ReactNode;
  actions?: ReactNode;
  /** `.ptabs` şeridi. Bantta değil, içeriğin başında çizilir. */
  tabs?: ReactNode;
  /**
   * Büyük bant (H1 56, ilk kart banda biner). Yalnız Merkez Genel Bakış ve DeciShip Pano.
   * Verilmezse standart bant: her sayfada aynı sabit yükseklik; başlık ve alt metin tek satır.
   */
  hero?: boolean;
  /**
   * Başlığın solunda görsel (ör. Hesabım'daki baş harf dairesi). Yalnız standart bantta; telefonda gizlenir (bant boyu sabit kalır).
   * Süsleyicidir: erişilebilir ad başlıktadır, verilen öğe `aria-hidden` olmalı.
   */
  media?: ReactNode;
  /** @deprecated Bant artık hep sabit standart boyda; etkisi yok. */
  short?: boolean;
};

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Sayfa başlığı. AppShell içinde bandın başlık bölgesine taşınır (portal); dışında satır içi çizilir.
 * Sayfa başına tek `PageHeader`.
 */
export function PageHeader({ title, sub, description, eyebrow, crumbs, actions, tabs, hero, media }: PageHeaderProps) {
  const slot = useHeadSlot();
  const size = hero ? 'hero' : 'standard';
  const setSize = slot?.setSize;
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Bant boyu boyamadan önce bilinsin: ilk karede zıplama olmaz.
  useIsoLayoutEffect(() => {
    if (!setSize) return;
    setSize(size);
    return () => setSize(null);
  }, [setSize, size]);
  const titleMounted = slot?.titleMounted;
  const slotEl = slot?.el;
  useEffect(() => {
    if (slotEl) titleMounted?.(titleRef.current);
  }, [titleMounted, slotEl]);
  sub = sub ?? description;
  if (!slot) {
    return (
      <div className={`phead${tabs ? ' has-tabs' : ''}`}>
        <div className="phead-main">
          {crumbs && <div className="crumb">{crumbs}</div>}
          {eyebrow && <p className="peyebrow">{eyebrow}</p>}
          <h1 className="ptitle">{title}</h1>
          {sub && <div className="psub">{sub}</div>}
        </div>
        {actions && <div className="pactions">{actions}</div>}
        {tabs}
      </div>
    );
  }
  // Standart bantta satırlar hep yer tutar (boş da olsa): yükseklik içerikten bağımsız.
  const head = hero ? (
    <div className="phead is-band is-hero">
      <div className="phead-main">
        {crumbs && <div className="crumb">{crumbs}</div>}
        {eyebrow && <p className="peyebrow">{eyebrow}</p>}
        <h1 ref={titleRef} className="ptitle" tabIndex={-1}>
          {title}
        </h1>
        {sub && <div className="psub">{sub}</div>}
      </div>
      {actions && <div className="pactions">{actions}</div>}
    </div>
  ) : (
    <div className={`phead is-band${media ? ' has-media' : ''}`}>
      {media && <div className="phead-media">{media}</div>}
      <div className="phead-main">
        <div className="phead-kicker">
          {crumbs && <div className="crumb">{crumbs}</div>}
          {eyebrow && <p className="peyebrow">{eyebrow}</p>}
        </div>
        <h1 ref={titleRef} className="ptitle" tabIndex={-1}>
          {title}
        </h1>
        <div className="psub">{sub}</div>
      </div>
      <div className="pactions">{actions}</div>
    </div>
  );
  return (
    <>
      {slot.el && createPortal(head, slot.el)}
      {tabs && <div className="phead-tabs">{tabs}</div>}
    </>
  );
}

// ---------- Card ----------
export function Card({
  title,
  description,
  actions,
  children,
  flush,
  className,
  ...rest
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={['card', flush ? 'flush' : '', className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {(title || actions) && (
        <div className="card-h">
          <div className="grow">
            {title && <h2 className="tt">{title}</h2>}
            {description && <p className="card-desc">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

// ---------- Skeleton / empty / error ----------
export function Skel({ w = '100%', h = 14 }: { w?: number | string; h?: number }) {
  return <span className="skel" style={{ width: w, height: h }} />;
}

/** Tablo yüklenirken iskelet: `cols` sütun, `rows` satır. */
export function TableSkeleton({ cols, rows = 6 }: { cols: number; rows?: number }) {
  const { t } = useTranslation('shell');
  return (
    <div className="tbl-wrap" aria-busy="true" aria-label={t('common.loading')}>
      <table className="dt">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>
                <Skel w={i === 0 ? 120 : 72} h={12} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <Skel w={c === 0 ? '70%' : '50%'} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({
  icon = 'doc',
  title,
  children,
  actions,
  compact,
  good,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  /** Sonuç iyi ise (ör. bekleyen iş yok) yeşil zemin. */
  good?: boolean;
}) {
  return (
    <div className={`empty${compact ? ' compact' : ''}${good ? ' good' : ''}`}>
      <div className="ic">
        <Icon name={icon} size={compact ? 20 : 24} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="acts">{actions}</div>}
    </div>
  );
}

/**
 * Sunucunun söylediği neden, yoksa `fallback`. `instanceof` yerine yapıya bakar: kabuğun `ApiError`'u da uygulamanın
 * kendi `ApiError` sınıfı da (DeciShip `api/client.ts`, `name = 'ApiError'`) tanınır.
 */
export function errorText(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'ApiError') {
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: ReactNode }) {
  const { t } = useTranslation('shell');
  return (
    <div className="notif err" role="alert">
      <Icon name="err" />
      <span>
        <b>{title ?? t('common.loadFailed')}</b> {errorText(error, t('common.unexpected'))}
      </span>
      {onRetry && (
        <button type="button" className="link-btn act" onClick={onRetry}>
          <Icon name="refresh" /> {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'err' | 'ok'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notif ${tone}`} role={tone === 'err' ? 'alert' : 'status'}>
      <Icon name={tone === 'warn' ? 'warn' : tone} />
      <span>{children}</span>
      {action}
    </div>
  );
}

// ---------- Focus trap ----------
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement | null>, onEscape: () => void) {
  const esc = useRef(onEscape);
  esc.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea') ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        esc.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const f = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const a = f[0]!;
      const z = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [active, ref]);
}

// ---------- Modal ----------
export interface ModalProps {
  label?: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  size?: 'wide' | 'xwide';
  /** Pencereye sayfaya özgü ek sınıf. */
  className?: string;
  /** İşlem sürüyor: Esc, örtü ve X yok sayılır, X kapalı. */
  busy?: boolean;
  /** Yazılmış mı. Verilmezse pencere içindeki alanlara yazılıp yazılmadığı kendiliğinden izlenir. */
  dirty?: boolean;
  /**
   * "Yazdıklarınız silinsin mi" koruması (varsayılan açık). Yazılmışsa Esc, örtü ya da X hemen kapatmaz; alt şeritte sorar.
   * Çağıranın kendi düğmeleri sormaz. `false`: koruma yok, `busy` yine geçerli.
   */
  guard?: boolean;
}

/**
 * Pencere koruması (Modal ve SlideOver ortak): Esc, örtü ve X `requestClose` ile gelir; `closeDecision` kararı verir.
 * `dirty` verilmezse `ref` içindeki alanlara yazılıp yazılmadığı kendiliğinden izlenir.
 */
function useCloseGuard(ref: React.RefObject<HTMLElement | null>, o: { onClose: () => void; busy: boolean; dirty?: boolean; guard: boolean }) {
  const closeRef = useRef(o.onClose);
  closeRef.current = o.onClose;
  const [asking, setAsking] = useState(false);
  const touchedRef = useRef(false);
  const stateRef = useRef({ busy: o.busy, dirty: o.dirty, asking, guard: o.guard });
  stateRef.current = { busy: o.busy, dirty: o.dirty, asking, guard: o.guard };
  const requestClose = useRef((source: CloseSource) => {
    const st = stateRef.current;
    const d = closeDecision({ busy: st.busy, dirty: st.guard && (st.dirty ?? touchedRef.current), asking: st.asking, source });
    if (d === 'close') closeRef.current();
    else if (d === 'ask') setAsking(true);
    else if (d === 'keep') setAsking(false);
  }).current;
  // Pencere içindeki alanlara yazıldı mı (`dirty` verilmediyse koruma buna bakar).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTouch = (e: Event) => {
      if (e.target instanceof Element && isTrackedField(e.target)) touchedRef.current = true;
    };
    el.addEventListener('input', onTouch, true);
    el.addEventListener('change', onTouch, true);
    return () => {
      el.removeEventListener('input', onTouch, true);
      el.removeEventListener('change', onTouch, true);
    };
  }, [ref]);
  useEffect(() => {
    if (asking) ref.current?.querySelector<HTMLElement>('.modal-guard [data-autofocus]')?.focus();
  }, [asking, ref]);
  return { asking, requestClose, keep: () => setAsking(false), discard: () => closeRef.current() };
}

/** "Yazdıklarınız silinsin mi" şeridi: pencerenin eylem satırının yerine çıkar. */
function CloseGuardStrip({ className, onKeep, onDiscard }: { className: string; onKeep: () => void; onDiscard: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <div className={`${className} modal-guard`} role="alert">
      <div className="modal-guard-text">
        <strong>{t('modalGuard.title')}</strong>
        <span>{t('modalGuard.body')}</span>
      </div>
      <div className="modal-guard-btns">
        <ModalAction kind="dark" data-autofocus onClick={onKeep}>
          {t('modalGuard.keep')}
        </ModalAction>
        <ModalAction kind="danger" onClick={onDiscard}>
          {t('modalGuard.discard')}
        </ModalAction>
      </div>
    </div>
  );
}

export function Modal({ label, title, onClose, children, actions, size, className, busy = false, dirty, guard = true }: ModalProps) {
  const { t } = useTranslation('shell');
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { asking, requestClose, keep, discard } = useCloseGuard(ref, { onClose, busy, dirty, guard });
  useFocusTrap(true, ref, () => requestClose('esc'));

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose('backdrop');
      }}
    >
      <div className={`modal${size ? ` ${size}` : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="modal-in">
          {label && <div className="modal-label">{label}</div>}
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          <Button
            kind="plain"
            icon="close"
            className="close"
            aria-label={t('common.close')}
            title={busy ? t('modalGuard.busy') : undefined}
            disabled={busy}
            onClick={() => requestClose('x')}
          />
          <div className="modal-body">{children}</div>
        </div>
        {asking ? (
          <CloseGuardStrip className="modal-actions" onKeep={keep} onDiscard={discard} />
        ) : (
          actions && <div className="modal-actions">{actions}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ModalAction({
  kind,
  children,
  icon,
  loading,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind: 'dark' | 'prim' | 'danger'; icon?: IconName; loading?: boolean }) {
  return (
    <button type="button" className={`pa ${kind}`} disabled={rest.disabled || loading} {...rest}>
      <span>{children}</span>
      {loading ? <Icon name="spin" className="spin" /> : icon && <Icon name={icon} />}
    </button>
  );
}

// ---------- Slide-over ----------
/**
 * Sağdan açılan panel. Bağlamı örtmeden iş yaptırır (davet gibi). Telefonda tam ekran.
 * Koruma `Modal` ile aynı (`busy`, `dirty`, `guard`): yazılmışsa Esc, örtü ya da X hemen kapatmaz, alt şeritte sorar.
 */
export function SlideOver({
  title,
  description,
  onClose,
  children,
  actions,
  busy = false,
  dirty,
  guard = true,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
  dirty?: boolean;
  guard?: boolean;
}) {
  const { t } = useTranslation('shell');
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { asking, requestClose, keep, discard } = useCloseGuard(ref, { onClose, busy, dirty, guard });
  useFocusTrap(true, ref, () => requestClose('esc'));
  return createPortal(
    <div
      className="sod-slide-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose('backdrop');
      }}
    >
      <div className="sod-slide" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <header className="sod-slide-head">
          <div className="grow">
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <Button
            kind="plain"
            icon="close"
            aria-label={t('common.close')}
            title={busy ? t('modalGuard.busy') : undefined}
            disabled={busy}
            onClick={() => requestClose('x')}
          />
        </header>
        <div className="sod-slide-body">{children}</div>
        {asking ? (
          <CloseGuardStrip className="sod-slide-foot" onKeep={keep} onDiscard={discard} />
        ) : (
          actions && <footer className="sod-slide-foot">{actions}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Fields ----------
export function Field({
  label,
  children,
  help,
  error,
  className,
  htmlFor,
}: {
  label: ReactNode;
  children: ReactNode;
  help?: ReactNode;
  error?: string | null;
  className?: string;
  htmlFor?: string;
}) {
  const noteId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const note = error ? 'err' : help ? 'help' : null;
  const required = /(^|\s)req(\s|$)/.test(className ?? '');
  const addedRequired = useRef(false);
  // Hata ya da yardım satırı alana bağlanır (ekran okuyucu alanla birlikte okur); zorunlu alan (`req`, etiketteki yıldız)
  // `aria-required`. Alan çocuğun içinde de olabilir (arama kutusu, birim ekli girdi): etiketin bağlı olduğu öğe (`htmlFor`)
  // bulunur. Alanın kendi `aria-describedby`'si korunur; her çizimden sonra yeniden uygulanır.
  // `aria-invalid` burada eklenmez: `[aria-invalid='true']` kırmızı çerçeve çizer, alanı kırmızı yapmak çağıranın (görünüm) kararıdır.
  useIsoLayoutEffect(() => {
    if (!htmlFor) return;
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>(`[id="${htmlFor.replace(/["\\]/g, '\\$&')}"]`);
    if (!el) return;
    const own = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((x) => x && x !== noteId);
    const ids = note ? [...own, noteId] : own;
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
    if (required && !el.hasAttribute('aria-required') && !el.hasAttribute('required')) {
      el.setAttribute('aria-required', 'true');
      addedRequired.current = true;
    } else if (!required && addedRequired.current) {
      el.removeAttribute('aria-required');
      addedRequired.current = false;
    }
  });
  return (
    <div ref={ref} className={`fld${className ? ` ${className}` : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span id={noteId} className="err">
          {error}
        </span>
      ) : help ? (
        <span id={noteId} className="help">
          {help}
        </span>
      ) : null}
    </div>
  );
}

/** Birim ekli girdi (kg, cm, %, ₺). Genişlik sınıfları (`w-sm` …) sarmalayıcıya verilir. */
export function Affix({ sfx, className, children }: { sfx: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`affix${className ? ` ${className}` : ''}`}>
      {children}
      <span className="sfx" aria-hidden="true">
        {sfx}
      </span>
    </div>
  );
}

/** Klavyeyle de açılan tablo satırı (Enter, boşluk). */
export function rowProps(onActivate: () => void, selected: boolean) {
  return {
    className: `clickable${selected ? ' sel' : ''}`,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: ReactKeyboardEvent) => {
      // Satırın içindeki düğme, kutu ya da menüden gelen tuş satırı açmaz.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

// ---------- Sekmeler ----------
/**
 * Sekme listesinde klavye (WAI-ARIA sekme deseni, otomatik seçim): ←/→ komşu sekmeye, Home/End ilk ve son sekmeye geçer ve
 * onu seçer (tıklar). `role="tablist"` kabının `onKeyDown`'ı; sekmelerin `tabIndex`'i `tabStop` ile verilir.
 */
export function tabListKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (n) => !n.hasAttribute('disabled') && n.getAttribute('aria-disabled') !== 'true',
  );
  const at = tabs.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  const n = tabs.length;
  const to = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
  if (to < 0) return;
  e.preventDefault();
  tabs[to]!.focus();
  if (to !== at) tabs[to]!.click();
}

/** Gezici sekme durağı: Tab sekme listesine bir kez, seçili sekmeden girer (hiçbiri seçili değilse ilkinden). */
export function tabStop(index: number, selectedIndex: number): 0 | -1 {
  return index === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1;
}

// ---------- Pager ----------
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  label,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  /** Kayıt birimi ("fatura", "satır"); verilmezse "kayıt". */
  label?: string;
}) {
  const { t } = useTranslation('shell');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="tfoot">
      <span className="muted">{label ? t('common.rangeOfUnit', { from, to, total, label }) : t('common.rangeOf', { from, to, total })}</span>
      <div className="pager">
        <span className="muted s12">{t('common.pageOf', { page, pages })}</span>
        <button type="button" className="pager-btn" aria-label={t('common.prevPage')} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <Icon name="chevl" />
        </button>
        <button type="button" className="pager-btn" aria-label={t('common.nextPage')} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <Icon name="chevr" />
        </button>
      </div>
    </div>
  );
}

// ---------- Toast ----------
type ToastKind = 'ok' | 'err' | 'info';
export type ToastOptions = { /** Örn. "Geri al". */ action?: { label: string; onClick: () => void }; duration?: number; /** Bant bastırmasını (çevrimdışı, firma değişti) atlar. */ always?: boolean };
type ToastItem = { id: number; kind: ToastKind; title: string; text?: string; action?: ToastOptions['action']; duration: number };
type ToastFn = (title: string, text?: string, opts?: ToastOptions) => void;
type ToastApi = { ok: ToastFn; err: ToastFn; info: ToastFn };

let bridge: ToastApi | null = null;
/** Bileşen dışı koddan da çağrılabilir. */
export const toast: ToastApi = {
  ok: (t, x, o) => bridge?.ok(t, x, o),
  err: (t, x, o) => bridge?.err(t, x, o),
  info: (t, x, o) => bridge?.info(t, x, o),
};

/** Süre (ms): hata 7 sn, eylemli ("Geri al") 8 sn ki düğmeye uzanacak zaman olsun, diğerleri 4 sn. */
export function toastDuration(kind: ToastKind, opts?: ToastOptions): number {
  return opts?.duration ?? (kind === 'err' ? 7000 : opts?.action ? 8000 : 4000);
}

export interface ToastProviderProps {
  children: ReactNode;
  /**
   * `true` dönerse hata bildirimi gösterilmez (`always` hariç). Bant bastırmasına (firma değişti, bağlantı yok) ek
   * uygulama kuralı; DeciShip: oturum düşünce `() => sessionLostState() !== 'none'`.
   */
  suppress?: () => boolean;
  /**
   * Eylemli bildirimin yeri. `bottom` (varsayılan, Merkez): alt ortada ayrı yığın, sağ üstteki sayfa eylemini örtmez.
   * `stack` (DeciShip): diğer bildirimlerle aynı yığında.
   */
  actionPlacement?: 'bottom' | 'stack';
}

export function ToastProvider({ children, suppress, actionPlacement = 'bottom' }: ToastProviderProps) {
  const { t } = useTranslation('shell');
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const suppressRef = useRef(suppress);
  suppressRef.current = suppress;
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, title: string, text?: string, opts?: ToastOptions) => {
      // Bant (firma değişti, bağlantı yok) durumu zaten söylüyor: aynı hata bir de bildirim olmasın.
      if (kind === 'err' && !opts?.always) {
        const banner = sessionStatus.get();
        if (banner.orgChange || banner.offline || suppressRef.current?.()) return;
      }
      const id = ++seq.current;
      const duration = toastDuration(kind, opts);
      setItems((xs) => [...xs.filter((x) => !(x.title === title && x.text === text)), { id, kind, title, text, action: opts?.action, duration }].slice(-4));
    },
    [],
  );
  const api = useMemo<ToastApi>(
    () => ({ ok: (a, b, c) => push('ok', a, b, c), err: (a, b, c) => push('err', a, b, c), info: (a, b, c) => push('info', a, b, c) }),
    [push],
  );
  bridge = api;
  const stack = actionPlacement === 'stack';
  // Fare üstündeyken ya da odak bildirimdeyken süre durur (WCAG 2.2.1): "Geri al"a klavyeyle ulaşan kişi yetişir.
  const [paused, setPaused] = useState(false);
  const hover = useRef(false);
  const focus = useRef(false);
  const sync = () => setPaused(hover.current || focus.current);
  const holdProps = {
    onPointerEnter: () => {
      hover.current = true;
      sync();
    },
    onPointerLeave: () => {
      hover.current = false;
      sync();
    },
    onFocus: () => {
      focus.current = true;
      sync();
    },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      focus.current = false;
      sync();
    },
  };
  useEffect(() => {
    // Son bildirim kapanınca kap boşalır: içinde kalan durma bayrağı sonraki bildirimi tutmasın.
    if (items.length) return;
    hover.current = false;
    focus.current = false;
    setPaused(false);
  }, [items.length]);
  const item = (x: ToastItem) => (
    <ToastView key={x.id} x={x} paused={paused} stack={stack} onDismiss={dismiss} closeLabel={t('common.close')} />
  );
  // Canlı bölge (`role=status`) içerikten önce sayfada durur; içeriğiyle birlikte doğan bölgeyi ekran okuyucular çoğu kez okumaz.
  return (
    <>
      {children}
      {stack ? (
        <div className="toasts" role="status" aria-live="polite" {...holdProps}>
          {items.map(item)}
        </div>
      ) : (
        // Eylemli bildirim (Geri al) alt ortada: sağ üstteki sayfa eylemini örtmez.
        [items.filter((x) => !x.action), items.filter((x) => x.action)].map((group, i) => (
          <div key={i} className={`toasts${i ? ' is-bottom' : ''}`} role="status" aria-live="polite" {...holdProps}>
            {group.map(item)}
          </div>
        ))
      )}
    </>
  );
}

/** Tek bildirim. Süre kendi sayacında; `paused` iken kalan süre saklanır, bitince kaldığı yerden sürer. */
function ToastView({
  x,
  paused,
  stack,
  onDismiss,
  closeLabel,
}: {
  x: ToastItem;
  paused: boolean;
  stack: boolean;
  onDismiss: (id: number) => void;
  closeLabel: string;
}) {
  const left = useRef(x.duration);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(x.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [paused, x.id, onDismiss]);
  return (
    <div className={`toast ${x.kind}`} role={x.kind === 'err' ? 'alert' : undefined}>
      <Icon name={x.kind} />
      <div className="tx">
        <b>{x.title}</b>
        {x.text && <span className="s12">{x.text}</span>}
      </div>
      {x.action && (
        <button
          type="button"
          // `toast-act`: DeciShip'in eski sınıfı (yığında); stili `primitives.css`'te.
          className={stack ? 'toast-action toast-act' : 'toast-action'}
          onClick={() => {
            onDismiss(x.id);
            x.action!.onClick();
          }}
        >
          {x.action.label}
        </button>
      )}
      <button type="button" className="x" aria-label={closeLabel} onClick={() => onDismiss(x.id)}>
        <Icon name="close" />
      </button>
    </div>
  );
}
