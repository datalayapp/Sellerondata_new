-- KALANLAR 6.20: kalıcı silme kaydının (`CompanyPurge`) ilkeleri product-kit `memberProjectionSql` gibi ayrılır. Önceki tek genel
-- ilke (`company_isolation`, 20261125090000) firma bağlamındaki her isteğe kaydı eklemeyi, bitişi boşaltmayı ve silmeyi açıyordu:
-- silme yalnız Hesap'ın olayıyla başlar, kaydın kendisi silmenin tek tetikleyicisidir. Yalnız ilke ve yetki değişir; mevcut satırlara
-- dokunulmaz (veri ifadesi yok). Kilit beklemesi sınırlı: tablo küçük, göç beklemek yerine düşer, yeniden koşulur.
SET lock_timeout = '5s';

DROP POLICY company_isolation ON "deciship"."CompanyPurge";

-- Okuma: firma bağlamında kendi kaydı (olay alıcısı, JIT ve silme işlemi `isCompanyPurged`). Bakımın bitmemiş kayıt okuması
-- (`maintenance_purge_read`) aynen kalır.
CREATE POLICY company_read ON "deciship"."CompanyPurge" FOR SELECT
  USING ("companyId" = current_setting('app.company_id', true));

-- Ekleme: yalnız olay alıcısı (`identity.ts` `org.purged`: olay kapsamı + olayın firmasının bağlamı), yalnız bitmemiş ve hiç
-- denenmemiş kayıt (baştan "bitti" ya da "denendi" eklenemez).
CREATE POLICY event_insert ON "deciship"."CompanyPurge" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.company_id', true) AND current_setting('app.scope', true) = 'events'
    AND "completedAt" IS NULL AND "attemptedAt" IS NULL);

-- Bitiş: firma bağlamında yalnız bitmemiş kayıt bitmiş olur (`completedAt` bir kez dolar, geri boşaltılamaz, değiştirilemez).
-- Yazım silme işleminin içinde (`companyPurge.ts`: firma kilidi, kayıt denetimi, firma satırı kilidi).
CREATE POLICY purge_complete ON "deciship"."CompanyPurge" FOR UPDATE
  USING ("companyId" = current_setting('app.company_id', true) AND "completedAt" IS NULL)
  WITH CHECK ("companyId" = current_setting('app.company_id', true) AND "completedAt" IS NOT NULL);

-- Deneme anı (`attemptedAt`, 20261128090000): firma bağlamında, yalnız bitmemiş kayıtta ve kayıt bitmemiş kalır. Sütun yetkisiyle
-- (aşağıda) bu ilkeden geçen güncelleme yalnız `attemptedAt`'i değiştirir. Yazım silmenin kendi kısa işleminde (`companyPurge.ts`).
-- Bakım kapsamında güncelleme yok (bakım yalnız okur).
CREATE POLICY purge_attempt ON "deciship"."CompanyPurge" FOR UPDATE
  USING ("companyId" = current_setting('app.company_id', true) AND "completedAt" IS NULL)
  WITH CHECK ("companyId" = current_setting('app.company_id', true) AND "completedAt" IS NULL);

-- Silme ilkesi yok (FORCE RLS: hiçbir satır silinmez); yetki de alınır. Güncelleme yalnız iki an sütununda: kimlik ve açılış anı
-- değişmez.
REVOKE DELETE, UPDATE ON "deciship"."CompanyPurge" FROM sod_deciship;
GRANT UPDATE ("completedAt", "attemptedAt") ON "deciship"."CompanyPurge" TO sod_deciship;

-- Oturum ayarı sonraki göçlere taşınmasın (göç aracı aynı bağlantıyı sürdürebilir).
RESET lock_timeout;
