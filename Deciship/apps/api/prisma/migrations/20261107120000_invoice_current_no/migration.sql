-- Bir taşıyıcıda aynı numarayla tek canlı fatura olur. Kural POST /invoices ön denetimiyle aynı: firma + taşıyıcı + numara,
-- silinmiş ve kurulum örneği sayılmaz. Ön denetim kur beklemesinden önce çalışır, iki istek onu birlikte geçebiliyordu.
-- Prisma kısmi dizini şemada gösteremez: yalnız burada, schemaCheck ve check-drift korur.

-- Eski hacimde yarıştan kalma kopya varsa dizin kurulamaz. En eski kopya kalır: mükerrer sayımı önceki faturaya bakar,
-- en eskinin sonucu bozulmamıştır. Sonrakiler kullanıcının silmesiyle aynı biçimde işaretlenir, satır ve dosya durur.
-- Sahip de FORCE RLS'ye tabidir ve göçte firma bağlamı yoktur: bu işlem boyunca iki tabloda kapatılır.
ALTER TABLE "deciship"."Invoice" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "deciship"."AuditLog" NO FORCE ROW LEVEL SECURITY;

WITH ranked AS (
  SELECT "id", "companyId", "invoiceNo",
    first_value("id") OVER w AS "keptId",
    row_number() OVER w AS "position"
  FROM "deciship"."Invoice"
  WHERE "deletedAt" IS NULL AND NOT "isSample"
  WINDOW w AS (PARTITION BY "companyId", "carrierId", "invoiceNo" ORDER BY "createdAt", "id")
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

CREATE UNIQUE INDEX "Invoice_current_no_key" ON "deciship"."Invoice"("companyId", "carrierId", "invoiceNo") WHERE "deletedAt" IS NULL AND NOT "isSample";
