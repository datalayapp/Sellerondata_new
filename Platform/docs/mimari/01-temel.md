# Mimari: temel kararlar, depo, adresler, veritabanı (§1–§4)

Dizin ve diğer parçalar: `Platform/docs/ARCHITECTURE.md`. Bu dosya bağlayıcıdır; değişiklik gerekiyorsa önce burası güncellenir.

## 1. Mimariyi belirleyen kararlar

Kararların tam ve güncel listesi `Platform/docs/KARARLAR.md`'dedir. Burada yalnız mimariyi belirleyenler durur; çelişki olursa KARARLAR.md geçerlidir ve bu dosya ona göre düzeltilir.

- **Araçlar:** SellerOnData üst marka; araçlar DeciShip, OrderLoom, TagPress.
  - Kod anahtarı marka adının küçük harflisidir (`deciship`, `orderloom`, `tagpress`); veritabanına, adrese (`/orderloom`, `/api/orderloom`), izin adlarına (`orderloom.*`) ve işaret dosyası adına (`orderloom-mark.svg`) aynen yazılır; ekranda her dilde marka adı görünür.
  - Bugün yalnız DeciShip çalışır; OrderLoom ve TagPress `off` durumunda, Merkez'de tıklanamaz "Yakında".
- **Tek kayıt:** her aracın bütün tanımı `Platform/packages/contracts/src/products.ts` içindeki tek girdidedir: ad, slogan, renk (paletten), işaret, durum, izinler ve roller, sahip rolü, davet varsayılanı, Merkez izinleri, dağıtım (servis, port), site yolu, mobil giriş.
  - `catalog.ts` dışa aktarımları (`PRODUCTS`, `Permission`, etiketler) kayıttan türer.
  - Araç anahtarı Merkez ve gateway adlarıyla çakışamaz (`RESERVED_PRODUCT_KEYS`).
  - Site ürün listesi ve gateway ürün blokları kayıttan **üretilir** (§7).
  - Ad ve slogan kopyaları site ve Merkez metinlerinde ayrıca durur (`apps/site/src/content/common.mjs`, `pricing.mjs`, `hub-web/src/lib/site.ts`).
- **Çalışırken durum:** kayıttaki `launch` değeri `off` (kapalı), `pilot` (yalnız aboneliği olan firmalar), `public` (herkese açık) olur; Hesap servisinde `PRODUCT_LAUNCH` ortam değişkeniyle ezilir (çalıştırma: `KURULUM.md`).
  - Tek kural `productAccessFor` (`account-api/src/lib/productAccess.ts`): jeton, `/me`, `/catalog`, kayıtta otomatik açılış, rol atama, davet ve olay yayını hepsi ona bakar.
  - `off` araç hiçbir yoldan jetona girmez; `pilot` yalnız o üründe aboneliği olan firmada açılır.
  - Açılışta yapılandırma denetlenir: rolü, sahip rolü ya da API'si olmayan aracı açmak servisi durdurur. Kabuk, Merkez ve mobil açıklığı `/me`'den okur.
- **Deneme süresi yok** (kod, metin, ekran, durum olarak da). Ödeme yer tutucudur (`POST /org/billing/*` 501).
  - Kayıt `REGISTRATION_ENABLED=true|false` ile tamamen kapanır; açıkken kipi `SIGNUP_MODE=open|invite` (kapalı denemede `invite`: yalnız kayıt davetiyle, §6 "Kayıt yalnız davetle").
  - Yeni firmaya herkese açık (`public`) her araç `early_access` planıyla `ACTIVE` açılır (bugün DeciShip); eski firmalara `product:launch` ile (§6).
