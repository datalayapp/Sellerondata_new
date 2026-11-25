-- İtiraz takibi: fatura başına itiraz paketi (tur), paketteki satırlar, sonuç girişleri ve girişlerin satır payları.
-- Yalnız yeni tablo, tür ve dizin eklenir: mevcut satırlara dokunulmaz, dolu veritabanında da sorunsuz uygulanır.
-- Yabancı anahtarlar init göçündeki gibi bileşiktir (x, companyId) -> (id, companyId); Prisma bunları göremez (check-drift).

-- CreateEnum
CREATE TYPE "deciship"."DisputeChannel" AS ENUM ('EMAIL', 'PORTAL', 'OTHER');

-- CreateEnum
CREATE TYPE "deciship"."DisputeLineOutcome" AS ENUM ('PENDING', 'RECOVERED', 'REJECTED');

-- CreateEnum
CREATE TYPE "deciship"."DisputeResultKind" AS ENUM ('RECOVERED', 'REJECTED');

-- CreateTable
CREATE TABLE "deciship"."Dispute" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "sentOn" TIMESTAMP(3) NOT NULL,
    "channel" "deciship"."DisputeChannel" NOT NULL,
    "channelNote" TEXT,
    "reference" TEXT,
    "sentById" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "claimedTotal" DECIMAL(14,2) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnById" TEXT,
    "withdrawReason" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."DisputeLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "invoiceLineId" TEXT NOT NULL,
    "trackingNo" TEXT NOT NULL,
    "claimedAmount" DECIMAL(14,2) NOT NULL,
    "outcome" "deciship"."DisputeLineOutcome" NOT NULL DEFAULT 'PENDING',
    "recoveredAmount" DECIMAL(14,2),
    "resultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisputeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."DisputeResult" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "kind" "deciship"."DisputeResultKind" NOT NULL,
    "creditNoteNo" TEXT,
    "resultOn" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "enteredById" TEXT NOT NULL,
    "revertedAt" TIMESTAMP(3),
    "revertedById" TEXT,
    "revertReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisputeResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."DisputeResultLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "disputeLineId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeResultLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_supersededById_key" ON "deciship"."Dispute"("supersededById");

-- CreateIndex
CREATE INDEX "Dispute_companyId_invoiceId_idx" ON "deciship"."Dispute"("companyId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_id_companyId_key" ON "deciship"."Dispute"("id", "companyId");

-- CreateIndex
CREATE INDEX "DisputeLine_invoiceLineId_idx" ON "deciship"."DisputeLine"("invoiceLineId");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeLine_disputeId_invoiceLineId_key" ON "deciship"."DisputeLine"("disputeId", "invoiceLineId");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeLine_id_companyId_key" ON "deciship"."DisputeLine"("id", "companyId");

-- CreateIndex
CREATE INDEX "DisputeResult_disputeId_idx" ON "deciship"."DisputeResult"("disputeId");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeResult_id_companyId_key" ON "deciship"."DisputeResult"("id", "companyId");

-- CreateIndex
CREATE INDEX "DisputeResultLine_disputeLineId_idx" ON "deciship"."DisputeResultLine"("disputeLineId");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeResultLine_resultId_disputeLineId_key" ON "deciship"."DisputeResultLine"("resultId", "disputeLineId");

-- CreateIndex: itiraz satırının bileşik anahtarı için (mevcut satırlarda id zaten tekil, dizin her zaman kurulur)
CREATE UNIQUE INDEX "InvoiceLine_id_companyId_key" ON "deciship"."InvoiceLine"("id", "companyId");

-- AddForeignKey: firma
ALTER TABLE "deciship"."Dispute" ADD CONSTRAINT "Dispute_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeLine" ADD CONSTRAINT "DisputeLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeResult" ADD CONSTRAINT "DisputeResult_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeResultLine" ADD CONSTRAINT "DisputeResultLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: bileşik (12 anahtar; src/lib/schemaCheck.ts MIN_COMPANY_SCOPED_FKS)
ALTER TABLE "deciship"."Dispute" ADD CONSTRAINT "Dispute_invoiceId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "deciship"."Invoice"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."Dispute" ADD CONSTRAINT "Dispute_sentById_fkey" FOREIGN KEY ("sentById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deciship"."Dispute" ADD CONSTRAINT "Dispute_withdrawnById_fkey" FOREIGN KEY ("withdrawnById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("withdrawnById") ON UPDATE CASCADE;
ALTER TABLE "deciship"."Dispute" ADD CONSTRAINT "Dispute_supersededById_fkey" FOREIGN KEY ("supersededById", "companyId") REFERENCES "deciship"."Dispute"("id", "companyId") ON DELETE SET NULL ("supersededById") ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeLine" ADD CONSTRAINT "DisputeLine_disputeId_fkey" FOREIGN KEY ("disputeId", "companyId") REFERENCES "deciship"."Dispute"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeLine" ADD CONSTRAINT "DisputeLine_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId", "companyId") REFERENCES "deciship"."InvoiceLine"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeLine" ADD CONSTRAINT "DisputeLine_resultId_fkey" FOREIGN KEY ("resultId", "companyId") REFERENCES "deciship"."DisputeResult"("id", "companyId") ON DELETE SET NULL ("resultId") ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeResult" ADD CONSTRAINT "DisputeResult_disputeId_fkey" FOREIGN KEY ("disputeId", "companyId") REFERENCES "deciship"."Dispute"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeResult" ADD CONSTRAINT "DisputeResult_enteredById_fkey" FOREIGN KEY ("enteredById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeResult" ADD CONSTRAINT "DisputeResult_revertedById_fkey" FOREIGN KEY ("revertedById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("revertedById") ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeResultLine" ADD CONSTRAINT "DisputeResultLine_resultId_fkey" FOREIGN KEY ("resultId", "companyId") REFERENCES "deciship"."DisputeResult"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deciship"."DisputeResultLine" ADD CONSTRAINT "DisputeResultLine_disputeLineId_fkey" FOREIGN KEY ("disputeLineId", "companyId") REFERENCES "deciship"."DisputeLine"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- Prisma şemasının anlatamadıkları ----------

-- Faturada aynı anda tek etkin tur: geri çekilmemiş ve yerini yeni tura bırakmamış. Yeniden göndermede eski turun
-- "supersededAt"ı önce yazılır, sonra yeni tur eklenir (aynı işlemde): dizin ikisini aynı anda etkin görmez.
CREATE UNIQUE INDEX "Dispute_active_invoice_key" ON "deciship"."Dispute"("companyId", "invoiceId") WHERE "withdrawnAt" IS NULL AND "supersededAt" IS NULL;

-- ---------- Satır düzeyinde güvenlik (init göçüyle aynı ilke) ----------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Dispute', 'DisputeLine', 'DisputeResult', 'DisputeResultLine'] LOOP
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
