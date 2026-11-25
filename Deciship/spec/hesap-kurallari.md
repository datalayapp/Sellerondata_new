# DeciShip SPEC — Alan kuralları: desi, fiyat, karşılaştırma, fatura okuma (§3–§3.7)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 3. Alan kuralları (packages/core)

Tüm para hesapları **kuruş/cent tamsayı** ile ya da her adımda **2 ondalığa yarım-yukarı yuvarlama** ile yapılır; kayan nokta hatası testlerde yakalanmalıdır. Ağırlıklar 3 ondalık (gram) tamsayı mantığıyla.

### 3.1 Hacimsel ağırlık / desi
```
kenar = tariff.edgeRounding === 'CEIL_CM' ? ceil(kenar) : kenar      // varsayılan CEIL_CM
volumetric = L × W × H / divisor                                      // divisor: 5000 (uluslararası) | 3000 (yurt içi desi)
chargeableRaw = max(actualKg, volumetric)
chargeable = roundUpToStep(chargeableRaw, weightSteps)
```
- `weightSteps`: `[{ upto: 20, step: 0.5 }, { upto: null, step: 1 }]` — `chargeableRaw`'ın düştüğü ilk bandın adımına **yukarı** yuvarlanır (ör. 9,45 → 9,5; 21,2 → 22). Boş liste → yuvarlama yok. Yurt içi desi tarifelerinde tipik `[{upto:null, step:1}]`.
- **lb basamakları** (lb tarifesi, §5.7 "Ağırlık yuvarlama tablodan") lb katına yuvarlanır.
  - Tam ya da yarım lb'nin 3 haneli kg'ına denk gelen basamak (0,454 · 0,907 · 2,268 …), tarifenin fiyat satırları kg ağırlığıysa kg basamağıdır.
  - Satırların kg sayılması (core `lbRatesOf`): sabit fiyatlı satırların farklı ağırlıklarından ≥ 2 tanesinin yarıdan çoğu tam/yarım lb'nin 3 haneli kg'ı değilse kg; açık uç ve kg başı bant sayılmaz. Bu durumda yalnız tam hassasiyetli lb değeri (içe aktarmanın yazdığı 0,45359237) lb kalır.
  - lb satırlı tarifede 3 haneli değer (düzenleyicinin yuvarladığı 0,454; 0,68 · 0,34 de) lb'dir.
  - Satır bilgisi verilmeyen çağrıda (mobil barem notu) satırsız kural geçerlidir.
  - Hesap motoru satırları `roundUpToStep(kg, steps, rates)`, `chargeableWeight({ rates })`, `overflowUnits(…, rates)` ile alır; karşılaştırma ve tarife fiyat denemesi (`POST /tariffs/:id/quote`) tarifenin satırlarını verir.

Mobil ekranda ölçüm yapana gösterilen: **Desi** (`ayarlar.desiDivisor`, varsayılan 3000) ve **Hacimsel kg (5000)**, ayrıca gerçek kg. Fiyat yok.

