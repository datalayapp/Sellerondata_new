-- Taşıyıcı poşeti / zarfı (ambalaj türü; FedEx Pak, UPS Express Pak, DHL Flyer, zarflar). Yalnız yeni tür ve yeni sütunlar; mevcut satırlara dokunulmaz (veri ifadesi yok), dolu
-- veritabanında da sorunsuz uygulanır. Varsayılanlar eski davranışı korur:
--  - Measurement.packaging: OWN (kendi ambalajı); eski uygulamanın kaydı da OWN.
--  - TariffRate.packaging: OWN; mevcut fiyat satırlarının hepsi kendi ambalaj (koli) fiyatıdır.
--  - InvoiceLine.packaging: boş (faturada ambalaj bilgisi yok ya da göçten önce yüklendi).
--  - Tariff.pakDiscountPct / envelopeDiscountPct: boş (= tarifenin indirimi kullanılır).
--  - Carrier.packagingLimits: boş (= taşıyıcı kodunun varsayılan poşet / zarf sınırları, core `packagingLimitsFor`).
-- Tarife sürümlerinin özeti (TariffRevision.contentHash) değişmez: OWN satır ve boş indirim özete eskisi gibi girer
-- (services/tariffs.ts tariffContentHash), göç yüzünden yeni sürüm açılmaz. Kilit beklemesi sınırlı: yoğun tabloda göç beklemek
-- yerine düşer, yeniden koşulur.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "deciship"."Packaging" AS ENUM ('OWN', 'PAK', 'ENVELOPE');

-- AlterTable
ALTER TABLE "deciship"."Measurement" ADD COLUMN "packaging" "deciship"."Packaging" NOT NULL DEFAULT 'OWN';

-- AlterTable
ALTER TABLE "deciship"."TariffRate" ADD COLUMN "packaging" "deciship"."Packaging" NOT NULL DEFAULT 'OWN';

-- AlterTable
ALTER TABLE "deciship"."Tariff" ADD COLUMN "pakDiscountPct" DECIMAL(6,2),
ADD COLUMN "envelopeDiscountPct" DECIMAL(6,2);

-- AlterTable
ALTER TABLE "deciship"."InvoiceLine" ADD COLUMN "packaging" "deciship"."Packaging";

-- AlterTable
ALTER TABLE "deciship"."Carrier" ADD COLUMN "packagingLimits" JSONB;
