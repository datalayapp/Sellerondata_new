# @sellerondata/shell

Tüm araçların paylaştığı kabuk (D09 Renk bandı): ürün renginde üst bant, yatay ürün menüsü, uygulama/firma/hesap menüleri, sayfa başlığı portalı, oturum istemcisi, `useMe`, i18n kurulumu, ürün işaretleri, belirteçler, temel bileşenler.

Bağımsızdır: react-router gerekmez. Bağımlılıkları eş bağımlılıktır (`react`, `react-dom`, `i18next`, `react-i18next`, `@tanstack/react-query`, `@sellerondata/contracts`).

## Yerleşim

```
┌───────────────────────────────────────────────────────────────┐
│ [işaret] DeciShip  ⊞   [▣ Pano][Faturalar] …        [Firma ▾] (EK) │  üst satır 72 px
│          SellerOnData                                              │
│ ─────────────────────────────────────────────────────────────── │
│ EYEBROW                                                         │  bant (ürün rengi)
│ Sayfa başlığı 56/600                          [ikincil] [birincil]│  PageHeader portalı
│ alt metin 19                                                    │
│        ┌──────────────── ilk kart (.sod-lift) ───────────────┐  │  bant altı 40 px (büyük bantta 112)
└────────┤                                                     ├──┘
         │  içerik (--sod-wrap 1240, kenar --gutter)            │
```

- **Üst satır** her üründe (TagPress `workspace` dahil) aynı: logo kilidi (en az 136 px) ve hemen sağında ⊞ (44 px), `productNav` (gruplar düzleşir, grup adı çizilmez; geniş ekranda A · bölmeli sekmeler: açık oluk, seçili sekme beyaz, solunda `icon`; sığmayınca önce simgeler gizlenir, sonra oluk kayar), sağ küme `[headerSlot] [firma seçici] [avatar 40px]`. Menü her üründe aynı x'te başlar. Yalnız renk ve logo değişir.
- **Logo kilidi:** işaret 28 px solda, sağında iki satır: ad 17/600, altında `SellerOnData` 12/400. Merkez'de ad `MERKEZ` (metin "Merkez"/"Hub", CSS büyük harf; erişilebilir ad "SellerOnData Merkez"). Tek bağlantı (44 px hedef): Merkez'de `/home`, üründe ürünün ana sayfası. Merkez'e geçiş ⊞ ve telefonda alttaki uygulama çubuğunda. Telefonda da iki satır.
- **⊞ menüsü:** Merkez ve ürünler. Açık olmayan ürün (`available: false`) `role="menuitem" aria-disabled="true"` `<span>`, bağlantı değil.
- **Firma seçici:** firma değiştirme, firma ayarları, yeni firma. **Avatar:** profil, güvenlik, dil (TR/EN), çıkış.
- **Alt uygulama çubuğu (telefon):** ≤ 760'ta ekranın altında sabit beyaz çubuk (60 px + güvenli alan): Merkez, sonra ürünler (`PRODUCT_KEYS`); yol ve izin kuralı ⊞ ile aynı. Etkin uygulama `aria-current="page"`, tepede 3 px renk çizgisi ve açık ton zemin; açık olmayan ürün soluk `<span aria-disabled>`. Yüksekliği `--sod-dock-h` (geniş ekranda 0): alttaki sabit/yapışkan öğeler `bottom: var(--sod-dock-h, 0px)`, güvenli alan payı `var(--sod-safe-b, env(safe-area-inset-bottom))` kullanır.
- **Bant rengi** `currentProduct`'a göre (`bandTheme(product)` CSS değişkenleri döner): Merkez grafit `#2a2d34` (tanıtım sitesinin gece mavisinden `#0a1a3a` ayrışır; ürün renkleriyle karışmaz), etkin menü çizgisi ve bant birincil düğmesi güneş `#fdb022` (yazı `#2a2d34`); DeciShip `#1d5bd8` / `#1546b8`, açık `#e8eefc`, çizgi `#b5cbff`, bant birincil düğmesi beyaz + `#1d5bd8` yazı. Diğer ürünler katalog renginden aynı kalıpla türer.
- **TagPress bandı** kalıbın onaltılık yazılmış hâli: `#644acb` / `#533da9`, açık `#f2effe`, çizgi `#d0c5fd` (`tokens.json` `bands.tagpress`, üretilen `TAGPRESS_BAND`). Kontrast grafitte: beyaz 13.8:1, güneş 7.5:1 (düğme yazısı da 7.5:1), odak `#b5cbff` 8.5:1, menü yazısı `#d3d6dc` 9.5:1.
- **Bant dışı birincil:** ürünlerde `#1d5bd8`; Merkez'de marka mavisi `#0f2a5c` (`:root[data-sod-product='hub']`, AppShell kök öğeye yazar; modal ve bildirim de aynı rengi alır).
- **Odak:** açık zeminde `#1d5bd8`, bantta `#b5cbff` (`--focus`, `--focus-on-dark`).
- Sayfa değişince odak `main`'e, kaydırma başa; telefonda etkin menü öğesi görünür kaydırılır. Sekme başlığı (`Faturalar · DeciShip`), simge, prefetch, görünüm geçişi korunur.

