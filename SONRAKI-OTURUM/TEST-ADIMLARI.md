# Deneme rehberi

Sahibin elle denemeleri. Plan satırları `KALANLAR.md` aşama 1, 2, 3 ve 4'te. Denemeler haftalık "kararlı nokta" sürümünde yapılır.

## Açmak

- Docker Desktop açık olsun, `Platform\BASLAT.bat` → Merkez http://localhost:8088 , site http://localhost:8089 . Kapatmak `Platform\DURDUR.bat`.
- Yerelde postalar gönderilmez; görmek için `Platform\POSTA.bat`.
- Demo hesap yalnız demo kurulumda: `sahip@demo.sellerondata.com` / `Demo12345!`. Gerçek veriyle demo kullanılmaz, `SIFIRLA.bat` çalıştırılmaz.

## Gerçek dosyalar nerede durur

- Kişisel veri içerdiği için depoya girmez: `C:\Users\Gokcan\Desktop\SellerOnData-GERCEK-VERI\<tarih>\` gibi depo dışı bir klasör.
- Claude'a gönderirken başlık satırı ve sorunlu 2–3 satır yeter; alıcı adı ve adresi silinir.

## Toplanacaklar (aşama 1 sürerken)

1. Her taşıyıcının yürürlükteki sözleşme fiyatları: bölen, 30 desi üstü kural, KDV dahil mi, yakıt (sabit mi, dahil mi), mesafe bölgesi var mı, ek hizmetler (kapıda ödeme, mobil bölge, SMS, adresten alım).
2. Her taşıyıcının aynı ayına ait, portaldan değiştirilmeden indirilmiş gönderi dökümü (Excel ya da CSV) ve aynı dönemin e-Fatura PDF'i ile matrah, KDV ve genel toplam.
3. Uç dosyalar: ayrı KDV sütunlu ve yalnız "Toplam" yazan, çok sayfalı Excel, iade satırlı, çok kolili gönderi, 1.000 TL üstü tutar ve ondalıklı desi; LibreOffice, Google Sheets ya da Numbers'ta kaydedilmiş bir Excel.
4. Yurt dışı: bir FedEx, UPS ya da DHL dökümü (karışık hizmetli, yakıtı ayrı yazmayan, inçli ABD dökümü varsa onlar); mümkünse uzun ve taranmış bir PDF fatura.
5. Her taşıyıcıdan 2–3 koli etiketinin fotoğrafı; görünen her barkod ve numara.
6. Bir haftalık sevkiyattan 20–30 koli: takip no, mezura ölçüsü, tartı ağırlığı kâğıda.

## Masa başı deneme (aşama 2)

1. Gerçek firma kurulur (demo değil). Yeni firma: Merkez › Genel Bakış → "Onayla" → DeciShip sihirbazı. Günlük yedek kurulmuş ve bir kez geri yüklenmiş olmalı.
2. **Tarife.** Önce tek yurt içi taşıyıcı. Tarife ekranında bölen (3000), 30 desi üstü satırı ve `*` bölgesine bakın. 3, 12, 30 ve 35 desi için tutarı hesap makinesiyle bulun; DeciShip'in satırdaki "hesap dökümü"yle karşılaştırın.
3. **Döküm.** Aynı taşıyıcının dökümünü yükleyin ve beşine bakın:
   1. KDV hariç "Faturalanan" = e-Fatura matrahı (±1 TL). Yaklaşık %20 fark: KDV yanlış okunmuş. Yakıt kadar fark: net tutar yanlış sütun. Satır eksik: bir sayfa okunmamış.
   2. İçe aktarılan satır sayısı = dökümdeki gönderi sayısı.
   3. Eşleşen satır sayısı ölçtüğünüz koli sayısına yakın mı?
   4. 20–30 kolinin her birinde "bizim desi" = mezura hesabı (E × B × Y / 3000, yukarı yuvarlanır).
   5. "Fark var" satırlarından 5'ini elle yeniden hesaplayın. En az %90'ı elle de fark çıkmalı; kalanların her biri bir nedene bağlanır (tolerans, çok koli, bölge, kapıda ödeme).
4. "Bu eşlemeyi hatırla"yı ilk dosya doğrulanınca işaretleyin; ikinci ayda eşlemeye yine bakın.
5. Sonra öbür yurt içi taşıyıcılar, bir yurt dışı CSV, en son PDF (yapay zekâ). Her PDF'ten sonra Merkez › Abonelik › Yapay zekâ kullanımı'nda tutara bakın; satır sayısını, PDF'teki toplamı ve "kontrol edilecek" satırları sayın.
6. Kapıda ödeme bedelini tarifeye yüzde olarak yazmayın (bugün yanlış hesaplanır).
7. **İlk itiraz:** küçük bir taşıyıcı, 5–10 satır. Metni taşıyıcının kendi PDF'iyle satır satır okuyun (takip no, desi, tutar, KDV). Fark raporunu (Excel/PDF) eklemeyin; yalnız fotoğraf ZIP'i. Aynı gün "Gönderildi olarak işaretle", taşıyıcının vaka numarasını not edin.
8. Her gün Merkez Genel Bakış'tan süresi yaklaşanlara bakın. Ay sonunda Pano, faturanın Excel raporu ve Merkez rakamlarını yan yana koyun.

## Gözle bakılacaklar (kodlandı, tarayıcıda hiç denenmedi)

- Fatura yükleme sihirbazı 3. adımda tarife ipucu; Muhasebe hesabıyla "Bu eşlemeyi hatırla" kutusu; itiraz penceresinin özet satırı.
- Ağırlıkta "1.500" yazan dosyada soru çıkıyor mu (koli ölçümünde 1,5 kg; tarife ve faturada sorulur).
- Merkez › Ekip › Roller: rol oluştur, düzenle, sil, hazır rolü geri getir; yönetici hesabıyla kilitler.
- Merkez › Abonelik › Yapay zekâ kullanımı: birkaç PDF okutup satırları görmek. Yeni "Yapay zekâ harcaması" ve Platform › Yapay zekâ ekranları (gece kuruldu, tuvalden geçmedi): boş, durdurulmuş ve hata hâlleri.
- DeciShip Ölçümler'de çöp kutusu (silinen ölçüm, kalıcı silme).
- Hesabım: Profil, Güvenlik, Firmalarım. Firma kapat (ad + şifre) → firma seçicide "Kapalı" → geri aç.
- Yeni firmayla kayıt → Genel Bakış → Onayla → DeciShip sihirbazı → "Merkez'de onayla" dönüşü.
- Ambalaj (Pak/Zarf): Tarifeler › tarife › "Poşet ve zarf fiyatları" (gerçek FedEx tarife dosyasını içe aktarıp Pak satırlarının geldiğine bakın); Taşıyıcılar › FedEx › poşet/zarf sınırları; Ölçümler › ölçüm ekle/düzelt › Ambalaj; fatura ayrıntısında "Ambalaj farkı" süzgeci ve satır panelindeki "Ambalaj" satırı.

## TagPress ve yapay zekâ geçidi (aşama 2)

Önce yerel TagPress'i kapatın (5420) ve `Tagpress\data` klasörünü masaüstüne kopyalayın (elle yedek). Komutlar `Platform` klasöründe; ayrıntı `Platform/docs/KURULUM.md` "TagPress'i açmak ve yerel veriyi aktarmak" ve "Yapay zekâ geçidi".

**Açılış**
1. `Platform\DURDUR.bat`, sonra `Platform\BASLAT.bat` (yeni imajlar: `tagpress-api`, `tagpress-web`, `ai-api`; var olan veritabanında yeni roller kendiliğinden açılır). Açılmazsa `bash infra/postgres/verify.sh` çıktısını gönderin.
2. `Platform\.env`'e `PLATFORM_OPERATORS=<e-postanız>` yazın, `docker compose -p sellerondata up -d account-api`. Çıkıp yeniden girin: Merkez'in üst menüsünde "Platform" görünmeli; başka hesapta görünmemeli.

**Geçit (anahtar)**
3. Merkez › Platform › Yapay zekâ: Anthropic ve Gemini anahtarını girin (şifre yeniden sorulur), "Sına" geçmeli; ekranda yalnız son 4 hane görünmeli.
4. Geçidi açın: `.env`'e `AI_GATEWAY_URL=http://ai-api:4300`, `docker compose -p sellerondata up -d deciship-api tagpress-api`.
5. Küçük ücretli deneme (~0,01 $): TagPress'te bir işte "Şunu değiştir" (ya da DeciShip'te tek sayfalık PDF). Merkez › Abonelik › Yapay zekâ harcaması'nda satır, araç ve kişi görünmeli; Platform › Yapay zekâ'da bugünkü harcama artmalı.
6. DeciShip PDF'i geçitten okunduysa `.env`'den `ANTHROPIC_API_KEY` satırını silin, `up -d deciship-api`, bir PDF daha deneyin.

