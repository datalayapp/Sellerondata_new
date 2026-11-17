import { useEffect, useRef, type ReactNode } from 'react';
import { ActionMenu as ShellActionMenu, Button, Tag, type ActionMenuProps } from '@sellerondata/shell';
import type { Decision, DiffType, LineStatus } from '../api/types';
import { DECISION_LABEL, DECISION_TONE, DIFF_LABEL, STATUS_LABEL, STATUS_TONE } from '../lib/labels';
import { ApiError } from '../api/client';
import { useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import { DiffTypeLabel } from './TermHint';

/*
 * Temel bileşenler kabuktan gelir (`Platform/packages/shell/src/primitives.tsx`); Merkez ile aynı bileşen, aynı sınıf adları.
 * Burada yalnız DeciShip'e özgü olanlar kalır: durum rozetleri, yan panel, `errorMessage`.
 * Sayfalar içe aktarmayı buradan yapmaya devam eder.
 */
export {
  Affix,
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  Modal,
  ModalAction,
  PageHeader,
  Pager,
  Skel,
  TableSkeleton,
  Tag,
  rowProps,
  tabListKeyDown,
  tabStop,
  type PageHeaderProps,
} from '@sellerondata/shell';

/** Status pill: soft background + dark text + 6px dot. Same as Tag; prefer this name in new code. */
export const StatusPill = Tag;

// ---------- ActionMenu ----------
// Ikincil eylemleri tek "Diğer" düğmesinde toplar. Liste gövdeye taşınır ve kabuğun `placeMenu` yerleşimiyle ekrandan taşmaz;
// "⋯" düğmesi `.btn.btn-secondary.btn-icon.amenu-dots` biçiminde ve kendi çizimiyle (`dotsnarrow`).
export function ActionMenu(props: ActionMenuProps) {
  return <ShellActionMenu dotsTrigger="button" dotsIcon="dotsnarrow" {...props} />;
}

// ---------- Tags ----------
export function StatusTag({ status }: { status: LineStatus }) {
  return <Tag tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Tag>;
}
export function DecisionTag({ decision }: { decision: Decision }) {
  if (decision === 'OPEN') return null;
  return <Tag tone={DECISION_TONE[decision]}>{DECISION_LABEL[decision]}</Tag>;
}
export function DiffTags({ types }: { types: DiffType[] }) {
  if (!types.length) return null;
  return (
    <span className="tags">
      {types.map((t, i) => (
        <Tag key={t} tone={i === 0 ? 'red' : 'gray'} small>
          <DiffTypeLabel type={t} label={DIFF_LABEL[t]} />
        </Tag>
      ))}
    </span>
  );
}

// ---------- Errors ----------
/** Bildirim ve satır içi hata metni: sunucunun söylediği neden, yoksa genel metin. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return i18n.t('error.unexpected');
}

// ---------- Side panel ----------
export function SidePanel({
  meta,
  title,
  onClose,
  children,
  actions,
}: {
  meta?: ReactNode;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.overlay, .lightbox')) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // ≥1280 the panel is sticky beside the list but starts below the page header. Publish its
  // visible top offset as --pn-top so CSS sizes it to the visible area (footer stays on screen).
  const ref = useRef<HTMLElement>(null);
  // Below 1280 the panel covers the list: move focus into it, and give it back when it closes.
  useEffect(() => {
    if (!window.matchMedia('(max-width: 1279px)').matches) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    el?.focus({ preventScroll: true });
    return () => {
      const a = document.activeElement;
      if (prev?.isConnected && (!a || a === document.body || el?.contains(a) || !a.isConnected)) prev.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let last = -1;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = Math.max(0, Math.round(el.getBoundingClientRect().top));
        if (top !== last) el.style.setProperty('--pn-top', `${(last = top)}px`);
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(document.documentElement);
    window.addEventListener('scroll', sync, { passive: true, capture: true });
    window.addEventListener('resize', sync);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('scroll', sync, { capture: true });
      window.removeEventListener('resize', sync);
    };
  }, []);
  return (
    <aside ref={ref} className="panel overlay-sm" aria-label={t('panel.details')} tabIndex={-1}>
      <div className="panel-head">
        {meta && <div className="panel-meta">{meta}</div>}
        <h2 className="panel-title">{title}</h2>
        <Button kind="plain" icon="close" className="panel-close" aria-label={t('panel.close')} onClick={onClose} />
      </div>
      <div className="panel-body">{children}</div>
      {actions && <div className="panel-actions">{actions}</div>}
    </aside>
  );
}
