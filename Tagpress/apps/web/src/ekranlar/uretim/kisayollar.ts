import { defineCommands } from "../../tezgah/index.ts";

/**
 * Üretim kısayolları. Panel açıkken: 1–9 seçenek seçer, Enter onaylar ve sıradakine geçer, ←/→ ya da J/K
 * önceki/sonraki, D ayrıntılı düzenle, Esc kapatır. Listede: / ara, I dosya yükle, U seçilenleri üret, A en iyilerini onayla.
 * Rozet: birincil "Onayla" (Enter); sık işler 1–9, D, U, A. Gerisi ipucunda ve `?` listesinde.
 */
const PANEL = "production:shortcuts.groups.panel";
const LIST = "production:shortcuts.groups.list";

defineCommands([
  // sağ panel
  { id: "uretim.approve", scope: "uretim", keys: ["enter"], group: PANEL, badge: "primary" },
  { id: "uretim.pick", scope: "uretim", keys: ["1-9"], group: PANEL, badge: "frequent" },
  { id: "uretim.adjust", scope: "uretim", keys: ["d"], group: PANEL, badge: "frequent" },
  { id: "uretim.next", scope: "uretim", keys: ["arrowright", "j"], group: PANEL, repeat: true },
  { id: "uretim.prev", scope: "uretim", keys: ["arrowleft", "k"], group: PANEL, repeat: true },
  { id: "uretim.editText", scope: "uretim", keys: ["e"], group: PANEL },
  { id: "uretim.revise", scope: "uretim", keys: ["c"], group: PANEL },
  { id: "uretim.regenerate", scope: "uretim", keys: ["r"], group: PANEL },
  { id: "uretim.delete", scope: "uretim", keys: ["delete"], group: PANEL },
  { id: "uretim.close", scope: "uretim", keys: ["escape"], group: PANEL },
  // liste
  { id: "uretim.search", scope: "uretim", keys: ["/"], group: LIST },
  { id: "uretim.upload", scope: "uretim", keys: ["i"], group: LIST },
  { id: "uretim.generate", scope: "uretim", keys: ["u"], group: LIST, badge: "frequent" },
  { id: "uretim.approveBest", scope: "uretim", keys: ["a"], group: LIST, badge: "frequent" },
]);
