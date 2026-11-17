# Kod haritası — DeciShip paneli

Yollar depo köküne göredir.

## DeciShip paneli

Kök `Deciship/apps/web` (React 19, Vite, react-router, TanStack Query, i18next). `/deciship/` altında yayınlanır.

| Dosya | Ne işe yarar |
|---|---|
| `Deciship/apps/web/src/App.tsx` | Yönlendirme ve sayfa izinleri (`Require`, `NavGuard`). |
| `Deciship/apps/web/src/api/client.ts`, `session.ts` | `request`, `download`, hata sınıfı; oturum, CSRF, dil başlığı kabuktan. |
| `Deciship/apps/web/src/api/endpoints.ts` | Her API çağrısı tek yerde. |
| `Deciship/apps/web/src/api/types.ts` | API yanıt tipleri; serileştiricilerle **elle** eş tutulur, otomatik denetim yok. |
| `Deciship/apps/web/src/mocks/browser.ts` | Sahte sunucu (MSW, `npm run dev:mock`, `VITE_MOCK=1`); Playwright testleri bununla koşar. `mocks/disputes.ts` itiraz, `mocks/account.ts` hesap/Merkez taklidi. |
| `Deciship/apps/web/src/pages/` | Sayfalar (ayrıntı aşağıda "Sayfalar"). |
| `Deciship/apps/web/src/components/ui.tsx`, `Toast.tsx`, `Icon.tsx` | **Artık kabuktan yeniden dışa aktarma**: `ui.tsx` 143 satır, `Toast.tsx` 3, `Icon.tsx` 2. Bileşenin kendisi `Platform/packages/shell/src/primitives.tsx` (`Button`, `ActionMenu`, `Tag`, `Card`, `Modal` (`busy`, `dirty`, `guard`; kirliyken kapatmadan önce sarı onay şeridi), `Field`, `Pager`, `Empty`, `ErrorState`, `TableSkeleton`, `ToastProvider` (`suppress`, `actionPlacement`)) ve `icons.tsx`. Yalnız DeciShip'e özgü olanlar `ui.tsx`'te kalır: `StatusTag`, `DecisionTag`, `DiffTags`, `SidePanel`. Bileşen davranışını değiştirmek için kabuğu düzenle; Merkez de etkilenir. |
| `Deciship/apps/web/src/components/` (diğer) | `Shell.tsx` (kabuk + menü; firma değişiminde kaydedilmemiş değişiklik onayı, çıkış sonucu; `supportHref`), `DemoBanner.tsx` (deneme bandı ve "Denemeyi bitir"), `LeaveGuard.tsx` (`useLeaveGuard`: sayfa çıkış uyarısı + `LeaveConfirm`), `TariffSelect`, `TariffLink`, `NumberPasteGuard`, `UpdateBanner`, `Photos`. |
| `Deciship/apps/web/src/lib/` | Saf mantık ve yardımcılar (ayrıntı aşağıda "lib/ dosyaları"). |
| `Deciship/apps/web/src/lib/jobs.ts`, `src/lib/useJob.ts`, `src/components/JobProgress.tsx` | **Arka plan işleri**: `jobs.ts` saf yardımcılar (aşama anahtarı, hâl: sırada/sürüyor/durduruluyor/bitti, süre metni); `useJob` işi bitene dek yoklar (gizli sayfada seyrek), bitince `onFinish` çağırır; sayfalar yeniden açılınca süren işi `GET /jobs?active=1` ile bulup bağlanır; `JobProgress` ilerleme çubuğu, geçen süre ve "Durdur". |
| `Deciship/apps/web/src/pages/invoice-upload/liveFile.ts` | Önizlemesi çıkmış dosyanın "vazgeçilirse sunucuda silinir" kararı (saf): `live`/`importing`; içe aktarma sürerken dosya hiçbir yoldan silinmez; yeniden okumada eski dosya yenisi uygulanınca silinir (`previewArrived`). Test `test/live-file.test.ts`. |
| `Deciship/apps/web/src/pages/invoice-upload/wizardKeep.ts` | Sihirbaz emeği korur (saf): 1. adımda "Devam" (`canContinue`), taşıyıcı ve dosya seçiminin planı (`planCarrierPick`, `planFilePick`: okuma yok / önizlemeye dön / PDF'te yalnız taşıyıcı değişir / eski önizlemeyi tutarak oku / önce sor), düzeltme var mı (`isEdited`), taşıyıcı başına tarife (`switchTariff`), "Yeniden oku"da çift ücret yok (`rereadFresh`). Test `test/wizard-keep.test.ts`; ekranda `e2e/upload-keep.spec.ts` (taklit kancaları `sod_mock_ai_quota` PDF'te 429, `sod_mock_job_fail`, `sod_mock_ai_hold` yapay zekâ eşlemesini bekletir, `sod_mock_third_carrier` üçüncü taşıyıcı). |
| `Deciship/apps/web/src/pages/invoice-upload/ResumeBand.tsx`, `useKeepPreview.ts`, `resume.ts` | Sürdürme bandı ("Okunan PDF hazır · Devam et"); açık önizlemede çalışılırken tazeleme (`keepAliveDue`); "Dosyayı bize gönderin" (`isFileProblem`, `sendFileHref`). Kurulum örnek PDF'i `pages/onboarding/samplePdf.ts`. Test `test/upload-resume.test.ts`. |
| `Deciship/apps/web/src/pages/onboarding/company.ts`, `HubCompany.tsx` | Kurulum sihirbazının Merkez firma satırı (ayrıntı aşağıda "Merkez firma satırı"). |
| `Deciship/apps/web/src/pages/invoice-detail/BulkBand.tsx`, `bulkAnnounce.ts` | Toplu geçiş işi bilgi bandı (tarife düzenleyici ve Ayarlar; süren işe bağlanır, eylem yok) ve bitiş iletisi (yazılan fatura sayısı, "kalanı durduruldu"); pencere (`RecalcDialog.tsx`) ilerlemeyi aynı bileşenle gösterir. |
| `Deciship/apps/web/src/locales/{tr,en}/<ad>.json` | Sözlükler; dosya adı = ad alanı (`common`, `invoices`, `invoiceDetail`, `invoiceUpload`, `tariffs`, `tariffEditor`, `tariffImport`, `measurements`, `disputes`, `settings`, `onboarding`, `dashboard`, `platform`). |
| `Deciship/apps/web/src/styles/app.css`, `styles/pages/*.css`, `styles/tokens.deciship.css` | `app.css` yalnız DeciShip'e özgü kuralları ve en sonda "DeciShip farkları" bölümünü taşır (her kuralın yorumunda kabuk değeri); ortak bileşen stili kabuğun `primitives.css`'inden gelir. `tokens.deciship.css` üretilir (elle düzenlenmez). **Yükleme sırası (`main.tsx`): tokens → tokens.deciship → shell → primitives → app → pages**; sıra çakışan seçicide kazananı belirler. |

