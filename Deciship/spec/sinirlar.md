# DeciShip SPEC — Yük ve maliyet sınırları (§5.12)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

### 5.12 Yük ve maliyet sınırları

Ortam değişkenleri ve varsayılanları: `Platform/docs/KURULUM.md`. Kararlar: `Platform/docs/KARARLAR.md`.

#### Yapay zekâ sayacı

`services/aiMeter.ts`. Bütün çağrılar `meteredCall` üzerinden geçer; `structuredCall`'ı yalnız bu dosya çağırır.

- **Türler:** `SCALE_READ` (tartı), `INVOICE_PDF`, `INVOICE_MAPPING`, `TARIFF_PDF_DISCOVER`, `TARIFF_PDF_EXTRACT`, `TARIFF_REVIEW`.
- **Satır:** her çağrı firmanın şemasında bir `AiUsage` satırı yazar: token (girdi, çıktı, önbellek), süre, model, tür, kişi, durum (`OK`, `FAILED` + hata kodu, `CACHED`) ve tutar.
- **Tutar** = sağlayıcının liste fiyatı (`@sellerondata/contracts` `AI_LIST_PRICES_USD`, `AI_PRICE_TABLE` ile ezilir) × `AI_PRICE_TRY_PER_USD`; mikro TL tamsayıyla hesaplanır.
  - Liste fiyatı Anthropic'in resmî fiyat sayfasındandır; tablo kaynağını ve okunduğu tarihi yazar. Haiku 5.5 istem uzunluğuna göre iki kademelidir (100.000 token üstü istek üst fiyattan).
  - Fiyat tablosunda olmayan model (istenen ya da yanıtı veren) en pahalı fiyattan sayılır: etkin tablonun (liste + `AI_PRICE_TABLE` ezmesi) her kaleminin en yüksek değeri, kademeli fiyatın üst kademesi dahil (contracts `mostExpensiveAiPrice`).
- Ek kredi defteri `AiCreditEntry` (destek komutu `npm run ai:grant`).
- **Dönem:** firmanın saat dilimine göre takvim ayı. Aylık ücretsiz hak: abonelik limitindeki `aiCreditMonthly`, yoksa `AI_FREE_CREDIT_MONTHLY_TRY` (2.500); limit `false` ya da `0` ise hak yok.

**Denetim sırası:**
1. Anahtar yok → 503 `AI_DISABLED`.
2. Kişi başı dakika sınırı (tartı 30, PDF 6, diğer 10; `AI_RATE_SCALE_PER_MIN`, `AI_RATE_PDF_PER_MIN`, `AI_RATE_OTHER_PER_MIN`) → 429 `TOO_MANY_REQUESTS` + `retry-after`.
3. Önbellek isabeti (yalnız PDF fatura, sütun eşleme, tarife PDF tarama ve okuma; 30 gün, aynı firma, `?fresh=1` atlar) → `CACHED`, ücretsiz.
4. Aynı firmada aynı girdi sürüyorsa onun sonucu beklenir.
5. Kota denetimi.
6. Firma başına aynı anda 2 çağrı (tartı ayrı yuva grubunda) → 429 `TOO_MANY_REQUESTS`.
7. Sağlayıcı çağrısı; satır yazımı.

**Kota:** kullanılan ≥ hak + ek kredi → 429 `AI_QUOTA_EXCEEDED`. Yanıtta tutar yok, yalnız yeni dönemin tarihi (ölçüm rolüne para bilgisi gitmez). Sınır yumuşaktır: aşım en çok firma başı eşzamanlı çağrı kadar. `AI_QUOTA_ENFORCED=false` sayar ama durdurmaz.

**%80 postası** (`services/aiQuotaNotice.ts`): ücretli çağrıdan sonra kullanılan hakkın %80'ine ulaştıysa ayar yetkililerine (`deciship.settings.manage`: firma sahibi ve Yönetici) ayda en çok bir posta; Hesap servisinin `/internal/notify` ucu, tekrar anahtarı `ai-quota-80:<dönem>`. Yalnız hak uygulanıyorsa ve hak > 0. Kalıcı işaret denetim kaydında (`ai.quotaNotice`); gönderim kabul edilmezse (alıcı yok, ağ hatası) işaret yazılmaz, bir saat sonra gelen ücretli çağrı yeniden dener. Ay dönmüşse eski dönemin postası gitmez. Tutar yok, yalnız yüzde ve yeni hakkın tarihi; TR + EN.

