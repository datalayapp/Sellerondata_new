# DeciShip SPEC — Web paneli (§8)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## 8. Web paneli (apps/web)

D09 ortak kabuk içinde, `/deciship/*` altında çalışır (Vite `base: '/deciship/'`). Yerleşim, renk, rozet, telefon uyumu ve erişilebilirlik kuralları `Platform/docs/DESIGN.md`'dedir. Üyeler ve roller Merkez'de yönetilir; DeciShip'te kullanıcı ekranı yoktur. Her ekran izne göre açılır (`Require`, `NavGuard`).

#### İlk kurulum

`/deciship/setup`, §5.3; yalnız `settings.manage`. Adımlar `pages/onboarding/steps.ts`; firma bilgileri Merkez'de kurulur, sihirbazda firma adımı yoktur (eski `?adim=firma` / `?adim=sirket` bağlantısı ilk adımı açar).

1. **Taşıyıcılar**: çoklu seçim, ≥ 1.
2. **Örnek faturalar** (isteğe bağlı): fatura yükleme `?tasiyici=<id>&donus=` ile açılır, sihirbaza `&fatura=<id>` ile döner. PDF tarife taramasındaki "Faturanıza uygun" tablo önerisini besler.
3. **Tarifeler**: taşıyıcı başına durum.
   - "PDF / Excel yükle" ve "Elle oluştur" tarife editörünü `?donus=/setup?adim=tarifeler` ile açar; editör "Kuruluma dön" çubuğu gösterir ve dönüşü kayıttan sonra korur (`lib/returnTo.ts`, yalnız uygulama içi yol).
   - Tarifesiz taşıyıcıyla uyarılı atlanabilir.
   - Tarifesi eklenen taşıyıcının `linesWithoutTariff > 0` örnek faturaları bir kez `POST /invoices/:id/recompare` ile karşılaştırılır ve tarife uyumu paneliyle listelenir.
4. **Ölçüm kuralları**: varsayılanlar dolu, onaylanır.
5. **Hazır koliler**.
6. **Özet**: ✓ / Atlandı / Eksik, "Kurulumu bitir".

Kurulum gerekirken (`me.onboarding.required`) Pano, ayar yetkisi olanı oturumda bir kez `/setup`'a yönlendirir. Menüden çıkılabilir; tamamlanana kadar menüde "Kurulum" öğesi ve Pano'da kapatılabilir bant görünür. Ayarlar'da "Kurulum sihirbazını aç".

#### Pano

- Göstergeler: bu ay ölçüm, faturalanan gönderi, fark var, fazla ödeme (KDV hariç; itiraz listesinde olan ve itiraz sonuçları: geri alınan / itirazda bekleyen), ölçüm kapsaması % (ölçülmüş satır / toplam satır).
- Fark türleri (fazla ödemeye göre sıralı), ölçüm yöntemleri, "Son yüklenenler" (dönemden bağımsız).
- Birincil eylem "Fatura yükle".

#### Ölçümler

- Süzgeç: arama (takip no), tarih aralığı, kişi, yöntem.
- Satır ayrıntısı: fotoğraflar, ölçü/ağırlık/desi, yöntem, ölçen, zaman, sürüm geçmişi, eşleşen fatura satırı; "Düzelt" (yeni sürüm). Elle ölçüm ekleme.
- Silme ve geri yükleme: §10.4.

#### Faturalar

**Liste:** süzgeç satırı "Ara · Durum · Taşıyıcı · Tarih".
- Arama fatura no ya da takip no; adreste `q`, 300 ms gecikmeli.
- Durum "Fark var / Ölçümü eksik / İtiraz bekliyor" (`DIFF`, `UNMATCHED`, `TO_DISPUTE`); adreste `status`.
- Tarih alanları "Tarih" düğmesinin arkasındadır; tarih seçiliyse açık durur.
- Aramada sonuç yoksa ayrı boş durum.

**"Fatura yükle" sihirbazı:**
1. Taşıyıcı ve tarife seç + dosya.
   - Tarife önseçimi (`components/TariffSelect.tsx`, sunucuyla aynı kural `lib/tariffPick.ts`): fatura gününde geçerli tarife, yoksa taşıyıcının varsayılanı. Kişi elle seçmediyse fatura tarihi değişince önseçim yenilenir; taşıyıcı değişince yeni taşıyıcınınki seçilir.
   - Alt satır: "Varsayılan tarife seçili; farklı bir tarife kullanmak için değiştirin." ya da "<tarih> tarihinde geçerli tarife seçili; …". Seçilen tarife o gün geçerli değilse uyarır (yine o tarifeyle hesaplanır).
   - Taşıyıcının tarifesi yoksa "Bu taşıyıcının tarifesi yok" + "Tarife ekle".
