# DeciShip SPEC — Esneklik: düzenleme, silme, geri alma (§10)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 10. Esneklik: düzenleme, silme, geri alma

İlke:
- Her değişiklik geri izlenebilir: ölçüm düzeltmesi yeni sürüm yazar, silme yumuşaktır (`deletedAt`), her işlem denetim kaydı bırakır.
- Ölçüm ya da fatura değişince ilgili faturalar otomatik yeniden karşılaştırılır (§4 son paragraf); karar verilmiş ve itirazdaki satırlar donar, tarife ve ayar değişikliği eski faturayı kendiliğinden değiştirmez (§3.14).
- `prices.view` olmayan kişi hiçbir yanıtta fiyat/tutar görmez.

### 10.1 Ölçümler (API)

#### Düzeltme
- `PATCH /measurements/:id`. Yetki: `measurements.manage` her ölçümü, ölçüm yapan yalnız kendisininkini düzeltir; başkasınınki 404; süre sınırı yok.
- Gövde JSON ya da multipart `data`: `{ trackingRaw?, lengthCm?, widthCm?, heightCm?, weightKg?, dimMethod?, weightMethod?, boxPresetId?: string|null, note?: string|null, measuredAt? (yalnız manage; diğerinden yok sayılır. Değişiyorsa sunucu saatinden en çok 15 dk ileride olabilir, yoksa `400 MEASURED_AT_INVALID`; geçmişe çekmek serbest, §5.4), removePhotoIds?: string[], photoKinds?: PhotoKind[] }`.
- Multipart'ta ayrıca `photos` (`photoKinds` ile aynı sırada; eksikse fazla fotoğraf `PHOTO_OTHER`).
- Sonuç her zaman **yeni sürüm**: eski sürüm `supersededById` alır, fotoğraflar yeni sürüme kopyalanır (`removePhotoIds` hariç), yeni fotoğraflar eklenir.
- Yanıt `200`, yeni sürümün detayı (yeni `id`!); istemci yanıttaki `id` ile devam eder. Eski sürüme `PATCH` → `409 NOT_LATEST_VERSION`.
- Yöntem kuralı:
  - `boxPresetId` verilirse → `PRESET`, ölçüler (gönderilmediyse) hazır koliden alınır, `dimConfidence=null`.
  - Ölçüler değişip `dimMethod` gönderilmezse → `MANUAL`, `dimConfidence=null`, `boxPresetId=null`.
  - Ağırlık değişip `weightMethod` gönderilmezse → `MANUAL`.
- `PHOTO_REQUIRED` (400, `details: { required, boxPhotos }`): düzenleme kutu fotoğrafı sayısını şirket ayarının altına **düşürüyorsa**. Ayarı zaten karşılamayan eski kayıtlar fotoğraf eklenmeden de düzenlenebilir.
- Bilinmeyen `boxPresetId` → `404`.

