import { defineCommands } from "../../tezgah/index.ts";

/**
 * Düzelt'in kısayolları (eski pencereyle aynı tuşlar; değişen tek şey: Enter metni düzenler, Ctrl S kaydeder).
 * Rozet: birincil Kaydet (Ctrl S); sık işler yatay / dikey / tam ortala (H V C) ve metni düzenle (Enter). Boyut ve
 * kalınlığın ilk tuşları sağ panelde elle rozet (`SIZE_KEYS`, `STROKE_KEYS`); geri al ve yakınlaştırma ipucunda ve `?` listesinde. Tuval komutları (Ctrl − =, Shift 1, 1, Shift 2,
 * Boşluk) temelin `tuval` kapsamında.
 */
/** Boyut ve kalınlık: sağ panelde sayı kutusunun yanında rozet olarak görünen ilk tuşlar (maket "- =" ve "[ ]"). */
export const SIZE_KEYS = { down: "-", up: "=" } as const;
export const STROKE_KEYS = { down: "[", up: "]" } as const;

const EDIT = "adjust:shortcuts.groups.edit";
const MOVE = "adjust:shortcuts.groups.move";
const SELECT = "adjust:shortcuts.groups.select";
const TOOLS = "adjust:shortcuts.groups.tools";

defineCommands([
  { id: "duzelt.save", scope: "duzelt", keys: ["mod+s"], group: EDIT, badge: "primary", inInput: true },
  { id: "duzelt.saveEnter", scope: "duzelt", keys: ["mod+enter"], group: EDIT, inInput: true },
  { id: "duzelt.cancel", scope: "duzelt", keys: ["escape"], group: EDIT, inInput: true },
  { id: "duzelt.undo", scope: "duzelt", keys: ["mod+z"], group: EDIT, repeat: true },
  { id: "duzelt.redo", scope: "duzelt", keys: ["mod+y", "mod+shift+z"], group: EDIT, repeat: true },
  { id: "duzelt.reset", scope: "duzelt", keys: ["0"], group: EDIT },
  { id: "duzelt.editText", scope: "duzelt", keys: ["enter"], group: EDIT, badge: "frequent" },

  { id: "duzelt.centerX", scope: "duzelt", keys: ["h"], group: MOVE, badge: "frequent" },
  { id: "duzelt.centerY", scope: "duzelt", keys: ["v"], group: MOVE, badge: "frequent" },
  { id: "duzelt.centerBoth", scope: "duzelt", keys: ["c"], group: MOVE, badge: "frequent" },
  { id: "duzelt.left", scope: "duzelt", keys: ["arrowleft", "shift+arrowleft"], group: MOVE, repeat: true },
  { id: "duzelt.right", scope: "duzelt", keys: ["arrowright", "shift+arrowright"], group: MOVE, repeat: true },
  { id: "duzelt.up", scope: "duzelt", keys: ["arrowup", "shift+arrowup"], group: MOVE, repeat: true },
  { id: "duzelt.down", scope: "duzelt", keys: ["arrowdown", "shift+arrowdown"], group: MOVE, repeat: true },
  { id: "duzelt.scaleDown", scope: "duzelt", keys: [SIZE_KEYS.down, "_"], group: MOVE, repeat: true },
  { id: "duzelt.scaleUp", scope: "duzelt", keys: [SIZE_KEYS.up, "+"], group: MOVE, repeat: true },
  { id: "duzelt.strokeDown", scope: "duzelt", keys: [STROKE_KEYS.down, ","], group: MOVE, repeat: true },
  { id: "duzelt.strokeUp", scope: "duzelt", keys: [STROKE_KEYS.up, "."], group: MOVE, repeat: true },

  { id: "duzelt.nextLine", scope: "duzelt", keys: ["tab"], group: SELECT },
  { id: "duzelt.prevLine", scope: "duzelt", keys: ["shift+tab"], group: SELECT },
  { id: "duzelt.selectAll", scope: "duzelt", keys: ["mod+a"], group: SELECT },

  // Araç rayı (tuşsuz: kip seçimi; Boşluk ve Enter kendi komutlarında).
  { id: "duzelt.toolSelect", scope: "duzelt", keys: [], group: TOOLS },
  { id: "duzelt.toolMarquee", scope: "duzelt", keys: [], group: TOOLS },
  { id: "duzelt.toolZoom", scope: "duzelt", keys: [], group: TOOLS },
]);
