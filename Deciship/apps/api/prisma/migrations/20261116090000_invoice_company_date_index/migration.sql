-- Y145 (05-B7): Analiz ve fatura listesi firmanın faturalarını tarih aralığıyla okur; "Invoice"ta (companyId, invoiceDate)
-- dizini yoktu. Yalnız dizin eklenir (ön toplam / rollup YOK); hiçbir satır okunmaz ya da güncellenmez (NO FORCE -> UPDATE
-- -> FORCE gerekmez), tablo ve sütun değişmez, dolu veritabanında da sorunsuz uygulanır. schema.prisma: @@index([companyId, invoiceDate]).

-- CreateIndex
CREATE INDEX "Invoice_companyId_invoiceDate_idx" ON "deciship"."Invoice"("companyId", "invoiceDate");
