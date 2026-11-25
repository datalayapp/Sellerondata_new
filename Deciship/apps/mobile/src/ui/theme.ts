import { Platform, type TextStyle } from 'react-native';
import { genBands, genColors, genHubColors, genNightChip, genRadius, genShadow, genSpace, genTouch } from './theme.generated';

/**
 * Renk, köşe, boşluk, dokunma ve gölge DEĞERLERİ üretilmiştir: Platform/packages/tokens/tokens.json (surfaces.mobile) -> theme.generated.ts.
 * Burada yalnız adlar, türler ve yazı tipleri durur.
 *
 * DeciShip mobil tasarım belirteçleri: D05 "Yoğun çalışma masası".
 *
 * Kâğıt zemin, beyaz kartlar (1 px çizgi, r6), kimliğe göre renkli üst çubuk (`bands`), ürün mavisi birincil eylem ve seçimde.
 * Depo kullanımı: dokunma hedefi ≥48 dp, sayı tuşları 52 dp.
 */
export const colors = genColors;

/**
 * Üst çubuk kimliği (web D09 bandıyla aynı renkler, `@sellerondata/shell` `bandTheme`).
 * `site`: giriş ve davet (gece mavisi). `hub`: Merkez grafit + güneş. `deciship`: ürün mavisi.
 */
export type BandKey = 'site' | 'hub' | 'deciship';
export type BandTheme = {
  bg: string;
  /** Basılı simge düğmesi */
  pressed: string;
  on: string;
  /** İkincil metin ("SellerOnData" alt satırı, adım metni) */
  on2: string;
  /** Adım çubuğu boş / dolu */
  track: string;
  trackOn: string;
};
export const bands: Record<BandKey, BandTheme> = genBands;

/** Merkez vurguları (web `data-sod-product='hub'`): bant dışı bağlantı gece mavisi, etkin işaret güneş. */
export const hubColors = genHubColors;

/** DeciShip mavi çubuğundaki bağlantı/kuyruk rozetleri (zemin / metin). Sorun durumları açık zeminle öne çıkar. */
export const nightChip = genNightChip;

/** D05: tek düğme yarıçapı r6 (birincil, ikincil, simge düğmeleri, kartlar). */
export const radius = genRadius;

/** Dokunma ölçüleri (dp). */
export const touch = genTouch;

/** Boşluk ölçeği: D05 sıkı (12 px kenar, 10 px kart arası). */
export const space = genSpace;

/** D05 düz yüzeyler: gölge yok; yalnız alt çubuk ve kayan bildirim hafif gölge taşır. */
export const shadow = genShadow;

/**
 * IBM Plex yalnızca Android'de gömülü (plugins/with-fonts.js). Android'de ağırlığı dosya seçer;
 * fontWeight verilmez ki sahte kalınlaştırma olmasın. iOS sistem yazı tipine düşer.
 */
const android = Platform.OS === 'android';
const fam = (file: string, weight: TextStyle['fontWeight'], fallback?: string): TextStyle =>
  android ? { fontFamily: file } : { fontWeight: weight, ...(fallback ? { fontFamily: fallback } : null) };

export const font = {
  regular: fam('IBMPlexSans-Regular', '400'),
  medium: fam('IBMPlexSans-Medium', '500'),
  semibold: fam('IBMPlexSans-SemiBold', '600'),
  bold: fam('IBMPlexSans-Bold', '700'),
  mono: { ...fam('IBMPlexMono-Regular', '400', 'Menlo'), fontVariant: ['tabular-nums'] } as TextStyle,
  monoMedium: { ...fam('IBMPlexMono-Medium', '500', 'Menlo'), fontVariant: ['tabular-nums'] } as TextStyle,
  monoSemibold: { ...fam('IBMPlexMono-SemiBold', '600', 'Menlo'), fontVariant: ['tabular-nums'] } as TextStyle,
} as const;

/**
 * Tipografi ölçeği (D05): gövde 13–14, sayfa başlığı 18/600, bölüm başlığı 13/600, etiket 12/500.
 * Sayılar (ağırlık, ölçü, desi) ayrı ve büyük: `num`.
 */
export const type = {
  body: { fontSize: 14, lineHeight: 20, color: colors.text, ...font.regular } as TextStyle,
  small: { fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular } as TextStyle,
  label: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium } as TextStyle,
  /** Bölüm / kart başlığı (`.sh`) */
  cardTitle: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold } as TextStyle,
  /** Satır başlığı (`.mc-t`) */
  rowTitle: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.semibold } as TextStyle,
  title: { fontSize: 18, lineHeight: 24, color: colors.text, ...font.semibold } as TextStyle,
  pageTitle: { fontSize: 18, lineHeight: 24, color: colors.text, ...font.semibold } as TextStyle,
  /** Kayıt kimliği (takip no): mono */
  id: { fontSize: 12, lineHeight: 17, color: colors.text, ...font.mono } as TextStyle,
  /** Büyük sayı göstergesi (`.disp .v`) */
  display: { fontSize: 40, lineHeight: 46, color: colors.text, ...font.semibold, fontVariant: ['tabular-nums'] } as TextStyle,
  /** Ücretli ağırlık gibi vurgulu sonuç (`.chg .v`) */
  result: { fontSize: 24, lineHeight: 28, color: colors.primaryHover, ...font.semibold, fontVariant: ['tabular-nums'] } as TextStyle,
} as const;

/** Geriye dönük: eski kod `mono` sabitini kullanıyordu. */
export const mono = android ? 'IBMPlexMono-Regular' : 'Menlo';
