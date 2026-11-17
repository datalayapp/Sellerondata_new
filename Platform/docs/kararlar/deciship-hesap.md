# DeciShip ürün kararları: fatura ve hesap

Parçası olduğu dizin: `Platform/docs/KARARLAR.md` (okuma kuralları orada).

## Fatura yükleme ve okuma

- Aynı dosya farklı taşıyıcıya yüklenirse reddedilir; bir gönderi iki faturada sayılmaz.
- "Alacak dekontu" terimi kalır (EN "credit note").
- Noktalı ABD biçimli tarih (`10.05.2026`) soru sorulmadan gün/ay okunur.
- **Ağırlıkta "1.500" yazımı (K36)** (kullanıcı kararı 2026-11-14). Teknik: `Deciship/SPEC.md` (core `ambiguousWeightText`).
  - Nokta ve ardından tam üç hane ("1.500", "12.000") Türkçe binlik (1500 kg) de İngilizce ondalık (1,5 kg) da olabilir.
  - Koli ölçümünde (ölçüm formu, mobil, ölçüm API'si) sorulmaz: 1,5 kg okunur.
  - Tarife ve faturada sessizce seçilmez: tarife düzenleyicide alanın altında "1,5 kg mı, 1.500 kg mı?"; PDF fatura adımında tablonun üstünde bir kez (seçim bütün belirsiz ağırlıklara). Seçilene dek kayıt ya da içe aktarma kapalı. PDF'te yapay zekânın okuduğu ağırlık metinde "1.500" gibi basılıysa da aynı soru. Tarife PDF'inde okunan değer uyarıyla gösterilir.
  - Tarife ve fatura dosyasında sayı biçimi dosyadan anlaşılmıyorsa dosya başına bir kez sorulur (tarifede "Türkçe mi İngilizce mi" seçeneği; faturada eşleme adımındaki "Ağırlık yazımını seçin": yalnız ağırlığı belirler, tutarlar değişmez, onayla geçilmez, taşıyıcının kayıtlı eşlemesine yazılmaz, sonraki dosyada yine sorulur).
  - Excel'in gerçek sayı hücresinde ve biçimi belli dosyada soru yok.
  - İngilizce arayüzde aynası: virgül ve tam üç hane ("1,500") aynı kuralla sorulur ("1.5 kg or 1,500 kg?"). İngilizcede nokta ("1.500"), Türkçede virgül ("1,500") dilin ondalığıdır, sorulmaz.
  - Dosya ve PDF arayüz diline değil dosyanın kanıtına bakar: kanıtsız dosyada "1.500" de "1,500" de sorulur. PDF'te açık sayı biçimi kanıtı (gruplu "1.234,56" ya da para işaretli "250,00 TL") yoksa ikisi de sorulur; kanıt varsa ve okunan değer ona uyuyorsa sorulmaz (para işaretli ya da tek türlü basılmış değer zaten sorulmaz).
  - Seçim ağırlığın yazım biçimidir: aynı dosyada "1.500" ve "1,500" birlikte geçerse her biri kendi ayırıcısıyla okunur, soru ikisini de gösterir.
  - Arayüz dili değişince ekranda duran, kaydedilmemiş sayılar (tarife, içe aktarma sihirbazı, Ayarlar, kurulum, itiraz sonucu, KDV oranı, PDF adımı) anlamını korur (Türkçe "1,500" kg İngilizcede "1.5" olur; seçilmemiş soru yeni dilde de durur).
  - "1500", "1.5" değişmedi. Tutarlar ve ölçüler (cm) bu kuralın dışında. Soruların görünümü bugünkü hâliyle onaylıdır.
- **PDF'te tutmayan satır** (kullanıcı kararı): yapay zekânın okuduğu takip no ya da tutar PDF'in metninde yoksa fatura yine yüklenir; satır "Kontrol edilecek / İncele" olur ve nedeni görünür. Yükleme özetinde kaç satırın tutmadığı yazar; yüklemeyi durduran onay penceresi yok.
- Taşıyıcı değişince süren okuma iptal edilir; okuma sürerken "Okumayı durdur" bağlantısı var. Sunucu yapay zekâ okumasını yine tamamlar.
- **Okunamayan satırlar:** fatura özet kartında tek satır uyarı ve "Ayrıntı" penceresi; satır listesine girmez.
- **Yüklemede fatura gününde geçerli tarife önseçilir** (kullanıcı kararı K2): o gün geçerli etkin tarife (birden çoksa "Varsayılan", sonra dönem tarifesi, sonra en son güncellenen); yoksa taşıyıcının varsayılanı. Kişi elle seçmediyse fatura tarihi değişince önseçim yenilenir. Sunucu da tarife verilmeyen içe aktarmada ve taşıyıcı değişen başlık düzeltmesinde aynı kuralı uygular. Kayıtlı faturanın "Yeni tarifeyle hesapla"sı faturanın tarifesiyle, yoksa varsayılanla kalır.
- **Taşıyıcının kayıtlı sütun eşlemesini yalnız ayar izni olan değiştirir** (kullanıcı kararı K3): "Bu eşlemeyi hatırla" `deciship.settings.manage` iznine bağlı. İzni olmayan fatura yükler, kutu kapalıdır ve nedeni yazar; sunucu isteği yok sayar. Kayıtlı eşlemeyi kullanmak herkese açık.
- **Yapay zekâ ile sütun eşlemede kişisel veri maskelenir** (kullanıcı kararı 2026-11-12). Kural `Deciship/apps/api/src/services/aiMappingMask.ts`.
  - Sağlayıcıya giden örnek hücrelerden kişisel olabilecekler (ad, firma adı, adres, telefon, e-posta, posta kodu, şehir, kimlik/vergi no; takip ve fatura no da) biçimi korunarak gider: büyük harf `A`, küçük harf `a`, rakam `9`, noktalama ve uzunluk aynen.
  - Başlık satırı veri gibi görünüyorsa ya da tek başlık kuşkuluysa başlık da gizlenir ("#<sıra>"). Gerçek başlıklar ve kişisel olmayan değerler (tutar, ağırlık, ölçü, sayısal tarih, para/ülke/birim kodu, ülke/hizmet/ücret etiketi) aynen gider. Emin olunamayan hücre maskelenir.
  - PDF fatura okumada belgenin kendisi gider; bu kural onu kapsamaz.

**KDV**
- "Tutarlar KDV dahil" seçiliyken navlun ve ek ücret sütunlarının KDV'si eşleme ekranında gösterilir ve değiştirilebilir; kanıt yoksa "KDV hariç" varsayılır ve bu açıkça söylenir.
- **Tutarlar KDV hariç gösterilir ve bu yazılır:** saklanan ve gösterilen bütün fatura tutarları KDV hariçtir; fatura özeti, satır tablosu tutar başlıkları, Pano, rapor (Excel, PDF) ve itiraz metni "KDV hariç" / "excl. VAT" yazar.
- **İtiraz metninde KDV dahil tutar da yazılır** (kullanıcı kararı K43): faturanın KDV oranı biliniyorsa satırda faturalanan tutar ve toplam talep "KDV hariç X, KDV dahil Y" diye yazılır; itiraz penceresinin özet satırı da.
  - Oran yalnız şöyle bilinir: tablo faturası "Tutarlar KDV dahil" ile eşlendiyse eşlemenin oranı; PDF'te belgede oran KDV sözcüğünün yanında yazıyorsa o (metinde yoksa modelin okuduğu oran kabul edilmez); yazmıyor ama tutarlar KDV dahil okunduysa %20 (KDV belirsiz okumada yok).
  - KDV hariç eşlenmiş tablo faturasında ve bu karardan önce yüklenen PDF faturada metin yalnız KDV hariç. Kaydedilen talep tutarı KDV hariç kalır. Geri alma: `services/evidence.ts` `invoiceVatPct` null döner.

## Emin olunmayan fark kesin gösterilmez

(2026-11-10) Böyle satırlar **İncele** sınıfına düşer (EN "Review"); tutarı büyük "Fazla ödeme" rakamına eklenmez, ayrı gösterilir. Teknik: `Deciship/SPEC.md` §3.13.

- **Yakıt:** tarifede seçim: "Yakıt değişken" ya da "Sözleşmede sabit". Değişkense faturadaki oran kabul edilir, fatura başında oran notu çıkar; sabitse fark gösterilir. Örnek veri tarifeleri bilerek "sabit".
  - **Yurt içi varsayılanı** (2026-11-14, KALANLAR 1.1): yeni tarife (elle, Excel/CSV, PDF) yurt içi taşıyıcıda 3000 bölen ve sabit yakıtla, yurt dışında 5000 ve değişken yakıtla başlar. Yurt içi: `aras`, `yurtici`, `mng`, `ptt` ve adında bilinen yurt dışı taşıyıcı (TNT, GLS, DPD, Aramex, "yurt dışı" …) geçmeyen "Diğer" taşıyıcı (Sürat, HepsiJet, Kolay Gelsin …). PTT ve "Diğer"de yeni tarife ekranında "Kapsam" seçilir; içe aktarmada bölen ve yakıt türü sorulur. Kayıtlı tarifeler değişmez.
  - **Yakıt ayrı yazılmamışsa:** değişken yakıtlı tarifede faturada yakıt ayrı sütunda değilse (navlunun içinde) fiyat farkı kesin sayılmaz, satır "İncele" olur (fark taşıyıcının güncel yakıt oranından olabilir). Ağırlık, ölçü ve ek ücret farkı kesin kalır; sabit yakıtta değişiklik yok; %60 eşiği aynen. Geri alma: `core/src/compare.ts` `VARIABLE_FUEL_WITHOUT_COLUMN_IS_REVIEW = false`.
  - **Yakıt ek ücrete de uygulanmışsa:** sabit yakıtlı tarifede faturadaki yakıt, tarifedeki oranın taşıma + ek ücret toplamına uygulanmış hâliyse fark kesin sayılmaz (sözleşme izin veriyorsa fark yoktur); gerekçede fazla yakıt tutarı yazar. Oran farklıysa fark kesin kalır. Belirsiz olan yalnız fazla yakıttır: fark ondan büyükse fazla yakıt Beklenen'e faturadaki tutarıyla eklenir, kalan fark kesin kalır; satır yalnız fark fazla yakıttan ibaretse "İncele" olur.
  - Kesin ek ücret farkı ile belirsiz yakıt aynı satırdaysa satırın tamamı "İncele" olur (kullanıcı kararı 2026-11-13).
- **Karışık hizmet:** satırın hizmeti tarifedeki hizmetten farklıysa fiyat farkı üretilmez; satır "İncele" olur, ekran "bu hizmet için tarife ekleyin" der.
  - Hizmet adları serbest metin olduğu için yalnız hizmet sınıfı sözcüklerine bakılır (priority, economy, express, saver…); "IE", "IP" gibi kısaltmalar tanınır. Adlardan biri boşsa ya da sınıf sözcüğü taşımıyorsa satır farklı sayılmaz.
  - **Tarifenin hizmeti belirsizse:** faturada birden çok hizmet varken tarifede hizmet adı boş ya da tanınmıyorsa farkı olan satırlar "İncele" olur, "tarifeye hizmet adını yazın" denir; tarife uyumu raporu ülke istisnası önermez. Tek hizmetli faturada değişiklik yok.
  - **Satırın hizmeti boşsa** (kullanıcı kararı K39): tarifenin hizmeti belliyken (sınıf sözcüğü taşıyan ad) satırda hizmet adı yoksa farkı olan satır "İncele" olur. Uyumlu satır işaretlenmez. Faturanın hiçbir satırında hizmet adı yoksa (hizmet sütunu olmayan yurt içi tablosu) kural uygulanmaz.
- **Mükerrer:** aynı taşıyıcı ve aynı tutar ise "Mükerrer (kesin)"; tutar farklıysa "İncele" (ek fatura olabilir). Başka taşıyıcının faturasında görülen takip no da "İncele" olur. Aynı tutarlı önceki satırın açıklaması (hizmet, ek ücret kodları) farklıysa da "İncele" (KALANLAR 1.8).
- **Çok koli şüphesi** (kullanıcı kararı 2026-11-14; gerçek çözüm KALANLAR 5.2): takip no aynı dosyada birden çok ücret satırındaysa o satırların hiçbir farkı kesin değildir (mükerrer dahil, "İncele"); takip no birden çok kez ölçüldüyse (telefonda "Yeniden ölç") ağırlık/ölçü farkı "İncele". Düzeltme (ölçüm anı aynı) tek ölçüm sayılır. Aynı faturada iki kez kesilmiş gerçek mükerrer de bu yüzden "İncele" görünür; kullanıcı bunu bilerek seçti (yanlış itiraz riski yok), kural gerçek faturalar görülünce netleşir.
- **Birebir aynı satır:** atlanmaz; içeri alınır ve "Mükerrer" gösterilir. Dosyadaki gönderilerin en az yarısı başka fatura(lar)da varsa yükleme "Yine de yükle" onayı ister; pay birleşik sayılır (iki eski faturaya %30 + %30 yayılmış gönderiler de); sunucu da denetler.
- **İade / düzeltme satırı:** net tutarı eksi olan satır tarifeyle karşılaştırılmaz; "Tarife yok" sınıfında durur, notu "İade/düzeltme satırı (eksi tutar)". Beklenen'e ve fazla ödemeye girmez, fatura toplamında kalır. Mükerrer sayılmaz, aynı takip no'lu asıl ücreti de mükerrer yapmaz. Tutarı önceki bir ücrete eşit iade o ücreti iptal eder: iptal edilip yeniden faturalanan gönderi mükerrer değildir, aynı faturada iptal edilen ücret karşılaştırılmaz ("İade ile iptal edildi"); tutarı hiçbir ücrete eşit olmayan iade varsa mükerrer "İncele" olur.
- **Sıfır tutarlı satır** (kullanıcı kararı 2026-11-13): tarifeyle karşılaştırılmaz, notu "Ücretsiz satır (tutar 0) — tarifeyle karşılaştırılmaz"; Karşılaştırılan, Beklenen ve fazla ödemeye girmez, Faturalanan'a 0 ekler; mükerrer kuralında önceki görünüm sayılmaz.
- **Ölçüm sınırı:** kendi ölçümümüzün her kenarına tolerans kadar pay eklenir; fark bu payın içindeyse satır "Uyumlu" sayılır, "fark ölçüm toleransı içinde" notu çıkar. Tolerans ayarlardan değişir. Yeni firmanın varsayılanı 0,5 cm (2026-11-14; kenarlar zaten yukarı yuvarlanır, 1 cm sık görülen 1–2 desi şişirmesini gizliyordu); kayıtlı değeri olan firma kendi değerinde kalır.
- **Mesafe bölgeli tarife** (2026-11-14, KALANLAR 1.9): fiyat satırlarında iki ya da daha çok mesafe bölgesi ("Şehir içi", "Yakın", "Uzak", km kademesi) gönderinin bölgesi faturadan doğrulanamaz (il ve mesafe eşlemesi yok). Kesin fark her bölgeyle hesaplanır ve en küçüğü talep edilir (ağırlık farkında da bölge fiyat aralığı talebe girmez); bir bölgenin fiyatıyla fark yoksa satır "İncele" olur.
- **Açık uçlu tarife satırı** (2026-11-14, KALANLAR 1.7): "kg başı" yazmayan "31+", "30 desi üzeri", "her ilave desi" satırı son satırın fiyatı + her ilave birim × fiyat okunur (30 desi 195, üstü 8 → 35 desi 235); okunamayan yazım, tablodaki artışa göre çok düşük ilave fiyatı, çelişen iki aşım kuralı ve kısa biten bölgedeki kural tahmin edilmez, sorulur. İçe aktarmada "kg başı" (fiyat × toplam ağırlık) ya da "sabit fiyat" seçilebilir. Bölge eşlemesi olmayan tek bölgeli yeni yurt içi tarifeye `*` kendiliğinden eklenir (yurt dışında ve kayıtlı tarifede eklenmez).
- **Parasız fark:** tutara etkisi olmayan ağırlık farkı "Uyumlu" sayılır, notla gösterilir.
- **Tutar toleransı:** firmanın para biriminde tutulur; dövizli faturada kurla çevrilerek uygulanır. Varsayılan para birimine göre: TRY 5, USD/EUR/GBP 0,5. Para birimi değişince varsayılandaki tolerans yenisine geçer, elle girilmiş değer kalır.
- **Kur alınamazsa:** sabit yedek oran yok. O para çiftinin saklı en yakın önceki günün kuru kullanılır, en çok 7 gün geriye; satır notunda "Kur gg.aa.yyyy tarihli" yazar. O da yoksa satır "Kur alınamadı" olur (Tarife yok sınıfı): fazla ödemeye girmez, fatura "Yeniden karşılaştır" uyarısı gösterir. Satır kuru ve tutar toleransının kuru aynı kurala uyar. Kararı verilmiş satırlar değişmez, farkı "bekleyen değişiklik" olarak gösterilir.
  - Eski tarihli kurla hesaplanan satır "İncele" olur: kesin fazla ödemeye ve kesin itiraz talebine girmez; faturada "N satır eski tarihli kurla hesaplandı — Yeniden karşılaştır" uyarısı, Merkez'in kur uyarısı bunları da sayar. Hafta sonu için önceki iş gününün kuru eski sayılmaz. Taze kur gelince "Yeniden karşılaştır" kesinleştirir; kararı verilmiş satırda rakam aynıysa yalnız not ve işaret kalkar.
- Ölçüm ekranındaki desi firmanın böleniyle, fatura karşılaştırması tarifenin böleni ve kenar yuvarlama kuralıyla hesaplanır; ikisi farklı olabilir.
- Gerçek faturalar görülmeden yapılmayacaklar: sistemin her satıra tarifeyi kendisi seçmesi, aynı gönderinin ayrı satırlarını birleştirme.

## Geçmiş sonuçlar donar

(2026-11-10) Bir fatura hesaplandığı günkü tarife ve ayarla kalır; sonraki değişiklik eski rakamı kendiliğinden değiştirmez. Teknik: `Deciship/SPEC.md` §3.14.

- **Tarife değişince:** eski fatura eski tarifeyle kalır, "tarife değişti" notu çıkar; "Yeni tarifeyle hesapla" denirse önce/sonra rakamı görülüp onaylanır.
- **Ölçüm değişince:** karar verilmemiş satır yeni ölçümle hesaplanır, "ölçüm değişti, eski fark şuydu" notu çıkar. Karar verilmiş ("Doğrulandı", "Uyumlu sayıldı") ya da itiraza girmiş satır donar; değiştirmek için önce/sonra görülüp onaylanır.
- **İtirazı gönderilmiş satır:** yeni ölçümle hesaplatmak için önce itiraz geri çekilir; onay yetmez.
- Tutarı değiştirmeyen yeni ölçüm (ör. aynı desi) sormadan uygulanır; "yeniden hesap bekliyor" işareti kalıcı kalmaz.
- **Tolerans ayarı değişince:** eski faturalar eski ayarla kalır. Kaydedince tek soru: "N fatura eski ayarla hesaplı; yeni ayara geçirilsin mi?"; toplu önce/sonra gösterilir, onayla geçirilir. Aynı işlem sonradan Ayarlar'dan da yapılır.
- **Faturası olan tarife silinince:** tarife gerçekten silinir; eski faturalar aynı rakamda kalır, tarife adının yanında "silindi" yazar.
- **Toplu geçişte önizlemeden sonra değişen fatura** (kullanıcı kararı K4): değişmeyen faturalar yazılır; önizlemeden sonra değişen fatura (ölçüm ya da başlık düzeltmesi, silme) yazılmaz, "önizlemeden sonra değişti" diye atlanır ve listelenir. Önizlemeden sonra kapsama giren ya da itirazı kapanan fatura bu onayla taşınmaz, sayısı söylenir.
  - Bitişte pencere yazılanı, atlananları (faturaya bağlantıyla) ve kalanları gösterir; tek eylem "Yeniden önizle".
  - Uygulama önizlemenin planını yeniden hesaplamadan yazar. Tarife sürümü ya da ayar önizlemeden sonra değiştiyse ya da aynı önizleme daha önce uygulandıysa hiçbir fatura yazılmaz, yeni önizleme açılır. Teknik: SPEC §3.14, §5.13.
- **Arka plandaki yeniden hesap 5 kez düşerse** (kullanıcı kararı K37): fatura sayfasında "Yeniden hesap yapılamadı … Yeniden karşılaştır" uyarısı, Merkez Genel Bakış'ta "N faturada yeniden hesap yapılamadı" bekleyeni; elle "Yeniden karşılaştır" uyarıyı kaldırır ve arka plan denemesini baştan başlatır. Günde bir sonsuz deneme yok.
