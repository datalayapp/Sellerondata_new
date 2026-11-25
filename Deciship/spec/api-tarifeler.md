# DeciShip SPEC — API: taşıyıcılar ve tarifeler (§5.7)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

### 5.7 Taşıyıcılar ve tarifeler

Kod: `apps/api/src/routes/tariffs.ts`, `apps/api/src/services/tariffs.ts`, `tariffImport.ts`, `tariffPdf.ts`, `tariffExcel.ts`; çekirdek `packages/core/src/tariffImport.ts`.

#### Taşıyıcı ve tarife uçları
- `DELETE /carriers/:id`: faturası varsa pasifleştirir.
- `GET /tariffs?carrierId=` → özet liste.
- `GET /tariffs/:id` → `{ tariff (tam: zones, rates, overflow, surcharges), pinnedInvoices }`. `pinnedInvoices`: bu tarifenin sürümleriyle hesaplanmış silinmemiş fatura sayısı (silme onayındaki "Geçmiş faturalar etkilenmez" cümlesi için).
- `PUT /tariffs/:id`: tam gövdeyi değiştirir.
  - Gövdede `expectedUpdatedAt` = düzenlenen hâlin `updatedAt`'i. Tarife bu arada başka yerde değiştiyse hiçbir şey yazılmaz: 409 `STALE` + `details.updatedAt`. Verilmezse son kaydeden kazanır.
  - Değişiklikten önceki hâl aynı işlemde, tarife satırı kilitlendikten sonra okunup sürüm olur.
  - Varsayılan işareti yalnız önceki varsayılandan kalkar; öbür tarifelerin `updatedAt`'i oynamaz. Varsayılanı değiştiren her yazım taşıyıcı başına kilit alır; eşzamanlı iki "Varsayılan yap" iki varsayılan bırakmaz.
- `POST`/`PUT /tariffs`: aynı bölge (`zoneKey`) ve ağırlık için ikinci fiyat ya da aynı gruptaki (`canonicalSurchargeCode`) ikinci ek ücret 400 `VALIDATION` (`details[].path` `rates.N` / `surcharges.N`).
- `POST /tariffs/:id/duplicate`.
- `DELETE /tariffs/:id`: gerçek silme; fiyat sürümleri ve onlara bağlı faturalar durur (§3.14).
- `POST /tariffs/:id/default`: tek tıkla varsayılan yap (taşıyıcının diğer tarifelerinden işaret kalkar; pasif tarife `400 TARIFF_INACTIVE`).
- Tarife yazan her yol (oluşturma, `PUT`, içe aktarma, geri yükleme, kopya, ülke istisnası) aynı işlemde fiyat sürümünü günceller (`ensureTariffRevision`, §3.14) ve hiçbir faturayı hesaplamaz.
- Tam tarife gövdesi: `{ carrierId, name, service?, currency, divisor, edgeRounding, weightSteps, discountPct, fuelPct, validFrom?, validTo?, active, isDefault, zones: {country, zone}[], rates: {zone, weightUpto, price, perKg?}[], overflow: {zone, perUnit}[], surcharges: {code, name, kind, amount}[], countryAdjustments? }`
- `POST /tariffs/:id/country-adjustments`: §3.9.
- `POST /tariffs/:id/quote` `{ lengthCm, widthCm, heightCm, weightKg, destCountry?, surchargeCodes? }` → `expectedCharge` sonucu + `chargeableKg, volumetricKg, basis, currency` (tarife ekranındaki "Fiyat hesapla" deneme kutusu).

#### Excel/CSV içe aktarma
- `GET /tariffs/template.xlsx`: 3 sayfalı şablon: `Fiyatlar` (ilk sütun "Ağırlık (kg/desi) ≤", diğer sütun başlıkları bölge adları), `Bölgeler` (Ülke kodu, Bölge), `Ek ücretler` (Kod, Ad, Tür, Tutar).
- **"Bölgeler" ülke hücreleri:** ISO-2 (`DE`), ISO-3 (`DEU`), `*`, Türkçe/İngilizce ad (`Almanya`, `Germany`) ve ad+kod birlikte (`Germany DEU`, `Almanya - DE`, `GBR: United Kingdom`) okunur. Ad ile kod çelişirse tahmin yapılmaz, hücre tanınmaz.
- `POST /tariffs/:id/import` multipart `file` (xlsx/csv) → **kaydetmez**; taslak (24 saat) + önizleme döner: `{ draftId, summary, zones, rates, overflow, surcharges, checks, canApply, fixes, comparison, aiAvailable }`.
  - Kod kontrolleri (`checkTariffImport`, core) hataları engeller: fiyat yok, bölge sütunu yok, mükerrer ağırlık, okunamayan fiyat, bölge eşlemesindeki bölgenin fiyatı yok, lb ağırlık (seçenek `convertLbToKg`), para birimi farkı (seçenek `currency`), belirsiz sayı biçimi (seçenek `numberFormat`), belirsiz indirim oranı (seçenek `discountUnit`), belirsiz açık uçlu satır.
  - `fixes`: `{ id, value?, label, resolves }`; `numberFormat` ve `discountUnit` aynı kimlikle iki seçenektir (biri seçilir).
  - Bölge adları `zoneKey` ile karşılaştırılır ("Zone A" = "A").
