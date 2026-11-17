# DeciShip SPEC — Mobil uygulama ve referans kartı ölçümü (§6–§7)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 6. Mobil uygulama (apps/mobile)

Giriş, firma seçimi, Merkez sekmeleri ve kabuk platform mobil uygulamasındadır (paket `com.sellerondata.app`; tasarım D05, `Platform/docs/DESIGN.md`). DeciShip ekranları `app/(tabs)/deciship/` altındadır. Bu bölüm yalnız ölçüm işlevini anlatır.

#### Ekranlar (expo-router)

1. **Bugün** (`today`): üstte "Yeni ölçüm" (yarım ölçüm varsa önce sorar, §6.2); yarım ölçüm kartı; bugünkü ölçümler (takip no, ölçü, kg, desi, yöntem, durum: Gönderildi / Kuyrukta / Hata); kuyrukta bekleyen sayısı + "Şimdi gönder"; "Tüm ölçümlerim" bağlantısı.
2. **Okut** (`scan`): tam ekran kamera barkod okuyucu (Code128, Code39, EAN-13, QR, DataMatrix, PDF417, ITF-14).
   - Elle giriş alanı (Bluetooth okuyucu buraya yazar, Enter ile devam), fener.
   - Okununca titreşim + ses. Çevrimiçiyse `/measurements/check`; daha önce ölçüldüyse "Bu koli 14:12'de Mehmet tarafından ölçüldü — Yeniden ölç?" diyaloğu.
   - Okunan değer önce biçimden geçer (`src/lib/scanCheck.ts`, kural core `trackingFormat.ts`, §3.3): takip no'ya benzemiyorsa (ürün barkodu, yarım okuma, adres) tek soru "Bu bir takip no gibi görünmüyor" ("Yeniden okut" / "Yine de devam et"); kesin geçersizse yalnız "Yeniden okut". Okuyucu işaretleri ham değerden silinir. Kuyruktaki mükerrer denetimi aynı kuralla eşler (`src/queue/store.ts`).
3. **Ağırlık** (`weight`): "Tartıyı fotoğrafla" (kamera → `/vision/scale` → değer gösterilir, kullanıcı onaylar ya da düzeltir; fotoğraf `PHOTO_SCALE` olarak eklenir) **veya** sayısal klavyeyle elle giriş.
   - Çevrimdışıyken tartı fotoğrafı yine çekilir ve taslağa girer (kanıt); okuma yapılmaz, satırda "Çevrimdışı. Ağırlığı elle girin." yazar.
   - Firma tartı okumasını kapattıysa (`scaleAiRead: false`, varsayılan) fotoğraf yine çekilir ve kanıt olarak eklenir, hiç okutulmaz. Otomatik okuma iletisi ya da bekleme görünmez; satırda "İsteğe bağlı; kanıt olarak saklanır", çekimden sonra "Fotoğraf kaydedildi; değeri aşağıya girin" yazar; ağırlık elle girilir (`src/lib/scaleCapture.ts`).
   - Ayar `/me` ya da `/settings` yanıtından gelir; gelmezse kapalı sayılır. Ayar telefona ulaşmadan kapatıldıysa 409 `AI_DISABLED` "Otomatik okuma kapalı. Ağırlığı elle girin." der.
   - Yeniden çekimde önceki okuma silinir: yeni fotoğrafta "Yapay zekâ okudu" kalmaz, yöntem elle olur (`SCALE_CAPTURE_RESET`, `weightMethodOf`).
   - Tuş takımı her basışı bir öncekinin sonucuna uygular; hızlı basışta rakam kaybolmaz (`src/lib/numKey.ts`; ölçü alanının − / + düğmeleri de aynı, `dimStep.ts`).
4. **Ölçü** (`dims`, `reference`). Yöntemler:
   - **LiDAR ile otomatik** (yalnız `getCapabilities().lidar` true ise, en üstte, "Önerilen")
   - **AR ile ölç** (`ar` true ise; desteklemeyen cihazda hiç gösterilmez): köşelere dokunarak
   - **Referans kartı ile**: kart yanında tek fotoğraf; çevrimiçi gerekir (§7)
   - **Hazır koli**: K1/K2/K3 tek dokunuş
   - **Manuel**: her zaman

   Sonuç her yöntemde aynı düzenlenebilir alanlara düşer: En / Boy / Yükseklik (0,1 hassasiyet). Altında canlı: **Desi** (şirket böleni), **Hacimsel kg (5000)**, **Gerçek kg**, **Ücretlenecek (büyük olan)**. Yöntem ve güven yüzdesi gösterilir.
   - **Barem notu:** ölçü ve özet ekranında, ücretli ağırlık bir basamağı az farkla (≤ 0,2 kg) aşıyorsa tek satır çıkar ("Ücretli ağırlık 6,0 kg basamağını 0,2 kg ile aşıyor"). Yalnız kg, fiyat yok. "Kenar 1 cm kısa olsaydı" gibi ölçüyü kısmaya özendirecek not bilerek yoktur (`packages/core/src/barem.ts`, `baremNote`).
   - **Referans kartı kilidi:** vision kutuyu kendisi bulduysa (`suggestedBox.auto === true`) noktalar hazır gelir; bulamadıysa varsayılan yerleşim gösterilir ve kullanıcı noktaları taşımadan "Ölç" düğmesi kapalı kalır.
   - Ölçü, referans kartı ve liste ekranlarında teknik hata metni yerine kısa yönlendirme gösterilir.
