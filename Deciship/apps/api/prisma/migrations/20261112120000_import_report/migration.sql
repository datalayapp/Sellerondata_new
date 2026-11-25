-- Mesaj 5, kullanıcıya açık ol:
--  - "Invoice"."importReport": yükleme özeti (core ImportReport, version 1). Faturaya alınmayan satırlar, takip no'suz
--    ücret satırları ve PDF metin denetiminin sonucu. Mesaj 5 öncesi faturada boş kalır (geriye dönük üretilemez).
--  - "Invoice"."calculatedAt": hesap motorunun faturayı son koştuğu an. Yalnız oluşturma ve yeniden karşılaştırma yazar;
--    karar, not ve yalnız toplam yazan yollar yazmaz.

-- AlterTable
ALTER TABLE "deciship"."Invoice" ADD COLUMN "importReport" JSONB,
ADD COLUMN "calculatedAt" TIMESTAMP(3);

-- ---------- Backfill ----------
-- Sahip de FORCE RLS'ye tabidir ve göçte firma bağlamı yoktur: bu işlem boyunca kapatılır, sonunda geri açılır
-- (20261111120000_frozen_results ile aynı yol). Mevcut faturada en iyi tahmin "updatedAt"tir. "updatedAt"in kendisi
-- değişmez: Prisma'nın @updatedAt'i istemci tarafındadır, düz SQL UPDATE ona dokunmaz.
ALTER TABLE "deciship"."Invoice" NO FORCE ROW LEVEL SECURITY;

UPDATE "deciship"."Invoice" SET "calculatedAt" = "updatedAt" WHERE "calculatedAt" IS NULL;

ALTER TABLE "deciship"."Invoice" FORCE ROW LEVEL SECURITY;
