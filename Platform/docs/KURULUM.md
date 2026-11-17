# Kurulum

Komutlar `Platform` klasöründe çalışır. Ortam değişkenlerinin tam listesi `Platform/.env.example`'da.

## Tek tıkla (Docker Desktop yeterli)

| Dosya | Ne yapar |
|---|---|
| `BASLAT.bat` | Derler, başlatır, sağlık denetler, `http://localhost:8088`'i açar. İlk kurulumda `.env` oluşturur (`ACCOUNT_CODE_PEPPER`, `FILE_TOKEN_SECRET` rastgele; `ENABLE_DATA_RESET=true`), demo hesapları ve örnek fatura/itirazları yükler. |
| `DURDUR.bat` | Durdurur; veri korunur. |
| `POSTA.bat` | Yerel postaları açar ("Posta"). |
| `SIFIRLA.bat` | Yalnız bu sistemin hacimlerini siler; `EVET` yazmadan silmez. **Gerçek veri varken önce `YEDEKLE.bat`.** |
| `YEDEKLE.bat` | Yedek alır: veritabanı, DeciShip dosyaları, `.env` ve `keys\` → `Platform\yedekler\<tarih-saat>\` (git dışı); ayarlıysa şifreli dış kopya. Sistem kapalıysa yalnız veritabanını açıp kapatır. Aşağıda "Yedek ve geri yükleme". |

- Hepsi `scripts\demo.ps1`'i çağırır: `-Stop`, `-Reset`, `-Seed` (demo hesapları yeniden: `powershell -File scripts\demo.ps1 -Seed`), `-Yes`, `-NoBrowser`. Demoyu güncellemek: `scripts\demo.ps1 -Yes -NoBrowser`.
- `git pull` yapmaz. İlk derleme 10–15 dk.
- Tohum (`node dist/seed.js`) son satıra `SEED-OK people=8 memberships=9` yazmalı ve `sahip@demo.sellerondata.com` girişi 200 dönmeli; olmazsa sarı uyarı ve "Demo hesapları YÜKLENMEDİ". `SEED-OK` yoksa imaj eski: `BASLAT.bat` ile yeniden derleyin.

### Yedek ve geri yükleme

Gerçek veri yalnız Docker hacimlerinde (`sod_pgdata`, `sod_deciship_storage`); Docker sıfırlanırsa, `SIFIRLA.bat` çalışırsa ya da disk giderse gider. Sunucudaki yedek ayrı iş (KALANLAR 3.3).

**Ne alınır** (`scripts\yedekle.ps1`, `YEDEKLE.bat`): `veritabani.dump` (yalnız `sellerondata` veritabanı; test veritabanları alınmaz), `roller.sql` (parolasız, başvuru için), `dosyalar.tar.gz`, `sirlar\.env`, `sirlar\keys\` (klasör yalnız şimdiki kullanıcıya açık), künye `yedek.json` (SHA-256, tablo tablo satır sayısı, dosya sayısı, commit, son migration).

Döküm baştan sona açılıp sayılır, kopya SHA-256 ile denetlenir, arşiv Windows'ta açılabiliyor mu bakılır; tutmazsa yedek silinir, çıkış 1. Günlük `yedekler\gunluk\yedek-<ay>.log`, son sonuç `yedekler\son-yedek.json`.

**Çıkış ve uyarı:** 0 tamam; 1 yedek alınamadı; 2 yerel yedek tamam ama sorun var (dış kopya alınamadı, parola yok, saklama ayarı geçersiz, ani düşüş). 1 ya da 2'de masaüstüne `SellerOnData-YEDEK-SORUNU.txt` yazılır ve Windows bildirimi denenir; sonraki başarılı yedek dosyayı siler. `BASLAT.bat` her açılışta `durum`a bakar, sorunu kırmızı yazar.

**Saklama:** son 14 yedek + son 14 gün + son 12 ayın her birinin son yedeği; ötekiler silinir (yerelde ve dış hedefte). En yeni yedek hep kalır; `SOD_BACKUP_KEEP_*` 1'den küçükse saklama uygulanmaz, çıkış 2. Satır ya da dosya sayısı önceki yedeğin yarısının altına düşerse (ani düşüş) o çalıştırmada hiçbir eski yedek silinmez, çıkış 2. `-Dir <klasör>` ile alınan yedeğe saklama uygulanmaz.

**Bilgisayar dışı kopya:** `.env` içinde `SOD_BACKUP_OFFSITE_DIR` (bulut klasörü ya da harici disk, ör. `D:\SellerOnData-yedek`); boşsa yalnız yerel yedek ve uyarı. Kopya `sellerondata-yedek-<tarih-saat>.sodyedek`: AES-256 ile şifreli, HMAC-SHA256 ile mühürlü, parola PBKDF2 (600.000 tur). Ek program gerekmez (Windows PowerShell).

Yazılan kopya baştan sona yeniden okunup doğrulanır; dış hedefe ulaşılamazsa yerel yedek kalır, çıkış 2. Bulut klasöründe bu okuma yerel önbellektendir; buluta gerçekten yüklendiğini bulut uygulaması gösterir (ayda bir başka bilgisayardan açıp bakın).

Parola `SOD_BACKUP_PASSWORD`. Boşsa ve dış hedef ayarlıysa, **elle** çalıştırmada (`YEDEKLE.bat`) üretilir, ekrana yazılır ve "EVET" onayından sonra `.env`'e kaydedilir; gece görevi parolayı görünmeden üretmez (çıkış 2, "bir kez elle çalıştırın"). **Parolayı parola yöneticisine kaydedin** (`YEDEKLE.bat -ParolaGoster`): bilgisayar kaybolursa kopya yalnız onunla açılır. Parola değişirse eski kopyalar eski parolayla açılır.

**Her gece:** `powershell -File scripts\yedek-zamanla.ps1 kaydet` (varsayılan 03:00, `-Saat 02:30`, uykudan uyandırmak için `-Uyandir`), `durum`, `kaldir`. Yönetici hakkı istemez; oturum açıkken çalışır, o saatte bilgisayar kapalıysa ilk açılışta. 10 saat sonra ikinci tetikleme var: ilk yedek başarılıysa bir şey yapmaz (son 20 saat), değilse aynı gün yeniden dener.

Görev, Docker Desktop'ın kendi kaplarını açmasını 90 sn bekler; sistem kapalıysa yalnız veritabanını açar ve sonra, sistemin başka kabı çalışmıyorsa, yine kapatır. `durum` 36 saatten eski yerel ya da dış kopyada, parola yokken ya da son hata varsa 1 döner. Yedek ve geri yükleme aynı kilidi tutar, aynı anda çalışmaz.

**Geri yükleme provası** (`scripts\geri-yukle.ps1`; canlıya dokunmaz). Ayrı yığın `sellerondata-prova`, hacimler `sod_prova_pgdata` ve `sod_prova_storage`, Postgres `localhost:15444`; posta ve yapay zekâ kapalı. Her tablonun satır sayısı ve dosya sayısı yedekle karşılaştırılır; `-Tam`'da ayrıca kaydı olup diskte olmayan dosya (MISSING) sıfır olmalı.

```powershell
powershell -File scripts\geri-yukle.ps1                                # en yeni yerel yedek: veritabanı + dosyalar
powershell -File scripts\geri-yukle.ps1 -Yedek yedekler\2026-11-16_0300 -Tam   # uygulamayı da aç: http://localhost:18098
powershell -File scripts\geri-yukle.ps1 -Yedek D:\SellerOnData-yedek\sellerondata-yedek-2026-11-16_0300.sodyedek   # dış kopyadan
powershell -File scripts\geri-yukle.ps1 -ProvaKaldir                    # provayı, hacimlerini ve çözülmüş kopyaları sil
```

- Ayda bir ve her büyük değişiklikten önce prova; ayda bir kez dış kopyadan. "PROVA GEÇTİ" yazmalı.
- Şifreli kopyadan geri yüklemede çözülen klasör iş bitince silinir. `-YalnizAc -Yedek <dosya.sodyedek> [-Hedef <klasör>]` yalnız çözüp açar (yeni bilgisayarda ilk adım; parola sorulur); açılan klasörü işiniz bitince silin.

**Canlıya geri yükleme** mevcut veriyi yedekteki hâliyle değiştirir: `powershell -File scripts\geri-yukle.ps1 -Canli -Yedek <klasör|dosya>` (`-Yedek` zorunlu). `EVET` yazdırır; veritabanı hacmi duruyorsa (kap silinmiş olsa bile) önce veritabanını açıp şimdiki hâlin güvenlik yedeğini `yedekler\guvenlik-<tarih-saat>\` içine alır (saklama bu klasörlere dokunmaz; işiniz bitince elle silin).

Sonra uygulamaları durdurur, veritabanını tek işlemde kurar (hata olursa eski hâl kalır), rol parolalarını `.env` ile eşitler, dosyaları geçici klasöre açıp sayı tutunca yerine koyar, sistemi açar. `.env` ve `keys\` yalnız eksikse yedekten konur. Aynı sürümle geri yükleyin (yedek.json `commit`); sonra "Kaydı olmayan disk dosyaları" denetimi.

Yeni bilgisayarda: depoyu kurun, yedeğin `sirlar\.env`'ini `Platform\.env` olarak, `sirlar\keys\`'i `Platform\keys\` olarak koyun, `BASLAT.bat` (demo yüklenir), sonra `-Canli`.

Gerçek veriyle yerelde ayarlar: aşağıda "Gerçek kullanıma geçiş".

## Gerçek kullanıma geçiş

Bu bilgisayarda gerçek faturalarla çalışmadan önce bir kez. Yalnız yerel kurulum içindir (`APP_BASE_URL` `localhost`); sunucu için "Üretim açılışı".

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gercek-kullanim.ps1 -KuruCalisma             # hiçbir şey değiştirmez: plan ve şimdiki durum
powershell -ExecutionPolicy Bypass -File scripts\gercek-kullanim.ps1 -SahipEposta <e-posta>    # geçiş, sonunda sahibin kayıt daveti
```

