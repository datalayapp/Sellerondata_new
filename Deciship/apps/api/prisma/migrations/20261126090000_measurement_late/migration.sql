-- KALANLAR 6.7: geç gelen eski ölçüm ve cihaz saati farkı. Yalnız yeni sütun; mevcut satırlara dokunulmaz (veri ifadesi yok),
-- dolu veritabanında da sorunsuz uygulanır.
--
-- `arrivedLate`: kayıt geldiğinde aynı takip no'nun daha yeni bir güncel ölçümü vardı; zincire eski sürüm olarak girdi
-- (`services/measurementOrder.ts`). Merkez'in çalışan sayımı ve çalışanın kendi listesi bunu ayırır.
-- `deviceMeasuredAt`: cihazın bildirdiği ham ölçüm anı; yalnız sunucu saat farkını düzelttiyse dolu (`measuredAt` düzeltilmiş an).
ALTER TABLE "deciship"."Measurement" ADD COLUMN "arrivedLate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "deviceMeasuredAt" TIMESTAMP(3);
