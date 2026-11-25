import { defineCommands } from "../../tezgah/index.ts";

/**
 * Şablonlar kısayolları (eski düzenleyiciyle aynı tuşlar): araçlar V O R P (yalnız Elle kipte anlamlı; başka kipte
 * araç seçmek alanı Elle'ye çevirir), önceki / sonraki şablon [ ], arama /, kaydet Ctrl S. Yeni: geri al Ctrl Z,
 * ızgara görünümü G. Çokgen çiziminde Enter kapatır, Esc iptal eder, Del son noktayı (ya da seçili noktayı) siler;
 * oklar 1 px (Shift 10 px) kaydırır. Tuval komutları (Ctrl − =, Shift 1, 1, Boşluk) temelin `tuval` kapsamında.
 * Rozet: yalnız birincil Kaydet; ray düğmeleri tuşlarını kendisi yazar.
 */
const EDIT = "templates:shortcuts.groups.edit";
const TOOLS = "templates:shortcuts.groups.tools";
const AREA = "templates:shortcuts.groups.area";
const LIBRARY = "templates:shortcuts.groups.library";

defineCommands([
  { id: "sablonlar.save", scope: "sablonlar", keys: ["mod+s"], group: EDIT, badge: "primary", inInput: true },
  { id: "sablonlar.undo", scope: "sablonlar", keys: ["mod+z"], group: EDIT, repeat: true },

  { id: "sablonlar.toolSelect", scope: "sablonlar", keys: ["v"], group: TOOLS },
  { id: "sablonlar.toolEllipse", scope: "sablonlar", keys: ["o"], group: TOOLS },
  { id: "sablonlar.toolRect", scope: "sablonlar", keys: ["r"], group: TOOLS },
  { id: "sablonlar.toolPolygon", scope: "sablonlar", keys: ["p"], group: TOOLS },

  { id: "sablonlar.cancel", scope: "sablonlar", keys: ["escape"], group: AREA },
  { id: "sablonlar.finish", scope: "sablonlar", keys: ["enter"], group: AREA },
  { id: "sablonlar.deleteVertex", scope: "sablonlar", keys: ["delete", "backspace"], group: AREA },
  { id: "sablonlar.left", scope: "sablonlar", keys: ["arrowleft", "shift+arrowleft"], group: AREA, repeat: true },
  { id: "sablonlar.right", scope: "sablonlar", keys: ["arrowright", "shift+arrowright"], group: AREA, repeat: true },
  { id: "sablonlar.up", scope: "sablonlar", keys: ["arrowup", "shift+arrowup"], group: AREA, repeat: true },
  { id: "sablonlar.down", scope: "sablonlar", keys: ["arrowdown", "shift+arrowdown"], group: AREA, repeat: true },

  { id: "sablonlar.prev", scope: "sablonlar", keys: ["["], group: LIBRARY },
  { id: "sablonlar.next", scope: "sablonlar", keys: ["]"], group: LIBRARY },
  { id: "sablonlar.search", scope: "sablonlar", keys: ["/"], group: LIBRARY },
  { id: "sablonlar.toggleView", scope: "sablonlar", keys: ["g"], group: LIBRARY },
]);
