# SellerOnData tasarım belgesi

Merkez, DeciShip paneli, mobil ve site buna uyar. **Kod doğrudur**: ayrışırsa belge düzeltilir; değer değişirken önce kod, sonra belge.

Kısaltmalar: `tokens.json` = `Platform/packages/tokens/tokens.json` · `tokens.css`, `shell.css`, `primitives.css` = `Platform/packages/shell/src/styles/` · `theme.ts` = `Deciship/apps/mobile/src/ui/theme.ts` · `site.css` = `Platform/apps/site/src/site.css`.

## 1. Üç yüzey, üç dil

- **Site dili** (site; giriş, kayıt, katılım, şifre; firmasız kişinin "Firma oluştur" ekranı `AuthFrame`): kâğıt zemin, gece (`--night`) çatı, sarı düğme. `site.css`, `hub-web/src/styles/auth.css`.
- **D09 Renk bandı** (Merkez `Platform/apps/hub-web`, Hesabım ve Yeni firma dahil; DeciShip paneli `Deciship/apps/web`): ortak kabuk `Platform/packages/shell`; Hesabım `account.css` (`.acc`).
- **D05 Yoğun çalışma masası** (DeciShip mobil, Merkez sekmeleri dahil): §5.
- **Tezgâh** (TagPress web): aynı kabuk, alçak `work` bandı ve masaüstü yoğunluğu; §7, değerler `Tagpress/DESIGN.md`.
- Ortak: IBM Plex Sans + Mono, kâğıt zemin, beyaz kart, ürün renkleri, logo ailesi. Koyu tema yok (`color-scheme: light`, mobil `userInterfaceStyle: light`).

### Belirteç nerede değişir

Renk, ölçü, köşe, gölge, bant ve ürün paleti yalnız `tokens.json`'da değişir, sonra üretilir:

```
npm --prefix Platform/packages/tokens run build   # yazar
node Platform/packages/tokens/build.mjs --check   # güncel mi (yazmaz; değilse çıkış 1)
npm --prefix Platform/packages/tokens test        # --check + kontrast, bütünlük
```

- Üretilen dosyalar (§8) commit edilir, elle düzenlenmez ("ÜRETİLDİ" başlığı; sonraki üretim siler).
- **Yüzeyler arası farklar** adlı durur: `tokens.json` `surfaces.decishipWeb`, `mobile`, `hubAuth`, `site`, `tagpressWeb` (TagPress rengi ve `--tz-*` Tezgâh değerleri); DeciShip `app.css` sonu "DeciShip farkları" (yorumda kabuk değeri). Hizalama kullanıcı kararı; tek değere indirmeyin.
- **CSS sırası:** DeciShip (`main.tsx`) `tokens.css` → `tokens.deciship.css` → `shell.css` → `primitives.css` → `app.css` → `pages/*.css`; Merkez (`styles/index.css`) tokens → primitives → shell → `hub.css` → `tokens.hub.css`. Sıra çakışan seçicide kazananı belirler; değiştirmeden önce `npm run test:visual`.

### Biçimleme (sayı, para, tarih)

- Tek yer `Platform/packages/format` (bütün yüzeyler ve hesap motoru); kurallar `KARARLAR.md` "Ortak arayüz".
- TR "1.234,50 ₺", EN "₺1,234.50"; eksi sıfır yok; ekranda Unicode eksi, kayıtlı ve dışa giden metinde ASCII; 24 saat, 4 haneli yıl; geçersiz değer "—".
- Para metni boşluktan bölünmez (bölünmez boşluk); parça için `moneyParts`. Pakette `Intl.NumberFormat` ve benzerleri yasak (Hermes).

## 2. Renk

### Temel renkler (`tokens.json`)

