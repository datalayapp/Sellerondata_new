import type { JSX, ReactNode } from 'react';
import { PRODUCTS, PRODUCT_PALETTE, type ProductKey } from '@sellerondata/contracts';

/*
 * Platform ve ürün işaretleri. Yollar `Platform/brand` ve `Deciship/brand` ile birebir aynıdır.
 * Ölçü sarısı (#fdb022) yalnız işarette durur. Zemin rengi katalogdan gelir, tek kaynak `contracts`.
 */
const AMBER = '#fdb022';
const INK = '#0f2a5c';

/**
 * Uygulamalar düğmesinin simgesi (⊞, F1-b): dört kare; üçü uygulama renkleri (DeciShip, OrderLoom, TagPress),
 * dördüncüsü SellerOnData laciverti. Renkler katalogdan; yalnız süs (aria-hidden), adı düğmede.
 */
export function AppsGlyph({ size = 24 }: { size?: number }) {
  const sq = (x: number, y: number, fill: string) => <rect x={x} y={y} width="7" height="7" rx="2" fill={fill} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {sq(4, 4, PRODUCT_PALETTE.deciship.main)}
      {sq(13, 4, PRODUCT_PALETTE.orderloom.main)}
      {sq(4, 13, PRODUCT_PALETTE.tagpress.main)}
      {sq(13, 13, INK)}
    </svg>
  );
}
const J = { strokeLinejoin: 'round', strokeLinecap: 'round' } as const;

type MarkProps = { size?: number; className?: string };

