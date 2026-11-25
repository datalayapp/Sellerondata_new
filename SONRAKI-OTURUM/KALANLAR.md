# Kalanlar

Tek plan. Bir satır = bir iş = bir commit; biten satır silinir, yeni iş tek satır. Ritim: `.claude/skills/is-akisi/SKILL.md`.

- Tür: hata, özellik, artık, test, altyapı, ayar, sahip (kullanıcının işi). Boyut: S < yarım gün, M 1–2 gün, L.
- Kısaltmalar: `core/` = `Deciship/packages/core/src/`, `api/` = `Deciship/apps/api/src/`, `web/` = `Deciship/apps/web/src/`, `mobil/` = `Deciship/apps/mobile/`, `acc/` = `Platform/apps/account-api/src/`.
- Kaynak A–E: masaüstündeki arşivde `yol-haritasi-incelemeleri/` (A işletme, B DeciShip, C platform, D süreç, E mobil); "B4.3" = B, bölüm 4, madde 3.

## 0. Gelen kutusu

Sahibin bulduğu hatalar: `tarih · ekran · ne yaptım · ne bekledim · ne oldu · görüntü`. Oturum başında her satır ya düzelir ya aşağıya satır olur.

- 2026-11-22 · DeciShip PDF · yanlışlıkla 33 sayfalık fiyat anlaşması yüklendi · fatura olmadığı erken anlaşılsın · 5'er sayfalık 7 çağrı (~30 TL) yapıldı · öneri: ilk parçada fatura satırı yoksa dur ve sor (sahip kararı bekliyor)

## Aşama 0 — Zemin (~1 hafta, 1 ile aynı anda)