#### Sistemin günlük tavanı

`services/aiDailyBudget.ts`; kapalı deneme kararı.

- **Toplam:** bütün firmaların bugünkü `AiUsage` tutarlarının toplamı. Durum ayrımı yok: ücret doğmuş `FAILED` sayılır, `CACHED` 0.
- **Ret:** toplam `AI_DAILY_BUDGET_TRY`'ye (TL, varsayılan 1.000) ulaşınca yeni sağlayıcı çağrısı sağlayıcıya gitmeden, satır yazılmadan 429 `AI_DAILY_BUDGET` alır: "Yapay zekâ bugün için durduruldu; yarın yeniden açılır. Elle giriş ve Excel/CSV yükleme çalışır." (`details.resetsAt` yalnız; tutar yok).
- Firma kotasından önce bakılır. Firmanın hakkı ve `/me` `ai` alanı değişmez: `available` "yapılandırıldı" demektir, tavan dolunca da `true`; `quotaExhausted` yalnız firmanın kotasıdır.
- **Gün:** sistem günü, Europe/Istanbul takvim günü (`createdAt` o günün içinde; firmanın saat dilimi değil).
- Önbellek isabeti ve tek uçuşta bekleyen ikinci istek ücretsiz döner.
- **Değer:** yalnız `off` (büyük/küçük harf fark etmez) tavanı kapatır (açılışta uyarı); boş ya da tanımsız varsayılandır; `0` hiç yeni çağrı yaptırmaz; başka değer (eksi, `1e3`, `false`…) açılışı durdurur.
- **Okuma:** toplam en çok 10 sn'de bir veritabanından okunur (`app.scope = 'ai_budget'`: yalnız `AiUsage`, yalnız okuma, yalnız son 2 gün); arada bu sürecin çağrıları artımlı eklenir.
- **Pay ayırma:** sonucu beklenen her çağrı kendi üst sınırı kadar pay ayırır (`aiCallUpperMicros`: `maxTokens` × çıktı fiyatı + istek boyundan tahmini girdi, bayt / 2 + 1.000 token, en çok 200.000 token, girdi ya da önbelleğe yazma fiyatından büyüğüyle; istenen modelin fiyatı). Sonuç gelince pay bırakılır, gerçek tutar eklenir.
  - Örnek (Sonnet 5.5, kur 100): 100 KB'lık PDF grubu (64.000 çıktı) ~81 TL, sütun eşleme (16.000) ~16 TL.
- **Kesin ve geçici ret:** harcanan tavana ulaştıysa kesin ret (`AI_DAILY_BUDGET`). Harcanan altında ama süren çağrıların payıyla doluyorsa geçici 503 `AI_BUSY` ("biraz sonra yeniden deneyin", `retry-after` 15 sn; arka plan işi beklemeyle yeniden dener).
- **Aşım:** tek kopyada en çok bir çağrının üst sınırı (ölçülen: 100 TL tavan, aynı anda 60 × 12,10 TL çağrı → 9 geçer, 108,90 TL). Birden çok kopyada her kopya ötekilerin son 10 sn'lik harcamasını görmez: aşım ≤ ötekilerin son 10 sn harcaması + kopya başına bir çağrının üst sınırı. Sağlayıcının istenenden pahalı yedek modele düşmesi üst sınırın dışındadır.
- Tavan reddi (kesin ya da geçici) kişinin dakika hız sınırı hakkından düşmez.
- **Açılış denetimi:** tavan `off` değilse `AiUsage.ai_budget_read` ilkesi aranır; yoksa (göç uygulanmamış: toplam sessizce 0 görünürdü) servis açılmaz (`lib/schemaCheck.ts`).
- **Arka plan işi:** tavan bu süreçte ilk dolduğu andan önce açılmış işin çağrıları tavanın %20 üstüne kadar sürer; sonra o iş de `FAILED` `AI_DAILY_BUDGET` olur, iletisi kullanıcıya gösterilen metnin aynısı.
  - Bilinçli olarak kendiliğinden yeniden denenmez ve ertesi gün kendiliğinden sürmez: kullanıcı yeniden başlatır, okunmuş parçalar önbellekte (ücretsiz).
  - Sonra açılan iş başlatılabilir ama önbellekte olmayan ilk çağrıda aynı hatayla durur.
