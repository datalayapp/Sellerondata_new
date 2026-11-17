import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { DiffType } from '../api/types';

/**
 * Noktalı alt çizgili terim: üzerine gelince, klavyeyle odaklanınca ya da dokununca küçük baloncukta anlamı yazar
 * (özetteki "i" balonunun görünümü, `.inv-sum-tip`). Açıklama `aria-describedby` ile bağlıdır: ekran okuyucu baloncuk
 * açılmadan da okur. Görünen baloncuk gövdeye taşınır; tablo kaydırma alanı ya da kapsayıcı sorgusu onu kırpmaz.
 * Dokunma satırı açmaz (tıklama yukarı çıkmaz); fare tıklaması ve Enter bugünkü gibi satıra gider.
 */
export function TermHint({ children, hint }: { children: ReactNode; hint: string }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // dokunmada odak da açar: tıklama, dokunmadan önceki duruma göre açar ya da kapatır
  const tap = useRef<{ touch: boolean; wasOpen: boolean }>({ touch: false, wasOpen: false });

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = tip.current?.offsetWidth ?? 0;
    const h = tip.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 && r.top - 6 - h >= 8 ? r.top - 6 - h : below;
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const outside = (e: PointerEvent) => {
      if (!btn.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="term"
        aria-describedby={id}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setOpen(false)}
        onPointerDown={(e) => {
          tap.current = { touch: e.pointerType !== 'mouse', wasOpen: open };
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          // açık baloncuğu kapatan Escape, yan paneli de kapatmasın
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onClick={(e) => {
          if (!tap.current.touch) return;
          e.stopPropagation();
          setOpen(!tap.current.wasOpen);
          tap.current = { touch: false, wasOpen: false };
        }}
      >
        {children}
      </button>
      <span id={id} hidden>
        {hint}
      </span>
      {open &&
        createPortal(
          <span
            ref={tip}
            className="term-tip"
            aria-hidden="true"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            {hint}
          </span>,
          document.body,
        )}
    </>
  );
}

/** Açıklaması olan fark türleri (şimdilik yalnız mükerrer). */
const DIFF_HINT_KEYS: readonly DiffType[] = ['DUPLICATE'];

/** Fark türü etiketi; açıklaması varsa noktalı alt çizgi ve baloncukla. */
export function DiffTypeLabel({ type, label }: { type: DiffType; label: string }) {
  const { t } = useTranslation('common');
  if (!DIFF_HINT_KEYS.includes(type)) return <>{label}</>;
  return <TermHint hint={t(`diffHint.${type}`)}>{label}</TermHint>;
}
