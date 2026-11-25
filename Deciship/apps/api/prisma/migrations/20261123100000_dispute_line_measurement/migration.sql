-- Silinenlerin kalıcı temizliği, bağımsız inceleme (2026-11-12): itiraz satırı gönderim anındaki ölçüm sürümünü değişmez
-- taşır. Kalıcı silme (src/services/deletedPurge.ts) fotoğraf korumasını fatura satırının bugünkü bağına değil buna dayandırır:
-- satır sonradan yeni ölçüme geçse ya da bağı boşalsa da turdaki kanıtın fotoğrafı silinmez.
-- Yabancı anahtar yok (bilerek): ölçüm kaydı silinmez, SET NULL ile bağın kopması istenmez.

-- AlterTable: yeni sütun boş başlar
ALTER TABLE "deciship"."DisputeLine" ADD COLUMN "measurementId" TEXT;

-- CreateIndex
CREATE INDEX "DisputeLine_measurementId_idx" ON "deciship"."DisputeLine"("measurementId");

-- CreateIndex: takip no eşleşmesiyle koruma (doldurmada bağı bulunamayan eski itiraz satırı)
CREATE INDEX "DisputeLine_companyId_trackingNo_idx" ON "deciship"."DisputeLine"("companyId", "trackingNo");

-- ---------- Backfill ----------
-- Geçmiş itiraz satırları fatura satırının bugünkü ölçüm bağından doldurulur (en iyi tahmin; bağ bugün boşsa satır boş kalır
-- ve kalıcı silme takip no eşleşmesiyle korur). Sahip de FORCE RLS'ye tabidir, göçte firma bağlamı yoktur: iki tablo bu
-- işlem boyunca açılır, sonunda geri kapanır (20261112120000_import_report ile aynı yol).
ALTER TABLE "deciship"."DisputeLine" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."InvoiceLine" NO FORCE ROW LEVEL SECURITY;

UPDATE "deciship"."DisputeLine" dl
SET "measurementId" = l."measurementId"
FROM "deciship"."InvoiceLine" l
WHERE l."id" = dl."invoiceLineId" AND l."companyId" = dl."companyId" AND dl."measurementId" IS NULL AND l."measurementId" IS NOT NULL;

ALTER TABLE "deciship"."InvoiceLine" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."DisputeLine" FORCE ROW LEVEL SECURITY;