- **Günlük:** tavan o gün bu süreçte ilk dolduğunda `error` düzeyinde tek satır `ai-daily-budget-reached`. Destek komutu `npm run ai:usage` günün toplamını ve tavanı yazar (`DAILY-BUDGET-FULL`).

#### Sonuç vermeyen çağrı

- `FAILED` (kesilme, ret, bozuk biçim, süre dolması) gerçek token ve maliyetle yazılır ama kotadan düşmez (kota yalnız `OK` satırlarını toplar).
- **Vazgeçme:** kullanıcı süren okumayı durdurursa (arka plan işinde iş iptali) çağrı sağlayıcıda kesilir: `FAILED` `AI_CANCELLED`, `estimated`. Kesilen isteğin son sayısı gelmez, bilinmeyen kısım fazla sayılır: girdi sağlayıcının sayısı ya da istek boyundan üst tahmin, çıktı en az geçen saniye × 110 token (en çok `maxTokens`). Hakka sayılmaz; sonuç vermeyen çağrı tavanına ve sistemin günlük tavanına sayılır. Hatırlanmaz (hemen yeniden başlatılabilir). İstek sağlayıcıya gitmeden gelen vazgeçme satır yazmaz.
- **Ayrı aylık tavan:** bu çağrıların maliyeti için hak × `AI_FAILED_BUDGET_RATIO` (1). Dolunca yeni çağrı 429 `AI_QUOTA_EXCEEDED`, `details.reason: 'failed_budget'`, ayrı metin.
- **Hatırlama:** aynı içerik (firma + tür + içerik özeti) için ücret doğmuş sonuçsuz çağrı 30 dk hatırlanır: kesilme, ret ve toplam süre dolması (`AI_CALL_MAX_MS`; akış başlamıştır, kullanım görünmese de ücretli sayılır).
  - Dil ve `fresh` atlatmaz; sağlayıcı çağrılmadan aynı kod döner, `details.retryAfter` ve `retry-after` başlığı kalan süre (sn).
  - Metin, kesilme ve ret için: nedenin kendi önerisi (dosyayı bölün, başka dosya) + "Aynı içerik az önce de okunamadı; aynısını yeniden göndermek sonucu değiştirmez" (yeniden denemeye çağırmaz).
  - Metin, süre dolması için: "Yapay zekâ bu içeriği az önce zamanında okuyamadı; N dakika sonra yeniden deneyebilirsiniz".
  - Arka plan işinde ayrıca: aynı iş içinde aynı içerik (önbellek anahtarı) kesildi ya da reddedildiyse (`FAILED` satırı, işin oluşturulmasından 1 dk öncesinden bu yana) süreç belleği olmasa da (başka kopya, yeniden başlama, 30 dk'yı aşan bekleme) yeniden gönderilmez (`jobs/jobScope.ts`).
- **Hatırlanmayanlar:** sağlayıcının ücretsiz geçici hatası: aşırı yük (529) ve sağlayıcı hız sınırı (429) → 503 `AI_BUSY`, ulaşılamadı → 503 `AI_FAILED`, bağlantı zaman aşımı (yanıt hiç başlamadı) → 504 `AI_FAILED`, sağlayıcının sunucu hatası (5xx) → 502 `AI_FAILED`; ikinci deneme sağlayıcıya gider. Bozuk biçim de hatırlanmaz.
- **Tahmini kullanım:** kopan akışta ya da süre dolunca çıktı tokeni akan metinden tahmin edilir (karakter / 3,5, alt sınır). Satır `AiUsage.estimated` ile işaretlenir (günlükte `ai-meter-usage-estimated`), token ve tutarıyla aynen sayılır.
- **Sayaç yazılamazsa** sonuç yine döner (günlükte `ai-meter-write-failed`). Aynı firmada art arda 3 yazım hatasında o firmanın yeni sağlayıcı çağrıları 5 dk 503 `AI_BUSY` alır (`retry-after` kalan süre). Arka plan işi için geçicidir (§5.13): sağlayıcı çağrılmadığı için ücret yok, iş sigorta kapanınca sürer.

#### İstek boyu ve istemler

- **İstek boyu:** sağlayıcıya gidecek istek (base64 belge + metin + istem payı) 32 MB'ı (`AI_MAX_REQUEST_BYTES`) aşıyorsa çağrı yapılmaz, ücret satırı yazılmaz: 413 `FILE_TOO_LARGE`, `details: { kind: 'aiRequest', limitMb: 32 }`. PDF'te metin: "PDF yapay zekâ için çok büyük; daha düşük çözünürlükle tarayın ya da dosyayı bölerek yükleyin". Önbellek ve hatırlama bu denetimden önce gelir (ücretsiz).
- **Geçersiz anahtar** (401): kullanıcıya 503 `AI_DISABLED` genel metin, günlüğe `error` `ai-key-invalid`.
- **İstemler:** eşleme (`INVOICE_MAPPING`) ve tarife incelemesi (`TARIFF_REVIEW`) istemleri belgedeki metnin veri olduğunu, talimat olmadığını söyler.
  - "in Turkish" demez; "Output language: Turkish, unless the last line … names another language" der. İngilizce istekte `withOutputLanguage` satırı dili açıkça söyler; Türkçe istemde satır eklenmez.
  - Tarife incelemesinde firma profili sabit "Türkiye çıkışlı ihracatçı" değildir: `company.country` (`firmCountry`; bilinmiyorsa null, istem Türkiye varsayar) ve bu taşıyıcının son faturalarının varış ülkelerinden `recentShipments` (`domestic` / `international` / `both` / `unknown`).
  - `INVOICE_MAPPING` önbellek anahtarı istemi içerir (istem değişince eski kayıt ıskalanır, yanlış sonuç döndürmez); `TARIFF_REVIEW` önbelleğe girmez.

#### Merkez kullanım ekranı

- **Özet:** `GET /platform/ai-usage[?period=YYYY-MM]` (`settings` izni; en çok 12 ay geri) → `HubAiUsage` (`contracts/src/hub.ts`).
  - Alanlar: dönem, `resetsAt`, `freeAmount`, ek kredi, kullanılan, `usedPct`, token, işlem, süre, önbellekten sayısı, türlere göre döküm, tahminli işlem sayısı (`estimatedCalls`) ve kişi başına döküm (`byMember`: işlem, önbellekten, token, tutar).
  - Kişi dökümü token sırasıyla gelir, tutar sırasıyla değil (fiyat izni olmayana maliyet sırası sızmasın); silinmiş kişinin satırları tek "Kişi bilinmiyor" satırında.
  - Para alanları (`*Amount`, `byKind[].amount`, `byMember[].amount`) fiyat iznine bağlı.
  - Ayrıntılı döküm için ayrıca: sonuç dağılımı (`statusCounts`: başarılı, okunamadı, yarıda kaldı, başarısız), geçen ayın aynı süresi (`previous`; bu ay seçiliyse geçen ayın başından bugünkü ana kadar, geçmiş ayda önceki ayın tamamı) ve seçilebilir aylar (`months`, `firstPeriod`: 12 ay geri, firmanın açıldığı aydan önce değil).
- Merkez → Abonelik'teki kart bunu çizer ("Ayrıntı" altında tür ve kişi tabloları; tahminli işlem varsa tek satır not).
- **Döküm:** `GET /platform/ai-usage/calls?period=&kind=&member=&page=&pageSize=` (`settings` izni, `HubAiCallPage`; en yeni önce, sayfa 50, en çok 200; `member=none` silinmiş kişi; önceki sonuçtan gelen ücretsiz işlemler listede yok).
- **Excel:** `GET /platform/ai-usage/calls/export` (`settings` + `data.export`; başlıklar isteğin dilinde; tutar, haktan düşme ve fiyat tablosu sütunları fiyat izniyle; en çok 50.000 satır; `data.export` denetim kaydı).
- Satırın kayıt adı ve bağlantısı yalnız kişi o kaydı görebiliyorsa: fatura dosyası fatura izniyle (faturası varsa fatura sayfasına), tarife belgesi ve tarife taslağı tarife izniyle (tarife sayfasına). Tartı okumasının kaydı yok.
- Destek için ekran yok: `npm run ai:usage` (firma listesi, `unbilled_TRY`, `fail_cap_TRY`, `FAILED-BUDGET-FULL`), `npm run ai:grant`.

#### Hak dolunca istemciler

- `GET /me` → `ai: { available, quotaExhausted }` (tutar ya da yüzde taşımaz, her rol okur). `quotaExhausted`: kota uygulanıyor ve hak ya da sonuç vermeyen çağrı tavanı doldu, yani yeni çağrı 429 `AI_QUOTA_EXCEEDED` alır (`assertAiQuota` ile aynı kural).
- Panel fatura yüklemede hak dolunca PDF seçeneğini kapatır ve açıklamada tek satırla söyler; 429 gelirse "Tekrar dene" çıkmaz.
- **"Yeniden oku"** PDF satır adımında: `POST /invoices/preview?async=1&fresh=1` (onaydan sonra, ücretli; ekrandaki düzeltmeler yeni okuma uygulanınca silinir).
  - Eski okuma (satırlar, düzeltmeler, önizleme dosyası) yenisi gelene kadar kalır. Okuma düşerse (hak, hız sınırı, ağ, iş hatası) ya da durdurulursa 1. adımda hata ve "Devam" görünür; "Devam" eski satırları düzeltmeleriyle açar. Eski dosya ancak yeni okuma uygulanınca silinir (web `liveFile.ts` `previewArrived`).
  - Panel her PDF okumasından sonra (başarılı ya da düşen) `GET /me`'yi yeniler: son hak kullanıldıysa "Yeniden oku" gizlenir.
  - Başlamış bir "Yeniden oku" işi düştükten ya da durdurulduktan sonra (arada okuma uygulanmadıysa) "Devam" ile satırlara dönülüp yeniden "Yeniden oku"ya basılırsa `fresh` gitmez: ilk işin ücretlediği parçalar önbellekten gelir (`rereadFresh`). Okuma uygulandıktan sonraki "Yeniden oku" yine `fresh`'tir.
  - Yeniden okuma işi başladıktan sonra düşerse "Tekrar dene" `fresh` göndermez: işin okuyup ücretlediği parçalar önbellekten ücretsiz gelir, yeni `fresh` iş onları ikinci kez ücretlerdi (`retryFresh`).
  - Okuma önceki sonuçtan geldiyse (`aiCached`) bu da yazılır.
- **Mobil tartı okuması:** 429 `AI_QUOTA_EXCEEDED` → "Bu ayki yapay zekâ hakkı doldu. Ağırlığı elle girin."; 429 `TOO_MANY_REQUESTS` (yuva ya da dakika sınırı) ve 503 `AI_BUSY` → "Şu an yoğun. Birkaç saniye sonra yeniden çekin ya da elle girin."; ölçüm durmaz.

#### Dosya okuma

`lib/fileWorkers.ts`, `workers/fileWorker.ts`, `workers/pdfGuard.ts`, core `invoice/zipGuard.ts`.

- **Çocuk süreç havuzu:** Excel, CSV ve PDF API sürecinde değil, ayrı ve yeniden kullanılan çocuk süreçlerde (`child_process.fork`) açılır: `FILE_WORKERS` 2, yığın `FILE_WORKER_HEAP_MB` 512 (`--max-old-space-size`), dosya başına `FILE_WORKER_TIMEOUT_MS` 60 sn (çocuğun açılışı dahil).
  - Çocukta yığın tükenmesi, tek büyük ayırma ya da çöküş API'yi düşürmez: çocuk ölür, istek 422 `FILE_TOO_COMPLEX`. `reason`: yığın tükenmesi, yakalanan "Array buffer allocation failed" ve bizim göndermediğimiz SIGKILL → `memory`; diğer çıkış → `crash`.
  - Açılamayan çocuk (hazır iletisinden önce ölen) 500: yapılandırma hatası.
  - Çocuğa API'nin ortamı geçmez (izinli liste: `NODE_ENV`, `TZ`, `LANG`, `LC_ALL`, geçici klasör; Windows'ta `SystemRoot`, `windir`); girdi ve sonuç IPC ile (`serialization: 'advanced'`).
  - Çocuk 200 işten sonra ya da açılıştan beri büyümesi bekçi sınırının dörtte birini aşınca yenilenir; API kanalı kapanınca (API öldü) kendini kapatır.
  - Linux'ta çocuk `oom_score_adj` 1000 alır: kap belleği dolarsa çekirdek API'yi değil çocuğu öldürür (istek 422 `memory`).
  - PDF'ten sayfa kesme (pdf-lib; büyük fatura grupları ve tarife PDF'i) de havuzdadır.
  - `FILE_WORKER_MODE=inline`: süreç içi okuma (geri dönüş; testlerde varsayılan). Başka her değer (eski `thread` dahil) çocuk süreç havuzudur.