2. Sütun eşleme (önerilen eşleme dolu gelir; örnek 10 satır önizleme; eksik zorunlu alan belirgin; "Bu eşlemeyi hatırla"; §11.6) ya da PDF için yapay zekâ satır tablosu.
   - PDF tablosu düzenlenebilir; PDF metninde bulunamayan hücre kırmızı kenarlı, üstte tek satır uyarı.
   - Ağırlık hücresinde binlik yazımı belirsizse tarife düzenleyicideki "1,5 kg mı, 1.500 kg mı?" sorusu çıkar (`components/WeightChoice.tsx`); seçilene dek içe aktarma kapalıdır.
3. Fatura no / tarih / para birimi → İçe aktar.

- PDF okuma kapalıyken PDF seçilemez (§3.15).
- **Okuma iptali:** okuma sürerken başka taşıyıcı seçilirse eski okuma iptal edilir (`preview(file, carrierId, signal)`); geç gelen eski yanıt sıra numarasıyla yok sayılır; taşıyıcı kartları kilitlenmez. Bırakma alanının altındaki "Okumayı durdur" okumayı keser, dosya seçili kalır. Bu düğme iş numarası gelmeden (istek sürerken) çıkar: sunucu başlamış okumayı yine tamamlar (maliyet sayaca girer). İş başladıktan sonra ilerlemedeki "Durdur" işi durdurur ve süren yapay zekâ çağrısını da keser.
- 2. adımdan yükleme bitene kadar sayfadan çıkış sorulur.

#### Fatura detayı (Karşılaştırma)

- **Özet kartı:** büyük "Fazla ödeme" + tek cümle (§3.4); Faturalanan · Beklenen · İtiraz listesinde; fark varsa itiraz süresi satırı; şüphede tarife uyarısı (§3.11); "Tarife: <ad>" bağlantısı; alınmayan satırlar uyarısı ve "Nasıl hesaplandı?" açılır alanı (§3.15). Tamamı mükerrer faturada "Faturalanan / Beklenen" yerine tek satır açıklama yazar.
- **Durum sekmeleri** sayılarıyla: Fark var (varsayılan) / Eşleşmedi / Uyumlu / Tarife yok (yalnız varsa; satırların çoğunda kur alınamadıysa "Kur alınamadı") / Kontrol edilecek (yalnız varsa) / Tümü.
- **Tablo:** takip no, tür, bizim ölçü & kg, fatura ölçü & kg, beklenen, faturalanan, fark, karar.
- **Satır ayrıntısı:** bizim ölçüm + fotoğraflar | fatura değerleri, kullanılan tarife ve fiyat dökümü, "İtiraz listesine ekle" (VERIFIED) / "Uyumlu say" (gerekçe ister) / "Geri al", düzeltme ve elle eşleştirme (§10.4).
- **Toplu seçim** ("Fark var" ve "Tümü" sekmesinde, `lines.decide` izniyle, satır paneli kapalıyken):
  - kararı burada değiştirilebilen satırın başında onay kutusu; uygun olmayanın kutusu kapalıdır, ipucu nedeni söyler;
  - seçim yapılınca tablonun üstünde "N satır seçildi · İtiraz listesine ekle · Uyumlu say · Seçimi kaldır" bandı (`invoice-detail/BulkBar.tsx`, telefonda alta yapışır);
  - sayfanın tümü seçilince "Bu süzgeçteki N satırın tümünü seç";
  - süzgeç değişince seçim sıfırlanır, sayfa değişince kimlikle seçim korunur (`invoice-detail/bulk.ts`);
  - "Uyumlu say" gerekçe ister. Başarıda bildirimde "Geri al" ve atlanan satırların nedeni; liste bu arada değiştiyse liste yenilenir ve "Seçim değişti" denir;
  - seçim açıkken başlıktaki "İtiraz metni" düğmesi ikincil olur.