Sırayla, `EVET` yazdırarak:

1. Yedek (`scripts\yedekle.ps1`). Alınamazsa hiçbir şey değişmez; çıkış 2'de (yerel yedek tamam, dış kopya, parola, saklama ya da ani düşüş sorunu) nedeni yazılır, geçiş sürer.
2. `.env` güncellenir; eski hâli `yedekler\gercek-kullanim\env-<tarih>.env`. Ayarlar aşağıda.
3. Veritabanında demo hesap ya da demo firma varsa veritabanı ve DeciShip dosyaları silinip boş kurulur (`SIFIRLA.bat` ile aynı silme), demo tohumu yüklenmez. Seçerek silen bir yol yok: canlıda demo hesap görülürse Hesap servisi de "veritabanını sıfırdan kurun" der. Demo dışı firmalar ekrana listelenir, onlar da silinir (yedekte kalır); `-Evet` ile çalışırken bunun için ayrıca `-DemoDisiniDeSil` gerekir. `keys\` ve `.env` kalır, herkes oturumdan düşer.
4. `docker compose up -d --build`. Site kayıt kipiyle yeniden derlenir.
5. Son denetim: ayarlar kaplarda etkin mi, gateway ve site yalnız `127.0.0.1`'de mi, bilgisayarın ağ adresinden port kapalı mı, veritabanında demo kaldı mı, `sahip@demo.sellerondata.com` girişi reddediliyor mu. Geçmeyen varsa çıkış 1.
6. Veri silindiyse yeni taban yedeği (`yedekle.ps1 -YeniTaban`, ani düşüş denetimi yok): ilk gece yedeği geçiş öncesine göre "ani düşüş" demez.
7. `-SahipEposta` verildiyse tek kullanımlık kayıt daveti (`/register?invite=…`); sonra sahibin adımları ekrana yazılır. Firma kaydını sahip kendisi yapar.

Yeniden çalıştırmak güvenlidir: yapılmış adım atlanır. Seçenekler: `-Evet` (soru sorma), `-DemoDisiniDeSil`, `-Bekle`.

| Ayar | Değer | Neden |
|---|---|---|
| `ENABLE_DATA_RESET` | `false` | "Örnek verileri yükle" firmanın verisini siler |
| `DEMO_TOUR` | `off` | Örnek veriyle deneme turu yok |
| `SIGNUP_MODE` | `invite` | Yeni firma yalnız davetle; ekip daveti etkilenmez. Sonradan davet: `-SahipEposta` ya da `docker compose -p sellerondata exec account-api node dist/signup-invite.js --email <adres> --operator <ad>` |
| `GATEWAY_PORT`, `SITE_PORT` | `127.0.0.1:<port>` | Yerel ağdaki başka cihaz göremez. Telefon USB ile (`adb reverse`), `Deciship/TELEFON-KURULUM.md` |
| `AI_DAILY_BUDGET_TRY` | en çok `200` | Bütün firmalar, günde ≈ 2 USD (≈ 25 PDF sayfası). Daha düşük değer (ör. `0`) korunur |
| `AI_FREE_CREDIT_MONTHLY_TRY` | en çok `1500` | Firma başına aylık hak. Daha düşük değer korunur |
| `SOD_EMAIL_VERIFICATION`, `AI_QUOTA_ENFORCED` | kapatılmışsa `true` | Satır yoksa compose varsayılanı (açık) geçer |
| `SOD_GERCEK_KULLANIM` | geçiş tarihi | Bu kurulumda gerçek veri var işareti |

Sonrası:

- `BASLAT.bat` / `DURDUR.bat` güvenli: `SOD_GERCEK_KULLANIM` doluyken boş veritabanına bile demo yüklenmez. `SIFIRLA.bat`, `scripts\demo.ps1 -Seed` ve `scripts\dev.ps1 -Seed` açık iletiyle durur. Bilerek sıfırlamak: önce `YEDEKLE.bat`, sonra `.env`'den `SOD_GERCEK_KULLANIM` satırını silin.
- Testler gerçek verinin Postgres'ine (`SOD_POSTGRES_PORT`, 5434) bağlanmaz (`scripts/lib/pg-guard.mjs`): kök koşucular 5434'ü yoklamaz, paket testleri varsayılan olarak 5435'i kullanır, 5434'e işaret eden `TEST_DB_HOST` reddedilir. Veritabanı testlerinden önce `npm run pg:baslat`.
- Her gece yedek: `scripts\yedek-zamanla.ps1 kaydet`, dış kopya için `SOD_BACKUP_OFFSITE_DIR` ("Yedek ve geri yükleme").
- Bilinçli kabul (yalnız `127.0.0.1`'e açık olduğu için): geliştirme kipi ve düz HTTP, geliştirme veritabanı parolaları. Posta SMTP'siz: doğrulama ve itiraz hatırlatmaları `POSTA.bat`'a düşer.
- Geri dönüş: eski `.env`'i geri koyun; veri için `scripts\geri-yukle.ps1 -Canli -Yedek <geçiş öncesi yedek>`.

## Portlar

| Port | Servis |
|---|---|
| 8088 | Uygulama (gateway): Merkez, `/deciship/`, `/api/*` |
| 8089 | Tanıtım sitesi |
| 5434 | Postgres (127.0.0.1; `SOD_POSTGRES_PORT`) |
| 4100 | account-api (127.0.0.1; `ACCOUNT_API_PORT`) |
| 8001 | Görüntü servisi (127.0.0.1; `VISION_PORT`) |

DeciShip API ve web arayüzleri port açmaz; `*/internal/*` dışarıdan hep 404. Üretimde yalnız Caddy açık (80, 443); 8088, 8089, 5434, 4100, 8001 kapalı. Android emülatöründen `http://10.0.2.2:8088`.

## Demo hesaplar

Şifre `Demo12345!`, firma Demo Lojistik; e-postalar doğrulanmış. Tohum ve `demo.ps1` yalnız yerel adreste çalışır (`APP_BASE_URL` `localhost`, `127.0.0.1`, `[::1]`); üretimde veritabanında demo hesap varsa Hesap açılmaz.

| E-posta | Rol |
|---|---|
| `sahip@demo.sellerondata.com` | Firma sahibi, DeciShip Yönetici |
| `yonetici@demo.sellerondata.com` | Firma yöneticisi, DeciShip Yönetici |
| `denetleyici@demo.sellerondata.com` | Çalışan, DeciShip Denetleyici |
| `muhasebe@demo.sellerondata.com` | Çalışan, DeciShip Muhasebe |
| `+905550000005` (telefon) | Çalışan, DeciShip Ölçüm (yalnız mobil) |
| `erisimyok@demo.sellerondata.com` | Hiçbir araca erişimi yok |
| `cokfirma@demo.sellerondata.com` | İki firmada üye, DeciShip Muhasebe |

Tam liste `apps/account-api/src/seed.ts`.

- **Örnek veri** (`Deciship/apps/api/src/seedDemoDisputes.ts`): 6 taşıyıcı, tarifeler, ölçümler, `Deciship/samples/invoices`'tan 7 fatura (tarihler bugüne göre) ve her durumda itiraz. Firmada fatura varsa bir şey yapmaz; yüklenemezse sarı uyarı. `SOD_DEMO_DATA=0` kapatır (e2e yığını böyle). İkinci Firma boş başlar.
- **Panelden:** DeciShip › Ayarlar › Veri yönetimi › **Örnek verileri yükle** firmanın taşıyıcı, tarife, ölçüm ve faturalarını kalıcı siler, 6 taşıyıcı, tarife ve 57 ölçüm getirir. Fatura için `Deciship/samples/invoices/fedex-9-482-11735.csv` (18 satır: 13 uyumlu, 4 fark, 1 eşleşmedi; fazla ödeme 611,20 ₺, ayrıca 1.120,00 ₺ "İncele": aynı dosyada tekrarlanan mükerrer). Yalnız `ENABLE_DATA_RESET=true` iken.

### Android uygulamasını dağıtma

Mağazada değil, iOS yok; yönetici APK'yı iletir. Merkez › Ekip "Uygulamayı paylaş" bağlantıyı `VITE_ANDROID_APK_URL`'den okur (boşsa düğme yok). Derlemede gömülür: değişince `docker compose up -d --build hub-web`. Dağıtım yolu belirlenmedi.

## Ortam değişkenleri

Parantezde varsayılan. "Zorunlu" = üretimde eksikse `docker-compose.prod.yml` durur ya da servis açılmaz. `.env.example` sonundaki "compose GEÇİRMEZ" bölümündekiler `.env`'de etkisiz. DeciShip sınırlarının davranışı `Deciship/SPEC.md` §5.12 (yapay zekâ, dosya, hız), §5.13 (iş kuyruğu, dosya alanı, silme), §5.14 (deneme turu, hatırlatma).

**Adres, köken, çerez**
- `APP_BASE_URL`: dış adres (posta bağlantıları); geliştirmede yerel ya da özel ağ (`localhost`, `127.x`, `10.x`, `172.16–31.x`, `192.168.x`), üretimde `https://`.
- `ALLOWED_ORIGINS`: çerezli yazmada kabul edilen Origin'ler; zorunlu, `APP_BASE_URL` kökenini içerir.
- `SITE_ORIGINS` (`http://localhost:8089,http://localhost:5190`): site kökenleri; zorunlu, https, `ALLOWED_ORIGINS` ile çakışmaz. `SITE_BASE_URL`: site adresi (kanonik, sitemap; derlemede).
- `COOKIE_SECURE` (boş: üretimde Secure), `COOKIE_LANG_DOMAIN` (ör. `.sellerondata.com`), `TRUST_PROXY_HOPS` (compose 1; değiştirmeyin).
- `GATEWAY_PORT` (8088), `SITE_PORT` (8089), `GATEWAY_REAL_IP_FROM` (önündeki vekilin adresi; üretimde Caddy'ninkine sabit, `.env`'deki etkisiz).
- Üretim (Caddy): `APP_HOST`, `SITE_HOST`, `ACME_EMAIL` (zorunlu), `SOD_EDGE_SUBNET` (`172.31.250.0/24`), `SOD_CADDY_IP` (`172.31.250.10`), `CADDY_MEM` (`256m`); yalnız yerel deneme `CADDY_HTTP_PORT` (80), `CADDY_HTTPS_PORT` (443). "Üretim açılışı" adım 3.

**Gizli değerler**
- `ACCOUNT_SIGNING_KEY`: imza JWK'sı; geliştirmede boşsa `keys/` altına üretilir; zorunlu. Döndürme `ACCOUNT_PREVIOUS_PUBLIC_KEYS` (ARCHITECTURE.md §6 "Anahtar döndürme").
- `ACCOUNT_CODE_PEPPER` (+ `ACCOUNT_CODE_PEPPER_PREVIOUS`), `FILE_TOKEN_SECRET`: `BASLAT.bat` üretir; zorunlu, ≥ 32 karakter.
- `SOD_POSTGRES_PASSWORD`, `SOD_PLATFORM_ADMIN_DB_PASSWORD`, `SOD_DECISHIP_ADMIN_DB_PASSWORD`, `SOD_PLATFORM_DB_PASSWORD`, `SOD_DECISHIP_DB_PASSWORD`. Compose dışında `DATABASE_URL`, `MIGRATE_DATABASE_URL`.
- `PRODUCT_NOTIFY_SECRET`: araç bildirimi anahtarı; compose Hesap'a `PRODUCT_NOTIFY_SECRETS=deciship=<anahtar>`, DeciShip'e aynen verir. Boşsa yerel anahtar. 32–512 yazdırılabilir ASCII; **zorunlu**, geliştirme ya da kısa anahtar reddedilir. Üret: `openssl rand -base64 48`.
- `PRODUCT_NOTIFY_SECRETS` (Hesap, compose dışında; `Platform/scripts/dev.ps1` yazar): `urun=anahtar`; bilinmeyen/tekrar ürün, boş ya da ortak anahtar servisi açmaz; boşsa uç 401.
- `ACCOUNT_NOTIFY_URL` (DeciShip; compose `http://account-api:4100/api/account/internal/notify`): **boşsa itiraz hatırlatması kapalı.**

**Hesap servisi**
- `SMTP_URL` (`smtp://kullanici:parola@sunucu:587`, özel karakterler URL kodlu; **zorunlu**), `MAIL_FROM` (`SellerOnData <no-reply@sellerondata.com>`).
- `SOD_EMAIL_VERIFICATION` (`true`; compose `EMAIL_VERIFICATION_REQUIRED`'a geçirir, üretimde sabit `true`). `SOD_DEV_MAILBOX` (`true`; postalar veritabanına, üretimde kapalı).
- `REGISTRATION_ENABLED` (`true`). `SIGNUP_MODE` (yerelde `open`, üretimde `invite`: yeni firma yalnız `signup:invite` ile; site aynı değerle derlenir; başka değer servisi durdurur).
- `SESSION_MAX_AGE_DAYS` (90, 1–3650): oturum ömrü. `ORG_PURGE_DAYS` (30, 1–3650): kapatılan firmanın geri açılabilir süresi.
- `MIN_MOBILE_VERSION` (`x.y.z`; boş: denetim yok; altındaki uygulama 426 alır; bozuk biçim üretimde servisi açmaz), `MOBILE_LATEST_VERSION`, `MOBILE_UPDATE_URL` (`GET /api/account/client-policy`). ARCHITECTURE.md §11 "Mobil sürüm uyumu".
- `PRODUCT_EVENT_TARGETS` (compose `deciship=http://deciship-api:4000/api/deciship/internal/events`): olay adresleri, `urun=adres`. Bilinmeyen ürün, tekrar ya da boş adres her ortamda servisi açmaz. Kapalı (`off`) olmayan her ürünün adresi üretimde zorunlu (yoksa servis açılmaz); geliştirmede eksikse açılışta uyarı yazılır, olaylar bekler. Yeni araç `pilot`/`public` olmadan önce adresi buraya eklenir.
- `PRODUCT_LAUNCH`: `urun=durum` (`off` kapalı, `pilot` yalnız aboneliği olan, `public` herkes), ör. `orderloom=pilot,tagpress=off`; boşsa kayıt geçerli. `off` acil kapatma. Bilinmeyen ürün/durum ya da tekrar servisi açmaz. Sonra `docker compose -p sellerondata up -d account-api`.

**DeciShip: yapay zekâ**
- `ANTHROPIC_API_KEY`: PDF fatura ve tartı fotoğrafı; boşsa yalnız bu ikisi kapalı. `CLAUDE_MODEL` (`claude-sonnet-5-5`; `AI_PRICE_TABLE`'da olmayan model en pahalı fiyattan sayılır, önce tabloya ekleyin).
- `AI_DAILY_BUDGET_TRY` (boş = 1000 TL/gün, tüm firmalar): `off` tavansız, `0` acil durdurma; geçersiz değer ya da eksik göç `20261123090000` API'yi açmaz.
- `AI_FAILED_BUDGET_RATIO` (1): sonuç vermeyen çağrıların aylık tavanı (hakka oran). `AI_QUOTA_ENFORCED` (açık), `AI_FREE_CREDIT_MONTHLY_TRY` (2500), `AI_PRICE_TRY_PER_USD` (100), `AI_CACHE_TTL_DAYS` (30), `AI_CONCURRENCY_PER_ORG` (2), `AI_RATE_*_PER_MIN` (kişi/dk: tartı 30, PDF 6, diğer 10), `PDF_INVOICE_PAGES_PER_CALL` (5).

**DeciShip: dosya ve rapor**
- `FILE_WORKER_MODE` (çocuk süreç; `inline`), `FILE_WORKERS` (2), `FILE_WORKER_HEAP_MB` (512), `FILE_WORKER_TIMEOUT_MS` (60000), `FILE_QUEUE_MAX` (16), `FILE_QUEUE_WAIT_MS` (60000; 503 `FILE_BUSY`), `FILE_MAX_ROWS` (200000), `XLSX_MAX_UNCOMPRESSED_MB` (200), `PDF_MAX_PAGES` (300), `PDF_MAX_UNCOMPRESSED_MB` (300; 413 `FILE_TOO_LARGE`).
- `FILE_WORKER_RSS_LIMIT_MB` (1200; 1,3 katı mutlak; 422 `FILE_TOO_COMPLEX`): varsayılanlarla ≈ 1,7 GB, 2 GB kabın altında; kap dolarsa önce dosya çocuğu ölür (`oom_score_adj` 1000).
- `REPORT_WORKER_HEAP_MB` (1024), `REPORT_WORKER_TIMEOUT_MS` (180000; 422 `REPORT_TOO_LARGE`), `REPORT_PDF_MAX_ROWS` (1000; tümü Excel'de).
- `INVOICE_TABLE_CACHE_MB` (150; `0` kapalı), `INVOICE_TABLE_CACHE_TTL_MS` (900000). `STORAGE_QUOTA_GB_PER_ORG` (10; `0` kapalı; yalnız fatura dosyası ve tarife PDF'i yüklemesi durur, 413 `STORAGE_QUOTA_EXCEEDED`; ölçüm durmaz).

**DeciShip: hız, eşzamanlılık, veritabanı**
- `API_RATE_LIMIT` (açık; `off`), `RATE_UPLOAD_PER_MIN_MEMBER` (60), `RATE_UPLOAD_PER_MIN_ORG` (300), `RATE_WRITE_PER_MIN_MEMBER` (300), `IMPORT_CONCURRENCY` (3), `HEAVY_QUEUE_WAIT_MS` (30000; `0` beklemez).
- `RATE_VISION_PER_MIN_MEMBER` (60), `RATE_VISION_PER_MIN_ORG` (240): canlı tartı ve işaret; 429 `TOO_MANY_REQUESTS`, ölçüm elle sürer.
- `HUB_DB_SLOTS` (8), `HUB_CONCURRENCY_PER_ORG` (6), `DB_POOL_MAX` (20), `DB_CONNECT_TIMEOUT_MS` (10000), `DB_STATEMENT_TIMEOUT_MS` (60000).

**DeciShip: arka plan ve bakım** (ARCHITECTURE.md §11 "Arka plan işleri ve ölçek")
- `JOB_RUNNER` (`on`; `off` HTTP kabı yalnız kuyruğa yazar, iş ve bakım çalıştırmaz: ayrı iş çalıştırıcı kabı `node dist/worker.js` için, örnek parça ARCHITECTURE.md §11; `inline` yalnız test, üretimde servis açılmaz). Worker kabında `JOB_RUNNER` yok sayılır; `WORKER_HEALTH_FILE` (`/tmp/deciship-worker.alive`) sağlık dosyası. `JOB_SLOTS_AI` (2), `JOB_SLOTS_RECALC` (1), `MEASURE_RECOMPARE_SLOTS` (2), `JOB_POLL_MS` (2000), `JOB_LEASE_MS` (60000), `JOB_MAX_ATTEMPTS` (5), `JOB_SHUTDOWN_GRACE_MS` (30000).
- **Kapanış:** `deciship-api` `stop_grace_period` 45 sn (iki compose dosyasında); `JOB_SHUTDOWN_GRACE_MS`'ten en az 15 sn uzun kalmalı, yoksa kap iş bırakılmadan ölür. Diğerleri "Kaplar ve gateway".
- `DELETED_INVOICE_PURGE_DAYS`, `DELETED_MEASUREMENT_PHOTO_PURGE_DAYS` (**kapalı**; `off`, `0` da; 7'den küçük 7; başka değer API'yi açmaz): "Silinenlerin kalıcı silinmesi".
- `ENABLE_DATA_RESET` (`false`; üretimde `true` servisi açmaz), `DEMO_TOUR` (`on`; `off` deneme turu 404), `SOD_DEMO_DATA` (açık). Compose dışında `ACCOUNT_JWKS_URL`, `VISION_URL`.

**Kaplar ve gateway**
- `GATEWAY_API_RATE` (`30r/s`), `GATEWAY_API_BURST` (200), `GATEWAY_UPLOAD_RATE` (`600r/m`; her multipart, depodaki telefonların ortak IP'sine göre), `GATEWAY_UPLOAD_BURST` (300), `GATEWAY_AUTH_RATE` (`30r/m`; giriş, kayıt, şifre sıfırlama, kod doğrulama, davet), `GATEWAY_AUTH_BURST` (30), `GATEWAY_CONN_PER_IP` (100): IP başına, 429. Hangi uç hangi kovada: ARCHITECTURE §11 "Gateway hız sınırı".
- Yükleme kovası DeciShip'in `RATE_UPLOAD_PER_MIN_ORG` + `RATE_VISION_PER_MIN_ORG` toplamından düşük olmamalı (asıl sınır API'de kişi ve firma başına). Metin yanıtlar gzip'li, Hesap API'si hariç (§11 "Sıkıştırma").
- `POSTGRES_MEM` (`2g`), `DECISHIP_API_MEM` (`2g`), `ACCOUNT_API_MEM` (`512m`), `VISION_MEM` (`1g`), `WEB_MEM` (`128m`). Yan yana sistem: "Uçtan uca testler".
- **Günlükler:** her kap `json-file`, dönüşümlü: `SOD_LOG_MAX_SIZE` (`20m`) × `SOD_LOG_MAX_FILE` (5), eskiler sıkıştırılır; kap başına en çok ~100 MB. `docker compose logs` aynen çalışır. Değişince kaplar yeniden oluşturulur (`up -d`).
- **Kapanış süreleri** (`stop_grace_period`; Docker varsayılanı 10 sn, sonra öldürür): Postgres 60 sn (`SIGINT`, hızlı kapanış: bağlantıları keser, son denetim noktasını yazar; öldürülürse sonraki açılışta kurtarma koşar), `deciship-api` 45 sn, `account-api` 20 sn, gateway, Caddy (üretim) ve görüntü servisi 15 sn, web kapları 10 sn. Compose bağımlıyı önce durdurur: API'ler Postgres'ten önce kapanır.
- **Sağlık denetimi:** açılışta 2 sn'de bir (`start_interval`; ilk başarıda "sağlıklı", bağımlılar hemen açılır), sonra Postgres 10 sn, API'ler ve gateway 15 sn, web kapları ve Caddy 30 sn; 3 ardışık hata "sağlıksız". `start_interval` Docker Engine 25+ ister. API sağlık uçları yalnız sürecin ayakta olduğunu söyler (veritabanına bakmaz); veritabanı Postgres kabının kendi denetiminde.

## Üretim açılışı

`BASLAT.bat` geliştirme içindir; üretimde demo ve tohum yok. Bash ile:

```bash
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
```

Prod dosyası bütün iç portları `!reset` ile kapatır (`docker compose version` v5.1.4 ile sınandı); dışa yalnız Caddy açılır (TCP 80, 443). `$DC config --format json | jq -r '.services | to_entries[] | select(.value.ports) | .key'` yalnız `caddy` yazmalı.

**0. Sunucu ve DNS.** Güvenlik duvarı yalnız 22, 80 ve 443 (TCP); SSH yalnız anahtarla; otomatik güvenlik güncellemesi açık. Docker yayınladığı portta güvenlik duvarını (UFW) atlar: dışa açık port yalnız compose'un açtığıdır, bu yüzden geliştirme `.env`'i (`GATEWAY_PORT`, `SITE_PORT`) sunucuya taşınmaz. DNS'te `APP_HOST`, `SITE_HOST` ve `www.<SITE_HOST>` için sunucunun IPv4 adresine A kaydı; AAAA (IPv6) kaydı yazılmaz (Caddy yalnız IPv4'te dinler, adım 3).

**1. Gizli değerler** (`.env`'e, commit edilmez):

```bash
openssl rand -hex 32   # her biri için ayrı: 5 veritabanı parolası, ACCOUNT_CODE_PEPPER, FILE_TOKEN_SECRET
npm --prefix apps/account-api ci && npm --prefix apps/account-api run keys:generate   # ACCOUNT_SIGNING_KEY
```

Parolalarda onaltılık kullanın (`@`, `/`, `:` bağlantı adresini bozar). İmza anahtarı tek tırnakta: `ACCOUNT_SIGNING_KEY='{"crv":...}'`.

**2. `.env`** (eksik olan compose'u adıyla durdurur): beş `SOD_*_PASSWORD` (`*_dev` reddedilir; ilk açılışta veritabanına yazılır, sonra `.env`'den değiştirmek yetmez), `APP_BASE_URL` (`https://`), `ALLOWED_ORIGINS`, `SITE_ORIGINS` (ör. `https://sellerondata.com,https://www.sellerondata.com`), `SITE_BASE_URL`, `ACCOUNT_SIGNING_KEY` (değişirse oturumlar düşer; döndürme `apps/account-api/scripts/keys.ts` başında), `ACCOUNT_CODE_PEPPER`, `FILE_TOKEN_SECRET`, `PRODUCT_NOTIFY_SECRET`, `SMTP_URL`.
- TLS (Caddy): `APP_HOST` (ör. `app.sellerondata.com`; `APP_BASE_URL=https://<APP_HOST>`), `SITE_HOST` (ör. `sellerondata.com`; `SITE_BASE_URL=https://<SITE_HOST>`), `ACME_EMAIL` (Let's Encrypt hesabının e-postası; süre dolumu postası gelmez, yenilenmeyen sertifikayı "Ayakta mı denetimi"nin https yoklaması yakalar).
- İsteğe bağlı: `MAIL_FROM`, `ANTHROPIC_API_KEY`, `AI_DAILY_BUDGET_TRY`, `COOKIE_LANG_DOMAIN`, `VITE_ANDROID_APK_URL`, `REGISTRATION_ENABLED`, `SIGNUP_MODE` (herkese açmak `open`), `SESSION_MAX_AGE_DAYS`.
- Servisi açmayanlar: `ENABLE_DATA_RESET=true`, `COOKIE_SECURE=false`, veritabanında demo hesap, hazır ürünün olay adresi eksik.

**3. TLS sonlandırıcı (Caddy, `caddy/Caddyfile`).** Üretim katmanında hazır; elle vekil kurulmaz. Kural ve gerekçe: ARCHITECTURE §11 "TLS ve vekil".
- İlk açılışta sertifikayı Let's Encrypt'ten alır (80 ve 443 dışarıdan ulaşılır, DNS kaydı sunucuyu göstermeli), süresi dolmadan kendisi yeniler. Sertifika ve ACME hesabı `sod_caddy_data` hacminde: silinirse yeniden alınır (Let's Encrypt aynı ad kümesine haftada 5 sertifika verir).
- http → https (308), `www.<SITE_HOST>` → `https://<SITE_HOST>` (301). Başka ada gelen istek hiçbir servise aktarılmaz; sunucunun IP adresiyle https açılmaz (sertifika yok).
- Gateway ve site yalnız Caddy'nin iç ağında (`edge`, `SOD_EDGE_SUBNET`); Caddy'nin adresi sabit (`SOD_CADDY_IP`). Üretim katmanı `GATEWAY_REAL_IP_FROM`'u bu adrese, `TRUST_PROXY_HOPS`'u 1'e bağlar; `.env`'deki değerleri etkisizdir. Ağ sunucudaki başka bir Docker ağıyla çakışırsa compose açılmaz: iki değer birlikte değiştirilir.
- Caddyfile değişince: `$DC exec caddy caddy reload --config /etc/caddy/Caddyfile` (kesintisiz). Caddy günlüğü yalnız hatalar ve sertifika işleri (istek adresi ve başlıkları silinmiş); istek günlüğü gateway'de.
- Sertifika yetkilisi Caddyfile'da seçilmez: Caddy'nin varsayılanı Let's Encrypt, olmazsa ZeroSSL.
- Yerel deneme (gerçek sertifikasız): `APP_HOST=app.localhost`, `SITE_HOST=localhost`; bu adlara Caddy kendi yetkilisinden sertifika verir, dışarıya istek gitmez (`curl -k`).
  Canlı yığınla aynı makinede ayrı bir ortam dosyası ve proje adı (`-p`), kendi hacim adları (`SOD_PGDATA_VOLUME`, `SOD_STORAGE_VOLUME`, `SOD_CADDY_DATA_VOLUME`, `SOD_CADDY_CONFIG_VOLUME`), başka portlar (`CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT`, ör. 18080 ve 18443) ve başka bir iç ağ (`SOD_EDGE_SUBNET` ile `SOD_CADDY_IP` birlikte, ör. `172.31.251.0/24` ve `172.31.251.10`; aynı aralık iki projede "Pool overlaps" verir); bitince `down -v`.

**4. Açın ve doğrulayın.**

```bash
$DC config --quiet          # eksik değişken ve yazım hatası burada çıkar; --quiet olmadan parolalar ekrana yazılır
$DC up -d --build --wait    # tek seferlik servisler 0 ile çıkar
$DC ps -a
curl -sI https://<APP_HOST>/home | grep -iE 'strict-transport|content-security'   # ikisi de bir kez
curl -sI http://<APP_HOST>/home | grep -iE '^(HTTP|location)'                        # 308, https://
curl -sI https://www.<SITE_HOST>/ | grep -iE '^(HTTP|location|strict-transport)'     # 301, kök, HSTS
curl -s -o /dev/null -w '%{http_code}\n' https://<APP_HOST>/api/deciship/internal/events   # 404
$DC logs --tail 5 gateway        # satır başında sizin dış IP'niz olmalı, Caddy'nin 172.31.250.10'u değil
```

- Dışarıdan (başka ağdan) kapalı olmalı: `http://<sunucu IP>:8088`, `:8089`, `:5434`, `:4100`, `:8001`.
- Telefonda ölçüm fotoğrafı açılıyor mu: dosya bağlantısı `https://<APP_HOST>/api/deciship/files/...` olmalı (üretim APK'sı düz HTTP'yi engeller).

- Kayıt olun, "Şifremi unuttum" postası gelmeli. SMTP'ye ulaşılamazsa yanıt yine başarılı görünür (hesap varlığı gizli); posta en çok 3 kez denenir; davette Merkez "gönderilemedi" der. Günlükte `e-posta yeniden denenecek`, `e-posta gönderilemedi`.
- Veritabanı: `$DC exec postgres psql -U postgres -d sellerondata`. Sonra "Silinenlerin kalıcı silinmesi" açılışı.

### Yedek

Üç şey: veritabanı, DeciShip dosya hacmi, `.env` (imza anahtarı ve parolalar; o olmadan yedek işe yaramaz). Sistem açıkken.

```bash
HACIM=sod_deciship_storage   # SOD_STORAGE_VOLUME verdiyseniz o ad
$DC exec -T postgres pg_dump -U postgres -d sellerondata -Fc -f /tmp/yedek.dump
$DC cp postgres:/tmp/yedek.dump ./yedek.dump
$DC exec -T postgres rm /tmp/yedek.dump
docker run --rm -v "$HACIM":/data:ro -v "$PWD":/yedek alpine tar czf /yedek/dosyalar.tgz -C /data .
```

Yedek kişisel veri içerir: şifreli taşıyın. Windows PowerShell 5.1'de `>` ile yönlendirmeyin (ikili dosyayı bozar).

### Geri yükleme

Boş hacimlere, yedeğin `.env`'iyle (aynı parolalar gerekir).

```bash
$DC down -v    # DİKKAT: bu sistemin verisini siler. Yalnız yeni sunucuda veya yedek doğrulandıktan sonra.
$DC up -d --wait postgres
$DC cp ./yedek.dump postgres:/tmp/yedek.dump
$DC exec -T postgres pg_restore -U postgres -d sellerondata --clean --if-exists /tmp/yedek.dump
$DC exec -T postgres rm /tmp/yedek.dump
docker run --rm -v "$HACIM":/data -v "$PWD":/yedek alpine tar xzf /yedek/dosyalar.tgz -C /data
$DC up -d --wait
```

Dosya sahipliği (uid 1000) korunur. Aynı sürümle geri yükleyin (yeni sürümde `up` eksik migration'ları uygular). Sonra `storage:orphans`.

### Ayakta mı denetimi

`bash scripts/ayakta-mi.sh` (Linux; bash, curl, GNU coreutils). Sağlık uçları (`/healthz`, `/api/account/health`, her aracın `/api/<araç>/health`'i araç kaydından; tanıtım sitesi) 200 mü, compose kaplarında sağlıksız, yeniden başlayıp duran ya da durmuş kap var mı (göç kapları 0 ile bitmiş olmalı), disk doluluğu, son başarılı yedeğin yaşı. Her denetim bir satır (`TAMAM`, `SORUN`, `ATLANDI`), sonda özet.

- **Çıkış:** 0 sorun yok, 1 en az bir sorun, 2 ayar ya da ortam hatası (curl yok, sayı olmayan sınır). Docker'a erişilemezse kap adımı atlanır (sağlık uçları yine bakılır).
- **Ayarlar** (ortam değişkeni; hepsi betiğin başında): `SOD_CHECK_URL` (`http://127.0.0.1:8088`), `SOD_CHECK_SITE_URL` (`http://127.0.0.1:8089/`, `off`), `SOD_CHECK_EXTRA_PATHS`, `SOD_CHECK_TIMEOUT` (10 sn), `SOD_COMPOSE_PROJECT` (`sellerondata`, `off`), `SOD_DISK_PATHS` (`/`, `/var/lib/docker`, yedek klasörü), `SOD_DISK_MAX_PCT` (85), `SOD_DISK_MIN_FREE_MB` (5120; ikisinden biri aşılırsa sorun), `SOD_BACKUP_DIR` (`yedekler`), `SOD_BACKUP_MAX_AGE_HOURS` (36; 0 bakmaz), `SOD_CHECK_LOG` (satırların ekleneceği dosya).
- **Üretim sunucusunda** gateway ve site portu kapalı (dışa yalnız Caddy, "Üretim açılışı" adım 3): `SOD_CHECK_URL=https://<APP_HOST>` ve `SOD_CHECK_SITE_URL=https://<SITE_HOST>/` verilir (aşağıdaki örneklerde). Denetim böylece Caddy'yi ve sertifikayı da kapsar.
- **Yedek sözleşmesi:** başarılı yedek `SOD_BACKUP_DIR/<YYYY-AA-GG_SSDD>/yedek.json` bırakır (yarım kalan `.yaziliyor` sayılmaz); her çalıştırma `son-yedek.json` yazar, `"kod": 0` dışı sorun sayılır. Bugün `yedekle.ps1` böyle yazar; sunucu yedeği (KALANLAR 3.3) aynı iki dosyayı yazmalı, yazana dek yedek satırı `SORUN` der.
- **Zamanlama** (5 dakikada bir; kullanıcı `docker` grubunda olmalı, yoksa kap adımı atlanır). systemd önerilir: çıktı journald'a gider, o döndürür; cron'da günlük klasörünü açın (`sudo install -d -o $USER /var/log/sellerondata`) ve logrotate'e ekleyin (günde ~300 KB).

```bash
# cron (crontab -e):
*/5 * * * * cd /srv/sellerondata/Platform && SOD_CHECK_URL=https://app.sellerondata.com SOD_CHECK_SITE_URL=https://sellerondata.com/ SOD_CHECK_LOG=/var/log/sellerondata/ayakta-mi.log bash scripts/ayakta-mi.sh >/dev/null
```

```ini
# systemd: /etc/systemd/system/sod-ayakta.service
[Service]
Type=oneshot
WorkingDirectory=/srv/sellerondata/Platform
Environment=SOD_CHECK_URL=https://app.sellerondata.com SOD_CHECK_SITE_URL=https://sellerondata.com/
ExecStart=/usr/bin/bash scripts/ayakta-mi.sh
# /etc/systemd/system/sod-ayakta.timer   (systemctl enable --now sod-ayakta.timer; günlük: journalctl -u sod-ayakta)
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
```

- **Uyarı kanalı henüz yok:** bugün yalnız çıkış kodu ve günlük. Sunucuda posta ya da bildirim hesabı açılınca (Aşama 3) çıkış 1'e bağlanır: systemd'de `OnFailure=` ile posta/bildirim birimi, cron'da `|| <bildirim komutu>`. Dışarıdan yoklama (sunucu tümden düşerse bu betik de çalışmaz) ayrı: UptimeRobot benzeri hizmet `https://<adres>/healthz`'i yoklar.