| Belirteç | Değer | Kullanım |
|---|---|---|
| `--bg` | `#f5f3ee` | Sayfa zemini (kâğıt) |
| `--surface`, `--surface-2`, `--surface-3` | `#ffffff`, `#faf9f6`, `#ebe8e1` | Kart / ikincil zemin, üzerine gelme / nötr etiket, ilerleme izi |
| `--border` | `#e4e1da` | Kart kenarı |
| `--line`, `--line-soft` | `#d9d6cf`, `#eeebe5` | Satır, bölüm çizgisi / kart içi ayraç |
| `--border-strong`, `--border-hover` | `#8f8a80`, `#6b665d` | Alan kenarı / üzerine gelme; WCAG 1.4.11 ≥ 3:1 (beyazda 3,43 ve 5,70, kâğıtta 3,10). Mobil `#c9c5bc` |
| `--text`, `--text-2`, `--text-3` | `#0f1a2e`, `#475467`, `#5f6b7f` | Metin; `text-3` açık zeminlerde ≥ 4.5:1 |
| `--placeholder` | `#8d93a0` | Yalnız yer tutucu |
| `--primary` (`-hover`, `-active`) | `#1d5bd8` (`#174bb5`, `#133f99`) | Araçta birincil, bağlantı, seçili |
| `--primary-soft`, `--primary-line` | `#e8eefc`, `#c7d7f8` | Seçili satır, bilgi kutusu |
| `--success` `-bg` `-line` | `#067647` `#ecfdf3` `#abefc6` | Uyumlu, gönderildi |
| `--danger` `-bg` `-line` (`-hover`) | `#c4271b` `#fef3f2` `#fecdca` (`#b42318`) | Hata, fark |
| `--warning` `-bg` `-line` | `#b54708` `#fffaeb` `#fedf89` | Uyarı, kuyrukta |
| `--focus`, `--focus-on-dark` | `#1d5bd8`, `#b5cbff` | Odak: açık zemin / bant ve koyu zemin |
| `--focus-ring`, `--scrim` | `0 0 0 3px rgba(29,91,216,.25)`, `rgba(15,26,46,.45)` | Odak halkası, pencere örtüsü |
| `--brand-ink`, `--sod-ink` | `#0f2a5c` | Marka mavisi: işaret, Merkez birincili |
| `--night` | `#0a1a3a` | Gece (zemin): site ve giriş çatısı, Pano baş kartı, mobil. Marka mavisiyle karıştırılmaz |
| `--accent` | `#fdb022` | Ölçü sarısı: işaret, vurgu; **durum rengi değil** |
| `--chart-1..4`, `--chart-prev`, `--chart-grid` | `#1d5bd8`, `#dc6803`, `#0e9384`, `#7a5af8`, `#98a2b3`, `#eeebe5` | Grafik serileri, önceki dönem, ızgara |

Merkez'de (`:root[data-sod-product='hub']`) birincil aile marka mavisi: `--primary #0f2a5c`, `-hover #0b2049`, `-active #081a3d`, `-soft #e8edf7`, `-line #c5d0e6`; pencere ve bildirim de.

### Ürün renkleri (`tokens.json` `products`, `bands` → `palette.generated.ts`, `bands.generated.ts`)

| Ürün | Renk | Bant | Bant birincil düğmesi | Etkin menü çizgisi |
|---|---|---|---|---|
| Merkez | işaret `#0f2a5c` | grafit `#2a2d34` (ikinci `#363a43`, yazı `#d3d6dc`) | sarı `#fdb022`, yazı `#2a2d34` | sarı `#fdb022` |
| DeciShip | `#1d5bd8` | `#1d5bd8` (ikinci `#1546b8`, yazı `#e8eefc`) | beyaz, yazı `#1d5bd8` | `#b5cbff` |
| OrderLoom | `#0e9384` | `color-mix(renk 82%, siyah)` | beyaz, yazı bant tonunda | `color-mix(renk 35%, beyaz)` |
| TagPress | `#7a5af8` | `#644acb` (ikinci `#533da9`, yazı `#f2effe`); `tokens.json` `bands.tagpress` | beyaz, yazı `#644acb` (üzerine gelince `#f2effe`) | `#d0c5fd` |

- TagPress bandı OrderLoom'daki kalıbın onaltılık yazılmış hâlidir (Tezgâh onayı); `bandTheme('tagpress')` üretilen `TAGPRESS_BAND`'ı döner, tokens testi kalıpla eşitliği denetler.

- Ad yalnız `catalog.ts`'ten, renk `tokens.json`'dan (`PRODUCT_PALETTE`); mobil de oradan.
- Beş ton `--p-hero` / `--p-main` / `--p-on-dark` / `--p-soft` / `--p-text` (site ürün sayfaları; `text` kâğıtta ve beyaz `hero` üzerinde ≥ 4.5, `tokens` testi): DeciShip `#1546b8 #1d5bd8 #b5cbff #e8eefc #1546b8`; OrderLoom `#075e55 #0e9384 #7de8d9 #e3f5f2 #0b6b60`; TagPress `#3d2a99 #7a5af8 #cfc3ff #efebff #5b3fd6`.

