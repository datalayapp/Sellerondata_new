import { defineCommands } from "../../../tezgah/index.ts";

/**
 * Baskı masasının kısayolları (eski masayla aynı tuşlar). Rozet yalnız "Yazıyı düzelt" (Enter, sık iş); geri al,
 * çoğalt, sil ve ince ayar ipucunda ve `?` listesinde. Tuval komutları (Ctrl − =, Shift 1 hepsini sığdır, 1 / Shift 0
 * gerçek boyut, Boşluk ile kaydır) temelin `tuval` kapsamında. Raftan bırakırken Shift ve Alt yalnız listede (tuşa
 * basmak bir şey yapmaz; bırakmayı değiştirir).
 */
const EDIT = "printDesk:shortcuts.groups.edit";
const LABELS = "printDesk:shortcuts.groups.labels";
const SHELF = "printDesk:shortcuts.groups.shelf";

defineCommands([
  { id: "baskiMasa.undo", scope: "baskiMasa", keys: ["mod+z"], group: EDIT, repeat: true },
  { id: "baskiMasa.redo", scope: "baskiMasa", keys: ["mod+y", "mod+shift+z"], group: EDIT, repeat: true },

  { id: "baskiMasa.adjust", scope: "baskiMasa", keys: ["enter"], group: LABELS, badge: "frequent" },
  { id: "baskiMasa.duplicate", scope: "baskiMasa", keys: ["mod+d"], group: LABELS },
  { id: "baskiMasa.delete", scope: "baskiMasa", keys: ["delete", "backspace"], group: LABELS },
  { id: "baskiMasa.selectAll", scope: "baskiMasa", keys: ["mod+a"], group: LABELS },
  { id: "baskiMasa.clear", scope: "baskiMasa", keys: ["escape"], group: LABELS },
  { id: "baskiMasa.left", scope: "baskiMasa", keys: ["arrowleft", "shift+arrowleft"], group: LABELS, repeat: true },
  { id: "baskiMasa.right", scope: "baskiMasa", keys: ["arrowright", "shift+arrowright"], group: LABELS, repeat: true },
  { id: "baskiMasa.up", scope: "baskiMasa", keys: ["arrowup", "shift+arrowup"], group: LABELS, repeat: true },
  { id: "baskiMasa.down", scope: "baskiMasa", keys: ["arrowdown", "shift+arrowdown"], group: LABELS, repeat: true },

  // Raftan bırakırken (işleyicisi yok; sürükle-bırakın değiştiricisi).
  { id: "baskiMasa.dropAll", scope: "baskiMasa", keys: ["shift"], group: SHELF, passive: true },
  { id: "baskiMasa.dropFree", scope: "baskiMasa", keys: ["alt"], group: SHELF, passive: true },
]);