- **Sınırlar:** satır `FILE_MAX_ROWS` 200.000, Excel'in açılmış hâli `XLSX_MAX_UNCOMPRESSED_MB` 200, PDF sayfa `PDF_MAX_PAGES` 300, PDF'teki sıkıştırılmış akışların açılmış toplamı `PDF_MAX_UNCOMPRESSED_MB` 300. Aşılınca 413 `FILE_TOO_LARGE`, `details: { kind: 'rows'|'uncompressed'|'pages', limit }`.
- **Excel zip denetimi** açmadan önce yapılır: beyan edilen ve gerçek açılmış boyut okuyucunun (JSZip) gözüyle sayılır; yalan dizinli bomba 413. Yapı kuralına uymayan zip (sonuna bayt eklenmiş, önekli) reddedilmez, yalnız "güvenilmez" sayılır. Açılamayan dosya core `XLSX_UNREADABLE`.
- **PDF ön denetimi** (`pdfGuard`) pdfjs ve pdf-lib'ten önce her `stream` gövdesini sayar:
  - Sözlükten bağımsız ham Flate denemesi; ayrıca sözlükten (kaçışlı ad, dolaylı başvuru) süzgeç zinciri (ASCIIHex, ASCII85, Flate → Flate, LZW, RunLength, Brotli; aşamaların toplamı); şifreli belgede (boş kullanıcı parolası: RC4, AESV2, AESV3) çözülmüş akış. Akış başına büyüğü sayılır.
  - Denetimin kendi süresi en çok 15 sn, ayrıştırıcının iç döngülerinde de; tek ayrıştırmada en çok 4096 değer, süzgeç zinciri en çok 16, nesne başlığı en çok 250.000 (aşılırsa 422 `FILE_TOO_COMPLEX`, `reason: 'timeout'`).
