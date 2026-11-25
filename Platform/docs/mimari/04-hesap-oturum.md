# Mimari: Hesap uygulama kararları, bölüm 2 (§6 devamı)

Dizin ve diğer parçalar: `Platform/docs/ARCHITECTURE.md`. Bu dosya §6 "Hesap uygulama kararları (sözleşme boşlukları)" bölümünün devamıdır (başı ve uç listesi `03-hesap-api.md`). Maddeler bağlayıcıdır.

**Oturum**

- **Tek kilit sırası: kişi, sonra üyelik, sonra davet.**
  - Tek kullanımlık jeton da kişiden sonra gelir: doğrulama ve sıfırlamada jetonun sahibi önce okunur, kişi kilitlenir, sonra jeton harcanır. Birden çok kişi kimliğe göre sıralanır.
  - `lockMemberships` önce sahiplerini kilitler ve üyelik satırını kilitleyen tek yerdir (test denetler). Sıra karşıtı akış, şifre değişimi ile üye çıkarma gibi işlemleri karşılıklı bekletir.
  - Firma satırını kilitleyen abonelik işlemleri (§6 "Abonelik durumları") için sıra: **firma (`FOR NO KEY UPDATE`), abonelik, kişi, üyelik, davet**; hiçbir akış kişi ya da üyelik kilidinden sonra firmayı kilitlemez (`ordering.test.ts` denetler).
