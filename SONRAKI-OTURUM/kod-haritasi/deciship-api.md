# Kod haritası — DeciShip API

Yollar depo köküne göredir. `src/services/` altı için: `SONRAKI-OTURUM/kod-haritasi/deciship-api-servisler.md`.

## DeciShip API

Kök `Deciship/apps/api` (Fastify 5, Prisma 7, Postgres). Bütün uçlar `/api/deciship` önekiyle `src/app.ts` içinde kaydedilir.

| Dosya | Ne işe yarar |
|---|---|
| `Deciship/apps/api/src/main.ts` | Giriş: ortam denetimi, şema denetimi (`lib/schemaCheck.ts`), bakım işi, dinleme. |
| `Deciship/apps/api/src/app.ts` | `buildApp`: rota kaydı, `routeTable` (testler buradan uç listesi üretir), fiyat izni yoksa para alanlarını silen `stripMoney`, istek başına firma bağlamı. |
| `Deciship/apps/api/src/identity.ts` | Jeton doğrulama (auth-kit), Company/Member izdüşümü, Hesap olayları (`POST /internal/events`, auth-kit kaydeder). |
| `Deciship/apps/api/src/db.ts` | Prisma istemcisi, RLS bağlamı (`withCompany`, `runInCompany`, `setTxCompany`, olay ve bakım kapsamı), `TX_DEFAULTS`. |
| `Deciship/apps/api/src/errors.ts` | `AppError`, `badRequest`, `notFound`, `conflict`; zod hatasının çevirisi. |
| `Deciship/apps/api/src/i18n/messages.ts`, `index.ts` | API'nin kullanıcıya dönen metinleri (`m(key)`, TR+EN tek nesnede); istek dili `Accept-Language`. |
| `Deciship/apps/api/src/lib/access.ts` | `can(req, izin)`, `requireAny`. Kod rol adına bakmaz, izne bakar. |
| `Deciship/apps/api/src/lib/settings.ts` | Firma ayarları tipi, varsayılanlar (`defaultAmountTol`: para birimine göre tutar toleransı), `settingsFor` (kim hangi ayarı görür), kurulum adımları. |
| `Deciship/apps/api/src/lib/zip.ts` | Sıkıştırmasız akışlı ZIP yazıcısı (`zipStream`, `isSafeZipName`); bağımlılık yok. |
| `Deciship/apps/api/src/lib/audit.ts` | `audit(companyId, userId, action, entity, id, data)`: denetim kaydı; hata isteği bozmaz. |
| `Deciship/apps/api/src/lib/storage.ts`, `util.ts`, `time.ts`, `mappingSchema.ts` | Dosya saklama ve imzalı bağlantı; sayı/tarih/fatura no yardımcıları; saat dilimi; kayıtlı eşleme şeması. |
| `Deciship/apps/api/prisma/schema.prisma` | Veri modeli (`deciship` şeması). Üretilen istemci `src/generated/prisma` (commit edilmez). |
| `Deciship/apps/api/prisma/migrations/` | Elle yazılmış SQL göçleri; bileşik yabancı anahtar ve RLS burada. |
| `Deciship/apps/api/scripts/check-drift.mjs` | Göç bileşik anahtarı/kısmi dizini düşürüyor mu, şema ile veritabanı farkı. |
| `Deciship/apps/api/src/lib/fileWorkers.ts`, `src/workers/fileWorker.ts`, `src/workers/pdfGuard.ts` | Dosya okuma havuzu ve çocuk süreçler (ayrıntı aşağıda "Dosya okuma havuzu"). |
| `Deciship/apps/api/src/lib/tableCache.ts` | Önizleme tablosu önbelleği: `TableCache` (bayt `INVOICE_TABLE_CACHE_MB`, süre, en çok 8), `estimateTableBytes`; örneği `routes/invoices.ts` `tableCache`. |
| `Deciship/apps/api/src/lib/util.ts` `yieldToLoop`, `mapSliced`, `YIELD_EVERY_ROWS` | Uzun döngülerde olay döngüsü molası; `services/compare.ts` `compareAllSliced` (sonuç `compareAll` ile aynı). |
| `Deciship/apps/api/src/lib/rateLimit.ts` | Hız sınırı kovaları (`RATE_TABLE`: `upload`, `vision`, `write`, `heavy`), ağır yazma yuvası; yeni yazma ucu tabloya girer. |
| `Deciship/apps/api/src/cli/aiUsage.ts` | Destek komutları `npm run ai:usage` (firma başına kullanım), `npm run ai:grant` (ek kredi). |
| `Deciship/apps/api/src/cli/reminders.ts` | İtiraz süresi hatırlatmasını bir kez çalıştırır (`npm run reminders:once -- [--send] [--now] [--company <id>]`, kapta `dist/cli/reminders.js`); bayraksız kuru çalışır. |
| `Deciship/apps/api/src/cli/purgePreview.ts` | Silinenlerin kalıcı temizliğinin kuru çalışması (`npm run purge:preview -- [--invoice-days <n>] [--photo-days <n>] [--now <ISO>] [--company <id>] [--json]`, kapta `dist/cli/purgePreview.js`); hiçbir şey silmez. |
| `Deciship/apps/api/src/app.ts` (426 kancası) | `X-SOD-Client` başlığına göre 426 `UPGRADE_REQUIRED` (`MIN_MOBILE_VERSION`, `env.ts`); muaf `UPGRADE_EXEMPT`. |

