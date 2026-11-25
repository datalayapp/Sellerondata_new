# Kod haritası — Örnek veri, kesişen değişiklikler, bilinen tuzaklar

Yollar depo köküne göredir.

## Örnek veri

Kök `Deciship/samples` (hepsi kurgusal).

| Dosya | Ne işe yarar |
|---|---|
| `invoices/*` | 7 altın fatura (FedEx CSV/XLSX, UPS, DHL, Aras, Yurtiçi, MNG) + FBO ve genel EN/DE örnekleri. |
| `seed-tariffs.json`, `seed-measurements.json` | Tarifeler ve 57 ölçüm; API `services/companyData.ts` (örnek veri) ve `test/invoices.test.ts` okur. |
| `expected.json`, `EXPECTED.md` | Altın sonuçlar (satır satır ve toplamlar). Okuyanlar: core `test/samples.test.ts`, `invoice-robustness`; API `test/helpers.ts`, `invoices.test.ts`, `invoiceRobustness.test.ts`, `src/seedDemoDisputes.ts`; Platform `e2e/tests/45-merkez-ozellikler`, `90-performans-goruntu`. |
| `Deciship/samples/tools/generate.mjs` | Hepsini üretir; SPEC §3 kurallarının **bağımsız** bir kopyasını içerir. Kural değişirse burada da değiştirilip yeniden üretilir: `cd Deciship/samples/tools && npm i && node generate.mjs`. |
| `vision/`, `reference-card.pdf` | Görüntü servisi örnekleri. |

Core'un ayrı dayanıklılık fikstürleri: `Deciship/packages/core/test/fixtures/robustness/` (üretici `build.ts`; yeniden üretme komutu dosyanın başında).

## Kesişen değişiklikler

| Değişen | Ayrıca güncellenir |
|---|---|
| API yanıt şekli | Web `src/api/types.ts` + `src/api/endpoints.ts` + `src/mocks/browser.ts` (itirazsa `mocks/disputes.ts`); mobil kullanıyorsa `Deciship/apps/mobile/src/api/endpoints.ts`; para alanıysa adı `app.ts` `MONEY_KEY` kalıbına uymalı (fiyat izni olmayana gitmesin), `permissionMatrix` "para sızıntısı" testi koşulur. |
| Core'un ürettiği Türkçe not/etiket (`compare.*`, `tariff.*`, `read.*`, `parse.*`, `import.reason.*`, `stored.*`, `fx.sourceFor`) | Veritabanında Türkçe saklanır, gösterirken `localizeText` kalıpla geri eşler. Şablonu değiştirmek eski kayıtların çevirisini bozar; yeni anahtar ekle ya da eski kalıbı tanımaya devam et. API'de öneke bakan kod var (`services/compare.ts` `FX_FAILED_NOTE_PREFIX`, core `isPakNote`, `isFxMissingNote`). Anlık görüntüler: core `test/__snapshots__/i18nTrBaseline.test.ts.snap`, `i18nEn.test.ts.snap`. |
| API metni (`src/i18n/messages.ts`) | `test/__snapshots__/i18n.test.ts.snap`; `src/` altında yeni Türkçe karakterli kod satırı `test/i18n.test.ts` `ALLOWED` listesinde değilse test kırılır. |
| Karşılaştırma kuralı (rakamları değiştiren) | `Deciship/samples/tools/generate.mjs` + yeniden üretilen `expected.json`, `EXPECTED.md`, `samples/README.md` tablosu; API `test/invoices.test.ts`; Merkez kayıtlı örnekleri (aşağıda). |
| Merkez uçları (`services/hub/*`) | Aşağıdaki "Merkez uçları değişince" listesi. |
| `services/hub/links.ts` sorgu adları | Web sayfalarının okuduğu sorgu parametreleri: `InvoiceDetail.tsx` (`tab`, `line`), `Measurements.tsx` (`id`, `userId`, `from`, `to`), `Tariffs.tsx` (`carrier`). |
| Tarifenin fiyatı etkileyen alanı | `services/tariffs.ts` `tariffContentHash` (yoksa yeni sürüm doğmaz), `services/compare.ts` `snapshotToTariffInput`. |
| Yeni tablo/ilişki | RLS bloğu, bileşik FK, `lib/schemaCheck.ts` `MIN_COMPANY_SCOPED_FKS`; firma sıfırlama yolu `services/companyData.ts` `clearCompanyData` ve kalıcı firma silme listesi `services/companyPurge.ts` `PURGE_TABLES`. |
| Hesap olayı | `contracts/src/events.ts`, Hesap `src/lib/outbox.ts`, DeciShip `src/identity.ts` `onEvent`, auth-kit `src/eventReceiver.ts` `KNOWN_TYPES` (tanınmayan tür 422), product-kit `src/identity.ts` (TagPress bunu kullanır: `Tagpress/apps/server/src/platform/identity.ts`), geçidin alıcısı `Platform/apps/ai-api/src/routes/events.ts` (hizmet olayları), API `test/events.test.ts`. Yeni tür: önce ürünler ve hizmetler, sonra Hesap (ARCHITECTURE §6). |
| Yapay zekâ fiyatı ya da modeli | `contracts/src/ai.ts` fiyat tablosu (tarih testi), kayıttaki `ai.models` (izin listesi), TagPress `packages/domain/src/ai.ts` eşitlik testi, DeciShip `AI_PRICE_TABLE`; geçit tabloda olmayan modeli reddeder. |

