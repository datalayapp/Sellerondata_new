# DeciShip SPEC — Okuma kontrolü ve yapay zekâ destekli eşleme (§11)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 11. Okuma kontrolü ve yapay zekâ destekli eşleme

İlke:
- Deterministik eşleme (kayıtlı eşleme, yoksa taşıyıcı kalıbı) varsayılandır: ücretsiz ve anında.
- Yapay zekâ isteğe bağlıdır; yalnız kullanıcı "Yapay zekâ ile eşle" deyince çağrılır.
- Her önizlemede ve her içe aktarmada **okuma kontrolü** (deterministik doğrulama) tüm satırlarda çalışır. Yapay zekâ kullanılsa da kullanılmasa da çalışır.
- Eşleme tam doğrulanmadan içe aktarma sessizce geçmez.

### 11.1 Okuma kontrolü (core: `packages/core/src/invoice/verify.ts`)

`verifyMapping(table, mapping, { divisor? })` → `MappingVerification`; `mappingDiagnostics(t, m, { divisor })` sonucunda `verification` alanı olarak da döner.

```ts
type FieldVerdict = { status: 'ok' | 'check' | 'missing'; confidence: number /*0..1*/; reasons: string[] };
type MappingVerification = {
  verdict: 'ok' | 'check';
  fields: Partial<Record<HeaderField, FieldVerdict>>;   // eşlenen her alan + eşlenmemiş zorunlu alanlar ('missing')
  rowFlags: { rowIndex: number /*0 tabanlı veri satırı*/; trackingNo?: string; codes: RowFlagCode[] }[];
  flaggedRows: number;                                   // sert bayraklı satır sayısı
  flagCounts: Partial<Record<RowFlagCode, number>>;
  checks: { tracking: { filled, total, formatOk, unique }, charges: { rowsChecked, rowsMatching },
            invoiceTotal: { value, linesTotal, difference } | null, billedWeight: { rowsChecked, rowsOdd, divisor } };
  issues: string[];                                      // açık sorunlar; verdict 'ok' ise boş
};
```

Alan kararı neye bakar:
- **Doluluk.** Takip no tüm satırlara göre, diğer alanlar okunan satırlara göre. Hiç dolu değilse `check`. Hiç satır okunamıyorsa isteğe bağlı alanlar da `check` olur.
- **Biçim.**
  - Takip no: değerlerin en az %90'ı 8–35 harf/rakam; değerlerin en az %80'i benzersiz (en az 3 değer ve 2+ tekrar varken; tek mükerrer satır fatura bulgusudur, okuma hatası değil). Fatura ya da hesap numarası seçilirse benzersizlik düşük olur.
  - Ağırlık 0–1000 kg; ölçüler 1–300 cm (birim çevrildikten sonra).
  - Tarih okunuyor olmalı. Ülke tanınıyor olmalı; ülke adları dile bağımsız olarak `Intl.DisplayNames` ile 14 dilde tanınır.
  - Para birimi kodu; bölen 1000–10000; birim hücreleri cm/inç, kg/lb.
- **Tutarlar.**
  - Net tutar her satırda aynıysa (5+ satır) fatura toplamı olabilir → `check`.
  - Ücret kalemleri (navlun − indirim + yakıt + ek ücretler) net tutarı tutmalı, tolerans 0,05. "KDV dahil" seçiliyken bileşen sütunları zaten KDV hariç olabilir (ör. Aras); bu durumda bileşenler KDV ile bölünmeden de karşılaştırılır.
  - Satırların net toplamı fatura toplamı sütununu tutmalı (±1; KDV dahil toplam da kabul).
  - Ayrı KDV tutarı sütunu varsa "Tutarlar KDV dahil" seçimi ve oranı satırlarla sınanır (`invoice/vat.ts` `checkMappingVat`; kural §3.2). Uymuyorsa, KDV'li ve KDV'siz satır karışıksa "KDV dahil" seçili ama veri bunu göstermiyorsa ya da "KDV hariç" seçili ama satırların çoğu KDV dahil görünüyorsa net tutar `check` olur.
