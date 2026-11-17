-- Uzun işler ve dosyalar (Mesaj 7): arka plan iş kuyruğu (`Job`), dosya temizliği için `File.purgedAt`, PDF fatura
-- önizlemesinin sunucuda kalan özeti `File.preview`, çalıştırıcı ve bakım kapsamlarının dar ilkeleri.
-- Yalnız yeni tür, tablo, sütun, dizin ve ilke eklenir; hiçbir satır güncellenmez (NO FORCE -> UPDATE -> FORCE gerekmez),
-- dolu veritabanında da sorunsuz uygulanır. Diskte duran eski önizleme dosyalarını göç değil, çalışma anındaki tarama
-- (src/services/fileCleanup.ts, firma bağlamında) temizler.

-- CreateEnum
CREATE TYPE "deciship"."JobKind" AS ENUM ('INVOICE_PDF_READ', 'TARIFF_PDF_SCAN', 'TARIFF_PDF_EXTRACT', 'BULK_RECOMPARE_PREVIEW', 'BULK_RECOMPARE_APPLY');

-- CreateEnum
CREATE TYPE "deciship"."JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterTable: yeni sütunlar boş başlar (eski satırlar: dosya diskte, önizleme özeti yok)
ALTER TABLE "deciship"."File" ADD COLUMN "preview" JSONB,
ADD COLUMN "purgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "deciship"."Job" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "deciship"."JobKind" NOT NULL,
    "status" "deciship"."JobStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "label" TEXT,
    "input" JSONB NOT NULL,
    "checkpoint" JSONB,
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER,
    "stage" TEXT,
    "counters" JSONB,
    "result" JSONB,
    "error" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "deciship"."Job"("status", "runAfter");

-- CreateIndex
CREATE INDEX "Job_companyId_refType_refId_idx" ON "deciship"."Job"("companyId", "refType", "refId");

-- CreateIndex
CREATE INDEX "Job_finishedAt_idx" ON "deciship"."Job"("finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_id_companyId_key" ON "deciship"."Job"("id", "companyId");

-- AddForeignKey: firma
ALTER TABLE "deciship"."Job" ADD CONSTRAINT "Job_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: bileşik (1 anahtar; src/lib/schemaCheck.ts MIN_COMPANY_SCOPED_FKS). Üye silinince yalnız "createdById" boşalır.
-- Prisma'nın önerdiği tek sütunlu anahtar yazılmaz.
ALTER TABLE "deciship"."Job" ADD CONSTRAINT "Job_createdById_fkey" FOREIGN KEY ("createdById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("createdById") ON UPDATE CASCADE;

-- ---------- Prisma şemasının anlatamadıkları ----------

-- Kısmi tekil dizin: aynı iş iki kez başlamasın. Yalnız bekleyen ve süren işler arasında tekildir: iş bitince aynı anahtarla
-- yenisi başlayabilir. `enqueueJob` aynı hedefle `ON CONFLICT ("companyId", "kind", "dedupeKey") WHERE "status" IN
-- ('QUEUED', 'RUNNING') DO NOTHING` yazar. src/lib/schemaCheck.ts REQUIRED_INDEXES denetler.
CREATE UNIQUE INDEX "Job_active_key" ON "deciship"."Job"("companyId", "kind", "dedupeKey") WHERE "status" IN ('QUEUED', 'RUNNING');

-- ---------- Satır düzeyinde güvenlik (init göçüyle aynı ilke) ----------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Job'] LOOP
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

-- Çalıştırıcının dar yolu (src/db.ts withJobScope): bütün firmaların yalnız bekleyen ve süren işleri. Ekleme ve silme yok.
-- `SELECT … FOR UPDATE` UPDATE ilkesinin USING koşulunu da ister: ikisi aynı küme. Çalıştırıcı bir işi yalnız QUEUED
-- (kira bırakma, geçici hata) ya da RUNNING (sahiplenme, kalp atışı) bırakabilir. Postgres, sütuna bakan UPDATE'te yeni
-- satırı SELECT ilkesine de vurur: bu kapsamda bitmiş duruma (SUCCEEDED, FAILED, CANCELLED) geçiş zaten yazılamaz.
-- Bitiş yazımı, deneme hakkı biten işin FAILED (JOB_ABANDONED) yazımı dahil, işin kendi firma bağlamında yapılır;
-- iş kapsamı yalnız aday listesini okur (bakım işinin deseni).
CREATE POLICY jobs_runner_read ON "deciship"."Job" FOR SELECT
  USING (current_setting('app.scope', true) = 'jobs' AND "status" IN ('QUEUED', 'RUNNING'));
CREATE POLICY jobs_runner_update ON "deciship"."Job" FOR UPDATE
  USING (current_setting('app.scope', true) = 'jobs' AND "status" IN ('QUEUED', 'RUNNING'))
  WITH CHECK (current_setting('app.scope', true) = 'jobs' AND "status" IN ('QUEUED', 'RUNNING'));

-- Bakım kapsamı (20261107000000_maintenance_scope deseni): biten ve 7 günden eski işler görünür ve silinir. Süre koddaki
-- JOB_RETENTION_MS ile aynı (test denetler). "finishedAt" UTC saklanır; bitmemiş işin "finishedAt"ı boştur, görünmez.
CREATE POLICY maintenance_expired_read ON "deciship"."Job" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "finishedAt" < (now() AT TIME ZONE 'UTC') - interval '7 days');
CREATE POLICY maintenance_expired_delete ON "deciship"."Job" FOR DELETE
  USING (current_setting('app.scope', true) = 'maintenance' AND "finishedAt" < (now() AT TIME ZONE 'UTC') - interval '7 days');

-- Bakım kapsamı: dosya temizliğinin ADAY listesi, yalnız okuma. Silme ve "purgedAt" yazımı firma bağlamında, ayrıntılı
-- denetimle yapılır (src/services/fileCleanup.ts). Süreler koddaki DELETED_INVOICE_FILE_TTL_MS (30 gün) ve
-- PREVIEW_FILE_TTL_MS (24 saat) ile aynı.
CREATE POLICY maintenance_deleted_read ON "deciship"."Invoice" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "deletedAt" < (now() AT TIME ZONE 'UTC') - interval '30 days');

-- Alt sorgu "Invoice" tablosunun ilkesine tabidir: bakım kapsamında yalnız 30 günden eski silinmiş faturaları görür, bu
-- yüzden canlı faturanın dosyası aday listesine giremez. Önizleme dosyası (faturaya bağlanmamış) 24 saat dokunulmadıysa aday.
CREATE POLICY maintenance_preview_read ON "deciship"."File" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "kind" = 'INVOICE_SOURCE' AND "purgedAt" IS NULL
    AND (
      ("invoiceId" IS NULL AND "updatedAt" < (now() AT TIME ZONE 'UTC') - interval '24 hours')
      OR "invoiceId" IN (SELECT i."id" FROM "deciship"."Invoice" i)
    ));
