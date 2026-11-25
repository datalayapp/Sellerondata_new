# DeciShip SPEC — Deneme turu ve kapalı firma (§5.14–§5.15)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

### 5.14 Deneme turu ve itiraz süresi hatırlatması

Kararlar `Platform/docs/KARARLAR.md`; bildirim ucu `Platform/docs/ARCHITECTURE.md` §6; ortam değişkenleri `Platform/docs/KURULUM.md`.

#### Örnek veriyle deneme turu

Kod: `routes/demo.ts`, `services/demoTour.ts`, örnek faturalar `services/sampleInvoices.ts`. Deneme firmanın kendi hesabında yapılır. Veri kaybı riskli olduğu için kural "ne varsa" değil "ne yüklendiyse" silmektir.

**Başlatma:** `POST /settings/demo` (`settings.manage`) → `201 { carriers, tariffs, measurements, invoices }`.
- `DEMO_TOUR=off` iken 404. Yalnız başlatma kapanır; açık kalmış deneme yine bitirilebilir.
- Firmada taşıyıcı, tarife, fatura (silinmiş ve örnek dahil) ya da silinmemiş ölçüm varsa 409 `DEMO_NOT_EMPTY`. Deneme zaten açıksa 409 `DEMO_ACTIVE`.
- Önce firma satırı kilidi altında bayrak yazılır: `settings.demo = { startedAt, byMemberId, carrierIds, loadingSince }`. `carrierIds` açılacak örnek taşıyıcıların önceden üretilen kimlikleridir; `loadingSince` yüklemenin sürdüğünü gösterir.
- Sonra örnek taşıyıcı, tarife ve ölçümler (`clientId` öneki `demo:`) ve gerçek içe aktarma yolundan iki fatura yüklenir: FedEx bugünden 5 gün önce (itiraz için 3 gün kalır), Aras 20 gün önce (süresi dolmuş).
- Kurulum tamamlanmış sayılır, `loadingSince` kalkar, `company.demoStart` denetim kaydı düşer.
- Bir adım hata verirse yüklenen örnek veri aynı silme yoluyla kaldırılır, bayrak iner, 500 döner. Temizlik de düşerse bayrak kalır: bant görünür, "Denemeyi bitir" sonradan temizler.

**Bitirme:** `DELETE /settings/demo` (`settings.manage`) → `200 { removed: { invoices, tariffs, carriers, measurements } }`.
- Deneme açık değilse 409 `DEMO_NOT_ACTIVE`.
- Yükleme sürüyorsa ve 15 dakika (`DEMO_LOADING_TTL_MS`) dolmadıysa 409 `DEMO_LOADING` ("Örnek veriler hâlâ yükleniyor…"). Süre dolmuşsa (süreç düşmüş) bitirme temizler.
- Yükleme sürdükçe `loadingSince` dakikada bir (`DEMO_LOADING_HEARTBEAT_MS`) firma kilidi altında tazelenir. Süre yalnız tazeleme durunca (süreç düştü) dolar; çok yavaş ama süren yükleme temizlenmez.
- Silinenler tek işlemde, firma kilidi ve firma bağlamında:
  - yalnız `carrierIds` taşıyıcıları, onların faturaları (satır ve itirazlar dahil), tarifeleri, fiyat sürümleri, içe aktarma taslakları, tarife PDF'leri ve kaynak dosyaları;
  - yalnız `clientId`'si `demo:` ile başlayan ölçümler ve fotoğrafları;
  - bunlara bağlı arka plan işleri ve deneme başladıktan sonra açılan firma çapında toplu yeniden hesap işleri.
- Kalanlar: listede olmayan taşıyıcılar ve kayıtları, çalışanların deneme sırasında kaydettiği ölçümler ve fotoğrafları, hazır koliler, ayarlar, üyeler, denetim kaydı.
- Örnek tarife ya da taşıyıcıda deneme sırasında yapılan değişiklik de silinir (onay penceresi söyler).
- Disk dosyası yalnız firmanın kendi klasöründeyse ve başka satır kullanmıyorsa silinir; firma klasörü toptan silinmez.
- Sonra bayrak silinir, kurulum yeniden açılır, `company.demoEnd` yazılır.
- Bayrakta `carrierIds` yoksa (eski biçim, `legacyDemoCarrierIds`) örnek taşıyıcı ancak hepsi tutarsa silinir:
  - kodu örnek taşıyıcı kodudur ve o koddan yükleme penceresinde (`startedAt` − 5 dk … `startedAt` + 15 dk) tek taşıyıcı açılmıştır;
  - taşıyıcı, bütün tarifeleri ve faturaları o pencerede açılmıştır;
  - bütün faturaları o kodun örnek fatura numarasını taşır.
  - Tutmayan taşıyıcı (tarife ve faturalarıyla) kalır ve günlüğe yazılır; başlangıcı okunamayan bayrakta hiçbir taşıyıcı silinmez. Önekli ölçümler her durumda silinir.

