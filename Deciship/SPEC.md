# DeciShip teknik belgesi: alan kuralları ve API (dizin)

DeciShip, kolinin gerçek ölçüsünü ve ağırlığını paketleme anında telefonla kaydeder; kargo faturası gelince her satırı bu ölçümle ve sözleşme tarifesiyle karşılaştırır, fazla ödenen tutarı fatura bazlı raporlar ve itirazını takip eder.

Bu dizin DeciShip'in alan kurallarını (`packages/core`), veri modelini, API'yi (`/api/deciship`), mobil ölçümü, referans kartı servisini ve web panelini anlatan dosyaları gösterir; bölümler `Deciship/spec/` altındadır. Kimlik, firma, rol ve abonelik Platform'dadır (`Platform/docs/ARCHITECTURE.md`); tasarım `Platform/docs/DESIGN.md` ve `Deciship/DESIGN.md`.

- Adlar, yollar ve JSON biçimleri bağlayıcıdır. Belge kodla çelişirse kod doğrudur; ilgili `spec/` dosyası düzeltilir.
- Koddaki "SPEC.md §5.13", "SPEC §11.4" gibi atıflar aşağıdaki tabloyla çözülür. § numaraları değişmez; yeni bölüm yeni numara alır.
- Koddaki "SPEC §FX" atfı §3.10 (döviz kuru) demektir.

