import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Photo } from '../api/types';
import { PHOTO_KIND_LABEL } from '../lib/labels';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '@sellerondata/shell';
import { Icon } from './Icon';

export function PhotoStrip({ photos }: { photos: Photo[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  if (!photos.length) return <p className="muted s12">{t('photos.none')}</p>;
  return (
    <>
      <div className="thumbs">
        {photos.map((p, i) => (
          <button key={p.id} type="button" className="thumb" onClick={() => setOpen(i)} aria-label={t('photos.enlarge', { kind: PHOTO_KIND_LABEL[p.kind] })}>
            <img src={p.url} alt="" loading="lazy" />
            <div className="cap">{PHOTO_KIND_LABEL[p.kind] ?? t('photos.photo')}</div>
          </button>
        ))}
      </div>
      {open !== null && <Lightbox photos={photos} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

function Lightbox({ photos, index, onIndex, onClose }: { photos: Photo[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const n = photos.length;
  const go = useCallback((d: number) => onIndex((index + d + n) % n), [index, n, onIndex]);
  // Pencere gibi: Tab içeride döner, Esc kapatır, kapanınca odak büyütülen küçük resme döner.
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(true, ref, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, onClose]);
  const p = photos[index];
  return createPortal(
    <div ref={ref} className="lightbox" role="dialog" aria-modal="true" aria-label={t('photos.photo')} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <img src={p.url} alt={PHOTO_KIND_LABEL[p.kind]} />
      <div className="lb-cap">
        {PHOTO_KIND_LABEL[p.kind]} · {index + 1} / {n}
      </div>
      <button type="button" className="lb-close" aria-label={t('actions.close')} onClick={onClose} data-autofocus>
        <Icon name="close" />
      </button>
      {n > 1 && (
        <>
          <button type="button" className="lb-nav prev" aria-label={t('photos.prev')} onClick={() => go(-1)}>
            <Icon name="chevl" />
          </button>
          <button type="button" className="lb-nav next" aria-label={t('photos.next')} onClick={() => go(1)}>
            <Icon name="chevr" />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
