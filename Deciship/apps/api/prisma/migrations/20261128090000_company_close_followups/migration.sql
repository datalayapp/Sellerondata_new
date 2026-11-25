-- KALANLAR 6.10: firma kapatmanın ve üyelik eşitlemesinin artıkları. Yalnız yeni dizin ve sütun; mevcut satırlara dokunulmaz (veri
-- ifadesi yok, NO FORCE -> UPDATE -> FORCE gerekmez), RLS ilkeleri değişmez. Dolu veritabanında da uygulanır (dizinler kısa süre
-- yazmayı bekletir; iç kullanım aşamasında tablolar küçük). Kilit beklemesi sınırlı: yoğun tabloda göç beklemek yerine düşer, yeniden
-- koşulur (uygulama yazmaları göçün arkasında kuyruğa girmez).
SET lock_timeout = '5s';

-- Firma sütunuyla başlayan dizini olmayan dokuz firma tablosu. Kalıcı silme (`services/companyPurge.ts`) her parçada
-- `"companyId" = <firma>` ile seçer, firma satırının silinmesi de her çocuk tablonun firma anahtarını tarar; RLS ilkesi de her
-- sorguya aynı koşulu ekler. Dizinsiz bu tablolar büyük veride baştan sona taranırdı. Denetim: test/companyClose.test.ts
-- "her firma tablosunda firma sütunuyla başlayan dizin var".
CREATE INDEX "TariffZone_companyId_idx" ON "deciship"."TariffZone"("companyId");
CREATE INDEX "TariffRate_companyId_idx" ON "deciship"."TariffRate"("companyId");
CREATE INDEX "TariffOverflow_companyId_idx" ON "deciship"."TariffOverflow"("companyId");
CREATE INDEX "TariffSurcharge_companyId_idx" ON "deciship"."TariffSurcharge"("companyId");
CREATE INDEX "TariffVersion_companyId_idx" ON "deciship"."TariffVersion"("companyId");
CREATE INDEX "TariffRevision_companyId_idx" ON "deciship"."TariffRevision"("companyId");
CREATE INDEX "InvoiceRecheck_companyId_idx" ON "deciship"."InvoiceRecheck"("companyId");
CREATE INDEX "DisputeResult_companyId_idx" ON "deciship"."DisputeResult"("companyId");
CREATE INDEX "DisputeResultLine_companyId_idx" ON "deciship"."DisputeResultLine"("companyId");

-- Kalıcı silmenin son deneme anı. Saatlik bakım bitmemiş silmeleri önce hiç denenmemiş, sonra en uzun süredir denenmemiş sırayla
-- alır (`maintenance.ts` `companyPurgeQueue`): hep düşen silmeler sıranın başını tutup yenilerini bekletmez. Yazma firma bağlamında
-- (`company_isolation`), okuma bakım kapsamında (`maintenance_purge_read`); yeni ilke gerekmez.
ALTER TABLE "deciship"."CompanyPurge" ADD COLUMN "attemptedAt" TIMESTAMP(3);

-- Üyeliğin Hesap'ta silindiği an (`member.removed`). Çıkarma kalıcıdır: jetonla eşitleme (`identity.ts` `syncMember`) askıdan
-- dönen üyeyi açar ama çıkarılmış kaydı hiç açmaz (Hesap üyelik kimliğini yeniden kullanmaz; yedekten geri yükleme ya da tohum aynı
-- kimliğe daha büyük epoch'lu jeton basarsa bile). Yalnız `member.removed` yazar, hiçbir şey boşaltmaz.
ALTER TABLE "deciship"."Member" ADD COLUMN "removedAt" TIMESTAMP(3);

-- Oturum ayarı sonraki göçlere taşınmasın (göç aracı aynı bağlantıyı sürdürebilir).
RESET lock_timeout;
