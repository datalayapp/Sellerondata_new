// Aktarım dosyasındaki şifreli anahtarları çözer ve uygulamanın ayarlarına (yalnızca HTTP ile, belleğe) gönderir;
// uygulama onları kendi ana anahtarıyla şifreleyip saklar. Düz metin diske ve ekrana yazılmaz.
// Kullanım: node scripts/anahtar-yukle.mjs <dosya.json> <adres, ör. http://127.0.0.1:5420>
// Dosya `anahtar-cek.mjs` biçimindeyse uygulamanın ana anahtarıyla, eski biçimdeyse (`anahtarlar.dpapi.json`:
// { sağlayıcı: DPAPI değeri }) yalnız Windows'ta, kaydeden kullanıcının DPAPI'siyle çözülür.
import { readFileSync } from "node:fs";
import { legacyDpapi } from "../apps/server/src/services/dpapi.ts";
import { SEALED_FORMAT, open } from "../apps/server/src/services/secret-box.ts";
import { TRANSFER_FORMAT, appKeyRing, transferAad } from "./anahtar-ortak.mjs";

const [file, base] = process.argv.slice(2);
if (!file || !base) {
  console.error("Kullanım: node scripts/anahtar-yukle.mjs <dosya.json> <adres>");
  process.exit(2);
}
const data = JSON.parse(readFileSync(file, "utf8"));
let entries;
if (data?.format === TRANSFER_FORMAT) {
  const { ring } = await appKeyRing();
  entries = Object.entries(data.keys ?? {}).map(([provider, value]) => [provider, () => open(ring, { format: SEALED_FORMAT, kid: data.kid, value }, transferAad(provider))]);
} else {
  const dpapi = legacyDpapi();
  if (!dpapi) throw new Error("Eski biçimli (DPAPI) dosya yalnız onu kaydeden Windows kullanıcısında çözülür.");
  entries = Object.entries(data).map(([provider, value]) => [provider, () => dpapi(String(value))]);
}
for (const [provider, decrypt] of entries) {
  const res = await fetch(`${base}/api/settings/keys/${provider}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "X-Studio": "1", origin: base },
    body: JSON.stringify({ apiKey: decrypt() }),
  });
  console.log(provider, res.status, (await res.text()).slice(0, 200));
}
