-- Sistemin günlük yapay zekâ tavanı (kapalı deneme kararı 2026-11-12, denetim 05-B3): API bütün firmaların bugünkü
-- `AiUsage` tutar toplamını okuyabilsin (src/services/aiDailyBudget.ts, kapı src/db.ts withAiBudgetScope).
-- Yalnız SELECT ve yalnız son 2 günün satırları ("createdAt" UTC saklanır); ekleme, güncelleme, silme ve başka tablo
-- bu kapsamda AÇILMAZ (Company dahil). Kapsam yalnız aiDailyBudget.ts'ten açılır (test/aiDailyBudget.test.ts sınar).
-- Yalnız ilke eklenir; hiçbir satır güncellenmez (NO FORCE -> UPDATE -> FORCE gerekmez), tablo ve sütun değişmez.
-- Geri almak: DROP POLICY ai_budget_read ON "deciship"."AiUsage";
CREATE POLICY ai_budget_read ON "deciship"."AiUsage" FOR SELECT
  USING (current_setting('app.scope', true) = 'ai_budget' AND "createdAt" >= (now() AT TIME ZONE 'UTC') - interval '2 days');
