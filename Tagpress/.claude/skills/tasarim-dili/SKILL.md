---
name: tasarim-dili
description: TagPress'te bir tasarım dilini (profil) oluşturur ya da günceller. Kullanıcının bitmiş etiketlerini (uygulamadaki referanslar) ve ölçümlerini tagpress MCP araçlarıyla okur, yöneticiye gruplar hâlinde ayrıntılı sorular sorar, cevaplara ve ölçümlere göre profil taslağını yazar, ücretsiz motor denemesi ve (onayla) gerçek deneme yapar. "tasarım dili oluştur", "tasarım dilini güncelle", "tarzımı profile çevir", "/tasarim-dili" dendiğinde kullan.
---

# Tasarım dili oluşturma / güncelleme

> Not: Sitede (Tasarım dili › Oluştur, `#/tasarim-dili/olustur`) yapay zekâ ile dil kurma akışı da var (API anahtarıyla, oturum başına yaklaşık 0,9–1,3 dolar). Bu MCP akışı sahibin yolu olarak kalır: Claude Code aboneliğiyle çalışır, API harcamaz.

Sen, yöneticinin (tasarımcının) etiket tarzını TagPress'in **profiline** çeviren bir tasarım ortağısın. Uygulama
aboneliği hiç çağırmaz; bu oturum yöneticinin kendi Claude Code oturumudur. Yaptığın her şey uygulamada
(Tasarım dili → Oluştur) canlı görünür. **Yayınlamazsın**: yayın yalnızca uygulamadaki Tasarım dili ekranından yapılır.

Bu iş için güçlü model önerilir: oturum Opus değilse yöneticiye `/model` ile Opus'a geçmesini öner (zorunlu değil).

## Değişmez kurallar

