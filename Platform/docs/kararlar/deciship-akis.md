# DeciShip ürün kararları: akış, itiraz, yapay zekâ, dosyalar

Parçası olduğu dizin: `Platform/docs/KARARLAR.md` (okuma kuralları orada).

## DeciShip akışı ve Merkez sadeleştirme

Teknik: `Deciship/SPEC.md` §5.8, §5.14.

**Toplu karar**
- Yalnız kararı bekleyen satıra uygulanır. Kararı verilmiş, itirazdaki ve yeniden hesap bekleyen satırlar atlanır, nedeniyle söylenir. "İncele" işaretli satır toplu olarak itiraz listesine girmez ama uyumlu sayılabilir.
- Talebi sıfır olan satır toplu itiraza girmez.
- Toplu "Geri al" yalnız sizin verdiğiniz kararı geri alır; arada başkasının verdiği karar kalır.
- "Bu süzgeçteki tümünü seç" seçilen andan sonra liste değiştiyse hiçbir şey yazılmaz: liste yenilenir, "Seçim değişti" denir. Tek seferde en çok 5.000 satır.
- Seçim açıkken başlıktaki "İtiraz" düğmesi ikincil olur (ekranda tek birincil).

**Faturalar**
- Arama takip no'da tam, fatura no'da parça eşleşmedir. Durum süzgeci üç seçenek: Fark var, Ölçümü eksik, İtiraz bekliyor. Tarih alanları bir düğmenin arkasında.
- Pano'daki liste "Son yüklenenler" (dönemden bağımsız).

**Deneme turu**
- Deneme firmanın kendi hesabında yapılır, yalnız boş firmada açılır. Sürerken fatura, tarife ve taşıyıcı eklemek kapalı.
- "Denemeyi bitir" yalnız örnek olarak yüklenenleri siler: örnek taşıyıcılar, onların tarife ve faturaları, örnek ölçümler; örnek tarife ya da taşıyıcıda deneme sırasında yapılan değişiklikler de (onay penceresi söyler). Çalışanların bu arada kaydettiği ölçümler kalır.
- Sunucuda `DEMO_TOUR=off` deneme başlatmayı kapatır; açık kalmış deneme yine bitirilebilir.

## İtiraz

Teknik: `Deciship/spec/itiraz.md`, `Deciship/SPEC.md` §3.15, §5.14.

- **İtiraz penceresi:** metin e-posta bağlantısı için uzunsa (1.800 karakter) "Kopyala" öne çıkar, e-postaya yalnız kısa giriş gider. Düzenlenmiş metin dil değişince sorulmadan silinmez. Taşıyıcının e-postası yalnız tarayıcıda hatırlanır.
- **Geri çekilen yeniden talep reddedilen sayılır** (kullanıcı kararı K38): reddedilmiş satır yeniden gönderilip o tur geri çekilirse taşıyıcının son cevabı red kalır; Pano, İtirazlar ve Merkez satırı "reddedilen" sayar. Satır yine yeniden talep edilebilir. Kişi reddi kabul edip satırı itiraz listesinden çıkarırsa satır itiraz toplamından da çıkar.
- **"Zamanında itiraz edildi" ilk gönderimin günüdür:** yeniden gönderilen itirazda fatura sayfası ve İtirazlar listesi TTK'ya esas günü (satırın taşıyıcıya ilk bildirildiği gün) yazar.

**Kullanıcıya açık olma** (kullanıcı kararları)
- **İtirazda ölçen kişi:** kargo firmasına giden metinde kişinin adı yazmaz; rol ("depo çalışanımız"), ölçüm zamanı ve yöntem yazar. Ad yalnız firmanın kendi Excel raporunda görünür.
- **Fotoğraflar:** itiraz için indirilen tek ZIP dosyası; kullanıcı e-postaya kendisi ekler. Herkese açık ya da süreli bağlantı yok.
- PDF'te tutmayan satır ve okunamayan satırlar: `kararlar/deciship-hesap.md` "Fatura yükleme ve okuma".

