// ⋯ menüsünün yeri: altta yer yoksa yukarı açılır, ekrandan ve alttaki uygulama çubuğundan taşmaz (paylaşılan @sellerondata/shell/menu-placement).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MENU_GAP, MENU_MARGIN, placeMenu } from '@sellerondata/shell/menu-placement';

const rect = (top: number, left: number, size = 44) => ({ top, bottom: top + size, left, right: left + size });
const menu = { width: 220, height: 60 };
const desktop = { top: 72, bottom: 800, width: 1280 };

describe('placeMenu', () => {
  it('altta yer varsa düğmenin altında açılır', () => {
    const p = placeMenu(rect(200, 1000), menu, desktop);
    assert.equal(p.up, false);
    assert.equal(p.top, 244 + MENU_GAP);
    assert.equal(p.maxHeight, undefined);
  });

  it('panelin alt eylem satırında (ekranın dibinde) yukarı çevrilir', () => {
    const p = placeMenu(rect(744, 1000), menu, desktop);
    assert.equal(p.up, true);
    assert.equal(p.top, 744 - MENU_GAP - menu.height);
    assert.ok(p.top + menu.height <= desktop.bottom);
  });

  it('telefonda alttaki uygulama çubuğunun üstünde kalır', () => {
    // 390×844, çubuk 60 px: görünür alan 784'te biter; düğme çubuğun hemen üstünde
    const phone = { top: 112, bottom: 784, width: 390 };
    const p = placeMenu(rect(728, 16), menu, phone, 'left');
    assert.equal(p.up, true);
    assert.ok(p.top + menu.height <= phone.bottom);
    assert.ok(p.top >= phone.top);
  });

  it('sabit üst satırın altına taşmaz: üstte de yer yoksa geniş yana açılır, yüksekliği sınırlanır', () => {
    const tall = { width: 220, height: 500 };
    const small = { top: 72, bottom: 600, width: 1280 };
    const p = placeMenu(rect(400, 1000), tall, small);
    // üstte 400-72-12 = 316, altta 600-444-12 = 144 → yukarı, 316 px
    assert.equal(p.up, true);
    assert.equal(p.maxHeight, 400 - small.top - MENU_GAP - MENU_MARGIN);
    assert.ok(p.top >= small.top);
    assert.equal(p.top + p.maxHeight! + MENU_GAP, 400);
  });

  it('yatayda ekran içinde kalır (sağa hizalı ve sola hizalı)', () => {
    assert.equal(placeMenu(rect(200, 4), menu, desktop, 'right').left, MENU_MARGIN);
    assert.equal(placeMenu(rect(200, 1250), menu, desktop, 'left').left, desktop.width - menu.width - MENU_MARGIN);
    assert.equal(placeMenu(rect(200, 1000), menu, desktop, 'right').left, 1044 - menu.width);
  });
});
