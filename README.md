# SellerOnData

E-ticaret satıcıları için araçlar. Bu dosya projeyi yazılımcı olmayan biri için anlatır; Claude'un çalışma kuralları `CLAUDE.md` içindedir.

## Bugün ne çalışıyor

**DeciShip**: kargo firmasının kestiği faturayı, satıcının kendi ölçtüğü koli ölçüsü ve anlaşmalı fiyat listesiyle (tarife) karşılaştırır, fazla alınan parayı bulur ve itiraz metnini hazırlar. Depodaki çalışan koliyi telefondaki uygulamayla ölçer. **OrderLoom** ve **TagPress** sonra eklenecek.

Kısa yol:

1. Satıcı siteden hesap açar; giriş, ekip ve roller **Merkez**'dedir.
2. DeciShip panelinde tarifeyi girer; çalışan telefonla her koliyi ölçer.
3. Kargo faturası (Excel, CSV ya da PDF) yüklenince DeciShip her satırı ölçüm ve tarifeyle karşılaştırır, farkları gösterir.
4. Satıcı farkları seçer, sistem itiraz metnini hazırlar. Merkez hepsinin özetini gösterir.

## Sırada ne var

Yol haritası yedi aşama: önce zemin (testler ve düzen), DeciShip'in gerçek veriye hazırlanması, bu bilgisayarda gerçek faturalarla deneme, sonra küçük bir bulut sunucusuna taşınma ve depoda telefonla deneme. Yayın altyapısı ve ikinci araç arka planda ilerler. Ayrıntı ve sizden beklenen kararlar `SONRAKI-OTURUM/KALANLAR.md`'de.

## Nasıl açılır

- Docker Desktop açık olsun, `Platform\BASLAT.bat` dosyasına çift tıklayın. Kapatmak: `Platform\DURDUR.bat`.
- Merkez: http://localhost:8088 . Tanıtım sitesi: http://localhost:8089 .
- Demo hesap: `sahip@demo.sellerondata.com` / `Demo12345!` (yalnız bu bilgisayarda; gerçek veriyle kullanılmaz).
- Temiz demo verisi: `Platform\SIFIRLA.bat`, sonra yeniden `BASLAT.bat`. Yerelde gönderilen postaları görmek: `Platform\POSTA.bat`.
- Telefonda denemek ve gerçek FedEx faturasıyla denemek: `Deciship/TELEFON-KURULUM.md`.

## Nereye bakmalı

| Ne | Dosya |
|---|---|
| Şu an neredeyiz | `SONRAKI-OTURUM/DEVAM.md` |
| Plan: bulduğunuz hatalar, aşamalar, sizden beklenen kararlar, yayından önce | `SONRAKI-OTURUM/KALANLAR.md` |
| Kendi başınıza deneme adımları | `SONRAKI-OTURUM/TEST-ADIMLARI.md` |
| Verilmiş bütün kararlar | `Platform/docs/KARARLAR.md` |
| Eski notlar ve uzun denetim raporları | masaüstündeki `SellerOnData-ARSIV-2026-11-14` klasörü |

## Hata bulunca

Claude'a bir satır yazın: hangi ekran · ne yaptım · ne bekledim · ne oldu (varsa ekran görüntüsü). Claude bunu plan listesinin en üstüne ("Gelen kutusu") yazar ve sırayla kapatır. Gerçek fatura dosyalarını depoya koymayın; ayrıntı `TEST-ADIMLARI.md`.

## Klasörler

| Klasör | Ne işe yarar |
|---|---|
| `Platform/apps/account-api` | **Hesap servisi.** Kayıt, giriş, firma, ekip, rol, abonelik |
| `Platform/apps/hub-web` | **Merkez.** Giriş ve kayıt ekranları, ekip, analiz |
| `Platform/apps/site` | **Tanıtım sitesi** |
| `Platform/packages` | Bütün araçların ortak parçaları: üst bant ve düğmeler, renkler, giriş denetimi, ürün listesi |
| `Platform/gateway` | **Kapı.** Gelen her isteği doğru programa yollar |
| `Platform/e2e` | Sistemi gerçek kullanıcı gibi baştan sona deneyen testler |
| `Platform/docs` | Kararlar, mimari, tasarım kuralları, kurulum (teknik) |
| `Deciship/packages/core` | **Hesap motoru.** Desi, tarife fiyatı, karşılaştırma, fatura okuma, itiraz metni |
| `Deciship/apps/api` | **DeciShip servisi.** Faturaları, ölçümleri, tarifeleri saklar |
| `Deciship/apps/web` | **DeciShip paneli.** Pano, faturalar, tarifeler, ölçümler, itirazlar |
| `Deciship/apps/mobile` | **Mobil uygulama.** Koli ölçme, tartı fotoğrafı, barkod, Merkez sekmesi |
| `Deciship/services/vision` | **Görüntü servisi.** Fotoğraftaki referans kartından ölçü çıkarır |
| `Deciship/samples` | Örnek faturalar, tarifeler ve beklenen sonuçlar (hepsi kurgusal) |
| `Deciship/spec` | DeciShip'in hesap ve itiraz kuralları (teknik) |
| `SONRAKI-OTURUM` | Durum notu, plan, kod haritası, deneme rehberi |

## Bir şeyi değiştirmek istersem

| İstek | Yer |
|---|---|
| Sitedeki bir yazı | `Platform/apps/site/src/content/` |
| Merkez'deki bir yazı | `Platform/apps/hub-web/src/locales/` (tr ve en) |
| DeciShip panelindeki bir yazı | `Deciship/apps/web/src/locales/` (tr ve en) |
| Hesap kuralı (desi, fark, tolerans) | `Deciship/packages/core/` ve `Deciship/SPEC.md` |
| Rol, izin, yeni araç | `Platform/packages/contracts/` (`src/products.ts`) |

## Testler

Kök klasörde: `npm test` (hızlı denetim, birkaç dakika), `npm run test:all` (veritabanı testleri dahil, uzun), `npm run test:e2e` (tarayıcı testleri). Ayrıntı `CLAUDE.md` "Testler".

GitHub'a her gönderimde otomatik denetim (CI) koşar. Her commit'ten önce hızlı denetim için bir kez `npm run hooks:install` yazın.

## Kod deposu

Tüm proje tek depodadır: `github.com/GokcanT/SellerOnData` (özel). Çalışma dalı `gelistirme`; `main` dalına birleştirme proje sahibindedir.
