# Kod haritası — TagPress

Yollar depo köküne göredir. TagPress'in kendi kuralları `Tagpress/CLAUDE.md`, yön `Tagpress/YOL-HARITASI.md`; testler kök `CLAUDE.md` "Testler". İki kip aynı kodla çalışır: platform (`TAGPRESS_AUTH=platform`, Postgres, Hesap jetonu) ve yerel (`local`, SQLite, girişsiz; `pnpm dev`/`pnpm start` `--yerel` ile).

## TagPress

### Sunucu (`Tagpress/apps/server/src`)

| Şunu değiştireceksen | Şu dosyalara bak |
|---|---|
| Kip, ortam değişkenleri, açılış | `config.ts` (`TAGPRESS_AUTH`, platformda eksik değişken), `main.ts` (`--yerel`), `app.ts` (yerel güvenlik kancası yalnız yerel kipte, platformda `rewriteUrl` `/api/tagpress/<yol>` → `/api/<yol>`) |
| Yeni uç ya da uç izni | `features/route-map.ts` (her uç `read`/`write`/`spend`/`manage`; tablosuz uç testte kırılır), `features/gate.ts` (`permissionFor`: read → `tagpress.web.access`, write → `work.edit`, spend → `ai.use` + `work.edit`, manage → `settings.manage`); kayıt `Platform/packages/contracts/src/products.ts` |
| Firma bağlamı, kapalı firma, JIT firma | `org/resolver.ts` (`PlatformOrgResolver`), `org/platform-service.ts` (`ensureSeeded`: yeni firmaya varsayılan içerik), `org/context.ts`, `org/access.ts`, `org/seed.ts` |
| Hesap olayları, kalıcı silme | `platform/identity.ts` (product-kit `registerProductIdentity`, `purge.orgColumn: 'org_id'`, `onPurged` firma klasörünü siler), `org/tables.ts` (`PG_PURGE_TABLES` silme sırası); canlı akışların kapanması `platform/live-streams.ts` |
| Merkez uçları (`/api/tagpress/platform/*`) | `platform/hub/` (`overview.ts`, `analytics.ts`, `datasets.ts`, `activity.ts`, `sql.ts`, `time.ts`); gerçek yanıt kaydı `platform/hub/hubWebFixtures.test.ts` → `Platform/apps/hub-web/e2e/fixtures/tagpress-real/`; etiketler `i18n/` |
| Veritabanı arayüzü (iki lehçe) | `org/tenant-db.ts` (`TenantDbLike`, `$org`/`$member` bağlama, `dialectSql`), `db/factory.ts` (`createDatabase`), `db/database.ts` (SQLite) |
| Postgres köprüsü ve lehçe | `db/pg/bridge.ts` + `worker.ts` (senkron köprü, tek bağlantı), `db/pg/pg-tenant-db.ts`, `db/pg/dialect.ts` (`?`/adlı parametre → `$n`, `LIKE` → `ILIKE`; tanımadığı SQLite işlevine hata); mekanik olmayan SQL servisin içinde `dialectSql({ sqlite, pg })` |
| Şema, göç | SQLite `db/migrations/NNNN-*.ts` + `index.ts`; Postgres `db/pg/migrations/NNNN-*.sql` + `db/pg/migrate.ts` (giriş `bin/migrate-pg.ts`), haklar `db/pg/grants.ts`. Yeni sütun iki yere de yazılır; şema eşliği testi `db/pg/schema.pg.test.ts` |
| Yapay zekâ çağrıları | `adapters/ai.ts` (kipe göre istemci), `adapters/ai-gateway.ts` (geçit bağlamı, `withAiJob`, kalan hak önbelleği), `services/key-guard.ts`, `services/secrets.ts` (yalnız yerel kip), `services/costs.ts` (`ai_calls`), `services/builder/budget.ts`; istemciler `Tagpress/packages/ai/src/{claude,gemini,gateway}.ts`; fiyat ve amaçlar `Tagpress/packages/domain/src/ai.ts` |
| Aktarım (SQLite → Postgres) | `bin/aktar-pg.ts`, `aktar/` (`source.ts` salt okunur kopya, `target.ts`, `transfer.ts` tek işlem, `files.ts`); sarmalayıcı `Platform/scripts/tagpress-aktar.ps1` |
| Hata kodları | `Tagpress/docs/sunucu-kodlari.md` (üretici `Tagpress/scripts/sunucu-kodlari.ts`); platform kipi auth-kit kodlarını olduğu gibi döner |

