// API anahtarlarının ana anahtarı: durum, döndürme, eski anahtarların temizliği. Değer ekrana yazılmaz (yalnız kimlik).
// Kullanım: node scripts/ana-anahtar.mjs durum | dondur | temizle   (veri klasörü: TAGPRESS_DATA_DIR ya da data/)
//   dondur:  yeni ana anahtar geçerli olur, eskiler dosyada kalır; uygulama sonraki açılışta kayıtları yeniden şifreler.
//   temizle: kayıtlarda kullanılmayan eski anahtarları siler (önce uygulamayı bir kez yeniden başlatın).
// TAGPRESS_SECRET_KEY kullanılıyorsa döndürme ortamda yapılır: yeni değer TAGPRESS_SECRET_KEY'e, eskisi bir açılış
// boyunca TAGPRESS_SECRET_KEY_OLD'a; açılıştan sonra TAGPRESS_SECRET_KEY_OLD kaldırılır.
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultKeyFile, defaultKeyProvider, envKeyProvider, isServerMode, pruneKeyFile, rotateKeyFile } from "../apps/server/src/services/secret-box.ts";
import { dataDir } from "./anahtar-ortak.mjs";

const cmd = process.argv[2];
const dir = dataDir();
// Windows: veri klasöründe (DPAPI ile sarılı); öteki sistemler: ~/.config/tagpress/<kurulum kimliği>/ (TAGPRESS_SECRET_KEY_DIR ile değişir).
const file = defaultKeyFile(dir);
const db = path.join(dir, "studio.db");

/** Kayıtlı anahtarların biçimi ve ana anahtar kimliği (değer okunmaz). */
function records() {
  if (!existsSync(db)) return [];
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'key:%'")
      .all()
      .map((r) => {
        const v = JSON.parse(String(r.value));
        return { provider: String(r.key).slice(4), format: v.format, kid: v.kid ?? null };
      });
  } finally {
    d.close();
  }
}

if (cmd === "durum") {
  // Salt okuma: dosya yazılmaz (sarılmamışsa sarılmaz, eski ortak konumdan kopyalanmaz).
  const provider = defaultKeyProvider(dir, process.env, { readOnly: true });
  const ring = await provider.load();
  console.log(`Kaynak: ${provider.description}`);
  console.log(ring ? `Geçerli: ${ring.current.id}  ·  eski: ${ring.previous.map((k) => k.id).join(", ") || "yok"}` : "Ana anahtar yok (uygulama ilk açılışta üretir).");
  for (const r of records()) console.log(`  ${r.provider}: ${r.format}${r.kid ? ` (${r.kid})` : ""}`);
} else if (cmd === "dondur" || cmd === "temizle") {
  if (envKeyProvider() || isServerMode()) {
    console.error("TAGPRESS_SECRET_KEY kullanılıyor (ya da sunucu kipi): döndürme ortamda yapılır (bu betiğin başındaki açıklama).");
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`Ana anahtar dosyası yok: ${file}`);
    process.exit(1);
  }
  if (cmd === "dondur") {
    const r = rotateKeyFile(file);
    console.log(`Yeni ana anahtar: ${r.current} (eskiler dosyada: ${r.previous.join(", ")}).`);
    console.log("Uygulamayı yeniden başlatın: kayıtlar yeni anahtarla şifrelenir. Sonra: node scripts/ana-anahtar.mjs temizle");
  } else {
    const inUse = new Set(records().map((r) => r.kid).filter(Boolean));
    const removed = pruneKeyFile(file, inUse);
    console.log(removed.length ? `Silinen eski anahtarlar: ${removed.join(", ")}` : "Silinecek eski anahtar yok.");
    if (removed.length) console.log("Not: yedek klasöründeki eski veritabanı kopyalarındaki anahtarlar artık çözülemez.");
  }
} else {
  console.error("Kullanım: node scripts/ana-anahtar.mjs durum | dondur | temizle");
  process.exit(2);
}
