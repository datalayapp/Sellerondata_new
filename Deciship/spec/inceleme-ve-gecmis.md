# DeciShip SPEC — İncele ve geçmiş sonuçlar (§3.13–§3.14)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

### 3.13 Emin olunmayan farklar: "İncele"

Kararlar `Platform/docs/KARARLAR.md` "DeciShip ürün kararları" başlığında. Bu bölüm önceki bölümlerle çelişirse bu bölüm geçerlidir.

#### Sınıf, rozet, süzgeç
- **Sınıf:** `confidence = LOW` satırın ekrandaki adı "İncele" (EN "Review"). Tutarı "Fazla ödeme"ye girmez (`estimatedOverchargeTotal`).
- Gerekçenin sınıfı `reviewCode`: `MULTI_PARCEL`, `SERVICE`, `SERVICE_UNKNOWN`, `SERVICE_MISSING`, `DUPLICATE`, `TARIFF_ONLY`, `ZONE_DISTANCE`, `EXTREME_RATE`, `EXTREME_WEIGHT`, `FUEL_RATE`, `FUEL_UNKNOWN`, `FUEL_SURCHARGE`, `FX_STALE`. Satırın `pricing` JSON'unda saklanır; satır yanıtında yalnız LOW satırda bulunur, tutar taşımaz.
- Gerekçelerin önceliği (ilk tutan): MULTI_PARCEL → SERVICE → SERVICE_UNKNOWN → SERVICE_MISSING → TARIFF_ONLY → EXTREME_RATE → EXTREME_WEIGHT → FUEL_RATE → FUEL_UNKNOWN → FUEL_SURCHARGE → FX_STALE; `ZONE_DISTANCE` en sonda (yalnız kesin ya da EXTREME_RATE satırında).
- **Mesafe bölgeli tarife** (fiyat satırlarında ≥ 2 mesafe bölgesi, core `distanceZoneCount`; "Şehir içi", "Yakın", "Uzak", km kademesi): bölge yalnız varış ülkesinden ya da `*`'dan bulunur. `*` ya da bir mesafe bölgesiyle fiyatlanan kesin (ya da EXTREME_RATE) fark satırı tarifenin her mesafe bölgesiyle yeniden hesaplanır (core `compareLine`; ülkesi ayrı bölgeye bağlı gönderi, ör. DE → EU1, denenmez); talep **en küçük farktır** (gönderi hangi bölgede olursa olsun en az bu kadar fazla ödenmiş).
  - En küçük fark sıfırdan büyükse o bölgenin sonucu kalır (tutar, tür, döküm, güven), not "fark, en az farkı veren "{bölge}" bölgesine göre". Örnek: 5 desi ölçülmüş, Uzak 10 desi 130 kesilmiş → ağırlık farkı 41 (Uzak 5 desi 89), 60 değil; fatura en pahalı bölgenin de üstündeyse aradaki kısım kesin.
  - Bir bölgede fark yoksa (ya da hesaplanamıyorsa) satır `ZONE_DISTANCE` "İncele" olur, tutarlar `*` bölgesinden; EXTREME_RATE satırı kendi gerekçesiyle kalır. Uyumlu satır işaretlenmez.
