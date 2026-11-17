# Durum

Son güncelleme: 2026-11-16 (gece oturumu). Kısa kalır: neredeyiz, son test durumu, sıradaki adım. Plan `KALANLAR.md`, ritim `.claude/skills/is-akisi/SKILL.md`.

## Neredeyiz

- 2026-11-16 sabah: ilk kararlı nokta, `main` = `f4fe2add`.
- 2026-11-16 gece (sahip uyurken, onayıyla): karar gerektirmeyen işler bitti; her biri kendi commit'inde, para/yetki/veri silme işleri bağımsız incelemeden geçti. Kapananlar: 0.10, 0.14, 0.15, 2.2 (gece yedeği + şifreli dış kopya + geri yükleme provası, Görev Zamanlayıcı'da kayıtlı), 2.1 hazırlığı (`gercek-kullanim.ps1`), 2.3, 3.2/3.5/3.7 hazırlığı (Caddy, `guncelle.sh`, `kurulum.sh`), 3.4, 3.6, 4.4, 4.6, 4.8, 4.9, 5.15, 5.17, 5.19, 6.2, 6.5, 6.7, 6.8, 6.10, 6.11, 6.12, 6.14, 6.15 (hız sınırı), 6.17, 6.18, 6.19, 6.20, 6.21, 6.22, 6.24, 6.25, 6.26, 6.28. Kalanları ve yeni artık satırları KALANLAR'da.
- Sahibin kararını bekleyenler (sabah listesi): yedek dış hedefi ve parola, gerçek kullanıma geçişte silinecek iki deneme firması ve kayıt kipi, CAPTCHA sağlayıcısı, takip no saklanan sütun, Merkez satır tablosunda sınırlı sayım, tasarım soruları (ORG_CLOSED ekranı, İngilizce üst çubuk, odak halkası, kırmızı çerçeve, mobil Merkez renkleri), "kayıtta kod".
- Yol haritası: https://claude.ai/artifact/SdijYT29LPB3C4WW2uYEDk ; eski belgeler masaüstündeki `SellerOnData-ARSIV-2026-11-14` klasöründe.

## Son test durumu

- CI yeşil (son koşu gece sonunda; `npm run ci:son`). Yerelde: Platform e2e 80/80 (yeniden derlenmiş yığın), Merkez e2e 205/205, panel e2e 305/305, görsel karşılaştırma panel 95 + Merkez 32 (tabanlar `%LOCALAPPDATA%\SellerOnData\gorsel`), ağ geçidi Docker testi 189/189, yedek provası (normal, -Tam, şifreli kopyadan).
- Hiç denenmedi: gerçek telefon (release APK), gerçek yapay zekâ anahtarıyla PDF, gerçek e-posta, gerçek kargo faturası, gerçek sunucu ve sertifika, `-Canli` geri yükleme.

## Sıradaki adım

Sahip sabah kararları verir; karar gerektiren işler ona göre. Sonra sahibin dosya toplaması (1.14) ve gerçek kullanıma geçiş (2.1: önce `scripts\gercek-kullanim.ps1 -KuruCalisma`).

## Bilinmesi gerekenler

- Çalışan sistemin ayar dosyası `Platform/.env` (Claude anahtarı orada); `Deciship/.env` okunmuyor.
- Gece yedeği her gün 03:00 (`Platform\scripts\yedek-zamanla.ps1 durum`); dış kopya hedefi ayarlanana dek yalnız bu bilgisayarda. C: diski %95 dolu.
- Gerçek kullanım işareti (`SOD_GERCEK_KULLANIM`) konunca testler 5434'e bağlanmaz: `npm run pg:baslat` (5435).
- Görüntü servisi testleri yalnız `Deciship/services/vision/.venv` Python'uyla geçer.
- Kalıcı silme kapalı gelir (`DELETED_INVOICE_PURGE_DAYS` boş); açmadan önce kuru çalışma (`Platform/docs/KURULUM.md`).
- Telefonda geliştirme sürümü kurulu; Metro ister (`Deciship/TELEFON-KURULUM.md`). Yeni APK çıkınca sürüm 1.2.0 ve sunucuda `MIN_MOBILE_VERSION` (KALANLAR 4.2).
- Elle CI koşusu (`gh workflow run ci.yml -f e2e=true`) aynı daldaki push koşusunu iptal eder.