- **Bellek bekçisi** (ön denetimin saymadıkları için: görüntü süzgeçleri DCT/JPX/JBIG2/CCITT, tahmin edici, standart dışı şifre, sözlüğü okunamayan akışın zinciri):
  - Çocuktaki izleme iş parçacığı RSS'i 100 ms'de bir ayrı boruya yazar.
  - İş sürerken API RSS'i + çocukların açılıştan beri büyümesi `FILE_WORKER_RSS_LIMIT_MB` (1200) aşarsa ve iş başından beri belirgin büyüdüyse ya da toplam 1,3 katını aşarsa en çok büyüyen çocuk öldürülür.
  - API'nin olay döngüsü takılıp ölçüler okunmadan geç kalan denetim, ölçüler okunduktan sonra yinelenir: sağlıklı çocuk "ölçü vermiyor" sayılmaz.
  - Süre ya da bellek aşımı 422 `FILE_TOO_COMPLEX` (`details.reason`).
- **Kuyruk:** bekleyen iş en çok `FILE_QUEUE_MAX` 16, kuyrukta bekleme `FILE_QUEUE_WAIT_MS` 60 sn. Firma aynı anda en çok `max(1, FILE_WORKERS − 1)` çocuk kullanır, bekleyen işi en çok 4; sıra firmalar arasında döner. Dolu → 503 `FILE_BUSY` + `retry-after`; firmanın kendi işi yüzündense `details.scope: 'company'` ve ayrı metin.
- **PDF fatura karşılaştırması** (§3.15) havuz meşgul ya da sınır aşımı yüzünden yapılamazsa `pdfCheck.method: 'skipped'`: fatura yüklenir, rapora "metin katmanı yok" değil "denetim yapılamadı" yazılır. Boyut sınırı aşımı (413) ise reddedilir. Yöntemler: `text`, `none` (taranmış PDF), `skipped`.

