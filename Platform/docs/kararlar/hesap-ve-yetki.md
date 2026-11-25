# Hesap, kayıt, yetki ve güvenlik

Parçası olduğu dizin: `Platform/docs/KARARLAR.md` (okuma kuralları orada).

## Hesap, kayıt ve adresler

- Tanıtım sitesi `sellerondata.com`, uygulama `app.sellerondata.com` (`/home`, `/deciship`, `/account` …).
- Tek hesap: site, Merkez ve bütün araçlar aynı hesabı kullanır. Kayıt siteden başlar, kurulum Merkez'de yapılır.
- Şifre yalnız uygulama adresinde girilir. Site yalnız "giriş yapılmış mı" diye yoklar ve çıkış yapar; sitede form ve şifre alanı olmaz.
- Firma öder, kişi girer. Bir kişi birden çok firmada olabilir.
- Kayıt tek anahtarla tamamen kapatılabilir (`REGISTRATION_ENABLED=false`, her kipte önce gelir). Yeni firmaya DeciShip "Erken erişim" olarak hemen açılır.
- E-postası olmayan çalışan: yönetici ad ve telefon girer, sistem tek seferlik kod üretir, yönetici kodu elden iletir, çalışan şifresini kendisi belirler.
- Telefon numarası yalnız doğrulanmış e-posta varken kaldırılabilir.
- Destek yalnız e-postayla (`destek@sellerondata.com`): Merkez ve DeciShip'te avatar menüsünde, mobilde Hesap sekmesinde "Yardım ve destek".

**Kayıt yalnız davetle (kapalı deneme)** (kullanıcı kararı 2026-11-12). Ayrıntı: ARCHITECTURE.md §6 "Kayıt yalnız davetle"; komut: KURULUM.md "Destek komutları".
- `SIGNUP_MODE=invite`: yeni firma kaydı yalnız destekçinin `signup:invite` ile ürettiği kayıt davetiyle. Davet tek kullanımlık, yalnız o e-posta adresiyle, varsayılan 14 gün (1–90). Komut bağlantıyı yazar, posta göndermez; destekçi kişiye kendisi iletir.
- Davetsiz kayıt `403 SIGNUP_INVITE_REQUIRED`; yanlış, kullanılmış, süresi geçmiş ya da uydurma davet tek kodla `403 SIGNUP_INVITE_INVALID` (davetin hangi adrese bağlı olduğu söylenmez).
- Giriş yapmış kişi de davetsiz yeni firma açamaz (`/me` `canCreateOrg: false`); yoksa her ekip daveti yeni firma kapısı olurdu. Mevcut hesapla ikinci firma kapalı denemede açılmaz; gerekirse başka adrese kayıt daveti.
- **Firmaya ekip daveti (e-posta bağlantısı, telefon + kod) etkilenmez.**
- Merkez kayıt ekranı davetsiz gelene form yerine "Şu an yalnız davetle hesap açılıyor" + destek postası gösterir. Site `invite` ile derlenince "Hesap aç" düğmeleri "Erken erişim isteyin" olur (destek postası; üst çubukta "Erken erişim").
- Varsayılan: üretimde `invite`, yerelde ve testte `open`. Bozuk değer servisi ve site derlemesini durdurur.
- Herkese açmak: `.env`'de `SIGNUP_MODE=open`, Hesap servisi yeniden başlar, site yeniden derlenir. Veri değişmez.

## Merkez ve yetkiler

