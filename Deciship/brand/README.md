# DeciShip marka rehberi

**DeciShip** = *desi* (hacimsel ağırlık) + *ship*. Kolinin gerçek ölçüsünü kaydeder, kargo faturasını o ölçüm ve tarifeyle doğrular.
Ton: güvenilir, net, sakin. Süs yerine doğruluk; her görsel öğe bir şey anlatır.

## İşaret

Ölçülmüş koli: izometrik bir koli (dolu kapak, bantlı) ve altında, ön kenarına paralel bir **ölçü çizgisi**.
Ölçü çizgisi "ölçü sarısı" ile çizilir; markanın tek vurgu rengi budur.

| Dosya | Ne zaman |
|---|---|
| `deciship-logo.svg` | Varsayılan: açık zemin, işaret + yazı |
| `deciship-logo-reverse.svg` | Koyu zemin (`#0c111d`, `#0f2a5c` gibi) |
| `deciship-logo-mono.svg` / `-mono-white.svg` | Tek renk baskı, faks, damga, filigran |
| `deciship-mark.svg` | Yalnız işaret (uygulama ikonu, avatar, ≥ 24 px) |
| `deciship-mark-small.svg` | 16–24 px (favicon). Bant ve ölçü uçları yok, çizgi kalın |
| `deciship-mark-mono.svg` | Tek renk işaret (`currentColor`) |

Kod içinde: web `apps/web/src/components/Brand.tsx` (`BrandMark`, `BrandLogo`, `BrandGlyph`), mobil `apps/mobile/src/ui/BrandMark.tsx`.
Bu klasördeki SVG'ler ve web favicon/ikonları `generate.mjs` ile üretilir; elle düzenlemeyin, üreticiyi değiştirin. Mobil uygulama ikonları DeciShip işareti değil SellerOnData işaretidir; onları `Platform/brand/generate.mjs` üretir (aşağıda "Uygulama ikonları").

## Renkler

| Ad | Değer | Kullanım |
|---|---|---|
| DeciShip mavisi | `#1d5bd8` | İşaretin zemini, DeciShip içindeki birincil düğme ve bağlantı (kurallar: `Platform/docs/DESIGN.md`) |
| Marka mavisi | `#0f2a5c` | Koyu marka yüzeyi (giriş sayfasının sol paneli) |
| Mürekkep | `#101828` | Yazı logosu, ana metin |
| Ölçü sarısı | `#fdb022` | **Yalnız** işaretteki ölçü çizgisi ve marka süsü. Arayüzde durum rengi olarak kullanılmaz (uyarı rengi `#b54708` ayrıdır) |

## Yazı tipi

IBM Plex Sans SemiBold (600) — yazı logosu (SVG'lerde yola çevrilmiştir, yazı tipi gerekmez) ve başlıklar.
Arayüz: IBM Plex Sans 400/500/600; sayılar IBM Plex Mono, `tabular-nums`. Harf aralığı 0.
Yazılış her zaman **DeciShip** (büyük D, büyük S, bitişik). "Deciship", "DECISHIP", "Deci Ship" yazmayın.

## Kullanım

- **Boşluk:** logonun çevresinde en az işaret yüksekliğinin ¼'ü kadar boşluk bırakın (64 px işarette 16 px).
- **En küçük boy:** tam logo 20 px yükseklik; işaret tek başına 16 px (`-small` sürümü).
- **İşaret ile yazı arası:** işaret yüksekliğinin ¼'ü (web'de 12 px).
- Zemin: işaret mavi karesini kendi taşır; renkli/fotoğraflı zeminde de kare korunur. Koyu zeminde `-reverse` kullanın.
- Yapmayın: işareti döndürmek, gölge/degrade eklemek, renkleri değiştirmek, ölçü çizgisini kaldırmak (16 px hariç), kareyi daireye çevirmek, yazıyı başka yazı tipiyle yeniden dizmek.

## Uygulama ikonları

- Web: `apps/web/public/favicon.svg` (küçük işaret), `favicon.ico` (16/32/48), `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `site.webmanifest`.
- Mobil (`apps/mobile/assets`): mobil uygulama SellerOnData adıyla çıkar ve ikonu SellerOnData işaretidir: marka mavisi (`#0f2a5c`) zeminde beyaz S, sarı ölçü çizgisi. `icon.png` (1024, tam kare marka mavisi), `android-icon-foreground.png` + `android-icon-background.png` + `android-icon-monochrome.png` (uyarlanabilir ikon; `app.json` `backgroundColor` `#0f2a5c`), `splash-icon.png` (saydam zeminde beyaz S; açılış zemini `app.json`'da `#0f2a5c`, `imageWidth` 200). Bu dosyalar `Platform/brand/mobile/` çıktısının kopyasıdır; üretici `Platform/brand/generate.mjs`.
- Bu klasördeki `generate.mjs` mobil ikon üretmez (`apps/mobile/assets`'e yazmaz).
- Mobil ikon/açılış değişikliği yalnız yeni derlemede görünür: `scripts\android-build.ps1 -Clean`.
