# DeciShip SPEC — Dosya temizliği ve dosya alanı (§5.13, devam)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

### 5.13 Arka plan işleri ve dosya temizliği (devam)

Bölümün ilk yarısı (iş kuyruğu, ölçüm ve mükerrer yeniden hesabı): [arka-plan-isleri.md](arka-plan-isleri.md).

#### Dosya temizliği

`services/fileCleanup.ts`, `lib/storage.ts` `deleteStored`; `File.purgedAt`, `File.preview`; saatlik bakım `runFileCleanup`.

| Dosya | Ne zaman silinir |
|---|---|
| Önizleme dosyası (`INVOICE_SOURCE`, faturaya bağlanmamış), kullanıcı vazgeçti | Hemen (`DELETE /invoices/preview/:fileId`); ayrıntı aşağıda |
| Önizleme dosyası, PDF okuma başarısız, durduruldu ya da bırakıldı | İşin bitişinde (temizlik kancası) |
| Önizleme dosyası, unutuldu | Bakım: `updatedAt` 24 saatten eski; tazeleme aşağıda |
| Silinen faturanın kaynak dosyası | Bakım: dosyayı gösteren **bütün** faturalar 30 günden uzun süredir silinmiş. Diskten silinir, satır kalır (`purgedAt` dolu, `preview` boşaltılır); `GET /files/:id` 404 |
| Tarife PDF'i | 7 gün |
| Silinen faturanın kendisi, satırları ve kaynak dosya kaydı | Açıksa N gün (karar 30) sonra kalıcı ("Silinenlerin kalıcı temizliği"; varsayılan kapalı; itiraz kaydı olan fatura kalır) |
| Ölçüm fotoğrafı | Yalnız silinmiş ölçümün (son sürüm) kendi fotoğrafları, açıksa N gün sonra kalıcı. Eski sürümlerin fotoğrafı, canlı ölçümün fotoğrafı ve itiraz kanıtı hiç silinmez |

**Vazgeçilen önizleme:**
- Panelde "Başka dosya seç" (başka dosya) ve sihirbazdan çıkış → `DELETE /invoices/preview/:fileId`.
- "Geri" silmez: önizleme 1. adımda "Devam" ile yeniden açılır. Aynı dosyanın yeniden okumasında ("Yeniden oku", taşıyıcı değişimi) eski dosya yeni okuma uygulanınca silinir, okuma düşerse kalır (web `liveFile.ts`, `wizardKeep.ts`).
- **Yalnız yükleyen kişi** siler (başkasınınki 404).
- Aynı PDF'in süren okumasına bağlanan üye (`joined: true`) önizlemeyi paylaşır (`File.holders`): paylaşılan önizlemede vazgeçen yalnız listeden çıkar, dosya son tutan vazgeçince silinir.
- İçe aktarma sürerken panel vazgeçme çağrısı göndermez.

**Unutulan önizleme:** doğrulama ve eşleme çağrıları `updatedAt`'i tazeler. Panel de önizleme açıkken (adım 2–3) kullanıcı sayfada bir şey yaptıysa en çok 15 dakikada bir `POST /invoices/preview/:fileId/keep` gönderir. Sekmesi açık kalıp dokunulmayan önizleme tazelenmez, 24 saat sonra silinir.

**Korumalar** (`discardPreviewFile`, `purgeInvoiceSourceFile`; firma bağlamında, satır `FOR UPDATE` kilidiyle tek işlemde; önce satır, sonra disk):
- Faturaya bağlı (silinmiş fatura dahil) dosya önizleme olarak silinmez; son güvence `Invoice.sourceFileId` yabancı anahtarı `RESTRICT` (23503 yakalanır, dosya korunur). Canlı faturanın dosyasına hiçbir yoldan dokunulmaz.
- Süren işi (`QUEUED`/`RUNNING`, `refType = 'File'`) olan dosya korunur.
- **Yol paylaşımı:** aynı `path`'i kullanan başka (temizlenmemiş) satır varsa satır işlenir ama disk dosyası kalır; son satır temizlenince diski de silinir.
- Disk yalnız firmanın klasöründe silinir (`<companyId>/…`); değilse satır işlenir, disk kalır, uyarı yazılır. Disk hatası turu düşürmez (yetim dosya kalır; `npm run storage:orphans` raporlar).
- Temizlenmiş (`purgedAt`) dosyadan fatura üretilmez (`POST /invoices` 404, işlem içinde yeniden denetlenir); içe aktarma ile temizlik aynı satır kilidinde sıraya girer.
- **Bakım aday listesi** `app.scope = 'maintenance'` ile salt okunur ve dardır (taze önizlemeyi ve canlı faturayı göstermez), tur başına en çok 500. Sınır korunan adaylarla (faturanın gösterdiği önizleme, süren işi olan dosya) dolarsa sonraki tur liste sırasında kalınan yerden sürer, liste bitince baştan başlar (süreç içi imleç). Silme firma bağlamında yapılır.
- Süreler kodda sabittir (`PREVIEW_FILE_TTL_MS` 24 sa, `DELETED_INVOICE_FILE_TTL_MS` 30 gün) ve göçteki aralıklarla aynıdır; test eşitliği sınar.

