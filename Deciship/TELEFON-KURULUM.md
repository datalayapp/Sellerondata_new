# Kendi Android telefonunuzda SellerOnData (kamera ile gerçek deneme)

Gerçek FedEx faturasıyla deneme en sonda: [Gerçek FedEx faturasıyla deneme](#gerçek-fedex-faturasıyla-deneme).

En kolay yol **USB kablosu**. Wi-Fi, IP adresi ve Güvenlik Duvarı ayarı gerekmez: telefon, bilgisayardaki sunucuya kablo üzerinden bağlanır (`adb reverse`).

**Gerçek kullanımda** (`Platform/docs/KURULUM.md` "Gerçek kullanıma geçiş") gateway yalnız `127.0.0.1`'de dinler: USB ya da kablosuz hata ayıklama (Seçenek A) çalışır, aynı Wi-Fi ile doğrudan bağlantı (Seçenek B) çalışmaz. Geçişten önce telefonda bekleyen ölçüm kalmasın (Hesap ekranı); geçişten sonra demo oturumundan çıkıp yeni hesapla girin.

Expo Go ile çalışmaz: uygulama yerel modül (ölçüm) taşır, kendi APK'sı kurulur (Adım 4; geliştirmede dev client APK).

Gerekenler:
- Android telefon (Android 8+).
- Veri aktarabilen bir USB kablosu (bazı şarj kabloları veri taşımaz).
- Bilgisayarda SellerOnData sistemi çalışıyor olmalı; kurulum ve başlatma: `Platform/docs/KURULUM.md`. Gateway `http://localhost:8088` adresinden açılır (hesap + DeciShip API tek adresten).

## Adım 1 — Geliştirici seçeneklerini açın (bir kerelik)
1. Telefonda **Ayarlar → Telefon hakkında**'yı açın.
   - Samsung: Ayarlar → Telefon hakkında → **Yazılım bilgileri**.
   - Xiaomi: Ayarlar → Telefon hakkında.
2. **Yapı numarası**'na (Xiaomi'de **MIUI/HyperOS sürümü**) **7 kez** art arda dokunun. "Artık bir geliştiricisiniz" yazısı çıkar; PIN isteyebilir.

## Adım 2 — USB hata ayıklamayı açın (bir kerelik)
1. **Ayarlar → Sistem → Geliştirici seçenekleri**'ni açın.
   - Samsung: Ayarlar'ın en altında **Geliştirici seçenekleri**.
   - Xiaomi: Ek ayarlar → Geliştirici seçenekleri.
2. **USB hata ayıklama**'yı açın.
3. Yalnızca Xiaomi'de, şunları da açın:
   - **USB üzerinden yükle**
   - **USB hata ayıklama (Güvenlik ayarları)**
   Bunlar için Mi hesabıyla giriş gerekebilir.

## Adım 3 — Telefonu bağlayın
1. Telefonu USB kablosuyla bilgisayara takın.
2. Telefonda **"USB hata ayıklamasına izin verilsin mi?"** sorusu çıkar. **"Bu bilgisayara her zaman izin ver"** kutusunu işaretleyip **İzin ver**'e dokunun.
   - Soru çıkmazsa bildirim çubuğundaki USB bildirimine dokunup modu **Dosya aktarımı** yapın.

## Adım 4 — Uygulamayı kurun ve bağlantıyı açın
Bilgisayarda, `Deciship` klasöründe PowerShell'i açıp şunu çalıştırın:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\phone.ps1
```

Betik telefonu bulur, uygulamayı kurar ya da günceller ve bağlantıyı açar (`8088`). "Hazır." yazısını görmelisiniz.

> **Telefonda eski DeciShip uygulaması (`com.selleron.deciship`) varsa:** SellerOnData uygulaması (`com.sellerondata.app`) onun yanına ayrı kurulur, eski oturumu ve eski kuyruğu görmez. Eski uygulamada gönderilmemiş ölçüm kalmadığından emin olduktan sonra kaldırın: `adb uninstall com.selleron.deciship`.

## Adım 5 — Giriş
1. Telefonda **SellerOnData**'yı açın.
2. Geliştirme derlemesinde giriş ekranının en altında sunucu adresi görünür; `http://127.0.0.1:8088` olmalı (varsayılan budur; tek adres gateway'dir, sonuna `/api` eklemeyin). Farklıysa üzerine dokunup düzeltin. Üretim derlemesinde bu alan yoktur.
3. Giriş:
   - E-posta **veya** telefon + şifre (kullanıcı adıyla giriş yok).
   - E-postası olmayan çalışan ilk girişini **Davet kodum var** ile yapar: telefon + yöneticinin Merkez'de ürettiği 8 karakterli kod, sonra ad ve yeni şifre. Telefon zaten kayıtlıysa mevcut şifre sorulur.
   - Şifresini unutan çalışan yöneticiden yeni kod ister, aynı ekrandan yeni şifre belirler.
   - Birden çok firması olan kişi girişten sonra firma seçer; sonra **Hesap** ekranından değiştirir.
