# DeciShip SPEC — İtiraz takibi: kurallar ve API sözleşmesi

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

İtiraz takibinin (itiraz paketi, gönderme, sonuç girişi, geri alma, yeniden gönderme) bağlayıcı sözleşmesi. Web ve API bu dosyaya uyar; sözleşme değişecekse önce bu dosya değişir. Genel DeciShip kuralları: itiraz süresi §3.11, uç listesi §5.2 ve §5.11.

## Veri modeli (`deciship` şeması, hepsi `companyId` + RLS + bileşik FK)

- `Dispute`: fatura başına itiraz paketi, bir "tur". `invoiceId`, `round`, `sentOn` (date), `channel` (`EMAIL | PORTAL | OTHER`), `channelNote?`, `reference?` (taşıyıcı vaka no), `sentById`, `currency`, `claimedTotal`, `withdrawnAt?`, `withdrawnById?`, `withdrawReason?`, `supersededAt?`, `supersededById?`, `version`, zaman damgaları.
  - Faturada aynı anda tek etkin paket: kısmi tekil dizin `withdrawnAt IS NULL AND supersededAt IS NULL`.
- `DisputeLine`: paketteki satır. `invoiceLineId`, `trackingNo` (gönderim anındaki), `claimedAmount` (gönderim anındaki talep, değişmez), `outcome` (`PENDING | RECOVERED | REJECTED`), `recoveredAmount?`, `resultId?`, `measurementId?`.
  - `measurementId`: gönderim anında satırın bağlı olduğu ölçüm sürümü, değişmez; yabancı anahtar yok; kalıcı silme bu kanıtın fotoğraflarını korur (§5.13).
  - Kısmi geri alma = `RECOVERED` ve tutar talepten az; fark "eksik kalan" olarak görünür.
- `DisputeResult`: sonuç girişi. `kind` (`RECOVERED | REJECTED`), `creditNoteNo?`, `resultOn` (dekont veya ret tarihi), `reason?`, `enteredById`, `revertedAt?`, `revertedById?`, `revertReason?`. Bir dekont birden çok satırı kapsar.
- `DisputeResultLine`: girişin satır payları (`disputeLineId`, `amount`). Değişmez; geri alınan girişin geçmişi burada kalır.
- Silme yok. Geri çekme ve sonuç geri alma kayıtlıdır (kim, ne zaman, neden). Ayrıca `audit()` ile Merkez etkinlik akışına düşer.

## Kurallar

- Gönderme: faturadaki "İtiraz listesinde" (`VERIFIED`) ve talebi > 0 olan satırlardan paket oluşur (talep hesabı `buildDisputeText` ile aynı). Satır yoksa 400. Tam tanım: [itiraz-api.md](itiraz-api.md) "Doğrulama kuralları" › "Gönderilebilir satır".
- Paketteki satırın kararı değiştirilemez (409), paket geri çekilene dek. Etkin paketi olan fatura silinemez (409).
- Sonuç girme: yalnız `PENDING` satırlar. Geri alınan tutar 0 < tutar ≤ talep. Ret için neden zorunlu.
- Geri çekme: canlı `RECOVERED` satır varsa önce dekont geri alınır (409). Neden zorunlu.
- Yeniden gönderme: eski tur `supersededById` ile kapanır, yeni tur açılır; `RECOVERED` olmayan liste satırları yeniden talep edilir. Reddedilen itirazı tekrar gönderme yolu da budur.
- Her değiştirici istek `version` taşır; eski sürümle 409 `STALE`. Satır kilidi `SELECT … FOR UPDATE`.
- Para: fatura para birimiyle saklanır (`Decimal(14,2)`, hesap kuruş güvenli `toCents`). Para birimleri toplanmaz, para birimi başına toplam.
- TTK: gönderim tarihi TTK son gününe kadarsa "zamanında itiraz edildi", sonraysa "süre geçtikten sonra gönderildi". Gönderilmiş fatura süresi yaklaşanlar listesinden çıkar. Zincir kuralı: aşağıda "TTK".

