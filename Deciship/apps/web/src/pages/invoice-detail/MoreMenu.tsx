import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../../components/Icon';
import { placeMenu, visibleBounds, type MenuPlacement } from '@sellerondata/shell';

export interface MoreItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  /** verilirse yeni sekmede açılan bağlantı (menü öğesi rolüyle) */
  href?: string;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * "⋯" düğmesi: nadir eylemler tek menüde. Liste gövdeye taşınır (tablo ve kart kırpmasına takılmaz), düğmenin altına
 * hizalanır; altta yer yoksa üstüne açılır (`@sellerondata/shell` `placeMenu`).
 * Klavye: ↑/↓ gezinir, Esc kapatıp odağı düğmeye döndürür, Tab ve dışarı tıklama kapatır. Satır içinde kullanılınca tıklama satıra geçmez.
 */
export function MoreMenu({ label, items, busy, disabled, className }: { label: string; items: MoreItem[]; busy?: boolean; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  // Liste önce gizli çizilip ölçülür; altta yer yoksa (sayfanın son satırları) düğmenin üstüne açılır,
  // telefonda alttaki uygulama çubuğunun arkasında kalmaz. Kaydırmada aynı kuralla yeniden konur.
  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    const el = list.current;
    if (!r || !el) return;
    const prev = el.style.maxHeight;
    el.style.maxHeight = ''; // doğal yükseklik ölçülsün
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    el.style.maxHeight = prev;
    setPos(placeMenu(r, size, visibleBounds(), 'right'));
  };

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!list.current?.contains(n) && !trigger.current?.contains(n)) setOpen(false);
    };
    const close = () => place(); // kaydırma/yeniden boyutta liste düğmeyle birlikte kayar, kapanmaz
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  // liste konumlanınca (ilk çizimden sonra) ilk öğeye odaklan
  const placed = pos !== null;
  useEffect(() => {
    if (open && placed) list.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open, placed]);

  const onKeyDown = (e: KeyboardEvent) => {
    // Menü satırın içindedir: Enter ve boşluk (menü kapalıyken de) satıra ulaşıp paneli açmasın.
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
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
      const all = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      all[(e.key === 'ArrowDown' ? i + 1 : i - 1 + all.length) % all.length]?.focus();
    }
  };

  return (
    <span className={`mm${className ? ` ${className}` : ''}`} onKeyDown={onKeyDown} onClick={(e: MouseEvent) => e.stopPropagation()}>
      <button
        ref={trigger}
        type="button"
        className="mm-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-busy={busy || undefined}
        disabled={disabled}
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
            className="mm-list"
            role="menu"
            id={id}
            data-up={pos?.up || undefined}
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? 'visible' : 'hidden',
              ...(pos?.maxHeight !== undefined ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : null),
            }}
          >
            {items.map((it) =>
              it.href ? (
                <a
                  key={it.label}
                  role="menuitem"
                  href={it.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                >
                  {it.icon && <Icon name={it.icon} />}
                  {it.label}
                </a>
              ) : (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  className={it.danger ? 'danger' : undefined}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                    it.onSelect?.();
                  }}
                >
                  {it.icon && <Icon name={it.icon} />}
                  {it.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
