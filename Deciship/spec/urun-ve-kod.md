# DeciShip SPEC — Ürün, roller, kod yerleşimi ve kalite çıtası (§1, §2, §9)

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir.

## Genel

- **Adlar, yollar ve JSON biçimleri bağlayıcıdır.** Belge kodla çelişirse kod okunur ve belge düzeltilir.
- **Kimlik, oturum, firma, üye, rol, abonelik:** `Platform/apps/account-api`; sözleşme `Platform/docs/ARCHITECTURE.md` §4–§6. DeciShip jetonu `@sellerondata/auth-kit` ile doğrular, üyeleri Hesap olaylarıyla kopyalar.
- **Adresler, depo yapısı, ortam değişkenleri, başlatma:** ARCHITECTURE §2–§3, `Platform/docs/KURULUM.md`, `Platform/BASLAT.bat`. API öneki `/api/deciship`, gateway `http://localhost:8088`.
- **Arayüz ve tasarım** (web D09 ortak kabuk, mobil D05): `Platform/docs/DESIGN.md`. Merkez uçları (`/platform/*`): ARCHITECTURE §7.

---

## 1. Ürün, roller ve kapsam

DeciShip, kolinin gerçek ölçüsünü ve ağırlığını paketleme anında telefonla kaydeder; kargo firmasının faturası gelince her satırı bu ölçümle ve sözleşme tarifesiyle karşılaştırır, fazla ödenen tutarı fatura bazlı raporlar.

Arayüz Türkçe ve İngilizce. Sayılar dile göre biçimlenir (TR: `1.184,00 ₺`, `4,02 kg`).

### Roller
Rol ve izin kaydı `Platform/packages/contracts/src/products.ts`'tedir (`catalog.ts` ondan türer). **Kod rol adına bakmaz, izin anahtarına bakar** (`can(req, 'deciship.…')`).

İzinler (hepsi `deciship.` önekli): `web.access`, `settings.manage`, `tariffs.view`, `tariffs.edit`, `invoices.upload`, `lines.decide`, `disputes.manage`, `invoices.view`, `reports.view`, `data.export`, `measurements.capture`, `measurements.view_all`, `measurements.manage`, `prices.view`.

| Rol | Kod | Ne yapar |
|---|---|---|
| Yönetici | `ADMIN` | Kurulum ve ayarlar dahil her şey |
| Denetleyici | `AUDITOR` | Tarife, fatura, fark kararı, ölçüm yönetimi; ayarlara ve itiraz gönderimine giremez |
| Muhasebe | `ACCOUNTING` | Fatura yükler, başlığını düzeltir (kararı verilmiş satırın tutarını değiştirmeyen düzeltme) ve siler (`invoices.upload`); fatura, tarife, rapor ve tüm ölçümleri görür, dışa aktarır; itirazı gönderir, sonucunu girer. Fark kararı, tarife düzenleme, taşıyıcı ve ayar yok |
| Ölçüm | `MEASURE` | Yalnız mobilde ölçüm (`measurements.capture`). Fiyat görmez, web paneline giremez |
| Erişim yok | rol `null` | Üye var, DeciShip erişimi yok |

- `deciship.prices.view` olmayan kişiye giden **hiçbir yanıtta para alanı bulunmaz** (`app.ts` `preSerialization` → `stripMoney`; testle doğrulanır).
- `deciship.web.access` olmayan kişi web paneline giremez.

### İş akışı
- **Mobil:** barkod okut → tartı (fotoğraftan yapay zekâ ya da elle) → ölçü (LiDAR, AR, referans kartı, hazır koli ya da elle) → fotoğraf → kaydet; internet yoksa kuyruğa girer (§6).
- **Web:** tarifeler (elle, Excel, PDF) → fatura yükleme (CSV/XLSX; PDF yapay zekâ ile) ve sütun eşleme → tarife + ölçüm ile karşılaştırma → fatura bazlı fark raporu (ekran, Excel, PDF) → itiraz metni ve takibi (§8).

**Kapsam dışı:** koli önerisi, Bluetooth terazi, haftalık yakıt tablosu.

---

## 2. Kod yerleşimi

- `packages/core`: saf TS alan mantığı.
- `apps/api`: Fastify + Prisma + PostgreSQL.
- `apps/web`: Vite + React.
- `apps/mobile`: Expo; yerel ölçüm modülü `modules/box-measure`.
- `services/vision`: Python FastAPI + OpenCV.
- `samples/`: örnek fatura, tarife, test fotoğrafı.
- Depo kuralları (workspaces yok, `file:` bağlantısı): ARCHITECTURE §2.

Kurallar:
- `@deciship/core` dışa aktarımları: `.`, `./calc`, `./barem`, `./format`, `./measure` (`measureInput.ts`), `./i18n`.
- `src/calc.ts` **bağımlılıksız** olmalı; mobil yalnız `calc`, `barem`, `measure` ve `i18n` kullanır (Metro `watchFolders`).
- DeciShip'e özgü ortam değişkenleri: `apps/api/src/env.ts` → `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (varsayılan `claude-sonnet-5-5`), `VISION_URL`, `STORAGE_DIR`, `ENABLE_DATA_RESET`; `apps/api/src/services/fx.ts` → `FX_TIMEOUT_MS`, `FX_PREFETCH_BUDGET_MS`. Açıklamaları KURULUM.md.

---

## 9. Kalite çıtası

- **core:** vitest; wiki örnekleri (#5305 ölçü farkı +458,50 ₺ senaryosu dahil), her kural, yuvarlama sınırları, Türkçe sayı/tarih okuma, her taşıyıcı kalıbının örnek dosyayla eşlemesi.
- **api:** vitest + gerçek PostgreSQL (docker) entegrasyon testleri:
  - izin denetimi (`web.access` olmayan web'e giremez, `prices.view` olmayan para alanı görmez),
  - firma yalıtımı (RLS),
  - Hesap olaylarının işlenmesi,
  - ölçüm idempotency ve sürümleme,
  - fatura yükleme → karşılaştırma uçtan uca (`samples/` dosyalarıyla),
  - rapor dosyalarının üretilmesi.
- **web:** `tsc --noEmit` + `vite build` temiz; Playwright ile uçtan uca duman testi (`apps/web/e2e`: tarife → fatura yükle → fark gör → Excel indir). Platform geneli uçtan uca testler: KURULUM.md "Uçtan uca testler".
- **mobile:** `tsc --noEmit` temiz; Android emülatörde derlenip çalışır (dev build); ekran görüntüleriyle doğrulama.
- **vision:** pytest sentetik doğruluk testleri.
- Kod: TypeScript strict; anlamlı adlar; gereksiz yorum yok; gizli anahtar koda yazılmaz.
