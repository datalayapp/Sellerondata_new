-- Firmayı kapatma (plan PLAN-firma-kapatma.md, kullanıcı kararı 2026-11-13). Sahip firmayı kapatır; veriler `purgeAfter`a kadar durur,
-- bu sürede sahip geri açabilir, süre dolunca saatlik bakım firmayı kalıcı siler. Üçü birlikte dolu ya da birlikte boş.
-- `closedById` kişi kimliğidir (Person.id); yabancı anahtar yok: kişi silinse de iz kalır.
ALTER TABLE "platform"."Organization" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "platform"."Organization" ADD COLUMN "closedById" TEXT;
ALTER TABLE "platform"."Organization" ADD COLUMN "purgeAfter" TIMESTAMP(3);
ALTER TABLE "platform"."Organization" ADD CONSTRAINT "Organization_closure_check"
  CHECK (("closedAt" IS NULL AND "purgeAfter" IS NULL AND "closedById" IS NULL) OR ("closedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL));
-- Kalıcı silme işi yalnız kapalı firmaları tarar.
CREATE INDEX "Organization_purgeAfter_idx" ON "platform"."Organization"("purgeAfter") WHERE "purgeAfter" IS NOT NULL;
