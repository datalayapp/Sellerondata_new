# Mimari: kimlik ve oturum (§5)

Dizin ve diğer parçalar: `Platform/docs/ARCHITECTURE.md`.

## 5. Kimlik ve oturum

- İmza: Ed25519 (`jose`). Özel anahtar yalnız account-api'de. Ürünler `GET /api/account/.well-known/jwks.json` adresinden açık anahtarı alır (iç adresle, önbellek + `kid` döndürme). `JWT_SECRET` yoktur.
- Erişim jetonu 10 dk. Alanlar `contracts/AccessClaims`. Ürün, jetonu Hesap'a sormadan doğrular; Hesap kısa süre kesilirse açık oturumlar çalışır.
- Yenileme jetonu 30 gün, her kullanımda döner; eski jeton tekrar gelirse aile iptal edilir (kayıp yanıt toleransı ve tekrar anahtarı: `04-hesap-oturum.md` "Oturum").
- **Oturumun üst yaşı** `SESSION_MAX_AGE_DAYS` (varsayılan 90, 1–3650):
  - Şifreyle ya da kodla açılan ilk girişten (`familyCreatedAt`) bu süre geçince yenileme aileyi iptal eder, `session.expired` denetim kaydı yazar, çerezleri siler ve `401` döner; kişi yeniden şifre girer. Yeni satırın `expiresAt` değeri bu sınırı aşmaz.
  - Başarılı giriş `session.created`, kilitlenen kişi kovası `login.locked` yazar (kişi düzeyinde, `orgId: null`; firma denetim izinde görünmez).
- **Web:** yalnız HttpOnly çerez. `sod_at` Path=`/api`, `sod_rt` Path=`/api/account/auth`, `SameSite=Lax`, üretimde `Secure`. Tarayıcı deposunda jeton yoktur. Durum değiştiren isteklerde `X-SOD-CSRF: 1` başlığı + `Origin` izin listesi zorunlu (Bearer isteklerinde gerekmez).
- **Mobil:** gövdede jeton, `Authorization: Bearer`, SecureStore.
- **Firma yönetimi yalnız tarayıcı oturumuyla** (KARARLAR): Hesap'ın `/org` ve `/org/*` yazmaları `Authorization` başlığı olmayan ve oturum satırı `client: web` olan isteği kabul eder (`auth.ts` `isWebSession`); ikisi birden gerekir, yoksa çalınmış mobil jeton çerezle gönderilirdi. Değilse `403 FORBIDDEN`, `details.reason: WEB_SESSION_REQUIRED`. Denetim kimlik ve firma denetiminden sonradır (bayat jeton yine `401 TOKEN_STALE`). İstisna `POST /org/members/invite` gövdesi `kind: PHONE_CODE` ve `orgRole: MEMBER` (ya da yok): mobil "Çalışan ekle". Bu yolda araç rolü rol kilidi altında ayrıca sınırlıdır (`routes/org.ts` `mobileGrantable`: izinleri kilitli rol ve sahibe özel izinli rol yok, mobilin `inviteRoleOptions` listesiyle aynı) ve aynı telefonun bekleyen daveti yalnız bu sınırdaysa (telefon kodu, çalışan, mobil rolü) yenilenir; değilse `403 WEB_SESSION_REQUIRED`, eski davet kalır. Mobil oturumdan web oturumu üreten yol yoktur.
- Giriş kimliği e-posta veya telefon. Telefon `libphonenumber-js` ile E.164'e çevrilir, varsayılan ülke TR. Yanıtlar kimliğin varlığını ele vermez.
- **Telefon doğrulaması:** SMS gelene kadar `PATCH /me` ile telefon eklenemez ve değiştirilemez (`403 PHONE_CHANGE_NOT_ALLOWED`), kaldırılabilir. Numara hesaba yalnız kodlu davet kabulüyle bağlanır:
  - kişi yoksa yeni hesap açılır;
  - oturum açık ve hesapta telefon yoksa (`join/preview` `linksCurrentAccount`) hesabın şifresiyle onaylanır ve numara ona yazılır (yalnız açıkça seçilirse, §11 "numara kapma");
  - hesapta başka numara varsa veya numara başkasınınsa `403 INVITE_WRONG_ACCOUNT`.
  - E-posta daveti numara taşımaz, telefon yazmaz.
- **Sekmeler arası firma:** etkin firma çerezde ve sekmeler arasında ortaktır.
  - Tarayıcı istemcisi çerezli her yazma isteğinde ekranda gördüğü firmayı `X-SOD-Org` ile gönderir.
  - Hesap'ın firmaya bağlı uçları ve auth-kit, başlık yoksa veya jetondaki `org` değilse `409 ORG_MISMATCH` döner; istemci otomatik yeniden denemez, sayfayı yeniler.
  - Bearer ve okuma muaf. Firmaya bağlı olmayan Hesap uçları (`/auth/*`, `/me`, `/orgs`) istemez.
