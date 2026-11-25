-- Y91 incelemesi (B5): "File"."holders" boş liste varsayılanıyla eklendi (20261117120000_file_holders) ama NULL'a izin
-- veriyordu; NULL satır paylaşım güncellemesini sessizce boşa düşürür ve vazgeçmede liste okunamazdı. Kod NULL'u yine de
-- boş liste sayar (src/services/fileCleanup.ts). Önce olası NULL satırlar boş listeye çevrilir, sonra sütun NOT NULL olur.
-- Sahip de FORCE RLS'ye tabidir ve göçte firma bağlamı yoktur: güncelleme boyunca kapatılır, hemen geri açılır
-- (20261112120000_import_report ile aynı yol). Prisma'da liste sütununun boşluk bilgisi yoktur (String[] her zaman dolu).

ALTER TABLE "deciship"."File" NO FORCE ROW LEVEL SECURITY;

UPDATE "deciship"."File" SET "holders" = ARRAY[]::TEXT[] WHERE "holders" IS NULL;

ALTER TABLE "deciship"."File" FORCE ROW LEVEL SECURITY;

-- AlterTable
ALTER TABLE "deciship"."File" ALTER COLUMN "holders" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "holders" SET NOT NULL;
