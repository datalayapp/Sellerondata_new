# DeciShip SPEC — Arka plan işleri (§5.13)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

### 5.13 Arka plan işleri ve dosya temizliği

Bu dosya iş kuyruğunu, ölçüm ve mükerrer yeniden hesabını anlatır; dosya temizliği, dosya alanı kotası, sürdürme bandı ve yetim dosya raporu [dosya-temizligi.md](dosya-temizligi.md) içindedir. Kararlar `Platform/docs/KARARLAR.md`, ortam değişkenleri `Platform/docs/KURULUM.md`, ölçek notu `Platform/docs/ARCHITECTURE.md` §11.

Tarife sayfasında "Tarife PDF'i okunuyor" bandı yok: tarama penceresi yeniden açılınca süren işe bağlanır.

#### İş türleri

`services/jobs/registry.ts`; kuyruk Postgres'te, tablo `Job`, RLS'li.

| Tür | Grup | Tekillik anahtarı (firma içinde) | İzin |
|---|---|---|---|
| `INVOICE_PDF_READ` (PDF fatura okuma + metin denetimi) | `ai` | `pdf:<sha256>:<dil>` | `invoices.upload` |
| `TARIFF_PDF_SCAN` (tarife PDF'inde yapay zekâ taraması) | `ai` | `scan-ai:<belge>:<dil>` | `tariffs.edit` |
| `TARIFF_PDF_EXTRACT` (fiyat okuma) | `ai` | `extract:<belge>:<gövde özeti>:<dil>` | `tariffs.edit` |
| `BULK_RECOMPARE_PREVIEW` / `BULK_RECOMPARE_APPLY` (eski faturaları yeni tarifeye ya da ayara geçirme, §3.14) | `recalc` | önizleme: `tariff:<id>:<sürüm>` ya da `settings:<ayar özeti>`; uygulama: `tariff:<id>` ya da `settings` | tarife kapsamında `tariffs.edit`, ayar kapsamında `settings.manage` |
| `INVOICE_IMPORT` (büyük CSV/Excel fatura içe aktarma) | `recalc` | `import:<dosya>` | `invoices.upload` |
| `TARIFF_IMPORT_REVIEW` (tarife içe aktarmanın yapay zekâ incelemesi) | `ai` | `review:<taslak>:<seçenek özeti>:<dil>` | `tariffs.edit` |

- **Tekillik:** `(companyId, kind, dedupeKey)` yalnız `QUEUED` ve `RUNNING` işlerde tekildir (kısmi dizin `Job_active_key`). İkinci istek yeni iş açmaz, süren işe bağlanır (`joined: true`). Bitince aynı anahtarla yenisi başlayabilir. `?fresh=1` anahtara `:fresh` ekler.
- **Konu:** `refType`/`refId` (`File`, `TariffDocument`, `Tariff`, `Company`, `TariffImportDraft`); `label` ekranda gösterilen ad. Girdi `input` içinde (`v`, `locale`, `aiLimits`, `fresh`, türe özgü); iş başlatanın dilinde çalışır. Firma her zaman satırın `companyId` sütunundan alınır.
- **Durumlar:** `QUEUED` → `RUNNING` → `SUCCEEDED` | `FAILED` | `CANCELLED`. Bitmiş durum değişmez. İş kayıtları 7 gün saklanır (`JOB_RETENTION_MS`, bakım siler).

#### Çalıştırıcı

`services/jobs/runner.ts`, DeciShip API sürecinin içinde; `main.ts` başlatır (`startJobRunner`), `buildApp` başlatmaz.

- **`JOB_RUNNER`:** `on` (varsayılan) bu süreç iş alır; `off` almaz, yalnız kuyruğa yazar, HTTP sürecinde saatlik bakımı da kapatır; işleri ve bakımı ayrı iş çalıştırıcı `node dist/worker.js` (`src/worker.ts`, kendi `JOB_RUNNER`'ını yok sayar, hep iş alır) çalıştırır; `inline` işi başlatan istek sonuna kadar çalıştırır (testlerde varsayılan; üretimde açılış reddedilir).
- **Yuvalar:** grup başına sunucuda `ai` 2, `recalc` 1 (`JOB_SLOTS_AI`, `JOB_SLOTS_RECALC`). Firma başına ve grup başına aynı anda en çok 1 iş; sıradakiler "Sırada" bekler (iki kopya arasında yumuşak sınır).
- **Adil paylaşım:** aynı gruptan başka firmanın işi bekliyorsa toplu uygulama bir çalıştırmada en çok `JOB_FAIR_SLICE_MS` (60 sn) sürer, sonra fatura arasında yuvayı bırakır ve kaldığı yerden sürer.
  - Bırakma `JobYield`: `QUEUED`, `runAfter` şimdi, deneme hakkı geri verilir; bekleyen iş önce alınır.
  - Her çalıştırma en az bir fatura ilerler, her fatura en çok bir kez yazılır.
  - Önizleme ve yapay zekâ işleri bırakmaz (kaldığı yerden sürmez).
- **Sahiplenme** `FOR UPDATE SKIP LOCKED` ile tek ifade, `app.scope = 'jobs'` kapsamında. Bu kapsam yalnız `QUEUED`/`RUNNING` satırı görür ve güncelleyebilir, işi bitmiş duruma geçiremez (bitiş firma bağlamında yazılır).
- **Kira, devralma, deneme hakkı:** kira 60 sn (`JOB_LEASE_MS`), kalp atışı her 15 sn. Her sahiplenme belirteçli ve bir deneme sayılır (en çok `JOB_MAX_ATTEMPTS` 5). Kira dolunca (süreç öldü) başka çalıştırıcı ya da yeniden başlayan süreç devralır ve işi kaldığı yerden sürer. Kirayı kaybeden çalıştırıcı sonuç yazamaz (her yazım belirteç ve `RUNNING` ister). Deneme hakkı biterse `FAILED` / `JOB_ABANDONED`.
- **Süre sınırı:** bir denemenin en uzun süresi grup başına: `ai` 30 dk (3 × `AI_CALL_MAX_MS`), `recalc` 2 saat. Aşılınca işleyici bırakılır, iş `JOB_TIMEOUT` ile geçici hata gibi kuyruğa döner (hak bittiyse `JOB_ABANDONED`). Takılan iş kirayı süresiz tutamaz.
- **Kapanış:** yeni iş alınmaz, süren işe `JOB_SHUTDOWN_GRACE_MS` (30 sn) tanınır; bitmeyenin kirası bırakılıp `QUEUED`'a döndürülür ve deneme hakkı geri verilir. İş başına en çok 2 kez geri verilir (sonsuz döngü olmasın).
  - Sayaç `Job.releases` sütunundadır; hata yazımı sıfırlamaz.
  - Kademeli yayın için önceki sürümün yeri de korunur: okuma `releases` ile `error` içindeki eski sayacın (`code: 'JOB_RELEASED'`, `details.releases`) büyüğünü alır, yazım ikisine birden yapılır.
  - Compose `stop_grace_period: 45s`.
- **Durdurma:** yalnız işi başlatan üye ya da `settings.manage`; diğerleri 404 alır (görme izni yetmez).
  - Kuyruktaki iş hemen `CANCELLED` olur. Çalışan işte `cancelRequestedAt` yazılır, işleyici adım arasında görür (en geç 15 sn).
  - **Süren yapay zekâ çağrısı kesilmez**: bitene dek sürer (ücret zaten doğmuştur), sonucu önbelleğe girer, sonra iş durur.
  - İstekten 30 sn sonra işleyici hâlâ dönmediyse iş yine `CANCELLED` yazılır (işleyici arkada bitebilir, satıra yazamaz).
  - PDF okumada durdurma önizleme dosyasını da siler.

#### Hata ve yeniden deneme

- **Kalıcı hata:** `AppError` (`AI_REFUSED`, `AI_TRUNCATED`, `AI_FAILED`, `AI_QUOTA_EXCEEDED`, `AI_DISABLED`, `PREVIEW_STALE`, `SCAN_CHANGED`, doğrulama) → `FAILED`, `error = { statusCode, code, message, details }`, mesaj işin dilinde.
- **Ücret doğmuş yapay zekâ hatası kendiliğinden yeniden denenmez** (kesilme, ret, bozuk biçim, toplam süre dolması, akış başladıktan sonra kopma; her deneme ücretli); kullanıcı yeniden başlatır.
- **Geçici hata** (veritabanı bağlantısı, `FILE_BUSY`, firma yapay zekâ yuvası dolu 429) → `QUEUED`, `runAfter = şimdi + max(10 sn × deneme, retryAfter)`, deneme hakkından düşer. Hak bitince `JOB_ABANDONED`.
- **Sağlayıcının ücretsiz geçici hatası** (`AiTransientError`, `services/ai.ts`) da geçicidir:
  - Kapsam: aşırı yük 529 ve sağlayıcı 429 → 503 `AI_BUSY`; ulaşılamadı → 503 `AI_FAILED`; bağlantı zaman aşımı → 504 `AI_FAILED`; sağlayıcının sunucu hatası 5xx → 502 `AI_FAILED`; akış içi `event: error` olayında aşırı yük → 503 `AI_BUSY`, `api_error` → 502 `AI_FAILED`; sayaç sigortası 503 `AI_BUSY`.
  - Bekleme denemeyle artar: 30 sn, 2 dk, 5 dk, 10 dk, her biri ±%20 rastgele (`AI_RETRY_DELAYS_MS`, `AI_RETRY_JITTER`); sağlayıcının `retry-after` değeri daha uzunsa o, en çok 15 dk.
  - İş bu sürede `QUEUED`, `attempt > 1` görünür; temizlik kancası çalışmaz, PDF önizleme dosyası durur.
  - Deneme hakkı (`JOB_MAX_ATTEMPTS` 5) bitince iş son hatanın kendisiyle `FAILED` olur (`JOB_ABANDONED` değil; diğer geçici hatalar `JOB_ABANDONED`).
  - Bu hata ücret doğurmaz (yanıt gelmedi). Akış başlayıp kullanım > 0 iken koparsa sayaç işareti kaldırır, hata kalıcıdır.
- **Bilinmeyen hata** → `FAILED` / `INTERNAL` (500), günlüğe yazılır.

#### Çift ücret olmaz

- Başlatma ucu önce kotayı ve kişi başı dakika sınırını denetler (kota doluyken önbellekteki sonuç bile iş açmadan 429 `AI_QUOTA_EXCEEDED` alır). İş içinde dakika sınırı atlanır (`origin: 'job'`), firma yuvası ve kota geçerli kalır.
- `AiUsage` (`OK`) satırı ile `AiResultCache` satırı **tek işlemde** yazılır (ya ikisi ya hiçbiri).
- Yeniden başlayan deneme önbellekten alır (`CACHED`, ücret 0). Sağlayıcının geçici hatasından sonraki yeniden deneme de: gruplu okumada ödenmiş gruplar `CACHED`, yalnız düşen grup yeniden çağrılır; işte kesilmiş tek çağrı (ikiye bölünmeye yol açan) yeniden gönderilmez (`test/aiTransient.test.ts`).
- "Yeniden oku" (`fresh`) işin kendi sonucunu kullanır, işten önceki eski sonucu kullanmaz (`cacheNotBefore = Job.createdAt`, veritabanı saati).
- Bilinen açık: çağrı sürerken süreç ölürse sayaç satırı hiç yazılmamıştır ve yeni deneme bir kez ücretlenir; sağlayıcı maliyetini biz taşırız.

#### Türe özgü kurallar

- **`TARIFF_PDF_EXTRACT`:** girdiye seçimin dayandığı taramaların `scannedAt` değerleri yazılır ve anahtara girer; çalışırken belge yeniden taranmışsa iş 409 `SCAN_CHANGED` ile `FAILED` (taslak oluşmaz, çağrı yapılmaz).
- **`INVOICE_PDF_READ`:**
  - Sayfa metni istek içinde, dosya saklanmadan önce okunur (413/422/503 hemen döner) ve `File.preview.pageTexts`'e yazılır (1 MB'ı aşarsa yazılmaz, içe aktarma dosyadan okur). Fatura yazılınca aynı işlemde silinir (PDF dosyası ve kaydın öbür alanları kalır); faturaya bağlanmış dosyaya okuma bir daha yazmaz.
  - İş yapay zekâ okumasını ve metin denetimini (§3.15) yapar. Sonuç = önizleme yanıtı. İçe aktarma PDF'i ikinci kez okumaz.
  - Okunan takip no'suz satırlar `File.preview.skipped`'te durur (sunucu yeniden başlasa da içe aktarma raporuna yazılır); alan yoksa `NO_TRACKING` yazılmaz.
  - Sonuçta `pdfTotals` (satır toplamı ve fatura toplamı, §3.15). Toplam öbür KDV kipine eşitse `File.preview.review.vatUnclear` yazılır ve içe aktarma bütün satırlara `PDF_VAT_UNCLEAR` koyar.
  - İşin `aiLines`'ı içe aktarmada gönderilen satırlarla karşılaştırılır (denetim kaydı `pdfEdits`).
  - İstem işin girdisine (dosya, dil) bağlıdır; yeniden deneme aynı anahtarı bulur. İstem ya da şema değişince `INVOICE_PDF` önbelleği bir kez ıskalanır.

#### Büyük PDF fatura

`services/invoicePdfRead.ts`.

- **Gruplama:** sayfa sayısı `PDF_INVOICE_PAGES_PER_CALL`'dan (varsayılan 5) büyükse belge o boyda sayfa gruplarına kesilir (pdf-lib, dosya çalışanında) ve her grup ayrı belge olarak okunur; girdi ücreti yalnız grubun sayfalarıdır.
  - Eşik ve altı tek çağrıyla okunur (istem ve önbellek anahtarı aynı). Tek çağrı kesilirse (`AI_TRUNCATED`) ve belge en az 2 sayfaysa iki yarıyla gruplu yola geçilir.
- **Kesilmeyen belge** (her zaman tek çağrı): sayfa sayısı bilinmiyor; pdf-lib açamıyor ya da sayfa sayısı tutmuyor; belge şifreli (yalnız sahip parolalı da: pdf-lib içeriği çözmeden kopyalar, parçalar boş giderdi); ya da metni olan sayfa kesildikten sonra metinsiz kalıyor (ilk parça dosya çalışanıyla denetlenir).
  - Taranmış (metinsiz) belgede bu denetim yapılamaz: okuma sürer, `review.sliceUnchecked` (önizleme uyarısı `invoice.pdfSliceUnchecked`).
- İstek içi eşzamanlı yolda kişi başı dakika sınırı belge başına bir kez sayılır, gruplar yeniden saymaz.
- **Ölçüm ve önbellek:** her grup ayrı ölçülür ve ayrı önbelleğe girer (anahtar: kaynak dosyanın sha256'sı + sayfa listesi). Yeniden deneme, devralma ve aynı dosyanın yeniden yüklenmesi okunmuş grupları ücretsiz alır (`CACHED`). Kesilen grup ikiye bölünür; tek sayfa da kesilirse 422 `AI_TRUNCATED`.
- **Birleştirme:**
  - Satırlar sayfa sırasıyla eklenir; tekilleştirme ve kendiliğinden birleştirme yok (gruplar örtüşmez; birebir aynı iki satır gerçekten iki kez basılmıştır, "Mükerrer" çıkar). Devreden/ara toplam satırları istemde dışlanır.
  - Şüphe sessiz seçilmez: satıra sert bayrak olur ("İncele") ve önizlemede `warning` + `pdfReview` ile söylenir.
  - KDV: grup "KDV dahil" bayrağını `true`/`false`/`null` (bu sayfalarda yazmıyor) döner, yalnız açık oylar sayılır; çelişki ya da hiç açık oy yoksa bütün satırlar `PDF_VAT_UNCLEAR`.
  - Sonraki grubun ilk satırı takip no'suzsa ya da önceki grubun son satırıyla aynı takip no'yu taşıyorsa iki satır `PDF_PAGE_BREAK` (takip no'suz satır faturaya alınmaz, takip no'suz satır sayılır).
  - Fatura no, tarih, para birimi 1. sayfanın grubundan (yoksa ilk dolu); gruplar arasında çelişirse uyarı.
  - Bayraklar içe aktarmada sunucunun kaydından (`File.preview.review`) konur. Metin denetimi (§3.15) birleşik sonuç üzerindedir.
- **Durdurma** süren grubun yapay zekâ çağrısını sağlayıcıda keser (kesilen grup `FAILED` `AI_CANCELLED`, sonucu yok; okunmuş gruplar önbellekte kalır). Kapanış, kira kaybı ve süre aşımı çağrıyı kesmez. Kota ortada dolarsa iş `FAILED` `AI_QUOTA_EXCEEDED`, okunmuş gruplar önbellekte kalır.
- **İlerleme** sayfa cinsinden: aşama `pdfPages`, `done` / `total` okunmuş / toplam sayfa, okunan grup `counters.from`–`counters.to` (panel: "Sayfa 6–10 / 12").
- Kurulum örnek faturası da aynı okuma işlevini kullanır.

#### Uçlar

`routes/jobs.ts` ve ilgili uçlar.

- `GET /jobs/:jobId` → `JobView`. 404 `NOT_FOUND`: iş yok, başka firmanın ya da türün izni yok (üçü ayırt edilmez).
- `GET /jobs?active=1&kind=&refType=&refId=&mine=1` → `{ items }` (en çok 20, yalnız izinli türler, `result` yok).
- `POST /jobs/:jobId/cancel` → `JobView`; 409 `JOB_FINISHED`, 409 `JOB_NOT_CANCELLABLE`; hız sınırı `write`.
- **Uzun işler yalnız arka planda:** `POST /invoices/preview` (yalnız PDF dalı), `POST /tariff-documents/:id/scan` (`mode: 'ai'`), `POST /tariff-documents/:id/extract`, `POST /tariff-imports/:draftId/review`, `POST /tariffs/:id/recompare-invoices[/preview]`, `POST /settings/recompare-invoices[/preview]` ve büyük CSV/Excel'de `POST /invoices` `?async=1` ile → **202** `{ job, joined }`.
  - `async` olmadan → 400 `ASYNC_REQUIRED` (`services/jobs/queue.ts` `requireAsync`): iş açılmaz, dosya saklanmaz, yapay zekâ çağrılmaz, yazım yok. İzin, sahiplik (404), gövde ve seçim denetimleri (400) ve yapay zekâ anahtarı yokluğu (503 `AI_DISABLED`) ondan önce döner.
  - Eşzamanlı kalanlar: CSV/XLSX önizleme ve `mode: 'code'` tarama (200); PDF ve eşiği aşmayan CSV/Excel içe aktarma (`POST /invoices`, 201).
  - Geriye uyum için tutulan eşzamanlı uç yok (Y83, KALANLAR 6.18): bütün güncel istemciler (panel; mobil bu uçları kullanmaz) `?async=1` gönderir.
  - Başlatırken 429 `AI_QUOTA_EXCEEDED` / `TOO_MANY_REQUESTS` olabilir.
- Toplu uygulamada aynı kapsamda aynı `token` ile süren uygulama varsa `joined: true`; farklı `token` → 409 `JOB_ACTIVE` (`details.job`). İşteki bayat özet `job.error.code = 'PREVIEW_STALE'` (409). Önizleme işi bugünkü sürüm/ayar özetini anahtara katar (eski önizlemeye bağlanmaz).
- Tarife PDF işleri yalnız `GET /jobs/:jobId` ile, türün izniyle (`tariffs.edit`) okunur; `GET /tariff-documents/:documentId/jobs/:jobId` diye bir uç yok.

**`JobView`** (`services/jobs/types.ts`; panel `src/api/types.ts` ile elle eş):
- `id`, `kind`, `status`, `label`, `ref`, `createdAt`, `startedAt`, `finishedAt`, `elapsedMs`.
- `progress { done, total | null, stage | null }`; aşama: `pdfRead`, `pdfPages`, `pdfCheck`, `tariffScan`, `tariffExtract`, `bulkCheck`, `bulkWrite`, `importRead`, `importCompare`, `importWrite`, `tariffReview`.
- `counters?`: yalnız sayısal (toplu uygulamada `{ invoices, lines, inDispute, stale }`; biten işte de okunur).
- `params?`: yalnız türün beyaz listesi (ör. tarife okumada seçim).
- `attempt` (> 1 ise "kaldığı yerden sürüyor"), `cancellable` (isteği yapana göre), `cancelRequested`.
- `result?`: yalnız `SUCCEEDED` ve bölüm sonucuyla `CANCELLED`; listede yok. İçindeki para alanları fiyat iznine tabidir (`prices.view` olmayana gitmez).
- `error?`: yalnız `FAILED`.

#### Büyük CSV/Excel içe aktarma işi

`routes/invoices.ts` (`startLargeImport`, `runInvoiceImport`), `handlers/invoiceImport.ts`. KALANLAR 6.18.

- **Eşik:** dosyanın veri satırı (başlık hariç) `INVOICE_IMPORT_QUEUE_ROWS`'u (varsayılan 5.000) aşarsa iş; eşik ve altı istek içinde 201. PDF fatura (en çok 5.000 satır) hep istek içinde.
  - Hemen düşecek istek (taşıyıcı ya da dosya yok, eşleme eksik, fatura no kullanılıyor, tarife seçimi hatalı) iş açmadan bugünkü hatayı verir.
  - Eşiğin üstünde `async` yoksa 400 `ASYNC_REQUIRED` (eski sayfa sessizce iş başlatmaz).
- **Aynı işlev:** iş, istekle aynı `runInvoiceImport`'u çalıştırır: aynı denetimler, karşılaştırma ve tek işlemli yazım; aynı dosya ve gövde aynı faturayı aynı rakamlarla yazar (`test/invoiceImportJob.test.ts` satır satır karşılaştırır).
- **Sonuç:** bugünkü 201 gövdesi `{ invoice, errors, importReport }`; `invoice.fileUrl` yok (imzalı bağlantı okuyana göre üretilir), `errors` en çok 200 (tamamı `importReport`'ta sayılır). Tutarlar fiyat izni olmayana gitmez.
- **Kapı hataları işin hatasıdır:** 409 `MAPPING_UNVERIFIED`, `INVOICE_OVERLAP`, `WEIGHT_FORMAT_REQUIRED`, `INVOICE_EXISTS`, 400 `TRACKING_SCIENTIFIC` → `FAILED`, `error` aynı kod, ileti ve ayrıntı; hiçbir şey yazılmaz. Kullanıcı onaylayıp yeniden başlatır (yeni iş).
- **Tek iş:** anahtar dosya başına; süren işe aynı gövdeyle (gövde özeti `input.digest`) bağlanılır, başka gövdeyle 409 `JOB_ACTIVE` (`details.job`).
- **Kayıtlı eşleme** (`saveMapping`) başlatanın başlatma anındaki iznine göre (`input.mayRemember`).
- **Başlatan:** iş başlarken başlatanın yerel üye kaydı etkin ve `invoices.upload` izinli olmalı (`services/jobs/starter.ts`); değilse 403 `JOB_STARTER_FORBIDDEN` ("İşi başlatan kişinin yetkisi kalmadı; yeniden başlatın."), yazım yok. Aboneliğin salt okunurluğu yerelde tutulmaz: yalnız başlatma ucu denetler.
- **Durdurma:** adım arasında (okuma, karşılaştırma, yazım öncesi); yazım işleminin sonunda işin satırı çitle kilitlenir ve durdurma isteği yeniden okunur, istenmişse işlem geri alınır (fatura yazılmaz).
  - Fatura yazıldıktan sonra durdurma işi durdurmaz (`registry.ts` `committed`, `JobContext.markCommitted`): `POST /jobs/:id/cancel` 409 `JOB_NOT_CANCELLABLE`; daha önce gelmiş istek de sinyali kesmez, zorla durdurma yazılmaz; iş `SUCCEEDED`, panel faturayı açar.
- **Tek yazım:** fatura kimliği yazımla aynı işlemde işin kaydına (`checkpoint`: fatura, satır hataları, tazelemenin nedeni, `settled`) çitle yazılır; `invoice.import` (ve `invoice.importUnverified`) denetim kaydı da aynı işlemdedir (satır içi yolda da). Kirayı kaybeden çalıştırıcının yazımı geri alınır.
  - Yazımdan sonra iş yeniden denenirse (kapanış, geçici hata, süre sınırı, süreç ölümü) fatura ikinci kez yazılmaz. Yazım sonrası tazeleme (`settleImportRecompare`: sabit dayanak, açık satırlar) bitmediyse (`settled` yok) yeniden çalıştırılır (güvenli), sonra kayıtlı faturanın sonucu döner.
  - Ölçüm işaretleri yazımla aynı işlemde kalıcıdır; sıraya alınmaları kaldıysa tarama tamamlar.
- Süre sınırı 30 dk (`maxRunMs`); grup `recalc` (firma başına bir iş, toplu hesapla aynı sıra). Kaldığı yerden sürmez, yuva bırakmaz.
- **Panel:** 3. adımda bekleme notunun yerinde ortak ilerleme görünümü (`JobProgress`: aşama, süre, "Durdur"); işin hatası eşzamanlı yanıtın hatası gibi ele alınır (onay pencereleri aynı açılır), durdurulan iş ekranı içe aktarmadan önceki hâline döndürür; reddedilen durdurmada (fatura yazılmış) yoklama sürer ve fatura açılır. Tek yoklama hatası beklemeyi bitirmez: 5xx ve ağ hatasında geri çekilerek 5 kez yeniden denenir, 4xx hemen biter (`lib/waitJob.ts`).

#### Tarife incelemesi işi

`routes/tariffs.ts` (`runTariffReview`), `handlers/tariffReview.ts`. KALANLAR 6.18.

- İş dışında inceleme önbelleğe girmez (her istek yeni, ücretli iş). İşte çağrı işe özgü önbellekle yapılır (anahtarda iş kimliği): kira kaybı, kapanış ya da süreç ölümünden sonraki deneme ödenmiş sonucu ücretsiz alır (`CACHED`). Taslağa (`aiReview`) işin kimliğiyle yazılır; yazılmışsa yeniden deneme sağlayıcıya hiç gitmez.
- Başlarken başlatan etkin ve `tariffs.edit` izinli olmalı (`starter.ts`), değilse 403 `JOB_STARTER_FORBIDDEN` ve çağrı yok. İnceleme sürerken taslak uygulanıp silindiyse iş 404 (`tariff.draftNotFound`).
- Sonuç bugünkü inceleme yanıtı; uygulama (`apply`) incelemeyi taslaktan okur (seçenek özeti tutmalı).
- Durdurma süren çağrıyı keser (`jobCancelSignal`); çağrı bittikten sonra gelen durdurmada inceleme taslakta kalır, iş `CANCELLED`.
- **Panel:** inceleme kutusunda ortak ilerleme görünümü ("Durdur" ile vazgeçilir, kutu ilk hâline döner).

#### Toplu yeniden hesap işi

`services/bulkRecalc.ts` kancaları, `handlers/bulkRecompare.ts`.

- **Yazım** yalnız `applyRecompare` üzerinden, §3.14 kurallarıyla: bayat fatura ve etkin itirazlı fatura atlanır, tarife geçişi yalnız tarifeyi, ayar geçişi yalnız ayarı değiştirir, para birimine göre toplam ayrı.
- **Önizleme işi** planın tamamını (fatura kimliği + faturanın kendi özeti, itirazda atlananlar, dayanak anahtarı) kendi `Job.checkpoint`'ine yazar (dışarı verilmez; dayanak önizleme sürerken değiştiyse yazmaz).
- **Uygulamanın ilk denemesi** bu planı aynı `token`'lı başarılı önizleme işinden okur (genel özet yalnız planın bütünlüğü için denetlenir, yeniden hesap yok).
  - Aranan satır SQL'de süzülür: aynı `token`, bugünkü dayanak anahtarı, henüz kullanılmamış (`checkpoint.appliedBy` boş ya da bu iş).
  - Plan kaydıyla aynı işlemde aynı `token`'lı bütün önizleme satırlarına `appliedBy` = bu iş yazılır: bir önizleme bir kez uygulanır; aynı durumun yeni önizlemesi (yeni satır) her zaman uygulanabilir (hiç yazmadan durdurulan uygulamadan sonra da).
  - Aynı `token`'lı önizleme var ama bu koşulları tutmuyorsa (dayanak değişti, önizleme kullanıldı) hiçbir şey yazılmaz (`FAILED`, `PREVIEW_STALE`).
  - Plan bulunamazsa (temizlenmiş iş) kapsam yeniden hesaplanır (`bulkCheck`, n / N) ve özet `token` tutmuyorsa hiçbir şey yazılmaz.
- Sonra plan uygulama işinin `Job.checkpoint`'ine bir kez yazılır, sonra her fatura kendi kısa işleminde yazılır (`bulkWrite`, n / M).
- **Her fatura en çok bir kez yazılır:** ilerleme ve sahiplik denetimi fatura yazımıyla aynı işlemdedir; kirayı kaybeden çalıştırıcının fatura yazımı geri alınır.
- **Kaldığı yerden sürme:** genel özet yeniden denetlenmez (kullanıcı planı onayladı), ama her fatura yine kendi özetiyle korunur: bu arada değişen `stale`, itiraza giren `inDispute` olarak atlanır; önizlemeden sonra kapsama giren fatura taşınmaz.
  - Atlanan `stale` faturaların kimlikleri (en çok 200) uygulama işinin `checkpoint.stale`'inde, ilerleme ve sayaçlarla aynı çitli işlemde tutulur: denemeler ve yuva bırakmalar boyunca kaybolmaz, sonuçta `staleInvoices` olur. Okunamayan ya da başka özetli kayıt yok sayılır ve genel özet baştan denetlenir.
- **Başlatan:** önizleme ve uygulama işi her çalıştırmanın başında (ilk deneme, devralma, yuva bırakma sonrası) başlatanın yerel üye kaydının etkin ve kapsamın izniyle (tarifede `tariffs.edit`, ayarda `settings.manage`) izinli olduğuna bakar (`starter.ts`); değilse 403 `JOB_STARTER_FORBIDDEN`, o çalıştırmada yazım yok. Uygulamanın önceki çalıştırmalarda yazdığı faturalar kalır, kapsam kaydı başarısız işteki gibi yazılır. Aynı işe bağlanan (`joined`) başka üye işi kendi adına sürdürmez: başlatan düşerse iş düşer.
- **Durdurma:** hesap aşamasında hiçbir şey yazılmamıştır (`CANCELLED`, `result` yok); yazım aşamasında yazılan faturalar yeni hâlinde kalır, `result = { invoices, lines, skipped, stopped }`.
- **Denetim kaydı:** faturaların kaydı (`invoice.recalculate`) her fatura için; kapsamın kaydı (`tariff.recompare` / `settings.recompare`) iş başına tam bir kez (`jobId` alanı + danışma kilidi). Durdurulan, başarısız ya da bırakılan iş en az bir fatura yazdıysa kaydı temizlik kancası yazar (`failed: true` olabilir).
- Bilinen sınır: yazım ile fatura kaydı arasında çökme olursa o faturanın kaydı eksik kalabilir.
- **Panel:** Ayarlar'da kaydedilmemiş değişiklik varken "Eski faturaları yeni ayara geçir" kapalıdır, yanında "Önce kaydedin" (`settings:tolerances.saveFirst`); toplu geçiş her zaman kayıtlı ayarla çalışır.

#### Ölçüm karşılaştırması

`services/measurementQueue.ts`; iş satırı açılmaz, kalıcılık `Measurement.recomparePendingAt`.

- Ölçüm kaydı (`POST`), tekrar gönderim ve silme fatura karşılaştırmasını **beklemez**; yanıttan sonra süreç içi sırada yapılır (`MEASURE_RECOMPARE_SLOTS` 2, aynı ölçüm sırada bir kez).
- Ölçüm düzeltme (`PATCH`) ve geri yükleme yanıtı karşılaştırmayı en çok 2 sn bekler (`recompareWithin`); yetişmezse `measurement.recomparePending: true` ile döner ve ölçümü yeniden okuyup güncel tutarı verir.
- Düşen karşılaştırma 1 sn ve 5 sn sonra iki kez yeniden denenir.
- `JOB_RUNNER=on` iken `startMeasurementSweep` açılışta ve 90 sn'de bir bekleyen işaretleri sıraya alır. Bakım kapsamı yalnız 2 dakikadan (`RECOMPARE_STALE_MS`; migration `20261119090000_measurement_recompare_stale_short`) eski işareti gösterir; bu yüzden yeniden başlamadan sonra bekleyen karşılaştırma en geç ~3,5 dk içinde alınır.
- İşaret yalnız başarıda ve aynı değerle boşalır. Kapanışta `drainMeasurementQueue`; bekleyenin işareti bakıma kalır. `JOB_RUNNER=inline` bekler (testler).

#### Ölçüm ve mükerrer yeniden hesabının kalıcılığı

`services/measurementQueue.ts`, `services/compare.ts`, migration `20261122090000_recompare_marks`.

- **Yükleme sırasında değişen ölçüm:**
  - `POST /invoices` yazım işlemi, içe aktarmanın danışma kilidini (`importLockName`: `invoice-import:<firma>`) aldıktan sonra ölçüm kümesini karşılaştırmadaki kapsamla yeniden okur (`MeasurementIndex.load(…, tx)`).
  - Arada kaydedilen, düzeltilen, silinen ya da geri yüklenen ölçümün (`movedMeasurements`) işareti aynı işlemde yeniden yazılır (`markMeasurementsPending`: yeni değer eskisinden kesin büyük, deneme sayısı 0).
  - Fatura yazıldıktan sonra `applyRecompare(pinned, open, MEASUREMENT)`; bu hesap düşerse yükleme yine 201 döner, işaretler sıra ya da taramayla tamamlanır.
  - Ölçüm tarafında `recompareForTracking` satır aramasını aynı kilidi **paylaşımlı** alarak yapar: süren yazım işlemini bekler ve yeni faturayı görür (bekleme en çok o işlem kadar; sorgu süresi sınırı aşılırsa karşılaştırma düşer, işaret kalır).
  - Aynı kilit ve yeniden okuma (`importRecheck`) kurulum örnek faturasında (`POST /invoices/samples`) ve deneme / demo faturasında (`importDemoInvoice`) da uygulanır.
  - Kilit altında önceki faturalardaki görünüm de (satır, taşıyıcı, fatura no, para birimi, tutar) yeniden okunur, yalnız satır sayısı değil: içe aktarma sürerken önceki faturanın başlığı düzeltilirse yeni fatura da yeniden karşılaştırılır.
- **Sonraki faturaların mükerreri:**
  - Fatura silme, başlık düzeltmesi (taşıyıcı, para birimi, fatura no) ve satırın takip no düzeltmesi, aynı numaraları taşıyan sonraki (silinmemiş, örnek olmayan) faturalara değişiklikle **aynı işlemde** `InvoiceRecheck` satırı yazar (`markLaterDuplicates`; içe aktarma kilidi paylaşımlı).
  - Hesap (`settleInvoiceRecheck`: `pinned` + `open` + `DUPLICATE`) yanıttan sonra aynı sırada yapılır; satır yalnız aynı `pendingAt` ile silinir.
  - Yanıt değişikliğin sonucudur: hesabın hatası silmeyi ya da düzeltmeyi başarısız göstermez (satır içi kipte günlüğe yazılır). Kalan işaretleri sık tarama ve saatlik bakım (`MaintenanceResult.rechecked`) tamamlar.
  - Ayrı tablo: bakımın dar okuması `Invoice` görünürlüğünü genişletmez (`File` bakım ilkesi ona dayanır); ilke `maintenance_recheck_read`, 2 dk.
  - **Kilit sırası:** işaret yazan işlem paylaşımlı içe aktarma kilidini fatura satır kilidinden **önce** alır (`lockImportsShared`; yeniden hesaplı başlık düzeltmesinde `applyRecompare`'in `beforeLock`'u). Tersi, sırada özel kilit isteyen içe aktarma varken iki düzeltmeyle kilitlenme üretir.
- **Birleştirme:** firmanın bekleyen ölçümleri tek karşılaştırmada birleşir (`settleMeasurementRecompares`, en çok `MEASURE_BATCH_MAX` 100, aynı dil): faturalar bir kez hesaplanır; işaretler hepsi bitince kendi değerleriyle boşalır. Birleşik karşılaştırma düşerse ölçümler tek tek, deneme sayısı değişmeden yeniden sıraya girer. Satır kümesi daraltılmaz (`lineIds` kipi hesabı daraltmaz ve donmuş satırı yazar).
- **Adil sıra ve deneme sınırı:**
  - Firma başına aynı anda en çok bir karşılaştırma; boş yuva en uzun süredir hizmet almamış bekleyen firmaya verilir.
  - Taramadan ya da bakımdan gelen denemenin düşüşü sayılır (`Measurement.recompareAttempts`, `InvoiceRecheck.attempts`; isteğin kendi 1 + 5 sn yeniden denemeleri sayılmaz).
  - `n` kez düşmüş işaret yaşı `2 dk × 4^n`'i geçince yeniden alınır; 5. düşüşten sonra taramaya ve bakıma girmez, günlükte `recompare gave up after max attempts` uyarısı.
  - İşaretin yeniden yazılması (yeni ölçüm sürümü, silme, geri yükleme, içe aktarmanın tazelemesi) sayacı sıfırlar.
- **Bitmiş deneme görünür** (`services/recalcFailed.ts`):
  - `GET /invoices/:id` `recalcFailed: true` (yalnız doluyken): faturanın `InvoiceRecheck` satırı 5 kez düştüyse ya da faturaya dokunan bir ölçümün işareti 5 kez düştüyse (ölçümün ve önceki sürümünün takip numarası, son 10 karakter ya da satırın zincirdeki ölçüm kimliği; `recompareForTracking` ile aynı eşleşme).
  - Panel fatura sayfasında "Yeniden hesap yapılamadı … Yeniden karşılaştır" uyarısı (eylem `lines.decide` izniyle, `POST /invoices/:id/recompare`). Merkez Genel Bakış'ta `recalc-failed` uyarısı (dönemden bağımsız; tek faturada ona, çoksa faturalar listesine). Liste rozeti yok.
  - Elle `POST /invoices/:id/recompare` ya da tüm faturanın `POST /invoices/:id/recalculate`'i (seçili satırlarla değil) başarıyla bitince `clearFailedRecalc`: faturanın bitmiş `InvoiceRecheck` satırı silinir; faturaya dokunan bitmiş ölçüm işaretinin sayacı 0'a döner (işaret dolu kalır, tarama öbür faturalar için baştan dener; yine 5 kez düşerse uyarı geri gelir).
