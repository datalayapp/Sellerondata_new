# Kod haritası — Test rehberi

Yollar depo köküne göredir. Komutlar: kök `CLAUDE.md` › Testler.

## Test rehberi

| Parça | Postgres? | Tek dosya örneği | Özel testler / notlar |
|---|---|---|---|
| Hesap motoru `Deciship/packages/core` | Hayır | `npx vitest run test/compare.test.ts` | |
| DeciShip API `Deciship/apps/api` | **Evet**; veritabanısız dosyalar `test/unitFiles.ts` kuralıyla kendiliğinden seçilir (`helpers`/`fixtures`/`src/db`/`src/app`/`pg`/Prisma içe aktarmayan; zorla veritabanlı: `// test-layer: db`); Postgres'e bağlanmaya kalkarsa `test/noDbGuard.ts` kırar | `npx vitest run test/disputes.test.ts`; veritabanısız dosya `npx vitest run --config vitest.unit.config.ts test/x.test.ts` ya da `npm run t -- <dosya>` | `npm test` = `test:unit` (veritabanısız) + `test:db`; metin tablosu ve kaynak taraması `test/i18nText.test.ts` (hızlı grup) |
| DeciShip paneli `Deciship/apps/web` | Hayır | `node --test test/recalc.test.ts`; `npx playwright test e2e/disputes.spec.ts --output=<ayrı klasör>` | `npm test` node --test koşar; `check:i18n`; `test:e2e` sahte sunucu |
| Mobil `Deciship/apps/mobile` | Hayır | `npx vitest run tests/flush.test.ts` | `npm test` = vitest + node --test + `test:hub`; `node scripts/check-i18n.mjs` |
| Hesap servisi `Platform/apps/account-api` | **Evet** (veritabanı adı süreç başına rastgele, paralel güvenli) | `npx vitest run test/members.test.ts` | |
| tokens, format `Platform/packages/tokens`, `Platform/packages/format` | Hayır | | tokens `node --test`; belirteç güncel mi: `node build.mjs --check` |
| auth-kit, shell | auth-kit `eventRace.db.test.ts` evet; diğerleri hayır | | |
| Merkez `Platform/apps/hub-web` | Hayır | `node --test test/deciship-contract.test.mjs` | `npm test` = `src/lib/*.test.mjs` + `test/*.test.mjs` (sahte API = gerçek kayıt); `typecheck` src + e2e; `test:e2e` sahte sunucu |
| Görüntü servisi `Deciship/services/vision` | Hayır | | `pytest` (`tests/`) |
| contracts `Platform/packages/contracts` | Hayır | `node --test test/client.test.ts` | `npm test` = `node --test test/*.test.ts` |
| Araç kaydı ve üretici | Hayır | | `Platform/packages/contracts`: `node --test test/registry.test.ts test/catalog.test.ts`; kök: `node --test Platform/scripts/products-gen.test.mjs Platform/scripts/dev-gateway.test.mjs`; güncellik `npm run products:check` |
| product-kit `Platform/packages/product-kit` | Evet (fikstür `ornekarac` için) | `npx vitest run test/hub.test.ts` | |
| Araç durumu ve abonelik komutları | Evet | | Hesap servisi: `npx vitest run test/launch.test.ts test/subscriptions.test.ts test/ordering.test.ts test/cli.test.ts` |
| Kök betikleri `scripts/`, `tools/lint/` | Hayır | | `node --test scripts/repo-check.test.mjs`, `node --test tools/lint/rules.test.mjs`, `node --test scripts/ci-select.test.mjs` (CI iş seçimi, parçalı işin toplanması), `node --test scripts/lib/shape.test.mjs` (yanıt şekli yardımcısı), `node --test scripts/test-changed.test.mjs` (test:changed planı), `node --test scripts/ci-son.test.mjs` (CI günlük özeti); parçalar `repo-check-test`, `lint-rules`, `ci-select`, `shape-lib`, `test-changed`, `ci-son` |
| Süre eşikli testler (`*.perf.test.ts`) | API ve core hayır, hesap servisi evet | `npm run t -- Deciship/packages/core/test/pdfCheck.perf.test.ts` | Kapı değil: `npm run test:perf` (parçalar `api-perf`, `core-perf`, `account-perf`, `gate: false`; kalırsa "kaldı (bilgi)"); paket başına `npm run test:perf` (`vitest.perf.config.ts`). Doğruluk denetimi kapıdaki eş dosyada (ör. `pdfCheckLarge`, `invoice-robustness`, hesap servisi `loginArgon`) |
| Kapsam (isteğe bağlı, kilometre taşı) | Hayır | | kök `npm run coverage:core` (`scripts/coverage.mjs`; çekirdek para modülleri; `@vitest/coverage-v8` kurulu değilse çıkış 2, koşmadı) |
| Derlenmiş komut girişleri (`dist/*.js`: tohum, destek komutları) | Hayır | | Hesap servisi ve DeciShip API: `npm run test:cli` (`test/cli-entries.test.mjs`; ayrı klasöre tsup derler, her girişi çalıştırır, boş geçip 0 ile biten girişte kırılır); parçalar `account-cli`, `api-cli`. Kural: giriş `scripts/<ad>.ts` (DeciShip `src/bin/<ad>.ts`), hiçbir modül içe aktarmaz; yeni giriş `tsup.config.ts` + testteki `PROBES` listesine |
| Gateway hız sınırı (kimlik kovası, 429 biçimi) | Hayır | | `Platform`: `node --test gateway/test/rate-limits.test.mjs`; parça `rate-limits`. Canlı: `bash gateway/test/run.sh` (Docker) |
| Günlükte jeton yok, Referrer-Policy | Hayır | | `Platform`: `node --test gateway/test/access-log.test.mjs` (ortak biçim `gateway/conf/access-log.conf`; gateway, hub-web, deciship-web; jetonlu sayfa `no-referrer`); parça `access-log`. Canlı: `bash gateway/test/run.sh` (Docker) |

