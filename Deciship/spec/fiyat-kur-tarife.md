# DeciShip SPEC — Fiyat dayanağı, tarife uyumu, döviz kuru, itiraz süresi, faturanın tarifesi (§3.8–§3.12)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 3. Alan kuralları (packages/core) (devam)

### 3.8 Fiyat dayanağı, ülke istisnası ve güven

Taşıyıcılar sözleşme belgesinden sapabilir (ör. bir ülkeye ayrı indirim, kendi kur kaynağı). Ağırlık/ölçü denetimi tarifenin kusursuz güncel olmasına bağlı kalmasın diye beklenen taşıma bedeli **taşıyıcının bu faturadaki kendi fiyatına** dayanabilir (`packages/core/src/compare.ts`).

- **Faturanın ücretli kg'ı** (`billedPricingKg`):
  - Faturada ücretli kg yazıyorsa o (taşıyıcının kendi — çoğu zaman inçle — hacim hesabını içerir; faturadaki ölçülerden kenar yuvarlamasıyla yeniden hesaplamak bir basamak fazla verebilir); ancak faturadaki ölçülerin yuvarlamasız hacimsel ağırlığı bundan %2'den fazla büyükse hacimsel.
  - Ücretli kg yoksa max(gerçek kg, faturadaki ölçülerin hacimsel ağırlığı).
  - Bölen faturadaki ya da tarifeninki; sonuç tarifenin basamağına yukarı.
  - Ağırlık/ölçü farkı yoksa (fatura kg'ı bizimkinden tolerans içinde; yalnız ek ücret farkı olan satır da) karşılaştırma bizim kg'ımızda yapılır.
- **Faturadaki taşıma bedeli** (`billedFreight`):
  - Liste varsa liste − |indirim| (yakıt = faturadaki yakıt, yoksa net − taşıma − ek ücretler kalanı).
  - Liste yok yakıt varsa net − yakıt − ek ücretler.
  - İkisi de yoksa taşıma + yakıt birlikte = net − ek ücretler (`combined`).
- **Sapma** `rateDeviationPct` = faturadaki taşıma / tarifenin aynı kg'daki taşıma bedeli (liste − indirim ± ülke istisnası, kurla çevrilmiş; `combined`'da yakıt dahil) − 1, % (−15 = tarifeden %15 ucuz). Ölçümü olmayan satırlarda da hesaplanır (§3.9 raporu için).
- **Dayanak** `pricingBasis`:
  - `INVOICE`: ağırlık/ölçü farkı ya da ek ücret farkı varsa (yalnız ek ücret farkında ölçekleme bizim kg'ımızdadır, oran 1) ve taşıyıcının ölçeklenebilir tutarı (taşıma + yakıt) tarifeninkinden tutar toleransı (kur çevrilen satırda max(amountTol, %fxTolerancePct)) ötesinde düşükse.
  - `INVOICE`'ta beklenen taşıma = faturadaki taşıma × tarife(bizim kg) / tarife(fatura kg) (liste fiyatları oranı; kurdan ve ülke indiriminden bağımsız); yakıt aynı oranla ölçeklenir (yakıt ayrı yoksa birlikte ölçeklenir). Müşteri sözleşme ile taşıyıcının gerçek fiyatından **düşük olanı** öder.
  - Değilse `TARIFF` (taşıyıcı tarifeden pahalıysa sözleşme fiyatı).
  - Bilinen ek ücretler her iki dayanakta tarifeyle kontrol edilir; tarifede olmayanlar Beklenen'e faturadaki tutarıyla girer (§3.4).
  - `INVOICE` dayanağında tutar toleransı yalnız kurla çevrilen kısma (bilinen ek ücretler) uygulanır.
  - Döküm: `Taşıma — faturadaki fiyatla: 800,00 ₺ × 20,00/25,00 (2,0 kg / 3,0 kg)`, `Yakıt — faturadaki yakıtla: …`, bilgi kalemi (`info: true`, toplama girmez) `Tarifeye göre olurdu: 21,00 USD × 40,0000 (TCMB …)`; not `Faturadaki fiyatla hesaplandı (tarifeden −%20)`.
- **Fiyat farkı (`PRICE`)**: yalnız ağırlık/ölçü/ek ücret farkı yokken `diff > tolerans` — fatura kg'ı bizimkiyle aynı olduğundan bu, taşıyıcının sözleşmeden pahalı fiyatıdır (yakıt oranı dahil; #5290). Ucuz taşıyıcı aynı kg'da "Lehimize fark" kalır (dayanak `TARIFF`).
- **Ülke istisnası** (`Tariff.countryAdjustments` `[{ country (ISO-2), pct (işaretli), note?, source:'manual'|'invoice', invoiceId? }]`, ülke başına bir):
  - `expectedCharge` varış ülkesinin taşıma bedeline (indirimden sonra, yakıttan önce) uygular: `adjustment = round2(afterDiscount × pct/100)`, `freight = afterDiscount + adjustment`, yakıt `freight` üstünden; döküm `İspanya istisnası −%15,45`.
  - PCT ek ücretler liste fiyatından kalır.
  - Tarife gövdesinde (`tariffBody.countryAdjustments`, −90…200), sürüm anlık görüntüsünde, kopyada ve içe aktarmada korunur (Excel/PDF dosyasından okunmaz; şablon "Açıklama" sayfasında bilgi olarak listelenir).
- **Güven** `confidence` (`HIGH` kesin | `LOW` tahmini) + `confidenceReason`. `LOW` olur:
  - faturada ücretli ağırlık yok / taşıma bedeli okunamadı / tarifede faturadaki kg için fiyat yok ("…; beklenen yalnız tarifeden");
  - |sapma| > %35 (`EXTREME_RATE_DEVIATION_PCT`: "hizmet ya da bölge farklı olabilir");
  - fatura ile ölçüm ücretli kg oranı > 4 (`EXTREME_WEIGHT_RATIO`: "eşleşme yanlış olabilir").
  - Mükerrer, ölçümsüz ve tarifesiz satırlar `HIGH`. Ekrandaki adı "İncele"; ek gerekçeler ve `reviewCode` §3.13'te.
- **Saklama**: `InvoiceLine.pricing` JSON `{ basis, rateDeviationPct, confidence, confidenceReason, zone, rateKg, mode, adjustmentPct, fuelPct }` (null → kesin sayılır; yeniden karşılaştırma doldurur). API satırda `pricingBasis, rateDeviationPct, confidence, confidenceReason`.
- **Toplamlar**:
  - `overchargeTotal` yalnız `HIGH` fark satırlarının pozitif farkı (+ mükerrer).
  - `estimatedOverchargeTotal` / `estimatedLines`: `LOW` olanlar — Fazla ödeme'ye girmez. Özet kartında "İncelenecek tutar" (N satır, ayrıca gösterilir; açıklama `ESTIMATED_NOTE`); Excel "Özet"te ayrı satır ("İncelenecek tutar (ayrı)") + satır sayfalarında "Fiyat dayanağı", "Tarifeye göre sapma (%)", "Güven" kolonları; PDF'te KPI altında ayrı satır ve fark hücresinde "incele".
  - `overchargeNote` tahmini fazlayı da hesaba katar.
- **Web**: satır tablosunda "İncele" etiketi (ipucunda gerekçe), satır panelinde dayanak düz Türkçe ("FedEx bu gönderide tarifenizden %20 düşük fiyat uyguladı. Beklenen, faturadaki bu fiyatın sizin ölçtüğünüz ağırlığa oranlanmasıyla hesaplandı…").

### 3.9 Tarife uyumu raporu

`tariffHealth(lines, { fxTolerancePct, carrierName, tariffFuelPct })` (`packages/core/src/tariffHealth.ts`): faturanın satırları (mükerrer ve pak/zarf hariç; ölçümü olmayanlar dahil) `rateDeviationPct` ile varış ülkesi + bölge + hizmet gruplarına ayrılır; grup başına satır sayısı, medyan/en küçük/en büyük sapma ve durum:
- `ok`: |medyan| ≤ eşik — kur çevrilen faturada `fxTolerancePct` (varsayılan %1,5), aynı para biriminde %1 (`HEALTH_OK_PCT_SAME_CURRENCY`).
- `cheaper` / `pricier`: eşiğin altı / üstü. Öneri (`suggestedAdjustmentPct`) = mevcut istisna dahil toplam yüzde `(1+mevcut)(1+medyan) − 1`.
- |medyan| > %35 → `suspect` (istisna değil, yanlış hizmet/bölge; öneri yok).
- < 3 satır ya da yayılım > 5 puan → `weak` (uyarıyla uygulanabilir).
- Mesajlar: "İspanya (4 satır): FedEx tarifenizden %20 düşük fiyat uyguluyor — ayrı bir anlaşma olabilir." / pahalı: "… yüksek fiyat uyguluyor — sözleşmenize göre fazla ücret olabilir; itiraz edebilirsiniz."
- **Genel not** (`overallNote`): ≥ 5 satırın ≥ %70'i medyanın ±1 puanında ve 0,3 ≤ |medyan| ≤ 3 ise tek cümle — kurlu faturada kur kaynağı farkı (FedEx sözleşmeleri OANDA der, DeciShip TCMB kullanır; tolerans içindeyse "Kur toleransı bu farkı karşılar"), değilse genel indirim/yakıt oranı.
- **Yakıt notu** (`fuelNote`): ≥ 3 satırda faturadaki yakıt oranının medyanı tarifedekinden ≥ 0,1 puan farklıysa.

**API:**
- `GET /invoices/:id/tariff-health` → `{ health: { invoiceId, carrierName, tariff:{id|null,name,currency,countryAdjustments,removed,revisionId}|null, stale, checkedLines, okLines, skippedLines, okTolerancePct, groups[], overallNote, overallMedianPct, fuelNote, invoiceFuelPct } }`.
  - `stale`: hiçbir satırda `pricing` yok → yeniden karşılaştırın. Tarifeyle karşılaştırılan satıra fiyatı kontrol edilemese de boş alanlı `pricing` yazılır; böylece "kontrol edilemedi" ile "eski karşılaştırma" ayrılır.
  - Rapor canlı tarifeyi değil faturanın hesaplandığı tarife sürümünü (§3.14) ve faturanın kayıtlı kur toleransını okur: yakıt oranı, değişken yakıt, hizmet, para birimi ve ülke istisnaları sürümden gelir. Tarife silindiyse `tariff.id` null, `removed: true`, ad sürümden.
- `POST /tariffs/:id/country-adjustments` `{ country, pct, note?, source, invoiceId? }` → istisnayı ekler/değiştirir (pct 0 kaldırır).
  - Önce tarifenin hâli geri alma sürümü (`TariffVersion`) olarak saklanır ("İspanya istisnası −%20 uygulanmadan önceki sürüm"); aynı işlemde yeni fiyat sürümü (`TariffRevision`) doğar.
  - Hiçbir fatura yeniden hesaplanmaz; `invoiceId` verilirse o faturanın raporu döner → `{ tariff, versionId, totals: null, health|null }`. Web ardından toplu geçiş önizlemesini açar (§3.14).
- İzinler: rapor `reports.view`, istisna `tariffs.edit`; başka şirketin tarifesi/faturası 404.

**Web:**
- Fatura ayrıntısında "Tarife uyumu" kartı (`TariffHealthPanel`, `pages/invoice-detail/TariffHealth.tsx`, props `{ invoiceId, compact? }`): "✓ 40 satır tarifenizle uyumlu · fark ±%1,5 içinde"; sorunlu gruplar "Tarifeye uygula" (onay penceresi; yalnız `cheaper`, `suspect` değil) ve "Yok say" (tarayıcıda fatura başına saklanır); genel not ve yakıt notu.
- Tarife düzenleyicide "Ülke istisnaları" kartı (ülke / % / not; faturadan gelenlerde "Faturadan önerildi · faturayı aç").

### 3.10 Döviz kuru ile karşılaştırma

Gerçek FedEx Türkiye sözleşme tarifeleri USD, faturalar TRY (FedEx günlük kurla çevirir; kendi kaynağı OANDA). Tarife ile satır para birimi farklıysa beklenen tutar kurla satır para birimine çevrilir.

- **Core** (`packages/core/src/fx.ts`, `compare.ts`): `compareLine({ …, fx: { date, rate: FxRate | null } })`.
  - Beklenen tutar tarife para biriminde hesaplanır, `round2(beklenen × kur)` ile çevrilir; ek ücret beklenenleri de çevrilir. Ağırlık/ölçü kuralları değişmez.
  - Döküm kalemleri tarife para biriminde (`currency`); son kalem çevrimdir: `Beklenen 52,94 USD × 41,2345 (TCMB 03.06.2025)` = TRY tutarı, `fx` nesnesiyle (`FxApplied`: base, quote, rate, date, requestedDate, source, expected, converted).
  - DB'de ayrı kolon yok; `fx` döküm JSON'unda saklanır, API satırda `fx` olarak döner (`fxFromBreakdown`).
- **Kur toleransı**: şirket ayarı `fxTolerancePct` (varsayılan %1,5). Çevrilen satırlarda tutar toleransı `max(amountTol, beklenen × %fxTolerancePct)`; sabit toleransı aşıp kur toleransında kalan fark MATCH + not `Kur farkı tolerans içinde (%1,5)`. Üstü DIFF.
- **Kur yoksa**: NO_TARIFF, not `Kur bulunamadı (USD→TRY, 03.06.2025)`, yapısal işaret `fxMissing`. `fx` hiç verilmezse `Para birimi uyuşmuyor …`.
- **Tutar toleransının kuru**: `compareLine({ …, tolFx: { base, quote, date, rate } })` — firma para biriminden satır para birimine (fatura günü).
  - `rate` null ise sabit yedek oran yoktur: satır NO_TARIFF + `Kur bulunamadı (TRY→USD, …)` (ağ hatasında `Kur alınamadı … — TCMB yanıt vermedi`), `fxMissing` çifti firma→satır.
  - Mükerrer ve ölçümsüz satır etkilenmez; tolerans 0 ise kur istenmez.
- **Saklı (bayat) kur**: `FxRate.stale` ise satır o kurla hesaplanır.
  - Notun sonuna `Kur 13.10.2026 tarihli (TCMB yanıt vermedi, saklı son kur kullanıldı)` eklenir (iki kur da bayatsa iki gün).
  - Sonuç `fxStale` (kurun günü, ISO) taşır; API satırın `pricing.fxStale` alanına yazar; satır kuruysa `fx.stale` döküm JSON'unda da durur.
  - Satır "İncele" olur (`confidence: LOW`, `reviewCode: FX_STALE`, gerekçe `Kur … tarihli (TCMB yanıt vermedi); güncel kurla Yeniden karşılaştırın`): kesin fazla ödemeye ve kesin itiraz talebine girmez (TL değer kaybederken eski kur farkı büyük gösterir).
  - Fatura toplamında `fxStale` (yalnız > 0 ise) sayılır; panel "N satır eski tarihli kurla hesaplandı … Yeniden karşılaştır" uyarısını gösterir (kur alınamadı uyarısı varken gösterilmez); Merkez'in "kur alınamadı" uyarısı bu satırları da sayar.
  - Kararı verilmiş satırda taze kur aynı rakamı verirse (aynı tarife sürümü ve ölçüm) not, döküm ve güven yazılır, karar değişmez; etkin itirazdaki satıra dokunulmaz.
  - Yalnız tutar toleransının kuru eksik diye hesaplanamayan donmuş satır "yeniden hesap bekliyor" işareti almaz.
- **Satır para birimi**: satırda yazmıyorsa fatura para birimi kullanılır. **Gün**: sevk tarihi, yoksa fatura tarihi (tarife geçerlilik notuyla aynı gün).
- **Kaynak** (`apps/api/src/services/fx.ts`): TCMB günlük bülteni `https://www.tcmb.gov.tr/kurlar/YYYYMM/DDMMYYYY.xml` (bugün için `today.xml`).
  - Kur = (ForexBuying + ForexSelling) / 2 / Unit — orta kura en yakın değer; alış ya da satış seçmek sistematik ±%0,1–0,2 sapma yaratırdı.
  - TRY karşılığı 4, çapraz kur (EUR→USD, TRY üzerinden) 6 ondalık.
  - Bülten yoksa (hafta sonu, tatil, bugün 15:30 öncesi) en çok 10 gün geriye gidilir (9 günlük bayram tatilinin son günü de önceki iş gününün kurunu bulur); dökümde `TCMB 06.06.2025, 07.06.2025 için` yazar.
- **Önbellek ve ağ**:
  - Önbellek: bellek + `STORAGE_DIR/fx/tcmb-YYYY-MM-DD.json` (geçmiş günlerin "bülten yok" işaretleri de).
  - İstek zaman aşımı `FX_TIMEOUT_MS` (varsayılan 30 sn; TCMB 5–10 sn, bazen daha yavaş); zaman aşımı/ağ hatası/5xx'te en çok 3 deneme (1 sn, 3 sn bekleme).
  - Yükleme ve `recompareInvoice` gereken (çift, gün) kurlarını önce **sırayla** toplar (`prefetchFx`). Bu toplamada 60 sn'lik devre kesici kullanılmaz/açılmaz; yalnız arka arkaya 2 gün 3 denemenin hepsinde düşerse kalan günler yalnız önbellekten okunur.
  - Toplamanın üst süresi `FX_PREFETCH_BUDGET_MS` (varsayılan 45 sn): dolunca istek beklemez, kalan günler önbellekten okunur, alınamayanlar arka planda iner ve `Yeniden karşılaştır` tamamlar.
  - Ölçüm değişikliğinden tetiklenen arka plan yeniden karşılaştırması (`recompareForTracking`) devre kesiciyi kullanır (2 başarısızlık → 60 sn TCMB'ye gidilmez).
  - Tutar toleransının kurları (firma → satır para birimi, fatura günü) aynı toplamaya girer.
- **Saklı kur seçimi**: ağ hatası ya da süre sınırı yüzünden alınamayan (çift, gün) için önbellekteki en yakın önceki bülten kullanılır (taze yolla aynı pencere, 10 gün; ilk bulunan bülten); `failed`'e girmez.
  - Arada atlanan her gün "bülten yok" işaretli ya da Cumartesi/Pazar ise kur taze yolun vereceği kurdur, bayat sayılmaz (Pazar için önbellekteki Cuma).
  - Bülteni bilinmeyen bir iş günü atlandıysa kur `stale: true` taşır ve en çok 7 gün geriden alınır (`STALE_MAX_DAYS`).
  - Alınamayan her gün arka planda yeniden indirilir: süre sınırına takılan hemen, ağ hatası alan (TCMB kapalıyken atlananlar dahil) 60 sn sonra (`retryAfterMs`); `Yeniden karşılaştır` taze kurla hesaplar.
  - Tek başına `getRate` saklı kur vermez.
- **Kur alınamadıysa**: fatura her durumda işlenir; ağ yüzünden kuru alınamayan (saklı kuru da olmayan) satır NO_TARIFF + not `Kur alınamadı (USD→TRY, 15.10.2026) — TCMB yanıt vermedi`. `totals.fxMissing` sayısı > 0 ise web fatura üstünde "Bazı satırlar için kur alınamadı — Yeniden karşılaştır'a basın" uyarısı gösterir. (Bülten gerçekten yoksa not "Kur bulunamadı …" kalır, sayılmaz.)
- **Ayarlar**: `GET/PATCH /settings` → `fxTolerancePct` (0–20), `fxSource` (salt okunur: "TCMB döviz alış/satış ortalaması").
- **Web**: satır tablosunda küçük `kur` etiketi (başlıkta kur/kaynak/gün); satır panelinde tarife kalemleri USD, "Tarife toplamı", "Kur USD→TRY TCMB gg.aa.yyyy × kur", "Beklenen" TRY. Ayarlar → "Döviz kuru" kartı.
- **Raporlar**: Excel'de "Kur" kolonu (`1 USD = 41,2345 TRY (TCMB 03.06.2025)`), PDF'te Beklenen hücresinin altında `52,94 $ × 41,2345`.

### 3.11 İtiraz süresi, WhatsApp paylaşımı, tarife şüphesi, itiraz takibi

Kurallar saf fonksiyon: `packages/core/src/invoiceHints.ts` ve `packages/core/src/disputes.ts` (testleri `packages/core/test`).

- **Ülke kuralı:** TTK süresi, son günü ve ona dayanan her uyarı, sütun ve sıralama yalnız ülkesi Türkiye olan firmada görünür (`ttkApplies`).
  - Ülke Merkez'den `org.updated` ile gelir, `settings.country` olarak saklanır, DeciShip yazmaz.
  - Yoksa `firmCountry` çözer: sürümlü olay gelmişse para birimi TRY ise Türkiye, değilse bilinmiyor; hiç olay gelmemişse bilinmiyor. Bilinmiyorsa TTK söylenmez.
  - Başka ülkede FedEx düzeltme süresi kalır (taşıyıcının kendi kuralı): özet satırı yalnız onu gösterir; Merkez'de KPI "Düzeltme süresi yaklaşan fatura" ve süzgeç "Düzeltme süresi" adıyla, yaklaşan yoksa KPI hiç çıkmaz; "İtiraz son günü" sütunu ve CSV'si yok, WhatsApp'ta son gün yazılmaz.
- **İtiraz süresi** (`disputeDeadlines(invoiceDate, carrierCode, today, country)`): TTK m.21/2 — fatura tarihi + 8 gün (son gün dahil); taşıyıcı kodu `fedex` ise ikinci bilgi olarak FedEx düzeltme süresi fatura tarihi + 30 gün. "Bugün" Türkiye yerel tarihi (UTC+3).
  - Fatura ayrıntısındaki özet kartında, fark varsa tek satır: `İtiraz için son gün 04.11.2026 · 3 gün kaldı` (0 gün: "bugün son gün"; ≤2 gün `warning` rengi); süre geçtiyse gri `İtiraz süresi doldu (8 gün)`; FedEx'te ` · FedEx düzeltme son günü 26.11.2026` (geçmediyse).
  - "i" ipucu: "TTK'ya göre faturaya 8 gün içinde itiraz edilmezse içeriği kabul edilmiş sayılabilir. Hukuki görüş değildir."
- **WhatsApp'ta paylaş** (`buildWhatsAppText`, `whatsAppUrl`): fatura başlığındaki eylemlerde tek bağlantı; `https://wa.me/?text=…` yeni sekmede açılır, "Gönder"e insan basar.
  - Mesajda yalnızca sayılar (müşteri adı/adresi/takip no yok): `DeciShip · FedEx fatura 9-482-11735 (27.10.2026): 18 gönderi, 4 fark, 1 eşleşmedi. Fazla ödeme 1.731,20 ₺. İtiraz için son gün 04.11.2026.`
  - Fazla ödeme yoksa "Fazla ödeme yok."; TTK süresi geçtiyse ya da firma Türkiye'de değilse son gün yazılmaz.
- **Tarife şüphesi** (`isTariffSuspect(compared, priceDiff)`): karşılaştırılan satır (MATCH + DIFF) ≥ 5 ve bunların %30'undan fazlası `PRICE` fark türündeyse (ölçü/ağırlık/ek ücret/mükerrer sayılmaz).
  - `GET/PATCH /invoices/:id` yanıtında `tariffSuspect: boolean` (okurken iki sayımla hesaplanır, saklanmaz).
  - Web özet kartında tek satır uyarı: "Satırların çoğunda fiyat farkı var; tarife yanlış ya da eski olabilir." + "Tarifeyi aç" (faturanın tarifesi).
- **İtiraz takibi**: fatura başına itiraz paketi gönderildi olarak işaretlenir, sonuç satır satır girilir, giriş iptal edilir, paket geri çekilir veya yeniden gönderilir; silme yok, her adım denetim izinde. Gönderen ve sonucu giren: `deciship.disputes.manage` (Yönetici, Muhasebe). Veri modeli §4, uçlar §5.11; kurallar `apps/api/src/services/disputes.ts`, `packages/core/src/disputes.ts`; ekranlar `apps/web/src/pages/Disputes.tsx`, `pages/invoice-detail/DisputeCard.tsx`. Ayrıntı: [itiraz.md](itiraz.md).

### 3.12 Faturanın tarifesi
Her faturanın **tek tarifesi** vardır (`Invoice.tariffId`, tarife silinince `SetNull`); faturanın tüm satırları bu tarifeyle karşılaştırılır (hizmete ya da tarihe göre satır başına seçim **yok**). Hesap canlı tarifeden değil, faturanın bağlı olduğu **tarife sürümünden** yapılır (`Invoice.tariffRevisionId`, §3.14).

- **Yeni faturanın tarifesi (`tariffForDate`):** istemci tarife vermediyse (`POST /invoices`, `PATCH /invoices/:id` ile taşıyıcı değişip tarife verilmediyse ya da `tariffId: null`) fatura gününde geçerli etkin tarife (geçerlilik başı ve sonu dahil).
  - Birden çoksa önce `isDefault`, sonra geçerlilik tarihi yazılı olan, sonra en son güncellenen. O gün geçerli tarife yoksa aşağıdaki varsayılan.
  - Web yükleme sihirbazı ve fatura düzenleme penceresi aynı kuralla önseçer (`apps/web/src/lib/tariffPick.ts`, `components/TariffSelect.tsx`); kişi elle seçmediyse fatura tarihi değişince önseçim yenilenir, ipucu "dd.mm.yyyy tarihinde geçerli tarife seçili".
- **Varsayılan kural** (`invoiceTariff`, `defaultTariff`): faturada seçilen tarife (aynı taşıyıcınınsa); seçim yoksa taşıyıcının etkin ve `isDefault` tarifesi, o da yoksa en son güncellenen etkin tarife.
  - Kural yalnız dayanağın **tarife parçası** bugünküne geçerken uygulanır: içe aktarmada, "Yeni tarifeyle hesapla"da, tarife toplu geçişinde, `PATCH /invoices/:id` ile taşıyıcı/tarife değişince ve dayanaksız faturanın kullanıcı hesabında.
  - Fatura bulunan tarifenin bugünkü sürümüne bağlanır (§3.14).
- Kayıtlı fatura sürümünde kalır: tarife sonradan değişse, silinse ya da "Varsayılan yap" başka tarifeyi seçse de rakam değişmez. `tariffId` boş faturada "Yeni tarifeyle hesapla" bir tarifeye bağlanınca o tarife `tariffId`'ye de yazılır.
- Taşıyıcının etkin tarifesi yoksa yükleme yapılır, satırlar `NO_TARIFF`, fatura dayanaksızdır (`tariffRevisionId` null; §3.14).
- Satır günü (sevk, yoksa fatura tarihi) tarifenin geçerliliği dışındaysa satır yine bu tarifeyle fiyatlanır, nota `Tarife (Ad) 2026-10-15 tarihinde geçerli değil (geçerlilik: … – …); yine de bu tarifeyle hesaplandı` eklenir. Geçerlilik tarihleri sürümün anlık görüntüsünden okunur.
