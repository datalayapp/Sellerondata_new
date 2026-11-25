-- Y89: düzgün kapanışta bırakılan işin sayacı (deneme hakkı iş başına en çok MAX_SHUTDOWN_REFUNDS kez geri sayılır,
-- src/services/jobs/runner.ts) "error" sütununun içinde ({ code: 'JOB_RELEASED', details: { releases } }) tutuluyordu;
-- geçici hata yazımı onu sıfırlıyordu. Artık ayrı sütun.
-- Yalnız sütun eklenir; hiçbir satır okunmaz ya da güncellenmez (NO FORCE -> UPDATE -> FORCE gerekmez), dolu veritabanında
-- da sorunsuz uygulanır. Eski satırlar 0 ile başlar: yeni kod sayacı GREATEST("releases", "error" içindeki sayaç) olarak
-- okur, ikisine birden yazar. Böylece göç sırasında süren ya da kuyruktaki iş sayacını kaybetmez ve kademeli yayında eski
-- sürüm (yalnız "error"u okuyan) yeni sürümün yazdığı değeri de görür. İlke ve yetki değişmez (tablo düzeyinde).
-- schema.prisma: releases Int @default(0). test/jobs.test.ts sınar.

-- AlterTable
ALTER TABLE "deciship"."Job" ADD COLUMN "releases" INTEGER NOT NULL DEFAULT 0;
