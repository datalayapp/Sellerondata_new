# Devir notu — Etiket Studio

> **Eski ad:** Etiket Studio bugün **TagPress**'tir. Bu tarihî belgede eski adlar (`Etiket Studio`, `etiket-studio`, `@studio/*`, `STUDIO_*`) olduğu gibi bırakıldı; güncel adlar `README.md` ve `YOL-HARITASI.md`'de (`@tagpress/*`, `TAGPRESS_*`, MCP sunucusu `tagpress`).

> 2026-10-10 öğlen (6. oturum sonu — önce "6. oturum" bölümünü okuyun). Bu belge işi yeni bir oturuma bağlam kaybı olmadan devretmek için yazıldı.
> Önce bunu, sonra `PLAN.md` (mimari, kararlar, kabul ölçütleri, ilerleme tablosu), `PRODUCT.md`, `DESIGN.md` ve
> `.impeccable/tasarim-brifi.md` (arayüz kuralları) dosyalarını okuyun. Kurulum ve kullanım: `README.md`.

## Kullanıcı ve çalışma kuralları
- Kullanıcıyla Türkçe konuşun. Arayüz, kod yorumları ve mesajlar Türkçe.
- Teknik kararları siz verin, ürün kararlarını kullanıcıya sorun. Gereksiz soru sormayın; anahtar gibi bir şey gerekince durup açıkça isteyin.
- **Eski klasör `C:\Users\Gokcan\Desktop\Etiket-Generator` YALNIZCA OKUNUR.** Oraya yazılmaz, orada komut çalıştırılmaz, kodu kopyalanmaz. Eski uygulama 5317'de çalışmaya devam ediyor.
- Portlar:
  - Uygulama **5420**.
  - Geliştirme arayüzü 5421 (`pnpm dev`, sunucu 5420'yi kullanır; `PORT=5499 pnpm exec vite` ile 5499'a bağlanır).
  - Deneme/ölçüm sunucuları **5499**, her zaman kopya veri klasörüyle (`STUDIO_DATA_DIR`).
  - İş bitince süreç ağacı kapatılır (`taskkill //PID <pid> //T //F`) ve `netstat` ile portun boş olduğu doğrulanır. Kullanıcıya hangi portun açık kaldığı söylenir.
- Commit/push kullanıcı istemeden yapılmaz (2026-10-10 gecesi yerel commit izni verildi; push yok).
- AI çağrıları para harcar: önce küçük örnek, maliyet söylenir. **Bütçe toplam ≤ $20** (kullanıcı 2026-10-09: "gerekmedikçe harcama, daha iyi sonuç olacaksa kullan"). **Şu ana kadar ≈ $2,94 harcandı** (1. oturum $0,25 + 2. ≈ $1,20 + 3. ≈ $0,91 + 4. ≈ $0,58).
- Bellek kısıtlı: aynı anda tek headless tarayıcı. Testler hedefli çalıştırılır.
- **Ajan takımıyla çalışma (kullanıcının talimatı):**
  - Aynı anda en fazla 5 alt ajan. İşi biten ajan kapanır, gerekince yenisi açılır, gereksiz ajan açılmaz. **Kullanıcı paralelliği önemsiyor:** "neden tek ajan çalışıyor?" diye sordu — bağımsız işleri (ölçümü bozmayanları) bekletmeyin, paralel açın.
  - Model seçimi: **Opus 5.5** yalnızca gerektiğinde (motor, AI akışı, kalite turu, zor hatalar, mimari); **Sonnet 5.5** iyi tanımlı işlerde (arayüz, test, eklenti, belge).
  - Ajanlara dosya sahipliği net verilir. Ortak dosyalarda (domain, app.ts, göçler) "düzenlemeden hemen önce yeniden oku, küçük ve eklemeli değiştir".
  - 5499 tek sunucu: bir ajan sahibi olur (yeniden başlatır), diğerleri yalnızca kullanır. Ölçüm yapılırken profil yayınlama / şablon kaydetme / öğrenme uygulama diğer ajanlara yasaklanır.
  - Ajanların raporu körü körüne kabul edilmez: typecheck, test ve ekran görüntüsüyle kendiniz doğrulayın.