- `POST /tariff-imports/:draftId/recheck` `{ options }` → aynı önizleme.
- `POST /tariff-imports/:draftId/review?async=1` `{ options? }` → 202 `{ job, joined }` (iş `TARIFF_IMPORT_REVIEW`); sonuç `GET /jobs/:id` `result` = yapay zekâ içerik incelemesi `{ verdict, summary, issues, detected, identity, model }`. `async` yoksa 400 `ASYNC_REQUIRED`; kurallar [arka-plan-isleri.md](arka-plan-isleri.md) "Tarife incelemesi işi".
- `POST /tariff-imports/:draftId/apply` `{ options, acknowledged, meta? }` → önce mevcut hâli sürüm olarak saklar → `{ tariff, versionId, affectedInvoices, otherInvoices }`. Gövdenin dayandığı hâl uygulama anında okunur; kilit alınana dek değiştiyse 409 `STALE` (araya giren kayıt ezilmez; yeniden uygula güncel hâle göre kurar). Sayılar: aşağıda "Eski faturaları yeni tarifeye geçirme".
- **Onay ve yapay zekâ:** hiçbir yerde otomatik yapay zekâ yok; inceleme (`/review`) yalnız istenince.
  - `apply`: hata varsa 422 `IMPORT_BLOCKED`.
  - `acknowledged` yalnız **kod uyarısı varsa** ya da güncel seçeneklerle yapılmış yapay zekâ incelemesinin sonucu "ok" değilse gerekir (409 `ACK_REQUIRED`); temiz dosya onaysız ve yapay zekâsız uygulanır.
  - Başka seçenekle yapılmış inceleme yok sayılır (`aiStale`).

#### Kg başı bantlar, "İlave" ve aşım satırları
- Excel/CSV okuyucu "71-99", "71–99 kg başı", "1000+" etiketlerini ve "Kg başına ücret …" bölüm başlığını tanır.
- İlave satırı yazımları (core `parseStepRule`): "İlave 0,5 kg", "Her ilave desi", "İlave desi", "her ek kg", "Each additional kg", "+1 desi" (sayısız birim = 1) ve başlangıçlı "30 desi üzeri her desi için", "30 desiden sonra her ilave desi". Sorulan (**hata** `STEP_RULE_UNCLEAR`, `stepConflicts`): başlangıç tablonun son satırı ya da bir basamak sonrası değil; bölgenin başka aşım kuralı var ("Aşım" satırı, "31+" ya da ikinci ilave satırı; aynı tutar ve basamaksa sorun yok); başlangıçsız kural kısa biten bölgede (B 20'de, A 30'da biterken "Her ilave desi").
- "İlave 0,5 kg" satırı iki açık ağırlık arasındaki her adımı (önceki fiyat + k × tutar) kodla üretir; açık satırlar olduğu gibi kalır. Üretilen ara ağırlıklar `SUMMARY` notunda sayılır; sorunlar `STEP_MISMATCH`, `STEP_RULE_UNUSED` uyarılarıdır.
- Son satırdan sonraki "İlave X" satırı (arkasında ağırlık satırı yok) o bölgenin **aşım fiyatı** olur (dosyada "Aşım" satırı varsa o kalır); aşım basamağı X (`overflowStep`). lb→kg çevrilince tutar X lb başına kalır, basamak X lb'nin kg karşılığıdır.
- "Aşım" satırının etiketindeki birim de basamaktır (core `overflowUnitStep`): "kg başı", "her (ilave) kg", "desi başı", "per kg", "/kg" → 1; "her ilave 0,5 kg" → 0,5.
  - Birim yoksa mevcut tarifenin son basamağı kullanılır ve `OVERFLOW_UNIT_MISSING` uyarısı verilir (0,5 kg basamakta kg başı tutar iki kat sayılırdı).
  - Şablonun "Aşım (her ek birim)" etiketi bilerek "tarifenin basamağı başına"dır, uyarı vermez. Şablon, üstte tek basamak varsa etiketi birimle yazar ("Aşım (kg başı)", "Aşım (her ilave 0,5 kg)").
