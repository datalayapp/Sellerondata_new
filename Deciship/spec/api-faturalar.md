# DeciShip SPEC — API: faturalar (§5.8)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

### 5.8 Faturalar

Kod: `apps/api/src/routes/invoices.ts`; toplu karar `apps/api/src/services/bulkDecide.ts`; yeniden hesap `apps/api/src/services/compare.ts`.

#### Yükleme
- `POST /invoices/preview` multipart `file`, alan `carrierId` → dosya saklanır →
  - CSV/XLSX: `{ fileId, format, headers, sampleRows (ilk 10), rowCount, suggestedMapping, mappingSource: 'saved'|'preset', confidence, missing, guessedMeta: { invoiceNo?, invoiceDate?, currency? }, fieldSources, suggestAi, aiAvailable, divisor, diagnostics }`.
    - `rowCount`: ayrıştırıcının okuyacağı veri satırı; TOPLAM, ara toplam ve boş satır sayılmaz (kural `parseRows`'un kendisi, `previewRowCount`). Takip no ya da tutar sütunu eşlenmemişse ham satır sayısı.
  - PDF: yalnız `?async=1` ile, arka plan işi (`INVOICE_PDF_READ`, 202 `{ job, joined }`; `async` yoksa 400 `ASYNC_REQUIRED`, §5.13). Claude ile okunur; `job.result` → `{ fileId, format:'pdf', aiLines: ParsedInvoiceLine[], pdfCheck: { method, checked, unverified, rows: { rowIndex, codes }[] }, aiSkipped: { count, amount? }, guessedMeta, warning: "Yapay zekâ ile okundu, kontrol edin" }`.
    - `warning`e gerektiğinde KDV oranı / ağırlık birimi varsayımı, lb çevirisi ve okunmamış olabilecek takip no'lar eklenir.
    - `pdfCheck` ve `aiSkipped`: §3.15. Web işaretli hücreyi kırmızı kenarla gösterir, üstte tek satır uyarı; yükleme engellenmez.
    - AI kapalıysa 503 `AI_DISABLED` (dosya saklanmadan).
- `POST /invoices/preview/verify` ve `POST /invoices/preview/ai-mapping`: §11.
- `POST /invoices` `{ fileId, carrierId, tariffId?, invoiceNo, invoiceDate, periodFrom?, periodTo?, currency?, mapping? (csv/xlsx), lines? (pdf, kullanıcı düzeltmeli, en çok 5.000), saveMapping: boolean, acknowledgeIssues?: boolean, confirmOverlap?: boolean, pdfWeightConfirmed?: number[] }` → okur, PDF'te satırları metinle denetler (§3.15), eşleştirir, karşılaştırır → `201 { invoice, errors, importReport }`.
  - KALANLAR 6.18: CSV/Excel'in veri satırı `INVOICE_IMPORT_QUEUE_ROWS`'u (5.000) aşarsa `?async=1` ile 202 `{ job, joined }` (iş `INVOICE_IMPORT`, sonuç aynı gövde; `async` yoksa 400 `ASYNC_REQUIRED`); kurallar [arka-plan-isleri.md](arka-plan-isleri.md) "Büyük CSV/Excel içe aktarma işi".
  - `currency` verilmezse firmanın para birimi (`settings.currency`).
  - `saveMapping` yalnız `deciship.settings.manage` izniyle taşıyıcının kayıtlı eşlemesine yazılır; izin yoksa yok sayılır, fatura yine yüklenir.
  - `pdfWeightConfirmed`: iki türlü basılı PDF ağırlıklarında seçim yapılan satırlar (409 `PDF_WEIGHT_CHOICE_REQUIRED`; §3.15).
  - Hiçbir satır atlanmaz (birebir aynı satır da; §3.13). Çakışma onayı `409 INVOICE_OVERLAP` (§3.13); okuma kontrolü onayı yalnız CSV/XLSX'te `409 MAPPING_UNVERIFIED` (§11.4). Takip no'su Excel'in bilimsel yazımına dönmüş dosya onayla da alınmaz: `400 TRACKING_SCIENTIFIC` (`details: { count, sample }`, §11.1).
  - `tariffId` verilmezse/null ise fatura gününde geçerli tarife, yoksa varsayılan kaydedilir (§3.12; tarife yoksa null). Hesabın dayanağı (tarifenin bugünkü sürümü + bugünkü ayar) faturaya ve satırlara yazılır (§3.14).
  - Başka şirketin tarifesi `404`, başka taşıyıcının `400 TARIFF_CARRIER_MISMATCH`, pasif `400 TARIFF_INACTIVE`.
  - Aynı `invoiceNo` + taşıyıcı varsa (büyük/küçük harf ayrımı yok) 409 `INVOICE_EXISTS`.
  - Denetimler kur beklemesinden sonra firma kilidi altında yinelenir; yarışan istekte yalnız kapılmamış satırlar yazılır.

#### Liste ve ayrıntı
- `GET /invoices?carrierId=&from=&to=&q=&status=&page=` → `{ items: { id, invoiceNo, invoiceDate, carrier, totals, createdAt }[], total, page, pageSize }` (örnek faturalar yok).
  - `q` (kırpılır, en çok 64 karakter): fatura no parça eşleşir (büyük/küçük harf duyarsız); normalleştirilmiş takip no en az 4 karakterse satırlarda tam eşleşme de aranır (dizinden). `%`, `_` ve `\` kaçışlanır (`likeEscape`; Prisma `contains` kaçışlamaz): `q=%` hiçbir şey bulmaz.
  - `status`: `DIFF` (kayıtlı toplamda `diff > 0`), `UNMATCHED` (`unmatched > 0`), `TO_DISPUTE` (`overchargeTotal > 0` ve etkin itiraz turu yok; ekranda "İtiraz bekliyor"). Toplam satırlarla aynı işlemde yazıldığı için süzgeç güncel sayılır.
- `GET /invoices/:id` → başlık + totals + taşıyıcı + dosya (`fileUrl`, `fileName`, `fileFormat`) + `tariffId`, `tariff: {id,name}|null`, `tariffsUsed: [{id,name,lines}]`, `tariffSuspect` (§3.11), `dispute` (`itiraz.md`), `basis`, `importReport` (§3.15; eski faturada null).
  - `basis: { state: 'CURRENT'|'TARIFF_CHANGED'|'TARIFF_REMOVED'|'RULES_CHANGED'|'NONE', tariffName, calculatedAt }` (§3.14): `tariffName` tarife silindiyse sürümdeki ad; `calculatedAt` son hesap anı (§3.15).
  - `totals.pendingLines` yeniden hesap bekleyen satır sayısıdır; `totals.reconciliation`, `totals.overchargeByType` dökümdür (§3.15).
- `PATCH /invoices/:id` (fatura bilgilerini düzeltme): §10.2.
- `DELETE /invoices/:id` (yumuşak).

#### Satırlar
- `GET /invoices/:id/lines?status=&diffType=&decision=&q=&flagged=&recalcPending=&review=&page=`
  - `decision` virgülle çoklu; `recalcPending=true` yalnız yeniden hesap bekleyen satırlar; `review=true` yalnız "İncele" satırları (§3.13).
  - Satırlar + eşleşen ölçüm özeti: `measurement: { id, lengthCm, widthCm, heightCm, weightKg, dimMethod, weightMethod, photoCount, measuredAt, measuredByName, photos:[{id,kind,url}] } | null`.
  - Satırda ayrıca `tariff: {id,name}|null`, `measurementPinned`, `originalTrackingNo`, `parseFlags`, `parseChecked`, `pricingBasis`, `rateDeviationPct`, `confidence`, `confidenceReason`, `reviewCode`, `fx`, `recalcPending`, `recalcPendingAt` (§3.14) ve `prevResult: { status, at, cause, diffTypes, expectedAmount, diffAmount, ourChargeableKg }|null` (`prices.view` yoksa yalnız `status`, `at`, `cause`; iç kimlikler gitmez).
  - Yanıt `{ items, total, page, pageSize, selectionDigest, selectionEligible }`.
  - `selectionDigest`: süzgecin BÜTÜN satırlarının (yalnız bu sayfa değil) özeti (kimlik, `updatedAt`, karar, durum, `recalcPending`; kimliğe göre sıralı SHA-256, 64 onaltılık hane). "Tümünü seç" bunu toplu karara geri gönderir. `total` ile aynı sorgudan gelir. Karar izni yoksa ya da süzgeçte 5.000'den çok satır varsa `null` ("tümünü seç" sunulmaz).
  - `selectionEligible` (`selectionDigest` ile birlikte, yoksa `null`): süzgeçte toplu kararın değiştirebileceği satır sayısı (kararı bekleyen, "Fark var", yeniden hesap beklemeyen, etkin itiraz turunda olmayan; web `isEligible` ile aynı). Web "tümünü seç"te ve onay başlığında süzgecin toplamını değil bunu yazar.
  - "İncele" süzgecinde "İtiraz listesine ekle" düğmesi çizilmez ("Uyumlu say" birincil).
  - Süzgecin tek tanımı `buildLineWhere` (`services/bulkDecide.ts`); liste ucu ve toplu karar aynı satırları görür, `q` kaçışlıdır.
- `PATCH /invoice-lines/:id` `{ decision?, reason?, trackingNo?, measurementId?: string|null, note?: string|null, parseChecked?, expectedDecision? }` → `200 { line, totals }`. Boş gövde de geçerlidir (yalnız totals tazelenir).
  - `decision`: `ACCEPTED`'da gerekçe zorunlu (400 `REASON_REQUIRED`; gerekçe en çok 1.000 karakter). Karar alanları ve kuralı toplu kararla ortaktır (`decisionFields`, `reopenPendingLines`).
  - Tek satırda `VERIFIED` toplu kararla aynı kurala bağlıdır (`hasClaim`, `isDisputable`): "Fark var" olmayan ya da talebi sıfır olan satır 409 `NO_CLAIM`, hiçbir şey yazılmaz. Panelde düğme görünmez; fiyat izni olmayana tutar gitmediği için düğme kalır, kuralı sunucu söyler.
  - Aynı istekte takip no / eşleşme düzeltmesi varsa satır o istekte yeniden hesaplandığı için bu denetim yapılmaz.
  - Yarış koruması: karar kuralları (`NO_CLAIM`, `LINE_IN_DISPUTE`) fatura kilidi altında yeniden okunan satıra bakar; yazım okunan kararı koşul alır (araya kilitsiz bir yazıcı girdiyse 409 `LINE_CHANGED`).
  - `expectedDecision` (panelin gördüğü karar; web her karar isteğinde gönderir) verilirse ve satırın bugünkü kararı farklıysa 409 `LINE_CHANGED`, hiçbir alan yazılmaz: eski ekrandaki kişi başkasının kararını sessizce ezemez. Alan isteğe bağlıdır (eski istemci ve testler); web 409'da satırı yeniden okur ve söyler.
  - `parseChecked`: §11.5.

#### Toplu karar
`POST /invoices/:id/lines/decide` (izin `lines.decide`, salt okunur abonelikte kapalı; kod `services/bulkDecide.ts`):
- Gövde `{ decision: 'VERIFIED'|'ACCEPTED'|'OPEN', reason?, lineIds? (1..5.000 tekil), filter?: { status?, diffType?, decision?[], q?, review?, recalcPending?, flagged? } (tanınmayan alan 400), expectedCount?, selectionDigest? (64 onaltılık hane), undoOf?: { opId, decidedAt } }`.
  - `lineIds` ile `filter`'dan tam olarak biri. `filter` ile `expectedCount` ve `selectionDigest` zorunlu (özet göndermeyen eski istemci 400 `VALIDATION` alır; eski `listedAt` alanı yok sayılır). `undoOf` yalnız `decision: 'OPEN'` + `lineIds` ile. Aksi 400 `VALIDATION`.
  - `ACCEPTED`'da gerekçe zorunlu (400 `REASON_REQUIRED`, tek satırla aynı 1.000 karakter sınırı).
  - 5.000'den çok satır (kimlik ya da süzgecin bugünkü toplamı) 400 `BULK_TOO_MANY`.
- Fatura gövdeden önce aranır: yok, silinmiş ya da başka firmanınsa gövde ne olursa olsun 404. Kimliklerden biri bu faturanın değilse 404.
- Fatura kilidi altında, tek işlemde. Süzgeçle seçimde ("bu süzgeçteki tümü") bugünkü toplam `expectedCount`'tan farklıysa ya da kilit altında karar verilecek satırları okuyan sorgudan üretilen özet `selectionDigest`'i tutmazsa (sayı aynı kalıp küme ya da kümedeki bir satır değişmiş olabilir) hiçbir şey yazılmaz: 409 `SELECTION_CHANGED`, `details: { listed, current, changed }` (`changed`: 0 sayı tutmadı, 1 özet tutmadı). Özet saate bakmaz.
- Hangi satır değişir; geri kalanı atlanır ve tek nedenle sayılır (sıra: `inDispute` > `OPEN` için `notDecided` > `changedSince` > `decided` > `noGap` > `pending` > `noClaim` > `review`):
  - `VERIFIED` ("İtiraz listesine ekle"): kararı bekleyen (`OPEN`), "Fark var" (`DIFF`), yeniden hesap beklemeyen, talebi sıfırdan büyük (`isDisputable`, itiraz metniyle aynı kural) ve "İncele" işaretli olmayan satır.
  - `ACCEPTED` ("Uyumlu say"): aynı koşullar; "İncele" işaretli ve talebi sıfır olan satır da uyumlu sayılabilir.
  - `OPEN` ("Geri al"): kararı verilmiş satır. `undoOf` verilmişse yalnız o işlemin kararını (karar veren = isteyen kişi, `decidedAt` = `undoOf.decidedAt`) hâlâ taşıyan satır; arada başkasının ya da sonradan verilen karar kalır (`changedSince`).
  - Etkin itiraz turundaki satıra hiçbir kararda dokunulmaz (`inDispute`).
- Satır başına `invoiceLine.bulkDecision` ve fatura için tek `invoice.linesDecided` denetim kaydı kararla aynı işlemde yazılır (Merkez etkinliğinde yalnız ikincisi görünür). Toplam aynı işlemde yazılır; son hesap anı (`calculatedAt`) kararla ilerlemez.
- `OPEN`'a dönen ve `recalcPending` taşıyan satırlar işlemden sonra yalnız kendileri, faturanın sabit dayanağıyla, tek satır kuralıyla hesaplanır; bu arada yeniden karar verildiyse yazılmaz, satır işaretli kalır.
- Yanıt `200 { opId, decision, changed, changedLineIds, decidedAt (OPEN'da ya da hiçbir satır değişmediyse null), skipped: { inDispute, noGap, review, decided, pending, notDecided, noClaim, changedSince }, totals }`. Alan adlarında para sözcüğü yoktur (`MONEY_KEY` fiyat izni olmayana "diff" geçen alanı siler; bu yüzden `noGap`).
- Web "Geri al"da `changedLineIds` ile `decision: 'OPEN'` ve ilk yanıtın `{ opId, decidedAt }`'ini gönderir: yalnız kişinin kendi verdiği karar geri alınır.

#### Yeniden karşılaştırma ve yeniden hesap
- `POST /invoices/:id/recompare` (önizlemesiz; kur yeniden denemesi, §11.4 doldurma) → okuma bayraklarını yeniler, faturanın kayıtlı dayanağıyla yalnız karar verilmemiş satırları yeniden karşılaştırır; donmuş satırın farklı sonucu `recalcPending` ile işaretlenir → `{ invoice, pendingLines }`. Dayanaksız fatura burada güncel dayanağa bağlanır (gönderilmiş itirazı varsa bağlanmaz). Kararlar korunur.
- `POST /invoices/:id/recalculate/preview` `{ basis: 'pinned'|'tariff'|'rules', lineIds?, patch?: { carrierId?, tariffId?, invoiceDate?, currency? } }` → `{ token, basis: { from, to, rulesChanged }, totals: { before, after }, changedLines, frozenChanged, skippedInDispute, writeLines, lines: [{ id, rowIndex, trackingNo, decision, before, after }] }`; yazmaz.
  - `from`/`to` = `{ tariffId|null, tariffName, revisionId, revisionAt }`; `before`/`after` satırda `{ status, diffTypes, expectedAmount, diffAmount }`, toplamda tam `InvoiceTotals`.
  - `lines`: yalnız yazılacak ve para sonucu değişen satırlar (ilk 200).
  - `changedLines`: yazılacak, para sonucu değişen satır. `frozenChanged`: karar verilmiş (itirazda olmayan) satırlardan sonucu değişen. `skippedInDispute`: sonucu değişecek ama etkin itirazda olduğu için yazılmayacak satır.
  - `writeLines`: uygulanınca dokunulacak satır (sonucu yazılan, "yeniden hesap bekliyor" işareti konan ya da silinen), görünür değişiklik olsun olmasın.
  - Bir satır yalnız durumu, fark türleri ya da fazla ödemeye katkısı (en az 0,01) değişirse "değişen" sayılır; tolerans içi küçük kayma sayılmaz ama yine yazılır.
  - Web `changedLines` 0, toplam ve dayanak aynıyken `writeLines > 0` ise pencere açmadan uygular ve "Satırlar güncellendi; tutar değişmedi." der (ör. kararlı satırın aynı desili yeni ölçümü; işaret kalıcı kalmaz).
  - `lineIds` verilmezse kapsam `all`; verilirse yalnız o satırlar (başka faturanın satırı 404).
  - `patch` düzenleme penceresinin önizlemesidir: taşıyıcı ya da tarife değişiyorsa tarife parçası bugünküne geçer (ayar kalır); `PATCH /invoices/:id` kaydı bu önizlemenin `token`'ını ister.
  - `lineIds` ve `patch` yalnız `basis: 'pinned'` ile; `tariff` / `rules` ile `400 VALIDATION` (`details[].path` `lineIds` ya da `patch`).
  - İzin: `lines.decide`; yalnız `invoices.upload` olan kişi yalnız `basis: 'pinned'` + `patch` (lineIds'siz) önizlemesi isteyebilir.
- `POST /invoices/:id/recalculate` `{ basis, lineIds?, token }` → `{ invoice }` (`GET /invoices/:id` biçimi).
  - Önizlemenin `token`'ı zorunlu; tutmazsa `409 PREVIEW_STALE`.
  - `tariff` faturayı yalnız tarifenin bugünkü sürümüne, `rules` yalnız bugünkü ayara bağlar; öbür parça faturada kalır (§3.14).
  - Yetki her kipte `lines.decide`.
  - Gönderilmiş itirazdaki kilitler (`INVOICE_HAS_DISPUTE`, `LINE_IN_DISPUTE`): `itiraz.md`.

#### Raporlar ve itiraz metni
- `GET /invoices/:id/report.xlsx`: sayfa 1 "Özet" (fatura, dönem, tarife, satır sayıları, faturalanan, beklenen, fazla ödeme, doğrulanan), sayfa 2 "Farklar" (yalnız DIFF), sayfa 3 "Tüm satırlar", sayfa 4 "Eşleşmeyenler". Satır sayfalarının sonunda ölçüm kanıtı sütunları (zaman, ölçen, yöntem, fotoğraf; §3.15).
- `GET /invoices/:id/report.pdf`: A4 yatay, şirket adı, özet kutuları (tarife dahil), fark tablosu (takip no, tür, bizim ölçü/kg, fatura ölçü/kg, beklenen, faturalanan, fark, "Ölçüm" sütunu; ölçen kişinin adı yok), Türkçe karakterler doğru.
- İki rapor da dışa aktarma iznine ek olarak fiyat izni (`prices.view`) ister.
- `GET /invoices/:id/dispute?lang=tr|en` (varsayılan istek dili) → `{ subject, body, lineCount, total, vatPct?, totalInclVat?, photoCount, linesWithoutPhoto }` (`itiraz.md`). İsteğe bağlı `X-Signature-Email`, `X-Signature-Phone` başlıkları imzaya girer (ZIP'te de; `itiraz.md` "İmza").
  - `vatPct`/`totalInclVat` yalnız faturanın KDV oranı biliniyorsa.
  - Yalnız VERIFIED satırlar; yoksa 400 `NO_VERIFIED_LINES`; fiyat izni yoksa 403.
  - Uç, ZIP gibi dışa aktarma yuvasındadır (`limited(…, 'export')`, firma başına `HUB_EXPORT_CONCURRENCY_PER_ORG`).
  - Fotoğrafın üst verisinin temizlenebilirliği dosya başına (boyut + değişme anı) süreç içinde hatırlanır; pencere yeniden açılınca ve dil değişince fotoğraflar yeniden okunmaz (sayma kuralı ZIP'inkiyle aynı).
- Kanıt satırları ve `GET /invoices/:id/dispute/evidence.zip`: `itiraz.md` "İtiraz metni ve kanıt".