- **Rozet ve süzgeç:** `confidence = LOW` olan her satırda, durumu "Uyumlu" olsa da, listede "İncele" rozeti çıkar. `GET /invoices/:id/lines?review=true` yalnız bu satırları verir (`pricing`'i olmayan eski satır kesin sayılır). Web süzgeci "İncele işaretli".

#### Ölçüm payı ve tolerans
- **Ölçüm payı:** ölçümün her kenarına `edgeTolCm` eklenerek ücretli kg yeniden hesaplanır.
  - Faturadaki ücretli kg bu değeri (+ `weightTolKg`) aşmıyorsa ağırlık/ölçü farkı sayılmaz. Beklenen taşıyıcının ağırlığında hesaplanır (o ağırlıkta fiyat farkı varsa `PRICE` yine çıkar); nota "Ağırlık farkı ölçüm toleransı içinde (±1 cm)…" yazılır.
  - Sınır, faturadaki kg'ın tarife basamağına yuvarlanmış hâliyle karşılaştırılır.
  - `edgeTolCm = 0` payı kapatır; üst sınır 10 cm.
- **Parasız fark:** ağırlık/ölçü farkı olan ama `diff <= tolerans` kalan satır `MATCH` olur, not: "Ağırlık farklı yazılmış, tutara etkisi yok". Eşik sabit tutar toleransıdır (kur toleransı kullanılmaz). Ek ücret farkı varsa satır fark olarak kalır.
- **Tutar toleransı:** `amountTol` firmanın para birimindedir.
  - Satır başka para birimindeyse fatura gününün kuruyla çevrilir (`amountTolIn`, `apps/api/src/services/compare.ts`). Kur yoksa sabit yedek oran yoktur: saklı en yakın önceki günün kuru, o da yoksa satır "Kur alınamadı/bulunamadı" (§3.10).
  - Varsayılan para birimine göredir (`lib/settings.ts` `defaultAmountTol`): TRY 5, USD/EUR/GBP 0,5, başka para birimi 5. Kayıtlı tolerans yoksa para biriminin varsayılanı okunur.
  - Merkez'den para birimi değişince tolerans eski para biriminin varsayılanındaysa yenisine geçer, elle girilmiş değer kalır (`applyOrgCurrency`). Göç yok.
  - Donmuş faturanın `compareSettings`'inde eksik alan bilerek sabit 5 okunur.

#### Mükerrer ve çakışan fatura
- **Mükerrer:** takip no aynı dosyada üstte ya da daha önceki bir faturada varsa satır `DUPLICATE` olur. Önceki faturada aynı taşıyıcı ve aynı tutar ise kesin; tutar farklıysa ya da başka taşıyıcının faturasındaysa "İncele" (gerekçede önceki fatura no ve tutar). Çekirdek girdisi: `compareLine({ isDuplicate, duplicatePrior })`.
  - Aynı tutarlı önceki görünümün açıklaması farklıysa "İncele" (`duplicatePrior.sameDescription: false`, gerekçe `compare.confidence.duplicateDescription`). Açıklama = hizmet adı (boşluk, büyük/küçük harf ve I/ı farkı yok sayılır) + sıralı ek ücret kodları (API `lineDescription`). Yalnız iki tarafta da yazılı kısım karşılaştırılır (`sameLineDescription`): bir tarafta hizmet boşsa hizmet, bir tarafta ek ücret kodu yoksa ek ücretler yok sayılır. Aynı tutarlı görünümlerden biri aynı açıklamalıysa kesin.
  - Aynı dosyadaki görünüm (aynı tutar da olsa) kesin değildir: koli başına ayrı satır ya da ayrı ücret satırı olabilir (gerekçe `compare.confidence.duplicateFile`; tutar farklıysa bugünkü `duplicateAmountFile`).
- **Çok koli şüphesi** (KALANLAR 1.8; çok kolinin gerçek modeli 5.2, faturadaki parça sayısı okunmuyor). Fark kesin sayılmaz, `reviewCode = 'MULTI_PARCEL'`; uyumlu satır işaretlenmez; tutarlar değişmez:
  - takip no bu dosyada birden çok ücret satırında (artı tutarlı; bu dosyanın iadesiyle iptal edilenler düşülür): her fark türü (`compareLine({ repeatedInFile })`, gerekçe `compare.confidence.multiParcelFile`); bu satırların mükerreri de "İncele";
  - eşleşen ölçümün zincirinde birden çok ölçüm anı var (telefonda "Yeniden ölç" yeni sürüm açar, birinciyi ezer; kuyrukta geç kalan eski ölçüm eski sürüm olarak girer, §5.4): yalnız `WEIGHT`/`DIMENSION` farkı (`compareLine({ remeasured })`, API `remeasuredMeasurements`, gerekçe `compare.confidence.multiParcelMeasured`). Düzeltme (`PATCH`) ölçüm anını korur, tek ölçüm sayılır; yönetici ölçüm anını değiştirirse sayılır. Elle eşlenen ölçüm de.
- **Birebir aynı satır:** atlanmaz, içeri alınır.
  - Dosyadaki gönderilerin en az yarısı başka canlı fatura(lar)da varsa `POST /invoices` `409 INVOICE_OVERLAP` döner. Pay birleşiktir: gönderiler iki eski faturaya yayılmışsa (%30 + %30) da sayılır.
  - `details.overlap` = `{ total, matched (birleşik, tekrarsız), invoiceId, invoiceNo (en çok çakışan), otherInvoices?: { invoiceId, invoiceNo, matched }[] }` (en çok 10 fatura).
  - Önizleme uyarısı ve içe aktarma aynı işlevi (`trackingOverlap`) kullanır; istemci onaydan sonra `confirmOverlap: true` ile yeniden gönderir.
  - Denetim içe aktarma kilidi altında yinelenir; bu arada aynı takip numaralarıyla başka fatura yazıldıysa yeni fatura hemen yeniden karşılaştırılır.

#### Yakıt
- `Tariff.fuelVariable`. `true` (değişken) ve fatura yakıtı ayrı yazıyorsa beklenen yakıt faturadaki oranla hesaplanır: oran = yakıt / (net − yakıt − ek ücretler). Oran 0–60 dışındaysa tarife oranı kullanılır. Döküm etiketi "Yakıt %27,5 (faturadaki oran; tarifede %25)"; tarife uyumu kartı oranı not eder.
- `false` (sözleşmede sabit): yüksek oran `PRICE`.
- Yeni tarifede varsayılan: `aras`, `yurtici`, `mng` için sabit (`DOMESTIC_CARRIERS`), diğer taşıyıcılarda değişken. Göç `20261110180000` FORCE RLS altında firma bağlamı olmadan çalıştığı için var olan hiçbir tarifeyi değiştirmedi; o tarihten önceki (demo) tarifeler sabit kaldı ve KARARLAR gereği öyle bırakıldı.
- **Makul olmayan oran** (core `implausibleInvoiceFuel`): değişken yakıtlı tarifede faturadaki oran kabul edilmiyorsa (> %60 ya da net − yakıt − ek ücretler ≤ 0) beklenen tarife oranıyla hesaplanır.
  - Fark türlerinde `PRICE`, `WEIGHT` ya da `DIMENSION` varsa satır "İncele" olur (`reviewCode = 'FUEL_RATE'`, gerekçe: sütun yanlış eşlenmiş ya da yakıt liste fiyatından hesaplanmış olabilir).
  - Yalnız `SURCHARGE` farkı olan satır kesin kalır (taşıma kısmı da pahalıysa `PRICE` eklenir ve kural uygulanır, §3.4 adım 8).
  - Bilinen sınır: %60 eşiğinde sıçrama var.
- **Yakıt ayrı yazılmamış** (KARARLAR): değişken yakıtlı tarifede faturada yakıt sütunu yoksa (yakıt navlunun içinde) beklenen tarifedeki oranla kurulur.
  - Fark türlerinde `PRICE` varsa satır "İncele" olur (`reviewCode = 'FUEL_UNKNOWN'`, gerekçe: fark güncel yakıt oranından olabilir). Ağırlık/ölçü/ek ücret farkı kesin kalır; sabit yakıtlı tarifede kural yoktur.
  - Tek yerde: core `VARIABLE_FUEL_WITHOUT_COLUMN_IS_REVIEW` (geri almak için `false`).
  - Aynı satırda kesin ek ücret farkı ile bu kural birlikte varsa satırın tamamı "İncele" olur.
- **Yakıt ek ücrete de uygulanmış** (KARARLAR; core `fuelOnSurcharges`, core adım 9b):
  - Koşul: sabit yakıtlı tarife (`fuelVariable` kapalı), fatura yakıtı ayrı yazıyor (split) ve yakıt, tarifedeki oranın taşıma bedeline uygulanmış hâli değil ama taşıma + faturadaki ek ücretlerin bir alt kümesine uygulanmış hâli. En çok 8 ek ücretin alt kümeleri denenir, daha çoksa yalnız tümü; pay (kalem sayısı + 2) kuruş.
  - Fark türlerinde `PRICE`, `WEIGHT` ya da `DIMENSION` varsa yalnız fazla yakıt (= faturadaki yakıt − oran × taşıma) belirsizdir.
  - Fark − fazla yakıt ≤ tolerans ise (fark yalnız fazla yakıt) tutarlar değişmez, satır "İncele" olur (`reviewCode = 'FUEL_SURCHARGE'`, gerekçede tarife oranı ve fazla yakıt).
  - Fark daha büyükse fazla yakıt Beklenen'e faturadaki tutarıyla eklenir: dökümde kendi kalemi "Ek ücretlere uygulanan yakıt"; "tarifede olmayan ek ücretler" toplamına (`uncheckedSurchargeTotal`) girmez; not `compare.fuelOnSurcharges`. Kalan fark kesin kalır.
  - Fatura dayanağında ölçeklenen yakıt, faturadaki yakıt − fazla yakıttan hesaplanır (fazla yakıt iki kez sayılmaz). Yalnız ek ücret farkı olan satırda "Fiyat farkı" yalnız fazla yakıttan doğuyorsa kalkar.
  - Değişken yakıttaki kural (kesin ek ücret farkı + belirsiz yakıt → satırın tamamı "İncele") ayrıdır, değişmez.
  - Yüksek yakıt oranı (oran × taşıma + ek ücret alt kümesiyle de tutmayan) kesin fiyat farkı kalır; değişken yakıtta faturadaki oran zaten kabul edilir.
  - Örnek 1: ölçüm 6,0 kg, fatura 9,5 kg, taşıma 1.316,00 + tarifede olmayan ücret 100,00 + yakıt %25 × 1.416 = 354,00 → net 1.770,00; Beklenen 1.284,00 + fazla yakıt 25,00 = 1.309,00, kesin ağırlık farkı 461,00.
  - Örnek 2: taşıma 947,20 + ek elleçleme 285, yakıt %25 × 1.232,20 = 308,05 → beklenen 1.469,00, fark +71,25 "İncele".

#### Hizmet
- **Karışık hizmet:** `serviceMismatch(line.service, tariff.service)` (`packages/core/src/service.ts`) iki adın hizmet sınıfı sözcüklerini (priority, economy, express, saver…) karşılaştırır.
  - İkisinde de sınıf sözcüğü var ve kümeler farklıysa satır "İncele" olur ("…bu hizmet için tarife ekleyin"); tarife uyumu grubunda öneri verilmez. Adlardan biri boşsa ya da sınıf sözcüğü taşımıyorsa hüküm verilmez.
  - Taşıyıcı kısaltmaları da sınıf sayılır: FedEx `IP`/`IE` (Priority/Economy), `IPF`/`IEF` (… Freight), DHL `WPX`/`DOX` (Express).
- **Hizmeti belirsiz tarife:** faturanın satırlarında farklı hizmet sınıfları varsa (`invoiceHasMixedServices`, pak/zarf sayılmaz; API faturanın tüm satırlarından bir kez hesaplar, `compareLine({ mixedServices })`) ve tarifenin hizmeti boşsa ya da sınıf sözcüğü taşımıyorsa:
  - farkı olan her satır "İncele" olur (`reviewCode = 'SERVICE_UNKNOWN'`, gerekçe: "tarifeye hizmet adını yazın");
  - uyumlu satır işaretlenmez; tek hizmetli faturada kural yoktur;
  - tarife uyumu raporu bu durumda ülke istisnası önermez (`tariffHealth({ mixedServices })`, mesaj `health.serviceUnknown`).
- **Satırın hizmeti boş** (kullanıcı kararı): tarifenin hizmeti sınıf sözcüğü taşıyorsa (`serviceClassWords(tariff.service)` boş değil: "IE", "International Economy", "Standart") ve satırın hizmeti boşsa (yok ya da yalnız boşluk):
  - farkı olan her satır (her fark türü) "İncele" olur (`reviewCode = 'SERVICE_MISSING'`, gerekçe: tarifenin hizmeti bu gönderiye uygulanıyor mu bilinmiyor); tek hizmetli faturada da geçerlidir;
  - faturanın hiçbir satırında hizmet adı yoksa (hizmet sütunu yok; yurt içi tablolarında olağan) kural uygulanmaz (`compareLine({ invoiceLacksServices })`, API faturanın tüm satırlarından bir kez hesaplar). Gerekçe: satırın boş hizmeti bir şey söylemez; kural olsa "Standart" tarifeli yurt içi faturanın bütün desi farkları "İncele" olurdu;
  - uyumlu satır işaretlenmez; tarifenin hizmeti boşsa ya da sınıf sözcüğü taşımıyorsa kural yok; satırın hizmeti yazılı ama sınıf sözcüğü taşımıyorsa ("FedEx") kural yok.

#### Diğer
- **Bileşen KDV'si:** "Tutarlar KDV dahil" seçiliyken navlun/yakıt/ek ücret sütunlarının KDV kararı `parseRows(...).componentsVat` ve `diagnostics.componentsVat` ile döner (`source`: `mapping | header | data | default | none`); eşleme ekranı gösterir ve değiştirmeye izin verir. PDF yolu aynı veri kuralını kullanır (`componentsVatFromData`); veride kanıt yoksa bileşenler de KDV dahil sayılır (PDF'te kararı değiştirecek eşleme ekranı yoktur).
- **Gösterilen desi:** ölçüm ekranlarındaki desi firmanın böleni ve yukarı yuvarlanmış kenarlarla hesaplanır; fatura karşılaştırması tarifenin bölenini ve kenar yuvarlama kuralını kullanır. Bölen ya da yuvarlama farklıysa iki sayı farklı olabilir; fatura satırında karşılaştırmanın kendi değeri (`ourChargeableKg`) gösterilir.
- Gerçek fatura görülmeden yapılmayacaklar: satır başına otomatik tarife, aynı gönderinin ayrı satırlarını birleştirme.

