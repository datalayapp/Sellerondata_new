# Merkez (hub-web)

React 19, Vite, react-router, TanStack Query. Geliştirme portu 5180. Kabuk `packages/shell`.

Sistemin tamamı `Platform\BASLAT.bat` ile açılır: gateway `http://localhost:8088`, tanıtım sitesi `8089` (ayrıntı `Platform/docs/KURULUM.md`). `npm run dev` yalnız bu uygulamayı Vite ile açar; vekil hedefleri `ACCOUNT_PROXY_TARGET` (varsayılan `http://localhost:4100`) ve `API_PROXY_TARGET` (varsayılan `http://localhost:4000`) ile değişir. Gateway üzerinden denemek için bu değişkenleri `http://localhost:8088` yapın.

```
npm install
npm run dev:mock     # VITE_MOCK=1: sahte API + geçici /deciship taslağı
npm run dev          # gerçek servislere vekil: /api/account → :4100, /api → :4000
npm run build        # tsc --noEmit -p tsconfig.build.json && vite build
npm run typecheck    # tsc --noEmit
npm run test:e2e     # Playwright, mock üzerinde
npm run test:prod     # node e2e/prod/run.mjs
npm run screens      # screenshots/ altına 1440, 1024, 390 (TR, EN)
```

## Mock modu

Yalnız `import.meta.env.DEV && VITE_MOCK === '1'`. Dinamik içe aktarılır, üretim paketine girmez. Veri açıkça örnektir ve arayüzde "Örnek veri" etiketi görünür.

Şifre hepsinde `Test12345!`:

| Giriş | Rol |
|---|---|
| `sahip@ornek.test` | Sahip + DeciShip Yönetici, iki firma |
| `yonetici@ornek.test` | Firma yöneticisi + Denetleyici |
| `denetci@ornek.test` | Çalışan + Denetleyici |
| `muhasebe@ornek.test` | Çalışan + Muhasebe |
| `0532 000 00 04` | Çalışan + Ölçüm (sade Merkez) |
| `erisimsiz@ornek.test` | Çalışan, araç rolü yok |
| `yeni@ornek.test` | Yeni firma, kurulum bitmemiş |
| `firmasiz@ornek.test` | Hiç firması yok: tam ekran "Firma oluştur" |

`/join` için: telefon `0532 000 00 11`, kod `K7M2QX9P`. `/invite/ornek-davet` e-posta daveti.

Test kancaları (`localStorage`): `sod_mock_fail` (uç adları JSON dizisi: `deciship.overview`, `deciship.analytics`, `deciship.activity`, `team.patch`), `sod_mock_expire` (`TOKEN_EXPIRED` veya `TOKEN_STALE`), `sod_mock_fast`, `sod_mock_register_closed`.

## Hesap API

Yanıt şekilleri `apps/account-api/src/routes` ile hizalıdır (`src/api/types.ts`). Mock da aynı şekli döner.

## DeciShip `platform/*`

Mock (`src/mocks/deciship.ts`) gerçek uçların (`Deciship/apps/api/src/services/hub`) yanıt şeklini ve etiketlerini (`deciship-labels.json`) birebir izler; sayılar örnek veri kümesinden hesaplanır. `test/deciship-contract.test.mjs` (`npm test`, tarayıcısız) mock'u gerçek yanıt kaydı `e2e/fixtures/deciship-real/*.json` ile karşılaştırır: KPI, bekleyen, widget, kolon, süzgeç, veri seti, bağlantı biçimi ve alan adı/türü (kökteki `scripts/lib/shape.mjs`) sapınca kırılır.

Kaydı DeciShip API veritabanı testi `Deciship/apps/api/test/hub/hubWebFixtures.test.ts` üretir ve denetler: DeciShip Merkez uçları değişince orada kırılır; bilerek yenileme `Deciship/apps/api` içinde `npx vitest run test/hub/hubWebFixtures.test.ts -u`, sonra burada `npm test`.

- `GET /org/audit` eylemi kod olarak döner; metin `activity.actions.*` çevirisinden, kişi adı üyelik listesinden gelir.
- `RESET_CODE_NOT_ALLOWED` `details.reason` taşır (`NOT_ACTIVE`, `HAS_EMAIL`, `MULTIPLE_ORGS`); nedeni arayüz yazar.
- Davet bağlantısı ve kod yalnız üretildiği yanıtta gelir. Listeden okunmaz; "Yeniden gönder" yenisini üretir.
- Ürün süzgeçleri `filter.<id>=değer`, çoklu seçimde tekrar eder. Analiz karşılaştırması `compare=previous`. DeciShip `platform/*` uçları bunlara uymalı.

Oturum dayanıklılığı test kancaları: `sod_mock_offline` (ağ hatası), `sod_mock_account_down` (Hesap kesik, ağ geçidi 503), `sod_mock_refresh_down` (yenileme 503), `sod_mock_no_refresh` (yenileme kesin 401), `sod_mock_verify_required` (202 ve doğrulanmamış giriş), `sod_mock_mail_limited` (`mailSent: false`), `sod_mock_fail` içinde `me`, `transfer.email`, `invite.exhausted`, `invite.limit`. Kullanıcılar: `0532 000 00 07` tek firmadan fazla, e-postasız (`passwordRecovery: 'none'`). Tohum `@sellerondata/shell/mock-seed` içinde.
