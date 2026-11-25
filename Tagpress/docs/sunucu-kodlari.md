# Sunucu kodları

> Bu belge üretilir: `node scripts/sunucu-kodlari.ts` (kaynak: `packages/domain/src/messages.ts`). Elle düzenlemeyin.
> Test (`packages/domain/src/messages.test.ts`) listedeki her kodun burada geçtiğini denetler.

Sunucu kullanıcıya gösterilen her hatayı, sorunu, düzeltme önerisini, geri al bildirimini ve baskı şablonu uyarısını
**kod + parametre** ile gönderir. Bugünkü Türkçe cümle aynı yanıtta durur (geriye uyum; eski arayüz onu gösterir).

## Yanıt biçimi

| Ne | Alanlar (yeni olanlar kalın) | Sözlük anahtarı önerisi |
| --- | --- | --- |
| Hata (`ApiError`, 4xx/5xx) | `error` (TR cümle), **`code`**, **`params`**, `fields`, `provider` | `errors:<code>` |
| Sorun (`Issue`) | `code`, `severity`, `message` (TR), **`messageKey`**, **`params`**, `field`, `fixes` | `issues:<messageKey>` (yoksa `issues:<code>`) |
| Düzeltme önerisi (`FixAction`) | `kind`, `label` (TR), **`labelKey`**, **`params`**, `value` | `issues:fix.<labelKey>` (yoksa `issues:fix.<kind>`) |
| Geri al (`UndoToken`) | `undoToken`, `label` (TR), **`code`**, **`params`**, `expiresAt` | `common:undo.<code>` |
| Baskı şablonu uyarısı (`PrintTemplateWarning`) | `code`, `message` (TR), **`messageKey`**, **`params`**, `slotIds` | `printTemplates:warnings.<messageKey>` |

- **Kod düzeni:** küçük harf, kısa çizgili, düz (nokta yok): `template-key-not-found`. Sözlük anahtarı olarak doğrudan kullanılır.
  Var olan kodlar korundu (`missing-key`, `edit-font`, `not-adjustable`, `version-conflict`, `printed`; sorun kodlarının hepsi).
- **Bir sorun kodunun birden çok cümlesi olabilir** (ör. `text-very-long` üç farklı durum). Gruplama ve sayma `code` ile, metin
  `messageKey` ile yapılır. Tek cümlesi olan kodda `messageKey` kodla aynıdır.
- **Parametreler** düz JSON: sayılar sayı (`count`, `line`, `max`, `version`…), listeler önceden birleştirilmiş metin
  (`chars`, `words`, `slots`, `families`). `pt` bir ondalıklı metindir ("5.5"). Parametre yoksa `params` alanı gelmez.
- **Müşteri metni** parametreye olduğu gibi girer (`text`, `fixed`, `first`/`second`, `got`/`want`, `input`); arayüz
  bunları değiştirmeden göstermelidir. Sunucu cümlesi i18next'e verilirken kaçış (HTML) arayüzün işidir.
- **Serbest metin** (tabloda `*`): `detail`, `reason`, `reasons`, `note` motorun, AI sağlayıcısının, kütüphanenin ya da
  AI denetçisinin kendi cümlesidir (çoğu Türkçe, bazıları İngilizce). Çevrilemez; EN arayüzde olduğu gibi gösterilir.
- **Eski kayıtlar:** veritabanında saklı sorunlarda (`variants.issues`, iş sorunları) `messageKey`/`params` olmayabilir; o zaman
  `message`'a düşülür.
- **Doğrulama alanları** (`fields[].message`) zod'un ya da şemanın kendi cümlesidir; kodlanmadı.

### Arayüz kuralı (öneri)

1. Hata: `code` sözlükte varsa `t("errors:" + code, params)`; yoksa TR'de `error`, EN'de `errors:generic` + ayrıntıda `error`.
2. Sorun: `t("issues:" + (messageKey ?? code), params)`; anahtar yoksa `message`.
3. Düzeltme: `t("issues:fix." + (labelKey ?? kind), { value, ...params })`; anahtar yoksa `label`.
4. Geri al: `t("common:undo." + code, params)`; yoksa TR'de `label`, EN'de `common:undo.generic`.

## Hatalar (160)

`status` "—": durum değişir (Fastify'ın kendi 4xx'i).