**İtiraz süresi hatırlatması**
- Hatırlatma postası fatura başına değil, **firma başına günde tek özet**; postada tutar yok.
- Son güne 3 gün ve 1 gün kala, firmanın saatiyle 09:00–19:00 arasında; gece posta yok.
- Gönderimden sonra listeye eklenen satır da hatırlatılır: etkin itirazı olan faturada henüz gönderilmemiş satır varsa TTK süresi postaya girer.
- Alıcı itiraz yetkisi olan kişidir (Yönetici, Muhasebe). Firma ayarıyla kapatılır, varsayılanı açık; yalnız Türkiye'deki firmalarda.
- Postayı DeciShip değil Hesap servisi gönderir; DeciShip kişilerin e-posta adresini öğrenmez. Araçlar kendi posta sunucusunu kurmaz (ARCHITECTURE.md §6 "Araç bildirimi").

## Yapay zekâ

- Ayda 2.500 TL ücretsiz hak (firma başına; 2026-11-14'e dek 500, KALANLAR 1.10: ~100 sayfalık fatura PDF'i ~800 TL), 1 USD = 100 TL; hak dolunca bütün yapay zekâ işleri durur.
- Sonuç vermeyen yapay zekâ çağrısı müşterinin kotasından düşmez; bu çağrıların maliyetine ayrı aylık tavan var (varsayılan firmanın aylık hakkı kadar, `AI_FAILED_BUDGET_RATIO`).
- Yapay zekâ hatası kendiliğinden yeniden denenmez (her deneme ücretli); kullanıcı yeniden başlatır.
- **Günlük yapay zekâ tavanı** (kullanıcı kararı 2026-11-12, kapalı deneme; `AI_DAILY_BUDGET_TRY`, DeciShip API; teknik `Deciship/SPEC.md` §5.12):
  - Bütün firmaların o günkü harcamasının toplamı; varsayılan **1.000 TL/gün** (tek firma ya da bir hata bütün bütçeyi bir günde yakamaz). Gün sistem günüdür (Europe/Istanbul), firmanın saat dilimi değil.
  - Dolunca yeni çağrı sağlayıcıya gitmeden `429 AI_DAILY_BUDGET` ("Yapay zekâ bugün için durduruldu; yarın yeniden açılır. Elle giriş ve Excel/CSV yükleme çalışır."). Firma kotası dolmuş gibi gösterilmez; firma kotası, hız sınırları ve `/me` `ai.available` değişmez. Önbellekten gelen sonuç ücretsiz sürer. İlk dolduğunda günlüğe `error` düzeyinde tek satır `ai-daily-budget-reached`.
  - Tavandan önce başlamış arka plan işi tavanın %20 üstüne kadar sürer, sonra o da durur; aynı iletiyle biter, kendiliğinden yeniden denenmez, ertesi gün kendiliğinden sürmez (okunmuş parçalar önbellekten ücretsiz).
  - Her çağrı sonucu gelene dek kendi üst sınır tutarı kadar pay ayırır; tavana yalnız süren çağrıların payıyla yaklaşıldıysa geçici `503 AI_BUSY`, harcanan tavana ulaştıysa `429 AI_DAILY_BUDGET`. Aşım süreç başına en çok bir çağrının üst sınırı (iki API kopyasında ötekinin son 10 saniyesi eklenir); sağlayıcı daha pahalı yedek modele düşerse sınır gevşer.
  - Değer: boş = 1000; `off` = tavan yok; `0` = acil durdurma; başka değer API'yi başlatmaz. Günün toplamı: destek komutu `ai:usage`. Tavan açıkken `AiUsage.ai_budget_read` ilkesi yoksa API açılmaz.
- **Tartı fotoğrafından ağırlık okuma varsayılan kapalı** (kullanıcı kararı 2026-11-12: "500 TL sırf tartı okuması için aşırı gereksiz harcama"). Firma ayarı `scaleAiRead` (varsayılan `false`, kayıtlı değeri olmayan firma da kapalı).
  - Kapalıyken tartı fotoğrafı yine çekilir ve kanıt olarak eklenir, okutulmaz; otomatik okumayla ilgili ileti ya da bekleme görünmez, ağırlık elle girilir. `POST /vision/scale` kapalı firmada sağlayıcıya ve sayaca gitmeden `409 AI_DISABLED` (`details.reason: scale_ai_off`; eski mobil sürümler de "Otomatik okuma kapalı" der).
  - Yönetici Ayarlar › Mobil ölçüm kartındaki anahtarla açar; açıkken her okuma haktan düşer. Ücretsiz (yapay zekâsız) okuma bu ayarın dışında.

## Uzun işler ve dosyalar

