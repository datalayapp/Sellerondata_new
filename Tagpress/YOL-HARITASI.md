# TagPress — yol haritası

> 2026-11-21 ve 2026-11-23 kullanıcı kararları. Bu dosya `PLAN.md` ve `HANDOFF.md` ile çelişirse bu dosya geçerlidir;
> o ikisi eski "Etiket Studio" (yerel, tek kullanıcı) dönemini anlatır ve motor, baskı, tasarım dili verisi için hâlâ doğru kaynaktır.

## Hedef

TagPress, SellerOnData'nın bir aracıdır (DeciShip gibi). İki aşama:

1. **Tek başına sorunsuz araç.** Baştan itibaren başka satıcıların kullanacağı genel ürün olarak düşünülür
   (yalnız sahibin bilgisayarı için değil). Yalnız TagPress kullanmak isteyen kişi diğer araçlardan bağımsız çalışabilir.
2. **SellerOnData'ya bağlama** (yapıldı, 2026-11-23). Hesap servisi, firma ayrımı, Merkez uçları, gateway (`Platform/docs/mimari/06-merkez.md` "Yeni araç ekleme"); kod haritası `SONRAKI-OTURUM/kod-haritasi/tagpress.md`.

## Kararlar

| Konu | Karar |
|---|---|
| Kitle | İlk aşamadan beri genel ürün; tek kullanıcı varsayımı bırakılır |
| Tasarım dili (arayüz) | Eski "Baskı Provası" tamamen bırakılır. Sıfırdan, Merkez ve DeciShip ile uyumlu, TagPress moru (`#7a5af8`), "tasarım yapma uygulaması" olduğu anlaşılan dil. Seçenekler önce tuvalde; onaydan sonra kod |
| Kapsam | Bütün özellikler kalır, ama kişiye göre açılır: **Kurulum**da kullanıcının ihtiyacına uyan özellikler açılır, gerisi kapalıdır; kullanıcı sonradan istediğini açar. Varsayılan görünüm sade, en ortak kullanıma göre |
| Tasarım dili oluşturma | Claude Code + MCP yerine **sitede, API ile**: sorular ve örnek etiket yükleme → yapay zekâ dili kurar → örnek etiketlerle gösterir → kullanıcı düzeltme ister, dil güncellenir (tekrarlı). Kurulumun parçası. Tasarım dili yoksa varsayılan ayarlar kullanılır ve kullanıcıya gösterilir |
| Entegrasyon hazırlığı (1. aşamada) | TR/EN sözlük, TagPress adına geçiş, verilerde firma alanı, Windows'a özel yolların temizliği. Giriş, Postgres ve sunucuya taşıma 2. aşamada (yapıldı) |
| Sıra | Önce temizlik ve tasarım; kalite hedefleri (satır bölme %85, boyut %70) ve gerçek baskı/kesim denemesi sonra |
| Mobil | TagPress'in tasarım işleri yalnız webde yapılır; mobil uygulamada TagPress ekranı olmaz. İstatistik ve analiz verileri Merkez'de görünür (2. aşamada Merkez uçları: özet, analiz, veri, etkinlik) |
| Yapay zekâ anahtarı ve harcama (2026-11-21) | Anahtar SellerOnData düzeyinde tek yerde durur, platform sahibi bir kez girer, bütün araçlar onu kullanır; firmalar anahtar girmez (ileride firmanın kendi anahtarı seçeneği eklenebilir). Bütün araçların yapay zekâ harcaması tek "yapay zekâ harcaması" görünümünde araç araç, ayrıntılı görünür. Geçit kuruldu (`SONRAKI-OTURUM/YAPAY-ZEKA-GECIDI.md`); `SUNUCU-PLANI.md` §8.1 bu kararla kapandı (ürünün anahtarı) |
| Kesim şekli (2026-11-21) | Kesim şekli ve ölçüsü tasarım dilinin değil **şablonun** ayarı olur: aynı tasarım dilinde daire, dikdörtgen (ör. 63,5 × 38,1 mm ürün etiketi) ve kare etiketler birlikte bulunabilir. Tasarım dilindeki kesim ayarı, şablonu kesim bilgisi taşımayan eski kayıtlar için varsayılan olarak kalır. Varsayılan içeriğe dikdörtgen ürün etiketi ve kare şablon eklenir |
| Baskı ölçüleri (2026-11-21) | Fiziksel ölçünün tek kaynağı mm; piksel yalnız çıktı anında hesaplanır. Varsayılanlar baskıya uyumlu seçilir (kullanıcı ayarları orkestratöre bıraktı); yalnız karar gerektirenler kurulumda sorulur |
| Yapay zekâ deneme bütçesi (2026-11-21) | Tasarım dili oluşturmanın gerçek Claude API ile denenmesi için 10 dolara kadar harcama onaylandı (önceki ≤ 20 dolar toplam bütçenin içinde ayrı izin). Her denemenin maliyeti kaydedilir ve raporlanır |
| Görsel denetim (2026-11-21) | Üründen kaldırılır: sonucu iyileştirmediği ölçüldü, maliyeti artırıyordu |
| Kalan kararlar (2026-11-21) | `SUNUCU-PLANI.md` §9 ve `SONRAKI-OTURUM/YAPAY-ZEKA-GECIDI.md` §9: örnek etiketler saklanır; "birden çok dil" iki ayrı seçenek; örneksiz kullanıcı sorularla dil kurar; yapay zekâ geçidi onaylı (zamanlaması 2026-11-23'te "şimdi" oldu), firmaya tutar TL, aylık hak tek ve ortak |
| Kesim değişince onaylar (2026-11-22) | Şablonun (ya da dilin) kesim şekli/ölçüsü sonradan değişirse o şablonla onaylanmış ve henüz basılmamış işlerin onayı düşer, yeniden kontrol istenir; basılmış işlere dokunulmaz |
| Çok firmalı kuyruk payı (2026-11-22) | Birden çok firma varken tek başına iş gönderen firma bir üretim yuvasını boş bırakır (sonradan gelen beklemez); tek firmalı kurulumda fark yok. İnce ayar, değiştirilebilir |
| Gece oturumu kararları (2026-11-23) | Orkestratörün verdiği, geri alınabilir kararlar; liste tablonun altında |
| 2. aşama: platforma bağlama (2026-11-23) | TagPress SellerOnData'ya tam araç olarak bağlanır: hesap ve firma (jeton, kimlik izdüşümü, olaylar), Postgres (`tagpress` şeması, RLS), Merkez uçları (genel bakış, analiz, veri setleri, etkinlik), gateway, ortak kabuk. Yerel kip (girişsiz, SQLite) ikinci kip olarak kalır. Yapay zekâ geçidi şimdi kurulur; TagPress ve DeciShip ikisi de geçide bağlanır (önceki "DeciShip oturduktan sonra" kararı kalktı). TagPress rolleri: Yönetici ve Kullanıcı (iki rol) |
| Git | Ayrı depo kaldırıldı; klasör ana SellerOnData deposuna girer (`Tagpress/`, dal `gelistirme`). Eski geçmiş masaüstünde `TagPress-eski-git-2026-11-21` |

**Gece oturumu kararları (2026-11-23):**
- Kurulum yeniden çalıştırılınca ekranda kapatılan (listede olmayan) özellik kapanır; gizli ve her zaman açık özelliklere dokunulmaz.
- Kesim değişince silinmiş (geri alınabilir) işlerin onayı da düşer; geri almada kesim değişmişse onay geri gelmez.
- `print.stickers` yalnız yeni sticker şablonu yazarken denetlenir; adlandırma, arşiv, oturum açma, yeniden basma serbest.
- Baskı sayfa/öğe kimliğini her zaman sunucu verir (`ids` eşlemesi; `SUNUCU-PLANI.md` §10.3 kapandı).
- Kurulumdaki kağıt yeni sayfa şablonunun varsayılanıdır; sticker ölçüsü profile kendiliğinden yazılmaz.
- Oluşturucu: oturum sürerken dil başka yoldan yayınlandıysa ya da taslak değiştiyse yayın durur (`build-base-changed`), kullanıcı "Yine de yayınla" diyebilir; dışarıdan gelen taslak ezilmez, oturum geçmişine `manual` revizyon olarak yazılır. Ölçüm kanıtı yalnız istatistik düğümleri; modele gösterilmiş örnek ayrılmış kümeye girmez; bütçe her istekten önce yeniden hesaplanır.

## İş sırası

1. Ana depoya taşıma (klasör adı `Tagpress`, denetimler yeşil, tek commit).
2. Arayüz tasarım dili: tuvalde seçenekler → seçim → ekran ekran yeniden tasarım.
3. Temizlik: Figma kalıntıları, eski adlar (`etiket-studio`, `@studio/*`, "Etiket Studio"), eski klasöre bağlı yollar ve fontlar, eksik `pnpm durum`, tek seferlik aktarım betikleri.
4. Entegrasyon hazırlığı: TR/EN sözlük, firma alanı, Windows bağımlılıkları (DPAPI, `WINDIR\Fonts`).
5. Kurulum akışı ve özellik anahtarları (kişiye göre açılan özellikler).
6. Sitede tasarım dili oluşturma (soru + örnek + AI + düzeltme döngüsü; varsayılan dil).
7. Kalite hedefleri ve gerçek baskı denemesi.
8. 2. aşama: platforma bağlama.

## Durum (2026-11-23, 2. aşama gece oturumu sonu)

İş sırasının sekiz maddesi de bitti: TagPress SellerOnData'nın tam aracıdır, yerel kip ikinci kip olarak durur. Kod `gelistirme`'de; testlerin son sonucu `npm run ci:son`. Ayrıntı commit mesajlarında.

**1. aşama (tek başına araç)**
- Ana depoya taşıma, ad temizliği (`@tagpress/*`, ortam değişkenleri `TAGPRESS_*`; eski `STUDIO_*` adları da okunur), Figma kalıntıları ve görsel denetim kaldırıldı.
- Arayüz Tezgâh: bütün ekranlar (Üretim, Düzelt, İçe aktarma, Baskı masası, Sayfa şablonları, Arşiv, Şablonlar, Tasarım dili, Oluştur, Ayarlar, Kurulum); temel katman `apps/web/src/tezgah` (`OKU.md`), plan `ARAYUZ-PLANI.md`, maketler `docs/tezgah-tuval.html`, `docs/tezgah-tuval-2.html`.
- Sunucu: kodlu mesajlar (`docs/sunucu-kodlari.md`), anahtar şifreleme, güvenli dosya yolları, firma kapsamı, varsayılan içerik, özellik anahtarları ve kurulum, baskı ölçüleri mm, şablon kesimi ve kesim değişince onay düşmesi; plan `SUNUCU-PLANI.md`.
- Tasarım dili oluşturucu (Oluştur): gerçek Claude API ile uçtan uca denendi (oturum başına 0,8–0,9 dolar; kalan deneme bütçesi yaklaşık 7,3 dolar).
- Bilerek değişmeyenler: veritabanı dosyası `studio.db`, yerel kipte `X-Studio` başlığı ve `studio-header-missing` kodu, tarayıcıdaki `studio.*` anahtarları, dil paketi biçimi `etiket-studio-dil`, istem sürüm adları `studio-*-vN`.

**2. aşama (platforma bağlama)**
- Kip: `TAGPRESS_AUTH=platform` (varsayılan; Hesap jetonu, Postgres) ya da `local` (girişsiz, SQLite; `pnpm dev`, `pnpm start` kendisi verir). Aynı servis kodu iki veritabanında çalışır: Postgres'e senkron köprüyle, SQL tek kaynaktan.
- Postgres `tagpress` şeması: 26 firma tablosu, `org_id` + zorunlu RLS, product-kit kimlik izdüşümü, düz SQL göçleri; SQLite göç 14 (üye izi).
- Hesap: izinler `tagpress.*`, roller Yönetici ve Kullanıcı; hesap olayları (üye, firma kapanış/açılış, kalıcı silme dosyalarla birlikte); yeni firmaya ilk istekte varsayılan içerik. Ücretli eylem `ai.use` + `work.edit` ister; harcama tutarlarını yalnız Yönetici görür.
- Merkez uçları (`/api/tagpress/platform/*`: genel bakış, analiz, veri setleri, dışa aktarma, etkinlik); müşteri metni bu yanıtlarda yok.
- Web platform kipinde `/tagpress/`, ortak kabuk (`AppShell workspace`, `work` bandı), oturum, firma değiştirme, yetkiye göre gizlenen bölümler; belirteçler `Platform/packages/tokens` → `apps/web/src/tezgah/tokens.generated.css`.
- Compose servisleri (`tagpress-migrate`, `tagpress-api`, `tagpress-web`, `tagpress-aktar`), gateway, yedek ve geri yükleme, CI parçası `tagpress-db`; aktarım aracı `pnpm aktar:pg` ve `Platform/scripts/tagpress-aktar.ps1` (gerçek verinin kopyasında denendi: 26 tablo, 644 satır, 856 dosya eşit, kaynak değişmedi).
- Yapay zekâ platform kipinde yalnız SellerOnData geçidinden (`SONRAKI-OTURUM/YAPAY-ZEKA-GECIDI.md`); geçit adresi boşken yapay zekâ kapalı, gerisi çalışır.

**Sahibin sabah yapacakları** (adımlar `SONRAKI-OTURUM/TEST-ADIMLARI.md` "TagPress ve yapay zekâ geçidi")
1. Yerel TagPress'i kapat (5420), `Tagpress\data`'yı elle kopyala.
2. `Platform\DURDUR.bat`, `Platform\BASLAT.bat` (yeni imajlar).
3. `PLATFORM_OPERATORS`, Merkez › Platform › Yapay zekâ'da anahtarları gir ve sına; geçidi aç (`AI_GATEWAY_URL`).
4. Gerçek firmada TagPress'i aç (`subscription:set`), kendine Yönetici rolü ver, Merkez'den TagPress'i bir kez aç.
5. Aktarım: `tagpress-aktar.ps1 -Firma <kimlik> -KuruCalisma`, sayıları oku, sonra gerçek; verini TagPress'te kontrol et.
6. Küçük ücretli deneme; Merkez › Abonelik › Yapay zekâ harcaması'nda satır.
7. Yeni ekranları ve [V] kararları gözden geçir (KALANLAR 2.9).

**Kullanıcıya kalan (gözetimsiz oturum YAPMAZ)**
- Gerçek kâğıda deneme baskısı ve cetvelle ölçüm (sticker 5255 yaklaşık 45,9 mm genişlik; etiket dairesi 38 mm); taslak sticker oturumunda "Yeniden planla". Firma adı artık Merkez › Firma'dan ("GiftUpStore").
- Claude Code'u `Tagpress` klasöründe açınca proje MCP sunucusu `tagpress` için bir kez onay. MCP yalnız yerel kipte çalışır.
- Kalite hedefleri (satır bölme %85, boyut %70): ücretli ölçüm ister.
- Küçük açık noktalar: para biçimi (`$0,002` / `0,012 $`), `X-Studio` başlığının adı, Oluştur vitrin kartında uzun adın kısalması, Tarz notu farkının bütün paragrafı üstü çizili göstermesi.

**Kalanlar** (`SONRAKI-OTURUM/KALANLAR.md`): servislerin asenkron veritabanına ve dosyaların nesne deposuna geçişi (6.35), MCP'nin platform kipi (6.36), `X-Studio` adı (6.37), npm'e/ortak düzene çevirme (6.29); `SUNUCU-PLANI.md` §10 (çok firmalıya açılmadan önce).

Değişmezler (`CLAUDE.md`) aynen geçerli: AI piksel koordinatı üretmez; müşteri metni otomatik değişmez; tarz koda değil tasarım diline yazılır; "şablona yaz" modunda şablon pikseline dokunulmaz.
