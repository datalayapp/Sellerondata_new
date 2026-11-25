# DeciShip SPEC — API (§5.1–§5.6, §5.9–§5.11)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 5. API (`/api/deciship`)

§5.7 (taşıyıcılar ve tarifeler), §5.8 (faturalar) ve §5.12–§5.15 ayrı dosyalardadır (dizin: SPEC.md). Uç listesi (§5.2) bütün API'nin haritasıdır.

### 5.1 Genel
- JSON. Kimlik Hesap'ın jetonudur; doğrulama, oturum ve kimlik hata kodları (`UNAUTHORIZED`, `TOKEN_EXPIRED`, `TOKEN_STALE`, `NO_PRODUCT_ACCESS`, `READ_ONLY`, `CSRF_FAILED`) ARCHITECTURE §5'tedir. Giriş, kayıt, kullanıcı ve rol uçları Hesap'tadır (`/api/account`).
- Hata biçimi her zaman `{ "error": { "code": "STRING", "message": "kullanıcının dilinde (Accept-Language), gösterilebilir", "details"?: any } }`. Doğrulama zod ile; 400 `VALIDATION`.
- Diğer kodlar:
  - 403 `FORBIDDEN`, 404 `NOT_FOUND` (başka firmanın kaydı da 404).
  - 400 `INVALID_FILE` (okunamayan/yanlış türde dosya; mesaj ne yapılacağını söyler), 400 `EMPTY_FILE`, 400 `VALUE_OUT_OF_RANGE` (veritabanı sütununa sığmayan değer), 413 `TOO_MANY_FILES`/`FILE_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE`.
  - 409 `TRACKING_IN_USE`/`NEWER_EXISTS`/`NOT_LATEST_VERSION`/`INVOICE_EXISTS`/`STALE`; 400 `REASON_REQUIRED`/`MAPPING_INCOMPLETE`/`NO_LINES`/`PHOTO_REQUIRED`.
  - Yapay zekâ: 503 `AI_DISABLED`/`AI_BUSY`, 502 `AI_FAILED`, 422 `AI_REFUSED`/`AI_TRUNCATED`. Görüntü servisi: 503 `VISION_UNAVAILABLE`, 502 `VISION_FAILED`.
- Veritabanı bağlantısı kısa süre kopar/dolarsa 500 yerine 503 `DB_UNAVAILABLE` ("Sunucu meşgul…"). Web ve mobil istemci yalnız **GET** isteğini ~1,5 sn sonra bir kez yeniden dener, yazma isteklerini asla.
- Firma başına eşzamanlı ağır istek sınırı aşılırsa 429 `TOO_MANY_REQUESTS` (`HUB_CONCURRENCY_PER_ORG`, `READ_CONCURRENCY_PER_ORG`, `HUB_EXPORT_CONCURRENCY_PER_ORG`).
- Yük ve maliyet sınırlarının kodları (429 `AI_QUOTA_EXCEEDED`, 429 `AI_DAILY_BUDGET` sistemin günlük tavanı, 429 `TOO_MANY_REQUESTS` hız sınırı, 413 `FILE_TOO_LARGE` `details.kind`, 422 `FILE_TOO_COMPLEX`, 503 `FILE_BUSY`): §5.12. Firmanın dosya alanı dolu 413 `STORAGE_QUOTA_EXCEEDED` (`details.limitGb`): §5.13. Mobilin desteklenmeyen sürümü 426 `UPGRADE_REQUIRED`: §6.3.
- Sayfalama: `?page=1&pageSize=50` (en çok 500; fatura satırları varsayılan 100, en çok 1000) → `{ items, total, page, pageSize }`. Tarihler ISO 8601. Para JSON'da number (2 ondalık).
- `prices.view` olmayan kişiye para alanı gitmez (§1).

### 5.2 Uç listesi
İzinler `deciship.` öneksiz yazılmıştır. "kendi": izin yalnız kişinin kendi ölçümü için geçerli.