Sayfalar (`Deciship/apps/web/src/pages/`):

- `Dashboard`, `Invoices`, `Tariffs`, `TariffImport`, `Settings`, `onboarding/` (kurulum sihirbazı).
- `InvoiceDetail` + `invoice-detail/`: `Header` (rozetler telefonda alt satırda), `BulkBar` + `bulk.ts` (toplu seçim bandı ve saf seçim modeli: kimlikle ya da süzgeçle seçim), `Summary`, `ImportReport` (alınmayan satırlar uyarısı ve pencere) + `reportLogic.ts`, `HowComputed` ("Nasıl hesaplandı?"), `LineTable`, `LinePanel`, `EditDialog`, `Dispute*` (ZIP bağlantısı `DisputeDialog`), `TariffHealth`, `RecalcDialog` + `recalc.ts`.
- `InvoiceUpload` + `invoice-upload/`: `StepOne`, `MappingStep`, `MetaStep`, `PdfStep` (PDF metin denetimi işaretleri), `Verification`, `acceptList.ts` (PDF okuma kapalıyken PDF'siz kabul listesi).
- `TariffEditor` + `tariff-editor/`: `draft.ts` form durumu, `BasicSections`, `RateGrid`, `ZonesSurcharges`, `CountryAdjustments`, `VersionsSection`, `QuoteBox`.
- `TariffPdfImport` + `tariff-import/`; `Measurements` + `measurements/`; `Disputes` + `disputes/parts.tsx`.

`src/lib/` dosyaları:

- `permissions.ts` (görünürlük tek yer), `labels.ts` (durum/fark etiketleri `common` sözlüğünden), `format.ts`, `currency.ts`, `disputes.ts`, `onboarding.ts`, `returnTo.ts`, `numberPaste.ts`.
- `modalGuard.ts` (pencere kapatma kararı `closeDecision`, `isTrackedField`), `leaveGuard.ts` (`shouldBlockLeave`), `unsavedChanges.ts` (sekme kapanma uyarısı, `hasUnsavedChanges`, `allowUnload`).
- `disputeMail.ts`: itiraz e-postası (`mailtoHref`, 1.800 sınırı `MAILTO_MAX`, `mailPlan`, dil onayı `needsLangConfirm`, hatırlanan adres anahtarı, imza başlıkları `signatureHeaders`). İtiraz penceresi iç fark raporunu (Excel/PDF) önermez (KALANLAR 1.11).
- `features.ts`: geri alma bayrakları `bulkDecide`, `invoiceSearch`, `demoTour`.

Merkez firma satırı (`pages/onboarding/company.ts`, `HubCompany.tsx`):

- Onay `companyConfirmed` (Merkez `/me` `isCompanyConfirmed`, yoksa `/settings/onboarding` `company.confirmed`), gösterilen firma bilgisi, Merkez'e dönüş bağlantısı `hubConfirmHref`; onaysızken "Önce firma bilgileri" kapısı.
- Karşı uçlar: Hesap `PATCH /org` `confirmCompany`, `Organization.companyConfirmedAt`, `org.updated` `companyConfirmed` → DeciShip `identity.ts` → `settings.companyConfirmed` (`companyConfirmedOf`) → `onboardingFlags`.
- Merkez: `pages/Home.tsx` (Merkez kurulumu + Araç kurulumları), `lib/setupLayout.ts`, `pages/account/Company.tsx`.

Sık yapılan işler:

| İş | Bakılacak dosyalar | Koşulacak testler |
|---|---|---|
| Yeni arayüz metni | İlgili `src/locales/tr/<ad>.json` **ve** `en/<ad>.json` (aynı anahtar); kodda `t('ad:anahtar')`. Denetim dört yüzeyde aynı ortak betiktir: `Platform/scripts/check-i18n.mjs` (satır içi istisna `// i18n-ok: <neden>`). Kullanılmayan anahtar: kökte `npm run i18n:unused` (`Platform/scripts/unused-i18n.mjs`; `--all` şüphelileri, `--delete-list <dosya>` elle incelenmiş listeyi siler) | `npm run check:i18n` (`--strict`: kodda kalan Türkçe, eksik anahtar ve uyarılar hata; yasak sözcük listesi de denetlenir) |
| Yeni renk ya da ölçü | `Platform/packages/tokens/tokens.json` (yalnız orada), sonra `npm --prefix Platform/packages/tokens run build`; üretilen dosyaları elle düzenleme. Yüzeye özgü fark ise `surfaces.*` altına, yorumuyla | `node Platform/packages/tokens/build.mjs --check`, `npm --prefix Platform/packages/tokens test`, `npm run test:visual` |
| Para, sayı ya da tarih biçimi | `Platform/packages/format/src/index.ts` (yalnız orada; yüzey sarmalayıcıları ince kalır) | `Platform/packages/format` `npm test`, dört `formatGolden` testi |
| API yanıtı değişti | `src/api/types.ts`, `src/api/endpoints.ts`, `src/mocks/browser.ts` (ve `mocks/disputes.ts`) | `npm run typecheck`, ilgili `e2e/*.spec.ts` |
| Saf mantık ekleme | `src/lib/*.ts` ya da sayfa yanında `*.ts` (tarayıcısız sınanır) | `test/*.test.ts` (ör. `recalc`, `disputes`, `permissions`, `decision-visible`, `tariff-notice`, `tariff-draft` (tarife taslağı: bölge sütunu, okunamayan oran, çakışma kararı), `import-report`, `upload-accept`, `modal-guard`, `leave-guard`, `jobs`, `live-file`, `bulk-select`, `dispute-mail`, `pdf-row-parse` (PDF düzenleme tablosu: kg/ölçü `parseMeasure`, "Devam"ı durduran hücre; `invoice-upload/pdfRowParse.ts`), `vat-input` (eşlemedeki KDV oranı kutusu, `invoice-upload/vatInput.ts`), `wizard-keep` (yükleme sihirbazında "Geri"/"Devam", yeniden okuma kararı; `invoice-upload/wizardKeep.ts`)) |
| Toplu seçim, arama, deneme turu ekranları | Toplu seçim `invoice-detail/BulkBar.tsx`, `bulk.ts`, `styles/pages/bulk.css`; arama `pages/Invoices.tsx`; deneme `components/DemoBanner.tsx`, `pages/onboarding/Onboarding.tsx`, `styles/pages/demo.css`; itiraz penceresi `invoice-detail/DisputeDialog.tsx` + `lib/disputeMail.ts`; bayraklar `lib/features.ts` | `e2e/bulk.spec.ts`, `invoice-search.spec.ts`, `demo.spec.ts`, `disputes.spec.ts` |
| Pencere ya da sayfa çıkış koruması | kabukta `Platform/packages/shell/src/primitives.tsx` `Modal` + `modalGuard.ts` (`src/components/ui.tsx` ve `src/lib/modalGuard.ts` yeniden dışa aktarır), `src/components/LeaveGuard.tsx`, `src/lib/leaveGuard.ts`, `src/lib/unsavedChanges.ts`; metinler `common.json` `modalGuard.*`, `platform.json` `leave.*`; stil kabuğun `primitives.css` `.modal-guard`; metinler artık kabuk `shell.json` `modalGuard.*` | `node --test test/modal-guard.test.ts test/leave-guard.test.ts`, `e2e/unsaved-guards.spec.ts` |
| Fatura okuma iptali | `src/pages/InvoiceUpload.tsx` (`startRead`, `stopRead`), `invoice-upload/StepOne.tsx` ("Okumayı durdur"), `src/api/endpoints.ts` `preview(…, signal)`; taklit kancası `localStorage.sod_mock_preview_delay` (`mocks/browser.ts`) | `e2e/unsaved-guards.spec.ts`, `e2e/upload-keep.spec.ts` |
| Yeni sayfa | `src/App.tsx`, `src/components/Shell.tsx` menüsü, `src/lib/permissions.ts`, yeni sözlük dosyası (TR+EN), `src/styles/pages/` | `typecheck`, `check:i18n`, `e2e/smoke.spec.ts` |
