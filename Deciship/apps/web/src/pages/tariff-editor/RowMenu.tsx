import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../../components/Icon';
import { placeMenu, visibleBounds, type MenuPlacement } from '@sellerondata/shell';

export interface RowMenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * ⋯ menüsü: nadir eylemleri tek düğmede toplar. Liste tarayıcı katmanında (portal) açılır; böylece kaydırılan
 * tablo ya da kırpılan kart onu kesmez. Klavye: ↑/↓ gezinir, Esc kapatır ve odağı düğmeye döndürür.
 */
export function RowMenu({ label, items, busy, align = 'right' }: { label: string; items: RowMenuItem[]; busy?: boolean; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  // Liste önce gizli çizilir, ölçülür, sonra yerine konur: altta yer yoksa (panelin alt eylem satırı,
  // sayfanın son satırı) yukarı açılır; telefonda alttaki uygulama çubuğunun arkasında kalmaz.
  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const size = { width: list.current?.offsetWidth ?? 220, height: list.current?.offsetHeight ?? 0 };
    setPos(placeMenu(r, size, visibleBounds(), align));
  };
  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open]);
  // gizli (ölçülen) listeye odak verilemez: yerine konduktan sonra ilk öğeye odaklan
  const placed = pos !== null;
  useEffect(() => {
    if (open && placed) list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, placed]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!list.current?.contains(n) && !trigger.current?.contains(n)) setOpen(false);
    };
    // listenin kendi içinde kaydırılması (yüksekliği sınırlandıysa) menüyü kapatmaz
    const close = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    }
  };

  return (
    <span className="rmenu" onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()}>
      <button
        ref={trigger}
        type="button"
        className="rmenu-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? (
          <Icon name="spin" className="spin" />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            className="amenu-list rmenu-list"
            role="menu"
            id={id}
            data-up={pos?.up || undefined}
            style={{
              position: 'fixed',
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? 'visible' : 'hidden',
              ...(pos?.maxHeight !== undefined ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : null),
            }}
            onKeyDown={onKeyDown}
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={it.danger ? 'is-danger' : undefined}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} />}
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
