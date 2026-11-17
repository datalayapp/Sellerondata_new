-- Fatura numarası büyük/küçük harfe duyarsız tekildir: MNG-CASE-77120 ile mng-case-77120 aynı faturadır.
-- Önceki göçle aynı kural: en eski kopya kalır, sonrakiler silinmiş sayılır ve izi yazılır, satır ve dosya durur.
-- Sahip de FORCE RLS'ye tabidir ve göçte firma bağlamı yoktur: bu işlem boyunca iki tabloda kapatılır.
ALTER TABLE "deciship"."Invoice" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."AuditLog" NO FORCE ROW LEVEL SECURITY;

WITH ranked AS (
  SELECT "id", "companyId", "invoiceNo",
    first_value("id") OVER w AS "keptId",
    row_number() OVER w AS "position"
  FROM "deciship"."Invoice"
  WHERE "deletedAt" IS NULL AND NOT "isSample"
  WINDOW w AS (PARTITION BY "companyId", "carrierId", lower("invoiceNo") ORDER BY "createdAt", "id")
), retired AS (
  UPDATE "deciship"."Invoice" i
  SET "deletedAt" = now() AT TIME ZONE 'UTC', "updatedAt" = now() AT TIME ZONE 'UTC'
  FROM ranked r
  WHERE i."id" = r."id" AND r."position" > 1
  RETURNING i."id", i."companyId", i."invoiceNo", r."keptId"
)
INSERT INTO "deciship"."AuditLog" ("id", "companyId", "userId", "action", "entity", "entityId", "data", "updatedAt")
SELECT gen_random_uuid()::text, "companyId", NULL, 'invoice.delete', 'Invoice', "id",
  jsonb_build_object('reason', 'duplicate_invoice_no', 'keptInvoiceId', "keptId", 'invoiceNo', "invoiceNo"),
  now() AT TIME ZONE 'UTC'
FROM retired;

ALTER TABLE "deciship"."Invoice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."AuditLog" FORCE ROW LEVEL SECURITY;

DROP INDEX "deciship"."Invoice_current_no_key";
CREATE UNIQUE INDEX "Invoice_current_no_key" ON "deciship"."Invoice"("companyId", "carrierId", lower("invoiceNo")) WHERE "deletedAt" IS NULL AND NOT "isSample";
