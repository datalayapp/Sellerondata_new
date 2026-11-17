-- 03-B4: ölçüm kaydedilip faturalarla yeniden karşılaştırma yarıda kalırsa iş kaybolmasın. Değişikliği yazan işlem
-- "recomparePendingAt"i doldurur, karşılaştırma bitince boşalır. Dolu kalırsa aynı ölçümün tekrar gönderimi ya da bakım
-- işi (src/services/maintenance.ts) karşılaştırmayı tamamlar.
ALTER TABLE "deciship"."Measurement" ADD COLUMN "recomparePendingAt" TIMESTAMP(3);

CREATE INDEX "Measurement_recomparePendingAt_idx" ON "deciship"."Measurement"("recomparePendingAt");

-- Bakım işinin dar yolu (20261107000000 ile aynı desen): yalnız okuma, yalnız 10 dakikadan uzun süredir bekleyen satır.
-- Yeniden karşılaştırmanın kendisi firma bağlamında çalışır. Süre koddaki RECOMPARE_STALE_MS ile aynı: test/measurementRecompare.test.ts sınar.
CREATE POLICY maintenance_recompare_read ON "deciship"."Measurement" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "recomparePendingAt" < (now() AT TIME ZONE 'UTC') - interval '10 minutes');
