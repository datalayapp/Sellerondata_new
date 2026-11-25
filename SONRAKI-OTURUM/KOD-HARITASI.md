# Kod haritası

Alt ajanlara "şunu değiştireceksen şu dosyalara bak" diyen rehberin içindekiler sayfası. Ayrıntı bölüm dosyalarındadır (`SONRAKI-OTURUM/kod-haritasi/`). Yollar depo köküne göredir. Prompt'ta "KOD-HARITASI → 'DeciShip API'" diye atıf yapılır; bölüm başlıkları bölüm dosyalarında aynen durur.

## Büyük akış

```
Fatura dosyası ─► API routes/invoices.ts ─► core (oku, eşle, karşılaştır) ─► services/compare.ts + lineWrite.ts ─► Postgres (deciship şeması, RLS)
Ölçüm (mobil) ─► API routes/measurements.ts ─► aynı tracking no'lu faturalar yanıttan sonra yeniden karşılaştırılır (services/measurementQueue.ts ─► compare.ts recompareForTracking)
Okuma: services/invoiceSerialize.ts ─► web src/api/types.ts ─► sayfalar     Merkez: services/hub/* ─► contracts hub.ts ─► hub-web, mobil hub
TagPress: web (/tagpress/) ─► /api/tagpress ─► Tagpress/apps/server (rewriteUrl, uç izni) ─► servisler ─► TenantDb (SQLite ya da senkron köprü ─► Postgres tagpress şeması)
Yapay zekâ: araç SDK ─► ai-api /internal/* (araç jetonu, X-SOD-*) ─► Anthropic/Gemini; defter ai.AiCall ─► /api/ai/spend/* ─► Merkez
```

Paket bağları `file:` yoluyla, `node_modules` içinde junction'dır: `@deciship/core` (api, web, mobil), `@sellerondata/contracts` ve `auth-kit` (api, ai-api), `shell` (web, hub-web). TagPress (pnpm) aynı Platform paketlerini `link:` ile alır (`Tagpress/apps/*/node_modules/@sellerondata/*`, aynı junction tuzağı). Core'daki değişiklik derleme olmadan hemen tüm tüketicilere geçer.

## Bölümler

| Bölüm | Dosya | Ne zaman bakılır |
|---|---|---|
| Hesap motoru | `SONRAKI-OTURUM/kod-haritasi/deciship-core.md` | Karşılaştırma, tarife hesabı, fatura okuma/eşleme, ileti metni, çekirdek i18n |
| DeciShip API | `SONRAKI-OTURUM/kod-haritasi/deciship-api.md` | Yeni uç, rota, şema/göç, rateLimit, "sık yapılan işler" tablosu |
| DeciShip API (servisler) | `SONRAKI-OTURUM/kod-haritasi/deciship-api-servisler.md` | `services/` altındaki iş mantığı: karşılaştırma, itiraz, yapay zekâ, iş kuyruğu, temizlik, Merkez uçları |
| DeciShip paneli | `SONRAKI-OTURUM/kod-haritasi/deciship-panel.md` | Web sayfaları, bileşenler, sözlük, stil, panel testleri |
| Mobil, Görüntü servisi | `SONRAKI-OTURUM/kod-haritasi/mobil.md` | Mobil ekranlar, kuyruk, taslak, sürüm denetimi; Python görüntü servisi |
| Platform | `SONRAKI-OTURUM/kod-haritasi/platform.md` | Hesap servisi (platform yöneticisi dahil), Merkez, site, ortak paketler, gateway, yapay zekâ geçidi (`ai-api`), yeni araç eklemek, e2e |
| TagPress | `SONRAKI-OTURUM/kod-haritasi/tagpress.md` | İki kip, uç izni, firma bağlamı, Postgres köprüsü ve lehçe, göçler, Merkez uçları, yapay zekâ, aktarım, web platform kipi |
| Test rehberi | `SONRAKI-OTURUM/kod-haritasi/testler.md` | Hangi değişiklikte hangi test, kök koşucu, depo denetimi, lint, görsel test, CI |
| Örnek veri, Kesişen değişiklikler, Bilinen tuzaklar | `SONRAKI-OTURUM/kod-haritasi/kesisen-ve-tuzaklar.md` | Bir değişiklik başka nereleri etkiler; sık düşülen hatalar |

## Başka belgeler

- Alan kuralları: `Deciship/SPEC.md` (içindekiler; parçalar `Deciship/spec/`), itiraz takibi `Deciship/spec/itiraz.md`.
- Kararlar: `Platform/docs/KARARLAR.md`. Mimari: `Platform/docs/ARCHITECTURE.md` (içindekiler; parçalar `Platform/docs/mimari/`).
- Test komutları: kök `CLAUDE.md` "Testler" tablosu. Bu haritadaki test notları yalnız hangi değişiklikte hangi testin koşulacağını söyler.

## Kural

Bir iş yeni dosya ya da yeni yol eklerse, ilgili bölüm dosyası iş kapanırken güncellenir.
