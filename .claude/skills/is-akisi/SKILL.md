---
name: is-akisi
description: SellerOnData projesinde çalışma ritmi. Oturum başında, "devam et", "sıradakini yap", "KALANLAR 1.3'ü yap" gibi isteklerde, kullanıcı hata bildirdiğinde, bir işi planlarken, test ederken, incelemeye verirken ve oturumu kapatırken ÖNCE bu skill okunur. Oturum başı CI denetimi, bir iş = bir commit, katmanlı testler, bağımsız inceleme sınırı, gelen kutusu, haftalık kararlı nokta ve oturum sonunu içerir. Yalnız bu projede geçerlidir; ajan seçimi ve prompt kuralları genel `agent-management` skill'indedir.
---

# İş akışı (SellerOnData)

Kurallar ve test komutları kök `CLAUDE.md`'de; plan `SONRAKI-OTURUM/KALANLAR.md`. Bu dosya yalnız sırayı anlatır.

## Oturum başı (~2 dk)

1. `git status -sb` ve son CI sonucu: `gh run list --branch gelistirme --limit 3` ya da `npm run ci:son` (düşen testler ve ilk hata satırı).
2. CI kırmızıysa önce o, en çok 30 dakika. Çözülmezse KALANLAR'a satır yazılır, kullanıcıya söylenir; devam onun kararıyla.
3. `DEVAM.md` ve yalnız istenen KALANLAR satırı okunur. Büyük belgelerin (SPEC, mimari, kararlar, kod haritası) yalnız ilgili bölümü grep'le bulunur; tamamı okunmaz.
4. "Gelen kutusu" boş değilse kullanıcıya söylenir; istenirse ondan başlanır.

## İş

- Bir iş = bir KALANLAR satırı ya da bir kullanıcı isteği = bir commit. Üretilen dosyalar (anlık görüntü, sözlük tablosu) aynı commit'te.
- Tarif bugünkü koda göre hâlâ doğru mu? Eskiyen kısmı düzelt, sonra başla.
- Çekirdek önce: asıl amacı sağlayan en küçük tutarlı bütün (yarım ekran, çalışmayan düğme kalmaz). Ekler ayrı ve küçük; ertelenen ek KALANLAR'a tek satır.
- Birden çok parça aynı anda yazılacaksa aradaki sözleşme (tablo/sütun adları, uç gövdesi ve yanıtı, hata kodları, yetkiler) önce ajan prompt'larına yazılır; sapan ajan raporunda söyler.
- Ajan prompt'una kod haritasının ilgili bölüm dosyası (`SONRAKI-OTURUM/kod-haritasi/<bölüm>.md`) ve koşacağı test dosyaları verilir.
- Kullanıcıya soru: ürün davranışı, veri modeli ya da görünüm kararı plan aşamasında topluca, öneriyle. İş başladıktan sonra çıkan kararda en makul yol seçilir, raporda söylenir. İnce ayar sorulmaz.

## Test katmanları

| Ne zaman | Ne koşulur |
|---|---|
| Her ajan değişikliğinden sonra | Dokunulan dosyaya bağlı testler (`npm run test:changed` ya da `npm run t -- <dosya>`) + o paketin tip denetimi |
| Her commit'ten önce | Kanca: repo-check + sahnelenen dosyalarda lint |
| Push'tan önce | Kökten `npm test`; veritabanına dokunduysa ilgili veritabanı test dosyaları (Postgres yoksa `npm run pg:baslat`, Docker gerekmez) |
| Push'tan sonra | CI beklenir ya da `DEVAM.md`'ye "CI bekleniyor: <commit>" yazılır |
| Ekran değiştiyse, iş sonunda | O ekranın e2e dosyaları tek tek, ayrı `--output`; çalışan sistemde bir kez gezilir, olmadıysa "tarayıcıda denenmedi" |
| Haftada bir (kararlı nokta) | `test:all`, panel + Merkez + Platform e2e, görsel tabanlar, `npm outdated` |

## Bağımsız inceleme

- Yalnız para, yetki, veri silme ve veri modeli değişikliğinde; tek Opus incelemesi, riskli parça biter bitmez (öbür parçalar sürerken).
- Bulgular: gerçek hata (yanlış para, veri kaybı, yetki açığı) hemen düzelir ve testi yazılır; gerçek ama küçük olanlar KALANLAR'a en çok 3 satır (fazlası tek "artıklar" satırında); olasılıklar yazılmaz.

## Gelen kutusu

- Kullanıcı hata söyleyince KALANLAR "0. Gelen kutusu"na bir satır: `tarih · ekran · ne yaptım · ne bekledim · ne oldu · görüntü`.
- Oturum başında her satır ya hemen düzelir ya da ilgili aşamaya numaralı satır olur; gelen kutusundan silinir.
- Gerçek müşteri dosyaları depoya girmez (depo dışı klasör; `TEST-ADIMLARI.md`).

## Haftalık kararlı nokta

Hızlı + veritabanı işi yeşil, panel, Merkez ve Platform e2e yeşil → kullanıcı onayıyla `main`'e birleştirme ya da etiket. Kullanıcı denemelerini bu sürümde yapar.

## Oturum sonu

1. Her iş kendi commit'inde (`gelistirme`, dosyalar tek tek, `git commit -F`).
2. KALANLAR'daki satır silinir ya da güncellenir; `DEVAM.md` yalnız "neredeyiz + son test durumu + sıradaki adım" (≤ 3 KB).
3. Kural değiştiyse yalnız ilgili belgenin ilgili maddesi; yeni dosya ya da yol eklendiyse kod haritasının bölüm dosyası.
4. `git push`.
5. Kullanıcıya kısa özet: ne değişti (ürün diliyle), sınırlar, koşan ve koşmayan testler, sıradaki adım.
