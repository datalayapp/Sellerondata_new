# Geçerli kararlar

Bugün geçerli kararların tek listesi; konuya göre, parçaları `Platform/docs/kararlar/` içinde. Başka bir belge bununla çelişirse bu liste doğrudur; kod ile çelişirse kod doğrudur, belge düzeltilir.

- Yeni karar ilgili konunun altına tek madde olarak eklenir; eskisi silinir. Tarih yalnız sahip için anlamlıysa yazılır.
- "kullanıcı kararı": sahibin kendisinin verdiği karar. İşaretsiz maddeler sahip adına verilip onaylanmış ya da onaya sunulmuş kararlardır; hepsi geri alınabilir.
- **Kalın etiketler** ve başlıklar kodda alıntılanır (ör. KARARLAR "Birebir aynı satır"); adları değiştirilmez. Etiketin hangi parçada olduğu aşağıdaki tabloda.
- Teknik ayrıntı burada değil: sözleşme `ARCHITECTURE.md §N`, tasarım `DESIGN.md`, komut ve ortam değişkeni `KURULUM.md`, DeciShip alan kuralı `Deciship/SPEC.md §N`.
- Açık işler ve bekleyen kararlar burada değil: `SONRAKI-OTURUM/KALANLAR.md`.

Son güncelleme: 2026-11-25.

## Konular

| Konu | Dosya | Neler var (kodda alıntılanan etiketler kalın) |
|---|---|---|
| Hesap, kayıt, yetki ve güvenlik | `kararlar/hesap-ve-yetki.md` | Adresler, tek hesap, kayıt yalnız davetle (kapalı deneme), Merkez ve yetkiler, **Firma yönetimi yalnız tarayıcıdan**, hazır roller, **Özel roller**, e-posta doğrulaması, oturum ve sınırlar, davet ve devir, destek ve açılış korumaları |
| Firma, abonelik ve Merkez | `kararlar/firma-ve-merkez.md` | **Firma kapatma ve silme** (sahip kapatır, 30 gün sonra silinir), araç kaydı ve abonelik (**İptal: 90 gün salt okunur**, destek komutu `org:close`), **Merkez kurulumu ve araç kurulumu**, Merkez ekranları, yapay zekâ kullanımı ekranı, **Yapay zekâ geçidi ve harcama** |
| Dil, ortak arayüz ve mobil | `kararlar/arayuz-dil-mobil.md` | **İlk açılış dili**, site dili, para birimi, **Ortak arayüz** (tasarım dili, yapı, yazım, davranış, hata olunca kullanıcı ortada kalmaz, erişilebilirlik), mobil, mobil sürüm uyumu |
| DeciShip ürün kararları: fatura ve hesap | `kararlar/deciship-hesap.md` | Fatura yükleme ve okuma (ağırlıkta "1.500" yazımı, **K36**), KDV, **Emin olunmayan fark kesin gösterilmez** (**İncele**, **Yakıt**, **Karışık hizmet**, **Mükerrer**, **Birebir aynı satır**, iade, sıfır tutar, **Ölçüm sınırı**, **Taşıyıcı ambalajı (Pak/Zarf)**, **Parasız fark**, **Tutar toleransı**, kur alınamazsa), **Geçmiş sonuçlar donar** |
| DeciShip ürün kararları: akış, itiraz, yapay zekâ, dosyalar | `kararlar/deciship-akis.md` | **DeciShip akışı ve Merkez sadeleştirme** (toplu karar, faturalar, deneme turu), itiraz (**Kullanıcıya açık olma**, süre hatırlatması), yapay zekâ (kota, günlük tavan, tartı okuması), uzun işler ve dosyalar, silinenlerin kalıcı silinmesi, raporlar |

## Marka ve ürünler