| Genişlik | Davranış |
|---|---|
| > 760 | Tek üst satır. Standart bant 240 px (başlık bölgesi 128: üst satır 20, H1 36/44, alt metin 24), büyük bant H1 56. |
| ≤ 760 | Menü ikinci satıra iner, yatay kaydırılır. Firma adı 130 px'te kısalır. ⊞ ve `headerSlot` gizlenir (uygulama geçişi alttaki çubukta). Kaydırınca üst satır (logo satırı + menü satırı) üstte sabit kalır. Standart bant 289 px (başlık 156: üst satır 18, H1 26/34, alt metin 20, eylem satırı 48 hep yer tutar), büyük bant H1 38. Çekmece yok. |

### PageHeader ve bant boyu

`PageHeader` (`primitives.tsx`) AppShell içinde bandın başlık bölgesine **portal** ile taşınır (beyaz metin, sınıflar `.phead.is-band`, `.phead-main`, `.peyebrow`, `.ptitle`, `.psub`, `.pactions`, `.crumb`). AppShell dışında eskisi gibi satır içi (`.phead`). Sayfa başına tek `PageHeader`.

| Prop | Anlamı |
|---|---|
| `title`, `sub` (`description` eşi), `crumbs`, `actions` | Standart bantta başlık geniş ekranda tek satır (taşan `…`), ≤760 px'te en çok iki satır; alt metin her ekranda en çok iki satır (fazlası kesilir). `actions` bantta: `.btn-primary` bant birincili, `.btn-secondary` saydam + beyaz kenar, `.btn-ghost` beyaz metin. |
| `eyebrow` | Başlığın üstünde Mono 13, büyük harf, `.06em`. |
| `tabs` | `.ptabs` şeridi. Bantta değil, içeriğin başında (`.phead-tabs`) çizilir; bant standart kalır. |
| `hero` | Büyük bant (H1 56, alt metin 19, ilk kart 72 px biner). Yalnız Merkez Genel Bakış ve DeciShip Pano. |
| `short` | Eski; etkisi yok (bant hep standart). |

