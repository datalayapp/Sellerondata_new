# SellerOnData

E-ticaret satıcılarına araç satan üst marka; satan şirket DatalaYapp. Çalışan tek araç **DeciShip** (kargo faturası ve desi farkı denetimi). **OrderLoom** ve **TagPress** sonra gelecek; altyapı buna hazır olmalı. Sade anlatım: `README.md`.

## Önce bunları oku

Giriş dosyaları içindekiler sayfasıdır; yalnız ilgili bölümü oku.

| Ne | Dosya |
|---|---|
| Neredeyiz, son test durumu | `SONRAKI-OTURUM/DEVAM.md` |
| Plan: gelen kutusu, aşama 0–6, bekleyen kararlar, yayından önce | `SONRAKI-OTURUM/KALANLAR.md` |
| Çalışma ritmi (oturum başı/sonu, commit, test, inceleme) | `.claude/skills/is-akisi/SKILL.md` |
| Geçerli kararlar | `Platform/docs/KARARLAR.md` |
| Mimari (kimlik, API, olaylar) | `Platform/docs/ARCHITECTURE.md` → `Platform/docs/mimari/` |
| DeciShip alan kuralları, API, itiraz | `Deciship/SPEC.md` → `Deciship/spec/` |
| Kurulum, portlar, demo hesaplar | `Platform/docs/KURULUM.md` |
| Tasarım kuralları | `Platform/docs/DESIGN.md` |
| Şunu değiştireceksen şu dosyalara bak | `SONRAKI-OTURUM/KOD-HARITASI.md` → `SONRAKI-OTURUM/kod-haritasi/` |
| Sahibin elle deneme adımları | `SONRAKI-OTURUM/TEST-ADIMLARI.md` |

Belge kodla çelişirse kod doğrudur; belgeyi düzelt. Eski planlar ve denetim raporları depoda yok; gerekirse masaüstündeki `SellerOnData-ARSIV-2026-11-14` klasörü.

## Klasörler

Tek git deposu (`github.com/GokcanT/SellerOnData`, özel), çalışma dalı `gelistirme`.

- `Platform/`: `apps/account-api` hesap servisi, `apps/hub-web` Merkez, `apps/site` tanıtım sitesi; `packages/` (auth-kit, contracts, shell, tokens, format, product-kit); `gateway/` nginx; `e2e/`; `docs/`.
- `Deciship/`: `packages/core` hesap motoru, `apps/api`, `apps/web` panel, `apps/mobile` tek SellerOnData mobil uygulaması (Expo), `services/vision` görüntü servisi (Python).
- DeciShip, Platform paketlerini `file:` yoluyla alır (workspaces yok; paket uyumu `npm run check`; karar kullanıcıda).

## Çalıştırma

- `Platform\BASLAT.bat` (Docker Desktop gerekir), `Platform\DURDUR.bat`. Merkez http://localhost:8088, site :8089, Postgres 5434, hesap servisi 4100. Hedef: `sellerondata.com`, `app.sellerondata.com`.
- Demo (yalnız yerel): `sahip@demo.sellerondata.com` / `Demo12345!`. Sıfırlama `Platform\SIFIRLA.bat`; demo güncelleme `Platform\scripts\demo.ps1 -Yes -NoBrowser`; yerel postalar `Platform\POSTA.bat`.
- Telefon: `Deciship/TELEFON-KURULUM.md`. Sahibin telefonu Android; Expo Go çalışmaz, dev client APK gerekir.

## Testler (tek kaynak)

Komut ilgili klasörde. Hangi değişiklikte hangi test: `SONRAKI-OTURUM/kod-haritasi/testler.md`.

