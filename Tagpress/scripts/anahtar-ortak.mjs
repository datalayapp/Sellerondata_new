// Anahtar betiklerinin ortak parçaları. Şifreleme sunucuyla aynı modülden gelir (`secret-box.ts`, Node doğrudan çalıştırır).
import path from "node:path";
import { tagpressEnv } from "../packages/domain/src/env.ts";
import { defaultKeyProvider } from "../apps/server/src/services/secret-box.ts";

/** Aktarım dosyasının biçimi: `{ format, kid, keys: { sağlayıcı: şifreli değer } }`. */
export const TRANSFER_FORMAT = "tagpress-anahtar-aktarim/v1";
export const transferAad = (provider) => `tagpress:aktarim:${provider}`;

/** Uygulamanın veri klasörü: TAGPRESS_DATA_DIR (eski adı STUDIO_DATA_DIR), yoksa Tagpress/data. */
export const dataDir = () => path.resolve(tagpressEnv("DATA_DIR")?.trim() || path.join(import.meta.dirname, "..", "data"));

/**
 * Uygulamanın ana anahtarı (uygulamayla aynı kaynak: `defaultKeyProvider`). Betik anahtar ÜRETMEZ:
 * üretim yalnız uygulamanın açılışında, sahipsiz şifreli kayıt yoksa yapılır (kayıt kaybını önler).
 */
export async function appKeyRing() {
  const provider = defaultKeyProvider(dataDir(), process.env, { readOnly: true }); // betik dosyayı yazmaz
  const ring = await provider.load();
  if (!ring) throw new Error(`Ana anahtar yok (${provider.description}). Uygulamayı bir kez açın (ana anahtar üretilir) ya da TAGPRESS_SECRET_KEY verin.`);
  return { ring, source: provider.description };
}