- **Başlık:** rozetler telefonda başlığın altına iner. ⋯ menüsü klavyeyle açılır; satırdaki düğme ve kutudan gelen tuş satırı açmaz.
- **Fatura eylemleri:**
  - Başlıkta "İtiraz metni" düğmesi: TR/EN, konu + gövde, "Kopyala", taşıyıcı e-postası; pencere ve e-posta taslağı kuralları itiraz.md "İtiraz penceresi ve e-posta taslağı".
  - ⋯ menüsünde: "Excel indir", "PDF indir", "Düzenle" (fatura bilgileri, §10.4), "Yeniden karşılaştır" (önce/sonra penceresi; değişiklik yoksa pencere açılmaz), "WhatsApp'ta paylaş".
- Dayanak bandı, "yeniden hesap bekleyen" rozeti ve "Yeni ölçümle hesapla": §3.14. İtiraz kartı (`DisputeCard`): §3.11.

#### İtirazlar

`/deciship/disputes`: itirazı olan faturaların listesi. Tek toplam satırı, durum sekmeleri (Gönderilmedi / Gönderildi / Kapandı / Tümü; `status` = `UNSENT`, `SENT`, `CLOSED`), fatura no araması; süresi yaklaşan varsa üstte. Satır faturayı açar; sonuç girişi fatura detayındaki itiraz kartındadır (§3.11).

#### Tarifeler