- İşlem dışında doğrulanan şifre (argon2 uzun sürer) kilit altında yeniden sınanır (`assertPasswordUnchanged`): özet değiştiyse `401 INVALID_CREDENTIALS`. Kapsam: giriş, yeniden özetleme, şifre değişimi, kimlik değişimi, devir, ayrılma. Davet kabulünde şifre zaten kilit altında doğrulanır. Böylece eşzamanlı şifre değişimi sonrası eski şifre oturum açamaz.
- Oturumu değiştiren her işlem önce kişi satırını kilitler (`lockPerson`). Döndürme yeni satır açar: kilit olmadan eşzamanlı iptal yeni satırı görmez, oturum şifre değişiminden veya çıkıştan sağ çıkar; firma değişimi de döndürülen eski satıra yazılıp kaybolur.
- `EMAIL_VERIFICATION_REQUIRED=true` (varsayılan) iken doğrulanmamış e-posta oturum almaz: giriş ve yenileme `403 EMAIL_NOT_VERIFIED` (web kabuğu ve mobil yenilemedeki bu yanıtı oturum bitti sayar, yeniden denemez), kayıt ve davet kabulü `202 { verificationRequired: true }`. E-postasız (yalnız telefonlu) kişide doğrulama yoktur. Kurallar aşağıda "E-posta doğrulaması".
- **`POST /auth/refresh`** aynı satır üzerinde kilitlenir. **Tolerans olaya ve süreye bağlıdır:**
  - Döndürülmüş eski jeton, ailenin başı bu eski jetonun sunumuyla doğduysa (`Session.parentId` = eski satır: yeni jeton henüz hiç kullanılmadı) ve `REFRESH_REUSE_GRACE_SECONDS` (varsayılan 60 sn) içinde gelirse aile düşmez. Amaç: çoklu sekme, kayıp yanıt ve mobilin zaman aşımından sonra yaptığı tekrarlar (ilk deneme 6 sn, iki tekrar, 7 sn pencere; yavaş ağda istek sunucuya geç de varabilir) kullanıcıyı atmasın.
  - **Tekrar anahtarı** (`retryKey`, gövdede, 32–128 karakter `[A-Za-z0-9_-]`, biçimsizse 400): istemci her yenilemeden önce rastgele anahtar üretir, eski jetonla birlikte saklar ve aynı jetonla her denemede aynısını gönderir (mobil: 32 bayt, `sod_refresh_retry` içinde `<jetonun SHA-256 özeti>:<anahtar>`; jeton değişince silinir, açılışta özet tutmazsa atılır). Yalnız mobil oturumda sayılır; web oturumunda gelen anahtar yok sayılır (hata değil). Döndürmenin açtığı satır özetini yazar (`Session.retryKeyHash`). Eski jeton, baş onun sunumuyla doğduysa ve baş aynı anahtarın özetini taşıyorsa **süre aranmaz**: telefon dakikalarca ağsız kalsa ya da uygulama yeni jetonu depoya yazamadan kapansa da oturum düşmez. Pencere dışında böyle geçen tekrar kişi düzeyinde `session.retry_accepted` (`meta: { ageSeconds }`) yazar. Anahtar yenilemeden hemen önce üretildiği için jetonun daha önce alınmış kopyası onu bilmez; o kopya için süre kuralı aynen sürer.
  - Gerçek üst sınır: aile üst yaşı (`SESSION_MAX_AGE_DAYS`) ve baş satırın bitişi geçerlidir; eski jetonun satırı da bitişinden (açılışından 30 gün) 7 gün sonra bakımla silinir (`lib/maintenance.ts`), sonra jeton tanınmaz (`401`, hırsızlık değil). Aynı eski jeton anahtarla pratikte en çok ~37 gün kullanılabilir.
  - `retryKey` jeton gibi gizlidir: istek gövdesini günlüğe ya da başka bir yere yazan bir şey eklenirse `refreshToken` ile birlikte gizlenmelidir.
  - Web'de ikinci istek yalnız erişim çerezi alır, mobilde baş satır döner (yeni satırın ebeveyni ve anahtar özeti yine eski sunumunkidir: aynı eski jetonla eşzamanlı istekler ve sonraki anahtarlı tekrarlar da geçer).
  - Yeni jeton bir kez kullanıldıktan sonra gelen eski jeton süre içinde de, doğru anahtarla da hırsızlıktır; çalınmış eski jeton toleransla yeni jeton alırsa, meşru sahibin elindeki jeton geldiğinde aile düşer (gidip gelme yok).
  - Süre dışında anahtarsız ya da başka anahtarla gelen tekrar da hırsızlık sayılır: aile iptal, epoch artışı, denetim kaydı `session.reuse_detected` (`meta: { ageSeconds, successorUsed, retryKey, headMissing }`; `successorUsed: true` güçlü hırsızlık işaretidir; `headMissing: true` ailenin başı yok demektir (yeni jetonun süresi doldu ya da bakım sildi): halefin kullanılıp kullanılmadığı bilinmez, anahtar karşılaştırılamaz, kayıt hırsızlık işareti sayılmaz; aile yine iptal edilir, epoch artar (güvenli taraf). Baş varken `successorUsed: false` ve `retryKey: false` geç gelen anahtarsız tekrar da olabilir; `successorUsed: false`, `retryKey: true` ve `headMissing: false` başı başka biri doğurmuş demektir, eski jetonu iki taraf tutuyor).
  - Bilinen sınırlar: web kabuğu anahtar göndermez (çerezli sekmeler ortak çerezle yeniler); yanıtı kaybolan web yenilemesi 60 sn'den sonra tekrarlanırsa oturum yine düşer. Anahtarlı istemcide hırsız, yeni jeton yanıtı yoldayken jetonu ve anahtarı birlikte ele geçirdiyse meşru sahiple ayırt edilemez (her jeton hırsızlığındaki gibi): ilk ayrışmada aile düşer.
  - Göçten önceki ailelerde ebeveyn yoktur, yalnız süre kuralı geçerlidir.
