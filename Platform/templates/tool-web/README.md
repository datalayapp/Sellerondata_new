# Araç web şablonu

Yeni bir aracın (OrderLoom, TagPress) web paneli için başlangıç iskeleti. DeciShip panelinin (`Deciship/apps/web`) araçtan bağımsız kısmıdır: Vite kurulumu, `@sellerondata/shell` kabuğu ve oturumu, "web erişimin yok" kapısı, i18n (TR + EN, `check:i18n`), sahte API bağlantısı (`dev:mock`), Dockerfile ve nginx.

**Tasarım içermez.** OrderLoom ve TagPress için tasarım dili seçilmedi. Şablon yalnız kabuğun kendi stillerini yükler; yazı tipi, araç belirteçleri (`tokens.<anahtar>.css`), sayfa stilleri, simge ve manifest seçimden sonra eklenir. Bant rengi kabuktan gelir (`bandTheme`, kayıttaki araç renginden türer).

Bu klasör bir paket değildir: kurulmaz, derlenmez, hiçbir test parçası onu koşmaz. `package.json.tmpl` uzantısı bilerek böyledir; düz `package.json` olsaydı depo denetimi (`npm run check`, K6 `file:` yolları) onu paket sanıp göreli yolları bu klasöre göre çözerdi. Kod dosyaları gerçek uzantılıdır: kök lint ve biçim denetimi onları da tarar, temiz tutulmalıdır.

## 1. Kopyala ve adları değiştir

Örnek OrderLoom. Araç klasörü anahtarın ilk harfi büyük yazılır (`orderloom` → `Orderloom/`, `products:check` bu adı arar).

```bash
mkdir -p Orderloom/apps
cp -r Platform/templates/tool-web Orderloom/apps/web
cd Orderloom/apps/web
mv package.json.tmpl package.json
rm README.md
grep -rl ornekarac . | xargs sed -i 's/ornekarac/orderloom/g; s/Ornekarac/Orderloom/g; s/ORNEKARAC/ORDERLOOM/g'
npm install   # package-lock.json oluşur; junction'lar node_modules/@sellerondata/* altında
```

| Yer tutucu | Değişir | Nerede |
|---|---|---|
| `ornekarac` | araç anahtarı (`orderloom`) | `src/lib/base.ts` `TOOL`, `vite.config.ts`, `nginx.conf`, `Dockerfile`, `src/mocks/browser.ts`, paket adı `@ornekarac/web` |
| `Ornekarac` | araç klasörü (`Orderloom`) | `Dockerfile`, `Dockerfile.dockerignore` |
| `ORNEKARAC` | ortam değişkeni öneki | `vite.config.ts` `ORNEKARAC_WEB_PORT` (geliştirme kapısıyla aynı ad: `<ANAHTAR>_WEB_PORT`) |
| `5174` | geliştirme portu | `vite.config.ts` `DEV_WEB_PORT` = kayıttaki `deploy.web.dev` |
| `4200` | aracın API'sinin geliştirme portu | `vite.config.ts` `DEV_API_PORT` = kayıttaki `deploy.api.dev` |
| `ornekarac-web` | compose servis adı | kayıttaki `deploy.web.service` ve `Platform/docker-compose.yml` |

`ornekarac` adı bilerek seçildi: kayıt anahtarı kuralına (`/^[a-z][a-z0-9]{2,19}$/`) uyar, dosyalar geçerli TypeScript kalır ve product-kit testlerindeki sahte araçla aynı addır. Kayıtta olmadığı için `src/lib/base.ts` içindeki `satisfies ProductKey` şablonda derlenmez; kopyada araç kayda girince derlenir ve yanlış yazılmış anahtarı yakalar. Şablon, anahtar `deciship` yapılarak DeciShip panelinin bağımlılıklarıyla bir kez tip denetiminden geçirildi (iki tsconfig de hatasız).

## 2. Araç kaydı ve üretilen dosyalar

`Platform/packages/contracts/src/products.ts` içindeki girdiye:

- `webAccess`: web'e giriş izni (ör. `'orderloom.web.access'`), izin listesinde ve rollerde. Kapı buna bakar (`hasWebAccess`).
- `deploy.web: { service: 'orderloom-web', port: 80, dev: 5174 }` (ve API için `deploy.api`). `deploy.web` varsa `webAccess` zorunludur.

