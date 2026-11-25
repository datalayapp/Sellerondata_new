# DeciShip SPEC — Veri modeli (§4)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 4. Veri modeli (Prisma, PostgreSQL)

Şema `apps/api/prisma/schema.prisma`, PostgreSQL `deciship` şeması.
- `companyId` taşıyan her tablo satır düzeyinde güvenlikle (RLS) firmaya süzülür.
- Firma tablosu dışındaki yabancı anahtarlar `(x, companyId)` bileşiktir (ARCHITECTURE §4).
- Para `Decimal(14,2)`, ağırlık `Decimal(10,3)`, ölçü `Decimal(8,1)`.

**İçe aktarılan satır saklanacağı hassasiyetle karşılaştırılır** (API `services/lineWrite.ts` `atStoredPrecision`):
- Fatura kenarı 0,1 cm'ye **yukarı** yuvarlanır (13 in = 33,02 cm → 33,1). "Kenar yukarı tam cm" kuralında aynı tam cm'yi verir; yarım-yukarı yuvarlama 33,0 kenarı 34 yerine 33 sayardı.
- kg 3, tutar 2 ondalık, veritabanının yarım-yukarı kuralıyla; bölen tam sayı. Ek ücretler JSON'da olduğu gibi.
- Tablo, PDF ve örnek fatura yolları aynı işlevden geçer. "Yeniden karşılaştır" veritabanındaki aynı sayıyı okur; sonuç kendiliğinden değişmez.

#### Tablolar

- **Company**: id (== Hesap'taki Organization.id), name ve nameVersion (Merkez'den `org.updated` ile gelir, DeciShip yazmaz), settings (Json).
  - `settings`: `{ edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5 (para birimine göre, §3.13), desiDivisor: 3000, requiredBoxPhotos: 1, warnEdgeCm: 150, warnWeightKg: 70, scaleAiRead: false, currency: 'TRY', fxTolerancePct: 1.5, unknownSurchargesAsDiff: false, disputeReminders: true, timeZone, country?, onboarding? }`.
  - `currency`, `country` ve `timeZone` Merkez'den gelir; `PATCH /settings` bunları kabul etmez (400).
- **Company.closedAt / closedVersion** ve **CompanyPurge** (firmayı kapatma, §5.15): kapalılık işareti ve onu yazan olayın sürümü. CompanyPurge kalıcı silinen firmanın yalnız kimliğini ve anlarını (`createdAt`, `completedAt`, son deneme `attemptedAt`) tutar; firmaya ilişkisi yoktur.
- **Member**: Hesap'taki üyeliğin yerel kopyası (id == Membership.id): companyId, personId, name, role (null = DeciShip erişimi yok), permissions, active, epoch, removedAt (`member.removed` yazar, hiç boşalmaz: jetonla eşitleme çıkarılmış kaydı açmaz), lastSeenAt. Hesap olaylarıyla (`member.upserted`, `member.removed`, `org.updated`; `identity.ts`) ve ilk istekte yazılır. Kimlik ve yetki: ARCHITECTURE §4–§5.
  - `permissions` (TEXT[] NULL): rolün firmadaki geçerli izinleri (katalogla kesişmiş); NULL = rolden katalogla türet. Prisma NULL ile boş listeyi ayırmadığı için yalnız ham SQL ile okunur ve yazılır (`lib/access.ts` `loadMemberAccess`, `identity.ts`).
- **ProcessedEvent**: işlenmiş Hesap olayının kimliği (olay tekrarına karşı).
- **BoxPreset**: id, companyId, name (K1), lengthCm, widthCm, heightCm, sortOrder, active. Yeni şirkete varsayılan K1 30×20×15, K2 40×30×25, K3 50×40×30 eklenir.
- **Measurement**: id, companyId, clientId, trackingRaw, trackingNo (normalize), lengthCm, widthCm, heightCm, weightKg, dimMethod `LIDAR|AR|REFERENCE|MANUAL|PRESET`, weightMethod `OCR|MANUAL`, ocrWeightKg?, dimConfidence?, boxPresetId?, measuredById (→ Member), measuredAt (cihaz saati; gönderimde ölçülen cihaz saati farkı düzeltilmiş, §5.4), deviceMeasuredAt? (ham cihaz anı, yalnız düzeltildiyse), arrivedLate (geç gelip zincire eski sürüm olarak girdi), note?, version (1..), supersededById?, deletedAt?.
  - clientId kişi başına benzersizdir: `(companyId, measuredById, clientId)` (idempotency).
  - Düzeltmede eski kayıt silinmez; yeni sürüm yazılır, eskisi `supersededById` ile işaretlenir.
  - Takip no başına tek güncel, silinmemiş sürüm (kısmi tekil dizin `Measurement_current_tracking_key`).
  - recomparePendingAt?: değişiklik kaydedildi, faturalarla yeniden karşılaştırması bitmedi; bitince boşalır, kalırsa tekrar gönderim ya da bakım tamamlar. recompareAttempts: tarama ya da bakımda düşen deneme (geri çekilme 2 dk, 8 dk, 32 dk …; 5 denemeden sonra taramaya girmez, günlükte uyarı); işaret boşalınca ya da yeniden yazılınca 0.