Bant boyu `header.sod-band[data-size]`: `hero` (içerikle büyür, alt 112 px), `standard` (varsayılan; en az 1440'ta 240, 390'da 289 px: alt metin ikinci satıra ya da telefonda başlık ikinci satıra geçerse bant o satır kadar uzar), `none` (başlık yok, standartın en az yüksekliğiyle aynı: yükleme bitince zıplamaz), `work` (Tezgâh çalışma bandı, TagPress: 72 px üst satır + 44 px iş satırı, alt boşluk yok, kenardan kenara; iş satırı aracın `useHeadSlot().el`'e çizdiği düğüm; kabuk pencere boyunda, içerik kalan yüksekliği doldurur, sayfa kaymaz).

Standartta kırıntı ve eyebrow aynı üst satırda; başlık geniş ekranda tek satır, ≤760 px'te en çok iki satır; alt metin en çok iki satır. Boş alt metin ve boş kırıntı satırı yer tutar; telefonda boş eylem satırı yer tutmaz. Telefonda üst menü (`.sod-nav`) yanlara kayar, iki kenarı solar. Boy `PageHeader`'ın layout etkisiyle boyamadan önce yazılır.

İçeriğin ilk kartı banda biner: kartına `sod-lift` sınıfı verin (`.sod-main .lift` da çalışır). Standart bantta `-24px` (telefonda `-16px`), büyük bantta `-72px` (telefonda `-64px`).

`useHeadSlot()` AppShell içinde olup olmadığını söyler (kendi başlık bileşenini portal ile taşımak isteyen uygulama için).

## Kurulum

```ts
// package.json
"@sellerondata/shell": "file:../../../Platform/packages/shell",
"@sellerondata/contracts": "file:../../../Platform/packages/contracts",
"@sellerondata/format": "file:../../../Platform/packages/format"
```

Paket kaynak olarak gelir (`exports` → `./src/index.ts`). React'in tek kopya kalması için bağlantı yolu korunmalı:

```ts
// vite.config.ts
resolve: { preserveSymlinks: true, dedupe: ['react', 'react-dom', 'i18next', 'react-i18next', '@tanstack/react-query'] },
optimizeDeps: {
  exclude: ['@sellerondata/shell', '@sellerondata/contracts', '@sellerondata/format'],
  include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'i18next', 'react-i18next', '@tanstack/react-query'],
},
```

```jsonc
// tsconfig.json
"preserveSymlinks": true, "allowImportingTsExtensions": true, "resolveJsonModule": true
```

Stil:

```ts
import '@sellerondata/shell/tokens.css';      // D09 belirteçleri + --sod-* (bant)
import '@sellerondata/shell/shell.css';       // bant, menüler, PageHeader'ın bant hali, bant düğmeleri, view transitions. Sınıflar sod- önekli.
import '@sellerondata/shell/primitives.css';  // .btn, .inp, .dt... Merkez ve DeciShip web yükler (sıra: Platform/docs/DESIGN.md §1).
```

## Kullanım

```tsx
const client = createSessionClient({
  getLocale: currentLocale,
  onSessionLost: () => location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`),
});
initShellI18n({ resources: { tr: { deciship: tr }, en: { deciship: en } }, defaultNS: 'deciship' });

<QueryClientProvider client={qc}>
  <SessionProvider client={client}>
    <App />
  </SessionProvider>