**Fatura raporu da havuzda** (`renderReport`):
- `GET /invoices/:id/report.pdf` ve `report.xlsx` içeriği değişmeden dosya çalışanında üretilir; API'nin olay döngüsü rapor süresince kilitlenmez.
- Rapor çocuğu kendi yığınıyla açılır (`REPORT_WORKER_HEAP_MB` 1024) ve işi bitince kapanır; süre `REPORT_WORKER_TIMEOUT_MS` 180 sn.
- Kuyruk, firma payı ve bellek bekçisi dosya okumayla aynı; meşgul havuz 503 `FILE_BUSY`; çocuk sınırda düşerse 422 `REPORT_TOO_LARGE` (`details.reason`: `memory`, `timeout`, `crash`).
- **PDF satır sınırı** (kullanıcı kararı): PDF'in fark tablosu en çok `REPORT_PDF_MAX_ROWS` (varsayılan 1.000) satır listeler (`reports.ts` `pdfDiffRows`; sınır ana süreçten görevle gelir, rapor modülü ortam okumaz).
  - Fark satırı = durumu `DIFF` olan satır (Excel "Farklar" sayfasıyla aynı küme; kabul edilen, tahmini ve lehe olanlar dahil).
  - Sayı sınırı aşarsa Fark tutarı büyükten küçüğe (eşitse dosya sırası) ilk N satır bu sırayla gösterilir; raporun başında ve tablonun son satırında "Bu PDF en büyük N fark satırını gösterir (toplam M satır). Toplamlar tüm satırları kapsar. Tamamı Excel raporundadır." yazar (`report.pdf.truncatedNote`, TR+EN).
  - Sınır verilmemiş ya da geçersizse (0, eksi, NaN) sınırsız değil, 1.000 (`REPORT_PDF_MAX_ROWS_DEFAULT`).
  - Üstteki sayılar/tutarlar (`totals`) ve tablo altı toplamları (`diffReconciliation(r.lines)`) her zaman bütün faturadır. Sınır aşılmazsa sıra dosya sırasıdır.
  - Excel raporu ve itiraz kanıt paketi sınırsızdır.

