-- Özel roller (SONRAKI-OTURUM/ARSIV/PLAN-ozel-roller.md, bölüm B): üyenin rolündeki geçerli izinler. Hesap olayı
-- (`member.upserted.permissions`) ya da jeton (`ProductClaim.perms`) taşır; auth-kit katalogla kesiştirir.
-- NULL: rolden katalogla türet (eski biçim olay ya da jeton; hazır rol). Geri doldurma yok (bilerek): var olan üyeler
-- NULL kalır ve bugünkü gibi rolden türer; Hesap'ın `members:announce` duyurusu ya da sonraki jeton eşitlemesi doldurur.
-- Yeni sütun, veri ifadesi yok: tablonun RLS'i (init göçü) olduğu gibi geçerli, yeni RLS bloğu gerekmez.

-- AlterTable
ALTER TABLE "deciship"."Member" ADD COLUMN "permissions" TEXT[];