Teknik: `Deciship/SPEC.md` §5.13, ölçek ARCHITECTURE.md §11 "Arka plan işleri ve ölçek".

- Kuyruk Postgres'te, çalışan DeciShip API'nin içinde; ayrı kap ve Redis yok. İkinci API kopyası da iş alır; ayrı iş çalıştırıcı kabı hazır (`node dist/worker.js`, API kopyaları `JOB_RUNNER=off`) ama bugün açılmadı.
- Kuyruğa giren işler: PDF fatura okuma, tarife PDF'inde yapay zekâ ile tarama ve fiyat okuma, toplu yeniden hesap (önizleme ve uygulama). Excel/CSV önizlemesi, fatura kaydı, tarife "uygula" ve kodla tarama anında kalır. Büyük CSV içe aktarma ve tarife incelemesi kuyrukta değil.
- Büyük PDF fatura 5'er sayfalık parçalarla okunur (`PDF_INVOICE_PAGES_PER_CALL`); küçük PDF tek seferde.
- Ölçüm kaydı fatura karşılaştırmasını beklemez; karşılaştırma yanıttan birkaç saniye sonra yapılır (kalıcılık `recomparePendingAt` işaretinde). Ölçüm düzeltme ve geri yüklemede yanıt en çok 2 sn bekler; yetişmezse `recomparePending: true`.
- Aynı iş iki kez başlamaz: aynı PDF okunurken ikinci yükleme aynı işe bağlanır; toplu geçişte aynı özetle ikinci "Uygula" aynı işi gösterir, farklı önizlemeden geliyorsa "zaten sürüyor" (409).
- Yeniden başlamada iş kaldığı yerden sürer; okunmuş yapay zekâ sonucu önbellekte kaldığı için tekrar ücretlenmez. En çok 5 deneme, sonra "yarıda kaldı, yeniden başlatın".
- Durdurma: PDF ve tarife okumada o anki yapay zekâ çağrısı bitmeden durmaz (ücreti doğmuştur), sonra iş durur. Toplu geçişte durdurulunca güncellenen faturalar yeni hâlinde kalır, pencere bunu söyler. İşi yalnız başlatan üye ya da `settings.manage` izni olan durdurur.
- Sıra: firma başına her grupta aynı anda bir iş, sıradakiler "Sırada". Sunucu başına aynı anda 2 yapay zekâ işi ve 1 toplu hesap. İş kayıtları 7 gün saklanır.
- Süre sınırı: bir denemenin en uzun süresi yapay zekâ işinde 30 dk, toplu hesapta 2 saat; zorla durdurmada işleyiciye 30 sn.
- Çift ücret yok: sayaç satırı ile önbellek satırı tek işlemde yazılır. Sağlayıcı çağrısı sürerken süreç ölürse bir kez ücret yazılır, sağlayıcı maliyetini biz taşırız.
- Kapanışta süren işlere 30 sn verilir (compose `stop_grace_period: 45s`); bitmeyen iş sıraya döner, deneme hakkı geri verilir (iş başına en çok 2 kez).
- Eski "hemen yanıt veren" uçlar korunur (testler ve geri uyum); panel hep arka plan yolunu kullanır.
- Vazgeçilen önizlemenin dosyası hemen silinir ("Başka dosya", "Geri", sihirbazdan çıkış); unutulan en geç 24 saat sonra; okuma başarısız olursa ya da durdurulursa hemen. Önizlemeyi yalnız yükleyen siler (başkasınınki 404). İçe aktarma sürerken panel vazgeçme çağrısı göndermez.
- Silinen faturanın kaynak dosyası 30 gün sonra diskten silinir (kayıt durur, dosya açılamaz); aşağıdaki kalıcı silme değişkenlerinden bağımsızdır, kapalıyken de çalışır. Canlı faturanın dosyasına dokunulmaz.
- Firma başına dosya alanı kotası varsayılan 10 GB (`STORAGE_QUOTA_GB_PER_ORG`, `0` kapalı): yalnız fatura ve tarife dosyası yüklemesi durur; ölçüm fotoğrafı hiç durdurulmaz ve sayılmaz; silinen faturanın dosyası sayılmaz.

## Silinenlerin kalıcı silinmesi

