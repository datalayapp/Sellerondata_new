-- Yenilemenin tekrar anahtarı (KALANLAR 6.8). İstemci (mobil) her yenilemeden önce rastgele bir anahtar üretir, eski jetonla birlikte
-- saklar ve gönderir; döndürmenin açtığı yeni satır anahtarın SHA-256 özetini yazar. Aynı eski jeton AYNI anahtarla yeniden gelirse
-- ve ailenin başı o sunumla doğduysa (yeni jeton henüz kullanılmadı) süre toleransı (`REFRESH_REUSE_GRACE_SECONDS`) aranmaz: kayıp
-- yanıt dakikalar ya da günler sonra tekrarlansa da oturum düşmez. Anahtarı bilmeyen eski kopya için kural değişmez.
-- Boş olabilir: girişle açılan satır, anahtarsız istemcinin (web, eski mobil sürüm) döndürmesi ve bu göçten önceki satırlar.
ALTER TABLE "platform"."Session" ADD COLUMN "retryKeyHash" TEXT;
