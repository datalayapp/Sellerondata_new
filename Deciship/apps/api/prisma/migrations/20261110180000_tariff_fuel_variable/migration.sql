-- KARARLAR "Yakıt" (2026-11-10): tarifede seçim. true = yakıt değişken (faturadaki oran kabul edilir), false = sözleşmede
-- sabit (tarifedeki oranla beklenir, yüksek oran fiyat farkıdır).
ALTER TABLE "deciship"."Tariff" ADD COLUMN "fuelVariable" BOOLEAN NOT NULL DEFAULT false;

-- Varsayılan: yurt dışı taşıyıcıda değişken, yurt içinde sabit. Yurt içi listesi koddaki DOMESTIC_CARRIERS ile aynı
-- (src/services/tariffs.ts). Mevcut tarifeler de bu varsayılana çekilir.
UPDATE "deciship"."Tariff" t SET "fuelVariable" = true
FROM "deciship"."Carrier" c
WHERE c."id" = t."carrierId" AND lower(c."code") NOT IN ('aras', 'yurtici', 'mng');