## Kökten koşu

Bağımlılık yok; parça kaydı `scripts/parts.mjs`, koşturucu `scripts/test.mjs`, liste `npm run parts`.

- `npm test` = `check` + `typecheck` + `lint` + `quick` (veritabanısız).
- `npm run test:db`: DeciShip API `npm run test:db`, hesap servisi, auth-kit, product-kit; Postgres'i önce yoklar, kapalıysa "koşmadı" der.
- `npm run test:all`: kilometre taşı, e2e hariç. `npm run test:e2e`: web ve Merkez Playwright, ayrı port ve çıktı.
- Değişen dosyaların testleri: `npm run test:changed [-- --staged | --deps | --no-tc | --dry-run | <dosya...>]` (`scripts/test-changed.mjs`; son gönderimden bu yanaki commit'ler + sahnelenen + sahnelenmemiş + izlenmeyen; vitest paketlerinde `vitest related`, node --test paketlerinde değişen test ve değişen kaynağı içe aktaran testler; dokunulan paketin tip denetimi; Postgres yoksa veritabanı adımı "koşmadı"; `--deps` file: ile alan paketlerin ilgili vitest testleri).
- Son CI koşusu: `npm run ci:son [-- --bekle] [sha|dal]` (`scripts/ci-son.mjs`, salt okunur `gh`; işler, kalan işte düşen testler ve ilk hata satırı, ayrı satırda gece e2e; çıkış 0 yeşil, 1 kırmızı, 2 okunamadı, 3 bitmedi).
- Tek dosya: `npm run t -- <dosya> [-u] [-t "<ad>"]` (`scripts/t.mjs`; dosyanın paketini ve koşucusunu paketin `test` betiğinden bulur, API'nin veritabanısız dosyalarını `vitest.unit.config.ts` ile koşar; dosyasız, klasörle ya da `*` ile çağrılırsa hiçbir şey koşmadan reddeder).
- Kurulum: `npm run install:all` (`scripts/install.mjs`; yalnız eksik `node_modules`'a kurar, junction silmez). Kayıtlar `.test-logs/`.
- `main` birleştirmesinden önce `npm run main:ready` (`scripts/main-ready.mjs`, salt okunur `gh`: o commit'te hızlı iş ve veritabanı işi yeşil mi; veritabanı işi atlandıysa en yakın yeşil koşu ve aradaki veritabanı değişiklikleri; çıkış 0 hazır, 1 değil, 2 okunamadı).

## Depo denetimi

`npm run check` (`scripts/repo-check.mjs`, ayarlar ve istisnalar `scripts/repo-check.config.mjs`):

- K1 kontrol karakteri, K2 görünmez karakter, K3 BOM (`.ps1` BOM'lu olmalı; ts, js, json ve sh BOM'suz), K4 satır sonu (`.sh` LF).
- K5 göçte FORCE RLS deseni (eski yakıt göçü "bilinen eski" listesinde).
- K6–K9 paket bağı, kilit, bağımlılık ve sürüm birliği.
- K10 belge yolu, K11 uzun satır (yalnız UYARI): Markdown'da ters tırnak içindeki depo kökü yolu (`Platform/`, `Deciship/`, `scripts/` …) ne kökte ne belgenin klasöründe varsa; 600 karakteri aşan satır (dosya başına tek satır). Kapsam `docs` (SONRAKI-OTURUM dahil, ARSIV hariç).

## Lint

`npm run lint` (`tools/lint/run.mjs`, ayar `tools/lint/eslint.config.mjs`, kurallar `rules.mjs`; kendi `node_modules`'u, kök `eslint.config.mjs` tek satır): yalnız hata sınıfı kurallar, tip bilgisi yok.

- Bugün 0 hata, 28 uyarı. Uyarı sayısı kural başına `tools/lint/warnings-baseline.json` ile karşılaştırılır: artarsa lint kırılır (CI dahil), azalırsa `node tools/lint/run.mjs --update-baseline`.
- `rules.mjs` `PENDING` (başka işin dosyasındaki ihlali geçici uyarıya indiren liste) bugün boş.
- Meşru istisna: `// eslint-disable-next-line <kural> -- <neden>`.
- `npm run format:check` Prettier farkını sayar, dosya değiştirmez (`.prettierrc.json`, `.prettierignore`); toplu biçimleme kullanıcı kararı.

## "Önce" kayıtları

Biçimleme altın testleri: core `test/formatGolden.test.ts`, shell `test/formatGolden.test.ts`, mobil `tests/formatGolden.test.ts`, panel `test/format-golden.test.ts` (+ `format-golden.snapshot.json`); mobil tema `tests/theme-baseline.test.ts`; belirteç haritası `Platform/packages/tokens/test/before.json`. Bu kayıtlar yalnız bilinçli değişiklikte güncellenir.

Büyük firma süre ölçümü: `Deciship/apps/api/test/bigCompany.db.perf.test.ts` + `test/perfData.ts` (`npm run test:perf:db`, kök `api-perf-db`, kapı değil; `PERF_SCALE`, `PERF_SQL=1`). RLS altında dizin kuralı `Deciship/spec/sinirlar.md` "Büyük firmada hız".

API `reviewRound2` K1 `settled()`: boşta keep-alive bağlantıları kapatılarak yalnız süren istekler sayılır (sunucu 72 sn açık tutar; hızlı CI'da biten istek bekleme süresini dolduruyordu).

shell oturum testleri: react-query haberi bileşene `setTimeout(0)` ile gelir; çıkış ya da önbellek temizliği denetlenmeden önce yanıtın bileşene ulaşması beklenir (`settleFetched`, `timeZone.test.tsx`). Yavaş CI'da 20 ms'lik sabit bekleme yetmiyordu.

## Görsel karşılaştırma

`npm run test:visual`: `Deciship/apps/web` 95 senaryo, `Platform/apps/hub-web` 32 senaryo; dosyalar `playwright.visual.config.ts` + `e2e/visual/visual.spec.ts`.

- Görüntüler depoda değil: sabit klasör `%LOCALAPPDATA%\SellerOnData\gorsel\deciship` ve `...\gorsel\hub` (`VISUAL_DIR` ile değişir). Son taban 2026-11-16, `f4fe2add` sonrası.
- Taban almak (değişiklikten önce): `npm run test:visual -- --update-snapshots --output <ayrı klasör>`.
- Karşılaştırmak (değişiklikten sonra, `--update-snapshots` olmadan): aynı komut; fark çıkarsa HTML raporu önce/sonra/fark görüntüsünü verir.
- Portlar `DECISHIP_WEB_PORT` (5273), `HUB_WEB_PORT` (5280/5281); `VISUAL_NO_SERVER=1` açık sunucuya bağlanır. Her koşu ayrı `--output` alır.
- Çekmediği durumlar: 600–767 px kart tabloları, üstüne gelme ve odak.

## Postgres, portlar, anlık görüntüler

Postgres: Platform compose'daki `postgres` (localhost:5434, `Platform\BASLAT.bat`) ya da Docker'sız yerel test kümesi (localhost:5435, `npm run pg:baslat`; `scripts/pg-yerel.ps1`: resmî taşınabilir PostgreSQL 17 `%LOCALAPPDATA%\SellerOnData\pg-test` altına, aynı roller `init.sql` ile, fsync kapalı, UTC).
- Gerçek kullanımda (`Platform/.env` `SOD_GERCEK_KULLANIM` dolu) testler gerçek verinin Postgres'ine bağlanmaz: `scripts/lib/pg-guard.mjs` (kök `pg.mjs`, API ve hesap servisi `test/testEnv.ts`, auth-kit ve product-kit veritabanı testleri); 5435 gerekir, kaçış `TEST_ALLOW_REAL_PG=1`.
- Hangisi: Kök koşucular (`test.mjs`, `t.mjs`, `test-changed.mjs`) sırayla `TEST_DB_HOST`, 5434, 5435'i dener ve bulduğunu `TEST_DB_HOST` ile geçirir (`scripts/lib/pg.mjs`); bütün veritabanı testleri bu değişkeni okur.

DeciShip API testleri her koşuda test veritabanını göçlerle sıfırdan kurar (`test/globalSetup.ts`). Ad verilmezse koşu başına rastgeledir (`deciship_apitest_<pid>_<rastgele>`, `test/testEnv.ts`) ve bitişte veritabanı ile dosya klasörü silinir: paralel koşular birbirini silmez. Veritabanını sonra incelemek için ad verilir (silinmez): PowerShell `$env:TEST_DB_NAME='deciship_apitest_a'; npx vitest run test/x.test.ts`. Dosyalar sırayla koşar (`fileParallelism: false`); tam koşu uzundur.

- Playwright portları: web `DECISHIP_WEB_PORT` (5173), `HUB_WEB_PORT` (5180); hub-web `HUB_WEB_PORT`. Paralel koşuda her biri farklı port ve `--output` alır.
- Anlık görüntü yalnız metin değişikliği bilerek yapıldıysa güncellenir: `npm run t -- Deciship/apps/api/test/i18nText.test.ts -u` (API, veritabanısız) ya da core'da ilgili dosya; farkı gözden geçir.

## API test dosyası → konu

En çok dokunulan kaynaklar.

| Kaynak (`Deciship/apps/api/src/`) | Testler (`Deciship/apps/api/test/`) |
|---|---|
| `app.ts`, yeni uç, izinler | `permissionMatrix` (`routeRules.ts`), `apiHardening`, `security` |
| `db.ts`, RLS | `rls`, `dbConnection`, `security` |
| `routes/invoices.ts` (yükleme, önizleme) | `invoices`, `invoiceUploadGuards`, `invoiceDuplicates`, `invoiceMetaGuess`, `invoiceRace`, `invoiceTariff`, `sampleInvoices`, `fedexFbo`, `webExpectations`, `aiMapping`, `invoiceImportReport`, `invoiceReview`, `invoiceRobustness`, `invoiceCurrencyMix` (karışık para birimi bayrağı ve onay, başlıkta para birimi çelişkisi 409 `CURRENCY_CONFLICT`) |
| `services/invoicePdfCheck.ts`, PDF yükleme yolu | `pdfInvoiceCheck`, `pdfInvoiceTotals` (fatura toplamı, ağırlık/ölçü/ek ücret, istem, `pdfEdits`), `invoices`, `ai` |
| `services/evidence.ts`, `lib/zip.ts` | `evidenceZip`, `disputes`, `security`, `permissionMatrix`, `kullaniciKararlari` |
| Yüklemede tarife önseçimi (`compare.ts` `tariffForDate`, `routes/invoices.ts` `resolveInvoiceTariff`; web `lib/tariffPick.ts`, `components/TariffSelect.tsx`), kayıtlı eşleme izni (`POST /invoices` `saveMapping` + `settings.manage`; web `invoice-upload/MappingStep.tsx`) | API `kullaniciKararlari`, `invoiceTariff`; web `test/user-decisions.test.ts` |
| `services/compare.ts` | `invoices`, `amountTolerance`, `invoiceTotals`, `invoiceTotalsConcurrency`, `lineWriteEquivalence`, `measurementRecompare`, `tariffRecompareScope`, `frozenResults`, `recalculate`, `bulkRecalc`, `invoicePatchRace`, `calculatedAt`, `importMeasurementRace`, `invoiceRecheck`, `measurementQueueBatch` |
| `services/compare.ts` yeniden hesabın sorgu sayısı | `recalcQueries` (önizleme + onay < 40 sorgu, onay yanıtı = GET, birleşik itiraz sorgusu = eski iki sorgu), `performance` |
| `services/lineWrite.ts` | `lineWriteEquivalence` (ayrıca `atStoredPrecision`: inçli satırda içe aktarma = yeniden karşılaştırma), `performance`, `invoices` |
| `services/invoiceSerialize.ts` | `i18n` (EN notlar), `performance`, `recalculate`, `permissionMatrix` (para sızıntısı) |
| `routes/tariffs.ts`, `services/tariffs.ts` | `tariffs`, `tariffsView`, `tariffEdges`, `tariffDomesticDistance`, `tariffRecompareScope`, `tariffRevisions`, `tariffConcurrency` (409 STALE, kilit altında sürüm, yinelenen satır), `frozenBackfill` |
| `services/tariffImport.ts` | `tariffImport`, `tariffImportNumbers` (sayı biçimi seçeneği, indirim oranı şablon gidiş-dönüşü ve eski şablon, lb tablosunda basamak), `webExpectations`, `orgCurrency`, `firmCurrency` |
| `services/tariffExcel.ts` (şablon) | `tariffEdges`, `tariffImportNumbers` |
| `services/tariffPdf.ts` | `tariffPdf`, `tariffPdfBuild`, `tariffPdfPosition` (fiyatın yeri: satır kayması, sütun karışması; yanlış alarm yerleşimleri), `tariffPdfListDiscount`, `tariffEdges`, `maintenance` |
| `services/tariffHealth.ts` | `tariffHealth`, `frozenResults` |
| `routes/measurements.ts` | `measurements`, `measurementRecompare`, `flex`, `security`, `importMeasurementRace` (yükleme sırasında ölçüm), `measurementPurge` (kalıcı silme) |
| `services/disputes.ts`, `routes/disputes.ts` | `disputes`, `disputesMoney` |
| İtiraz metni = kayıt, seçim özeti, satır kararı yarışı, önceki turda geri alma, "geçerli satır"ın dört kopyası (core, `disputeFacts`, `lineDisputeStates`, Merkez) | `test/disputeSync.test.ts` |
| `services/fx.ts` | `fx`, `amountTolerance`, `measurementRecompare` |
| `services/reports.ts` | `reportPdfMoney`, `performance`, `i18n`, `reportWorker` (rapor dosya çalışanında: olay döngüsü, içerik ana süreçle aynı, 422 `REPORT_TOO_LARGE`) |
| `lib/tableCache.ts` (önizleme tablo önbelleği) | `tableCache` (bayt/süre/sayı sınırı; önbelleksiz akış = önbellekli akış) |
| `lib/storage.ts` `storeBuffer` (geçici ad, 507 `STORAGE_FULL`, `discardStored`) | `storeBuffer` |
| `services/evidence.ts` itiraz penceresinin fotoğraf taraması | `disputeWindow`, `evidenceZip`, `storageFiles` |
| `services/storageOrphans.ts` ters yön (`MISSING`), `services/storageQuota.ts` `storageUsage` | `storageOrphansMissing`, `storageUsage`, `previewResume` |
| `services/hub/metrics.ts` `companySettings` istek belleği | `hub/settingsMemo` |
| `routes/settings.ts`, `lib/settings.ts`, `services/onboarding.ts` | `reviewFindings`, `onboarding`, `orgCurrency`, `firmCountry`, `firmCurrency` |
| `services/hub/*`, `routes/platform.ts` | `hub/access`, `hub/consistency`, `hub/numbers`, `hub/boxPresetDataset`, `reviewFindings`, `reviewRound2`, `disputes` |
| `identity.ts` | `events`, `auth`, `firmCountry`, `firmCurrency` |
| `i18n/messages.ts` | `i18n`, `aiLanguage` |
| `services/ai.ts`, `services/aiMapping.ts` | `ai`, `aiLanguage`, `aiMapping`, `aiProvider`, `aiTransient`, `aiPromptRules` |
| `services/aiTariffReview.ts` (istem, firma profili) | `aiLanguage`, `aiPromptRules` |
| `services/aiMeter.ts`, `services/hub/aiUsage.ts`, `cli/aiUsage.ts` | `aiMeter`, `aiProvider`, `rls`, `aiTransient` (geçici hata hatırlanmaz, hatırlanan hatanın metni ve `retry-after`, sigorta, 413 istek boyu, 401 günlüğü) |
| `services/aiDailyBudget.ts` (sistemin günlük yapay zekâ tavanı `AI_DAILY_BUDGET_TRY`: `takeAiDailyBudget`, çağıran `aiMeter.ts` `callProvider`; kapı `db.ts` `withAiBudgetScope`, göç `20261123090000_ai_daily_budget_scope`; `env.ts` `aiDailyBudgetTry`; `cli/aiUsage.ts` günün toplamı) | `aiDailyBudget`, `aiMeter`, `rls` |
| `services/jobs/runner.ts` yeniden deneme (`isTransientJobError`, `retryDelayMs`), `services/jobs/jobScope.ts` | `jobs`, `aiTransient` (529 sonra başarı, gruplu okumada çift ücret yok, kesilen içerik iş içinde bir kez, deneme hakkı bitince asıl hata, bekleme kayması) |
| `services/ai.ts` `aiFailed` (akış içi hata) | `aiStreamErrors` (gerçek SDK: akış içi aşırı yük ücretsizse geçici, ücretliyse kalıcı) |
| `lib/fileWorkers.ts`, `workers/*` | `fileWorker`, `invoiceUploadGuards`, `pdfInvoiceCheck`, `reportWorker` (rapor görevleri, iş başına çocuk yığını) |
| `lib/rateLimit.ts` (ağır yuva sırası `HEAVY_QUEUE_WAIT_MS`), `services/hub/limiter.ts`, `db.ts` havuzu | `rateLimit`, `dbLane` |
| `app.ts` 426 kancası, `env.ts` `MIN_MOBILE_VERSION` | `clientVersion` |
| `services/jobs/*`, `routes/jobs.ts` | `jobs` (kuyruk, kira, devralma, durdurma, yetki), `jobKinds` (PDF ve tarife işleri, çift ücret, `File.preview`), `bulkJob` (toplu geçiş, ölçüm sırası), `rls`, `permissionMatrix` |
| `services/jobs/runner.ts` adil paylaşım, `bulkRecalc.ts` `shouldPause` | `jobFairShare` (yuva bırakma, kaldığı yerden sürme, bayat faturadan sonra bırakma, başka kopyadan durdurma) |
| `services/fileCleanup.ts`, `lib/storage.ts` | `fileCleanup` (24 saat, 30 gün, korumalar, yarışlar), `maintenance`, `invoices`, `security` |
| `services/deletedPurge.ts`, `cli/purgePreview.ts` | `deletedPurge` (29/30 gün, itiraz ve kanıt, geri yükleme, paylaşılan yol, disk hatası, başka firma, kuru çalışma), `fileCleanup`, `maintenance`, `rls`, `evidenceZip`, `invoiceRecheck`; `npm run test:cli` |
| `services/measurementQueue.ts` | `bulkJob` (sıra, yeniden deneme), `measurementRecompare`, `measurements`, `measurementQueueBatch` (birleştirme, firmalar arası sıra, deneme sınırı), `invoiceRecheck` (mükerrer işareti, tarama) |
| `services/recalcFailed.ts` | `recalcFailed`, `invoiceRecheck`, `measurementQueueBatch` |
| `services/maintenance.ts`, `lib/schemaCheck.ts` | `maintenance`, `measurementRecompare`; `invoiceRace`, `reviewRound2`, `frozenBackfill` |
| `services/companyData.ts`, `seed.ts` | `demoData`, `onboarding`, `reviewRound2` |
| `services/bulkDecide.ts`, `routes/invoices.ts` (liste süzgeci, önizleme) | `bulkDecide`, `invoiceListFilter`, `previewRowCount`, `recalcVisibleChange` |
| `services/demoTour.ts`, `routes/demo.ts`, `services/sampleInvoices.ts` | `demoTour`, `onboarding`, `demoData`, `permissionMatrix`, `apiHardening` |
| `services/demoTour.ts` tazeleme ve eski bayrak | `demoTourLimits` |
| `services/reminders.ts`, `services/notify.ts`, `cli/reminders.ts` | `reminders`, `settingsNotify`, `maintenance`, `rls` |


## CI

`.github/workflows/ci.yml`, beş iş:

- `secim` (her koşu): `scripts/ci-select.mjs`; işin son sınandığı commit'ten bu yana ilgili yol değişti mi, bir commit mesajında `[db]` var mı; yol listelerinin tek kaynağı bu dosya.
- `hizli` (her koşu): `npm test`; ~3 dk; aynı dala yeni gönderim iptal eder.
- `veritabani`: beş parçalı matris (API 1/3–3/3, hesap servisi 1/2 + auth-kit, 2/2 + product-kit), her biri kendi Postgres servis kabıyla `node scripts/test.mjs db --only <parçalar> --shard i/n` (`shard: true` parçalara vitest `--shard`); veritabanı yolu değişince ya da `[db]` ile, son commit'te `[db-sonra]` erteler; hızlı iş geçince koşar; iptal edilmez, parça başına bir süren + en yeni bir bekleyen.
  `ci-select.mjs` `findJob` parçaları tek iş gibi toplar (biri sürüyorsa sürüyor, bittiyse en kötü sonuç); `main:ready` ve `ci:son` aynı yardımcıyı kullanır. Hesap-1 parçası sonunda `account-perf` (bilgi).
- `vision`: görüntü servisi değişince; Python 3.12, pytest.
- `hizli` sonunda süre ölçümleri `api-perf`, `core-perf` (bilgi, işi kırmaz).
- `e2e`: her gece 03:17 İstanbul (`schedule`, varsayılan dal `gelistirme`; o koşuda öteki işler atlanır) ve elle (Run workflow, `e2e` kutusu); panel ve Merkez Playwright, sahte API. Sonuç `npm run ci:son` "Gece e2e" satırında.
- Yalnız `SONRAKI-OTURUM/**`, `**/*.md`, `.claude/**` değişen gönderimde CI hiç koşmaz. Mobil derleme, Docker imajı, gateway canlı testi ve gerçek yığın e2e CI'da yok.

**Ön-commit kancası** `.githooks/pre-commit`: depo denetimi + sahnelenen dosyalarda lint ve uyarı tabanı (`node tools/lint/run.mjs --head-baseline <dosyalar>`: bu dosyalarda kural başına uyarı HEAD'dekinden çoksa durur; HEAD tabanın içindeyse CI'daki kuralın aynısı). Kurulum `npm run hooks:install`. Lint çalışma ağacındaki içerikle koşar.

## Ortak test yardımcıları

Ortak test yardımcıları: `test/timing.ts` (`timeBudget`: makineye göre ölçeklenen süre sınırı, taban × 5), `test/unitFiles.ts` + `test/noDbGuard.ts` (veritabanısız liste ve bekçisi), `test/helpers.ts` (`getApp`, `issueIdentity`, `registerCompany`, `multipart`, `inCompany`, `sendEvent`, `findMoneyKeys`), `test/fixtures.ts` (`companyFixture`, `tariffPayload`), `test/hub/harness.ts`, `test/disputeHelpers.ts`, `test/recalcHelpers.ts`.