- **File**: id, companyId, kind `PHOTO_BOX|PHOTO_SCALE|PHOTO_LABEL|PHOTO_OTHER|INVOICE_SOURCE`, mime, size, path (STORAGE_DIR altında), sha256, originalName?, measurementId?, invoiceId?, createdById.
  - purgedAt?: silinen faturanın dosyası diskten silindi, satır kalır (§5.13).
  - preview? (Json): yalnız PDF fatura önizlemesi, sunucu üretir: `{ v: 1, pageTexts?, skipped?, method? }`. `pageTexts` (PDF'in ham metni) içe aktarmada fatura yazılınca silinir; öbür alanlar kalır.
  - holders (String[], NOT NULL; boş = yalnız yükleyen): aynı PDF okumasına bağlanan üyelerle paylaşılan önizlemeyi tutanlar (§5.13).
- **Job** (§5.13): id, companyId, kind, status, dedupeKey, refType?/refId?, label?, input (Json), checkpoint? (toplu uygulamanın planı), progressDone, progressTotal?, stage?, counters?, result?, error?, attempts, maxAttempts, releases (kapanışta bırakılma sayısı), runAfter, lockedBy?/lockedUntil?/heartbeatAt? (kira), cancelRequestedAt?, createdById? (→ Member), createdAt, startedAt?, finishedAt?.
  - `(companyId, kind, dedupeKey)` yalnız QUEUED/RUNNING'de tekildir: `Job_active_key`.
  - RLS'li; çalıştırıcı dar `jobs` kapsamıyla yalnız bekleyen ve süren işi görür.
  - `companyId` değiştirilemez (tetikleyici `Job_companyId_immutable`, her kapsamda).
- **Carrier**: id, companyId, code (CarrierCode), name, active, defaultMapping (Json?, son kullanılan sütun eşleme).
- **Tariff**: id, companyId, carrierId, name, service?, currency, divisor, edgeRounding, weightSteps (Json), discountPct, fuelPct, fuelVariable, validFrom?, validTo?, active, isDefault, countryAdjustments (Json, §3.8), currentRevisionId? (→ TariffRevision, güncel fiyat sürümü; §3.14).
- **TariffZone**: tariffId, country (ISO-2 veya `*`), zone.
- **TariffRate**: tariffId, zone, weightUpto, price, perKg · **TariffOverflow**: tariffId, zone, perUnit.
- **TariffSurcharge**: tariffId, code, name, kind `FIXED|PCT|PER_KG`, amount.
- **TariffRevision** (§3.14): id, companyId, tariffId? (tarife silinince boşalır), tariffName, contentHash?, snapshot (Json, `tariffBody` biçimi), currency, createdAt. Fiyat içeriğinin değişmez sürümü; faturanın hesap dayanağı. Güncellenmez, silinmez (yalnız firmayla).
- **TariffImportDraft** (içe aktarma taslağı, 24 sa) · **TariffVersion** (geri alma için değişiklikten önceki hâl, tarife başına son 50; hesap ona bakmaz) · **TariffDocument** (yüklenen tarife PDF'i, 7 gün).
- **Invoice**: id, companyId, carrierId, tariffId? (§3.12), tariffRevisionId? (hesabın dayandığı tarife sürümü; null = dayanaksız), compareSettings (Json?, hesaplandığı günkü firma ayarı; §3.14), invoiceNo, invoiceDate, periodFrom?, periodTo?, currency, sourceFileId, mapping (Json), status `PROCESSED|FAILED`, totals (Json), importReport (Json?, faturaya alınmayan satırlar ve PDF denetimi; §3.15), calculatedAt? (son hesap anı; §3.15), isSample (kurulum örneği), deletedAt?.
  - `totals`: `{lines, match, diff, unmatched, noTariff, billedTotal, comparedBilledTotal, expectedTotal, overchargeTotal, estimatedOverchargeTotal, estimatedLines, verifiedTotal, uncheckedSurchargeTotal, pakUnmatched, pakNoTariff, flaggedLines, fxMissing, pendingLines, reconciliation, overchargeByType, …}`; `pendingLines` = `recalcPending` dolu satır sayısı.
  - Taşıyıcı başına fatura no tekildir: silinmemiş, örnek olmayan faturalarda, büyük/küçük harf ayrımsız (`Invoice_current_no_key`).
- **InvoiceRecheck**: invoiceId (birincil anahtar), companyId, pendingAt, attempts. Faturanın "Mükerrer" yeniden hesabı bekliyor (aynı takip no'yu taşıyan önceki fatura silindi ya da başlığı düzeltildi). Değişikliği yazan işlem satırı yazar; hesap bitince satır yalnız aynı `pendingAt` ile silinir, kalırsa sık tarama ve saatlik bakım tamamlar (`services/measurementQueue.ts`). `attempts` ölçümdeki `recompareAttempts` kuralıyla aynı.
- **InvoiceLine**: id, invoiceId, companyId, rowIndex, trackingNo, shipDate?, service?, destCountry?, actualKg?, billedKg?, dimL/W/H?, billedDivisor?, baseAmount?, discountAmount?, fuelAmount?, surcharges (Json), netAmount, currency?, reference?, rawHash, parseFlags, parseChecked (§11).
  - Eşleme ve sonuç: measurementId?, measurementPinned, originalTrackingNo? (§10.2), tariffId?, tariffRevisionId? (kayıtlı sonucun hesaplandığı sürüm), status, diffTypes (string[]), ourChargeableKg?, billedChargeableKg?, expectedAmount?, diffAmount?, breakdown (Json), pricing (Json?, §3.8).
  - Not ve karar: note?, noteManual, decision `OPEN|VERIFIED|ACCEPTED`, decisionReason?, decidedById?, decidedAt?.
  - prevResult (Json?): sonuç değişmeden önceki hâl, bir adım.
  - recalcPending?: donmuş satırda yazılmamış farklı sonucun nedeni; recalcPendingAt? (§3.14).
- **Dispute**: fatura başına itiraz turu. Faturada tek etkin tur (`Dispute_active_invoice_key`); geri çekilir ya da yerini yeni tura bırakır, silinmez; iyimser kilit `version` → 409 `STALE`.
- **DisputeLine**: gönderim anındaki talep, değişmez; outcome `PENDING|RECOVERED|REJECTED`.
- **DisputeResult**: alacak dekontu ya da ret; geri alınır, silinmez · **DisputeResultLine**: girişin satır payları. Ayrıntı: itiraz.md.
- **AuditLog**: id, companyId, userId (→ Member), action, entity, entityId, data (Json): tarife, fatura, karar, ölçüm, itiraz, ayar olayları.
- **AiUsage** (§5.12): yapay zekâ çağrısı başına bir satır: companyId, memberId? (üye silinince boşalır), kind `SCALE_READ|INVOICE_PDF|INVOICE_MAPPING|TARIFF_PDF_DISCOVER|TARIFF_PDF_EXTRACT|TARIFF_REVIEW`, status `OK|CACHED|FAILED`, errorCode?, period (`YYYY-MM`, firmanın saat diliminde), model, servedModel?, input/output/cacheRead/cacheWrite token sayıları, cost (`Decimal(14,6)`, TL), currency, priceVersion, durationMs, estimated, cacheKey?, refType?/refId?.
  - Silinmez (veri sıfırlama kotayı sıfırlamaz), yalnız firmayla gider; ücret yazılırken o anki fiyat ve kurla hesaplanır, sonradan yeniden fiyatlanmaz.
- **AiCreditEntry** (§5.12): kredi defteri: kind `GRANT|PURCHASE|ADJUST`, amount (TL; ADJUST eksi olabilir), currency, period? (`YYYY-MM` = yalnız o ay; null = devreden bakiye), note?, operator?, externalRef? (`(companyId, externalRef)` tekil). Bugün yalnız GRANT/ADJUST (`npm run ai:grant`); PURCHASE ödeme gelince.
- **AiResultCache** (§5.12): aynı girdide yapay zekânın önceki ham çıktısı (yalnız firma içi): kind, cacheKey (sha256, `services/aiMeter.ts` `aiCacheKey`; `(companyId, kind, cacheKey)` tekil), model, result (Json), usageId?, expiresAt. Süresi dolanı bakım işi, firmanın hepsini veri sıfırlama siler.

#### İndeksler
- Ölçümde `(companyId, trackingNo)` ve `(companyId, measuredAt)`.
- `InvoiceLine`'da `(invoiceId, rowIndex)`, `(companyId, trackingNo, invoiceId)`, `(companyId, rawHash, invoiceId)` (silinmiş fatura kopyaları tabloya gidilmeden indeksten elenir), `(companyId, right(trackingNo, 10))` (takip no son eki; yalnız SQL'de, Prisma şemasında yok), `measurementId`, `tariffId`, `tariffRevisionId` (`Invoice`'ta da).
- `Invoice`'ta ayrıca `(companyId, carrierId, invoiceNo)` ve `(companyId, invoiceDate)` (analiz ve liste: tarih aralığı).
- 5.000+ satırlık fatura yükleme ve yeniden karşılaştırma bu indekslere dayanır.
- Kısmi tekil dizinler Prisma'da görünmez; `migrate dev` silmeyi önerirse üretilen göçten çıkarılır (şema başındaki not).

#### Ölçüm değişince yeniden karşılaştırma
Ölçüm eklendiğinde, düzeltildiğinde, silindiğinde ya da geri yüklendiğinde şu satırların faturaları otomatik yeniden karşılaştırılır (`recompareForTracking`):
- o takip no ile eşleşebilecek satırlar **ve**
- ölçüm zincirinin herhangi bir sürümüne bağlı (sabitlenmiş ya da otomatik) satırlar.

Faturanın kayıtlı dayanağı kullanılır; yalnız donmamış satırlar yazılır. Karar verilmiş ya da itirazdaki satırın sonucu farklı çıkarsa `recalcPending = 'MEASUREMENT'` ile işaretlenir (§3.14).
