# Firma, abonelik ve Merkez

Parçası olduğu dizin: `Platform/docs/KARARLAR.md` (okuma kuralları orada).

## Firma kapatma ve silme

Kullanıcı kararı 2026-11-13. Sözleşme ARCHITECTURE.md §6 "Firmayı kapatma"; DeciShip tarafı `Deciship/SPEC.md` §5.15. İki yol vardır, ikisi de geçerlidir: sahibin Merkez'den kapatması (30 gün sonra kalıcı silme) ve destek komutu `org:close` (silme yok; aşağıda "Araç kaydı ve abonelik").

- Firmayı **yalnız sahibi** kapatır: Merkez › Firma sayfasının en altındaki tehlikeli bölümden; firma adını yazar ve şifresini yeniden girer (e-posta onayı ve ekibe bildirim yok). Yanlış ad şifre denemesi saymaz; şifre denemeleri mevcut şifre onayı sınırına tabidir.
- Kapanınca: kimse firmaya giremez, açık oturumlar firmasız kalır, bekleyen davetler düşer (geri açılınca dönmez), araç bildirim postaları gitmez, DeciShip arka plan işleri o firmada durur. Abonelikler değişmez.
- Veri **30 gün** saklanır (`ORG_PURGE_DAYS`). Bu sürede sahibi Merkez'den (firma seçicide "Kapalı" satırı ya da firmasız ekran) şifresiyle **geri açar**; üyeler rolleriyle döner. Kapalı firmayı yalnız sahibi görür.
- Süre dolunca saatlik bakım firmayı **kalıcı siler**: Hesap servisinde firma, üyelikler, roller, abonelikler, davetler; kişiler (hesaplar) silinmez. DeciShip `org.purged` olayıyla kendi verisini (faturalar, ölçümler, itirazlar, dosyalar) siler. **Kalıcı silinen veri geri gelmez** (yedekten başka yol yok). Denetim izinde `org.purged` satırı firma adı olmadan kalır.
- Kapatma, geri açma ve silme olayları firmada aboneliği olan ya da daha önce olay almış her araca gider (araç kapalı olsa da) ve teslim edilene dek denenir; teslim edilmemiş satır temizlenmez. Süreler veritabanı saatiyle hesaplanır. DeciShip büyük firmayı küçük parçalarla, bakım turu başına sınırlı sürede siler; kaldığı yerden sürer.

## Araç kaydı ve abonelik

Ayrıntı: ARCHITECTURE.md §1, §6 "Abonelik durumları ve destek komutları", §7 "Yeni araç ekleme"; komutlar KURULUM.md "Destek komutları".

- Araçların tek kaydı `contracts/src/products.ts` (tip güvenliği için TypeScript); diğer tanımlar ondan türer. Gateway blokları ve site listesi kayıttan üretilir, commit edilir, `npm run products:check` ile denetlenir.
- Araç anahtarı Merkez ve gateway adlarıyla çakışamaz (`RESERVED_PRODUCT_KEYS`). Sahte test aracı `ornekarac` yalnız test fikstürüdür, kayıtta yok.
- Araç durumu `off`, `pilot`, `public`; çalışırken yalnız Hesap servisi ortamından (`PRODUCT_LAUNCH`) değişir, diğer parçalar `/me`'den okur, yeniden derleme gerekmez. Mobilde de aracın açıklığı `/me`'den okunur.
- Herkese açık araç yeni firmaya kayıtta otomatik ve ücretsiz açılır; eski firmalara `product:launch` ile.
- İlk açılışta sahibe aracın sahip rolü verilir, bütün üyeler araca duyurulur. Yeni olay türü yok.
- Abonelik değiştirmek yalnız destek komutuyla; Merkez'de müşteri düğmesi ve HTTP ucu yok (ödeme ertelendi).
- Durdurma `READ_ONLY`: okur, yazamaz.
- **İptal: 90 gün salt okunur.** `CANCELED`: 90 gün okunur, sonra erişim biter; **veri silinmez**, silme işi yok.
- Durum değişince jetonlar hemen yenilenir (epoch artışı); durdurulan firma 10 dk yazmaya devam etmez.
- Destek komutuyla firma kapatma (`org:close`): bütün abonelikler iptal, bekleyen davetler düşer, silme yok; `org:reopen` geri alır. Kapalı firmada yeni davet `409 ORG_CLOSED`; şifre sıfırlama kodları (`PHONE_RESET`) düşmez.
- `org:list` sahibin e-postasını tam gösterir (yalnız sunucuda koşan destek aracı).
- Her komut ve açılış yapılandırma denetimini koşar. Hesap servisinin okuduğu her ortam değişkeni compose'da yazılı olmak zorunda (bilinçli istisnalar `DISPATCHER_INTERVAL_MS`, `REFRESH_REUSE_GRACE_SECONDS`). Kimlik paketindeki tanım dikişi yalnız `NODE_ENV=test` iken kabul edilir.
- Ortak paket `@sellerondata/product-kit`; DeciShip ona geçmedi.
- Veritabanı rolleri, şemaları ve compose servisleri kayda bağlanmadı (güvenlik ağırlıklı; Docker uçtan uca testi ister).
- Fatura profili ve kullanım sayacı yok: fiyat birimi kararı yok, ödemeyle gelir.