| Parça | Komut | Postgres |
|---|---|---|
| Hesap servisi `Platform/apps/account-api` | `npm test`, `npm run typecheck` | evet |
| Merkez `Platform/apps/hub-web` | `npm test` (sahte API = gerçek kayıt), `npm run typecheck`, `npm run test:e2e` | hayır |
| Site `Platform/apps/site` | `npm run check` | hayır |
| Ortak paketler `Platform/packages/<ad>` | `npm test`; belirteçler ayrıca `npm run check` | product-kit, auth-kit kısmen |
| Gateway, uçtan uca `Platform` | `bash gateway/test/run.sh` (Docker), `npm run e2e` (ağır) | Docker |
| Hesap motoru `Deciship/packages/core` | `npm test` | hayır |
| DeciShip API `Deciship/apps/api` | `npm test` (= `test:unit` + `test:db`), `npm run typecheck` | `test:db` evet |
| DeciShip paneli `Deciship/apps/web` | `npm test`, `npm run check:i18n`, `npm run test:e2e` | hayır |
| Mobil `Deciship/apps/mobile` | `npm test`, `npm run typecheck` | hayır |
| Görüntü servisi `Deciship/services/vision` | `.venv\Scripts\python -m pytest -q` (sistem Python'unda `cv2` yok) | hayır |
| Görsel karşılaştırma (web, hub-web) | `npm run test:visual` (taban `%LOCALAPPDATA%\SellerOnData\gorsel`) | hayır |

- Gerçek yanıt kaydını bilerek yenilemek (`Deciship/apps/api`): `npx vitest run test/contract.test.ts -u` (panel), `npx vitest run test/hub/hubWebFixtures.test.ts -u` (Merkez); API metin tablosu `npm run t -- Deciship/apps/api/test/i18nText.test.ts -u`.
- Docker'sız test Postgres'i (5435, yönetici hakkı istemez): `npm run pg:baslat` / `pg:durdur` / `pg:durum` (`scripts/pg-yerel.ps1`). Kök koşucular 5434 kapalıysa 5435'i kendiliğinden kullanır; elle `TEST_DB_HOST=localhost:5435`.
- Kökten (`npm run parts` listeler): `npm test` (depo denetimi, tip, lint, veritabanısız), `npm run test:db`, `npm run test:all` (e2e hariç), `npm run test:e2e`, tek dosya `npm run t -- <dosya>`, değişen dosyaların testleri `npm run test:changed` (Postgres yoksa veritabanı adımı "koşmadı"), süre ölçümleri `npm run test:perf` (`*.perf.test.ts`, kapı değil), son CI koşusu `npm run ci:son` (düşen testler, ilk hata satırı), `npm run products:check`, `npm run main:ready` (o commit'te iki CI işi yeşil mi), `npm run check`, `npm run lint`, `npm run format:check`, isteğe bağlı `npm run coverage:core`.
- CI (`.github/workflows/ci.yml`): her push'ta hızlı iş; veritabanı işi ilgili yol değişince (`scripts/ci-select.mjs`; beş parça: API 3, hesap servisi 2), mesajda `[db]` zorlar, `[db-sonra]` erteler. Yalnız belge (`*.md`, `SONRAKI-OTURUM/**`, `.claude/**`) değişince CI koşmaz. e2e her gece 03:17 ve elle. Ön-commit kancası (`npm run hooks:install`): depo denetimi, sahnelenen dosyalarda lint ve uyarı tabanı.
- DeciShip API test veritabanı adı verilmezse rastgele ve bitişte silinir; sonra incelemek için `TEST_DB_NAME=deciship_apitest_<harf>`.

## Çalışma kuralları

**Plan ve karar**
- Kullanıcı projeyi devraldı: ne isterse o yapılır; yeni düzeltme ya da denetim kendiliğinden başlatılmaz.
- Plan `KALANLAR.md`; iş bitince satır silinir, yeni iş tek satır. `DEVAM.md` kısa kalır.
- İnce ayar (tutar, süre, eşik) sorulmaz: makul varsayılan konur, KALANLAR "Yayından önce"ye yazılır.
- Ürün davranışını, veri modelini ya da görünen tasarımı değiştiren, iki makul yolu olan karar sade dille ve öneriyle sorulur.
- Tasarım değişikliği önce tuvalde gösterilir, onaydan sonra kodlanır.
- Ödeme, deneme süresi, SMS, KVKK metinleri, mağaza yayını ve dış firmalara açılış sona bırakıldı (hata değil). Sunucu kurulumu iç kullanım için aşama 3'te.

**Test ve inceleme**
- Her değişiklikten sonra yalnız ilgili testler; tam koşu haftalık kararlı noktada ve kilometre taşında (`main` birleştirmesi, ilk sunucu kurulumu).
- Koşmayan test geçti sayılmaz, raporda "koşmadı" yazılır. Test beklentisi gevşetilmez; `skip`, `only` eklenmez.
- CI kırmızıyken yeni iş commit'lenmez; önce kırık düzelir (bayat beklenti KARARLAR'a göre).
- Para, yetki, veri silme ya da veri modeli değiştiren iş bağımsız incelemeden geçmeden kapanmaz.
- Sahte API'lere (panel, Merkez) iş kuralı kopyalanmaz. Belgede kural bugünkü hâliyle durur; tarihçe commit mesajına.

**Ajanlar ve makine**
- Ajan kuralları genel `agent-management` skill'inde; proje ritmi `is-akisi` skill'inde.
- Ajanlar sunucu (`vite`, `expo`) başlatmaz, e2e koşmaz. Sunucular ön planda başlatılmaz.
- Aynı anda en çok 3–4 ajan. Ağır koşular (Docker, Playwright, veritabanı) bellek yettikçe paralel; dolunca boşaltılır, gerekirse sırayla.

**Git**
- `gelistirme`'ye commit, oturum sonunda `git push`. Bir iş = bir commit. `main` birleştirmesi kullanıcıda; uzaktaki `main`, `gece`, `platform-gecisi` dallarına dokunulmaz.
- `git add -A` ve `--no-verify` yok; dosyalar tek tek eklenir. Mesaj dosyadan (`git commit -F`). `.env`, `keys/`, `storage/` ve gerçek müşteri dosyaları commit edilmez.

**Windows tuzakları**
- `node_modules/@sellerondata/*` ve `@deciship/core` junction'dır: klasör silmeden önce junction'ı kaldır; `robocopy /MIR` kullanma (hedef paketi siler).
- Node süreçleri yalnız PID ile kapatılır. Paralel Playwright koşularında ayrı `--output` klasörü ve port.
- `*.ps1` UTF-8 BOM'lu, `*.sh` LF kalır. Bash komutunda dosya adını ters tırnakla yazma; belgeyi Edit/Write ile düzenle.

**Dil ve arayüz**
- Kullanıcıya Türkçe, kısa, sade; yazılımcı değil gibi anlat. "İşçi" denmez, "çalışan" yazılır.
- Arayüz metni koda yazılmaz; her metin TR ve EN sözlükte. İlk açılış dili: kayıtlı tercih, yoksa cihaz/tarayıcı dili (tr, en), yoksa İngilizce; her yüzeyde aynı.
- Ürün adları SellerOnData, DeciShip, OrderLoom, TagPress; kod anahtarı küçük harf (`deciship`, `orderloom`, `tagpress`). Yeni araç: `Platform/packages/contracts/src/products.ts` + `npm run products:gen`.
- Sade arayüz: ekran başına tek birincil eylem, nadir eylemler ⋯ menüsünde, az süzgeç, kısa metin; sadeleştirme özellik silmez.
- Tasarım dili: Merkez ve DeciShip paneli D09 Renk bandı, mobil D05; OrderLoom ve TagPress için seçilmedi, sorulmadan varsayılmaz.
