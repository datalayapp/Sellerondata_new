-- Y60: sayaç satırında "tahmin" işareti. Bağlantı koptuğunda ya da süre dolduğunda çıktı tokeni akan metinden tahmin edilir
-- (alt sınır, `services/ai.ts` `AI_CHARS_PER_OUTPUT_TOKEN`); bugüne dek bu yalnız günlükte görünüyordu. Satırın kotaya ve
-- tutara nasıl girdiği değişmez; yalnız işaretlenir.
-- Yalnız varsayılanlı sütun eklenir; hiçbir satır okunmaz ya da güncellenmez (NO FORCE -> UPDATE -> FORCE gerekmez), dolu
-- veritabanında da sorunsuz uygulanır. Eski satırlar `false` kalır: geçmişte tahmin edilmiş satır sütundan ayırt edilemez.

-- AlterTable
ALTER TABLE "deciship"."AiUsage" ADD COLUMN "estimated" BOOLEAN NOT NULL DEFAULT false;
