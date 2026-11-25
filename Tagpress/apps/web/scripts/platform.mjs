#!/usr/bin/env node
// Platform yapısı (VITE_TAGPRESS_PLATFORM=1): taban /tagpress/, sunucu /api/tagpress, ortak kabuk (vite.config.ts).
//   node scripts/platform.mjs build   → dist/ (web imajı bunu kopyalar)
//   node scripts/platform.mjs dev     → 5423, Hesap/Merkez/TagPress API vekilleri
// Ortam değişkeni her işletim sisteminde aynı biçimde verilsin diye küçük sarmalayıcı (cross-env yok).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const mode = process.argv[2] === "dev" ? [] : ["build"];
// `vite/bin` dışa aktarılmıyor: paket kökü package.json'dan bulunur.
const vite = path.join(path.dirname(createRequire(path.join(root, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
const r = spawnSync(process.execPath, [vite, ...mode, ...process.argv.slice(3)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_TAGPRESS_PLATFORM: "1" },
});
process.exit(r.status ?? 1);
