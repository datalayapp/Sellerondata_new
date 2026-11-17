-- Yenileme toleransı olaya bağlanır (04-B1): her döndürmede yeni satır, kendisini doğuran yenilemede SUNULAN satırı yazar.
-- Döndürülmüş eski jeton yalnız ailenin başı onun sunumuyla doğduysa (yeni jeton henüz kullanılmadıysa) kabul edilir.
-- Boş olabilir: girişle açılan satır ve bu göçten önceki satırlar (onlarda eski kural, yalnız süre, geçerli kalır).
-- Yabancı anahtar yok: satırlar bakım turunda ayrı ayrı silinir, ebeveyn silinince çocuk etkilenmemeli.
ALTER TABLE "platform"."Session" ADD COLUMN "parentId" TEXT;