**Önizleme tablosu önbelleği** (`lib/tableCache.ts`): doğrulama ve yapay zekâ eşlemesi için okunmuş tablolar API belleğinde tutulur: toplam tahmini `INVOICE_TABLE_CACHE_MB` (150) ve en çok 8 tablo. En uzun süredir kullanılmayan bırakılır; tek başına sınırı aşan tablo tutulmaz (gerekince dosya çalışanında yeniden okunur, sonuç aynı). Kullanılmayan tablo `INVOICE_TABLE_CACHE_TTL_MS` (15 dk) sonra düşer; içe aktarma ve `DELETE /invoices/preview/:fileId` girdiyi siler. `0` kapalı.

**Uzun eşzamanlı parçalar:** önizleme, doğrulama ve içe aktarmada tablo bir kez ayrıştırılıp okuma kontrolüne verilir. Karşılaştırma (`compareAllSliced`) ve saklama hassasiyeti 2.000 satırlık dilimlerle yürür, aşamalar arasında olay döngüsü bırakılır. 50.000 satırda en uzun kesinti ~0,9 sn. Kalan blok çekirdeğin tek `parseRows` çağrısıdır (~0,8 sn; çekirdek değişikliği ya da çocuğa taşıma ister).

#### Hız sınırı ve eşzamanlılık

`lib/rateLimit.ts`, `services/hub/limiter.ts`; süreç içi, birden çok sunucuda sınır sunucu başınadır.