| Kod | Durum | Parametreler | TR (bugünkü metin) | EN önerisi |
| --- | --- | --- | --- | --- |
| `host-not-local` | 403 | — | Yalnızca yerel adresten erişilebilir. | Only reachable from a local address. |
| `origin-not-allowed` | 403 | — | Bu kökenden erişime izin yok. | Access from this origin is not allowed. |
| `studio-header-missing` | 403 | — | İstek reddedildi: X-Studio başlığı eksik. | Request rejected: the X-Studio header is missing. |
| `not-found` | 404 | — | Bulunamadı. | Not found. |
| `web-not-built` | 404 | — | Arayüz derlenmemiş. | The interface has not been built. |
| `body-invalid-json` | 400 | — | Gövde geçerli JSON değil. | The request body is not valid JSON. |
| `request-failed` | — | `detail`* | {detail} | {detail} |
| `server-error` | 500 | `detail`* | Sunucu hatası: {detail} | Server error: {detail} |
| `request-invalid` | 400 | — | İstek geçersiz. | The request is invalid. |
| `query-invalid` | 400 | — | Sorgu geçersiz. | The query is invalid. |
| `version-invalid` | 400 | — | Sürüm geçersiz. | The version is invalid. |
| `version-range-invalid` | 400 | — | Sürüm aralığı geçersiz. | The version range is invalid. |
| `learn-request-invalid` | 400 | — | Öğrenme isteği geçersiz. | The learning request is invalid. |
| `source-invalid` | 400 | — | Kaynak geçersiz. | The source is invalid. |
| `replay-request-invalid` | 400 | — | Deneme isteği geçersiz. | The replay request is invalid. |
| `session-invalid` | 400 | — | Oturum geçersiz. | The session is invalid. |
| `session-entry-invalid` | 400 | — | Oturum girdisi geçersiz. | The session entry is invalid. |
| `draft-patch-invalid` | 400 | — | Taslak yaması geçersiz. | The draft patch is invalid. |
| `setting-invalid` | 400 | — | Ayar geçersiz. | The setting is invalid. |
| `feature-invalid` | 400 | — | Özellik seçimi geçersiz. | The feature selection is not valid. |
| `setup-invalid` | 400 | — | Kurulum cevabı geçersiz. | The setup answer is not valid. |
| `provider-invalid` | 400 | — | Sağlayıcı geçersiz. | The provider is invalid. |
| `key-invalid` | 400 | — | Anahtar geçersiz. | The key is invalid. |
| `language-package-invalid` | 400 | — | Tasarım dili paketi geçersiz. | The design language package is invalid. |
| `language-package-profile-invalid` | 400 | — | Paketteki profil geçersiz. | The profile in the package is invalid. |
| `trial-request-invalid` | 400 | — | Deneme geçersiz. | The trial request is invalid. |
| `reference-invalid` | 400 | — | Referans geçersiz. | The reference is invalid. |
| `proposal-invalid` | 400 | — | Öneri geçersiz. | The proposal is invalid. |
| `profile-invalid` | 400 | — | Profil geçersiz; işaretli alanları düzeltin. | The profile is invalid; fix the marked fields. |
| `preset-invalid` | 400 | — | Ön ayar geçersiz. | The preset is invalid. |
| `print-template-invalid` | 400 | — | Baskı şablonu geçersiz. | The print template is invalid. |
| `print-template-corrupt` | 500 | `id` | Baskı şablonu kaydı bozuk ({id}). | The print template record is corrupt ({id}). |
| `template-record-invalid` | 400 | — | Şablon kaydı geçersiz. | The template record is invalid. |
| `template-patch-invalid` | 400 | — | Şablon yaması geçersiz. | The template patch is invalid. |
| `template-fields-readonly` | 400 | — | Bu alanlar değiştirilemez. | These fields cannot be changed. |
| `template-key-invalid` | 400 | `key` | Geçersiz şablon adı: "{key}" (harf, rakam, - ve _). | Invalid template name: "{key}" (letters, digits, - and _). |
| `language-id-invalid` | 400 | — | Geçersiz tasarım dili kimliği. | Invalid design language ID. |
| `language-id-required` | 400 | — | languageId gerekli. | languageId is required. |
| `language-unknown` | 400 | — | Böyle bir tasarım dili yok. | No such design language. |
| `preview-width-range` | 400 | — | w 32–4000 arasında olmalı. | w must be between 32 and 4000. |
| `file-name-invalid` | 400 | — | Geçersiz dosya adı. | Invalid file name. |
| `not-png` | 400 | — | Dosya PNG değil. | The file is not a PNG. |
| `font-file-type` | 400 | — | Font dosyası .ttf, .otf, .woff ya da .woff2 olmalı. | The font file must be .ttf, .otf, .woff or .woff2. |
| `font-invalid` | 400 | — | Dosya geçerli bir font değil. | The file is not a valid font. |
| `job-not-found` | 404 | — | İş bulunamadı. | Job not found. |
| `jobs-to-delete-not-found` | 404 | — | Silinecek iş bulunamadı. | No jobs to delete were found. |
| `batch-not-found` | 404 | — | Parti bulunamadı. | Batch not found. |
| `variant-not-found` | 404 | — | Varyasyon bulunamadı. | Variant not found. |
| `preview-not-found` | 404 | — | Önizleme bulunamadı. | Preview not found. |
| `text-layer-not-found` | 404 | — | Yazı katmanı bulunamadı. | Text layer not found. |
| `language-not-found` | 404 | — | Tasarım dili bulunamadı. | Design language not found. |
| `profile-version-not-found` | 404 | `version` | Profil sürümü {version} bulunamadı. | Profile version {version} not found. |
| `template-not-found` | 404 | — | Şablon bulunamadı. | Template not found. |
| `template-key-not-found` | 404 | `key` | Şablon "{key}" bulunamadı. | Template "{key}" not found. |
| `template-image-not-found` | 404 | — | Şablon görseli bulunamadı. | Template image not found. |
| `template-key-image-not-found` | 404 | `key` | Şablon "{key}" görseli bulunamadı. | Image of template "{key}" not found. |
| `template-backup-not-found` | 404 | `key` | "{key}" için yedek bulunamadı. | No backup found for "{key}". |
| `template-task-not-found` | 404 | — | Şablon üretim görevi bulunamadı. | Template generation task not found. |
| `font-file-not-found` | 404 | — | Font dosyası bulunamadı. | Font file not found. |
| `reference-not-found` | 404 | — | Referans bulunamadı. | Reference not found. |
| `reference-image-not-found` | 404 | — | Referans görseli bulunamadı. | Reference image not found. |
| `proposal-not-found` | 404 | — | Öğrenme önerisi bulunamadı. | Learning proposal not found. |
| `ai-call-not-found` | 404 | — | AI çağrısı bulunamadı. | AI call not found. |
| `trial-preview-not-found` | 404 | — | Deneme önizlemesi bulunamadı. | Trial preview not found. |
| `undo-not-found` | 404 | — | Geri alma kaydı bulunamadı. | Undo record not found. |
| `print-template-not-found` | 404 | — | Baskı şablonu bulunamadı. | Print template not found. |
| `preset-not-found` | 404 | — | Ön ayar bulunamadı. | Preset not found. |
| `print-session-not-found` | 404 | — | Baskı oturumu bulunamadı. | Print session not found. |
| `print-page-not-found` | 404 | — | Baskı sayfası bulunamadı. | Print page not found. |
| `print-item-not-found` | 404 | — | Baskı öğesi bulunamadı. | Print item not found. |
| `slot-not-found` | 404 | `slot` | Yuva {slot} bulunamadı. | Slot {slot} not found. |
| `export-not-found` | 404 | — | Baskı çıktısı bulunamadı. | Print export not found. |
| `export-file-not-found` | 404 | — | Çıktı dosyası bulunamadı. | Export file not found. |
| `overlay-unavailable` | 501 | — | Alan bindirmesi için templates paketi bağlı değil. | The area overlay needs the templates package, which is not connected. |
| `specimen-unavailable` | 501 | — | Font örneği için typeset paketi bağlı değil. | The font specimen needs the typeset package, which is not connected. |
| `key-tester-unavailable` | 501 | — | Bağlantı denemesi bağlı değil. | The connection test is not connected. |
| `text-layer-unavailable` | 501 | — | Yazı katmanı çizimi (motor) bağlı değil. | Text layer drawing (engine) is not connected. |
| `edit-unavailable` | 501 | — | Metin/font düzenlemesi (motor) bağlı değil. | Text/font editing (engine) is not connected. |
| `engine-preview-unavailable` | 501 | — | Motor bağlı değil; önizleme çizilemez. | The engine is not connected; the preview cannot be drawn. |
| `layout-engine-unavailable` | 501 | — | Yerleşim motoru bağlı değil. | The layout engine is not connected. |
| `geometry-unavailable` | 501 | — | Şablon geometrisi bağlı değil. | Template geometry is not connected. |
| `ai-designer-unavailable` | 501 | — | AI tasarımcı bağlı değil. | The AI designer is not connected. |
| `image-generator-unavailable` | 501 | — | Görüntü üretimi bağlı değil. | Image generation is not connected. |
| `print-render-unavailable` | 501 | — | Baskı sayfası çizimi (motor) henüz bağlı değil. | Print page drawing (engine) is not connected yet. |
| `pdf-unavailable` | 501 | — | PDF çıktısı (motor) henüz bağlı değil. | PDF output (engine) is not connected yet. |
| `print-planner-unavailable` | 501 | — | Baskı sayfası planlayıcısı (@tagpress/print) henüz bağlı değil. | The print page planner (@tagpress/print) is not connected yet. |
| `missing-key` | 409 | `providerName` | {providerName} anahtarı yok. Ayarlar → Bağlantılar'dan {providerName} anahtarını girin. | There is no {providerName} key. Enter your {providerName} key in Settings → Connections. |
| `managed-by-platform` | 409 | — | Bu ayarı SellerOnData platformu yönetir; burada değiştirilmez. | This setting is managed by the SellerOnData platform and cannot be changed here. |
| `name-managed-by-platform` | 403 | — | Firma adı SellerOnData Merkez'de değişir. | The company name is changed in SellerOnData Hub. |
| `ai-paused` | 409 | — | Yapay zekâ SellerOnData'da geçici olarak durduruldu; iş başlamadı. Biraz sonra yeniden deneyin. | AI is temporarily paused on SellerOnData; nothing was started. Please try again shortly. |
| `ai-unavailable` | 409 | — | Yapay zekâ şu an kullanılamıyor; iş başlamadı. | AI is unavailable right now; nothing was started. |
| `master-key-missing` | 409 | `keys` | Ana anahtar yok ({keys}); anahtar şifrelenemiyor. Ana anahtarı geri koyun ya da çözülemeyen anahtarları silip uygulamayı yeniden başlatın. | The master key is missing ({keys}); keys cannot be encrypted. Put the master key back, or delete the keys that cannot be decrypted and restart the app. |
| `key-unreadable` | 409 | `providerName`, `detail`* | {providerName} anahtarı çözülemiyor: {detail} Ayarlar → Bağlantılar'dan anahtarı yeniden girin. | The {providerName} key cannot be decrypted: {detail} Enter the key again in Settings → Connections. |
| `feature-off` | 409 | — | Bu özellik kapalı. Ayarlar → Özellikler'den açabilirsiniz. | This feature is turned off. You can turn it on in Settings → Features. |
| `feature-always-on` | 400 | — | Bu özellik her zaman açıktır; kapatılamaz. | This feature is always on; it cannot be turned off. |
| `no-language` | 409 | — | Henüz tasarım dili yok. Önce bir tasarım dili oluşturun. | There is no design language yet. Create a design language first. |
| `no-published-profile` | 409 | — | Bu tasarım dilinin yayınlanmış profili yok. | This design language has no published profile. |
| `no-draft` | 409 | — | Yayınlanacak taslak yok. | There is no draft to publish. |
| `no-draft-profile` | 400 | — | Taslak profil yok. | There is no draft profile. |
| `learn-running` | 409 | — | Bu tasarım dili için öğrenme zaten çalışıyor. | Learning is already running for this design language. |
| `learn-nothing` | 409 | — | Henüz referans ya da elle düzeltme yok: üretilen varyasyonları Düzelt ile düzeltin. | No references or manual adjustments yet: adjust the generated variants with Adjust. |
| `replay-no-references` | 409 | — | Tekrar edilebilecek referans yok (şablonu ve görseli olan, tasarım alanı boyutunda). | No references to replay (they need a template, an image and the design area size). |
| `proposal-decided` | 409 | — | Bu öneri zaten karara bağlanmış. | This proposal has already been decided. |
| `proposal-empty` | 400 | — | Önerinin uygulanabilir değişikliği yok. | The proposal has no applicable change. |
| `proposal-accepted` | 409 | — | Uygulanmış öneri reddedilemez; önce geri alın. | An applied proposal cannot be rejected; undo it first. |
| `proposal-not-applied` | 409 | — | Öneri uygulanmamış. | The proposal has not been applied. |
| `proposal-no-record` | 409 | — | Bu önerinin uygulama kaydı yok; elle geri alın. | There is no record of applying this proposal; undo it manually. |
| `build-not-found` | 404 | — | Oluşturma oturumu bulunamadı. | Build session not found. |
| `build-active` | 409 | — | Bu tasarım dilinde açık bir oluşturma oturumu var. | There is already an open build session for this design language. |
| `build-state` | 409 | — | Oturum bu adımda bu işi yapamaz. | The session cannot do this at this step. |
| `build-busy` | 409 | — | Oturumda çalışan bir iş var; bitmesini bekleyin. | Something is running in this session; wait for it to finish. |
| `build-no-revision` | 409 | — | Bu revizyon henüz yok. | This revision does not exist yet. |
| `budget-exceeded` | 409 | — | Yapay zekâ harcama sınırına ulaşıldı; iş başlamadı. | The AI spending limit was reached; nothing was started. |
| `budget-raise-used` | 409 | — | Oturum sınırı zaten bir kez artırıldı. | The session limit has already been raised once. |
| `build-base-changed` | 409 | — | Oturum sürerken tasarım dili başka bir yerden değişti; yayınlanırsa o değişiklik kaybolur. | The design language was changed elsewhere during this session; publishing would discard that change. |
| `sample-limit` | 409 | `max` | Bu oturumda en çok {max} örnek olabilir. | A session can have at most {max} samples. |
| `sample-too-large` | 413 | — | Dosya çok büyük. | The file is too large. |
| `sample-type` | 415 | — | Bu dosya türü kabul edilmiyor (PNG, JPG ya da PDF). | This file type is not accepted (PNG, JPG or PDF). |
| `sample-not-found` | 404 | — | Örnek bulunamadı. | Sample not found. |
| `question-unknown` | 400 | — | Cevaplanan soru bekleyen sorular arasında yok. | The answered question is not among the open questions. |
| `message-kind` | 409 | — | Bu adımda bu tür ileti gönderilemez. | This kind of message cannot be sent at this step. |
| `showcase-item-not-found` | 404 | — | Örnek etiket bulunamadı. | Sample label not found. |
| `template-exists` | 409 | `key` | "{key}" adlı şablon zaten var. | A template named "{key}" already exists. |
| `trial-failed` | 422 | `detail`* | {detail} | {detail} |
| `import-empty` | 400 | — | Dosya boş. | The file is empty. |
| `import-json-invalid` | 400 | `detail`* | Geçerli bir JSON değil: {detail} | Not valid JSON: {detail} |
| `import-no-list` | 400 | — | JSON içinde iş listesi bulunamadı. | No job list was found in the JSON. |
| `import-no-records` | 400 | — | JSON içinde iş (nesne) bulunamadı. | No jobs (objects) were found in the JSON. |
| `edit-font` | 400 | `detail`* | {detail} | {detail} |
| `not-adjustable` | 422 | — | Bu varyasyon elle düzeltilemez (yazı motor yerleşimi değil). | This variant cannot be adjusted manually (the text is not an engine layout). |
| `no-saved-adjust` | 409 | — | Bu varyasyonda kayıtlı düzeltme yok. | This variant has no saved adjustment. |
| `undo-used` | 409 | — | Bu işlem zaten geri alındı. | This action has already been undone. |
| `undo-expired` | 410 | — | Geri alma süresi doldu. | The undo period has expired. |
| `version-conflict` | 409 | — | Oturum başka bir yerde değişti; sayfayı yenileyip yeniden deneyin. | The session was changed elsewhere; reload the page and try again. |
| `printed` | 409 | — | Basılmış oturum değiştirilemez; yeniden basmak için kopyalayın. | A printed session cannot be changed; copy it to print again. |
| `printed-session-not-deletable` | 409 | — | Basılmış oturum arşivdedir ve silinmez. | A printed session is archived and cannot be deleted. |
| `template-other-language` | 400 | — | Şablon bu tasarım diline ait değil. | The template does not belong to this design language. |
| `template-archived` | 409 | — | Arşivlenmiş şablonla oturum kurulamaz. | A session cannot be set up with an archived template. |
| `print-template-required` | 400 | — | Sayfa şablonu seçin (templateId). | Choose a page template (templateId). |
| `session-template-missing` | 400 | — | Oturumun şablonu yok. | The session has no template. |
| `session-no-matching-jobs` | 400 | — | Bu şablona uyan onaylı iş yok. | No approved job fits this template. |
| `session-no-matching-jobs-quantity` | 400 | — | Bu şablona uyan onaylı iş yok. Seçilen işlerin adedi yok. | No approved job fits this template. The selected jobs have no quantity. |
| `shelf-no-matching-jobs` | 400 | — | Rafta bu şablona uyan, planlanmamış onaylı iş yok. | No unplanned approved job on the shelf fits this template. |
| `shelf-no-matching-jobs-quantity` | 400 | — | Rafta bu şablona uyan, planlanmamış onaylı iş yok. Seçilen işlerin adedi yok. | No unplanned approved job on the shelf fits this template. The selected jobs have no quantity. |
| `plan-failed` | 400 | `detail`* | Plan yapılamadı: {detail} | Planning failed: {detail} |
| `export-no-pages` | 400 | — | Oturumda basılacak sayfa yok. | The session has no pages to print. |
| `grid-diameter-required` | 400 | — | Izgara için yuva çapı gerekli. | The grid needs a slot diameter. |
| `grid-size-required` | 400 | — | Izgara için yuva genişliği ve yüksekliği gerekli. | The grid needs a slot width and height. |
| `grid-no-fit` | 400 | — | Yuvalar bu kağıda bu sayıda sığmıyor (adım sıfır ya da eksi çıktı). | That many slots do not fit on this paper (the step came out zero or negative). |
| `sticker-on-label-page` | 400 | — | Sticker etiket sayfasına konmaz; sticker sayfasına bırakın. | A sticker cannot go on a label page; drop it on a sticker page. |
| `label-on-sticker-page` | 400 | — | Etiket sticker sayfasına konmaz; etiket sayfasına bırakın. | A label cannot go on a sticker page; drop it on a label page. |
| `sticker-move-to-label` | 400 | — | Sticker etiket sayfasına taşınamaz. | A sticker cannot be moved to a label page. |
| `label-move-to-sticker` | 400 | — | Etiket sticker sayfasına taşınamaz. | A label cannot be moved to a sticker page. |
| `page-kind-mismatch` | 400 | — | Etiket sayfası sticker şablonuna (ya da tersi) çevrilemez. | A label page cannot be switched to a sticker template (or the other way round). |
| `no-approved-variant` | 400 | — | İşin onaylı varyasyonu yok; varyasyon seçin. | The job has no approved variant; choose a variant. |
| `slot-occupied` | 409 | `slot` | Yuva {slot} dolu. | Slot {slot} is taken. |
| `no-free-slot` | 409 | — | Sayfada boş yuva yok; konum verin. | There is no free slot on the page; give a position. |
| `free-position-required` | 400 | — | Serbest konum için xMm ve yMm gerekli. | A free position needs xMm and yMm. |
| `move-target-required` | 400 | — | Taşımak için yuva ya da xMm/yMm gerekli. | Moving needs a slot or xMm/yMm. |
| `id-in-use` | 400 | `id` | Kimlik zaten kullanılıyor: {id}. | ID already in use: {id}. |

## Sorunlar (114 cümle, 42 kod)

