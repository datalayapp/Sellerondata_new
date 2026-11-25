-- Firma saat dilimi (Mesaj 15 §4.1). Mevcut firmalar varsayılanı alır (bugünkü davranış: İstanbul); değer listesi uygulamada (contracts TIME_ZONES).
ALTER TABLE "platform"."Organization" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'Europe/Istanbul';
