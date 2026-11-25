-- DS-AI (YAPAY-ZEKA-GECIDI §3, §6): DeciShip'in sayaç satırı geçidin defter satırını taşır (`x-sod-ai-call-id`). Yalnız boş
-- olabilir yeni sütun; mevcut satırlara dokunulmaz (veri ifadesi yok), RLS ilkeleri ve yetkiler değişmez (tablo düzeyinde).
-- Dizin yok: uzlaştırma (`ai:reconcile`) dönem dizinini (`companyId, period`) kullanır. Kilit beklemesi sınırlı: yoğun tabloda göç
-- beklemek yerine düşer, yeniden koşulur.
SET lock_timeout = '5s';

ALTER TABLE "deciship"."AiUsage" ADD COLUMN "gatewayCallId" TEXT;