5. **Fotoğraflar** (`photos`): en az `requiredBoxPhotos` kutu fotoğrafı (1600 px uzun kenar, JPEG %80); tartı fotoğrafı varsa gösterilir; ek fotoğraf eklenebilir ve silinebilir.
   - Galeriden seçilen fotoğraf koli fotoğrafı sayılmaz: `PHOTO_OTHER` olur (`src/lib/photoKind.ts`), zorunlu sayıya girmez ve altında "koliyi kamerayla çekin" notu çıkar. Sunucu da yalnız `PHOTO_BOX`'ı sayar.
6. **Özet ve Kaydet** (`summary`): tek ekranda her şey; "Kaydet ve yeni ölçüm" (birincil) ve "Kaydet".
   - Kayıt önce yerel kuyruğa yazılır (expo-sqlite `deciship.db` + fotoğraflar `Paths.document/queue/<clientId>/`), hemen gönderilmeye çalışılır; başarılıysa yerel dosyalar silinir.
   - Sunucuya yeniden ulaşılınca ve uygulama öne gelince kuyruk kendiliğinden boşalır; uygulama arka plana geçerken bir kez gönderim denenir (yalnız JS). Gerçek arka plan görevi ve yerel bildirim yoktur (yeni APK ister).
   - **"Çevrimiçi" = sunucuya ulaşılıyor**, internete değil (`src/queue/reach.ts`, yoklama `src/api/client.ts` `pingServer`): DeciShip sağlık ucu (`GET /api/deciship/health`) `{ ok: true }` döndü. İnternetsiz depo Wi-Fi'ında yerel sunucu ayaktaysa çevrimiçi; internet var ama sunucu kapalıysa (ya da karşılama sayfası varsa) çevrimdışı. NetInfo yalnız "hiç bağlantı yok" (yoklamadan çevrimdışı) ve bağlantı değişimi için kullanılır. Yoklama seyrek: bağlantı değişince, öne gelince ve gönderilecek kayıt varken turdan önce (sonuç 30 sn önbellekte), öndeyken ulaşılamıyorsa 30 sn, ayaktaysa 3 dk arayla; arka planda yok. Başarılı gönderim yoklama yerine geçer, gönderimdeki ağ hatası hemen yoklatır. Ulaşılamıyorken tur hiçbir kaydı yüklemez (deneme sayılmaz, ağ beklemesi kurulur). Rozet, çevrimdışı kutuları, "daha önce ölçüldü" denetimi ve çevrimiçi gerektiren düğmeler bu durumu okur.
   - Gönderilmemiş kayıt varken "Bugün"deki kuyruk kutusu bunu söyler (çevrimdışıyken tek sarı kutu). Sunucu ya da ağ hatasında genel üstel bekleme (§6.2 "Kuyruk zamanlaması"). `clientId` (taslağın kimliği) ile çift kayıt olmaz.
   - Akla aykırı değerde önce sarı uyarı onaylanır (§6.2).
7. **Ölçüm detayı ve geçmiş** (`measurement/[id]`, `measurement/edit`, `history`): düzenleme, silme, geri alma §10.3.
8. **Hesap** (`account`, ortak ekran `src/screens/AccountScreen.tsx`): "Yardım ve destek" satırı destek adresine (`SUPPORT_EMAIL`, contracts `support.ts`) konusu dolu bir e-posta açar; gövdede uygulama sürümü ve cihaz modeli (`src/lib/supportMail.ts`). Ekranın altında "Sürüm X.Y.Z (derleme)" satırı.

#### Genel kurallar

