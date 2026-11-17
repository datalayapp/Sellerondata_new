-- Yapay zekâ sayacı (Mesaj 6): çağrı başına kullanım satırı, kredi defteri ve firma içi sonuç önbelleği.
-- Yalnız yeni tür, tablo, dizin ve ilke eklenir; mevcut satırlara dokunulmaz (NO FORCE -> UPDATE -> FORCE gerekmez),
-- dolu veritabanında da sorunsuz uygulanır. Denetim kayıtlarındaki eski kullanım bilgisi sayaca aktarılmaz.
-- Kimlikler istemcide üretilir (Prisma uuid()), diğer tablolarla aynı. Üye anahtarı bileşiktir (init göçündeki gibi).

-- CreateEnum
CREATE TYPE "deciship"."AiKind" AS ENUM ('SCALE_READ', 'INVOICE_PDF', 'INVOICE_MAPPING', 'TARIFF_PDF_DISCOVER', 'TARIFF_PDF_EXTRACT', 'TARIFF_REVIEW');

-- CreateEnum
CREATE TYPE "deciship"."AiCallStatus" AS ENUM ('OK', 'CACHED', 'FAILED');

-- CreateEnum
CREATE TYPE "deciship"."AiCreditKind" AS ENUM ('GRANT', 'PURCHASE', 'ADJUST');

-- CreateTable
CREATE TABLE "deciship"."AiUsage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "memberId" TEXT,
    "kind" "deciship"."AiKind" NOT NULL,
    "status" "deciship"."AiCallStatus" NOT NULL,
    "errorCode" TEXT,
    "period" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "servedModel" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(14,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "priceVersion" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "cacheKey" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."AiCreditEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "deciship"."AiCreditKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "period" TEXT,
    "note" TEXT,
    "operator" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."AiResultCache" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "deciship"."AiKind" NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "usageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiResultCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsage_companyId_period_idx" ON "deciship"."AiUsage"("companyId", "period");

-- CreateIndex
CREATE INDEX "AiUsage_period_idx" ON "deciship"."AiUsage"("period");

-- CreateIndex
CREATE INDEX "AiCreditEntry_companyId_period_idx" ON "deciship"."AiCreditEntry"("companyId", "period");

-- CreateIndex: ödeme ya da olay kimliği bir kez uygulanır (boş kimlikler birbirine çarpmaz)
CREATE UNIQUE INDEX "AiCreditEntry_companyId_externalRef_key" ON "deciship"."AiCreditEntry"("companyId", "externalRef");

-- CreateIndex
CREATE INDEX "AiResultCache_expiresAt_idx" ON "deciship"."AiResultCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiResultCache_companyId_kind_cacheKey_key" ON "deciship"."AiResultCache"("companyId", "kind", "cacheKey");

-- AddForeignKey: firma
ALTER TABLE "deciship"."AiUsage" ADD CONSTRAINT "AiUsage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."AiCreditEntry" ADD CONSTRAINT "AiCreditEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."AiResultCache" ADD CONSTRAINT "AiResultCache_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: bileşik (1 anahtar; src/lib/schemaCheck.ts MIN_COMPANY_SCOPED_FKS). Üye silinince yalnız "memberId" boşalır.
ALTER TABLE "deciship"."AiUsage" ADD CONSTRAINT "AiUsage_memberId_fkey" FOREIGN KEY ("memberId", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("memberId") ON UPDATE CASCADE;

-- ---------- Satır düzeyinde güvenlik (init göçüyle aynı ilke) ----------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AiUsage', 'AiCreditEntry', 'AiResultCache'] LOOP
    EXECUTE format('ALTER TABLE "deciship".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE "deciship".%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY company_isolation ON "deciship".%I
           USING ("companyId" = current_setting('app.company_id', true))
           WITH CHECK ("companyId" = current_setting('app.company_id', true))$p$,
      t
    );
  END LOOP;
END $$;

-- Destek kapsamı (src/db.ts withSupportScope, yalnız komut satırı): bütün firmaların kullanımı, kredisi ve adı okunur.
-- Yalnız SELECT: ekleme, güncelleme ve silme bu yoldan açılmaz. Ek kredi withCompany ile firma ilkesinden yazılır.
CREATE POLICY support_read ON "deciship"."AiUsage" FOR SELECT
  USING (current_setting('app.scope', true) = 'support');
CREATE POLICY support_read ON "deciship"."AiCreditEntry" FOR SELECT
  USING (current_setting('app.scope', true) = 'support');
CREATE POLICY support_read ON "deciship"."Company" FOR SELECT
  USING (current_setting('app.scope', true) = 'support');

-- Bakım kapsamı (20261107000000_maintenance_scope deseni): yalnız süresi dolmuş önbellek satırları görünür ve silinir.
-- "expiresAt" UTC saklanır. Kullanım ve kredi satırları bakımla silinmez.
CREATE POLICY maintenance_expired_read ON "deciship"."AiResultCache" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "expiresAt" < (now() AT TIME ZONE 'UTC'));
CREATE POLICY maintenance_expired_delete ON "deciship"."AiResultCache" FOR DELETE
  USING (current_setting('app.scope', true) = 'maintenance' AND "expiresAt" < (now() AT TIME ZONE 'UTC'));
