# SellerOnData: yapay zekâ geçidi

> **Durum (2026-11-23):** geçit kuruldu ve testli (`Platform/apps/ai-api`). Anahtar deposu, vekil, defter, tavanlar, Merkez harcama ve yönetici ekranları, Hesap'ta platform yöneticisi ve hizmet olayları var; TagPress ve DeciShip geçide bağlanacak biçimde yazıldı. **Araçlar henüz geçide bağlı değil:** compose'da `AI_GATEWAY_URL` boş (açmak §7). Kalanlar §7, kararlar §9.

Kod doğrudur; bu belge bugünkü hâli kısaca anlatır. Ayarlar ve komutlar `Platform/docs/KURULUM.md` "Yapay zekâ geçidi", servis notu `Platform/apps/ai-api/README.md`, mimari `Platform/docs/mimari/01-temel.md` §1, yönetici yetkisinin güvenlik sınırları `Platform/docs/mimari/07-guvenlik.md` §11. **[V]** = sahibin gözden geçireceği varsayılan.

## 0. Kısaca

- Sağlayıcı anahtarları (Anthropic, Gemini) yalnız geçitte, şifreli durur; platform sahibi Merkez'den bir kez girer. Araçta anahtar yoktur.
- Araçlar SDK'nın taban adresini geçide çevirir, anahtar yerine kendi araç jetonunu gönderir. Geçit isteği değiştirmeden iletir, kullanımı yanıttan kendisi okur ve tek deftere (USD) yazar.
- Sınırlar geçitte: platform günlük/aylık tavan, firmanın tek ortak aylık hakkı, firma × araç tavanı, hız, model izin listesi.
- Merkez'de "Yapay zekâ harcaması" (firma) ve "Platform › Yapay zekâ" (platform yöneticisi) ekranları geçidin uçlarından okur.

## 1. Parçalar (koddan)

| Parça | Yer |
|---|---|
| Sözleşme: fiyat tablosu (Anthropic + Gemini, 1 sa önbellek, görsel), `aiCostMicroUsd`, `X-SOD-*` başlıkları, `sod_*` ret kodları, harcama tipleri, tavan varsayılanları | `Platform/packages/contracts/src/ai.ts`, `aiSpend.ts`; kayıtta araç başına `ai: { purposes, models, defaultCapUsd }` (`products.ts`) |
| Geçit | `Platform/apps/ai-api` (`keystore/`, `proxy/`, `ledger/`, `limits/`, `routes/`, `spend/`, `maintenance/`) |
| Platform yöneticisi, adım artırma, hizmet olayları | `Platform/apps/account-api/src/routes/operator.ts`, `lib/me.ts`, `lib/outbox.ts`, `lib/dispatcher.ts`, `env.ts` |
| Merkez ekranları | `Platform/apps/hub-web/src/pages/account/AiSpend.tsx` (`/account/billing/ai`), `src/pages/platform/` (`/platform/ai`, `/platform/ai/spend`), `src/api/ai.ts`, sahte `src/mocks/ai.ts` |
| DeciShip bağlantısı | `Deciship/apps/api/src/env.ts` (`aiModeOf`), `services/ai.ts`, `services/aiMeter.ts` |
| TagPress bağlantısı | `Tagpress/packages/ai/src/gateway.ts`, `Tagpress/apps/server/src/adapters/ai-gateway.ts`, `adapters/ai.ts`, `services/key-guard.ts`, `services/costs.ts` |
| Compose | `ai-migrate`, `ai-api` (`Platform/docker-compose.yml`); gateway `/api/ai/` (`Platform/gateway/conf/default.conf`) |

## 2. Anahtarın yeri ve yönetimi

- Anahtar `ai.ProviderKey`'de AES-256-GCM ile mühürlü (ana anahtar `AI_KEY_MASTER`). Hiçbir yanıtta ve günlükte yoktur; ekran son 4 haneyi, gireni, zamanı ve son sınamayı gösterir. Üretimde sağlayıcı anahtarı hiçbir kabın ortamında olamaz (geçit, DeciShip ve TagPress açılmaz).
- **Platform yöneticisi:** `PLATFORM_OPERATORS` e-posta listesi; yalnız doğrulanmış, askıda olmayan kişi. Jetonda `op: true`, `/me`'de `platformOperator: true`; firmadan bağımsız.
- Ekran Merkez › Platform › Yapay zekâ: anahtar gir, sına (ücretsiz), kaldır; platform tavanları ve acil durdurma; firma tavanı. Değiştiren her işlem şifreyi yeniden ister (`POST /api/account/operator/step-up`, 5 dk, `aud: ai-admin`).
- Acil durum komutu `ai-key` (`set` anahtarı standart girdiden okur; `status`, `test`, `remove`, `rotate-master`).