- Merkez yalnız geçiş ekranı değildir: bütün araçların analizi ve verisi görülür; ekip, yetki, firma ve abonelik yönetilir.
- İş işlemi (fark kararı gibi) araçta kalır; Merkez'deki satır araca bağlantı verir.
- Yetkilendirme yalnız Merkez'dedir; araçların kendi kullanıcı ekranı yoktur. Kod rol adına değil izin anahtarına bakar.
- **Firma yönetimi yalnız tarayıcıdan** (C2.4-A1). Hesap'ın `/org` ve `/org/*` yazma uçları (firma ayarı, üye, rol, davet, devir, kapatma, geri açma, ayrılma) yalnız tarayıcı oturumunu kabul eder: jeton çerezde ve oturum web girişiyle açılmış. Mobil ya da Bearer jeton `403 FORBIDDEN` (`details.reason: WEB_SESSION_REQUIRED`) alır; çalınmış, uzun ömürlü mobil oturumla firma yönetilemez. Tek istisna mobilin "Çalışan ekle"si: telefon kodlu, firma rolü çalışan olan ve araç rolü mobilin verebildiği (sahip rolü ve sahibe özel izinli rol değil) davet; aynı telefona web'den açılmış başka türden bekleyen daveti düşüremez. Okumalar (ekip, roller, etkinlik), `/orgs`, `/me` ve `/auth/*` mobilde açık. Kod `routes/org.ts` `guardOrgWrites`.
- Firma rolleri sabit: Sahip, Yönetici, Çalışan.
- DeciShip hazır rolleri: Yönetici, Denetleyici, Muhasebe, Ölçüm ve Erişim yok. Muhasebe tarifeleri yalnız görür; fatura yükler. Yükleme izni faturanın başlığını düzeltmeyi ve silmeyi de getirir, fark kararı vermez.
- TagPress hazır rolleri (kullanıcı kararı 2026-11-23): **Yönetici** (ayarlar ve anahtarlar dahil her şey) ve **Kullanıcı** (ayarlar dışında her şey). Ayar izni yalnız firma sahibinin verebileceği izindir (DeciShip ile aynı); davetin varsayılanı Kullanıcı. Ücretli yapay zekâ eylemi `tagpress.ai.use` ile birlikte `tagpress.work.edit` de ister.
- Karar izni olmayan, kararı verilmiş satırın tutarını değiştiren başlık düzeltmesini (taşıyıcı, tarife, tarih, para birimi) yapamaz; fark kararı verebilen biri yapar. Bilinçli sonuç: Muhasebe itirazı geri çekip faturayı silebilir; itirazın kaydı veritabanında kalır ama ekrandan kaybolur.
- **Askı ve çıkarma araçta** (KALANLAR 6.10). Askıdan dönen çalışanın olayı araca ulaşmasa da (DEAD) çalışan araca bir sonraki girişinde döner: araç, kendi kaydından büyük çağlı (epoch) jetonla kaydı etkin yazar (DeciShip ve product-kit `syncMember`). Bilinçli kabul: askıdan dönüş olayı gelmeden yeniden askı olayı da gecikirse, arada basılmış jeton en çok jeton ömrü (10 dk) erişim verir; olaylar sırayla gelseydi de aynı olurdu. Eşit çağlı jeton pasif kaydı açmaz. **Çıkarma kalıcıdır:** firmadan çıkarılan üyenin araçtaki kaydını (`member.removed`, `removedAt`) hiçbir jeton açmaz (yedekten geri yükleme ya da tohum aynı üyelik kimliğine büyük çağlı jeton bassa da).

**Özel roller** (kullanıcı kararı 2026-11-13). Kod `Platform/packages/contracts/src/roles.ts`, `account-api/src/lib/roles.ts`, `roleBook.ts`.
- Roller **uygulama başına**; Merkez Ekip sayfasında "Roller" sekmesi.
- **Hazır roller** düzenlenebilir, adı değiştirilebilir, silinebilir (firmada gizlenir, "Silinen hazır rolleri geri getir" ile döner). **İstisna:** ürünün sahip rolü (DeciShip "Yönetici") silinemez, yetkileri kilitlidir; adı değişebilir.
- Yeni rol hazır şablondan ya da boş başlar; izinler gruplu seçilir. Bağımlı izinler sunucuda zorunludur (eksikse reddedilir, arayüz kendiliğinden işaretler): `invoices.view` ve `data.export` → `prices.view` gerektirir.
- Rolleri **sahip ve firma yöneticisi** yönetir. Firma yöneticisi kendisinde olmayan izni rol tanımına koyamaz; kendisinin, sahibin ya da başka bir yöneticinin taşıdığı rolü düzenleyemez, silemez.
- `deciship.settings.manage` (Ayarlar) içeren rolü yalnız sahip oluşturur, düzenler, atar ve davetle verir; yani firma yöneticisi DeciShip "Yönetici" rolünü veremez.
- Var olan rolün kişiye atanması "kişiyi yönetebiliyor mu" + "sahibe özel izin" ile sınırlıdır (DeciShip rolü olmayan firma yöneticisi de ekibine rol verebilir).
- Rolde sahip olmayan birinin (firma yöneticisinin) açtığı süresi geçmemiş bekleyen davet varken o role sahibe özel izin eklenmez, silinirken davetler sahibe özel izinli role taşınmaz (`ROLE_FORBIDDEN pending_admin_invites`, engel olan davetler yanıtta ve Merkez iletisinde); sahip daveti iptal eder ya da kendisi yeniden gönderir. Yoksa davet kabulde ölürdü. Süresi geçmiş davet engel değildir: ancak yeniden gönderilerek dirilir, yeniden gönderen de o anki yetkisiyle sınanır.
- Kullanımdaki rol silinirken kişilere ve bekleyen davetlere yeni rol seçilir; kimse rolsüz kalmaz. Değişiklik hemen geçerli: jetondaki izin listesi (`perms`) ve çağ (epoch) artar, oturumlar saniyeler içinde yenilenir.
- Sunucu savunması: rapor XLSX/PDF, itiraz metni/ZIP, doldurulmuş tarife şablonu ve kaynak fatura dosyası `prices.view` ister.
- Firma başına ürün başına en çok 20 özel rol.

## Hesap güvenliği

Ayrıntı: ARCHITECTURE.md §5 "Yetki kuralları", §6 ("E-posta doğrulaması", "Oturum", "Hız sınırı", "Açılış korumaları"), §11.

