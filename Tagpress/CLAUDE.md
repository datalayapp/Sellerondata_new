# TagPress — çalışma notları

Önce `YOL-HARITASI.md` (geçerli yön, kararlar, durum) okunur. `HANDOFF.md` ve `PLAN.md` eski "Etiket Studio" dönemini anlatır; motor, baskı ve tasarım dili verisi için kaynak olmayı sürdürür, `YOL-HARITASI.md` ile çelişirse `YOL-HARITASI.md` geçerlidir.
Arayüz: dil "Tezgâh"; görünüm `docs/tezgah-tuval.html`, değerlerin tek kaynağı `Platform/packages/tokens/tokens.json` (`surfaces.tagpressWeb`, `bands.tagpress`; üretilen `apps/web/src/tezgah/tokens.generated.css`, aynası `DESIGN.md`), uygulama planı `ARAYUZ-PLANI.md` (eski "Baskı Provası" kuralları geçersiz). Kurulum: `README.md`; platformdaki yeri ve kod haritası `SONRAKI-OTURUM/kod-haritasi/tagpress.md`.
İki kip: platform (`TAGPRESS_AUTH=platform`, varsayılan; SellerOnData Hesap jetonu, Postgres, yapay zekâ yalnız geçitten) ve yerel (`local`, girişsiz, SQLite; `pnpm dev` ve `pnpm start` kendisi verir). Sunucu kodu ikisinde aynı; SQL değişince `pnpm test` ve `pnpm test:pg` ikisi de koşar.

- Kullanıcıyla Türkçe konuşulur; arayüz, kod yorumları ve mesajlar Türkçe.
- Teknik kararları sen ver, ürün kararlarını kullanıcıya sor. Kullanıcıdan bir şey gerekince (anahtar, kağıt ölçüsü, deneme baskısı) dur ve açıkça iste.
- Eski klasör `C:\Users\Gokcan\Desktop\Etiket-Generator` YALNIZCA OKUNUR: yazma, komut çalıştırma, kod kopyalama yok. Eski uygulama 5317'de çalışır.
- Portlar:
  - Uygulama 5420, geliştirme arayüzü 5421 (yerel kip; sahibin TagPress'i ve MCP buradadır).
  - Platform kipi geliştirmede API 5422, web 5423 (`Platform\scripts\dev.ps1` açar); kapta API 4200, `/api/tagpress` ve `/tagpress/` gateway arkasında.
  - Deneme/ölçüm sunucuları yalnızca 5499 ve kopya veriyle (`TAGPRESS_DATA_DIR`; eski adı `STUDIO_DATA_DIR` da kabul edilir).
  - İş bitince süreç ağacı kapatılır, `netstat` ile doğrulanır, açık kalan port kullanıcıya söylenir.
- Değişmezler:
  - AI piksel koordinatı üretmez.
  - Müşteri metni hiçbir otomatik adımda değişmez; fontta olmayan karakter yedek fontla basılır.
  - Tarz koda değil tasarım diline (profil) yazılır.
  - Görüntü "şablona yaz" modunda şablon pikseline dokunulmaz.
- AI çağrıları para harcar: önce küçük örnek, maliyeti söyle (toplam bütçe ≤ $20; kullanıcı 2026-10-09: gerekmedikçe harcama, sonucu iyileştirecekse kullan).
- Git: commit `gelistirme`'ye, bir iş = bir commit; kurallar kök `CLAUDE.md`'de.
- Ajan kuralları genel `agent-management` skill'inde.
- Komutlar:
  - `pnpm test`, `pnpm typecheck`, `pnpm test:pg` (Postgres; `TEST_DB_HOST`, rastgele ve bitişte silinen veritabanı)
  - `pnpm dev`, `pnpm start` (yerel kip)
  - `pnpm aktar:pg` (yerel veriyi platforma aktarır; sahip `Platform\scripts\tagpress-aktar.ps1` ile çalıştırır, `Tagpress/data` gözetimsiz okunmaz ve yazılmaz)
  - `pnpm olc:motor`
  - `node scripts/kabul.mjs` (kabul ölçümü)
  - `node scripts/anahtar-yukle.mjs` (şifreli anahtarları bir sunucuya yükler)
  - `node scripts/ana-anahtar.mjs durum | dondur | temizle` (API anahtarlarının ana anahtarı)
- Site Figma'ya bağlı değil (2026-10-10). Figma eklentisi ayrı bir projedir: `C:\Users\Gokcan\Desktop\VIBE CODING\OTOMASYON ARAÇLARI\Figma Plugin` (siteye bağlanmaz).