Merkez uçları (`services/hub/*`) değişince:

- Sahte sunucu `Platform/apps/hub-web/src/mocks/deciship.ts`; etiket eklendiyse `src/mocks/deciship-labels.json` (`services/hub/i18n.ts`'nin kopyası; üretici betik yok, elle eşlenir).
- Kayıtlı gerçek yanıtlar `Platform/apps/hub-web/e2e/fixtures/deciship-real/*.json`: DeciShip API veritabanı testi `test/hub/hubWebFixtures.test.ts` üretir ve karşılaştırır; uç değişince kırılır, bilerek yenileme `npx vitest run test/hub/hubWebFixtures.test.ts -u`.
- Denetim: Merkez `test/deciship-contract.test.mjs` (`npm test`, her gönderimde).
- Panel uçları: gerçek şekil `Deciship/apps/api/test/__contract__/*.json` (`test/contract.test.ts`, yenileme `-u`); sahte API denetimi panel `test/mock-contract.test.ts`; izin tablosu `test/mock-permissions.test.ts` (`mocks/account.ts` = API `test/routeRules.ts`).
- Yeni uç ya da durum: iki testin örnek listesine birlikte girer.

## Bilinen tuzaklar

`CLAUDE.md` "Windows tuzakları"na ek olarak:

- **Biçimlenmiş para metnini boşluktan bölme.** Ekranda tutar ile simge arasında bölünmez boşluk var (U+00A0); `split(' ')` ya da düzenli ifade onu bulamaz ve simgeyi küçültmek için metin ayrıştırmak sessizce bozulur. Parça gerekiyorsa `@sellerondata/format` `moneyParts` kullan.
- **Kaynakta `\u00a0` kaçışı araç zincirinde gerçek karaktere dönüşebilir.** Depo denetimi (`npm run check`, K2 görünmez karakter) onu reddeder. Bölünmez boşluğu `String.fromCharCode(160)` ile üret.
- **Vite `optimizeDeps.exclude` listesine yeni ortak paket eklenmeli** (`Deciship/apps/web/vite.config.ts`, `Platform/apps/hub-web/vite.config.ts`: `@sellerondata/shell`, `contracts`, `format`, `@deciship/core`). Eklenmezse Vite paketin eski ön paket kopyasını çalıştırır ve kaynak değişikliği görünmez; ön bellek `node_modules/.vite` silinerek temizlenir.
- **DeciShip CSS yükleme sırası önemlidir** (tokens → tokens.deciship → shell → primitives → app → pages). Sırayı ya da `primitives.css` ile `app.css` arasındaki seçici özgüllüğünü değiştirmek görünümü kaydırır; sonra `npm run test:visual` koş.
- **Üretilen belirteç dosyalarını elle düzenleme** (`tokens.css`, `tokens.deciship.css`, `theme.generated.ts`, `bands.generated.ts`, `palette.generated.ts`, site `styles/tokens.css`): bir sonraki üretimde silinir ve `build.mjs --check` kırılır. Değeri `tokens.json`'da değiştir.
- **CI'da `.test-logs` gizli klasördür.** Günlük yüklemesi `include-hidden-files: true` ister; yoksa hata günlükleri yüklenmez. Yeşil hızlı iş veritabanı testlerinin geçtiği demek değildir: veritabanı işi atlanmış ya da ertelenmiş olabilir (`npm run main:ready` söyler).
- **İşlem içinde `include` yok.** Prisma etkileşimli işlemde birden çok ilişkiyi `include` ile okuyunca aynı bağlantıda paralel sorgu atar (pg: "client is already executing a query"). Alt tabloları sırayla oku ya da işlemden sonra oku (`services/tariffs.ts` `createTariff` üstündeki not).
- **`findUnique` ve dizi biçimli `$transaction` yasak.** Prisma bunları aynı tikte toplar, sorgu başka firmanın bağlamında çalışır. `findFirst` ve `$transaction(async (tx) => …)` kullan; `test/rls.test.ts` kaynakta `findUnique` arar (`src/db.ts` notu).
- **RLS + FORCE ile göçte veri doldurma.** Göçte firma bağlamı yoktur ve tablo sahibi de FORCE RLS'ye tabidir: doldurulan tablolarda önce `NO FORCE ROW LEVEL SECURITY`, sonunda `FORCE` (örnek `20261107120000_invoice_current_no`, `20261111120000_frozen_results`, `20261112120000_import_report`). Bunu unutan `UPDATE` hata vermez, sessizce hiçbir satırı değiştirmez (`20261110180000_tariff_fuel_variable` böyle kaldı). Doldururken `updatedAt` değiştirme; bayatlık denetimi ve varsayılan tarife seçimi ona bakar.
- **Prisma'nın önerdiği göç bileşik anahtarları bozar.** `--create-only` çıktısını oku; `npm run db:check-drift` koş.
- **Ham SQL satır yazımı.** `services/lineWrite.ts` sütunları elle listeler; satıra alan ekleyince INSERT, UPDATE ve `jsonb_to_recordset` tip listesini birlikte güncelle, `lineWriteEquivalence` koş.
- **Fiyat izni ve alan adları.** Para alanı adı `price|amount|expected|diff|net|billed|overcharge|...` kalıbına uymazsa ölçüm rolüne sızar; uyan ama para olmayan bir ad da silinir (`app.ts` `MONEY_KEY`, `MONEY_WORDS`).
- **Rol adı kodda geçmez.** `permissionMatrix` kaynakta rol adı ve yönetici denetimi arar; izne bak (`can`).
- **Regex'te görünmez karakter.** `\b` bir araç ya da `echo -e`/`printf` üzerinden geçince backspace (0x08) olarak dosyaya yazılabilir; regex sessizce hiç eşleşmez. Yazdıktan sonra denetle: `git grep -nIP "[\x00-\x08\x0B\x0C\x0E-\x1F]" -- '*.ts' '*.tsx' '*.mjs' '*.js' '*.json'` boş dönmeli.
- **Bash heredoc'ta ters eğik çizgi.** Tırnaksız `<<EOF` içinde `\\` tek `\` olur, `$` ve backtick genişler; kod yazarken `<<'EOF'` kullan ya da Write/Edit aracıyla yaz.
- **Windows'ta test süreci sessizce ölürse** (çıkış 0xC0000409): Node 24.15 keepalive hatası; `test/winKeepAliveGuard.ts` bunu atlar, kaldırma.
- **İş kapsamı (`withJobScope`, `app.scope = 'jobs'`) işi bitmiş duruma geçiremez.** RLS yeni satırı da SELECT ilkesine vurur; bitmiş satır `jobs_runner_read`'e uymaz ve yazım 42501 ile düşer. Bitiş (`SUCCEEDED`, `FAILED`, `CANCELLED`, `JOB_ABANDONED`) hep işin kendi firma bağlamında yazılır; kapsamdan yalnız sahiplenme, kalp atışı, kira bırakma ve aday listesi yapılır.
- **İş işleyicileri düz yolla tembel içe aktarılır** (`registry.ts`: `await import('./handlers/x.ts')`, sabit yol). Paketleme tsup ile yapılır: yolu değişkenle kurma, sabit yol yaz (derleme çıktısında çözülsün); tembel yükleme döngüsel içe aktarmayı da önler.
- **Testler `JOB_RUNNER=inline` koşar** (`vitest.config.ts`): başlatan uç işi sonuna kadar çalıştırır, `buildApp` döngü açmaz. Gerçek döngüyü yalnız `jobs`, `jobKinds`, `bulkJob` dener ve `afterEach`'te `await runner.stop()` çağırır; çağırmayan test asılı kalır. Satır içi kip `runAfter`'ı ve firma başına grup sınırını uygulamaz.
- **`discardPreviewFile` aynı `File` satırını tutan bir işlemin içinden çağrılmaz.** Kendi bağlantısını açıp aynı satırı `FOR UPDATE` ile kilitler; çağıran işlem satırı tutuyorsa kendi kendini bekler. İçe aktarma işleminden sonra, işlem dışında çağır.
- **Yeni iş yazımları sahiplik ister:** ilerleme, kaldığı yer ve bitiş `WHERE "lockedBy" = <belirteç> AND status = 'RUNNING'` ile yazılır; 0 satır = kira kaybı, sonuç atılır. Fatura yazan işte çit (`ctx.fence(tx, …)`) fatura yazımıyla aynı işlemde olmalı.
- **Web ve mobil API tipleri elle tutulur.** Derleme API değişikliğini yakalamaz. Panel ve Merkez için seçili uçlarda sözleşme kaydı yakalar (gerçek şekil değişince API testi, kayıt yenilenince sahte API testi kırılır); kayıtta olmayan uçta ve mobilde sahte sunucu eski şekli döndürmeye devam eder ve e2e yeşil kalır.
- **Mobil yalnız alt yollardan içe aktarır** (`@deciship/core/calc`, `/i18n`, `/measure`, `/barem`, `/format`); `calc.ts`, `measureInput.ts`, `barem.ts` içine ağır import eklenmez.
- **`ENABLE_DATA_RESET`**: kapalıyken sıfırlama ucu hiç kaydedilmez; compose varsayılanı `false`, testte açık (`vitest.config.ts`), üretimde açıksa servis başlamaz (`src/env.ts`).
- **Üretilen `.conf` ve JSON elle düzenlenmez** (`Platform/gateway/conf/products/*.conf`, `apps/site/src/content/products.generated.json`): kayıt değişince `npm run products:gen` koş ve commit et; `npm run products:check` bayatı yakalar.
- **Hesap servisine yeni ortam değişkeni eklenince compose'a da eklenmeli** (`docker-compose.yml`, `docker-compose.prod.yml`); yoksa test düşer. Yoksa değişken kapta sessizce hiç gelmez (acil kapatma `PRODUCT_LAUNCH` böyle çalışmaz olurdu). Bilinçli istisnalar testte yazılı (`DISPATCHER_INTERVAL_MS`, `REFRESH_REUSE_GRACE_SECONDS`).
- **Kimlik paketinde `definition` yalnız `NODE_ENV=test` iken kabul edilir** (auth-kit `resolveProductDefinition`); üretimde kayıttaki tanım okunur. Test fikstürü dışında kullanma.
- **Kilit sırası:** firma (`FOR NO KEY UPDATE`) → abonelik → kişi → üyelik → davet. Kişi ya da üyelik kilidinden sonra firmayı kilitleme (`test/ordering.test.ts`). Abonelik işleminin yeni akışı bu sırayı bozarsa ölü kilit olur.
- **Araç anahtarı ayrılmış adlarla çakışamaz** (`RESERVED_PRODUCT_KEYS`: Merkez ve gateway yolları) ve nginx değişkenleri önekli yazılır (`$sod_p_<anahtar>_api`).
- **Prisma `contains` / `startsWith` `%` ve `_`'yi kaçışlamaz** (Prisma 7 değeri olduğu gibi `LIKE` içine koyar): kullanıcı aramasında `likeEscape` (`lib/util.ts`; `services/bulkDecide.ts`'te aynısı) kullan, yoksa `q=%` her satırı bulur.
- **Deneme turu koruması:** taşıyıcı, tarife ya da fatura ekleyen yeni uç `DEMO_BLOCKED`'a girmezse deneme sırasında gerçek veri eklenebilir ve bitirmede karışır; `demoTour` testi yazma uçlarını listeyle karşılaştırır. `demo:` öneki yalnız sunucunundur.
- **Bant rengi ürün başına üretilmez:** `bandTheme` `deciship` ve `tagpress` dallarını biliyor (`tokens.json` `bands`); öbür araçlar katalog renginden türer, sabit bant için `tokens.json` girdisi ve `bandTheme` satırı gerekir.
- **TagPress'te SQL iki veritabanında çalışmalı.** Servis kodu senkron; platform kipinde aynı SQL köprüden Postgres'e gider. Köprünün çevirmediği SQLite işlevi (`json_*`, `rowid`, `COLLATE NOCASE`, `PRAGMA`) çalışma anında hata verir: `dialectSql(db, { sqlite, pg })` ile ikiye ayır, `pnpm test` ve `pnpm test:pg` ikisini de koş. Firma kapsamı `$org` (ve `$member`) adlı parametresiyle; kapsamsız SQL her kipte reddedilir.
- **TagPress'e yeni tablo ya da sütun:** SQLite göçü (`db/migrations/NNNN-*.ts`) ve Postgres göçü (`db/pg/migrations/NNNN-*.sql`; `org_id` NOT NULL, `Company` FK, ENABLE + FORCE RLS, ilke) birlikte; silme sırası `org/tables.ts` `PG_PURGE_TABLES`; şema eşliği testi kırılır. Uygulanmış `.sql` göçü değiştirilmez (çalıştırıcı özetle durur).
- **Senkron köprü olay döngüsünü bekletir:** platform kipinde uzun sorgu bütün TagPress isteklerini durdurur (`statement_timeout` 30 sn, `lock_timeout` 5 sn). Async havuzdaki işlemler (olaylar, silme, Merkez uçları) kısa tutulur; servislerin yazdığı tablolara async yoldan yalnız kalıcı silme yazar.
- **Yapay zekâ geçidinin retleri yeniden denenmez:** `x-should-retry: false` gelen yanıt (her `sod_*` reddi ve ücret doğmuş olabilecek 5xx) araçta da tekrar edilmez; yeniden deneme ikinci ücret olabilir. Araçta yeni yapay zekâ çağrısı `X-SOD-*` bağlamıyla ve araç jetonuyla açılır, sağlayıcı anahtarına hiçbir kipte ortamdan düşülmez.