**Koruma:**
- Deneme açıkken taşıyıcı, tarife ve fatura ekleyen bütün uçlar 409 `DEMO_ACTIVE` döner (`DEMO_BLOCKED`, `app.ts` kancası): `POST /carriers`, `/tariffs`, `/tariffs/:id/{duplicate,import}`, `/tariff-imports[/:draftId/{recheck,review,apply}]`, `/tariff-documents/:documentId/{scan,extract}`, `/invoices`, `/invoices/preview[/verify,/ai-mapping]`, `/invoices/samples`, `/settings/data/reset`.
- `POST /carriers` ayrıca kendi işleminde firma satırını `FOR SHARE` kilitleyip bayrağı yeniden okur.
- Ölçüm kaydı, karar, itiraz, tarife düzenleme ve ayar serbesttir.
- Test, yazma yöntemli her ucu bu liste ile gerekçeli izin listesine karşı denetler (`test/demoTour.test.ts`): yeni yazma ucu ikisinden birine girmek zorundadır.
- `demo:` öneki yalnız sunucunundur: istemci `clientId`'si `demo:` ile başlarsa 400 `VALIDATION`. Örnek ölçümün düzeltmesi yeni sürümü de önekli açar.
- Aynı takip numarasına ölçüm yazanlar (ölçüm ucu ve örnek veri) aynı kilit sırasına girer (`services/measurementLocks.ts`).

**Arayüz:**
- Web: kurulumun ilk adımının üstünde "Henüz veriniz yok mu?" kartı (yalnız `demo.available`). Deneme sürerken bütün sayfaların üstünde ince bant ve ayar yetkisi olana "Denemeyi bitir" (`components/DemoBanner.tsx`). Yükleme sayfası denemede kendi faturanızı yükleyemeyeceğinizi söyler.
- Merkez: deneme açıkken `GET /platform/overview` `sample: true` döner (yoksa alan yok); Genel Bakış'ta DeciShip kartının başlığında "Örnek veri" notu çıkar.

#### İtiraz süresi hatırlatması

Kod: `services/reminders.ts`, `services/notify.ts`, komut `src/cli/reminders.ts`. İtiraz kurallarıyla ilişkisi ve kısa özeti: [itiraz.md](itiraz.md); gönderim kuralları burada.

DeciShip kişilerin e-posta adresini bilmez: postayı Hesap servisi gönderir (`POST /api/account/internal/notify`, ARCHITECTURE §6). Firma başına **günde en çok bir özet** posta.

- **Çalışma:** saatlik bakım işi temizlikten sonra çalıştırır; hatası bakımı bozmaz. Firma listesi bakım kapsamında yalnız `Company` satırından okunur (göç `20261115090000_company_maintenance_read`; başka tablo bakım kapsamında açılmaz); adaylar her firmanın kendi bağlamında okunur.
- **Atlanan firma:** `disputeReminders === false`, deneme açık, ülkesi Türkiye değil (`ttkApplies`), ya da firmanın saat diliminde yerel saat 09:00–19:00 dışında (gece posta yok).
- **Aday fatura:** silinmemiş, örnek olmayan, son 10 günde tarihli, fazla ödemesi olan, kabul edilmemiş fark satırı olan ve etkin itiraz turu olmayan.
  - Etkin turu olan fatura, gönderimden sonra listeye eklenip henüz gönderilmemiş satırı varsa (`unsentAfterSend`, itiraz.md "gönderilmemiş") yine adaydır. Çok faturalı postanın `TO_DISPUTE` bağlantısı onu göstermez (satırda adı yazar).
- **Özete giren:** TTK son gününe 3 gün kalan fatura her zaman. Son güne yakın tek yuva vardır ve yükleme günü belirler:
  - son günden bir önceki günden önce yüklenen fatura 1 gün kala özetine girer;
  - o gün ya da sonra yüklenen fatura son gün özetine girer;
  - 2 gün kala girmez. Bir fatura en çok iki özette görünür ("3 gün kala" ve "1 gün kala" ya da "son gün"); iki gün üst üste listelenmez. Kural iz tutmaz, yalnız yükleme gününe bakar.