### 3.14 Geçmiş sonuçlar: tarife sürümü ve dondurma

Kararlar `Platform/docs/KARARLAR.md` "Geçmiş sonuçlar donar" maddesinde. Bu bölüm önceki bölümlerle çelişirse bu bölüm geçerlidir. İtirazla ilgili kilitler: `itiraz.md` "Gönderilmiş itirazda hesap kilidi".

- Kod: `apps/api/src/services/compare.ts` (motor), `services/tariffs.ts` (sürüm), `services/bulkRecalc.ts` (toplu geçiş).
- Testler: `test/frozenResults.test.ts`, `tariffRevisions.test.ts`, `recalculate.test.ts`, `bulkRecalc.test.ts`, `frozenBackfill.test.ts`.

**Tarife sürümü**
- `TariffRevision`: tarifenin fiyat içeriğinin değişmez anlık görüntüsü (`snapshot`, `tariffBody` biçimi). Hesap canlı tablolardan değil sürümden kurulur (`snapshotToTariffInput` → `PricingTariff`); iki yol aynı `TariffInput`'u verir (eşdeğerlik testi). Tarifenin güncel sürümü `Tariff.currentRevisionId`.
- `ensureTariffRevision(tx, tariffId, companyId)` tarife yazan her yolda aynı işlemde çalışır: oluşturma (`POST /tariffs`, kopya, içe aktarmayla yeni tarife, örnek veri), `PUT /tariffs/:id`, içe aktarma uygulama, sürüm geri yükleme, ülke istisnası. Tarife satırını `FOR UPDATE` ile kilitler; içerik özeti (`contentHash`, `tariffContentHash`) güncel sürümünkiyle aynıysa yeni sürüm açmaz.
- Özete girenler: taşıyıcı ve fiyatı etkileyenler (para birimi, bölen, kenar yuvarlama, ağırlık basamakları, indirim, yakıt oranı, `fuelVariable`, hizmet, bölgeler, fiyatlar, aşım, ek ücretlerin kodu, türü ve tutarı, ülke istisnalarının ülke ve yüzdesi).
- Girmeyenler (hesap kullanmaz): ad, etkinlik, varsayılan, geçerlilik tarihleri, ek ücretin adı, istisnanın notu ve kaynağı. Bunlar değişince yeni sürüm doğmaz, faturada "Tarife değişti" çıkmaz.
- Satırdaki "tarife bu tarihte geçerli değil" notu tarihleri, tarife duruyorsa canlı tarifeden, silindiyse sürümdeki tarihten okur (`loadPricingTariff`); not bir sonraki yeniden karşılaştırmada yeni tarihle yazılır, rakam değişmez.
- Sürüm bir taşıyıcının fiyatıdır: tarife başka taşıyıcıya taşınınca yeni sürüm doğar, eski sürüm (`snapshot.carrierId` eski taşıyıcı) eski taşıyıcının faturalarında kalır. Sürümün taşıyıcısı `snapshot.carrierId`'den okunur (`revisionOfCarrier`; alan yoksa tarifenin bugünkü taşıyıcısı).
- Sürüm güncellenmez, silinmez (yalnız firmayla birlikte). İki etiket istisnası: `contentHash` boşsa (göçte doldurulan sürüm) ya da başka kuralla yazılmışsa (özete giren alanlar değişti), ilk `ensureTariffRevision` sürümün kendi anlık görüntüsünü bugünkü kuralla özetler; içerik aynıysa yeni sürüm açmaz, yalnız `contentHash`'i yazar. Tarife yeniden adlandırılınca güncel sürümün `tariffName`'i güncellenir.
- Tarife silme gerçek silmedir. Sürümler durur, yalnız `tariffId`leri boşalır (FK `ON DELETE SET NULL ("tariffId")`); sürümü gösteren fatura ve satır aynı rakamda kalır, ad sürümden okunur.
- `TariffVersion` (§5.7 "Sürümler") ayrı bir şeydir: geri alma için değişiklikten önceki hâl, tarife başına son 50, tarifeyle silinir. Hesap ona bakmaz.

