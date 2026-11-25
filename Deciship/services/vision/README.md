# Görüntü servisi (vision)

DeciShip'in Python/OpenCV servisi. API bu servise iç ağdan ulaşır (`VISION_URL`, port 8001). Referans kartı kuralları: `Deciship/spec/mobil.md` (SPEC §7).

| Uç | Ne yapar |
|---|---|
| `GET /health` | Servis ayakta mı |
| `POST /detect` | Fotoğraftaki referans kartını ve kutu köşelerini bulur |
| `POST /solve` | Köşelerden kutunun ölçülerini (cm) hesaplar |
| `POST /scale/read-free` | Tartı ekranındaki ağırlığı yapay zekâsız okur. **Varsayılan kapalı**, kimse çağırmıyor (aşağıda) |

## Testler

```
cd Deciship/services/vision
.venv\Scripts\python -m pytest -q
```

Sanal ortam yoksa: `python -m venv .venv` ve `.venv\Scripts\python -m pip install -r requirements-dev.txt`.

## Ücretsiz tartı okuma (deneme aşamasında)

Bugün tartı fotoğrafını ücretli yapay zekâ okur (ya da ağırlık elle girilir). Bu uç aynı işi ücretsiz,
klasik görüntü işlemeyle yapmayı dener. Varsayılan **kapalı**; gerçek fotoğraflarla ölçülüp yeterince
iyi çıkarsa açılması düşünülür.

**Ne okuyabilir:** dijital tartılardaki yedi parçalı (seven-segment) rakamlar: LCD (açık zemin, koyu
rakam) ve LED (koyu zemin, parlak rakam), eğik yazı, ondalık nokta, ekranın yanındaki `kg`, `g` ya da
`lb` yazısı.

**Ne okuyamaz (ve "okunamadı" der):** nokta matris ekran, ibreli (analog) terazi, renkli grafik ekran,
eksi ağırlık, sıfır, birden çok sayı gösteren ekran (ağırlık + fiyat gibi), birimi belirsiz tam sayı.

**Temel kural:** emin değilse ağırlık döndürmez. Yanlış ağırlık, hiç ağırlık olmamasından kötüdür
(yanlış kargo itirazı açtırır). Bu yüzden şunlardan biri olursa okuma reddedilir: tek bir parçanın
yanık mı sönük mü olduğu net değil; rakam yedi parça desenine uymuyor; sayının hemen solunda ya da
sağında yarım görünen bir rakam var; nokta yeri belirsiz; birim yazısı var ama tanınmadı; aralık
dışı (0 ile 300 kg arası değil); ondalık basamak kg için 1-3 değil; fotoğrafta iki farklı sayı var.
Birim yazısı hiç görünmüyorsa ve sayıda ondalık varsa kg sayılır (`unitAssumed: true`).

### Açmak

Servisin ortamında `SCALE_FREE_READ=1`. Kapalıyken uç `404` ve `{"ok": false, "message": "Ücretsiz tartı okuma kapalı."}` döner.

### Yanıt

`multipart/form-data`, alan adı `image` (JPEG/PNG; `/detect` ile aynı boyut ve piksel sınırları).

```json
{
  "ok": true,
  "weightKg": 12.345,
  "unit": "kg",
  "unitAssumed": false,
  "rawText": "12.345",
  "confidence": 0.93,
  "reason": null,
  "message": "Tartı ekranı okundu; değeri kontrol edin.",
  "imageSize": {"w": 4032, "h": 3024},
  "debug": {"elapsedMs": 240, "rows": []}
}
```

Okunamazsa `ok: false`, `weightKg: null`, `rawText: ""`, `reason` nedeni söyler (ör. `no_digits`,
`ambiguous_segment`, `not_seven_segment`, `missed_digit`, `ambiguous_dot`, `unit_unknown`,
`multiple_numbers`, `low_confidence`, `zero`, `negative`, `out_of_range`). `weightKg` her zaman kg'dır
(g ve lb çevrilir). Güven eşiği 0,7'dir (`app/scale.py`, `ACCEPT_CONFIDENCE`).

### Gerçek fotoğraflarla ölçmek

1. Tartı ekranlarının 20-30 fotoğrafını bir klasöre koyun (telefonla, normal çekim; farklı tartılar,
   ışıklar ve açılar olursa daha iyi).
2. Aynı klasöre `etiketler.csv` yazın: her satırda dosya adı, ekrandaki ağırlık, birim.

   ```
   dosya,agirlik,birim
   IMG_0001.jpg,4.02,kg
   IMG_0002.jpg,1250,g
   ```

   Excel'in Türkçe biçimi (`;` ayraç, `4,02` gibi virgüllü sayı) de olur. Birim boşsa kg sayılır.
3. Çalıştırın:

   ```
   cd Deciship/services/vision
   .venv\Scripts\python tools\scale_eval.py C:\yol\tarti-fotograflari --csv sonuc.csv
   ```

Çıktı: doğru / **yanlış** / okunamadı sayıları, yanlış okunan her fotoğraf, okunamama nedenleri ve
güven eşiğine göre tablo (eşik yükselince yanlış azalır, okunamayan artar). `sonuc.csv` dosya başına
sonucu yazar. Açma kararı için ölçüt: **yanlış sıfır olmalı** (ya da çok az, ve hangi eşikte sıfıra
indiği görülmeli); okunamayan oranı ne kadar faydalı olduğunu gösterir.

### Sentetik ölçüm

Gerçek fotoğraf yokken okuyucu, testte üretilen yapay tartı fotoğraflarıyla ölçülür
(`app/scale_synth.py`: farklı rakamlar, nokta yeri, boyut, eğim, perspektif, bulanıklık, gürültü,
parlama, düşük kontrast, LCD/LED, tartı gövdesi ve dağınık arka plan):

```
.venv\Scripts\python tools\scale_accuracy.py --n 100
```

**Sentetik sonuç gerçek dünyayı garanti etmez.** Yapay görüntüleri okuyucuyu yazan kişi üretti;
gerçek ekranların yazı tipi, yansıması, kir, eğik çekim ve kamera işlemesi farklıdır. Açma kararı
yalnız gerçek fotoğraf ölçümüne göre verilir.
