# Mimari: güvenlik, mobil sürüm, arka plan işleri, çalışma kuralları (§11–§12)

Dizin ve diğer parçalar: `Platform/docs/ARCHITECTURE.md`.

## 11. Güvenlik asgarileri

- Argon2id. Oturum ve bağlantı jetonu özetleri SHA-256 (256 bit rastgele). Telefon kodu özeti biberli HMAC-SHA-256 (`ACCOUNT_CODE_PEPPER`): kod 40 bit, düz özet sızan tablodan kırılırdı.
- Şifre en az 10 karakter; yaygın örüntüler reddedilir (yaygın kelime + rakam, klavye sırası, ardışık, yinelenen, yalnız rakam). Mevcut şifre doğrulamasına uygulanmaz.
- Uygulama bağlantısı `TimeZone=UTC` ile açılır, roller de UTC'dedir: ham SQL `now()` ile Prisma'nın UTC yazdığı `TIMESTAMP` sütunları aynı saate bakar. `TIMESTAMPTZ` bu sorunu çözmez, pg bağdaştırıcısı parametreyi ofsetsiz gönderir ve yazma kayar. Her ürün bağlantısı aynısını yapar.
- **Giriş hız sınırı.** IPv6 /64'e indirgenir. Amaç saldırganı yavaşlatmak, kurbanı kilitlememek. Pencereler §6 "Hız sınırı" (ikili/kimlik/kişi 5 dk, IP 15 dk):
  1. Saldırganın elindeki kovalar önce: IP (100) ve kimlik + IP (10), her istekte sayılır; dolunca `429` ve kimlik kovasına yazılmaz. Tek bilgisayar kimlik kovasına en çok 10 deneme ekleyebilir.
  2. Kimlik (30) ve kişi bulunursa `login:person` (30) atomik artırılır ("önce say, başarıda geri ver": paralel istek sınırı delemez).
     - Dolu kovada yalnız **bilinen cihaz** geçer: kişinin son 90 güne ait, iptal edilmemiş, şifreyle ya da kodla açılmış (döndürmeyle değil) en yeni 100 oturumundan birinin IP birimi aynı. Çalınmış yenileme jetonunu başka IP'den döndüren hırsız o IP'yi bilinen cihaz yapamaz. İstisnayla geçen deneme ayrıca `login:known` kovasına (30) yazılır, dolunca `429`. Kişi yoksa da aynı sorgu çalışır: süre farkı varlığı ele vermez.
  3. Şifre doğruysa sayılan paylar geri verilir ve kimlik + IP kovası silinir; kovalarda yalnız başarısız denemeler kalır.
  4. Kişi kovası ilk kez dolunca pencere başına bir kez `login.locked` yazılır; kişinin adresi doğrulanmışsa günde en çok bir "çok sayıda hatalı giriş denemesi" postası gider (`login_locked`; bağlantı yalnız "şifremi unuttum" sayfası).
  5. **Günlük tavan:** kişi başına 24 saatte 100 başarısız deneme (`login:day`), 15 dakikalık kovalarla aynı kural (önce say, başarıda geri ver; dolu kovada yalnız bilinen cihaz geçer). Birçok IP'den 15 dakikalık kovaları doldurmadan günde binlerce tahmin yapılamaz. Davet kabulü ve ilk doğrulamadaki şifre de bu kovaya sayılır.
  6. **Kilidin kalkması:** şifre "şifremi unuttum" bağlantısıyla ya da yöneticinin koduyla yenilenince kişinin giriş kovaları (kişi, günlük, bilinen cihaz ve bugünkü e-posta ve telefonunun kimlik kovası) boşalır: yeni yerden giremeyen meşru kişinin kendi çıkış yolu budur. Kimlik + IP kovası kalır.
