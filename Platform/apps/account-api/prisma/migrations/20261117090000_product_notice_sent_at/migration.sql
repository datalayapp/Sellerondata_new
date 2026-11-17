-- Araç bildiriminin gönderim anı (Y129). Satır yazılıp postalar bitmeden süreç durursa `sentAt` boş kalır; son denemeden
-- (`attemptedAt`) 10 dakika sonra aynı anahtarla gelen istek postaları yeniden gönderir. Var olan satırlar gönderilmiş sayılır.
ALTER TABLE "platform"."ProductNotice" ADD COLUMN "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "platform"."ProductNotice" ADD COLUMN "sentAt" TIMESTAMP(3);

UPDATE "platform"."ProductNotice" SET "attemptedAt" = "createdAt", "sentAt" = "createdAt";