- Taşıyıcılar ve tarifeleri ("Varsayılan" etiketi, "Varsayılan yap").
- **Tarife düzenleyici:**
  - genel ayarlar (ad, hizmet, para birimi, bölen, kenar yuvarlama, ağırlık basamakları, indirim %, yakıt %, geçerlilik, varsayılan);
  - yeni tarife taşıyıcının kapsamıyla başlar (yurt içi 3000 + sabit yakıt, yurt dışı 5000 + değişken; `tariff-editor/draft.ts` `withCarrier`); PTT ve "Diğer"de "Kapsam" seçimi (`applyScope`) bölen ve yakıtı doldurur, elle değiştirilmiş bölen/yakıt taşıyıcı değişince korunur. İçe aktarma sihirbazının yeni tarife formunda yakıt türü seçilir (`meta.fuelVariable`);
  - **fiyat tablosu ızgarası** (satır = ağırlık ≤, sütun = bölge; hücre düzenlenebilir; satır/sütun ekle-sil; Excel'den yapıştırma);
  - bölge eşleme (ülke kodu → bölge, `*` tümü), ek ücretler, ülke istisnaları (§3.8);
  - "Excel şablonu indir" / "Excel'den içe aktar" / PDF içe aktarma (önizleme → uygula, §5.7);
  - sürümler ve geri yükleme; **"Fiyat hesapla"** deneme kutusu.
  - Kayıttan sonra eski tarifeyle duran faturalar varsa "Yeni tarifeye geçir" (toplu önce/sonra, §5.7).
- **Düzenleyici kuralları:**
  - Ülke eşlemesi bölge sütununa bağlıdır, ada değil: sütun adı yazılırken ülkeler yer değiştirmez. Excel başlığı yapıştırılınca ülke eski bölge adının yeni sütununa gider; ad yoksa "—" ve kayıt durur.
  - Kaydı durduranlar: aynı bölge anahtarlı iki sütun ("a" = "A" = "Zone A"), aynı gruptaki iki ek ücret, dolu ama okunamayan indirim/yakıt, okunamayan basamak sınırı. Boş oran %0'dır.
  - **Binlik yazımı belirsiz ağırlık:** arayüz dilinin binlik yazımıyla girilen ağırlık (Türkçede "1.500", İngilizcede "1,500"; fiyat satırının ağırlığı, basamak sınırı ve adımı) alanın altında "1,5 kg mı, 1.500 kg mı?" / "1.5 kg or 1,500 kg?" diye sorulur (`components/WeightChoice.tsx`). Seçim alana "1,5" ya da "1500" yazar; seçilene dek kayıt durur. Dilin ondalık yazımı sorulmaz (Türkçede "1,500", İngilizcede "1.500").
  - **Dil değişince sayılar korunur:** kaydedilmemiş taslağın ve PDF adımının sayıları eski dilde okunup yeni dilde yazılır (`relocalizeDraft`, `relocalizePdfRows`). Aynısı tarife içe aktarma sihirbazının bölen/indirim/yakıt alanları, Ayarlar ve kurulumdaki tolerans/bölen alanları, itiraz sonucu tutarları ve eşlemedeki KDV oranı için de geçerlidir (`lib/localeSwitch.ts` `useLocaleSwitch` + `relocalizeFields`). Seçilmemiş soru yeni dilin aynı yazımına geçer.
  - Biçimi belli yapıştırılan blokta ağırlık binliksiz yazılır; biçimi belirsiz blokta "iki türlü okunabilir" sorusu sorulur.
  - Kaydedilmemiş taslak açıkken tarife başka yerde kaydedilirse taslak ezilmez: "Bu tarife siz bakarken değişti" bandı "Güncel hâli yükle" ya da "Yine de kaydet" (öbür hâl sürüm geçmişinde kalır) sorar.
  - Yeni tarife sayfasında taşıyıcı değişince önceki taşıyıcıya yüklenmiş dosya ve tarama bırakılır.
  - Faturası olan tarife silinirken onayda "Geçmiş faturalar etkilenmez" yazar.

#### Ayarlar

- Firma adı (fatura ve raporlarda görünen).
- Karşılaştırma toleransları; tarifede olmayan ek ücretleri fark say; "Eski faturaları yeni ayara geçir" (§5.3).
- Mobil ölçüm: desi böleni (ölçüm yapana gösterilir), zorunlu kutu fotoğrafı sayısı, ölçü uyarı eşikleri (`warnEdgeCm`, `warnWeightKg`, §6.2), "Tartı fotoğrafını yapay zekâ okusun" (`scaleAiRead`, §6).
- Döviz kuru toleransı (§3.10).
- İtiraz süresi hatırlatması (yalnız Türkiye firmasında; §5.14). Saat dilimi ve firma dili Merkez › Firma'dan gelir.
- Hazır koliler (ekle/düzenle/sırala), "Referans kartını indir (PDF)", veri sıfırlama (yalnız açıksa, §5.3).

#### Ortak adlar ve davranışlar

- Durum adları: Uyumlu, Fark var, Eşleşmedi, Tarife yok, Doğrulandı, Uyumlu sayıldı. Tür adları: Mükerrer, Ölçü farkı, Ağırlık farkı, Ek ücret, Fiyat farkı.
- Boş durumlar, yükleniyor iskeletleri ve hata mesajları her ekranda olmalı.
- Pak/zarf satırında tabloda ve satır ayrıntısında "Ölçüm yok" yerine "Kapsam dışı" yazar.
- Tarife içe aktarmada para birimi değiştiyse bildirimde "Ek ücretleri kontrol edin" bağlantısı çıkar.
- Sekme başlığı fatura detayında "fatura no · tarife adı" olur, ayrıntıdan çıkınca eski hâline döner.
- "Sunucu meşgul" (503) yanıtında yalnız GET bir kez yeniden denenir.

**Yazılanı koruma** (kurallar ortak kabukta, `@sellerondata/shell`; panelin `lib/modalGuard.ts`, `lib/leaveGuard.ts`, `components/LeaveGuard.tsx` dosyaları yalnız yeniden dışa aktarır):
- `Modal` `busy` (işlem sürerken Esc, örtü ve X yok sayılır) ve `dirty` (verilmezse pencere içindeki alan değişimiyle kendiliğinden; karar `closeDecision`) alır; kirli pencere kapatmadan önce sarı şeritte sorar.
- Sayfa çıkışı `useLeaveGuard(dirty)` (karar `shouldBlockLeave`, `@sellerondata/shell/leave-rules`): Ayarlar, fatura yükleme, tarife düzenleyici; başarılı kayıttan sonra `release()`.
- Firma değişiminde kaydedilmemiş değişiklik varsa onay (`lib/unsavedChanges.ts` `hasUnsavedChanges`).
- Çıkış sunucuya ulaşamazsa sayfada kalınır ve bildirim gösterilir.
- Görünüm kuralları `Platform/docs/DESIGN.md` §4b.

**Destek ve geri alma bayrakları:**
- Avatar menüsünde "Yardım ve destek": konusu dolu `mailto` (`supportMailto`; Merkez'de de var).
- Deneme turu kartı ve bandı: §5.14.
- `src/lib/features.ts` `{ bulkDecide, invoiceSearch, demoTour }` bayraklarından biri `false` yapılınca o ekran gizlenir: toplu seçim, fatura araması ve durum süzgeci, deneme turu kartı ve bandı. Sunucu uçları yerinde kalır; deneme turunu sunucuda `DEMO_TOUR=off` kapatır.