- **Saat dilimi:** "Bugün", Geçmiş gün grupları ve gösterilen saat firmanın saat dilimiyledir (`me.activeOrg.timeZone`, `src/lib/format.ts` `setFormatTimeZone`); profilde yoksa ya da cihaz adı tanımazsa telefonun saati. Ölçüm zamanı (`measuredAt`) telefon saatidir. Gönderimde telefonun o anki saati de gider (`X-SOD-Sent-At` başlığı, `src/api/client.ts` `stampSentAt`: her denemede, jeton yenilemesinden sonra, istek çıkarken; yedek olarak gövdede `sentAt`, `src/queue/flush.ts` `wirePayload`; kuyrukta saklanmaz): sunucu saat farkını düzeltir (§5.4), saati ileride, geride ya da sıfırlanmış telefonun kaydı da gerçek anla sıralanır. Barkod ekranında "daha önce ölçüldü" sorusunda "Yeniden ölç" seçilirse görülen kaydın kimliği taslağa (`replacesId`) ve kayda yazılır: sunucu o kayıt hâlâ güncelse saate bakmadan yenisini güncel yapar (başkasının kaydında kimlik gelmez; o zaman saat sırası geçerli). Kuyrukta geç kalan eski ölçüm, bu arada yapılmış yeni ölçümün yerine geçmez (sunucu eski sürüm olarak saklar, §5.4). Kabul aralığı dışındaki ölçüm anı `MEASURED_AT_INVALID` alır (bkz. kuyruk sınıfları).
- **Bugün sayacı:** "Ölçülen" = `GET /measurements/stats/today` `count` + telefonda gönderilmemiş bugünkü ölçümler; liste sayısının altına inmez. Uç yoksa ya da hata verirse listeden sayılır (`src/lib/todayCount.ts`). Liste en çok 200 ölçüm alır.
- Akış sihirbaz gibidir: takip no, ağırlık, ölçü ve zorunlu fotoğraf olmadan kaydedilemez. Hedef: okutmadan kayda **25 saniyenin altında**.
- Sunucu "Sunucu meşgul" (503) derse yalnız GET istekleri bir kez tekrarlanır.
- Ölçüm adımlarında (Barkod → Özet, referans kartı dahil) ekran kararmaz (`expo-keep-awake`, `app/(tabs)/deciship/_layout.tsx`); akıştan çıkınca kalkar.
- **Kamera izni** kalıcı reddedildiyse barkod ekranı ve fotoğraf penceresi "Ayarlarda izin ver" düğmesiyle telefonun uygulama ayarlarını açar; uygulama öne gelince izin yeniden okunur. İzin yokken fotoğraf penceresinde deklanşör yerine neden yazar (`src/ui/CameraPermission.tsx`).
- Canlı hesapta desi firma böleniyle, "Hacimsel kg" ve ücretli ağırlık sabit 5000 ile hesaplanır (§3.1; tanım gereği).

### 6.1 Yerel ölçüm modülü (`apps/mobile/modules/box-measure`, Expo Modules API)

```ts
export type MeasureResult = { lengthCm: number; widthCm: number; heightCm: number; confidence: number /*0..1*/; snapshotUri?: string /* file:// jpeg */ };
export function getCapabilities(): Promise<{ lidar: boolean; ar: boolean; arUnavailableReason?: string }>;
export function measureWithLidar(): Promise<MeasureResult | null>; // null = kullanıcı iptal etti
export function measureWithAR(): Promise<MeasureResult | null>;
```

- **iOS LiDAR (otomatik):** ARKit `sceneDepth`/`smoothedSceneDepth` + yatay düzlem algılama.
  - Masa düzlemi bulunur; düzlemin üstündeki derinlik noktaları kümelenir (kameranın baktığı merkeze en yakın küme).
  - Düzleme izdüşümde en küçük alanlı dikdörtgen → En/Boy; düzlemden en yüksek noktalar (üst %2 persentil) → Yükseklik.
  - Canlı tel kafes kutu çizilir, değerler ekranda; birkaç kare ortalanır (kararlılık), kararlı olunca "Kaydet" etkin. Güven = kare tutarlılığı + nokta yoğunluğu.
- **AR (iOS ARKit / Android ARCore):** yatay düzlem algılanır; kullanıcı kutunun tabanındaki 3 köşeye dokunur (A→B uzunluk, B→C genişlik).
  - Ardından yükseklik: C köşesinden dikey çizgi; kullanıcı telefonu yukarı doğrultup üst köşeye nişan alır (dikey çizgiye en yakın ışın noktası) ve dokunur.
  - Ekranda nişangâh, köşe işaretleri, ölçü etiketleri, "Geri al" ve "Baştan başla". Android'de ARCore yoksa `ar:false` + neden.
- Tam ekran yerel görünüm/aktivite olarak açılır; sonuç Promise ile döner. Kamera izni yönetilir. Development build gerekir (Expo Go değil).
- iOS kodu Windows makinede derlenemez: Swift kodu dikkatle, derlenebilir şekilde yazılır; iOS derlemesi EAS ile yapılır.