- **Alıcı:** firmada `deciship.disputes.manage` izni olan (Yönetici, Muhasebe), doğrulanmış e-postalı etkin kişiler; seçimi Hesap servisi yapar.
- **Posta:** tutar yazmaz. Son günü en yakın önce, en çok 6 fatura (`DIGEST_MAX_ROWS`) ve "ve X fatura daha"; konu en acil faturaya göre (bugün / yarın / N gün); yasal not; tek faturada düğme faturaya, birden çokta `/deciship/invoices?status=TO_DISPUTE`. Metinler `mail.ttk.*` (TR ve EN; dil kişiye göre Hesap'ta seçilir).
- **Tekrar:** anahtar `ttk:<YYYY-MM-DD>` (firmanın takvim günü). Hesap servisi aynı anahtarı ikinci kez göndermez (`duplicate`). Süreç içi bellek cevabı alınmış günü saatlik turlarda yeniden sormaz; firma düzeyindeki olumsuz yanıtı (`disabled`, `no_recipients`, `limited`, reddedilen gövde) 3 saat hatırlar.
- **Kullanıcı verisi** (taşıyıcı adı, fatura no) sözleşmedeki `cleanNoticeText` ile temizlenir (40 karakter); bağlantıya benzeyen değer yerine genel metin. Kurulan metin `isNoticePlainText` ile denetlenir: bir firmanın verisi turu bozamaz.
- **Tur sınırları:** tur başına en çok 200 istek. Zaman aşımı, ağ, 5xx ve 401 art arda 5 kez olursa tur kesilir (401'de bir kez "anahtar uyuşmuyor" yazılır); adres ya da anahtar bozuksa tur hemen durur. `ACCOUNT_NOTIFY_URL` boşsa hatırlatma kapalıdır.
- **Yarım kalan gönderim:** Hesap servisi postalar bitince `ProductNotice.sentAt` yazar. Süreç gönderim sırasında durursa DeciShip yanıt alamaz, sonraki saatlik turda aynı anahtarla yeniden sorar; son denemeden 10 dakika (`NOTICE_RESEND_AFTER_MINUTES`) geçtiyse Hesap servisi postaları yeniden gönderir (`queued`).
- **Bilinen sınırlar:**
  - O günün özeti gittikten sonra yüklenen fatura o günün özetine girmez. 3 gün kala günü kaçan fatura 1 gün kala ya da son gün yuvasında yine görünür; son gün böyle yüklenen fatura hatırlatılmaz.
  - Hesap servisi `queued` yanıtını verip postalar bitmeden (3 sn bekleme sonrasında) durursa DeciShip o günü cevaplanmış sayar, yeniden sormaz: o günün postası yalnız DeciShip yeniden başlarsa gider.
- **Komut** (deneme ve destek): `npm run reminders:once -- [--send] [--now] [--company <id>]`, kapta `node dist/cli/reminders.js …`. Bayraksız kuru çalışır (her firma için gönderilecek özeti tek satırda yazar, adres boşken de); gerçek gönderim yalnız `--send` ile; `--now` saat penceresini yok sayar; `--dry` ile `--send` birlikte verilemez.
- **Web:** Ayarlar'da tek anahtar ("E-posta ile hatırlat"), yalnız Türkiye firmasında görünür.

---

### 5.15 Kapalı firma (firmayı kapatma)

Firmayı yalnız sahibi Merkez'den kapatır (`POST /api/account/org/close`). Veriler 30 gün saklanır, sahip bu sürede geri açabilir; süre dolunca Hesap firmayı siler (kurallar `Platform/docs/KARARLAR.md`). DeciShip yalnız olayları uygular (`identity.ts`).

- **`org.closed`** `{ closedAt, purgeAfter, version }`: `Company.closedAt` yazılır.
- **`org.reopened`** `{ version }`: `closedAt` boşalır; her şey kapanıştan önceki gibidir (veri, ayar, bekleyen işler).
- İkisi `closedVersion` sırasıyla uygulanır: kayıtlı sürümden küçük ya da eşit sürüm uygulanmaz (olaylar sırasız gelebilir; ad sürümü `nameVersion` ayrıdır). Satır yoksa açılır (sırası bozuk üye olayı kapalı firmayı açık kurmasın).
- **Uçlar:** kapalı firmada her kimlikli uç 409 `ORG_CLOSED` döner (auth-kit `MemberProjection.orgClosed`; rol, epoch ve abonelikten önce). Kapanışta Hesap epoch'u artırır ve ürün erişimini kaldırır, açık oturum zaten düşer: bu çift güvencedir. İmzalı dosya bağlantısı 404. JIT kapalı ya da silinmiş firmada üye açmaz.
- **Arka plan işleri** kapalı firmayı atlar, kaydına dokunmaz; geri açılınca kaldığı yerden sürer:
  - iş kuyruğu (QUEUED kalır, deneme hakkı harcanmaz; iş kapsamı firma satırını yalnız okur, ilke `Company.jobs_company_read`, açılış denetimi arar);
  - deneme hakkı biten işlerin sonlandırılması, ölçüm/fatura yeniden hesap taraması;
  - fatura dosyası ve önizleme temizliği, silinenlerin kalıcı temizliği, eski iş temizliği;
  - itiraz süresi hatırlatması.
  - Kapanış anında süren iş bitene kadar çalışır. Süreli geçici kayıtlar (olay kimliği, tarife taslağı ve PDF'i, yapay zekâ önbelleği) kapalı firmada da süresi dolunca silinir.
- **`org.purged`** (sürümsüz, son olay): `CompanyPurge` kaydı yazılır, firma kapalı sayılır. Silme yalnız bu kayıtla başlar.
  - Commit'ten sonra `services/companyPurge.ts` firmanın bütün satırlarını siler: firma sütunlu her tablo, `PURGE_TABLES` sırasıyla (üyeler, ayarlar, yapay zekâ kullanımı dahil).
  - Silme küçük parçalarla yapılır: tablo başına en çok 500 satırlık kısa işlemler, her biri firma kilidi, `CompanyPurge` denetimi ve firma bağlamıyla. Firma satırı en son, bütün tabloların boş olduğu kilit altında doğrulanınca silinir.
  - Her parçanın dosyaları (yalnız firmanın kendi klasöründekiler) o parça commit edilince silinir; en sonda `<STORAGE_DIR>/<firma>` klasörü silinir. Olmayan dosya sorun değildir.
  - Çağrı başına 2 dakika, bakım turu başına toplam 5 dakika sınırı vardır; dolunca sonraki turda sürer (ilerleme saklanmaz, her tur kalan satırları siler). Yarıda kalırsa (`completedAt` boş) saatlik bakım yeniden dener: önce hiç denenmemiş, sonra en uzun süredir denenmemiş silme (`attemptedAt`, her denemede yazılır); hep düşen silme yenilerini bekletmez.
  - Firma sütunlu her tabloda firma sütunuyla başlayan dizin vardır (silme ve firma satırının silinmesi tabloyu baştan taramaz; `test/companyClose.test.ts`).
  - Kayıt kalır: sonra gelen (gecikmiş) hiçbir olay firmayı yeniden kurmaz, tekrar gelen silme olayı zararsızdır.
  - Kaydın veritabanı kuralları (RLS, göç `20261129090000_company_purge_policies`): firma bağlamında okunur; yalnız olay alıcısı ekler (olay kapsamı + firma bağlamı), yalnız bitmemiş ve denenmemiş kayıt; bitiş anı (`completedAt`) yalnız bitmemiş kayda, bir kez ve silme işleminin içinde (firma kilidi, kayıt denetimi) yazılır, sonra boşaltılamaz ya da değiştirilemez; deneme anı silmenin kendi kısa işleminde, firma bağlamında ve yalnız bitmemiş kayıtta yazılır; bakım kaydı yalnız okur; kayıt hiçbir kapsamda silinmez. Uygulama rolü yalnız bu iki an sütununu güncelleyebilir.
  - Silme listesi veritabanı kataloğuyla denetlenir (`companyPurge.ts` `checkPurgeTables`, test `[]` bekler): firma sütunlu her gerçek tablo listede, uygulama rolü listedeki her tablodan silebilir, firma sütunsuz çocuk tablo ebeveynine `ON DELETE CASCADE` ile bağlı (ya da listede), silmeyi engelleyen bağla bağlı çocuk ebeveyninden önce, dosya tablosu ebeveyniyle CASCADE gitmez, RLS'li her tabloda firma bağlamında silme ilkesi var. CASCADE'li çocuğa engelleyen bağla bağlı torun da yakalanır; `SET NULL` engel sayılmaz.
  - Bir tur hiç satır silmeden biterken kalan satır varsa (ilke ya da yetki eksik) silme boşa dönmez: hata günlüğe yazılır, `in-progress` döner, bakım sonraki turda yeniden dener.
  - Firmanın olayları, JIT'i ve silmesi firma kilidiyle sıralanır.
