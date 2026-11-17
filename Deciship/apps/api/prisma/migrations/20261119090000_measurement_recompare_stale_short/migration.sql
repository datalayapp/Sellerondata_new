-- Y93: bakım kapsamının ölçüm karşılaştırması dar yolu 10 yerine 2 dakikadan eski işaretleri gösterir. Yeni açılan süreç
-- yarıda kalmış karşılaştırmayı en geç ~3,5 dk sonra alır (2 dk + 90 sn tarama aralığı; eskiden ~11,5 dk). Süre koddaki
-- RECOMPARE_STALE_MS ile aynı (src/services/maintenance.ts): test/measurementRecompare.test.ts sınar. Yalnız okuma, yalnız
-- işaretli satır: ilkenin geri kalanı 20261110120000 ile aynı. Süren karşılaştırmayla yarışırsa iki hesap aynı sonucu yazar
-- (fatura kilidi altında; işaret yalnız aynı değerle boşalır).
ALTER POLICY maintenance_recompare_read ON "deciship"."Measurement"
  USING (current_setting('app.scope', true) = 'maintenance' AND "recomparePendingAt" < (now() AT TIME ZONE 'UTC') - interval '2 minutes');