**Faturanın dayanağı**
- Dayanak iki parçadır: tarife sürümü (`Invoice.tariffRevisionId`) ve ayar (`Invoice.compareSettings`).
- `compareSettings` hesaplandığı günkü firma ayarıdır: `{ edgeTolCm, weightTolKg, amountTol, fxTolerancePct, unknownSurchargesAsDiff, companyCurrency }` (`compareSettingsOf`). `desiDivisor`, `requiredBoxPhotos`, `timeZone` hesaba girmez, dayanakta yoktur.
- Her yol ya bir parçayı ya hiçbirini günceller; öbür parça faturada olduğu gibi kalır.
- Satır kayıtlı sonucunun sürümünü taşır (`InvoiceLine.tariffRevisionId`; tarifesiz sonuçta null).
- İçe aktarma (`POST /invoices`, örnek fatura, demo tohumu `seedDemoDisputes.ts`) güncel dayanağı çözer (`resolveCurrentBasis`: §3.12 tarifesinin bugünkü sürümü + bugünkü ayar) ve faturaya, satırlara yazar. Taşıyıcının etkin tarifesi yoksa fatura **dayanaksızdır** (`tariffRevisionId` null).
- Göç `20261111120000_frozen_results` var olan veriyi aynı kuralla doldurdu: her tarifeye o günkü hâlinden bir sürüm, her faturaya o anki tarifesinin sürümü (`invoiceTariff` kuralının SQL karşılığı) ve firmanın o anki ayarı, her satıra kendi tarifesinin sürümü (`NO_TARIFF` hariç).