**Geçidin ayrıntıları:**

- Araç yolları yalnız iç ağdan: `POST /internal/anthropic/v1/messages`, `…/count_tokens`, `POST /internal/gemini/v1beta/models/{model}:generateContent` ve `:streamGenerateContent`; diğer sağlayıcı yolları 404.
- Araç kimliği SDK'nın anahtar başlığında (`x-api-key` / `x-goog-api-key` = `AI_GATEWAY_TOKENS` içindeki jeton); ürün jetondan çözülür. Bağlam başlıkları `X-SOD-Org`, `X-SOD-Member`, `X-SOD-Purpose`, `X-SOD-Request-Id`, `X-SOD-Origin` (`request`|`job`) sağlayıcıya gitmez. Firma başlığı sınanmaz: doğru firmayı vermek aracın işidir (README "Güven sınırı").
- Akış olduğu gibi aktarılır; sağlayıcının hata gövdesi, durumu ve `retry-after` değişmez. Geçidin kendi reddi sağlayıcı biçiminde `{type:'error', error:{type:'sod_*'}}` + `x-sod-ai-reject` + `x-should-retry: false`; ücret doğmuş olabilecek her geçit 5xx'inde de `x-should-retry: false`.
- Kodlar: `sod_platform_paused`, `sod_org_cap`, `sod_tool_cap`, `sod_rate_limited` (429); `sod_model_not_allowed`, `sod_purpose_unknown` (400); `sod_unauthorized` (401); `sod_provider_missing` (503). Gövde saklanmaz, günlüğe yazılmaz.

## 3. Harcama defteri

- `ai.AiCall`: bir yukarı akış denemesi = bir satır (`UNIQUE(product, toolRequestId, attempt)`). Ürün jetondan, firma/kişi/amaç başlıktan; istenen ve yanıtlayan model, belirteçler (önbellek 5 dk/1 sa ayrı), görsel sayısı, `costMicroUsd`, `priceVersion`, durum (`ok`, `failed`, `cancelled`, `rejected`, `interrupted`), `estimated`.
- Satır kabulde `pending` ve üst sınır payıyla açılır, tek koşullu güncellemeyle kapanır. Kopma ya da iptalde tahmin (bilinmeyen kısım fazla); açılışta ve dakikada bir `interrupted` taraması.
- Fiyatlar tek kaynaktan (`contracts` `ai.ts`); bilinmeyen model geçitte reddedilir, tabloda olmayan yedek model en pahalıdan sayılır. Defter USD; firma ekranında TL (kur `AI_PRICE_TRY_PER_USD`, 100).
- Saklama: ayrıntılı satırlar 24 ay **[V]**; `AiSpendDaily` (gün × firma × araç × amaç × model × durum) süresiz. Firma kalıcı silinince ayrıntılı satırlar özete katılıp silinir; özette ad ve kişi yoktur.
- Olaylar Hesap'tan (`PLATFORM_SERVICE_TARGETS=ai=…`): `org.updated` (ad, saat dilimi), `org.closed`, `org.reopened`, `org.purged`, `subscription.updated` (sınırlardan araç tavanı).
- Araçların kendi kayıtları sürer ve geçidin satırını taşır: DeciShip `AiUsage.gatewayCallId`, TagPress `ai_calls.gateway_call_id` (+ `member_id`).

## 4. Merkez'de harcama

