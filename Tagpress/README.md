# TagPress

Sipariş JSON'undaki müşteri metinlerini etiket şablonlarına AI ile yerleştirir. Siz varyasyonları karşılaştırıp onaylar, uygulamadaki **Baskı masası**nda sayfalara dizip PDF/PNG olarak basarsınız. Her tasarımcı kendi **tasarım diliyle** çalışır: profil, şablonlar ve fontlar.

## Kurulum (bir kez)

Gerekenler: Windows 10/11, Node 24+, pnpm 11.

```
pnpm install
pnpm start        # http://127.0.0.1:5420
```

İlk açılışta aktarılan tasarım dili ("Örnek – Figma'daki eski işlerin tarzı") kendiliğinden yüklenir.

**Anahtarlar:** Ayarlar → Bağlantılar.
- **Anthropic:** günlük üretim için, Claude Haiku 5.5.
- **Gemini:** görüntü üretimi için, Nano Banana.

Anahtarlar diskte şifrelenir (AES-256-GCM, her işletim sisteminde) ve ekranda hiç gösterilmez. Şifrenin ana anahtarı ilk açılışta `ana-anahtar.json` olarak üretilir:

- **Windows:** veri klasöründe; içeriği Windows hesabınıza bağlı olarak (DPAPI) sarılır, veri klasörünün kopyası tek başına anahtarları açmaz.
- **Öteki sistemler:** veri klasörünün dışında, kuruluma göre ayrı: `~/.config/tagpress/<kurulum kimliği>/` (ya da `$XDG_CONFIG_HOME/tagpress/<kurulum kimliği>/`; kimlik veri klasörünün yolundan türer), yalnız sahibin okuyabildiği izinle (600). Önceki sürümün ortak dosyası (`~/.config/tagpress/ana-anahtar.json`) ilk açılışta buraya kopyalanır, silinmez. Yeri `TAGPRESS_SECRET_KEY_DIR` ile değişir.
- **Sunucu** (`TAGPRESS_MODE=server` ya da `NODE_ENV=production`): dosya okunmaz; ana anahtar `TAGPRESS_SECRET_KEY` ortam değişkeniyle verilir (base64, 32 bayt), yoksa uygulama açılmaz.

Dosyadan ortam değişkenine geçiş: `TAGPRESS_SECRET_KEY` verip uygulamayı dosya yerindeyken bir kez açın; dosyadaki anahtarlar o açılışta eski anahtar olarak okunur ve kayıtlar yeni anahtarla yeniden şifrelenir (günlükte yazar).
Ardından `ana-anahtar.json` dosyasını kaldırın.

Ana anahtar kaybolursa API anahtarlarını yeniden girmeniz gerekir. Durum ve döndürme: `node scripts/ana-anahtar.mjs durum | dondur | temizle`.

## SellerOnData içinde (platform kipi)

`pnpm start` ve `pnpm dev` tek başına kullanımdır (yerel kip: girişsiz, veri `data/`). TagPress aynı zamanda SellerOnData'nın aracıdır: Merkez'deki ⊞ menüsünden `/tagpress/` açılır, giriş, firma, ekip ve roller (Yönetici, Kullanıcı) Merkez'dedir, veri Postgres'te, yapay zekâ anahtarı SellerOnData'nın yapay zekâ geçidindedir (Ayarlar › Bağlantılar orada salt okunur). Açmak, ortam değişkenleri ve bu bilgisayardaki verinin platforma aktarımı: `Platform/docs/KURULUM.md` "TagPress'i açmak ve yerel veriyi aktarmak".

## Günlük kullanım

Uygulama tek adreste açılır: http://127.0.0.1:5420 (eski `/tezgah.html` ve `#/uretim/karsilastir` bağlantıları da buraya düşer). Üstteki menü: Üretim, Tasarım dili, Şablonlar, Baskı, Ayarlar (Alt+1, 2, 3, 5, 4). Arayüz dili Ayarlar → Dil'den (Türkçe, English) değişir.

1. **Üretim → İçe aktar** (`I`). JSON dosyasını ekranın herhangi bir yerine bırakmanız da yeterli.
2. **İçe aktarma masasında satırları kontrol edin.** Sorunlu satırlar işaretli görünür; `N` sonraki soruna, `Shift N` öncekine gider. Sorunun altında düzeltme düğmesi var. Metni yerinde düzenleyebilir (`Enter`), şablonu değiştirebilir, satırı `Space` ile hariç tutabilirsiniz. Müşteri metni yalnızca siz düzenlerseniz değişir.
3. **İçe aktar ve üret** (`Ctrl Enter`).
4. **Önerileri karşılaştırın.** Üretim ekranında solda iş kuyruğu, ortada varyasyonlar büyük ve yan yana, sağda işin ayrıntısı:
   - `1`–`9` ile onaylarsınız, sıradaki işe geçilir; `Enter` seçili varyasyonu onaylar. `J`/`K` ya da oklar işler arasında gezer.
   - `R` yeni varyasyon üretir, `C` "şunu değiştir" isteği açar, `E` müşteri metnini düzenler.
   - `D` seçili varyasyonu **Düzelt** ekranında açar: satırı oklarla kaydırır, `H` `V` `C` ile ortalar, `-` `=` ile boyutlar; `Ctrl S` kaydeder, `Esc` geri döner.
   - Kuyrukta seçim yapınca (`Shift` + ok, `Ctrl A`) toplu şerit açılır: Üret (`U`), En iyiyi onayla (`A`), Sil (`Del`).
