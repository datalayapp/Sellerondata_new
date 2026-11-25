# Durum

Son güncelleme: 2026-11-25. Kısa kalır: neredeyiz, son test durumu, sıradaki adım. Plan `KALANLAR.md`, ritim `.claude/skills/is-akisi/SKILL.md`.

## Neredeyiz

- 2026-11-16 sabah: ilk kararlı nokta, `main` = `f4fe2add`. Sonrası `gelistirme`'de.
- 2026-11-23 gece (sahip uyurken, onayıyla): **TagPress SellerOnData'ya tam araç olarak bağlandı** (Hesap jetonu ve izinler, Postgres `tagpress` şeması + RLS, Merkez uçları, gateway, ortak kabuk, compose servisleri, yerel veriyi aktarma aracı; yerel kip ikinci kip olarak duruyor) ve **yapay zekâ geçidi kuruldu** (`Platform/apps/ai-api`: anahtar deposu, vekil, defter, tavanlar, Merkez harcama ve yönetici ekranları; DeciShip ve TagPress bağlanacak biçimde). Yetki, gizli bilgi, veri ve para işleri bağımsız incelemelerden geçti (R1, R2, R2b, R3, R4); bulguların hepsi düzeltildi ve testlendi. TagPress kayıtta `pilot`.
- Araçlar geçide henüz bağlı değil (`AI_GATEWAY_URL` boş); sahip anahtarı girip sınayınca açılır (KURULUM "Geçidi açmak").
- Yeni ekranlar (Yapay zekâ harcaması, Platform › Yapay zekâ, TagPress'in kabuk içi görünümü) tuvalden geçmedi, yalnız mevcut bileşenlerle kuruldu: sahip onaylar.
- 2026-11-24: TagPress sadeleştirme (sahip istekleri, tuval onaylı): Üretim ortalı tek ızgara (Bekleyen → Düzenle → Onaylı; yükleyince listeye düşer, seçilenleri üret, kartta sil), sağ panelde küçük tezgâh ve aynı ekranda "Ayrıntılı düzenle" penceresi (Baskı masası da), sayfa şablonunda sürükle-yapış, hep görünür Ortala, Temel/Gelişmiş, görünür Sil (kullanılmışsa arşive); yazı taşırken çerçeve kayması düzeldi. Sıradaki TagPress işi ürün tipleri (KALANLAR 2.11).
- 2026-11-25 (sahip istekleri, tuval onaylı): **mobil barkod** artık yalnız takip no alıyor (FedEx 2D barkodu ve 34/22 haneli 96 barkodu ayıklanıyor, birden çok barkodda en uygunu); **taşıyıcı ambalajı** (kendi / poşet: FedEx Pak, UPS Express Pak, DHL Flyer / zarf) bütün taşıyıcılar için: mobilde ölçü ekranında seçim ve kayıttan önce uyarı, taşıyıcı başına sınır, tarifede poşet/zarf fiyatları, faturada "Ambalaj farkı" (Pak sınır içindeyse kesin, zarf ve belirsizler İncele). Para ve veri kısmı iki bağımsız incelemeden geçti, bulgular düzeltildi. Gerçek dosyayla ve telefonda denenmedi (KALANLAR 5.7, TEST-ADIMLARI).
- Yol haritası: https://claude.ai/artifact/SdijYT29LPB3C4WW2uYEDk ; TagPress'in kendi durumu `Tagpress/YOL-HARITASI.md`.

## Son test durumu

- 2026-11-25 (ambalaj ve barkod işi, yerelde): kökte `npm test` yeşil; `npm run test:db` 6 parçanın 5'i yeşil (ai-api `admin.test.ts` bir kez düştü, tek başına geçti; bu işle ilgisiz), API veritabanı testleri son düzeltmelerden sonra yeniden yeşil (1526); panel e2e 8 dosya 131/132 (düşen KALANLAR 0.17, değişikliksiz hâlde de düşüyor). Koşmadı: Merkez e2e, görsel taban, gerçek yığın e2e.
- **GitHub Actions durdu:** 2026-11-23 sabahından beri işler "ödeme başarısız ya da harcama sınırı doldu" diye başlamıyor (GitHub › Settings › Billing & plans). Son yeşil CI `5cfe5fd`; sonrası yerelde doğrulandı: kökte `npm test` (bütün hızlı parçalar) ve `npm run test:db` (6 parça: api, account, auth-kit, product-kit, ai, tagpress) yeşil; Merkez e2e (sahte API) 205/205; Docker'lı gateway testi 251/251; TagPress API, web ve ai-api imajları derleniyor.
- Koşmadı (sahibe): gerçek yığın e2e (`npm run e2e`, `47-tagpress` dahil), DeciShip paneli e2e, görsel karşılaştırma tabanı, gerçek anahtarla ücretli deneme, gerçek TagPress verisinin aktarımı (yalnız kopyasında denendi: 26 tablo, 644 satır, 856 dosya eşit).
- Hiç denenmedi: gerçek telefon (release APK), gerçek e-posta, gerçek kargo faturası, gerçek sunucu ve sertifika, `-Canli` geri yükleme.

## Sıradaki adım

Sahibin sabah yapacakları `KALANLAR.md` Aşama 2'deki "sahip" satırları ve `TEST-ADIMLARI.md` "TagPress ve yapay zekâ geçidi": yeni imajlarla açılış, anahtarı Merkez'den girmek, TagPress'i gerçek firmada açıp yerel veriyi aktarmak, ekranları gözden geçirmek. Sonra DeciShip'in gerçek kullanıma geçişi (2.1).

## Bilinmesi gerekenler

- Çalışan sistemin ayar dosyası `Platform/.env`; `Deciship/.env` okunmuyor. Platform yöneticisi `PLATFORM_OPERATORS` ile (boşsa kimse anahtar giremez).
- Sahibin yerel TagPress'i (`Tagpress\data`, 5420) aktarım dışında hiç kullanılmaz; aktarımdan sonra iki kopya ayrı yaşar.
- Gece yedeği görevi 2026-11-25'te sahip isteğiyle kaldırıldı (gerçek kullanım yok; sunucu kurulunca açılır: `Platform\scripts\yedek-zamanla.ps1 kaydet`, KALANLAR 2.2). Var olan yerel yedekler duruyor. C: diski %95 dolu.
- Gerçek kullanım işareti (`SOD_GERCEK_KULLANIM`) konunca testler 5434'e bağlanmaz: `npm run pg:baslat` (5435).
- Görüntü servisi testleri yalnız `Deciship/services/vision/.venv` Python'uyla geçer.
- Kalıcı silme kapalı gelir (`DELETED_INVOICE_PURGE_DAYS` boş); açmadan önce kuru çalışma (`Platform/docs/KURULUM.md`).
- Telefonda geliştirme sürümü kurulu; Metro ister (`Deciship/TELEFON-KURULUM.md`). Yeni APK çıkınca sürüm 1.2.0 ve sunucuda `MIN_MOBILE_VERSION` (KALANLAR 4.2).
- Elle CI koşusu (`gh workflow run ci.yml -f e2e=true`) aynı daldaki push koşusunu iptal eder.
