# Kod haritası — Hesap motoru

Yollar depo köküne göredir.

## Hesap motoru

Kök `Deciship/packages/core` (saf TypeScript, veritabanı yok). Giriş `src/index.ts` her modülü dışa aktarır. Alt yollar: `@deciship/core/calc`, `/barem`, `/format`, `/measure`, `/i18n` (mobil yalnız bunları kullanır; kök içe aktarma exceljs getirir).

| Dosya | Ne işe yarar |
|---|---|
| `Deciship/packages/core/src/packaging.ts` | Taşıyıcı ambalajı (OWN/PAK/ENVELOPE): taşıyıcı başına sınırlar (`DEFAULT_PACKAGING_LIMITS`, `packagingLimitsFor`), uygunluk (`packagingFit`, `suggestPackaging`), adlar (`packagingLabel`), faturadan tanıma (`parsePackaging`, `servicePackaging`); karşılaştırmadaki kural `compare.ts` (`PACKAGING` farkı, `PACKAGING_*` İncele kodları). Test `test/packaging.test.ts`. |
| `Deciship/packages/core/src/compare.ts` | Satır karşılaştırması: `compareLine` (durum MATCH/DIFF/UNMATCHED/NO_TARIFF, fark türleri, güven HIGH/LOW, `ReviewCode`, döküm), `localizeComparison`, `billedChargeableKg`. |
| `compare.ts` `invoiceHasMixedServices` | Faturanın satırlarında farklı hizmet sınıfı var mı (pak/zarf ve sınıfsız adlar sayılmaz); API `compareAll` ve tarife uyumu faturanın tüm satırlarından bir kez hesaplar. |
| `compare.ts` `CompareLineInput.mixedServices` | Karışık hizmet bayrağı; tarifenin hizmeti boş ya da tanınmıyorsa farkı olan satır "İncele". `tariffHealth({ mixedServices })` aynı bayrakla ülke istisnası önermez. |
| `ReviewCode` `MULTI_PARCEL` | "İncele" nedeni (KALANLAR 1.8): `CompareLineInput.repeatedInFile` (her fark) ya da `remeasured` (ağırlık/ölçü farkı); `compareLineTr` adım 11'in ilki. Mükerrer kolunda `repeatedInFile` / `duplicatePrior.sameDescription: false` gerekçeleri. Test `test/cokKoli.test.ts`. |
| `ReviewCode` `SERVICE_UNKNOWN` | "İncele" nedeni: karışık hizmetli fatura + hizmeti belirsiz tarife (`compareLineTr` adım 11, SERVICE'ten hemen sonra); etiket web `common.json` `reviewCode.SERVICE_UNKNOWN`. |
| `ReviewCode` `FUEL_UNKNOWN` | "İncele" nedeni: değişken yakıtlı tarife, faturada yakıt ayrı yok, fark türünde PRICE (aç/kapa `VARIABLE_FUEL_WITHOUT_COLUMN_IS_REVIEW`); FUEL_RATE'ten sonra, FX_STALE'den önce. |
| `Deciship/packages/core/src/tariff.ts` | `TariffInput` tipi, `expectedCharge` (beklenen taşıma bedeli), bölge çözümü, ek ücret tutarı, ülke istisnası; `distanceZoneCount` (mesafe bölgeli tarife → fiyat farkı `ZONE_DISTANCE` "İncele"). |
| `Deciship/packages/core/src/carrierScope.ts` | Yeni tarifenin kapsamı (`carrierScope`: yurt içi 3000 + sabit yakıt, yurt dışı 5000 + değişken; "Diğer" taşıyıcı adla), `scopeDivisor`, `scopeFuelVariable`. API (`services/tariffs.ts`, `tariffImport.ts`, `routes/tariffs.ts`) ve panel (`tariff-editor/draft.ts`) kullanır. |
| `Deciship/packages/core/src/calc.ts` | Desi, ücretli kg, basamağa yuvarlama, kuruş toplamı (`sumMoney`, `toCents`). İçe aktarma eklenmez (mobil kullanır). |
| `Deciship/packages/core/src/surcharges.ts` | Ek ücret kodu normalleştirme ve eş anlamlılar (`canonicalSurchargeCode`). |
| `Deciship/packages/core/src/service.ts` | Hizmet adı uyuşmazlığı ("karışık hizmet" → İncele). |
| `Deciship/packages/core/src/fx.ts` | Kur çevrimi, kur toleransı, kur kaynağı metni (kurun kendisi API'de alınır). |
| `Deciship/packages/core/src/tracking.ts` | Takip no normalleştirme, FedEx 34 haneli barkod, en iyi eşleşme. |
| `Deciship/packages/core/src/tariffImport.ts` | Tarife içe aktarma: ham tablo → fiyat tablosu + kod kontrolleri (`checkTariffImport`). |
| `Deciship/packages/core/src/pdfScan.ts`, `pdfDiscount.ts` | Yapay zekâsız PDF tarife taraması; liste fiyatı × indirim tablosu. |
| `Deciship/packages/core/src/weightSteps.ts` | Ağırlık basamaklarını fiyat tablosundan çıkarma ve anlatma. |
| `Deciship/packages/core/src/tariffHealth.ts` | Tarife uyumu raporu (SPEC §3.9), ülke istisnası önerisi. |
| `Deciship/packages/core/src/disputes.ts` | İtiraz takibinin saf hesabı: talep kuralı, tur/fatura toplamları, TTK süresi. |
| `Deciship/packages/core/src/dispute.ts` | İtiraz metni (`buildDisputeText`), satır kanıtı (`DisputeLine.evidence`, ad yok), `photoCount`. |
| `Deciship/packages/core/src/invoiceHints.ts`, `invoiceSummary.ts` | İtiraz süreleri, WhatsApp metni, tarife şüphesi; özet toplamları ve cümlesi; "Nasıl hesaplandı?" dökümü (`overchargeReconciliation`). |
| `Deciship/packages/core/src/countries.ts`, `countryNames.ts` | Ülke adı → ISO-2, takma adlar (UK→GB, EL→GR). |
| `Deciship/packages/core/src/i18n/` | `messages.tr.ts` (anahtarların kaynağı, `MessageKey`), `messages.en.ts` (aynı anahtarlar; tip zorlar), `index.ts` (`t`, `localizeText`: kayıtlı Türkçe metni gösterirken çevirir; `VERBATIM_PARAMS` çevrilmeyen yer tutucular). |

Fatura okuma, `Deciship/packages/core/src/invoice/`:

- `read.ts`: biçim, ayırıcı, başlık satırı; `ReadLimits` ile sınır kodları `XLSX_TOO_LARGE`, `TOO_MANY_ROWS`, `PDF_TOO_MANY_PAGES`.
- `parse.ts`: `parseRows`, sayı/tarih/ülke/KDV; `skipped` ve kodlu `errors`.
- `mapping.ts` (`suggestMapping`), `presets.ts` (taşıyıcı kalıpları, başlık eş anlamlıları), `types.ts` (`ParsedInvoiceLine`, `ColumnMapping`, `MAPPING_FIELDS`).
- `verify.ts`: okuma kontrolü, satır bayrakları (`PDF_*` bayrakları); Excel'in sayıya çevirdiği uzun takip no `excelNumberTrackingRows` (5.19).
- `trackingFormat.ts`: takip no temizliği ve biçimi (`stripScanNoise`, `checkTracking`, taşıyıcı biçim tablosu); mobil okutma ve API ölçüm girdisi kullanır, eşleme yine `normalizeTracking`.
- `vat.ts`: KDV dahil toplamı veriyle sınama (`vatEvidence`, `checkMappingVat`; KALANLAR 1.3). Okunmayan Excel sayfaları `Table.sheets` + `mapping.ts` `unreadSheetsOf` (1.6); bilimsel yazımlı takip no `verify.ts` `scientificTrackingRows` (1.13); sayı biçimi kanıtı `parse.ts` `resolveNumberFormat` (1.4).
- `importReport.ts`: `buildImportReport` (faturaya alınmayan satırlar).
- `pdfCheck.ts`: `checkPdfLines` (PDF satırlarını metinle denetleme; `PdfCheckMethod` `text`/`none`/`skipped`).
- `zipGuard.ts`: Excel açılmadan önce zip yapısı ve açılmış boyut (`countJsZipInflated`, okuyucunun JSZip'iyle).
- `diagnostics.ts` (eşleme tanısı, `guessInvoiceMeta`), `merge.ts` (yapay zekâ eşlemesini birleştirme), `meta.ts`, `values.ts`, `charges.ts`, `sha256.ts` (`rawHash`).

Biçimleme ve ağırlıkta "1.500" belirsizliği (`format.ts`, `pastedNumbers.ts`, `measureInput.ts`):

- Biçimleme ve sayı okuma (`parseTrNumber`), yapıştırılan sayı, ölçü girişi sınırları.
- Ağırlıkta "1.500" sorulur (koli ölçümünde 1,5 kg; tarife ve faturada sorulur; İngilizce "1,500" de; dil değişince yazılı sayılar korunur): `measureInput.ts` `ambiguousWeightText`.
- Kullananlar: web `lib/weightChoice.ts` + `components/WeightChoice.tsx` (tarife düzenleyici, PDF fatura adımı); fatura dosyası `invoice/parse.ts` `tableWeightAmbiguity` + eşlemenin `weightFormat`ı (yalnız ağırlık; kayıtlı eşlemeye yazılmaz: API `lib/mappingSchema.ts` `savedMappingOf`); PDF fatura `invoice/pdfCheck.ts` `weightAmbiguity` + API içe aktarma `pdfWeightConfirmed` (409 `PDF_WEIGHT_CHOICE_REQUIRED` / `WEIGHT_FORMAT_REQUIRED`); tarife PDF'i API `services/tariffPdf.ts`.
- Testler: core `measureNumber`, `weightAmbiguity`, `pdfCheckFields`, `webPasteBlock`, web `pdf-row-parse`, API `weightAmbiguityImport` (veritabanlı).

Sık yapılan işler:

| İş | Bakılacak dosyalar | Koşulacak testler (`Deciship/packages/core/test/`) |
|---|---|---|
| Yeni karşılaştırma kuralı / fark türü | `src/compare.ts` (`compareLineTr`), gerekirse `src/tariff.ts`; yeni not metni `src/i18n/messages.tr.ts` + `.en.ts`; yeni `DiffType`/`ReviewCode` için API `services/compare.ts` + web `src/api/types.ts` + web `common.json` etiketleri | `compare`, `pricing`, `edgeCases`, `mesaj3`, `localeInvariance`, `samples`, `i18nTrBaseline`, `i18nEn` |
| Kesin fark / "İncele" sınırı (karışık hizmet, basamak sınırı, ek ücret + fiyat, yakıt ayrı yok) | `src/compare.ts` (`compareLineTr` adım 5, 7, 9, 11), `src/service.ts` (kısaltmalar) | `kesinFark` (`test/kesinFark.test.ts`: B1, B3, B10, B2), `compare`, `samples`, `i18nTrBaseline` |
| Tarife hesabında değişiklik | `src/tariff.ts`, `src/calc.ts`, `src/weightSteps.ts` | `tariff`, `calc`, `edgeCases`, `domesticDistance`, `weightSteps`, `samples` |
| Fatura okuma/eşleme | `src/invoice/*.ts` (başlık eş anlamlısı `presets.ts`) | `invoice`, `invoice-robustness`, `verify`, `currencyColumn`, `dateOrder`, `vatComponents`, `fedex-fbo`, `invoiceMetaGuess`, `reviewFixes`, `mesaj5`, `mesaj5Ek`, `pdfCheckLarge` (süresi `pdfCheck.perf`), `numericCells` (XLSX sayı hücresi işareti `Table.numeric`, `isNumericCell`; tarife sayfası `numeric`/`percent`), `numericInvoiceCells` (sayı hücresi biçimden bağımsız), `mixedCurrency` (`CURRENCY_MISMATCH`), `faturaOkuma` (KALANLAR 1.3–1.6, 1.13; API `faturaOkumaImport`) |
| Alınmayan satır raporu, PDF metin denetimi, fazla ödeme dökümü | `src/invoice/importReport.ts`, `src/invoice/pdfCheck.ts`, `src/invoice/parse.ts` (`skipped`, kodlu `errors`), `src/invoiceSummary.ts` | `mesaj5`, `mesaj5Ek`, `pdfCheckLarge` (süresi `pdfCheck.perf`), `pdfCheckFields` (ağırlık/ölçü/ek ücret metinde, satır penceresinde KDV, `checkPdfTotals`, `pdfLineEdits`), `invoice`, `verify` |
| Tarife içe aktarma / PDF tarama | `src/tariffImport.ts` (açık uç `openBandReading`, ilave kuralı `parseStepRule`, `*` kendiliğinden `effectiveZones`), `src/pdfScan.ts`, `src/pdfDiscount.ts` | `tariffImport`, `tariffImportNumbers` (sayı biçimi, indirim oranı, işaretsiz açık uç, lb basamağı), `tarifeGercekVeri` (kapsam, `*`, açık uç ve ilave yazımları, mesafe bölgesi), `pdfScan`, `domesticPdf`, `pdfDiscount`, `tariffPdfModel`, `weightSteps` |
| İtiraz hesabı/metni | `src/disputes.ts`, `src/dispute.ts` | `disputes`, `dispute`, `mesaj5`, `i18nTrBaseline`, `i18nEn` |
| Yeni ileti metni | `src/i18n/messages.tr.ts` + `messages.en.ts` (aynı anahtar, aynı yer tutucular `{ad}`, `{n|tekil|çoğul}`) | `i18n`, `i18nTrBaseline`, `i18nEn` |
| Dosya boyut/satır sınırı, zip denetimi | `src/invoice/zipGuard.ts`, `src/invoice/read.ts` (`ReadLimits`); API yüzü `apps/api/src/lib/fileWorkers.ts` | `zipGuard`, `invoice`, `invoice-robustness` |
| Biçimleme (`format.ts`) değişikliği | "Önce" kaydı: `test/formatGolden.test.ts` + `test/__golden__/formatGolden.core.txt`; bilinçsiz fark testi kırar | `formatGolden` |