Sonra kökte `npm run products:gen`. Üretilen gateway blokları (`Platform/gateway/conf/products/<anahtar>.conf`: `/<anahtar>` yönlendirmesi, `/<anahtar>/assets/` uzun önbellek, `/<anahtar>/` `no-cache`) bu şablonun `nginx.conf`'uyla eşleşir. Geliştirme kapısı (`Platform/scripts/dev-gateway.mjs`) `deploy.web.dev` portuna kendiliğinden yönlendirir. Ayrıntı: `Platform/docs/mimari/06-merkez.md` "Yeni araç ekleme".

## 3. Elle güncellenen listeler

`npm run products:check` bunları denetler ve eksikte kalır:

- `scripts/parts.mjs`: en az bir parça; web için `tc:<anahtar>-web` (`npm run typecheck`) ve `<anahtar>-web-i18n` (`node scripts/check-i18n.mjs --strict`, `modules: false`). Test eklenince `npm test` parçası.
- `scripts/install.mjs` (kilit dosyası olan paket), `scripts/test-changed.mjs` `PACKAGES` (`tc`, `i18n` alanlarıyla), `.github/workflows/ci.yml` npm önbellek yolları (`cache-dependency-path`).
- `Platform/gateway/test/access-log.test.mjs` `SERVERS`: aracın `nginx.conf`, `Dockerfile` ve `Dockerfile.dockerignore`'u.
- Klasör listeleri: `Platform/e2e/snapshot.mjs`, `scripts/repo-check.mjs` `DOC_ROOTS` (yeni kök klasör), `scripts/test.mjs --scope`.

Denetlenmeyenler (unutulursa sessiz kalır):

