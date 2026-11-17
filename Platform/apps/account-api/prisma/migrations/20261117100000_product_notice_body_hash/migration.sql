-- Araç bildirimi yeniden gönderiminin iki koruması (Y129 incelemesi).
-- 1) `attemptedAt` varsayılansız ve boş olabilir: kademeli yayında bu sütunu bilmeyen eski kodun yazdığı satır boş kalır ve
--    gönderilmiş sayılır (yeniden gönderilmez). Yeni kod sütunu her zaman veritabanı saatiyle (`now()`) yazar.
-- 2) `bodyHash`: ilk gövdenin özeti. Yeniden gönderim yalnız aynı gövdeyle yapılır.
ALTER TABLE "platform"."ProductNotice" ALTER COLUMN "attemptedAt" DROP DEFAULT;
ALTER TABLE "platform"."ProductNotice" ALTER COLUMN "attemptedAt" DROP NOT NULL;
ALTER TABLE "platform"."ProductNotice" ADD COLUMN "bodyHash" TEXT;

-- Önceki göçten sonra yazılmış, hâlâ gönderilmemiş satırların özeti yok: yeniden gönderilmezler (gönderilmiş say).
UPDATE "platform"."ProductNotice" SET "sentAt" = COALESCE("attemptedAt", "createdAt") WHERE "sentAt" IS NULL AND "bodyHash" IS NULL;
