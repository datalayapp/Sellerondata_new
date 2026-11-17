-- Merkez kurulumu (2026-11-13): firma bilgilerinin Merkez'de onaylandığı an. NULL = onay bekliyor.
-- Geriye dönük doldurma: bu göçten önce açılmış her firma onaylı sayılır (kimseye yeni uyarı çıkmaz; yayından önce gerçek
-- müşteri yok). Göçten sonra açılan firma NULL başlar ve Merkez'de `PATCH /org { confirmCompany: true }` ile onaylanır.
ALTER TABLE "platform"."Organization" ADD COLUMN "companyConfirmedAt" TIMESTAMP(3);
UPDATE "platform"."Organization" SET "companyConfirmedAt" = "createdAt" WHERE "companyConfirmedAt" IS NULL;