### 6.2 Yarım ölçüm, kuyruk sınıfları, ölçü uyarıları

#### Yarım ölçüm (taslak)

Kod: `src/draft/persist.ts`, `DraftContext.tsx`.

- **Yer:** yerel veritabanındaki `kv` tablosu. Anahtar `draft:<personId>:<orgId>`; değer `{ v: 1, savedAt, draft }`. `Draft.clientId` taslakla doğar ve kayıt kuyruğa **aynı kimlikle** girer.
- **Ömür:** `DRAFT_TTL_MS` = 2 gün (son yazmadan). Gönderilmiş kuyruk satırının kalma süresinden (`SENT_KEEP_MS`, 3 gün) kısa olmalıdır; yoksa kaydedilmiş ama silinememiş taslak geri gelirdi. Süresi dolan taslak ve fotoğrafları silinir.
- **Silinme bildirimi** (`src/draft/expiredNotice.ts`): süresi dolan taslak silinmeden önce `kv` tablosuna bildirim bırakılır (anahtar `expiredDraft:<clientId>`, değer `{ v: 1, rowKey, clientId, trackingRaw, startedAt, deletedAt }`).
  - Geri yükleme (`restoreDraft`) ve açılış süpürmesi (`sweepExpiredDrafts`) aynı yolu kullanır.
  - Bugün ekranı kişi ve firmanın kapatılmamış bildirimlerini tek kutuda gösterir ("Cuma, 6 Kasım 17:00 başlayan yarım ölçüm (takip no …) 2 günü geçtiği için silindi."). "Tamam" ile satır silinir, bir daha görünmez; kapatılmadıkça yeniden açılışta da durur.
  - Kaydedilmiş (kuyrukta) taslak için bildirim yok.
- **Fotoğraf dosyaları** (`src/draft/photoFiles.ts`): taslağa giren her fotoğraf hemen kalıcı klasöre kopyalanır: `Paths.document/drafts/<clientId>/`.
  - Önbellekteki kaynak hemen silinmez (ekran kullanıyor olabilir); taslak fotoğrafı silinince ya da taslak bitince birlikte silinir. Kopyalanamazsa fotoğraf eski adresiyle kalır.
  - Geri yüklemede önbellek adresli eski fotoğraf bulunursa kalıcı klasöre kopyalanır ve yeni adres hemen diske yazılır (`savedAt` değişmez; eski dosya silinmez). Kopyalanamazsa eski adres kalır; bulunamayan fotoğraf aşağıdaki gibi işlenir.
  - Fotoğraf silinince (kaldırma, değiştirme, Sil, Kaydet sonrası, süre dolumu) dosya silinir, boşalan klasör kaldırılır; kuyruk dosyalarına dokunulmaz.
  - Açılışta (ilk başarılı okumadan sonra bir kez) hiçbir taslağın sahiplenmediği klasör silinir. Kalan klasörler: adı diskteki ya da bellekteki bir taslağın kimliği olan, bir taslak fotoğrafının adresinde geçen (okunamayan satırlar da taranır) ve bu oturumda açılan.
- **Yükleme kapısı:** diskten okuma bitmeden hiçbir yazma ya da silme yapılmaz; açılıştaki boş taslak diski ezemez.
  - Okuma hata verirse diske dokunulmaz; 1 ve 3 sn sonra (ve uygulama öne gelince) yeniden denenir.
  - Denemeler tükenince ekran "korumalı" açılır: o anahtar silinmez, üstüne ancak yeniden okuma "saklı taslak yok" (ya da "saklı olan bu taslak") derse yazılır.
  - Bu arada yeni ölçüm kaybolmaz: yedek anahtara (`draft:<personId>:<orgId>:<clientId>`) yazılır; asıl anahtar boşalınca en eski yedek oraya taşınır ve "Yarım ölçüm" olarak gelir.
  - Korumalı açılış her kapsam için ayrı hatırlanır. Yeniden deneme zamanlayıcısı kapsam değişince ve sağlayıcı ayrılınca durur; okuma sıradayken öne gelme ikinci okuma başlatmaz.