- **Merkez tüm araçların analiz, veri, ekip ve yetki merkezidir:** analiz, verilerin görüntülenmesi, dışa aktarma, etkinlik, ekip/yetki/firma/abonelik. **İş işlemi araçta kalır** (fark kararı vb.); Merkez'deki satır araca derin bağlantı verir.
- **Yetkilendirme tek yerde:** kişi, üyelik, rol Hesap servisinde, yönetimi Merkez'de. Araçta kullanıcı ekleme/düzenleme/şifre ekranı ve API'si yoktur.
- **Tek hesap:** site, Merkez, araçlar ve mobil aynı hesabı kullanır; şifre yalnız uygulama kökeninde (`app.sellerondata.com`) girilir, site yalnız yoklar ve çıkış yaptırır (§5 "Tek hesap").
- **E-postasız çalışan:** yönetici ad + telefon girer, sistem tek seferlik kod üretir, yönetici elden/WhatsApp ile iletir, çalışan şifresini kendi belirler. SMS yok; SMS satıştan önce eklenir, o zamana kadar numara kapma kabul edilen risktir (§11).
- **Roller izinle denetlenir:** DeciShip hazır rolleri Yönetici, Denetleyici, Muhasebe, Ölçüm, Erişim yok; firma özel rol de tanımlayabilir (§6 `/org/roles`). Kod rol adına değil izin anahtarına bakar (`packages/contracts`).
- **TR + EN:** site, Merkez, Hesap, DeciShip web, mobil, API hata mesajları.
- **Mobil:** tek SellerOnData uygulaması; araç ekranları araç grubunda, sekmeler role/aboneliğe göre açılır.
- **Veri taşıma yok:** eski DeciShip verisi korunmaz, eski Docker hacimlerine dokunulmaz, yeni sistem yeni hacim kullanır.

## 2. Depo ve klasör yapısı

```
SellerOnData/
  scripts/                    kök betikleri (depo denetimi, parça listesi, CI seçimi, test koşucuları)
  Platform/
    docs/                     ARCHITECTURE.md (dizin) + mimari/, DESIGN.md, KARARLAR.md, KURULUM.md
    packages/
      contracts/              @sellerondata/contracts  ürün, rol, izin, jeton, olay, Merkez sözleşmeleri. Bağımlılıksız saf TS. Web, API, mobil kullanır.
      auth-kit/               @sellerondata/auth-kit   ürün API'leri için Fastify eklentisi: jeton doğrulama, izin kontrolü, olay alıcısı, test jetonu üretici.
      shell/                  @sellerondata/shell      React ortak kabuk: D09 renk bandı, ürün menüsü, firma/hesap menüleri, belirteçler, oturum istemcisi, i18n, ürün işaretleri.
      product-kit/            @sellerondata/product-kit araç API'lerinin ortak işleri: kimlik izdüşümü (SQL), Merkez uçlarının çatısı, dönem, CSV, sınırlayıcı.
      format/                 @sellerondata/format     sayı, para, tarih biçimleme; bağımlılıksız, telefonda (Hermes) da çalışır.
      tokens/                 @sellerondata/tokens     tasarım belirteçlerinin tek kaynağı (tokens.json) ve üretim adımı.
    apps/
      account-api/            Hesap servisi (Fastify + Prisma, şema `platform`), port 4100
      hub-web/                Merkez + Hesap arayüzü (React + Vite), port 5180, base `/`
      site/                   Tanıtım sitesi (statik TR/EN), port 5190
    gateway/                  nginx: tek köken altında yol yönlendirme, CSP, internal engeli; `test/` senaryoları
    infra/postgres/           init.sql (yeni hacim), upgrade.sql (var olan hacim), verify.sh (kurulum sınaması)
    brand/                    marka ve ürün işaretleri, favicon ve mobil simgeler (`generate.mjs` üretir)
    e2e/                      Playwright uçtan uca testleri ve test yığını betikleri
    scripts/                  geliştirme betikleri (dev-gateway.mjs, dev.ps1, demo.ps1, products-gen.mjs, yedekle.ps1)
    keys/                     geliştirme imza anahtarı (git dışı)
    docker-compose.yml        tüm sistem
    docker-compose.prod.yml   üretim katmanı (zorunlu parola ve değişkenler)
    BASLAT.bat / DURDUR.bat / SIFIRLA.bat / POSTA.bat / YEDEKLE.bat
  Deciship/
    apps/api, apps/web        DeciShip API ve web paneli
    apps/mobile               tek SellerOnData mobil uygulaması (Merkez sekmesi dahil)
    packages/core             @deciship/core
    services/vision           görüntüden ölçüm servisi
```