**Dayanak kipi ve kapsam**
- Kipler:
  - `pinned`: faturanın kayıtlı sürümü ve ayarı.
  - `tariff`: tarife parçası bugünküne geçer (§3.12 kuralıyla bulunan tarifenin bugünkü sürümü), ayar faturadaki kalır.
  - `rules`: ayar parçası bugünküne geçer, tarife sürümü faturadaki kalır.
  - Uygulanınca güncellenen parça faturaya yazılır.
- `tariff`'te tarife bulunamazsa (silinmiş, varsayılan yok) sürüm, faturanın taşıyıcısına aitse korunur; değilse dayanak boşalır, satırlar `NO_TARIFF` olur (başka taşıyıcının fiyatı kullanılmaz).
- Kapsam: `open`: yalnız donmamış satırlar yazılır. `all`: karar verilmiş satırlar da yazılır. Etkin itiraz turundaki satır hiçbir kipte yazılmaz.
- `recompareInvoice(id, { basis, scope, forceLineIds?, lineIds?, cause })`, varsayılan `pinned` + `open`. Tek motor: `computeRecompare` (yazmaz) → `applyRecompare` (fatura kilidi altında yazar).
  - `forceLineIds`: kullanıcının düzelttiği satır kararlı olsa da yazılır.
  - `lineIds`: yalnız bu satırlar yazılır, diğerlerine dokunulmaz.
- `lineIds` ve `patch` (başlık değişikliği) yalnız `pinned` ile: uç `tariff` / `rules` ile birleşimi `400 VALIDATION` ile reddeder. Satır seçimli hesap faturanın dayanağını değiştirmez (dayanaksız faturada tarife de benimsenmez).
- **Dayanaksız fatura:** kullanıcının başlattığı `pinned` hesap (`all` + satır seçimi yok) ve önizlemesiz `POST /invoices/:id/recompare` yalnız tarife parçasını benimser; otomatik tetikleyici benimsemez, satırlar tarifesiz kalır.
  - Etkin itiraz turu olan faturada benimseme yapılmaz: hesap faturanın kendi (tarifesiz) dayanağıyla yapılır; itiraz önizlemeden sonra gönderildiyse onay `409 PREVIEW_STALE` olur.