- **Yazma** 300 ms gecikmeli, değişiklik anındaki kapsamın anahtarına; uygulama arka plana geçince hemen. Kapsam yokken (oturum geçici kapalı) okunmaz, yazılmaz. Başka firmaya geçince önceki firmanın taslağı silinmez, o firmaya dönünce sürer.
- Açılışta kuyrukta aynı `clientId` varsa taslak düşer (çift kayıt önlemi). Bulunamayan fotoğraf listeden çıkar, sayısı bir kez söylenir.
- **Kayıt** (`saveDraftToQueue`): kuyrukta yoksa yeni satır; gönderilmemiş satır varsa (önceki deneme yarıda kaldı) güncellenir. Gönderilmişse ya da şu an gönderiliyorsa yeni kayıt açılmaz ve hangisiyse o söylenir:
  - "zaten gönderildi": taslak düşer;
  - "şu an gönderiliyor": taslak tutulur. Gönderim başarısızsa satır kuyrukta PENDING ya da ERROR kalır ve yeniden Kaydet son değerleri satıra yazar. Düzeltme ekranı ve ölçüm detayı da gönderilmekte olanı "henüz gönderilmedi" diye sunmaz.
  - Başarılıysa taslak ve fotoğrafları silinir (kuyruk kendi kopyasını tutar).
- "Bugün"de "Yarım ölçüm · Devam et / Sil"; "Devam et" ilk eksik adıma gider (Barkod → Ağırlık → Ölçü → Fotoğraf → Özet). Taslak doluyken "Yeni ölçüm" sorar: devam et, sil ve yeni başla, vazgeç.

#### Kuyruk sınıfları

`src/queue/flush.ts` `classifySendError`, sırayla:
1. `scope`: jeton bu kaydın kişi/firmasına ait değil; dur, deneme sayılmaz.
2. `upgrade`: 426 ya da `UPGRADE_REQUIRED` (§6.3).
3. `network`: bağlantı yok ya da `TIMEOUT`; dur, genel kısa bekleme (aşağıda).
4. `paused`: `READ_ONLY`, `NO_PRODUCT_ACCESS`, `ORG_REQUIRED`, `FORBIDDEN`; dur, profil yenilenir.
5. `retry`: 401, 408, 429, ≥ 500. Kayıt Hatalı olmaz.
   - Sunucu genelindeki durumda (`serverTrouble`: 429, 408, 502, 503, 504, `AUTH_UNAVAILABLE`, `DB_UNAVAILABLE`) tur durur ve genel bekleme kurulur.
   - 500 ve diğer 5xx'te sıradaki kayda geçilir; aynı turda arka arkaya ikinci 500 turu durdurur.
   - Turu durduran bu kayıtlar genel beklemenin iki katı (en çok 30 dk) ertelenir; bekleme bitince sıradakiler önce denenir (baştaki iki bozuk kayıt arkadakileri sonsuza dek bekletmez).
6. `rejected` ("Hatalı"): durum 400/409/413/422 **ve** kod `REJECT_CODES` içinde: `VALIDATION`, `EMPTY_FILE`, `INVALID_FILE`, `VALUE_OUT_OF_RANGE`, `TRACKING_IN_USE`, `PHOTO_REQUIRED`, `FILE_TOO_LARGE`, `TOO_MANY_FILES`, `MEASURED_AT_INVALID`. Kullanıcı kaydı düzeltir. Hatalı kayıt otomatik turlara girmez (yalnız elle "Gönder"): döngü yok.
   - İstisna `MEASURED_AT_INVALID` + ölçüm anı telefonun şimdiki saatine göre en çok 6 saat ileride (ölçümden sonra saat düzelmiş; zaman geçince geçerli olur): kayıt Hatalı olmaz, o ana dek (en çok 30 dk, `ROW_DELAY_MAX_MS`) bekleyip kendiliğinden yeniden denenir (`measuredAtRetryAt`). Çok eski ya da daha uzak gelecekteki an düzelmez: Hatalı; çalışan saati düzeltip koliyi yeniden ölçer.
   - Bu kodu tanımayan eski uygulama gönderim anını da göndermez; sunucu onun aralık dışı anını reddetmez, alış anına çeker (§5.4), sonsuz yeniden gönderim olmaz. Yeni sürüm yayınlanınca yine `MIN_MOBILE_VERSION` (§6.3) yükseltilmesi önerilir (saat düzeltmesi ve `replacesId` yalnız yenide).
