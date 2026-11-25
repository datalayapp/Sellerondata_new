# ai-api: yapay zekâ geçidi

SellerOnData'nın bütün araçlarının yapay zekâ çağrıları buradan geçer. Ürün değil, platform hizmetidir (şema `ai`, roller `sod_ai_admin`, `sod_ai`; port 4300). Nasıl kurulduğu ve kalanlar `SONRAKI-OTURUM/YAPAY-ZEKA-GECIDI.md`; ayarlar `Platform/docs/KURULUM.md` "Yapay zekâ geçidi"; kararlar `Platform/docs/kararlar/firma-ve-merkez.md` "Yapay zekâ geçidi ve harcama".

## Ne yapar

- **Anahtar deposu** (`src/keystore/`): Anthropic ve Gemini anahtarları veritabanında AES-256-GCM ile mühürlü, satıra bağlı (`AI_KEY_MASTER`; döndürmede `AI_KEY_MASTER_PREVIOUS`). Anahtar hiçbir yanıtta ve günlükte yoktur; ekran yalnız son 4 haneyi, gireni ve son sınamayı görür.
- **Vekil** (`src/proxy/`): araç yolları `POST /internal/anthropic/v1/messages`, `…/v1/messages/count_tokens`, `POST /internal/gemini/v1beta/models/{model}:generateContent` ve `:streamGenerateContent`. İstek baytı baytına iletilir (akış, araç kullanımı, görsel, önbellek, beta başlıkları korunur); aracın jetonu ve `X-SOD-*` başlıkları silinir, gerçek anahtar eklenir. Yanıtta `x-sod-ai-call-id`.
- **Defter** (`src/ledger/`): her yukarı akış denemesi bir `AiCall` satırı, mikro USD; satır `pending` açılır, tek koşullu güncellemeyle kapanır; kopma ve iptalde tahmin (bilinmeyen kısım fazla), çökme sonrası `interrupted` taraması. Fiyatlar `@sellerondata/contracts` `ai.ts`'ten.
- **Sınırlar** (`src/limits/`): firma kapalı, platform durdurma, platform günlük ve aylık tavan, firmanın tek ortak aylık hakkı, firma × araç tavanı, hız ve eşzamanlılık; kabulden önce pay ayrılır, süren işe %20 pay. Ret gövdesi sağlayıcı biçiminde `sod_*` kodu + `x-sod-ai-reject` + `x-should-retry: false` (SDK yeniden denemez). `GET /internal/status`, `GET /internal/allowance?orgId=` araçlar için.
- **Merkez uçları** (`src/routes/spend.ts`, `admin.ts`, `admin-keys.ts`; gateway `/api/ai/`): harcama özeti, çağrı listesi, CSV/XLSX dışa aktarma (en çok 50.000 satır), kalan hak; yönetici uçları anahtarlar, tavanlar, durum. Firma görünümü yalnız jetondaki firma ve OWNER/ADMIN; `scope=platform` yalnız platform yöneticisi (`op`). Değiştiren yönetici uçları ayrıca Hesap'ın adım artırma jetonunu ister (`Platform/docs/mimari/07-guvenlik.md` §11).
- **Olay alıcısı** (`src/routes/events.ts`, `POST /api/ai/internal/events`, imzalı): firma adı, saat dilimi, kapanış ve açılış, kalıcı silme, abonelik sınırları (araç tavanı). **Bakım** (`src/maintenance/`): saatlik günlük özet (`AiSpendDaily`), 24 ay saklama, eski olay kimlikleri; kalıcı silinen firmanın ayrıntılı satırları özete katılıp silinir.

## Güven sınırı

- Araç kimliği yalnız araç jetonudur (`AI_GATEWAY_TOKENS`, SDK'nın anahtar başlığında: `x-api-key` / `x-goog-api-key`). Jeton bir ürüne bağlıdır; ürün jetondan çözülür, başka araç adına çağrı yapılamaz.
- **`X-SOD-Org` ve `X-SOD-Member` sınanmaz**: geçit aracın söylediği firmaya yazar. Doğru firma bağlamını vermek aracın sorumluluğudur (araç kendi jetonuyla, kendi firma kapsamından gönderir); jetonu ele geçiren herhangi bir firma adına harcama yazabilir, bu yüzden jeton yalnız iç ağda ve aracın kabındadır.
- Olaylardan henüz tanınmayan firma (satırı yok) varsayılan hakkı alır (`AI_ORG_MONTHLY_USD`); kapalı firma reddedilir (`Org.closedAt`).
- Araç yolları (`/internal/*`) gateway'de dışarıya 404; yalnız Docker iç ağından.

## Komutlar

`Platform/apps/ai-api` içinde (Postgres gerekir; testler `TEST_DB_HOST`, kök `CLAUDE.md` "Testler"):

| Komut | Ne |
|---|---|
| `npm test` | Bütün testler (Postgres; rastgele, bitişte silinen veritabanı) |
| `npm run typecheck` | Tip denetimi |
| `npm run dev` | Geliştirme sunucusu (`Platform/scripts/dev.ps1` kendisi açar, 4300) |
| `npm run ai-key -- <komut>` | Acil durum anahtar komutu; kapta `node dist/ai-key.js <komut>`: `set`, `remove`, `test`, `status`, `rotate-master` (KURULUM) |
| `npm run db:deploy` | Göçleri uygular (compose'da `ai-migrate`) |

Kökten parçalar: `ai` (veritabanı testleri), `tc:ai` (tip).