#### Silme ve geri yükleme
- `DELETE /measurements/:id` (aynı yetki) → yumuşak silme, `204`.
- `POST /measurements/:id/restore` (aynı yetki) → `deletedAt = null`, `200` detay; silinmemiş kayıtta da `200` (idempotent).
- `409 NEWER_EXISTS`: sürüm zincirinde silinmemiş daha yeni bir sürüm var ya da aynı takip no ile daha sonra oluşturulmuş silinmemiş güncel bir ölçüm var.
- İstisna (KALANLAR 6.7): o güncel ölçüm silinmişken gelen **geç** kayıtsa (tek sürümlü, ölçüm anı geri yüklenenin hem ölçüm anından hem `createdAt`'inden önce; kendi kaydı ya da `measurements.manage`) geri yükleme yapılır ve geç kayıt geri yüklenen zincire eski sürüm olarak girer (`arrivedLate`); denetim kaydında `lateId`.

#### Kalıcı silme
- `POST /measurements/:id/purge` (`services/measurementPurge.ts`). Yalnız `measurements.manage`; kendi ölçümü için ölçüm izni yetmez → `403`. **Geri gelmez.** Toplu kalıcı silme yok.
- Yalnız silinmiş (`deletedAt` dolu) son sürümde çalışır. Ölçüm, bütün eski sürümleri (zincirin tamamı) ve bu sürümlerin bütün `File` satırları tek işlemde silinir.
- Disk dosyaları işlem kapandıktan sonra silinir, yalnız aynı yolu gösteren başka satır kalmadıysa (başka ölçümün dosyası kalır; diskte bulunamayan dosya sorun sayılmaz).
- Yanıt `200 { purged: { id, trackingNo, versions, photos } }`.
- Hatalar:
  - `404`: yok ya da başka firmanın.
  - `409 NOT_DELETED`: silinmemiş. `409 NOT_LATEST_VERSION`: eski sürüm.
  - `409 MEASUREMENT_CHANGED`: kilit altında zincir değişti ya da zincirin bir sürümünün faturalarla karşılaştırması bitmedi (`recomparePendingAt` dolu: bağlı açık satır hâlâ bu ölçümün rakamını taşıyabilir; "biraz sonra yeniden deneyin").
  - `409 MEASUREMENT_PROTECTED`, `details.reason`:
    - `DISPUTE`: zincirin bir sürümü itiraz kanıtı; ya da zincirin takip no'su, takip no'sunun veya ham barkodunun son 10 karakteri bir itiraz satırında; ya da zincire bağlı satır itirazda (her tur, geri çekilmiş dahil).
    - `DECIDED_LINE`: zincire bağlı fatura satırında karar var (faturası silinmiş olsa da).
- Koruma, §5.13'teki 30 günlük fotoğraf temizliğinin aynı SQL'idir (`chainProtectedSql`; kuşkuda silinmez).
- Ayrıntı (`GET /measurements/:id`) silinmiş son sürümde ve yönetme iznine `purge: { allowed, reason }` taşır.
- **Fatura satırları:**
  - Zincire bağlı kalan (korumadan sonra kararsız, itirazsız) satırların bağı kalkar (`measurementId = null`, elle eşleştirme `measurementPinned = false`).
  - Silinmemiş faturalarına aynı işlemde `InvoiceRecheck` işareti yazılır. İşlem kapanınca fatura sabit dayanakla yalnız açık satırlarla yeniden hesaplanır (`MEASUREMENT`), işaret silinir; hesap düşerse işaret kalır, bakım tamamlar.
  - Satırın sonucu silinen ölçüme dayanmaz; aynı koli yeniden ölçüldüyse satır takip no ile yeni ölçüme eşleşir.
  - Bağı kalkan satırın geçmiş kayıtlarında (önceki sonuç `prevResult`, hesap dökümü) silinen ölçümün ölçüleri sayı olarak kalabilir; ölçüm kaydının kendisi gider.
  - Elle eşleştirme, son sürümü silinmiş zincirin eski sürümünü de kabul etmez (`404`).
- **Eşzamanlılık:**
  - Kilit sırası: içe aktarma kilidi (paylaşımlı) → takip no danışma kilidi (geri yükleme, düzeltme ve yeniden ölçümle aynı) → dosya, ölçüm satırları → ilgili faturalar → satırlar (`FOR UPDATE`). Koruma kilit altında sınanır.
  - Önce gelen kazanır: geri yükleme önceyse `409 NOT_DELETED`, kalıcı silme önceyse geri yükleme `404`.
  - Kilitlenmede (40P01) işlem geri alınır ve bir kez yeniden denenir.
- Denetim: `measurement.purge` (takip no, sürüm, fotoğraf ve bağı kalkan satır sayısı, silinme anı, silinen sürüm kimlikleri `versionIds`, bağı kalkan satırların faturaları `invoiceIds`). Merkez etkinlik akışında "silinen ölçümü kalıcı olarak sildi". Eski denetim kayıtları kalır.

#### Denetim kayıtları
`measurement.create`, `measurement.remeasure`, `measurement.correct`, `measurement.delete`, `measurement.restore`, `measurement.purge`.

### 10.2 Faturalar (API)

#### Fatura başlığı
- `PATCH /invoices/:id` `{ invoiceNo?, invoiceDate? ('YYYY-MM-DD'), periodFrom?: string|null, periodTo?: string|null, currency? (3 harf), carrierId?, tariffId?: string|null, token? }` → `200 { invoice }` (`GET /invoices/:id` ile aynı biçim).
- Değişmeyen alanlar yok sayılır; hiçbir şey değişmezse kayıt yazılmaz.
- Yeniden hesap (kararlar korunur):
  - `carrierId` ya da `tariffId` değişirse fatura yeni tarifenin bugünkü sürümüne bağlanır (yalnız tarife parçası; ayar faturadaki kalır) ve karar verilmiş satırlar dahil baştan hesaplanır.
  - Yalnız `invoiceDate` ya da `currency` değişirse kendi sabit dayanağıyla (`pinned`) baştan hesaplanır (§3.14).
- Token: bu dört alandan (`carrierId`, `tariffId`, `invoiceDate`, `currency`) biri değişiyorsa `token` zorunludur; aynı değişikliğin `recalculate/preview` `{ basis: 'pinned', patch }` önizlemesinin özetidir.
  - Token yoksa `400 VALIDATION` (`details[].path = token`).
  - Önizlemeden sonra ölçüm, karar, tarife ya da satır değiştiyse `409 PREVIEW_STALE` ve hiçbir alan yazılmaz.
  - `invoiceNo` ve dönem token istemez.
- `tariffId: null` → taşıyıcının varsayılanı; `carrierId` değişip `tariffId` verilmezse yeni taşıyıcının varsayılanı.
- Gönderilmiş itirazı olan faturada bu dört alan değişmez: `409 INVOICE_HAS_DISPUTE` ([itiraz.md](itiraz.md)); `invoiceNo` ve dönem serbest.
- Hatalar: `409 INVOICE_EXISTS` (aynı taşıyıcıda silinmemiş başka faturada aynı numara), bilinmeyen taşıyıcı `404`, `periodFrom > periodTo` → `400 VALIDATION`.

#### Fatura satırı
- `PATCH /invoice-lines/:id` düzeltme alanları (karar alanları §5.8, `parseChecked` §11.5); hepsi isteğe bağlı, yanıt `200 { line, totals }`.
- Takip no düzeltme ve elle eşleştirme faturayı kayıtlı dayanağıyla yeniden karşılaştırır:
  - Düzeltilen satır kararlı olsa da yazılır (kararı değişmez, eski rakamı `prevResult`'ta); öbür kararlı satırlar yalnız işaretlenir.
  - Kararı `OPEN`'a dönen ve yeniden hesap bekleyen (`recalcPending`) satır aynı istekte güncel ölçüm ve sabit dayanakla hesaplanır.
  - Not yazmak ya da silmek hesap yapmaz, hiçbir rakamı değiştirmez (§3.14 "Satır düzeltmesi ve not").
- `trackingNo`: faturadaki takip no yazım hatasını düzeltir. Normalize edilir; satır yeniden eşleşir ve karşılaştırılır. Orijinal değer ilk düzeltmede `originalTrackingNo`'da saklanır (sonraki düzeltmeler bu değeri değiştirmez; orijinale geri dönülürse `null` olur).
- `measurementId`: elle eşleştirme.
  - Silinmemiş, şirkete ait bir ölçüm olmalı (yoksa `404`); herhangi bir sürümün id'si verilebilir.
  - Satır o ölçüme **sabitlenir** (`measurementPinned = true`); yeniden karşılaştırmalar takip no'ya bakmaz, zincirin **en güncel silinmemiş sürümünü** kullanır ve `measurementId` o sürüme güncellenir.
  - `null` sabitlemeyi kaldırır, otomatik eşleşmeye döner.
- **Sabitlenmiş ölçüm silinirse:** satır `UNMATCHED` karşılaştırılır, sabitleme korunur (`measurementPinned=true`, `measurementId` silinmiş sürümü gösterir, `measurement: null`).
  - Ölçüm geri yüklenince eşleşme kendiliğinden döner; kalıcı silinirse (§10.1) sabitleme kalkar ve satır takip no ile yeniden eşleşir.
  - UI "Eşleştirilen ölçüm silindi" gösterebilir (`measurementPinned && measurementId && !measurement`).
- `note`: elle yazılan not yeniden karşılaştırmalarda korunur (`noteManual`). `null`/boş → not silinir; karşılaştırmanın otomatik notu, satırın sabit dayanakla sonucu kayıtlıyla aynıysa geri gelir (değilse not boş kalır, rakam değişmez).
- Eşleştirme penceresi ölçüm aramak için `GET /measurements?q=` kullanır; ek uç yoktur.

#### Denetim kayıtları
`invoice.import` (`skippedRows`, PDF'te `pdfUnverified` sayıları da), `invoice.importUnverified`, `invoice.aiMapping`, `invoice.update` (`{ changes, recompared }`), `invoice.recompare` (`{ flaggedLines, pendingLines }`), `invoice.recalculate` (§3.14), `invoice.delete`, `invoiceLine.decision`, `invoiceLine.trackingFix`, `invoiceLine.pin`, `invoiceLine.unpin`, `invoiceLine.parseChecked`, `invoiceLine.update` (yalnız not).

### 10.3 Mobil
- **Ölçüm detayı** (`measurement/[id]`): Bugün ve geçmişteki her kayda dokununca açılır. Ölçü, ağırlık, desi, yöntem, fotoğraflar, not, sürüm ("Düzeltildi · 2. sürüm"). Eylemler **Düzenle**, **Sil**.
- **Düzenle** (`measurement/edit`): takip no, ağırlık, ölçüler (hazır koli / elle), not, fotoğraf ekle/çıkar → `PATCH`.
  - Çevrimdışıysa "Düzenlemek için internet bağlantısı gerekir".
  - Form kayıt başına bir kez doldurulur; uygulama öne gelince yapılan profil yenilemesi yazılanı silmez (aynı dile geçişte i18next'e dokunulmaz, `src/i18n` `setLocale`).
  - Tuş takımı açıkken akla aykırı değer uyarısı alt şeritte gösterilmez, "Tamam"dan sonra çıkar.
- **Sil:** onay → `DELETE` → listeden kalkar; altta ~6 sn **"Silindi · Geri al"** bildirimi (`/restore`).
- **Kuyruktaki** (henüz gönderilmemiş, Kuyrukta/Hata) kayıtlar yerelde düzenlenir ya da silinir; sunucuya gitmez.
- **Geçmiş** (`history`): Bugün ekranında "Tüm ölçümlerim" → takip no arama + gün gün gruplu, sayfalı liste.
- Mobilde `measurements.view_all` izni olan tüm firma ölçümlerini görür, `measurements.manage` izni olan düzenler.

### 10.4 Web
- **Fatura başlığı:** "Fatura bilgilerini düzenle" penceresi (fatura no, tarih, dönem, para birimi, taşıyıcı, tarife).
  - Taşıyıcı, tarife, tarih ya da para birimi değişince "Satırlar yeniden hesaplanacak" uyarısı; kaydetmeden önce önce/sonra penceresi (değişiklik rakamları etkilemiyorsa doğrudan kaydeder).
  - Gönderilmiş itirazda bu dört alan kilitli gösterilir.
- **Satır ayrıntısı:** "Takip no'yu düzelt"; "Ölçümle eşleştir" (takip no ile ölçüm arayıp seçme); "Eşleştirmeyi kaldır"; satır notu. Sabitlenmiş eşleşmede "Elle eşleştirildi", düzeltilmiş takip no'da "Faturada: X".
- **Ölçümler:**
  - Silme sonrası "Geri al" bildirimi; "Silinenler" süzgeci ve her satırda "Geri yükle".
  - Silinmiş ölçümün panelinde "Geri yükle" (tek birincil eylem) yanında çöp kutusu "Kalıcı olarak sil": onay penceresi takip no'yu ve geri alınamadığını söyler, tek eylem kırmızı.
  - Korunan ölçümde düğme devre dışı, nedeni panelde yazılı (`pages/measurements/PurgeMeasurement.tsx`).