Dosya okuma havuzu (`lib/fileWorkers.ts`, `workers/`):

- Excel/CSV/PDF ayrı çocuk süreçlerde okunur (`child_process.fork`). `fileWorkers.ts` havuz; `workers/fileWorker.ts` çocuğun girişi (argv işareti `--deciship-file-worker`, IPC, fd 4'e RSS yazan izleme iş parçacığı).
- Bellek bekçisi (API RSS'i + çocukların büyümesi), süre, firma payı, kuyruk (`FILE_BUSY`), sınır hataları (`FILE_TOO_LARGE`, `FILE_TOO_COMPLEX`), çöküş ayrımı (stderr; açılmadan ölen çocuk 500).
- `workers/pdfGuard.ts`: PDF akışlarının açılmış boyutunu pdfjs'ten önce sayar.
- Üretimde `dist/fileWorker.js` (`tsup.config.ts`); imajda duman testi `Deciship/apps/api/scripts/file-worker-smoke.mjs` (çocuğu fork eder).
- Fatura raporu da burada (`renderReport`; görevler `reportPdf`, `reportXlsx`): `services/reports.ts` çocukta dinamik yüklenir, veritabanı ve `env.ts` içe aktarmamalı.
- İş başına çocuk yığını (`JobClass`: dosya `FILE_WORKER_HEAP_MB`, rapor `REPORT_WORKER_HEAP_MB`); farklı yığınlı çocuk işi bitince kapanır.

Rotalar (`Deciship/apps/api/src/routes/`):

| Dosya | Uçlar |
|---|---|
| `invoices.ts` | Fatura uçları (ayrıntı aşağıda "invoices.ts uçları"). |
| `tariffs.ts` | Tarife CRUD, varsayılan, kopya, şablon, CSV/XLSX içe aktarma taslağı, PDF belge tarama/çıkarma, sürümler ve geri yükleme, faturaları yeniden karşılaştırma, ülke istisnası, fiyat sorgusu (`quote`). |
| `measurements.ts` | Ölçüm kaydı (çok parçalı, fotoğraf), kontrol, liste, düzeltme (yeni sürüm), silme/geri yükleme; `serializeMeasurement` burada. Takip no `trackingOrThrow` (core `trackingFormat.ts` `checkTracking` + `stripScanNoise`; eşleme yine `normalizeTracking`), test `measurementTracking.test.ts`. |
| `settings.ts` | Ayarlar, kurulum sihirbazı, ayar değişince yeniden karşılaştırma, veri sıfırlama (yalnız `ENABLE_DATA_RESET=true`), koli kalıpları. |
| `disputes.ts` | İtiraz listesi, gönderme, yeniden gönderme, geri çekme, sonuç girme, sonucu geri alma. |
| `demo.ts` | Örnek veriyle deneme turu: `POST/DELETE /settings/demo` (kurallar `services/demoTour.ts`). |
| `jobs.ts` | Arka plan işi uçları: `GET /jobs`, `GET /jobs/:jobId`, `POST /jobs/:jobId/cancel`; işi başlatan uçlar kendi dosyalarında (`invoices.ts` PDF önizleme, `tariffs.ts` tarama/okuma/toplu geçiş, `settings.ts` toplu geçiş; hepsi `?async=1`). |
| `platform.ts` | Merkez uçları `/platform/overview`, `analytics`, `datasets`, `datasets/:id`, `datasets/:id/export`, `activity`, `ai-usage`. |
| `carriers.ts`, `dashboard.ts`, `me.ts`, `files.ts`, `vision.ts` | Taşıyıcılar; Pano; `/me` ve `/members`; imzalı dosya ve referans kartı; tartı okuma ve referans kartı ölçümü (görüntü servisine vekil; kural aşağıda). |

`routes/invoices.ts` uçları:

- Önizleme, doğrulama, yapay zekâ eşleme (önizleme satır sayısı `previewRowCount`).
- Yükleme `POST /invoices`: PDF için `lines` gövdesi, `importReport`, çakışma denetimi `trackingOverlap` + `otherInvoices`.
- Liste (arama `q`, durum `status`), ayrıntı, `PATCH /invoices/:id`.
- Satırlar: süzgeçler `flagged`, `recalcPending`, `review`; yanıtta süzgecin küme özeti `selectionDigest`.
- `PATCH /invoice-lines/:id` (karar, takip no, eşleştirme); toplu karar `POST /invoices/:id/lines/decide` (kural `services/bulkDecide.ts`).
- Tarife uyumu; yeniden karşılaştırma (`refreshParseFlags`: `PDF_*` korunur); `recalculate/preview` (yükleme izni yalnız başlık düzeltme kipine, `editPreview`) + `recalculate`.
- Silme, Excel/PDF rapor, itiraz metni ve kanıt ZIP'i (`/dispute/evidence.zip`).

`routes/vision.ts`: tartı okuması firma ayarı `scaleAiRead` kapalıysa (varsayılan) sağlayıcıya gitmeden 409 `AI_DISABLED` (`details.reason: scale_ai_off`). Test `test/scaleAiSetting.test.ts`; sınama firması `helpers.ts` `registerCompany` ayarı açık kurar, gerçek varsayılan `{ realDefaults: true }`.

Sık yapılan işler:

| İş | Bakılacak dosyalar | Koşulacak testler (`Deciship/apps/api/test/`) |
|---|---|---|
| Yeni API ucu | `src/routes/<alan>.ts` (`onRequest` kancası şart: `app.requirePermission` ya da `requireAny`), `test/routeRules.ts` `ROUTE_RULES` satırı (yoksa test kırılır), salt okunur abonelikte açık kalacaksa `READ_ONLY_EXEMPT`; yeni izin gerekiyorsa `Platform/packages/contracts/src/catalog.ts`; web istemcisi `Deciship/apps/web/src/api/endpoints.ts` + `types.ts` + sahte sunucu | `permissionMatrix`, uç alanının testi, `apiHardening` |
| Fatura satırına yeni alan | Şema `InvoiceLine` + yeni göç; core `src/invoice/types.ts` (`ParsedInvoiceLine`, eşleme alanıysa `MappingField`/`MAPPING_FIELDS`), `parse.ts`, `presets.ts`, `mapping.ts`, `verify.ts`; API `services/compare.ts` (`parsedToLineData`, `lineRowToParsed`), `services/lineWrite.ts` (INSERT sütunları ve `jsonb_to_recordset` tipleri; sayı sütunuysa `atStoredPrecision` ölçeği), `services/invoiceSerialize.ts`, `routes/invoices.ts` `lineSchema` (PDF yolu), `lib/mappingSchema.ts`, `services/ai.ts`/`aiMapping.ts` (prompt); web `src/api/types.ts`, `src/mocks/browser.ts`, yükleme adımı `src/pages/invoice-upload/`, `invoiceUpload.json`; gerekirse `services/reports.ts`, `services/hub/datasets.ts` (invoice-lines) | `lineWriteEquivalence`, `invoices`, `aiMapping`, `ai`, `i18n`; core `invoice`, `verify` |
| Tarifeye yeni alan | Şema `Tariff` + göç; `services/tariffs.ts` (`tariffBody`, `createTariffTx`, `serializeTariffFull`; fiyatı etkiliyorsa `tariffContentHash`); `services/compare.ts` (`toTariffInput`, `snapshotToTariffInput`); core `src/tariff.ts` `TariffInput`; `services/tariffExcel.ts`, `services/tariffImport.ts` (`appliedBody`, `newTariffDefaults`); web `src/api/types.ts`, `src/pages/tariff-editor/draft.ts` + `BasicSections.tsx`, `tariffEditor.json`, `src/mocks/browser.ts`; örnek `Deciship/samples/seed-tariffs.json` + `samples/tools/generate.mjs` | `tariffs`, `tariffsView`, `tariffEdges`, `tariffRevisions`, `tariffImport`, `frozenBackfill`; core `tariff` |
| Ayarlara yeni alan | `src/lib/settings.ts` (`CompanySettings`, `DEFAULT_SETTINGS`, `settingsFor`), `src/routes/settings.ts` `settingsPatch`; karşılaştırmayı etkiliyorsa `services/compare.ts` `CompareSettings`/`compareSettingsOf`; metin `src/i18n/messages.ts`; web `src/api/types.ts`, `src/pages/Settings.tsx`, `settings.json`, `src/mocks/browser.ts`; kurulumda soruluyorsa `src/pages/onboarding/SetupSteps.tsx` | `reviewFindings`, `onboarding`, `measurements`, `orgCurrency` |
| Yeni denetim kaydı eylemi | Uçta `audit(...)` çağrısı (`src/lib/audit.ts`); Merkez'de görünecekse `src/services/hub/activity.ts` `ACTIONS` (grup + görme izni) ve `src/services/hub/i18n.ts` `activity.<eylem>` TR+EN; `ACTIONS`'ta olmayan eylem akışta görünmez | `test/hub/access.test.ts`, `test/hub/consistency.test.ts` |
| İtiraz akışında değişiklik | Önce `Deciship/spec/itiraz.md`; `src/services/disputes.ts`, `src/routes/disputes.ts`, core `src/disputes.ts`; metin ve kanıt ZIP'i `src/services/evidence.ts`, `src/lib/zip.ts`, core `src/dispute.ts` (test `evidenceZip`); şema `Dispute*` modelleri; web `src/pages/Disputes.tsx`, `src/pages/disputes/parts.tsx`, `src/pages/invoice-detail/Dispute*.tsx`, `src/lib/disputes.ts`, `src/mocks/disputes.ts`, `disputes.json`; Merkez KPI'ları `services/hub/overview.ts`/`metrics.ts`; demo `src/seedDemoDisputes.ts` | `disputes`, `disputesMoney` (`disputeHelpers.ts`), `test/hub/numbers`; core `disputes`; web `test/disputes.test.ts`, `e2e/disputes.spec.ts`; Platform `e2e/tests/41-itiraz.spec.ts` |
| Merkez'e yeni veri/kart | `src/services/hub/overview.ts` (KPI, uyarı), `analytics.ts` (bölüm/grafik), `datasets.ts` (veri seti, sütun), `metrics.ts`, `i18n.ts` (TR+EN etiket); yeni şekil gerekiyorsa `Platform/packages/contracts/src/hub.ts`; başlık KPI kimlikleri `contracts/src/catalog.ts` `hub.headline`; çizim `Platform/apps/hub-web/src/components/Widgets.tsx`, `charts.tsx`, mobil `Deciship/apps/mobile/src/hub/ui.tsx`, `TimeSeries.tsx`, `chart.ts`; sahte yanıt ve kayıtlı örnekler (bkz. "Kesişen değişiklikler") | `test/hub/*.test.ts` (kayıt `test/hub/hubWebFixtures.test.ts`); hub-web `test/deciship-contract.test.mjs` (`npm test`), `e2e/hub.spec.ts`; mobil `npm run test:hub` |
| Kur davranışı | `src/services/fx.ts`, core `src/fx.ts`, `services/compare.ts` (`prefetchFx`, `amountTolIn`) | `fx`, `amountTolerance`, `measurementRecompare` |
| Rapor (Excel/PDF) | `src/services/reports.ts`, metinler `src/i18n/messages.ts` | `reportPdfMoney`, `performance`, `i18n` |
| Yeni hata metni | `src/i18n/messages.ts` (`err.*`); ortak kodlar `Platform/packages/contracts/src/errors.ts` | `i18n` (anlık görüntü + kaynakta Türkçe tarama) |
| Yeni yapay zekâ çağrısı | `services/aiMeter.ts` `meteredCall` (tür `AiKind` + `AI_KINDS`, önbellek gerekip gerekmediği); Merkez etiketi `services/hub/i18n.ts`; fiyat `Platform/packages/contracts/src/ai.ts` | `aiMeter`, `aiProvider`, `ai`, `rls` |
| Yeni arka plan işi türü | Şema `JobKind` + göç; `services/jobs/types.ts`, `registry.ts` (`JOB_KINDS`), `handlers/<tür>.ts`; başlatan uçta `launchJob` (tekillik anahtarı, `?async=1`); panelde `src/lib/jobs.ts` `JOB_STAGES`; metinler `job.*` (API) ve `common:jobs.*` | `jobs`, `jobKinds`, `bulkJob`, `rls`, `permissionMatrix` |
| Yeni yazma ucu (hız sınırı) | `src/lib/rateLimit.ts` `RATE_TABLE` satırı (yoksa test kırılır) | `rateLimit` |
| Yeni yazma ucu (deneme turu) | Taşıyıcı, tarife ya da fatura ekliyorsa `services/demoTour.ts` `DEMO_BLOCKED`'a, eklemiyorsa `test/demoTour.test.ts` gerekçeli izin listesine (ikisinde de yoksa test kırılır) | `demoTour` |
| Satır kararı (tek ya da toplu) | `services/bulkDecide.ts` (kural tek yerde), `routes/invoices.ts` (gövde şeması `bulkDecideBody`); süzgeç değişirse `buildLineWhere` (liste ucu da kullanır); web `invoice-detail/bulk.ts`, `BulkBar.tsx`, `LineTable.tsx`; Merkez etiketi `services/hub/activity.ts` + `i18n.ts` | `bulkDecide`, `recalculate`, `frozenResults`, `disputes`, `permissionMatrix`; web `test/bulk-select.test.ts`, `e2e/bulk.spec.ts` |
| Hatırlatma postası | `services/reminders.ts` (kural; metin `mail.ttk.*` `i18n/messages.ts`), `services/notify.ts`; ayar `lib/settings.ts` `disputeReminders`; Hesap tarafı `Platform/apps/account-api/src/lib/productNotice.ts`, sözleşme `Platform/packages/contracts/src/notify.ts` | `reminders`, `settingsNotify`, `maintenance`, `rls`; Hesap `productNotice`; contracts `notify` |
| Dosya okuma sınırı ya da havuz | `src/lib/fileWorkers.ts`, `src/workers/*`, `src/env.ts`; compose `Platform/docker-compose.yml` (yeni değişkeni geçir) | `fileWorker`, `invoiceUploadGuards`, `pdfInvoiceCheck`; core `zipGuard` |

Prisma ve göç deseni:

- Şemayı değiştir → `npm run db:migrate` (`migrate dev --create-only` + `check-drift --migrations-only` + `migrate deploy`). Üretilen SQL'i elle gözden geçir: Prisma bileşik yabancı anahtarları göremez ve onları tek sütunluya çevirmeyi önerir; o satırları sil.
- İlişkiler bileşiktir: `(x, "companyId") → (id, "companyId")`. Yeni ilişki eklenince `src/lib/schemaCheck.ts` `MIN_COMPANY_SCOPED_FKS` artırılır.
- Yeni tabloda RLS: `prisma/migrations/20261108120000_disputes/migration.sql` sonundaki döngü (`ENABLE` + `FORCE ROW LEVEL SECURITY` + `company_isolation` ilkesi, `current_setting('app.company_id', true)`).
- Bakım işinin okuyacağı satırlar için dar ilke: `20261107000000_maintenance_scope`, `20261110120000_measurement_recompare_pending`, `20261115090000_company_maintenance_read` (yalnız `Company`, hatırlatma için) (`app.scope = 'maintenance'`).
- Göç `sod_deciship_admin` ile çalışır (`prisma.config.ts`, `MIGRATE_DATABASE_URL`); uygulama `sod_deciship` ile. Roller ve GRANT'ler `Platform/infra/postgres/init.sql`.
