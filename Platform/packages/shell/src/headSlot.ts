import { createContext, useContext } from 'react';

/**
 * Bandın boyu. `standard`: tüm sayfalar, içerikten bağımsız sabit yükseklik. `hero`: yalnız Genel Bakış ve Pano.
 * `none`: başlık yok (yükleniyor); standart ile aynı yükseklik, sayfa gelince zıplamaz.
 * `work`: Tezgâh çalışma bandı (TagPress): 72 px üst satır + 44 px iş satırı, alt boşluk yok, kenardan kenara;
 * iş satırı başlık bölgesine (`el`) aracın verdiği düğümdür. Kabuk pencere boyundadır, içerik (`.sod-main`) kalan
 * yüksekliği doldurur, sayfa kaymaz. `AppShell workspace` verilince bildirim yokken de bu boydadır.
 */
export type BandSize = 'none' | 'standard' | 'hero' | 'work';

export type HeadSlot = {
  /** Bandın başlık bölgesi. İlk çizimde null; ref bağlanınca boyamadan önce dolar. */
  el: HTMLElement | null;
  /** `PageHeader` (ya da aracın iş satırı) bandın boyunu bildirir; ayrılınca `null` (dinlenme boyu: `workspace` ise `work`, değilse `none`). */
  setSize: (size: BandSize | null) => void;
  /**
   * `PageHeader` bandın başlığı (`h1`) çizilince bildirir. Sayfa değişiminden sonra odak henüz içerikteyse (kişi araya
   * dokunmadıysa) başlığa geçer: ekran okuyucu yeni sayfanın adını okur, sonraki Tab sayfa düğmelerine gider.
   */
  titleMounted?: (h1: HTMLElement | null) => void;
};

export const HeadSlotContext = createContext<HeadSlot | null>(null);

/** AppShell içinde mi? `PageHeader` buna bakıp banda taşınır. */
export function useHeadSlot(): HeadSlot | null {
  return useContext(HeadSlotContext);
}
