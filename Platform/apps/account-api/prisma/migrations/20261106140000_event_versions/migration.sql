-- Olay sürümü: alıcı küçük sürümü uygulamaz (eski CANCELED yeni ACTIVE'i ezmesin).
ALTER TABLE "Organization" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Subscription" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