Kullanıcı kararı 2026-11-12: silinen fatura ve silinen ölçüm fotoğrafları 30 gün sonra kalıcı silinir; itiraz kanıtı korunur. Teknik: `Deciship/SPEC.md` §5.13 "Silinenlerin kalıcı temizliği", çalıştırma KURULUM.md "Silinenlerin kalıcı silinmesi (DeciShip)". **Kalıcı silinen veri geri gelmez** (yedekten başka yol yok).

- **Silinen fatura:** silinmesinden 30 gün sonra fatura, satırları, satır kararları ve yalnız ona ait kaynak dosya (kayıt ve disk) kalıcı silinir. Ekran "30 gün sonra kalıcı olarak silinir" der. Silinen fatura bu sürede de geri alınamaz (geri yükleme yok).
- **İtiraz kaydı olan fatura kalıcı silinmez:** etkin, geri çekilmiş ya da yerini yeni tura bırakmış herhangi bir tur varsa fatura (silinmiş görünse de) satırları ve itiraz geçmişiyle saklanır. Biten itirazlı faturanın ne zaman silineceği karara bağlanmadı; o zamana dek saklanır.
- **Silinen ölçüm:** ölçüm kaydı (ölçü, ağırlık, zaman) kalır; yalnız silinmiş ölçümün (son sürüm) kendi fotoğrafları 30 gün sonra silinir. 30 gün dolmadan geri yüklenen ölçümün fotoğrafları kalır; sonra geri yüklenen fotoğrafsız döner.
- **Eski sürümlerin fotoğrafları silinmez** (düzeltmede kaldırılan, yeniden ölçülen kolinin eski fotoğrafları dahil); şimdilik süresiz kalır, karara bağlanmadı. Silinmiş son sürümle aynı dosyayı paylaşan eski sürüm varsa dosya diskte kalır. Canlı ölçümün fotoğrafına dokunulmaz.
- **İtiraz kanıtı korunur:** itiraz satırı gönderim anındaki ölçüm sürümünü değişmez saklar; o ölçümün bütün sürüm zincirinin fotoğrafları, satır sonradan yeni ölçüme geçse de silinmez. Zincirdeki bir ölçüme bağlı fatura satırında karar varsa ("İtiraz listesinde" ya da "Uyumlu") ya da zincirin takip no'su bir itiraz satırında geçiyorsa da silinmez (kuşkuda silinmez).
- **Silinmiş ölçümün elle kalıcı silinmesi** (kullanıcı kararı 2026-11-13): paneldeki silinmiş ölçümde "Kalıcı olarak sil" (yalnız ölçüm yönetme izni) ölçümü, bütün eski sürümlerini ve fotoğraflarını (kayıt ve disk) hemen ve geri dönüşsüz siler; toplu silme yok. İtiraz kanıtı koruması aynen: itiraz kaydına ya da kararlı fatura satırına bağlı zincir silinmez, düğme nedeni yazılı devre dışıdır. Bağlı kalan kararsız fatura satırlarının bağı kalkar, fatura yeniden hesaplanır. Teknik: `Deciship/SPEC.md` §10.1.
- **Denetim izi kalır:** kalıcı silme kendi kaydını bırakır (`invoice.purge`: fatura no, satır sayısı; `measurement.purge`: takip no, sürüm ve fotoğraf sayısı). Eski denetim kayıtlarındaki takip no gibi bilgiler silinmez.
- **Varsayılan kapalı; canlıda açmak zorunlu adım:** `DELETED_INVOICE_PURGE_DAYS=30` ve `DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=30` (en az 7; boş, `off` ya da `0` kapatır). Açmadan önce `npm run purge:preview` neyin silineceğini sayar. Kapalıyken API açılışta uyarı yazar. Ekran "30 gün" dediği için süre değişirse ekran metni de değişmeli.

## Raporlar

- **Çok büyük faturada PDF raporu en büyük 1.000 fark satırını gösterir; tamamı Excel'de** (kullanıcı kararı 2026-11-12). Fark satırı (`DIFF`) sınırı aşarsa PDF, fark tutarı büyükten küçüğe (eşitse dosya sırası) ilk 1.000 satırı listeler; raporun başında ve tablonun sonunda "Bu PDF en büyük 1.000 fark satırını gösterir (toplam N satır). Tamamı Excel raporundadır." ve "Toplamlar tüm satırları kapsar." yazar. Özet ve toplamlar her zaman faturanın tamamıdır. Sınır `REPORT_PDF_MAX_ROWS` (varsayılan 1000). Excel raporu ve itiraz kanıt paketi değişmez.