4. Kamera izni sorulunca **İzin ver**'e dokunun.

Yalnız Ölçüm rolündeki kişi sekme çubuğu görmez, doğrudan **Bugün** ekranı açılır. Hesap ve çıkış sağ üstteki kişi simgesindedir.

## Adım 6 — Kamerayla deneyin
- **Barkod:** Elinizdeki herhangi bir kargo etiketini ya da ürün barkodunu kameraya tutun. Okununca titreşir ve ses çıkarır.
- **Tartı:** Ağırlık ekranında **Tartı fotoğrafı → Çek** ile dijital tartının ekranını fotoğraflayın. Claude değeri okuyup doldurur; mutlaka kontrol edin.
- **AR ile ölç:** ARCore destekli telefonlarda çalışır. Koliyi masaya koyup köşelerine sırayla dokunun.
- **Referans kartı:**
  1. Web → Ayarlar → **Referans kartını indir (PDF)** → A4'e **%100 ölçekle** basın ("Sığdır" kapalı).
  2. Kartın üstündeki çizginin cetvelle 100 mm olduğunu kontrol edin.
  3. Kartı kolinin yanına koyun.
  4. Kolinin üç yüzü görünecek şekilde çapraz yukarıdan tek fotoğraf çekin; kartın tamamı karede olmalı.
- **Kaydet** → ölçüm ve fotoğrafları web panelinde **Ölçümler** sayfasında görünür.

## Geliştirici kullanımı (dev client, canlı kod)
Kodu değiştirip telefonda anında görmek için release APK yerine dev client APK kullanılır. Komutlar `Deciship` klasöründe; Metro `Deciship\apps\mobile` içinde çalışır.
1. Dev client APK'yı derleyip telefona kurun (ilk kez ya da yerel modül/eklenti değişince): `powershell -ExecutionPolicy Bypass -File scripts\android-build.ps1 -Profile development -Device <telefon seri no>` (`adb devices` ile bakın).
2. İki bağlantıyı açın: `adb reverse tcp:8081 tcp:8081` (Metro) ve `adb reverse tcp:8088 tcp:8088` (gateway; `scripts\phone.ps1 -NoInstall` bunu yapar).
3. `apps\mobile` klasöründe Metro'yu başlatın:
   ```powershell
   $env:EXPO_PUBLIC_API_URL = "http://127.0.0.1:8088"; npx expo start --dev-client --localhost
   ```
4. Telefonda uygulamayı açın; Metro'ya bağlanır.

## Üretim derlemesi
Derleme profilleri `apps\mobile\eas.json` içinde tanımlıdır; ortam ve sunucu adresi oradan gelir.

```powershell
# Geliştirme (dev client, http://127.0.0.1:8088)
powershell -ExecutionPolicy Bypass -File scripts\android-build.ps1 -Profile development
# Üretim (release APK, https://app.sellerondata.com)
powershell -ExecutionPolicy Bypass -File scripts\android-build.ps1 -Profile production
```

