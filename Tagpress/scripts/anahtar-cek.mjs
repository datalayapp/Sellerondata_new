// Eski veritabanı kopyasından anahtarları okur (salt okunur), uygulamanın ana anahtarıyla (AES-256-GCM) şifreleyip
// aktarım dosyasına yazar. Düz metin diske yazılmaz, ekrana yalnız uzunluk yazılır.
// Kullanım: node scripts/anahtar-cek.mjs <eski-kopya.db> <cikti.json>   (ana anahtar: anahtar-ortak.mjs)
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { seal } from "../apps/server/src/services/secret-box.ts";
import { TRANSFER_FORMAT, appKeyRing, transferAad } from "./anahtar-ortak.mjs";

const [dbPath, out] = process.argv.slice(2);
if (!dbPath || !out) {
  console.error("Kullanım: node scripts/anahtar-cek.mjs <eski-kopya.db> <cikti.json>");
  process.exit(2);
}
const { ring, source } = await appKeyRing();
const d = new DatabaseSync(dbPath, { readOnly: true });
const get = (id) => d.prepare("select api_key from providers where id = ?").get(id)?.api_key;
const keys = {
  anthropic: get("096d3bd1-7024-456f-be16-a188c019cf7e"),
  gemini: get("ef3554f3-5470-4c63-a0b2-c2418d229b0b"),
};
d.close();
const sealed = {};
for (const [k, v] of Object.entries(keys)) if (v) sealed[k] = seal(ring, String(v).trim(), transferAad(k)).value;
writeFileSync(out, JSON.stringify({ format: TRANSFER_FORMAT, kid: ring.current.id, keys: sealed }), { mode: 0o600 });
console.log(`Ana anahtar: ${source}`);
console.log(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v ? `alındı (${String(v).length} karakter)` : "YOK"])));