### Birincil düğme kuralı (kullanıcı kararı: bugünkü hal)

- Sayfa içi birincil: Merkez marka mavisi `#0f2a5c`, araç kendi rengi (DeciShip `#1d5bd8`). `--primary` kullanılır, renk elle yazılmaz.
- Bant üstündeki birincil ters çizilir (tablodaki sütun); OrderLoom ve TagPress kendi renkleriyle aynı kural. "Her yerde `#1d5bd8`" geçersiz.
- Site ve giriş ekranlarında birincil sarı `#fdb022`, yazı gece `#0a1a3a` (`.btn-sun`).

### Durum renkleri

- Durum: başarı yeşil, uyarı kahve-turuncu, tehlike kırmızı. Hata için uyarı rengi, odak için hata rengi yok. Ölçü sarısı (işaret, Merkez bandı menü çizgisi, mobil Merkez sekmesi) durum göstermez.
- Metin rengi yalnız `text`, `text-2`, `text-3` ve durum belirteçleri.

## 3. Yazı, ölçü, köşe, gölge (web)

Kaynak: `tokens.json`, `primitives.css`, `shell.css`.

- `--f`: `'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif`; 400 / 500 / 600.
- `--fm`: `'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace`: takip no, kod, eyebrow. Sayılar `.num` / `.mono` ile `tabular-nums`. `letter-spacing` gövdede 0, büyük başlıkta eksi.

Yazı ölçeği (boyut / satır, ağırlık; parantezde telefon):
- Gövde 16 / 1.55, 400. `.btn` 16 / 20, `.btn-sm` 15, `.inp` 15, `.sod-nav` 15 / 20.
- Bant başlığı 36 / 44, `-0.02em`, 600 (26 / 34); alt metin 17 / 24 (15 / 20).
- Büyük bant (`hero`) 56 / 1.05, `-0.025em`, 600 (38); alt metin 19 / 1.5 (17).
- Bant dışı başlık `.ptitle` 32 / 1.15, `-0.02em`, 600 (26); alt metin 16 / 1.5.
- Eyebrow Mono 13 / 18, `.06em`, büyük harf. Kırıntı 14 / 20, bağlantı 500.
- Kart başlığı `.card-h .tt` 18 / 26, `-0.01em`, 600; açıklama 14 / 20. Tablo başlığı 13 / 18, 500; hücre 15. Rozet `.tag` 13 / 18, 500.
- Logo kilidi: ad 17 / 20, 600; `SellerOnData` 12 / 16, 400; Merkez'de ad büyük harf, `.04em`.