5. **Baskı masası** (Baskı, Alt+5). Onaylı işler rafta görünür; sayfa şablonuna dizilir, kesim çizgileriyle PDF ya da PNG olarak basılır. Basılanlar arşive geçer, yeniden basılabilir.

Silinen iş, parti ve varyasyonlar "Geri al" ile geri gelir. Her ekranın klavye kısayolları `?` tuşuyla açılan listede.

## Figma yok; baskı masası

Figma eklentisi kaldırıldı (2026-10-10; kod git geçmişinde). Yerleştirme, düzeltme (Düzelt ekranı) ve baskı sayfaları uygulamanın içinde yapılır. Eski Figma işlerinden aktarılmış referanslar durur; öğrenme ve ölçüm onları okur. Veritabanında Figma tablosu ya da sütunu yoktur.

## Sitede tasarım dili oluşturma (Oluştur)

Tasarım dilini uygulamanın içinde yapay zekâ ile de kurabilirsiniz: **Tasarım dili › Oluştur** (`#/tasarim-dili/olustur`). Kurulum'da "Oluştur" seçili bitirirseniz doğrudan bu ekrana gelirsiniz. Bitmiş etiket örneklerinizi yüklersiniz (ya da "örneğim yok" dersiniz), model ölçümlere ve cevaplarınıza göre sorular sorar, taslağı revizyon revizyon yazar; her değişikliğin yanında neye dayandığı görünür. Örnek etiketlerde önceki sürümle farkı görür, dilerseniz bir revizyona dönersiniz. Yayını yalnız siz yaparsınız.

Bu yol Anthropic API anahtarınızı kullanır ve para harcar: oturum başına yaklaşık 0,9–1,3 dolar. Başlamadan önce tahmin gösterilir. Oturum sınırı 3 dolardır (aşılacaksa sorulur, onayla bir kez 3 dolar artar); firma başına aylık sınır 20 dolardır.

## Tasarım dili oluşturma (Claude aboneliğiyle, API'siz)

Sitedeki yola ek olarak sahibin yolu budur. Tasarım dilini güçlü bir modelle (Opus) Claude Code içinden oluşturursunuz; bu, Max aboneliğinizden harcar. Uygulama aboneliği hiç çağırmaz.

1. TagPress açıkken bu klasörde Claude Code'u başlatın ve `/model` ile Opus'u seçin.
2. İlk seferde proje MCP sunucusunu ("tagpress", `.mcp.json`) onaylayın.
3. `/tasarim-dili` deyin. Claude örneklerinizi ve ölçümleri okur, size gruplar hâlinde sorular sorar ve taslak profili yazar.
4. Uygulamada **Tasarım dili** sekmesinde taslağı görür, **Dene** ile örnek siparişlerde karşılaştırır, **Yayınla** ile etkinleştirirsiniz. Eski sürümlere **Sürümler** bölümünden dönebilirsiniz.

**Düzeltmelerimden öğren:** üretilen varyasyonları Düzelt ekranında düzelttikçe (ve var olan referanslardan) öneriler çıkar. Tasarım dili → Öğren bölümünde önerileri önce/sonra ölçüleriyle görür; uygular ya da reddedersiniz.

## Veri

Bütün veri `data/` klasöründedir (git dışı):

| Ne | Nerede |
|---|---|
| Veritabanı | `studio.db` |
| Tasarım dillerinin şablon ve fontları | `diller/<dil>/` |
| Yedek fontlar | `ortak/fontlar/` |
| Önizlemeler | `onizleme/` |
| Referans görselleri (eski Figma işlerinden aktarılan) | `referanslar/` |

Başka bir klasör kullanmak için `TAGPRESS_DATA_DIR` ortam değişkeni verilir.

**Ortam değişkenlerinin eski adları:** Etiket Studio döneminden kalan `STUDIO_DATA_DIR`, `STUDIO_BOOTSTRAP`, `STUDIO_SYSTEM_FONT_DIRS` ve `STUDIO_URL` da kabul edilir (kısayollar ve betikler çalışmayı sürdürür). İkisi birden verilirse `TAGPRESS_*` geçerlidir. Okuma tek yerde: `packages/domain/src/env.ts`.

## Ölçüm ve geliştirme

```
pnpm test          # bütün testler
pnpm typecheck
pnpm olc:motor     # AI'sız motor ölçümü: referanslardaki son hâllerinize göre boyut/konum/boşluk
pnpm dev           # geliştirme: sunucu 5420 + arayüz 5421 (sıcak yenileme)
```

Portlar: uygulama **5420**, geliştirme arayüzü 5421, deneme sunucuları 5499. Eski uygulama 5317'de çalışmaya devam eder.