| § | Dosya | Ne anlatır |
|---|---|---|
| Genel, §1 | [spec/urun-ve-kod.md](spec/urun-ve-kod.md) | Ürün, roller ve izin anahtarları, para alanı süzme, mobil ve web iş akışı, kapsam dışı |
| §2 | [spec/urun-ve-kod.md](spec/urun-ve-kod.md) | Paket ve uygulama yerleşimi, core dışa aktarım yolları, DeciShip ortam değişkenleri |
| §3, §3.1 | [spec/hesap-kurallari.md](spec/hesap-kurallari.md) | Yuvarlama; hacimsel ağırlık, desi, ağırlık basamakları, lb kuralı |
| §3.2 | [spec/hesap-kurallari.md](spec/hesap-kurallari.md) | Beklenen fiyat: bölge, taban, indirim, yakıt, ek ücret, kg bandı, KDV |
| §3.3 | [spec/hesap-kurallari.md](spec/hesap-kurallari.md) | Takip no normalleştirme ve eşleşme sırası |
| §3.4 | [spec/hesap-kurallari.md](spec/hesap-kurallari.md) | Satır karşılaştırma: durum, fark türleri, kural sırası, toleranslar, fatura özeti |
| §3.5 | [spec/hesap-kurallari.md](spec/hesap-kurallari.md) | Fatura okuma: tablo, sütun eşleme, taşıyıcı kalıpları, hata kodları, PDF |
| §3.6 | [spec/hesap-kurallari.md](spec/hesap-kurallari.md) | İtiraz metni (`buildDisputeText`) |
| §3.7 | [spec/hesap-kurallari.md](spec/hesap-kurallari.md) | Core modülleri ve dışa aktarımları |
| §3.8 | [spec/fiyat-kur-tarife.md](spec/fiyat-kur-tarife.md) | Fiyat dayanağı (INVOICE/TARIFF), sapma, ülke istisnası, güven, toplamlar |
| §3.9 | [spec/fiyat-kur-tarife.md](spec/fiyat-kur-tarife.md) | Tarife uyumu raporu (`tariffHealth`), eşikler, ilgili uçlar, web kartı |
| §3.10 | [spec/fiyat-kur-tarife.md](spec/fiyat-kur-tarife.md) | Döviz kuru ile karşılaştırma: çevrim, tolerans, TCMB, önbellek, süre sınırları |
| §3.11 | [spec/fiyat-kur-tarife.md](spec/fiyat-kur-tarife.md) | İtiraz süresi (TTK), WhatsApp paylaşımı, tarife şüphesi |
| §3.12 | [spec/fiyat-kur-tarife.md](spec/fiyat-kur-tarife.md) | Faturanın tarifesi ve sürümü, tarife seçimi, geçerlilik dışı satır |
| §3.13 | [spec/inceleme-ve-gecmis.md](spec/inceleme-ve-gecmis.md) | Emin olunmayan farklar ("İncele"): LOW sınıfı, `reviewCode`, toleranslar |
| §3.14 | [spec/inceleme-ve-gecmis.md](spec/inceleme-ve-gecmis.md) | Geçmiş sonuçlar: tarife sürümü, dondurma, toplu geçiş, önizleme/onay |
| §3.15 | [spec/acik-olma.md](spec/acik-olma.md) | Alınmayan satırlar (`importReport`), PDF metin/toplam/KDV denetimi, fazla ödeme dökümü |
| §4 | [spec/veri-modeli.md](spec/veri-modeli.md) | Prisma tabloları, alanlar, RLS, ölçekler, tekil dizinler, indeksler |
| §5, §5.1 | [spec/api.md](spec/api.md) | API genel: JSON, hata biçimi ve kodları, eşzamanlılık, sayfalama |
| §5.2 | [spec/api.md](spec/api.md) | Bütün uçlar ve izinleri (harita) |
| §5.3 | [spec/api.md](spec/api.md) | `/me`, ayarlar, ilk kurulum sihirbazı, örnek fatura, veri sıfırlama |
| §5.4–§5.6 | [spec/api.md](spec/api.md) | Ölçüm kaydı, dosyalar ve imzalı bağlantı, tartı okuma ve referans kartı uçları |
| §5.7 | [spec/api-tarifeler.md](spec/api-tarifeler.md) | Taşıyıcılar ve tarifeler: CRUD, Excel/CSV/PDF içe aktarma, sürümler |
| §5.8 | [spec/api-faturalar.md](spec/api-faturalar.md) | Fatura yükleme, önizleme, liste, satırlar, karar, yeniden hesap, raporlar |
| §5.9–§5.11 | [spec/api.md](spec/api.md) | Pano, tohum veri, itiraz uçları (ayrıntı itiraz dosyalarında) |
| §5.12 | [spec/sinirlar.md](spec/sinirlar.md) | Yapay zekâ sayacı, kota, günlük tavan, dosya çalışanı, hız sınırları |
| §5.13 | [spec/arka-plan-isleri.md](spec/arka-plan-isleri.md) | İş kuyruğu (`Job`), türler, kira ve deneme, toplu yeniden hesap |
| §5.13 (devam) | [spec/dosya-temizligi.md](spec/dosya-temizligi.md) | Dosya temizliği, dosya alanı kotası, sürdürme bandı, yetim dosya raporu |
| §5.14 | [spec/deneme-ve-kapali-firma.md](spec/deneme-ve-kapali-firma.md) | Deneme turu ve itiraz süresi hatırlatması |
| §5.15 | [spec/deneme-ve-kapali-firma.md](spec/deneme-ve-kapali-firma.md) | Kapalı firma: kapatınca DeciShip'in davranışı |
| §6 | [spec/mobil.md](spec/mobil.md) | Mobil uygulama: ölçüm akışı, kuyruk, ekranlar |
| §6.1 | [spec/mobil.md](spec/mobil.md) | Yerel ölçüm modülü (`modules/box-measure`) |
| §6.2 | [spec/mobil.md](spec/mobil.md) | Yarım ölçüm, kuyruk sınıfları, ölçü uyarıları |
| §6.3 | [spec/mobil.md](spec/mobil.md) | Sürüm denetimi ve 426 |
| §7 | [spec/mobil.md](spec/mobil.md) | Referans kartı ölçümü (`services/vision`) |
| §8 | [spec/web-paneli.md](spec/web-paneli.md) | Web paneli sayfaları ve davranışı |
| §9 | [spec/urun-ve-kod.md](spec/urun-ve-kod.md) | Kalite çıtası (core, api, web, mobil, vision) |
| §10–§10.4 | [spec/duzenleme.md](spec/duzenleme.md) | Düzenleme, silme, geri alma: ölçüm ve fatura (API), mobil, web |
| §11, §11.1 | [spec/okuma-kontrolu.md](spec/okuma-kontrolu.md) | Okuma kontrolü (`verifyMapping`), satır bayrakları |
| §11.2–§11.3 | [spec/okuma-kontrolu.md](spec/okuma-kontrolu.md) | Yapay zekâ ile sütun eşleme, kişisel veri maskesi, birleştirme ve kaynak |
| §11.4–§11.6 | [spec/okuma-kontrolu.md](spec/okuma-kontrolu.md) | İçe aktarma kapısı, "Kontrol ettim", web ekranları |
| İtiraz | [spec/itiraz.md](spec/itiraz.md) | İtiraz takibi kuralları: veri modeli, kilit, "geçerli satır", TTK, Gönderim uyarısı |
| İtiraz API | [spec/itiraz-api.md](spec/itiraz-api.md) | İtiraz takibi "API sözleşmesi": tipler, gövdeler, hata kodları |

Ayrıca: telefonda deneme ve gerçek FedEx faturasıyla deneme `Deciship/TELEFON-KURULUM.md`; görüntü servisi `Deciship/services/vision/README.md`; marka `Deciship/brand/README.md`; mobil betikler `Deciship/scripts/README.md`.