**TagPress platformda (demo ya da gerçek firma)**
7. Gerçek firmada TagPress'i açın: `docker compose -p sellerondata exec account-api node dist/subscription-set.js <firma kimliği> tagpress ACTIVE --operator <adınız>`; Merkez › Ekip'te kendinize TagPress Yönetici rolü verin.
8. ⊞ menüsünden TagPress'i açın: `/tagpress/` kabuğun mor bandıyla açılmalı (iş satırı bandın içinde); firma ilk açılışta varsayılan içerikle kurulur.
9. Bir iş ekleyin, onaylayın. Merkez Genel Bakış'ta TagPress kartında sayılar (gelen, onaylanan) artmalı; Analiz ve Veriler'de TagPress sekmesi; Etkinlik'te satırlar adınızla.
10. Kullanıcı rolündeki biriyle (demo: `denetleyici@demo.sellerondata.com`) girin: Ayarlar'da Özellikler, Bağlantılar, Maliyet görünmemeli; tutarlar "—".
11. Firma değiştirin ve çıkış yapın: TagPress de firmayı değiştirmeli, kaydedilmemiş değişiklik varsa sormalı.

**Aktarım (yerel veri → platform)**
12. Merkez'den TagPress'i gerçek firmada bir kez açmış olun (adım 8). Sonra `powershell -File scripts\tagpress-aktar.ps1 -Firma <firma kimliği> -KuruCalisma`: tablo tablo sayı tablosunu okuyun, hiçbir şey yazılmamalı.
13. `-KuruCalisma`'sız çalıştırın. TagPress'te tasarım dilleri, şablonlar, işler, baskı oturumları ve arşiv yerinde mi; birkaç işin görseli açılıyor mu; bir baskı PDF'i alın. Sorun olursa çıkış kodu ve son 20 satırı gönderin.

