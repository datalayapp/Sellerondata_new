import { defineCommands } from "../../tezgah/index.ts";

/**
 * İçe aktarma masasının kısayolları (eski masayla aynı tuşlar). Rozet: birincil "İçe aktar ve üret" (Ctrl Enter) ve
 * sık iş "Sonraki sorun" (N); gerisi ipucunda ve `?` listesinde.
 */
const ROWS = "importDesk:shortcuts.groups.rows";
const DESK = "importDesk:shortcuts.groups.desk";

defineCommands([
  { id: "iceAktar.commitGenerate", scope: "iceAktar", keys: ["mod+enter"], group: DESK, badge: "primary" },
  { id: "iceAktar.nextIssue", scope: "iceAktar", keys: ["n"], group: ROWS, badge: "frequent" },
  { id: "iceAktar.prevIssue", scope: "iceAktar", keys: ["shift+n"], group: ROWS },
  { id: "iceAktar.down", scope: "iceAktar", keys: ["arrowdown"], group: ROWS, repeat: true },
  { id: "iceAktar.up", scope: "iceAktar", keys: ["arrowup"], group: ROWS, repeat: true },
  { id: "iceAktar.edit", scope: "iceAktar", keys: ["enter"], group: ROWS },
  { id: "iceAktar.toggle", scope: "iceAktar", keys: ["space"], group: ROWS },
  { id: "iceAktar.close", scope: "iceAktar", keys: ["escape"], group: DESK },
]);