function Svg({ size = 32, className, children, viewBox = '0 0 64 64' }: MarkProps & { children: ReactNode; viewBox?: string }) {
  return (
    <svg className={['sod-mark', className].filter(Boolean).join(' ')} viewBox={viewBox} width={size} height={size} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/**
 * SellerOnData S işareti: gece mavisi kare, beyaz S, ölçü sarısı çizgi.
 * `reverse` koyu zemin içindir (kare kaybolmasın). 24 px ve altında küçük çizim kullanılır.
 */
export function SellerOnDataMark({ size = 32, className, variant = 'default' }: MarkProps & { variant?: 'default' | 'reverse' }) {
  const tile = variant === 'reverse' ? '#fff' : INK;
  const ink = variant === 'reverse' ? INK : '#fff';
  if (size <= 24) {
    return (
      <Svg size={size} className={className} viewBox="0 0 16 16">
        <rect width="16" height="16" rx="3.6" fill={tile} />
        <path d="M12.2 3.6H6A2.2 2.2 0 0 0 6 8H10A2.2 2.2 0 0 1 10 12.4H8.4" fill="none" stroke={ink} strokeWidth="2" {...J} />
        <path d="M8.4 12.4H4.2" stroke={AMBER} strokeWidth="2" strokeLinecap="round" />
      </Svg>
    );
  }
  return (
    <Svg size={size} className={className}>
      <rect width="64" height="64" rx="14" fill={tile} />
      <path d="M46 18H22a5 5 0 0 0-5 5v4a5 5 0 0 0 5 5h20a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H24" fill="none" stroke={ink} strokeWidth="5.5" strokeLinecap="round" />
      <path d="M24 46H16" stroke={AMBER} strokeWidth="5.5" strokeLinecap="round" />
    </Svg>
  );
}

function DeciShipMark({ size = 32, className }: MarkProps) {
  const color = PRODUCTS.deciship.color;
  if (size <= 24) {
    return (
      <Svg size={size} className={className} viewBox="0 0 16 16">
        <rect width="16" height="16" rx="3.6" fill={color} />
        <path d="M3.4 4.9L8 7.5L8 12L3.4 9.4ZM8 7.5L12.6 4.9L12.6 9.4L8 12Z" fill="none" stroke="#fff" strokeWidth="1.45" {...J} />
        <path d="M8 2.3L12.6 4.9L8 7.5L3.4 4.9Z" fill="#fff" stroke="#fff" strokeWidth="1.45" {...J} />
        <path d="M3.4 11.5L8 14.1" fill="none" stroke={AMBER} strokeWidth="1.09" {...J} />
      </Svg>
    );
  }
  return (
    <Svg size={size} className={className}>
      <rect width="64" height="64" rx="14" fill={color} />
      <path d="M18 20L32 28L32 44.5L18 36.5ZM32 28L46 20L46 36.5L32 44.5Z" fill="none" stroke="#fff" strokeWidth="3.5" {...J} />
      <path d="M32 12L46 20L32 28L18 20Z" fill="#fff" stroke="#fff" strokeWidth="3.5" {...J} />
      <path d="M39 16L25 24" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
      <path d="M18 43L32 51M18 40.6v4.8M32 48.6v4.8" fill="none" stroke={AMBER} strokeWidth="2.63" {...J} />
    </Svg>
  );
}

function OrderLoomMark({ size, className }: MarkProps) {
  return (
    <Svg size={size} className={className}>
      <rect width="64" height="64" rx="14" fill={PRODUCTS.orderloom.color} />
      <path d="M26 21h21M26 32h21M26 43h21" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
      <path d="M15.5 21l2.6 2.6 4-4.6M15.5 32l2.6 2.6 4-4.6" fill="none" stroke="#fff" strokeWidth="3" {...J} />
      <circle cx="18.5" cy="43" r="3.6" fill={AMBER} />
    </Svg>
  );
}

function TagPressMark({ size, className }: MarkProps) {
  const color = PRODUCTS.tagpress.color;
  return (
    <Svg size={size} className={className}>
      <rect width="64" height="64" rx="14" fill={color} />
      <circle cx="32" cy="32" r="14" fill="#fff" />
      <path d="M26 34c2-5 4-7 6-7 1.5 0 1.5 2-.5 4s-1.5 4 .5 4c2.5 0 4-2 6-4" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M12 19v-7h7M52 19v-7h-7M12 45v7h7M52 45v7h-7" fill="none" stroke={AMBER} strokeWidth="3" {...J} />
    </Svg>
  );
}

/** Çizimi olmayan araç: ürün renginde yuvarlak kare ve adın ilk harfi beyaz (kayıttaki `mark` yoksa da bu çizilir). */
function MonogramMark({ product, size = 32, className }: MarkProps & { product: ProductKey }) {
  const { color, name } = PRODUCTS[product];
  const letter = (Array.from(name.trim())[0] ?? '?').toLocaleUpperCase('tr');
  return (
    <Svg size={size} className={className}>
      <rect width="64" height="64" rx="14" fill={color} />
      <text x="32" y="32" textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize="36" fontWeight="700" fontFamily="system-ui, sans-serif">
        {letter}
      </text>
    </Svg>
  );
}

/** Marka varlığı olan araçların çizimleri. Burada olmayan araç `MonogramMark` ile çizilir. */
const MARKS: Partial<Record<ProductKey, (p: MarkProps) => JSX.Element>> = {
  deciship: DeciShipMark,
  orderloom: OrderLoomMark,
  tagpress: TagPressMark,
};

/** Etkin alan: Merkez ("hub") veya bir ürün. */
export type ShellProduct = ProductKey | 'hub';

/** Ürün işareti. `product` "hub" ise SellerOnData S işareti çizilir. */
export function ProductMark({ product, size, className, onDark }: MarkProps & { product: ShellProduct; onDark?: boolean }) {
  if (product === 'hub') return <SellerOnDataMark size={size} className={className} variant={onDark ? 'reverse' : 'default'} />;
  const Mark = MARKS[product];
  if (!Mark) return <MonogramMark product={product} size={size} className={className} />;
  return <Mark size={size} className={className} />;
}

const FAVICONS: Partial<Record<ShellProduct, string>> = {
  hub: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.6" fill="${INK}"/><path d="M12.2 3.6H6A2.2 2.2 0 0 0 6 8H10A2.2 2.2 0 0 1 10 12.4H8.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.4 12.4H4.2" stroke="${AMBER}" stroke-width="2" stroke-linecap="round"/></svg>`,
  deciship: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.6" fill="${PRODUCTS.deciship.color}"/><path d="M3.4 4.9L8 7.5L8 12L3.4 9.4ZM8 7.5L12.6 4.9L12.6 9.4L8 12Z" fill="none" stroke="#fff" stroke-width="1.45" stroke-linejoin="round"/><path d="M8 2.3L12.6 4.9L8 7.5L3.4 4.9Z" fill="#fff" stroke="#fff" stroke-width="1.45" stroke-linejoin="round"/><path d="M3.4 11.5L8 14.1" fill="none" stroke="${AMBER}" stroke-width="1.09" stroke-linecap="round"/></svg>`,
};

function monogramFavicon(product: ProductKey): string {
  const { color, name } = PRODUCTS[product];
  const letter = (Array.from(name.trim())[0] ?? '?').toLocaleUpperCase('tr');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.6" fill="${color}"/><text x="8" y="8.4" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="9.5" font-weight="700" font-family="system-ui,sans-serif">${letter.replace(/[<>&"]/g, '')}</text></svg>`;
}

/** Sekme simgesi. Sekme başlığı ile birlikte etkin aracı gösterir. */
export function faviconHref(product: ShellProduct): string | null {
  const s = FAVICONS[product] ?? (product === 'hub' ? undefined : monogramFavicon(product));
  return s ? `data:image/svg+xml,${encodeURIComponent(s)}` : null;
}