## Sunucuda ilk kurulum

Temiz Linux sunucuda bir kez, `bash scripts/kurulum.sh` ile. "Üretim açılışı"ndaki elle adımların betiği; kural ve gerekçe orada. Bu bilgisayarda gerçek kullanım ayrı iş: "Gerçek kullanıma geçiş".

Önce: "Üretim açılışı" adım 0 (güvenlik duvarı, DNS), Docker Engine ve compose 2.25+ (`!reset`), kullanıcı `docker` grubunda, posta hesabı (SMTP) hazır. Depo `/srv/sellerondata`'ya klonlanır (salt okunur deploy key), kurulacak etikete geçilir (`git checkout --detach <etiket>`).

```bash
cd /srv/sellerondata/Platform
bash scripts/kurulum.sh ac -n --app-host app.sellerondata.com --site-host sellerondata.com --acme-email <adres> --smtp-url '<smtp://…>'   # hiçbir şey yazmaz
bash scripts/kurulum.sh ac --app-host app.sellerondata.com --site-host sellerondata.com --acme-email <adres> --smtp-url '<smtp://…>' --sahip-eposta <sahip>
bash scripts/kurulum.sh dogrula --sahip-eposta <sahip>    # sahip kayıt olup e-postasını doğruladıktan sonra
bash scripts/kurulum.sh kalici-silme                      # purge:preview, EVET, 30 gün
```