- Firma sahibi ve yöneticisi: Merkez › Abonelik › Yapay zekâ harcaması (`/account/billing/ai`): yalnız kendi firması, bütün araçlarıyla; tutar TL; kalan aylık hak; araç, amaç, model, kişi kırılımı; çağrı listesi; CSV/XLSX (en çok 50.000 satır). Diğer üyeler görmez.
- Platform yöneticisi: `/platform/ai/spend`, bütün firmalar ve araçlar, firma kırılımı; TL ve USD.
- Uçlar `/api/ai/spend/summary` (`HubAnalytics`), `/spend/calls` (`HubDatasetPage`), `/spend/calls/export`, `/spend/allowance`; yönetici `/api/ai/admin/keys`, `/admin/limits` (+ `/orgs/:orgId`), `/admin/status`.
- DeciShip'in araç içi "Yapay zekâ kullanımı" sayfası (`/account/billing/ai/:product`) kalır.
- Ekranlar yalnız mevcut bileşenlerle kuruldu (gece; tuvalden geçmedi): sahip onaylar ya da değiştirmek ister.

## 5. Sınırlar (varsayılanlar [V])

| Sınır | Varsayılan | Nereden değişir |
|---|---|---|
| Platform günlük / aylık | 10 $ / 150 $ | `AI_PLATFORM_DAILY_USD`, `AI_PLATFORM_MONTHLY_USD`; yönetici ekranı ezer |
| Firma aylık (bütün araçlar, tek hak) | 30 $ | `AI_ORG_MONTHLY_USD`; yönetici firma başına ezer |
| Firma × araç aylık | DeciShip 15 $, TagPress 20 $ | kayıttaki `defaultCapUsd`; abonelik sınırı ezer; 0 = o araçta kapalı |
| Uyarı eşiği | %80 (`warnPct`) | kod |
| Hız | firma dakikada 30 çağrı, aynı anda 4 akış; araç başına aynı anda 12 | kod |
| Tek istek | gövde ≤ 32 MB, akış 15 dk | kod |

- Kabulden önce pay ayrılır (üst sınır tutarı); `harcanan + kendi payı > tavan` kesin ret, süren çağrıların payı yüzünden aşılacaksa geçici ret (`sod_rate_limited`, 15 sn). Tavan dolmadan açılmış arka plan işi tavanın %20 üstüne kadar sürer; platformun elle durdurulması pay tanımaz.
- Platform durunca firmaya "geçici olarak durduruldu" denir, firma hakkı dolmuş gibi gösterilmez. Elle giriş, Excel ve önbellek çalışır.

## 6. Araçlar

**DeciShip** (`Deciship/apps/api`)
- Yol `aiModeOf`: `AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN` doluysa geçit; boşsa yerelde `ANTHROPIC_API_KEY` ile doğrudan; üretimde yalnız geçit (`ANTHROPIC_API_KEY` doluysa açılış durur).
- Her çağrıda `X-SOD-*`; `X-SOD-Request-Id` = `AiUsage.id`. `aiEnabled()` ve `/me ai.available` geçidin `/internal/status`'ünden (30 sn önbellek).
- Ret eşlemesi: platform durdurma 429 `AI_PLATFORM_PAUSED`, firma/araç tavanı 429 `AI_SPEND_CAP`, hız 503 `AI_BUSY`, anahtar yok 503 `AI_DISABLED`, kapalı firma 409; hiçbiri yeniden denenmez, 0 TL `FAILED` satırı.
- Araç içinde kalanlar: firmanın TL aylık hakkı (`Subscription.limits.aiCreditMonthly`, `AiCreditEntry`), önbellek, hata hatırlama, sigorta, günlük tavan `aiDailyBudget.ts` (geçitten sonra emekliye ayrılacak, §7).

**TagPress** (platform kipi; yerel kip bugünkü gibi sahibin kayıtlı anahtarıyla)
- İstemciler `AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN` ile; her çağrıda `X-SOD-*` (amaç `tagpress.<amaç>`, bir işin bütün çağrıları aynı istek kimliğiyle). Adres boşsa yapay zekâ kapalı (`ai-unavailable`).
- Platform kipinde `SecretService` hiç çağrılmaz; ortam değişkenine düşme her kipte kapalı. Anahtar uçları `409 managed-by-platform`; Ayarlar › Bağlantılar platformda salt okunur.
- Aylık sınır geçidin `/internal/allowance`'ından (firma başına 30 sn önbellek; yalnız işi baştan durdurmak için, asıl sınırı geçit uygular). Oturum başına 3 $ ve `count_tokens` tahmini araçta kalır. `sod_*` retleri `409 budget-exceeded` / `ai-paused`.
- Fiyatlar `@sellerondata/contracts` tablosundan (yerel kipte de). Harcama tutarlarını araç içinde yalnız TagPress Yönetici görür.