- Tek git deposu (`github.com/GokcanT/SellerOnData`, çalışma dalı `gelistirme`).
- Paketler `file:` bağlantısıyla paylaşılır, workspaces yoktur: `exports` doğrudan `./src/index.ts`, tüketici `file:` bağımlılığı (`file:../../../Platform/packages/contracts`). Paket uyumunu kökte `npm run check` denetler; workspaces kararı kullanıcıdadır.
- Docker derleme bağlamı `SellerOnData/` köküdür. Mobil, metro `watchFolders` ile okur.

## 3. Adresler (tek köken)

Üretim `https://app.sellerondata.com`, geliştirme `http://localhost:8088` (gateway). Tanıtım sitesi üretimde `https://sellerondata.com`, geliştirmede `http://localhost:8089`.

| Yol | Hedef |
|---|---|
| `/` | `/home` yönlendirme |
| `/home`, `/analytics/*`, `/data/*`, `/activity`, `/account/*`, `/login`, `/register`, `/join`, `/invite/*`, `/forgot-password`, `/reset-password/*`, `/verify-email/*`, `/orderloom*`, `/tagpress*` | hub-web (son ikisi "yakında" sayfası; `/account/*` sayfaları §8) |
| `/deciship/*` | Deciship web (Vite `base: '/deciship/'`) |
| `/api/account/*` | account-api |
| `/api/deciship/*` | Deciship API |
| `*/internal/*` | Gateway'de 404. Yalnız iç ağ. |

Deciship web yolları İngilizcedir: `/deciship` (Pano), `/deciship/measurements`, `/deciship/invoices` (`/:id`, `/upload`), `/deciship/disputes`, `/deciship/tariffs` (`/:id`, `/new`), `/deciship/settings`, `/deciship/setup`.

**Açılış sırası.** İkincil bir parça bozulsa da giriş ve Merkez açılır:
- Gateway yalnız `account-api` ve `hub-web` sağlıklı olunca açılır; DeciShip'i beklemez (açılışın ilk saniyelerinde `/deciship/` 503 verebilir).
- DeciShip API görüntü servisini yalnız başlamış olarak bekler; servis yoksa ölçüm ucu istek anında `503 VISION_UNAVAILABLE` döner.
- `Platform/scripts/dev.ps1` ve `demo.ps1` görüntü servisi ya da DeciShip açılmazsa durmaz, sarı uyarı verir.

## 4. Veritabanı