- **OWNER'ın e-postası zorunlu** (`409 OWNER_REQUIRES_EMAIL`): devir e-postasız kişiye yapılamaz, OWNER e-postasını silemez, e-postasız kişi firma açamaz. OWNER'ın şifresini kurtarabilecek başka kimse yoktur.
- **Devir yalnız doğrulanmış adrese:** `EMAIL_VERIFICATION_REQUIRED` açıkken (üretimde hep) e-postası doğrulanmamış üyeye devir `409 OWNER_REQUIRES_EMAIL`, `details.reason: 'EMAIL_NOT_VERIFIED'` (TR ve EN metin `i18n.ts` `OWNER_EMAIL_REASONS`). Gerekçe: doğrulanmamış adres giriş yapamaz, devir firmayı girebilen sahipsiz bırakırdı. `GET /org/members` her üyede `emailVerified` taşır; Merkez devir penceresi doğrulanmamış üyeyi seçtirmez, yanında "e-posta doğrulanmamış" yazar.
- Etkin firma oturumda durur. `POST /auth/switch-org` yeni jeton üretir. Üyeliği olmayan kişi `org: null` jeton alır; ürünler bunu reddeder.
- **Jetonun firması gerçeğin gerisinde kalırsa:**
  - Kişinin etkin üyeliği varken jeton firmasızsa, jetonun üyeliği artık etkin değilse veya `mid` güncel üyelik değilse (askı kalktı, davet başka cihazda kabul edildi, çıkarılıp yeniden eklendi, bir firmada askıya alındı ama başkasında etkin) `GET /me` `401 TOKEN_STALE` döner, firmasız yanıt vermez. Hesap'ın firma uçları da aynı durumda `ORG_REQUIRED` yerine `TOKEN_STALE` der.
  - İstemci her 401'de olduğu gibi yeniler; yenileme, tolerans içindeki web tekrarı dahil, etkin firmayı seçer.
  - Etkin üyeliği olmayan kişi `/me` için 200 ve `activeOrg: null`, firma uçları için `403 ORG_REQUIRED` alır: ekranı askı veya firma oluştur olur.
- Yeni kişinin ilk girişi: `lastOrgId ?? tek firma ?? ilk firma`.

### Tek hesap: site, Merkez, araçlar

