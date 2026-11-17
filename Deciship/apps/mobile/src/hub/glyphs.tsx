import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { ProductKey } from './contracts';
import { PRODUCTS } from './contracts';

/** `ui/Icon.tsx`te olmayan Merkez ikonları. Aynı çizgi kalınlığı ve uç biçimi. */
export type GlyphName = 'up' | 'down' | 'flat' | 'external';

export function Glyph({ name, size = 16, color, strokeWidth = 2 }: { name: GlyphName; size?: number; color: string; strokeWidth?: number }) {
  const p = { stroke: color, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'up' ? <Path d="M12 20V5M6 11l6-6 6 6" {...p} /> : null}
      {name === 'down' ? <Path d="M12 4v15M6 13l6 6 6-6" {...p} /> : null}
      {name === 'flat' ? <Path d="M5 12h14" {...p} /> : null}
      {name === 'external' ? <Path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" {...p} /> : null}
    </Svg>
  );
}

const AMBER = '#fdb022';
const J = { strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };

/**
 * Ürün işareti. Çizimler sitedeki işaretlerle aynı
 * (`Platform/packages/shell/src/marks.tsx`); renk katalogdan (`PRODUCTS`). DeciShip 24 px ve altında küçük çizimle.
 */
export function ProductMark({ product, size = 20, muted }: { product: ProductKey; size?: number; muted?: boolean }) {
  const color = PRODUCTS[product].color;
  const small = product === 'deciship' && size <= 24;
  return (
    <Svg width={size} height={size} viewBox={small ? '0 0 16 16' : '0 0 64 64'} opacity={muted ? 0.45 : 1}>
      {product === 'deciship' && !small ? (
        <>
          <Rect width="64" height="64" rx="14" fill={color} />
          <Path d="M18 20L32 28L32 44.5L18 36.5ZM32 28L46 20L46 36.5L32 44.5Z" fill="none" stroke="#fff" strokeWidth="3.5" {...J} />
          <Path d="M32 12L46 20L32 28L18 20Z" fill="#fff" stroke="#fff" strokeWidth="3.5" {...J} />
          <Path d="M39 16L25 24" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
          <Path d="M18 43L32 51M18 40.6v4.8M32 48.6v4.8" fill="none" stroke={AMBER} strokeWidth="2.63" {...J} />
        </>
      ) : null}
      {small ? (
        <>
          <Rect width="16" height="16" rx="3.6" fill={color} />
          <Path d="M3.4 4.9L8 7.5L8 12L3.4 9.4ZM8 7.5L12.6 4.9L12.6 9.4L8 12Z" fill="none" stroke="#fff" strokeWidth="1.45" {...J} />
          <Path d="M8 2.3L12.6 4.9L8 7.5L3.4 4.9Z" fill="#fff" stroke="#fff" strokeWidth="1.45" {...J} />
          <Path d="M3.4 11.5L8 14.1" fill="none" stroke={AMBER} strokeWidth="1.09" {...J} />
        </>
      ) : null}
      {product === 'orderloom' ? (
        <>
          <Rect width="64" height="64" rx="14" fill={color} />
          <Path d="M26 21h21M26 32h21M26 43h21" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
          <Path d="M15.5 21l2.6 2.6 4-4.6M15.5 32l2.6 2.6 4-4.6" fill="none" stroke="#fff" strokeWidth="3" {...J} />
          <Circle cx="18.5" cy="43" r="3.6" fill={AMBER} />
        </>
      ) : null}
      {product === 'tagpress' ? (
        <>
          <Rect width="64" height="64" rx="14" fill={color} />
          <Circle cx="32" cy="32" r="14" fill="#fff" />
          <Path d="M26 34c2-5 4-7 6-7 1.5 0 1.5 2-.5 4s-1.5 4 .5 4c2.5 0 4-2 6-4" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
          <Path d="M12 19v-7h7M52 19v-7h-7M12 45v7h7M52 45v7h-7" fill="none" stroke={AMBER} strokeWidth="3" {...J} />
        </>
      ) : null}
    </Svg>
  );
}
