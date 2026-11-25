# SellerOnData Platform: mimari sözleşme

Bu dosya mimari sözleşmenin dizinidir: kimlik, oturum, Hesap API, olaylar, Merkez sözleşmesi, güvenlik. İçerik `Platform/docs/mimari/` altındaki parçalardadır; § numaraları ve başlıklar değişmez (kod "ARCHITECTURE §6", "§5 "Tek hesap"" diye atıf yapar). Sözleşme bağlayıcıdır; değişiklik gerekiyorsa önce ilgili parça güncellenir.

Başka yerde duranlar:
- Geçerli kararlar ve gerekçeleri (kullanıcı ne seçti): `Platform/docs/KARARLAR.md`. Çelişkide KARARLAR geçerlidir, mimari ona göre düzeltilir.
- Çalıştırma (komut, ortam değişkeni, port, demo hesap, yedek, destek komutlarının kullanımı): `Platform/docs/KURULUM.md`.
- Görsel kurallar (renk, ölçü, bileşen, sadelik): `Platform/docs/DESIGN.md`.
- Çalışma kuralları: kök `CLAUDE.md`. DeciShip alan kuralları: `Deciship/SPEC.md`.

## § → dosya

| § | Başlık | Dosya | Özet |
|---|---|---|---|
| §1 | Mimariyi belirleyen kararlar | `mimari/01-temel.md` | Araçlar ve kod anahtarları, tek ürün kaydı (`products.ts`), `off/pilot/public`, deneme süresi yok, Merkez'in rolü, tek hesap, izinle denetim, yapay zekâ geçidi (`ai-api`; ayrıntı `SONRAKI-OTURUM/YAPAY-ZEKA-GECIDI.md`) |
| §2 | Depo ve klasör yapısı | `mimari/01-temel.md` | Klasör ağacı, `file:` paketleri (workspaces yok; TagPress `link:`), Docker derleme bağlamı |
| §3 | Adresler (tek köken) | `mimari/01-temel.md` | Yol → servis tablosu (TagPress, `/api/ai/`), DeciShip web yolları, açılış sırası |
| §4 | Veritabanı | `mimari/01-temel.md` | Roller ve şemalar, migration kuralları, üretim, kalan riskler |
| §4 | ↳ platform şeması | `mimari/01-temel.md` | Hesap tabloları ve alanları |
| §4 | ↳ deciship şeması | `mimari/01-temel.md` | `Company`, `Member` projeksiyonu, RLS |
| §4 | ↳ tagpress şeması | `mimari/01-temel.md` | product-kit izdüşümü, `org_id` + RLS, senkron köprü, düz SQL göçleri |
| §4 | ↳ ai şeması | `mimari/01-temel.md` | Geçidin defteri, günlük özet, mühürlü anahtarlar, tavanlar |
| §5 | Kimlik ve oturum | `mimari/02-kimlik.md` | Ed25519 jeton, çerezler, üst yaş, telefon, `X-SOD-Org`, sahip e-postası, `TOKEN_STALE` |
| §5 | ↳ Tek hesap: site, Merkez, araçlar | `mimari/02-kimlik.md` | Site kimlik bilgisi almaz, `site-session` yoklaması, CORS/CSRF, `SITE_ORIGINS`, siteden çıkış |
| §5 | ↳ Yetki kuralları (güvenlik sınırı) | `mimari/02-kimlik.md` | Yönetici sınırları, telefon daveti, şifre kodu, e-posta daveti, posta ve gönderim sonucu |
| §5 | ↳ Anlık iptal | `mimari/02-kimlik.md` | Epoch + Outbox, olay gönderimi, JIT projeksiyon |
| §5 | ↳ Ürün tarafı denetim sırası (`auth-kit`) | `mimari/02-kimlik.md` | Jeton → ürün → izin → salt okunur sırası |
| §6 | Hesap API (`/api/account`) | `mimari/03-hesap-api.md` | Bütün uçların listesi (roller dahil), hata gövdesi |
| §6 | ↳ Hesap uygulama kararları (sözleşme boşlukları) | `mimari/03-hesap-api.md` | Veri, Yetki, Firma açma ve ayrılma (Firmayı kapatma), Kayıt yalnız davetle |
| §6 | ↳ (devamı) Oturum, Katılım, E-posta doğrulaması, Hız sınırı, Anahtar döndürme, Açılış korumaları, Olaylar ve abonelik (Alıcı sözleşmesi) | `mimari/04-hesap-oturum.md` | Kilit sırası, yenileme toleransı, çıkış, doğrulama, kova sınırları, açılış denetimleri, olay sözleşmesi, JWKS önbelleği |
| §6 | ↳ Abonelik durumları ve destek komutları | `mimari/05-abonelik-bildirim.md` | `ACTIVE/READ_ONLY/CANCELED`, epoch artışı, destek komutları, `signup:purge` |
| §6 | ↳ Firma dili ve saat dilimi | `mimari/05-abonelik-bildirim.md` | Firma dili, `TIME_ZONES`, olayla yayılma, web ve mobilde saat dilimi, sabit kalanlar |
| §6 | ↳ Araç bildirimi | `mimari/05-abonelik-bildirim.md` | `POST /internal/notify`: kimlik, gövde, alıcı, sınırlar, yarım kalan gönderim |
| §7 | Merkez sözleşmesi (ürünlerin uyguladığı uçlar) | `mimari/06-merkez.md` | `/platform/*` uçları, `sample`, tak-çalıştır hedefi |
| §7 | ↳ Yeni araç ekleme | `mimari/06-merkez.md` | Kayıt → üret → kod → açma, hâlâ elle kalanlar |
| §8 | Merkez bilgi mimarisi | `mimari/06-merkez.md` | Sayfalar (Yapay zekâ harcaması, Platform › Yapay zekâ dahil), görünürlük, mobil Merkez, hata sınırı, çıkış, parça yükleme, araçlar arası geçiş |
| §9 | i18n | `mimari/06-merkez.md` | Dil kaynağı sırası, API dili, site dili |
| §10 | Marka | `mimari/06-merkez.md` | Yazım, renk ve işaret kaynakları |
| §11 | Güvenlik asgarileri | `mimari/07-guvenlik.md` | Özetler, şifre kuralı, giriş hız sınırı, kabul edilen riskler (numara kapma), biber dönüşü, günlük, gateway, geçitte yönetici yetkisi |
| §11 | ↳ Mobil sürüm uyumu (426) | `mimari/07-guvenlik.md` | `X-SOD-Client`, `MIN_MOBILE_VERSION`, `client-policy` |
| §11 | ↳ Arka plan işleri ve ölçek | `mimari/07-guvenlik.md` | Postgres iş kuyruğu, çalıştırıcı, tek sunucuya bağlı kalanlar |
| §12 | Çalışma kuralları | `mimari/07-guvenlik.md` | Kök `CLAUDE.md`'ye yönlendirir |

Bir başlığı bulmak için başlık metniyle `Platform/docs/mimari/` içinde arayın (ör. "Alıcı sözleşmesi", "Hız sınırı", "Firmayı kapatma").
