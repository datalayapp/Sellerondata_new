import Svg, { Path, Rect } from 'react-native-svg';

/**
 * DeciShip marka işareti (ölçülmüş koli). Web'deki components/Brand.tsx ve /brand/deciship-mark.svg ile aynı çizim.
 */
/** SellerOnData işareti: gece mavisi, S, ölçü sarısı çizgi. Çizim `Platform/brand` ile aynı. */
export function SellerOnDataMark({ size = 56 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessible={false}>
      <Rect width={64} height={64} rx={14} fill="#0f2a5c" />
      <Path d="M46 18H22a5 5 0 0 0-5 5v4a5 5 0 0 0 5 5h20a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H24" fill="none" stroke="#fff" strokeWidth={5.5} strokeLinecap="round" />
      <Path d="M24 46H16" stroke="#fdb022" strokeWidth={5.5} strokeLinecap="round" />
    </Svg>
  );
}

/** DeciShip işaretinin 24 px altı biçimi: `brand/deciship-mark-small.svg`. Başlıkta ürün adının yanında. */
export function BrandMarkSmall({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" accessible={false}>
      <Rect width={16} height={16} rx={3.6} fill="#1d5bd8" />
      <Path d="M3.4 4.9L8 7.5L8 12L3.4 9.4ZM8 7.5L12.6 4.9L12.6 9.4L8 12Z" fill="none" stroke="#fff" strokeWidth={1.45} strokeLinejoin="round" strokeLinecap="round" />
      <Path d="M8 2.3L12.6 4.9L8 7.5L3.4 4.9Z" fill="#fff" stroke="#fff" strokeWidth={1.45} strokeLinejoin="round" strokeLinecap="round" />
      <Path d="M3.4 11.5L8 14.1" fill="none" stroke="#fdb022" strokeWidth={1.09} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

export function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessible={false}>
      <Rect width={64} height={64} rx={14} fill="#1d5bd8" />
      <Path d="M18 20L32 28L32 44.5L18 36.5ZM32 28L46 20L46 36.5L32 44.5Z" fill="none" stroke="#fff" strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
      <Path d="M32 12L46 20L32 28L18 20Z" fill="#fff" stroke="#fff" strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
      <Path d="M39 16L25 24" stroke="#1d5bd8" strokeWidth={2.8} strokeLinecap="round" />
      <Path d="M18 43L32 51M18 40.6v4.8M32 48.6v4.8" fill="none" stroke="#fdb022" strokeWidth={2.63} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}