Tek Postgres, veritabanı `sellerondata`. Kiracı başına bir şema ve iki rol; kiracılar `platform` (Hesap servisi) ve araç kaydında `deploy.api` alanı olan her araç (bugün `deciship`). Veritabanının sahibi süper kullanıcıdır. Hiçbir rolde `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `REPLICATION` yoktur; roller birbirine üye değildir.

| Rol | İş | Erişim |
|---|---|---|
| `sod_<k>_admin` (`sod_platform_admin`, `sod_deciship_admin`) | Kiracının migration'ı | `<k>` şemasının sahibi. Başka şemayı göremez. |
| `sod_<k>` (`sod_platform`, `sod_deciship`) | Kiracının API'si (account-api, DeciShip API) | Yalnız `<k>`, yalnız veri (default privileges: tablo, dizi, işlev). DDL yok. |

- "Her ürün yalnız kendi alanına yazar" kuralı veritabanı düzeyinde geçerlidir, migration rolü için de. Platform şemasında araçlara açık görünüm yoktur; araç kimliği olaylarla kendi şemasına yazar.
- Migration rolü uygulama kabına girmez: tek seferlik kapta ürünün migration rolüyle çalışır, uygulama kabı bu parolayı bilmez.
- `infra/postgres/init.sql` (yeni hacim) ve `upgrade.sql` (var olan hacim, compose'da `postgres-upgrade`) **üretilir**: `npm run products:gen` araç kaydından yazar (`Platform/scripts/products-db.mjs`), elle düzenlenmez. Kayda yeni eklenen aracın rolleri ve şeması var olan hacimde `upgrade.sql` ile açılır; üretimde (`SOD_ENV=production`) yeni rol `*_dev` parolasıyla açılmaz. Parola değişkenleri `SOD_<K>_ADMIN_DB_PASSWORD`, `SOD_<K>_DB_PASSWORD`. Anahtar Postgres ayrılmış sözcüğü ya da iç ad (`superuser`, `platform`, `public`…) olamaz.
- Üretimde (`SOD_ENV=production`; temel compose `SOD_ENV`i ortamdan, yani sunucunun `.env` dosyasından alır) `upgrade.sql` sonunda her `sod_` rolüne ağ üzerinden `<rol>_dev` ile girmeyi dener (`infra/postgres/dev-parola.sh`); biri girerse ya da sunucu parolayı sınamıyorsa (yerel soket, 127.0.0.1) durur. Rol ayarları her koşuda baştan yazılır (`RESET ALL` + `search_path`, uygulama rolünde UTC). Parola taşıyan oturum ifade günlüğünü kapatır (`log_statement`, `log_min_error_statement`).
- Kurulumun sınaması `bash infra/postgres/verify.sh` (Docker; kaplar `--rm`, kiracı listesini `init.sql`'deki `-- @sod-schemas` satırından okur; bağlantılar kabın IP adresine gider, parola gerçekten sınanır).
  - Denetlenenler: rol öznitelikleri ve ayarları, her rolün yalnız kendi şemasında hakkı (her kiracı çifti için okuma, yazma, işlev, tablo açma), `upgrade.sql`'in yeni kurulumda hiçbir şey değiştirmemesi, üretim parolası reddi, üretimde her rolün gerçek parolayla girip `*_dev` ile girememesi, düz parolanın sunucu günlüğüne düşmemesi, `yedek-kap.sh rol-parola`. `SOD_VERIFY_OLD_INIT=<eski init.sql>` ile var olan hacme yeni araç eklenmesini (geliştirmede ve üretimde) sınar.
- Kayıtta olup elle yazılan listeler (compose, `.env` örneği, CI, kök betikler, yedek betikleri, göç denetimi) üretilmez; `npm run products:check` her aracın bunlarda olduğunu denetler (`Platform/scripts/products-lists.mjs`; liste `mimari/06-merkez.md` "Yeni araç ekleme").
- Çapraz şema yabancı anahtar yoktur.

**Migration kuralları.**
- Şemayı `init.sql` açar: migration'da `CREATE SCHEMA` olmaz, rolde `CREATE ON DATABASE` yoktur (Prisma'nın ürettiği satır silinir).
- Her ürünün ilk migration'ı `REVOKE ALL ON TABLE "_prisma_migrations" FROM <uygulama rolü>;` içerir: default privileges o tabloyu da kapsar, uygulama rolü migration geçmişine yazamamalı. `_prisma_migrations` şemanın içinde durur.
- `prisma migrate dev` gölge veritabanı ister: `SHADOW_DATABASE_URL` süper kullanıcıyla verilir (yalnız geliştirme).

**Şema değişikliği, üretim öncesi ve sonrası.**
- Üretim kurulumu yokken kural ürün başına tek `init`ti: değişiklik `init`e yazılır, geliştirme hacmi `SIFIRLA.bat` ile baştan açılır. Bugün bu kurala uyulmuyor: iki üründe de birden çok ileri migration var. İlk üretim kurulumundan önce bunlar tek `init`e indirilir ya da kural kaldırılır (karar bekliyor).
- `migrate deploy` değişmiş `init`i uygulamaz ve `migrate status` bunu göstermez; bu yüzden DeciShip API açılışta şemaya bakar, eski şemada anlaşılır hatayla başlamaz (`lib/schemaCheck.ts`).
- İlk üretim kurulumundan sonra her değişiklik ileri migration'dır, `init` değişmez.
- DeciShip'te firma tablosu dışındaki yabancı anahtarlar bileşik, `Measurement_current_tracking_key` ve `Invoice_current_no_key` kısmi dizindir; bunlar yalnız SQL'dedir, `npm run db:check-drift` korur.

**Üretim.** `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. Parola eksikse compose başlamaz. `*_dev` parola `init.sql`de (`SOD_ENV=production`) ve servis açılışında (`hasDevPassword`, `contracts`) reddedilir.