Servis ve rotalar: `services/**`, `routes/**` (iş kuralı bugünkü gibi; SQL'e dokununca iki veritabanında da test).

### Web (`Tagpress/apps/web/src`)

| Şunu değiştireceksen | Şu dosyalara bak |
|---|---|
| Kipler ve giriş | `main.tsx` (platform), `yerel.tsx` (yerel, eski üst satır), `vite.config.ts` (`VITE_TAGPRESS_PLATFORM=1`: taban `/tagpress/`, `dedupe`, geliştirme vekilleri), `Tagpress/apps/web/scripts/platform.mjs` (`build:platform`, `dev:platform`) |
| İstekler, hata davranışı | `lib/api.ts` (platformda `/api/tagpress`, `X-SOD-CSRF`, firma başlığı; yerelde `/api`, `X-Studio`), `oturum/` (`istemci.ts` kabuğun oturum istemcisi, `hatalar.ts`: 401 yenile, 403 `NO_PRODUCT_ACCESS`, 409 `ORG_CLOSED`/`ORG_MISMATCH`), `lib/sse.ts`, `lib/liveSync.ts` |
| Yetkiye göre görünürlük | `lib/access.ts` (`access.edit/spend/manage` → düğmeler, Ayarlar bölümleri, tutarlar) |
| Kabuk ve iş satırı | `oturum/Kabuk.tsx` (`AppShell workspace`, `column`), `tezgah/cerceve/` (yerel üst satır, ortak çerçeve) |
| Yerleşim, dar ekran, "Kurulum · Eksik" | ekran türü `lib/route.ts` `screenKind`; bağlam ve tablet çekmecesi `tezgah/cerceve/duzen.ts`; telefon notu `cerceve.tsx` `NarrowNote` + `rotalar.tsx` `screenFor`; menü öğesi kuralı `lib/setupMenu.ts`; kurallar `Tagpress/ARAYUZ-PLANI.md` "Yerleşim" |
| Belirteçler | `Platform/packages/tokens/tokens.json` `surfaces.tagpressWeb` → üretilen `tezgah/tokens.generated.css`; `tezgah/tokens.css` yalnız yerel kipte `base` kopyası (`tezgah/tokens.test.ts`) |
| Üretim ekranı, yükleme, gömülü düzenleme | `ekranlar/uretim/` (`index.tsx`, `Izgara.tsx` üç bölüm, `IsPaneli.tsx` sağ panel, `Alim.tsx`; dosya → üretimsiz kayıt `mantik/yukle.ts`); küçük tezgâh ve büyük pencere `ekranlar/duzelt/gomulu.tsx` (`HizliDuzelt`, `DuzeltPenceresi`; ortak gövde `Calisma.tsx`, veri `useDuzeltModel.ts`), pencere bileşeni `tezgah/katman/WorkDialog.tsx`; sayfa şablonu yapışma ve ortalama `ekranlar/baski/mantik/sablon/{yapisma,yerlesim}.ts` |
| Ekranlar ve metin | `ekranlar/<ekran>/`, temel bileşenler `tezgah/` (kullanım notu `tezgah/OKU.md`); sözlük `locales/{tr,en}/`, sunucu kodlarının metni `i18n/sunucu.ts` |

### Platform tarafında TagPress'e dokunan yerler

- Kayıt `Platform/packages/contracts/src/products.ts` (izinler, roller, `hub`, `deploy`, `ai`) → `npm run products:gen` (`Platform/gateway/conf/products/tagpress.conf`, `init.sql`/`upgrade.sql`).
- Compose `tagpress-migrate`, `tagpress-api`, `tagpress-web`, `tagpress-aktar` (`tools`), hacim `sod_tagpress_storage`; imajlar `Tagpress/apps/server/Dockerfile`, `Tagpress/apps/web/Dockerfile` + `nginx.conf`.
- Merkez sahte API kayıttan kurar (kayıt `hub-web/e2e/fixtures/tagpress-real/`); demo rolleri `Platform/apps/account-api/src/seed.ts`, `Platform/packages/shell/src/mock/seed.ts`; e2e `Platform/e2e/lib/products.ts` `TOOLS.tagpress`, `Platform/e2e/tests/47-tagpress.spec.ts`.
- Bant ve yüzey `Platform/packages/tokens/tokens.json` `bands.tagpress`, `surfaces.tagpressWeb`; kabuk `AppShell` `workspace`, `BandSize 'work'` (`Platform/packages/shell/src/headSlot.ts`).

### Testler

| Değişen | Test |
|---|---|
| Sunucu (her değişiklik) | `Tagpress` içinde `pnpm test` (SQLite) ve `pnpm test:pg` (Postgres: rota ve servis testleri + iki firma takımı `apps/server/src/test/two-orgs.ts`, `*.pg.test.ts`); tek dosya `pnpm vitest run <dosya>`, Postgres'te `pnpm vitest run --config vitest.pg.config.ts <dosya>` |
| Uç tablosu, izin | `apps/server/src/platform/platform-mode.test.ts`, `platform.pg.test.ts`, `r1.pg.test.ts` |
| Merkez uçları | `apps/server/src/platform/hub/` (`hub.test.ts`, `routes.test.ts`, `hubWebFixtures.test.ts`; kaydı bilerek yenilemek `-u`), sonra Merkez `npm test` (`test/hub-providers.test.mjs`) |
| Köprü, lehçe, şema | `apps/server/src/db/pg/{bridge,schema}.pg.test.ts`, `dialect.test.ts`, `apps/server/src/db/migrations.test.ts` |
| Aktarım | `apps/server/src/aktar/transfer.pg.test.ts`, `source.test.ts` |
| Yapay zekâ | `apps/server/src/adapters/ai-gateway.test.ts`, `apps/server/src/platform/ai.pg.test.ts`, `Tagpress/packages/ai/src/gateway.test.ts` |
| Web | `pnpm test` (web dahil), `node apps/web/scripts/check-i18n.mjs --strict`, `pnpm typecheck`; iki yapı `pnpm --filter @tagpress/web build` ve `build:platform` |

Kökten parçalar: `tagpress` (hızlı), `tagpress-db` (Postgres, `pnpm test:pg`), `tc:tp-*` (tip), `tp-web-i18n`.