| messageKey | code | Parametreler | TR (bugünkü metin) | EN önerisi |
| --- | --- | --- | --- | --- |
| `text-missing` | = | — | Metin boş. | The text is empty. |
| `text-very-long` | = | `length`, `capacity` | Metin çok uzun ({length} karakter); bu profilde yaklaşık {capacity} karaktere kadar sığar. | The text is very long ({length} characters); this profile fits about {capacity} characters. |
| `text-very-long-lines` | `text-very-long` | `lines`, `max` | Müşteri {lines} satır vermiş; profil en fazla {max} satıra izin veriyor. | The customer gave {lines} lines; the profile allows at most {max}. |
| `text-very-long-segment` | `text-very-long` | `line`, `max` | {line}. satır {max} karakterden uzun (satır bölmeleri kesin). | Line {line} is longer than {max} characters (line breaks are fixed). |
| `text-word-too-long` | = | `words`, `max` | Tek satıra sığmayacak kadar uzun kelime: {words} (en fazla {max} karakter). | A word too long for one line: {words} (at most {max} characters). |
| `text-outer-quotes-removed` | = | — | Metni saran tırnak işaretleri kaldırıldı. | The quotation marks around the text were removed. |
| `text-unicode-styled` | = | `chars` | Süslü yazı var ({chars}). Düz harfe çevrilirse etiketin fontuyla, olduğu gibi bırakılırsa bu stille basılır. | The text has styled letters ({chars}). Converted to plain letters it prints in the label font; left as is, it prints in this style. |
| `text-unprintable` | = | `chars` | Hiçbir fontta olmayan karakter: {chars}. Basılırsa boş kutu çıkar. | Characters missing from every font: {chars}. They would print as empty boxes. |
| `text-unprintable-broken` | `text-unprintable` | `count` | Yarım kalmış karakter var (bozuk emoji ya da kopyalama hatası, {count} yerde); basılamaz. Müşterinin metnini kontrol edin. | There are broken characters (a damaged emoji or a copy error, in {count} places); they cannot be printed. Check the customer's text. |
| `text-unprintable-control` | `text-unprintable` | `chars` | Basılamayan denetim karakteri var ({chars}). | There are unprintable control characters ({chars}). |
| `text-fallback-font` | = | `chars` | Tasarım fontlarında olmayan karakterler yedek fontla basılacak: {chars}. | Characters missing from the design fonts will print with a fallback font: {chars}. |
| `text-fallback-font-partial` | `text-fallback-font` | `chars` | Bu emojiler fontta tek parça yok; parçaları yan yana basılacak: {chars}. | These emoji are not a single glyph in the font; their parts will print side by side: {chars}. |
| `text-fallback-font-mono` | `text-fallback-font` | `chars` | Bu emojiler renkli fontta yok; tek renk basılacak: {chars}. | These emoji are not in the colour font; they will print in one colour: {chars}. |
| `text-suspicious-space` | `text-suspicious` | `chars` | Alışılmadık boşluk karakteri var ({chars}). | There are unusual space characters ({chars}). |
| `text-suspicious-all-caps` | `text-suspicious` | — | Metnin tamamı büyük harf; müşteri böyle mi istiyor? | The whole text is in capitals; is that what the customer wants? |
| `text-suspicious-mixed-case` | `text-suspicious` | `words` | Kelime içinde karışık büyük/küçük harf: {words}. | Mixed upper and lower case inside a word: {words}. |
| `text-suspicious-leading-punct` | `text-suspicious` | `char` | Metin noktalama işaretiyle başlıyor ("{char}"). | The text starts with a punctuation mark ("{char}"). |
| `text-suspicious-trailing-punct` | `text-suspicious` | `char` | Metin noktalama işaretiyle bitiyor ("{char}"). | The text ends with a punctuation mark ("{char}"). |
| `text-suspicious-unbalanced` | `text-suspicious` | `chars` | Eşleşmeyen parantez/tırnak: {chars}. | Unmatched brackets or quotes: {chars}. |
| `text-suspicious-mojibake` | `text-suspicious` | `fixed` | Metin bozuk kodlanmış görünüyor (Türkçe harf ya da emoji yanlış okunmuş); doğrusu: "{fixed}". | The text looks wrongly encoded (accented letters or emoji were misread); it should be: "{fixed}". |
| `text-suspicious-escapes` | `text-suspicious` | `fixed` | Metinde kaçışlı yazılmış karakter var; çözülmüş hâli: "{fixed}". | The text contains escaped characters; decoded: "{fixed}". |
| `text-suspicious-replacement` | `text-suspicious` | — | Metinde bozuk karakter (�) var: müşterinin dosyasında kodlama hatası olabilir; asıl karakteri yazın. | The text has a broken character (�): the customer's file may have an encoding error; type the real character. |
| `template-missing` | = | — | Şablon bilgisi yok. | No template given. |
| `template-missing-input` | `template-missing` | `input` | Şablon değeri anlaşılamadı ("{input}"). | The template value could not be understood ("{input}"). |
| `template-unknown` | = | `key` | "{key}" adlı şablon bu tasarım dilinde yok. | There is no template named "{key}" in this design language. |
| `template-unknown-suggest` | `template-unknown` | `key`, `suggestions` | "{key}" adlı şablon bu tasarım dilinde yok. Şunu mu demek istediniz: {suggestions}? | There is no template named "{key}" in this design language. Did you mean: {suggestions}? |
| `template-unknown-file` | `template-unknown` | `key` | "{key}" şablonunun PNG dosyası klasörde yok. | The PNG file of template "{key}" is missing from the folder. |
| `size-unknown` | = | `size`, `defaultSize` | Etiket boyutu "{size}" tanınmadı; varsayılan {defaultSize} kullanılacak. | Label size "{size}" was not recognised; the default {defaultSize} will be used. |
| `quantity-missing` | = | — | Adet yok. | No quantity. |
| `quantity-invalid` | = | `value` | Adet geçersiz ("{value}"); pozitif tam sayı olmalı. | Invalid quantity ("{value}"); it must be a positive whole number. |
| `order-missing` | = | — | Sipariş numarası yok. | No order number. |
| `duplicate-in-file` | = | `row` | Dosyada {row}. satırla aynı iş. | Same job as row {row} in the file. |
| `duplicate-existing` | = | `batch`, `date` | Bu iş daha önce "{batch}" partisinde içe aktarılmış ({date}). | This job was already imported in batch "{batch}" ({date}). |
| `duplicate-similar-file` | `duplicate-similar` | `order`, `row` | Aynı metin ve şablon {order} numaralı siparişte de var (dosyada {row}. satır). | The same text and template are also in order {order} (row {row} in the file). |
| `duplicate-similar-batch` | `duplicate-similar` | `order`, `batch` | Aynı metin ve şablon {order} numaralı siparişte de var ("{batch}" partisi). | The same text and template are also in order {order} (batch "{batch}"). |
| `sticker-detected` | = | — | Sticker siparişi (şablonsuz, sticker sayfasına yerleşir). | Sticker order (no template; it goes on a sticker page). |
| `sticker-sheet-missing` | = | — | Bu sticker için sayfa seçilmedi. | No page was chosen for this sticker. |
| `sticker-sheet-missing-none` | `sticker-sheet-missing` | — | Profilde sticker sayfası tanımlı değil (Tasarım dili → Sticker). | The profile defines no sticker page (Design language → Sticker). |
| `sticker-sheet-missing-id` | `sticker-sheet-missing` | `sheet` | Sticker sayfası "{sheet}" profilde yok. | Sticker page "{sheet}" is not in the profile. |
| `text-changed` | = | `at`, `got`, `want` | Metin değişmiş ({at}. karakter): "{got}" ≠ "{want}" | The text was changed (character {at}): "{got}" ≠ "{want}" |
| `text-changed-generic` | `text-changed` | — | Metin değişmiş. | The text was changed. |
| `text-changed-lines` | `text-changed` | — | Satırlar müşteri metnini değiştiriyor. | The lines change the customer's text. |
| `text-changed-customer` | `text-changed` | — | Müşteri metni değişmiş. | The customer's text was changed. |
| `text-edited` | = | — | Satır metni elle düzenlendi; iş metninden farklı (yalnızca bu varyasyonda, müşteri metni değişmedi). | Line text edited by hand; it differs from the job text (only in this variant; the customer's text is unchanged). |
| `text-edited-diff` | `text-edited` | `at`, `got`, `want` | Satır metni elle düzenlendi; iş metninden farklı (yalnızca bu varyasyonda, müşteri metni değişmedi). Metin değişmiş ({at}. karakter): "{got}" ≠ "{want}" | Line text edited by hand; it differs from the job text (only in this variant; the customer's text is unchanged). The text was changed (character {at}): "{got}" ≠ "{want}" |
| `no-layout` | = | — | Metin en küçük ölçekte bile yazı alanına sığmıyor. | The text does not fit the text area even at the smallest size. |
| `text-too-small` | = | `pt`, `min` | En küçük satır {pt} pt; okunurluk sınırı {min} pt. | The smallest line is {pt} pt; the readability limit is {min} pt. |
| `text-too-small-min` | `text-too-small` | `min` | En küçük satır {min} pt altına düşüyor; metin bu dizilişle sığmıyor. | The smallest line drops below {min} pt; the text does not fit with this arrangement. |
| `text-too-small-adjust` | `text-too-small` | `pt`, `min` | Küçültme sonrası en küçük satır {pt} pt; okunurluk sınırı {min} pt. | After shrinking, the smallest line is {pt} pt; the readability limit is {min} pt. |
| `collision` | = | — | Yazı dekorla ya da kesim çizgisiyle çarpışmadan yerleştirilemedi. | The text could not be placed without hitting the decoration or the cut line. |
| `collision-cut` | `collision` | — | Yazı kesim çizgisinin dışına taşıyor; baskıda kesilir. | The text goes outside the cut line; it will be cut off when printed. |
| `collision-decoration` | `collision` | — | Yazı şablon süslemesine değiyor. | The text touches the template decoration. |
| `text-unprintable-layout` | `text-unprintable` | `chars` | Hiçbir font şu karakterleri basamıyor: {chars} | No font can print these characters: {chars} |
| `text-unprintable-kept` | `text-unprintable` | `chars` | Hiçbir font şu karakterleri basamıyor (silinmedi): {chars} | No font can print these characters (not removed): {chars} |
| `text-fallback-font-used` | `text-fallback-font` | `chars` | Tasarım fontunda olmayan karakterler yedek fontla basıldı: {chars} | Characters missing from the design font were printed with a fallback font: {chars} |
| `text-fallback-font-partial-used` | `text-fallback-font` | `chars` | Bu emojiler fontta tek parça yok; parçaları yan yana basılacak: {chars} | These emoji are not a single glyph in the font; their parts will print side by side: {chars} |
| `text-fallback-font-mono-used` | `text-fallback-font` | `chars` | Bu emojiler renkli fontta yok; tek renk basılacak: {chars} | These emoji are not in the colour font; they will print in one colour: {chars} |
| `rule-too-many-lines` | = | `lines`, `max` | {lines} satır var; en fazla {max} olmalı. | {lines} lines; there should be at most {max}. |
| `rule-line-too-long` | = | `line`, `chars`, `max` | {line}. satır {chars} karakter; sınır {max}. | Line {line} has {chars} characters; the limit is {max}. |
| `rule-lone-word` | = | `text` | "{text}" tek başına satır olmamalı; ait olduğu ifadeyle kalmalı. | "{text}" should not stand alone on a line; keep it with its phrase. |
| `rule-name-not-own-line` | = | `text` | İsim satırı ("{text}") en büyük satır değil. | The name line ("{text}") is not the largest line. |
| `rule-name-not-own-line-extra` | `rule-name-not-own-line` | `words` | İsim satırında başka kelimeler var: {words}. | The name line has other words: {words}. |
| `rule-split-greeting` | = | `first`, `second` | Kısa selam bölünmüş: "{first}" / "{second}". | A short greeting is split: "{first}" / "{second}". |
| `rule-date-own-line` | = | `text` | Tarih kendi satırında değil: "{text}". | The date is not on its own line: "{text}". |
| `rule-customer-break` | = | `line` | {line}. satır müşterinin verdiği satır bölmesine uymuyor. | Line {line} does not follow the customer's line break. |
| `rule-initials-split` | = | — | Yalnızca baş harf olan metin tek satırda olmalı. | Text made of initials only should stay on one line. |
| `font-unavailable-unknown` | `font-unavailable` | `font` | Profilde olmayan font: {font}. | Font not in the profile: {font}. |
| `font-unavailable-disabled` | `font-unavailable` | `font` | {font} profilde kapalı. | {font} is turned off in the profile. |
| `font-unavailable-special` | `font-unavailable` | `font` | {font} yalnızca özel karakter kuralları için; satır fontu olamaz. | {font} is only for special character rules; it cannot be a line font. |
| `font-unavailable-missing` | `font-unavailable` | `font` | {font} font dosyası yüklü değil. | The font file for {font} is not installed. |
| `font-unavailable-uppercase` | `font-unavailable` | `font`, `run`, `max` | {font}: metinde art arda {run} büyük harf var (sınır {max}). | {font}: the text has {run} capitals in a row (limit {max}). |
| `font-mixing` | = | `limit`, `count` | Bir etikette en fazla {limit} font ailesi olabilir; {count} kullanılmış. | A label can use at most {limit} font families; {count} were used. |
| `font-mixing-adjust` | `font-mixing` | `limit`, `count`, `families` | Tasarım dili bir etikette en fazla {limit} font ailesi istiyor; elle {count} aile kullanıldı ({families}). | The design language wants at most {limit} font families per label; {count} were used by hand ({families}). |
| `rule-too-many-lines-ai` | `rule-too-many-lines` | `lines`, `max` | {lines} satır; en fazla {max}. | {lines} lines; at most {max}. |
| `rule-lone-word-ai` | `rule-lone-word` | `text` | "{text}" tek başına satır olamaz. | "{text}" cannot stand alone on a line. |
| `rule-split-greeting-example` | `rule-split-greeting` | `text` | "{text}" bölünmüş; tasarımcının örneğinde tek satır. | "{text}" is split; it is one line in the designer's example. |
| `rule-initials-split-connector` | `rule-initials-split` | — | Baş harfler alt alta dizilmiş; tek satırda olmalı. | The initials are stacked; they should be on one line. |
| `rule-initials-split-stacked` | `rule-initials-split` | — | Baş harfler alt alta dizilmiş. | The initials are stacked. |
| `rule-couple-stack` | = | `text` | "{text}": isimler alt alta (isim / bağlaç / isim) dizilmeli. | "{text}": stack the names (name / connector / name). |
| `rule-couple-stack-connector` | `rule-couple-stack` | — | Bağlaç kendi satırında; bu tarzda isimler tek satırda kalır. | The connector is on its own line; in this style the names stay on one line. |
| `rule-name-not-own-line-ai` | `rule-name-not-own-line` | `text` | İsim satırı "{text}" ana satır değil. | The name line "{text}" is not the main line. |
| `rule-date-own-line-ai` | `rule-date-own-line` | `date` | Tarih "{date}" başka sözcüklerle aynı satırda. | The date "{date}" shares a line with other words. |
| `rule-customer-break-ai` | `rule-customer-break` | — | Müşterinin satır bölmelerinden biri korunmamış. | One of the customer's line breaks was not kept. |
| `font-unavailable-none` | `font-unavailable` | — | Bu iş için kullanılabilir font yok (font listesi, roller ve büyük harf sınırlarını kontrol edin). | No font can be used for this job (check the font list, roles and capital-letter limits). |
| `font-unavailable-catalog` | `font-unavailable` | `font` | Katalogda olmayan font: {font} | Font not in the catalogue: {font} |
| `font-unavailable-job` | `font-unavailable` | `font`, `reason`* | {font} bu işte kullanılamaz: {reason} | {font} cannot be used for this job: {reason} |
| `font-unavailable-tier` | `font-unavailable` | `font`, `tier`, `roles` | {font} "{tier}" satırında kullanılamaz (rolleri: {roles}). | {font} cannot be used on a "{tier}" line (roles: {roles}). |
| `font-mixing-candidate` | `font-mixing` | `limit`, `families` | Bu tasarım dili en fazla {limit} font ailesine izin veriyor; aday {families} kullanıyor. | This design language allows at most {limit} font families; the candidate uses {families}. |
| `ai-duplicate` | = | — | Aynı tasarım zaten var. | The same design already exists. |
| `ai-duplicate-lines` | `ai-duplicate` | — | Aynı satır bölmesi zaten gösterildi. | The same line split was already shown. |
| `ai-failed-empty-line` | `ai-failed` | — | Boş satır var. | There is an empty line. |
| `ai-failed-format` | `ai-failed` | `detail`* | Aday biçimi geçersiz: {detail} | Invalid candidate format: {detail} |
| `ai-failed-intent` | `ai-failed` | `detail`* | Niyet oluşturulamadı: {detail} | The intent could not be built: {detail} |
| `ai-unavailable` | `ai-failed` | `reason`*, `detail`* | AI kullanılamıyor: {reason}. {detail} | AI is unavailable: {reason}. {detail} |
| `ai-call-failed` | `ai-failed` | `detail`* | AI çağrısı başarısız: {detail} | The AI call failed: {detail} |
| `ai-no-good-candidate` | = | `detail`* | AI geçerli aday üretemedi: {detail} | The AI produced no valid candidate: {detail} |
| `ai-no-good-candidate-empty` | `ai-no-good-candidate` | — | AI geçerli aday üretemedi: yanıt kullanılamadı | The AI produced no valid candidate: the response could not be used |
| `generation-failed` | `ai-failed` | `detail`* | Üretim başarısız: {detail} | Generation failed: {detail} |
| `critique-issue` | = | `note`* | Görsel denetim: {note} | Visual check: {note} |
| `critique-issue-fixed` | `critique-issue` | `note`* | Görsel denetim: {note} (düzeltildi) | Visual check: {note} (fixed) |
| `image-text-unreadable` | `image-text-mismatch` | — | Görseldeki yazı okunamadı; metni gözle kontrol edin. | The text in the image could not be read; check it by eye. |
| `image-text-mismatch` | = | `text` | Görseldeki yazı müşteri metninden farklı: "{text}" | The text in the image differs from the customer's text: "{text}" |
| `image-text-different` | `image-text-mismatch` | `text` | Görseldeki yazı müşteri metniyle aynı değil (görselde: "{text}"). | The text in the image is not the customer's text (in the image: "{text}"). |
| `image-template-changed` | = | — | Görüntü modeli şablonun piksellerini değiştirdi; bu sonuç kullanılmamalı. | The image model changed the template's pixels; this result should not be used. |
| `image-template-changed-reasons` | `image-template-changed` | `reasons`* | Görüntü modeli şablonu değiştirdi ya da yazı ayrılamadı ({reasons}); şablona dokunulmadığı garanti edilemediği için sonuç kullanılmadı. | The image model changed the template or the text could not be separated ({reasons}); the result was not used because the template cannot be guaranteed untouched. |
| `template-cut-changed` | = | `template` | Şablonun ({template}) kesim şekli ya da ölçüsü değişti; onay kaldırıldı. Yerleşimi yeni kesimle kontrol edip yeniden onaylayın (gerekirse yeniden üretin). | The cut shape or size of the template ({template}) changed; the approval was removed. Check the layout with the new cut and approve again (regenerate if needed). |
| `image-template-changed-internal` | `image-template-changed` | — | İç hata: bileşikte şablon pikseli değişti; sonuç kullanılmadı. | Internal error: a template pixel changed in the composite; the result was not used. |
| `image-model-unavailable` | `ai-failed` | `detail`* | Görüntü modeli kullanılamıyor: {detail} | The image model is unavailable: {detail} |
| `image-generation-failed` | `ai-failed` | `detail`* | Görüntü üretilemedi: {detail} | The image could not be generated: {detail} |
| `image-generation-failed-unknown` | `ai-failed` | — | Görüntü üretilemedi: bilinmeyen hata | The image could not be generated: unknown error |
| `template-text-unchecked` | `image-text-mismatch` | — | Şablonda yazı olup olmadığı denetlenemedi (görsel okuyucu yok). | Could not check whether the template has text (no image reader). |
| `template-has-text` | `image-text-mismatch` | `text` | Üretilen şablonda yazı var: "{text}". | The generated template has text: "{text}". |
| `template-text-unreadable` | `image-text-mismatch` | — | Üretilen şablonda yazı olup olmadığı okunamadı. | Could not read whether the generated template has text. |
| `template-generation-failed` | `ai-failed` | `detail`* | Şablon üretilemedi: {detail} | The template could not be generated: {detail} |

## Düzeltme önerileri (26)

`value` (öneri değeri: dönüştürülmüş metin, şablon anahtarı, boyut kimliği…) ayrıca gelir; sözlükte `{{value}}` ile kullanılabilir.

| labelKey | kind | Parametreler | TR (bugünkü ad) | EN önerisi |
| --- | --- | --- | --- | --- |
| `regenerate` | = | — | Yeniden üret | Generate again |
| `retry` | `regenerate` | — | Yeniden dene | Try again |
| `revise` | = | — | Daha az satırla dene | Try with fewer lines |
| `request-fix` | `revise` | — | Bu düzeltmeyi iste | Ask for this fix |
| `edit-text` | = | — | Metni düzenle | Edit text |
| `fix-text` | `edit-text` | — | Metni düzelt | Fix text |
| `write-text` | `edit-text` | — | Metni yaz | Write text |
| `restore-quotes` | `edit-text` | — | Tırnakları geri koy | Put the quotes back |
| `normalize-spaces` | `edit-text` | — | Normal boşluğa çevir | Use normal spaces |
| `fix-encoding` | `edit-text` | — | Kodlamayı düzelt | Fix the encoding |
| `decode-escapes` | `edit-text` | — | Kaçışları çöz | Decode escapes |
| `remove-control` | `edit-text` | — | Denetim karakterlerini sil | Remove control characters |
| `convert-unicode` | = | — | Düz harfe çevir | Convert to plain letters |
| `choose-template` | = | — | Şablon seç | Choose template |
| `choose-template-key` | `choose-template` | `key` | {key} | {key} |
| `set-size` | = | `cm` | {cm} cm | {cm} cm |
| `set-quantity` | = | — | Adet yaz | Enter quantity |
| `fix-quantity` | `set-quantity` | — | Adeti düzelt | Fix quantity |
| `set-order` | = | — | Sipariş no yaz | Enter order no. |
| `open-template` | = | — | Şablonu aç | Open template |
| `upload-template` | `open-template` | — | Şablon yükle | Upload template |
| `fix-text-area` | `open-template` | — | Yazı alanını düzelt | Fix the text area |
| `skip` | = | — | Bunu alma | Don't import |
| `skip-row` | `skip` | — | Bu satırı alma | Don't import this row |
| `dismiss` | = | — | Doğru, böyle kalsın | It's correct, keep it |
| `print-as-is` | `dismiss` | — | Olduğu gibi bas | Print as is |

## Geri al bildirimi (9)

| code | Parametreler | TR (bugünkü metin) | EN önerisi |
| --- | --- | --- | --- |
| `jobs-deleted` | `count` | {count} iş silindi | {count} jobs deleted |
| `batch-deleted` | `count` | Parti ve {count} işi silindi | Batch and its {count} jobs deleted |
| `variant-deleted` | — | Varyasyon silindi | Variant deleted |
| `adjust-saved` | — | Elle düzeltme kaydedildi | Manual adjustment saved |
| `adjust-removed` | — | Elle düzeltme kaldırıldı | Manual adjustment removed |
| `print-page-deleted` | — | Baskı sayfası silindi | Print page deleted |
| `print-pages-deleted` | `count` | {count} baskı sayfası silindi | {count} print pages deleted |
| `print-session-deleted` | — | Baskı oturumu silindi | Print session deleted |
| `language-deleted` | — | Tasarım dili silindi | Design language deleted |

EN'de çoğul için i18next `_one`/`_other` önerilir (`jobs-deleted_one`: "1 job deleted").

## Baskı şablonu uyarıları (8)

| messageKey | code | Parametreler | TR (bugünkü metin) | EN önerisi |
| --- | --- | --- | --- | --- |
| `no-slots` | = | — | Şablonda yuva yok. | The template has no slots. |
| `no-slots-sticker` | `no-slots` | — | Şablonda ne yuva ne de sticker akışı var. | The template has neither slots nor a sticker flow. |
| `slot-duplicate-id` | = | `slots` | Aynı kimlikli yuvalar var: {slots}. | Slots with the same ID: {slots}. |
| `slot-outside` | = | `count`, `slots` | {count} yuva kağıt dışına taşıyor: {slots}. | {count} slots go off the paper: {slots}. |
| `slot-overlap` | = | `count`, `slots` | {count} yuva üst üste biniyor: {slots}. | {count} slots overlap: {slots}. |
| `label-larger-than-slot` | = | `diameter`, `count` | Etiket çapı ({diameter} mm) {count} yuvadan büyük; etiket yuva çizgisine taşar. | The label diameter ({diameter} mm) is larger than {count} slots; the label runs over the slot line. |
| `slot-in-printer-margin` | = | `count`, `marginMm`, `slots` | {count} yuva (taşma payı dahil) yazıcının basamadığı {marginMm} mm'lik kenara giriyor: {slots}. Kenarı eksik basılabilir. | {count} slots (bleed included) reach into the {marginMm} mm edge the printer cannot print: {slots}. The edge may print incomplete. |
| `mark-overlap` | = | `count`, `safeMm`, `slots` | Kayıt işaretleri {count} yuvaya çakışıyor ya da taşma payı + {safeMm} mm güvenli alana giriyor: {slots}. Kenardan payı değiştirin. | Registration marks hit {count} slots or enter the bleed + {safeMm} mm safe area: {slots}. Change the edge margin. |

## Baskı oturumu bildirimleri (3)

Oturum ayrıntısında `notices[]` (`code`, `message`, `params`); sözlük anahtarı `printDesk:notices.<code>`.

| code | Parametreler | TR (bugünkü metin) | EN önerisi |
| --- | --- | --- | --- |
| `plan-stale` | `sheets`, `replanSheets` | Bu oturum eski ölçülerle dizilmiş ({sheets} kağıt; sticker ölçüsü ya da bir şablonun kesimi değişti). Yeniden planlayınca yaklaşık {replanSheets} kağıt; basmadan önce yeniden planlayın. | This session was laid out with outdated sizes ({sheets} sheets; the sticker size or a template's cut changed). Replanning brings it to about {replanSheets} sheets; replan before printing. |
| `printed-old-scale` | — | Bu oturum eski sticker ölçüsüyle basıldı; dışa aktarım basıldığı gibi çıkar. Yeni ölçüyle basmak için yeniden basın ve yeniden planlayın. | This session was printed with the old sticker size; the export comes out as printed. To print with the new size, reprint and replan. |
| `sticker-small-text` | `orderNo`, `pt`, `minPt` | {orderNo}: sticker'daki en küçük yazı {pt} pt; okunurluk sınırının ({minPt} pt) altında. Sticker alanını büyütün ya da yazıyı kısaltın. | {orderNo}: the smallest sticker text is {pt} pt, below the legibility limit ({minPt} pt). Enlarge the sticker area or shorten the text. |

## Kodlanmayan metinler (serbest metin kalanlar)

- Üretim ilerleme günlüğü (`ProgressStep.message`, SSE), öğrenme durumu (`LearnStatus.message`), AI çağrısı aşama metinleri.
- İş / görev / çıktı kayıtlarındaki `error` sütunları (üretim, şablon üretimi, baskı çıktısı hatası) ve `GenerationError` metinleri
  (sorun olarak `generation-failed` + `detail` ile gelir).
- Atlanan satır / iş gerekçeleri (`skipped[].reason`: içe aktarma, üretim, baskı planı) ve baskı planı uyarıları (`warnings[]`).
- Anahtar bağlantı denemesi sonucu (`KeyTestResponse.message`).
- Doğrulama alanları (`fields[].message`) ve şema içindeki özel doğrulama cümleleri.

## Sözlük dosyası önerisi

`issues.json` içinde düzeltme adları `fix` altında. Geri al için `common.json` → `undo`, baskı uyarıları için
`printTemplates.json` → `warnings` önerilir (bu iki bölüm aşağıda ayrı).

<details><summary><code>locales/tr/errors.json</code></summary>

```json
{
  "generic": "Beklenmeyen bir hata oldu.",
  "host-not-local": "Yalnızca yerel adresten erişilebilir.",
  "origin-not-allowed": "Bu kökenden erişime izin yok.",
  "studio-header-missing": "İstek reddedildi: X-Studio başlığı eksik.",
  "not-found": "Bulunamadı.",
  "web-not-built": "Arayüz derlenmemiş.",
  "body-invalid-json": "Gövde geçerli JSON değil.",
  "request-failed": "{{detail}}",
  "server-error": "Sunucu hatası: {{detail}}",
  "request-invalid": "İstek geçersiz.",
  "query-invalid": "Sorgu geçersiz.",
  "version-invalid": "Sürüm geçersiz.",
  "version-range-invalid": "Sürüm aralığı geçersiz.",
  "learn-request-invalid": "Öğrenme isteği geçersiz.",
  "source-invalid": "Kaynak geçersiz.",
  "replay-request-invalid": "Deneme isteği geçersiz.",
  "session-invalid": "Oturum geçersiz.",
  "session-entry-invalid": "Oturum girdisi geçersiz.",
  "draft-patch-invalid": "Taslak yaması geçersiz.",
  "setting-invalid": "Ayar geçersiz.",
  "feature-invalid": "Özellik seçimi geçersiz.",
  "setup-invalid": "Kurulum cevabı geçersiz.",
  "provider-invalid": "Sağlayıcı geçersiz.",
  "key-invalid": "Anahtar geçersiz.",
  "language-package-invalid": "Tasarım dili paketi geçersiz.",
  "language-package-profile-invalid": "Paketteki profil geçersiz.",
  "trial-request-invalid": "Deneme geçersiz.",
  "reference-invalid": "Referans geçersiz.",
  "proposal-invalid": "Öneri geçersiz.",
  "profile-invalid": "Profil geçersiz; işaretli alanları düzeltin.",
  "preset-invalid": "Ön ayar geçersiz.",
  "print-template-invalid": "Baskı şablonu geçersiz.",
  "print-template-corrupt": "Baskı şablonu kaydı bozuk ({{id}}).",
  "template-record-invalid": "Şablon kaydı geçersiz.",
  "template-patch-invalid": "Şablon yaması geçersiz.",
  "template-fields-readonly": "Bu alanlar değiştirilemez.",
  "template-key-invalid": "Geçersiz şablon adı: \"{{key}}\" (harf, rakam, - ve _).",
  "language-id-invalid": "Geçersiz tasarım dili kimliği.",
  "language-id-required": "languageId gerekli.",
  "language-unknown": "Böyle bir tasarım dili yok.",
  "preview-width-range": "w 32–4000 arasında olmalı.",
  "file-name-invalid": "Geçersiz dosya adı.",
  "not-png": "Dosya PNG değil.",
  "font-file-type": "Font dosyası .ttf, .otf, .woff ya da .woff2 olmalı.",
  "font-invalid": "Dosya geçerli bir font değil.",
  "job-not-found": "İş bulunamadı.",
  "jobs-to-delete-not-found": "Silinecek iş bulunamadı.",
  "batch-not-found": "Parti bulunamadı.",
  "variant-not-found": "Varyasyon bulunamadı.",
  "preview-not-found": "Önizleme bulunamadı.",
  "text-layer-not-found": "Yazı katmanı bulunamadı.",
  "language-not-found": "Tasarım dili bulunamadı.",
  "profile-version-not-found": "Profil sürümü {{version}} bulunamadı.",
  "template-not-found": "Şablon bulunamadı.",
  "template-key-not-found": "Şablon \"{{key}}\" bulunamadı.",
  "template-image-not-found": "Şablon görseli bulunamadı.",
  "template-key-image-not-found": "Şablon \"{{key}}\" görseli bulunamadı.",
  "template-backup-not-found": "\"{{key}}\" için yedek bulunamadı.",
  "template-task-not-found": "Şablon üretim görevi bulunamadı.",
  "font-file-not-found": "Font dosyası bulunamadı.",
  "reference-not-found": "Referans bulunamadı.",
  "reference-image-not-found": "Referans görseli bulunamadı.",
  "proposal-not-found": "Öğrenme önerisi bulunamadı.",
  "ai-call-not-found": "AI çağrısı bulunamadı.",
  "trial-preview-not-found": "Deneme önizlemesi bulunamadı.",
  "undo-not-found": "Geri alma kaydı bulunamadı.",
  "print-template-not-found": "Baskı şablonu bulunamadı.",
  "preset-not-found": "Ön ayar bulunamadı.",
  "print-session-not-found": "Baskı oturumu bulunamadı.",
  "print-page-not-found": "Baskı sayfası bulunamadı.",
  "print-item-not-found": "Baskı öğesi bulunamadı.",
  "slot-not-found": "Yuva {{slot}} bulunamadı.",
  "export-not-found": "Baskı çıktısı bulunamadı.",
  "export-file-not-found": "Çıktı dosyası bulunamadı.",
  "overlay-unavailable": "Alan bindirmesi için templates paketi bağlı değil.",
  "specimen-unavailable": "Font örneği için typeset paketi bağlı değil.",
  "key-tester-unavailable": "Bağlantı denemesi bağlı değil.",
  "text-layer-unavailable": "Yazı katmanı çizimi (motor) bağlı değil.",
  "edit-unavailable": "Metin/font düzenlemesi (motor) bağlı değil.",
  "engine-preview-unavailable": "Motor bağlı değil; önizleme çizilemez.",
  "layout-engine-unavailable": "Yerleşim motoru bağlı değil.",
  "geometry-unavailable": "Şablon geometrisi bağlı değil.",
  "ai-designer-unavailable": "AI tasarımcı bağlı değil.",
  "image-generator-unavailable": "Görüntü üretimi bağlı değil.",
  "print-render-unavailable": "Baskı sayfası çizimi (motor) henüz bağlı değil.",
  "pdf-unavailable": "PDF çıktısı (motor) henüz bağlı değil.",
  "print-planner-unavailable": "Baskı sayfası planlayıcısı (@tagpress/print) henüz bağlı değil.",
  "missing-key": "{{providerName}} anahtarı yok. Ayarlar → Bağlantılar'dan {{providerName}} anahtarını girin.",
  "managed-by-platform": "Bu ayarı SellerOnData platformu yönetir; burada değiştirilmez.",
  "name-managed-by-platform": "Firma adı SellerOnData Merkez'de değişir.",
  "ai-paused": "Yapay zekâ SellerOnData'da geçici olarak durduruldu; iş başlamadı. Biraz sonra yeniden deneyin.",
  "ai-unavailable": "Yapay zekâ şu an kullanılamıyor; iş başlamadı.",
  "master-key-missing": "Ana anahtar yok ({{keys}}); anahtar şifrelenemiyor. Ana anahtarı geri koyun ya da çözülemeyen anahtarları silip uygulamayı yeniden başlatın.",
  "key-unreadable": "{{providerName}} anahtarı çözülemiyor: {{detail}} Ayarlar → Bağlantılar'dan anahtarı yeniden girin.",
  "feature-off": "Bu özellik kapalı. Ayarlar → Özellikler'den açabilirsiniz.",
  "feature-always-on": "Bu özellik her zaman açıktır; kapatılamaz.",
  "no-language": "Henüz tasarım dili yok. Önce bir tasarım dili oluşturun.",
  "no-published-profile": "Bu tasarım dilinin yayınlanmış profili yok.",
  "no-draft": "Yayınlanacak taslak yok.",
  "no-draft-profile": "Taslak profil yok.",
  "learn-running": "Bu tasarım dili için öğrenme zaten çalışıyor.",
  "learn-nothing": "Henüz referans ya da elle düzeltme yok: üretilen varyasyonları Düzelt ile düzeltin.",
  "replay-no-references": "Tekrar edilebilecek referans yok (şablonu ve görseli olan, tasarım alanı boyutunda).",
  "proposal-decided": "Bu öneri zaten karara bağlanmış.",
  "proposal-empty": "Önerinin uygulanabilir değişikliği yok.",
  "proposal-accepted": "Uygulanmış öneri reddedilemez; önce geri alın.",
  "proposal-not-applied": "Öneri uygulanmamış.",
  "proposal-no-record": "Bu önerinin uygulama kaydı yok; elle geri alın.",
  "build-not-found": "Oluşturma oturumu bulunamadı.",
  "build-active": "Bu tasarım dilinde açık bir oluşturma oturumu var.",
  "build-state": "Oturum bu adımda bu işi yapamaz.",
  "build-busy": "Oturumda çalışan bir iş var; bitmesini bekleyin.",
  "build-no-revision": "Bu revizyon henüz yok.",
  "budget-exceeded": "Yapay zekâ harcama sınırına ulaşıldı; iş başlamadı.",
  "budget-raise-used": "Oturum sınırı zaten bir kez artırıldı.",
  "build-base-changed": "Oturum sürerken tasarım dili başka bir yerden değişti; yayınlanırsa o değişiklik kaybolur.",
  "sample-limit": "Bu oturumda en çok {{max}} örnek olabilir.",
  "sample-too-large": "Dosya çok büyük.",
  "sample-type": "Bu dosya türü kabul edilmiyor (PNG, JPG ya da PDF).",
  "sample-not-found": "Örnek bulunamadı.",
  "question-unknown": "Cevaplanan soru bekleyen sorular arasında yok.",
  "message-kind": "Bu adımda bu tür ileti gönderilemez.",
  "showcase-item-not-found": "Örnek etiket bulunamadı.",
  "template-exists": "\"{{key}}\" adlı şablon zaten var.",
  "trial-failed": "{{detail}}",
  "import-empty": "Dosya boş.",
  "import-json-invalid": "Geçerli bir JSON değil: {{detail}}",
  "import-no-list": "JSON içinde iş listesi bulunamadı.",
  "import-no-records": "JSON içinde iş (nesne) bulunamadı.",
  "edit-font": "{{detail}}",
  "not-adjustable": "Bu varyasyon elle düzeltilemez (yazı motor yerleşimi değil).",
  "no-saved-adjust": "Bu varyasyonda kayıtlı düzeltme yok.",
  "undo-used": "Bu işlem zaten geri alındı.",
  "undo-expired": "Geri alma süresi doldu.",
  "version-conflict": "Oturum başka bir yerde değişti; sayfayı yenileyip yeniden deneyin.",
  "printed": "Basılmış oturum değiştirilemez; yeniden basmak için kopyalayın.",
  "printed-session-not-deletable": "Basılmış oturum arşivdedir ve silinmez.",
  "template-other-language": "Şablon bu tasarım diline ait değil.",
  "template-archived": "Arşivlenmiş şablonla oturum kurulamaz.",
  "print-template-required": "Sayfa şablonu seçin (templateId).",
  "session-template-missing": "Oturumun şablonu yok.",
  "session-no-matching-jobs": "Bu şablona uyan onaylı iş yok.",
  "session-no-matching-jobs-quantity": "Bu şablona uyan onaylı iş yok. Seçilen işlerin adedi yok.",
  "shelf-no-matching-jobs": "Rafta bu şablona uyan, planlanmamış onaylı iş yok.",
  "shelf-no-matching-jobs-quantity": "Rafta bu şablona uyan, planlanmamış onaylı iş yok. Seçilen işlerin adedi yok.",
  "plan-failed": "Plan yapılamadı: {{detail}}",
  "export-no-pages": "Oturumda basılacak sayfa yok.",
  "grid-diameter-required": "Izgara için yuva çapı gerekli.",
  "grid-size-required": "Izgara için yuva genişliği ve yüksekliği gerekli.",
  "grid-no-fit": "Yuvalar bu kağıda bu sayıda sığmıyor (adım sıfır ya da eksi çıktı).",
  "sticker-on-label-page": "Sticker etiket sayfasına konmaz; sticker sayfasına bırakın.",
  "label-on-sticker-page": "Etiket sticker sayfasına konmaz; etiket sayfasına bırakın.",
  "sticker-move-to-label": "Sticker etiket sayfasına taşınamaz.",
  "label-move-to-sticker": "Etiket sticker sayfasına taşınamaz.",
  "page-kind-mismatch": "Etiket sayfası sticker şablonuna (ya da tersi) çevrilemez.",
  "no-approved-variant": "İşin onaylı varyasyonu yok; varyasyon seçin.",
  "slot-occupied": "Yuva {{slot}} dolu.",
  "no-free-slot": "Sayfada boş yuva yok; konum verin.",
  "free-position-required": "Serbest konum için xMm ve yMm gerekli.",
  "move-target-required": "Taşımak için yuva ya da xMm/yMm gerekli.",
  "id-in-use": "Kimlik zaten kullanılıyor: {{id}}."
}
```

</details>

<details><summary><code>locales/en/errors.json</code></summary>

```json
{
  "generic": "Something went wrong.",
  "host-not-local": "Only reachable from a local address.",
  "origin-not-allowed": "Access from this origin is not allowed.",
  "studio-header-missing": "Request rejected: the X-Studio header is missing.",
  "not-found": "Not found.",
  "web-not-built": "The interface has not been built.",
  "body-invalid-json": "The request body is not valid JSON.",
  "request-failed": "{{detail}}",
  "server-error": "Server error: {{detail}}",
  "request-invalid": "The request is invalid.",
  "query-invalid": "The query is invalid.",
  "version-invalid": "The version is invalid.",
  "version-range-invalid": "The version range is invalid.",
  "learn-request-invalid": "The learning request is invalid.",
  "source-invalid": "The source is invalid.",
  "replay-request-invalid": "The replay request is invalid.",
  "session-invalid": "The session is invalid.",
  "session-entry-invalid": "The session entry is invalid.",
  "draft-patch-invalid": "The draft patch is invalid.",
  "setting-invalid": "The setting is invalid.",
  "feature-invalid": "The feature selection is not valid.",
  "setup-invalid": "The setup answer is not valid.",
  "provider-invalid": "The provider is invalid.",
  "key-invalid": "The key is invalid.",
  "language-package-invalid": "The design language package is invalid.",
  "language-package-profile-invalid": "The profile in the package is invalid.",
  "trial-request-invalid": "The trial request is invalid.",
  "reference-invalid": "The reference is invalid.",
  "proposal-invalid": "The proposal is invalid.",
  "profile-invalid": "The profile is invalid; fix the marked fields.",
  "preset-invalid": "The preset is invalid.",
  "print-template-invalid": "The print template is invalid.",
  "print-template-corrupt": "The print template record is corrupt ({{id}}).",
  "template-record-invalid": "The template record is invalid.",
  "template-patch-invalid": "The template patch is invalid.",
  "template-fields-readonly": "These fields cannot be changed.",
  "template-key-invalid": "Invalid template name: \"{{key}}\" (letters, digits, - and _).",
  "language-id-invalid": "Invalid design language ID.",
  "language-id-required": "languageId is required.",
  "language-unknown": "No such design language.",
  "preview-width-range": "w must be between 32 and 4000.",
  "file-name-invalid": "Invalid file name.",
  "not-png": "The file is not a PNG.",
  "font-file-type": "The font file must be .ttf, .otf, .woff or .woff2.",
  "font-invalid": "The file is not a valid font.",
  "job-not-found": "Job not found.",
  "jobs-to-delete-not-found": "No jobs to delete were found.",
  "batch-not-found": "Batch not found.",
  "variant-not-found": "Variant not found.",
  "preview-not-found": "Preview not found.",
  "text-layer-not-found": "Text layer not found.",
  "language-not-found": "Design language not found.",
  "profile-version-not-found": "Profile version {{version}} not found.",
  "template-not-found": "Template not found.",
  "template-key-not-found": "Template \"{{key}}\" not found.",
  "template-image-not-found": "Template image not found.",
  "template-key-image-not-found": "Image of template \"{{key}}\" not found.",
  "template-backup-not-found": "No backup found for \"{{key}}\".",
  "template-task-not-found": "Template generation task not found.",
  "font-file-not-found": "Font file not found.",
  "reference-not-found": "Reference not found.",
  "reference-image-not-found": "Reference image not found.",
  "proposal-not-found": "Learning proposal not found.",
  "ai-call-not-found": "AI call not found.",
  "trial-preview-not-found": "Trial preview not found.",
  "undo-not-found": "Undo record not found.",
  "print-template-not-found": "Print template not found.",
  "preset-not-found": "Preset not found.",
  "print-session-not-found": "Print session not found.",
  "print-page-not-found": "Print page not found.",
  "print-item-not-found": "Print item not found.",
  "slot-not-found": "Slot {{slot}} not found.",
  "export-not-found": "Print export not found.",
  "export-file-not-found": "Export file not found.",
  "overlay-unavailable": "The area overlay needs the templates package, which is not connected.",
  "specimen-unavailable": "The font specimen needs the typeset package, which is not connected.",
  "key-tester-unavailable": "The connection test is not connected.",
  "text-layer-unavailable": "Text layer drawing (engine) is not connected.",
  "edit-unavailable": "Text/font editing (engine) is not connected.",
  "engine-preview-unavailable": "The engine is not connected; the preview cannot be drawn.",
  "layout-engine-unavailable": "The layout engine is not connected.",
  "geometry-unavailable": "Template geometry is not connected.",
  "ai-designer-unavailable": "The AI designer is not connected.",
  "image-generator-unavailable": "Image generation is not connected.",
  "print-render-unavailable": "Print page drawing (engine) is not connected yet.",
  "pdf-unavailable": "PDF output (engine) is not connected yet.",
  "print-planner-unavailable": "The print page planner (@tagpress/print) is not connected yet.",
  "missing-key": "There is no {{providerName}} key. Enter your {{providerName}} key in Settings → Connections.",
  "managed-by-platform": "This setting is managed by the SellerOnData platform and cannot be changed here.",
  "name-managed-by-platform": "The company name is changed in SellerOnData Hub.",
  "ai-paused": "AI is temporarily paused on SellerOnData; nothing was started. Please try again shortly.",
  "ai-unavailable": "AI is unavailable right now; nothing was started.",
  "master-key-missing": "The master key is missing ({{keys}}); keys cannot be encrypted. Put the master key back, or delete the keys that cannot be decrypted and restart the app.",
  "key-unreadable": "The {{providerName}} key cannot be decrypted: {{detail}} Enter the key again in Settings → Connections.",
  "feature-off": "This feature is turned off. You can turn it on in Settings → Features.",
  "feature-always-on": "This feature is always on; it cannot be turned off.",
  "no-language": "There is no design language yet. Create a design language first.",
  "no-published-profile": "This design language has no published profile.",
  "no-draft": "There is no draft to publish.",
  "no-draft-profile": "There is no draft profile.",
  "learn-running": "Learning is already running for this design language.",
  "learn-nothing": "No references or manual adjustments yet: adjust the generated variants with Adjust.",
  "replay-no-references": "No references to replay (they need a template, an image and the design area size).",
  "proposal-decided": "This proposal has already been decided.",
  "proposal-empty": "The proposal has no applicable change.",
  "proposal-accepted": "An applied proposal cannot be rejected; undo it first.",
  "proposal-not-applied": "The proposal has not been applied.",
  "proposal-no-record": "There is no record of applying this proposal; undo it manually.",
  "build-not-found": "Build session not found.",
  "build-active": "There is already an open build session for this design language.",
  "build-state": "The session cannot do this at this step.",
  "build-busy": "Something is running in this session; wait for it to finish.",
  "build-no-revision": "This revision does not exist yet.",
  "budget-exceeded": "The AI spending limit was reached; nothing was started.",
  "budget-raise-used": "The session limit has already been raised once.",
  "build-base-changed": "The design language was changed elsewhere during this session; publishing would discard that change.",
  "sample-limit": "A session can have at most {{max}} samples.",
  "sample-too-large": "The file is too large.",
  "sample-type": "This file type is not accepted (PNG, JPG or PDF).",
  "sample-not-found": "Sample not found.",
  "question-unknown": "The answered question is not among the open questions.",
  "message-kind": "This kind of message cannot be sent at this step.",
  "showcase-item-not-found": "Sample label not found.",
  "template-exists": "A template named \"{{key}}\" already exists.",
  "trial-failed": "{{detail}}",
  "import-empty": "The file is empty.",
  "import-json-invalid": "Not valid JSON: {{detail}}",
  "import-no-list": "No job list was found in the JSON.",
  "import-no-records": "No jobs (objects) were found in the JSON.",
  "edit-font": "{{detail}}",
  "not-adjustable": "This variant cannot be adjusted manually (the text is not an engine layout).",
  "no-saved-adjust": "This variant has no saved adjustment.",
  "undo-used": "This action has already been undone.",
  "undo-expired": "The undo period has expired.",
  "version-conflict": "The session was changed elsewhere; reload the page and try again.",
  "printed": "A printed session cannot be changed; copy it to print again.",
  "printed-session-not-deletable": "A printed session is archived and cannot be deleted.",
  "template-other-language": "The template does not belong to this design language.",
  "template-archived": "A session cannot be set up with an archived template.",
  "print-template-required": "Choose a page template (templateId).",
  "session-template-missing": "The session has no template.",
  "session-no-matching-jobs": "No approved job fits this template.",
  "session-no-matching-jobs-quantity": "No approved job fits this template. The selected jobs have no quantity.",
  "shelf-no-matching-jobs": "No unplanned approved job on the shelf fits this template.",
  "shelf-no-matching-jobs-quantity": "No unplanned approved job on the shelf fits this template. The selected jobs have no quantity.",
  "plan-failed": "Planning failed: {{detail}}",
  "export-no-pages": "The session has no pages to print.",
  "grid-diameter-required": "The grid needs a slot diameter.",
  "grid-size-required": "The grid needs a slot width and height.",
  "grid-no-fit": "That many slots do not fit on this paper (the step came out zero or negative).",
  "sticker-on-label-page": "A sticker cannot go on a label page; drop it on a sticker page.",
  "label-on-sticker-page": "A label cannot go on a sticker page; drop it on a label page.",
  "sticker-move-to-label": "A sticker cannot be moved to a label page.",
  "label-move-to-sticker": "A label cannot be moved to a sticker page.",
  "page-kind-mismatch": "A label page cannot be switched to a sticker template (or the other way round).",
  "no-approved-variant": "The job has no approved variant; choose a variant.",
  "slot-occupied": "Slot {{slot}} is taken.",
  "no-free-slot": "There is no free slot on the page; give a position.",
  "free-position-required": "A free position needs xMm and yMm.",
  "move-target-required": "Moving needs a slot or xMm/yMm.",
  "id-in-use": "ID already in use: {{id}}."
}
```

</details>

<details><summary><code>locales/tr/issues.json</code></summary>

```json
{
  "text-missing": "Metin boş.",
  "text-very-long": "Metin çok uzun ({{length}} karakter); bu profilde yaklaşık {{capacity}} karaktere kadar sığar.",
  "text-very-long-lines": "Müşteri {{lines}} satır vermiş; profil en fazla {{max}} satıra izin veriyor.",
  "text-very-long-segment": "{{line}}. satır {{max}} karakterden uzun (satır bölmeleri kesin).",
  "text-word-too-long": "Tek satıra sığmayacak kadar uzun kelime: {{words}} (en fazla {{max}} karakter).",
  "text-outer-quotes-removed": "Metni saran tırnak işaretleri kaldırıldı.",
  "text-unicode-styled": "Süslü yazı var ({{chars}}). Düz harfe çevrilirse etiketin fontuyla, olduğu gibi bırakılırsa bu stille basılır.",
  "text-unprintable": "Hiçbir fontta olmayan karakter: {{chars}}. Basılırsa boş kutu çıkar.",
  "text-unprintable-broken": "Yarım kalmış karakter var (bozuk emoji ya da kopyalama hatası, {{count}} yerde); basılamaz. Müşterinin metnini kontrol edin.",
  "text-unprintable-control": "Basılamayan denetim karakteri var ({{chars}}).",
  "text-fallback-font": "Tasarım fontlarında olmayan karakterler yedek fontla basılacak: {{chars}}.",
  "text-fallback-font-partial": "Bu emojiler fontta tek parça yok; parçaları yan yana basılacak: {{chars}}.",
  "text-fallback-font-mono": "Bu emojiler renkli fontta yok; tek renk basılacak: {{chars}}.",
  "text-suspicious-space": "Alışılmadık boşluk karakteri var ({{chars}}).",
  "text-suspicious-all-caps": "Metnin tamamı büyük harf; müşteri böyle mi istiyor?",
  "text-suspicious-mixed-case": "Kelime içinde karışık büyük/küçük harf: {{words}}.",
  "text-suspicious-leading-punct": "Metin noktalama işaretiyle başlıyor (\"{{char}}\").",
  "text-suspicious-trailing-punct": "Metin noktalama işaretiyle bitiyor (\"{{char}}\").",
  "text-suspicious-unbalanced": "Eşleşmeyen parantez/tırnak: {{chars}}.",
  "text-suspicious-mojibake": "Metin bozuk kodlanmış görünüyor (Türkçe harf ya da emoji yanlış okunmuş); doğrusu: \"{{fixed}}\".",
  "text-suspicious-escapes": "Metinde kaçışlı yazılmış karakter var; çözülmüş hâli: \"{{fixed}}\".",
  "text-suspicious-replacement": "Metinde bozuk karakter (�) var: müşterinin dosyasında kodlama hatası olabilir; asıl karakteri yazın.",
  "template-missing": "Şablon bilgisi yok.",
  "template-missing-input": "Şablon değeri anlaşılamadı (\"{{input}}\").",
  "template-unknown": "\"{{key}}\" adlı şablon bu tasarım dilinde yok.",
  "template-unknown-suggest": "\"{{key}}\" adlı şablon bu tasarım dilinde yok. Şunu mu demek istediniz: {{suggestions}}?",
  "template-unknown-file": "\"{{key}}\" şablonunun PNG dosyası klasörde yok.",
  "size-unknown": "Etiket boyutu \"{{size}}\" tanınmadı; varsayılan {{defaultSize}} kullanılacak.",
  "quantity-missing": "Adet yok.",
  "quantity-invalid": "Adet geçersiz (\"{{value}}\"); pozitif tam sayı olmalı.",
  "order-missing": "Sipariş numarası yok.",
  "duplicate-in-file": "Dosyada {{row}}. satırla aynı iş.",
  "duplicate-existing": "Bu iş daha önce \"{{batch}}\" partisinde içe aktarılmış ({{date}}).",
  "duplicate-similar-file": "Aynı metin ve şablon {{order}} numaralı siparişte de var (dosyada {{row}}. satır).",
  "duplicate-similar-batch": "Aynı metin ve şablon {{order}} numaralı siparişte de var (\"{{batch}}\" partisi).",
  "sticker-detected": "Sticker siparişi (şablonsuz, sticker sayfasına yerleşir).",
  "sticker-sheet-missing": "Bu sticker için sayfa seçilmedi.",
  "sticker-sheet-missing-none": "Profilde sticker sayfası tanımlı değil (Tasarım dili → Sticker).",
  "sticker-sheet-missing-id": "Sticker sayfası \"{{sheet}}\" profilde yok.",
  "text-changed": "Metin değişmiş ({{at}}. karakter): \"{{got}}\" ≠ \"{{want}}\"",
  "text-changed-generic": "Metin değişmiş.",
  "text-changed-lines": "Satırlar müşteri metnini değiştiriyor.",
  "text-changed-customer": "Müşteri metni değişmiş.",
  "text-edited": "Satır metni elle düzenlendi; iş metninden farklı (yalnızca bu varyasyonda, müşteri metni değişmedi).",
  "text-edited-diff": "Satır metni elle düzenlendi; iş metninden farklı (yalnızca bu varyasyonda, müşteri metni değişmedi). Metin değişmiş ({{at}}. karakter): \"{{got}}\" ≠ \"{{want}}\"",
  "no-layout": "Metin en küçük ölçekte bile yazı alanına sığmıyor.",
  "text-too-small": "En küçük satır {{pt}} pt; okunurluk sınırı {{min}} pt.",
  "text-too-small-min": "En küçük satır {{min}} pt altına düşüyor; metin bu dizilişle sığmıyor.",
  "text-too-small-adjust": "Küçültme sonrası en küçük satır {{pt}} pt; okunurluk sınırı {{min}} pt.",
  "collision": "Yazı dekorla ya da kesim çizgisiyle çarpışmadan yerleştirilemedi.",
  "collision-cut": "Yazı kesim çizgisinin dışına taşıyor; baskıda kesilir.",
  "collision-decoration": "Yazı şablon süslemesine değiyor.",
  "text-unprintable-layout": "Hiçbir font şu karakterleri basamıyor: {{chars}}",
  "text-unprintable-kept": "Hiçbir font şu karakterleri basamıyor (silinmedi): {{chars}}",
  "text-fallback-font-used": "Tasarım fontunda olmayan karakterler yedek fontla basıldı: {{chars}}",
  "text-fallback-font-partial-used": "Bu emojiler fontta tek parça yok; parçaları yan yana basılacak: {{chars}}",
  "text-fallback-font-mono-used": "Bu emojiler renkli fontta yok; tek renk basılacak: {{chars}}",
  "rule-too-many-lines": "{{lines}} satır var; en fazla {{max}} olmalı.",
  "rule-line-too-long": "{{line}}. satır {{chars}} karakter; sınır {{max}}.",
  "rule-lone-word": "\"{{text}}\" tek başına satır olmamalı; ait olduğu ifadeyle kalmalı.",
  "rule-name-not-own-line": "İsim satırı (\"{{text}}\") en büyük satır değil.",
  "rule-name-not-own-line-extra": "İsim satırında başka kelimeler var: {{words}}.",
  "rule-split-greeting": "Kısa selam bölünmüş: \"{{first}}\" / \"{{second}}\".",
  "rule-date-own-line": "Tarih kendi satırında değil: \"{{text}}\".",
  "rule-customer-break": "{{line}}. satır müşterinin verdiği satır bölmesine uymuyor.",
  "rule-initials-split": "Yalnızca baş harf olan metin tek satırda olmalı.",
  "font-unavailable-unknown": "Profilde olmayan font: {{font}}.",
  "font-unavailable-disabled": "{{font}} profilde kapalı.",
  "font-unavailable-special": "{{font}} yalnızca özel karakter kuralları için; satır fontu olamaz.",
  "font-unavailable-missing": "{{font}} font dosyası yüklü değil.",
  "font-unavailable-uppercase": "{{font}}: metinde art arda {{run}} büyük harf var (sınır {{max}}).",
  "font-mixing": "Bir etikette en fazla {{limit}} font ailesi olabilir; {{count}} kullanılmış.",
  "font-mixing-adjust": "Tasarım dili bir etikette en fazla {{limit}} font ailesi istiyor; elle {{count}} aile kullanıldı ({{families}}).",
  "rule-too-many-lines-ai": "{{lines}} satır; en fazla {{max}}.",
  "rule-lone-word-ai": "\"{{text}}\" tek başına satır olamaz.",
  "rule-split-greeting-example": "\"{{text}}\" bölünmüş; tasarımcının örneğinde tek satır.",
  "rule-initials-split-connector": "Baş harfler alt alta dizilmiş; tek satırda olmalı.",
  "rule-initials-split-stacked": "Baş harfler alt alta dizilmiş.",
  "rule-couple-stack": "\"{{text}}\": isimler alt alta (isim / bağlaç / isim) dizilmeli.",
  "rule-couple-stack-connector": "Bağlaç kendi satırında; bu tarzda isimler tek satırda kalır.",
  "rule-name-not-own-line-ai": "İsim satırı \"{{text}}\" ana satır değil.",
  "rule-date-own-line-ai": "Tarih \"{{date}}\" başka sözcüklerle aynı satırda.",
  "rule-customer-break-ai": "Müşterinin satır bölmelerinden biri korunmamış.",
  "font-unavailable-none": "Bu iş için kullanılabilir font yok (font listesi, roller ve büyük harf sınırlarını kontrol edin).",
  "font-unavailable-catalog": "Katalogda olmayan font: {{font}}",
  "font-unavailable-job": "{{font}} bu işte kullanılamaz: {{reason}}",
  "font-unavailable-tier": "{{font}} \"{{tier}}\" satırında kullanılamaz (rolleri: {{roles}}).",
  "font-mixing-candidate": "Bu tasarım dili en fazla {{limit}} font ailesine izin veriyor; aday {{families}} kullanıyor.",
  "ai-duplicate": "Aynı tasarım zaten var.",
  "ai-duplicate-lines": "Aynı satır bölmesi zaten gösterildi.",
  "ai-failed-empty-line": "Boş satır var.",
  "ai-failed-format": "Aday biçimi geçersiz: {{detail}}",
  "ai-failed-intent": "Niyet oluşturulamadı: {{detail}}",
  "ai-unavailable": "AI kullanılamıyor: {{reason}}. {{detail}}",
  "ai-call-failed": "AI çağrısı başarısız: {{detail}}",
  "ai-no-good-candidate": "AI geçerli aday üretemedi: {{detail}}",
  "ai-no-good-candidate-empty": "AI geçerli aday üretemedi: yanıt kullanılamadı",
  "generation-failed": "Üretim başarısız: {{detail}}",
  "critique-issue": "Görsel denetim: {{note}}",
  "critique-issue-fixed": "Görsel denetim: {{note}} (düzeltildi)",
  "image-text-unreadable": "Görseldeki yazı okunamadı; metni gözle kontrol edin.",
  "image-text-mismatch": "Görseldeki yazı müşteri metninden farklı: \"{{text}}\"",
  "image-text-different": "Görseldeki yazı müşteri metniyle aynı değil (görselde: \"{{text}}\").",
  "image-template-changed": "Görüntü modeli şablonun piksellerini değiştirdi; bu sonuç kullanılmamalı.",
  "image-template-changed-reasons": "Görüntü modeli şablonu değiştirdi ya da yazı ayrılamadı ({{reasons}}); şablona dokunulmadığı garanti edilemediği için sonuç kullanılmadı.",
  "template-cut-changed": "Şablonun ({{template}}) kesim şekli ya da ölçüsü değişti; onay kaldırıldı. Yerleşimi yeni kesimle kontrol edip yeniden onaylayın (gerekirse yeniden üretin).",
  "image-template-changed-internal": "İç hata: bileşikte şablon pikseli değişti; sonuç kullanılmadı.",
  "image-model-unavailable": "Görüntü modeli kullanılamıyor: {{detail}}",
  "image-generation-failed": "Görüntü üretilemedi: {{detail}}",
  "image-generation-failed-unknown": "Görüntü üretilemedi: bilinmeyen hata",
  "template-text-unchecked": "Şablonda yazı olup olmadığı denetlenemedi (görsel okuyucu yok).",
  "template-has-text": "Üretilen şablonda yazı var: \"{{text}}\".",
  "template-text-unreadable": "Üretilen şablonda yazı olup olmadığı okunamadı.",
  "template-generation-failed": "Şablon üretilemedi: {{detail}}",
  "fix": {
    "regenerate": "Yeniden üret",
    "retry": "Yeniden dene",
    "revise": "Daha az satırla dene",
    "request-fix": "Bu düzeltmeyi iste",
    "edit-text": "Metni düzenle",
    "fix-text": "Metni düzelt",
    "write-text": "Metni yaz",
    "restore-quotes": "Tırnakları geri koy",
    "normalize-spaces": "Normal boşluğa çevir",
    "fix-encoding": "Kodlamayı düzelt",
    "decode-escapes": "Kaçışları çöz",
    "remove-control": "Denetim karakterlerini sil",
    "convert-unicode": "Düz harfe çevir",
    "choose-template": "Şablon seç",
    "choose-template-key": "{{key}}",
    "set-size": "{{cm}} cm",
    "set-quantity": "Adet yaz",
    "fix-quantity": "Adeti düzelt",
    "set-order": "Sipariş no yaz",
    "open-template": "Şablonu aç",
    "upload-template": "Şablon yükle",
    "fix-text-area": "Yazı alanını düzelt",
    "skip": "Bunu alma",
    "skip-row": "Bu satırı alma",
    "dismiss": "Doğru, böyle kalsın",
    "print-as-is": "Olduğu gibi bas"
  }
}
```

</details>

<details><summary><code>locales/en/issues.json</code></summary>

```json
{
  "text-missing": "The text is empty.",
  "text-very-long": "The text is very long ({{length}} characters); this profile fits about {{capacity}} characters.",
  "text-very-long-lines": "The customer gave {{lines}} lines; the profile allows at most {{max}}.",
  "text-very-long-segment": "Line {{line}} is longer than {{max}} characters (line breaks are fixed).",
  "text-word-too-long": "A word too long for one line: {{words}} (at most {{max}} characters).",
  "text-outer-quotes-removed": "The quotation marks around the text were removed.",
  "text-unicode-styled": "The text has styled letters ({{chars}}). Converted to plain letters it prints in the label font; left as is, it prints in this style.",
  "text-unprintable": "Characters missing from every font: {{chars}}. They would print as empty boxes.",
  "text-unprintable-broken": "There are broken characters (a damaged emoji or a copy error, in {{count}} places); they cannot be printed. Check the customer's text.",
  "text-unprintable-control": "There are unprintable control characters ({{chars}}).",
  "text-fallback-font": "Characters missing from the design fonts will print with a fallback font: {{chars}}.",
  "text-fallback-font-partial": "These emoji are not a single glyph in the font; their parts will print side by side: {{chars}}.",
  "text-fallback-font-mono": "These emoji are not in the colour font; they will print in one colour: {{chars}}.",
  "text-suspicious-space": "There are unusual space characters ({{chars}}).",
  "text-suspicious-all-caps": "The whole text is in capitals; is that what the customer wants?",
  "text-suspicious-mixed-case": "Mixed upper and lower case inside a word: {{words}}.",
  "text-suspicious-leading-punct": "The text starts with a punctuation mark (\"{{char}}\").",
  "text-suspicious-trailing-punct": "The text ends with a punctuation mark (\"{{char}}\").",
  "text-suspicious-unbalanced": "Unmatched brackets or quotes: {{chars}}.",
  "text-suspicious-mojibake": "The text looks wrongly encoded (accented letters or emoji were misread); it should be: \"{{fixed}}\".",
  "text-suspicious-escapes": "The text contains escaped characters; decoded: \"{{fixed}}\".",
  "text-suspicious-replacement": "The text has a broken character (�): the customer's file may have an encoding error; type the real character.",
  "template-missing": "No template given.",
  "template-missing-input": "The template value could not be understood (\"{{input}}\").",
  "template-unknown": "There is no template named \"{{key}}\" in this design language.",
  "template-unknown-suggest": "There is no template named \"{{key}}\" in this design language. Did you mean: {{suggestions}}?",
  "template-unknown-file": "The PNG file of template \"{{key}}\" is missing from the folder.",
  "size-unknown": "Label size \"{{size}}\" was not recognised; the default {{defaultSize}} will be used.",
  "quantity-missing": "No quantity.",
  "quantity-invalid": "Invalid quantity (\"{{value}}\"); it must be a positive whole number.",
  "order-missing": "No order number.",
  "duplicate-in-file": "Same job as row {{row}} in the file.",
  "duplicate-existing": "This job was already imported in batch \"{{batch}}\" ({{date}}).",
  "duplicate-similar-file": "The same text and template are also in order {{order}} (row {{row}} in the file).",
  "duplicate-similar-batch": "The same text and template are also in order {{order}} (batch \"{{batch}}\").",
  "sticker-detected": "Sticker order (no template; it goes on a sticker page).",
  "sticker-sheet-missing": "No page was chosen for this sticker.",
  "sticker-sheet-missing-none": "The profile defines no sticker page (Design language → Sticker).",
  "sticker-sheet-missing-id": "Sticker page \"{{sheet}}\" is not in the profile.",
  "text-changed": "The text was changed (character {{at}}): \"{{got}}\" ≠ \"{{want}}\"",
  "text-changed-generic": "The text was changed.",
  "text-changed-lines": "The lines change the customer's text.",
  "text-changed-customer": "The customer's text was changed.",
  "text-edited": "Line text edited by hand; it differs from the job text (only in this variant; the customer's text is unchanged).",
  "text-edited-diff": "Line text edited by hand; it differs from the job text (only in this variant; the customer's text is unchanged). The text was changed (character {{at}}): \"{{got}}\" ≠ \"{{want}}\"",
  "no-layout": "The text does not fit the text area even at the smallest size.",
  "text-too-small": "The smallest line is {{pt}} pt; the readability limit is {{min}} pt.",
  "text-too-small-min": "The smallest line drops below {{min}} pt; the text does not fit with this arrangement.",
  "text-too-small-adjust": "After shrinking, the smallest line is {{pt}} pt; the readability limit is {{min}} pt.",
  "collision": "The text could not be placed without hitting the decoration or the cut line.",
  "collision-cut": "The text goes outside the cut line; it will be cut off when printed.",
  "collision-decoration": "The text touches the template decoration.",
  "text-unprintable-layout": "No font can print these characters: {{chars}}",
  "text-unprintable-kept": "No font can print these characters (not removed): {{chars}}",
  "text-fallback-font-used": "Characters missing from the design font were printed with a fallback font: {{chars}}",
  "text-fallback-font-partial-used": "These emoji are not a single glyph in the font; their parts will print side by side: {{chars}}",
  "text-fallback-font-mono-used": "These emoji are not in the colour font; they will print in one colour: {{chars}}",
  "rule-too-many-lines": "{{lines}} lines; there should be at most {{max}}.",
  "rule-line-too-long": "Line {{line}} has {{chars}} characters; the limit is {{max}}.",
  "rule-lone-word": "\"{{text}}\" should not stand alone on a line; keep it with its phrase.",
  "rule-name-not-own-line": "The name line (\"{{text}}\") is not the largest line.",
  "rule-name-not-own-line-extra": "The name line has other words: {{words}}.",
  "rule-split-greeting": "A short greeting is split: \"{{first}}\" / \"{{second}}\".",
  "rule-date-own-line": "The date is not on its own line: \"{{text}}\".",
  "rule-customer-break": "Line {{line}} does not follow the customer's line break.",
  "rule-initials-split": "Text made of initials only should stay on one line.",
  "font-unavailable-unknown": "Font not in the profile: {{font}}.",
  "font-unavailable-disabled": "{{font}} is turned off in the profile.",
  "font-unavailable-special": "{{font}} is only for special character rules; it cannot be a line font.",
  "font-unavailable-missing": "The font file for {{font}} is not installed.",
  "font-unavailable-uppercase": "{{font}}: the text has {{run}} capitals in a row (limit {{max}}).",
  "font-mixing": "A label can use at most {{limit}} font families; {{count}} were used.",
  "font-mixing-adjust": "The design language wants at most {{limit}} font families per label; {{count}} were used by hand ({{families}}).",
  "rule-too-many-lines-ai": "{{lines}} lines; at most {{max}}.",
  "rule-lone-word-ai": "\"{{text}}\" cannot stand alone on a line.",
  "rule-split-greeting-example": "\"{{text}}\" is split; it is one line in the designer's example.",
  "rule-initials-split-connector": "The initials are stacked; they should be on one line.",
  "rule-initials-split-stacked": "The initials are stacked.",
  "rule-couple-stack": "\"{{text}}\": stack the names (name / connector / name).",
  "rule-couple-stack-connector": "The connector is on its own line; in this style the names stay on one line.",
  "rule-name-not-own-line-ai": "The name line \"{{text}}\" is not the main line.",
  "rule-date-own-line-ai": "The date \"{{date}}\" shares a line with other words.",
  "rule-customer-break-ai": "One of the customer's line breaks was not kept.",
  "font-unavailable-none": "No font can be used for this job (check the font list, roles and capital-letter limits).",
  "font-unavailable-catalog": "Font not in the catalogue: {{font}}",
  "font-unavailable-job": "{{font}} cannot be used for this job: {{reason}}",
  "font-unavailable-tier": "{{font}} cannot be used on a \"{{tier}}\" line (roles: {{roles}}).",
  "font-mixing-candidate": "This design language allows at most {{limit}} font families; the candidate uses {{families}}.",
  "ai-duplicate": "The same design already exists.",
  "ai-duplicate-lines": "The same line split was already shown.",
  "ai-failed-empty-line": "There is an empty line.",
  "ai-failed-format": "Invalid candidate format: {{detail}}",
  "ai-failed-intent": "The intent could not be built: {{detail}}",
  "ai-unavailable": "AI is unavailable: {{reason}}. {{detail}}",
  "ai-call-failed": "The AI call failed: {{detail}}",
  "ai-no-good-candidate": "The AI produced no valid candidate: {{detail}}",
  "ai-no-good-candidate-empty": "The AI produced no valid candidate: the response could not be used",
  "generation-failed": "Generation failed: {{detail}}",
  "critique-issue": "Visual check: {{note}}",
  "critique-issue-fixed": "Visual check: {{note}} (fixed)",
  "image-text-unreadable": "The text in the image could not be read; check it by eye.",
  "image-text-mismatch": "The text in the image differs from the customer's text: \"{{text}}\"",
  "image-text-different": "The text in the image is not the customer's text (in the image: \"{{text}}\").",
  "image-template-changed": "The image model changed the template's pixels; this result should not be used.",
  "image-template-changed-reasons": "The image model changed the template or the text could not be separated ({{reasons}}); the result was not used because the template cannot be guaranteed untouched.",
  "template-cut-changed": "The cut shape or size of the template ({{template}}) changed; the approval was removed. Check the layout with the new cut and approve again (regenerate if needed).",
  "image-template-changed-internal": "Internal error: a template pixel changed in the composite; the result was not used.",
  "image-model-unavailable": "The image model is unavailable: {{detail}}",
  "image-generation-failed": "The image could not be generated: {{detail}}",
  "image-generation-failed-unknown": "The image could not be generated: unknown error",
  "template-text-unchecked": "Could not check whether the template has text (no image reader).",
  "template-has-text": "The generated template has text: \"{{text}}\".",
  "template-text-unreadable": "Could not read whether the generated template has text.",
  "template-generation-failed": "The template could not be generated: {{detail}}",
  "fix": {
    "regenerate": "Generate again",
    "retry": "Try again",
    "revise": "Try with fewer lines",
    "request-fix": "Ask for this fix",
    "edit-text": "Edit text",
    "fix-text": "Fix text",
    "write-text": "Write text",
    "restore-quotes": "Put the quotes back",
    "normalize-spaces": "Use normal spaces",
    "fix-encoding": "Fix the encoding",
    "decode-escapes": "Decode escapes",
    "remove-control": "Remove control characters",
    "convert-unicode": "Convert to plain letters",
    "choose-template": "Choose template",
    "choose-template-key": "{{key}}",
    "set-size": "{{cm}} cm",
    "set-quantity": "Enter quantity",
    "fix-quantity": "Fix quantity",
    "set-order": "Enter order no.",
    "open-template": "Open template",
    "upload-template": "Upload template",
    "fix-text-area": "Fix the text area",
    "skip": "Don't import",
    "skip-row": "Don't import this row",
    "dismiss": "It's correct, keep it",
    "print-as-is": "Print as is"
  }
}
```

</details>

<details><summary><code>common.json</code> → <code>undo</code> ve <code>printTemplates.json</code> → <code>warnings</code> (tr / en)</summary>

```json
{
  "tr": {
    "undo": {
      "jobs-deleted": "{{count}} iş silindi",
      "batch-deleted": "Parti ve {{count}} işi silindi",
      "variant-deleted": "Varyasyon silindi",
      "adjust-saved": "Elle düzeltme kaydedildi",
      "adjust-removed": "Elle düzeltme kaldırıldı",
      "print-page-deleted": "Baskı sayfası silindi",
      "print-pages-deleted": "{{count}} baskı sayfası silindi",
      "print-session-deleted": "Baskı oturumu silindi",
      "language-deleted": "Tasarım dili silindi"
    },
    "warnings": {
      "no-slots": "Şablonda yuva yok.",
      "no-slots-sticker": "Şablonda ne yuva ne de sticker akışı var.",
      "slot-duplicate-id": "Aynı kimlikli yuvalar var: {{slots}}.",
      "slot-outside": "{{count}} yuva kağıt dışına taşıyor: {{slots}}.",
      "slot-overlap": "{{count}} yuva üst üste biniyor: {{slots}}.",
      "label-larger-than-slot": "Etiket çapı ({{diameter}} mm) {{count}} yuvadan büyük; etiket yuva çizgisine taşar.",
      "slot-in-printer-margin": "{{count}} yuva (taşma payı dahil) yazıcının basamadığı {{marginMm}} mm'lik kenara giriyor: {{slots}}. Kenarı eksik basılabilir.",
      "mark-overlap": "Kayıt işaretleri {{count}} yuvaya çakışıyor ya da taşma payı + {{safeMm}} mm güvenli alana giriyor: {{slots}}. Kenardan payı değiştirin."
    }
  },
  "en": {
    "undo": {
      "jobs-deleted": "{{count}} jobs deleted",
      "batch-deleted": "Batch and its {{count}} jobs deleted",
      "variant-deleted": "Variant deleted",
      "adjust-saved": "Manual adjustment saved",
      "adjust-removed": "Manual adjustment removed",
      "print-page-deleted": "Print page deleted",
      "print-pages-deleted": "{{count}} print pages deleted",
      "print-session-deleted": "Print session deleted",
      "language-deleted": "Design language deleted"
    },
    "warnings": {
      "no-slots": "The template has no slots.",
      "no-slots-sticker": "The template has neither slots nor a sticker flow.",
      "slot-duplicate-id": "Slots with the same ID: {{slots}}.",
      "slot-outside": "{{count}} slots go off the paper: {{slots}}.",
      "slot-overlap": "{{count}} slots overlap: {{slots}}.",
      "label-larger-than-slot": "The label diameter ({{diameter}} mm) is larger than {{count}} slots; the label runs over the slot line.",
      "slot-in-printer-margin": "{{count}} slots (bleed included) reach into the {{marginMm}} mm edge the printer cannot print: {{slots}}. The edge may print incomplete.",
      "mark-overlap": "Registration marks hit {{count}} slots or enter the bleed + {{safeMm}} mm safe area: {{slots}}. Change the edge margin."
    }
  }
}
```

</details>