- **Dosya.**
  - XLSX'in okunmayan görünür sayfasında gönderi satırı varsa (okunan sayfanın takip no sütunu orada da var ya da genel kalıp takip no ve tutar buluyor) sorun yazılır: sayfa adı ve satır sayısı (`unreadSheetsOf`). Öbür okunmayan sayfalar eşleme ekranında bilgi olarak (`diagnostics.sheets`).
  - Takip no Excel'in bilimsel yazımına dönmüşse ("1,23457E+11") sorun yazılır ve dosyanın nasıl yeniden alınacağı söylenir; içe aktarma onayla da almaz (400 `TRACKING_SCIENTIFIC`, `scientificTrackingRows`).
  - Takip no XLSX'te 16+ haneli sayı hücresiyse ya da metinde (Excel'de kaydedilmiş CSV) 15. haneden sonrası hep sıfırsa (sütundaki uzun numaraların en az yarısı) tek sorun yazılır, onayla alınır, değer düzeltilmez (`excelNumberTrackingRows`, 5.19). Baştaki düşen sıfırlar ayrıca denetlenmez: eşleşme en az 10 karakterlik sonekle yakalar.
- **Tutarlılık (yumuşak).** Ölçüsü olan satırlarda ücretli kg ≈ max(gerçek kg, hacimsel kg).
  - Bölen sırası: satırdaki bölen, sonra taşıyıcının varsayılan etkin tarifesi, sonra kalıp, en son 5000.
  - Bu kontrol alan kararını değiştirmez; gerçek FedEx verisinde hacimsel ağırlık her gönderide uygulanmıyor.

Satır bayrakları (`RowFlagCode`):

| Kod | Tür | Anlamı |
|---|---|---|
| `TRACKING_FORMAT` | sert | Takip no 8–35 harf/rakam değil |
| `AMOUNT_PARSE` | sert | Net tutar okunamadı |
| `CHARGES_MISMATCH` | sert | Kalemler net tutarı tutmuyor |
| `WEIGHT_RANGE` | sert | Ağırlık 0–1000 kg dışında |
| `DIMS_RANGE` | sert | Ölçü 1–300 cm dışında |
| `DATE_PARSE` | sert | Gönderi tarihi okunamadı |
| `UNIT_UNKNOWN` | sert | Birim hücresi tanınmadı |
| `PDF_TRACKING_UNVERIFIED` | sert | PDF: yapay zekânın okuduğu takip no PDF metninde yok (§3.15) |
| `PDF_AMOUNT_UNVERIFIED` | sert | PDF: net tutar PDF metninde, takip no'nun yakınında yok (§3.15) |
| `PDF_VAT_UNCLEAR` | sert | PDF: tutarların KDV dahil olup olmadığı belirsiz (§3.15) |
| `PDF_PAGE_BREAK` | sert | PDF: satır sayfa sınırında bölünmüş olabilir (§3.15) |
| `PDF_WEIGHT_UNVERIFIED` | sert | PDF: okunan ağırlık satırın penceresinde yok (§3.15) |
| `PDF_DIMS_UNVERIFIED` | sert | PDF: okunan ölçülerden biri satırın penceresinde yok (§3.15) |
| `PDF_SURCHARGE_UNVERIFIED` | sert | PDF: okunan ek ücret ya da yakıt tutarı satırın penceresinde yok (§3.15) |
| `CURRENCY_MISMATCH` | sert | Satırın kendi para birimi faturanınkinden farklı (aşağıda) |
| `DUPLICATE_TRACKING` | yumuşak | Aynı takip no dosyada tekrar ediyor. Okuma hatası değil fatura bulgusu; karşılaştırma `DUPLICATE` olarak işaretler. |
| `BILLED_WEIGHT_ODD` | yumuşak | Ücretli kg, max(gerçek, hacimsel) ile uyuşmuyor |