- Fiyat sırası/karşılaştırma kontrolleri kg başı fiyatları sabit fiyatlarla kıyaslamaz.
- Dosyada aşım satırı yoksa mevcut aşım korunur (`OVERFLOW_KEPT`; değişirse `OVERFLOW_CHANGED`).
- Para birimi değişince dosyadan gelmeyen FIXED/PER_KG ek ücretler ve aşım için `SURCHARGES_OTHER_CURRENCY`.
- Kg başı açık bant ("1000+") tüm ağırlıkları kapsıyorsa eski aşım fiyatları kaldırılır.

#### Ağırlık yuvarlama tablodan
- Her içe aktarmada (PDF/Excel/CSV) `weightSteps` fiyat tablosundan yeniden çıkarılır (core `weightStepsFromRates` / `importWeightSteps`):
  - Açık satırların aralığı basamaktır (0,5'er 70,5 kg'a kadar → `{upto:70.5, step:0.5}`; aralık değişince yeni bant; 1 kg'dan büyük aralıklar 1 kg).
  - Son açık satırın üstü (kg başı bantlar) 1 kg; kg başı bant yok ama aşım fiyatı varsa üst basamak mevcut tarifeden.
  - Aralıklar düzgün basamağa (≥ 0,1 kg) oturmuyorsa ya da < 2 açık ağırlık varsa mevcut basamaklar korunur.
  - Değişirse `SUMMARY` notu: "Ağırlık yuvarlama tablodan alındı: 70,5 kg'a kadar 0,5 kg, üstü 1 kg".
- **lb → kg çevrilince** (`convertLbToKg`) mevcut kg basamağı korunmaz; basamaklar lb basamağıdır, kg karşılığıyla (`{upto:null, step:0.45359237}` = her 1 lb). lb satırlarından çıkarılır: 0,5 lb aralıklı satırlarda 0,5 lb.
  - Hesap motoru lb basamağını tanır (core `lbStepKg`): olağan lb basamağının kg değerine 0,5 g'dan yakın adım, düzenleyicinin yuvarladığı 0,454 dahil; kg basamakları hiçbirine yakın değil.
  - Ağırlık lb katına yukarı yuvarlanır (`roundUpToStep`; 3 haneli kg'ın lb sınırını en çok 0,5 g kaçırması payıyla): 0,88 kg = 1,94 lb → 2 lb satırı.
  - Aşım tutarı dosyadaki gibi X lb başına kalır, birim lb basamağı (`overflowUnits`, 1 g payla): 6,536 kg = 14,41 lb → 15 lb → 10 lb fiyatı + 5 × lb başı.
  - "Her ilave 1,5 lb / 0,75 lb" birimi de lb sayılır: içe aktarmanın yazdığı tam değerle (0,680388555 · 0,340194278) her zaman; 3 haneye yuvarlanmış hâliyle (0,68 · 0,34; düzenleyici) yalnız tarifede lb kanıtı varsa (başka bandın adımı lb basamağı ya da önceki bandın üstü / son satır tam veya yarım lb'nin kg'ı). Kanıtsız 0,68 · 0,34 kg basamağıdır. Örnek: 10 lb satırından sonra her ilave 1,5 lb, 5,5 kg = 12,13 lb → 13 lb → 2 birim.
  - Dosyada aşım yoksa ve mevcut aşım kalıyorsa son satırın üstü mevcut basamaklarla (fiyat eski birim başına).
  - lb satırlarından düzgün basamak çıkmazsa son satıra kadar yuvarlama yok (0,001 kg).
  - Mevcut basamak varsa ve değişiyorsa `LB_WEIGHT_STEPS` uyarısı ("her 0,5 kg → her 0,454 kg"), yoksa `SUMMARY` notu.
- Geri alma: içe aktarma öncesi sürüm.

#### Sayı biçimi (Excel/CSV)
- Fiyat tablosunun metin hücreleri dosyanın sayı biçimiyle okunur (core `tableNumberFormat`; kural tarife PDF'indekiyle aynı, aşağıda "PDF tarife"):
  - Yalnız ağırlık ve fiyat hücreleri kanıttır.
  - İki ayırıcılı sayı güçlü kanıt; tek ayırıcı + 1–2 / 4+ hane ya da "0.500" zayıf kanıt; tek ayırıcı + tam 3 hane kanıt değil.
  - Tek yönde güçlü ve karşı kanıt yok → kesin. Güçlü yok, tek yönde ≥ 3 zayıf → seçilir, kesin değil. Diğer → varsayılan okuma (`parseTrNumber`).
- XLSX'in gerçek sayı hücreleri (`RawTariffFile.pricesNumeric`, taslakta '0'/'1' dizgisi) biçimden bağımsız okunur (`numericCellValue`) ve kanıt sayılmaz.
- Biçim belirsizken iki türlü okunan sayı ("1,250", "1.500") **hata** `NUMBER_FORMAT_UNCLEAR` (varsayılan okuma kalır, iki okuma gösterilir).
- Biçim zayıf kanıtla seçildiyse varsayılan okumadan farklı okunan sayılar da **hata** `NUMBER_FORMAT_ASSUMED`; toplu onayla geçilmez (noktalı ağırlıklı Türkçe dosya "0.5" kg ile İngilizce seçtirir, "1.250" TL fiyatı 1,25 okunurdu).
- İkisinde de düzeltme seçeneği `numberFormat: 'tr'|'en'` (seçilince tespit yapılmaz; `CONVERSIONS` notu).
- PDF taslağının hücreleri kodla yazıldığı için tespit yapılmaz.
- Ağırlık sütunundaki "1.500" bu kuralın içindedir: biçim belirsizken `NUMBER_FORMAT_UNCLEAR` ile durur, ayrı soru yoktur. Tarife PDF'inde biçim kesin değilken "1.500" gibi ağırlık etiketi okunan değerle uyarılır (`PDF_WEIGHT_FORMAT_UNCLEAR`, uyarı; onaysız uygulanmaz).

#### İndirim oranı ve işaretsiz açık uçlu satır
- **İndirim oranı:** "%38", "38", "38,5" ve Excel yüzde biçimli hücre (0,38 → %38, 0,005 → %0,5; `pricesPercent`) okunur.
  - Biçimsiz 0–1 arası değer iki türlü okunur (eski şablonlar oranı ham yazar: 0,5 = %0,5; Excel'de yüzde girişi 0,5 = %50): **hata** `DISCOUNT_UNCLEAR`, düzeltme seçeneği `discountUnit: 'percent'|'ratio'`.
  - Şablon indirimi oran ve `0.00%` biçimiyle yazar (gidiş-dönüş aynı).
- **İşaretsiz açık uçlu satır** ("31+", "30 desi üzeri", "30+ desi", "> 30", "31-∞", "31 ve üstü"; "kg başı" yazmıyor), fiyatı önceki sabit satırın dörtte birinden azsa (core `openBandReading`, `readOpenBand`):
  - **Her ilave birim** okunur: bölgenin aşım fiyatı, basamak 1 (30 desi 195, "31+ | 8" → 35 desi = 195 + 5 × 8 = 235). Uyarı `OPEN_BAND_ADDITIONAL` iki okumayı örnekle gösterir.
  - Satır alınmaz, **hata** `OPEN_BAND_UNCLEAR` (neden `why`): başlangıç tablonun son satırına uymuyor ("50+" ama tablo 30'da bitiyor; "30 üzeri" ve "31+" uyar; `start`), bölgenin başka aşım kuralı ya da arkasında fiyat satırı var (`conflict`), ilave fiyatı bölgenin son iki satırının birim artışının yarısından az (30 desi 195, 20 desi 160 iken "31+ | 1"; `price`).
  - Fiyat önceki satırın %25–%100'ü arasındaysa (30 desi 195, "31+ | 180") sabit okunmaz, sorulur (`cheaper`; her yazımda). Önceki satırdan pahalı açık uç sabit fiyattır.
  - Aynı bölgede aynı tutar ve basamakla iki kural ("Her ilave desi | 8" ve "31+ | 8", sıra fark etmez) tek kuraldır.
  - Düzeltme seçeneği `openBandMode: 'additional'|'perKg'|'flat'` (iki kodu da çözer; seçimden sonra da sunulur). `perKg`: fiyat × toplam ağırlık (eski okuma, son kg başı bant); `flat`: tablonun üstünde her koli bu fiyat.
  - Diğer durumlarda sabit fiyat. PDF yolu: yurt içi listede açık uç ve "her desi" ilave satırıdır, uluslararası listede "kg başı" yazılır.
- **Okunamayan açık uç:** açık uç ya da ilave satırına benzeyen, fiyatı olan ama okunamayan etiket ("30 desi sonrası beher") tahmin edilmez: uyarı `OPEN_BAND_UNREADABLE` (onay ister; `SKIPPED_ROWS`'a girmez).

#### PDF tarife: yükleme ve tarama
- `POST /tariffs/:id/import` (ya da `POST /tariff-imports` `file + carrierId` → yeni tarife) `.pdf` ile → **tarama yok, yapay zekâ yok**: metin katmanı saklanır (`TariffDocument`, 7 gün) → `{ kind:'pdf', documentId, fileName, pages, textLayer, target, suggestedDefaults? }`.
- `GET /tariff-documents/:documentId` → yükleme yanıtı + `lastScan`.
- Tarama tuşla: `POST /tariff-documents/:documentId/scan` `{ mode:'code'|'ai' }` → `{ mode, document:{carrier,validFrom,currency,weightUnit,dimDivisor,fuel,notes,surchargeNotes,countryZonePages}, sections[], suggestedSectionIds, hasCountryZones, message }`.
- `ai`: yapay zekâ keşfi (bölüm kimlikleri `s1…`; anahtar yoksa 503 `AI_DISABLED`). Yalnız `?async=1` ile (§5.13), sonuç `GET /jobs/:jobId` `result`.
- `code`: yapay zekâsız; pdfjs konumlu metinden (core `scanPdfLayout`) satır/sütun kurulur; ağırlık başlığı + ≥2 bölge sütunu olan tablolar okunur. Bölüm kimlikleri `c1…`.
  - **Tek fiyat sütunlu yurt içi listeler** ("Desi | Ücret", "Desi/Kg | Fiyat (TL)", "KG/Desi | Ücret"; KDV hariç/dahil iki sütunda hariç olan) tek bölgeli (`TR`, `direction:'domestic'`) bölüm olur.
    - "Dosya"/"Zarf" satırı atlanır ve bölüm notu olarak içe aktarma notlarına (`PDF_NOTES`) düşer.
    - Son satırın altındaki "30 desi üzeri her desi" / "+" satırı "İlave 1" (aşım) olur.
    - Başlık "Desi" ise ve belgede bölen yazmıyorsa `dimDivisor` 3000 (ağırlık sütunu desi = ücretlenecek kg).
    - Çıkarmada hedef tarifenin `*` bölgesi varsa fiyatlar o adla yazılır; tarifede hiç eşleme yoksa `* → TR` eklenir.
  - **Mesafe sütunlu yurt içi listeler** ("Desi | Şehir içi | Yakın | Orta | Uzak", "Kısa/Orta/Uzun Mesafe", "Mahalli / Bölge içi …"; büyük harfli "DESİ" de) çok bölgeli yurt içi bölüm olur.
    - Bölge adları kısa kod (core `distanceZoneCode`): SEHIRICI, YAKIN, ORTA, UZAK, KISA, UZUN, MAHALLI, BOLGEICI, COKUZAK, SEHIRLERARASI, ILICI, ILDISI, UZUNHAT, km kademeleri "0-200KM", "1000KM+". Excel başlıkları da aynı koda çevrilir.
    - Bölge varış ülkesinden / `*` ile bulunduğu ve faturada il/mesafe bilgisi kullanılmadığı için **otomatik eşleme yapılmaz**: bölüm notu + `DISTANCE_ZONES` uyarısı (eşleme yoksa `NO_COUNTRY_MAPPING` yerine). `*` hangi mesafeye bağlıysa tüm yurt içi gönderiler o fiyatla karşılaştırılır.
  - Ayrıca bulunur: "İlave X kg", "kg başına" bantları; DHL tipi "From | To" ilave ücret tablosu (açık satırlar arası "İlave"; son satırın üstünü kapsayan bant, ör. "150 lb üstü her ilave lb", son satırdan sonra "İlave" → aşım fiyatı); para birimi satırı; bölüm başlığı (hizmet, net/liste, ihracat/ithalat); ülke → bölge listesi (çok sütun, çok satırlı adlar → `countryNameToIso2`); geçerlilik / yakıt (FIXED %) / DIM.
  - Bulamazsa `sections: []` + mesaj: "Bu PDF'teki tablolar otomatik okunamadı. Yapay zekâ ile taramayı deneyin." / metinsizse "PDF taranmış görüntü; yalnızca yapay zekâ ile okunabilir."
- **Zarf / Pak / mektup tabloları hiç sunulmaz** (koli desisi ölçülür).
- **Önerilen bölümler** kodla (`suggestPdfSectionChoice`); yanıtta `suggestionSource`:
  - önce son faturaların hizmetleri (`invoices` → "Faturanıza uygun");
  - taşıyıcının hizmet adı yazan faturası yoksa hedef tarifenin hizmeti (`tariff` → "Tarifenizle aynı hizmet");
  - hiçbiri eşleşmezse ilk koli tablosu (`default` → "Önerilen").
  - Web'de önerilen bölümler listede önce gelir.
  - Bölüm hizmeti eşleştirilir (Intl = International, ®, büyük/küçük harf; tam eşleşen hizmet üst kümesinden önce: "FedEx Intl Priority" → IP, IPE değil); net > liste, ihracat > ithalat; aynı hizmetin tüm bölge grupları (Dünya + Avrupa).

#### PDF tarife: çıkarma
- `POST /tariff-documents/:documentId/extract` `{ sectionIds, includeCountryZones, target: {tariffId} | {newTariff:{name,service}}, pricing? }` → normal taslak. Yalnız `?async=1` ile (§5.13): 202 `{ job, joined }`, sonuç `GET /jobs/:jobId` `result`; `async` yoksa 400 `ASYNC_REQUIRED`.
- Kod bölümleri belirlenimci (yapay zekâ yok; `verification.method:'code'`, hepsi eşleşmiş).
- Yapay zekâ bölümleri yapay zekâyla okunup metin katmanıyla doğrulanır (`method:'ai'`; eşleşmeyen > 0 uyarı, > %2 hata `PDF_VALUES_UNVERIFIED`).
- **Sayı biçimi** yalnız alınan tabloların fiyat hücrelerinden (sayfa metni, saat, madde no, desi sütunu kanıt değil):
  - iki ayırıcılı sayı güçlü kanıt ("1.234,56" Türkçe, "1,234.56" İngilizce; tek yönde ve karşı kanıt yoksa biçim kesin);
  - tek ayırıcı + 1–2 hane zayıf kanıt (tek yönde en az 3 hücre: biçim seçilir ama kesin değil);
  - tek ayırıcı + 3 hane ("1.250", "1,125") kanıt değil; aksi hâlde varsayılan okuma.
  - Biçim kesin değilse iki türlü okunan ya da varsayılan okumadan sapan her fiyat `PDF_NUMBER_FORMAT_UNCLEAR` uyarısında adı ve okunan değeriyle geçer.
  - Doğrulama biçimden bağımsız: hücrenin basılı hâli sayfada birebir ya da değer olarak bulunur (iki türlü okunan sayının iki okuması da).
- **Yer denetimi** (yapay zekâ bölümlerinin ağırlık ve kg başı satırları, en az 2 hücre): bütün hücreleri sayfada bulunan satır, metin katmanının satırlarında (pdfjs satır sonu) aranır.
  - Hücreler bir satırda sırayla geçiyor ve o satırda kendi etiketi (ağırlık, bant sınırı; her okuma) yoksa ama tablonun başka bir satırının etiketi (etikete benzer sayı: en çok 4 hane, en çok 2 ondalık) varsa satır kaymıştır.
  - Hücrelerin hepsi kendi etiketli satırında var ama başka sıradaysa sütun karışmıştır.
  - İkisinde de satırın bütün hücreleri `verification.unmatched` listesine (sayfada bulunamayanlardan sonra) girer, `matched` düşer, ayrı **uyarı** `PDF_VALUES_MISPLACED` (hata değil: alışılmadık yerleşimde yanlış alarm kaydı kilitlemesin; onayla kaydedilir).
  - Denetlenemeyen satır (sütun sütun çizilmiş tablo, ağırlıklar sütunda, satıra bölünmüş hücre, etiketsiz satır, tek hücreli satır, "İlave" satırı) yalnız sayfada bulunma denetiminden geçer. Ülke → bölge listesi metinle denetlenmez.
- Ülkeler kod taramasındaki listeden (yoksa yapay zekâ bölümleriyle birlikte) alınır.
- PDF'ten gelen net fiyat → indirim %0, sabit yakıt %, DIM böleni uygulamada **otomatik** yazılır (`PDF_SETTINGS` bilgisi; `suggestedMeta`'da tekrar edilmez); geçerlilik `suggestedMeta.validFrom` önerisidir.
- Sütunu bozuk ("#REF!") bölge: ona ülke atanmışsa uyarı (`PDF_COLUMN_DROPPED`), değilse bilgi. Tanınmayan ülke adları ve seçilmeyen bölgelerdeki ülkeler bilgi (`PDF_NOTES`).

#### PDF: liste fiyatı × indirim tablosu
- FedEx Türkiye sözleşmelerinde net sayfalar (s. 3–14) yalnız müzakere amaçlıdır; kesin hesap (s. 2) liste fiyatı (s. 17–28) × (1 − İhracat/İthalat İndirimi yüzdesi, s. 15/16).
- Kod taraması (`scanPdfLayout`) `discountTables: [{ id:'d1…', direction, service, title, pages, zones, rows:[{ label, packaging:'envelope'|'pak'|null, min, max, pcts, cells, page }] }]` döner:
  - "indirim|discount" geçen sayfada bölge başlıkları satırı ("(KG)" ayrı satırda olabilir) + satırlar "IP 3.00 5.00 67.00% … #REF!" (hizmet kısaltması ya da adı).
  - "Letter"/"Pak" satırları ambalaj olarak ayrılır. Bant iki sayı; tek sayı + "+" açık bant; sayısız = tüm ağırlıklar.
  - Yüzde nokta/virgül, işaret önde/arkada; başlıkta %/yüzde yoksa işaretsiz sayı yüzde sayılmaz; "#REF!"/"#N/A"/boş → null; hücreler x konumuyla sütuna.
  - Yön sayfa başlığından; araya giren "İthalat İndirimi" satırı sonrakileri ithalat yapar.
- Core `pdfDiscount`:
  - `findDiscountTable`: aynı hizmet (kısaltma ya da tam ad) ve yön.
  - `applyListDiscount`: önce "İlave X" satırları liste fiyatında ara ağırlıklara açılır (liste(10,5) + k × ilave, faturadaki liste tutarıyla aynı); sonra her ağırlık kendi bandının yüzdesiyle: ağırlık satırı kendisi, son satırdan sonraki "İlave" son + X, kg başı bant alt sınırı; bantlar arası boşlukta alttaki bant. `round2`: kuruşa yarım yukarı, tam sayı aritmetiğiyle. İndirimi olmayan hücreye ("#REF!" ya da "indirim yok") sayı yazılmaz; liste fiyatı net diye alınmaz.
  - `linkListDiscounts`: liste bölümü → kendisi; net bölüm → aynı hizmet/yön/ambalaj/bölgelerdeki liste bölümü + net sayfayla hücre farkı `diff:{compared,differing,maxDiff}` (fark ara ağırlıklarda yuvarlanmış net ilave tutarından doğar).
- Tarama yanıtında her bölümde `listDiscount:{listSectionId,discountTableId,listPages,discountPages,diff}|null`, `discountTables` özeti (`bands` = koli bant sayısı) ve `suggestedPricing` ('listDiscount' önerilen bölümlerin hepsi hesaplanabiliyorsa; `suggestPdfSectionChoice` → `pricing`).
- Çıkarma gövdesi `pricing:'table'|'listDiscount'` (varsayılan 'table'): listDiscount'ta seçilen her kod bölümü liste karşılığı × indirimle hesaplanmış **net** bölüme çevrilir (başlık "… · liste × indirim", tarife modeli değişmez, indirim %0); karşılığı olmayan, tablodaki fiyatla kalır (bilgi).
- Notlar: `PDF_LIST_DISCOUNT` bilgisi (yöntem, sayfalar, bant sayısı, net sayfayla fark, indirimsiz bölge); kısmen indirimsiz hücreler `PDF_DISCOUNT_MISSING` uyarısı; tamamen indirimsiz sütun (ör. X "#REF!") `PDF_COLUMN_DROPPED` / bilgi kuralıyla düşer.
- Yapay zekâ taramasında (tablo yok) seçenek sunulmaz.
- Web: seçilen tablolardan birinin karşılığı varsa "Fiyatlar nasıl alınsın?": "Liste fiyatı × indirim tablosu" (önerilen) / "Net fiyat tablosu" + iki yolun kaç fiyatta farklı olduğu.

#### Taslak özeti ve notlar
- Her taslakta önce özet: `headline: { status:'ok'|'warning'|'error', title, lines[≤3] }`; ayrıntı `checks`'te.
  - ok: "Dosya uygun" + "9 bölge, 0,5–70,5 kg, 70,5 kg üstü kg başı fiyat · 223 ülke eşlemesi · USD"
  - warning: "N konuya bakın" + ilk iki uyarı
  - error: "Bu haliyle yüklenemez" + ilk hatalar
- Bilgi notları en çok birkaç satır:
  - `SUMMARY`: okunanlar, "İlave" ile üretilen ara ağırlıklar, kg başı bantlar, bölge adı sadeleştirme, atlanan açıklama/paket satırları, CSV notu.
  - `CONVERSIONS`: lb→kg, para birimi değişimi.
  - `CURRENCY_VS_INVOICES`: "Faturalarınız TRY; karşılaştırmada TCMB kuruyla çevrilir."
  - PDF'te `PDF_SETTINGS`, `PDF_NOTES`.
- `SKIPPED_ROWS` yalnız ağırlığı okunamayan fiyat satırları için uyarıdır.

#### Yeni tarife hedefi
- Taslakta `tariffId` boş (ya da `data.newTariff`); kontroller karşılaştırmasız.
- `apply`'da `meta.name` zorunlu (extract'ta ad boş olabilir); `meta` ayrıca `currency, divisor, edgeRounding, discountPct, fuelPct, fuelVariable`.
- Para birimi = seçenek ?? algılanan ?? TRY. Bölen = meta ?? PDF DIM ?? kaynak tarife ?? kapsam. Yakıt = meta ?? kaynak tarife ?? kapsam.
  - Kapsam (core `carrierScope`): aras, yurtici, mng, ptt yurt içi (3000, sabit yakıt); fedex, ups, dhl yurt dışı (5000, değişken). "Diğer" (generic) adında bilinen yurt dışı taşıyıcı (TNT, GLS, DPD, Aramex, "yurt dışı" …) varsa yurt dışı, değilse yurt içi (Sürat, HepsiJet, Kolay Gelsin, Sendeo, Trendyol Express).
  - Önizleme `suggestedDefaults: { currency, divisor, edgeRounding, discountPct, fuelPct, fuelVariable, name, service }`; PDF yüklemesinde `{ currency, divisor }`. Yalnız yeni tarifeye; kayıtlı tarife değişmez.
- **Bölge eşlemesi yoksa `*`:** yalnız yeni tarifede ve taşıyıcının kapsamı yurt içiyse (`TariffImportContext.newTariff`, `domestic`), Bölgeler sayfası boş ve fiyat tablosu tek bölgeliyse `* → o bölge` kendiliğinden yazılır; yurt dışında ("Weight | Zone A") ve kayıtlı tarifeye içe aktarmada `NO_COUNTRY_MAPPING` uyarısı kalır (core `effectiveZones`, `autoStarZone`); bilgi `ZONE_STAR_AUTO`. Çok bölgede tahmin yok (`NO_COUNTRY_MAPPING` ya da `DISTANCE_ZONES`).
- Taşıyıcının başka aktif tarifesi yoksa varsayılan olur; yanıtta `versionId: null`.

#### Sürümler (geri alma)
- `GET /tariffs/:id/versions`, `POST /tariffs/:id/versions/:versionId/restore` (geri yüklemeden önce de sürüm alınır).
- Her içe aktarma, `PUT /tariffs/:id`, ülke istisnası ve geri yükleme öncesi tarifenin tam hâli `TariffVersion` olarak saklanır (tarife başına son 50). İçe aktarma, `PUT` ve geri yüklemede bu hâl değişiklikle aynı işlemde, kilit altında okunur (eşzamanlı iki kayıtta ara hâl de kalır).
- Fatura hesabının dayandığı fiyat sürümü (`TariffRevision`) bundan ayrıdır (§3.14).
- Geri yükleme etiketindeki saat ("… tarihli sürüm geri yüklendi") firmanın saat diliminde yazılır (`settings.timeZone`; kayıtta an durur, yalnız gösterim).
- Panel de tarih-saati, "bu ay"ı ve Pano ay listesini firmanın saat diliminde gösterir; yalnız gün olan alanlar (fatura tarihi, gönderim günü) kaymaz, itiraz süreleri sabit Türkiye günüyle kalır (Platform `ARCHITECTURE.md` "Firma dili ve saat dilimi").

#### Eski faturaları yeni tarifeye geçirme
- `POST /tariffs/:id/recompare-invoices/preview` `{}` → `POST /settings/recompare-invoices/preview` ile aynı biçim (§5.3); yazmaz.
- `POST /tariffs/:id/recompare-invoices` `{ token }` → `{ invoices, lines, skipped: { inDispute, stale }, staleInvoices?, remaining?, stopped }` (`staleInvoices` yalnız `stale` > 0 iken, `remaining` yalnız > 0 iken).
  - Dayanak değiştiyse ya da önizleme bilinmiyorsa `PREVIEW_STALE`; önizlemeden sonra değişen fatura atlanıp listelenir (§3.14).
- İkisi de yalnız `?async=1` ile arka plan işi (§5.13).
- Yalnız tarife sürümü güncellenir, faturanın toleransı kalır; kapsam §3.14.
- `PUT`, içe aktarma ve geri yükleme yanıtındaki sayılar:
  - `affectedInvoices`: toplu önizlemenin kapsamı (aynı kural, `tariffSaveCounts`): bu tarifeye düşen ama bugünkü sürümünde olmayan faturalar; etkin itirazdaki dahil (önizleme onu atlar ve sayar).
  - `otherInvoices`: taşıyıcının başka tarifeye düşen faturaları.
  - "Bu tarifeye düşen": faturada seçili, seçim yoksa taşıyıcının varsayılanı buysa.