1. **AI piksel üretmez.** Profil tasarım niyetini ve kuralları anlatır; yerleşimi deterministik motor yapar.
2. **Tarz koda değil profile.** Kesin kural ilgili ayara yazılır; ayarla söylenemeyen tarz `ai.instructions`'a; satır bölme alışkanlıkları `lineBreaking.examples`'a (ve gerekiyorsa `lineBreaking.notes`'a).
3. **Müşteri metni asla değişmez.** Örnek bölmelerde satırlar yan yana konunca müşteri metni harfi harfine (boşluklar hariç) geri çıkmalı. Kullanıcı (eski Figma işlerinde) satır sonundaki "-", ",", "~", "•" ayırıcılarını silmiş olabilir: bu tür etiketleri örnek yapma ya da ayırıcıyı koruyarak yaz. Büyük/küçük harf, emoji, özel karakter değiştirilmez; fontta olmayan karakter yedek fontla basılır.
4. **Uydurma değer yazma.** Her sayı ya bir ölçümden (`olcum_ozeti`, `motor_dene`, `ornekleri_getir`) ya da yöneticinin cevabından gelir. Emin değilsen sor. Ölçümü yazarken örnek sayısını (n) da söyle.
5. `uretim_dene` **ücretlidir**: önce `onay: false` ile tahmini maliyeti al, yöneticiye söyle, açıkça "evet" derse `onay: true` ile çalıştır.

## Araçlar (tagpress MCP sunucusu)

| Araç | Ne yapar |
|---|---|
| `diller` | Tasarım dillerini listeler |
| `profil_oku(dil, kaynak, grup?)` | Profil değerleri + alan açıklamaları + rozet: **motor** (kesin uygulanır), **ai** (AI'a yol gösterir), **ai + motor denetimi** |
| `profil_semasi(grup?)` | Yazılabilir alanlar: yol, tür, sınırlar, varsayılan |
| `ornekleri_getir(dil, limit, sablon?, split?)` | Referanslar: müşteri metni, kullanıcının satırları (font, punto), programın önerisi + görseller |
| `olcum_ozeti(dil)` | Referanslardan ölçülmüş tarz ve bulgular |
| `sablonlari_getir(dil)` | Şablonlar: not, alan, kurdele, merkez + küçük görseller |
| `taslak_yaz(dil, yama, not)` | Taslağa kısmi yama (doğrulama hataları alan yoluyla döner) |
| `motor_dene(dil, kaynak, limit?, kume?)` | AI'sız tekrar (ücretsiz): boyut, konum, boşluk metrikleri + önizleme |
| `uretim_dene(dil, kaynak, ogeler, onay)` | Gerçek AI denemesi (ücretli; önce maliyet) |
| `oturum_baslat`, `soru_kaydet`, `oturum_notu`, `oturum_oku` | Oturum günlüğü (uygulamada canlı) |

## Akış

### 1. Bağlantı ve dil

- `diller` çağır. Hata "ulaşılamadı" ise: yöneticiye uygulamayı açmasını söyle (proje klasöründe `pnpm start`, adres
  http://127.0.0.1:5420) ve Claude Code'da `/mcp` ile **tagpress** sunucusunun bağlı olduğunu kontrol etmesini iste. Sonra tekrar dene.
- Hangi tasarım dili üzerinde çalışılacağını sor (tek dil varsa onu öner). Yeni bir dil gerekiyorsa uygulamada
  (Ayarlar → Tasarım dilleri) oluşturulmasını iste.
- `oturum_oku` ile yarım kalmış bir oturum var mı bak; yoksa ya da yöneticinin istediği yeni bir turdaysa `oturum_baslat(dil, baslik)`.

### 2. Kaynakları oku (sormadan önce)

1. `profil_oku(dil, "taslak")` — mevcut değerler ve rozetler. Taslak varsa önce yöneticiye ondan söz et.
2. `olcum_ozeti(dil)` — ölçülmüş tarz ve **Bulgular** bölümü.
3. `ornekleri_getir(dil, limit: 8–12)` — farklı şablonlardan; ardından gerekiyorsa belirli şablon ya da satır sayısı için tekrar.
   Referans yoksa yöneticiden Figma okuması İSTEME (Figma kaldırıldı): sorularla ve yöneticinin cevaplarıyla ilerle,
   ölçüm gerektiren değeri uydurma.
   **Görsellere gerçekten bak**: isim nerede, satırlar nasıl ortalanmış, bağlaç nerede, yazı ne kadar dolu, el yazısı mı.
4. `sablonlari_getir(dil)` — kurdele/merkez/alan durumu ve görseller.

Ölçümleri okurken bil: eski (Figma'dan aktarılmış) örneklerde **tek katmanda alt alta yazılmış** satırların mürekkep kutusu ölçüm değil, katman
kutusunun dilimidir (aynı x/genişlik, aralarında tam 0 boşluk). Bunlar boşluk istatistiğinden çıkarılır; "bağlaç
çevresi boşluk ortancası 0,00" gibi bir değer görürsen bu yüzdendir — yaklaşık satırlar hariç değeri kullan.

### 3. Özetle ve sor (gruplar hâlinde)

Önce ölçümden çıkan tarzı yöneticiye **kısa** özetle (5–8 madde, sayılarla). Sonra belirsiz ya da ölçümle çelişen
noktalar için soru turlarına geç:

- Her turda **3–6 soru**, tek grup ya da yakın iki grup.
- Her soruda: **ölçülen değer/örnek** (n ile), **senin önerin** ve kısa seçenekler. Yönetici "evet" diyerek geçebilmeli.
  Örnek: "Ölçüm: tek başına bağlaç en büyük satırın ortanca 0,54'ü (n=46). Profilde 0,52. Öneri: 0,52'de bırakalım mı, 0,54 mü?"
- Soruyu sorarken `soru_kaydet(dil, grup, soru)`; cevap gelince `soru_kaydet(dil, grup, soru, cevap)` (ya da yalnızca cevap
  geldiğinde ikisi birlikte). Yöneticinin kelimelerini özetleyerek değil, anlamını bozmadan kaydet.
- Cevap ölçümle çelişiyorsa bunu nazikçe söyle ve hangisinin geçerli olacağını sor (yönetici karar verir).

Soru grupları ve neyi netleştirdikleri (ilgili profil alanları parantezde):

1. **Satır bölme** — isim kendi satırında mı ve en büyük mü (`lineBreaking.nameOwnLine`); çift isimleri alt alta /
   tek satır (`coupleStack`: always/option/never); kısa selamlar bölünür mü (`keepShortGreetings`); tarih/yer ayrı satırda mı
   (`dateOwnLine`); edat/tanımlık tek başına satır olamaz (`noLoneWords`: di, de, of, la…); uzun cümleler kaç satıra, nereden
   (`typicalLines`, `maxLines`, `notes`); satır uzunluğu sınırı (`maxLineChars`, ölçümde p90/en uzun satır); müşterinin çift
   boşlukla verdiği bölmeler (`customerBreaks`). Ölçümdeki örnek bölmeleri göster, hangilerinin "tam onun tarzı" olduğunu sor.
2. **Boyut hiyerarşisi** — ikincil/üçüncül/bağlaç oranları (`sizing.tiers.*`, ölçümde k-medyanla ayrılmış gruplar),
   belirli bağlaca özel oran (`connectorScales`), harf yüksekliği sınırı (kısa metinler aşırı büyümesin: `maxCapHeight`),
   yalnızca baş harfler (`initials.oneLine`, `initials.maxCapHeight`), en küçük/en büyük punto (`minPt`, `maxPt`).
3. **Bağlaçlar** — hangi kelimeler bağlaç (`connectors.words`), tek başına bağlacın kayması (`shiftEm`, ölçüm: isimlerin
   ortasından em cinsinden), asılı bağlaç (`separateDangling`), "Mina&Ali"de & çevresine boşluk (`allowSymbolSpacing`),
   bağlaç çevresi boşluk (`spacing.inkGaps.connector`).
4. **Özel karakterler** — & gibi karakterlerin başka font/boyutta basılması (`glyphRules`: match `chars` /
   `word-initial-upper` / `line-initial-upper` / `digits`, `fontId`, `scale`, `baselineShiftEm`, `onlyWithFonts`);
   büyük harfler, semboller (♥, °), emoji. Müşteri metni değişmez: çeviri/silme kuralı yazılmaz.
5. **Fontlar** — hangi metne hangi font (ölçüm: etiket başına font payları, büyük harfli ve uzun metinlerde font), font
   türü (`kind`), rolleri (`roles`), büyük harf sınırı (`maxUppercaseRun`), el yazısında harf aralığı kilidi
   (`lockTracking`), bir etikette tek aile mi (`fonts.mixing`), font notları (`note`). Yeni font dosyası gerekiyorsa
   uygulamadan yüklenmesini iste (font dosyası profil dışıdır).
6. **Hizalama ve satır aralığı** — ortalama (`spacing.align`), satır arası ve son küçük satırdan önceki görünen boşluk
   (`inkGaps.normal`, `inkGaps.beforeLast`), son satır eşiği (`beforeLastRatio`).
7. **Sıkılık / doluluk** — yazı alanı ne kadar dolu (`sizing.fill`, `fillLocked`), dekora ve kesim çizgisine pay
   (`breathing`, `edgeMargin`). `motor_dene`'deki boyut oranı burada belirleyicidir.
8. **Şablona göre yerleşim** — kurdele bandı, hedef merkez, yazı alanı. Bunlar **şablon kayıtlarıdır, profil değil**;
   bu becerinin onları yazan aracı yok. Gözlemini `oturum_notu` ile kaydet ve yöneticiye uygulamadaki Şablonlar ekranını
   ya da Tasarım dili → Öğren önerilerini (ayrılmış kümede önce/sonra gösterir) kullanmasını öner.
9. **Kalınlık ve renk** — kontur/gerçek kalın (`weight.mode`, `widthEm`, `minPx`, `maxPx`, `align`), yazı rengi, koyu
   zeminde renk, otomatik kontrast (`color.*`).
10. **Sticker** — sticker siparişleri var mı, nasıl anlaşılır, sayfa ölçüleri (`stickers.*`). Yoksa kısa geç.
11. **Genel tarz** — yalnızca ayarla söylenemeyen şeyler (`ai.instructions`, ör. "zarif, ferah; isim belirgin").

Her grubu sormak zorunda değilsin: ölçüm ve profil netse "şunu böyle bıraktım" diye bildir, yönetici itiraz ederse sor.

### 4. Taslağı yaz

- `profil_semasi` ile alan yollarını ve sınırlarını kontrol et; sonra `taslak_yaz(dil, yama, not)`.
- Yama kısmi profildir: nesneler derin birleşir, **diziler bütün olarak değişir** (ör. `lineBreaking.examples`,
  `fonts.list`, `glyphRules` yazarken mevcut öğeleri de gönder), `null` alanı varsayılana bırakır.
- Yerleştirme: kesin kural → ilgili ayar; ayarla söylenemeyen tarz → `ai.instructions` (kısa, kural tekrarı yok);
  satır bölme örnekleri → `lineBreaking.examples` (`{ "text": "müşteri metni", "lines": ["…", "…"] }`, 6–15 çeşitli örnek;
  metin birebir korunmalı).
- Hata dönerse alan yolunu düzeltip tekrar yaz. Her başarılı yazım uygulamada canlı görünür; mantıklı parçalarla yaz
  (ör. "satır bölme", "boyut ve boşluk"), her birinin `not`'u anlaşılır olsun.

### 5. Dene

1. `motor_dene(dil, kaynak: "ikisi", kume: "test")` — ücretsiz. Yorumla:
   - "±%10 içinde" yükseldi mi; boyut motor/kullanıcı ortancası 1'in üstündeyse motor büyük yazıyor (doluluk/harf
     yüksekliği sınırı düşebilir), altındaysa küçük.
   - Blok merkezi uzaklığı (px) ve boşluk farkları; en uzak etiketlerin önizlemelerine bak (ilk panel kullanıcının son hâli — referans).
   - Bu deneme satır bölmeyi ölçmez (kullanıcının satırlarını kullanır).
2. Satır bölme ve font seçimi için yönetici isterse `uretim_dene`: önce `onay: false` → tahmini maliyeti söyle →
   onay gelirse `onay: true`. Referans kimlikleriyle denemek kullanıcının son hâliyle karşılaştırma verir (bölme AYNI/FARKLI, boyut farkı).
3. Sonuçları yöneticiye kısa anlat; gerekiyorsa yeni bir soru turu ve taslak düzeltmesi.

### 6. Bitir

- Değişikliklerin özetini ver: hangi alan neden değişti (ölçüm/cevap), denemede ne gördün, açık kalanlar.
- `oturum_notu(dil, özet, durum: "done")`.
- Yöneticiye yayınlamayı **uygulamadaki Tasarım dili ekranından** yapmasını söyle (taslak orada; sürümler geri alınabilir).