**Yeni araç:** `Platform/docs/mimari/06-merkez.md` "Yeni araç ekleme" (kayıtta `ai`, geçide jeton, SDK taban adresi, `X-SOD-*`).

## 7. Durum ve kalanlar

Yapılanlar (G1–G4, H1, W1, D1, T1 paketleri; commit mesajlarında): anahtar deposu ve `ai-key`, vekil, defter, tavanlar ve tek ortak hak, Merkez uçları ve ekranları, olay alıcısı ve bakım, platform yöneticisi ve adım artırma, DeciShip ve TagPress istemcileri.

Kalanlar (satırları `SONRAKI-OTURUM/KALANLAR.md`'de):
1. **Geçidi açmak:** Merkez'de anahtar girilip sınandıktan sonra araçlara `AI_GATEWAY_URL=http://ai-api:4300` (KURULUM "Geçidi açmak"); DeciShip'ten `ANTHROPIC_API_KEY` kalkar.
2. **DS-AI-2:** DeciShip'in araç içi aylık hakkının (`aiCreditMonthly`, `AiCreditEntry`) geçide taşınması (§9.3'ün DeciShip yarısı); araç kalan hakkı geçitten okur.
3. **D2:** bir hafta gözlemden sonra `aiDailyBudget.ts` emekliliği (`AI_DAILY_BUDGET_TRY=off`, sonra kod) ve iki defterin uzlaştırma komutu.
4. Yönetici ekranında uyarı geçmişi (tavana yaklaşma, dolma, anahtar reddi), %80'de firma sahibine posta, "bir firma platform harcamasının yarısını geçti" uyarısı: yok.
5. Yönetici yetkisinin düşmesi (listeden çıkarma, çıkış) geçitte en çok 10 dk gecikir (§11); anında görünmesi ayrı iş.
6. Çok firmalı ölçekte harcama özetinin ayrıntılı defter yerine günlük özetten okunması.
7. Sağlayıcının konsolunda aylık harcama sınırı (son savunma hattı; sahip kurar).

**Riskler:**
- Geçit tek arıza noktasıdır: düşerse bütün yapay zekâ durur (araçta geçici hata). Önlem: sağlık denetimi, `restart`; geri dönüş araçlarda `AI_GATEWAY_URL`'yi boşaltmak (DeciShip yerelde doğrudan, TagPress yapay zekâsız).
- Araç ile geçit arasına tampon yapan vekil girmez (araçlar iç adresten doğrudan bağlanır).
- SDK'nın `x-should-retry` davranışı sürümle değişebilir: `Platform/apps/ai-api/test/rejectNoRetry.test.ts` sabitler.
- İki defter (DeciShip TL, geçit USD) DS-AI-2'ye kadar ayrı tutulur.

## 8. Sorulmayan ince ayarlar

Tavanlar, eşikler, hız sınırları ve saklama süresi makul varsayılanla başladı (§5, **[V]**); KALANLAR "Yayından önce"de listeli, ortam ayarıyla ya da yönetici ekranından değişir.

## 9. Kullanıcı kararları

2026-11-21 (yaklaşım) ve 2026-11-23 (zamanlama); `Platform/docs/kararlar/firma-ve-merkez.md` "Yapay zekâ geçidi ve harcama".

1. **Yaklaşım:** merkezi geçit. **Zamanlama** (2026-11-23): şimdi kurulur; TagPress ve DeciShip ikisi de bağlanır (önceki "DeciShip oturduktan sonra" kalktı).
2. **Firmaya tutar TL olarak gösterilir**; firma sahibi ve yöneticisi kendi firmasının tutarını görür. Platform sahibinin ekranında TL ve USD. Defter USD tutar.
3. **Aylık hak tek ve ortaktır:** firmanın bütün araçlarda geçerli tek aylık hakkı geçitte tutulur; araç başına tavan yalnız koruma amaçlıdır; firma ekranı tek "kalan hak" gösterir, araç kırılımı altında. DeciShip'in araç içi hakkı geçide taşınacak (§7 madde 2).
4. **Silinen firmada** ayrıntılı çağrı kayıtları silinir; kişi ve firma adı içermeyen günlük özet kalır.