- **Kovalar** (`RATE_TABLE`; tabloda olmayan multipart uç `upload`, diğer yazma `write`). GET uçları sayılmaz. Aşılınca 429 `TOO_MANY_REQUESTS` + `retry-after`.
  - `upload`: kişi 60/dk, firma 300/dk (ölçüm kaydı dahil; `RATE_UPLOAD_PER_MIN_MEMBER`, `RATE_UPLOAD_PER_MIN_ORG`).
  - `vision` (tartı ve işaret okuması): kişi 60/dk, firma 240/dk (`RATE_VISION_PER_MIN_MEMBER`, `RATE_VISION_PER_MIN_ORG`; çok çalışanlı firma görüntü servisini tek başına meşgul etmesin), kuyruktan ayrı.
  - `write`: kişi 300/dk (`RATE_WRITE_PER_MIN_MEMBER`).
- **`heavy`** (içe aktarma, örnek fatura, toplu yeniden hesap): süreç genelinde aynı anda `IMPORT_CONCURRENCY` 3, firma başına 1.
  - Yuvalar başka firmalarla doluysa istek gelme sırasıyla en çok `HEAVY_QUEUE_WAIT_MS` (30 sn) bekler, yuva boşalınca sürer; süre dolarsa ya da istemci giderse 503 `FILE_BUSY` + `retry-after`.
  - Firmanın kendi ağır işi sürüyor ya da sırada bekliyorsa beklemeden 503 (`details.scope: 'company'`). `0`: beklemeden 503.
  - Panel `FILE_BUSY`'de kendiliğinden yeniden denemez.
- **Merkez sorgu kapısı:** `/platform/*`, `/dashboard`, fatura Excel/PDF raporu ve kanıt ZIP'i süreç genelinde `HUB_DB_SLOTS` 8 tekil sorgu, firma başına en çok yarısı. Fatura listesi, detayı ve satırları kapıya girmez. Havuz `DB_POOL_MAX` 20.
- `API_RATE_LIMIT=off` hız sınırını ve ağır yuvayı kapatır (testlerde kapalı; üretimde açılışta uyarı).
- Gateway'de ayrıca IP başına sınır (`GATEWAY_API_RATE` 30r/s, yükleme 600r/m birikme 300 — depo ağında telefonlar tek IP'den gelir, asıl sınır API'nin kişi ve firma sınırı —, kimlik uçları 30r/m, bağlantı 100; 429 JSON, `Retry-After`).

#### Büyük firmada hız

Ölçüm: `test/bigCompany.db.perf.test.ts` (`npm run test:perf:db`, kökte `api-perf-db`; kapı değil). Veriyi kendisi üretir (`test/perfData.ts`: varsayılan ölçek 0.5 = 25 bin fatura, 500 bin satır, 100 bin ölçüm; `PERF_SCALE=1` ile 50 bin fatura, 1 milyon satır, 200 bin ölçüm; ayrıca üç küçük firma), uçların medyan süresini tablo olarak yazar. Ölçek `PERF_SCALE` (0.2 hızlı deneme), `PERF_SQL=1` en yavaş sorgular, `PERF_DUMP=<dosya>` sorgu metni ve değerleri (plan incelemesi için).

- **JIT kapalı:** uygulama bağlantısı `jit=off` ile açılır (`db.ts` `poolConfig`). Merkez özet sorgularında derleme işin kendisinden uzun sürüyordu.
- **Dışa aktarma:** kimlik listesi bir kez alınır; partiler (2.000 satır) toplam sayımı ve para birimi listesini yeniden yapmaz.
- **Merkez özetinde itiraz:** satırın geçerli itiraz satırı firmanın itiraz satırlarından bir kez seçilip birleştirilir (satır başına alt sorgu yok).
- **RLS ve dizin:** firma ilkesi altında yalnız sızdırmaz (`LEAKPROOF`) işleçli koşullar dizinle aranır: metin eşitliği, tarih ve sayı karşılaştırması evet; `right()`, `translate()`, `upper()`, `LIKE`/`ILIKE`, enum eşitliği (`status`, `decision`) hayır — bunlar firmanın satırları içinde süzgeçtir. Yeni sorguda dizin bekleniyorsa koşul `companyId` + sızdırmaz bir sütun karşılaştırması olmalı. Fonksiyonlu ifade dizini uygulama rolüyle kullanılmaz (ör. `InvoiceLine_companyId_trackingSuffix_idx`: ölçüm sonrası arama `recompareForTracking` firmanın satırlarını tarar; süper kullanıcıyla ölçülen süre yanıltır).
