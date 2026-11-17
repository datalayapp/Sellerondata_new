-- Mesaj 4 (07-B1, 07-B7): ölçüm sonrası ve mükerrer yeniden hesabın kalıcı işaretleri.
-- Yalnız yeni sütun, tablo, dizin ve ilke eklenir; mevcut satırlara dokunulmaz (veri ifadesi yok).

-- 07-B7: ölçüm işaretinin tarama ya da bakımda düşen deneme sayısı (geri çekilme, 5 denemeden sonra taramadan çıkar).
ALTER TABLE "deciship"."Measurement" ADD COLUMN "recompareAttempts" INTEGER NOT NULL DEFAULT 0;

-- 07-B1: faturanın "Mükerrer" yeniden hesabı bekliyor. Önceki fatura silinince ya da başlığı (taşıyıcı, para birimi, fatura
-- no) düzeltilince değişikliği yazan işlem, aynı takip numaralarını taşıyan sonraki faturalara bu satırı yazar; hesap başarıyla
-- bitince satır yalnız aynı "pendingAt" ile silinir. Ayrı tablo: bakım kapsamının dar okuması "Invoice"u genişletmez
-- ("File" bakım ilkesi faturanın bakımda görünüp görünmediğine dayanır, 20261114120000_jobs_files).
CREATE TABLE "deciship"."InvoiceRecheck" (
    "invoiceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pendingAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceRecheck_pkey" PRIMARY KEY ("invoiceId")
);

CREATE INDEX "InvoiceRecheck_pendingAt_idx" ON "deciship"."InvoiceRecheck"("pendingAt");

-- AddForeignKey: firma
ALTER TABLE "deciship"."InvoiceRecheck" ADD CONSTRAINT "InvoiceRecheck_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey: bileşik (src/lib/schemaCheck.ts MIN_COMPANY_SCOPED_FKS)
ALTER TABLE "deciship"."InvoiceRecheck" ADD CONSTRAINT "InvoiceRecheck_invoiceId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "deciship"."Invoice"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Firma ayrımı (20261108120000_disputes deseni).
ALTER TABLE "deciship"."InvoiceRecheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."InvoiceRecheck" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "deciship"."InvoiceRecheck"
  USING ("companyId" = current_setting('app.company_id', true))
  WITH CHECK ("companyId" = current_setting('app.company_id', true));

-- Bakım kapsamının dar yolu (ölçüm işaretiyle aynı süre): yalnız okuma, yalnız 2 dakikadan uzun süredir bekleyen satır. Süre
-- koddaki RECOMPARE_STALE_MS ile aynı (src/services/maintenance.ts): test/invoiceRecheck.test.ts sınar. Yeniden hesabın kendisi
-- firma bağlamında çalışır.
CREATE POLICY maintenance_recheck_read ON "deciship"."InvoiceRecheck" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "pendingAt" < (now() AT TIME ZONE 'UTC') - interval '2 minutes');
