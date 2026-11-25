import { TABS, type Tab } from "../../lib/route.ts";
import { defineCommands } from "./kayit.ts";

/**
 * Genel ve tuval komutları (her ekranda aynı). Menü tuşları eski arayüzle aynı: Alt 1 Üretim, 2 Tasarım dili,
 * 3 Şablonlar, 4 Ayarlar, 5 Baskı (`TABS`).
 */
export const NAV_COMMAND: Record<Tab, string> = {
  uretim: "nav.production",
  "tasarim-dili": "nav.designLanguage",
  sablonlar: "nav.templates",
  baski: "nav.print",
  ayarlar: "nav.settings",
};

defineCommands([
  ...TABS.map((t) => ({ id: NAV_COMMAND[t.id], scope: "genel" as const, keys: [`alt+${t.key}`], group: "shortcuts:groups.navigation" })),
  { id: "help", scope: "genel", keys: ["?"], group: "shortcuts:groups.general" },
  // tuval (CANVAS_SCOPES ekranlarında)
  { id: "canvas.zoomIn", scope: "tuval", keys: ["mod+=", "mod++"], group: "shortcuts:groups.canvas", repeat: true },
  { id: "canvas.zoomOut", scope: "tuval", keys: ["mod+-"], group: "shortcuts:groups.canvas", repeat: true },
  { id: "canvas.fit", scope: "tuval", keys: ["shift+1"], group: "shortcuts:groups.canvas" },
  { id: "canvas.actual", scope: "tuval", keys: ["1", "shift+0"], group: "shortcuts:groups.canvas" },
  { id: "canvas.selection", scope: "tuval", keys: ["shift+2"], group: "shortcuts:groups.canvas" },
  // Basılı tutulur; işleyişi useCanvasView'de (kayıtta yalnız `?` listesi ve ipucu için).
  { id: "canvas.pan", scope: "tuval", keys: ["space"], group: "shortcuts:groups.canvas", passive: true },
]);