#### Gönderilen = metin

- İtiraz metni (`GET /invoices/:id/dispute`), kanıt ZIP'i ve kaydedilen tur aynı satır kümesinden üretilir (`services/disputes.ts` `sendableLines`). Geçerli sonucu `RECOVERED` olan (parası gelmiş) satır metne de girmez.
- Metin ve fatura ayrıntısı bu kümenin özetini verir (`selectionDigest`):
  - Satır başına kimlik, takip no, talep kuruşu ve faturanın para birimi; kimliğe göre sıralı.
  - Sunucu anahtarlı HMAC-SHA256 (anahtar `FILE_TOKEN_SECRET`'tan türetilir). Özet fiyat izni olmayana da gider; anahtarsız özetten küçük faturanın talebi denenerek bulunurdu.
  - Metnin özeti metnin kendi satırlarından ve rakamlarından üretilir (metin ile özet hiçbir an ayrışmaz).
- "Gönderildi olarak işaretle" ve "Yeniden gönder" özeti geri gönderir. Fatura kilidi altında bugünkü kümenin özeti tutmazsa 409 `SELECTION_CHANGED`, hiçbir şey yazılmaz (metin alındıktan sonra listeye satır eklendi ya da çıktı, bir satıra sonuç girildi, talep, takip no ya da faturanın para birimi değişti).
- **Alan zorunludur:** özetsiz gönderme ve yeniden gönderme 400 `VALIDATION` (hiçbir istemci kümeyi görmeden işaretleyemez; tohum `currentSelectionDigest` ile alır).
- Web:
  - Metin penceresinden gelindiyse metnin kümesini (sayı, toplam, özet) gösterir ve taşır; 409'da kaydı kapatır, "İtiraz metnini yeniden al" der.
  - Etkin tur varken (gönderimden sonra listeye satır eklendi) metin penceresindeki işaretleme yeniden göndermedir (metin açıldığındaki turun sürümüyle).
  - Kartın düğmesinden gelindiyse kartta görünen kümeyi taşır.

#### Sonuç geri alma

- Giriş geri alınır, satırları `PENDING`'e döner. Fatura kilidi altında (gönderilecek küme değişir).
- **Önceki turdaki giriş:** yerini yeniye bırakmış (geri çekilmemiş) turdaki giriş de geri alınabilir, yeter ki girişin satırlarından hiçbiri sonraki (geri çekilmemiş) bir turda yeniden talep edilmemiş olsun; yoksa 409 `RESULT_LINES_RESENT`.
  - Pratikte bu yanlış girilmiş dekonttur (geri alınan satır yeni tura girmez; reddedilen satır girer).
  - Geri alınan satır eski turda sonuçsuz kalır ve geçerli satır sayılmaz ("geçerli satır"): itiraz listesine döner ("gönderilmemiş"), bir sonraki yeniden gönderimde yeniden talep edilir, doğru sonuç yeni turda girilir. TTK zinciri satırın ilk gönderimini korur.
  - Denetim kaydı `dispute.revert` `{ round, superseded: true, … }`.
  - Web: kartın "Diğer › Girişi iptal et" listesinde önceki turun girişi tur no ile çıkar; yeniden gönderilen tur geri çekildiyse (etkin tur yok) de.
- Geri çekilmiş turdaki girişi geri alma 409 `STALE`.

#### Fatura düzeyi toplamlar ("geçerli satır")

- Her fatura satırı için geri çekilmemiş en son turdaki itiraz satırı sayılır.
- Yeniden göndermede `RECOVERED` satırlar yeni tura girmez, eski turda kalır ve fatura toplamında geri alınan olarak sayılmaya devam eder.
- Yerini yeniye bırakmış turda `RECOVERED` ve `REJECTED` satır geçerlidir. Orada sonuçsuz (`PENDING`) kalan en son satır geçerli sayılmaz (önceki turdaki girişin geri alınması ya da yeniden gönderilen turun geri çekilmesi): satır "gönderilmemiş"tir, `unsentAmount`'ta sayılır, bekleyende sayılmaz; satırdaki `dispute` null olur.
- **Son cevabı red olan satır:** reddedilen satır yeniden gönderimde hep yeni tura girer; o tur geri çekilince yeniden talebi geri çekilmiştir ve taşıyıcının son cevabı reddir.
  - Satır reddedilen sayılır (`rejectedAmount`, satırda `dispute.outcome = 'REJECTED'`), gönderilmemiş sayılmaz; yine de gönderilecek kümede kalır (yeni turda yeniden talep edilebilir).
  - Bu yalnız fatura satırı hâlâ itiraz listesindeyken (`VERIFIED` + `DIFF`) geçerlidir: etkin tur olmadığı için satır kilitli değildir; kişi reddi kabul edip satırı listeden çıkarırsa (Uyumlu / Karar bekliyor) satır itiraz toplamından da çıkar, listeye dönünce yine reddedilen sayılır (core `effectiveDisputeLines` `listed`).
  - İtirazlar listesinde etkin turu olmayan faturanın "Gönderilmedi" öğesi yalnız gönderilmemiş satırlardan kurulur (son cevabı red olan satırlar girmez; hepsi öyleyse fatura listede çıkmaz, toplamı özetin reddedilenindedir).
- Aynı kural: core `effectiveDisputeLines`, `disputeFacts`, `lineDisputeStates`, Merkez `services/hub/metrics.ts`; `test/disputeSync.test.ts` dördünü karşılaştırır.
- İtirazlar özeti (`summary.byCurrency`) etkin turu olmayan faturanın geçerli satırlarını da sayar (Pano ile aynı). `DisputeRound.sums` yalnız o turun satırlarıdır.
- `GET /invoices` `disputeSums`, `InvoiceDispute.sums`, `DisputeListItem.sums` (SENT/CLOSED), Pano ve Merkez bu kuralla aynı rakamı verir. `DisputeListItem.lineCount/resolvedCount` de geçerli satırlar üzerinden.

#### TTK

- `DisputeRound.ttk` ve `DisputeListItem.ttkStatus` satır başına hesaplanır.
- Zincir: tur ve yerini bıraktığı önceki turlar (geri çekilen tur zincire girmez; geri çekildikten sonra açılan tur kendi gününe göre).
- Turdaki her satırın taşıyıcıya ilk bildirildiği gün = zincirde o satırı içeren en erken `sentOn`; TTK'ya esas gün bu günlerin en geçi (`DisputeRound.ttkSentOn`, `DisputeListItem.ttkSentOn`).
- Fatura sayfasındaki "zamanında itiraz edildi (gün)" satırı ve İtirazlar listesinin taşıyıcı süresi bu günü kullanır, son yeniden gönderimin gününü değil.
- Süresinde gönderilip süre geçtikten sonra yeniden gönderilen satır zamanında kalır; gönderimden sonra listeye eklenip ilk kez süre geçtikten sonra gönderilen satır turu `LATE` yapar.
- `ttkStatus` yalnız gönderilenleri anlatır: gönderilmemiş satırı olan faturada (`unsentLineCount > 0`) web "zamanında" demez, süreyi (sayaç ya da "süre geçti") gösterir.

## Gönderilmiş itirazda hesap kilidi

Talep gönderildiği rakamlarla yazıldı; etkin tur varken bu rakamların dayanağı değişmez. Genel dondurma kuralı §3.14. Hepsi fatura kilidi altında kontrol edilir (itiraz gönderimiyle aynı kilit); önizlemede ve onayda ayrı ayrı.

- **Etkin turdaki satır donar.** Hiçbir yeniden hesap yolu (otomatik ya da kullanıcının başlattığı, `scope: 'all'` dahil) sonucunu yazmaz. Yeni sonuç farklı çıkarsa satır `recalcPending` ile işaretlenir; talep ve kayıtlı rakam aynı kalır.
- **Yeni ölçümle hesaplatmak için önce itiraz geri çekilir;** onay yetmez. `POST /invoices/:id/recalculate/preview` ve `POST /invoices/:id/recalculate`: `lineIds` içinde etkin turdaki satır varsa 409 `LINE_IN_DISPUTE` (ileti `line.inDispute`).
- **Fatura başlığı:** `PATCH /invoices/:id` `carrierId`, `tariffId`, `invoiceDate` ya da `currency` değiştiriyorsa 409 `INVOICE_HAS_DISPUTE` (ileti `invoice.hasDisputeLocked`: "taşıyıcı, tarih, tarife ve para birimi itiraz geri çekilene dek değişmez").
  - Önizleme `token`'ı eksik olsa da önce bu denetlenir. İtiraz kontrolü, güncelleme ve denetim kaydı tek işlemde. `invoiceNo` ve dönem serbest.
- **Yeni tarifeyle / yeni ayarla hesaplama:** `recalculate/preview` ve `recalculate` `basis: 'tariff'` ya da `basis: 'rules'` ya da önizlemede `patch` ile 409 `INVOICE_HAS_DISPUTE`. `basis: 'pinned'` serbest: etkin turdaki satırlar yazılmaz, önizlemede `skippedInDispute` olarak sayılır.
- **Dayanaksız faturada tarife benimseme de kilitlidir:** etkin turu olan dayanaksız faturada `basis: 'pinned'` + tümü ve `POST /invoices/:id/recompare` bugünkü tarifeye bağlanmaz; hesap faturanın kendi (tarifesiz) dayanağıyla yapılır. İtiraz önizlemeden sonra gönderildiyse onay 409 `PREVIEW_STALE` olur (fatura kilidi altında yeniden denetlenir).
- **Önizlemesiz yeniden karşılaştırma** (`POST /invoices/:id/recompare`) reddetmez; etkin turdaki satırları yazmaz.
- **Toplu geçişler** (`POST /tariffs/:id/recompare-invoices`, `POST /settings/recompare-invoices`) reddetmez: etkin turu olan faturayı atlar ve sayar (önizlemede `skippedInDispute`, onayda `skipped.inDispute`).
- **Otomatik yollar** (ölçüm değişikliği, bakım işi, mükerrer zinciri, satır düzeltmesinin fatura geneli hesabı) hata vermez; etkin turdaki satır donmuş sayılır.
- **Satır düzeltmesi:** `PATCH /invoice-lines/:id` karar, takip no ve ölçüm eşleşmesi için 409 `LINE_IN_DISPUTE`; not ve "Kontrol ettim" serbest. Not yazmak ya da silmek hiçbir satırda hesap yapmaz: rakam ve işaret aynı kalır (§3.14 "Satır düzeltmesi ve not").
- **Gönderim uyarısı:** gönderilecek satırlardan yeniden hesap bekleyenlerin sayısı `InvoiceDispute.recalcPendingLines`. Gönderimi engellemez; web göndermeden önce uyarır: itiraz metni penceresinin üstünde (satırları süzgeçte gösteren bağlantıyla) ve işaretleme penceresinde.

## İtiraz metni ve kanıt

Kod: core `dispute.ts` (`buildDisputeText`), API `services/evidence.ts` (`loadDisputeDraft`, `renderDisputeText`, `streamEvidenceZip`), `lib/zip.ts`. Testler: core `mesaj5`, `dispute`; API `evidenceZip`, `disputes`.

- **Tek satır kümesi.** `GET /invoices/:id/dispute` metni ve kanıt ZIP'i aynı satırlardan, aynı sırayla üretilir: "İtiraz listesinde" (`VERIFIED`) olup `buildDisputeText`'in süzdüğü (`isDisputable`) ve geçerli sonucu `RECOVERED` olmayan satırlar; gönderme ve yeniden gönderme de bu kümeyi kaydeder (`sendableLines`). Metindeki "3)" satırının fotoğrafları ZIP'te "03-…" adını alır.
- **Ölçümümüz.** Metindeki ölçü ve ağırlık yalnız canlı (silinmemiş, aynı firmadaki) ölçümden yazılır; ölçüm silindiyse satırda yalnız ücretli ağırlık kalır.
- **Kanıt satırı.** Her satırın altında `Ölçüm kaydımız: 21.10.2026 14:32 · depo çalışanımız tarafından · ölçü: elle (metre), ağırlık: terazi ekranından okundu` (zaman firmanın saat diliminde; core `DisputeLine.evidence = { measuredAtLocal, dimMethod, weightMethod, photoCount }`); fotoğraf varsa `Fotoğraf: N`. Mükerrer satırda kanıt yazılmaz.
- **Ölçen kişinin adı kargo firmasına giden metne girmez** (kullanıcı kararı): yalnız rol ("depo çalışanımız"), zaman ve yöntem. Ad yalnız firmanın kendi Excel raporunda ("Ölçen" sütunu); PDF raporunda da yoktur.
- **Desi** (KALANLAR 1.12): faturanın tarife sürümünün böleni 3000 ise (sürüm yoksa yurt içi taşıyıcı kodu, `isDomesticCarrier`) ücretli ağırlığın birimi her taraf için ayrı seçilir (core `chargeableUnitOf`, tarifenin bölen ve kenar yuvarlamasıyla): hacimsel desi belirlediyse "ücretli 12 desi", gerçek ağırlık büyükse "ücretli 10 kg", ölçü ya da gerçek ağırlık yoksa "ücretli 5 desi/kg" (core `DisputeInput.invoice.chargeUnit`, API `disputeChargeUnit`); gerçek ağırlık kg kalır.
- **İmza** (KALANLAR 1.12): ad, firma, varsa `E-posta: …` ve `Tel: …` (EN `Email:`, `Phone:`; +90 cep numarası gruplu). DeciShip kişinin iletişim bilgisini saklamaz: web Merkez hesabındakini (`person.phone`; `person.email` yalnız `emailVerified` ise) metin ve ZIP isteğine `X-Signature-Email` / `X-Signature-Phone` başlığıyla (`encodeURIComponent`) ekler, adreste değil; sunucu biçimi bozuk, uzun ya da satır sonlu değeri yazmaz (`services/evidence.ts` `signatureContact`). Yoksa imza ad ve firma.
- **Kapanış.** Fotoğraf varsa "Ölçüm fotoğraflarımız (N adet) ekteki ZIP dosyasındadır." ve "Yukarıdaki tutarlar için alacak dekontu düzenlenmesini rica ederiz." (`dispute.photosAttached`, `dispute.closingCredit`); yoksa kısa kapanış (`dispute.closing`).

#### KDV hariç ve KDV dahil (kullanıcı kararı)

- Faturanın KDV oranı biliniyorsa satırdaki faturalanan tutarın ardından ` · KDV dahil (%20): 132,97 ₺` (EN ` · incl. VAT (20%): 132.97 TRY`; mükerrer satırda da).
- Toplamda `Toplam talep edilen düzeltme: KDV hariç X, KDV dahil (%20) Y` (EN `Total requested correction: X excl. VAT, Y incl. VAT (20%)`; `dispute.vatIncluded`, `dispute.totalVat`).
- Satır başına talep satırı ve kaydedilen tur KDV hariç kalır.
- Yuvarlama: KDV dahil tutar KDV hariç tutardan kuruşa yarım-yukarı yuvarlanır (core `withVat`); toplamınki toplamdan hesaplanır (satırların KDV dahil toplamı değil, 1 kuruş farkedebilir). KDV dahil tutarlar hesaplanmıştır: faturada basılı KDV dahil tutardan 1 kuruş farklı olabilir (taşıyıcı KDV'yi başka adımda yuvarlamış olabilir).
- Oran (`invoiceVatPct`, `services/evidence.ts`, saklanan `Invoice.mapping`'den):
  - Tablo faturası "Tutarlar KDV dahil" ile eşlendiyse eşlemenin `vatPct`'i.
  - PDF faturada önizleme kaydının `invoiceVatPct`'i: belgede oran KDV sözcüğünün yanında yazıyorsa o, yazmıyorsa yalnız tutarlar KDV dahil okunduysa %20; KDV belirsizse yok (`knownPdfVatPct`). İçe aktarmada eşlemeye `{ source: 'ai', vatPct }` diye yazılır.
  - Oran yoksa ya da 0 ise metin yalnız KDV hariç.
- Web itiraz penceresinin özet satırı `totalInclVat` gelince "talep X KDV hariç, Y KDV dahil" yazar.

#### Metin yanıtı

- `{ subject, body, lineCount, total, vatPct?, totalInclVat?, photoCount, linesWithoutPhoto, selectionDigest }` (`vatPct`, `totalInclVat` yalnız oran biliniyorsa).
- `photoCount` yalnız metne giren, mükerrer olmayan satırların fotoğraflarıdır. `selectionDigest` metnin kümesinin özetidir ("Gönderilen = metin").
- Fiyat izni olmayana 403 (metin tutar taşır).
- Web `linesWithoutPhoto > 0` ise "Ekler" satırında "N satırda fotoğraf yok" yazar.

#### Kanıt ZIP'i: `GET /invoices/:id/dispute/evidence.zip?lang=tr|en`

- İzin `deciship.data.export`; ayrıca `prices.view` ve `measurements.view_all` yoksa 403 `FORBIDDEN` (bugünkü rollerde dışa aktaran herkeste ikisi de var). Uzun akış olduğu için `limited(..., 'export')` havuzunda; `routeRules.ts` satırı `EXPORT_PRICED` + `measurements.view_all`.
- İçerik: `00-itiraz-metni.txt` (EN `00-dispute-letter.txt`; konu + gövde) ve fotoğraflar `NN-<takipNo>-<kutu|tarti|etiket|diger>-<n>.<uzantı>` (EN box/scale/label/other). Dosya adı `itiraz-kanit-<faturaNo>.zip` (EN `dispute-evidence-…`). Arşiv içi adlar kullanıcı girdisinden türetilmez; uzantı sunucunun kaydettiği türden.
- Mükerrer satırın fotoğrafı konmaz (metindeki "N adet" tutsun diye). ZIP'teki mektupta fotoğraf sayıları ZIP'in gerçek içeriğine göre yazılır.
- Diskte bulunamayan ya da depo dışını gösteren dosya atlanır. Not mektuba girmez; yalnız eksik varsa ayrı iç not `01-eksik-dosyalar.txt` / `01-missing-files.txt` (satır no, takip no, beklenen dosya adı).
- Sınırlar: en çok 1.000 fotoğraf ve 500 MB (akış başlamadan, diskteki gerçek boyutla) → 413 `EVIDENCE_TOO_LARGE`; akış sırasında dosya büyürse akış kesilir. Listede satır yoksa 400 `NO_VERIFIED_LINES`.
- Biçim: sıkıştırmasız, akışlı ZIP (`lib/zip.ts`, CRC `zlib.crc32`, yeni bağımlılık yok, ZIP64 yok); giriş tarihleri firmanın saat diliminde.
- Herkese açık ya da süreli bağlantı yoktur (kullanıcı kararı): kullanıcı dosyayı indirir, e-postaya kendisi ekler.
- Firma sınırı: her sorgu firma bağlamında (RLS) ve ayrıca açık `companyId` süzgeciyle; başka firmanın ölçümü ya da dosyası satıra bağlı görünse bile alınmaz.
- Web: itiraz penceresinin "Ekler" satırında, `photoCount > 0` ise "Fotoğraflar (ZIP)" (aşağıda "İtiraz penceresi ve e-posta taslağı").
- **Fotoğraf sayısı tek kuraldan:** fotoğraf ancak dosyası diskte, firmanın kendi klasöründe (`<companyId>/…`) ve üst verisi temizlenebiliyorsa vardır.
  - Kayıtlı fotoğraf 1.000'i ya da 500 MB'ı aşarsa pencere diske bakmaz, kayıt sayısını yazar (ZIP zaten 413).
  - İtiraz penceresindeki metin ve sayılar (`GET /invoices/:id/dispute`: `photoCount`, `linesWithoutPhoto`, satırdaki "Fotoğraf: n") ile ZIP aynı işlevi kullanır (`services/evidence.ts` `locateEvidencePhotos`); ZIP'teki mektup penceredeki metinle aynıdır.
- **Üst veri:** fotoğrafların üst verisi (konum, cihaz, C2PA) sunucuda kaydederken kalkar; yön korunur (§5.5). ZIP her fotoğrafı girerken yeniden temizler (saklanan dosya değişmez). Temizlenemeyen fotoğraf (okunamayan yapı, HEIC) ZIP'e girmez, `01-eksik-dosyalar.txt` iç notunda ayrı başlıkla yazılır ("konum ve cihaz bilgisi temizlenemedi"); pencere de onu saymaz.

## İtiraz penceresi ve e-posta taslağı

Kod: web `invoice-detail/DisputeDialog.tsx`, saf yardımcılar `src/lib/disputeMail.ts` (test `test/dispute-mail.test.ts`). Metin `GET /invoices/:id/dispute`'tan gelir.

- **Uzun metin:** kodlanmış `mailto` adresi 1.800 karakteri (`MAILTO_MAX`) aşarsa metin uzun sayılır. O zaman üstte tek satır uyarı çıkar, "Kopyala" birincil olur, "E-posta ile aç" ikincile iner ve e-posta uygulamasına yalnız konu ile kısa bir giriş gider (`dispute.mailShortBody`, mektubun dilinde): kullanıcı metni kopyalayıp yapıştırır. Kısa metinde tam metin gider.
- **Dil değişimi:** konu ya da metin sunucudan yüklenenden farklıysa (kullanıcı düzenlediyse) dil düğmesi pencere içinde satır içi onay ister ("Dili değiştir · Vazgeç"); ikinci pencere açılmaz. Vazgeçilirse düzenlenen metin kalır.
- **Ekler satırı:** "E-postaya ekleyin: Fotoğraflar (ZIP)", yalnız fotoğraf varsa. Kargoya yalnız ona yönelik olan gider (metin + ZIP; KALANLAR 1.11): fark raporu (Excel/PDF) iç rapordur (ölçen çalışanın adı, iç not, kararlar, lehimize farklar), pencerede önerilmez; fatura sayfasından indirilir. Dosyaları kullanıcı indirip e-postaya kendisi ekler (herkese açık bağlantı yok).
- **Taşıyıcı e-postası** yalnız tarayıcıda hatırlanır (`deciship.disputeEmail.<firma>.<taşıyıcı>`), sunucuda saklanmaz.

## Toplu karar ve itiraz

Sözleşme §5.8 "Toplu karar" (`POST /invoices/:id/lines/decide`). İtirazla ilgili kurallar:

- Etkin itiraz turundaki satıra toplu kararın hiçbir kipinde dokunulmaz; sayılır (`skipped.inDispute`). Etkin tur `activeRoundWhere` ile, kilit altında okunur (gönderimle aynı fatura kilidi).
- "İtiraz listesine ekle" (`VERIFIED`) toplu olarak yalnız talebi sıfırdan büyük satıra uygulanır: itiraz metnine girecek satır kuralıyla aynıdır (`isDisputable`); talebi sıfır olan `noClaim` sayılır. "İncele" işaretli satır toplu olarak listeye girmez (`review`) ama uyumlu sayılabilir. Tek satırlık `PATCH /invoice-lines/:id` de aynı kuralı uygular: talebi sıfır satır 409 `NO_CLAIM` alır.
- Toplu "Geri al" yalnız o işlemde kişinin kendi verdiği kararı açar; arada başkasının verdiği karar kalır (`changedSince`).

## İtiraz süresi hatırlatması

Kurallar §5.14. Kısaca:

- Türkiye'deki firmada, fazla ödemesi olan ve itirazı gönderilmemiş faturalar için TTK son gününe 3 ve 1 gün kala, firmanın saatiyle 09:00–19:00 arasında, itiraz yetkisi olan kişilere (Yönetici, Muhasebe) firma başına günde tek özet e-posta gider; postada tutar yazmaz.
- Etkin itiraz turu olan fatura özete girmez; itiraz gönderilince fatura listeden çıkar. Ancak gönderimden sonra listeye eklenip henüz gönderilmemiş satırı olan (etkin turlu) fatura özete yine girer (`unsentAfterSend`); çok faturalı postanın bağlantısı (`?status=TO_DISPUTE`) bu faturayı göstermez, satırda adı yazar.
- Ayar `disputeReminders` (DeciShip › Ayarlar, varsayılan açık). Postayı Hesap servisi gönderir (`ARCHITECTURE.md` §6 "Araç bildirimi").

## Durumlar

- Fatura: `NONE` (İşlendi), `SENT` (İtiraz gönderildi, bekleyen satır var), `CLOSED` (Kapandı, bütün satırlar sonuçlu; geri alınan tutar yazılır).
  - Etkin tur yoksa `NONE`; etkin turda sonuçsuz satır varsa `SENT`, yoksa `CLOSED`. Etkin tur = geri çekilmemiş ve yerine yenisi gelmemiş tur.
- İtirazlar sayfasında ayrıca "Gönderilmedi": listede satırı olup paketi gönderilmemiş fatura (süre sayaçlarıyla).

## Uç noktalar

- `GET /disputes?status=&carrierId=&q=&page=&pageSize=`: faturalar arası liste + para birimi başına toplamlar (itiraz edilen, bekleyen, geri alınan, reddedilen, eksik kalan) + süresi yaklaşanlar.
- `GET /invoices/:id` yanıtına `dispute` (etkin tur, satır sonuçları, geçmiş turlar ve girişler) eklenir.
- `POST /invoices/:id/disputes` (gönder), `POST /disputes/:id/withdraw`, `POST /disputes/:id/resend`, `POST /disputes/:id/results`, `POST /dispute-results/:id/revert`.
- `GET /invoices` öğelerine `disputeStatus` ve `disputeSums`.
- `GET /dashboard`, Merkez `overview`/`analytics`/`datasets`: "geri alınan" ve "itirazda bekleyen". Ay ataması fatura ayına göre (Pano ile aynı küme).

## İzinler

- İzin `deciship.disputes.manage` (yazma izni, salt okur abonelikte kapalı): ADMIN ve ACCOUNTING. AUDITOR listeyi hazırlar (mevcut `lines.decide`), göndermez. Görme: `invoices.view`; tutarlar `prices.view` ister.
- İzin `permissionMatrix` ve `routeRules` içindedir.

## API sözleşmesi

Tipler (`DisputeRound`, `InvoiceDispute`, `DisputeListItem` …), değiştirici istek gövdeleri, yanıt biçimleri, doğrulama kuralları, hata kodları, `GET /disputes` sayım ve sırası, Merkez/Pano alanları, para anahtarları ve web'e özgü kurallar: [itiraz-api.md](itiraz-api.md). "Geçerli satır" ve "TTK" kuralları bu dosyada ("Kurallar" altında).
