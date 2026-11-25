-- Araç bildirimi (Mesaj 14 §4.5): tekrar anahtarı ve firma başına 24 saat tavanı. Gövde ve alıcılar saklanmaz.
CREATE TABLE "platform"."ProductNotice" (
    "id" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductNotice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductNotice_product_orgId_dedupeKey_key" ON "platform"."ProductNotice"("product", "orgId", "dedupeKey");

CREATE INDEX "ProductNotice_orgId_product_createdAt_idx" ON "platform"."ProductNotice"("orgId", "product", "createdAt");

ALTER TABLE "platform"."ProductNotice" ADD CONSTRAINT "ProductNotice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "platform"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