- `preview` ve `production` profillerinde API adresi zorunlu ve `https://` ile başlamalıdır; değilse derleme durur. Bu profillerde şifresiz HTTP kapalıdır.
- **Giriş ekranındaki sunucu adresi alanı yalnız geliştirme derlemesinde görünür.** Üretim ve önizleme derlemesinde adres derlemeye gömülüdür, değiştirilemez.
- Betik `android\` klasörünü yapılandırma değişince kendiliğinden yeniden üretir, çıkan APK'nın kimliğini ve sürümünü `app.json` ile karşılaştırır, sonucu `sod-build.json`'a yazar.
- Yayın: `scripts\apk-yayinla.ps1` yalnız `production` profiliyle derlenmiş APK'yı yükler.

## Sık sorunlar
| Belirti | Çözüm |
|---|---|
| Betik "Telefon bulunamadı" diyor | Kabloyu değiştirin (veri kablosu olmalı), USB modunu "Dosya aktarımı" yapın, Adım 2'yi kontrol edin. |
| "İzin verilmedi" | Telefondaki izin sorusunu onaylayın. Çıkmadıysa Geliştirici seçenekleri → **USB hata ayıklama yetkilerini iptal et** → kabloyu çıkarıp takın. |
| Kurulum başarısız (imza uyuşmazlığı) | Önce Hesap ekranında bekleyen ölçüm olmadığını görün; varsa kaldırmadan önce yöneticinize haber verin, kaldırma kuyruğu siler. |
| Uygulamada "Sunucuya ulaşılamadı" | Kablo çıktıysa ya da telefon kilitlenip uyandıysa `scripts\phone.ps1 -NoInstall` çalıştırın; bağlantıyı kendiliğinden korumak için `scripts\phone.ps1 -Watch -NoInstall` açık kalsın. Kuyrukta bekleyen ölçümler bağlantı dönünce kendiliğinden gönderilir. Bilgisayarda gateway'in açık olduğunu kontrol edin (`http://localhost:8088`). |
| "Başka oturumda bekleyen N ölçüm" uyarısı | Bu telefonda başka kişi veya başka firma adına kaydedilmiş ölçüm var. Yalnız sahibinin oturumunda gönderilir. Kendi diğer firmanızsa Hesap ekranından o firmaya geçin. Sahibi hiç dönmeyecekse Hesap ekranındaki "Bu telefondaki diğer oturumların ölçümleri" bölümünden silebilirsiniz; silme kalıcıdır. |
| Geliştirme derlemesinde "Uygulamayı güncelleyin" ekranı açık, sunucu adresi alanına ulaşılamıyor | Bu ekranda giriş ve adres alanı yoktur. Sunucuda `MIN_MOBILE_VERSION`'ı boşaltıp iki API'yi yeniden başlatın, sonra "Yeniden denetle"ye dokunun. Son çare uygulama verisini silmektir; bu bekleyen ölçümleri de siler, önce kuyruğun boş olduğundan emin olun. |
| Xiaomi'de kurulum engelleniyor | Adım 2'deki **USB üzerinden yükle** açık olmalı. Kurulumda telefonda çıkan onaya dokunun. |

## Kablosuz kullanmak isterseniz (isteğe bağlı)
**Seçenek A — Kablosuz hata ayıklama.** Android 11 ve üzeri gerekir. Yine Güvenlik Duvarı ayarı gerekmez.
1. Geliştirici seçenekleri → **Kablosuz hata ayıklama**'yı açın → **Eşleştirme koduyla cihaz eşle**.
2. Bilgisayarda: `adb pair <IP>:<port>`. Ekrandaki 6 haneli kodu girin.
3. Ardından: `adb connect <IP>:<ekrandaki diğer port>`.
4. Son olarak: `scripts\phone.ps1 -NoInstall`.

**Seçenek B — Aynı Wi-Fi üzerinden doğrudan.** Yalnız demo kurulumunda: gateway bütün ağ arayüzlerinde dinlemeli (`GATEWAY_PORT=8088`), şifre düz HTTP'de gider. Gerçek kullanımda açmayın.
1. Bilgisayarda `ipconfig` ile IPv4 adresini bulun.
2. Yönetici PowerShell'de bir kerelik şunu çalıştırın:
   `New-NetFirewallRule -DisplayName "SellerOnData Gateway" -Direction Inbound -Protocol TCP -LocalPort 8088 -Action Allow -Profile Private`
3. Uygulamada sunucu adresine `http://<IPv4>:8088` yazın.
4. Wi-Fi ağının Windows'ta **Özel** ağ olarak tanımlı olduğundan emin olun.

