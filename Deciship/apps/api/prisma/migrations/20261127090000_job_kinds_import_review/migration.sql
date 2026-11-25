-- KALANLAR 6.18: büyük CSV/Excel fatura içe aktarma (`INVOICE_IMPORT`) ve tarife içe aktarmanın yapay zekâ incelemesi
-- (`TARIFF_IMPORT_REVIEW`) arka plan işi oldu. Yalnız yeni enum değerleri; mevcut satırlara dokunulmaz, aynı göçte
-- kullanılmaz (PostgreSQL yeni enum değerini aynı işlemde kullandırmaz).
ALTER TYPE "deciship"."JobKind" ADD VALUE IF NOT EXISTS 'INVOICE_IMPORT';
ALTER TYPE "deciship"."JobKind" ADD VALUE IF NOT EXISTS 'TARIFF_IMPORT_REVIEW';
