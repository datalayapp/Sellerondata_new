# Kod haritası — Platform

Yollar depo köküne göredir.

## Platform

### Hesap servisi

Kök `Platform/apps/account-api` (`/api/account`).

Rotalar ve genel yapı:

- `src/app.ts` rota kaydı. `src/routes/`: `auth.ts` (kayıt, giriş, yenileme, site oturumu, şifre), `join.ts` (davet, katılma), `me.ts` (profil, oturumlar), `org.ts` (firma, üyeler, roller, devretme, abonelik, denetim izi), `public.ts` (health, JWKS, katalog, `client-policy`: mobil sürüm politikası).
- 426 kancası `src/app.ts` (`UPGRADE_EXEMPT`; test `test/clientPolicy.test.ts`).
- İş mantığı `src/lib/`: `orgs.ts`, `members.ts`, `sessions.ts` (oturum üst yaşı `familyExpired`), `rateLimit.ts` (`RATE_RULES`, `hitRateLimit`, `refundRateLimit`, `isKnownDevice`), `outbox.ts` + `dispatcher.ts` (ürüne olay gönderir), `tokens.ts`, `keys.ts`, `siteSession.ts`, `mailer.ts` (şablonlar), `demo.ts` (üretimde demo hesap denetimi).
- Açılış denetimleri `src/env.ts` (`assertConfig`, `assertProductionConfig`, `isLocalHostname`); demo tohumu `src/seed.ts` (`assertSeedAllowed`).
- E-posta doğrulaması ve bekleyen e-posta: `routes/auth.ts` (`verify-email`, `resend-verification`, `issueOneTimeToken`), `routes/me.ts` (`PATCH /me`, `/me/email/resend`, `/me/pending-email`).
- Şema `prisma/schema.prisma`; metinler `src/i18n.ts`.
- Testler `test/*.test.ts`: izin matrisi `matrix.test.ts`; doğrulama `emailVerification`; giriş sınırı `loginLimits`; oturum ve çıkış `sessionLimits`; davet postası `inviteMail`; açılış ve demo `startupGuards`.
- Merkez sahte API: `hub-web/src/mocks/browser.ts` (yalnız tarayıcıda başlatma) + `handlers.ts` (işleyiciler, Node'da da) + `db.ts`; araç uçları `hub.ts` (araç kaydından; örnek üretici `deciship.ts`, yoksa `e2e/fixtures/<anahtar>-real`, yoksa boş). Hesap yanıtı değişirse: account-api `npx vitest run test/hubWebFixtures.test.ts -u`, sonra hub-web `npm test` (`test/account-contract.test.mjs`, kayıt `e2e/fixtures/account-real`). Yeni aracın web paneli: `Platform/templates/tool-web/` (README).
- Firma kapatma: DeciShip ve product-kit `syncMember` jetonla askıdan dönen pasif üyeyi açar (epoch büyükse), `member.removed` ile yazılan `removedAt` kaydını asla açmaz; kapalı firmanın tarihleri `/me` `orgs[].timeZone` (Merkez `closeOrg.ts`); geri açma iletisi `noteReopened`/`useReopenedNotice`; `ORG_CLOSED` okumasında `/me` yenilenir (`App.tsx`); DeciShip silme sırası `maintenance.ts` `companyPurgeQueue` (`attemptedAt`).
- Firma yazması yalnız tarayıcıdan: `account-api/src/routes/org.ts` `guardOrgWrites` + `src/auth.ts` `isWebSession`; mobil istisnası (telefon kodlu çalışan daveti) `mobileGrantable`; test `test/matrix.test.ts`, yardımcı `test/helpers.ts` `asWeb`/`webTokenFor`. Sahibe özel izin ve bekleyen yönetici daveti: `src/lib/roles.ts` `assertInvitesKeepInviter` (`pending_admin_invites`), `test/ownerOnlyInvites.test.ts`.
- Yerel posta kutusu `Platform/scripts/posta.ps1` + `Platform/POSTA.bat` (`MailLog` okur).
- Gerçek kullanıma geçiş: `Platform/scripts/gercek-kullanim.ps1` (+ `.test.mjs`; `-KuruCalisma`, yedek → `.env` → demo sıfırlama → denetim → davet); işaret `SOD_GERCEK_KULLANIM` doluyken `demo.ps1 -Seed/-Reset` ve `dev.ps1 -Seed` durur. Belge KURULUM "Gerçek kullanıma geçiş".
- Sunucu: Caddy (https, gerçek IP) `Platform/caddy/Caddyfile` + `docker-compose.prod.yml` (`edge` ağı, Caddy sabit IP, ağ geçidi yalnız ondan gelen X-Forwarded-*'a güvenir) → `node --test gateway/test/compose-order.test.mjs`, `bash gateway/test/run.sh`; güncelleme `Platform/scripts/guncelle.sh`, ilk kurulum `kurulum.sh` (testler `guncelle.test.mjs`, `kurulum.test.mjs`, taklitler `scripts/test-fixtures/sunucu/`); DeciShip dosya bağlantısı üretimde `APP_BASE_URL`'den (`lib/storage.ts` `publicBase`).
- Yedek ve geri yükleme: `Platform/scripts/yedekle.ps1` (`YEDEKLE.bat`), `geri-yukle.ps1` (prova `sellerondata-prova`, `-Canli`), `yedek-zamanla.ps1` (Görev Zamanlayıcı), ortak `yedek-ortak.ps1` + kap adımları `yedek-kap.sh`; test `Platform/scripts/yedek.test.mjs` (Docker'sız; gerçek yedek ve prova elle); `demo.ps1` sonunda yedek durumu. Belge KURULUM "Yedek ve geri yükleme". PowerShell ad tuzağı: işlev ya da değişken adı komut/anahtar adıyla aynı olmasın (`Docker` işlevi `docker`ı gölgeler, `$bekle` `-Bekle`'yle çakışır).

Araç bildirimi, firma dili ve saat dilimi:

- Araç bildirimi iç ucu `src/routes/internal.ts` (`POST /internal/notify`, ürün anahtarıyla) + `src/lib/productNotice.ts` (anahtar çözümü `productForSecret`, gövde şeması, alıcı seçimi, tekrar ve 30/gün tavanı, `sendProductNotice`).
- Şablon `mailer.ts` `productNoticeMail`; 30 günlük temizlik `lib/maintenance.ts`; anahtar haritası `env.ts` `productNotifySecrets`; test `test/productNotice.test.ts`; göç `20261114090000_product_notice`.
- Firma dili ve saat dilimi: `routes/org.ts` `PATCH /org`, olay `lib/outbox.ts` `orgUpdatedEvent` (`sayTimeZone`), `lib/me.ts` `activeOrg.timeZone/locale`; test `test/orgTimeZone.test.ts`; göç `20261114091000_org_time_zone`.

Araç durumu ve abonelik:

- `src/lib/launch.ts` (`PRODUCT_LAUNCH` ayrıştırma, `productLaunch`, `isProductOn`, `assertLaunchConfig`).
- `src/lib/productAccess.ts` (`productAccessFor`: jeton, `/me`, `/catalog`, rol atama, davet ve olay yayınının tek kuralı).
- `src/lib/subscriptions.ts` (`setSubscription`, `launchProduct`, `closeOrg`, `reopenOrg`, `announceMembers`, `listOrgs`, `isOrgClosed`).
- Destek komutları `scripts/{org-list,subscription-set,product-launch,org-close,org-reopen,members-announce}.ts` (ince betik; `tsup.config.ts` girişi, `package.json` betiği; ortak yardımcılar `src/lib/support.ts`: `runSupportCommand`, `UsageError`, `requireOperator`).
- Kilit sırası firma, abonelik, kişi, üyelik, davet. Testler `test/{launch,subscriptions,ordering,cli}.test.ts`.

Kimlik ve yetki sıkılaştırma:

- Devirde eski sahibin yönetici davetleri `src/lib/members.ts` `revokeOwnerOnlyInvitationsBy`; kabulde üretenin bugünkü yetkisi `inviterStillAuthorized` (`routes/join.ts` dört yer).
- Devir yalnız doğrulanmış adrese: `routes/org.ts` transfer (`details.reason: EMAIL_NOT_VERIFIED`, metin `src/i18n.ts` `OWNER_EMAIL_REASONS`, `errors.ts` `messageFor`); üye listesinde `emailVerified`.
- Şifre kodu reddinde tek neden `SELF_RESET` (`org.ts` `assertResetCodeAllowed`, `i18n.ts` `RESET_CODE_REASONS`).
- Yönetim yazma kovası `org.ts` `limitAdminWrite` (`RATE_RULES.orgAdminWrite`); hedef önce firmada aranır (`lockActorAndTarget`).
- Günlük giriş tavanı ve kilit postası `src/lib/rateLimit.ts` (`loginPersonDay`, `loginLockMail`, `personLoginKey`, `personLoginDayKey`, `hitPersonPasswordBuckets`, `clearPersonLoginBuckets`) + `routes/auth.ts` `countLoginAttempt`/`recordLoginLock`.
- Şifre değişti postası `routes/auth.ts` `sendPasswordChangedMail` (şablonlar `mailer.ts` `passwordChangedMail`, `loginLockedMail`); bildirim postasında bağlantı etkisizleştirme `mailer.ts` `productNoticeMail`.
- Yenileme toleransı `src/lib/sessions.ts` `refreshSession` (`Session.parentId`, göç `20261118090000_session_parent`, `env.ts` `refreshReuseGraceSeconds` varsayılan 60).
- Destek izinde operatör ve gerekçe gizli: `org.ts` `customerDetails`. Olay adresi biçimi `env.ts` `assertProductionConfig`.
- Kullanılmamış kayıt temizliği `src/lib/signupPurge.ts` + giriş `Platform/apps/account-api/scripts/signup-purge.ts` (`npm run signup:purge`).
- Testler `test/identityHardening.test.ts` (bulgu başına blok), `test/signupPurge.test.ts`, `test/startupGuards.test.ts` (olay adresi).
- Merkez tarafı: `hub-web/src/pages/account/Company.tsx` `TransferDialog` (`transferNotVerified`, `transferError`), `src/lib/csvCell.ts` (`neutralizeFormula`: DeciShip API `services/hub/csv.ts` `neutralize` ile aynı kural; test `src/lib/csv.test.mjs`).

Kayıt yalnız davetle (kullanıcı kararı, kapalı deneme):

- Kip `src/env.ts` `signupMode` (`SIGNUP_MODE`, üretimde varsayılan `invite`; bozuk değer `assertConfig`).
- Davet `src/lib/signupInvites.ts` (`createSignupInvite`, `consumeSignupInvite`), tablo `SignupInvite` (göç `20261119090000_signup_invite`), komut `Platform/apps/account-api/scripts/signup-invite.ts` (`npm run signup:invite`; `tsup.config.ts`, `test/cli-entries.test.mjs` `PROBES`).
- Uçlar: `routes/auth.ts` kayıt (`signupInvite` alanı), `routes/org.ts` `POST /orgs` (invite iken kapalı), `routes/public.ts` katalog `signupMode`, `lib/me.ts` `canCreateOrg`.
- Hata kodları `contracts/src/errors.ts` `SIGNUP_INVITE_REQUIRED`/`SIGNUP_INVITE_INVALID`; denetim etiketleri `contracts/src/audit.ts`. Test `test/signupInvite.test.ts`, `test/startupGuards.test.ts`.
- Merkez: `hub-web/src/pages/auth/Auth.tsx` `Register` (`?invite=`, `needsInvite`), `src/lib/hooks.ts` `useCatalog().inviteOnly`, sahte sunucu `src/mocks/browser.ts` (`sod_mock_signup_invite`), e2e `hub.spec.ts` "kayıt yalnız davetle".
- Site: `apps/site/scripts/build.mjs` (`SIGNUP_MODE` derleme değişkeni), `src/shell.mjs` `makeCtx` (`inviteOnly`, `inviteText`, `startCta`), metin `src/content/common.mjs` `invite`; compose `site` derleme argümanı.

Firma kapatma ve silme (kullanıcı kararı):

- `src/lib/orgClosure.ts` (kapatma, geri açma, saatlik `purgeDueOrgs`; bakım adımı `lib/maintenance.ts`); uçlar `routes/org.ts` `POST /org/close`, `POST /org/reopen`; süre `env.ts` `ORG_PURGE_DAYS`; göç `20261122090000_org_closure`; test `test/orgClosure.test.ts`.
- Kapalı firma kuralları: `auth.ts` `requireMember` (409 `ORG_CLOSED`), `lib/sessions.ts`, `lib/me.ts` (`orgStatus`, yalnız sahibe), `lib/siteSession.ts`, `lib/subscriptions.ts` `isOrgClosed`, `lib/productNotice.ts`.
- Merkez: `hub-web/src/pages/account/CloseOrg.tsx` (onay penceresi + `/account/company/closed/:orgId` geri açma), `src/lib/closeOrg.ts`, sahte `src/mocks/orgClose.ts`; kabuk `shell/src/AppShell.tsx` `OrgMenu` kapalı satırı.
- DeciShip: `src/identity.ts` (olaylar, firma kilidi), `services/companyPurge.ts` (`PURGE_TABLES`, dosyalar commit'ten sonra), arka plan işleri kapalı firmayı atlar; product-kit `identity.ts` `purge` seçeneği (`purge.ts`: parçalı kalıcı silme, `purge.tables`, `checkPurgeTables` katalogdan sorun listesi, ilk yeniden deneme 60 sn sonra), `isOrgClosed`; `org.ts` `readOrgProfile` (saat dilimi, Merkez onayı), `members.ts` `loadMemberAccess`/`memberPermissions`; Merkez çatısı firma kaydını kendisi okur.

### Merkez

Kök `Platform/apps/hub-web`.

- Sayfalar `src/pages/`: `Home` (Genel Bakış), `Analytics` (tek "Dışa aktar" menüsü, 403'te kilit ekranı), `Data` (⋯ menüsünde sütunlar ve CSV), `Activity` (süzgeçler adreste), `ToolAccess`, `ComingSoon`, `auth/Auth.tsx`.
- `account/*`: ekip (sekmeler ok tuşuyla, davet iptali onaylı), firma (`Company.tsx`: firma dili ve saat dilimi), abonelik, Hesabım.
- Hesabım (kişinin kendi alanı, Merkez kabuğunda): çerçeve `account/AccountLayout.tsx` (bant başlığı baş harf dairesiyle, solda ayar menüsü, `Panel`/`Row`). Bölümler: `account/Profile.tsx` (`/account/profile`: kişisel bilgiler, dil), `account/Security.tsx` (`/account/security`: şifre, açık oturumlar; "Diğer tüm oturumları kapat" tek tek DELETE ile), `account/Firms.tsx` (`/account/firms`: firmalar, geçiş, ayrılma `LeaveOrg.tsx`, sahibe kapalı firmalar). Stil `styles/account.css` `.acc`.
- `/account/memberships` ve eski `/account/profile#firmalar` `/account/firms`'e yönlenir.
- Avatar menüsündeki Hesabım / Güvenlik / Firmalarım kabukta (`AppShell.tsx` `UserMenu`, `accountPaths`); sitedeki karşılığı `apps/site/src/shell.mjs` `acctPanel`.
- Ürün uçları istemcisi `src/api/hub.ts`; hesap tipleri `src/api/types.ts`.
- Bileşenler `src/components/`: `Widgets.tsx`, `charts.tsx`, `DataTable.tsx`, `AiUsageCard.tsx` (Abonelik'teki "Yapay zekâ kullanımı" kartı, ürün başına `/api/<ürün>/platform/ai-usage`). Görünürlük `src/lib/access.ts`.
- Çıkış tek kancadan: `src/lib/logout.ts` (`useLogoutAction`; `HubLayout`, `CreateOrg` kullanır).
- Hata sınırı `src/main.tsx` (tam sayfa; sayfalar kabuğun sınırında); hata e2e'si `e2e/hata-hub.spec.ts` (`sod_mock_account_down` kancası).
- Sözlükler `src/locales/{tr,en}/{account,auth,hub}.json` (denetim betiği yok). Dikkat: ad alanları üst düzey anahtarla sığ birleşir (`i18n.ts`); `company` ve `billing` `hub.json`'dadır, `account.json`'a aynı üst anahtarı yazmak `hub.json`'dakini siler.
- Sahte sunucu `src/mocks/browser.ts` + `db.ts` (hesap), `src/mocks/deciship.ts` + `deciship-labels.json` (DeciShip Merkez uçları).

### Site

Kök `Platform/apps/site` (statik HTML üreten betik). Yeni sayfa: `src/routes.mjs` + `src/pages/<anahtar>.mjs` + `src/content/<anahtar>.mjs` (`{ tr, en }`; `title`, `description` zorunlu). Ortak kalıp `src/shell.mjs`, stil `src/styles/`. Denetim: `npm run build` sonra `npm run check` (`dist/` okur; bağlantı, hreflang, meta, yasak ifade, nginx).

### Ortak paketler

| Paket | Dosyalar |
|---|---|
| `Platform/packages/contracts` | Sözleşmeler (ayrıntı aşağıda "contracts"). |
| `Platform/packages/tokens` | **Renk ve ölçülerin tek kaynağı:** `tokens.json` + `build.mjs` (`--check`). Altı çıktı üretir: kabuk `styles/tokens.css` ve `bands.generated.ts`, DeciShip `styles/tokens.deciship.css`, mobil `src/ui/theme.generated.ts`, site `styles/tokens.css`, contracts `palette.generated.ts`. Yüzeye özgü farklar `surfaces.*` altında. Testler `test/*.test.mjs` (üretim güncelliği, "önce" kaydı `test/before.json` ile aynılık, ürün paleti kontrastı). Komutlar: `npm run build`, `npm run check`, `npm test`. |
| `Platform/packages/format` | `@sellerondata/format`: sayı, para, yüzde, tarih (`num`, `money`, `moneyParts`, `percent`, `dateShort`, `dateTime`, `dayMonth`, `dateLong`). Saf TypeScript, `Intl.NumberFormat` yok (Hermes). Kabuk `format.ts`, panel `lib/format.ts`, mobil `lib/format.ts` ve `hub/format.ts`, hesap motoru `format.ts` ona devreder; çekirdekte kayıtlı not biçimi (`fmtDate`) bilerek kalır. Testler `test/`. |
| `Platform/packages/auth-kit` | `productAuth.ts` (ürün API'sinde jeton doğrulama, `requirePermission`), `eventReceiver.ts` (olay alıcısı), `jwks.ts`, `testing.ts` (testte jeton/olay üretici). |
| `Platform/packages/product-kit` | `@sellerondata/product-kit`: yeni aracın ortak iskeleti. `identity.ts`/`projection.ts` (kimlik izdüşümü: `memberProjectionSql`, `Member`/`Company`/`ProcessedEvent` + RLS), `hub/` (Merkez uçlarının çatısı: `registerHubRoutes`), `db.ts`, `errors.ts`, dönem/CSV/sınırlayıcı yardımcıları. Test fikstürü `test/ornekarac/` (sahte araç; kayıtta yok). DeciShip pakete geçmedi (E6). Testler `test/{helpers,hub}.test.ts` + fikstür (Postgres ister). |
| `Platform/packages/shell` | Ortak kabuk (ayrıntı aşağıda "shell"). |

contracts (`Platform/packages/contracts/src/`):

- `products.ts`: **araç kaydı, her aracın tek tanımı** (`defineProduct`, `validateRegistry`, `RESERVED_PRODUCT_KEYS`).
- `catalog.ts` (kayıttan türeyen ürünler, roller, izinler, Merkez izinleri, `isProductKey`, `webProductKeys`, `hubOwnedProductKeys`), `errors.ts` (hata kodları ve metinleri), `events.ts` (Hesap → ürün olayları), `hub.ts` (Merkez sözleşmesi), `tokens.ts`, `audit.ts` (Hesap denetim etiketleri), `ai.ts` (yapay zekâ fiyat listesi, maliyet ve dönem hesabı).
- `client.ts`: `X-SOD-Client` başlığı, sürüm karşılaştırma, `strictVersion`, `ClientPolicy`.
- `notify.ts`: araç bildirimi sözleşmesi (`NOTIFY_PATH`, `NOTICE_LIMITS`, `isValidNotifySecret`, `DEV_PRODUCT_NOTIFY_SECRET`, `isNoticePlainText`, `cleanNoticeText`, `isNoticeActionPath`).
- `support.ts` (`SUPPORT_EMAIL`, `supportMailto`), `timezones.ts` (`TIME_ZONES`, `defaultTimeZone`, `isOrgTimeZone`).
- Testler `test/*.test.ts` (`ai`, `catalog`, `client`, `errors`, `events`, `tokens`, `notify`, `timezones`), `node --test` ile, vitest yok.

shell (`Platform/packages/shell/`):

- `AppShell.tsx`: bant + ray; `<main>` hata sınırıyla sarılı; `supportHref` avatar menüsüne "Yardım ve destek" koyar.
- `ErrorBoundary.tsx` (ortak hata sınırı ve yedek ekran), `primitives.tsx` (`ToastApi` `always`), `session/` (oturum istemcisi; `provider.tsx` `logout` → `{ serverEnded }`), `navigation.ts`, `marks.tsx`.
- `session/epoch.ts`: oturum sayacı. Çıkış, başka sekmede çıkış, giriş (`beginSession`, Merkez `useAfterAuth`) ve firma geçişi (`beginOrgChange`: shell'in firma değiştirme işlevleri, `SessionBanner`, Merkez `CloseOrg` `useReloadSession`) artırır; geç gelen eski `/me` yan etkisiz kalır. Test `test/sessionRace.test.tsx`.
- `format.ts` (`formatMoney` hata fırlatmaz, `safeHref`), `i18n/setup.ts`, `locales/{tr,en}/shell.json` (`boundary.*`, `session.logoutFailed*`, `org.switchFailed`).
- `styles/tokens.css`, `styles/shell.css` (`.sod-err*`; bant alt metni en çok iki satır, telefonda menü solması), `styles/a11y.css` (yüksek kontrast kipi).
- Testler `test/errorBoundary`, `format`, `logout`, `appShell`, `formatGolden` ("önce" kaydı, `test/__golden__/formatGolden.shell.txt`).

Yeni izin ya da rol: `contracts/src/products.ts` (araç girdisi; `catalog.ts` ondan türer) → DeciShip API `test/routeRules.ts`, web `src/lib/permissions.ts`, mobil `src/auth/access.ts`, Hesap `test/matrix.test.ts`, Merkez `src/lib/access.ts`.

### Gateway

- Araç kaydından üretilenler: `products-gen.mjs` gateway dosyalarını, site listesini ve `infra/postgres/init.sql` ile `upgrade.sql`'i yazar (`products-db.mjs`; iç değişkenler `sod__` önekli, ayrılmış anahtarlar ve Postgres sözcükleri reddedilir). Elle yazılan listelerin denetimi `products-lists.mjs` (`products:check`; göçte `TO PUBLIC` ve başka şemaya hak yasak). Sınama `bash infra/postgres/verify.sh` (Docker; parolalar kabın IP'sinden sınanır), üretimde `dev-parola.sh` `_dev` parolalı rol bulursa durur; yedekten geri yüklemede parola eşitleme `yedek-kap.sh rol-parola`.
- Araç blokları **üretilir**: `Platform/gateway/conf/products/<anahtar>.conf` (üretici `Platform/scripts/products-gen.mjs`; `npm run products:gen` / `products:check`; testi `products-gen.test.mjs`). Aynı üretici site için `Platform/apps/site/src/content/products.generated.json` yazar. Üretilenler commit edilir, elle düzenlenmez.
- `Platform/gateway/conf/default.conf` (yollar: `/api/account/`, `/api/deciship/`, `/deciship/`, site, `*/internal/*` dışarıya 404), `proxy.conf`, `security-headers.conf`, `templates/10-real-ip.conf.template`.
- Hız sınırı `templates/20-limits.conf.template` + `api-limits.inc.template` (kimlik kovası, yükleme kovası API firma sınırlarının üstünde: `rate-limits.test.mjs`); sıkıştırma `conf/gzip.conf` (hesap API'si sıkıştırılmaz, BREACH; `gzip.test.mjs`). Kap günlüğü, kapanış ve sağlık `docker-compose.yml` `x-logging` (`compose-order.test.mjs`); sunucu denetimi `Platform/scripts/ayakta-mi.sh` (`ayakta-mi.test.mjs`).
- Test: `Platform` içinde `bash gateway/test/run.sh` (Docker). Geliştirme kapısı `Platform/scripts/dev-gateway.mjs` (+ `.test.mjs`). Servis listesi `Platform/docker-compose.yml`.

### Yeni araç eklemek

Ayrıntı `Platform/docs/ARCHITECTURE.md` (§7, parçalar `Platform/docs/mimari/`). Kısaca:

1. `Platform/packages/contracts/src/products.ts` içine tek `defineProduct({...})` girdisi (renk `tokens.json` paletinden).
2. Kökte `npm run products:gen`; çıkan `.conf` ve JSON'u commit et.
3. Aracın API ve web'i `@sellerondata/product-kit` ile.
4. `PRODUCT_LAUNCH` ile aç; `subscription:set` / `product:launch` ile firmalara ver.

Hâlâ elle: veritabanı rolleri ve şemaları (`infra/postgres`), compose servisleri ve `PRODUCT_EVENT_TARGETS`, demo tohumu, taklit sunucu verisi (`hub-web/src/mocks`), iki araçlı e2e, mobil ekran, bant rengi (`tokens.json`).

### Uçtan uca

`Platform/e2e/tests/NN-*.spec.ts` (gerçek yığın: `stack.mjs`, `run.mjs`), yardımcılar `e2e/lib/`. Komut `Platform` içinde `npm run e2e` (ağır).