- "Şifremi unuttum"da kimlik sınırı (saatte 3) aşılınca hata değil aynı yanıt döner, posta gitmez; yeni istek eski bağlantıyı silmez (en çok 3 etkin bağlantı). Doğrulama sayfasındaki şifre de giriş kovalarıyla sınanır.
- Şifre denemesi kişi başına tek kovada sayılır (`login:person`): e-posta, telefon, davet kabulü ve ilk doğrulama ayrı sayılmaz. `resend` bu kovayı sıfırlamaz.
- **Bilinen sınırlar:** aynı ofis ağındaki biri dolu kovada da deneme hakkı bulur (kimlik + IP kovasıyla sınırlı); dağıtık saldırgan çok sayıda IPv6 `/64` bulabilir. CAPTCHA yok (yayına hazırlıkta, sağlayıcı seçilmedi). Bilinen cihaz IP birimine bağlıdır (cihaz kimliği çerezi yok): günlük kova doluyken yeni ağdan giren meşru kişi, şifresini yenileyene ya da 24 saat dolana kadar 429 alır.
- **Şifre değişti postası:** `POST /me/password` ve `POST /auth/reset-password` sonrası kişinin mevcut adresine arka planda `password_changed` postası (TR/EN; bağlantı yalnız "şifremi unuttum" sayfası, jeton yok). Yöneticinin koduyla yenilemede kişinin e-postası yoktur, posta gitmez.
- **Kabul edilen risk, `personExists`:** geçerli kodu veya bağlantısı olan, numaranın ya da e-postanın kayıtlı olup olmadığını öğrenir; akış gereği (yeni şifre mi mevcut şifre mi, giriş mi soracak).
  - Davet açmak firma yöneticisi gerektirir: telefon firma başına saatte 20, 24 saatten genç firmada 10; e-posta saatte 30, genç firmada 10. Yalnız açılan davet sayılır: geçersiz girdi, zaten üye ve yetkisiz deneme hak yemez. Tarama böyle daraltılır.
  - Telefonda çözümü SMS, e-postada davet kabulüne kadar varlığı gizleyen akıştır.
- **Kabul edilen risk, numara kapma (yayına engel, açık madde):** SMS yokken davet kabul eden kişinin numaranın gerçek sahibi olduğu kanıtlanamaz.
  - Yöneticiden kodu alan telefonsuz hesap numarayı kendine bağlayabilir, yalnız açıkça seçerse: `join/preview` ve `join/accept` gövdesinde `linkCurrentAccount: true`; seçmezse açık oturum yok sayılır ve kod yeni ya da numaranın sahibi kişi için kullanılır. Hesabı olmayan biri de kodla yeni hesap açıp numarayı alabilir.
  - Bu hesap ele geçirme değildir: numaraya şifre belirletmez, başkasının hesabına girmez. Etkisi numaranın gerçek sahibini davetten engellemektir.
  - Azaltma: `PATCH /me` ile telefon eklenemez; iki yolda da `person.phone_linked` denetim izi son 4 hane ile; yeni firma daveti sınırı.
  - Destek komutu `npm run phone:release -- <telefon> --operator <ad>` (imajda `node dist/phone-release.js ...`) numarayı ayırır, oturumları düşürür, kişinin başka girişi yoksa askıya alır, denetim izine operatörle yazar. Tersi `phone:restore -- <kişi> [telefon] --operator <ad>`: askıyı kaldırır, yalnız komutun askıya aldığı üyelikleri açar. `operator` zorunludur, ortam değişkenine güvenilmez. Çalıştırma: `KURULUM.md` "Destek komutları".
  - Askıdaki kişi (`suspendedAt`) hiçbir yoldan oturum alamaz: giriş, yenileme, davet kabulü kilit altında denetler; yöneticinin üyeliği açması `409 PERSON_SUSPENDED`, `resetCodeAllowed` false.
  - `Person.phoneVerifiedAt` SMS için hazır, henüz kullanılmıyor. Risk SMS ile kapanır.
