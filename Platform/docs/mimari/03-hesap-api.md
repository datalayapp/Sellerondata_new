# Mimari: Hesap API uçları ve uygulama kararları, bölüm 1 (§6)

Dizin ve diğer parçalar: `Platform/docs/ARCHITECTURE.md`. §6'nın devamı (Oturum, Katılım, E-posta doğrulaması, Hız sınırı, Anahtar döndürme, Açılış korumaları, Olaylar ve abonelik) `04-hesap-oturum.md`, abonelik durumları, firma dili ve araç bildirimi `05-abonelik-bildirim.md` dosyasındadır.

## 6. Hesap API (`/api/account`)

```
GET  /.well-known/jwks.json
GET  /health
GET  /client-policy                           mobil sürüm politikası (§11 "Mobil sürüm uyumu")
GET  /catalog                                 ürünler, roller, izin açıklamaları (locale'e göre)
POST /auth/register                           { orgName, name, email, password, country, locale, signupInvite? }  firma + OWNER + DeciShip ACTIVE + DeciShip ADMIN; doğrulama açıkken 202 { verificationRequired: true }
POST /auth/login                              { identifier, password, client }  doğrulanmamış e-posta: 403 EMAIL_NOT_VERIFIED (posta kendiliğinden yeniden gider)
POST /auth/refresh                            mobil gövde { refreshToken, retryKey? } / web çerez; üst yaş dolunca 401
POST /auth/logout                             site kökeninden de (CSRF + SITE_ORIGINS); epoch artırır (aşağıda "Oturum")
GET  /auth/site-session                       sitenin "kimim" yoklaması, salt okunur: { signedIn, name?, orgName?, canManageOrg? } (§5 "Tek hesap")
POST /auth/switch-org                         { orgId }
POST /auth/forgot-password | /auth/reset-password
POST /auth/verify-email                       { token, password? }  -> { ok, result: 'verified'|'changed'|'already' } (aşağıda "E-posta doğrulaması")
POST /auth/resend-verification                { email }  herkese açık, yanıt { ok: true }; adres başına sınır doluysa 429
POST /orgs                                    { name, country? }  giriş yapmış kişi firma açar: OWNER + DeciShip ACTIVE + DeciShip ADMIN, yeni firma etkin olur
POST /auth/join/preview                       { phone, code } -> { orgName, name, personExists }
POST /auth/join/accept                        { phone, code, name?, password, client }  kişi varsa password mevcut şifredir
GET  /invites/:token  POST /invites/:token/accept
GET  /me  PATCH /me                           kişi (pendingEmail dahil), firmalar, etkin firma, ürün durumları, izinler; e-posta değişikliği bekleyen adrese yazılır
POST /me/email/resend                         {}  -> { ok, sentTo: 'pending'|'current'|null }  kişi başına saatte 5
DELETE /me/pending-email                      bekleyen e-posta değişikliğinden vazgeç (tekrar çağrılabilir)
POST /me/password
GET  /me/sessions  DELETE /me/sessions/:id
GET  /org  PATCH /org                         { name?, country?, currency?, locale?, timeZone?, confirmCompany?: true }  -> { id, name, country, currency, locale, timeZone, companyConfirmedAt }; yönetici; ad, ülke, para birimi, saat dilimi değişince ya da ilk onayda org.updated (tekrar onay zararsız, sürüm artmaz)
POST /org/leave                               { password? }  kişi etkin firmadaki üyeliğinden çıkar, jeton sonraki firmaya veya org: null'a geçer
GET  /org/members
POST /org/members/invite                      { kind, email|phone, name, orgRole, productRoles }  -> PHONE_CODE ise { code } bir kez, EMAIL ise { link, mailSent } (posta gerçekten gittiyse true)
PATCH /org/members/:id                        { orgRole?, productRoles?, status? }
DELETE /org/members/:id
POST /org/members/:id/reset-code
POST /org/transfer-ownership                  { membershipId, password }
GET  /org/roles  POST /org/roles              araç rolleri (hazır + özel); POST { product, name, description?, permissions, basedOn? } -> 201 { role }
PATCH /org/roles/:id                          özel rol { name?, description?, permissions?, version }  (iyimser kilit)
PATCH /org/roles/builtin/:product/:key        hazır rolü firmada düzenle (aynı gövde)
DELETE /org/roles/:id  DELETE /org/roles/builtin/:product/:key   ?reassignTo= (kullanılan rol önce taşınır)
POST /org/roles/builtin/:product/:key/reset   hazır rolü katalog haline döndür
POST /org/close                               { confirmName, password }  yalnız OWNER; -> AuthResponse + { closedAt, purgeAfter }
POST /org/reopen                              { orgId, password }  kapalı firmanın OWNER'ı, saklama süresinde; etkin firma gerekmez -> AuthResponse
GET  /org/invitations  POST /org/invitations/:id/resend  DELETE /org/invitations/:id
GET  /org/subscriptions
POST /org/billing/*                           501 PAYMENT_NOT_AVAILABLE placeholder
GET  /org/audit
POST /internal/notify                         araç bildirimi; yalnız iç ağ, ürün anahtarıyla (aşağıda "Araç bildirimi")
POST /operator/step-up                        { password }  -> { token, expiresAt }  yalnız platform yöneticisi, tarayıcı oturumu, CSRF; yapay zekâ geçidinin değiştiren yönetici uçları için 5 dk jeton (aud ai-admin; §11 "Yapay zekâ geçidinde yönetici yetkisi")
```