- `Platform/docker-compose.yml`: web servisi (`deciship-web` bloğunun kopyası; `context: ..`, `dockerfile: <Klasör>/apps/web/Dockerfile`, sağlık yoklaması `/<anahtar>/`). `Platform/gateway/test/compose-order.test.mjs` servis listesi.
- `Platform/gateway/test/run.sh`: sahte web kabı ve yönlendirme denetimleri (Docker ister).
- `Platform/scripts/dev.ps1`: web sunucusunu başlatan `Start-Server` satırı (DeciShip'inki `Platform/scripts/dev.ps1:132`).
- `tools/lint/eslint.config.mjs` `UI` listesi (React kanca kuralları yalnız buradaki klasörlerde koşar) ve `tools/lint/run.mjs` `PART_DIRS` (sayım tablosu).
- `scripts/repo-check.config.mjs`: web için genelde gerekmez (göç yok, imaj `node_modules` bağlamaz).
- Merkez sahte API'sinin araca özgü verisi (`Platform/apps/hub-web/src/mocks/`), Playwright ve görsel testler (şablonda yok).

## 4. Dosyalar ve DeciShip karşılıkları

| Şablon | DeciShip paneli | Not |
|---|---|---|
| `package.json.tmpl` | `Deciship/apps/web/package.json` | `@deciship/core`, yazı tipleri, Playwright yok; sürümler DeciShip ile aynı (K9 sürüm birliği) |
| `tsconfig.json`, `tsconfig.node.json` | aynı adlar | node tsconfig yalnız `vite.config.ts` |
| `vite.config.ts` | `Deciship/apps/web/vite.config.ts` | tek köken vekilleri, `base`, derleme kimliği, `blocking="render"` |
| `index.html` | `Deciship/apps/web/index.html` | simge, manifest, tema rengi yok (tasarım) |
| `.env.mock` | `Deciship/apps/web/.env.mock` | `VITE_MOCK=1` |
| `src/main.tsx` | `Deciship/apps/web/src/main.tsx` | yalnız kabuk stilleri |
| `src/App.tsx` | `Deciship/apps/web/src/App.tsx` + `src/components/Shell.tsx` | kabuk, menü, oturum kapısı, örnek sayfa |
| `src/lib/base.ts` | `Deciship/apps/web/src/lib/base.ts` | `TOOL`, `APP_BASE`, `toolAccessHref` |
| `src/api/session.ts` | `Deciship/apps/web/src/api/session.ts` + `src/api/client.ts` | kabuğun oturum istemcisi; araç uçları için küçük `api` |
| `src/i18n/index.ts`, `src/locales/{tr,en}/common.json` | `Deciship/apps/web/src/i18n/index.ts`, `src/locales/` | ad alanı = dosya adı |
| `scripts/check-i18n.mjs` | `Deciship/apps/web/scripts/check-i18n.mjs` | ortak betiğe (`Platform/scripts/check-i18n.mjs`) sarmalayıcı |
| `src/mocks/browser.ts` | `Deciship/apps/web/src/mocks/browser.ts` | örnek uç + `passthrough`; Hesap uçları yok (aşağıda 4. madde) |
| `src/build-id.d.ts` | `Deciship/apps/web/src/build-id.d.ts` | `__BUILD_ID__` |
| `Dockerfile`, `Dockerfile.dockerignore`, `nginx.conf` | aynı adlar | çekirdek paketi yok; `version.json` `no-store` |

## 5. Oturum kapısı

`src/App.tsx` `gateOf`: oturum yok → Merkez girişi (`/login?next=…`); Hesap'a ulaşılamadı ve son bilinen kişi yok → "Bağlantı yok" (kabuk metni); etkin firma yok → Merkez'e dönüş; araçta web izni yok → `/account/tool-access/<anahtar>` (Merkez'in ortak sayfası: rol mobilde mi, hiç rol yok mu orada anlatılır). DeciShip bu son iki durumu kendi sayfalarında gösterir; şablon kopyalamaz, Merkez'e gönderir.

426 (desteklenmeyen mobil sürüm) web'de yoktur: yalnız mobil uygulama sürüm başlığı gönderir, kanca API'lerin içindedir (aşağıda 1. madde). Web'in karşılığı "yeni sürüm var" denetimidir: derleme `version.json` yazar, nginx onu önbelleğe almaz; denetleyen bant bugün DeciShip'te (aşağıda 3. madde).

## 6. Ortak pakete alınacaklar (bugün DeciShip'te; şablona kopyalanmadı)

1. **426 sürüm kancası** → auth-kit `registerClientVersionGate(app, { min, exempt })`, product-kit `registerProductIdentity` kendiliğinden kaydetsin. Bugün iki kopya: `Deciship/apps/api/src/app.ts:32-33` ve `:99-109`, `Platform/apps/account-api/src/app.ts:31-32` ve `:74-83`.
2. **"Web erişimin yok" kapısı** → kabukta `ProductGate` (durum makinesi + yönlendirme). Bugün: `Deciship/apps/web/src/auth/AuthContext.tsx:24` ve `:102-116` (durumlar), `Deciship/apps/web/src/components/Shell.tsx:79-81` ve `:204-213` (seçim), `Deciship/apps/web/src/pages/AccessPages.tsx:13-217` (erişim, firma, bağlantı sayfaları), `Deciship/apps/web/src/lib/permissions.ts:17` ve `:34` (`productOf`, kabuğun `hasWebAccess`'ine sarmalayıcı). Şablondaki `gateOf` bunun en küçük hâli; kapı kabuğa gelince silinir.
3. **"Yeni sürüm var" bandı ve eski parça yeniden yüklemesi** → kabukta bileşen ya da kanca. Bugün: `Deciship/apps/web/src/components/UpdateBanner.tsx` (bütün dosya).
4. **Sahte Hesap uçları** (me, refresh, switch-org, logout, ürün denetim sırası) → `@sellerondata/shell/mock-seed` yanına. Bugün: `Deciship/apps/web/src/mocks/account.ts:127` (`accountHandlers`); `:176-357` DeciShip'in izin tablosu, ortak değil. O gelene kadar şablonun `dev:mock`'unda oturum açılmaz; `accountHandlers` elle kopyalanır.
5. **Vite eklentileri** (derleme kimliği, `blocking="render"`) → kabukta küçük bir `vite` dışa aktarımı. Bugün üç kopya: `Deciship/apps/web/vite.config.ts:8-15` ve `:21-30`, `Platform/apps/hub-web/vite.config.ts:31-40`, şablonun `vite.config.ts`'i.
6. **Oturum kaybında kaydedilmemiş yazıyı sorma** ve **yetki azalınca önbelleği atma** → kabuk. Bugün: `Deciship/apps/web/src/lib/sessionLost.ts`, `Deciship/apps/web/src/lib/accessCache.ts`, `Deciship/apps/web/src/auth/AuthContext.tsx:42-62` (`useAccessRecheck`), `Deciship/apps/web/src/App.tsx:36-50` (`reactToAccessError`).
7. **Yol yardımcıları** (`isAppHref`, `toRouterPath`, `toFullPath`, `loginHref`) → kabukta `APP_BASE` alan tek işlev. Bugün: `Deciship/apps/web/src/lib/base.ts` ve şablonun `src/lib/base.ts`'i.