</QueryClientProvider>;
```

```tsx
function Layout() {
  const { me } = useMe();
  const { logout, switchOrg, changeLocale } = useSessionActions();
  const loc = useLocation();
  return (
    <AppShell
      currentProduct="deciship"
      productNav={[{ items: [{ href: '/deciship/', label: 'Pano', end: true }, { href: '/deciship/invoices', label: 'Faturalar' }] }]}
      pageTitle="Faturalar"
      currentPath={loc.pathname}
      me={me}
      renderLink={({ href, children, ...rest }) => <Link to={href} {...rest}>{children}</Link>}
      isLocalHref={(href) => href.startsWith('/deciship')}
      onLogout={async () => { await logout(); location.assign('/login'); }}
      onSwitchOrg={(id) => switchOrg(id)}
      onChangeLocale={(l) => changeLocale(l)}
    >
      <Outlet />
    </AppShell>
  );
}
```

| Prop | Anlamı |
|---|---|
| `currentProduct` | `'hub'` veya `ProductKey`. |
| `productNav` | Bant menüsü (yatay). `ProductNavGroup[]` düzleşir; `badge` ad yanında durur, `icon` geniş ekranda adın solunda (telefonda ve sığmayınca çizilmez). Düğüm verilirse `<nav class="sod-nav">` içine olduğu gibi oturur. |
| `pageTitle` | Yalnız sekme başlığı. Sayfa adı `PageHeader`'ın `h1`idir. |
| `breadcrumb` | Bantta başlık bölgesinin üstünde kırıntı. Çoğu sayfada verilmez; `PageHeader.crumbs` tercih edilir. |
| `currentPath` | Etkin menü öğesi (`aria-current="page"`) ve sayfa değişimi (odak `main`'e, kaydırma başa). |
| `renderLink`, `isLocalHref` | Uygulama içi bağlantı. Verilmezse düz `<a>`. Araçlar arası bağlantı her zaman tam sayfa gider. |
| `headerSlot` | Sağ kümenin başında uygulamaya özel alan (ör. "Örnek veri"). |
| `accountPaths` | Profil, güvenlik, firma yolları. Varsayılan Merkez adresleri. |
| `workspace` | Tezgâh çalışma düzeni (TagPress; `Platform/docs/DESIGN.md` §7). Bant ve içerik kenardan kenara (`.sod-wrap` yok, kenar 24 px, telefonda 16); sayfa boy bildirmezken bant `work` boyunda. Üst satır Merkez ve DeciShip'inkiyle aynı. Uygulama boyunca sabit verilir. Verilmezse Merkez ve DeciShip kabuğu aynen. |
| `column` | Yalnız `workspace` ile: form ve liste ekranları için sütun. Bandın başlık bölgesi (baş yuvası, kırıntı) ve `.sod-main` Merkez ve DeciShip sütununa döner (`--sod-wrap` 1240, `--gutter` 32, telefonda 16). Üst satır workspace kipinde her ekranda bu sütunda. Kökte `data-sod-column`; içerik kenarını `var(--gutter)` ile verir. Çalışırken değişebilir. |

## DeciShip web'e takma notları

1. Kendi üst çubuğu ve yan menüsü yok: başlık, işaret, firma, dil, kullanıcı ve çıkış kabukta. Menü `productNav` dizisi olarak verilir.
2. Sayfa başlığı için kabuğun `PageHeader`'ı kullanılmalı (bant portalı). `ui.tsx`'in kendi `PageHeader`'ı bantta çizilmez.
3. `primitives.css` yüklenir. DeciShip sırası: `tokens.css` → `tokens.deciship.css` → `shell.css` → `primitives.css` → `app.css` → `pages/*.css`. `app.css` yalnız DeciShip'e özgü kuralları ve sonunda "DeciShip farkları" bölümünü taşır. Bant içindeki `.btn` ve `.phead` biçimi `shell.css`'te.
4. `index.html` içinde `<script type="module" blocking="render" ...>` olmalı ve `main.tsx` ilk çizimi `flushSync` ile yapmalı. Yoksa görünüm geçişinin yeni karesi boş çizilir, bant yanıp söner. **Vite derlemede bu özniteliği düşürür**: `apps/hub-web/vite.config.ts` içindeki `renderBlockingEntry` eklentisini aynen alın ve `dist/index.html`'de durduğunu doğrulayın.
5. `base: '/deciship/'` ile ⊞ menüsünün bağlantısı `/deciship/` (sondaki bölü dahil) doğrudan karşılanmalı.
6. `useAuth` kalkar: `useMe()` ve `useSessionClient()` gelir. Yetki kararı `me.products[].permissions` üstünden.
7. `QueryClient` paylaşılmaz; `useMe` `['sod', 'me']` anahtarını kullanır, uygulamanın kendi `QueryClient`'ına yazılır.

## Oturum istemcisi

`createSessionClient(options)` → `{ request, get, post, patch, delete, download, raw, refresh, noteActiveOrg, forgetOrg, resetLost }`

- Çerez (`credentials: 'include'`), `Accept-Language`; durum değiştirenlerde `X-SOD-CSRF: 1`.
- 401 alınca tek seferlik `POST /api/account/auth/refresh`, sonra aynı isteği tekrar dener. Girişte `noRefresh: true`.
- Yenileme jetonu tek kullanımlık ve eskisi gelirse aile iptal olur (ARCHITECTURE.md §5). Bu yüzden yenileme sekme içinde tek uçuşlu, sekmeler arası Web Locks ile sıralıdır; başka sekme az önce yenilediyse tekrar gönderilmez.
- Hata: `ApiError { status, code, message, details }`. Mantık `code`'a bakar, metin sunucudan yerelleşmiş gelir.

`useMe()` son yanıtı `sessionStorage`'da tutar (jeton içermez, çıkışta silinir). Amacı yeni belgenin ilk karesinde bandın ve firma adının doğru çizilmesidir.

## Araçlar arası geçiş (ARCHITECTURE.md §8)

- `shell.css` içinde `@view-transition { navigation: auto; }`. Sağ küme (`sod-top-r`) animasyonsuz yerinde kalır, üst satır (`sod-top`: logo, menü) ve bant rengi kısa geçer, içerik (`sod-main`) yükselerek gelir. `prefers-reduced-motion` açıkta geçiş kapalı.
- `usePrefetchProducts`: açık araçlara `<link rel="prefetch">`; destek varsa üstüne gelince Speculation Rules ile önceden çizim.
- **Gateway notu:** satır içi speculation rules için CSP'de `script-src 'self' 'inline-speculation-rules'` gerekir. Yoksa tarayıcı kuralı sessizce yok sayar, prefetch yine çalışır.

## Belirteçler ve ortak bileşenler

- `src/styles/tokens.css` ve `src/bands.generated.ts` **üretilir** (kaynak `Platform/packages/tokens/tokens.json`; `npm --prefix Platform/packages/tokens run build`). Elle düzenlemeyin; değeri `tokens.json`'da değiştirin. Ayrıntı `Platform/docs/DESIGN.md` "Belirteç nerede değişir".
- DeciShip paneli `Button`, `ActionMenu`, `Tag`, `Card`, `Modal`, `Field`, `Pager`, `Empty`, `ErrorState`, `TableSkeleton`, `ToastProvider` ve `Icon`'u bu paketten alır (`ui.tsx`, `Toast.tsx`, `Icon.tsx` yeniden dışa aktarır).
- Yeni prop'lar: `Modal` `busy`, `dirty`, `guard` (Merkez'de de varsayılan açık: yazıp kapatınca "Yazdıklarınız silinsin mi?"; kapatmak için `guard={false}`), `className`; `ToastProvider` `suppress`, `actionPlacement` (`'bottom'` Merkez, `'stack'` DeciShip); `ActionMenu` `portal`, `dotsTrigger`, `dotsIcon`, `disabled`, `busy`; `Button` `kind` `'dark'` ve `'tert'`; `Pager` `label`. Eylemli bildirim 8 sn; hata bildirimi `role=alert`.
- Sayı, para, tarih biçimleri `@sellerondata/format` paketinden gelir; `format.ts` ince sarmalayıcıdır.

## i18n

`initShellI18n` kabuk metinlerini `shell` ad alanında getirir. Dil sırası `Person.locale` → `sod_lang` çerezi → tarayıcı dilleri (ilk desteklenen) → İngilizce (`contracts` `pickInitialLocale`; KARARLAR, ilk açılış dili). `useSessionActions().changeLocale` çerezi, `<html lang>`'ı ve hesabı günceller. Biçimler: `formatHubValue`, `formatMoney`, `formatDate`, `formatRelative`, `formatPhone`.

## Oturum dayanıklılığı

- Hesap kesikse (ağ geçidi 502/503/504) kabuk "Bağlantı yok" der. `useMe` son bilinen kişiyi döner, ürün verisi ve yazmaları çalışmaya devam eder. Ürün servisinin 503'ü genel uyarı değildir, o bölümün hatasıdır.
- Çıkış yalnız yenileme ucunun kesin 401'inde (`onSessionLost`). Ağ hatası ve 5xx: `ApiError` durum 0, kod `NETWORK_UNAVAILABLE`; kabuk "Bağlantı yok" ve "Yeniden dene" gösterir, formdaki yazı silinmez.
- Firma biliniyorsa her istekte `X-SOD-Org` (firma `useMe` ile öğrenilir; sunucu yazmalarda zorunlu kılar). `/api/account/auth/*` ve yenileme taşımaz: eski sekmeden çıkış ve firma değiştirme çalışmalı. Uyarı açıkken okuma istemcide durur (`409 ORG_MISMATCH`): sunucu okumaları denetlemez, yanıt başka firmanın verisi olurdu.
- `409 ORG_MISMATCH`: istek tekrarlanmaz. Sekmeler `BroadcastChannel('sod-session')` ile firmayı duyurur. `SessionBanner` (AppShell içinde, kabuk dışı ekranda elle) "Sayfayı yenile" ve "<firma> ile devam et" sunar; yazı varsa yenilemeden önce sorar.

## Mock tohumu

`@sellerondata/shell/mock-seed`: tek tohum (`createMockSeed`), depo anahtarları (`sod_mock_db`, `sod_mock_session`), `loadMockDb`, `saveMockDb`, `readMockSession`, `writeMockSession`. Merkez ve DeciShip tek kökende aynı kaydı okur. Ana girişten dışa aktarılmaz, üretim derlemesine girmez.

Dev sunucusu kabuğu `node_modules` bağlantısından okur ve izlemez: kabukta değişiklikten sonra sunucuyu yeniden başlatın.

İstemci: GET isteği `429` + `Retry-After` (en çok 60 sn) alırsa bir kez kendisi yeniden dener, o sırada kabukta kısa "yoğunluk" metni görünür. Yazma tekrar edilmez. `toast.ok(başlık, metin, { action, duration })`: "Geri al" gibi eylem.

## Test

`npm test` (vitest); metin denetimi `npm run check:i18n` (ortak `Platform/scripts/check-i18n.mjs`, `--strict`). Oturum istemcisi Node'da, `AppShell`/`PageHeader` happy-dom'da koşar. Kabuk React kurmaz (uygulamada iki kopya olurdu): bileşen testleri React'i `apps/hub-web/node_modules`'tan alır, önce orada `npm install` gerekir.