`CURRENCY_MISMATCH` ayrıntısı:
- Karşılaştırılan para birimi içe aktarmada ve yeniden karşılaştırmada faturanınki (`invoiceCurrency`), önizlemede satırlarda en sık görülen.
- Okuma sorunu sayılmaz, kendi sorun metniyle söylenir ("2 satır faturanın para biriminde değil (2 EUR; fatura USD)…").
- Tablo ve PDF içe aktarması onay ister (409 `MAPPING_UNVERIFIED`; PDF'te `services/invoicePdfCheck.ts` `pdfCurrencyGate`); onaylanırsa satır "Kontrol edilecek" olur.
- Toplamlar para birimine göre ayrılmaz: farklı para birimli satırlar ayrı faturada yüklenmeli.

Yumuşak bayraklar saklanır ve bilgi olarak gösterilir. Genel kararı, içe aktarma onayını ve "Kontrol edilecek" sayısını etkilemez (`HARD_ROW_FLAGS`, `SOFT_ROW_FLAGS`).

**Genel karar** `check` olur, eğer: zorunlu bir alan `missing` ya da `check` ise; herhangi bir eşlenmiş alan `check` ise; sert bayraklı satır varsa; ya da hiç satır okunamadıysa.

`POST /invoices/preview/verify` `{ fileId, carrierId, mapping }` → `{ diagnostics, suggestAi }`.
- Eşleme ekranında her değişiklikte (350 ms gecikmeyle) çağrılır.
- Dosya yeniden yüklenmez; okunan tablo sunucuda küçük bir önbellekte tutulur.
- Yanıttaki `rowFlags` en fazla 200 öğedir; sayılar tamdır.

### 11.2 Yapay zekâ ile eşleme (API)

`POST /invoices/preview/ai-mapping` `{ fileId, carrierId, mapping?, sources? }` (`invoices.upload`) şu yanıtı döner:

```
{ mapping, fieldSources, aiConfidence: { [alan]: { header|null, confidence, reason, dropped? } }, decisions, dropped: {field, header}[], diagnostics, suggestAi:false, guessedMeta, usage: { model, inputTokens, outputTokens } }
```

#### İstek (`apps/api/src/services/aiMapping.ts`)
- Model `CLAUDE_MODEL` (varsayılan `claude-sonnet-5-5`).
- Mevcut `structuredCall` kullanılır: zod yapılandırılmış çıktı, akış, `effort: 'medium'`, `fallbacks: 'default'`.
- Claude'a giden: her sütun için başlık, tüm dosyadaki doluluk ve farklı değer sayısı, en fazla 12 örnek satırdan değerler (satır sırasıyla, "∅" boş).
  - Hücreler 40 karakterde kesilir.
  - Rakam içermeyen metin sütunlarından (ad, adres gibi) yalnız en fazla 4 farklı değer gider.
  - Tam satır dökümü gitmez.
- Önbellek anahtarına `MAPPING_PROMPT_VERSION` (bugün 4) girer; istem ya da maske kuralı değişince artırılır, `INVOICE_MAPPING` önbelleği bir kez ıskalanır.

#### Kişisel veri maskesi (`services/aiMappingMask.ts`)
- Kişisel olabilecek örnek hücre biçimi korunarak gider: büyük harf `A`, diğer harfler `a`, rakam `9`; boşluk, noktalama ve uzunluk aynen. Doluluk ve farklı değer sayısı gerçek tablodan hesaplanır. İstem modele maskeyi bir cümleyle anlatır.
- PDF fatura okumada belgenin kendisi gider; bu maske onu kapsamaz.
- **Başlıklar** (`headerAliases`): başlık satırı yanlış seçilmiş olabilir (başlıksız dosya, yinelenen başlıklar, birleşmiş grup başlığı).
  - Bir başlık veri gibiyse (sayı, tarih, saat, ölçü, e-posta, telefon, 7+ rakam, "1Z1" gibi rakam-harf-rakam kimlik) bütün başlık satırı gizlenir; değilse yalnız kuşkulu başlık (":" sonrası serbest metin, rakam ağırlıklı).
  - Gizlenen başlık yerine "#<sıra>" ve biçim maskesi gider; yanıttaki "#<sıra>" gerçek başlığa çevrilir (`aiRawToMapping`). Gizlenen sütun nötr sayılır.
- Hücre kararı önce başlıktan (`headerPrivacy`), sonra değerden (`shouldMaskSample`):
  1. Başlığında adres, telefon, e-posta, posta kodu (PK, CAP, CP, NPA dahil), şehir/ilçe, kimlik/vergi no, doğum, imza ya da ilgili kişi sözcüğü olan sütunun her hücresi maskelenir. Aynısı ad sözcüğü (name, ad, isim, soyad, unvan, kişi, rep; hiçbir güvenli sözcük ezmez: "Charge To Name", "Service Name" kişisel) olan ve taraf sözcüğü (alıcı, alan, gönderici, recipient, müşteri…) olup ülke ya da tarih anlamı taşımayan sütun için geçerlidir. Kısa güvenli sözcükler (land, date, unit…) tam sözcük olarak sayılır.
  2. E-posta ya da telefon biçimli (10–13 hane) değer her sütunda maskelenir.
  3. Sayı (tutar, ağırlık, ölçü; ayırıcı, işaret, para birimi ya da birim ekiyle), sayısal tarih/saat, "40x30x25" ölçü ve 2–3 harfli kod korunur. Kısa kod yalnız tamamı büyük harfse korunur ("Ali", "Can" maskelenir). 7 haneden uzun ayırıcısız rakam dizisi (takip, hesap, vergi no) ve boşlukla gruplanmış ondalıksız, eksiz rakam dizisi ("612 345 678") maskelenir; yalnız yyyymmdd tarihi korunur.
  4. Ülke/hizmet/ücret etiketi/para birimi/birim/tarih başlıklı sütunda metin yalnız değerin kendisi de güvenliyse korunur: ülke adı ya da kodu, para birimi adı, bilinen ek ücret adı ya da hizmet, ücret ve tarih sözlüğünden bir sözcük. Sözlükte ad olarak da kullanılan sözcük yok; sözlükte olmayan değer maskelenir.
  5. Geri kalan maskelenir (emin değilsen maskele).

#### İstem ve şema
- İstem dile bağımsızdır (TR, EN, DE, FR, … her dil). İstemde şunlar anlatılır:
  - her satırda tekrar eden fatura düzeyi değerler satır tutarı ya da takip no olamaz;
  - etiket/tutar sütun çiftleri vardır;
  - kanonik alanların listesi ve açıklamaları.
- Şema şunları ister:
  - her kanonik alan (satır + `invoiceNo/invoiceDate/invoiceTotal`) için `{ header|null, confidence, reason }`;
  - `chargePairs`; görülen etiketler için `chargeLabels` (base/discount/fuel/surcharge + kod); `surchargeColumns`;
  - `defaultDimUnit` / `defaultWeightUnit`; `numberFormat` ('tr' = virgül ondalık, AB biçimi de; yalnız dosyada biçim kanıtı yokken kullanılır, §3.5);
  - `dateOrder`: kanıt gönderi ve fatura tarihi sütunlarından birlikte toplanır; `/` ya da `-` ayraçlı değerlerden sıra anlaşılmıyorsa eşleme adımında kullanıcıya sorulur, seçilene dek okuma kontrolü sorun gösterir;
  - `amountsIncludeVat`; `desiAsWeight`.

#### Ağırlık yazımı sorusu (`weightAmbiguity`, `weightFormat`)
- Ağırlık sütununda (`actualKg`, `billedKg`) "1.500" ya da "1,500" gibi metin hücre varken eşlenen sayı sütunlarından biçim anlaşılmıyorsa (`detectTableNumberFormat` = auto) tanı `weightAmbiguity` döner; eşleme adımı "Ağırlık yazımını seçin" diye sorar.
  - XLSX'in gerçek sayı hücresi sayılmaz. `numberFormat` ipucu (yapay zekânınki ya da kayıtlı eşlemeninki) soruyu cevaplamaz.
- Cevap `weightFormat` ağırlık sütununun yazım biçimidir: `tr`: "1.500" = 1500 kg, "1,500" = 1,5 kg; `en` tersi (core `weightAs`).
  - Her hücre kendi ayırıcısıyla okunur; dosyada iki yazım birlikte varsa soru ikisini de gösterir (`weightAmbiguity.other`).
  - Yalnız ağırlık sütunlarının iki türlü okunan metin hücrelerine uygulanır; tutarlar ve öbür sütunlar `numberFormat`/tespitle okunmaya devam eder. Dosyanın biçimi kanıtla belliyse yok sayılır.
- Seçilene dek okuma kontrolü sorun gösterir; sunucu içe aktarmada `acknowledgeIssues` olsa da almaz (409 `WEIGHT_FORMAT_REQUIRED`), istemci "Devam"ı ve içe aktarmayı kapatır.
- Seçim dosya başınadır: taşıyıcının kayıtlı eşlemesine yazılmaz (`savedMappingOf`; PATCH /carriers da), kayıtlı eşlemeden okunmaz, yapay zekâ önermez; faturanın kendi eşlemesinde kalır.

#### Yanıt denetimi ve hatalar
- **Uydurma başlık denetimi.** Dönen her başlık dosyada aranır: önce tam, sonra boşluk kırpılmış, sonra normalleştirilmiş ve tekil eşleşme. Bulunmayanlar atılır ve `dropped` listesine yazılır. Aynı sütun iki satır alanına verilmişse güveni yüksek olan kalır.
- Hatalar: anahtar yok → `503 AI_DISABLED`; yoğunluk → `503 AI_BUSY`; API hatası → `502 AI_FAILED`; ret → `422 AI_REFUSED`; yanıt kesildi → `422 AI_TRUNCATED`.
- Her çağrı `invoice.aiMapping` denetim kaydı bırakır: token kullanımı, atılan başlıklar, kararlar.

### 11.3 Birleştirme ve kaynak

`mergeAiMapping(table, base, baseSources, ai, { divisor })` (core, `merge.ts`). `base`: istekte `mapping` varsa o (ekrandaki, kullanıcı düzenlemeleri dahil); yoksa kayıtlı/kalıp eşlemesi.

Alan başına kural:

| Durum | Sonuç |
|---|---|
| Aynı sütun | `agree`; kaynak değişmez |
| Deterministik seçim doğrulamada `ok`, yapay zekâ farklı sütunu kendi doğrulama güveninden **düşük ya da eşit** güvenle öneriyor (ya da hiç önermiyor) | Deterministik kalır (`kept`) |
| Diğer durumlar | Yapay zekânın seçimi alınır (`ai`) |
| Birleşik eşlemede yapay zekâ seçimi doğrulamadan geçmiyor | Geri alınır (`reverted`). İstisna: deterministik tarafta hiç olmayan zorunlu bir alan; boş kalmasından iyidir. |

Diğer birleştirme kuralları:
- Aynı sütun iki satır alanına verilemez.
- Ücret çiftleri yapay zekâdan yalnız şu durumlarda alınır: deterministik çift yoksa ya da kalemler net tutarı tutmuyorsa.
- Etiket geçersiz kılmaları yalnız tür farklıysa ya da yerleşik sınıflandırma kodu `DIGER` ise eklenir. Böylece yerleşik kodlar korunur ve tarife ek ücretleriyle eşleşme bozulmaz (ör. FedEx "Demand Surcharge" → `PEAK`, yapay zekânın `DEMAND`'ı değil).
- Sabit birimler, sayı biçimi ve tarih sırası: deterministik ipucu yoksa yapay zekânınki kullanılır.
- Başlıktaki birim ipucu sabit birim olur ("Weight (lbs)" → `defaultWeightUnit: 'lb'`, "Dimensions (in)" → `defaultDimUnit: 'in'`); sessiz birim hatasını kapatır.

Kaynak (`fieldSources`) değerleri: `preset` (Kalıp), `saved` (Kayıtlı), `ai` (Yapay zekâ), `user` (Siz; ekranda elle seçilen). `POST /invoices/preview` yanıtında `fieldSources`, `suggestAi`, `aiAvailable` ve `divisor` bulunur; `diagnostics.verification` her zaman dolu.

**Yapay zekâ önerisi (`suggestAi = true`)**: kayıtlı eşleme yok ve taşıyıcının kalıbı yok (`generic`); ya da zorunlu bir alan `missing`/`check`; ya da genel karar `check`.

### 11.4 İçe aktarma kapısı ve satır bayrakları

- `POST /invoices` gövdesinde `acknowledgeIssues?: boolean`.
- CSV/XLSX'te sunucu okuma kontrolünü son eşlemeyle yeniden çalıştırır. Karar `check` ise ve `acknowledgeIssues` gönderilmediyse `409 MAPPING_UNVERIFIED`, `details: { issues, verdict, flaggedRows, flagCounts, examples: RowFlag[≤10] }`.
- Onaylı içe aktarmada normal denetim kaydına ek olarak `invoice.importUnverified` kaydı (sorun listesiyle) yazılır; satır bayrakları satırlarda kalır.
- `InvoiceLine.parseFlags String[]` ve `parseChecked Boolean`. İçe aktarmada her satıra kendi `rowIndex`'inin bayrakları yazılır. Satır atlanmaz (birebir aynı satır da; §3.13).
- PDF (yapay zekâ ile okunan) satırlarda `flagParsedLines` çalışır ve sunucu satırları PDF metniyle denetler (`PDF_*` bayrakları, §3.15). PDF'te okuma kontrolü için onay kapısı yoktur (kullanıcı kararı): tutmayan satır yüklenir ve "Kontrol edilecek" olur. Para birimi kapısı ayrıdır (§11.1 `CURRENCY_MISMATCH`).
- **Doldurma.** `POST /invoices/:id/recompare` önce bayrakları yeniden hesaplar (kaynak dosya + faturanın eşlemesi; PDF'te saklanan satırlar; `PDF_*` bayrakları korunur), sonra karşılaştırır. `parseChecked` korunur.
- Satır nesnesi `parseFlags` ve `parseChecked` içerir. `totals.flaggedLines` = sert bayrağı olan ve `parseChecked = false` satır sayısı. `GET /invoices/:id/lines?flagged=true` aynı kümeyi döner.

### 11.5 "Kontrol ettim"

Bayraklar silinmez; denetim izi ve yeniden hesaplama için kalır.
- `PATCH /invoice-lines/:id` `{ parseChecked: true | false }` → `200 { line, totals }`. Denetim kaydı: `invoiceLine.parseChecked`.
- `true` olan satır "Kontrol edilecek" sayısından, süzgeçten ve satır rozetinden çıkar. Panelde "Kontrol edildi" ve "Geri al" görünür.

### 11.6 Web

**Fatura yükleme, Adım 2 (sütun eşleme):**
- "Yapay zekâ ile eşle" düğmesi normalde ikincildir. `suggestAi` iken vurgulu olur ve üstünde bilgi bandı çıkar: "Otomatik eşleme bu dosyadan emin değil. Yapay zekâ ile eşlemeyi deneyin."
- Yükleniyorken bilgi bandı gösterilir (10–30 sn) ve seçimler kilitlenir: sütun seçimleri ile bütün eşleme seçenekleri (tarih sırası, ek ücret sütunları, "Tutarlar KDV dahil", KDV oranı, bileşenlerin KDV'si, desi).
  - Yapay zekâ bu bayrakları kendisi belirler; beklerken yapılan seçimi sonucu sessizce geri almasın diye kilitlidir, sonuç gelince değiştirilebilir.
  - "Bu eşlemeyi hatırla" açık kalır (sonuç onu değiştirmez).
  - Sonuçta uygulanan alan sayısı ve atılan başlık sayısı gösterilir.
- Her eşleme satırında: durum "Emin" · "Kontrol edin" · "Eşlenmedi" (yalnız zorunlu alan); kaynak "Kalıp", "Kayıtlı", "Yapay zekâ", "Siz"; gerekçeler küçük metin olarak; yapay zekâ seçiminde "Yapay zekâ: … (%93)".
- Fatura düzeyi sütunlar (fatura no, tarih, toplam) ayrı grupta eşlenebilir.
- **"Kontrol sonuçları" kartı:** takip no doluluğu, biçimi ve benzersizliği; ücret kalemleri; fatura toplamı farkı; sorunlu satır sayısı; açık sorunlar listesi; "Örnek satırları göster" (yalnız satır no + bayrak adı, tam satır dökümü yok).
- Elle yapılan her değişiklik `/preview/verify` ile tüm satırlarda yeniden kontrol edilir; değişen alanın kaynağı "Siz" olur.
- **İçe aktarma kapısı:**
  - Karar `check` ise "İçe aktar ve karşılaştır" doğrudan aktarmaz; "Eşleşmede sorun olabilir" penceresi açılır.
  - Pencerede alan gerekçeleri ve sorunlu satır sayısıyla en fazla 5 örnek listelenir.
  - "Geri dön ve düzelt" ana eylemdir ve varsayılan odak odur.
  - "Yine de içe aktar" uyarı biçimindedir. "Sorunları gördüm, yine de içe aktarmak istiyorum" işaretlenmeden etkin olmaz.
  - Sorun yoksa pencere açılmadan aktarılır. Sunucu `409 MAPPING_UNVERIFIED` dönerse (ekran eskiyse) aynı pencere sunucunun listesiyle açılır.
- **"Bu eşlemeyi hatırla":** sorunlu eşlemede varsayılan olarak işaretsizdir; işaretlenince "Bu eşleme sorunlu görünüyor" onay penceresi açılır ("yine de kaydedilsin mi?"). Kaydedilen eşleme yapay zekâdan gelen çiftleri, birimleri ve etiket sınıflarını da içerir; sonraki dosya yapay zekâ gerekmeden kayıtlı eşlemeyle açılır.

**Fatura detayı:** sert bayraklı ve kontrol edilmemiş satırlarda "Okuma kontrolü" rozeti; "Kontrol edilecek" sekmesi sayısıyla (sayı > 0 iken); satır panelinde bayraklar sade dille listelenir (yumuşaklar bilgi simgesiyle), yanında "Kontrol ettim" / "Geri al".
