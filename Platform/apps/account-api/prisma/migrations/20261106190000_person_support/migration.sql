-- Telefon doğrulaması için hazır sütun (kullanım yok) ve destek işlemiyle askıya alınmış kişi.
ALTER TABLE "Person" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Person" ADD COLUMN "suspendedAt" TIMESTAMP(3);

-- Kimliksiz kişi yalnız askıdayken olur: giriş yolu yoktur, numara başkasına geçebilir.
ALTER TABLE "Person" DROP CONSTRAINT "Person_identity_required";
ALTER TABLE "Person" ADD CONSTRAINT "Person_identity_required" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL OR "suspendedAt" IS NOT NULL);