Bitti: CI bir hafta yeşil ya da kırılınca aynı gün düzeliyor.

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 0.13 | En sonda tek ayrı Prettier commit'i | altyapı | – | S | – |
| 0.17 | Panel e2e `layout-guards.spec.ts` "itiraz metni penceresi 390×640" artık sürekli düşüyor (2026-11-25: Kopyala düğmesi alt kenarı 680 > 640; değişiklikler kenara alınmış HEAD'de de düşüyor, ambalaj işiyle ilgisiz) | test | görünüm | S | – |
| 0.18 | Görsel karşılaştırma tabanı 2026-11-23 sonrası: Merkez yeni senaryolar (Yapay zekâ harcaması, Platform › Yapay zekâ) taban alır, eski Merkez ve panel senaryolarında fark yok mu; TagPress web için görsel test yok (yalnız elle tur) | test | görünüm | S | – |
| 0.19 | Gerçek yığın denemeleri (Docker, ağır): `npm run e2e` (`47-tagpress`, `60-iki-firma`, `00-sistem`), `bash gateway/test/run.sh`, `bash infra/postgres/verify.sh` yeni kiracılarla (`tagpress`, `ai`) | test | güvenlik | S | KURULUM "Uçtan uca testler" |
| 0.16 | Görsel: panel `12-kurulum-ozet` (390 px) adım şeridi 2026-11-16 gecesi bir commit'le ~1 px kaydı (nedeni bulunmadı; belirteç temizliği değil); taban yenilendi. Şeridin ilk kaydırması (`Onboarding.tsx` `Stepper`) yazı tipi/veri geç gelirse kayıyor olabilir | test | görünüm | S | – |

## Aşama 1 — DeciShip gerçek veriye hazır (3–4 gün)

Bitti: satırlar kapandı, testleri var; para satırları (1.1–1.9) tek bağımsız incelemeden geçti.

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 1.14 | Sahip toplar: sözleşme fiyatları, döküm + e-Fatura, uç dosyalar, etiketler, 20–30 koli elle ölçü | sahip | – | – | `TEST-ADIMLARI.md` |

## Aşama 2 — Masa başı gerçek veri denemesi (bu bilgisayarda, 1–2 hafta)

Bitti: iki taşıyıcının bir aylık faturası ölçütlerden geçti, bir itiraz gönderildi. Adımlar `TEST-ADIMLARI.md`.

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 2.1 | Gerçek kullanıma geçiş: sahip faturaları getirince `Platform\scripts\gercek-kullanim.ps1` (önce `-KuruCalisma`; yedek alır, demoyu siler, ayarları kapatır, davet bağlantısı verir) | sahip | güvenlik | S | KURULUM "Gerçek kullanıma geçiş" |
| 2.2 | Bilgisayar dışı yedek hedefi ayarlanır (`.env` `SOD_BACKUP_OFFSITE_DIR`), ilk elle yedekte parola üretilip parola yöneticisine kaydedilir. Gece yedeği görevi şimdilik kaldırıldı (sahip, 2026-11-25); gerçek kullanıma ya da sunucuya geçerken `yedek-zamanla.ps1 kaydet` | sahip | veri | S | KURULUM "Yedek ve geri yükleme" |
| 2.3 | İlk gerçek PDF'te yapay zekâ çağrısı canlı denenir (paket 1.8.0'a güncellendi). `npm audit`: exceljs → uuid orta seviye (buf verilmediği sürece etkisiz; exceljs sürümü bekleniyor) | test | – | S | D1.6 |
| 2.4 | Tarife, döküm, PDF ve ilk itiraz denemesi ölçütlerle | test | para | M | `TEST-ADIMLARI.md` |
| 2.5 | Hiç denenmemiş ekranlara bakılır | test | görünüm | S | `TEST-ADIMLARI.md` |
| 2.6 | "Faturalanan" anlatımı: sayfa üstü ile liste, raporda mükerrer, "KDV hariç" (önce tuval) | artık | görünüm | S | E2b-W2 |
| 2.7 | Geçidi açmak: `PLATFORM_OPERATORS`, Merkez › Platform › Yapay zekâ'da Anthropic ve Gemini anahtarı + "Sına", sonra araçlara `AI_GATEWAY_URL=http://ai-api:4300`, DeciShip'ten `ANTHROPIC_API_KEY` kalkar; küçük ücretli deneme (~0,01 $) Yapay zekâ harcaması'nda satır olarak görünmeli | sahip | para | S | KURULUM "Geçidi açmak", `TEST-ADIMLARI.md` |
| 2.8 | TagPress gerçek veri aktarımı: yerel TagPress kapalı, `Tagpress\data` elle kopyalanır, gerçek firmaya `subscription:set … tagpress ACTIVE`, Merkez'den TagPress bir kez açılır, `tagpress-aktar.ps1 -Firma <kimlik> -KuruCalisma` sonra gerçek; diller, şablonlar, işler, baskı oturumları yerinde mi | sahip | veri | S | KURULUM "TagPress'i açmak ve yerel veriyi aktarmak" |
| 2.9 | Gece kurulan ekranların ve varsayımların onayı: Yapay zekâ harcaması, Platform › Yapay zekâ, TagPress'in kabuk içi görünümü (tuvalden geçmedi); TagPress izin ve rol metinleri, Yönetici rolünü yalnız sahibin verebilmesi, Merkez TagPress KPI ve uyarı seçimi (takılan görev 15 dk), veri setlerinde müşteri metninin gösterilmemesi | sahip | görünüm | S | `Tagpress/YOL-HARITASI.md` |
| 2.11 | TagPress ürün tipleri (sahip kararı 2026-11-24, sıradaki iş; Üretim kartında tip etiketi şimdilik işin verisinden): Ayarlar › Ürün tipleri (ad, etiket/sticker, şekil ve ölçü, tasarım şablonları, sayfa şablonu); eşleme dosyadaki tip alanı → ürün adı/SKU kelimesi → varsayılan, kartta "Bunu hatırla"; bugünkü ölçüler ve sticker sayfaları ilk tipler olur | özellik | veri | L | – |
| 2.12 | TagPress yeni Üretim, gömülü düzenleme ve sayfa şablonu ekranlarının sahip denemesi: üretilmiş işlerde sağ paneldeki küçük tezgâh (sürükle, kendiliğinden kayıt, onay), Ayrıntılı düzenle penceresi, Baskı masasından pencere, sayfa şablonunda yapışma ve silme (tarayıcıda yalnız yükleme, bekleyen paneli ve şablon sürükleme denendi; üretim anahtarsız denenmedi) | sahip | görünüm | S | `TEST-ADIMLARI.md` |

## Aşama 3 — Sunucu: her zaman açık, https, otomatik yedek (~1 hafta)

