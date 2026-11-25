// Açılır menünün yeri: altta yer yoksa yukarı, yanda yer yoksa öbür yana, hiçbir zaman ekran dışına taşmaz (src/menuPlacement.ts).
import { MENU_GAP, MENU_MARGIN, placeMenu } from '../src/menuPlacement.ts';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any

const rect = (top: number, left: number, size = 44) => ({ top, bottom: top + size, left, right: left + size });
const menu = { width: 220, height: 180 };
const desktop = { top: 0, bottom: 900, width: 1440 };

describe('placeMenu', () => {
  it('altta yer varsa düğmenin altında, sağ kenara hizalı açılır', () => {
    const p = placeMenu(rect(200, 1200), menu, desktop);
    expect(p.up).toBe(false);
    expect(p.top).toBe(244 + MENU_GAP);
    expect(p.left).toBe(1244 - menu.width);
    expect(p.maxHeight).toBeUndefined();
  });

  it('son satırda (altta yer yok) yukarı açılır ve ekranın içinde kalır', () => {
    const p = placeMenu(rect(820, 1200), menu, desktop);
    expect(p.up).toBe(true);
    expect(p.top).toBe(820 - MENU_GAP - menu.height);
    expect(p.top + menu.height).toBeLessThanOrEqual(desktop.bottom);
  });

  it('sağda yer yoksa sola kayar; solda yer yoksa sağa kayar', () => {
    // Sola hizalı liste sağ kenara çok yakın düğmede: sağa taşmaz.
    const l = placeMenu(rect(200, 1420, 20), menu, desktop, 'left');
    expect(l.left + menu.width).toBeLessThanOrEqual(desktop.width - MENU_MARGIN);
    // Sağa hizalı liste sol kenardaki düğmede: sola taşmaz.
    const r = placeMenu(rect(200, 4, 20), menu, desktop, 'right');
    expect(r.left).toBe(MENU_MARGIN);
  });

  it('iki yanda da sığmazsa geniş yana açılır, yüksekliği sınırlanır', () => {
    const tall = { width: 220, height: 700 };
    const small = { top: 60, bottom: 600, width: 1280 };
    const p = placeMenu(rect(400, 1000), tall, small);
    expect(p.up).toBe(true);
    expect(p.maxHeight).toBe(400 - small.top - MENU_GAP - MENU_MARGIN);
    expect(p.top).toBeGreaterThanOrEqual(small.top);
  });

  it('dar ekranda listeden geniş pencere yoksa sol kenara yaslanır', () => {
    const p = placeMenu(rect(100, 10), { width: 400, height: 100 }, { top: 0, bottom: 800, width: 360 });
    expect(p.left).toBe(MENU_MARGIN);
  });
});