Ölçüler:
- Düğme `--btn-h` 48 px (yan dolgu 22, ikon arası 8); küçük 40 px (dolgu 14). Alan `--ctl-h` / `--ctl-h-sm` 44 / 40 px (dolgu 12).
- Sütun `--sod-wrap` = `--content-max` 1240 px; `--gutter` 32 (≤ 760 px'te 16); `.content` üst 32, alt 72.
- Kart iç boşluğu 24 / 28 (üst-alt / yan), kart başlığı altı 16. Tablo başlığı 44 px, satır 56 px, hücre dolgusu 10 / 16. Rozet 26 px, dolgu 10. Yan panel `--panel-w` 420 px.
- Bant: üst satır 72 px; standart bant en az 240 px (1440'ta), telefonda 289 px; ikinci satırla uzar. `work` bandı (yalnız TagPress çalışma ekranları): 72 px üst satır + 44 px iş satırı, alt boşluk yok.
- Köşe: `--r-ctl` 10 (alan, küçük düğme) · `--r-btn` 12 · `--r-card` 16 (kart, pencere) · `--r-pill` 999 (rozet).
- Kırılımlar: kabuk ≤ 760 (`shell.css`); bileşenler 767 / 1023 / 1279 (`primitives.css`).

Gölge:
- `--sh-sm` `0 1px 2px rgba(15,26,46,.04)`: Merkez'de birkaç kutu (`hub.css`). `.card` gölgesiz, yalnız 1 px kenar.
- `--sh-md` `0 4px 12px rgba(15,26,46,.08)`: atlama bağlantısı.
- `--sh-lg` `0 12px 32px rgba(10,26,58,.12)`: pencere, ⋯ menü, bildirim, kayan panel. Kabuk açılır kutusu `.sod-pop` `0 12px 32px rgba(10,26,58,.16)`.

### Bileşenler (`primitives.css`, `primitives.tsx`)

- **Düğme:** `.btn-primary` (ekranda en çok bir) · `.btn-secondary` (beyaz, `--line` kenar, 500) · `.btn-ghost` · `.btn-danger` · `.btn-danger-outline` · `.btn-sm` · `.btn-icon`. İkon metnin önünde; `arrow`/`chevr` sonda. Eski `dark`/`tert` yerine `secondary`.
- **Alan:** `.inp`, `.sel`, `.txt`; dört kenar çerçeve; odakta `--focus` kenar + 1 px halka, hatada `--danger`. Etiket hep üstte ve görünür; yer tutucu etiket yerine geçmez. Telefonda yazı 16 px (iOS yakınlaştırmasın).
- **Kart** `.card` (beyaz, `--border`, r16), tablo için `.card.flush`. **Rozet** `.tag` + `green | red | yellow | blue | gray | purple | teal`: açık zemin, renkli kenar, koyu yazı.
- **Boş durum:** ikon + kısa başlık + tek cümle + tek eylem. **Pencere:** masaüstünde ortada, telefonda alttan sayfa.
- **Toplu seçim bandı** (DeciShip fatura ayrıntısı; `invoice-detail/BulkBar.tsx`, `styles/pages/bulk.css`):
  - Satır başında kutu (`.ln-sel`); uygun olmayanın kutusu kapalı, ipucu nedeni söyler. Başlık kutusu sayfayı seçer; kısmi seçimde ara durum.
  - Tablo üstünde: "N satır seçildi" · "İtiraz listesine ekle", "Uyumlu say" · "Seçimi kaldır"; sayfa tümüyle seçiliyse "Bu süzgeçteki N satırın tümünü seç".
  - Telefonda alta yapışır. Seçim açıkken sayfanın birincili ikincile iner. Sonuç bildirimde, "Geri al" ile.
- **Giriş ve kayıt alanları** (`auth.css`): odakta mavi çerçeve ve halka (`--a-focus`), hatada kırmızı (`--a-bad` = `--danger`); amber yalnız düğmede.

## 4. D09 kabuğu ve sayfa kurma

Düzen: üst satır (72 px) → ürün renginde bant (başlık, eylemler) → banda binen ilk kart. Yerleşim çizimi ve prop'lar: `Platform/packages/shell/README.md`.

- **Üst satır her üründe aynı** (TagPress dahil); yalnız renk ve logo değişir. Logo kilidi en az 136 px, hemen sağında ⊞ araç değiştirici (açık olmayan devre dışı; liste sola yaslı açılır); menü her üründe aynı x'te başlar.
- **Yatay menü** `productNav`, grup adı yok. Geniş ekranda bölmeli sekmeler: açık oluk, seçili sekme beyaz zemin + bant tonunda yazı 600, solunda `icon`; sığmayınca önce simgeler gizlenir, sonra oluk kayar. Telefonda simgesiz, etkin öğe beyaz 600, altında 2 px `--sod-band-accent`.
- **Sağ küme:** aracın alanı (`headerSlot`; 1023 px'e kadar gizli), firma seçici, avatar (profil, güvenlik, "Yardım ve destek" (`supportHref` ile), dil, çıkış).
- **Telefonda (≤ 760)** ⊞ gizli; araçlar alttaki `.sod-dock`'ta (etkinin üstünde kendi renginde 3 px çizgi ve açık ton; açık olmayan soluk). Üst satır kaydırınca sabit.
- **Sekme başlığı:** `Sayfa · Ürün` (`navigation.ts`).

Sayfa kurma:
1. Sayfa başına tek `PageHeader`; AppShell içinde banda taşınır: `title`, `sub`, isteğe bağlı `eyebrow`, `crumbs`, `actions`.
2. Başlık geniş ekranda tek satır (taşan `…`), ≤ 760 px en çok iki; alt metin en çok iki satır, fazlası kesilir; bant ikinci satırla uzar. Telefonda boş eylem satırı yer tutmaz; menü yana kayar, kenarları solar.
3. Büyük bant (`hero`) yalnız Merkez Genel Bakış ve DeciShip Pano'da. Bant boyları (`BandSize`): `standard`, `hero`, `none` (başlık yok, standart yüksekliğinde), `work` (Tezgâh; aşağıda §7).
4. `actions` içinde en çok bir `.btn-primary`; ikinciller `.btn-secondary`, nadir eylemler ⋯ (`ActionMenu`).
5. İlk karta `sod-lift`: standart bantta 24 px (telefonda 16), büyük bantta 72 px (telefonda 64) banda biner.
6. Sekmeler (`tabs`) bantta değil, içeriğin başında. Bant dışı birincil §2'ye uyar.
7. Erişilebilirlik: görünür odak; ikon düğmesinde `aria-label` (görünen metinle başlar); dokunma hedefi ≥ 44 px; `prefers-reduced-motion` açıkken geçiş yok. `forced-colors`: kabuğun `a11y.css`'i (iki uygulama da yükler) denetimlerde `ButtonText` çerçeve, odakta 2 px `Highlight` halka verir. Satır içindeki düğme, kutu ya da menüden gelen tuş satırı açmaz (`rowProps`; satırda `aria-selected` yok).

## 4b. Hata ve kayıp önleme (web)

Kaynak: kabuk `primitives.tsx` (`Modal`, `SlideOver`, `ToastProvider`), `modalGuard.ts`, `LeaveGuard.tsx`, `leaveRules.ts`, `ErrorBoundary.tsx`; DeciShip bunları yeniden dışa aktarır.

- **Pencere onayı (sarı şerit)**, `Modal` ve `SlideOver` (ör. Ekip daveti), Merkez ve DeciShip:
  - Alan değiştiyse (yazı, seçim, onay kutusu; arama sayılmaz) Esc, dış tıklama ve X kapatmadan önce sorar.
  - İç içe pencere ya da tarayıcı kutusu değil: alt eylem şeridi sarı (`--warning-bg`, `--warning-line`) onay şeridine döner; kısa başlık, tek cümle, "Düzenlemeye dön" (odak) ve "Sil ve kapat" (tehlike). Telefonda alt alta.
  - "Vazgeç"/"Kaydet" sormaz. İşlem sürerken (kaydetme, içe aktarma, tarama) pencere kapanmaz; X devre dışı, `title` "İşlem sürüyor".
- **Sayfa çıkış uyarısı** (DeciShip Ayarlar, fatura yükleme, tarife düzenleyici): kaydedilmemiş değişiklikle sayfa değişirken "Değişiklikler kaydedilmedi", "Sayfada kal" / "Kaydetmeden çık"; sekme kapanınca tarayıcı uyarısı; sorgu değişimi sormaz. `useLeaveGuard` `createBrowserRouter` ister; Merkez `BrowserRouter`'da, önce yönlendirici geçirilmeli.
- **Hata ekranı:** ortada kart, uyarı ikonu, "Bu bölüm açılamadı" (tam sayfada "Sayfa açılamadı"), tek cümle, birincil "Sayfayı yenile", ikincil ana sayfa, kapalı "Teknik ayrıntı" (DeciShip `RouteError` aynı). Bant ve menü yerinde kalır.
- **Bildirim (toast)** menü ve düğme örtmez: masaüstünde sağ üstte `top` 84 px; ≤ 1023 px'te 109 px; `.sod-status` bandı ("Bağlantı yok", oturum) varsa 64 px daha aşağı. Telefonda altta.
- **Liste hatası** (ör. abonelikler): yalnız hata kutusu; "Açık değil" gibi yanıltıcı satır yok.

## 5. D05 mobil

Kaynak `theme.ts`, `components.tsx`. Kâğıt zemin, beyaz kart, kimliğe göre renkli üst çubuk, altta beyaz eylem şeridi ve tek birincil.

- Zemin `#f7f6f3`, kart `#ffffff`, kenar `#e4e2dc` (güçlü `#c9c5bc`); birincil `#1d5bd8` (basılı `#1546b8`); başarı `#0b6b3a`, uyarı `#7a4f00`.
- Köşe 6 (düğme, kart), rozet 999. Dokunma en az 48 dp (birincil 48, büyük birincil 52, sayı tuşu 52, satır 48). Boşluk 4 / 6 / 10 / 12 / 16 (ekran kenarı 12, kart arası ve kart iç 10). Gölge yalnız alt çubuk ve kayan bildirimde.
- Yazı: gövde 14/20, küçük 12/17, etiket 12/16 500, kart başlığı 13/18 600, sayfa başlığı 18/24 600, büyük sayı 40/46 600, sonuç 24/28. Alan en az 46 yükseklik, yazı 16, odakta 2 px mavi çerçeve.
- Üst çubuk (`bands`, web bandıyla aynı): `site` gece `#0a1a3a` (giriş, davet) · `hub` grafit `#2a2d34`, vurgu sarı · `deciship` `#1d5bd8`, vurgu beyaz. Merkez sekmelerinde gösterge ve seçim işareti marka mavisi (`hubColors.ink`); sekmelerde birincil yok.

Kurallar:
- Ana eylem altta sabit şeritte (`Footer`), tam genişlik, tek birincil; devre dışıyken eksiği söyler ("Üç ölçüyü de girin"). Nadir eylemler üst çubukta ⋯ (`OverflowMenu`, satır 52 dp).
- Akışta adım göstergesi ("Adım 2/5 · Ağırlık"): Barkod → Ağırlık → Ölçü → Fotoğraf → Özet.
- Cihazın yapamayacağı seçenek (ARCore yoksa AR, LiDAR yoksa LiDAR) listeden çıkar.
- Kamera ekranı koyu vizör (`#0b1430`); ipucu yarı saydam koyu kutuda beyaz. Kamera penceresinde hata deklanşörün üstünde kırmızı tek satır (RN `Modal` üstünde bildirim görünmez).
- IBM Plex yalnız Android'e gömülü (`plugins/with-fonts.js`); ağırlık dosya adıyla seçilir, iOS sistem yazı tipine düşer.
- Metin kısa, eylem odaklı ("Barkodu okutun"); hata ne yapılacağını söyler.
- Geçersiz değer kırpılmaz: alan yazılanı korur, altında kırmızı tek satır ("En çok 400 cm"). Akla aykırı ama geçerli değer özette sarı bantla sorulur ("Lütfen kontrol edin", "Değerler doğru"); onaya kadar kaydet kapalı.
- Yarım ölçüm "Bugün"de en üstte tek kart: "Yarım ölçüm", takip no ya da "Barkod okutulmadı" · başlama saati, "Devam et" ve "Sil" (onaylı).
- Hata ekranı: "Bir sorun oldu", tek cümle, "Yeniden dene"; sekme katmanında ikincil "Bugün'e dön".

## 6. Sadelik ilkeleri

- Ekran başına **tek birincil eylem**; **nadir eylemler ⋯ menüsünde** (dışa aktarma, sütun seçimi, silme).
- **Az süzgeç**: en sık bir iki tanesi açıkta, gerisi "Filtreler" panelinde.
- **Kısa metin**: başlık birkaç kelime, alt metin tek cümle; açıklama gerekirse açılır bölümde.
- **Sadeleştirme özellik silmez**: eylem menüye, bilgi ayrıntı paneline taşınır.
- Kalabalık ekran yok: eş boy kart ızgarası ve renkli ikon kutusu yerine tek baş rakam ve cetvelli satırlar. Marka öğesi sayfa başına en çok bir kez; içerikte süs yok.
- Ürün adları **SellerOnData**, **DeciShip**, **OrderLoom**, **TagPress**. "İşçi" denmez, **"çalışan"**; küçültücü ifade yok. Metin kodda değil TR/EN yerel dosyalarda.

Terimler (TR, EN):
- **Firma** (Company): ödeyen kuruluş. **Üye, üyelik** (Member, membership): kişinin bir firmadaki kaydı, yalnız bu anlamda. **Abonelik** (Subscription): firmanın bir araçtaki planı. **Rol** (Role): bir araçtaki izin kümesi.
- **Araç** (Tool): DeciShip, OrderLoom, TagPress; uygulamada "ürün" denmez (sitenin ticari başlıklarında kalabilir). **Çalışan** (Employee): "işçi" değil. **Merkez** (Hub): platformun ortak yüzü.
- **Hesabım** (My account): Profil, Güvenlik, Firmalarım; avatar menüsünün ilk öğesi. **Firmalarım** (My companies): `/account/firms`.
- **Gece** `#0a1a3a` (zemin) ve **marka mavisi** `#0f2a5c` (işaret): iki ayrı rol, iki ayrı ad.

## 7. Yeni araç (OrderLoom, TagPress)

- **Ad ve renk:** `contracts/src/catalog.ts` (`PRODUCTS.<anahtar>.name`) ve `tokens.json` `products`; başka yerde elle yazılmaz.
- **Bant:** AppShell `bandTheme` katalog renginden türetir; kabuk değişmez (sabit bant istenirse `tokens.json` `bands` girdisi ve `bandTheme` satırı; bugün DeciShip ve TagPress). **Birincil düğme:** aracın rengi (§2).
- **Logo:** `Platform/brand/generate.mjs` üretir (`orderloom-mark.svg`, `tagpress-mark.svg`, `web/favicon-orderloom.svg`, `favicon-tagpress.svg`); kabukta `packages/shell/src/marks.tsx`. Elle düzenlenmez. Kurallar `Platform/brand/README.md`.
- **Tasarım dili:** OrderLoom için seçilmedi; bant ve menü hazır, araç içi ekran dili (yoğunluk, mobil, sayfa kalıpları) kullanıcı seçene kadar varsayılmaz, DeciShip kalıpları sormadan kopyalanmaz.
- **TagPress: Tezgâh** (kullanıcı onayı 2026-11-21; maketler `Tagpress/docs/tezgah-tuval.html`, değerler `Tagpress/DESIGN.md`). Tasarım aracı olduğu için iki istisna: çalışma ekranlarında alçak bant (72 px üst satır + 44 px iş satırı, içerik kenardan kenara) ve masaüstü yoğunluğu (alan 30 px, araç düğmesi 32 px; kılavuzlu akışta 48 px). Sadelik (§6) aynen geçerli; araçlar ekranda kalır, kısayol rozeti yalnız sık işlerde, nadir ayar kapalı grupta.
- **TagPress kabuğu:** platform kipinde ortak kabuk `AppShell workspace` ile: bant ve içerik kenardan kenara (`.sod-wrap` 1240 px sınırı yok, kenar 24 px, telefonda 16), sayfa boy bildirmezken bant `work` boyunda (zıplamaz). Üst satır Merkez ve DeciShip'inkiyle aynı (§4: ⊞ logonun sağında, bölmeli sekmeler); tek fark bantta odak çizgisinin beyaz olması. Form ve liste ekranları (Kurulum, Ayarlar, listeler) `column` verir (kökte `data-sod-column`): bandın başlık bölgesi ve içerik Merkez sütununa döner (1240 px, kenar 32, telefonda 16). Üst satır ve iş satırı her ekranda (çalışma ekranında da) Merkez ve DeciShip sütununda durur; ekran değişince logo, sekmeler ve iş satırı kaymaz; çalışma alanı kenardan kenara. İş satırı ve Kurulum bandı aracın düğümü olarak bant portalına çizilir. `workspace` verilmezse Merkez ve DeciShip kabuğu değişmez. Yerel kipte (girişsiz) TagPress kabuğun ölçüleriyle kendi üst satırını çizer.
- **TagPress belirteçleri:** `tokens.json` `bands.tagpress` ve `surfaces.tagpressWeb` → üretilen `Tagpress/apps/web/src/tezgah/tokens.generated.css` (aracın rengi ve `--tz-*`). `Tagpress/apps/web/src/tezgah/tokens.css` yalnız yerel kipte yüklenen `base` kopyasıdır; kaymayı `tokens.test.ts` denetler.

## 8. Kaynak dosyalar

- Tek kaynak `tokens.json` (üretici `build.mjs`). Üretilen: kabuk `styles/tokens.css`, `bands.generated.ts`; DeciShip `styles/tokens.deciship.css`; mobil `theme.generated.ts`; site `styles/tokens.css`; Merkez `hub-web/src/styles/tokens.hub.css` (`.auth`); TagPress `tezgah/tokens.generated.css`; contracts `palette.generated.ts`.
- Kabuk `shell.css`, `primitives.css`, `a11y.css`, `AppShell.tsx` · DeciShip `app.css`, `pages/*.css`, `Deciship/DESIGN.md` · mobil `theme.ts`, `components.tsx` · site `site.css` · marka `Platform/brand/`.

## 9. Bilinen farklar

- Kabuktan farklı DeciShip değerleri (ör. düğme dolgusu 20 / 15 ile 22 / 16) yalnız `app.css` "DeciShip farkları"nda; eşit olmayan belirteçler `surfaces` altında (ör. DeciShip `--warning #7a4100`, `--primary-hover #1546b8`, `--sh-sm none`, `--topbar-h 56px`). Gece ve marka mavisini tek maviye indirmek görünür değişiklik: kullanıcı kararı.