- **Biber dönüşü:** eskisini `ACCOUNT_CODE_PEPPER_PREVIOUS`e, yenisini `ACCOUNT_CODE_PEPPER`e yaz, yeniden başlat. Yazma yeni biberle, doğrulama ikisiyle. 72 saat (kod ömrü) sonra önceki biberi sil. Özet biber kimliği taşır: bilinmeyen biberli kod doğrulanmaz ve hak yakmaz. Geliştirme biberi üretimde reddedilir.
- **Erişim günlüğü** bağlantı jetonlarını (`/invite`, `/reset-password`, `/verify-email`, `/api/account/invites`, `/register?invite=`; harf duyarsız) ve Referer'ı yazmaz. Kural tek dosyada (`gateway/conf/access-log.conf`, biçim `sod`): gateway, hub-web ve deciship-web imajları aynısını kullanır (denetim `gateway/test/access-log.test.mjs`). Jetonlu sayfalar `Referrer-Policy: no-referrer` alır: jeton ne üçüncü tarafa ne aynı kökendeki sonraki isteklere geçer.
- **Davet postası** konusu sabittir, serbest metin yalnız gövdede ve kaçışlıdır; adlar tırnak içinde ve 60 karakterde kısaltılmış görünür. Firma ve kişi adlarında bağlantı yasaktır (`http`, `www.`, `://`; yalnız yeni yazımda). Alıcı başına günde 5 posta: aşınca davet ve bağlantı çalışır, `mailSent: false` döner, posta gitmez. Böylece kurbanın gelen kutusu da daveti de korunur.
- Giriş, kayıt, şifremi unuttum, sıfırlama, kod denemesi ve şifre onayı veritabanında sınırlıdır (`RateBucket`; anahtarlar §6 "Hız sınırı").
- **TLS ve vekil** (üretim; `caddy/Caddyfile`, `docker-compose.prod.yml`, açılış KURULUM "Üretim açılışı" adım 3):
  - Dışa yalnız Caddy açılır (IPv4 TCP 80 ve 443). Sertifikayı kendisi alır ve yeniler (Caddy'nin varsayılanı: Let's Encrypt, olmazsa ZeroSSL; Caddyfile yetkili seçmez); http → https, `www` → kök. Gateway, site, veritabanı ve servislerin hiçbirinin portu açık değildir; gateway ve site Caddy'yle ayrı bir iç ağdadır (`edge`), site öteki servislere ulaşamaz.
  - Zincir sabit: istemci → Caddy → gateway → uygulama. Caddy istemcinin `X-Forwarded-For`/`-Proto`/`-Host` başlıklarını yok sayar, kendi gördüğünü yazar. Gateway bu başlıklara yalnız Caddy'nin sabit adresinden (`SOD_CADDY_IP`) gelirse güvenir (`GATEWAY_REAL_IP_FROM`, üretim katmanında bağlı, `.env` ezemez) ve uygulamaya tek adres geçirir; uygulamalarda `TRUST_PROXY_HOPS` 1 (üretimde sabit).
  - Sonuç: hız sınırı, günlük ve "bilinen cihaz" gerçek istemci IP'siyle çalışır; DeciShip dosya bağlantısı üretimde `APP_BASE_URL`'den kurulur (zorunlu, yalın `https://` kökeni; istek başlığına, `X-Forwarded-Host`'a bakılmaz), geliştirmede istekten (`Deciship/apps/api/src/lib/storage.ts` `publicBase`).
  - IPv6 yok: Docker, IPv6'sız kap ağına IPv6 bağlantısını aktarırken kaynak adresini köprünün adresiyle değiştirir; bütün IPv6 kullanıcıları tek IP sayılırdı. DNS'e AAAA kaydı yazılmaz.
  - Başlıklar tek yerde: uygulamanınkiler gateway'de (`gateway/conf/security-headers.conf`, HSTS dahil), sitenin başlıkları sitenin nginx'inde. Caddy yalnız sitenin (ve `www` yönlendirmesinin) HSTS'ini yazar, çünkü site nginx'i TLS'i bilmez; değer gateway'inkiyle aynıdır, her yanıtta her başlık bir kez (yapılandırma denetimi `gateway/test/compose-order.test.mjs`).
  - HSTS `max-age=86400; includeSubDomains`, preload yok: ilk kurulumda yanlış ayar tarayıcıları uzun süre kilitlemesin. Uzatma (1 yıl, sonra preload) KALANLAR "Yayından önce".
  - Caddy'de istek günlüğü yok (jetonlu adresler gateway'de maskeli yazılır); Caddy'nin hata günlüğü isteğin adresini ve başlıklarını siler. Çerezler üretimde `Secure` (`COOKIE_SECURE=false` servisi açmaz); Caddy `Set-Cookie`'ye dokunmaz, `__Host-` öneki (6.3) önünde engel yok.
  - Gateway çökerse Caddy `502` döner (gövdesiz); istemciler bunu geçici hata sayar.
