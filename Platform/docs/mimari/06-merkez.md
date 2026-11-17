# Mimari: Merkez sözleşmesi, bilgi mimarisi, i18n, marka (§7–§10)

Dizin ve diğer parçalar: `Platform/docs/ARCHITECTURE.md`.

## 7. Merkez sözleşmesi (ürünlerin uyguladığı uçlar)

Her ürün `/api/<ürün>/platform/*` altında `contracts/hub.ts` şeklinde şu uçları sunar. Merkez aynı kökenden doğrudan çağırır, jeton çerezdedir, ürün izne göre süzer. Merkez başka ürünün veritabanına asla bakmaz. Etiketler ürün tarafında `Accept-Language`'a göre yerelleşir.

```
GET /platform/overview?from&to              -> HubOverview  (KPI, dikkat listesi, kurulum durumu; deneme turunda `sample: true`)
GET /platform/analytics?from&to&compare&... -> HubAnalytics (filtre tanımları + bölümler + widget'lar)
GET /platform/datasets                      -> HubDatasetList
GET /platform/datasets/:id?page&pageSize&q&sort&dir&filter.*  -> HubDatasetPage (her satırda `href` derin bağlantı)
GET /platform/datasets/:id/export?...       -> CSV (izin: data.export)
GET /platform/activity?page                 -> HubActivityPage
```

- Ürün kapalıysa veya kişinin izni yoksa `403`, Merkez o bölümü gizler. Merkez'de ürün çağrısı başarısızsa yalnız o bölüm hata gösterir, sayfa ayakta kalır.
- Sayılar aracın deneme turundaki örnek veriden geliyorsa overview `sample: true` taşır (isteğe bağlı; tur yoksa alan hiç gelmez); Merkez Genel Bakış o aracın baş rakam kartının başlığına "Örnek veri" notu koyar.
- **Hedef:** yeni ürün Merkez ve kabuk koduna dokunmadan, yalnız kayıt girdisi ve bu uçlarla takılır. Bugün büyük ölçüde böyledir: kabuk ve Merkez araç listesini kayıttan, açıklığı `/me`'den okur (`isProductOpen`, `productHref`, `isHubPath`, `hubOwnedProductKeys`); Etkinlik akışları, Ekip davet varsayılanı ve "Yakında" rotaları kayıttan gelir; çok araçta Genel Bakış'ta kurulum kartı çıkar (`setupLayout`). Kalan sabitler aşağıda "Hâlâ elle kalanlar".

### Yeni araç ekleme

Örnek OrderLoom (`orderloom`).

