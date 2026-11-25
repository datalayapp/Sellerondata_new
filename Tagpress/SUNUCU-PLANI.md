# TagPress: firma alanı, kurulum ve özellik anahtarları, sitede tasarım dili oluşturma (birleşik sunucu planı)

> Hazırlanış 2026-11-21 (1. aşama). Platform kipi (2. aşama, 2026-11-23) bu planın dışındadır: bugünkü hâli `YOL-HARITASI.md` "Durum" ve `SONRAKI-OTURUM/kod-haritasi/tagpress.md`. Kapsam yol haritasının 4. adımındaki firma alanı, 5. adımı ve 6. adımı. Plan yalnız sunucu, veri ve yapay zekâ tarafını ve arayüzün kullanacağı API sözleşmesini kapsar. `apps/web` bu planda yok, o iş `ARAYUZ-PLANI.md`'de yürüyor.
> Yollar `C:\Users\Gokcan\Desktop\SellerOnData\Tagpress\` köküne göredir. **[V]** ile işaretli maddeler varsayımdır. Kullanıcı aksini söylerse plan o maddede değişir.
> Kaynaklar: `YOL-HARITASI.md`, `CLAUDE.md`, `ARAYUZ-PLANI.md`, `docs/tezgah-tuval.html` (maket 5 ve 6), `PLAN.md`, `HANDOFF.md`, `apps/server/src/**`, `packages/{domain,ai,learn}`, `apps/mcp`, `.claude/skills/tasarim-dili/SKILL.md`, `Platform/docs/mimari/{02-kimlik,06-merkez}.md`, `Platform/packages/product-kit/src/{projection,purge,org,db}.ts`, `Platform/packages/contracts/src/products.ts`. Sahibin veritabanı salt okunur açılıp satırları sayıldı.

## 0. Kısaca

- **Firma çekirdeği.** Her kiracı tablosuna `org_id` sütunu eklenir. İstek başına firma `AsyncLocalStorage` ile taşınır. Veritabanına tek bir kapsamlı erişim katmanından (`TenantDb`) gidilir. Kapsamı (`$org`) olmayan SQL bu katmanda çalışmaz. İki firmalı bir izolasyon test takımı bütün uçları dolaşır.
- **Dosyalar.** `data/` altındaki firma klasörleri `data/firmalar/<orgId>/` altına taşınır. Kayıtlardaki göreli yollar değişmez, çünkü taban artık firma kökü olur. Yedek fontlar (`data/ortak`) ortak kalır.
- **Firma bağlamının kaynağı.**
  - 1. aşamada tek yerel firma vardır (`LocalOrgResolver`).
  - 2. aşamada Hesap servisinin jetonu okunur (`PlatformOrgResolver`, auth-kit). Servisler yalnız `OrgContext`'i gördüğü için iş kodu değişmez.
- **Sahibin verisi.** Bugünkü verinin hepsi sahibin firmasına atanır: 1 dil, 54 şablon, 220 referans, 2 sayfa şablonu, 23 iş, 51 AI çağrısı, ayarlar ve anahtarlar. Sahibin firmasında bütün özellikler açık olur ve kurulum "tamamlandı" sayılır.
- **Yeni firmalar.** Ürünle gelen varsayılan dil, açık lisanslı fontlar ve sade şablonlarla açılır.
- **Özellik anahtarları.** Domain'de bir özellik kaydı tutulur, seçimler firma ayarında saklanır. Kapalı özelliğin yazma uçları `409 feature-off` döner; okuma açık kalır, veri silinmez. Hangi ucun hangi özelliğe bağlı olduğu tek bir tablodadır ve bir test, tablosuz uç kalmadığını denetler.
- **Sitede tasarım dili oluşturma.**
  - Messages API ile sunucuda çalışan bir araç döngüsüdür. Model Claude Opus 5.5: görsel girdi, katı (strict) araçlar, akış hâlinde yanıt, istem önbelleği.
  - Model profili doğrudan yazamaz. Yalnız kanıtlı değişiklik önerir (`propose_changes`): her değerin bir ölçüm anahtarı ya da kullanıcı cevabı olmalıdır, yoksa sunucu reddeder.
  - Her değişiklik geri alınabilir bir taslak revizyonudur. Örnek etiketler ücretsiz motor denemesiyle çizilir. Yayını yalnız kullanıcı yapar.

## 1. Bugünkü durumdan çıkan bulgular (planı etkileyenler)

1. Bütün servisler tekildir ve doğrudan `db.prepare` çağırır. Kapsam kavramı hiç yok. Kimlikle çalışan uçlar dil kapsamına bakmıyor: `/api/jobs/:id`, `/api/variants/:id`, `/api/references/:id`, `/api/undo/:token`, `/api/ai-calls/:id`, `/api/template-tasks/:id`, `/api/learn/previews/:dir/:file`, `PRINT_API` oturumları. Firma denetimi bu yüzden servis katmanında yapılmalı.
2. `settings` tablosu karışık. Bugün beş satırı var:
   - `app`: varsayılan dil, eşzamanlılık, görsel denetim, varyasyon sayısı
   - `key:anthropic` ve `key:gemini`: DPAPI ile şifreli
   - `imported:benim-tarzim`
   - `print.presets.benim-tarzim`
3. `SecretService.get`, kayıtlı anahtar yoksa `ANTHROPIC_API_KEY` ortam değişkenine düşüyor. Çok kiracılıda bu, sahibin anahtarını her firmaya açar. Ortam yedeği yalnız açık bir kurulum ayarıyla çalışmalı.
4. Mükerrer iş denetimi (`jobs_dedupe`, `rows.ts` `existing/similar`) bütün işlere bakıyor. Firma kapsamı olmazsa A firması B'nin siparişinin "zaten içe aktarıldı" bilgisini alır. Bu bir kiracılar arası sızıntıdır.
5. Dil kimliği bugün addan türetiliyor ve bütün kurulumda tekil (`uniqueId`). Ayrı firmalarda bu, başka firmanın dil adlarını ele verir (`lavanda-2`). Yeni diller UUIDv7 kimlik alır. Bootstrap'in kimlik düzeni (`^[a-z0-9][a-z0-9-]{0,40}$`) UUID'yi kabul ediyor; `benim-tarzim` olduğu gibi kalır.
6. Üretim kuyruğu (`gen_tasks`) ve SSE (`EventBus`) kurulum genelinde çalışıyor. `kick()` istek içinden mikro görevle çağrılıyor; `AsyncLocalStorage` kullanılırsa görev, isteği atan firmanın bağlamını miras alır. Her görev kendi firmasında açıkça başlatılmalı.
7. Göçler yalnız SQL metni. Sahibin firması için UUIDv7 ve dosya taşıma gerekiyor, ikisi de JavaScript işi. Göç çalıştırıcısının işlev kabul etmesi gerekir.
8. SQLite, `REFERENCES` içeren sütunu `ALTER TABLE ADD COLUMN` ile ancak `NULL` varsayılanla ekliyor. NOT NULL için 22 tabloyu yeniden kurmak gerekir. Bunun yerine sütun boş bırakılabilir eklenir; boş değeri ve firma değişikliğini tetikleyiciler engeller. Postgres'te sütun baştan NOT NULL ve yabancı anahtarlı olur.
9. Referanslar ölçüm için yapılandırılmış satır verisi istiyor: font, punto, mürekkep kutusu. Kullanıcının yükleyeceği bitmiş etiket görsellerinde bu veri yok. Görselden ölçüm yeni bir ardışık işlem olur (bkz. §4.4).
10. Bugün tek taslak satırı yerinde güncelleniyor (`profile_versions` taslak). Maket 5'teki "Sürüm 2 / 3", "Sürüm 2'ye dön" ve "değişen kurallar" için taslağın revizyon geçmişi gerekir.
11. Maket 6'da "Görsel denetim" açık görünüyor. Oysa `PLAN.md` ölçümü (2026-10-09) bu özelliğin sonucu iyileştirmediğini, maliyeti %43 artırdığını gösteriyor ve kararı "varsayılan kapalı". Kullanıcıya sorulacak (§8).
12. Hesap servisinde firma kimliği UUIDv7 (`Organization.id @default(uuid(7))`). product-kit'in beklentisi:
    - firma tablolarında `"orgId"` sütunu ve `Company`'ye yabancı anahtar;
    - `orgId`'siz çocuk tablolarda ebeveyne `ON DELETE CASCADE`;
    - RLS ilkesi `app.org_id` üzerinden;
    - parça parça kalıcı silme (`purge.tables` silme sırasıyla).

## 2. Firma alanı (A): veri modeli

### 2.1 Yeni tablolar (göç 9)

| Tablo | Sütunlar | Not |
|---|---|---|
| `orgs` | `id TEXT PK` (UUIDv7), `name`, `source` (`local`\|`account`), `created_at`, `closed_at`, `purged_at` | product-kit `Company` karşılığı. 2. aşamada `id` Hesap'taki firma kimliğidir |
| `org_settings` | `org_id`, `key`, `value` (JSON), PK(`org_id`,`key`) | `app`, `features`, `setup`, `print.presets.<dil>`, `imported:<dil>`, `ai.limits` |
| `org_secrets` | `org_id`, `provider`, `format`, `value`, `updated_at`, PK(`org_id`,`provider`) | Firmanın API anahtarları |

- `settings` tablosu yalnız kurulum düzeyinde kalır: `install.ownerOrgId`, `install.defaultOrgId`, `files.layout`, `install.maxConcurrency`.
- **[V]** Ürünün kendi anahtarı 1. aşamada yoktur. 2. aşamada ortam değişkeninden gelir, veritabanına yazılmaz.

### 2.2 `org_id` alan tablolar

Bugünkü kiracı tablolarının hepsi (22 tablo):

`languages`, `profile_versions`, `templates`, `batches`, `jobs`, `variants`, `gen_tasks`, `job_log`, `ai_calls`, `refs`, `learn_proposals`, `undo`, `design_sessions`, `design_session_entries`, `adjust_log`, `template_tasks`, `learn_runs`, `print_templates`, `print_sessions`, `print_pages`, `print_items`, `print_exports`

C adımının yeni tabloları da baştan `org_id` taşır (§4.2).

- **Karar: çocuk tablolar da `org_id` taşır.** product-kit buna izin veriyor (ebeveyne cascade de kabul). Gerekçe:
  - RLS ilkesi her tabloda aynı tek satır olur;
  - kimlikle gelen her sorgu kendi satırında denetlenir;
  - kalıcı silme sırası basitleşir.
- Her tabloya iki tetikleyici eklenir:
  - `BEFORE INSERT ... WHEN NEW.org_id IS NULL` → `RAISE(ABORT)`;
  - `BEFORE UPDATE OF org_id ... WHEN NEW.org_id IS NOT OLD.org_id` → `RAISE(ABORT)`. Firma değişmez.
- Dizinler firmayla başlar:
  - `languages(org_id, created_at)`, `batches(org_id, language_id, created_at)`;
  - `jobs(org_id, dedupe_key)`, `jobs(org_id, created_at)`;
  - `refs(org_id, language_id, created_at)`, `ai_calls(org_id, created_at)`;
  - `gen_tasks(status, org_id, created_at)`, `print_sessions(org_id, language_id, status, updated_at)`;
  - `design_sessions(org_id, language_id, started_at)`.
  - Eski tek sütunlu dizinler kaldırılır.
- **Ad uyumu.**
  - TypeScript, API ve domain'de `orgId`. SQLite'ta `org_id`: bugünkü 30'dan çok yılan biçimli sütunla tutarlı.
  - Postgres'te product-kit'e uygun `"orgId"`. Eşleme tek yerde, depo katmanındadır. Postgres DDL'i 2. aşamada zaten yeniden yazılacak (JSON → jsonb, ISO metin → timestamptz).
- **Kimlik biçimi.** Firma UUIDv7 (Hesap ile aynı biçim). Yeni dil kimliği UUIDv7. Mevcut kimlikler (UUIDv4 kayıtlar, `benim-tarzim`) değişmez. `apps/server/src/util/ids.ts` içine bağımlılıksız `uuidv7()` yazılır.

### 2.3 Göç 9 ve geri dönüş

1. Göç çalıştırıcısı (`db/database.ts` `migrate`) `string | (db) => void` kabul eder. Göçler `db/migrations/0009-firma.ts` gibi ayrı dosyalara bölünür. `MIGRATIONS` dizisi bunları sırayla bağlar; dizideki satırı orkestratör ekler.
2. Bekleyen göç varsa, göçten önce otomatik yedek alınır: WAL boşaltılır, sonra `data/yedek/db-<tarih>-goc-<n>-oncesi/` klasörüne kopyalanır.
3. Göç 9 işlevi:
   - kiracı verisi varsa (`languages` ya da `settings.app` satırı) firma açılır: `orgs(id=uuidv7, name='Firmam', source='local')` **[V]**;
   - sahip adı ("GiftUpStore") koda yazılmaz; ilk açılışta Ayarlar > Firma'dan ya da `PATCH /api/org` ile verilir;
   - bütün tablolarda `UPDATE … SET org_id = <sahip>`;
   - `settings` satırları taşınır: `app`, `print.presets.*` ve `imported:*` → `org_settings`; `key:*` → `org_secrets`;
   - `install.ownerOrgId` ve `install.defaultOrgId` yazılır.
4. Taze kurulumda göç firma açmaz. İlk açılışta `OrgService.ensureLocal()` "Firmam"ı varsayılan içerikle kurar ve kurulumu "bekliyor" durumunda bırakır.
5. **Geri dönüş:** uygulama kapalıyken yedek klasöründeki `studio.db` (`data/yedek/db-<tarih>-goc-<n>-oncesi/`) veritabanının yerine konur; eski kod geri yüklenmiş yedeği olduğu gibi açar (geri dönüş betiği yok). Göç ileri yönlüdür, ters SQL yazılmaz.
6. Prova: sahibin verisinin kopyasıyla 5499'da, `TAGPRESS_DATA_DIR` ayarlı ve anahtarlar silinmiş olarak. Satır sayıları göçten önce ve sonra eşit olmalı.

### 2.4 Dosya düzeni

- Firma kökü `data/firmalar/<orgId>/`. Altında aynı adlarla `diller/`, `referanslar/`, `onizleme/`, `baski/`, `aktarim/` ve yeni `tasarim-oturumlari/`.
- `data/ortak/fontlar` (açık lisanslı yedek fontlar) ve `data/yedek` kurulum düzeyinde kalır.
- Kayıtlar göreli yol tutuyor (`ref.image = "referanslar/benim-tarzim/…"`, `variants.preview_file = "<uuid>.png"`). Taban firma kökü olunca bu değerler olduğu gibi geçerli kalır; JSON yeniden yazılmaz.
- `dataPaths()` bugünkü alan adlarıyla firma köküne göre çözülür. `ctx.paths` o anki firmanın kökünü okuyan alıcılarla kurulur, böylece servis kodu değişmez. Firma bağlamı yoksa hata fırlatır.
- Taşıma bir kez yapılır, açılışta servisler kurulmadan önce, `files.layout = 2` işaretiyle ve klasör klasör `rename` ile. Yarıda kalırsa kaldığı yerden sürer. Hata olursa sunucu açılmaz ve açık bir ileti verir.
- **Sahibe özgü otomatik yükleme.** Bootstrap yalnız o firmanın kendi `aktarim/` klasörüne bakar. Ürünle hiçbir paket gelmez, başka firmanın klasörü boştur. Ayrıca `config.bootstrapPackages` ayarı (varsayılan kapalı, sahibin `.env`'inde açık) eklenir. Sahipte `imported:benim-tarzim` işareti olduğu için bugün zaten hiçbir şey yapmaz.

### 2.5 Erişim katmanı: kapsamın unutulmasını önleyen yapı

- `apps/server/src/org/context.ts`:
  - `runInOrg(orgId, fn)`, `currentOrg()` (bağlam yoksa hata), `maintenance(fn)` (kurulum geneli bakım; product-kit'in bakım kapsamına benzer).
  - `OrgContext = { orgId, memberId: null, permissions: 'all', locale, source }`.
- `apps/server/src/org/tenant-db.ts` (`TenantDb`), servislerin veritabanına tek yolu:
  - `prepare(sql)` SQL'i tarar. Kiracı tablosuna dokunan (`FROM/JOIN/INTO/UPDATE <tablo>`) ama `$org` geçmeyen ifade hata verir. `INSERT` için `org_id` sütunu ve `$org` zorunlu.
  - Çalıştırırken adlı parametre `{ org: currentOrg().orgId }` eklenir. node:sqlite adlı ve konumlu parametreyi birlikte kabul eder, bu yüzden bugünkü `?` parametreleri aynen kalır. Hedef sürüm Node 24.22.1; **[V]** davranış bir küçük testle doğrulanır.
  - Kurulum tablolarına (`settings`, `orgs`) yalnız `TenantDb.install` ve `maintenance` içinden erişilir.
- `apps/server/src/org/tables.ts`:
  - `TENANT_TABLES`, silme sırasıyla, çocuk önce: `print_items`, `print_pages`, `print_exports`, `print_sessions`, `print_templates`, `adjust_log`, `job_log`, `gen_tasks`, `variants`, `jobs`, `batches`, (C tabloları), `design_session_entries`, `design_sessions`, `learn_runs`, `learn_proposals`, `refs`, `template_tasks`, `ai_calls`, `undo`, `templates`, `profile_versions`, `languages`, `org_secrets`, `org_settings`.
  - Aynı liste 2. aşamada product-kit `purge.tables` olur.
- Testler:
  - `sqlite_master` taramasıyla her kiracı tablosunda `org_id`, iki tetikleyici ve firmayla başlayan dizin var mı;
  - kapsamsız SQL örnekleri koruyucuda hata veriyor mu;
  - iki firmalı izolasyon takımı (A4): her `GET/POST/PATCH/DELETE` ucu A'nın kimlikleriyle B'nin bağlamında `404` döner, B'nin listeleri boştur;
  - SSE'de B, A'nın olayını görmez; mükerrer denetimi firmalar arasında eşleşmez; önizleme dosyası başka firmanın kökünden sunulmaz.

### 2.6 Firma kapsamına inen ayarlar, kuyruk, SSE

- **Etkin dil.** `defaultLanguageId` firmanın `org_settings.app` ayarına iner. Kişinin seçtiği dil bugünkü gibi tarayıcıda (`studio.dil`) kalır. Firma ayarına inenler: `concurrency` (kurulumun üst sınırını aşamaz), `variantsPerRun`, AI sınırları. `visualCritique` özellik anahtarına geçer (§3).
- **Kuyruk.**
  - `gen_tasks.org_id`. Kurulum genelinde en çok `install.maxConcurrency` iş üretilir (**[V]** 4, ortam değişkeniyle değişir); firma başına en çok kendi `concurrency` ayarı kadar.
  - `kick()` sırayı adil seçer: bekleyen işi olan firmalardan o an en az işi çalışan, eşitse en eski görev.
  - Her görev `runInOrg(task.orgId)` içinde çalışır. `status()` firmaya göre döner, `recover()` bakım kapsamındadır.
  - Aynı kural `template_tasks`, `learn_runs`, `print_exports` ve C'nin oturum turları için geçerlidir.
- **SSE.**
  - `EventBus.emit` olaya geçerli firmayı ekler; bağlam yoksa test ve geliştirmede hata fırlatır.
  - `/api/events` abone olurken isteğin firmasını alır ve yalnız o firmanın olaylarını yazar. `queue` olayı firmaya göre durum taşır.
- **Anahtarlar.**
  - `SecretService` `org_secrets`'tan okur; bellekteki önbellek firma ve sağlayıcı anahtarlıdır.
  - Ortam yedeği yalnız `install.productKey` açıksa çalışır (1. aşamada kapalı).
  - `adapters/ai.ts`'deki istemci önbelleği tek girdili ve her anahtar değişiminde temizleniyor; küçük bir LRU'ya çevrilir.
  - DPAPI yerine taşınabilir şifreleme (AES-GCM, ana anahtar ortam değişkeninde) yol haritasının "Windows bağımlılıkları" maddesidir. Bu planın parçası değil, ama `SecretCipher` arayüzü firma tablosuyla uyumlu bırakılır. Bu iş 2026-11-21'de ayrıca yapılıyor; A0 onun bıraktığı `secret-box` arayüzünü kullanır.

### 2.7 1. ve 2. aşamada firma bağlamının kaynağı

- `OrgResolver` arayüzü: `resolve(req) → OrgContext`. `app.ts`'deki `onRequest` kancası onu çağırır ve isteği `runInOrg` ile sürdürür.
- **1. aşama: `LocalOrgResolver`.**
  - Firma `TAGPRESS_ORG` ortam değişkeninden, yoksa `install.defaultOrgId`'den gelir. İzinler `all`.
  - Firma değiştirme ucu yok. İkinci firmayı denemek için `pnpm firma ekle|liste|sil` (sunucu kapalıyken) ve `TAGPRESS_ORG=<id>` ile 5499'da açılış.
- **2. aşama: `PlatformOrgResolver`** (`TAGPRESS_AUTH=platform`).
  - auth-kit jetonu doğrular. `org` ve `prod.tagpress` yoksa 403; `X-SOD-Org` uyuşmazsa `409 ORG_MISMATCH`; abonelik `READ_ONLY` ise yazma 403.
  - Tanınmayan firma JIT olarak `orgs`'a yazılır (`id = claims.org`, `name = orgName`).
  - `OrgContext.memberId = mid` ve izinler jetondan gelir.
  - Bugünkü yerel güvenlik kuralları (Host, `X-Studio`) `SecurityMode = local` altında kalır; platformda `X-SOD-CSRF` ve köken listesi.
- **Neyin değişmeyeceği.** Servisler yalnız `OrgContext` ve `TenantDb` arayüzünü görür. 2. aşamada `PgTenantDb` (`withOrg` + RLS) yazılır.
  - Dürüst not: SQL metinleri Postgres'e taşınacak (`?` → `$n`, `json_*` → jsonb). Bu bir depo katmanı işidir, iş kuralı değişmez.
  - 1. aşamada yeni kodda SQLite'a özgü işlev kullanılmaz. A paketleri bugünkü `json_*` kullanımlarının listesini rapora yazar.
- **Firma kimliğinin eşlenmesi.** SQLite'tan Postgres'e taşıma zaten tek seferlik bir aktarım olacak. Yerel sahip firma kimliği bu aktarımda Hesap'taki GiftUpStore kimliğine çevrilir: sütunlar ve `data/firmalar/<id>` klasör adı. **[V]** 2. aşamada dosyalar nesne deposuna `org/<orgId>/…` önekiyle gider.
- Platform kaydı: `products.ts` tagpress girdisi bugün `permissions: {}, roles: []`. 1. aşamada uç tablosu (§3.3) her uca `access: read | write | spend` işareti koyar. 2. aşamada bu işaretler izin adlarına bağlanır, uç kodu değişmez.

### 2.8 Ürünle gelen varsayılan içerik

- `assets/varsayilan/` (depoda):
  - `fontlar/`: yalnız OFL ya da Apache lisanslı; **[V]** bir el yazısı, bir serif, bir sans, her birinin lisans dosyasıyla;
  - `sablonlar/`: 4–6 sade şablon (düz daire, ince kenarlı daire, kurdele bantlı daire, dikdörtgen ürün etiketi). Bir betikle SVG'den üretilir, kendi işimiz, CC0;
  - `profil.json`.
- Varsayılan profil: `packages/domain/src/defaults.ts` `defaultProfile()`. Şema varsayılanları artı paketteki fontların listesi. Uydurma ölçüm yoktur; arayüz bunu "varsayılan ayarlar" diye gösterir.
- Yeni firma açılınca (`OrgService.create`): varsayılan dil v1 yayınlanmış olarak, şablon ve font dosyaları firma köküne kopyalanmış olarak, özellikler kayıttaki varsayılanlarla ve kurulum `pending` olarak gelir.
- Test: paketteki her fontun yanında OFL ya da Apache lisans dosyası var; `assets/varsayilan` sahibin `data/` dosyalarından hiçbirini içermiyor (ad ve özet karşılaştırması); yeni firmada `benim-tarzim` görünmüyor.

### 2.9 Firma API'si

| Uç | İstek → yanıt |
|---|---|
| `GET /api/org` | → `{ org: { id, name }, setup: SetupState, features: FeatureView }` |
| `PATCH /api/org` | `{ name }` → aynı biçim |
| `GET /api/org/usage` | → `{ monthUsd, limitUsd, byPurpose[] }` (bugünkü `costs` firma kapsamlı hâliyle) |

## 3. Kurulum ve özellik anahtarları (B)

### 3.1 Özellik kaydı (`packages/domain/src/features.ts`)

| Anahtar | Bugünkü yetenek | Varsayılan | Ücret |
|---|---|---|---|
| `core.production` | Üretim, karşılaştırma, onay, en iyiyi onayla | her zaman açık | Haiku, az |
| `import.json` | Toplu JSON içe aktarma masası | açık | — |
| `jobs.manual` | Elle iş ekleme | açık | — |
| `adjust` | Düzelt (elle düzeltme, metin ve font) | açık | — |
| `revise` | "Şunu değiştir" | açık | Haiku |
| `image.onTemplate` | Görselle üret: şablona yaz | kapalı | Gemini |
| `image.themeTemplate` | Temadan şablon üret | kapalı | Gemini |
| `critique` | Görsel denetim (bugünkü `visualCritique`) | kapalı | Haiku |
| `learn` | Düzeltmelerden öğren, öneriler, referanslar | kapalı | — |
| `print` | Baskı masası, sayfa şablonları, arşiv | açık | — |
| `print.stickers` | Sticker sayfaları (`print`'e bağlı) | kapalı | — |
| `templates.editor` | Şablon alanı düzenleme, alan önerisi, deneme | açık | — |
| `language.builder` | Yapay zekâ ile tasarım dili (Oluştur) | açık | Opus |
| `language.rules` | Kuralları elle düzenleme, sürümler, geri dönüş | kapalı | — |
| `language.multi` | Birden çok tasarım dili | kapalı | — |
| `language.package` | Dil paketini dışa ve içe aktarma | kapalı | — |
| `text.languages` | Birden çok metin dili (bağlaç ve edat listeleri) **[V]** (§8.4) | kapalı | — |

- Kayıtta her özellik için anahtar, grup, varsayılan, `paid`, `dependsOn` ve `always` alanları tutulur. Metinler arayüz sözlüğünde, `setup:features.<anahtar>`.
- Etkin değer kayıttaki varsayılanla firmanın açık seçimlerinin birleşimidir. Saklanan biçim `org_settings.features = { [anahtar]: { on, by: 'setup' | 'user' | 'migration', at } }`. Sonradan eklenen özellik kendi varsayılanıyla gelir.
- Sahibin firması (göç 11) her şey açık olarak kaydedilir; `critique` bugünkü değeri olan kapalıyla gelir. `setup.completedAt` göç anı, `by: 'migration'`. Sahip kurulum ekranını görmez.

### 3.2 Kurulum soruları ve anahtar eşlemesi (maket 6)

- **Adım 1, etiket türü** (birden çok seçilir): Düğün ve nişan · Vaftiz ve doğum · Doğum günü · Teşekkür ve hatıra · Ürün etiketi · Sticker.
  - Hangi tür seçilirse seçilsin: `core.production`, `import.json`, `jobs.manual`, `adjust`, `revise`, `print`, `templates.editor`, `language.builder`.
  - Sticker seçilirse ayrıca `print.stickers`.
  - Ürün etiketi özellik açmaz; tasarım dili sorularına dikdörtgen kesim, ürün adı ve gramaj satırı soruları eklenir.
  - Düğün, vaftiz, doğum günü ve teşekkür yalnız C'nin soru gruplarını tohumlar: çift isim, tarih satırı, kısa selam, yaş.
  - Hiçbir tür ücretli görüntü özelliğini ya da görsel denetimi açmaz.
- **Adım 2, tasarım dili.**
  - "Örneklerimle oluştur": C oturumunu başlatır; tahmini maliyet adımda yazar.
  - "Varsayılanla başla": varsayılan dil, özeti ve örnek etiketleriyle gösterilir (`POST /api/languages/:lang/showcase`).
- **Adım 3, baskı.** Kâğıt ön ayarı ve kesim makinesi kullanılıp kullanılmadığı sorulur. Bugünkü `PRINT_API` ön ayarlarından bir sayfa şablonu açılır. Ön ayarlar ölçülmedi; "başlangıç değeri" notuyla gösterilir.
- "Atla, varsayılanla başla": adım 1'deki ortak küme açılır, `setup.skipped = true`.
- **Yeniden çalıştırma.**
  - `POST /api/setup/preview` önceki cevapları ve yeni öneriyi fark olarak döner (açılacaklar ve kapanacaklar).
  - Kullanıcının elle açtığı (`by: 'user'`) özellik onaysız kapatılmaz.
  - `complete` yalnız onaylanan listeyi yazar.

### 3.3 Kapalı özelliğin uçları

- Merkezi tablo `apps/server/src/features/route-map.ts`: her `METOT yol` için `{ feature?: Anahtar, access: 'read' | 'write' | 'spend' }`.
  - `onRoute` ve `preHandler` kancası, özellik kapalıysa yazma ve harcama uçlarında `409 { code: "feature-off", feature }` döner. Bugünkü `missing-key` biçimine uyar; arayüz "Aç" önerir.
  - Okuma uçları açık kalır.
  - Kapatmak veri silmez. Kuyruktaki görevler biter, yenisi alınmaz.
- Gövdeye bağlı denetimler serviste yapılır (`features.require(...)`):
  - `generate` isteğinde `mode` görüntü kipindeyse `image.*`;
  - `critique` üretim akışında;
  - ikinci dil oluşturmak `language.multi`;
  - sticker türünde sayfa şablonu `print.stickers`: yalnız YENİ sticker şablonu yazılırken (oluşturma, ızgara, çoğaltma, etiket şablonunu sticker'a çevirme); var olanı düzenleme, adlandırma, arşivleme, anlık kopyadan geri getirme, oturum açma ve yeniden basma serbest.
- Bugünkü sınır: `language.rules` kapalıyken yalnız elle taslak yazma (`PUT .../profile/draft`) ve sürüme dönme 409 döner; taslağı yayınlama/atma ve öğrenme, oluşturucu ya da MCP'den gelen taslak çekirdek uç olduğu için API'den kurallar yine değişebilir, kapanma esas olarak arayüzdedir. `language.package` kapalıyken dışa aktarma (okuma ucu) açık kalır, yalnız içe aktarma 409 döner.
- Test: Fastify'ın kayıtlı bütün uçları tabloda var mı (tablosuz uç kalmaz); her özellik kapalıyken bir yazma ucu 409 dönüyor mu; okuma açık mı.

### 3.4 Kurulum ve özellik API'si

| Uç | İstek → yanıt |
|---|---|
| `GET /api/features` | → `{ registry: FeatureDef[], effective: Record<Anahtar, boolean>, explicit: Record<Anahtar, { on, by, at }> }` |
| `PATCH /api/features` | `{ [anahtar]: boolean }` → aynı (bağımlılık: `print.stickers` açılırsa `print` da açılır; kapanırsa bağlılar da kapanır, yanıtta yazar) |
| `GET /api/setup` | → `{ status: 'pending' \| 'in-progress' \| 'completed', step, answers, completedAt, skipped }` |
| `POST /api/setup/preview` | `{ answers }` → `{ features: suggested, changes: [{ key, from, to }] }` (kaydetmez) |
| `PUT /api/setup/answers` | `{ step, answers }` → SetupState (adım adım kayıt; tarayıcı kapanırsa kaldığı yerden) |
| `POST /api/setup/complete` | `{ answers, features }` → `{ setup, features }` |
| `POST /api/setup/skip` | → `{ setup, features }` |
| `POST /api/setup/restart` | → SetupState (eski cevaplar dolu, `in-progress`) |

Sözleşme `packages/domain/src/{features,setup}.ts` dosyalarında ve ayrı bir `SETUP_API` sabitinde tutulur (`PRINT_API` kalıbıyla). Böylece `api.ts` çakışmaz.

## 4. Sitede yapay zekâ ile tasarım dili oluşturma (C)

Sunucu servisi ve uçlar yazıldı (paket C3, göç 13); arayüz `#/tasarim-dili/olustur` ekranıdır. Kod: `apps/server/src/services/builder/*` (dosya başı yorumları kuralları anlatır), `routes/builder.ts`, `db/migrations/0013-olusturucu.ts`, sözleşme `packages/domain/src/{builder,builder-tools,builder-api}.ts`, model döngüsü `packages/ai/src/builder/*`.

### 4.1 Bugünkü akıştan ne taşınır

| Parça | Nasıl kullanılır |
|---|---|
| `ProfileService` (`saveDraft` doğrulaması, `publish`, `diffLeaves`) ve `mergePatch` | Aynen; revizyon yazımı bunların üstünde |
| `DesignSessionService` (oturum ve günlük) | Aynı tablolar genişledi (göç 13): durum makinesi, yapılandırılmış girdiler |
| `learning.measure` (`olcum_ozeti`), `learning.samples`, `learning.replay` (`motor_dene`) | Aynen, servis içi çağrı (HTTP yok) |
| `trials.profileTry` (motor ve AI kipi) | Aynen; açık profil nesnesi alan iç sürüm eklendi |
| MCP'nin saf yardımcıları (`formatProfile`, `schemaFields`, `formatReplay` …) | `packages/ai/src/builder/format.ts`'te; `apps/mcp` oradan içe aktarır |
| `PROFILE_DOCS` ve `PROFILE_GROUPS` | Araç yolu listesi, değişiklik etiketleri |
| `SKILL.md` (11 soru grubu, kurallar, akış) | Sürümlü sistem istemi (`studio-builder-v1`, `packages/ai/src/builder/prompt.ts`) |
| `taslak_yaz` → `propose_changes` | Kanıt zorunlu |
| `soru_kaydet` → `ask_user` | Hazır cevaplı yapılandırılmış soru |
| `oturum_baslat`, `oturum_notu`, `oturum_oku` | Sunucunun durum makinesi yapar, araç değil |
| `uretim_dene` (ücretli) | Modelin aracı değil; yalnız kullanıcı başlatır, önce tahmin gösterilir |

Claude Code ile çalışan MCP yolu sahibin ve geliştiricinin yolu olarak çalışmayı sürdürür. Aynı servisleri kullanır, aynı günlüğe yazar (`mode = 'mcp'`).

### 4.2 Oturum modeli ve veri (göç 13)

Göç numaraları: 11 özellikler, 12 baskı ölçüleri, 13 oluşturucu. Göç ikinci koşuda bir şey değiştirmez.

- `design_sessions`'a eklenen sütunlar (var olan MCP satırlarına dokunulmaz; hepsi `mode = 'mcp'` kalır):
  - `mode` (`mcp` \| `site`), `state`, `resume_state`, `base` (`published` \| `default`), `base_version`, `base_data` (revizyon 0'ın tam profili), `current_rev`;
  - `start_version`: açılıştaki yayınlanmış sürüm (yayında "oturum sürerken başka sürüm yayınlandı mı" denetimi için; taban varsayılan olsa da tutulur);
  - para: `cost_usd`, `budget_usd`, `budget_raised`; model: `model`, `prompt_version`, `locale`;
  - kurulum: `from_setup`, `label_types`;
  - çalışan tur kilidi: `turn_seq`, `turn_started_at`, `turn_input`, `next_seq`; bekleyen bildirimler `notices`; `error`; `measured_at`; AI kalite denemesi `quality_ai`.
- `design_session_entries`'e: `role`, `data` (JSON: soru, cevap, revizyon, kod + parametre), `turn_seq`. `ai_calls`'a `build_id` (oturumun harcamaları; bütçe ve maliyet dökümü buradan).
- Bir dilde en çok bir etkin site oturumu: kısmi tekil dizin `design_sessions_org_active` (yarışta ikinci açılış veritabanında durur).
- Yeni tablolar (`org_id` NOT NULL değil, göç 9 düzeni; boş ekleme ve firma değişikliğini iki tetikleyici durdurur):

| Tablo | Sütunlar | Not |
|---|---|---|
| `design_session_turns` | `id`, `org_id`, `session_id`, `seq`, `messages` (sıkıştırılmış ham iletiler, düşünme blokları dahil), `usage`, `cost_usd`, `stop_reason`, `created_at`, UNIQUE(`session_id`,`seq`) | Yalnız eklenir, hiç düzenlenmez: Opus 5.5'te düşünme blokları konuşmaya bağlıdır |
| `design_samples` | `id`, `org_id`, `session_id`, `language_id`, `seq`, `name`, `w`, `h`, `status` (`uploaded` \| `measured` \| `qualitative` \| `failed`), `measurement` (JSON: kalite, satır kutuları, okunan metin), `template_key`, `font_file`, `split` (`train` \| `test`), `excluded`, `reference_id`, `error`, `shown_at`, `created_at`, `deleted_at` | Yüklenen bitmiş etiketler |
| `profile_revisions` | `id`, `org_id`, `session_id`, `language_id`, `rev` (≥ 1), `data` (tam profil), `changes` (JSON), `reason` (`initial` \| `answer` \| `correction` \| `restore` \| `manual`), `summary`, `entry_id`, `restored_from`, `cost_usd`, `created_at`, UNIQUE(`session_id`,`rev`) | Taslak geçmişi; revizyon 0 tabandır (`base_data`) |

- Taslak satırı her zaman son revizyondur. "Sürüm 2'ye dön", eski verinin yeni revizyon (`restore`) olarak yazılmasıdır; geçmiş silinmez.
- **Dışarıdan değişen taslak ezilmez.** Taslak bu oturumun dışında değiştiyse (Tasarım dili ekranı, MCP `taslak_yaz`, öğrenme), sonraki revizyon yazılmadan önce o hâl oturum geçmişine `manual` revizyon olarak yazılır, akışa `draft-replaced` bildirimi gelir, modele not düşülür; kullanıcı "Bu sürüme dön" ile geri getirebilir.
- **Durum makinesi** (geçişleri sunucu zorlar, `nextBuildState`; bir oturumda aynı anda tek ölçüm ya da tur, bir dilde tek etkin oturum):
  - `intake` (etiket türleri; kurulumdan tür seçimiyle gelindiyse atlanır)
  - → `samples` (örnek yükleme; "örneğim yok" ile atlanabilir)
  - → `analyzing` (ölçüm, ücretsiz; okuma Haiku ile, çok ucuz)
  - → `drafting` (model, ilk revizyon)
  - → `review` (örnek etiketler, değişen kurallar)
  - `review` ↔ `revising` (düzeltme → yeni revizyon)
  - her durumda `awaiting-user` (model soru sordu)
  - → `published` ya da `closed` (ikisi de son durum)
  - Hata durumları: `interrupted` (süreç kapandı, "Devam et") ve `failed` (açık nedenle; "Devam et" kesildiği duruma döner).
- **Tasarım dili yoksa.** Her firmada en az varsayılan dil vardır (§2.8). Oturum `base: 'published'` ile yayınlanmış sürümden, `base: 'default'` ile (ya da yayınlanmış sürüm yoksa) varsayılandan başlar; ikinci durumda akışa `base-default` bildirimi düşer.

### 4.3 Claude API kullanımı

- **Model: Claude Opus 5.5 (`claude-opus-5-5`, $4 / $20 MTok).** `MODELS.builder` olarak tek yerde tutulur.
  - Günlük üretim Haiku 5.5'te kalır; yüklenen görsellerin satır metinleri de Haiku ile okunur.
  - Sonnet 5.5'e geçiş bir maliyet kolu olarak ayrıca ölçülerek konuşulur; sistem modeli kendiliğinden düşürmez.
- **Düşünme ve özen düzeyi.** Uyarlamalı düşünme. `output_config.effort` tur türüne göre: ilk taslak `high`; cevap, düzeltme ve "Devam et" `medium`.
- **Döngü: Messages API, sunucuda el ile** (`packages/ai/src/builder/agent.ts`, `runBuilderTurn`): akış hâlinde istek (`max_tokens` 32k), araç çağrısı varsa çalıştır, sonuçları tek kullanıcı iletisinde gönder, döngü `end_turn` ya da `ask_user` gelince biter. Tur başına en çok 8 araç adımı. Managed Agents değil: araçlar yerel motor, SQLite ve dosyalarda çalışıyor, durum ve kalıcılık bizde.
- **Katı araçlar** (`strict: true`, `additionalProperties: false`, `eager_input_streaming: true`; her girdi ayrıca zod ile doğrulanır). Opus 5.5 zorla araç seçimini kabul etmez; `auto` ve istemdeki açık yönerge kullanılır.

| Araç | Girdi | Sunucunun yaptığı |
|---|---|---|
| `read_profile` | `{ source: 'draft' \| 'base', group? }` | `formatProfile` |
| `profile_schema` | `{ group? }` | `schemaFields` |
| `get_samples` | `{ limit, ids? }` | Yüklenen örnekler ve firmanın referansları; metin ve görseller |
| `get_measurements` | `{}` | `measure` özeti; her değerde n |
| `get_templates` | `{ keys? }` | Şablon özeti ve küçük görseller |
| `propose_changes` | `{ note, changes: [{ path, value_json, evidence }] }` | Doğrular, revizyon yazar, değişiklikleri döner; hatada `is_error` |
| `engine_trial` | `{ split: 'test' \| 'all', limit }` | Ücretsiz motor denemesi (`formatReplay`) |
| `ask_user` | `{ questions: [{ id, group, text, measured?, suggestion?, options: [{ label, value_json? }], free: boolean }] }` | Turu bitirir; durum `awaiting-user` |

- **"Uydurma değer yazılmaz" kuralı, `propose_changes` doğrulamasında zorlanır** (`tools-exec.ts`; değişiklikler sırayla, öncekilerin kabul edildiği taslak üzerinde):
  - `path` yalnız yazılabilir `PROFILE_DOCS` yollarından olabilir (`path-not-allowed`; ad ve tasarım alanı yazılamaz);
  - `value_json` ayrıştırılır (`invalid-json`), birleştirilir ve `ProfileSchema` ile doğrulanır (`schema-invalid`);
  - `evidence` üç türden biridir: `{ kind: 'measurement', key, n }`, `{ kind: 'answer' | 'correction', entryId }` (bu oturumun kullanıcı girdisi mi: `unknown-entry`), ya da `{ kind: 'default' }` (yalnız alanı varsayılana bırakmak için, değer `null`: `default-not-null`);
  - **ölçüm kanıtı yalnız istatistiktir (izin listesi).** Geçerli anahtarlar: istatistik düğümü (`{ n, median, q1, q3, p10, p90 }`; ör. `ratios.secondary`, `gaps.normal`) ya da onun `median` / `q1` / `q3` / `p10` / `p90` yaprağı; ayrıca `lineLength.p50`, `lineLength.p90`, `lineLength.max`. Sayımlar ve listeler (`refs.*`, `lineCount.*`, `fonts.*`, `templates.*`), örnek metinler (`examples`), bulgular ve `programVsUser` kanıt değildir; anahtar son ölçümde yoksa ya da n = 0 ise `unknown-measurement`. `n` ölçümden yazılır, modelin verdiği yok sayılır;
  - ölçülen çeyrekler aralığının dışındaki sayı kabul edilir ama `outside-measured-range` uyarısı alır;
  - `lineBreaking.examples` öğelerinde satırlar birleşince müşteri metni harfi harfine aynı olmalı (`text-not-preserved`, `checkTextPreserved`);
  - değer zaten aynıysa `no-change`.
- Bir önerinin en az bir değişikliği kabul edilirse yeni revizyon yazılır. Hiçbiri kabul edilmezse üst üste başarısızlık sayısı artar; 3'e ulaşınca tur biter, `proposal-failed` bildirimi gelir, taslak bozulmaz.
- Modelin yayın aracı ve ücretli deneme aracı yoktur. Görsellerdeki ve müşterinin yazdığı metin veri olarak, ayraçlı blokta verilir; **istem verisinde `<` ve `>` kaçırılır** (`escapeData`: `<`, `>`), veri bloğundan çıkamaz.
- **Görsel girdi.** Örnekler PNG, en uzun kenar 768 px.
- **İstem önbelleği.** Sıra: araçlar → sistem (sabit) → oturum bağlamı iletisi (ölçüm özeti, örnek görseller) → turlar. Kırılma noktaları 1 saatlik (sistemin sonu, oturum bağlamı, son ileti). Ara bilgiler ("örnek eklendi", "dışarıdan taslak değişti") konuşma içi sistem iletisiyle eklenir, önbelleği bozmaz. İsabet `cache_read_input_tokens` ile günlüğe yazılır.
- **Akış ve SSE.**
  - Durum değişiklikleri genel olay yolundan: `{ type: 'build', buildId, languageId, state }`.
  - Metin parçaları, araç adımları, soru, revizyon, maliyet ve hata, oturuma özel akıştan (`GET /api/builds/:id/stream`), olay kimlikli (`"<bootId>:<n>"`; `Last-Event-ID` ile son 500 olaydan kaldığı yerden; tampon süreç belleğindedir, açılış değişince arayüz sorgulayarak eşitlenir).
  - Arayüz akış olmadan da çalışır: oturumu ve `messages?after=` sorgular.
- **Ret ve yedek.** Sunucu tarafı yedek model açık: `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: [{ model: "claude-opus-5" }]` (Opus 5.5'in izinli yedeği Opus 4.8 konuşma içi özen iletisini reddettiği için `"default"` kullanılmaz). `stop_reason: refusal` durumunda tur `failed` olur ve kullanıcıya söylenir.

### 4.4 Örnek yükleme ve görselden ölçüm

- **Yükleme.** PNG, JPG ya da PDF'nin ilk sayfası (içerikten tanınır); oturumda en çok 24 örnek (silinenler sayılmaz), istek en çok 60 MB, dosya en çok 20 MB, kaynak en çok 40 milyon piksel, en kısa kenar en az 64 px. `sharp` ile yeniden kodlanır (EXIF silinir, yön uygulanır), en uzun kenar 2000 px. Hata kodları: `sample-limit`, `sample-too-large`, `sample-type`, `sample-unreadable`. Yer: `data/firmalar/<org>/tasarim-oturumlari/<oturum>/ornekler/`.
- **Ölçüm** (ücretsiz, deterministik; AI piksel üretmez):
  1. Şablon eşleşirse (kullanıcı seçer ya da boş şablonunu da yükler), yazı katmanı ayrılır: sonuç = şablon + mürekkep.
  2. Mürekkep satırları yatay izdüşümle bulunur: satır kutusu, yükseklik ve satırlar arası görünen boşluk (`packages/templates/src/ink-lines.ts`).
  3. Satır metinleri Haiku ile okunur. Satır sayısı mürekkeple eşleşmezse örnek `approx` işaretlenir.
  4. Font bilinmez; üretilmez. Kullanıcı firmanın font listesinden seçer (`patchSample`): kaynak cevaptır.
- **Kalite.**
  - `exact`: şablon ayrıldı, satır eşleşti → oranlar, boşluk ve doluluk ölçülür.
  - `ink`: düz zemin eşiği → yalnız oranlar.
  - `none`: fotoğraf ya da ayrılamayan → yalnız niteliksel (modelin gözü) ve satır bölme örnekleri.
  - Ölçülmeyen değer boş kalır; hiçbir değer tahminle doldurulmaz.
- **Ayrılmış küme.** 8 ve daha çok ölçülebilir örnekte %25'i (aşağı yuvarlanır) `test` kümesine ayrılır; kalite kartında kullanılır.
  - **Modele gösterilmiş örnek ayrılmış kümeye girmez.** Örnek modele açıldığı an (bağlam, `get_samples`, ölçüm özeti, motor denemesi `all`) `shown_at` yazılır; o örnek bir daha `test` olamaz. Ayrılmış küme modelin görmediği örneklerden kalır. Her örnek değişiminde küme yeniden hesaplanır.
- **Gizlilik.**
  - Etiketlerdeki adlar ve tarihler müşteri verisidir.
  - Görseller Anthropic API'sine gönderilir. API verisi varsayılan olarak eğitimde kullanılmaz; ekranda "örnekler yapay zekâya gönderilir" notu durur.
  - `ai_calls` görsel ve tam istem saklamaz.
  - Örnekler oturum ve dil silinince ya da firma kalıcı silinince silinir.
  - Yayından sonra örnekler firmanın referansı olarak kalır (§9.2); kullanıcı tek tıkla siler.

### 4.5 Örnek etiketler ve değişen kurallar

- **Örnek etiketler** (`showcase.ts`, ücretsiz motor), revizyon başına:
  - yüklenen örneklerin metinleri, kullanıcının kendi satırlarıyla (`sample`);
  - firmanın referansları (`reference`; `referenceToIntent`, motor_dene ile aynı yöntem);
  - kurulumdaki türlere göre hazır örnek metin (`preset`; `simpleIntent`, TR ve EN).
  - Her örnek için önceki revizyonla yerleşim imzası (`layoutSignature`) karşılaştırılır: `changed` ve kısa not ("Tarih küçüldü"), not değişen kural etiketlerinden üretilir (sayısal değişimde yön, diğerlerinde "değişti").
  - Çıktılar `tasarim-oturumlari/<oturum>/vitrin/<rev>/` altında saklanır.
- **Değişen kurallar:** `RuleChange = { path, group, label, unit, from, to, source: { kind, ref, n? }, warning? }`. Kaynak `diffLeaves` ve `PROFILE_DOCS`'tur; kaynak türleri üç kanıt türü, `restore` ve `manual`. İki revizyon arası farkta her yolun kaynağı onu en son değiştiren revizyonun kaydıdır, bulunamazsa `manual`.
- **Kendi metniyle deneme.** Motor kipi ücretsiz. AI kipi (Haiku) önce tahmin (`confirm` yok), sonra `confirm: true` ile çalışır.
- **Yayın.** `profiles.publish` çağrılır, not verilmezse oturum özeti. En az bir revizyon gerekir (`build-no-revision`). Sürüm geçmişi korunur.
  - **`build-base-changed`.** Oturum sürerken dilin başka bir sürümü yayınlandıysa (`start_version` bugünkü sürümden farklı) ya da taslak bu oturumun son revizyonundan farklıysa yayın durur: `409 build-base-changed` (`baseVersion`, `publishedVersion`, `draftChanged`). Kullanıcı onaylarsa `{ overwrite: true }` ile oturumun son revizyonu yine yayınlanır; sessizce ezilmez.

### 4.6 Maliyet ve bütçe

- **Tahmin, oturum başına** (`BUILDER_COST_HINTS`; gerçek oturumda ölçüldü). İlk taslak ≈ $0,5, soru turu ≈ $0,11, düzeltme turu ≈ $0,08, okuma örnek başına ≈ $0,001. Tipik oturum **yaklaşık $0,9–1,3**.
  - `POST /api/builds/estimate` önceki ön eki `count_tokens` ile sayar (olmazsa yaklaşık önek); ücretsizdir.
  - Her model isteği bittiği anda gerçek tutar `response.usage`'dan hesaplanıp `ai_calls`'a `build_id` ile yazılır. Kesilen akışın görülen kullanımı da yazılır.
- **Sınırlar** (`budget.ts`).
  - Oturum başına $3. Aşılacaksa tur ya da ölçüm başlamadan `409 budget-exceeded` (`scope: 'session'`, `canRaise`); kullanıcı onaylarsa `POST …/budget/raise` sınırı bir kez $3 artırır (ikinci kez `budget-raise-used`).
  - Firma başına aylık sınır `org_settings["ai.limits"].monthlyUsd`, varsayılan $20 (aynı ayarda `sessionUsd`, `sessionRaiseUsd`, `warnRatio` da var). Aylık harcama = firmanın bu ayki bütün `ai_calls` maliyeti + çalışan işlerin ayrılmış, henüz harcanmamış tahminleri. %80'de uyarı (`BuildEstimate.monthWarn`, bildirim `budget-warning`); aşınca `409 budget-exceeded` (`scope: 'month'`, artırılamaz).
  - Tur ya da ölçüm başlamadan tahmin ayrılır (`reserve`); denetim ve ayırma aynı eşzamanlı adımdadır, iki istek aynı boş payı birden alamaz. Ayırma iş bitince bırakılır (süreç belleğinde; tek süreç).
  - **Bütçe her model isteğinden önce kayıtlı harcamadan yeniden hesaplanır** (`remainingUsd`). Kalan pay 0'a inerse yeni istek gönderilmez, tur `budget` nedeniyle biter ve akışa `budget-stopped` bildirimi düşer. Eşzamanlı işler birbirinin harcamasını istek istek görür: **aşım iş başına en çok bir istek kadardır.**
  - **Fiyatı bilinmeyen model en pahalı bilinen fiyatla sayılır** (`budgetCostOf`; yeni bir yedek model bütçede $0 olmasın): bütçe tutarı üst sınırdır, gösterilen maliyet değildir; fiyatı bilinmeyenler maliyet özetinde ayrıca listelenir.
- **Fiyat hesabı.** `Usage.cacheWrite1hTokens` 1 saatlik önbellek yazımını (2 kat) hesaba katar; fiyatlar tek yerde (`domain/ai.ts`).
- **Anahtar.** 1. aşamada firmanın kendi anahtarı (Ayarlar > Bağlantılar); anahtar yoksa oturum başlamadan `409 missing-key`. Kod iki kaynağı tanır (`KeySource = 'org' | 'product'`); 2. aşamadaki seçim (§9.1) yalnız kaynağı ve sınırın nereden geldiğini değiştirir.
- Bütçe denetimi yalnız oluşturucu yollarındadır; üretim ve deneme uçlarında firma sınırı henüz okunmaz (§10.2).
- Geliştirmede gerçek harcama yoktur: testler sahte model portuyla koşar. Gerçek uçtan uca deneme bir oturumdur ve önce kullanıcıya sorulur (toplam bütçe ≤ $20 kuralı).

### 4.7 Hata ve kesinti

- Ağ hatası, 5xx ve 429: en çok 3 deneme, bekleme akışa `step: retry-wait` ve `retrying` bildirimiyle yazılır. Kota ve anahtar hatası `failed`, açık iletiyle.
- Tur yarıda kalırsa (süreç kapandı): asistan turu tamamlanmadan kaydedilmez. Açılışta `interrupted` olur; "Devam et" (`POST …/resume`) aynı girdiyi yeniden gönderir.
- İptal (`POST …/cancel`) turu `AbortController` ile keser; harcanan tutar yazılır.
- Araç girdisi bozuk ya da kesik JSON ise `is_error` sonucu döner ve model düzeltir. `max_tokens` ve `refusal` durdurma nedenleri araç çalıştırılmadan önce denetlenir.
- Doğrulamayı üst üste 3 kez geçemeyen öneri turu bitirir (`proposal-failed`); taslak bozulmaz.

### 4.8 Değerlendirme (oluşan dilin kalitesi)

- **Kullanıcıya gösterilen kalite kartı** (`GET /api/builds/:id/quality`):
  - ayrılmış kümede motor denemesi (ücretsiz): en büyük satır ±%10 içinde (n), blok merkezi uzaklığı, boşluk farkları;
  - isteğe bağlı AI denemesi (`POST …/quality/ai`; Haiku, önce tahmin, `confirm: true` ile çalışır): satır bölmesi aynı (%), boyut farkı.
- **Her revizyonda değişmez denetimler** (`quality.invariants`): kanıtsız değer 0, müşteri metni bozulması 0, şema dışı yol 0 (`restore` ve `manual` revizyonlar şema dışı sayımından muaf).
- **Senaryo testleri** (C4): beş sentetik firma senaryosu sahte modelle `apps/server/src/builder-scenarios.test.ts`'te koşar (maliyetsiz, ağsız). Gerçek çalıştırma betiği yoktur; gerçek API ile uçtan uca deneme elle, kullanıcıya sorularak yapılır (oturum başına ≈ $1). Kalite hedefleri (satır bölme %85, boyut %70) ücretli ölçüm ister (`YOL-HARITASI.md`).
- Model ve özen düzeyi değişiklikleri ölçümsüz yapılmaz.

### 4.9 Arayüzün kullandığı API (maket 5)

Sözleşme `packages/domain/src/builder-api.ts` dosyasında, `BUILDER_API` sabitindedir (yol, yöntem, `access`, geçerli durumlar, hata kodları). Bütün uçlar `language.builder` özelliğine bağlıdır; `write` ve `spend` uçları özellik kapalıyken `409 feature-off` döner, `read` açık kalır; `spend` uçları bütçe denetiminden geçer. Durum dışı çağrı `409 build-state` (gövdede `state`), çalışan iş varken `409 build-busy`.

| Uç | İstek → yanıt |
|---|---|
| `POST /api/builds/estimate` | `{ languageId, samples }` → `{ lowUsd, highUsd, sessionCapUsd, monthUsd, monthLimitUsd, monthWarn, keySource }` |
| `POST /api/languages/:lang/builds` | `{ base: 'published' \| 'default', fromSetup?, labelTypes? }` → `201 Build` (`build-active` gövdesinde `buildId`) |
| `GET /api/languages/:lang/builds/current` | → `Build \| null` |
| `GET /api/builds/:id` | → `Build` (`state`, `costUsd`, `budgetUsd`, `currentRev`, `baseVersion`, `pendingQuestions[]`, `samples[]`, `error` …) |
| `PUT /api/builds/:id/intake` | `{ labelTypes }` → `Build` (`intake`/`samples`) |
| `GET /api/builds/:id/messages?after=&limit=` | → `{ entries: [{ id, at, role, kind, turnSeq, text, group, question?, answer?, rev?, code?, params? }] }` (soldaki akış) |
| `POST /api/builds/:id/messages` | `{ kind: 'answer' \| 'correction' \| 'note', text?, answers?: [{ questionId, option?, text? }] }` → `202` (tur başlar), notta `200` |
| `POST /api/builds/:id/samples` | `{ files: [{ name, dataBase64 }], templateKey? }` → `{ samples: Sample[] }` (en çok 60 MB) |
| `PATCH /api/builds/:id/samples/:sid` | `{ templateKey?, lines?, fontId?, exclude? }` → `Sample` (kullanıcı düzeltmesi = cevap) |
| `DELETE /api/builds/:id/samples/:sid` | → `{ ok }` · `GET …/:sid/image.png` → PNG |
| `POST /api/builds/:id/skip-samples` | → `202` ("örneğim yok", ölçümsüz ilk tur) |
| `POST /api/builds/:id/analyze` | → `202` (ölçüm; ilk ölçümden sonra model turu kendiliğinden başlar) |
| `POST /api/builds/:id/cancel` · `…/resume` | → `Build` (`resume` `202`) |
| `POST /api/builds/:id/budget/raise` | → `Build` (oturum sınırı bir kez artar) |
| `GET /api/builds/:id/stream` | SSE: `status`, `text`, `step`, `question`, `revision`, `cost`, `error`, `done` |
| `GET /api/builds/:id/revisions` | → `[{ rev, at, reason, summary, changeCount, costUsd }]` |
| `GET /api/builds/:id/revisions/:rev` | → `{ rev, profile, changes: RuleChange[] }` (0 = taban) · `GET /api/builds/:id/diff?from=&to=` → `{ from, to, changes }` |
| `GET /api/builds/:id/revisions/:rev/showcase?locale=` | → `{ items: [{ id, title, text, templateKey, size, previewUrl, changed, note, source }] }` · `…/showcase/:item` → PNG |
| `POST /api/builds/:id/try` | `{ text, templateKey?, size?, rev?, mode: 'engine' \| 'ai', confirm?: boolean }` → bugünkü `ProfileTryResponse` biçimi |
| `POST /api/builds/:id/restore` | `{ rev }` → yeni revizyon ("Sürüm 2'ye dön") |
| `POST /api/builds/:id/publish` | `{ note?, overwrite? }` → `ProfileRecord` (`build-base-changed` olabilir) |
| `GET /api/builds/:id/quality?rev=` · `POST …/quality/ai` | kalite kartı · `{ rev?, confirm? }` → `{ estimateUsd, quality }` |
| `POST /api/builds/:id/close` | → `Build` |
| `POST /api/languages/:lang/showcase` | `{ source: 'published' \| 'draft', locale? }` → aynı `items` (Özet ve kurulumdaki "Varsayılanla başla") |

## 5. İş paketleri

Her pakette ortak kurallar:
- Ajan commit atmaz, sunucu başlatmaz (5499'u yalnız orkestratör açar).
- Yalnız kendi dosyalarının testini ve paketinin tip denetimini koşar.
- Paylaşılan dosyalar orkestratörün işidir: `packages/domain/src/index.ts`, `db/migrations/index`, `routes/index.ts`, `context.ts`, kök `package.json`. Ajan gerekeni raporunda ister.
- Kabulde `pnpm test` ve `pnpm typecheck` yeşil olmalı, test sayısı düşmemeli.

| Kod | Paket | Büyüklük | Model | Bağımlılık |
|---|---|---|---|---|
| A0 | Firma çekirdeği ve göç 9 | L | Opus | — |
| A1 | Servis kapsamı 1: dil, profil, şablon, font, referans, oturum, paket, ayar, anahtar, maliyet | L | Opus | A0 |
| A2 | Servis kapsamı 2: parti, iş, varyasyon, içe aktarma, üretim kuyruğu, düzelt, geri al, deneme, görevler, öğrenme, baskı | L | Opus | A0 |
| A3 | Dosya düzeni taşıması, geri dönüş, `pnpm firma` betikleri | M | Sonnet | A0 |
| A4 | İzolasyon test takımı | M | Sonnet | A0 (A1 ve A2 ile birlikte yeşile döner) |
| A5 | Varsayılan içerik ve firma kurma | M | Sonnet | A0 |
| B1 | Özellik ve kurulum sözleşmesi (domain) | S | Sonnet | — |
| B2 | Özellik ve kurulum sunucusu, uç tablosu, göç 11 | M | Sonnet | A1, A2, B1 |
| C0 | Oluşturucu sözleşmesi (domain) | M | Opus | — |
| C1 | AI paketi: oluşturucu döngüsü, araç tanımları, istem, sahte port, MCP biçimleyicilerinin taşınması | L | Opus | C0 |
| C2 | Görselden ölçüm | L | Opus | C0 |
| C3 | Oluşturucu servisi, göç 13, uçlar, SSE, bütçe | L | Opus | A1, A2, B2, C1, C2 |
| C4 | Değerlendirme betiği ve senaryo testleri | M | Sonnet | C3 |
| C5 | Belgeler | S | Sonnet | C3 |

**A0. Firma çekirdeği (Opus, tek ajan).**
- Sahip olduğu dosyalar: `apps/server/src/org/**`, `util/ids.ts`, `db/database.ts`, `db/migrations/**` (dosyalara bölme dahil), `config.ts`, `events.ts`, `app.ts` (çözücü kancası), `context.ts` (`paths` alıcıları, `OrgService` bağlantısı), `services/settings.ts` (kurulum ve firma ayrımı), `services/secrets.ts`.
- Kabul:
  - göç 9 sahibin kopya verisinde satır sayılarını korur;
  - taze kurulumda firma açılmaz, ilk açılışta "Firmam" kurulur;
  - koruyucu kapsamsız SQL'i reddeder;
  - olay yolu bağlamsız yayında testte hata fırlatır;
  - SSE firmaya göre süzer;
  - ortam anahtarı yedeği kapalıdır.
- Testler: `migrations.test.ts`'e göç 9; `tenant-db.test.ts`; şema denetimi (`org_id`, tetikleyiciler, dizinler).

**A1 ve A2. Servis kapsamı (Opus, iki paralel ajan; dosya kümeleri ayrık).**
- Her SQL'e `$org` eklenir, `INSERT`'lere `org_id` yazılır. Kimlikle okuma `id = ? AND org_id = $org` olur; yoksa 404.
- A1 dosyaları: `services/{languages, profiles, templates, fonts, references, session, language-package, bootstrap, costs, undo}.ts`. Dil kimliği UUIDv7'ye geçer, bootstrap firma klasörüne iner.
- A2 dosyaları: `services/{batches, variants, adjust, template-tasks, learn, key-guard}.ts`, `services/{jobs, import, generation, trial, print}/**`. Mükerrer denetimi firma kapsamına iner; kuyruk adil seçim yapar ve görevleri firma bağlamında başlatır.
- Rota dosyalarına dokunulmaz. Zorunlu küçük değişiklik varsa raporda istenir.
- Kabul: mevcut bütün testler yeşil; her ajan bugünkü `json_*` ve SQLite'a özgü ifadelerin listesini rapora yazar.

**A3. Dosya düzeni (Sonnet).**
- Dosyalar: `apps/server/src/org/roots.ts` (firma dosya kökleri), `scripts/firma.mjs`.
- Kabul: kopya veride taşıma ve yarıda kesip yeniden başlatma çalışır; geri dönüş göç öncesi yedeğin elle geri konmasıdır. Önizleme, referans görseli, şablon PNG'si ve baskı çıktısı taşımadan sonra aynı uçlardan gelir.

**A4. İzolasyon takımı (Sonnet).**
- Dosyalar: `apps/server/src/tenancy.test.ts`, `test/two-orgs.ts`.
- Kayıtlı uçlar Fastify'dan okunur. Kimlik parametreli her uç A'nın kimliğiyle B bağlamında denenir; SSE, kuyruk, mükerrer denetimi ve dosya denetimleri de buradadır.
- Kabul: yeni uç eklenip takıma girmezse test kırılır.

**A5. Varsayılan içerik (Sonnet).**
- Dosyalar: `assets/varsayilan/**`, `scripts/varsayilan-sablonlar.mjs`, `packages/domain/src/defaults.ts`, `apps/server/src/org/seed.ts`.
- Kabul: lisans testi; yeni firmada varsayılan dil v1 yayınlanmış ve şablonları eşitlenmiş; motor denemesi bu dille yerleşim üretir.

**B1. Sözleşme (Sonnet).**
- Dosyalar: `packages/domain/src/{features, setup}.ts` (`SETUP_API`).
- Kabul: kayıt testi (bağımlılık döngüsü yok, her anahtarın grubu var); tür → özellik eşleme işlevi saf ve testli.

**B2. Sunucu (Sonnet).**
- Dosyalar: `apps/server/src/features/**`, `services/setup.ts`, `routes/org.ts`, `db/migrations/0011-ozellikler.ts`. Servis içi iki `features.require` satırı A2'den sonra eklenir.
- Kabul:
  - uç tablosu kapsama testi;
  - kapalı özellikte 409, okumada 200;
  - sahibin firması her şey açık ve kurulum tamamlanmış;
  - kurulum `preview → complete → restart` testleri.

**C0. Sözleşme (Opus).**
- Dosyalar: `packages/domain/src/builder.ts` (`BUILDER_API`, durumlar, `RuleChange`, soru ve örnek şemaları).
- Kabul: arayüz ajanlarının sahte sunucu yazabileceği kadar tam; geçiş tablosu saf ve testli.

**C1. AI paketi (Opus).**
- Dosyalar: `packages/ai/src/builder/**` (`agent.ts`, `tools.ts`, `prompt.ts`, `format.ts`, `testing.ts`), `domain/ai.ts`'e `MODELS.builder` ve 1 saatlik önbellek fiyatı, `apps/mcp/src/tools/*`'ta yalnız içe aktarma değişikliği.
- Kabul: sahte istemciyle döngü testleri (araç sırası, `is_error` onarımı, `ask_user` ile duruş, ret, kesilme, iptal); önbellek kırılma noktaları istekte doğru yerde; MCP testleri aynı.

**C2. Görselden ölçüm (Opus).**
- Dosyalar: `packages/templates/src/ink-lines.ts`, `packages/learn/src/measure.ts` (kaliteye göre ölçüm), `packages/domain/src/reference.ts` (`uploaded`, `quality`), `apps/server/src/services/builder/samples.ts`.
- Kabul: gerçek şablon ve yazı katmanıyla üretilmiş fikstürlerde satır kutuları ±2 px; `none` kalitesinde hiçbir sayısal ölçüm yazılmaz; okuma uyuşmazlığı `approx` işaretlenir.

**C3. Oluşturucu servisi (Opus).**
- Dosyalar: `apps/server/src/services/builder/{service, store, stream, samples, revisions, showcase, tools-exec, budget, errors}.ts`, `routes/builder.ts`, `db/migrations/0013-olusturucu.ts` (durum geçişleri `packages/domain/src/builder.ts`'te).
- Kabul:
  - durum makinesi testleri;
  - kanıtsız ya da şema dışı öneri reddedilir;
  - revizyon ve geri dönüş;
  - örnek etiketlerde `changed` doğru;
  - bütçe sınırında tur başlamaz;
  - kesilen tur açılışta `interrupted` olur;
  - SSE kaldığı yerden sürer;
  - hepsi sahte modelle, maliyetsiz.

**C4. Değerlendirme (Sonnet).**
- Dosya: `apps/server/src/builder-scenarios.test.ts` (5 sentetik senaryo, sahte modelle). Gerçek çalıştırma betiği yok.
- Kabul: 5 sentetik senaryo yeşil; gerçek API ile deneme elle ve önce maliyeti söylenerek yapılır.

**C5. Belgeler (Sonnet).**
- `SKILL.md` başında sitedeki akışa işaret ve MCP'nin sahip yolu olduğu notu; README'de Oluştur ekranı ve maliyet; `YOL-HARITASI.md` durum satırı; bu belgenin §4'ü.

## 6. Sıra ve paralellik

- Bu dalgaların hiçbiri `apps/web`'e dokunmaz. Arayüzün 0–3. dalgalarıyla aynı anda yürür; aynı anda en çok 5 ajan (orkestratör sayılmaz).
- Paylaşılan tek sınır: arayüzün Dalga 0'ı da sunucuya dokunuyor (bugün `routes/index.ts`'e `fallback-fonts` ekleniyor). `routes/index.ts` ve `context.ts` orkestratörde kalır.

| Sunucu dalgası | Paketler | Not |
|---|---|---|
| S1 | A0, B1, C0 | A0 tek başına çekirdek. B1 ve C0 yalnız kendi domain dosyalarına yazar. Sözleşmeler arayüz ajanlarına erken verilir (Kurulum ve Oluştur ekranları sahte sunucuyla başlayabilir) |
| S2 | A1, A2, A3, A4, C1 | C1 yalnız `packages/ai` ve `apps/mcp`. A4 testleri önce kırmızı, A1 ve A2 bitince yeşil |
| S3 | A5, B2, C2 | A5 erken başlayabilir (yalnız A0'a bağlı) |
| S4 | C3 | Tek büyük paket. Arayüz ekranları gerçek uçlara bu dalgada bağlanır |
| S5 | C4, C5, bağımsız incelemeler, sahibin kopya verisiyle göç provası, onaylı tek gerçek oturum (≈ $1) | Sonunda sahibin `data/` klasöründe yedekli gerçek göç, kullanıcıyla |

- Göç numaraları: 8 profil alanı, 9 = A0 (firma), 10 sıkı kip, 11 = B2 (özellikler), 12 baskı ölçüleri, 13 = C3 (oluşturucu).
- Gerçek veride göçten önce yedek ve kullanıcı onayı alınır. 5420 yeniden başlatılmadan önce kullanıcıya sorulur.

## 7. Bağımsız inceleme gereken yerler ve riskler

**İnceleme.** Her biri paketi yazmayan bir Opus ajanıyla:
1. **Veri modeli** (A0, B2'nin göçü, C3'ün göçü): göç, geri dönüş, tetikleyiciler, dizinler, silme sırası, Postgres ve RLS eşlemesi.
2. **Yetki ve izolasyon** (A0–A4): koruyucunun atlanabildiği yol var mı (ham `db` erişimi, bakım kapsamı, arka plan görevi bağlamı), dosya sunan uçlarda yol kaçışı, SSE süzgeci.
3. **Para** (C3 `budget.ts`, `domain/ai.ts` fiyatları, kuyruk ve deneme harcama yolları, anahtar kaynağı): tahmin ve gerçek hesap, sınır yarışları (iki eşzamanlı tur), ortam anahtarının sızması.
4. **"Uydurma değer" ve metin koruması** (C3 `tools-exec.ts`, C2): kanıt denetimi atlanabiliyor mu, `examples` metin koruması.

**Riskler.**
1. **Bağlam sızıntısı.** `AsyncLocalStorage` kuyrukta, zamanlayıcıda ve olay dinleyicide yanlış firmayı taşıyabilir. Önlem: açık `runInOrg`, bağlamsız yayın ve sorguda hata, izolasyon testi.
2. **Kapsamı unutulmuş SQL.** Önlem: koruyucu her ortamda çalışır; şema testi; uç kapsama testi.
3. **Dosya taşımada veri kaybı.** Önlem: otomatik yedek, klasör klasör ve kaldığı yerden süren taşıma, kopya veride prova, göç öncesi yedekten elle geri dönüş.
4. **Sahibin günlük akışının bozulması** (kurulum ekranı, kapalı özellik, MCP). Önlem: göç 11 her şeyi açık ve tamamlanmış yazar; MCP testleri.
5. **Görselden ölçüm güvenilmez olabilir** (fotoğraf, hizasız dışa aktarma). Önlem: kalite işaretleri; ölçülemeyeni model sormak zorunda.
6. **Maliyet taşması** (uzun düzeltme döngüleri). Önlem: oturum ve firma sınırı, tahmin, önbellek isabeti günlüğü.
7. **İstem enjeksiyonu** (etiket metninde talimat). Önlem: araçlar dar, yayın ve ücretli araç yok, metin veri bloğunda.
8. **Düşünme bloklarının konuşmaya bağlı olması.** Geçmiş düzenlenirse sonraki istek reddedilir. Önlem: ham bloklar yalnız eklenerek saklanır, yeniden yazma yok.
9. **2. aşamada firma kimliği eşlemesi ve SQL'in taşınması.** Önlem: kimlik eşlemesi aktarımda; SQLite'a özgü SQL listesi; tek `TENANT_TABLES` listesi.
10. **Maket ile ölçülmüş karar çelişkisi** (görsel denetim açık görünüyor). §8.3'te soruluyor.
11. **Ürün etiketinin dikdörtgen kesimi.** Profilde tek `output.cut` var; aynı dilde Ø38 daire ve 63,5 × 38,1 mm dikdörtgen birlikte olabilir mi? **[V]** Şablon düzeyinde kesim yoksa ürün etiketi ayrı dil ister (`language.multi`). C3 başında doğrulanır.

## 8. Kullanıcıya sorulacak ürün kararları

1. **2. aşamada yapay zekâ anahtarı kimin?**
   - (a) Ürünün anahtarı, firma başına plan sınırıyla.
   - (b) Her firma kendi Anthropic ve Gemini anahtarını girer.
   - Öneri: **(a)**. Satıcı anahtar edinmekle uğraşmaz, maliyet abonelikte kalır. Kod iki yolu da destekler. 1. aşamada yerelde zaten firmanın kendi anahtarı kullanılır.
2. **Yüklenen örnek etiketler oturumdan sonra?**
   - (a) Firmanın referansı olarak saklanır: öğrenme ve kalite ölçümü için, tek tıkla silinebilir.
   - (b) Dil yayınlanınca silinir.
   - Öneri: **(a)**. Ayrılmış kümeyle ölçüm ve "Düzeltmelerden öğren" bu örneklerle çalışır.
3. **Görsel denetim kurulum listesinde?**
   - (a) Kurulumdan çıkar, Ayarlar'da kapalı kalır.
   - (b) Kurulum listesinde kapalı olarak durur.
   - Öneri: **(a)**. Ölçümde sonucu iyileştirmedi, maliyeti %43 artırdı. Maket 6'da açık çizilmişti.
4. **Maket 6'daki "Birden çok dil" ne demek?**
   - (a) Müşteri metinlerinin dilleri (İngilizce, İtalyanca bağlaç ve edatları; tasarım dili soruları buna göre).
   - (b) Birden çok tasarım dili.
   - Öneri: **(a)**. (b) ayrı bir gelişmiş özellik olarak (`language.multi`) kalır.
5. **Örneği olmayan kullanıcı yapay zekâyla dil kurabilsin mi?**
   - (a) Evet, yalnız sorularla: değerler cevaplardan, gösterim varsayılan şablonlarla, kalite kartı yok.
   - (b) Hayır, önce en az 6 örnek istenir.
   - Öneri: **(a)**. Kurulum herkes için çalışır; örnek geldikçe ölçümle güncellenir.

İnce ayarlar sorulmaz, makul varsayılanla başlar ve **[V]** ile işaretlidir: oturum sınırı $3, aylık $20, en çok 24 örnek, %25 ayrılmış küme, kurulum genelinde 4 eşzamanlı üretim.

## 9. Kullanıcı kararları (2026-11-21; §8'deki sorular kapandı, plan metniyle çelişirse bu bölüm geçerli)

1. **Yapay zekâ anahtarı:** platform düzeyinde tek anahtar (yapay zekâ geçidi; `SONRAKI-OTURUM/YAPAY-ZEKA-GECIDI.md`). Geçit kuruldu (2026-11-23 kararıyla şimdi): platform kipinde TagPress yalnız geçitten çağırır, yerel kipte sahibin kayıtlı anahtarıyla. `org_secrets` tablosu yok; `KeySource = 'local' | 'platform'`.
2. **Yüklenen örnek etiketler:** oturumdan sonra firmanın referansı olarak saklanır; kullanıcı tek tıkla silebilir.
3. **Görsel denetim üründen kaldırılır** (ölçümde sonucu iyileştirmedi, maliyeti artırdı): `critique` özellik anahtarı, `visualCritique` ayarı, üretim akışındaki denetim adımı ve istemi silinir. Kurulumda ve Ayarlar'da yer almaz.
4. **"Birden çok dil" iki ayrı seçenektir:** müşteri metni dilleri (`text.languages`) ve birden çok tasarım dili (`language.multi`); kurulumda ikisi ayrı ayrı görünür, ikisi de varsayılan kapalı.
5. **Örneği olmayan kullanıcı** yapay zekâyla yalnız sorularla dil kurabilir; örnek geldikçe ölçümle güncellenir.
6. **Kesim şekli şablonun ayarıdır** (YOL-HARITASI); ürün etiketi (dikdörtgen) aynı tasarım dilinde çalışır.
7. **Göç numaraları:** 8 profil alanı, 9 firma, 10 sıkı kip, 11 özellikler, 12 baskı ölçüleri, 13 oluşturucu.
8. **Yapay zekâ deneme bütçesi:** gerçek API denemeleri için 10 dolara kadar onaylı.

## 10. Çok firmalı kullanıma açılmadan önce

Firma kapsamı iki kez bağımsız incelendi (ikincisi saldırgan gözüyle, 2026-11-21). Kimlikle erişim sızıntısı yok; aşağıdakiler başka firmalara açılmadan önce kapanmalı:

1. **API anahtarı uçları (platform kipinde kapandı).** Platform kipinde anahtar uçları `409 managed-by-platform` döner, anahtar yalnız geçitte; yerel kipte (girişsiz, tek kullanıcı) kurulum düzeyindeki anahtar bugünkü gibi.
2. **Firma başına yapay zekâ harcama sınırı (platform kipinde kapandı).** Geçit firmanın tek ortak aylık hakkını ve araç tavanını her çağrıda uygular (`sod_org_cap`, `sod_tool_cap`); araç yalnız işi baştan durdurmak için kalan hakkı okur. Yerel kipte oluşturucu dışı yollarda sınır yok (tek kullanıcı).
3. **Baskı yamasında kimlik varlığı (kapandı, 2026-11-22).** Dil kimliğindeki kural: `addPage`/`addItem`'ın `id`'si yalnız geçici başvurudur, sunucu her eklemeye UUIDv7 verir ve yanıtta `ids` (geçici → gerçek) döner; web yerel geçmişini ve seçimini buna göre çevirir. Hiçbir yanıt bir kimliğin var olup olmadığını söylemez; yalnız aynı yamada iki eklemeye aynı geçici kimlik `id-in-use`.
4. **Kaynak payı kesintisizdir.** Çalışan üretim işi kesilmez; çok firmalı kurulumda tek başına çalışan firma bir yuvayı boş bırakır, sonraki yuvalar en az çalışan firmaya gider. Bir işin süresi uzunsa diğer firmanın ikinci işi o kadar bekler.
5. **Kurulum düzeyi ortak klasörler.** `data/ortak/fontlar` ve `data/yedek` (göç öncesi veritabanı yedekleri) bütün firmaların; uçlar yalnız okur. 2. aşamada nesne deposuna `org/<orgId>/…` önekiyle geçilirken ayrılmalı.