`ac` sırayla:

1. **`.env`** (`chmod 600`): yoksa yazılır; varsa yalnız eksikler eklenir, var olan değere dokunulmaz, verilen seçenek var olanla çelişirse durur.
   - Rastgele: beş veritabanı parolası, `ACCOUNT_CODE_PEPPER`, `FILE_TOKEN_SECRET`, `PRODUCT_NOTIFY_SECRET` (`openssl rand -hex 32`); `ACCOUNT_SIGNING_KEY` Ed25519 JWK (openssl, tek tırnakta).
   - Alan adlarından: `APP_HOST`, `SITE_HOST`, `ACME_EMAIL`, `APP_BASE_URL`, `ALLOWED_ORIGINS`, `SITE_BASE_URL`, `SITE_ORIGINS` (`www` dahil), `COOKIE_LANG_DOMAIN` (uygulama sitenin alt alanıysa `.<SITE_HOST>`). `SMTP_URL` ve `MAIL_FROM` (`SellerOnData <no-reply@<SITE_HOST>>`) tek tırnakta (parolada `$` olabilir).
   - Üretim: `SOD_ENV=production`; "Gerçek kullanıma geçiş" tablosundaki `ENABLE_DATA_RESET`, `DEMO_TOUR`, `SIGNUP_MODE`, `AI_DAILY_BUDGET_TRY` (200), `AI_FREE_CREDIT_MONTHLY_TRY` (1500) aynı değerlerle. Port satırı yok (dışa yalnız Caddy).