Bitti: `app.sellerondata.com` https ile açık; ilk yedek başka yerde geri yüklendi; sıfırlama postası geldi.

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 3.1 | Sahip açar: sunucu, yedek deposu, e-posta + DNS, uyarı adresi, parola yöneticisi | sahip | – | – | A5 |
| 3.2 | Sunucuda Caddy ilk kez: gerçek sertifika, AAAA kaydı yazılmaz (IPv6 kapalı), `APP_HOST` ile `APP_BASE_URL` tutarlı; HSTS kademeli uzatma (1 gün → 1 hafta → 1 ay → 1 yıl, sonra preload kararı; `default.conf` + `Caddyfile` birlikte); site nginx `server_tokens off` + `set_real_ip_from` | altyapı | güvenlik | S | KURULUM "Üretim açılışı" |
| 3.3 | Her gece şifreli yedek başka depoya, saklama, geri yükleme provası; veri kaybı incelemesi | altyapı | veri | M | A4.1, A4.15 |
| 3.4 | Sunucuda `scripts/ayakta-mi.sh` systemd/cron ile 5 dakikada bir, çıkış 1 gerçek uyarı kanalına (posta) bağlanır (günlük, kapanış, sağlık hazır) | altyapı | veri | S | KURULUM "Ayakta mı denetimi" |
| 3.5 | `Platform/scripts/guncelle.sh` sunucuda bir kez denenir (yedek → sürüm → sağlık; göçsüzse geri dönüş; `--ilk-kurulum`, `--uyelik-duyur`) | test | veri | S | KURULUM "Güncelleme" |
| 3.7 | `Platform/scripts/kurulum.sh` sunucuda: `ac` (.env, ilk açılış, sahip daveti), `dogrula`, `purge:preview` sonrası `kalici-silme` | test | veri | S | KURULUM "Sunucuda ilk kurulum" |
| 3.8 | Gerçek e-posta: doğrulama, sıfırlama, davet, hatırlatma (TR, EN) | test | – | S | `TEST-ADIMLARI.md` |

## Aşama 4 — Telefon ve depo (hazırlık 2–3 gün + deneme 2–3 hafta)

Bitti: iki hafta her gün ölçüm; ay sonu faturası bu ölçümlerle karşılaştırıldı.

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 4.1 | Gerçek imza anahtarı (birlikte, parola yöneticisine), kalıcı imza eklentisi | altyapı | güvenlik | M | E1-M2, A4.2 |
| 4.2 | Bilgisayara bağlı olmayan release APK, adres gömülü; "Kodu kopyala" pano modülü; sürüm 1.2.0 ve sunucuda `MIN_MOBILE_VERSION=1.2.0` (eski sürüm `MEASURED_AT_INVALID`i tanımıyor) | altyapı | – | S | E1-M1/M3 |
| 4.3 | Sabit indirme adresi; davet mesajı uygulamayı anlatsın | özellik | – | S | E1-M4/M5 |
| 4.5 | Yarım ölçüm süresi (bugün 2 gün; karar bekliyor) | ayar | veri | S | E1-M6 |
| 4.7 | Telefon çökme kaydı | özellik | – | M | E1-M12 |
| 4.10 | Mobil alan kenarı kontrastı (önce tuval) | artık | görünüm | S | E2a-U5 |
| 4.11 | Deneme: yarım gün sahip, bir hafta bir, iki hafta 2–3 çalışan | test | para | L | `TEST-ADIMLARI.md` |