## Merkez kurulumu ve araç kurulumu

Kullanıcı kararı 2026-11-13. Sözleşme `contracts/src/tokens.ts` (`activeOrg.companyConfirmedAt`, `isCompanyConfirmed`), `events.ts` (`org.updated.companyConfirmed`); ARCHITECTURE.md §6.

- Ortak koşul firma bilgileridir (ad, ülke, para birimi, saat dilimi) ve **yalnız Merkez'de** kurulur. Merkez kurulumu Merkez'de, her aracın kurulumu kendi içinde yapılır.
- **Merkez kurulumu** (yalnız sahip ve firma yöneticisi görür): zorunlu "Firma bilgilerini onaylayın" (Merkez › Firma sayfasında açık onay; `Organization.companyConfirmedAt`), isteğe bağlı "Ekibi davet edin". Sayaç yalnız zorunlu adımı sayar.
- Onay bir kez verilir, geri alınmaz; sonra bilgiler yine Merkez › Firma'dan değişir. Bu kuraldan önce açılmış firmalar onaylı sayılır; yeni firma onaysız başlar.
- Araç onayı `org.updated` olayıyla öğrenir. DeciShip değeri `settings.companyConfirmed`'da tutar (DeciShip yazmaz); yeni firma satırı `false` açılır, değer hiç gelmemişse (eski firma) onaylı sayılır. Panel Merkez'in taze `/me` yanıtını esas alır; olay gecikirse yalnız DeciShip'in "kurulum tamam" işareti birkaç saniye geç döner.
- **DeciShip kurulumu**: "Firma" adımı yok. Listenin başında sayılmayan "Firma bilgileri" satırı: "Merkez'de tamamlandı" (bilgiler Merkez'den okunur; "Merkez'de değiştir ↗") ya da "Merkez'de bekliyor".
  - Onay yoksa sihirbaz yalnız "Önce firma bilgileri"ni gösterir; tek düğme Merkez'in firma sayfasına gider, onaydan sonra kişi sihirbaza döner (`next`, yalnız aynı kökende göreli yol). Para birimi tarifeler için gerektiğinden DeciShip adımları onaydan sonra açılır; DeciShip kurulumunun "tamam" sayılması Merkez onayını da ister. Kayıtlı eski ilerleme (`sirket` adımı) göçsüz okunur, kurala girmez.
- **Merkez Genel Bakış** (yeni firma): üstte "Merkez kurulumu" paneli, altında "Araç kurulumları": her açık araç için "n/m adım · Sıradaki: …", ilerleme çubuğu ve "Kuruluma devam et" (aracın kendi sihirbazına); yakında gelen araçlar soluk. Adım verisi aracın Merkez özetinden (`overview.setup`) gelir; Merkez araç adımı bilmez.
- Başlangıç sayfası yönetici için firma onayı eksikken ya da görünen araçların hiçbirinin kurulumu bitmemişken görünür; sonra normal Genel Bakış. Merkez bitmiş, bir araç bitmiş ama başka aracın kurulumu açıksa Genel Bakış'ta o araç için kurulum kartı.
- Web'i olmayan aracın menü bağlantısı Merkez'de o araca süzülmüş Genel Bakış'a gider.

## Merkez ekranları

- "Üyelikler" sayfası yok; adres Hesabım › Firmalarım'a (`/account/firms`) gider. Plan ve araç durumu yönetici için Abonelik'te, herkes için ⊞ menüsünde.
- Firma dili ve saat dilimi Merkez › Firma'dan ayarlanır; değer Hesap servisinde saklanır, araçlara olayla gider (ARCHITECTURE.md §6 "Firma dili ve saat dilimi"). Saat dilimi 16 seçenekli kısa listedir, ülkeye göre önerilir. Davet postasının dili firma dilinden gelir; davet formunda dil yok.
- Genel Bakış'ta (web ve telefon) "Tümü" yok: her zaman tek aracın özeti, seçim yoksa ilk açık araç. Analiz'de (web) Tümü kalır.
- Genel Bakış bandındaki "DeciShip'i aç" ikincildir. Analiz'de dışa aktarma tek menü; Veriler'de açıkta tek süzgeç, "Sütunlar" ve "CSV indir" ⋯ menüsünde. Etkinlik süzgeçleri adreste durur. Ekip'te davet iptali onay sorar.
- **Yapay zekâ kullanımı** (kullanıcı kararı 2026-11-13), Merkez › Abonelik: ay seçici (‹ ay ›, en çok 12 ay), toplam maliyet, token (giren/çıkan), işlem sayısı (başarılı/okunamadı/yarıda), aylık hak; işlem türü ve kişiye göre dağılım; her çağrı satır satır (kişi, işlem, kayıt, token, süre, maliyet, sonuç) ve ayrıntı paneli; Excel indirme (`data.export` de gerekir). Ayarlar izni gerekir; tutarlar fiyat iznine bağlı. Toplam maliyet yalnız başarılı çağrılardır; başarısız çağrının maliyeti gösterilir ama aylık haktan düşülmez.