2. **Denetim:** `SOD_ENV` üretim değilse, parola boş, `*_dev` ya da kısa ve harf/rakam dışıysa, gizli değer 32 karakterden kısaysa, adresler https değilse, `ALLOWED_ORIGINS` uygulama kökenini içermiyorsa, `SMTP_URL` yoksa, `ENABLE_DATA_RESET=true` ya da `COOKIE_SECURE=false` ise durur (çıkış 2). `SIGNUP_MODE` davet değilse, deneme turu açıksa, `ANTHROPIC_API_KEY` boşsa (PDF ve tartı fotoğrafı kapalı) uyarır.
3. **İlk açılış:** `bash scripts/guncelle.sh --ilk-kurulum` ("Güncelleme"): veritabanı hacmi yoksa yedek atlanır; derleme, açılış, göç kapları, sağlık (`APP_BASE_URL` ve `SITE_BASE_URL` üzerinden: DNS ve 80/443 hazır olmalı, Caddy ilk sertifikayı alır), sonunda `org:announce`.
4. **Kayıt daveti** (`--sahip-eposta`; sonra `kurulum.sh davet --sahip-eposta <adres>`): `signup:invite`, 14 gün, tek kullanımlık; bağlantı yalnız ekranda, posta gitmez. Sahip bağlantıyla kayıt olur, firma o anda açılır ve sahibi odur; doğrulama postası gerçek SMTP'den gelir.

