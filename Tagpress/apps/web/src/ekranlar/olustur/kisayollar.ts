import { defineCommands } from "../../tezgah/index.ts";

// Oluştur ekranı Tasarım dili sekmesidir: kapsam `tasarimDili` (tuval komutları da etkin). Adlar `designLanguage:shortcuts.*`.
defineCommands([
  { id: "tasarimDili.primary", scope: "tasarimDili", keys: ["mod+enter"], group: "builder:shortcuts.groups.flow", badge: "primary" },
  { id: "tasarimDili.send", scope: "tasarimDili", keys: ["enter"], group: "builder:shortcuts.groups.chat", inInput: true },
  { id: "tasarimDili.focusComposer", scope: "tasarimDili", keys: ["c"], group: "builder:shortcuts.groups.chat", badge: "frequent" },
  { id: "tasarimDili.attach", scope: "tasarimDili", keys: ["u"], group: "builder:shortcuts.groups.chat" },
  { id: "tasarimDili.toggleRev", scope: "tasarimDili", keys: ["v"], group: "builder:shortcuts.groups.flow", badge: "frequent" },
]);