7. `config` (geri kalan her şey: 404, 405, 415, ağ geçidinin JSON olmayan 413'ü, tanınmayan kod): kayıt "Hatalı" olmaz, uzun aralıkla ertelenir ve sıradakine geçilir; tek kayıt sırayı tıkamaz.
   - Aynı turda iki ardışık `config` döngüyü durdurur; "Bugün"de "Sunucu ayarı sorunu… yöneticinize bildirin" satırı çıkar, sonraki başarılı gönderimde kalkar. Elle "Gönder" yine dener.

**Kural:** API `POST /measurements` için kayda özgü yeni bir hata kodu eklerse mobil `REJECT_CODES` listesine de eklenir. Eklenmezse kayıt kaybolmaz, "sunucu ayarı sorunu" olarak bekler. Kodların API'deki tek listesi `apps/api/src/lib/measurementCodes.ts` (kayda özgü + kayda özgü olmayan); mobil testi (`tests/flush.test.ts`) iki listeyi ve `routes/measurements.ts` içinde yazılan kodları karşılaştırır.

#### Kuyruk zamanlaması

Kod: `src/queue/schedule.ts` `nextFlushPlan`, `createFlushGate`.

- Turu durduran sunucu ya da ağ sorunu genel bir bekleme kurar: sunucuda 15 sn, her başarısız turda iki katı, en çok 10 dk; ağda 5 sn'den en çok 60 sn; ±%15 dağılım.
  - Kısa `retry-after` (veritabanı 3 sn) beklemeyi kısaltmaz. Süresini söyleyen 429'da bekleme `retry-after` kadardır, büyümez.
  - İlk başarılı gönderimde, oturum ya da yazma hakkı değişince sıfırlanır.
- Sunucunun `retry-after` süresi (en çok 60 sn) hiçbir tetikle atlanmaz.
- Zamanlayıcı (15 sn, uygulama öndeyken), kayıt, düzeltme, Bugün'e dönüş ve arka plana geçiş genel beklemeye ve kayıt başına beklemeye (`nextAttemptAt`) uyar.
- Uygulama öne gelince (soğuk açılış dahil) bekleme atlanır ve bir kez denenir; tur ilk sunucu hatasında durduğu için en çok bir kayıt yüklenir.
- Elle "Gönder", aşağı çekip yenileme ve ağın geri gelmesi beklemeyi atlar, Hatalıları da dener; yetki engelini (`PAUSE_MS`) de atlar.
- Bekleme anı en uzun süresinden ileride ise (telefon saati geri alındı) yok sayılır; kayıt beklemesi (`nextAttemptAt`) de 30 dk'dan (`ROW_DELAY_MAX_MS`) ileride ise kayıt bekliyor sayılmaz.
- Yerel veritabanı açılamazsa (ör. depolama dolu) bir sonraki çağrıda yeniden denenir (`src/queue/db.ts`). Açılıştaki yarıda kalmış gönderimlerin geri alınması (`recoverInterrupted`) hata verdiyse sonraki gönderim onu yeniden dener (`createRecovery`); uygulamayı yeniden başlatmak gerekmez.

#### Oturum yenileme

Kod: `src/api/client.ts` `refreshTokens`.

- Hesap servisi döndürülmüş eski yenileme jetonunu, yeni jeton henüz kullanılmadıysa kabul eder: aynı tekrar anahtarıyla geldiyse süre aramadan, değilse döndürme anından 60 sn (`REFRESH_REUSE_GRACE_SECONDS`) içinde; sonrası hırsızlık sayılır (ayrıntı `Platform/docs/mimari/04-hesap-oturum.md`).
- Tekrar anahtarı (`retryKeyFor`): elimizdeki jetonla ilk yenilemeden önce 32 rastgele bayt (`expo-crypto`) üretilir, güvenli depoya (`sod_refresh_retry`, `<jetonun SHA-256 özeti>:<anahtar>`; açılışta özet depodaki jetonla tutmazsa atılır) jetondan sonra yazılır, sonra istek çıkar; jeton değişene dek her deneme (uçuş içi tekrarlar, sonraki istekler, uygulamanın yeniden açılışı) aynısını gönderir. Yeni jeton depoya yazılınca, çıkışta da silinir; firma değişimi gibi jetonu korumayan yanıt silmez.
- Mobil: ilk yenileme 6 sn bekler. Sonucu belirsiz deneme (ağ hatası, zaman aşımı, ağ geçidinin 502/504'ü) aynı eski jetonla 0,3 ve 1,2 sn sonra yeniden denenir (`REFRESH_RETRY_DELAYS_MS`); tekrar yalnız ilk denemeden 7 sn içinde başlar.
- Kesin cevaplar (401, 403, 426, 429, 500, 503) tekrarlanmaz. Aynı anda gelen 401'ler tek yenileme uçuşunu bekler.
- `403 NO_PRODUCT_ACCESS` + `details.refreshable: true` gelirse jeton 30 sn'de en çok bir kez yenilenir (`ACCESS_REFRESH_INTERVAL_MS`) ve istek bir kez tekrarlanır.
- Yenileme yanıtı gelirken çıkış yapıldıysa yeni jeton yazılmaz; güvenli depoya yazımlar çağrı sırasıyla yapılır (çıkıştan sonra depoda jeton kalmaz).
- Pencere içinde hiç yanıt alınamazsa oturum kapanmaz; sonraki istekte (dakikalar, günler sonra ya da uygulama yeniden açılınca) eski jeton aynı anahtarla yeniden denenir ve sunucu döndürdüyse de kabul eder. Anahtar depoya yazılamadıysa (depo dolu) uygulama yeniden açılınca yeni anahtar üretilir; o zaman yalnız 60 sn kuralı geçerlidir.

#### Ölçü sınırları ve uyarılar

Kod: `src/ui/DimField.tsx`, `weight.tsx`, `src/lib/plausibility.ts`.

- Kenar 0 < n ≤ 400 cm, ağırlık < 1000 kg. Dışındaki değer kırpılmaz: geçersiz sayılır, yazılan korunur, alanın altında neden yazar.
- Akla aykırı ama geçerli değer: bir kenar > `warnEdgeCm` (firma ayarı, varsayılan 150 cm), ağırlık > `warnWeightKg` (firma ayarı, varsayılan 70 kg), desi gerçek ağırlığın 20 katından fazla (`RATIO_WARN`, sabit, firma böleniyle).
- Eşikler `GET /settings` ile gelir; gelmezse ya da aralık dışıysa varsayılanlar kullanılır (`plausibilityLimits`).
- Özet ekranında ve düzeltme ekranında (yalnız ölçü ya da ağırlık değiştiyse) aynı sarı uyarı çıkar; "Değerler doğru" denmeden kaydedilmez. Ölçü, ağırlık ya da eşik değişince onay sıfırlanır.
- Sunucu bu eşiklerle ölçüm reddetmez.

#### Hata ekranı

`app/_layout.tsx` (son çare; sağlayıcıya bağlı kanca kullanmaz) ve `app/(tabs)/_layout.tsx`. Taslak diskte olduğu için veri kaybettirmez. Çekim ya da galeri hatası kamera penceresinde tek satırla söylenir. Hata kaydı sunucuya gönderilmez.

### 6.3 Sürüm denetimi ve 426

Platform kuralı ARCHITECTURE'da; sözleşme `Platform/packages/contracts/src/client.ts`.

- **Başlık:** mobil her isteğe `X-SOD-Client: mobile/<sürüm>+<derleme> (<platform>)` koyar (ör. `mobile/1.1.0+2 (android)`). Sürüm `app.config.js` çıktısından gelir (`src/version/client.ts`); başlığı gönderen ilk sürüm 1.1.0.
- **Sunucu:** `MIN_MOBILE_VERSION` (x.y.z) Hesap servisinde ve DeciShip API'de aynı katı kuralla (`strictVersion`) okunur.
  - Başlık `mobile/…` ve sürüm altındaysa uygulama düzeyindeki tek kanca 426 `UPGRADE_REQUIRED` döner, `details: { minVersion, updateUrl }` (DeciShip API'de `updateUrl` `null`).
  - Başlık yoksa ya da bozuksa denetim yapılmaz: web, curl ve eski APK etkilenmez.
  - Değişken boşsa denetim yok; biçimi bozuksa üretimde servis açılmaz, geliştirmede uyarı yazar ve denetim yapmaz.
  - Muaf yollar: DeciShip `/health`; Hesap `/client-policy`, `/health`, `/catalog`, `/.well-known/jwks.json`.
  - Başlık uydurulabilir: bu bir güvenlik önlemi değildir.
- **Politika ucu:** `GET /api/account/client-policy` (açık, `cache-control: no-cache`) → `{ mobile: { minVersion, latestVersion, updateUrl } }` (`MIN_MOBILE_VERSION`, `MOBILE_LATEST_VERSION`, `MOBILE_UPDATE_URL`; ayarlanmamışsa `null`).
- **Mobil davranış** (`src/version/policy.ts`, `src/ui/UpdateRequired.tsx`): herhangi bir 426 yanıtı ya da açılışta ve öne gelişte politika denetimi tam ekran güncelleme ekranını açar.
  - Durum telefonda saklanır (`sod_upgrade_required`), çevrimdışı açılışta da sürer. Ağ hatası ve bozuk yanıt durumu açmaz.
  - Ekran bekleyen ölçüm sayısını söyler, "silmeyin, üzerine kurun" der; çıkış düğmesi yok.
  - Bayrak, uygulamanın sürümü değişince ya da sunucu "gerek yok" deyince kalkar.
- **Kuyruk** (`src/queue/flush.ts`): 426 ya da `UPGRADE_REQUIRED` sınıfı `upgrade`: kayıt Hatalı olmaz, silinmez, deneme sayısı artmaz; döngü durur. Güncelleme durumu açıkken zamanlayıcı, öne alma ve elle "Gönder" gönderim yapmaz. Elle denenen Hatalı kayıt 426 alırsa Hatalı kalır.
- **Derleme** (`app.config.js`, `eas.json`, `Deciship/scripts/android-build.ps1`): üretim ve önizleme derlemesi https API adresi olmadan durur.
  - Sunucu adresi alanı yalnız `APP_ENV=development`'ta görünür (`src/api/serverUrl.ts` `SERVER_EDITABLE`); şifresiz HTTP yalnız geliştirmede.
  - Betik yapılandırma değişince `android/` klasörünü yeniden üretir, uygulama kimliğini (`com.sellerondata.app`) ve `versionCode`'u denetler.
- **Araç kaydı** (`src/tools/registry.ts`): mobilde ekranı olan araçlar tek listededir; erişilebilirlik sunucudan gelir (`me.products[]`). Ekranı olmayan açık araç "Web'de aç" olarak görünür.
- **Merkez sözleşmesi kuralı:** `contracts/src/hub.ts` alanları yalnız eklenir ve isteğe bağlıdır; kaldırma ya da yeniden adlandırma ancak `MIN_MOBILE_VERSION` yükseltilerek yapılır.

---

## 7. Referans kartı ölçümü (services/vision)

Kart: **ArUco `DICT_4X4_50`, id 7, siyah kare kenarı tam 100 mm**. A4'e, çevresinde kesim çizgisi ve "Ölçek kontrolü: bu çizgi 100 mm olmalı" cetveliyle basılır (`samples/reference-card.pdf`; web panelden de indirilir).

Kullanım: kart masaya kutunun **yanına** düz konur; kutu, üç yüzü görünecek şekilde çapraz yukarıdan **tek fotoğrafla** çekilir. Servis yalnız API'den çağrılır (iç servis, `VISION_URL`). Servisin öbür uçları (`/health`, varsayılan kapalı `/scale/read-free`): `services/vision/README.md`.

- **`POST /detect`** (image):
  - markörü bulur, köşeleri alt-piksel hassas;
  - kamera iç parametresini tahmin eder: EXIF odak uzaklığı varsa ondan, yoksa markör homografisinden tek görüntü odak tahmini; asal nokta = görüntü merkezi;
  - masaya göre kamera pozunu `solvePnP` ile çıkarır;
  - kutunun görünen köşelerini öneri olarak bulur (kontur + düzlem bilgisi; bulunamazsa makul varsayılan yerleşim).
  - `points` sırası `[B1, B2, B3, T1, T2, T3]`: masaya değen 3 görünür alt köşe (B2 ortadaki/öndeki köşe) ve bunların hemen üstündeki 3 üst köşe.
  - Yanıt: `suggestedBox: { points, auto }`. `auto` true: köşeler otomatik bulundu; false: varsayılan yerleşim (kullanıcı noktaları taşımalı). `message` yalnız gösterim içindir, karar için kullanılmaz.
- **`POST /solve`:** alt köşeler masa düzlemiyle ışın kesişiminden 3B'ye; `L = |B1B2|`, `W = |B2B3|`. Yükseklik, T noktalarının ilgili alt köşenin dikeyi üzerindeki en küçük kareler çözümüdür (üçünün ortalaması, aykırı atılır). Güven: markör yeniden izdüşüm hatası + dikeylik/ortogonallik tutarlılığı. Geçersiz nokta 422.
- **Mobil:** fotoğraf çekilir → detect → önerilen 6 nokta fotoğrafın üstünde sürüklenebilir tutamaçlarla gösterilir (büyüteçli) → kullanıcı düzeltir → solve → ölçü alanlarına düşer.
- **Fotoğraf girişi:** JPEG/PNG/WebP (HEIC yok; mobil zaten JPEG gönderir); EXIF yönü düzeltilir.
  - Uzun kenarı 4032 px'ten büyük fotoğraf küçültülür; `imageSize` ve koordinatlar küçültülmüş görüntüye göredir. 50 MP üstü (`MAX_PIXELS`) reddedilir.
  - Okunamayan ya da çok büyük dosya 400 `{ ok:false, message }`.
  - Kart yok, kısmen görünüyor ya da bulanık (kenar geçişi > kart kenarının %10'u, `MAX_MARKER_BLUR`): 200 `{ ok:false, message }`; mobil `message`'ı gösterir.
- Kart köşeleri, kenarlarına oturtulan doğruların kesişiminden bulunur (bulanıklıkta köşe içe kaymaz). İki kart görünürse büyük görüneni kullanılır.
- Otomatik kutu önerisi yalnız B2 açısı 90±10° ve gizli arka üst köşe silüetle tutarlıysa verilir.
- Doğruluk hedefi: sentetik testlerde ±0,5 cm, gerçek fotoğrafta ±1 cm. pytest ile sentetik render (bilinen kutu + markör, OpenCV ile izdüşüm) testleri zorunludur.
