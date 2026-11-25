-- Firmayı kapatma (SONRAKI-OTURUM/PLAN-firma-kapatma.md, bölüm B): Hesap'ın `org.closed`, `org.reopened` ve `org.purged` olayları.
-- Yalnız yeni sütun, tablo ve ilke eklenir; mevcut satırlara dokunulmaz (veri ifadesi yok, NO FORCE -> UPDATE -> FORCE gerekmez),
-- dolu veritabanında da sorunsuz uygulanır.

-- Kapalı firma: `closedAt` doluysa uçlar 409 ORG_CLOSED döner, arka plan işleri firmayı atlar. `closedVersion`: kapalılığı yazan
-- son olayın sürümü (Organization.version, `org.updated` ile aynı sayaç). Olaylar sırasız gelebilir: eşit ya da küçük sürümlü
-- kapatma/geri açma uygulanmaz. Adın sürümü (`nameVersion`) ayrı kalır: ikisi farklı alanları sıralar.
ALTER TABLE "deciship"."Company" ADD COLUMN "closedAt" TIMESTAMP(3),
ADD COLUMN "closedVersion" INTEGER;

-- Kalıcı silme kaydı (`org.purged`). Firmanın satırı ve bütün verisi silinir; burada yalnız kimliği ve anları kalır:
-- - sonra gelen (gecikmiş) olay ya da JIT firmayı yeniden kurmaz (sözleşme `org.purged`);
-- - `completedAt` boşsa silme bitmemiştir (veritabanı ya da disk yarıda kaldı): saatlik bakım yeniden dener.
-- Firma satırına yabancı anahtar yok (firma silinir). Firma sütunu `companyId`: RLS ilkesi ve testler diğer tablolarla aynı.
CREATE TABLE "deciship"."CompanyPurge" (
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CompanyPurge_pkey" PRIMARY KEY ("companyId")
);

-- Firma ayrımı (20261108120000_disputes deseni).
ALTER TABLE "deciship"."CompanyPurge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."CompanyPurge" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "deciship"."CompanyPurge"
  USING ("companyId" = current_setting('app.company_id', true))
  WITH CHECK ("companyId" = current_setting('app.company_id', true));

-- Bakım kapsamının dar yolu (20261115090000 deseni): yalnız okuma, yalnız bitmemiş silmeler. Silmenin kendisi firma bağlamında.
CREATE POLICY maintenance_purge_read ON "deciship"."CompanyPurge" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "completedAt" IS NULL);

-- İş kuyruğu çalıştırıcısı kapalı firmanın işini almaz (src/services/jobs/runner.ts `claimNext`): iş kapsamında firma satırı
-- yalnız okunur. Sorgu `EXISTS (… "closedAt" IS NULL)` ile sorar: ilke yoksa hiçbir iş alınmaz (sessiz değil: açılış denetimi
-- src/lib/schemaCheck.ts bu ilkeyi arar). Ekleme, güncelleme, silme ve başka tablo açılmaz.
CREATE POLICY jobs_company_read ON "deciship"."Company" FOR SELECT
  USING (current_setting('app.scope', true) = 'jobs');