## Aşama 5 — Günlük kullanım (sürekli; gerçek veri görülünce)

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 5.1 | Barkod takip no değilse "referans" sütunuyla eşleşme | özellik | para | M | B4.7 |
| 5.7 | Ambalaj (Pak/Zarf) gerçek veriyle: ilk gerçek FedEx faturasında "Paketleme" sütunu ve Pak satırları, gerçek tarife dosyasının Envelope/Pak bölümü, gerçek FedEx PDF417 etiketi okutma; UPS ambalaj kodları (01 Letter, 02 kendi, 04 Pak) kaynaktan doğrulanmadı. Taşıyıcı sınırı değişince eski faturalar kendiliğinden yeniden hesaplanmaz ("Yeniden karşılaştır"); gerekirse sınır faturaya dondurulsun | test | para | S | – |
| 5.2 | Çok kolinin gerçek çözümü (1.8'in yerine: bugün dosyada yinelenen takip no ve ölçüm tekrarı "İncele"; faturadaki parça sayısı okunmuyor, tek ölçülen koli + toplam desi yakalanmıyor) | özellik | para | M | B4.6 |
| 5.3 | İtiraz süresi dökümün geldiği günden; cevapsız itiraza hatırlatma; UPS/DHL süresi | özellik | para | M | B4.24-25 |
| 5.4 | Alacak dekontu toplamı satırlara dağıtılsın | özellik | para | M | B4.26 |
| 5.5 | Tek araçlı firmada giriş doğrudan Pano, Merkez ile aynı rakam (karar) | özellik | görünüm | M | E2b-W1 |
| 5.6 | e-Fatura XML, pazaryeri kargo ekstreleri | özellik | para | L | B4.18, B4.31 |
| 5.7 | Kapıda ödeme bedeli tahsilatın yüzdesi | özellik | para | M | B4.10 |
| 5.8 | Eski .xls ve web sayfası ".xls" okunsun | özellik | – | M | B4.17 |
| 5.9 | Toplu kararı geri alma; silinen faturayı geri getirme | özellik | veri | S | B4.22-23 |
| 5.10 | Taşıyıcı müşteri numarası (çekirdekte `accountNo` var) | özellik | – | M | B4.21 |
| 5.11 | Hesap artıkları: katı kipte tarifesiz ek ücret, iade satırı "Tarife yok"ta, sabit yakıt ek ücrete | artık | para | M | B2 |
| 5.12 | KDV oranı bilinmeyen faturada itirazda KDV dahil tutar yok (ihracatta %20 varsayılmaz) | artık | para | S | B2 |
| 5.13 | PDF artıkları: yakıt yüzdesi yalnız başlıkta, düşünme tokeni, karışık para, "1.500" sorusunun çıkmadığı durumlar | artık | para | S | B2 |
| 5.14 | Sonradan eklenen itiraz satırı "süresi yaklaşan"da yok; hepsi red fatura "Gönderilmedi"; Ayarlar'da "Ayrıntılı döküm" | artık | para | S | – |
| 5.16 | Telefonlarda bekleyen ölçüm sayısı yöneticiye görünsün | özellik | veri | M | E2b-W3 |
| 5.17 | Doğrulanmış artık soruları (tuval): mobil Merkez "Vazgeç" düğmesi ve firma baş harfi gece mavisine; mobil Merkez Genel Bakış'a "Örnek veri" etiketi. "Kayıtta kod": notlar Türkçe cümle olarak saklanıyor (kod+parametreye geçiş veri modeli işi, ikinci araçtan ya da dış açılıştan önce) | artık | görünüm | M | 5.17 |
| 5.18 | Tarife ek ücretinde "Yakıt uygulanır" seçeneği; satır başına otomatik tarife ve sevkiyat satırlarını birleştirme; WhatsApp destek hattı (gerçek faturaları bekle) | özellik | para | M | – |
| 5.20 | Çok koli güvenlik ağı artıkları (1.8, bilerek güvenli yön): aynı dosyada yineleme önceki faturanın kesin mükerrerini de "İncele" yapar; hizmet metni aynı göndericiye iade ücreti hâlâ kesin mükerrer ("açıklama" sütunu okunmuyor, Aras kalıbı hizmete "ödeme tipi"ni eşler); ölçüm tekrarı kuralı geniş (düzeltilen her koli "İncele", WEIGHT+PRICE satırın tamamı) | artık | para | S | 1.8 incelemesi |

## Aşama 6 — Yayın altyapısı ve ikinci araç (arka planda)

Yayından önce:

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 6.1 | Firma düzeyinde "Yapay zekâ kullan" anahtarı (PDF bugün maskesiz gider) | özellik | veri | M | – |
| 6.3 | Açılış denetimi (köken, vekil), çerez önekleri (`__Host-`, canlı alan adıyla dene), "bilinen cihaz" tavanı (cihaz çerezi yok, yalnız IP bloğu) | altyapı | güvenlik | S | C2.3 |
| 6.4 | Hazır imajlar ve geri alma, kalıcı posta kuyruğu, hata bildirimi, sırlar dosyadan | altyapı | veri | L | A4.10, A4.14 |
| 6.6 | Telefon arka planda göndersin, bildirim; "yeni sürüm var" uyarısı | özellik | veri | M | E1-M7, M11 |
| 6.7 | Ölçüm sırası artıkları: telefon saati ölçümle gönderim arasında değişirse fark yakalanmıyor (tekdüze sayaç ister, yerli modül); silinen ölçümü geri yüklemede birleştirme saat sırasına dayanıyor | artık | para | M | 6.7 incelemesi |
| 6.8 | Web'de yenileme yanıtı kaybolup tarayıcı 60 sn sonra yeniden denerse (dizüstü uykusu) oturum düşer: kabuk da sekmeler arası paylaşılan tekrar anahtarı gönderebilir | artık | güvenlik | S | 6.8 |
| 6.9 | Sonraki faturadaki iade önceki faturadaki ücreti değiştirmiyor | artık | para | M | B2 |
| 6.10 | Firma kapatma kalanları: çalışana "firmanız kapatılmış olabilir" satırı ve panel/telefon ORG_CLOSED ekranı (sahibe soruldu, önce tuval); hesap servisinde `Outbox.orgId` dizini | artık | veri | S | 6.10 |
| 6.12 | Erişilebilirlik kalanları (görünüm, tuval): İngilizce Merkez üst çubuğunda kısa adlar, panel odak halkası, 40→44 px düğmeler, firma/dil değişiminde uygulama içi onay, Merkez Firma sayfasında kaydedilmemiş değişiklik uyarısı, tarih kutularının dili, hatalı alanda kırmızı çerçeve; hareket azaltma kuralı pencere/sayfa/bildirim animasyonlarına | artık | görünüm | M | 6.12 |
| 6.13 | Site: açılmamış araç "Yakında", yer tutucular, gizlilik metni | artık | görünüm | M | E2c-7 |
| 6.14 | Büyük firmada hız kalanları: RLS altında `right()`/`translate()`/LIKE/enum koşulları dizin kullanmıyor (takip no anahtarını saklanan sütun yapma kararı sahipte), Merkez satır tablosunda toplam sayım ve derin sayfa (karar sahipte), `GET /disputes` 1,7 sn (özet JS'te), 1 yıllık özet ~2 sn, itiraz toplamı alt sorgusu firmanın bütün itiraz geçmişini okuyor (dönemle sınırlanabilir) | altyapı | – | M | 6.14 |
| 6.15 | CAPTCHA (sağlayıcı seçimi sahipte; öneri kendi sunucumuzda bulmacasız doğrulama). Ağ geçidi hız sınırı bitti | altyapı | güvenlik | S | – |
| 6.16 | SMS gelene dek telefon numarası kapma riski (yayın engeli; `phone:release` destek komutu var) | altyapı | güvenlik | S | – |
| 6.18 | Kuyruktaki iş beklerken abonelik salt okunur olursa görülmüyor (abonelik yerelde tutulmuyor; jetonla geliyor) | artık | güvenlik | S | 6.18 incelemesi |
| 6.30 | DS-AI-2: DeciShip'in araç içi aylık yapay zekâ hakkı (`aiCreditMonthly`, `AiCreditEntry`) geçide taşınır, araç kalan hakkı geçitten okur (tek ortak hak kararının DeciShip yarısı) | özellik | para | M | `YAPAY-ZEKA-GECIDI.md` §7 |
| 6.31 | Geçit açıldıktan bir hafta sonra DeciShip `aiDailyBudget.ts` emekliliği (`AI_DAILY_BUDGET_TRY=off`, sonra kod ve kapı) ve iki defterin uzlaştırma komutu | altyapı | para | S | `YAPAY-ZEKA-GECIDI.md` §7 |
| 6.32 | Platform yöneticisinin listeden çıkarılması ya da çıkışı geçitte anında görünsün (bugün en çok 10 dk jeton ömrü, adım artırma 5 dk) | altyapı | güvenlik | S | `07-guvenlik.md` §11 |
| 6.33 | Geçit uyarıları: yönetici ekranında uyarı geçmişi (tavana yaklaşma, dolma, anahtar reddi), %80'de firma sahibine posta, bir firmanın platform harcamasının yarısını geçmesi uyarısı | özellik | para | M | `YAPAY-ZEKA-GECIDI.md` §7 |
| 6.34 | Çok firmalı ölçekte harcama özeti ayrıntılı defter yerine günlük özetten (`AiSpendDaily`) okunsun | altyapı | – | S | `YAPAY-ZEKA-GECIDI.md` §7 |
| 6.35 | TagPress servisleri asenkron veritabanına (bugün senkron köprü, tek bağlantı; çok firmalı ölçekte) ve firma dosyaları nesne deposuna | altyapı | – | L | `Tagpress/YOL-HARITASI.md` |
| 6.36 | TagPress MCP sunucusunun platform kipi (bugün yalnız yerel kip) | özellik | – | M | `Tagpress/YOL-HARITASI.md` |
| 6.37 | TagPress yerel kipteki `X-Studio` istek başlığı ve `studio-header-missing` kodunun adı (istemci/sunucu sözleşmesi; platform kipi `X-SOD-CSRF` kullanır) | artık | – | S | `Tagpress/YOL-HARITASI.md` |

OrderLoom'dan önce:

| No | Ne | Tür | Risk | Boyut | Kaynak |
|---|---|---|---|---|---|
| 6.20 | DeciShip Merkez dönem/CSV/sınırlayıcı/saat kopyaları `@sellerondata/product-kit/pure`'a geçsin (bugün aynılık elle kopyalanmış örneklerle sınanıyor; DeciShip değişirse fark görünmez) | altyapı | – | S | 6.20 incelemesi |
| 6.23 | Mobil uygulama ortak yere, türler araçtan bağımsız | altyapı | – | L | C1.4-4, C4-K4/K12 |
| 6.24 | Araç şablonu kalanları: şablonun `dev:mock`'u oturum açmıyor (Merkez `handlers.ts` Hesap işleyicileri ortak pakete), DeciShip panelinden ortak pakete alınacak 7 parça (`Platform/templates/tool-web/README.md`), `vite.config.ts` `decishipStub` ve `shell/src/mock/seed.ts` araç rolleri hâlâ DeciShip'e özel, Merkez `OrgMember` türünde `createdAt`/`personSuspended` yok | altyapı | – | M | 6.24 |
| 6.26 | OrderLoom açılınca: demo tohumunda araç başına rol (`account-api/src/seed.ts` `SeedMembership`, `demo.ps1`, KURULUM demo tablosu), e2e `lib/products.ts` `TOOLS` girdisi; pilot araç için e2e açma yolu yok | test | güvenlik | S | 6.26 |
| 6.27 | Workspaces kararı, kök listeler tek kaynaktan | altyapı | – | M | C1.4-5 |
| 6.29 | TagPress npm'e/ortak düzene çevrilsin (6.27 workspaces kararıyla birlikte) | altyapı | – | M | `Tagpress/YOL-HARITASI.md` |

## Bekleyen kararlar

| Aşama | Karar | Öneri |
|---|---|---|
| 3 | Sistem nerede? | Küçük bulut sunucusu |
| 3 | Bölge TR mi AB mi; PDF'in yapay zekâya gitmesi | Hukukçuya; o zamana dek yurt içi sağlayıcı |
| 3 | Yedek deposu, e-posta, parola yöneticisi | Yedek başka firmada; Resend/Postmark; Bitwarden |
| 4 | Ölçüm fotoğrafı saklama | İtiraz kanıtı süresiz, diğerleri 12 ay |
| 4 | Yarım ölçüm ne kadar saklansın? | 4 gün |
| 4 | Hacim ağırlığının (volumetric kg) ekrandaki adı | Tuvalde göstererek |
| 5 | Tek araçlı firmada giriş Pano'ya mı? | Evet; önce tuval |
| 6 | OrderLoom öncesi: mobil taşıma, paketler, belirteç, tasarım dili | Taşınsın; ekip yönetimi yalnız çerezle; dil tuvalde |
| – | Firma yöneticisi DeciShip yöneticisi rolünü verebilsin mi? | Yalnız sahip ya da DeciShip yöneticisi |
| – | Kişi itiraz hatırlatma postasını kapatabilsin mi? | Evet, Profil'den ve postadan |
| – | Pano "Ölçüm kapsamı" kartı, eksik "KDV hariç", odak çizgisi | Tuvalde göstererek |
| 6 | İlk canlıdan önce göçler ürün başına tek `init`'e sıkıştırılsın mı, yoksa kural kalksın mı? | Sıkıştırılsın |
| – | Firma değiştirirken kaydedilmemiş değişiklikte tarayıcı onay kutusu mu, uygulama içi onay mı? | Uygulama içi |
| – | Küçük kararlar: kayıtta "bu e-posta kullanılıyor" yanıtı; sahibe ulaşılamazsa sahiplik; firma ilk e-posta doğrulamasında mı açılsın; bitmiş itirazlı fatura ne zaman kalıcı silinsin; eski ölçüm sürümü fotoğrafları; eski denetim kayıtlarında takip no; yüzey farkı tek değer; workspaces | Sırayla sorulur |

## Yayından önce (sona bırakıldı)

1. Ödeme, fiyat, deneme süresi, SMS, mağaza yayını.
2. KVKK ve kullanım metinleri, hukukçu; firma kapatma ve 30 gün sonra silme metinde anılır.
3. İnce ayarlar (varsayılanla duruyor, değeri sahip belirler): `AI_DAILY_BUDGET_TRY` 1.000 TL/gün, firma aylık yapay zekâ hakkı 2.500 TL (`AI_FREE_CREDIT_MONTHLY_TRY`; yerel gerçek kullanımda `gercek-kullanim.ps1` en çok 200 TL/gün ve 1.500 TL/ay yazar), ürün başına 20 özel rol, yapay zekâ dökümünde 50.000 satır, PDF raporda 1.000 fark satırı, `ORG_PURGE_DAYS` 30, Postgres `random_page_cost` 1.1 (SSD; `SOD_PG_RANDOM_PAGE_COST`), API bağlantısında `jit=off`, büyük fatura kuyruk eşiği `INVOICE_IMPORT_QUEUE_ROWS` 5.000 satır (iş en çok 30 dk), kesilen yapay zekâ çağrısının çıktı tahmini 110 token/sn, hak uyarısı %80, takip no uzunluğu (kesin 5–50, olağan 8–35; `core/trackingFormat.ts`), mobil sunucu yoklaması (30 sn önbellek; kapalıyken 30 sn, açıkken 3 dk), kap günlüğü 20 MB x 5, Postgres kapanışı 60 sn, ayakta mı eşikleri (disk %85 / en az 5 GB, yedek 36 saat), gzip düzey 5 en küçük 1 KB, API firma sınırları (yükleme 300/dk, canlı okuma 240/dk; gerçek kullanımda gözlenmeli), ölçüm anı kabul aralığı (15 dk ileri, 730 gün geri; saat farkı eşiği 10 dk; mobil kendiliğinden yeniden deneme 6 saat; `services/measurementOrder.ts`), ağ geçidi IP başına (kimlik uçları dakikada 30 birikme 30, genel API saniyede 30 birikme 200, yükleme dakikada 600 birikme 300, bağlantı 100, `Retry-After` 5 sn), kenar toleransı 0,5 cm (yeni firma; mevcut firmalar kayıtlı 1 cm'de, sahip Ayarlar'dan indirir), yarım ölçüm süresi, koli fotoğrafı sayısı, fatura KDV sınaması (KDV hariç için satırların %90'ı, KDV dahil için hepsi; pay 0,02 + binde 1, oranlar 20/18/10/8/1; `core/invoice/vat.ts`), taşıyıcı ambalaj sınırları (`core/packaging.ts` `DEFAULT_PACKAGING_LIMITS`; firma panelde taşıyıcı ayarından değiştirir): FedEx Pak 2,5 kg ve 15.400 cm³, FedEx Zarf 0,5 kg ve 31,7×24,1×2 cm, UPS Zarf 0,5 kg ve 40,6×31,7×2 cm, DHL Zarf 0,3 kg ve 35×27,5×1 cm (zarf kalınlıkları FedEx/UPS için varsayım); UPS Pak, DHL Flyer ve yurt içi taşıyıcılar bilinmiyor (uyarı yok, fark "İncele").
4. Açılışta ayrıca: fiyat birimi, ürün başına plan ve paket indirimi; iptal sonrası veri silme; fatura profili ve kullanım sayacı; `expo-updates`; `purge:preview` sonrası canlıda `DELETED_*_PURGE_DAYS=30`.
5. Dış firmaya açılış: Aşama 6 "Yayından önce" bitmiş olmalı.
6. İnce ayarlar, yapay zekâ geçidi ve TagPress [V] (varsayılanla duruyor): geçit tavanları platform 10 $/gün ve 150 $/ay, firma 30 $/ay (bütün araçlar), araç başına TagPress 20 $ ve DeciShip 15 $; hız firma dakikada 30 çağrı, aynı anda 4 akış, araç başına aynı anda 12; tek istek 32 MB ve 15 dk; süren işe %20 pay; uyarı %80; ekran kuru 1 USD = 100 TL; ayrıntılı çağrı satırları 24 ay; araçların kalan hak önbelleği 30 sn; Merkez Genel Bakış yenileme 60 sn; TagPress oturum başına 3 $, takılan görev uyarısı 15 dk.