- **Tek kimlik.** Kişi, üyelik ve oturum yalnız Hesap servisindedir (`Person`, `Membership`, `Session`). Tanıtım sitesi, Merkez, DeciShip web, mobil ve sonraki araçlar aynı hesabı kullanır; araç başına hesap veya şifre yoktur.
- **Giriş noktaları.**
  - Site: "Hesap aç" `/register`, "Giriş" `/login` (uygulama kökeninde, EN'de `?lang=en`); kayıt `/home`a gider, kurulum Merkez'dedir.
  - Merkez ve DeciShip web aynı kökendedir (`app.sellerondata.com`) ve aynı çerezleri paylaşır. Mobil Bearer ile aynı kişiye girer.
  - Yeni araç `auth-kit` ile aynı erişim jetonunu doğrular, kendi oturumunu açmaz.
- **Site hiçbir kimlik bilgisi almaz.** Şifre, e-posta, telefon, kod alanı sitede yoktur (`apps/site/scripts/check.mjs` denetler). Gerekçe: sitede ileride reklam ve analiz betiği olabilir (§11); o betik form alanını okuyabilir. Kimlik bilgisi yalnız uygulama kökenindeki formlara girilir, orada üçüncü taraf betik yoktur.
- **Sitenin "kimim" yoklaması:** `GET /api/account/auth/site-session`. Yenileme çerezinin yolu altındadır (`sod_rt` yalnız oraya gider). Yanıt `{ signedIn: false }` ya da `{ signedIn: true, name, orgName, canManageOrg }`; jeton, kimlik, e-posta, firma kimliği taşımaz.
  - Salt okunur: jeton döndürmez, oturum satırına yazmaz (`lastUsedAt` dahil), aileyi iptal etmez, hırsızlık saymaz. Döndürme ve tekrar kuralları yalnız `POST /auth/refresh`te uygulanır.
  - `signedIn: true` yalnız: tek `sod_rt` çerezi (yineleniyorsa false), özeti eşleşen satır web oturumu ve ailenin başı (döndürülmemiş, iptal edilmemiş, süresi geçmemiş), kişi askıda değil, `EMAIL_VERIFICATION_REQUIRED` açıksa e-posta doğrulanmış. Döndürülmüş eski jeton tolerans içinde bile false döner, aile düşmez.
  - `orgName` oturumun etkin firmasıdır ve yalnız üyelik `ACTIVE` ise dolar, yoksa null. `canManageOrg` o üyelik OWNER veya ADMIN ise true (site "Firma ve ekip" bağlantısını buna göre gösterir; yetki yine Merkez'de denetlenir).
  - `Cache-Control: no-store`, `Vary: Origin, Cookie`. `Sec-Fetch-Site: cross-site` gelirse yanıt her zaman `{ signedIn: false }` (403 değil: site tek dalla "giriş yapılmamış"a düşer, yanıt bilgi taşımaz).
  - IP başına 15 dakikada 600 istek (cömert: aynı NAT arkasında çok ziyaretçi), aşınca `429`.
- **CORS ve CSRF kapsamı.** `SITE_ORIGINS` (liste) tanıtım sitesinin kökenleridir.
  - Site kökeni yalnız `config.siteOrigin` işaretli iki uçta geçerlidir: `GET /auth/site-session` (kimlikli CORS yanıtı) ve `POST /auth/logout` (ön uçuş + `X-SOD-CSRF: 1` + Origin listede).
  - Ön uçuş, uca kardeş kaydedilen aynı işaretli `OPTIONS` rotasındadır; karar yoldan değil işaretten okunur.
  - Diğer bütün uçlarda site kökeni ne CORS başlığı alır ne CSRF'i geçer (`403 CSRF_FAILED`, ön uçuş 404).
  - Site kökenine izinli başlıklar yalnız `accept-language` ve `X-SOD-CSRF`; `Authorization` ve `X-SOD-Org` yok. Uygulama kökenleri `ALLOWED_ORIGINS`tadır.
- **`SITE_ORIGINS` ayarı.** Geliştirme varsayılanı `http://localhost:8089,http://localhost:5190`. Üretimde zorunlu ve `https` (yalnız localhost serbest, APP_BASE_URL kuralı); yalın köken olmalı (yol, joker yok); `ALLOWED_ORIGINS` ile çakışırsa servis açılmaz, çünkü uygulama kökeni sayılan site her uca erişirdi. Compose geliştirmede varsayılanı verir, `docker-compose.prod.yml` `:?` ile ister.
- **Sitenin iki hali.**
  - Sunucu çıktısı "giriş yapılmamış"tır, betik yoksa da çalışır.
  - `site.js` `<body data-app>` kökenine kimlikli istek atar (3 sn zaman aşımı); giriş yapılmışsa üst çubukta "Merkez'e git" (`/home`) ve baş harf avatarı, panelde ad, firma, Merkez, Hesabım, Güvenlik, Firmalarım, Firma ve ekip (yalnız `canManageOrg`), Çıkış yap görünür. Ad ve firma `textContent` ile yazılır.
  - Hata veya zaman aşımında "giriş yapılmamış" kalır. Sekmeye dönüşte (`visibilitychange`) ve geri/ileri önbellekten gelişte (`pageshow`) yeniden yoklar.
  - Site CSP'si `connect-src 'self' <uygulama kökeni>` içerir; kök derlemede `nginx.conf`a yazılır.
- **Çıkış.** Siteden `POST {uygulama}/api/account/auth/logout` (`credentials: include`, `X-SOD-CSRF: 1`), ardından yeniden yoklama. Yoklama hâlâ giriş yapılmış derse veya istek başarısız olup yoklama yanıt vermezse arayüz "giriş yapılmamış"a geçmez, hata söyler. Merkez'den veya başka cihazdan (`DELETE /me/sessions/:id`) kapatılan oturum sitede bir sonraki yoklamada düşer.

### Yetki kuralları (güvenlik sınırı)

- Firma yöneticisi yalnız **üyeliği** yönetir: rol, araç rolü, askıya alma, çıkarma. Kişinin şifresine ve e-postasına dokunamaz.
- ADMIN, OWNER'ı değiştiremez ve ADMIN atayamaz; bunlar OWNER yetkisidir. Sahiplik devri yalnız OWNER'dan, şifre onayıyla. Son OWNER çıkarılamaz, askıya alınamaz.
- Kendi üyeliğini askıya alamaz, kendi rolünü düşüremez.
- **Telefon daveti:** 8 karakter Crockford base32, yalnız özeti saklanır, kod bir kez gösterilir, 72 saat, 20 hatalı denemede geçersiz (tek yer sözleşmede `JOIN_CODE_MAX_ATTEMPTS`; Hesap servisinde `MAX_CODE_ATTEMPTS`; asıl fren IP ve telefon + IP kovası).
  - Hakkı biten kod için yeni kod üretilmez (`409 INVITE_ATTEMPTS_EXHAUSTED`); Merkez Ekip ekranı satırda "Kodun hakkı bitti" yazar ve menüden iptal edip yeniden davete götürür.
  - Telefon zaten bir kişiye aitse kod **şifre belirletmez**: kişi mevcut şifresiyle onaylar ve üyelik eklenir (hesap ele geçirme kapısı kapalı).
- **Şifre unutan e-postasız çalışan:** yönetici yeni kod üretir, ancak kişi yalnız bu firmanın aktif üyesiyse ve e-postası yoksa.
  - E-postası varsa ya da birden çok firmadaysa üretilemez; ikisinde de nedeni ayırmayan tek yanıt döner (`RESET_CODE_NOT_ALLOWED`, `reason: 'SELF_RESET'`, "şifresini kendisi yenilemeli"): yönetici çalışanın başka firmada çalıştığını öğrenmez.
  - Askıdaki kişi `NOT_ACTIVE` ayrı kalır. Nedeni kişinin kendi ekranı söyler (`passwordRecovery`).
- E-posta daveti: bağlantı + "bağlantıyı kopyala" (posta sağlayıcı olmasa da çalışır), 7 gün. Var olan e-posta için önce giriş ister. Davet edenin e-postası yoksa ya da doğrulanmamışsa posta gitmez, kişi başına günde en çok 50 davet postası (`invite:mailby`); ikisinde de `mailSent: false`, bağlantı paylaşılır.
- **Posta:** `Mailer` arayüzü; `SMTP_URL` varsa nodemailer, yoksa `MailLog` + günlük (yalnız geliştirme).
  - `mailEnabled` = `SMTP_URL` var ya da (üretim dışı ve `DEV_MAILBOX=true`); compose geliştirmede posta kutusunu açar, Merkez "posta kapalı" demez, postalar `POSTA.bat` ile okunur.
  - **Üretimde `SMTP_URL` zorunlu, yoksa servis başlamaz.** `EMAIL_VERIFICATION_REQUIRED` varsayılanı `true`; üretimde `false` ise servis açılmaz.
- **Gönderim sonucu:**
  - Davet ve yeniden gönderme tek deneme yapar (en çok 8 sn), `mailSent` gerçek sonucu söyler; `false` ise Merkez "gönderildi" demez, bağlantıyı paylaştırır.
  - Şifre sıfırlama, e-posta doğrulama ve adres değişikliği bildirimi arka plandadır: yanıt ve süre hesabın varlığını ele vermez, geçici SMTP hatasında en çok 3 deneme yapılır (2 ve 8 sn ara), kalıcı hata tekrarlanmaz.
  - Günlükte işlem türü, hata sınıfı ve SMTP kodu durur; jeton, bağlantı, alıcı ve ham hata metni durmaz.
  - **Kuyruk süreç içidir ve kalıcı değildir:** süreç yeniden başlarsa denemesi süren posta kaybolabilir, kişi isteği yeniler. Düz metin jeton bu yüzden veritabanına yazılmaz; kalıcı kuyruk e-posta sağlayıcısı kararıyla birlikte değerlendirilir.

### Anlık iptal

Rol değişimi, askı, çıkarma, şifre değişimi: `Membership.epoch` artar, `Outbox`'a olay yazılır (aynı işlemde). Dağıtıcı ürüne iç adresten `POST /api/<ürün>/internal/events` gönderir: Ed25519 imzalı, `aud: 'product-events'`, idempotent, üstel geri çekilmeli. Ürün, jetondaki `ep < Member.epoch` ise `401 TOKEN_STALE` döner, istemci yeniler. Olay ulaşmazsa üst sınır jeton ömrüdür (10 dk).

**JIT projeksiyon:** Ürün, tanımadığı `mid`/`org` için jetondaki alanlardan `Member`/`Company` satırını açar (DeciShip varsayılan ayar ve kolileriyle). Böylece sağlama sırası önemsizdir.

### Ürün tarafı denetim sırası (`auth-kit`)

1. Jeton (çerez veya Bearer) doğrula. `org` yoksa `403 ORG_REQUIRED`.
2. `prod[ürün]` yoksa `403 NO_PRODUCT_ACCESS`.
3. `req.auth = { personId, membershipId, orgId, orgRole, productRole, subscription, permissions, name, locale }`.
4. `requirePermission('deciship.invoices.upload')`. Rol adı kodda hiç kullanılmaz.
5. `subscription.status != ACTIVE` ise durum değiştiren istek `403 READ_ONLY`.