## Gerçek FedEx faturasıyla deneme
Amaç: FedEx hesabınızdan bir faturanın satır verisini indirip DeciShip'e yüklemek ve sonucu gerçek veriyle incelemek.

**1. FedEx'ten indirin (CSV ya da Excel).** Portalın adı **FedEx Billing Online (FBO)**; menü adları ülkeye ve arayüz sürümüne göre biraz değişir.
1. https://www.fedex.com/en-tr/billing.html → **FedEx Billing Online** → FedEx kullanıcınızla giriş. İlk girişte hesabı FBO'ya bağlamak için hesap no + son faturalardan birinin no'su ve tutarı istenebilir.
2. **Faturalar / Invoices** sekmesinde faturayı bulun (ödenmiş, son 1–2 ayın faturası da olur).
3. İndirme:
   - **Yeni arayüz:** faturanın kutusunu işaretleyin → **İndir (Download)** → **CSV** ya da **XLSX** → **Create Download**.
   - **Klasik arayüz:** **Search/Download** → tarih aralığı ya da fatura no → **Download data** → **CSV** ya da **Excel**.
4. Dosya **Download Center / İndirme Merkezi**'nde hazırlanır; durum **Completed** olunca indirin (orada ~14 gün kalır).
5. PDF fatura da olur (DeciShip PDF'yi yapay zekâ ile okur); CSV/Excel her zaman daha güvenilirdir.

FedEx satır verisinde gönderi başına **Tracking ID**, **Rated/Billed Weight**, **Dim Length/Width/Height**, **Net Charge** gibi sütunlar bulunur; karşılaştırma için gereken bunlardır.

**2. DeciShip'e yükleyin.**
1. Web → **Faturalar → Fatura yükle** → **FedEx** → dosyayı seçin.
2. **Sütun eşleme** örnek FedEx dosyasına göre kendiliğinden yapılır; gerçek dosyada adlar farklı olabilir. "Zorunlu alanlar tamam" yazmıyorsa kırmızı satırlarda doğru sütunu seçin. En önemlileri **Takip no**, **Net tutar**, **Faturalanan kg**; ölçü sütunları varsa onları da eşleyin. **Bu eşlemeyi hatırla** sonraki FedEx faturalarında eşlemeyi getirir.
3. Fatura no ve tarihi kontrol edip **İçe aktar ve karşılaştır**. Yanlışsa sonradan fatura sayfasında **Düzenle**.

**3. Sonucu yorumlayın.** Gönderileri DeciShip'te ölçmediğiniz için satırların çoğu **Eşleşmedi** çıkar; bu normaldir. Gerçekçi deneme için:
1. Faturadan 3–5 takip no seçin; mobilde gerçek koli ölçüsüyle ölçün (koli elinizde yoksa faturadaki ölçüye yakın değer girin, birini bilerek farklı girin). Web'de **Ölçümler → Elle ölçüm ekle** de olur.
2. Ölçüm kaydedilince fatura kendiliğinden yeniden karşılaştırılır; sayfayı yenileyince satırlar **Uyumlu** ya da **Fark var** olur. Olmazsa **Yeniden karşılaştır**.
3. Demo FedEx tarifesi örnek fiyatlıdır. "Beklenen tutar"ın anlamlı olması için **Tarifeler → FedEx** altına kendi sözleşme fiyatlarınızı girin (ya da Excel şablonuyla yükleyin) ve yeniden karşılaştırın.
4. Takip no'su faturada farklı yazılmış satırda satır panelinden **Takip no'yu düzelt** ya da **Ölçümle eşleştir**.

Bir sütun yanlış eşlenirse dosyanın yalnız başlık satırını (ilk satır) geliştirme oturumuna verin; FedEx kalıbı gerçek dosyaya göre güncellenir.

Kaynaklar: [FedEx Türkiye — Billing](https://www.fedex.com/en-tr/billing.html), [FedEx Billing Online kılavuzu (PDF)](https://www.fedex.com/content/dam/fedex/lac-latin-america/downloads/2021/billing/FedEx_Billing_Online_User_Guide_Electronic_Invoice_EN.pdf).