1. **Kayıt:** `contracts/src/products.ts` içine tek `defineProduct({...})` girdisi. Renk `tokens.json` paletinden gelir (palette yeni araç için girdi ister). Başlangıç durumu `off` ya da `pilot`.
2. **Üret ve commit et:** kökte `npm run products:gen`. Üretilenler elle düzenlenmez; bayatlığı `npm run products:check` yakalar:
   - `Platform/gateway/conf/products/<anahtar>.conf` (gateway blokları) ve `Platform/apps/site/src/content/products.generated.json` (site listesi). Geliştirme kapısı (`Platform/scripts/dev-gateway.mjs`) kayıttan yönlendirir.
   - `Platform/infra/postgres/init.sql` ve `upgrade.sql`: `deploy.api` olan aracın `<anahtar>` şeması, `sod_<anahtar>_admin` ve `sod_<anahtar>` rolleri (`mimari/01-temel.md` §4). Var olan hacimde `docker compose run --rm postgres-upgrade` açar; sınama `bash infra/postgres/verify.sh`.
   - **Elle yazılan listeler** üretilmez; `products:check` aracın klasörü (`Orderloom/`: anahtarın ilk harfi büyük) ve kayıt girdisi için denetler, eksikte kalır:
     - her paket `scripts/parts.mjs`, `scripts/install.mjs`, `scripts/test-changed.mjs` ve `ci.yml` npm önbellek yollarında; veritabanı parçası `scripts/ci-select.mjs` `DB_PATHS` ve `ci.yml` veritabanı matrisinde;
     - `scripts/repo-check.config.mjs`: göç klasörü aracın şemasında, şema `rlsSchemas`'ta, `node_modules` bağlayan imaj `sharedNodeModules`'ta. Aracın göçlerinde `CREATE SCHEMA`, başka kiracının rolü ya da şeması, başka şemaya `GRANT … ON SCHEMA` ve `PUBLIC`'e hak (`GRANT`, `ALTER DEFAULT PRIVILEGES … TO PUBLIC`) yok; `_prisma_migrations` uygulama rolünden geri alınmış;
     - `Platform/gateway/test/access-log.test.mjs` (aracın `nginx.conf`'u); klasör `Platform/e2e/snapshot.mjs`, `scripts/repo-check.mjs` `DOC_ROOTS` ve `scripts/test.mjs --scope` içinde;
     - iki compose: `postgres` ve `postgres-upgrade` parolaları, API servisi yalnız `sod_<anahtar>` ile, göç servisi `sod_<anahtar>_admin` ve `?schema=<anahtar>` ile, `PRODUCT_EVENT_TARGETS`. Hiçbir servis iki kiracının rolüyle bağlanmaz, göç servisi dışında migration parolası yok;
     - `Platform/.env.example`, `Platform/scripts/dev.ps1`, `Platform/scripts/yedekle.ps1` (şema listeleri). Geri yükleme parolaları listesizdir: `geri-yukle.ps1` adları `.env`'den desenle alır, `yedek-kap.sh` rolleri veritabanından okur; yeni aracın parolaları `.env`'e yazılmalı (üretimde eksikse geri yükleme parola eşitlemede durur).
3. **Aracın kendi kodu:** API ve web `@sellerondata/product-kit` ile: kimlik izdüşümü (SQL `memberProjectionSql`: `Company`, `Member`, `ProcessedEvent`, `CompanyPurge`, RLS; aracın ilk göçüne yapıştırılır, göç rolüyle çalışır; şemayı açmaz, şema ve iki rol kayıttan üretilen `init.sql`/`upgrade.sql`'dedir), Merkez uçlarının çatısı (bu bölümün uçları), dönem, CSV ve sınırlayıcı yardımcıları. Saf parçalar (dönem, CSV, saat dilimi, yuva sayacı; Fastify ve pg yok) `@sellerondata/product-kit/pure` girişinde, DeciShip'teki kopyalarla aynı çıktı (`test/pure.test.ts`). Kimlik paketindeki `definition` dikişi yalnız `NODE_ENV=test` iken kabul edilir (üretimde kayıttaki tanım). DeciShip bu pakete geçmedi; paket DeciShip'in sözleşmesini aynen uygular:
   - firma saat dilimi ve Merkez onayı `org.updated`'dan yerel `Company`'ye (`timeZone`, `companyConfirmed`; yeni firma onaysız açılır). Merkez çatısı ikisini kendisi okur (`HubCtx.timeZone`, `HubCtx.companyConfirmed`): dönem, "bugün" ve CSV firmanın gününe göre; onaysız firmada Genel Bakış'ın `setup.completed` alanı `false` döner. Aracın kendi uçları `readOrgProfile` ile okur;
   - özel roller: `Member.permissions` (null = rolden türet); istek dışı yetki `loadMemberAccess` + `memberPermissions`. Aracın tabloları üyeye bileşik anahtarla bağlanır (`Member` `UNIQUE ("id", "orgId")`);
   - aracın firma tabloları `"orgId"` sütunu ve `Company`'ye yabancı anahtar taşır (RLS ilkesi ve kalıcı silme bu sütunla); `orgId`'siz çocuk tablo ebeveynine `ON DELETE CASCADE` ile bağlanır;
   - kalıcı silme parça parça: olay yalnız `CompanyPurge` kaydını yazar (RLS: yalnız olay kapsamında; bitiş anı bir kez yazılır), silme commit'ten sonra kısa işlemlerle sürer, yarıda kalırsa yeniden denenir (ilk tur açılıştan 60 sn sonra, sonra saatlik; `completedAt`). Araç `registerProductIdentity` `purge.tables` ile firma tablolarını silme sırasıyla (çocuk önce) verir; dosya yolu dönen tablo varsa `onRowsDeleted` ve kalan her şeyi silen `onPurged` zorunludur. Testinde `checkPurgeTables()` `[]` beklenir (katalogdan: listede olmayan firma tablosu, engelleyen bağ, sıra, silme yetkisi, sütunlar).
   - işlenmiş olay kimlikleri (`ProcessedEvent`) 30 gün saklanır (DeciShip ile aynı): bakım turu (saatlik, silme yeniden denemesiyle aynı zamanlayıcı) `cleanupProcessedEvents` ile siler; RLS bakım kapsamında yalnız süresi dolmuşu gösterir, olay kapsamı silemez.
   - haklar: kendi tablonuz init.sql'in varsayılanıyla uygulama rolünden SELECT/INSERT/UPDATE/DELETE alır; gerekmeyeni göçte REVOKE edin (örnek: `test/ornekarac/migration.sql` `Item`). Toplu `GRANT … ON ALL TABLES IN SCHEMA` yasak (`products:check`): şablon tablolarının daraltılmış haklarını genişletir. Aracın testi `identity.checkGrants()` için `[]` beklesin.
   - **Web paneli:** `Platform/templates/tool-web/`'i `<Klasör>/apps/web`'e kopyalayın, `package.json.tmpl`'i `package.json` yapın, `ornekarac`/`Ornekarac`/`ORNEKARAC` adlarını değiştirin (şablonun README'sindeki komut). Kayıtta `webAccess` ve `deploy.web` (`service`, `port: 80`, `dev`) olmalı; gateway blokları `products:gen` ile üretilir, şablonun `nginx.conf`'u onlarla eşleşir. Şablon tasarım varsaymaz: yalnız kabuk stilleri yüklüdür, aracın tasarım dili seçilince eklenir. `products:check`'in denetlemediği yerler (compose web servisi, `compose-order.test.mjs`, `gateway/test/run.sh`, `dev.ps1`, lint `UI` listesi) ve DeciShip panelinden ortak pakete alınacak parçalar (426 kancası, web erişim kapısı, sürüm bandı, sahte Hesap uçları) README'de listelidir; alındıkça şablondaki karşılıkları silinir.
   - **Merkez sahte API'si** (`hub-web/src/mocks/`, `dev:mock` ve Merkez testleri) araçtan bağımsızdır: aracın ortak Merkez uçları (`/api/<anahtar>/platform/{overview,analytics,datasets,datasets/:id,datasets/:id/export,activity}`) kayıttan kurulur (`handlers.ts` `productHandlers`), kapılar kayıttaki `hub` izinleri, yanıtlar `hub.ts` sağlayıcısından: elle yazılmış örnek üretici (yalnız DeciShip, `deciship.ts`), yoksa aracın gerçek yanıt kaydı `hub-web/e2e/fixtures/<anahtar>-real/*.json`, yoksa boş sözleşme yanıtları (`emptyHub*`). Yeni araçta kod değişmez: aracın API testi kaydı üretir (desen `Deciship/apps/api/test/hub/hubWebFixtures.test.ts`; dosya adları `overview.<dil>`, `analytics.<dil>`, `datasets.<dil>`, `dataset.<kimlik>.<dil>`, `activity.<dil>`, biçim `{ status, body }`, kimlik `<id>`, an `<zaman>`), Merkez kaydı olduğu gibi sunar (dönem, süzgeç ve sayfa uygulanmaz; iş kuralı kopyalanmaz). Araca özel uçlar (DeciShip yapay zekâ kullanımı) `handlers.ts`'de elle. `test/hub-providers.test.mjs` klasör adlarını ve seçimi denetler.
   - **Hesap uçlarının gerçek kaydı:** `account-api/test/hubWebFixtures.test.ts` (Postgres) Merkez'in kullandığı Hesap uçlarının yanıtını `hub-web/e2e/fixtures/account-real/` altına yazar ve karşılaştırır (bilerek yenileme: `account-api` içinde `npx vitest run test/hubWebFixtures.test.ts -u`). Merkez'de `test/account-contract.test.mjs` sahte Hesap işleyicilerini Node'da (`msw/node`, `test/lib/mock-server.mjs`) çağırıp yanıt şeklini bu kayda karşı sınar (`scripts/lib/shape.mjs`); kayıt yenilenince orada kırılır, sahte API gerçeğe uydurulur, test gevşetilmez. Yeni araç Hesap'a uç eklerse kaydına da eklenir.
4. **Açma:** `PRODUCT_LAUNCH=orderloom=pilot` ile Hesap servisi yeniden başlar; aracı firmaya `subscription:set`, herkese `product:launch` ile açın (araç `public` olduktan sonra). `off` iken `pilot`a geçince `members:announce` üyeleri araca duyurur. Çalıştırma: `KURULUM.md` "Destek komutları".
5. **Hâlâ elle kalanlar** (sahte araç `ornekarac` ile sınandı: elle dokunulan üretim dosyası 1, üretilen 1):
   - adım 2'deki listeler (denetlenir, üretilmez) ve compose'daki migrate, api, web servislerinin kendisi;
   - demo tohumu ve taklit sunucunun kişi tohumu (`shell/src/mock/seed.ts`: üyelerin araç rolleri bugün yalnız `deciship`); aracın Merkez yanıt kaydını üreten API testi; iki araçlı e2e senaryoları;
   - mobil ekran (`Deciship/apps/mobile`) ve yeni APK;
   - bant renkleri: `bandTheme` yalnız `deciship` için tasarımdan sabit değer tutar, diğer araçlar katalog renginden türer; sabit bant istenirse `tokens.json`a bant girdisi ve `bandTheme`e satır gerekir;
   - araç web'i ve API'si.

## 8. Merkez bilgi mimarisi

Ortak kabuk (`@sellerondata/shell`, her web uygulamasında aynı): üstte D09 renk bandı; ürün menüsünde Merkez, DeciShip, OrderLoom ve TagPress (ikisi "Yakında", tıklanamaz); firma, dil ve hesap menüleri. Görsel ayrıntı `Platform/docs/DESIGN.md`'dedir.

- `/home` Genel Bakış: tüm araçların dönem KPI'ları, dikkat isteyenler, kurulum durumu, araçlara giriş.
- `/analytics` Analiz: araç sekmeleri, tarih aralığı, önceki dönemle karşılaştırma, filtre, grafik/tablo, CSV, kayda derin bağlantı.
- `/data` Veriler: araç başına veri setleri, arama, sıralama, süzme, sayfalama, CSV, kayda derin bağlantı.
- `/activity` Etkinlik: platform + araç denetim izi.
- `/account/team` Ekip ve yetkiler: kişi × araç matrisi, davet, telefon kodu, askı, çıkarma.
- `/account/company`, `/account/company/new` (firma aç), `/account/billing` (yer tutucu).
- Hesabım: `/account/profile` (kişisel bilgiler, dil), `/account/security` (şifre, açık oturumlar), `/account/firms` (Firmalarım: firma listesi, geçiş, ayrılma, sahibe kapalı firmalar ve "Geri aç"; kapalı firmanın tarihleri o firmanın saat diliminde, geri açılınca sayfa yenilenir ve "geri açıldı" bildirimi bir kez çıkar; herhangi bir okuma `409 ORG_CLOSED` alırsa Merkez `/me`'yi yeniden okur); `/account` Profil'e gider. Eski `/account/memberships` ve `/account/profile#firmalar` adresleri `/account/firms`'e yönlenir.
- Aracın plan ve durumu yönetici için Abonelik'te, herkes için ⊞ menüsünde.
- `/account/tool-access/:product`: aracın web izni olmayan kişinin sayfası.

**Görünürlük:** OWNER/ADMIN Hesap yönetimi. Analiz ve Veriler ürün iznine göre. Ölçüm rolündeki kişi web'de Merkez'in sade halini görür; DeciShip'e tıklarsa `/account/tool-access/deciship` açılır: rolü varsa "bu rol mobil uygulamada çalışır", yoksa "erişiminiz yok" (`deciship.web.access` izni yok).

**Mobil Merkez sekmesi:** SellerOnData uygulamasında hafif bir Merkez sekmesi vardır: Genel Bakış, bekleyenler, KPI, analiz grafikleri, ekip listesi (salt okunur).
- Aynı `platform/*` ve `/api/account/org/members` uçlarını kullanır.
- Sekme yalnız izni olana görünür: OWNER/ADMIN veya ürün raporu izni olanlar; yalnız Ölçüm rolündeki kişi görmez.
- Rol değiştirme, davet ve abonelik ilk sürümde web'de kalır; satırdan araca derin bağlantı mobilde ilgili ekranı açar, yoksa web'e yönlendirir.

**Hata sınırı (ortak kabuk).** `packages/shell/src/ErrorBoundary.tsx` (`variant: 'section' | 'page'`, `resetKey`, `home`, `onError`):
- `AppShell` yalnız `<main>` içeriğini sarar; bant, menü, sağlayıcılar ve bildirimler ayakta kalır. `resetKey` yoldur (`pathname`); sorgu değişimi sınırı sıfırlamaz.
- Merkez'de ayrıca tam sayfa son çare sınırı (`main.tsx`, `variant="page"`) var; Hesabım kabuğun içinde çizildiği için kabuk sınırına düşer (ayrı sınırı yok). DeciShip panelinde rota `errorElement` öncelikli, kabuk sınırı yedektir.
- Yedek ekran: başlık, tek cümle, "Sayfayı yenile" (tam yenileme) ve ana sayfa bağlantısı (tam sayfa geçiş); "Teknik ayrıntı"da yalnız `ad: ileti`, yığın yok. "Tekrar dene" yok: çöken veriyle aynı hata tekrar eder. Hata `console.error`'a yazılır; sunucuya gönderilmez.
- Mobilde iki katman: `app/_layout.tsx` (son çare, sağlayıcıya bağlı kanca kullanmaz) ve `app/(tabs)/_layout.tsx` ("Yeniden dene", "Bugün'e dön").

**Çıkış ve firma değiştirme (ortak kabuk).** `useSessionActions().logout()` hata fırlatmaz, `{ serverEnded }` döner:
- Sunucu oturumu bitirdi sayılır: 2xx ya da 400–499 (408 ve 429 hariç; 401 dahil, oturum zaten yok). Yerel durum (önbellek, firma, sorgular) silinir, kişi girişe gider.
- Bitmedi sayılır: ağ hatası, 408, 429, 5xx. Yerel durum silinmez; kişi sayfada kalır ve "Çıkış yapılamadı. Oturumunuz hâlâ açık" bildirimi `always` seçeneğiyle (bant bastırmasını atlar) görünür. Gerekçe: sunucuda açık kalan oturumla giriş sayfası kişiyi geri içeri alırdı.
- Merkez çağıranları tek kancadan geçer (`hub-web/src/lib/logout.ts` `useLogoutAction`). `switchOrg` hata fırlatır; çağıran "Firma değiştirilemedi" der. DeciShip panelinde kaydedilmemiş değişiklik varsa firma değişiminden önce onay sorulur.
- Çıkış öbür sekmelere duyurulur (`sod-session` kanalında `{ type: 'logout' }`; oturum istemcisi `announceLogout`, yalnız sunucu oturumu bitirdiyse). Duyuruyu alan sekme bir sonraki isteği beklemeden kabuk önbelleğini siler ve bir kez `onSessionLost` çağırır: Merkez girişe gider, DeciShip kaydedilmemiş yazı varsa önce sorar (oturum kaybıyla aynı yol).

**Parça parça yükleme (Merkez):** `App.tsx` sayfaları `React.lazy` ile ayrı parçalardan yükler (Genel Bakış, Analiz, Veriler, Etkinlik, Ekip, Abonelik, Hesabım, Araç erişimi); kabuk ilk pakettedir, parça gelene kadar içerikte `PageSkeleton` durur. Giriş/kayıt, Firma ve Yeni firma ilk pakette kalır (birbirlerini ve firmasız ekranı içe aktarırlar). Grafikler (`components/charts.tsx`) yalnız onları kullanan sayfa parçalarıyla iner. `chunkSizeWarningLimit` yok: ilk paket 500 kB uyarı sınırının altında.

**Araçlar arası geçiş:** her uygulama ayrı yayınlanır, geçiş tam sayfa gezintidir. Cross-document View Transitions (`@view-transition { navigation: auto; }`) + ortak `view-transition-name` ile bant yerinde kalır, içerik yumuşak geçer. Speculation Rules ile önceden yükleme. Etkin araç bant rengiyle, adı ve işaretiyle net belli olur.

## 9. i18n

- `i18next` + `react-i18next`, anahtarlı `locales/{tr,en}/<ns>.json`. Her uygulamada ayrı dosyalar, `shell` kendi metinleriyle gelir. Arayüz metni koda gömülmez, i18n anahtarı olur.
- Dil kaynağı: `Person.locale` → `sod_lang` çerezi (HttpOnly değil, `.sellerondata.com` üretimde) → tarayıcı dilleri (`navigator.languages` sırasıyla ilk desteklenen) → İngilizce (`contracts` `pickInitialLocale`, `DEFAULT_LOCALE`; karar: KARARLAR.md ilk açılış dili). Mobilde kayıtlı seçim, yoksa cihaz dili, yoksa İngilizce. Dil değişimi `PATCH /me`.
- Tarih, sayı, para `Intl` ile etkin dile göre. Marka ve ürün adları çevrilmez.
- API: `Accept-Language` → yerelleşmiş hata mesajı ve üretilen dosya (rapor, itiraz metni, Excel) metni. Başlıkta desteklenen dil yoksa oturumun dili, o da yoksa İngilizce. Hesap servisinde yeni kişi ve firmanın dili gövdedeki `locale`, yoksa `Accept-Language`, yoksa İngilizce.
- Site: `/` TR, `/en/` EN, `hreflang` (`x-default` EN). Çerez yoksa tarayıcı diline göre sekmede bir kez öbür dile yönlendirir (`site.js`).

## 10. Marka

Yazım `SellerOnData`, `DeciShip`, `OrderLoom`, `TagPress`; adlar çevrilmez. Ürün rengi `contracts` kataloğunda, bant belirteçleri `packages/shell/src/AppShell.tsx` (`bandTheme`) içindedir. İşaret ve simge dosyaları `Platform/brand/` altında `generate.mjs` ile üretilir; kabuktaki kaynak `packages/shell/src/marks.tsx`. Renk, yazı ve bileşen kuralları `Platform/docs/DESIGN.md`'dedir.