- Dosya düzenlerken dikkat: bazı dosyalar CRLF satır sonlu; Edit aracını kullanın ve sonucu kontrol edin.
- impeccable tasarım kancası test fikstürlerindeki renkler için uyarı verebilir; yanlış alarmlar `.impeccable/config.json`'a dosya kapsamlı `ignore-value` olarak yazıldı (gerekçeli).
- **Kullanıcının kararları:** `PLAN.md` → "Kullanıcı kararları". Önemlileri: doluluk 0,94; teşekkür tek satır, bayram selamı iki satır; satır sınırı 42; çiftler şablon alanına göre; adedi boş sipariş baskıda planlanmaz; baskı çıktısı PDF+PNG, kesim makinesi (yuva çizgisi görünür), sayfa şablonları elle kurulur, kopya = tek sayfa + kopya sayısı, basılanlar arşive; görsel dünya "Baskı Provası"; 2,5 / 5,2 cm'de şablon ve yazı orantılı ölçeklenir; uzun cümlede etiketin tamamı Corsiva; ❤️ renkli emoji; satır sonu ayırıcılar silinmez, metin hiç değişmez; görüntü modunda şablona KESİNLİKLE dokunulmaz.

## 6. oturum (2026-10-10 öğlen) — 5. oturumun devamı, kapandı

- **5420 yeni kodla AÇIK** (gerçek `data/`; önce yedek `data/yedek/db-2026-10-10-figmasiz-oncesi`). Anahtarlar DB'de duruyor. 5421/5499 kapalı.
- **Commit atıldı (kullanıcı izniyle, push yok):** Etiket-Studio'da bu ve 5. oturumun değişiklikleri; dış eklentinin kendi
  deposunda iki commit: `e3a7471` (elle yapılmış, commit edilmemiş eski sürüm = `_orijinal/`; artık `.gitignore`'da) ve
  `0ca8160` (Etiket Studio hizalaması).
- **Kullanıcı kararı:** "Sunucudan Al" geri GELMEYECEK — "JSON Seç" yeterli; eklenti hiçbir sunucuya bağlanmaz.
- **Baskı ölçüleri standardı (2026-11-21):** fiziksel ölçü mm (`packages/domain/src/units.ts` tek kaynak). Sticker'ın mürekkebi
  profildeki sticker sayfasının yazı alanına (pt → mm) sığdırılır (`packages/print/src/sticker-size.ts`); önceden tasarım pikseli
  pt sayılıyordu (sticker ~2,3 kat büyük). Sticker çıktısı da 300 dpi (eski 72 okunurken kaldırılır; göç 12 `0012-baski-olculeri.ts` plan sürümünü ekler).
- **Düzeltme:** sticker sayfasında hücre etiketi (sipariş adı) çıktıda alttaki sticker'ın üstüne biniyordu (yuva yok, 38 mm
  daire varsayımıyla konuyordu); masa zaten göstermiyordu, eklentide de görünür etiket yoktu. Artık sticker sayfasında basılmaz
  (`render-input.ts`), masada "Sipariş adı" düğmesi ve şablon düzenleyicide "Hücre etiketi" sekmesi sticker için gizli.
  Ekranda doğrulandı.
- **Bekleyen (kullanıcıda):** dış eklentinin Figma'da ilk denemesi (Plugins → Development → Import plugin from manifest →
  `Figma Plugin\manifest.json`). Sonucu gelince: fontlar, satır ölçüsü, `&` kayması, 430 px bileşen varsayımı, hücre etiketi.
