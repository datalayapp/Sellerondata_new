import { defineCommands } from "../../../tezgah/index.ts";

/**
 * Sayfa şablonu düzenleyicisinin kısayolları (eski düzenleyiciyle aynı tuşlar). Rozet yalnız Kaydet'te (Ctrl S,
 * birincil); araç tuşları rayda, kalanlar ipucunda ve `?` listesinde. Tuval komutları (Ctrl − =, Shift 1, 1 / Shift 0,
 * Shift 2 seçime, Boşluk ile kaydır) temelin `tuval` kapsamında.
 */
const EDIT = "printTemplates:shortcuts.groups.edit";
const TOOLS = "printTemplates:shortcuts.groups.tools";
const SLOTS = "printTemplates:shortcuts.groups.slots";

defineCommands([
  { id: "baskiSablon.save", scope: "baskiSablon", keys: ["mod+s"], group: EDIT, badge: "primary", inInput: true },
  { id: "baskiSablon.undo", scope: "baskiSablon", keys: ["mod+z"], group: EDIT, repeat: true },
  { id: "baskiSablon.redo", scope: "baskiSablon", keys: ["mod+y", "mod+shift+z"], group: EDIT, repeat: true },
  { id: "baskiSablon.back", scope: "baskiSablon", keys: [], group: EDIT },

  { id: "baskiSablon.toolSelect", scope: "baskiSablon", keys: ["v"], group: TOOLS },
  { id: "baskiSablon.toolCircle", scope: "baskiSablon", keys: ["c"], group: TOOLS },
  { id: "baskiSablon.toolEllipse", scope: "baskiSablon", keys: ["e"], group: TOOLS },
  { id: "baskiSablon.toolRect", scope: "baskiSablon", keys: ["r"], group: TOOLS },

  { id: "baskiSablon.selectAll", scope: "baskiSablon", keys: ["mod+a"], group: SLOTS },
  { id: "baskiSablon.duplicate", scope: "baskiSablon", keys: ["mod+d"], group: SLOTS },
  { id: "baskiSablon.delete", scope: "baskiSablon", keys: ["delete", "backspace"], group: SLOTS },
  { id: "baskiSablon.clear", scope: "baskiSablon", keys: ["escape"], group: SLOTS },
  { id: "baskiSablon.left", scope: "baskiSablon", keys: ["arrowleft", "shift+arrowleft"], group: SLOTS, repeat: true },
  { id: "baskiSablon.right", scope: "baskiSablon", keys: ["arrowright", "shift+arrowright"], group: SLOTS, repeat: true },
  { id: "baskiSablon.up", scope: "baskiSablon", keys: ["arrowup", "shift+arrowup"], group: SLOTS, repeat: true },
  { id: "baskiSablon.down", scope: "baskiSablon", keys: ["arrowdown", "shift+arrowdown"], group: SLOTS, repeat: true },
]);
