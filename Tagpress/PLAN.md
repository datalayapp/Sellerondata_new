# Etiket Studio — Plan

> **Eski ad:** Etiket Studio bugün **TagPress**'tir. Bu tarihî belgede eski adlar (`Etiket Studio`, `etiket-studio`, `@studio/*`, `STUDIO_*`) olduğu gibi bırakıldı; güncel adlar `README.md` ve `YOL-HARITASI.md`'de (`@tagpress/*`, `TAGPRESS_*`, MCP sunucusu `tagpress`).

> Başlangıç: 2026-10-09. Eski uygulama (`Etiket-Generator`, port 5317) yalnızca okunan bir referanstır; ona hiçbir şey yazılmaz,
> kodu kopyalanmaz. Kararların kaynağı: YENI_SISTEM_PROMPT.md, Aşama 1 analizi ve kullanıcının 2026-10-09 cevapları.

## Ürün özeti

Yerel çalışan web uygulaması (Figma eklentisi 2026-10-10'da kaldırıldı). Sipariş JSON'undaki müşteri metinleri etiket şablonlarına AI ile yerleştirilir;
kullanıcı varyasyonları karşılaştırır, onaylar, uygulamadaki Baskı masasında basar. Her tasarımcı kendi
**tasarım dili** ile çalışır (profil + şablonlar + fontlar). Şimdilik tek kullanıcı (yönetici), kimlik doğrulama yok;
mimari sonradan satılabilir ürüne hazır.

## Değişmez ilkeler

1. AI asla piksel koordinatı üretmez; tasarım niyeti üretir (satır bölme, satır sınıfı, font). Yerleşim, sığdırma ve çarpışma deterministik motordadır.
2. Müşteri metni hiçbir otomatik adımda değişmez. Fontta olmayan karakter yedek fontla basılır, asla silinmez.
3. Tarz koda gömülmez; tasarım dili verisidir. Kod hiçbir font adı, bağlaç, sayfa adı ya da kullanıcı eşiği bilmez.
4. Görüntü modeli "şablona yaz" modunda şablonun TEK pikseline dokunmaz: sonuç = orijinal şablon + ayrılmış yazı katmanı (yapı gereği garanti, ayrıca doğrulanır).
5. (Kaldırıldı: Figma eklentisi ilkesi.) Baskı masasında da önce listelenir, kullanıcı seçer, sonra uygulanır; her işlem geri alınabilir.
6. Her otomatik değişiklik açıklanabilir ve geri alınabilir (profil sürümleri, öğrenme önerileri, silme).

## Mimari

```
packages/
  domain      zod şemaları + saf yardımcılar (profil v2 + alan açıklamaları, şablon, niyet, yerleşim, sorun modeli,
              metin kuralları, Figma protokolü, referans, fiyatlar). Sözleşmelerin tek kaynağı.
  typeset     FontRegistry (fontkit + harfbuzzjs), şekillendirme, yedek font zinciri, glif kapsamı, kontur çıkıntısı
  templates   şablon geometrisi: kesim şekli, dekor maskesi (alfa / renk eşiği), yazı alanı (otomatik öneri, elle şekil),
              kurdele bandı, hedef merkez, koyu zemin
  engine      compose (niyet + profil → satır bloğu) · fit (blok + geometri → yerleşim) · verify (raster çarpışma) · score ·
              render (SVG/PNG önizleme) · rules (satır bölme kural denetimi → sorunlar)
  ai          Anthropic istemcisi (ham yanıt koruma, önceki yanıtla onarım, kesilmede bütçe katlama, maliyet),
              profilden üretilen talimatlar (tasarım, aday seçimi, görsel denetim), görüntü üretimi (Gemini)
  learn       düzeltmelerden öğrenme: fark → toplama → yama önerisi → ayrılmış kümede tekrar oynatma
apps/
  server      Fastify + node:sqlite; servisler: diller/profiller (taslak/yayın, sürüm), şablonlar, fontlar, partiler/işler
              (içe aktarma + sorun tespiti), üretim kuyruğu, Figma kuyruğu, öğrenme, ayarlar (anahtarlar şifreli), SSE
  web         React 19 + Vite + TanStack Query + Tailwind 4. Sekmeler: Üretim · Tasarım dili · Şablonlar · Ayarlar
  (figma-plugin  2026-10-10'da silindi; git geçmişinde)
  mcp         stdio MCP sunucusu: Claude Code'daki "tasarım dili" becerisinin uygulamayla konuştuğu araçlar
scripts/aktar  eski sistemden veri aktarımı (salt okunur okur, data/aktarim/'a yazar)
.claude/skills/tasarim-dili  Claude Code becerisi (abonelikten Opus ile tasarım dili oluşturma)
```

**Port:** uygulama 5420 (tek süreç, web derlenip sunucudan sunulur). Deneme sunucuları yalnızca 5499 ve kopya veri klasörüyle.

**Veri klasörü** (`data/`, git dışı; `STUDIO_DATA_DIR` ile değişir):

```
data/studio.db                       SQLite
data/diller/<dilId>/sablonlar/       şablon PNG'leri
data/diller/<dilId>/fontlar/         tasarım dilinin fontları
data/ortak/fontlar/                  yedek fontlar (Noto Naskh Arabic, Twemoji…)
data/onizleme/                       önizleme ve görüntü üretimi çıktıları
data/referanslar/<dilId>/            bitmiş etiketlerin (referans) görselleri; eskileri Figma'dan aktarıldı
data/aktarim/<dilId>/                eski sistemden aktarılan veri paketi (ilk açılışta içe alınır)
data/yedek/                          otomatik yedekler
```

**Üretim akışı:** bağlam (profil, şablon geometrisi özeti, font kataloğu, önceki varyasyonlar, AI notu) → Haiku 5.5: 3 aday niyet
→ doğrulama (metin koruma, font, kurallar; bozuksa önceki ham yanıtla onarım) → motor yerleşimi → aynılar elenir → aday seçimi
(Haiku, görsellerle) → [görsel denetim — ölçülecek, işe yaramıyorsa kaldırılacak] → varyasyon + önizleme + sorunlar.

**Görüntü üretimi (Nano Banana):**
- *Şablona yaz:* model şablon üstüne yazılı görsel üretir → yazı katmanı ayrılır → sonuç = orijinal şablon + yazı katmanı.
  Şablon pikseli yapı gereği değişmez; ayırma güvenilmezse yeniden denenir, yine olmazsa kullanıcıya açıkça söylenir.
  Görseldeki yazı okunur ve müşteri metniyle birebir karşılaştırılır.
- *Temadan şablon üret:* tema/tarif → yazısız yeni şablon → şablon kütüphanesine "üretilmiş" olarak eklenir (istenirse kalıcı)
  → normal metin akışıyla (düzenlenebilir Figma yazısı) tasarlanır.

**Tasarım dili oluşturma (abonelik, Opus):** Claude Code + `.claude/skills/tasarim-dili` + `apps/mcp`. Uygulama aboneliği hiç
çağırmaz. Yönetici örnekleri uygulamaya yükler; Claude Code'da beceri çalışır, MCP araçlarıyla örnekleri/ölçümleri okur,
gruplar hâlinde soru sorar, taslak profili yazar, deneme çalıştırır. Uygulamada taslak, sorular ve denemeler canlı görünür.

**Düzeltmelerimden öğren:** referanslar (eski Figma işleri) ve Düzelt penceresindeki elle düzeltmeler → program önerisiyle satır satır fark → sağlam istatistikle
toplama (en az örnek eşikleri) → profil/şablon yaması önerisi → ayrılmış test kümesinde önce/sonra → kullanıcı onayı → yeni sürüm.

## Arayüz ilkeleri

- Günlük akış birkaç tıkla: **JSON bırak → kontrol et/düzelt → üret → karşılaştır → onayla → Baskı masası.**
- İçe aktarma tam ekran bir inceleme masasıdır: her satır yerinde düzenlenir, sorunlar anında işaretlenir ve tek tıkla düzeltilir.
- Partiler yüklenme tarihine göre sıralanır; iş/parti silmek kolay ve geri alınabilir.
- Karşılaştırma görünümü: varyasyonlar büyük ve yan yana; tek tıkla/tuşla onay, sonraki işe otomatik geçiş.
- İleri düzey ayrıntılar saklı ama erişilebilir; bugünkü sistemin her yeteneği yeni sistemde de var.
- Masaüstü öncelikli, dar ekranda bozulmaz. impeccable ile tasarlanır ve denetlenir.

## Aşamalar ve ilerleme

| # | Aşama | Sorumlu | Durum |
|---|---|---|---|
| 0 | Analiz, kararlar, iskelet, domain sözleşmeleri | baş mühendis | ✅ |
| 1 | typeset + engine + motor testleri + AI'sız tekrar düzeneği (`pnpm olc:motor`: ±%10 boyut 140–148/215; eski 143/214) | Opus ajan | ✅ |
| 2 | templates + eski veriden aktarım (54 şablon, 220 referans, profil v29 → v2; şablon kutusu Figma ölçümüyle (5,5,430)) | Opus ajan | ✅ |
| 3 | server (DB, içe aktarma + sorun tespiti, kuyruklar, Figma protokolü, SSE, DPAPI anahtar) | Opus ajan | ✅ |
| 4 | ai (Haiku akışı, onarım, görüntü üretimi iki mod) | Opus ajan | ✅ |
| 5 | Figma eklentisi (yeni, kimlik etiket-studio-…; listeler sınırsız) | Sonnet ajan | ✅ (gerçek Figma denemesi bekliyor) |
| 6 | Arayüz tasarım yönü (impeccable): "Baskı Provası" seçildi; tokenlar, kabuk, temel bileşenler, brif | baş mühendis | ✅ |
| 7 | Arayüz ekranları: Üretim + karşılaştırma, içe aktarma masası, Tasarım dili, Şablonlar, Ayarlar | Sonnet ajanlar | ✅ (tarayıcı denemesi bekliyor) |
| 8 | MCP sunucusu + tasarım dili becerisi + öğrenme paketi | Opus ajan | ✅ (kullanıcının oturumunda denenmedi) |
| 9 | Birleştirme ✅ · gerçek Haiku kabul ölçümü: test satır bölmesi %65 → %68 → %74 → **%78**, boyut %60 → %62 → %55 (hedef %85 / %70) ⏳ · görsel denetim → kapalı ✅ · görüntü üretimi ✅ | Opus ajan + baş mühendis | ⏳ |
| 10 | impeccable 8 düzeltme ✅, 2. son inceleme **pass** ✅ · DESIGN.md ✅ · tarayıcıda uçtan uca (güvenli akışlar ✅; yayınla/sürüm/Öğren/şablon kaydet ✅ 3. oturum) · koyu tema ve token borcu ✅ · eklenti derlemesi ✅ · README ✅ | baş mühendis + ajan | ✅ |
| 11 | Hafif düzeltme: sürükle, ortala, boyut, satır seçimi, kalınlık, Ctrl+Z/Ctrl+Y; Figma talimatı düzeltilmiş hâli taşır ✅ (Figma'da gerçek deneme ⏳) | Sonnet + Opus | ✅ |
| 12 | Teslim: gerçek `data/` ile 5420 ✅ (3. oturum; `pnpm aktar` yeniden, duman testi) · Kullanıcıyla: Figma eklentisi gerçek denemesi, `/tasarim-dili` oturumu ⏳ | baş mühendis + kullanıcı | ⏳ |
| 13 | Düzeltmelerden öğrenme: `adjust_log` → şablon `textCenter` önerisi, Öğren ekranında uygula/geri al ✅ | Opus ajan | ✅ |
| 14 | Düzelt penceresi: yakınlaştırma, çoklu seçim, metin düzenleme, satır/parça fontu ✅ · anlık güncelleme (SSE kök neden) ✅ | Opus + Sonnet | ✅ |
| 15 | **Baskı masası (Figma'sız):** sözleşme `print.ts`, planlayıcı `packages/print` (eklentiyle birebir), render/PDF/PNG, sunucu, Baskı sekmesi (Masa · Sayfa şablonları · Arşiv), uçtan uca tarayıcı denemesi + tasarım incelemesi ✅ · kullanıcının kağıt şablonları ve gerçek baskı/kesim denemesi ⏳ | Opus + Sonnet + baş mühendis | ⏳ |

## Kullanıcı kararları (2026-10-09, sonradan)

- 2,5 / 5,2 cm: tasarım 3,8 cmde yapılır, şablon ve yazı frame boyutuna orantılı ölçeklenir.
- "Uzun cümlelerde Corsiva" = o etiketin tamamı Corsiva (tek aile kuralı geçerli).
- ❤️ renkli emoji olarak basılır (metin değişmez).
- Görsel dünya: "Baskı Provası" (impeccable yön seçimi).
- Figma eklentisinde eski etiket/sticker üretim kısmı yok; şablon aktarma yeni sisteme göre; hiçbir listede sınır yok.
- Doluluk (`sizing.fill`) 0,97 → 0,94.
- Kısa selam: teşekkür ifadeleri tek satır, bayram/kutlama selamları iki satır.
- Satır başına en fazla karakter 32 → 42.
- Figma (2026-10-10): "Tüm işleri kendimiz yapabiliriz, Figma'ya gerek kalmadı." Eklenti silindi; sunucu/arayüzden Figma bağı kaldırıldı; veritabanındaki eski Figma tabloları ve referanslar silinmedi.
- Baskı (2026-10-10): Figma bağımlılığı kaldırılacak; baskı uygulamada. Çıktı PDF + PNG; kesim makinesi (yuva çizgisi baskıda görünür, diğer tarzlar şablon başına seçilir); sayfa şablonları uygulamada elle kurulur; sipariş adı sayfa başına aç/kapa; kopya = tek sayfa + kopya sayısı; fazlalık kuralları eklentideki gibi (profil `printing`); basılanlar "basıldı" arşivine; adedi boş sipariş planlanmaz (rafta uyarı); akış şeridinin son adımı Baskı masası.
- Çiftler: kesin kural yok, şablonun yazı alanına göre (dar/yüksek alanda alt alta, geniş alanda tek satır; önce aynı şablondaki örnekler).

## Kabul ölçütleri

**Doğruluk**
- Metin bozulması 0 (bütün testlerde ve gerçek denemelerde `checkTextPreserved`).
- Çarpışma 0 (etiket dışı 0 piksel; dekor toleransı motor sözleşmesindeki gibi).
- "Şablona yaz" modunda şablon pikselleri orijinalle birebir aynı (test edilir).

**Kalite (kullanıcının Figma'daki son hâllerine göre)**
- Ayrılmış referans kümesinde, gerçek Haiku 5.5 ile: satır bölmesi ≥ %85 aynı; en büyük satır boyutu ≥ %70'inde ±%10 içinde.
- AI'sız tekrar düzeneğinde (kullanıcının satırlarıyla) motor, eski sistemin vardığı noktadan (±%10 boyut 143/214) kötü değil.
- Görsel denetim: açık/kapalı karşılaştırmasında sonuçları iyileştirmiyorsa kaldırılır.
- **Görsel denetim ölçüldü (2026-10-09, gerçek kuyruk, öğrenme kümesinden 25 iş, `studio-design-v4`/`studio-critique-v1`):** kapalı satır bölmesi 22/25, boyut ±%10 14/25; açık 20/25, 14/25. Denetim 13 işte "düzelt" dedi ama 0 varyasyonu değiştirdi (önerilerin hepsi motorda karşılığı olmayan "taşı"; yönü 10/13'te kullanıcının yerleşimine ters). 3 doğru işi "kontrol et" diye işaretledi; iş başı maliyet +%43, süre +%28. **Karar: varsayılan kapalı kalır.**

**Kullanım**
- JSON içe aktar → üret → karşılaştır → onayla → baskı masası akışı tarayıcıda baştan sona çalışır; sorunlu satırlar içe aktarmada görünür ve düzeltilebilir.
- Tasarım dili sekmesi: profil okunabilir, düzenlenebilir, örnek siparişlerle denenebilir, sürümü geri alınabilir.
- Şablon alanı düzeltme (çizim, kurdele, hedef merkez) çalışır ve kaydedince hiçbir ölçülmüş alan kaybolmaz.
- Typecheck ve bütün testler temiz.

**Maliyet:** gerçek AI denemeleri toplamda ≤ $20 (2026-10-09 kullanıcı kararı; gerekmedikçe harcanmaz, aşılacaksa önce sorulur).

## Çalışma kuralları (ajanlar dahil)

- Eski klasör `C:\Users\Gokcan\Desktop\Etiket-Generator` YALNIZCA OKUNUR. Kod kopyalanmaz; bilgi ve davranış okunup yeniden yazılır.
  Eski veritabanı yalnızca geçici klasöre kopyalanıp salt okunur açılır.
- `packages/domain` sözleşmedir; değişiklik gerekiyorsa küçük, geriye uyumlu ve raporlanır.
- Sunucu yalnızca 5499'da ve geçici veri klasörüyle denenir; iş bitince kapatılır. 5317'ye ve 5420'ye dokunulmaz.
- Bellek kısıtlı: aynı anda tek headless tarayıcı; testler yalnızca ilgili paket için çalıştırılır.
- Kod yorumları ve arayüz Türkçe. Commit/push yok.
