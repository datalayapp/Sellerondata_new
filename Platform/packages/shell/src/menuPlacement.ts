/**
 * Açılır menünün ekrandaki yeri (gövdeye taşınan, `position: fixed` listeler: `ActionMenu`).
 * Altta yer varsa düğmenin altında açılır; yoksa üstüne çevrilir; iki yanda da sığmıyorsa geniş olan yana açılır ve
 * yüksekliği sınırlanır (liste kendi içinde kayar). Yatayda ekranın içinde kalır: sağa hizalı liste solda yer yoksa
 * sağa kayar, sola hizalı liste sağda yer yoksa sola kayar.
 * Saf işlev: DOM okumaz; ölçüleri `visibleBounds` ve çağıran verir (birim testi `test/menuPlacement.test.ts`).
 * DeciShip paneli de bunu kullanır (`@sellerondata/shell/menu-placement`: RowMenu, MoreMenu, panel testi).
 */
export interface MenuRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MenuBounds {
  /** Görünür alanın üst kenarı (sabit üst satırın altı). */
  top: number;
  /** Görünür alanın alt kenarı (telefonda alttaki uygulama çubuğunun üstü). */
  bottom: number;
  /** Pencere genişliği. */
  width: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  /** Yalnız iki yana da sığmayınca verilir. */
  maxHeight?: number;
  up: boolean;
}

/** Düğme ile liste arası. */
export const MENU_GAP = 4;
/** Liste ile ekran kenarı arası. */
export const MENU_MARGIN = 8;

export function placeMenu(trigger: MenuRect, menu: { width: number; height: number }, bounds: MenuBounds, align: 'left' | 'right' = 'right'): MenuPlacement {
  const below = bounds.bottom - trigger.bottom - MENU_GAP - MENU_MARGIN;
  const above = trigger.top - bounds.top - MENU_GAP - MENU_MARGIN;
  let up = false;
  let maxHeight: number | undefined;
  if (menu.height > below) {
    if (menu.height <= above) up = true;
    else {
      // İki yana da sığmıyor: geniş yana aç, yüksekliği o yana sınırla.
      up = above > below;
      maxHeight = Math.max(0, Math.floor(up ? above : below));
    }
  }
  const h = maxHeight === undefined ? menu.height : Math.min(menu.height, maxHeight);
  const top = up ? trigger.top - MENU_GAP - h : trigger.bottom + MENU_GAP;
  const rawLeft = align === 'right' ? trigger.right - menu.width : trigger.left;
  const left = Math.max(MENU_MARGIN, Math.min(rawLeft, bounds.width - menu.width - MENU_MARGIN));
  return maxHeight === undefined ? { top, left, up } : { top, left, maxHeight, up };
}

/**
 * Tarayıcıdaki görünür alan: üstte sabit üst satır (`.sod-top`, kabuk), altta telefonun uygulama çubuğu (`.sod-dock`)
 * çıkarılır. Çubuk gizliyse (geniş ekran, `display: none`) yüksekliği 0'dır, pay alınmaz.
 */
export function visibleBounds(): MenuBounds {
  const h = window.innerHeight;
  let top = 0;
  let bottom = h;
  const bar = document.querySelector('.sod-top')?.getBoundingClientRect();
  if (bar && bar.height > 0 && bar.bottom > 0 && bar.bottom < h) top = bar.bottom;
  const dock = document.querySelector('.sod-dock')?.getBoundingClientRect();
  if (dock && dock.height > 0 && dock.top > 0) bottom = Math.min(h, dock.top);
  return { top, bottom, width: document.documentElement.clientWidth || window.innerWidth };
}