- Platform yöneticisi (`PLATFORM_OPERATORS`, yalnız doğrulanmış ve askıda olmayan kişi): erişim jetonunda `op: true`, `/me`'de `platformOperator: true`; firmadan bağımsızdır. Hesap, firma ve abonelik olaylarını ürünlere ek olarak platform hizmetlerine de dağıtır (`PLATFORM_SERVICE_TARGETS`, bugün yalnız `ai`: `org.updated`, `org.closed`, `org.reopened`, `org.purged`, `subscription.updated`); `org.purged` hizmete de DEAD olmadan teslim edilene dek gider.

- Hata gövdesi her serviste aynı: `{ error: { code, message, details? } }`. `message` `Accept-Language`'a göre yerelleşir. Web ve mobil her isteğe `Accept-Language` koyar.
- `/org/roles*` uçları yönetici (OWNER/ADMIN) ister; mantık `account-api/src/lib/roles.ts`, `roleBook.ts`. Ürün kararı: KARARLAR.md "Özel roller". Rolün firmadaki geçerli izinleri jetonda (`prod[ürün].perms`) ve `member.upserted` olayında (`permissions`) gider; alan yoksa eski biçimdir, izin rolden katalogla türetilir.

### Hesap uygulama kararları (sözleşme boşlukları)

Bu maddeler Hesap servisi yazılırken netleşti, bağlayıcıdır. Bölüm burada başlar, `04-hesap-oturum.md`'de sürer.

**Veri**

- `Invitation.kind` üçüncü değeri `PHONE_RESET`: yöneticinin ürettiği şifre kodu. `targetPersonId` ile kişiye bağlıdır. `PHONE_CODE` şifre belirletmez, `PHONE_RESET` belirletir; bu yüzden ayrı türdür.
- `Session` satırı her döndürmede yenilenir. Döndürülmüş (`rotatedAt`) ile iptal edilmiş (`revokedAt`) ayrıdır. Ailede tek etkin baş vardır (kısmi benzersiz dizin). `sid` satır kimliğidir; önceki satırla basılmış erişim jetonu ömrünü doldurur.
- **Olay teslimi** `OutboxDelivery` tablosundadır:
  - Her olay için teslim satırı açılır; ürünün adresi (`PRODUCT_EVENT_TARGETS`) tanımsızsa satır bekler, olay kaybolmaz. Üretimde kapalı (`off`) olmayan her ürünün adresi zorunludur, yoksa servis açılmaz; geliştirmede açılış uyarı yazar. Adres listesinde bilinmeyen ürün, tekrar ya da boş adres her ortamda servisi durdurur; hata metni adresi yazmaz.
  - Satır `SKIP LOCKED` ile sahiplenilir, ağ çağrısında kilit tutulmaz (60 sn kira). En az bir kez teslim. Üstel geri çekilme, üst sınır 1 saat; 72 saat sonra `DEAD`. Geç gelen hata başka kopyanın sonucunu bozmaz.
  - Günlük her bakım turunda DEAD satırlar için uyarır (kaç tanesinin üyelik olayı olduğunu ayrıca yazar); `node dist/outbox-requeue.js` (geliştirmede `npm run outbox:requeue`) geri alır. 30 günde silinmeden önce denetim izine `outbox.dead_purged` yazılır.
  - Üyelik olayı DEAD kalırsa araç kaydı geride kalır ama çalışan kilitli kalmaz: araç (DeciShip ve product-kit ile yazılan her araç), yerel kayıttan büyük epoch'lu ilk jetonla kaydı eşitler ve askıdan dönen çalışanı açar; çıkarılmış üyenin kaydı (`member.removed`) hiç açılmaz (§5 "Ürün tarafı"). Ad ve rol listesi o girişe dek eski kalır; hepsini hemen eşitlemek için `outbox-requeue` (`KURULUM.md` "Teslim edilemeyen olaylar").
