/**
 * Mesaj 14 geri alma bayrakları (MESAJ-14 §3). `false` yapılan ekran gizlenir; sunucu uçları yerinde kalır.
 * Her bayrak yalnız arayüzü kapatır: deneme turunu sunucuda `DEMO_TOUR=off` kapatır.
 */
export interface Features {
  /** "Fark var" ve "Tümü" sekmesinde satır seçimi ve seçim çubuğu (toplu karar). */
  bulkDecide: boolean;
  /** Faturalar listesinde arama kutusu ve durum süzgeci. */
  invoiceSearch: boolean;
  /** Kurulumda "örnek veriyle dene" kartı ve panelde deneme bandı. */
  demoTour: boolean;
}

export const FEATURES: Features = {
  bulkDecide: true,
  invoiceSearch: true,
  demoTour: true,
};
