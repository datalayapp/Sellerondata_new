ALTER TABLE "platform"."Person" ADD COLUMN "pendingEmail" TEXT;
ALTER TABLE "platform"."Person" ADD CONSTRAINT "Person_pendingEmail_lowercase"
  CHECK ("pendingEmail" IS NULL OR "pendingEmail" = lower("pendingEmail"));
CREATE INDEX "Person_pendingEmail_idx" ON "platform"."Person"("pendingEmail");
ALTER TABLE "platform"."OneTimeToken" ADD COLUMN "email" TEXT;
ALTER TABLE "platform"."Session" ADD COLUMN "familyCreatedAt" TIMESTAMP(3);
UPDATE "platform"."Session" s SET "familyCreatedAt" = f.first
  FROM (SELECT "familyId", MIN("createdAt") AS first FROM "platform"."Session" GROUP BY "familyId") f
  WHERE s."familyId" = f."familyId";
ALTER TABLE "platform"."Session" ALTER COLUMN "familyCreatedAt" SET NOT NULL,
  ALTER COLUMN "familyCreatedAt" SET DEFAULT CURRENT_TIMESTAMP;
-- Geriye dönük uyum: doğrulama zorunlu olmadan açılmış hesaplar doğrulanmış sayılır.
-- Canlı kurulum sıfırdan olacak; orada tablo boş, bu satır etkisizdir.
UPDATE "platform"."Person" SET "emailVerifiedAt" = "createdAt"
  WHERE "email" IS NOT NULL AND "emailVerifiedAt" IS NULL;
