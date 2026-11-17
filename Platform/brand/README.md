# SellerOnData marka dosyaları

Yazılış her zaman **SellerOnData** (büyük S, O, D; bitişik). Ürünler: **DeciShip**, **OrderLoom**, **TagPress**.
Ana marka: marka mavisi `#0f2a5c` + ölçü sarısı (gece `#0a1a3a` ayrı renktir: site ve giriş çatısı). Ürün renkleri işarette, etkin araç belirteçlerinde ve o aracın içindeki birincil düğmede. Birincil düğme rengi: Merkez'de lacivert `#0f2a5c`, her araçta aracın kendi rengi (DeciShip `#1d5bd8`). Tasarım kuralları: `Platform/docs/DESIGN.md`.
Tüm dosyalar `generate.mjs` ile üretilir; elle düzenlemeyin, üreticiyi değiştirin. Kabuğun kaynağı `Platform/packages/shell/src/marks.tsx`, yollar onunla aynıdır.

## Üretim

```
# repo dışında boş bir klasörde
npm i sharp opentype.js
node <repo>/Platform/brand/generate.mjs
```

Çıktı: tüm SVG'ler (küçük boy ve logolar dahil), `web/*.png`, `mobile/*.png`, `preview.png`. DeciShip dosyaları üretilmez (aşağıya bakın).

## Dosyalar

| Dosya | Ne zaman |
|---|---|
| `sellerondata-mark.svg` | Varsayılan işaret: marka mavisi kare, beyaz S, sarı ölçü çizgisi (≥ 24 px) |
| `sellerondata-mark-small.svg` | 16–24 px. Yarım daire dönüşlü, kalın çizgili S |
| `sellerondata-mark-mono.svg` | Tek renk (`currentColor`, kare yok): damga, faks, filigran |
| `sellerondata-mark-reverse.svg` | Marka mavisi/koyu zemin: beyaz kare, mavi S |
| `sellerondata-logo.svg` | Açık zemin, işaret + yazı |
| `sellerondata-logo-reverse.svg` | Koyu zemin |
| `sellerondata-logo-mono.svg` / `-mono-white.svg` | Tek renk koyu / beyaz |
| `orderloom-mark.svg`, `tagpress-mark.svg` | OrderLoom, TagPress işaretleri. Dosya adı ürünün kod anahtarıyla aynıdır (`PRODUCTS.orderloom`, `PRODUCTS.tagpress`). Merkez (`hub-web/public/brand/`) ve site (`apps/site/public/`) aynı adla kopyasını taşır |
| `deciship-mark.svg`, `deciship-mark-small.svg` | `Deciship/brand` kopyası. **Değişmez**, üretici dokunmaz |
| `web/favicon.svg` | Tanıtım sitesi (küçük S) |
| `web/favicon-hub.svg` | Merkez (`app.`): küçük S |
| `web/favicon-deciship.svg` | DeciShip: küçük koli |
| `web/favicon-orderloom.svg`, `web/favicon-tagpress.svg` | OrderLoom, TagPress (tam işaret; 16 px'te okunur) |
| `web/favicon-32.png`, `favicon-16.png` | Küçük S, PNG |
| `web/apple-touch-icon.png` | 180, tam kare marka mavisi (iOS köşeyi kendisi keser) |
| `mobile/icon.png` | 1024, saydamsız, tam kare |
| `mobile/adaptive-foreground.png` | Android ön plan, saydam; S kutusu tuvalin ~0.44'ü (güvenli daire 0.61) |
| `mobile/adaptive-background.png` | Düz `#0f2a5c` (app.json'da `backgroundColor` da aynı) |
| `mobile/monochrome.png` | Android temalı ikon: beyaz, saydam |
| `mobile/splash.png` | 1024 saydam S; zemin app.json'da `#0f2a5c`, `imageWidth` 200, `resizeMode` contain |
| `preview.png` | 16, 32, 48, 192, 1024 boyunda tablo (1024 sütunu 256'ya küçültülmüş) |
| `fonts/` | Yalnız yazı logosunu yola çevirmek için (IBM Plex Sans SemiBold, OFL) |

Mobil `app.json` karşılığı (DeciShip'teki gibi): `icon` → `icon.png`; `android.adaptiveIcon.{foregroundImage, backgroundImage, monochromeImage, backgroundColor}` → `adaptive-foreground.png`, `adaptive-background.png`, `monochrome.png`, `#0f2a5c`; `expo-splash-screen.image` → `splash.png`.

## Renkler

| Ad | Değer | Kullanım |
|---|---|---|
| Marka mavisi | `#0f2a5c` | SellerOnData işaretinin zemini, koyu marka yüzeyi |
| Gece | `#0a1a3a` | Tanıtım sitesi ve giriş ekranlarının çatısı (marka mavisiyle karıştırılmaz) |
| Merkez grafiti | `#2a2d34` | Merkez uygulamasının bandı (kullanıcı kararı); marka mavisi Merkez'de işarette ve birincil düğmede kalır |
| Ölçü sarısı | `#fdb022` | **Yalnız** işaretteki ölçü çizgisi/ayrıntısı. Durum rengi değildir |
| Mürekkep | `#101828` | Yazı logosu, tek renk işaret |
| DeciShip mavisi | `#1d5bd8` | DeciShip işareti ve DeciShip içindeki birincil düğme |
| OrderLoom | `#0e9384` | `PRODUCTS.orderloom.color` (tek kaynak `packages/contracts`) |
| TagPress | `#7a5af8` | `PRODUCTS.tagpress.color` |

## Kurallar

- **Küçük boy:** 24 px altında `-small` (favicon, sekme). Tam logo en az 20 px yükseklik. 16 px'te sarı çizgi bir vurgudur, S okunur kalmalıdır; küçük S'yi değiştirirseniz `preview.png` 16/32 sütunlarına bakın.
- **Boşluk:** logonun çevresinde işaret yüksekliğinin ¼'ü. İşaret ile yazı arası: işaret yüksekliğinin ¼'ü.
- **Yazı:** IBM Plex Sans SemiBold, SVG'lerde yola çevrilmiştir. Başka yazı tipiyle yeniden dizmeyin.
- Koyu zeminde marka mavisi kare kaybolur; `-reverse` kullanın.
- Yapmayın: döndürmek, gölge/degrade, renk değiştirmek, sarı çizgiyi kaldırmak (tek renk hariç), kareyi daireye çevirmek, sarıyı arayüzde durum rengi yapmak.
- DeciShip işareti `Deciship/brand`'in kopyasıdır. Değişiklik orada yapılır, buraya yeniden kopyalanır.