- SellerOnData üst markadır. Altında üç eş araç: **DeciShip**, **OrderLoom**, **TagPress**. Adlar her dilde aynıdır.
- Satış ve fatura DatalaYapp'tan. GiftUpStore yalnız bir müşteridir.
- Önce DeciShip yayınlanır. OrderLoom sıfırdan yazılacak; Merkez'de tıklanamaz yer tutucudur ("Yakında").
- **TagPress tam araç olarak bağlı** (kullanıcı kararı 2026-11-23): Hesap jetonu ve firma, Postgres `tagpress` şeması (RLS), Merkez uçları, gateway, ortak kabuk. Açıklığı kayıttaki durumdan (`pilot`: yalnız aboneliği olan firma). Yön ve kalanlar `Tagpress/YOL-HARITASI.md`.
- TagPress'in girişsiz, SQLite **yerel kipi ikinci kip** olarak kalır (tek başına kullanım); varsayılan kip platform. Yerel veriyi platforma taşıma aracı var (`tagpress-aktar.ps1`), iki yön arasında eşitleme yok.
- TagPress'in mobil ekranı yok; tasarım işi yalnız web'de, sayıları Merkez'de.
- S işareti kalıcı marka işaretidir.
- Uygulama içinde "araç" denir; sitenin ticari başlıklarında "ürün" kalabilir ("Abonelik ve araçlar").

## Kod, depo ve CI

- Tüm proje tek depoda: `github.com/GokcanT/SellerOnData`; çalışma dalı `gelistirme`, uzağa gönderilir; `main`'e birleştirme sahiptedir.
- Eski DeciShip verisi korunmaz; taşıma betiği yok. Canlı kurulum sıfırdan yapılır.
- Node 24.22.1.
- Workspaces yok; yerine paket uyum denetimi (`npm run check`). Karar sahipte.
- Toplu kod biçimleme (Prettier) öbür işler bitince tek ayrı commit olarak yapılır; o zamana dek `npm run format:check` yalnız sayar.
- CI: her gönderimde hızlı iş (depo denetimi, lint, tip denetimi, veritabanısız testler); veritabanı işi veritabanına dokunan yol değişince kendiliğinden (`scripts/ci-select.mjs`), `[db]` zorlar, son commit'te `[db-sonra]` erteler. Yalnız not ve belge değişen gönderimde CI koşmaz. e2e her gece ve elle. Mobil derleme ve Docker imajı CI'da yok. Ayrıntı: KURULUM.md "CI ve ön-commit kancası".
- Ön-commit kancası yalnız hızlı denetimdir (depo denetimi + eklenen dosyaların lint'i); kurulum `npm run hooks:install`.
- **`exceljs` (4.4.0) bakımı durmuş ama kalıyor.**
  - Kullanıldığı yer: hesap motorunda Excel fatura ve tarife okuma (`core/src/invoice/read.ts`, dinamik içe aktarma), API'de Excel raporu ve tarife şablonu (`services/reports.ts`, `tariffExcel.ts`), `samples/tools`. Mobil `exceljs` çekmez (lint kuralı).
  - `npm audit` iki orta uyarı veriyor (`uuid@8`, yalnız `v3/v5/v6`'ya `buf` verilince); `exceljs` yalnız argümansız `uuid.v4()` çağırıyor, açık bize ulaşmıyor.
  - Güvenlik önlemleri `exceljs`'ten bağımsız: dosya açılmadan zip denetimi (`invoice/zipGuard.ts`, JSZip doğrudan bağımlılık), satır ve açılmış boyut sınırı, okuma dosya çalışanında (SPEC §5.12).
  - Yeniden bakılacak durumlar: bize ulaşan bir açık, Node yükseltmesinde kırılma ya da okunamayan bir Excel biçimi; o zaman okuma için SheetJS, yazma için akışlı başka bir yazıcı (iki taraf ayrı değişebilir).

## Bilinçli ertelenenler

Ödeme (yer tutucu), deneme süresi (yok), fiyat birimi, iptal sonrası veri silme, SMS, KVKK ve sözleşmeler, marka tescili, mağaza yayını ve canlı kurulum sona bırakıldı; bunlar hata değil. Liste: `SONRAKI-OTURUM/KALANLAR.md` "Yayından önce".

- SMS gelene dek telefon numarası kapma kabul edilen risktir; destek komutu `phone:release`.