**Giriş ve e-posta**
- Kullanıcı kararı: **e-posta doğrulanmadan giriş yok.** Demo hesaplar doğrulanmış sayılır.
- Yeni hesabın ilk doğrulamasında doğrulama sayfası şifre de sorar (bağlantı adresi kanıtlar, şifreyi kimin koyduğunu kanıtlamaz). Şifreyi bilmeyen gerçek sahip "Şifremi unuttum" ile hesabı alır. E-posta değişikliği onayı şifre sormaz.
- Davetle gelen yeni kişi e-postasını ayrıca doğrular (davet bağlantısını yönetici de görür).
- E-posta değişikliği: yeni adres onaylanana kadar eski adres geçerli; profilde "Yeniden gönder" ve "Vazgeç"; istek anında eski adrese "değiştirme isteği" haberi, onaydan sonra "adresiniz değişti" postası.
- Şifre değişince ya da sıfırlanınca kişiye "şifreniz değiştirildi" postası gider.
- Yerelde gerçek posta gitmez; postalar veritabanına düşer, `POSTA.bat` ile açılır. Ayrı posta sunucusu yok.
- Yapılmayanlar: kayıtta "bu e-posta kullanılıyor" yanıtı, CAPTCHA, iki adımlı doğrulama.

**Oturum ve sınırlar**
- Oturum en çok 90 gün. Çıkış yapınca diğer cihazlardaki açık araç oturumları bir kez sessizce yenilenir.
- Yenilemede eski jeton, yeni jeton henüz hiç kullanılmadıysa oturumu düşürmez: aynı tekrar anahtarıyla gelirse (mobil her yenilemeden önce üretip jetonla saklar; web oturumunda anahtar yok sayılır) süre aranmaz, anahtarsız ya da başka anahtarla gelirse 60 saniye içinde olmalı. Yeni jeton kullanıldıktan sonra gelen eski jeton, anahtarı doğru olsa da hemen hırsızlık sayılır (`REFRESH_REUSE_GRACE_SECONDS`, `lib/sessions.ts` `headFromThisToken`, `sameRetry`).
- Giriş: kişi başına günde 100 hatalı deneme tavanı (`lib/rateLimit.ts` `loginPersonDay`). Kişi daha önce şifreyle girdiği ağdan (IP) girmeye devam eder ("kişiyi kendi ağından kilitleme"); cihaz kimliği çerezi yok. Kilitlenince doğrulanmış adrese günde en çok bir bilgi postası. "Şifremi unuttum" ya da yöneticinin koduyla şifre yenilenince kilit kalkar.
- "Şifremi unuttum" sınırı aşınca hata değil "gönderildi" der ama posta göndermez; eski bağlantı yeni istekle ölmez.
- Telefon kodunun hatalı deneme hakkı 20.
- Üye rolü, askı, çıkarma, firma ayarı ve davet iptali yönetici başına 15 dakikada en çok 120 kez (firma başına değil: bir yönetici kovayı doldurup sahibin onu askıya almasını engelleyemesin).

**Davet, devir ve kodlar**
- Sahiplik devredilince eski sahibin sahipken açtığı yönetici davetleri ve yöneticilere ürettiği şifre kodları düşer; üye davetleri kalır (`routes/org.ts` `revokeOwnerOnlyInvitationsBy`). Her kod ve davet kabul edilirken onu üretenin bugünkü yetkisine bakılır (`routes/join.ts` `inviterStillAuthorized`).
- Sahiplik yalnız e-postasını doğrulamış kişiye devredilir (kural e-posta doğrulaması ayarına bağlı; üretimde hep açık).
- E-postası doğrulanmamış yönetici davet postası gönderemez, bağlantıyı kopyalar. Kişi başına günde en çok 50 davet postası.
- Yönetici şifre kodu üretemediğinde nedeni ayrılmaz ("şifresini kendisi yenilemeli"): çalışanın başka firmada çalıştığı ele verilmez.
- Firma ve kişi adlarında "http", "www.", "://" (tam genişlik ve ideografik noktalı yazımlar dahil) yalnız yeni yazımda kabul edilmez. Çıplak alan adı ("Kargo.com Lojistik") serbesttir; davet postasında "Kargo. com" yazılır, tıklanır bağlantıya dönmez.

**Destek ve açılış**
- Firmanın etkinlik kaydında destek çalışanının adı ve iç gerekçesi görünmez.
- Hiç doğrulanmamış ve hiç giriş yapılmamış, 7 günden eski kayıtları silen elle çalışan destek komutu: `signup:purge` (`--yes` olmadan yalnız liste). Firmayı kayıtta değil ilk doğrulamada açmak yapılmadı (kayıt akışını değiştirir, ayrı karar).
- Üretimde demo hesap varsa sistem açılmaz; tohum ve demo betiği yerel olmayan adreste çalışmaz; tohum imajda kalır. Geliştirme kipi yalnız yerel ya da özel ağ adresinde açılır.
- Tanınmayan olay türü "işlendi" sayılmaz; hedefi tanımsız olay da kaybolmaz. Üretimde olay hedefi açıkça yazılır; kayıttan varsayılan yok.