- `compareSettings`'i boş fatura (dayanak yazmayan eski bir yolla açılmış) her kipte bugünkü ayarla hesaplanır ve ona bağlanır (fark sayılmaz); tarife sürümü de boşsa ilk hesapta tarife parçasını da benimser.

**Donmuş satır**
- Donmuş = kararı `OPEN` olmayan (Doğrulandı, Uyumlu sayıldı) ya da etkin itiraz turunda `DisputeLine`'ı olan satır. Küme fatura kilidi altında, yazmadan hemen önce yeniden okunur (itiraz gönderimi ve kararla yarışmaz).
- Yazılmayan donmuş satırın para sonucu (durum, fark türleri, beklenen, fark ya da eşleşen ölçüm) kayıtlıdan farklı çıkarsa `recalcPending` (neden) ve `recalcPendingAt` işaretlenir; sonuç yeniden aynı çıkarsa işaret silinir.
  - Aynı ölçümün düzeltme zincirindeki yeni sürümü rakamı değiştirmiyorsa fark sayılmaz.
  - Var olan işaret korunur; yalnız `MEASUREMENT` başka bir nedenin üstüne yazar.
- Yazılan satırda işaret silinir, `tariffRevisionId` hesabın sürümü olur. Karar durumu (`decision`, gerekçe, karar veren) hiçbir hesap yolunda değişmez.
- `prevResult` (bir adım geri): yazılan satırın rakamı (durum, fark türleri, beklenen, fark) değiştiyse ve eski sonucu varsa (beklenen dolu ya da durum Fark var / Uyumlu) eski hâl yazılır: `{ status, diffTypes, expectedAmount, diffAmount, ourChargeableKg, measurementId, tariffRevisionId, at, cause }`. Yalnız not, döküm ya da ölçüm sürümü değiştiyse önceki kayıt olduğu gibi kalır.
- Neden (`cause`, `prevResult.cause`): `MEASUREMENT`, `DUPLICATE`, `TRACKING`, `MATCH`, `TARIFF`, `RULES`, `OTHER`. `recalcPending` işareti yalnız üç sınıftır: `MEASUREMENT`, `DUPLICATE`, `OTHER` (`pendingCauseOf`; öbür nedenler `OTHER` yazılır, web bilinmeyen değeri de "Yeniden hesap bekliyor" gösterir).