- **Çıkış ve oturum kapatma epoch artırır** (`POST /auth/logout`, `DELETE /me/sessions/:id`): kapatılan cihazın ürünlerdeki jetonu hemen düşsün, diğer cihazlar bir kez sessizce yeniler. Çıkışta artış yalnız gerçekten iptal edilen satır varsa olur: iptal edilmiş ailenin eski jetonuyla tekrar tekrar çıkış epoch'u şişiremez. Yalnız `sod_rt` ile gelen çıkışta (site) kişi yenileme satırından bulunur; süresi geçmiş erişim jetonu kimlik saymaz, başkasını etkileyemez.
- Etkin firma üyeliği biterse yenileme giriş kuralıyla başka firma seçer. `AuthResponse.activeOrgId` değişimi bildirir. Mobil kuyruk firma kapsamını buradan denetler.
- `Authorization` başlığı varsa yalnız ona bakılır, çereze düşülmez.
- CSRF çerez yazan uçlarda (`login`, `register`, `join/accept`, `invites/:token/accept`) çerez olmasa da denetlenir (giriş CSRF'i). `client: 'mobile'` çerez yazmaz, denetlenmez. `client` verilmezse `web` sayılır.
- Oturum çerezleri alan almaz. Yalnız `sod_lang` üst alan adında durur.
- `/org/*` jetonu etkin firmaya bağlıdır. `orgRole` `OWNER|ADMIN` dışında `/org` okuma hariç hepsi 403.

**Katılım**

- `join/preview` yanıtı `purpose: 'JOIN' | 'PASSWORD_RESET'` taşır. `PASSWORD_RESET`te `join/accept`in `password` alanı yeni şifredir ve kişinin tüm oturumları düşer.
- `join/accept`te geçerli kodla yanlış mevcut şifre de hakkı azaltır (20, `MAX_CODE_ATTEMPTS`). Yanlış kod telefondaki tüm bekleyen kodların hakkını azaltır. Sayaç satır kilidi altındadır, paralel istekle aşılamaz. Mevcut şifre girişle aynı kuralla sınanır (önce say, doğruysa geri ver; bilinen cihaz istisnası yok).
- E-posta daveti kabulü e-postayı doğrulanmış saymaz: bağlantıyı yönetici de görür. Davetle gelen yeni kişi ayrıca doğrulama postasını açar.

**E-posta doğrulaması ve bekleyen e-posta**

- **Değişiklik bekleyen adresle yapılır.**
  - `PATCH /me` (`currentPassword` ister) yeni adresi `pendingEmail`'e yazar; `email` ve `emailVerifiedAt` değişmez, eski adres onaya kadar geçerlidir. Adres başka kişinin `email`'iyse `409 EMAIL_TAKEN`.
  - Önceki bekleyen adresin bağlantıları silinir, denetim kaydı `person.email_change_requested`, yeni adrese onay postası, eski (mevcut) adrese hemen "değiştirme isteği" haberi gider (`email_change_requested`; yeni adresi ve onay bağlantısını içermez, tek bağlantı giriş sayfası).
  - `email: null` (adresi kaldırma) hemen uygulanır, bekleyeni de temizler. Bekleyen adrese davet, sıfırlama ve `resend-verification` postası gitmez.
- **`POST /auth/verify-email { token, password? }`** tek işlemde, kilit sırası kişi sonra jeton. Adres `token.email ?? person.email`:
  - Kişinin mevcut adresi: doğrulanır (`verified`, `person.email_verified`); aynı adrese giden öbür bağlantılar silinir.
  - **İlk doğrulamada şifre istenir** (adres mevcut adres ve henüz doğrulanmamış): bağlantı adresi kanıtlar ama şifreyi kimin koyduğunu kanıtlamaz (başkasının adresiyle kayıt, davetliye şifreyi yöneticinin koyması). Şifre yoksa `401 PASSWORD_REQUIRED` (sayılmaz), yanlışsa `401 INVALID_CREDENTIALS`; ikisinde de jeton harcanmaz.
    - Şifre giriş kovalarıyla sınanır (`login:ip`, `login:pair`, `login:person`; bilinen cihaz istisnası yok); işlem dışında doğrulanır, kilit altında özet yeniden karşılaştırılır. Gerçek sahibin çıkış yolu "şifremi unuttum"dur: sıfırlama adresi de doğrular, önceki şifre ölür.
  - Bekleyen adres: değişiklik onaylanır (`changed`, `person.identity_changed`); başka kişi bu arada aynı adresi aldıysa `409 EMAIL_TAKEN` (yarışta P2002 de). Kişinin kullanılmamış bütün jetonları silinir, eski adrese "adresiniz değişti" postası gider. Şifre istenmez: isteyen `currentPassword` verdi.
  - Başka her adres (eski bekleyen adres, değişmiş mevcut adres): `400 TOKEN_INVALID`.
  - Kullanılmış jeton, adresi kişinin şimdiki doğrulanmış adresiyse `already` (sayfa yenilenince "geçersiz" görünmesin); şifre istenmez.
- **Yeniden gönderme.**
  - `POST /auth/resend-verification` herkese açıktır, yanıt kişinin varlığına bakmaz, iş arka planda yürür (IP saatte 20, yazılan adres saatte 3 aşılırsa `429 TOO_MANY_ATTEMPTS`; ekran "gönderildi" yerine "biraz sonra deneyin" der).
  - Adres kovası kişi olsun olmasın aynı dolar; doğru şifreyle yapılan girişin kendiliğinden gönderdiği posta da bu kovayı sayar (sonucu beklenmez), böylece kişi kovası (5) dolmadan ekran dürüst yanıt alır.
  - `POST /me/email/resend` oturumludur: bekleyen adrese, yoksa doğrulanmamış mevcut adrese.
  - İkisi de kişi başına saatte 5 posta (`verify:mail`) ile sınırlıdır; girişte doğrulanmamış kişiye giden posta da bu sınıra tabidir.
- `resend` yeni kod veya bağlantı üretir, eskisi ölür, deneme sayacı sıfırlanır.

**Hız sınırı**

- Hedefi kimliğe göre alan yönetim uçları (`PATCH`/`DELETE /org/members/:id`, şifre kodu, devir) hedefi önce firmada arar, sonra kilitler: başka firmanın üyelik kimliği kilit beklemeden 404 alır.
- **Pencere 5 dk** (arayüz kalan süreyi geri sayımla gösterir): kimlik + IP 10, kimlik 30, kişi 30, bilinen cihaz kişi başına 30 (`login:known`), kod denemesi telefon+IP 10.
- **Pencere 15 dk:** giriş IP 100, kod denemesi IP 30; şifre onayı kişi 10; yönetim yazma uçları yapan yönetici başına 120 (`admin:write:<orgId>:<üyelik>`: `PATCH /org`, `PATCH`/`DELETE /org/members/:id`, `DELETE /org/invitations/:id`, `/org/roles*` yazmaları). Kova firma başına değil yapan başınadır: kötü niyetli ya da ele geçirilmiş bir yönetici kovayı doldurup sahibin onu askıya almasını engelleyemez.
- **Günlük (24 saat):** kişinin şifre denemesi 100 (`login:day`, §11), giriş kilidi bilgi postası kişi başına 1, davet postası davet eden kişi başına 50, alıcı başına 5.
- **Saatlik:** kayıt IP 5, şifremi unuttum kişi 3 (aşınca sessiz) ve IP 20, doğrulama yeniden gönderme IP 20 ve adres 3 (aşınca `429`), doğrulama postası kişi 5, firma daveti 100.
- Giriş kuralı §11. Kişi anahtarı özetlenerek yazılır.
- `TRUST_PROXY_HOPS` önündeki vekil sayısıdır (compose 1): gateway `X-Forwarded-For` değerini gerçek IP ile ezer (`$remote_addr`). Yalnız son değer okunur, istemcinin yazdığı sol taraf okunmaz.

**Anahtar döndürme**

`ACCOUNT_SIGNING_KEY` etkin özel JWK. Eskisinin açık alanları `ACCOUNT_PREVIOUS_PUBLIC_KEYS` dizisine eklenir, JWKS ikisini de yayınlar. Eski anahtar en az 15 dakika (jeton 10 + olay 5) yayında kalır. Komutlar `npm run keys:generate`, geliştirmede `npm run keys:rotate` (çalıştırma: `KURULUM.md`).

**Açılış korumaları** (`src/env.ts` `assertConfig`, `src/lib/demo.ts`)

- Üretim dışı kip (`NODE_ENV` production değil) yalnız yerel ya da özel ağ adresinde açılır: `APP_BASE_URL` `localhost`, `127.0.0.0/8`, `[::1]`, `*.localhost`, `10/8`, `172.16/12`, `192.168/16` değilse servis durur. Gerekçe: geliştirme kipinde postalar `MailLog`'a düşer, üretim denetimleri çalışmaz.
- Üretimde ek olarak: `EMAIL_VERIFICATION_REQUIRED` true, `SMTP_URL` dolu, hazır her ürünün olay adresi tanımlı olmalı.
- Üretimde veritabanında demo hesap (tohumdaki kişi kimliği ya da `@demo.sellerondata.com`) varsa servis açılmaz. Tek istisna `APP_BASE_URL`'in `localhost`, `127.0.0.1` ya da `[::1]` olması (yerel üretim sınaması); istisna istek başlığından değil ayardan okunur.
- Tohum (`src/seed.ts`, giriş `Platform/apps/account-api/scripts/seed.ts`) ve `Platform/scripts/demo.ps1` yerel olmayan `APP_BASE_URL`'de çalışmaz. Tohum demo e-postalarını doğrulanmış yazar. Tohum imajda kalır (demo betiği aynı imajı kullanır). Tohum yazdıklarını sayar ve `SEED-OK` satırıyla biter; demo betiği bu satırı ve demo sahibiyle girişi görmeden "yüklendi" demez.
- `SESSION_MAX_AGE_DAYS` ve `ORG_PURGE_DAYS` 1–3650 tam sayı, `DEV_MAILBOX` true/false; yanlış yazım açılışı durdurur.
- Üretimde `PRODUCT_EVENT_TARGETS` adresleri yalın `http(s)` olmalı: kullanıcı adı, parola, sorgu, parça yok; olay gövdesi üye adı ve rol taşır, yanlış yazılmış adres 72 saat yanlış yere denenmesin. Hata metni adresi yazmaz.

**Olaylar ve abonelik**

- Olay jetonu gövdesi `contracts/EventClaims`: `{ event, occurredAt, jti == eventId }`. `event.product`, alıcının ürünüyle aynı olmalı. Her denemede yeniden imzalanır, eventId değişmez.
- **Tanınmayan olay türü** imza ve biçim denetiminden sonra, işaretlenmeden ve işlem açılmadan `422 UNKNOWN_EVENT_TYPE` ile reddedilir; "işlendi" sayılmaz. Dağıtıcı bunu hata sayıp yeniden dener, 72 saatte `DEAD` olur, `outbox:requeue` ile geri alınır. Kural: yeni olay türü eklenirken önce ürünler güncellenir, sonra Hesap o türü yazar.
- **Alıcı sözleşmesi (bağlayıcı):** adımlar tek işlemdedir.
  - Önce `eventContext` (RLS bağlamı, `event.orgId`). `memberEpoch` satırı `FOR UPDATE` ile okur.
  - Yazma, satır yokken de koşulludur: `ON CONFLICT (id) DO UPDATE ... WHERE epoch <= EXCLUDED.epoch`.
  - Düz okuma eşzamanlı olayda askıyı kaybettirir, bağlamsız okuma iptali "işlendi" diye yutar. `auth-kit/testing` içindeki `runEpochRaceCheck` bunu gerçek veritabanında sınar.
- Dağıtıcı aynı üyenin (veya aynı firma + olay türünün) olaylarını bir turda sıralı, epoch sırasıyla gönderir; farklı üyeler paralel gider. Sıra koruması alıcı sözleşmesinin yerine geçmez: birden çok kopya ve yeniden deneme yine yarışabilir.
- **`org.updated`** adla birlikte `currency`, `country`, `timeZone` ve `companyConfirmed` taşır (isteğe bağlı alanlar; yoksa eski biçim olaydır, alıcı kendi değerine dokunmaz).
  - `companyConfirmed` her olayda o anki değerdir (`companyConfirmedAt !== null`; ilk olay `false`, yeniden duyurular dahil).
  - Firma açılışında da gider; ad, para birimi, ülke, saat dilimi değişince ya da firma ilk kez onaylanınca sürüm artar ve yeniden gider; dil ürüne gitmez. Ayrıntı §6 "Firma dili ve saat dilimi".
  - Ülkeye bağlı hukuk kuralı üründe uygulanır: DeciShip Türk Ticaret Kanunu süresini yalnız ülkesi TR olan firmada gösterir. Alan hiç gelmemişse: sürümlü olay almış firmada para birimi TRY ise TR, değilse bilinmiyor; hiç olay almamış firmada bilinmiyor; bilinmiyorsa süre gösterilmez.
  - Eski firmalar `npm run org:announce` (imajda `node dist/org-announce.js`) ile tek seferde tamamlanır, tekrar çalıştırmak zararsızdır.
- `org.updated` ve `subscription.updated` `version` taşır (`Organization.version`, `Subscription.version`, satır kilidi altında artar). Küçük sürüm uygulanmaz: eski CANCELED yeni ACTIVE'i ezmez. Alıcı `currentVersion` kancasıyla denetler; yerelde tutmuyorsa gerekmez.
- `org.closed` (`closedAt`, `purgeAfter`, `version`), `org.reopened` (`version`), `org.purged` (sürümsüz, son olay): firma kapatma (§6 "Firmayı kapatma"). `version` `org.updated` ile aynı sayaçtır (`Organization.version`); alıcı kapalılık durumunu sürümle saklar, küçük ya da eşit sürüm uygulanmaz. `org.purged` her durumda uygulanır, tekrarı zararsızdır, sonra gelen gecikmiş olay firmayı yeniden kurmaz.
- `member.upserted` rolün firmadaki geçerli izinlerini (`permissions`) de taşır; alan yoksa alıcı izinleri `role`'den katalogla türetir (DeciShip `Member.permissions` null).
- `member.removed` `personId` ve `name` da taşır: tanınmayan üye için pasif kayıt açılabilsin, geç gelen eski jeton JIT ile üyeyi geri açamasın.
- **Geri verilen rol:** jetonda ürün yok ama `ep < Member.epoch` ise `401 TOKEN_STALE`: istemci yeniler, 10 dakika beklemez. Üye yok veya epoch güncelse `403 NO_PRODUCT_ACCESS`, `details.refreshable: true` (ilk kez verilen rol, gecikmiş olay): istemci bir kez sessizce yeniler, yine aynıysa gösterir. Bu yüzden üye kaydı ürün denetiminden önce okunur.
- **Ürün tarafı:**
  - `ep > Member.epoch` ise yerel kayıt jetondan koşullu güncellenir (`WHERE epoch < $jeton`), sonuç yeniden okunur. JIT yalnız ekler (`ON CONFLICT DO NOTHING`), mevcut satırı döner: araya giren iptal geri alınmaz. Eşitleme üyeyi etkin de yazar (DeciShip `identity.ts` ve product-kit `identity.ts` `syncMember`, aynı kural): Hesap jetonu yalnız `ACTIVE` üyeliğe ve o anki epoch'la basar, her askı ve çıkarma epoch'u artırır; yerelden büyük epoch'lu jeton, yerel pasifliği yazan olaydan sonraki etkin hali kanıtlar (askıdan dönüş olayı DEAD olsa da çalışan döner). Eşit epoch'lu jeton pasif kaydı açmaz; sonra gelen askı olayı yine kapatır. Bilinçli kabul (KARARLAR "Askı ve çıkarma araçta"): dönüş olayı gelmeden yeni askı olayı da gecikirse arada basılmış jeton en çok jeton ömrü (10 dk) erişim verir. **Çıkarma kalıcıdır:** `member.removed` kaydı `removedAt` ile işaretler, eşitleme o kayda hiç dokunmaz (jeton kaç olursa olsun pasif).
  - Eşitlemeden sonra `ep < epoch` ise `401 TOKEN_STALE`, yerel kayıt pasifse jeton kaç olursa olsun `403 FORBIDDEN`.
  - Aynı adlı birden çok `sod_at`/`sod_rt` çerezi `401`: alt alan adından yazılan çerez firmalar arası oturum sabitleme yoludur.
- **JWKS önbelleği:** bilinen `kid` Hesap kesikken 1 saate kadar çalışır, sonra `503` (iptal edilen anahtar süresiz geçerli kalmaz; Hesap kesikken yeni jeton basılamadığı için açık oturumlar bu pencerede zaten biter). Bilinmeyen `kid` hemen getirilir; 1 sn içinde başarılı getirme olduysa `401`, son getirme başarısızsa 5 sn `503`. Ürün Hesap kesikken yeniden başlarsa önbellek boştur, Hesap dönene kadar `503`.
- `prod` içinde `CANCELED` abonelik `deleteAfter` geçene kadar durur (salt okunur). Sonra ürün düşer.
- SMTP yokken üretimde posta içeriği hiçbir yere yazılmaz: sıfırlama bağlantısı parola yerine geçer. `MailLog` ve günlük yalnız geliştirmede.
