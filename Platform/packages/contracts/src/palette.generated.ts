// ÜRETİLDİ: elle düzenlemeyin; kaynak Platform/packages/tokens/tokens.json (node Platform/packages/tokens/build.mjs).

/** Ürün paleti: ana / hero zemini / koyu zeminde açık ton / açık zemin / kâğıtta metin. */
export type ProductPalette = { main: string; hero: string; onDark: string; soft: string; text: string };

export const PRODUCT_PALETTE: Record<'deciship' | 'orderloom' | 'tagpress', ProductPalette> = {
  deciship: {
    main: '#1d5bd8',
    hero: '#1546b8',
    onDark: '#b5cbff',
    soft: '#e8eefc',
    text: '#1546b8',
  },
  orderloom: {
    main: '#0e9384',
    hero: '#075e55',
    onDark: '#7de8d9',
    soft: '#e3f5f2',
    text: '#0b6b60',
  },
  tagpress: {
    main: '#7a5af8',
    hero: '#3d2a99',
    onDark: '#cfc3ff',
    soft: '#efebff',
    text: '#5b3fd6',
  },
};