- **Gateway:** CSP (`default-src 'self'`, satır içi betik yok), `frame-ancestors 'none'`, HSTS (yalnız TLS arkasında, "TLS ve vekil"), `nosniff`, `Referrer-Policy` (varsayılan `strict-origin-when-cross-origin`, jetonlu sayfada `no-referrer`; yukarı akış yalnız daha sıkısını, `no-referrer` ya da `same-origin`, geçirebilir). Reklam/analiz betiği yalnız sitede; bu yüzden site kimlik bilgisi almaz ve Hesap'ta yalnız iki uca erişir (§5 "Tek hesap").
- **Gateway hız sınırı** (uygulama sınırlarının önünde kaba ilk savunma, IP başına, `gateway/templates/20-limits.conf.template`):
  - Kimlik uçları (`/api/account/auth/` altında `login`, `register`, `forgot-password`, `reset-password`, `verify-email`, `resend-verification`, `join/preview`, `join/accept`; `/api/account/invites/*`): dakikada 30, birikme 30. Oturum yenileme, `site-session`, çıkış ve firma değiştirme dışarıda (her sekme ve telefon sık çağırır).
  - Bütün `/api/` (kimlik uçları dahil): saniyede 30, birikme 200; eşzamanlı bağlantı 100. Yükleme (her multipart: ölçüm, canlı tartı ve işaret okuma, dosya): dakikada 600, birikme 300. Ölçüm gönderimi kimlik kovasına girmez.
  - Yükleme kovası depo NAT'ına göre: bütün telefonlar tek dış IP'den gelir, çevrimdışı kuyruk açılınca gönderim patlamalı olur. Bu yüzden kova DeciShip API'nin firma sınırları toplamının (yükleme 300 + okuma 240 / dk) üstündedir; asıl sınırı API kişi ve firma başına koyar (`Deciship/apps/api/src/lib/rateLimit.ts`: kişi yükleme 60, okuma 60 / dk). Aşınca API `429` + `Retry-After` (pencerenin açılacağı saniye) döner; mobil kuyruk turu durdurur ve o süre (en çok 60 sn) bekler.
  - Sağlık uçları, `/healthz` ve statik dosyalar ile web sayfaları hız sınırı almaz. Eşzamanlı istek sınırı (IP başına 100, `GATEWAY_CONN_PER_IP`) ise her yolda (`templates/conn-limit.inc.template`): yavaş gövde gönderen ya da yanıtı yavaş okuyan tek istemci gateway'in bağlantılarını tüketemez. nginx işçi başına bağlantı tavanı 4096 (varsayılan 1024; `gateway/Dockerfile`).
  - Aşınca `429`, `Retry-After: 5`, `{"error":{"code":"..."}}`: kimlik ucunda `TOO_MANY_ATTEMPTS` (giriş ekranları "N dakika sonra" yazar), başka yerde `TOO_MANY_REQUESTS`. Yukarı akışın kendi 429'u olduğu gibi geçer.
  - Kova anahtarı gerçek istemci IP'sidir (`$binary_remote_addr`, `GATEWAY_REAL_IP_FROM` güvenilen vekilden). Vekil arkasında bu değişken vekilin adresi olmazsa herkes tek IP sayılır; üretim katmanı onu Caddy'nin adresine bağlar ("TLS ve vekil"). IPv6 tam adres sayılır.
  - Depo Wi-Fi'ındaki telefonlar tek IP'den gelir: birikme vardiya başı toplu girişe göre geniş. Denetim `gateway/test/rate-limits.test.mjs`, canlı `gateway/test/run.sh`.
- **Sıkıştırma** (gateway, `gateway/conf/gzip.conf`): metin yanıtlar gzip (HTML, JSON, JS, CSS, SVG, CSV, düz metin; 1 KB üstü, düzey 5, `Vary: Accept-Encoding`). Fotoğraf, PDF, Excel ve arşiv zaten sıkıştırılmış, akış yanıtı (`text/event-stream`) arabelleğe alınmasın diye listede yok.
  - **BREACH kararı:** saldırı, gizli bilgi ile saldırganın seçtiği metin aynı sıkıştırılmış gövdedeyse ve saldırgan kurbanın tarayıcısına çok sayıda istek attırıp boyutları izleyebiliyorsa işler. Hesap API'si (`/api/account/*`) hiç sıkıştırılmaz: gövdede oturum, yenileme ve davet jetonu, kod döner; kazanç da küçüktür. `Set-Cookie` başlıktadır, gzip başlığı sıkıştırmaz.
  - DeciShip API'si sıkıştırılır (büyük listeler, asıl kazanç): oturum çerezi `SameSite=Lax` olduğundan başka siteden yalnız üst düzey gezinti çerez taşır, yazma isteği CSRF başlığı ister, mobil Bearer kullanır; gövdedeki tek gizli bilgi kısa ömürlü dosya bağlantısı imzasıdır. Yeni bir uç gövdede oturum ya da uzun ömürlü jeton döndürürse konumuna `gzip off` yazılır.
  - Statik dosyaları gateway anında sıkıştırır (hashli varlıklar tarayıcıda bir yıl önbellekte, maliyet ilk yüklemede). Önceden sıkıştırma (`gzip_static`) web kaplarında yapılabilir: kap `.gz` dosyasını `Content-Encoding` ile verirse gateway ikinci kez sıkıştırmaz.
  - Denetim `gateway/test/gzip.test.mjs`, canlı `gateway/test/run.sh` ("sıkıştırma").