| Uçlar | İzin |
|---|---|
| `GET /health` → `{ ok: true }` | kimliksiz |
| `GET /me` · `GET /settings` | oturum |
| `GET /members` (ölçüm süzgeci için ad listesi) | measurements.view_all |
| `PATCH /settings` · `POST /settings/recompare-invoices[/preview]` · `GET/PATCH /settings/onboarding` · `POST /settings/data/reset` · `POST/DELETE /settings/demo` (§5.14) | settings.manage |
| `GET /box-presets` · `POST/PATCH/DELETE /box-presets[/:id]` | measurements.capture · settings.manage |
| `GET /measurements/check` · `POST /measurements` | measurements.capture |
| `GET /measurements` · `GET /measurements/:id` · `GET /measurements/stats/today` | capture (kendi) ya da view_all |
| `PATCH/DELETE /measurements/:id` · `POST /measurements/:id/restore` | capture (kendi) ya da manage |
| `POST /measurements/:id/purge` (kalıcı silme, §10.1) | measurements.manage |
| `GET /files/:id` | imzalı bağlantı ya da oturum |
| `GET /reference-card.pdf` · `POST /vision/scale` · `POST /vision/reference/detect` · `POST /vision/reference/solve` | measurements.capture |
| `GET /carriers` | tariffs.edit, invoices.upload ya da invoices.view |
| `POST /carriers` · `PATCH/DELETE /carriers/:id` | settings.manage |
| `GET /tariffs` · `GET /tariffs/:id` · `GET /tariffs/:id/versions` · `GET /tariff-documents/:documentId` · `POST /tariffs/:id/quote` | tariffs.view |
| `GET /tariffs/template.xlsx` · `POST /tariffs` · `PUT/DELETE /tariffs/:id` · `POST /tariffs/:id/{default,duplicate,country-adjustments}` · `POST /tariffs/:id/recompare-invoices[/preview]` · `POST /tariffs/:id/versions/:versionId/restore` | tariffs.edit |
| `POST /tariffs/:id/import` · `POST /tariff-imports` · `POST /tariff-imports/:draftId/{recheck,review,apply}` · `POST /tariff-documents/:documentId/{scan,extract}` | tariffs.edit |
| `POST /invoices/preview[/verify,/ai-mapping]` · `DELETE /invoices/preview/:fileId` (yalnız yükleyen) · `POST /invoices` · `PATCH/DELETE /invoices/:id` | invoices.upload |
| `GET /invoices/preview/resumable` · `POST /invoices/preview/:fileId/keep` (sürdürme ve tazeleme, §5.13) | invoices.upload |
| `GET /jobs` · `GET /jobs/:jobId` · `POST /jobs/:jobId/cancel` (§5.13) | işin türünün izni (`invoices.upload`, `tariffs.edit`, `settings.manage`); durdurma yalnız başlatan ya da settings.manage |
| `POST /invoices/samples` | settings.manage |
| `GET /invoices` · `GET /invoices/:id` · `GET /invoices/:id/lines` · `GET /disputes` | invoices.view |
| `PATCH /invoice-lines/:id` · `POST /invoices/:id/lines/decide` (toplu karar, §5.8) · `POST /invoices/:id/recompare` · `POST /invoices/:id/recalculate[/preview]` | lines.decide |
| `POST /invoices/:id/recalculate/preview` yalnız başlık düzeltmenin kipi (aşağıda) | lines.decide ya da invoices.upload |
| `GET /invoices/:id/tariff-health` · `GET /dashboard` | reports.view |
| `GET /invoices/:id/report.xlsx` · `GET /invoices/:id/report.pdf` · `GET /invoices/:id/dispute` · `GET /invoices/:id/dispute/evidence.zip` | data.export (itiraz metni ve ZIP ayrıca prices.view, ZIP measurements.view_all da) |
| `POST /invoices/:id/disputes` · `POST /disputes/:id/{resend,withdraw,results}` · `POST /dispute-results/:id/revert` | disputes.manage |
| `GET /platform/{overview,analytics,activity}` · `GET /platform/datasets[/:id[/export]]` (Merkez sözleşmesi, ARCHITECTURE §7) | reports.view · invoices.view (+ data.export) |
| `GET /platform/ai-usage` · `GET /platform/ai-usage/calls[/export]` (§5.12) · `GET /platform/storage-usage` (§5.13) | settings.manage (export ayrıca data.export) |
| `POST /internal/events` (Hesap olayları, auth-kit; gateway'de 404) | iç ağ |

**Başlık düzeltmenin önizlemesi** (`POST /invoices/:id/recalculate/preview`, `basis: 'pinned'` + `patch`, `lineIds` yok):
- Önizleme yazmaz; kayıt `PATCH /invoices/:id` ile yapılır.
- Yükleme izniyle en az bir başlık alanı gerçekten değişmeli (boş ya da etkisiz `patch` 403).
- Karar izni olmayanın kaydında, kilit altındaki planda kararı verilmiş satırın sonucu değişiyorsa (`frozenChanged` > 0) 403 `DECIDED_LINES_CHANGE`, hiçbir şey yazılmaz.

### 5.3 Kişi, ayarlar ve ilk kurulum

#### `GET /me`
`GET /me` → `{ member: { id, name }, company: { id, name, settings }, aiAvailable, onboarding? }`. Kişi, rol ve izinler Hesap'ın `GET /api/account/me` ucundadır.
- `settings`: `settings.manage` olana tümü (+ `country`; hatırlatma ayarı `disputeReminders` dahil).
- Diğerine: `desiDivisor`, `requiredBoxPhotos`, `warnEdgeCm`, `warnWeightKg` (ölçü uyarısı eşikleri, §6.2), `scaleAiRead` (tartı okuması açık mı, §5.6); `prices.view` varsa `currency`, `invoices.view` varsa `country`.
- Deneme turu açıksa `settings.demo` herkese gider (bandı herkes görür): ayar yetkisi olana `{ startedAt, byMemberId }`, diğerine `{ startedAt }`. Bayrağın iç alanları (`carrierIds`, `loadingSince`) hiç gitmez.
- `onboarding` yalnız `settings.manage` olana.

#### `PATCH /settings`
- Gövde: `{ edgeTolCm?, weightTolKg?, amountTol?, desiDivisor? (1000–10000), requiredBoxPhotos? (0–10), warnEdgeCm? (tam sayı 10–400), warnWeightKg? (tam sayı 1–999), scaleAiRead? (boolean), fxTolerancePct? (0–20), unknownSurchargesAsDiff?, disputeReminders? }`.
- Firma adı, para birimi, ülke ve saat dilimi Merkez'den gelir (Firma ekranı, `org.updated` olayı; ARCHITECTURE §6); gövdede gönderilirse 400 `VALIDATION`.
- `disputeReminders` (varsayılan `true`): itiraz süresi hatırlatması (§5.14).
- Kayıt hiçbir faturayı hesaplamaz: faturalar hesaplandığı günkü ayarla kalır (`Invoice.compareSettings`, §3.14).

#### Eski faturaları yeni ayara geçirme
- `POST /settings/recompare-invoices/preview` `{}` → yazmaz. Yanıt:
  - `token`;
  - `invoices: [{ id, invoiceNo, carrierName, currency, before: { overchargeTotal }, after: { overchargeTotal }, changedLines }]` (ilk 200);
  - `totalsByCurrency: [{ currency, invoices, before: { overchargeTotal }, after: { overchargeTotal } }]` (geçecek tüm faturalar, para birimine göre ayrı);
  - `changedInvoices`, `skippedInDispute`.
- Yalnız ayar parçası güncellenir, tarife sürümü faturada kalır.
- `POST /settings/recompare-invoices` `{ token }` → `{ invoices, lines, skipped: { inDispute, stale }, staleInvoices?, remaining?, stopped }` (`staleInvoices` yalnız `stale` > 0 iken, `remaining` yalnız > 0 iken).
  - Dayanak değiştiyse ya da önizleme bilinmiyorsa `PREVIEW_STALE`; önizlemeden sonra değişen fatura atlanıp listelenir (§3.14).
- İkisi de yalnız `?async=1` ile arka plan işi (202 `{ job, joined }`, sonuç `job.result`, bayat özet `job.error`; §5.13). Kapsam ve kural §3.14.
- Web, toleranslardan biri (`edgeTolCm`, `weightTolKg`, `amountTol`, `fxTolerancePct`, `unknownSurchargesAsDiff`) değişip kaydedilince önizlemeyi açar ("N fatura eski ayarla hesaplı; yeni ayara geçirilsin mi?"; geçirilecek fatura yoksa sormaz). Aynı işlem Ayarlar'da "Eski faturaları yeni ayara geçir" ile de yapılır.

#### İlk kurulum
- İlerleme `company.settings.onboarding` `{ step?, done[], skipped[], startedAt?, completedAt?, bannerDismissedAt? }` (`lib/settings.ts`, `services/onboarding.ts`).
- `GET /settings/onboarding` → `{ state, completed, required, showBanner, boxPresetsReady, requiredSteps, company{name,currency,country,timeZone,confirmed}, carriers[{id,code,name,active,tariffs[],activeTariffCount}], boxPresets, invoices[], demo }`.
  - `demo: { active, available }` (§5.14); `available` = `DEMO_TOUR` açık, deneme açık değil ve firmada veri yok.
- `PATCH /settings/onboarding` `{ step?, done?, skipped?, complete?, dismissBanner? }` (zod `.strict()`) → aynı yanıt.
- `GET /me` `onboarding: { completed, required, showBanner }` ekler:
  - `required` = tamamlanmamış **ve** aktif taşıyıcı yok;
  - `showBanner` = tamamlanmamış, bant kapatılmamış ve (taşıyıcı yok ya da sihirbaz başlatılmış).
- Adımlar (sırayla): `tasiyicilar` (zorunlu) · `faturalar` (opsiyonel) · `tarifeler`, `olcum` (zorunlu) · `koliler` (opsiyonel) · `ozet`. Kayıtlı eski `kalibrasyon` adı `faturalar` okunur. Eski `sirket` adımı göçsüz okunur ve kabul edilir (`ONBOARDING_STEPS`'te kalır) ama hiçbir kurala girmez.
- Firma bilgileri Merkez'de onaylanır: `company.settings.companyConfirmed` yalnız `org.updated` `companyConfirmed` ile yazılır.
  - Ad ile aynı sürüm koşulu geçerlidir; bozuk ya da eksik alan kayıtlı değere dokunmaz.
  - `PATCH /settings` kabul etmez; ayar yanıtlarına girmez.
  - Yeni firma satırı `false` açılır; kayıtlı değer yoksa onaylı sayılır (`companyConfirmedOf`).
- Kurulum tamam = Merkez onayı **ve** (sihirbaz tamamlandı ya da zorunlu adımların hepsi veride). `/me`, `/settings/onboarding` ve Merkez `setup.completed` aynı kuralı okur.
- `company.country` `firmCountry` ile çözülür (bilinmiyorsa `null`).

#### Örnek faturalar
- `invoices[]` = şirketin örnek faturaları (`Invoice.isSample`, en çok 20); öğelerde `linesWithoutTariff` (hiçbir tarifeyle hesaplanmamış satır sayısı).
- `POST /invoices/samples` (multipart `carrierId`, `file`) tek adımda yükler → 201 `{ invoice, lines }`:
  - eşleme ekranı yok (kalıp/kayıtlı eşleme, tutmazsa yapay zekâ; PDF yapay zekâ);
  - fatura no/tarih/para birimi dosyadan tahmin edilir (yoksa dosya adı / bugün / şirket para birimi);
  - mükerrer kontrolü yapılmaz.
- Örnek faturalar fatura listesinde, Pano'da, ölçüm ekranlarında, fatura no çakışmasında ve gerçek faturaların mükerrer/satır tekrarı kontrolünde yok sayılır. PDF tarife taramasındaki fatura hizmeti önerisinde ve tarife uyumu raporunda kullanılır.
- Kaldırmak: `DELETE /invoices/:id`.

#### Veri sıfırlama
`POST /settings/data/reset` `{ confirm: true, samples? }` (`services/companyData.ts`) yalnız `ENABLE_DATA_RESET=true` iken kayıtlıdır (üretimde yok, 404).
- Şirketin faturaları, ölçümleri (dosyalarıyla), taşıyıcıları ve tarifeleri silinir; üyeler, ayarlar ve hazır koliler kalır.
- İlerleme silinir (sihirbaz yeniden açılır).
- `samples: true` ardından örnek veriyi yükler ve kurulumu tamamlanmış sayar.

### 5.4 Ölçümler
- `GET /measurements/check?tracking=RAW` → `{ exists: boolean, last?: { id, measuredAt, measuredByName, lengthCm, widthCm, heightCm, weightKg } }`. Başkasının kaydında ve `measurements.view_all` yoksa `last` yalnız `{ measuredAt, measuredByName }`: ikinci ölçümü yönlendirmesin.
- `POST /measurements` **multipart** → `201 { measurement }`:
  - alan `data` = JSON `{ clientId, trackingRaw, lengthCm, widthCm, heightCm, weightKg, dimMethod, weightMethod, ocrWeightKg?, dimConfidence?, boxPresetId?, measuredAt, note?, photoKinds: ('PHOTO_BOX'|'PHOTO_SCALE'|'PHOTO_LABEL'|'PHOTO_OTHER')[] }`;
  - `photos` dosyaları aynı sırada, JPEG, ≤ 8 MB/adet. Fotoğrafın üst verisi kaydetmeden önce kalkar (§5.5).
  - Aynı kişiden aynı `clientId` tekrar gelirse 200 ile mevcut kaydı döner (idempotent; başka kişinin aynı değeri ayrı kayıttır).
  - İsteğe bağlı gönderim anı: `X-SOD-Sent-At` başlığı (mobil her denemede jeton yenilemesinden sonra, istek çıkarken yazar; öncelikli) ya da `data.sentAt` (yedek). Okunamayan başlık yok sayılır. İsteğe bağlı `replacesId` (kontrol ekranında görülüp bilerek yeniden ölçülen kaydın kimliği).
  - **Cihaz saati farkı** (`services/measurementOrder.ts` `correctDeviceClock`): gönderim anı varsa fark = isteğin sunucuya ulaştığı an − gönderim anı; 10 dk'dan (`CLOCK_OFFSET_IGNORE_MS`) büyükse ölçüm anına eklenir. Fark yükleme süresini de içerir (ağ geçidi gövdeyi tamponlar; istemci isteği en çok 60 sn): eşik bu yüzden büyük, daha küçük saat farkı düzeltilmez. `measuredAt` düzeltilmiş andır, cihazın ham anı `deviceMeasuredAt`'te kalır (yalnız düzeltildiyse), fark denetim kaydında `clockOffsetMs`. Ölçümle gönderim arasında cihaz saati değiştiyse fark yakalanmaz. Gönderim anı yoksa (eski uygulama) ham an kullanılır; aralık dışındaysa reddedilmez, alış anına çekilir (ham an `deviceMeasuredAt`, denetim kaydında `clockClamped: true`). Gerçek anı bilinmeyen bu kayıt aynı takip no'nun güncel ölçümünün yerine geçmez (eski sürüm olarak girer); güncel ölçüm yoksa güncel olur. Eski sürüm `MEASURED_AT_INVALID`'i tanımadığı için reddi sonsuz yeniden gönderirdi.
  - Gönderim anını bildiren istekte (düzeltilmiş) ölçüm anı kabul aralığında olmalı: sunucu saatinden en çok 15 dk ileride (`MEASURED_AT_FUTURE_SKEW_MS`), en çok 730 gün geride (`MEASURED_AT_MAX_AGE_MS`). Dışındaysa `400 MEASURED_AT_INVALID` (`details: [{ path: 'measuredAt', message }]`), kayıt yazılmaz; kayda özgü red (§6.2). Denetim tekrar gönderimden sonradır: kaydedilmiş `clientId` her zaman 200 ile döner.
  - Aynı takip no daha önce ölçülmüşse yeni sürüm yazılır (eski `supersededById` ile işaretlenir). Sıra (`arrivesLate`):
    - `replacesId` güncel sürümün kimliğiyse gelen kayıt saate bakılmadan güncel olur (denetim kaydında `replaced: true`). Güncel değilse yok sayılır.
    - Gelen kaydın ölçüm anı güncel sürümün hem ölçüm anından hem sunucuya ulaştığı andan (`createdAt`) önceyse **geç** kayıttır; değilse (eşit dahil) güncel olur. `createdAt` koşulu saati ileride cihazın kaydına güvenmez: ondan sonra yapılan yeniden ölçüm eski sürüme düşmez.
    - Geç kayıtta güncel sürüm **değişmez**: kayıt zincire eski sürüm olarak, ölçüm anına göre yerine girer (zincir güncelden geriye yürünür, ölçüm anı gelen kayıttan yeni sürümler geçilir); geçilen sürümlerin `version`'ı birer artar, kayıtta `arrivedLate = true`. Yanıt yine `201`, `measurement.superseded: true`. Denetim kaydı `measurement.remeasure` `{ trackingNo, late: true, currentId }` (Merkez akışında ayrı etiket). Faturalar yeniden karşılaştırılır: rakam güncel sürümden gelir, zincirde birden çok ölçüm anı olduğu için ağırlık/ölçü farkı "İncele"ye düşer (§3.13). İçe aktarma yarışında sürüm değişimi de ölçüm değişikliği sayılır (`movedMeasurements`).
    - Güncel sürüm silinmişse (son sürümü silinmiş zincir) karşılaştırılacak güncel kayıt yoktur: gelen kayıt yeni zincir açar. Silinen kayıt sonra geri yüklenirse sıra orada düzelir (§10.1).
- `GET /measurements?q=&from=&to=&userId=&method=&deleted=&page=` → `view_all` olana tümü, olmayana yalnız kendi ölçümlerinin tümü (sayfalı, süre sınırı yok).
  - Güncel sürümler. `view_all` olmayana ayrıca kendi geç kaydı (`arrivedLate`), hemen sonraki sürüm başkasının silinmemiş güncel sürümüyse (ona güncel sürüm görünmez). Hepsini gören `userId=` ile süzerse o çalışan için aynı küme. `GET /measurements/stats/today` aynı kümeyi sayar; Merkez çalışan sayımı da (geç kayıt ölçene yazılır; "Düzeltilen" geç kaydın kaydırdığı sürüm numarasını saymaz).
  - Öğe: `{ id, trackingNo, trackingRaw, lengthCm, widthCm, heightCm, weightKg, desi, volumetricKg5000, dimMethod, weightMethod, measuredAt, measuredBy: {id,name}, photoCount, version, deleted, deletedAt, invoiceStatus? (yalnız invoices.view) }`.
  - `deleted=true` (yalnız `measurements.manage`; değilse 403 `FORBIDDEN`): yalnız silinmiş güncel sürümler, `deletedAt` azalan sırada.
- `GET /measurements/:id` (ve `PATCH`, `restore` yanıtı) → `{ measurement: { …liste öğesi, photos: {id, kind, url}[], history: Ölçüm[], canEdit, invoiceStatus?, invoiceLines? (yalnız invoices.view) } }`. `canEdit` = (`measurements.manage` ya da kendi ölçümü) **ve** en güncel sürüm **ve** silinmemiş.
- `GET /measurements/stats/today` → `{ count, missingPhotos }` (view_all yoksa kendi).
- Düzeltme (`PATCH`), silme (`DELETE`), geri alma (`POST …/restore`) ve silinenler listesi: §10.1. Takip no çakışması (aynı takip no'nun başka güncel kaydı) → `409 TRACKING_IN_USE`.

### 5.5 Dosyalar
- `GET /reference-card.pdf`: referans kartı PDF'i (`samples/reference-card.pdf`).
- `GET /files/:id?t=<fileToken>`: `<img>` için kısa ömürlü (10 dk), kişiye bağlı imzalı bağlantı (üyelik pasifleşir ya da yetkisi değişirse düşer). API yanıtlarındaki `url` alanı bunu içerir.
  - İmzasız istekte oturum gerekir: fatura dosyası yalnız `invoices.view` ile; fotoğraf `view_all` ile, yoksa yalnız kişinin kendi ölçümününki.
  - Silinen kaydın dosyası kapanır (silinen ölçümün fotoğrafı `measurements.manage`'e açık). Şirket dışı erişim 404.
  - Yanıtta `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; PDF dışı dosyalarda ayrıca `Content-Security-Policy: sandbox`.
- Ölçüm fotoğrafı yalnız JPEG/PNG/WebP/HEIC (tür + içerik imzası); SVG/HTML 400 `INVALID_FILE`.

#### Fotoğraf üst verisi (`lib/imageMeta.ts`)
Fotoğraf kanıt ZIP'iyle kargo firmasına gittiği için kaydetmeden önce temizlenir. Kural izin listesidir, bilinmeyen taşıyıcı kalmaz:
- JPEG'de yalnız SOFn/DHT/DQT/DRI/DAC/SOS/DNL (yapıları denetlenir), APP0 JFIF, APP2 ICC, APP14 Adobe kalır. APP1 (EXIF, XMP), APP3–APP13, APP11 JUMBF/C2PA, APP15, COM, MPF ve görüntü sonrası ek veri (ikinci görüntüler) kalkar; taramalar arasındaki üst veri de. Kesimler arası artık bayt libjpeg gibi atlanır.
- PNG'de zorunlu parçalar ve tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, bKGD, pHYs, cICP, APNG parçaları kalır.
- WebP'de VP8/VP8L/VP8X/ALPH/ANIM/ANMF/ICCP kalır.
- Görüntü verisi bayt bayt aynı kalır; EXIF yönü (2–8) yalnız onu taşıyan asgari EXIF ile korunur.
- Dosya başına en çok 4.096 kesim/parça (üstü okunamaz sayılır; çok parçalı dosyayla işlemci tutulamaz).
- Saklanan boyut ve sha256 temizlenmiş dosyanındır.
- Bozuk yapıdaki dosya (beklenmeyen işaret, tutmayan tablo, MPF'li dosyada görüntü sonu yok) ve HEIC/HEIF olduğu gibi saklanır (ölçüm reddedilmez); kayıttan sonra dosya kimliğiyle günlüğe yazılır.
- Kanıt ZIP'i her fotoğrafı girerken yeniden temizler (itiraz.md).

### 5.6 Görüntü işleme
- `POST /vision/scale` multipart `image` → `{ weightKg: number|null, unit: 'kg'|'g'|null, rawText: string, confidence: number }`. Claude vision (`CLAUDE_MODEL`); istem: tartı ekranındaki sayıyı oku, yalnızca JSON döndür. `ANTHROPIC_API_KEY` yoksa 503 `AI_DISABLED` ("Yapay zekâ anahtarı tanımlı değil, ağırlığı elle girin").
- **Firma ayarı `scaleAiRead`** (varsayılan `false`; kayıtlı değeri olmayan firma da kapalı, yalnız açıkça `true` açar):
  - Kapalıysa uç görüntüyü okumadan, sağlayıcıya ve sayaca gitmeden 409 `AI_DISABLED`, `details.reason: 'scale_ai_off'` ("Tartı fotoğrafı okuması bu firmada kapalı; ağırlığı elle girin") döner. Eski mobil sürümler de `AI_DISABLED`'ı "Otomatik okuma kapalı. Ağırlığı elle girin." diye gösterir. `AiUsage` ve önbellek satırı yazılmaz.
  - Bu denetim anahtar denetiminden (`AI_DISABLED`) önce gelir. Açıkken §5.12 kuralları aynen geçerlidir.
  - Yönetici panelde Ayarlar > Mobil ölçüm'den değiştirir; ölçen rol `/me` ve `/settings` yanıtında görür (telefon buradan okur).
  - Ücretsiz (yapay zekâsız) tartı okuması bu ayarın kapsamında değildir.
- `POST /vision/reference/detect` multipart `image` → vision servisine aktarır (§7) → `{ ok, marker?: {corners:[x,y][4], id}, imageSize: {w,h}, suggestedBox?: { points: [x,y][6], auto: boolean }, message? }`. API yanıtı olduğu gibi geçirir.
  - `suggestedBox.auto`: kutu köşeleri otomatik bulunduysa `true`, varsayılan yerleşimse `false`. Mobil "noktaları taşımadan ölçme" kararını bu bayrağa dayandırır (bayrak yoksa `message` metnine bakar).
- `POST /vision/reference/solve` JSON `{ detectId?, imageSize, marker, intrinsics?, points: [x,y][] /* §7 sırası */ }` → `{ lengthCm, widthCm, heightCm, confidence }`

### 5.9 Pano
`GET /dashboard?month=YYYY-MM` → `{ month, measurements: { count, byMethod: Record<DimMethod, number>, today }, invoices: { count, lines, match, diff, unmatched, noTariff }, overchargeTotal, verifiedTotal, recoveredTotal, disputePendingTotal, coveragePct /* ölçülmüş satır / toplam satır */, topDiffTypes: { type, count, amount }[], recentInvoices: [...5], currency, otherCurrencies, byCurrency }`.
- `recentInvoices` dönemden bağımsızdır, yükleme anına göre sıralıdır (ekranda "Son yüklenenler"). Kapsama kartının alt satırı "bu dönemin faturalarında" der.
- Tutarlar `currency` cinsindendir (firma para birimi; o para biriminde fatura yoksa en çok satırı olan); diğerleri `byCurrency` içinde.

### 5.10 Tohum veri
- `npm run seed` (api, `src/dev-seed.ts`): firma "Demo Lojistik" ve her rolden üye (Yönetici ×2, Denetleyici, Muhasebe, Ölçüm); `--reset` sıfırlar, `--samples` örnek veriyi yükler. Giriş hesapları ve şifreler Hesap tohumundadır (KURULUM.md "Demo hesaplar"); örnek fatura ve itirazları `seedDemoDisputes.ts` yükler.
- Örnek veri (`loadSampleData`, `samples/seed-tariffs.json` + `samples/seed-measurements.json`): 6 taşıyıcı (FedEx, UPS, DHL, Aras, Yurtiçi, MNG) ve tarifeleri, 57 ölçüm.
  - "FedEx International Economy 2026": bölen 5000, basamak 0,5 kg ≤20 sonra 1 kg, indirim %38, yakıt %25; FR/DE/NL → A, GB → B, US/CA → D; 6,0 kg A = 1.527,75.
  - "Aras Desi 2026": bölen 3000, tek bölge `*`, 1–30 desi.
  - Wiki örneklerine uyan ölçümler (ör. takip no 794812345305 = #5305). `samples/` altındaki örnek faturalar bu ölçümlerle eşleşir.
  - Dosya yoksa yerleşik FedEx + Aras tarifeleri kullanılır.

### 5.11 İtiraz takibi
Ayrıntılı sözleşme (alanlar, durumlar, hata kodları, gövdeler): `itiraz.md`. Kurallar §3.11.
- Uçlar: `GET /disputes` (liste ve süzgeç) · `POST /invoices/:id/disputes` (paketi gönderildi işaretle → 201 `{ dispute }`) · `POST /disputes/:id/resend` · `POST /disputes/:id/withdraw` · `POST /disputes/:id/results` (dekont ya da ret) · `POST /dispute-results/:id/revert`; hepsi `{ dispute }` döner.
- Hata kodları (`DISPUTE_ACTIVE`, `NO_SENDABLE_LINES`, `LINE_NOT_PENDING`, `AMOUNT_EXCEEDS_CLAIM`, `CREDIT_NOTE_REQUIRED`, `SENT_ON_IN_FUTURE`, `RESULT_ON_BEFORE_SENT`, `STALE` …): `apps/api/src/services/disputes.ts`.
- Kayıt önce aranır, gövde sonra doğrulanır: başka firmanın kimliği her gövdeyle 404 alır.