Örnek (#5305): 40×30×25, 4,0 kg, bölen 5000 → hacimsel 6,0 → ücretlenecek 6,0 kg. Bölen 3000 → 10 desi.

### 3.2 Beklenen fiyat
```
zone = tariff.zones[ülke] ?? tariff.zones['*'] ?? null           // yurt içi: tek bölge '*'; mesafe bölgeli tarifede fiyat farkı "İncele" (§3.13 ZONE_DISTANCE)
base = rate(zone, chargeable)  // weightUpto >= chargeable olan ilk satır; tablonun üstündeyse:
                               // son satır fiyatı + ceil((chargeable - sonUpto)/step) × overflowPerUnit (tanımlıysa, yoksa NO_TARIFF)
discount = round2(base × discountPct/100)
afterDiscount = base - discount
fuel = round2(afterDiscount × fuelPct/100)
expected = afterDiscount + fuel
```
Örnek (#5305): Bölge A, 6,0 kg liste 1.527,75 · indirim %38 → 580,55 → 947,20 · yakıt %25 → 236,80 → **1.184,00**. Bu örnek birim testtir.

- **Ek ücretler** yakıttan sonra eklenir; indirim ve yakıt uygulanmaz: `FIXED` = tutar, `PER_KG` = tutar × ücretlenecek kg, `PCT` = tutar% × base. `total = afterDiscount + fuel + surcharges`.
- **Kg başı fiyat bandı** (`TariffRate.perKg`): isabet eden satır kg başıysa fiyat = `round2(fiyat × ücretli kg)`; son açık bant ("1000+") `weightUpto = 99999`.
- **Mükerrer satırda** `expectedAmount = null`, `diffAmount = netAmount`.
- **`overchargeTotal`** = yalnız `DIFF` satırların pozitif `diffAmount` toplamı (kesin satırlar; tahminiler `estimatedOverchargeTotal`, §3.8).
- **Ülke istisnası** varsa indirimden sonra taşıma bedeline uygulanır, yakıt istisnalı tutar üstünden (§3.8).
- Altın test verisi: `samples/expected.json` (bkz. `samples/README.md`).

**KDV:**
- Fiyatlar **KDV hariç** girilir; fatura satırında da KDV hariç net tutar eşlenir.
- Eşleme ekranında "Tutarlar KDV dahil" seçilirse yalnız net/toplam sütunu `net / (1 + kdv/100)` ile düşülür; varsayılan KDV %20.
- Ayrı KDV tutarı sütunu varsa ("KDV", "KDV (%20)", "KDV Tutarı") net tutar sütunu veriyle sınanır (`invoice/vat.ts`): karar veren bütün satırlarda KDV ≈ (tutar − KDV) × oran ise KDV dahil, oran veriden (20, 18, 10, 8, 1 ya da eşlemedeki); satırların %90'ında KDV ≈ tutar × oran ya da KDV hep 0 ise hariç; pay 0,02 + KDV'nin binde biri. Boş KDV sütunu ve tutar değişirken hep aynı KDV değeri kanıt değildir; dolu sütunda boş hücre KDV'siz satır sayılır. Öneri veriye göre seçer; kanıt yoksa başlık tahmini eskisi gibi dardır (tam "Toplam"/"Genel Toplam"/"Total" + tam "KDV"/"VAT"). Okuma kontrolü sorar: seçim veriye uymuyorsa, KDV'li ve KDV'siz satır karışıksa, "KDV dahil" seçili ama veri bunu göstermiyorsa (başlık "KDV Dahil" yazmıyorsa); veri anlaşılmazken "KDV hariç" seçimi yalnız satırların yarıdan çoğu aynı oranla KDV dahil görünüyorsa sorulur (gümrük vergisi "Tax" sütunu sorulmaz, §11.1).
- Navlun, indirim, yakıt ve ek ücret sütunları için karar sırası: eşlemedeki `componentsIncludeVat` → sütun başlığındaki "KDV dahil/hariç" ibaresi → dosyadaki satırların çoğunluğu → hiçbiri yoksa KDV hariç.
- Saklanan ve gösterilen her tutar KDV hariçtir; fatura özetinde, satır tablosunun tutar başlıklarında, Pano'da, raporda (Excel özet, PDF açıklama) ve itiraz metninde (satır tutarları ve toplam) "KDV hariç" diye yazar. İtiraz metninde oran biliniyorsa KDV dahil tutar da eklenir: itiraz.md "İtiraz metni ve kanıt".
- Eşlemedeki KDV oranı kutusu yazarken biçimlenmez, kutudan çıkınca okunur (TR "7,5", EN "7.5"); okunamayan ya da 0-100 dışı değer önceki orana döner.

### 3.3 Takip no normalleştirme
- `normalizeTracking(raw)`: boşluk/tire temizle, büyük harf. FedEx 34 haneli (96… ile başlayan) Code 128 → son 12 hane (ayrıca son 15'i de aday olarak tut).
- Eşleşme sırası: (1) normalize edilmiş tam eşit, (2) biri diğerinin sonekiyse (en az 10 karakter), (3) ham değer eşit.
- `trackingCandidates(raw): string[]` döner.
- **Ölçüm girişi** (telefonun barkod ekranı, `POST`/`PATCH /measurements`, `GET /measurements/check`): önce `stripScanNoise` (`trackingFormat.ts`), sonra `normalizeTracking` (faturayla aynı işlev). `stripScanNoise` yalnız kesin işaretleri siler: kontrol ve biçim karakterleri (GS/FNC1, CR, sıfır genişlikli boşluk, BOM), baştaki AIM simge kimliği (`]C1`, `]d2`, `]Q3`…), değer "(00)" gibi başlıyorsa GS1 AI parantezleri; Türkçe klavyenin "İ"si "I" olur. Ham değer (`trackingRaw`) böyle saklanır; temiz değeri değiştirmez, kayıtlı ölçümlerin eşleşmesi aynı kalır.
- **Biçim denetimi** `checkTracking(raw, { symbology? })` → `ok` / `unusual` / `invalid`:
  - `invalid` (kesin): harf ya da rakam yok; temizlenmiş değer `TRACKING_HARD_MIN` (5) karakterden kısa ya da `TRACKING_HARD_MAX` (50) karakterden uzun; yazdırılabilir ASCII dışı karakter (Ş, emoji). Sunucu 400 `VALIDATION` ("Takip no: …"), telefon kaydetmez ("Yeniden okut").
  - `unusual`: ürün barkodu (kamera EAN-13/EAN-8/UPC/ITF-14 bildirdi ya da 868/869 önekli, denetim hanesi tutan 13 hane), 8–35 dışı uzunluk, harf/rakam dışı işaret, rakamsız. Telefon tek soruyla sorar ("Yeniden okut" / "Yine de devam et"); sunucu kabul eder.
  - Taşıyıcı biçimleri `CARRIER_TRACKING_FORMATS` (FedEx, UPS, DHL, PTT, Aras, Yurtiçi, MNG) yalnız tanır, engellemez; yurt içi biçimler gevşek rakam aralığıdır.

### 3.4 Karşılaştırma (satır başına)
Girdi: fatura satırı, eşleşen ölçüm (en son sürüm) veya yok, tarife, toleranslar, aynı takip no'nun başka fatura satırlarında görülüp görülmediği, gerekirse kur (§3.10).

**Durum (`status`):** `MATCH` (Uyumlu) · `DIFF` (Fark var) · `UNMATCHED` (Ölçüm yok) · `NO_TARIFF` (Tarife/bölge/fiyat bulunamadı).
**Fark türleri (`diffTypes[]`, birincil tür ilk sırada):** `DUPLICATE`, `DIMENSION`, `WEIGHT`, `SURCHARGE`, `PRICE`, `PACKAGING` (poşet/zarf ile gönderilip kendi ambalajı gibi fiyatlanmış; aşağıda).

Kurallar sırayla:

0. **İade / düzeltme:** net tutarı eksi olan satır tarifeyle karşılaştırılmaz ve mükerrer sayılmaz.
   - Sonuç: `NO_TARIFF`, `expectedAmount = diffAmount = null`, `note` "İade/düzeltme satırı (eksi tutar) — tarifeyle karşılaştırılmaz" (`compare.credit`), güven HIGH.
   - Fatura toplamında (`billedTotal`) kalır; karşılaştırılan Faturalanan, Beklenen ve fazla ödemeye girmez.
   - Mükerrer kuralında görünüm de sayılmaz: dosyada üstteki ya da önceki faturadaki iade, aynı takip no'lu asıl ücreti mükerrer yapmaz.
   - **İptal ve yeniden fatura** (API `cancelCredits`): tutarı (mutlak) aynı taşıyıcının bir ücretine kuruşu kuruşuna eşit iade o ücreti iptal eder; ikisi de önceki görünüm sayılmaz. Eşleme sırası: önceki faturaların iadeleri kendilerinden önceki ücretleri; bu dosyanın iadeleri önce önceki faturaların, yoksa bu dosyanın eşit tutarlı ücretini iptal eder; dosyadaki sırası fark etmez. Örnek: A: 100,00; B: −100,00 ve 100,00 → B'deki 100,00 mükerrer değil.
   - Aynı faturadaki iadeyle iptal edilen ücret de karşılaştırılmaz (`NO_TARIFF`, not "İade ile iptal edildi — tarifeyle karşılaştırılmaz", `compare.creditCancelled`; core `cancelledByCredit`): fark ve itiraz çıkmaz (dosyada 120,00, −120,00, 100,00 → yalnız 100,00 karşılaştırılır).
   - Önceki faturadaki iptal edilen ücret o faturada olduğu gibi kalır (kapsam dışı; kararı verilmiş olabilir).
   - Hiçbir ücrete eşit olmayan bu taşıyıcının iadesi varsa o takip no'nun mükerreri kesin sayılmaz, "İncele" olur (`DuplicatePrior.unmatchedCredit`, gerekçe `compare.confidence.duplicateCredit`).
   - **Sıfır tutarlı satır** (ücretsiz gönderi, kampanya) aynı sınıftadır: karşılaştırılmaz, `note` "Ücretsiz satır (tutar 0) — tarifeyle karşılaştırılmaz" (`compare.freeLine`), Faturalanan'a 0 ekler, mükerrerin önceki görünümü sayılmaz. Özet cümlesi ve ekran bu satırı "tarife yok" sayısında gösterir (ayrı sayı yok).
1. **Mükerrer:** Aynı takip no, aynı şirketin başka (silinmemiş, örnek olmayan) fatura satırında ya da aynı faturada daha önce varsa → `DIFF` + `DUPLICATE`, fark = satırın net tutarının tamamı (ikinci ve sonraki görünümler için). Kesin sayılması için önceki faturada aynı taşıyıcı, aynı tutar ve aynı açıklama gerekir; aynı dosyadaki görünüm hiçbir zaman kesin değildir; değilse satır "İncele" olur (§3.13 "Mükerrer", "Çok koli şüphesi").
2. **Ölçüm yok** → `UNMATCHED` (beklenen null). Fark hesaplanmaz.
3. **Tarife yok** (faturanın tarifesi, bölge veya fiyat satırı yok; para birimi uyuşmuyor ve kur yok) → `NO_TARIFF` + `note`.
4. `ourChargeable` = 3.1 ile bizim ölçümümüzden. `billedChargeable` = faturadaki ücretli ağırlık (yoksa faturadaki ölçülerden ve gerçek ağırlıktan aynı formülle; o da yoksa null).
5. `billedChargeable > ourChargeable + weightTolKg` ise: faturada ölçü var **ve** herhangi bir kenar bizimkinden `edgeTolCm`'den fazla büyükse **ya da** faturanın hacimsel ağırlığı bizim gerçek ağırlığımızdan büyükse → `DIMENSION`; değilse → `WEIGHT`. (Kenarlar sıralanarak karşılaştırılır; yön önemsizdir.)
   - Önce ölçüm payına bakılır (§3.13): fark payın içindeyse bu adım tetiklenmez.
   - Faturadaki ham kg toleransın içinde ama tarife basamağına yuvarlanınca bir üst basamağa düşüyorsa (biz 6,0; fatura 6,05 → 6,5 basamağı) adım yalnız taşıyıcının taşıma + yakıtı üst basamağın fiyatını gösteriyorsa tetiklenir: bizim basamağımızın tarife fiyatından tutar toleransı ötesinde pahalı **ve** faturadaki basamağın tarife fiyatından tolerans ötesinde ucuz değil.
   - Bizim basamağımızın fiyatını almışsa fark yoktur; iki basamağın arasında kalan fiyat (bizim basamağa zam, navluna katılmış güncel yakıt) basamak kanıtı sayılmaz, adım 8'deki fiyat farkı olarak kalır.
6. **Ek ücret:** faturadaki her ek ücret kodu tarifenin ek ücret listesinde yoksa → `SURCHARGE` (tutarı farka girer); listede varsa beklenen tutarı hesaplanır, fazlası `SURCHARGE`.
7. `expected` = 3.2 (ourChargeable ile) + tarifede tanımlı ve faturada geçen ek ücretlerin beklenen tutarı. `diff = billedNet - expected`. Ağırlık/ölçü farkı varken taşıyıcı tarifeden ucuzsa taşıma + yakıt faturadaki fiyattan ölçeklenir (§3.8).
8. `diff > amountTol` ve 5/6 tetiklenmediyse → `PRICE`. Yalnız 6 (ek ücret) tetiklendiyse ve dayanak tarifeyse, taşıma + yakıt kısmı (net − faturadaki tüm ek ücretler − tarifenin taşıma + yakıtı) toleransı aşıyorsa `PRICE` ikinci tür olarak eklenir (`['SURCHARGE', 'PRICE']`), notta "Taşıma ve yakıt tarifeden fazla: +…".
9. Hiçbiri tetiklenmediyse ve `diff <= amountTol` → `MATCH`. (Lehimize fark `diff < -amountTol` ise `MATCH` + `note: "Lehimize fark"`.) Ağırlık/ölçü farkı olup tutara etkisi tolerans içinde kalan satır da `MATCH` olur (§3.13).

Varsayılan toleranslar (şirket ayarı): `edgeTolCm = 0.5` (yeni firma; kayıtlı değeri olmayan eski firma 1, `LEGACY_EDGE_TOL_CM`), `weightTolKg = 0.1`, `amountTol = 5` (TRY; USD/EUR/GBP'de 0,5, §3.13).
**Ücretli kilogramı değiştirmeyen ölçü sapması fark sayılmaz.**

**Poşet (Pak) ve zarf** (bütün taşıyıcılar; `packages/core/src/packaging.ts`, `compare.ts` `packagingPlan`):
- Ambalaj türleri `OWN` (kendi ambalajımız, varsayılan), `PAK` (FedEx Pak, UPS Express Pak, DHL Flyer…), `ENVELOPE` (taşıyıcı zarfı; dosya/evrak). Ölçüm ambalajı mobilde seçilir (`MeasurementInput.packaging`); faturada ambalaj sütunundan (yalnız sayı olan kod yalnız FedEx kalıbında FedEx tablosuyla — "Service Packaging"/"Paketleme": 01, 03 kendi ambalajı, 02 Pak, 06 Zarf — ve UPS kalıbında UPS tablosuyla okunur, diğer taşıyıcılarda okunmaz; metin "Pak", "Flyer", "Envelope", "Letter", "Document", "Zarf", "Dosya", "Evrak", "Your Packaging"), sütun yoksa hizmet adından (yalnız Pak/Zarf; "Document(s)"/"Doc" hizmet adında ürün türüdür, ambalaj değil; "Non-Documents", "Doc Box" gibi adlar özel ambalaj sayılmaz); bilinmiyorsa yok (`ParsedInvoiceLine.packaging`). Hizmet adında "Dosya", "Evrak", "Flyer", "Poşet" geçen satır da Pak/Zarf sayılır: tarifede o ambalajın fiyatı yoksa kapsam dışı kalır.
- Sınırlar taşıyıcı başına (`packagingLimitsFor`: taşıyıcı ayarındaki geçersiz kılma > `DEFAULT_PACKAGING_LIMITS` > bilinmiyor). FedEx: Pak en çok 2,5 kg ve 15.400 cm³, Zarf en çok 0,5 kg ve 31,7×24,1×2 cm; UPS Zarf 0,5 kg ve 40,6×31,7×2 cm, DHL Zarf 0,3 kg ve 35×27,5×1 cm (zarf kalınlıkları varsayım); diğerleri bilinmiyor. Zarf kenarları (`maxEdgesCm`) ölçüler sıralanıp kenar kenar karşılaştırılır (aşınca `DIMENSION`); kenar sınırı ya da ölçü yoksa yalnız ağırlık denetlenir, mobil zarfı yalnız kenar sınırı ve ölçü varken önerir. Zarf sınırını aşan Pak gibi, Pak sınırını aşan kendi ambalajı gibi fiyatlanır (`pricedPackaging`).
- Tarife Pak ve Zarf fiyatlarını ayrı satır taşır (`rates[].packaging`), indirimleri `pakDiscountPct` / `envelopeDiscountPct` (yoksa genel indirim). Pak/Zarf fiyatında desi yoktur: ücretli kg = gerçek kg, o ambalajın kendi satırına yukarı (kendi ambalajı basamakları uygulanmaz: 1 kg basamaklı tarifede 0,4 kg Pak 0,5 kg satırından; `packagingRowKg`); taşma ve ülke istisnası uygulanmaz. Kendi ambalajı hesabı Pak/Zarf satırlarından etkilenmez.
- Fatura Pak/Zarf ve tarifede o ambalajın o bölgede fiyatı var → taşıyıcı o ambalajın fiyatını uyguladığı için o fiyatla, bizim ağırlığımızla denetlenir (ağırlık ve fiyat farkı kuralları geçerli, ölçü farkı yok); ölçümümüz o ambalajın sınırını aşsa da (bilgi notu; kendi ambalajı fiyatına geçmek yalnız taşıyıcı kendi ambalajı fiyatladıysa anlamlıdır). Tabloda bizim ağırlığımız için fiyat yoksa Zarf satırı Pak fiyatıyla, o da yoksa kapsam dışı. Fiyat yoksa satır kapsam dışıdır: koli tarifesiyle karşılaştırılmaz, ölçüm aranmaz, `UNMATCHED`/`NO_TARIFF` + `note` "Pak/zarf gönderisi — kapsam dışı" (`PAK_NOTE`); özette ayrı "N pak/zarf satırı kapsam dışı" diye sayılır.
- Ölçüm Pak/Zarf, fatura kendi ambalajı (ya da daha pahalı ambalaj; Zarf ile gönderilip Pak fiyatlanmış) ve ölçüm sınırı aşmıyor, tarifede fiyat var → `PACKAGING` farkı: beklenen bizim ambalajımızın fiyatı (bizim gerçek kg'ımızda), fark taşıma + yakıtın tamamı (faturadaki ağırlık/ölçü farkı ayrıca sayılmaz); ek ücret fazlası yanında `SURCHARGE` kalır, tutar bir kez. Kesin (HIGH) yalnız: sınır biliniyor, ölçüm Zarf değil, ölçümümüze toleranslar (`weightTolKg`, her kenara `edgeTolCm`) eklenince de ve faturadaki gerçek ağırlık/ölçüyle (varsa) sınır aşılmıyor, faturanın ambalajı biliniyor. Değilse "İncele", ilk tutan: sınır bilinmiyor `PACKAGING_LIMIT_UNKNOWN`; ölçüm Zarf `PACKAGING_ENVELOPE` (taşıyıcılar zarfı belge için kabul eder, içinde ürün olan zarfı poşet ya da paket fiyatlayabilir); sınıra yakın ya da faturadaki ağırlık/ölçü sınırı aşıyor `PACKAGING_NEAR_LIMIT`; faturada ambalaj bilgisi yok `PACKAGING_UNKNOWN`. Çok kolili şüphesi ve yakıt kuralları geçerli; uç fiyat/uç ağırlık kuralları uygulanmaz. Tarifede zarf fiyatı yoksa Pak fiyatıyla (alt sınır) denetlenir.
- Ölçüm Pak/Zarf ama bilinen sınırı aşıyor ya da tarifede fiyatı yok → kendi ambalajı kuralları, bilgi notu ("FedEx Pak sınırını aşıyor …; kendi ambalajı gibi denetlendi").
- Pak/Zarf fiyatıyla denetlenen satırın `rate`/`rateDeviationPct` boştur (tarife uyumu ve ülke istisnası yalnız kendi ambalajı fiyatına); `PACKAGING` satırında faturanın kendi ambalajı fiyatının tarifeyle karşılaştırmasıdır. Sonuçta `pricedPackaging` beklenenin alındığı ambalajı söyler.

#### Fatura özeti (`packages/core/src/invoiceSummary.ts`)
- "Karşılaştırılan satırlarda" kutusunda Faturalanan ve Beklenen **aynı kalemleri kapsar** (karşılaştırılan satırların tüm ücretleri).
- **Mükerrer satır Faturalanan'a tam tutarıyla girer, beklenen karşılığı 0 sayılır** (tutar `reconciliation` içindeki `uncompared` adımından; kayıtlı `comparedBilledTotal` değişmez, yalnız kutunun topladığı); böylece Faturalanan − Beklenen = Fazla ödeme tutar. Faturalanan taşıyıcının kestiğidir: "İncele" (aynı dosyada tekrar eden takip no, `confidence: LOW`) ya da "Uyumlu say" denmiş mükerrer de girer; Fazla ödeme'ye girmediği için aradaki adımlarda ("incelenecek", "kabul edilen") geri çıkar.
- Büyük sayının altında `summaryGap`: eşitse "= Faturalanan − Beklenen", değilse aradaki adımlar adlarıyla ("tolerans içi −0,30 ₺ · lehinize +15,00 ₺").
- Hiç karşılaştırılan satır yoksa (`nothingCompared`) kutular 0,00 yerine fatura toplamını ve "henüz karşılaştırılmadı" yazar.
- Tarifede tanımlı olmayan ek ücretler (varsayılan ayarda) Beklenen'e **faturadaki tutarıyla** eklenir: tarifeyle kontrol edilemezler, iki tarafta eşit olduklarından farkı etkilemezler; fark yalnız tarifenin tanımladığı kalemlerden doğar (satırda Beklenen = tarifeye göre + faturadan alınan, Fark = Faturalanan − Beklenen).
- "Tarifede olmayan ek ücretleri fark say" (`unknownSurchargesAsDiff`) açıkken Beklenen'e girmezler, tamamı fark sayılır (`invoiceSummaryAmounts` → `billed`, `expected`, `unchecked`, `invoiceTotal`); faturadan alınan ek ücretlerin toplamı (bilgi) ve fatura toplamı (farklıysa) ayrı satırda gösterilir.
- Tek cümle `invoiceSummarySentence`: "19/120 satır karşılaştırıldı · 3 satırda fark var · 63 satırın ölçümü bulunamadı · 38 pak/zarf satırı kapsam dışı" (yalnız tarifesinde Pak/Zarf fiyatı olmayan Pak/Zarf satırları).
- Büyük "Fazla ödeme" (yalnız fark satırlarının fazlası, mükerrer dahil) Faturalanan − Beklenen'den farklıysa tek satırlık açıklama (`overchargeNote`) çıkar, aynıysa çıkmaz.
- Aynı hesap ve açıklama ekranda, Excel ve PDF raporunda kullanılır. Fazla ödemenin adım adım dökümü ("Nasıl hesaplandı?", `overchargeReconciliation`): §3.15.

Satır kararı (`decision`): `OPEN` (varsayılan, DIFF satırlarında) · `VERIFIED` (Doğrulandı → itiraz listesinde) · `ACCEPTED` (Uyumlu sayıldı; `reason` zorunlu).

### 3.5 Fatura okuma
Normal satır biçimi (`ParsedInvoiceLine`):
```ts
{ rowIndex: number; trackingNo: string; shipDate?: string /*YYYY-MM-DD*/; service?: string;
  destCountry?: string /*ISO-2*/; actualKg?: number; billedKg?: number;
  dims?: { l: number; w: number; h: number }; billedDivisor?: number;
  baseAmount?: number; discountAmount?: number; fuelAmount?: number;
  surcharges: { code: string; name?: string; amount: number }[];
  netAmount: number; currency?: string; reference?: string; rawHash: string }
```
- `detectFormat(fileName, bytes)` → `'csv' | 'xlsx' | 'pdf' | 'unknown'`.
- `readTable(file)` → `{ headers: string[]; rows: string[][] }`.
  - CSV ayırıcı otomatik: `,` `;` `\t`; Excel'in `sep=;` ipucu satırına uyulup satır atılır.
  - Kodlama: UTF-8 (BOM'lu/BOM'suz), UTF-16 (BOM'lu), değilse Windows-1254.
  - XLSX'te en çok veri satırı olan görünür sayfa okunur (önde "Özet" sayfası olsa da). Okunmayan görünür dolu sayfalar `Table.sheets`'te; gönderi satırı taşıyanı okuma kontrolü sorar (§11.1).
  - Başlık satırı otomatik bulunur: ilk 20 satırda en çok **farklı** dolu metin hücresi olan satır.
  - Türkçe sayılar (`1.234,56`) ve tarihler (`27.10.2026`) doğru okunur.
  - Sayı biçimi: tutar sütunlarının metin hücrelerindeki kanıt eşlemedeki `numberFormat` ipucunu (kayıtlı eşleme, yapay zekâ) ezer; tutarlarda kanıt yoksa ipucu, o da yoksa bütün sayı sütunlarından tespit (`resolveNumberFormat`). Ağırlık yazımı tutarların biçimini belirlemez; K36 ağırlık seçimi (`weightFormat`) ayrıdır.
  - Birleştirilmiş hücreler: yatay devam hücreleri boş okunur (logo/başlık satırı her sütunda tekrarlanmaz), dikey devam hücreleri ana hücrenin değerini alır. İki katlı başlıkta grup adı alt başlığa eklenir: "Ağırlık / Gerçek".
  - CSV'deki Excel metin sarmalayıcısı `="0012…"` açılır.
  - XLSX'te gerçek sayı hücreleri işaretlenir (`Table.numeric`, `isNumericCell`); metni ondalık virgüllüdür ("0,453") ve sayı biçimine (`numberFormat` tr/en, tespit ya da eşleme) bakılmadan okunur (`cellNumber`; `parseRows`, okuma kontrolü, ücret çiftleri, fatura toplamı). Sayı biçimi tespiti yalnız metin hücrelerine bakar. CSV'de her hücre metindir.
  - Okunamayan dosyada `InvoiceFileError` (`code`: `EMPTY_FILE`, `NO_ROWS`, `XLSX_UNREADABLE`, `OLD_EXCEL`, `HTML_AS_EXCEL`, `UNSUPPORTED_FORMAT`) ne olduğunu ve ne yapılacağını kullanıcının dilinde söyler. `detectFormat` 'unknown' dönerse nedeni `unsupportedFileError(fileName, bytes)` verir. API bu mesajları olduğu gibi döner.
  - Dayanıklılık fikstürleri `packages/core/test/fixtures/robustness` altındadır (üretici `build.ts`). Testler: `invoice-robustness.test.ts`, uçtan uca `apps/api/test/invoiceRobustness.test.ts`.
- **Sütun eşleme (`ColumnMapping`):** alan → başlık adı.
  - Alanlar: `trackingNo`(zorunlu), `netAmount`(zorunlu), `shipDate`, `service`, `destCountry`, `actualKg`, `billedKg`, `dimL`, `dimW`, `dimH`, `dims` (tek hücrede "40x30x25"), `billedDivisor`, `baseAmount`, `discountAmount`, `fuelAmount`, `currency`, `reference`, `surchargeColumns: { header: string; code: string }[]`, `amountsIncludeVat: boolean`, `vatPct: number`, `desiAsWeight: boolean` (yurt içi faturalarda "Desi" sütunu ücretli ağırlık yerine).
  - Ayrıca birim sütunları ve sabit birimler (`dimUnit`, `actualKgUnit`, `billedKgUnit`, `defaultDimUnit`, `defaultWeightUnit`), ücret çiftleri (`chargePairs`), etiket sınıfları (`chargeLabelOverrides`), `numberFormat`, `dateOrder` (§11).
- **Hazır kalıplar (`CARRIER_PRESETS`):** `fedex`, `ups`, `dhl`, `aras`, `yurtici`, `mng`, `ptt`, `generic`.
  - Her kalıp, başlık adı eş anlamlılarından (TR + EN, büyük/küçük harf ve Türkçe karakter duyarsız) önerilen eşlemeyi üretir: `suggestMapping(headers, carrierCode)` → `{ mapping, confidence, missing: string[] }`.
  - Kapsanan başlıklar: FedEx Billing Online sütun adları (Tracking ID / Express or Ground Tracking ID, Shipment Date, Service Type, Recipient Country, Actual Weight, Rated Weight, Dim Length/Width/Height, Dim Divisor, Transportation Charge, Discount, Fuel Surcharge, Net Charge Amount, Currency…), UPS/DHL ve Türk firmalarının yaygın Excel başlıkları (Gönderi No, Takip No, Barkod, Desi, Kg, Ağırlık, Tutar, Toplam, Navlun, KDV…).
  - Kalıp bilinmiyorsa `generic` eş anlamlıları kullanılır.
  - "Navlun" net tutar adayı değildir (bileşen; yakıt ve ek ücret dışarıda kalırdı). Dosyada tek tutar sütunu navlunsa (yakıt, indirim, ek ücret ve "Hizmet Bedeli" gibi tanınmayan tutar sütunu yok) net odur; değilse net seçilmeyi bekler.
- `parseRows(table, mapping)` → `{ lines: ParsedInvoiceLine[]; errors: { rowIndex; code; message }[]; skipped: { rowIndex; reason: 'NO_TRACKING'; amount }[]; componentsVat }`.
  - Hata kodları `NO_TRACKING_COLUMN`, `NO_NET_COLUMN`, `BAD_TRACKING`, `BAD_NET`, `BAD_DATE`.
  - Takip no'su boş ama tutarı olan satır faturaya alınmaz, `skipped`'e yazılır; toplam satırları sayılmaz. Faturaya alınmayan satırların kaydı (`importReport`): §3.15.
- `rawHash` = satır hücrelerinin sha256'sı; yalnız satırın kimliğidir. Birebir aynı satır atlanmaz; içeri alınır ve "Mükerrer" olur (§3.13).
- **Kişisel veri:** alıcı adı/adres sütunları ham satırdan atılır; yalnızca eşlenen alanlar saklanır.
- PDF: core okumaz; API Claude ile okur ve aynı `ParsedInvoiceLine[]` biçimine çevirir (§5.8). Okunan takip no, tutar, ağırlık, ölçü ve ek ücretler PDF'in metniyle, satır toplamı fatura toplamıyla karşılaştırılır (`checkPdfLines`, `checkPdfTotals`, §3.15).
- **Toplu yazım (API, `services/lineWrite.ts`):** fatura satırları ve karşılaştırma sonuçları 2.000'lik parçalarla, parça başına tek SQL ifadesiyle (`jsonb_to_recordset`) yazılır; değerler (ondalık yuvarlama, UTC zaman damgası) Prisma ile yazılanlarla birebir aynıdır. 20 bin satırlık hesap ~1 sn; Excel raporu akışlı yazılır.

### 3.6 İtiraz metni
- `buildDisputeText({ company, carrier, invoice, lines, lang: 'tr'|'en' })` → `{ subject, body, lineCount, total }`.
- `VERIFIED` satırlar listelenir: takip no, bizim ölçü ve ağırlık, faturalanan ağırlık/ölçü, beklenen ve faturalanan tutar, talep edilen düzeltme, toplam.
- Yeniden karşılaştırmadan sonra artık fark olmayan ya da farkı ≤ 0 kalan doğrulanmış satırlar listeye girmez; toplam ekrandaki "İtiraz listesinde" tutarıyla (`totals.verifiedTotal`) aynıdır.
- Kibar, resmi, kısa.
- Satırın kanıtı (`DisputeLine.evidence`: ölçüm zamanı, yöntem, fotoğraf sayısı; ölçen kişinin adı yok), dönüşteki `photoCount` ve KDV dahil tutar: itiraz.md "İtiraz metni ve kanıt".

### 3.7 Core dışa aktarımları
`src/index.ts` her modülü dışa aktarır; tam imzaların kaynağı koddur. Ana giriş noktaları:

| Modül | Dışa aktarım |
|---|---|
| `calc.ts` (bağımlılıksız) | `WeightStep`, `EdgeRounding`, `roundEdges`, `volumetricWeight` (3 ondalık), `desi` (2 ondalık, bölen varsayılan 3000), `roundUpToStep`, `chargeableWeight` → `{ volumetric, chargeable, basis: 'ACTUAL'\|'VOLUMETRIC' }`, `round2` (yarım-yukarı) |
| `tariff.ts` | `TariffInput`, `CountryAdjustment`, `expectedCharge({ tariff, chargeableKg, destCountry?, surchargeCodes?, locale? })` → `{ ok: true, zone, lines, base, discount, adjustment, adjustmentPct, freight, fuel, surcharges, total }` ya da `{ ok: false, reason }` |
| `compare.ts` | `Tolerances` (`edgeTolCm, weightTolKg, amountTol, fxTolerancePct?, unknownSurchargesAsDiff?`), `MeasurementInput`, `compareLine({ line, measurement, tariff, tol, isDuplicate, fx?, locale? })` → `ComparisonResult` (`status, diffTypes, ourChargeableKg, billedChargeableKg, expectedAmount, billedAmount, diffAmount, uncheckedSurchargeTotal, breakdown, note?, fx?, pricingBasis, rateDeviationPct, confidence, confidenceReason, rate`) |
| `tracking.ts` (bağımlılıksız; dışa aktarım yolu `./tracking`) | `normalizeTracking`, `trackingCandidates`, `trackingMatchLevel` |
| `trackingFormat.ts` (bağımlılıksız; dışa aktarım yolu `./trackingFormat`, mobil de kullanır) | `stripScanNoise`, `checkTracking`, `CARRIER_TRACKING_FORMATS`, `TRACKING_HARD_MIN/MAX` (§3.3) |
| `invoice/*` | `detectFormat`, `readTable`, `suggestMapping`, `parseRows`, `CARRIER_PRESETS`, `CarrierCode`, `verifyMapping`, `mappingDiagnostics`, `mergeAiMapping`, `buildImportReport`, `checkPdfLines`, `pdfMissedTrackings`, `resolvePdfReadUnits` (§3.15) |
| `dispute.ts` | `buildDisputeText(input)` → `{ subject, body, lineCount, total, photoCount }` |
| `invoiceSummary.ts` | özet tutarları ve cümlesi (§3.4), `overchargeReconciliation` (§3.15) |
| `format.ts` (locale isteğe bağlı) | `fmtMoney` ("1.184,00 ₺"), `fmtKg` ("4,02 kg"), `parseTrNumber` ("1.234,56", "1234.56", "4,0") |
| `measureInput.ts` (bağımlılıksız; web ve mobil; dışa aktarım yolu `./measure`) | `parseMeasureNumber` (koli ölçüsü/ağırlığı: binlik yok, "1.500" = 1,5; mobil `parseNum` bunu kullanır), `ambiguousWeightText` ("1.500" gibi nokta + tam 3 hane ağırlığın iki okuması, değilse null; `sep`: `.` Türkçe arayüz, `,` İngilizce arayüz (`uiAmbiguousSeparator`), `any` dosya/PDF; yalnız "kg"/"desi" eki atılır, "1.500 lb" belirsiz sayılmaz) |
| Diğer | `i18n`, `barem`, `pastedNumbers`, `surcharges`, `disputes`, `tariffImport`, `pdfScan`, `pdfDiscount`, `weightSteps`, `countries`, `countryNames`, `fx`, `invoiceHints`, `tariffHealth`, `service` |
