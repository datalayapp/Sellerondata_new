-- Şema init.sql ile açılır. Migration rolünde CREATE ON DATABASE yoktur.

-- CreateEnum
CREATE TYPE "deciship"."DimMethod" AS ENUM ('LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET');

-- CreateEnum
CREATE TYPE "deciship"."WeightMethod" AS ENUM ('OCR', 'MANUAL');

-- CreateEnum
CREATE TYPE "deciship"."FileKind" AS ENUM ('PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER', 'INVOICE_SOURCE');

-- CreateEnum
CREATE TYPE "deciship"."EdgeRounding" AS ENUM ('CEIL_CM', 'NONE');

-- CreateEnum
CREATE TYPE "deciship"."SurchargeKind" AS ENUM ('FIXED', 'PCT', 'PER_KG');

-- CreateEnum
CREATE TYPE "deciship"."InvoiceStatus" AS ENUM ('PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "deciship"."LineStatus" AS ENUM ('MATCH', 'DIFF', 'UNMATCHED', 'NO_TARIFF');

-- CreateEnum
CREATE TYPE "deciship"."Decision" AS ENUM ('OPEN', 'VERIFIED', 'ACCEPTED');

-- CreateTable
CREATE TABLE "deciship"."Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameVersion" INTEGER,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."Member" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."BoxPreset" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lengthCm" DECIMAL(8,1) NOT NULL,
    "widthCm" DECIMAL(8,1) NOT NULL,
    "heightCm" DECIMAL(8,1) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoxPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."Measurement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "trackingRaw" TEXT NOT NULL,
    "trackingNo" TEXT NOT NULL,
    "lengthCm" DECIMAL(8,1) NOT NULL,
    "widthCm" DECIMAL(8,1) NOT NULL,
    "heightCm" DECIMAL(8,1) NOT NULL,
    "weightKg" DECIMAL(10,3) NOT NULL,
    "dimMethod" "deciship"."DimMethod" NOT NULL,
    "weightMethod" "deciship"."WeightMethod" NOT NULL,
    "ocrWeightKg" DECIMAL(10,3),
    "dimConfidence" DOUBLE PRECISION,
    "boxPresetId" TEXT,
    "measuredById" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Measurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."File" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "deciship"."FileKind" NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "originalName" TEXT,
    "measurementId" TEXT,
    "invoiceId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."Carrier" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultMapping" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."Tariff" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "service" TEXT,
    "currency" TEXT NOT NULL,
    "divisor" INTEGER NOT NULL,
    "edgeRounding" "deciship"."EdgeRounding" NOT NULL DEFAULT 'CEIL_CM',
    "weightSteps" JSONB NOT NULL,
    "discountPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "fuelPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "countryAdjustments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."TariffZone" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TariffZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."TariffRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "weightUpto" DECIMAL(10,3) NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "perKg" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TariffRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."TariffOverflow" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "perUnit" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TariffOverflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."TariffSurcharge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "deciship"."SurchargeKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TariffSurcharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."Invoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "tariffId" TEXT,
    "invoiceNo" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "currency" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "status" "deciship"."InvoiceStatus" NOT NULL DEFAULT 'PROCESSED',
    "totals" JSONB NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "trackingNo" TEXT NOT NULL,
    "shipDate" TIMESTAMP(3),
    "service" TEXT,
    "destCountry" TEXT,
    "actualKg" DECIMAL(10,3),
    "billedKg" DECIMAL(10,3),
    "dimL" DECIMAL(8,1),
    "dimW" DECIMAL(8,1),
    "dimH" DECIMAL(8,1),
    "billedDivisor" INTEGER,
    "baseAmount" DECIMAL(14,2),
    "discountAmount" DECIMAL(14,2),
    "fuelAmount" DECIMAL(14,2),
    "surcharges" JSONB NOT NULL,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT,
    "reference" TEXT,
    "rawHash" TEXT NOT NULL,
    "parseFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parseChecked" BOOLEAN NOT NULL DEFAULT false,
    "measurementId" TEXT,
    "measurementPinned" BOOLEAN NOT NULL DEFAULT false,
    "originalTrackingNo" TEXT,
    "tariffId" TEXT,
    "status" "deciship"."LineStatus" NOT NULL,
    "diffTypes" TEXT[],
    "ourChargeableKg" DECIMAL(10,3),
    "billedChargeableKg" DECIMAL(10,3),
    "expectedAmount" DECIMAL(14,2),
    "diffAmount" DECIMAL(14,2),
    "breakdown" JSONB NOT NULL,
    "pricing" JSONB,
    "note" TEXT,
    "noteManual" BOOLEAN NOT NULL DEFAULT false,
    "decision" "deciship"."Decision" NOT NULL DEFAULT 'OPEN',
    "decisionReason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."TariffImportDraft" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "tariffId" TEXT,
    "userId" TEXT,
    "fileName" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "aiReview" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TariffImportDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."TariffVersion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "userId" TEXT,
    "reason" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "rateCount" INTEGER NOT NULL,
    "zoneCount" INTEGER NOT NULL,
    "countryCount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TariffVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."TariffDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "tariffId" TEXT,
    "userId" TEXT,
    "fileName" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "pages" INTEGER NOT NULL,
    "textLayer" BOOLEAN NOT NULL,
    "pageTexts" JSONB NOT NULL,
    "discovery" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TariffDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deciship"."ProcessedEvent" (
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "Member_companyId_idx" ON "deciship"."Member"("companyId");

-- CreateIndex
CREATE INDEX "Member_personId_idx" ON "deciship"."Member"("personId");

-- CreateIndex
CREATE INDEX "BoxPreset_companyId_idx" ON "deciship"."BoxPreset"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Measurement_companyId_measuredById_clientId_key" ON "deciship"."Measurement"("companyId", "measuredById", "clientId");

-- Bir takip numarasının firmada tek güncel sürümü olur. Prisma kısmi dizini şemada gösteremez: yalnız burada.
CREATE UNIQUE INDEX "Measurement_current_tracking_key" ON "deciship"."Measurement"("companyId", "trackingNo") WHERE "supersededById" IS NULL AND "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Measurement_supersededById_key" ON "deciship"."Measurement"("supersededById");

-- CreateIndex
CREATE INDEX "Measurement_companyId_trackingNo_idx" ON "deciship"."Measurement"("companyId", "trackingNo");

-- CreateIndex
CREATE INDEX "Measurement_companyId_measuredAt_idx" ON "deciship"."Measurement"("companyId", "measuredAt");

-- CreateIndex
CREATE INDEX "File_companyId_idx" ON "deciship"."File"("companyId");

-- CreateIndex
CREATE INDEX "File_measurementId_idx" ON "deciship"."File"("measurementId");

-- CreateIndex
CREATE INDEX "Carrier_companyId_idx" ON "deciship"."Carrier"("companyId");

-- CreateIndex
CREATE INDEX "Tariff_companyId_carrierId_idx" ON "deciship"."Tariff"("companyId", "carrierId");

-- CreateIndex
CREATE UNIQUE INDEX "TariffZone_tariffId_country_key" ON "deciship"."TariffZone"("tariffId", "country");

-- CreateIndex
CREATE INDEX "TariffRate_tariffId_zone_idx" ON "deciship"."TariffRate"("tariffId", "zone");

-- CreateIndex
CREATE UNIQUE INDEX "TariffOverflow_tariffId_zone_key" ON "deciship"."TariffOverflow"("tariffId", "zone");

-- CreateIndex
CREATE INDEX "TariffSurcharge_tariffId_idx" ON "deciship"."TariffSurcharge"("tariffId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_carrierId_invoiceNo_idx" ON "deciship"."Invoice"("companyId", "carrierId", "invoiceNo");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_rowIndex_idx" ON "deciship"."InvoiceLine"("invoiceId", "rowIndex");

-- CreateIndex
CREATE INDEX "InvoiceLine_companyId_trackingNo_invoiceId_idx" ON "deciship"."InvoiceLine"("companyId", "trackingNo", "invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLine_companyId_rawHash_invoiceId_idx" ON "deciship"."InvoiceLine"("companyId", "rawHash", "invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLine_measurementId_idx" ON "deciship"."InvoiceLine"("measurementId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tariffId_idx" ON "deciship"."InvoiceLine"("tariffId");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "deciship"."AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "TariffImportDraft_companyId_tariffId_idx" ON "deciship"."TariffImportDraft"("companyId", "tariffId");

-- CreateIndex
CREATE INDEX "TariffImportDraft_createdAt_idx" ON "deciship"."TariffImportDraft"("createdAt");

-- CreateIndex
CREATE INDEX "TariffVersion_tariffId_createdAt_idx" ON "deciship"."TariffVersion"("tariffId", "createdAt");

-- CreateIndex
CREATE INDEX "TariffDocument_companyId_createdAt_idx" ON "deciship"."TariffDocument"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "TariffDocument_createdAt_idx" ON "deciship"."TariffDocument"("createdAt");

-- Firmalar arası bağ veritabanında da kapalıdır: FK denetimi RLS'i atlar, bu yüzden firma sütunu anahtara girer.
-- Bileşik yabancı anahtarlar yalnız burada yazılıdır (schema.prisma "Veritabanı ile şema arasındaki fark").
-- CreateIndex
CREATE UNIQUE INDEX "BoxPreset_id_companyId_key" ON "deciship"."BoxPreset"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Carrier_id_companyId_key" ON "deciship"."Carrier"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "File_id_companyId_key" ON "deciship"."File"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_id_companyId_key" ON "deciship"."Invoice"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Measurement_id_companyId_key" ON "deciship"."Measurement"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_id_companyId_key" ON "deciship"."Member"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Tariff_id_companyId_key" ON "deciship"."Tariff"("id", "companyId");

-- AddForeignKey
ALTER TABLE "deciship"."Member" ADD CONSTRAINT "Member_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."BoxPreset" ADD CONSTRAINT "BoxPreset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Measurement" ADD CONSTRAINT "Measurement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Measurement" ADD CONSTRAINT "Measurement_boxPresetId_fkey" FOREIGN KEY ("boxPresetId", "companyId") REFERENCES "deciship"."BoxPreset"("id", "companyId") ON DELETE SET NULL ("boxPresetId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Measurement" ADD CONSTRAINT "Measurement_measuredById_fkey" FOREIGN KEY ("measuredById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Measurement" ADD CONSTRAINT "Measurement_supersededById_fkey" FOREIGN KEY ("supersededById", "companyId") REFERENCES "deciship"."Measurement"("id", "companyId") ON DELETE SET NULL ("supersededById") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."File" ADD CONSTRAINT "File_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."File" ADD CONSTRAINT "File_measurementId_fkey" FOREIGN KEY ("measurementId", "companyId") REFERENCES "deciship"."Measurement"("id", "companyId") ON DELETE SET NULL ("measurementId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."File" ADD CONSTRAINT "File_createdById_fkey" FOREIGN KEY ("createdById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Carrier" ADD CONSTRAINT "Carrier_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Tariff" ADD CONSTRAINT "Tariff_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Tariff" ADD CONSTRAINT "Tariff_carrierId_fkey" FOREIGN KEY ("carrierId", "companyId") REFERENCES "deciship"."Carrier"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffZone" ADD CONSTRAINT "TariffZone_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffZone" ADD CONSTRAINT "TariffZone_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffRate" ADD CONSTRAINT "TariffRate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffRate" ADD CONSTRAINT "TariffRate_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffOverflow" ADD CONSTRAINT "TariffOverflow_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffOverflow" ADD CONSTRAINT "TariffOverflow_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffSurcharge" ADD CONSTRAINT "TariffSurcharge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffSurcharge" ADD CONSTRAINT "TariffSurcharge_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Invoice" ADD CONSTRAINT "Invoice_carrierId_fkey" FOREIGN KEY ("carrierId", "companyId") REFERENCES "deciship"."Carrier"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Invoice" ADD CONSTRAINT "Invoice_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE SET NULL ("tariffId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."Invoice" ADD CONSTRAINT "Invoice_sourceFileId_fkey" FOREIGN KEY ("sourceFileId", "companyId") REFERENCES "deciship"."File"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "deciship"."Invoice"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."InvoiceLine" ADD CONSTRAINT "InvoiceLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."InvoiceLine" ADD CONSTRAINT "InvoiceLine_measurementId_fkey" FOREIGN KEY ("measurementId", "companyId") REFERENCES "deciship"."Measurement"("id", "companyId") ON DELETE SET NULL ("measurementId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."InvoiceLine" ADD CONSTRAINT "InvoiceLine_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE SET NULL ("tariffId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."InvoiceLine" ADD CONSTRAINT "InvoiceLine_decidedById_fkey" FOREIGN KEY ("decidedById", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("decidedById") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("userId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffImportDraft" ADD CONSTRAINT "TariffImportDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffImportDraft" ADD CONSTRAINT "TariffImportDraft_carrierId_fkey" FOREIGN KEY ("carrierId", "companyId") REFERENCES "deciship"."Carrier"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffImportDraft" ADD CONSTRAINT "TariffImportDraft_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffImportDraft" ADD CONSTRAINT "TariffImportDraft_userId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("userId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffVersion" ADD CONSTRAINT "TariffVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffVersion" ADD CONSTRAINT "TariffVersion_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffVersion" ADD CONSTRAINT "TariffVersion_userId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("userId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffDocument" ADD CONSTRAINT "TariffDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "deciship"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffDocument" ADD CONSTRAINT "TariffDocument_carrierId_fkey" FOREIGN KEY ("carrierId", "companyId") REFERENCES "deciship"."Carrier"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffDocument" ADD CONSTRAINT "TariffDocument_tariffId_fkey" FOREIGN KEY ("tariffId", "companyId") REFERENCES "deciship"."Tariff"("id", "companyId") ON DELETE SET NULL ("tariffId") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deciship"."TariffDocument" ADD CONSTRAINT "TariffDocument_userId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "deciship"."Member"("id", "companyId") ON DELETE SET NULL ("userId") ON UPDATE CASCADE;


-- ---------- Prisma şemasının anlatamadıkları ----------

-- Ölçüm eklenince/düzeltilince etkilenen faturalar takip no'nun son 10 karakteriyle aranır (services/compare.ts).
CREATE INDEX "InvoiceLine_companyId_trackingSuffix_idx" ON "deciship"."InvoiceLine" ("companyId", right("trackingNo", 10));

-- ---------- Satır düzeyinde güvenlik (ARCHITECTURE §4) ----------
-- Bağlam yoksa current_setting NULL ya da '' döner: karşılaştırma doğru olmaz, sıfır satır görünür.
-- FORCE: tablo sahibi de (sod_deciship_admin) ilkeye tabidir. Yabancı anahtar denetimleri Postgres'te RLS'yi atlar.
-- Bağlamı src/db.ts kurar (SET LOCAL eşdeğeri set_config(..., true)).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Member', 'BoxPreset', 'Measurement', 'File', 'Carrier', 'Tariff', 'TariffZone', 'TariffRate', 'TariffOverflow',
    'TariffSurcharge', 'Invoice', 'InvoiceLine', 'AuditLog', 'TariffImportDraft', 'TariffVersion', 'TariffDocument'
  ] LOOP
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

-- Company'nin kimliği Organization.id'dir, firma sütunu "id".
ALTER TABLE "deciship"."Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."Company" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "deciship"."Company"
  USING ("id" = current_setting('app.company_id', true))
  WITH CHECK ("id" = current_setting('app.company_id', true));

-- Olay kimliği firmaya bağlı değil ve işlenmeden önce olayın firması bilinmez. Yalnız olay alıcısının dar kapısı görür.
ALTER TABLE "deciship"."ProcessedEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."ProcessedEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY event_receiver_only ON "deciship"."ProcessedEvent"
  USING (current_setting('app.scope', true) = 'events')
  WITH CHECK (current_setting('app.scope', true) = 'events');

-- Uygulama rolü migration geçmişine erişemez (default privileges bu tabloyu da kapsıyordu).
-- Gölge veritabanında bu tablo yoktur.
DO $$
BEGIN
  IF to_regclass('"deciship"."_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON TABLE "deciship"."_prisma_migrations" FROM sod_deciship;
  END IF;
END $$;