- **`dogrula`:** kişi var mı, e-postası doğrulandı mı, bir firmanın sahibi mi (veritabanından; adres psql değişkeniyle). Kayıt yoksa davet durumunu yazar; doğrulama yoksa posta günlüğünün yerini. Çıkış 0 hazır, 1 henüz değil.
- **`kalici-silme`:** `purge:preview --invoice-days 30 --photo-days 30` çıktısını gösterir, `EVET` ister (`--evet`), `.env`'in eski hâlini `yedekler/kurulum/` altına koyar, `DELETED_INVOICE_PURGE_DAYS=30`, `DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=30` yazar, DeciShip API'yi yeniden açar ve değeri kapta denetler. Kural: "Silinenlerin kalıcı silinmesi". Sahip ilk firmasını açtıktan sonra; temiz kurulumda sayılar sıfırdır.
- **Seçenekler:** `-n` (hiçbir şey yazmaz), `--mail-from`, `--dil tr|en` (davet), `--operator <ad>` (denetim izi; `kurulum`), `--evet`. Çıkış: 0 tamam, 1 adım tutmadı, 2 başlamadan durdu, 3–4 `guncelle.sh`'in.
- **Sonra:** `.env`'i parola yöneticisine kaydedin (imza anahtarı ve parolalar; kaybolursa yedek açılmaz). Her gece yedek (KALANLAR 3.3), "Ayakta mı denetimi" zamanlaması (3.4).

## Güncelleme

Sunucuda tek komut, `bash scripts/guncelle.sh <etiket|commit>` (Linux; bash, git, curl, Docker). Önce kuru çalışma:

```bash
bash scripts/guncelle.sh -n v1.3.0    # yalnız git fetch: kaç commit, veritabanı göçü var mı, yedek nereye
bash scripts/guncelle.sh v1.3.0
```

Sıra (biri tutmazsa durur):