- Firmalar arası izolasyon otomatik testi: her `/api/deciship` ucu için A firması jetonuyla B kaydı → 404/403.
- İzin matrisi otomatik testi: her uç × her rol.
- `/settings/data/reset` yalnız `ENABLE_DATA_RESET=true` iken açılır; üretimde varsayılan kapalı.
- **Yapay zekâ geçidinde yönetici yetkisi** (`Platform/apps/ai-api/src/auth/platform.ts`). Geçit durumsuzdur, Hesap'a sormaz:
  - Okuma ve sınama uçları erişim jetonundaki `op`'a bakar. Listeden çıkarma, e-posta doğrulamasının düşmesi, askı ve çıkış geçitte en çok erişim jetonu ömrü (10 dk) gecikmeyle görünür.
  - Değiştiren uçlar ayrıca adım artırma jetonu ister (`POST /api/account/operator/step-up`, şifre yeniden; Hesap yetkiyi o anda veritabanından okur). Jeton 5 dk geçerli, tek amaçlı (`aud: ai-admin`), aynı kişiye ve aynı oturum ailesine bağlı (`fid`; yenileme yeni `sid` açar, bağı koparmaz; `fid`'siz eski jetonda `sid` eşitliği). Tek kullanımlık değildir: süresi içinde aynı oturumda tekrar kullanılabilir.
  - Çıkış ve aile iptali Hesap'ta anında geçerlidir, geçitte değil: eski erişim + adım artırma jetonu çifti en çok 5 dk daha değiştiren uçlara girebilir.

### Mobil sürüm uyumu (426)

- Mobil uygulama her isteğe `X-SOD-Client: mobile/<sürüm>+<derleme> (<platform>)` başlığını koyar.
- Hesap ve DeciShip API, sürüm `MIN_MOBILE_VERSION`'ın (katı `x.y.z`, `contracts` `strictVersion`) altındaysa `426 UPGRADE_REQUIRED` döner. Başlıksız ya da bozuk başlıklı istek denetlenmez.
- `GET /api/account/client-policy` politikayı `cache-control: no-cache` ile verir. Mobil uygulama bu durumda tam ekran güncelleme ekranı gösterir; kuyruk korunur.
- `MIN_MOBILE_VERSION` güvenlik önlemi değildir; bir açık sunucu tarafında kapatılır.

### Arka plan işleri ve ölçek

Uzun işler (PDF fatura okuma, tarife PDF tarama ve okuma, toplu yeniden hesap) DeciShip'in Postgres'indeki `Job` tablosunda sıraya girer. Yeni altyapı yok: Redis ya da ayrı kap eklenmedi. Kurallar `Deciship/SPEC.md` §5.13.

- **Kuyruk Postgres'te, çalıştırıcı DeciShip API sürecinin içinde.** Sahiplenme `FOR UPDATE SKIP LOCKED`, kira 60 sn ve kalp atışıyla; ölen sürecin işini başka süreç devralır. İkinci API kopyası eklenince o da iş alır (iki kopya aynı işi almaz). Firma başına ve grup başına tek iş kuralı kopyalar arasında yumuşaktır; veri yazan her yol kendi kilidini taşır.
- **Bugün tek kap:** `deciship-api` (`JOB_RUNNER=on`) HTTP'nin yanında iş kuyruğunu, ölçüm taramasını ve saatlik bakımı çalıştırır. İkisinin başlatıcısı tektir (`services/background.ts`); HTTP girişi `main.ts`, iş çalıştırıcı girişi `worker.ts`.
- **Ayrı iş çalıştırıcı kabı** (sunucuda ölçek gerekince): aynı imaj `node dist/worker.js` ile açılır; HTTP dinlemez, iş kuyruğunu, ölçüm taramasını ve bakımı çalıştırır (`JOB_RUNNER` orada yok sayılır, hep iş alır). API kopyaları `JOB_RUNNER=off` ile açılır: yalnız kuyruğa yazar, bakım da çalıştırmaz. İş, API'den eklenince en geç `JOB_POLL_MS` (2 sn) içinde alınır. Örnek parça aşağıda; `docker-compose.yml` bugün değişmedi.
- **İki kap aynı anda iş alır, aynı işi ikisi almaz** (`SKIP LOCKED` sahiplenme, her yazımda sahiplik belirteci; `test/jobs.test.ts` "iki çalıştırıcı"). Bakımın her adımı birden çok kopyada güvenlidir (yalnız süresi dolmuşu siler; hatırlatmayı Hesap servisi anahtar başına bir kez gönderir). Sınır: firma başına grup başına tek iş kuralı aynı anda sahiplenmede kopyalar arasında aşılabilir (yukarıda).
- **Kapanış (worker):** SIGTERM'de yeni iş alınmaz, süren işler `JOB_SHUTDOWN_GRACE_MS` bekler, bitmeyenlerin kirası bırakılır, dosya çalışanları ve veritabanı bağlantısı kapanır, süreç 0 ile çıkar.
- **Sağlık (worker):** veritabanına kısa sorgu başarılıysa `WORKER_HEALTH_FILE` (varsayılan `/tmp/deciship-worker.alive`) 15 sn'de bir yenilenir; denetim dosyanın yaşına bakar.
- **Boştaki yoklama 2 sn'de bir** kısa bir sorgu (kopya başına); `LISTEN/NOTIFY` yok. Aynı süreçte eklenen iş döngüyü hemen uyandırır.
- **Çalıştırıcı kapsamı dardır:** `app.scope = 'jobs'` yalnız bekleyen ve süren işi görür ve günceller; bitiş yazımı ve işin kendisi firma bağlamında çalışır.
- **Kapanışta** süren işe 30 sn tanınır (compose `stop_grace_period: 45s`), bitmeyenin kirası bırakılır.

Ayrı iş çalıştırıcı kabı için örnek (`docker-compose.yml`'e eklenecek parça; dosyalar yerel diskte kalır, iki kap aynı hacmi bağlar, nesne deposu yok):

```yaml
  deciship-api:
    # ... bugünkü tanım ...
    environment:
      JOB_RUNNER: "off"            # HTTP kopyası yalnız kuyruğa yazar

  deciship-worker:
    build: *deciship-api-build     # aynı imaj
    command: ["node", "dist/worker.js"]
    restart: unless-stopped
    mem_limit: ${DECISHIP_WORKER_MEM:-2g}
    stop_grace_period: 45s         # JOB_SHUTDOWN_GRACE_MS'ten en az 15 sn uzun
    ulimits:
      core: 0
    environment:                   # deciship-api ile aynı ortam (veritabanı, yapay zekâ, dosya, iş ayarları); PORT gerekmez
      # ... deciship-api'deki değişkenler ...
      STORAGE_DIR: /data/storage
    volumes:
      - sod_deciship_storage:/data/storage   # deciship-api ile AYNI hacim
    healthcheck:
      test: ["CMD", "node", "-e", "const s=require('fs').statSync('/tmp/deciship-worker.alive');process.exit(Date.now()-s.mtimeMs<60000?0:1)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    depends_on:
      deciship-migrate:
        condition: service_completed_successfully
```

Ortamı iki kapta tekrar yazmamak için bir YAML çapası (`x-deciship-env: &deciship-env`) kullanılabilir. Ölçüm kaydından sonraki karşılaştırma HTTP kabında kalır (aşağıda, süreç içi sıra); yarıda kalanı worker'ın taraması alır.

Hâlâ tek sunucuya bağlı kalanlar:

- **Dosyalar yerel diskte** (`STORAGE_DIR`, kapta bir birim). Nesne deposu ve otomatik yedek yok (ilk canlı kurulumdan önce). İkinci kopya aynı birimi görmeden dosya işleri tutarsız olur.
- **Ölçüm sonrası fatura karşılaştırma sırası bellekte** (`measurementQueue.ts`, `MEASURE_RECOMPARE_SLOTS`). Kalıcılık `Measurement.recomparePendingAt` işaretinde; sunucu ölürse işareti tarama alır (yeniden başlamadan sonra en geç ~3,5 dk).
- **Kısa yapay zekâ çağrılarının sınırları** (tartı okuma, sütun eşleme, tarife incelemesi): kişi başı dakika sınırı, firma yuvası ve dosya okuma havuzu sunucu başına sayılır; kuyruğa girmezler. Uzun işlerin yuva sayısı (`ai` 2, `recalc` 1) da sunucu başınadır.
- **Toplu hesap** sunucu başına tek yuvada, bütün firmalar arasında sıralanır.

## 12. Çalışma kuralları

Çalışma kuralları kök `CLAUDE.md` dosyasındadır.
