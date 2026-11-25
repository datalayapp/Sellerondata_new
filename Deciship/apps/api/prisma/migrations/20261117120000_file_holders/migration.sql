-- Y91: aynı PDF faturayı iki kişi aynı anda yüklerse ikincisi süren okumaya bağlanır ve birincinin önizleme dosyasını
-- kullanır. "File"."holders" önizlemeyi hâlâ tutan üyeleri taşır (boş = yalnız yükleyen); vazgeçen listeden çıkar, dosya
-- son kişi vazgeçince silinir (src/services/fileCleanup.ts). Yalnız sütun eklenir; hiçbir satır okunmaz ya da güncellenmez
-- (NO FORCE -> UPDATE -> FORCE gerekmez), eski satırlar boş listeyle başlar (bugünkü davranış), dolu veritabanında da
-- sorunsuz uygulanır. İlke ve yetki değişmez (tablo düzeyinde). schema.prisma: holders String[] @default([]).

-- AlterTable
ALTER TABLE "deciship"."File" ADD COLUMN "holders" TEXT[] DEFAULT ARRAY[]::TEXT[];