1. Çalışma ağacı temiz mi (sunucuda kod elle değiştirilmez), `git fetch --tags`, hedef şimdikinin ilerisinde mi. Eski sürüm ya da ayrı dal: durur.
2. **Yedek** `yedekler/guncelle/<tarih-saat>/`: `veritabani.dump` (tablo tablo sayılır, kopyası SHA-256 ile denetlenir), `roller.sql`, `dosyalar.tar.gz`, `sirlar/.env`, künye `yedek.json` (`tur: guncelle-oncesi`, önceki ve hedef commit, son göçler). Son 3 güncelleme yedeği kalır (`SOD_UPDATE_BACKUP_KEEP`); gece yedeklerine dokunulmaz. Yedek alınamazsa güncelleme başlamaz. Sunucu yedeği (KALANLAR 3.3) `yedekle.sh` olarak gelince yerine o çağrılır (sözleşme `guncelle.sh`'in `yedek_al` işlevinde).
3. Hedef commit'e geçiş (ayrık HEAD), `docker compose build`, `up -d --wait --remove-orphans`.
4. Göç kapları (`*-migrate`, `*-upgrade`) 0 ile bitmiş olmalı; sağlık `bash scripts/ayakta-mi.sh` ile `APP_BASE_URL` ve `SITE_BASE_URL` üzerinden (6 deneme, 10 sn arayla; disk satırı yalnız uyarı).
5. Seçenekle duyurular: `--ilk-kurulum` sonunda `org:announce` (firmalar araçlara ad, para birimi, ülke ve saat dilimiyle); `--uyelik-duyur deciship[,…]` sonunda `members:announce` (hazır rolün varsayılan izinleri `Platform/packages/contracts/src/products.ts`'te değiştiğinde ya da araç `off`'tan açıldığında; araç kaydı değişmişse kuru çalışma hatırlatır). Tekrarı zararsız.

**Tutmazsa:** derleme bozulursa kaplara dokunulmaz, kod ve imajlar önceki sürüme döner. Açılış, göç ya da sağlık tutmazsa ve aradaki sürümlerde veritabanı göçü yoksa (`prisma/migrations`, `infra/postgres`) önceki sürüm yeniden kurulur. Göç varsa betik açıkça durur: Prisma göçü geri almaz, eski kod yeni şemayla açılmayabilir (aşağıda).

- **Çıkış:** 0 tamam; 1 güncelleme olmadı, sistem önceki sürümde açık; 2 başlamadan durdu, hiçbir şey değişmedi; 3 tutmadı ve kendiliğinden dönülemedi, elle bakın; 4 güncelleme tamam, duyuru tutmadı. Geçmiş `yedekler/guncelle/gecmis.log`; aynı anda iki güncelleme çalışmaz (kilit).
- **Seçenekler:** `-n`, `--ilk-kurulum` (hedef yoksa `HEAD`), `--uyelik-duyur <ürün>[,…]`, `--geri` (bilerek eski sürüme; yalnız göç farkı yoksa). Aynı sürüm (`HEAD`) verilirse imajlar yeniden derlenir, kaplar `.env`'e göre yeniden kurulur.
- **Ayarlar** (ortam değişkeni, betiğin başında): `SOD_COMPOSE_PROJECT` (`sellerondata`), `SOD_COMPOSE_FILES` (iki dosya), `SOD_ENV_FILE` (`.env`), `SOD_GIT_REMOTE` (`origin`), `SOD_BACKUP_DIR` (`yedekler`; ortamda yoksa `.env`), `SOD_UPDATE_BACKUP_KEEP` (3), `SOD_UPDATE_MIN_FREE_MB` (1024; önceki yedeğin 3 katından az değil), `SOD_UPDATE_WAIT_TIMEOUT` (600 sn), `SOD_UPDATE_HEALTH_TRIES` (6), `SOD_UPDATE_HEALTH_WAIT` (10 sn), `SOD_CHECK_URL`, `SOD_CHECK_SITE_URL`.
- Yerel denemede (`localhost` adları, Caddy'nin kendi sertifikası) curl sertifikaya güvenmez: Caddy'nin kök sertifikası `CURL_CA_BUNDLE` ile verilir.

### Göçlü sürüm açılmazsa

Betik `HATA: yeni sürüm açılmadı ve aradaki sürümlerde veritabanı göçü var` der, kod yeni sürümde kalır; göçün bir kısmı uygulanmış olabilir. Sırayla:

1. Günlükler: `$DC ps -a`, `$DC logs --tail 200 <servis>` (ör. `deciship-migrate`). Çoğu zaman `.env` eksiği ya da tek bir hatalı göçtür.
2. **İleri düzeltme (önerilen):** hatayı düzelten yeni sürüm, `bash scripts/guncelle.sh <yeni sürüm>`. Veri kaybı yok.
3. **Yedekten dönüş** (yalnız sistem açılmıyorsa; yedekten sonra yazılan veri gider): betiğin yazdığı yedek klasörüyle, önceki sürümde.

```bash
Y=yedekler/guncelle/<tarih-saat>
git -C .. checkout --detach "$(sed -n 's/.*"commit": "\([0-9a-f]*\)".*/\1/p' $Y/yedek.json)"
$DC stop && $DC up -d --wait postgres
$DC cp scripts/yedek-kap.sh postgres:/tmp/sod-yedek-kap.sh && $DC cp $Y/veritabani.dump postgres:/tmp/geri.dump
$DC exec -T postgres bash /tmp/sod-yedek-kap.sh geri /tmp/geri.dump sellerondata   # dökümdeki şemalar tek işlemde silinip kurulur
$DC exec -T postgres rm -f /tmp/geri.dump /tmp/sod-yedek-kap.sh
$DC build && $DC up -d --wait
```

Dosyalar geri yüklenmez (göç dosyaya dokunmaz); sonra `storage:orphans`. Sağlık: "Ayakta mı denetimi". Böyle bir dönüşten sonra hatalı sürüm yeniden denenmez; düzeltilmiş sürümle ileri gidilir.

## Destek komutları (abonelik ve firma)

- Yalnız sunucuda. Kapta `docker compose -p sellerondata exec account-api node dist/<komut>.js …` (tireli ad: `node dist/org-list.js --q demo`); geliştirmede `Platform/apps/account-api` içinde `npm run <komut> -- …`.
- `signup:purge` dışında hiçbiri veri silmez. Değiştirenler `--operator <ad>` ister, denetim izine yazar; üyelerin jetonu hemen yenilenir. Anlamlar ARCHITECTURE.md §6 "Abonelik durumları ve destek komutları".
- Çıkış: `0` tamam ya da değişiklik yok, `1` iş hatası (bozuk `PRODUCT_LAUNCH` dahil), `2` yanlış kullanım ya da eksik onay.

| Komut | Kullanım |
|---|---|
| `org:list` | `[--q <ad>] [--product <anahtar>] [--status ACTIVE\|READ_ONLY\|CANCELED\|none] [--limit 50] [--json]`; yalnız okur |
| `subscription:set` | `<orgId> <ürün> <ACTIVE\|READ_ONLY\|CANCELED> --operator <ad> [--plan <plan>] [--days <n>] [--reason <metin>]`: aç / durdur (okur, yazamaz) / iptal (`--days` gün okunur, 90); iptal edilen önce ACTIVE |
| `product:launch` | `<ürün> --operator <ad> [--plan <plan>] [--dry-run]`: `public` aracı aboneliği olmayan, kapalı olmayan firmalara açar |
| `org:close` | `<orgId> --operator <ad> --yes [--days 90] [--reason <metin>]`: abonelikleri iptal, davetleri düşürür (sonra `409 ORG_CLOSED`) |
| `org:reopen` | `<orgId> --operator <ad>`: önceki aboneliklere döner |
| `members:announce` | `<ürün> [--org <orgId>]`: üyeleri araca yeniden duyurur (`off` → `pilot` sonrası) |
| `org:announce` | Firmaları araçlara ad, para birimi, ülke, saat dilimiyle yeniden duyurur |
| `signup:invite` | `--email <adres> --operator <ad> [--days 14] [--lang tr\|en]`: `invite` kipinde tek kullanımlık kayıt bağlantısı (`…/register?invite=…`, 1–90 gün; posta gitmez, jeton saklanmaz). `--revoke <adres> --operator <ad>`, `--list [--email <adres>] [--limit 50]` |
| `signup:purge` | `--operator <ad> [--days 7] [--limit 500] [--yes]`: hiç kullanılmamış kayıtları geri alınamaz siler (ARCHITECTURE.md §6 "Kullanılmamış kayıt temizliği"); otomatik değil |
| `phone:release` / `phone:restore` | `<telefon> --operator <ad>` numarayı ayırır, oturumları düşürür / `<kişi> [telefon] --operator <ad>` geri alır (ARCHITECTURE.md §11) |
| `keys:generate` / `keys:rotate` | İmza anahtarı üretir / döndürür (geliştirmede) |

`--yes` isteyenler onaysız yalnız yazar, çıkış 2. DeciShip yapay zekâ: `Deciship/apps/api` içinde `npm run ai:usage` (günün toplamı, `fail_cap_TRY`, `FAILED-BUDGET-FULL`), `npm run ai:grant` (imajda `node dist/aiUsage.js`).

**Yeni komut:** giriş `scripts/<ad>.ts` (DeciShip `src/bin/<ad>.ts`) ince dosyadır, içe aktarılmaz, "ana dosya mı" denetlemez; `tsup.config.ts` ve `test/cli-entries.test.mjs`'e eklenir (yoksa komut boş geçip 0 döner). `npm run test:cli` hepsini derleyip çalıştırır.

### Teslim edilemeyen olaylar (DEAD)

Araç 72 saat ulaşılamazsa olay `DEAD` olur (ARCHITECTURE.md §6 "Olaylar ve abonelik"). Belirti: Hesap günlüğünde saatlik `… olay teslim edilemedi (DEAD), N tanesi üyelik olayı …`; araçtaki ad ve rol listesi geride kalır (askıdan dönen çalışan araca bir sonraki girişinde kendiliğinden döner; DeciShip ve product-kit araçları aynı; çıkarılan çalışan dönmez). Firma kapatma, geri açma ve silme olayları DEAD olmaz, teslim edilene dek denenir.

1. Araç açık mı, olay adresi doğru mu: `docker compose -p sellerondata ps`, `PRODUCT_EVENT_TARGETS`.
2. `docker compose -p sellerondata exec account-api node dist/outbox-requeue.js` (geliştirmede `npm run outbox:requeue`); tekrar zararsız.
3. Birkaç saniyede gider; uyarı sonraki turda sürüyorsa 1. adım. 30 günde silinen olay için (`outbox.dead_purged`) `members:announce <ürün> --org <orgId>`.

### İtiraz süresi hatırlatması (DeciShip)

Saatlik bakım çalıştırır; komut deneme içindir: kapta `docker compose -p sellerondata exec deciship-api node dist/cli/reminders.js [--send] [--now] [--company <firmaId>]`; geliştirmede `Deciship/apps/api` içinde `npm run reminders:once -- …`.
- Bayraksız **kuru** (gönderilmez, firma başına özet). Gönderim yalnız `--send`; `--now` 09:00–19:00 penceresini yok sayar; `--dry` ile `--send` birlikte olmaz.
- Firma başına günde tek özet (ikincisi `duplicate`; Hesap gönderirken durduysa 10 dk sonra yeniden, `sent`). Bir fatura en çok iki özette ("3 gün kala", "1 gün kala" ya da "son gün"). SPEC §5.14.

### Silinenlerin kalıcı silinmesi (DeciShip)

Açıkken saatlik bakım, silinmesinden N gün (kullanıcı kararı 30) sonra faturayı (satır, karar, kaynak dosyasıyla) ve silinmiş ölçümün fotoğraflarını **kalıcı** siler; itiraz kaydı olan fatura ve kanıt fotoğrafı kalır. SPEC §5.13.
- **Varsayılan kapalı, canlıda açmak zorunlu.** Kapalıyken API uyarır (`... off: deleted invoices and deleted measurement photos are kept`); panel "30 gün sonra kalıcı olarak silinir" der.
- **Kuru çalışma** (silmez, aynı kümeyi sayar): kapta `docker compose -p sellerondata exec deciship-api node dist/cli/purgePreview.js [--invoice-days <n|off>] [--photo-days <n|off>] [--company <firmaId>] [--json]`; geliştirmede `npm run purge:preview -- …`.
- **Açılış:** değişkenler boşken kurun, kuru çalışmaya bakın, sonra `DELETED_INVOICE_PURGE_DAYS=30`, `DELETED_MEASUREMENT_PHOTO_PURGE_DAYS=30` ve DeciShip API'yi yeniden başlatın.
- Tur başına en çok 100 fatura, 500 fotoğraf; silinemeyen dosya yetim kalır (`orphan file left`). Kaynak dosyanın 30 günlük disk temizliği ayrı, hep açık. Geri dönüş yalnız yedekten.

### Kaydı olmayan disk dosyaları (DeciShip)

Haftada bir; **yalnız raporlar.** Kapta `docker compose -p sellerondata exec deciship-api node dist/cli/storageOrphans.js [--min-age-hours <n>] [--json]`; geliştirmede `npm run storage:orphans`.
- `ORPHAN`: kaydı olmayan dosya (kalan `.tmp`; `company=unknown` silinmiş firma). `PURGED`: kaydı temizlenmiş. `MISSING`: kayıt var, dosya yok (`missing=<n>`; geri yüklemeden sonra sıfır değilse iki yedek aynı anın değil).
- Son 1 saattekiler `recentSkipped`. Silmek gerekirse önce yedek, sonra elle.

## Geliştirme modu

`scripts\dev.ps1` Postgres ve görüntü servisini Docker'da açar, migration uygular, sunucuları ve `scripts\dev-gateway.mjs`'i ayrı pencerelerde başlatır (`http://localhost:8088`). `-Seed`, `-NoWeb` (arayüzsüz), `-NoBrowser`. Durdurmak: pencereleri kapatın. Gerekenler: Node 24, Docker Desktop.

Test: `bash gateway/test/run.sh` (Docker), `node --test scripts/dev-gateway.test.mjs`, `node --test gateway/test/compose-order.test.mjs`.

## Uçtan uca testler

- `npm run e2e` (bir kez `npm --prefix e2e install`): gerçek sistem; ayrı proje `sod-e2e`, ayrı hacimler, 18xxx portları (`e2e/.env.e2e`). Temizlik `npm --prefix e2e run stack:reset`. Ekran görüntüleri `e2e/screenshots/` (git dışı).
- Kaydedilmiş sürümü sınamak: `node e2e/snapshot.mjs <hedef> --clone`, sonra `SOD_E2E_ROOT=<hedef>/Platform npm run e2e`.
- Hacim adları proje adından bağımsız: ikinci sistem `SOD_PGDATA_VOLUME`, `SOD_STORAGE_VOLUME`, `SOD_KEYS_DIR` vermezse aynı hacmi paylaşır, `down -v` onu siler. `demo.ps1` `SOD_PROJECT`, `SOD_ENV_FILE` okur.

## CI ve ön-commit kancası

- CI (`.github/workflows/ci.yml`, `scripts/ci-select.mjs`): kök `CLAUDE.md` "Testler"; veritabanı işi Postgres 17 + `infra/postgres/init.sql`.
- Kanca: `npm run hooks:install` (`git config core.hooksPath .githooks`); `.githooks/pre-commit` `node scripts/repo-check.mjs --staged` + sahnelenen JS/TS lint'i. Kapatmak: `git config --unset core.hooksPath`.

## Sorun giderme

- **Port dolu (5434/4100/8001):** `BASLAT.bat` boş porta (+10000) alır.
- **Port dolu (8088/8089):** `GATEWAY_PORT` / `SITE_PORT` değiştirin; `APP_BASE_URL`, `SITE_BASE_URL`, `ALLOWED_ORIGINS`, `SITE_ORIGINS` aynı porta çekilmeli.
- **"Sistem tam açılamadı":** `docker compose -p sellerondata ps`, `docker compose -p sellerondata logs <servis>`. **Derleme hatası:** `docker compose -p sellerondata build <servis>`.
- **PDF okunmuyor:** `ANTHROPIC_API_KEY` boş. **Giriş var, DeciShip 401:** `http://localhost:8088/api/account/.well-known/jwks.json` anahtar döndürmeli; `keys/` silinirse oturumlar düşer.
- **Görüntü servisi ya da DeciShip açılmıyor:** giriş ve Merkez yine açılır; görüntü servisi yokken yalnız referans kartlı ölçüm çalışmaz (`VISION_UNAVAILABLE`); ilk saniyelerde `/deciship/` 503 verebilir.
- **"Hesap servisi açılmadı: APP_BASE_URL yerel değil":** canlıda `docker-compose.prod.yml` ile açın.
- **Docker açılmıyor:** Docker Desktop'ı açın, WSL2 etkin olmalı. **Sıfırdan:** `SIFIRLA.bat`, `BASLAT.bat`.

## Posta

- **Üretimde `SMTP_URL` zorunlu** (gönderemeyen sistem "gönderildi" demesin).
- **Yerel kutu:** gerçek posta gitmez; postalar `MailLog`'a düşer, `SOD_DEV_MAILBOX=true` iken Merkez "gönderildi" der (`/me` `account.mailEnabled`, `/catalog` `mailEnabled`). `false` ise "posta kapalı"; bağlantılar `docker compose logs account-api`'de.
- Okumak: `POSTA.bat` (son 20) · `-To kisi@ornek.com` · `-Open` (en yeninin bağlantısı) · `-NoBrowser` (konsol). Betik `Platform/scripts/posta.ps1` (`SOD_PROJECT`); saatler UTC.
- **Doğrulama yerelde de açık:** kayıt → `POSTA.bat -Open` → şifre → giriş. Kapatmak: `SOD_EMAIL_VERIFICATION=false`, `BASLAT.bat`.
- "Şifremi unuttum" ve "bağlantıyı yeniden gönder" yanıtı kişi kayıtlı olsa da olmasa da aynı.