**Satır düzeltmesi ve not** (`PATCH /invoice-lines/:id`)
- Takip no düzeltmesi ve elle eşleştirme (ya da eşleştirmenin kaldırılması) kullanıcının o satırda bilerek yaptığı değişikliktir:
  - düzeltilen satır kararı verilmiş olsa da aynı istekte yeni sonuçla yazılır (`forceLineIds`; karar değişmez, eski rakam `prevResult`'ta, neden `TRACKING` / `MATCH`);
  - faturanın öbür satırları sabit dayanak + `open` ile hesaplanır: kararlı olanlar yazılmaz, sonucu değişen işaretlenir;
  - etkin itirazdaki satırda bu iki düzeltme `409 LINE_IN_DISPUTE`.
- Not yazmak ya da silmek hiçbir satırın para sonucunu değiştirmez; hesap yapılmaz. Elle not silinince, satır sabit dayanakla yazmadan hesaplanır; sonuç kayıtlıyla aynı çıkarsa karşılaştırma notu geri gelir (`restoreComparisonNote`). Farklıysa (satır eski ölçümde, kurda ya da mükerrer durumunda) not boş kalır, rakam ve işaret olduğu gibi kalır.
- Kararı `OPEN`'a dönen ve `recalcPending` taşıyan satır aynı istekte, yalnız o satır, güncel ölçüm ve faturanın sabit dayanağıyla hesaplanır (`pinned` + `lineIds`): eski rakam `prevResult`'a (neden işaretin nedeni), işaret silinir, toplam güncellenir. İşaretsiz satırın kararını geri almak hesap yapmaz. Etkin itirazdaki satırın kararı değişmez (`409 LINE_IN_DISPUTE`).

**Yollar**

| Yol | Dayanak / kapsam | Neden |
|---|---|---|
| Ölçüm kaydı, düzeltme, silme, geri yükleme, bakım işi (`recompareForTracking`) | pinned / open | `MEASUREMENT` |
| Mükerrer zinciri (`recompareLaterDuplicates`: fatura silme, takip no düzeltme, taşıyıcı/para birimi/fatura no değişimi), içe aktarma yarışı | pinned / open | `DUPLICATE` |
| `PATCH /invoice-lines/:id`: takip no, elle eşleştirme | pinned / open + o satır (`forceLineIds`) | `TRACKING` / `MATCH` |
| `PATCH /invoice-lines/:id`: kararı `OPEN`'a dönen işaretli satır | pinned / yalnız o satır (`lineIds`) | işaretin nedeni |
| `PATCH /invoice-lines/:id`: not yazma / silme, "Kontrol ettim" | hesap yok | — |
| `POST /invoices/:id/recompare` (önizlemesiz; kur yeniden denemesi) | pinned / open; dayanaksız ve itirazsız faturada tariff / open | `OTHER` |
| `POST /invoices/:id/recalculate` `basis: 'pinned'` ("Yeniden karşılaştır") | pinned / all | `OTHER` |
| `recalculate` `basis: 'tariff'` ("Yeni tarifeyle hesapla") | tariff / all | `TARIFF` (sürüm değişmiyorsa `OTHER`) |
| `recalculate` `basis: 'rules'` ("Yeni ayarla hesapla") | rules / all | `RULES` (ayar değişmiyorsa `OTHER`) |
| `recalculate` + `lineIds` (donmuş satırda "Yeni ölçümle hesapla") | pinned / yalnız o satırlar | satırların ortak işaret nedeni, yoksa `OTHER` |
| `PATCH /invoices/:id` taşıyıcı ya da tarife (önizleme `token`'ıyla) | tariff / all | `TARIFF` |
| `PATCH /invoices/:id` tarih ya da para birimi (önizleme `token`'ıyla) | pinned / all | `OTHER` |
| Toplu geçiş: tarife (`/tariffs/:id/recompare-invoices`) | tariff / all | `TARIFF` |
| Toplu geçiş: ayar (`/settings/recompare-invoices`) | rules / all | `RULES` |
| Tarife oluşturma, düzenleme, içe aktarma, geri yükleme, kopyalama, ülke istisnası, "Varsayılan yap", tarife silme, `PATCH /settings` | hesap yok | — |

**Dayanak durumu** (`GET /invoices/:id` → `basis.state`, `invoiceBasisState`), ilk tutan:
- `NONE`: dayanaksız fatura.
- `TARIFF_REMOVED`: sürümün tarifesi silinmiş ya da artık başka taşıyıcının (bu faturanın taşıyıcısı için tarife yok). Ad sürümden, web "Ad (silindi)" gösterir.
- `TARIFF_CHANGED`: tarifenin bugünkü sürümü başka. Ayar da farklıysa yine bu: "Yeni tarifeyle hesapla" yalnız tarife sürümünü günceller, ardından durum `RULES_CHANGED` olur ve "Yeni ayarla hesapla" ayrıca sorulur.
- `RULES_CHANGED`: `compareSettings` bugünkü ayardan farklı (boş `compareSettings` fark sayılmaz).
- `CURRENT`.

**Önizleme ve onay**
- Önizleme hiçbir şey yazmaz; `token` hesaplanan sonuçların, yazma planının, faturanın başlığının ve hedef dayanağın sha256 özetidir. Onay özeti fatura kilidi altında yeniden kurar; tutmazsa (ölçüm, karar, tarife, ayar ya da satır değişti) hiçbir şey yazılmaz, `409 PREVIEW_STALE`.
- `PATCH /invoices/:id` hesabı değiştiren dört alandan (taşıyıcı, tarife, tarih, para birimi) biri değişiyorsa aynı değişikliğin önizlemesinin (`recalculate/preview` `{ basis: 'pinned', patch }`) `token`'ını ister:
  - yoksa `400 VALIDATION` (etkin itiraz varsa önce `409 INVOICE_HAS_DISPUTE`);
  - tutmazsa `409 PREVIEW_STALE` ve hiçbir alan yazılmaz;
  - web önizleme "değişiklik yok" dese de token'ı gönderir; bayat yanıtta önizlemeyi yeniler ve önce/sonra penceresini gösterir.
- Para birimi değişimi (PATCH ve önizlemedeki `patch`): satırlarda kendi para birimi yazılıysa ve yeni para birimiyle çelişiyorsa `409 CURRENCY_CONFLICT` ("2 satırda para birimi USD yazılı; faturanın para birimi TRY yapılamaz…"), hiçbir şey yazılmaz. Satırların para birimi değiştirilmez (dosyada yazanı ezmek geri alınamazdı); para birimi yazılı olmayan satır engel değildir.
- Onaysız yollarda hesap ile kilit arasında fatura ya da satır değiştiyse hesap baştan yapılır (en çok 3 deneme; sonuncusu yine yazar).

**Toplu önizleme ve onay**
- Kapsamdaki her fatura `tariff` (tarife geçişi) ya da `rules` (ayar geçişi) + `all` ile hesaplanır; toplu `token` her faturanın özetini ve atlananları kapsar.
- Fazla ödeme toplamı para birimine göre ayrı döner (`totalsByCurrency`: `[{ currency, invoices, before: { overchargeTotal }, after: { overchargeTotal } }]`, geçecek tüm faturalardan, para birimi sırasıyla); farklı para birimleri toplanmaz.
- Toplu onay önizlemenin kaydettiği planı yeniden hesaplamadan yazar: faturalar sırayla önizlemedeki kendi özetleriyle yazılır.
  - Önizlemeden sonra değişen fatura (ölçüm ya da başlık düzeltmesi, silme) yazılmaz, sayılır (`skipped.stale`) ve listelenir (`staleInvoices`: `{ id, invoiceNo, carrierName, deleted? }`, en çok 200, bu arada silinen `deleted: true`); öbürleri yazılır; yazılmış olanlar geri alınmaz.
  - Önizlemeden sonra kapsama giren fatura bu onayla taşınmaz. İş bütünüyle bitince hâlâ kapsamda kalan, etkin itirazı olmayan fatura sayısı `remaining` olarak döner (> 0 ise; bayat atlananlar, sonradan eklenenler, itirazı kapananlar).
  - Dayanak (tarife sürümü ya da ayar) önizlemeden sonra değiştiyse ya da aynı önizleme daha önce uygulandıysa hiçbir fatura yazılmaz (`409 PREVIEW_STALE`).
  - Önizlemenin planı bulunamazsa (iş kaydı 7 günden eski) plan yeniden kurulur; toplu özet tutmazsa hiçbir fatura yazılmaz (`409 PREVIEW_STALE`).
- Panel: atlanan fatura ya da `remaining` > 0 varsa bitişte pencere açılır (durdurulan işte yalnız atlanan varsa): yazılan sayı, atlananların listesi faturaya bağlantıyla, kapsamda kalan sayı, tek birincil eylem "Yeniden önizle" (aynı kapsamın yeni önizlemesi onları yeniden gösterir).

**Toplu geçiş kapsamı**
- Tarife: bu tarifenin eski sürümüyle hesaplı faturalar; bu tarifeyi seçmiş ama bugünkü sürümünde olmayanlar; dayanaksız olup bu tarifeyle fiyatlanacak olanlar (faturada seçiliyse ya da seçimsiz ve taşıyıcının varsayılanı buysa).
  - Hesaptan sonra yalnız bu tarifenin bugünkü sürümüne geçecekler kalır; başka tarifeye düşecek fatura, faturadaki "Yeni tarifeyle hesapla" ile taşınır.
  - Yalnız tarife sürümü güncellenir; faturanın toleransı aynı kalır.
- Ayar: `compareSettings`'i bugünkü ayardan farklı, silinmemiş, örnek olmayan faturalar (`compareSettings` boş olan sayılmaz). Yalnız ayar güncellenir; tarifesi de değişmiş fatura eski tarife sürümünde kalır, faturada "Tarife değişti" ayrıca sorulur.
- Etkin itiraz turu olan fatura atlanır ve sayılır. `changedInvoices` = yeni dayanağa geçecek fatura (rakamı değişmese de). Liste ilk 200 fatura; sayılar ve para birimi toplamları tam.

**Yetki**
- Tek faturada her kip (`pinned`, `tariff`, `rules`, `lineIds`) `deciship.lines.decide` ister (Yönetici, Denetleyici): bugünkü tarife ya da ayarı bir faturaya uygulamak o faturanın incelemesidir, tarifeyi ya da ayarı değiştirmek değildir.
- Toplu geçişler kaynaklarının iznini ister: tarife `deciship.tariffs.edit`, ayar `deciship.settings.manage`. Tarife toplu geçişi ayara dokunmadığı için ayar yetkisi olmayan kişi tarife yoluyla ayarı uygulatamaz.

**Ek kurallar**
- Ölçüm ekranındaki fatura durumu (`invoiceStatus`, `invoiceLines`) ölçüm zincirinin tüm sürümlerinden okunur: donmuş satır ölçümün eski sürümünde kalır.
- `recompareForTracking`'in "eski ölçüm sürümünde kalan satır" turları yalnız `decision = OPEN` ve `recalcPending IS NULL` satırları sayar.
- `basis.calculatedAt` faturanın son hesap anıdır (`Invoice.calculatedAt`, boşsa `updatedAt`); karar, not ve "Kontrol ettim" onu ilerletmez (§3.15).
- Denetim kaydı: `invoice.recalculate` `{ basis, cause, revisionFrom, revisionTo, totalsBefore, totalsAfter, changedLines, via?, lineIds? }` (`basis`: `pinned` / `tariff` / `rules`; önizlemeli tek fatura, `PATCH /invoices/:id` ve toplu geçişte yazılan her fatura); `tariff.recompare` ve `settings.recompare` `{ invoices, lines, skipped }`.
- Web:
  - özet kartında `basis.state`'e göre bant ("Tarife değişti" / "Ayar değişti" / "Tarife silindi") ve tek birincil eylem "Yeni tarifeyle hesapla" (`basis: 'tariff'`) ya da "Yeni ayarla hesapla" (`basis: 'rules'`);
  - satır tablosunda "yeniden hesap bekleyen" rozeti ve süzgeci; satır panelinde "eski fark şuydu" satırı ve donmuş satırda "Yeni ölçümle hesapla";
  - önce/sonra penceresi tektir: `pages/invoice-detail/RecalcDialog.tsx` (fatura başlığı, düzenleme penceresi, satır paneli, tarife düzenleyici, tarife uyumu ve Ayarlar kullanır). Düzenleme penceresi önizlemeyi `basis: 'pinned'` + `patch` ile alır ve kaydı onun `token`'ıyla yapar;
  - toplu pencerede fazla ödeme para birimi başına bir satırdır.