## E-posta (aşama 3, sunucu kurulunca)

Kayıt doğrulama, şifre sıfırlama, ekip daveti, itiraz hatırlatma; Türkçe ve İngilizce. Gelen kutusuna mı, spam'e mi düşüyor?

## Telefon (aşama 4)

Barkod ve ambalaj (geliştirme sürümüyle de denenir, Metro yeter):

- FedEx etiketinde kamerayı etikete tutun: ekranda yalnız 12 ya da 15 haneli takip no görünmeli (uzun dize değil); kare (2D) barkoda ve uzun "96…" barkoda ayrı ayrı tutup deneyin. Olmazsa etiketin fotoğrafını ve ekranda çıkanı gönderin.
- Ölçü ekranında "Ambalaj": 1,8 kg ve 30×25×8 cm kendi ambalajı → özette "FedEx Pak ile gönderilebilir" sorusu; Pak seçip 3,1 kg → "sınırını aşıyor" sorusu; zarf seçip 35×25×2 cm → kenar uyarısı. Aynı takip no yeniden ölçülünce önceki ambalaj gelmeli.

İlk yarım gün (sahip, ofiste):

1. Eski geliştirme uygulamasında bekleyen ölçüm yoksa kaldırın. Yeni APK'yı bağlantıdan indirip kurun. Mikrofon izni sorulmamalı.
2. Girin: alttaki uygulama çubuğu, üstte sekmeler, sağ üstte Hesap; geri tuşu sırası Geçmiş → Bugün → Merkez; Hesap'ta sürüm satırı.
3. Merkez › Ekip › "Çalışan ekle" (telefon + kod). İkinci telefonda "Davet kodum var" ile katılın; yalnız ölçüm rolünde alt çubuk görünmemeli.
4. 10 koli ölçün (barkod → ağırlık → ölçü → fotoğraf → "Kaydet ve yeni"); koli başına süreyi tutun. Panel › Ölçümler'de 1 dakikada görünmeli, fotoğraflar açılmalı.
5. Uçak kipinde 5 koli: Bugün "5 ölçüm gönderilmeyi bekliyor"; uygulamayı kapatıp açınca hâlâ 5; uçak kipi kapanınca kendiliğinden gider.
6. Sunucu kapalıyken 3 koli, 10 dakika bekleyin: "yeniden denenecek" demeli, sunucu açılınca gitmeli.
7. Yarım ölçüm: barkod + ağırlık girip uygulamayı kapatın; açınca "Devam et" doğru adıma gitmeli, fotoğraf kaybolmamalı.
8. Kamera iznini kaldırın: uygulama "Ayarlarda izin ver" ile telefon ayarını açmalı.
9. Bekleyen 2 ölçüm varken yeni sürümü üstüne kurun: ölçümler kaybolmamalı. Zorunlu güncelleme ekranı doğru indirme adresine gitmeli.
10. Telefonun yazı boyutu en büyükte: tuş takımı ve özet taşmamalı.
11. Tartı fotoğrafı: çekilir, ağırlık elle girilir; panelde kanıt olarak görünür. "Bildirim" bugün yalnız uygulama içi iletidir.

Bir hafta, bir çalışan: kendi telefonuna kendisi kurar (yardım edilmez, takıldığı yer not edilir). Günlük not: koli sayısı, koli başına süre, barkodun ilk denemede okunması, elle yazılan takip no, pil (vardiya başı/sonu). Vardiya sonunda Bugün'de bekleyen 0 olmalı. Fatura gelince eşleşmeyen ölçümlerin barkodu faturadaki takip no ile yan yana konur: en önemli ölçü bu.

İki hafta, 2–3 çalışan: paylaşılan telefonda vardiya değişimi, aynı kolinin iki kez ölçülmesi, hafta sonu yarım kalan ölçüm; her sabah Merkez ve Pano rakamları aynı mı.

Hedefler: koli başına 30 saniyenin altı, barkod ilk denemede %90 üstü, faturayla eşleşme %95 üstü, kaybolan ölçüm 0, 8 saatte pil %40 altı, çökme 0.

## Sorun bildirmek

Bir satır yeter: ekran · ne yaptım · ne bekledim · ne oldu (rakamlarla). Fatura sorununda taşıyıcı, fatura no, satır no, satırın "hesap dökümü" ekran görüntüsü ve ilgili tarife satırı. Telefon sorununda Geçmiş ekranının görüntüsü ve saat. Claude bunu `KALANLAR.md` "Gelen kutusu"na yazar.