**Kalan riskler (Postgres ile kapatılamaz).**
- Bir rol kendi parolasını ve rol ayarlarını (`search_path`, `row_security`…) `ALTER ROLE` ile değiştirebilir. Ayrım şema haklarına dayanır; `upgrade.sql` ayarları her koşuda baştan yazar.
- `NOTIFY` komutu GRANT ile kapatılamaz (işlevi kapalı).
- `pg_advisory_lock` herkese açıktır: uygulama rolü Prisma'nın sabit kilidini (72707369) tutarak migration'ı bekletebilir; kapatılırsa Prisma'nın da yetkisi gerekir, bu yüzden açık bırakıldı.
- Migration rolü kendi şemasında FORCE RLS'yi kapatabilir (sahiptir): bu yüzden uygulama kabına girmez.

### platform şeması

- `Person` id, name, email? (unique, küçük harf), phone? (unique, E.164), phoneVerifiedAt? (SMS için hazır, kullanım yok), suspendedAt? (destek işlemi), passwordHash (argon2id), locale (`tr|en`), emailVerifiedAt?, pendingEmail? (doğrulama bekleyen yeni adres; benzersiz değil, onayda denetlenir), lastOrgId?, createdAt. En az biri zorunlu: email veya phone; yalnız askıdaki kişi kimliksiz olabilir.
- `Organization` id, name, country (ISO 3166-1 alfa-2, varsayılan `TR`), currency (`TRY|USD|EUR|GBP`), locale (firma dili), timeZone (`TIME_ZONES`'tan, varsayılan `Europe/Istanbul`), companyConfirmedAt (Merkez kurulumu: firma bilgileri onaylandığı an; `null` = onay bekliyor, yeni firma `null` açılır, göçten önceki firmalar `createdAt` ile dolduruldu), closedAt?, closedById?, purgeAfter? (firma kapatma, §6 "Firmayı kapatma"; `closedAt` ve `purgeAfter` birlikte dolu ya da boş), version (olay sürümü, §6), createdAt.
- `Membership` id, personId, orgId, orgRole (`OWNER|ADMIN|MEMBER`), status (`ACTIVE|SUSPENDED`), epoch (int, her yetki değişiminde artar), lastActiveAt, unique(personId, orgId). Her firmada tam bir OWNER.
- `ProductAccess` membershipId, product, role, customRoleId?, unique(membershipId, product). Kayıt yoksa "Erişim yok". Rol değeri `contracts` kataloğundaki hazır rol anahtarı ya da `custom:<ProductRole.id>`; özel rolde `customRoleId` doludur (göçteki CHECK), kullanılan özel rol önce başka role taşınmadan silinemez.
- `ProductRole` firmanın araç rolü: özel rol (`builtinKey` boş, `name` zorunlu) ya da hazır rolün firmadaki gölgesi (`builtinKey` dolu; ad, açıklama, izinleri katalogun üstüne yazar ya da rolü gizler, `hidden`). Alanlar: orgId, product, name?, description?, permissions, inheritPermissions, basedOn?, builtinKey?, hidden, version (iyimser kilit), createdById?. Ad tekilliği göçteki kısmi dizindedir. Ürün kararı: KARARLAR.md "Özel roller".
- `Subscription` orgId, product, status (`ACTIVE|READ_ONLY|CANCELED`), plan, limits (Json), currentPeriodEnd?, canceledAt?, deleteAfter?, version (olay sürümü, §6), unique(orgId, product). Ödeme sağlayıcı alanları (`provider`, `providerRef`) boş kalır.
- `Invitation` orgId, kind (`EMAIL|PHONE_CODE|PHONE_RESET`), email?, phone?, name?, orgRole, productRoles (Json), tokenHash, expiresAt, attempts, acceptedAt?, revokedAt?, invitedById, targetPersonId?.
- `SignupInvite` kayıt daveti (§6 "Kayıt yalnız davetle"): email, tokenHash, expiresAt, usedAt?, usedByPersonId?, orgId?, createdBy. Firmaya ekip daveti (`Invitation`) ayrıdır.
- `Session` id, personId, activeOrgId?, client (`web|mobile`), familyId, familyCreatedAt (ailenin ilk girişi; döndürmede kopyalanır), refreshHash, userAgent?, ip?, lastUsedAt, expiresAt, rotatedAt?, revokedAt?, parentId? (bu satırı doğuran yenilemede sunulan satır; girişle açılan satırda ve `20261118090000` göçünden önce boş; yenileme toleransı buna bakar, §6 "Oturum"), retryKeyHash? (o yenilemede gelen tekrar anahtarının SHA-256 özeti; anahtarsız istemcide boş).
- `OneTimeToken` kind (`PASSWORD_RESET|EMAIL_VERIFY`), personId, email? (jetonun kanıtladığı adres; boşsa kişinin o anki adresi), tokenHash, expiresAt, usedAt?. Kişi ve tür başına en çok 3 etkin jeton (`MAX_ACTIVE_TOKENS`): tavan doluyken sıfırlama jetonu üretilmez (posta gitmez), doğrulama jetonunda en eskisi silinir. Yeni istek eski bağlantıyı öldürmez.
- `RateBucket` key, count, windowEnd. Sınırlama veritabanındadır, bellekte değil.
- `AuditLog` orgId?, actorMembershipId?, actorPersonId?, action, target, meta, ip, createdAt.
- `Outbox` id, type, orgId?, payload, createdAt. `OutboxDelivery` outboxId, target, status (`PENDING|DELIVERED|DEAD`), attempts, nextAttemptAt, lastError?, deliveredAt? (hedef başına teslim).
- `ProductNotice` id, product, orgId (firma silinince silinir), dedupeKey, recipients, createdAt, attemptedAt?, sentAt?, bodyHash?; unique(product, orgId, dedupeKey). Araç bildiriminin tekrar ve günlük tavan kaydı (§6 "Araç bildirimi"); `sentAt` postaların gönderimi bitince yazılır; 30 gün sonra silinir.
- `MailLog` yalnız geliştirme posta kutusu (`DEV_MAILBOX`; `POSTA.bat` okur).

### deciship şeması

- `Company.id == Organization.id`. `Company` projeksiyondur: name, nameVersion? (adı yazan son `org.updated` sürümü; eski olay yeni adı ezmez), closedAt? ve closedVersion? (`org.closed`/`org.reopened` ile yazılır; doluysa uçlar `409 ORG_CLOSED`, arka plan işleri atlar) + DeciShip `settings`. Şirket adı değiştirme yetkisi Merkez'dedir.
- `Member`, `id == Membership.id`. Alanlar: id, companyId, personId, name, role? (hazır rol anahtarı ya da `custom:<uuid>`; null: üye var, DeciShip erişimi yok), permissions (rolün firmadaki geçerli izinleri, katalogla kesişmiş; NULL = rolden katalogla türet; ham SQL ile okunur ve yazılır), active, epoch, lastSeenAt.
  - Şifre, kullanıcı adı, e-posta ve yenileme jetonu bu şemada yoktur.
  - İş tablolarındaki `measuredById` vb. alanlar `Member`a bağlanır; firma kapsamı ve iş kodu bozulmaz.
- `ProcessedEvent` eventId. Olay tekrarına karşı.
- Migration geçmişi `20261106120000_init` ile başlar; eski DeciShip geçmişi taşınmadı.
- RLS: `companyId` taşıyan her tabloda `USING (companyId = current_setting('app.company_id', true))`, `FORCE ROW LEVEL SECURITY`. İstek bağlamı AsyncLocalStorage + Prisma istemci eklentisi ile `SET LOCAL` yapar.
