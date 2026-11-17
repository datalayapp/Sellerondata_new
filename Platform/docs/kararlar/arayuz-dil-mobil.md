# Dil, ortak arayüz ve mobil

Parçası olduğu dizin: `Platform/docs/KARARLAR.md` (okuma kuralları orada).

## Dil, para ve biçim

- Her şey Türkçe ve İngilizce: site, Merkez, DeciShip paneli, mobil, posta, hata iletileri. Arayüz metni kodda değil, TR ve EN sözlükte.
- **İlk açılış dili** (kullanıcı kararı 2026-11-12): kayıtlı tercih, yoksa cihaz/tarayıcı dili desteklenenlerdense o, yoksa İngilizce.
  - Kayıtlı tercih sırası: kişinin dili (`Person.locale`), `sod_lang` çerezi, cihazdaki seçim (mobil giriş ekranı); Merkez giriş/kayıtta `?lang=` hepsinden önce.
  - Tarayıcıda `navigator.languages` sırasıyla ilk desteklenen; bölgeli kod ana dile iner (`tr-TR` → tr).
  - Sunucuda dil bilgisi hiç yoksa (gövdede, `Accept-Language`'ta ya da oturumda desteklenen dil yok) yeni hesap, posta ve hata iletisi İngilizce.
  - Tek kural `@sellerondata/contracts` `pickInitialLocale` + `DEFAULT_LOCALE` (`en`); site `site.js` içinde küçük kopyası. Demo hesaplar Türkçe.
- **Site dili:** TR bağlantılarında da `?lang=tr`; dil seçimi çereze yazılır, uygulama aynı dili açar. Öneri bandı yok. Kendiliğinden yönlendirme (kullanıcı kararı 2026-11-12): `sod_lang` çerezi yoksa ve tarayıcı dili kurala göre sayfanın dilinden farklıysa sekmede bir kez aynı sayfanın öbür dildeki adresine gidilir; çerez varsa, bot ya da otomasyonsa (`navigator.webdriver`), 404'te ve betiksiz ziyaretçide yönlendirme yok. `hreflang="x-default"` İngilizce sayfadır.
- Firma para birimi ülkeden gelir: TR→TRY, DE/NL/FR→EUR, GB→GBP, diğerleri USD. Ayarlarda dördü de seçilebilir.
- Sayı, para ve tarih yazımı bütün yüzeylerde tektir; kurallar aşağıda "Ortak arayüz" › Yazım. Yeni yazım seçimi sahibe tek tek sorulmaz.

## Ortak arayüz

Tasarım ayrıntısı: DESIGN.md.

**Tasarım dili**
- Merkez ve DeciShip paneli: **D09 Renk bandı** ortak kabuk; DeciShip, Merkez'in içinde açılıyormuş gibi görünür. Mobil: **D05 Yoğun çalışma masası**. OrderLoom ve TagPress için dil seçilmedi; sorulmadan varsayılmaz.
- Giriş, kayıt, katılım, şifre ekranları ve firmasız kişinin "Firma oluştur" ekranı site tasarımında kalır (`AuthFrame`). Hesabım (Profil, Güvenlik, Firmalarım) ve Yeni firma Merkez'in kabuğundadır; her bölüm kendi adresinde (`/account/profile`, `/account/security`, `/account/firms`). Ayrıntı: DESIGN.md §4.
- Birincil düğme rengi bugünkü hâliyle kalır (2026-11-10): sayfa içinde Merkez'de lacivert `#0f2a5c`, araçta aracın kendi rengi (DeciShip `#1d5bd8`); üst bandın üstünde Merkez'de sarı, araçta beyaz. Ayrıntı: DESIGN.md §2 "Birincil düğme kuralı".
- Sade arayüz: ekran başına tek birincil eylem, nadir eylemler ⋯ menüsünde, az süzgeç, kısa metin. Sadeleştirme özellik silmez. Ayrıntı: DESIGN.md §6.
- Tasarım değişikliği önce tuvalde gösterilir, onaydan sonra kodlanır. Mevcut bileşenlerle ve D09/D05 diliyle kurulan yeni ekran ve akış doğrudan kodlanabilir.
- Ortak arayüz parçası değişince bütün kopyalarına uygulanır.

**Yapı**
- Renk ve ölçülerin tek kaynağı `Platform/packages/tokens/tokens.json`; çıktılar üretilir ve commit edilir, elle düzenlenmez. Her ürünün beş tonluk paleti oradadır; kontrast testi var.
- Yüzeyler arası farklar adlı "fark katmanı"nda durur (`tokens.json` `surfaces.*`, DeciShip `app.css` sonundaki "DeciShip farkları"). Farkları tek değere indirmek sahibin kararıdır.
- Gece mavisi iki ad: `--night` `#0a1a3a` (zemin), `--brand-ink` `#0f2a5c` (işaret).
- DeciShip paneli kabuğun bileşenlerini ve `primitives.css`'ini kullanır; `ui.tsx`, `Toast.tsx`, `Icon.tsx` yalnız yeniden dışa aktarır.
- Sayı, para, tarih biçimleme tek pakette: `@sellerondata/format`. Hesap motorunun kayıtlı not tarihi (`fmtDate`) ve kayıtlı not biçimi bilerek dışarıda kalır (eski kayıtların çevirisi bozulmasın).
- Metin denetimi tek betik: `Platform/scripts/check-i18n.mjs`; dört yüzeyde (`Deciship/apps/web`, mobil, `hub-web`, `shell`) `--strict` sıfır. Satır içi istisna `// i18n-ok: <neden>`.
- Görsel karşılaştırma `npm run test:visual`; taban görüntüleri depoda değil, sabit klasörde (`%LOCALAPPDATA%\SellerOnData\gorsel`, `VISUAL_DIR` ile değişir).

**Yazım**
- Eksi sıfır yok: yuvarlanmış değer sıfırsa işaret yazılmaz (`0,00 ₺`).
- Ekranda Unicode eksi (−); kayıtlı, dışa giden ve girdi metninde ASCII (-).
- Para: Türkçe `1.234,50 ₺`, İngilizce `₺1,234.50`. Bilinmeyen para kodu boşluklu (`CHF 12.50`). Ekranda tutar ile simge arası bölünmez boşluk.
- Tarih: İngilizce `27 Oct 2026`, Türkçe `27 Eki 2026`. Tarih-saat 4 haneli yıl ve 24 saat (mobil dahil); İngilizcede tarih-saatte virgül. Geçersiz tarih `—`.
- Yüzde: genel kural en çok 1 basamak; panelde 2 basamak.
- Yuvarlama hesap motorunun kuralıyla (1,005 → 1,01).

**Davranış**
- Pencerede bir şey yazılmışsa Esc, dış tıklama ve X önce sorar ("Yazdıklarınız silinsin mi?" sarı şeridi; kapatmak için `guard={false}`); pencerenin kendi "Vazgeç" düğmesi sormaz. İşlem sürerken pencere kapanmaz.
- Bildirim masaüstünde sağ üstte bandın altında, telefonda altta (DESIGN.md §4). Eylemli bildirim her yerde 8 sn; hata bildirimi ekran okuyucuya `role=alert` ile söylenir.
- Sayfa çıkış uyarısı: DeciShip Ayarlar, fatura yükleme (2. adımdan yükleme bitene kadar) ve tarife düzenleyici.
- Firma değiştirirken kaydedilmemiş değişiklik varsa tarayıcının kendi onay kutusu çıkar (dil değişimindeki desen).

**Hata olunca kullanıcı ortada kalmaz** (ayrıntı: DESIGN.md §4b, ARCHITECTURE.md §8, `Deciship/SPEC.md` §6.2)
- Beklenmeyen hatada "Bu bölüm açılamadı" ekranı: "Sayfayı yenile" ve ana sayfa bağlantısı; menü ve bant yerinde kalır. "Tekrar dene" yok.
- Çıkış sunucuya ulaşamazsa kişi sayfada kalır, "Çıkış yapılamadı. Oturumunuz hâlâ açık" der. Sunucu "oturum yok" derse çıkış tamam sayılır.
- Çökme raporu sunucuya gönderilmez; çıkış öbür sekmelere duyurulmaz.

**Erişilebilirlik**
- Alan ve kutu kenarlıkları beyazda en az 3:1 (`--border-strong` `#8f8a80`, `--border-hover` `#6b665d`; DeciShip paneli aynı, mobil farklı). Beğenilmezse `tokens.json`'da iki değer geri alınır.
- Odak her yerde mavi (`#1d5bd8`), hata kırmızı (`#c4271b`); giriş sayfasında amber yalnız düğmede.
- Windows yüksek kontrast kipi desteklenir (`a11y.css`). Koyu tema yoktur.
- Bantta alt metin en çok iki satır; telefonda başlık en çok iki satır; telefonda menünün iki kenarı solar.

## Mobil

- Tek SellerOnData uygulaması; araçlar içinde açılır, sekmeler role göre görünür. Kullanıcının telefonu Android.
- Hafif Merkez (kullanıcı kararı 2026-11-13): Genel Bakış · Etkinlik · Ekip. Analiz telefonda yok; Genel Bakış'ta "Ayrıntılı analiz ve veriler web'de" kartı. Ekip'te "Çalışan ekle" (telefon + kod daveti, yönetici rolü verilmez). Rol değiştirme, davet yönetimi ve abonelik web'de.
- Gezinme (2026-11-13): altta uygulama geçiş çubuğu (Merkez · DeciShip · OrderLoom · TagPress; açık olmayan soluk), uygulamanın bölümleri üstte sekme, Hesap sağ üstteki profil düğmesinde. Tek uygulamalı çalışan alt çubuğu görmez. DeciShip'te web paneline erişimi olana "Yönetim paneli" düğmesi. Web'in telefon görünümü aynı düzende (üst satır sekmelerle sabit, altta `.sod-dock`).
- Mobil iş kodlanır ve otomatik testten geçer; raporda "telefonda denenmedi" yazılır, her iş için yeni APK derlenmez.
- **Yarım ölçüm** telefonda kişi + firma anahtarıyla **2 gün** saklanır (gönderilmiş kayıt 3 gün kaldığı için ondan kısa olmalı). Başka firmaya geçince eski firmanın taslağı silinmez. "Devam et" ilk eksik adıma gider. Ayrıntı: `Deciship/SPEC.md` §6.2.
- Akla aykırı ölçü eşikleri sabit: kenar 150 cm, ağırlık 70 kg, desi ağırlığın 20 katı; uyarı "Değerler doğru" denmeden kaydettirmez. 400 cm üstü kırpılmaz, geçersiz sayılır.
- Kuyrukta yalnız bilinen kayıt hataları "Hatalı" olur; sunucu ayarı sorununda ölçüm telefonda bekler ve "yöneticinize bildirin" der.
- Galeriden seçilen fotoğraf koli fotoğrafı sayılmaz ("diğer fotoğraf" olur).

**Mobil sürüm uyumu** (ayrıntı: ARCHITECTURE.md §11 "Mobil sürüm uyumu", `Deciship/SPEC.md` §6.3)
- Sürüm ucu Hesap servisinde: `GET /api/account/client-policy`. Zorlama iki API'de aynı kancayla. `MIN_MOBILE_VERSION` boşsa her şey kapalı.
- Karşılaştırma insan sürümüyle (`1.1.0`), `versionCode` ile değil. Başlıksız istek denetlenmez; eski APK ve web etkilenmez.
- Yeni yerel modül yok (`expo-application`, `expo-updates` yok); uzaktan güncelleme yayın hazırlığında.
- Güncelleme ekranında çıkış düğmesi ve elle gönderim yok; telefondaki kuyruk korunur, kullanıcıya "silmeyin, üzerine kurun" denir.
- Sunucu adresi alanı yalnız `APP_ENV=development` derlemesinde görünür; üretim derlemesinde adres https zorunlu.
- `eas.json` derleme profillerinin tek kaynağıdır; yerel betik (`Deciship/scripts/android-build.ps1`) oradan okur, bulut EAS kullanılmaz.