- Küçük gözlem (dokunulmadı): masada sticker sayfası çubuğunda doluluk "0/0 dolu" yazıyor (yuva yok).
- **Dış eklenti, Figma ilk deneme → "'Intl' is not defined"** (Figma sanal makinesinde Intl yok). Düzeltildi: `src/core/locale.ts`
  (grafem bölme, Türkçe küçük harf, doğal sıralama — Intl'siz; Node Intl ile eşitliği `test/locale.test.ts`: 220 referans +
  örnekler + 3000 rastgele; code.js'te Intl/localeCompare/toLocale* yok denetimi). **Commit edilmedi.**
- **Kullanıcı isteği:** Etiket-Generator'daki eklentinin (`apps/figma-plugin`, "Etiket Generator"; eski arayüz `Figma Plugin eski/ui.html`)
  sticker şablonu oluşturma kısmı. Bulgu: yeni eklentide zaten var ("A4 sticker sayfası"), planlayıcı eskisiyle 500 rastgele
  kümede birebir aynı (`test/eski-sticker-esitlik.test.ts`, eski dosya salt okunur içe aktarılır). Fark yalnızca yedekti:
  artık eskisi gibi sticker yedeği düz GRUP + pluginData `sticker = yedek`. Eski eklentide olup yenisinde olmayan: STICKER
  ARŞİVİ / Arşiv akışı, "Generator" sekmesi (sunucudan iş çekme).
- **Arşiv eklendi (kullanıcı: "kullanıyordum"):** Şablon sekmesinde "Seçimi Arşivle". `src/core/archive.ts` (saf; eski
  `Figma Plugin eski/code.js` ARŞİV + `apps/figma-plugin/src/sticker-archive*.ts` kurallarıyla aynı sayılar), `src/figma/archive.ts`.
  Figma eklenti verisi eklenti kimliğine özel → eski eklentinin ARŞİV kaydı görünmez; kayıt yoksa düzen konumlardan çıkarılır
  (`inferOrigin` + `deriveLabelGroups`), hiçbir şey taşınmaz; sayfa belleği tamamen konuma bakar (yaşı bilinmeyen = en eski).
  Bilerek alınmayanlar: eski `narrowLabelGroups` (yerinde etiket taşır) ve bellek ızgarası yeniden kurulurken sayfa taşıma.
  `test/archive.test.ts` (sticker yerleşimi eski fonksiyonla 40×80 rastgele adımda birebir). Figma'da denenmedi. **Commit yok.**
- **Eklenti arayüzü yeniden düzenlendi (kullanıcı isteği):** sekmeler Oluştur · Şablon · Arşiv · ⚙ (Haiku anahtarı burada).
  Oluştur: etiket ve sticker listeleri ayrı yüklenir, tek "Oluştur" ikisini sırayla (etiket → sticker) yapar, tek tekrar onayı.
  Şablon: Etiket (kat, 2.5/3.8/5.2, fazlalık) ve Sticker (fazlalık) ayrı alt sayfa. Uzun açıklamalar kaldırıldı.
  Arşiv: sonuçta ızgara konumu yazılır; "Göster" (bildirimde ve panelde) ARŞİV sayfasını açıp taşınanları seçer/yakınlaştırır
  — kullanıcı arşivlenen sticker sayfalarını bulamamıştı. Tarayıcıda sahte ana iş parçacığıyla akış ve ekranlar denendi.
- **Arşiv çakışması düzeltildi (kullanıcı: "arşivler birbirine giriyor"):** eski +10000 kaydırma kaldırıldı; otomatikte
  sayfa ızgaraları etiketlerin SOLUNDA, STICKER ARŞİVİ üstte, etiketler sağa (test: dolu gruplarla çakışma yok). Eski
  kaydırmalı ızgaradaki sayfalar ilk açılışta aynı yuvayla yeni ızgaraya taşınır (`LAYOUT_VERSION` 2). Arşiv sekmesinde
  "Başlangıç noktaları" (Etiketler / Sticker sayfaları / Etiket sayfaları / Sticker yazıları; X·Y, "Seç" = ARŞİV'de seçili
  öğenin sol üstü, boş = otomatik, Kaydet / Otomatik); kayıt ARŞİV sayfasının eklenti verisinde. Etiket başlangıcı değişince
  eski etiketler yerinde kalır, yenileri oradan dizilir; ızgaralar ve STICKER ARŞİVİ taşınır. Kaydedince çakışan bölgeler yazılır.

## ⏸ 5. oturum (2026-10-10 sabah) — KULLANICI YARIDA KESTİ (6. oturumda tamamlandı)

**Kullanıcının bu oturumdaki istekleri:**
1. Sticker sayfalarının çözünürlüğü Figma'daki gibi olsun (çıktı gereksiz büyüktü). → ✅ YAPILDI.
2. Sitenin Figma ile bağı tamamen kalksın. → ✅ YAPILDI (aşağıdaki "Figma kaldırıldı" bölümü).
3. Dış Figma eklentisi (`C:\Users\Gokcan\Desktop\VIBE CODING\OTOMASYON ARAÇLARI\Figma Plugin`, "Etiket AI": `manifest.json`, `code.js`, `ui.html`)
   bu sitenin etiket/sticker ayarlarıyla güzel hizalasın. → ✅ KOD HAZIR, testler geçiyor; ⏳ Figma'da deneme ve "Sunucudan Al" kararı bekliyor.

**Durum (bırakıldığı an):**
- `pnpm -r typecheck` temiz; `pnpm vitest run` → **723 test geçti** (885 → 723: silinen Figma testleri).
- **Commit YOK** (son commit `7177284`; bu oturumun değişiklikleri çalışma ağacında). Kullanıcı istemeden commit atma.
- **5420 ESKİ kodla çalışıyor** (Figma'sız hâl ve sticker dpi görünmüyor). Yeniden başlatmak için önce DB yedeği
  (`data/yedek/…`), sonra `pnpm start`. Kullanıcıya sorulacaktı.
- 5421 / 5499 kapalı.

**Sticker çözünürlüğü:** profil `printing.stickerDpi` (varsayılan 300, en az 150); etiket `printing.dpi` (300). Fiziksel boyut dpi'den
bağımsızdır. `exports.ts` `dpiFor(languageId, kind)` sayfa şablonunun türüne göre seçer.

**Dış Figma eklentisi — kullanıcı kararları (kesin):**
- Eklentinin ŞU AN arayüzünde olan ayarlar (fazlalık miktarı gibi) KALACAK ve değiştirilebilir olacak; varsayılanları sitedekiyle aynı
  (profil `printing`: etiket 5–10 fazla, sayfayı tamamla 5, sticker 5–10). Sitede olup eklentide OLMAYAN ayarlar EKLENMEYECEK.
- Hizalamayı belirleyen geometri (etiket boyutları 2,5/3,8/5,2 cm, yuvarlaklar, kesim, sticker sayfa akışı, hücre etiketi) sitedeki
  değerlerle koda SABİT gömülecek.
- **Haiku API anahtarı:** eklentinin arayüzünde kullanıcı kendisi girer, `clientStorage`'da saklanır; KODA ASLA YAZILMAZ.
- Eklenti siteye/sunucuya bağlanmaz (eski "otomasyon sunucusu" bağlantısı gereksizse kaldırılır, raporlanır).
- AI yalnızca satır bölme önerisi için; koordinatlar deterministik (değişmez ilke).
- Bilinen risk: Figma metni sitedeki motordan (fontkit) farklı ölçer; birebir aynı görünüm garanti değil. Figma'da gerçek deneme şart.
- **Ajan durduruldu ama iş büyük ölçüde BİTTİ (baş mühendis doğruladı):** `npm test` 67/67, `npm run typecheck` temiz, koda anahtar gömülü değil
  (yalnızca kutudaki örnek yazı). Orijinal dosyalar `_orijinal/` (+ eklentinin kendi git geçmişi; daha eski yedek `yedek-eski-surum/`).
  Kaynak `src/` (`config.ts` = sitenin profil değerleri, `core/` yerleşim motoru + planlayıcılar, `figma/`, `ui/`), üretilmiş veri `src/generated/`
  (`scripts/uret-sabitler.ts`), `node build.mjs` → tek `code.js` + `ui.html`. Komutlar: `npm run build`, `npm test`, `npm run typecheck`.
  - Yerleşim motoru siteden taşındı: 68 gerçek etikette sitenin motoruyla fark yok; planlayıcılar 300 rastgele denemede sitedekiyle aynı.
  - AI'sız satır bölme kullanıcıyla %61 aynı (sitede AI ile ~%78); Haiku anahtarı girilirse yalnızca satır bölme önerir, koordinatlar motordan.
  - Korunan ayarlar: kat (1–5), şablon (3.8 / 5.2 / yeni "A4 sticker sayfası"), fazlalık en az/en çok (5/10; eski 2/10 idi, siteyle eşitlendi).
  - **Kaldırılan (kullanıcıya SORULACAK):** "Sunucudan Al" düğmesi ve sunucu adresi — yerine "JSON Seç" ile dosya yükleme. Kullanıcı her gün
    kullanıyorsa geri eklenmeli. Ayrıca DeepSeek anahtarı ve model seçimi kalktı (tek Haiku kutusu).
  - Manifest: ağ izni yalnızca `https://api.anthropic.com`, `documentAccess: dynamic-page`.
  - **Figma'da HİÇ denenmedi.** Bakılacaklar: fontlar Figma'da yüklü mü; satırlar Figma ölçüsüyle biraz küçük çıkabilir; `&` taban kayması yok;
    şablon bileşenlerinin 430 px olduğu varsayılıyor; hücre etiketi 35 px (−134/−19); sitedeki son çarpışma denetimi eklentide yok.
- Site planlayıcısı `packages/print/src` saf TS: eklentiye bundling ile taşınabilir (esbuild, tek `code.js`).

**Sıradaki adımlar:**
1. Kullanıcıyla dış eklentinin Figma'da ilk denemesi; "Sunucudan Al" kararı. (Eklenti testleri geçiyor; yarım iş yok.)
2. Kullanıcıya sor: commit + DB yedeğiyle 5420'yi yeniden başlatma.
3. Sticker çıktısını gerçek kağıda deneme baskısıyla doğrula (PNG 300 dpi = 2480×3508, PDF A4 210 × 297 mm; kopya veride ölçüldü).
4. Önceki kalan işler aşağıda (kağıt şablonları, deneme baskısı, kalite kararları).

## Figma kaldırıldı (2026-10-10, 4. oturumdan sonra)

Kullanıcı kararı: "Tüm işleri kendimiz yapabiliriz, Figma'ya gerek kalmadı." `apps/figma-plugin` silindi (git geçmişinde), `pnpm eklenti` yok.
Sunucudan Figma kuyruğu, `/api/figma/*`, kalibrasyon, Figma referans okuma ve Figma iş durumları; web'den "Figma'ya gönder"/geri çek,
Ayarlar → Figma, `F` kısayolu ve `figma` SSE olayı kaldırıldı. `null` köken artık CORS'ta izinli değil.
- **Veritabanı:** Figma tablosu ve sütunu yok (göç 7). Eski Figma iş durumları "onaylı", `figma-*` sorunları silinmiş, şablonlarda Figma
  bağlantısı yok (içe alınan pakette olsa da kayda yazılmaz); öğrenme önerisinin referans kaynağı `origin: "reference"`. Okurken eşleme yok.
- **Korunan:** öğrenme (referanslar + Düzelt kayıtları), referanslar (`source: "figma"` değeri eski kayıtlar için), baskı, `pnpm aktar`
  (eski sistemin Figma'dan okunmuş referanslarını dosyadan aktarır; Figma'ya bağlanmaz).
- `profile.figma`: `frameName` baskıda "Sipariş adı deseni" (Baskı grubu); `maxShrink`/`maxShiftPx` şemada, arayüzde gizli (`FieldDoc.hidden`).
  Profil grubu `figma-kalite` → `kalite`.
- 5420'deki çalışan uygulama yeniden başlatılıp arayüz yeniden derlenene kadar eski kodla çalışır.

## Durum (2026-10-10 gece, 4. oturum sonu)

- `pnpm -r typecheck` temiz; `pnpm vitest run` → **885 test geçti** (baş mühendis çalıştırdı).
- **Uygulama gerçek `data/` ile 5420'de AÇIK** (son kodla yeniden başlatıldı; göç 5–6 = baskı tabloları). 5421, 5499 kapalı.
  DB yedekleri: `data/yedek/db-2026-10-10-baski-oncesi`, `data/yedek/db-2026-10-10-entegrasyon-oncesi` (+ son başlatmadan önceki yedek, aşağıda).
- **Git:** yerel commit'ler var (kullanıcı 2026-10-10 gece izin verdi; push yok). Bundan sonra da commit yalnızca kullanıcı isteyince.
- Harcama: bu oturum ≈ $0,58 (yalnızca kalite ölçümü) → **toplam ≈ $2,94** / $20.

### 4. oturumda yapılanlar (hepsi doğrulandı)
1. **Figma eklentisi manifesti:** Figma IP kabul etmiyor → yalnızca `http://localhost:5420/5499`; eklenti adresi `localhost`'a çevrildi (`127.0.0.1` ayarı kendiliğinden çevrilir).
2. **Anlık güncelleme (kök neden):** sunucu adlı SSE olayları gönderiyordu, web yalnızca `onmessage` dinliyordu → hiçbir olay ulaşmıyordu. Artık her tür dinleniyor; tek merkez `apps/web/src/lib/liveSync.ts` (olay → sorgu eşlemesi, günlük satırı doğrudan önbelleğe).
3. **Düzelt penceresi:** Ctrl+tekerlek imlece yakınlaştırma (%25–800), Boşluk/orta tuş kaydırma, Shift+1 sığdır, `1` %100, Shift+2 seçime; yakınlaştıkça ince ok adımı; Ctrl/Shift+tık çoklu seçim, kutu seçimi, Ctrl+A; çift tık/Enter metin düzenleme (yalnızca o varyasyonda; iş metni ve onay değişmez; "metin elle düzenlendi" rozeti); satır/parça fontu (tek aile kuralı aşılırsa uyarı); Kaydet Ctrl+S. Domain: `VariantAdjust.edits`, uç `POST /api/variants/:id/edit/relayout`.
4. **Baskı masası (Figma'sız; kullanıcı istedi):** sekme "Baskı" (Alt+5): Masa · Sayfa şablonları · Arşiv.
   - Sözleşme `packages/domain/src/print.ts` (birim mm; kararlar dosya başında; sonunda `PRINT_API`), profil `printing` (fazlalık kuralları — eklentidekiyle aynı değerler).
   - Planlayıcı `packages/print` (eklentinin planlayıcısıyla 300 rastgele kümede birebir eşitti; eklenti silinince eşitlik testi kaldırıldı; yeniden planlama elle konmuş/kilitli olanları korur, toplam baskı ilk planla aynı).
   - Render `packages/engine/src/print*.ts`: sayfa SVG, PNG (dpi meta), PDF (raster ya da vektör; kesim çizgisi ve kayıt işaretleri her zaman vektör), kesim dosyası SVG, küçük resim. Hücre etiketi Inter Bold (`@fontsource/inter`).
   - Sunucu `apps/server/src/services/print/*`, `routes/print.ts`: şablon CRUD + ızgara üreteci + ön ayarlar (veri; ölçülmemiş başlangıç değerleri), raf, oturum (toplu yama + sürüm/409), yeniden planla, oturuma iş ekle, basıldı (şablon anlık kopyası saklanır) / arşiv / yeniden bas, çıktı görevi (SSE ilerleme).
   - Arayüz `apps/web/src/screens/baski/**`: saf SVG + kendi etkileşim katmanı. Uçtan uca tarayıcıda denendi (14 hata düzeltildi), tasarım incelemesi (impeccable finish reviewer) 8+1 madde → uygulandı ve ekranda doğrulandı.
   - Akış şeridinin son adımı "Baskı masası" ("Figma'ya gönder" sonradan tamamen kaldırıldı).
5. **Kalite:** benzer örneklere şablon alan oranı (`studio-design-v8`, `studio-rank-v5`). Test: satır bölmesi 58 → **61/78 (%78)**, boyut 43/78 (%55). Test kümesi 4 kez ölçüldü.

## Kalan işler (önerilen sıra)

### 0. Kullanıcıya sorulacak / kullanıcıyla
- **Kendi kağıtlarının şablonlarını kurmak** (Baskı → Sayfa şablonları; ızgara üreteci). Ön ayarlar (A4 Ø37 35'li, Ø25, Ø50) ölçülmedi.
- **Kayıt işareti çakışması:** dolu A4 5×7 Ø38'de köşe işaretleri yuvalara biniyor. Önerilen "kenardan payı 1,7 mm" yazıcının basamadığı kenar boşluğunda kalabilir (yazıcılar genelde 3–5 mm basmaz). Kullanıcının makinesi bilinmiyor; gerçek bir deneme baskısıyla karar verilmeli (daha az yuva, daha küçük işaret ya da işaretsiz).
- **Gerçek baskı + kesim denemesi** (PDF %100 / gerçek boyut).
- **Edat notu** (kalite; kanıt zayıf, yayınlamak kullanıcının kararı) — metin: "Edat satır sınırına denk gelirse …" (bkz. 4. oturum kalite raporu; `scripts/aktar/profil.ts` `prepositionSideNote` üretir).
- **Boyut için şablon başı düzeltme** (öneri, uygulanmadı): öğrenme referanslarından şablon başı boyut çarpanı → biri-dışarıda ölçümde öğrenme 98 → 101–102, test 51 → 54–55. Domain alanı + `layout.ts` gerekir; ürün kararı.
- `/tasarim-dili` oturumu (önceki oturumdan; Figma kaldırıldı, baskı uygulamada).

### 1. Kalite turu (hedef %85 / %70 ULAŞILMADI)
- Gürültü sanıldığından büyük: aynı ayarla öğrenmede 109 / 105.
- Seçimi 215 işin 214'ünde tasarım çağrısının ilk adayı belirliyor; sıralamayı gevşetmek kazanç göstermedi (+8/−4, testte net eksi).
- Boyut düşüşü (%62 → %55) doluluk 0,94 kaymasından (sınırdaki işler 0,90 altına) + gürültü; motor tarafında profil verisiyle düzeltme bulunamadı.

### 2. Bilinen eksikler (baskı)
- Raf göstergesi, iş oturuma eklenmeden önce grup planına göre; eklenince birkaç adet değişebilir.
- Yeniden planlamayı geri almak bütün öğeleri gönderir (2000+ öğede reddedilir).
- Sürüm çakışmasında son değişiklik yeniden uygulanmaz, yalnızca son hâl yüklenir.
- Gerçek bir sticker işiyle görsel kontrol yapılmadı (kopya veride sticker yoktu).
- Sticker şablonlarında kayıt işareti denetimi yok.
- `.num` noktalama aralığı yalnızca Baskı ve künyelerde düzeltildi (`ui/Num.tsx`); Üretim/Ayarlar/Tasarım dili taranmadı.
- Düzelt: satır eklenip silinemiyor; düzenlenen satır sığmazsa otomatik küçülmez.

## Anahtarlar
- Saklama: `settings` tablosunda AES-256-GCM (`apps/server/src/services/secret-box.ts`); ana anahtar `TAGPRESS_SECRET_KEY` (sunucu kipinde zorunlu) ya da `ana-anahtar.json` (ilk açılışta üretilir; Windows'ta `data/` içinde DPAPI ile sarılı, öteki sistemlerde `~/.config/tagpress`). Eski DPAPI kayıtları Windows'ta ilk açılışta yeni biçime taşınır; taşınamazsa eski kayıt yerinde kalır, Ayarlar'da uyarı çıkar. Durum/döndürme: `node scripts/ana-anahtar.mjs durum | dondur | temizle`.
- Eski DPAPI aktarım dosyası `data/yedek/anahtarlar.dpapi.json` (git dışı; yalnızca kullanıcının Windows hesabı çözer). Yükleme: `node scripts/anahtar-yukle.mjs data/yedek/anahtarlar.dpapi.json http://127.0.0.1:PORT`.
- Dosya kaybolursa: eski `data/etiket.db` (+ -wal/-shm) geçici klasöre kopyalanır, `node scripts/anahtar-cek.mjs <kopya.db> <cikti.json>` (salt okunur; çıktı uygulamanın ana anahtarıyla şifreli), sonra `anahtar-yukle.mjs <cikti.json> …`.

## Bilinen eksikler
- Arapça için tam bidi yok (cümle tek parça doğru basılıyor).
- Çok satırlı tek Figma katmanındaki satırlar "yaklaşık" ölçülüyor; öğrenme bunları ayıklıyor.
- `donusum-raporu.md`'de 17 referansta kullanıcının Figma metni iş metninden farklı (12'si yalnızca ayırıcı silme). Karar: metin değişmez.
- Hafif düzeltme: düzeltilmiş varyasyondan "şunu değiştir" ile istenen yeni varyasyon düzeltmeyi taşımaz; puan düzeltmeden sonra yeniden hesaplanmaz; Figma'ya zaten yerleşmiş etiket yeniden gönderilmeli; kalınlığın kutuya etkisi yaklaşık (kesin sonuç raster denetimde); profilde kalınlık kapalıyken kalınlaştırma kontur iledir (fontun kalın stiline geçilmez).
- Görsel denetimin "taşı" önerisi motorda karşılıksız (denetim zaten kapalı).
- Genel üretim kuyruğu paylaşımlı; çok iş varken revizyon dakikalarca "sırada" kalabilir.