#### Silinenlerin kalıcı temizliği

Kullanıcı kararı; `services/deletedPurge.ts`, saatlik bakım `runDeletedPurge`.

- **Süreler:** `DELETED_INVOICE_PURGE_DAYS` ve `DELETED_MEASUREMENT_PHOTO_PURGE_DAYS` (gün).
- **Varsayılan kapalı:** boş, `off`/`false`/`no` ya da sıfır dizisi (`0`, `00`) kapatır. Canlıda `purge:preview` ile bakıp `30` yazmak zorunlu adımdır; kapalıyken API açılışta uyarı yazar.
- 7'den küçük değer 7 sayılır; başka değer açılışı durdurur (`env.ts` `parsePurgeDays`, `invalidEnv`; komut satırı aynı kural).
- Süre veritabanı saatinden (`now()`) ölçülür.
- İki değişken yalnız bu kalıcı silmeyi yönetir; yukarıdaki kaynak dosya temizliği (sabit 30 gün) ayrıdır ve hep açıktır. Silinen veri geri gelmez.

**Fatura:**
- Silinmesinden (`deletedAt`) N gün sonra fatura, satırları ve satır kararları, yeniden hesap işareti (`InvoiceRecheck`) ve yalnız ona ait kaynak dosya kayıtları (kaynak dosya ve `invoiceId`'si bu fatura olan `INVOICE_SOURCE` satırları) tek işlemde silinir; diskleri işlem kapandıktan sonra.
- **Silinmez:** canlı fatura; itiraz kaydı olan fatura (herhangi bir tur: etkin, geri çekilmiş, yerini bırakmış; ya da satırına bağlı itiraz satırı); dosyasında süren iş olan fatura (o tur atlanır).
- Başka bir faturanın (canlı ya da silinmiş) da gösterdiği kaynak dosyanın kaydı ve diski kalır.
- Silme denetim izine `invoice.purge` yazar (kullanıcısız; fatura no, satır sayısı, silinme anı); eski denetim kayıtlarına dokunulmaz.
- Başka faturaların "Mükerrer" sonucu değişmez: silinmiş fatura zaten hiçbir hesaba girmiyordu, silme anındaki yeniden hesap (`InvoiceRecheck`) çoktan bitmişti.

**Ölçüm fotoğrafı:** ölçüm kaydı (ölçü, ağırlık, zaman, not) silinmez, yalnız **silinmiş** ölçümün kendi fotoğraf `File` satırları ve diski. Koşullar:
1. Ölçüm zincirin son sürümü ve N günden uzun süredir silinmiş (geri yüklenen aday olmaktan çıkar; 30 gün dolduktan sonra geri yüklenen fotoğrafsız döner).
2. Zincirin (bütün sürümler) hiçbir sürümüne bağlı fatura satırında karar yok (`OPEN` dışı: "İtiraz listesinde" ya da "Uyumlu") ve itiraz satırı yok (faturası silinmiş olsa da).
3. Hiçbir itiraz satırı (herhangi bir tur, geri çekilmiş dahil) zincirin bir sürümünü gönderim anındaki kanıt olarak göstermiyor (`DisputeLine.measurementId`, gönderimde değişmez yazılır; göç `20261123100000_dispute_line_measurement` eskileri fatura satırının bağından doldurdu) ve zincirin bir takip no'sunu taşımıyor (karşılaştırmanın eşleşmesi gibi son 10 karakteri de: takip no ve ham barkoddan; bağı belirsiz eski satır dahil, kuşkuda silinmez).
4. Aynı yolu gösteren başka her temizlenmemiş satır aynı zincirin fotoğraf satırı (fotoğraf olmayan kayıt ya da başka ölçüm gösteriyorsa satır kalır).

- **Eski sürümlerin fotoğraf satırları silinmez** (ayrı karar): onlarla paylaşılan yolun diski kalır. Ölçüme bağlanmamış fotoğraf satırı silinmez.
- Kural tek SQL'dedir (aday listesi, kuru çalışma ve kilit altındaki denetim aynı sorgu).

**Düzenek:**
- Firma listesi bakım kapsamında (yalnız `Company`) okunur; adaylar her firmanın kendi bağlamında aranır (bakım kapsamı genişletilmez).
- Turda önce fotoğraf adayları alınır, sonra faturalar silinir, sonra alınan fotoğraflar: fatura silinince kalkan koruma bir sonraki tura kalır, kuru çalışma gerçek turla aynı kümeyi sayar.
- Tur başına en çok 100 fatura ve 500 fotoğraf. İmleç yalnız sınırın dolduğu firmada yazılır, sonraki tur ondan sonrakinden başlar; düşen adaylar süreç içinde firmasının listesinin sonuna alınır.
- Her aday kendi işleminde: satırlar kilitlenir (fatura; fotoğrafta dosya, ölçüm ve bağlı fatura satırları), kural kilit altında yeniden sınanır, satırlar silinir, işlem kapanır; disk dosyaları (son satırsa ve firmanın klasöründeyse) ancak sonra silinir.
- Disk hatası yetim dosya bırakır (`storage:orphans` raporlar), veri tutarlı kalır.

**Kuru çalışma:** `npm run purge:preview -- [--invoice-days <n|off>] [--photo-days <n|off>] [--company <id>] [--json]` (kapta `node dist/cli/purgePreview.js`): firma başına aday fatura, itiraz kaydı yüzünden korunan silinmiş fatura, aday fotoğraf ve boyutu. Salt okunur işlemde çalışır, hiçbir şey silmez. Değişken boşken kararın 30 günüyle sayar.

**Bilinen sınır:** koruma kalkınca (ör. satırın kararı `OPEN`'a döner, ölçüm 30 günden uzun süredir silinmiş) fotoğraf bir sonraki turda gider; ek bekleme yok.

**Elle kalıcı silme** (kullanıcı kararı): silinmiş ölçüm, süre beklemeden kaydı, bütün eski sürümleri ve fotoğraflarıyla kalıcı silinebilir (§10.1, `services/measurementPurge.ts`). Koruma yukarıdaki (2) ve (3) ile aynı SQL'dir (`deletedPurge.ts` `chainProtectedSql`); korunan ölçüm silinmez (409 `MEASUREMENT_PROTECTED`). Kayıt bütün olarak gittiği için (4) yerine: zincirin bütün dosya satırları silinir, disk yalnız onu gösteren başka satır kalmadıysa.

#### Dosya yazımı

`lib/storage.ts` `storeBuffer`.

- Dosya önce aynı klasörde `<ad>.tmp`'ye yazılır, diske işlenir (`fsync`), sonra son adına taşınır; yazma düşerse geçici dosya silinir.
- Disk doluysa (`ENOSPC`, `EDQUOT`) 507 `STORAGE_FULL` ("Sunucuda dosya kaydedecek yer kalmadı…", TR+EN), günlükte hata düzeyi.
- Fatura önizlemesi, kurulum örnek faturası (iki yol), tarife PDF'i: dosyanın kaydı yazılamazsa saklanan dosya silinir (`discardStored`). Ölçüm fotoğraflarında da aynı: kayıt ya da düzeltme yazılamazsa o istekte yazılan fotoğraflar silinir (`routes/measurements.ts`).

#### Dosya alanı kotası

`services/storageQuota.ts`; `STORAGE_QUOTA_GB_PER_ORG`, varsayılan 10, `0` kapalı; 1 GB = 1024³ bayt.

- Fatura önizlemesi, kurulum örnek faturası ve tarife PDF'i yükleme başında, dosya okunmadan ve saklanmadan denetlenir. Kullanılan + gelen dosya kotayı aşarsa 413 `STORAGE_QUOTA_EXCEEDED` (`details.limitGb`, metin isteğin dilinde).
- **Kullanım ucu** (ekranı yok): `GET /platform/storage-usage` (`settings` izni) → `{ usedBytes, limitBytes, limitGb, usedPct, warn }`; `warn` %80 ve üstünde; kota kapalıysa sınır alanları `null`, `warn: false`.
- **Sayılan:** diskte duran fatura kaynak dosyaları (önizleme ya da canlı faturanın dosyası) ve tarife PDF'leri (`TariffDocument`).
- **Sayılmayan:** yalnız silinmiş faturaların gösterdiği dosya, temizlenmiş dosya, ölçüm fotoğrafı (ölçüm hiç durmaz). Excel/CSV tarifesi dosya olarak saklanmaz.
- Toplam her yüklemede veritabanında `SUM(size)`. Sınır yumuşaktır: aynı anda gelen yüklemeler ikisi de geçebilir, aşım en çok o anda süren yüklemeler kadar.
- Panel: fatura yüklemede "Dosya alanı dolu." + sunucu metni, yeniden dene düğmesi yok; tarife içe aktarmada aynı başlık.

#### Sürdürme bandı

- `GET /invoices/preview/resumable` (yükleme izni) → `{ items: [{ fileId, name, size, jobId, status: 'reading' | 'ready', updatedAt }] }`.
  - Kapsam: isteği yapan üyenin tuttuğu (yükleyen ya da `holders`), faturaya bağlanmamış, 24 saat içinde dokunulmuş PDF önizlemeleri; dosyanın son okuma işi `SUCCEEDED` (`ready`) ya da `QUEUED`/`RUNNING` (`reading`); en çok 5, en yenisi önce.
- Panel fatura yüklemenin 1. adımında, sayfada dosya seçilmemişken en yenisini bilgi bandında gösterir: "Okunan PDF hazır: dosya.pdf · Devam et" (okuma sürerken "PDF okunuyor", eylemsiz, 5 sn'de bir yoklar).
- "Devam et" (taşıyıcı seçiliyken) sonucu `GET /jobs/:jobId`'den alır, `keep` ile tazeler ve önizleme akışına geçer; bundan sonra dosya o sayfanın önizlemesidir (vazgeçme kuralı aynı). "Kaldır" `DELETE /invoices/preview/:fileId`.
- Sayfadan okuma bitmeden çıkılırsa dosya silinmez (iş sürer); okunmuş ve uygulanmış önizlemeden çıkılırsa silinir (bant onu göstermez).

#### Tazeleme

`POST /invoices/preview/:fileId/keep` (yükleme izni, hız sınırı `write`) → 204. Üyenin tuttuğu, faturaya bağlanmamış, temizlenmemiş önizleme yoksa 404 `invoice.uploadNotFound`. Yalnız `updatedAt` yazar. Bakım silmesi kilit altında `updatedAt`'i yeniden denetler: önce tazeleme biterse dosya kalır.

#### Kurulum örnek PDF'i

- Panel PDF'i `POST /invoices/preview?async=1` ile arka planda okutur, iş bitene dek yoklar, sonra `POST /invoices/samples` JSON `{ fileId, carrierId }` gönderir.
- Satırlar ve tahmin edilen başlık işin sunucuda yazdığı sonuçtan (`Job.result.aiLines`, `guessedMeta`) gelir, istemciden değil. Dosya yeniden saklanmaz; önizleme satırı kilitlenip (`FOR UPDATE`) örnek faturaya bağlanır.
- 404 `invoice.uploadNotFound`: üyenin tuttuğu okunmuş PDF önizlemesi yok (okuma bitmemiş, başkasının, silinmiş, zaten bağlanmış). 409 `PREVIEW_SHARED`: aynı PDF başka üyenin de önizlemesi.
- Çok parçalı (multipart) yol da açık: CSV/XLSX ve PDF'i istek içinde okur.

#### Yetim dosya raporu

`npm run storage:orphans -- [--min-age-hours <n>] [--json]` (kapta `node dist/cli/storageOrphans.js`). **Hiçbir şey silmez.** Haftada bir elle ya da zamanlanmış görevle çalıştırılır.

- `STORAGE_DIR` altındaki her firma klasörünü (`<companyId>/…`) o firmanın bağlamında `File.path` ve `TariffDocument.path` ile karşılaştırır: `ORPHAN` hiçbir kayıt göstermiyor, `PURGED` yalnız temizlenmiş satır gösteriyor (disk silinemedi).
- `--min-age-hours`'tan (varsayılan 1) yeni kayıtsız dosya sayılır, listelenmez (yükleme sürüyor olabilir).
- Firma klasörü olmayan üst klasörler (`fx`) taranmaz; sembolik bağlantı izlenmez.
- **Ters yön:** veritabanındaki her firmanın (bakım kapsamıyla) ve her disk klasörünün temizlenmemiş `File` ve `TariffDocument` kayıtları sayfa sayfa okunur; dosyası diskte olmayan `MISSING` satırıyla (kaynak, kimlik, tür, bağlı fatura/ölçüm) ve özette `missing=<n>` ile yazılır (yedekten geri yüklemeden sonra çalıştırılır).

**Bilinen dar yarış:** yükleyen tam bağlanma anında vazgeçerse bağlanan üye sonra 404 görür.
