import { useEffect, useId } from 'react';
import { setDetailTitle, setShellTitle } from '../lib/pageTitle';

/*
 * DeciShip marka işareti: ölçülmüş koli (izometrik koli + bant) ve altında ölçü çizgisi.
 * Kaynak SVG'ler ve kullanım kuralları: /brand (README.md). Buradaki yollar oradakilerle birebir aynıdır.
 */

const BLUE = '#1d5bd8';
const AMBER = '#fdb022';
const J = { strokeLinejoin: 'round', strokeLinecap: 'round' } as const;

/** Mavi kare üstünde beyaz koli. 24 px ve altında sadeleştirilmiş (bantsız) çizim kullanılır. */
export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  const cls = `brand-logo${className ? ` ${className}` : ''}`;
  if (size <= 24) {
    return (
      <svg className={cls} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
        <rect width="16" height="16" rx="3.6" fill={BLUE} />
        <path d="M3.4 4.9L8 7.5L8 12L3.4 9.4ZM8 7.5L12.6 4.9L12.6 9.4L8 12Z" fill="none" stroke="#fff" strokeWidth="1.45" {...J} />
        <path d="M8 2.3L12.6 4.9L8 7.5L3.4 4.9Z" fill="#fff" stroke="#fff" strokeWidth="1.45" {...J} />
        <path d="M3.4 11.5L8 14.1" fill="none" stroke={AMBER} strokeWidth="1.09" {...J} />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill={BLUE} />
      <path d="M18 20L32 28L32 44.5L18 36.5ZM32 28L46 20L46 36.5L32 44.5Z" fill="none" stroke="#fff" strokeWidth="3.5" {...J} />
      <path d="M32 12L46 20L32 28L18 20Z" fill="#fff" stroke="#fff" strokeWidth="3.5" {...J} />
      <path d="M39 16L25 24" stroke={BLUE} strokeWidth="2.8" strokeLinecap="round" />
      <path d="M18 43L32 51M18 40.6v4.8M32 48.6v4.8" fill="none" stroke={AMBER} strokeWidth="2.63" {...J} />
    </svg>
  );
}

/** Tek renkli, zeminsiz çizim (currentColor). Boş durum / 404 çizimleri ve dekor için. */
export function BrandGlyph({ size = 64, className, strokeWidth = 3.5 }: { size?: number; className?: string; strokeWidth?: number }) {
  const id = `ds-tape${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className={className} viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <path d="M39 16L25 24" stroke="#000" strokeWidth={strokeWidth * 0.8} strokeLinecap="round" />
      </mask>
      <path d="M18 20L32 28L32 44.5L18 36.5ZM32 28L46 20L46 36.5L32 44.5Z" stroke="currentColor" strokeWidth={strokeWidth} {...J} />
      <path d="M32 12L46 20L32 28L18 20Z" fill="currentColor" stroke="currentColor" strokeWidth={strokeWidth} {...J} mask={`url(#${id})`} />
      <path className="brand-dim" d="M18 43L32 51M18 40.6v4.8M32 48.6v4.8" stroke="currentColor" strokeWidth={strokeWidth * 0.75} {...J} />
    </svg>
  );
}

/** İşaret + "DeciShip" yazısı (yazı HTML; IBM Plex Sans 600). */
export function BrandLogo({ size = 36, sub }: { size?: number; sub?: string }) {
  return (
    <span className="brand-lockup">
      <BrandMark size={size} />
      <span className="brand-txt">
        <span className="brand-name">DeciShip</span>
        {sub && (
          <span className="brand-co ellipsis" title={sub}>
            {sub}
          </span>
        )}
      </span>
    </span>
  );
}

/** Sekme başlığı: "DeciShip — Sayfa". Sayfanın kendi başlığı (usePageTitle) varsa o önceliklidir. */
export function useDocumentTitle(page?: string | null) {
  useEffect(() => {
    setShellTitle(page);
  }, [page]);
}

/** Ayrıntı sayfası başlığı (ör. "Fatura 123"); boşken ya da sayfadan çıkınca Shell'in sayfa adı gelir. */
export function usePageTitle(detail?: string | null) {
  useEffect(() => {
    if (!detail) return;
    setDetailTitle(detail);
    return () => setDetailTitle(null);
  }, [detail]);
}
