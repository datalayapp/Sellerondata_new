-- Bakım işinin dar yolu (src/services/maintenance.ts). app.scope = 'maintenance' yalnız süresi dolmuş satırları gösterir
-- ve siler. Süreler koddaki sabitlerle aynı: test/maintenance.test.ts sınar. createdAt UTC saklanır.
-- Firma ilkeleri olduğu gibi kalır; başka tablo, taze satır, ekleme ve güncelleme bu yoldan açılmaz.

CREATE POLICY maintenance_expired_read ON "deciship"."ProcessedEvent" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '30 days');
CREATE POLICY maintenance_expired_delete ON "deciship"."ProcessedEvent" FOR DELETE
  USING (current_setting('app.scope', true) = 'maintenance' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '30 days');

CREATE POLICY maintenance_expired_read ON "deciship"."TariffImportDraft" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '24 hours');
CREATE POLICY maintenance_expired_delete ON "deciship"."TariffImportDraft" FOR DELETE
  USING (current_setting('app.scope', true) = 'maintenance' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '24 hours');

CREATE POLICY maintenance_expired_read ON "deciship"."TariffDocument" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '7 days');
CREATE POLICY maintenance_expired_delete ON "deciship"."TariffDocument" FOR DELETE
  USING (current_setting('app.scope', true) = 'maintenance' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '7 days');