- Veritabanı kuralları uygulamayı atlasa da geçerlidir: firmada tek OWNER (kısmi benzersiz dizin), en az bir OWNER (işlem sonu tetikleyici), OWNER askıda olamaz, kişide en az bir kimlik, küçük harf e-posta, E.164 telefon, firmada kişi başına tek bekleyen davet.
- `_prisma_migrations` ve migration rolü: §4.

**Yetki**

- Şifre kodu üretildiği andaki role bağlıdır: rol değişimi ve devir hedefin bekleyen kodunu iptal eder, kabulde rol `Invitation.orgRole` ile karşılaştırılır. `resend` kodu bilen yöneticiyi `invitedById`e yazar: yetkisi düşerse kod da düşer. Hakkı biten kod `resend` edilemez (`409 INVITE_ATTEMPTS_EXHAUSTED`), davet iptal edilip yeniden açılır.
- Firma yazmaları (`/org`, `/org/*`) yalnız tarayıcı oturumuyla; mobil yalnız telefonla çalışan daveti açar (§5 "Firma yönetimi yalnız tarayıcı oturumuyla", `routes/org.ts` `guardOrgWrites`).
- ADMIN yalnız MEMBER yönetir. Başka ADMIN'e, OWNER'a ve OWNER'ın açtığı ADMIN davetine dokunamaz. Şifre kodu da aynı kurala tabidir: ADMIN, OWNER veya ADMIN için kod üretseydi o hesabı ele geçirirdi.
- Kendini yönetme yasağının tek istisnası: OWNER kendi araç rolünü değiştirebilir, çünkü onu yönetebilecek başkası yoktur. Kişi firmadan `POST /org/leave` ile ayrılır, `DELETE /org/members/:id` kendine uygulanmaz.
- Tek OWNER kendini çıkarır, askıya alır veya düşürürse `LAST_OWNER`; ADMIN denerse `CANNOT_MANAGE_OWNER`.
- Hesap yetkiyi jetondan değil veritabanından, satır kilidi altında okur. Üyelik yoksa, askıdaysa, `mid` eşleşmiyorsa veya `ep < epoch` ise `401 TOKEN_STALE`.
- Yetkisi düşen yöneticinin (askı, MEMBER'a düşme, çıkarma) bekleyen davetleri iptal olur.
- **Devirde** eski sahip ADMIN olur: sahipken açtığı yönetici rolündeki davetler ve yöneticiye ürettiği şifre kodları (`orgRole` MEMBER olmayan, `invitedById` kendisi) düşer (`revokeOwnerOnlyInvitationsBy`); üye düzeyindeki davetleri kalır (ADMIN de açabilir).
- **Kabulde üretenin bugünkü yetkisi:** katılma kodu, şifre kodu ve e-posta daveti önizleme ve kabulde (`join/preview`, `join/accept`, `GET /invites/:token`, `POST /invites/:token/accept`) denetlenir: `invitedById` üyeliği bugün etkin mi ve bu daveti (`authorizeInvitedRole`) ya da bu kişiye şifre kodunu (`authorizeMemberChange`, `resetCode`) hâlâ verebilir mi (`members.ts` `inviterStillAuthorized`).
  - Değilse `400 INVITE_INVALID`, hak düşmez. İptal yollarından biri unutulsa da eski yetkiyle üretilmiş kod çalışmaz. Okuma kilitsizdir: devirle eşzamanlı kabul devirden önce yapılmış sayılır.
- Kod üretildikten sonra kişi başka firmaya girer veya e-posta eklerse kod ölür: koşullar kabul anında yeniden denetlenir.
- Sahibe özel izinli rolü yalnız OWNER davetle verdiği için, süresi geçmemiş bekleyen davetini OWNER olmayan birinin açtığı role sahibe özel izin eklenmez (düzenleme, varsayılana dönüş) ve silmede davet böyle role taşınmaz: `403 ROLE_FORBIDDEN`, `details: { reason: 'pending_admin_invites', permissions, invitations: [{ id, name, contact }] }`, davetler iptal edilmez (`roles.ts` `assertInvitesKeepInviter`). Süresi geçmiş davet engel değildir (yeniden gönderme yetkiyi yeniden sınar).
- `resend` davetin rollerinin ürün kilidini (paylaşımlı) davet satırından önce alır: rol düzenlemesiyle (özel kilit) yarışıp sahibe özel izin denetiminde eski tanımı okumaz.

**Firma açma ve ayrılma**

- `POST /orgs`: `REGISTRATION_ENABLED=false` iken `403 REGISTRATION_CLOSED`, `SIGNUP_MODE=invite` iken `403 SIGNUP_INVITE_REQUIRED` (kayıt daveti bu uçta kullanılmaz). Kişi 5, IP 20 / saat. Kayıtla aynı yol: abonelik `early_access` `ACTIVE`, deneme süresi yok.
- `POST /org/leave`: OWNER `409 LAST_OWNER`, önce devreder. Üyelik silinir, `member.removed` `epoch + 1` taşır, kişinin bu firmadaki bekleyen davetleri düşer, denetim izine `member.left` yazılır. Yanıt `AuthResponse`: etkin firma giriş kuralıyla seçilir, üyelik kalmazsa `org: null`. Askıdaki üye ayrılamaz: etkin firması yoktur, yönetici çıkarır.
- **Parola:** e-postalı kişi için istenmez (etki yalnız kişinin kendi erişimidir, yeniden davetle döner, CSRF ve oturum zaten gerekir). **E-postasız kişide istenir** (`403 PASSWORD_CONFIRM_REQUIRED`): üyelik sayısı şifre kodu koşuludur; çalınmış oturumla ikinci firmadan ayrılmak, kalan firmanın yöneticisine şifre kodu üretme yolu açar ve geçici oturum kalıcı hesap ele geçirmeye dönerdi.
- Son firmadan ayrılan e-postasız kişinin şifre kurtarma yolu kalmaz. `me.account.passwordRecovery` bunu söyler (`email`, `org_admin`, `none`), arayüz ayrılmadan önce uyarır ve e-posta eklemeyi önerir.
- `me.account`: `canCreateOrg`, `canLeaveActiveOrg`, `leaveRequiresPassword`, `passwordRecovery`, `defaultCountry`. `activeOrg` null ise "firma oluştur" ekranı bununla kurulur. `orgs` askıdaki üyelikleri de listeler. Bekleyen davetler listelenmez: e-posta doğrulanmadan başkasının adresine gelen davet ele verilirdi.
- **Firmayı kapatma** (mantık `account-api/src/lib/orgClosure.ts`; ürün kararı KARARLAR.md "Firma kapatma ve silme"):
  - `POST /org/close` yalnız OWNER. `confirmName` firma adıyla aynı değilse (`confirmNameMatches`: kırpılır, Türkçe küçük harf) `400 CONFIRM_NAME_MISMATCH` (şifre kovasını harcamaz); şifre `passwordConfirm` kovasıyla (`401 INVALID_CREDENTIALS`, `429`).
  - Tek işlemde: `Organization.closedAt/closedById/purgeAfter` (`ORG_PURGE_DAYS`, varsayılan 30) yazılır, firma sürümü ve bütün üyeliklerin epoch'u artar, bekleyen katılma davetleri düşer, üyelerin `lastOrgId` ve oturumlarının etkin firması boşalır, `org.closed` denetimi ve olayı. Abonelik satırlarına dokunulmaz.
  - Kapalı firma: `chooseActiveOrg` ve jeton (`buildAccessPayload`) onu seçmez, `switch-org` `409 ORG_CLOSED`, `requireMember` `409 ORG_CLOSED` (epoch'tan sonra çift güvence), araç bildirimi gitmez, davet ve `product:launch` kapalı sayar (`isOrgClosed`).
  - `/me` `orgs[]`'te yalnız sahibine `orgStatus: 'CLOSED'`, `closedAt`, `purgeAfter` ve firmanın saat dilimi `timeZone` ile görünür (Merkez tarihleri bununla yazar: kapalı firma etkin olamadığından kabuğun saat dilimi başka firmanındır); diğer üyelerde yoktur.
  - `POST /org/reopen`: o firmanın OWNER'ı değilse `404 ORG_NOT_FOUND`, açık firma `409 CONFLICT`, süre dolmuş `410 ORG_PURGED`; alanlar boşalır, sürüm ve epoch artar, `org.reopened`, firma etkin olur (düşen davetler dönmez).
  - **Kalıcı silme:** saatlik bakım (`purgeDueOrgs`) `purgeAfter <= now` firmaları tek tek, kilit sırasıyla ve koşulu kilit altında yeniden denetleyerek siler. Aynı işlemde aboneliği olan ya da daha önce olay almış her ürüne (araç kapalı olsa da; teslim edilene dek denenir, DEAD olmaz) `org.purged` gider ve denetim `org.purged` yazılır (`orgId` boş, `target` firma, `meta.ownerPersonId`: silinmiş firmayı geri açmak isteyen sahibe `410`).
  - Silme zincirlemedir (üyelik, araç rolü, abonelik, davet, bildirim izi, firma rolleri); kişiler ve firmanın eski denetim kayıtları kalır. Tekrar zararsız.
- `me.activeOrg.companyConfirmedAt` (Merkez kurulumu): firma bilgileri onaylandığı an (ISO) ya da `null` (onay bekliyor). Kural `isCompanyConfirmed` (contracts): alan yoksa (eski sunucu) onaylı sayılır. Onay `PATCH /org { confirmCompany: true }` ile, yalnız yönetici.
- `GET /catalog` `registrationEnabled` ve `signupMode` taşır: kayıt sayfası kapalıyken form göstermez, `invite` iken davet bağlantısı (`?invite=`) olmadan form yerine "yalnız davetle" açıklaması ve destek postası gösterir. `me.account.canCreateOrg` `invite` iken `false`.

**Kayıt yalnız davetle** (kapalı deneme)

- `SIGNUP_MODE=open|invite`. Yazılmazsa üretimde `invite`, yerelde ve testte `open`; başka değer açılışı durdurur (`assertConfig`). `REGISTRATION_ENABLED=false` her kipte önce gelir.
- Kayıt daveti `SignupInvite` tablosundadır (alanlar §4; jetonun yalnız SHA-256 özeti saklanır, `createdBy` operatördür). Firmaya ekip daveti (`Invitation`) ayrıdır ve bu kipten etkilenmez.
- Üretim yalnız destek komutuyla: `signup:invite --email <adres> --operator <ad> [--days 14] [--lang tr|en]` (1–90 gün). Çıktı bağlantı `APP_BASE_URL/register?invite=<jeton>`; posta gönderilmez. İz `support.signup_invite_created` (adres ve jeton yazılmaz). İptal ve liste: `signup:invite --revoke <adres>` (bekleyen davetlerin süresi şimdiye çekilir, iz `support.signup_invite_revoked`), `--list` (jetonsuz). Çalıştırma: `KURULUM.md` "Destek komutları".
- `POST /auth/register` gövdesi `signupInvite` taşır:
  - `invite` kipinde yoksa `403 SIGNUP_INVITE_REQUIRED` (hız kovasından önce).
  - Varsa kişi ve firma açıldıktan sonra aynı işlemde tek koşullu güncellemeyle harcanır: jeton, adres = kaydın adresi, kullanılmamış, süresi geçmemiş. Tutmazsa `403 SIGNUP_INVITE_INVALID` ve bütün işlem geri alınır (kişi, firma açılmaz, davet harcanmaz).
  - Davet adres denetiminden önce (salt okuyarak) sınanır: davetsiz ya da uydurma davetle `EMAIL_TAKEN` yanıtı alınmaz, kayıt ucu adres yoklamasına dönmez; geçerli davetle `EMAIL_TAKEN` daveti harcamaz.
  - Eşzamanlı iki kayıttan yalnız biri geçer. İz `signup.invite_used` (firma, kişi, davet kimliği).
  - `open` kipinde alan ne olursa olsun yok sayılır (uzun ya da bozuk değer 400 değil); `invite` kipinde metin değilse ya da 200 karakteri aşarsa `SIGNUP_INVITE_INVALID`, boşsa `SIGNUP_INVITE_REQUIRED`.
- Jeton sorguda olduğu için `/register` erişim günlüğünde sorgusuyla maskelenir (`gateway/conf/access-log.conf`: `/register?[gizli]`; gateway, Merkez ve DeciShip paneli nginx'i aynı biçimi kullanır) ve sayfa `Referrer-Policy: no-referrer` gönderir (gateway `$sod_referrer_policy`, Merkez `nginx.conf`).
- Davetle açılan kayıt `signup:purge` adayı olmaz (denetim izinde `signup.invite_used` vardır).
- Site derlemesi aynı adı okur: `invite` iken "Hesap aç" düğmeleri "Erken erişim isteyin" (`mailto:` destek) olur; `open` çıktısı değişmez. Site imajının varsayılanı `invite` (argümansız üretim derlemesi açık kayıtlı site çıkarmasın); yerel compose açıkça `open` verir, `npm run build` değişkensiz `open`.
