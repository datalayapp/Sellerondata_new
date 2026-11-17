# @sellerondata/auth-kit

Ürün API'leri (Fastify) için kimlik paketi. Sözleşme: `Platform/docs/ARCHITECTURE.md` §5.

Ürün jetonu Hesap'a sormadan doğrular. Yetki rol adıyla değil izin anahtarıyla denetlenir. Hata gövdeleri `{ error: { code, message } }`, `message` `Accept-Language`'a göre TR/EN gelir. Yanıtı kancanın kendisi gönderir, uygulamanın hata işleyicisine bağlı değildir.

## Kurulum

`package.json`:

```json
"@sellerondata/auth-kit": "file:../../../Platform/packages/auth-kit",
"@sellerondata/contracts": "file:../../../Platform/packages/contracts"
```

`file:` bağlantısı paketin kendi bağımlılıklarını kurmaz: önce `npm --prefix Platform/packages/auth-kit install`. Paket TS kaynak olarak gelir; `tsup`ta `noExternal: [/^@sellerondata\//]` verin. Docker'da `@deciship/core` kalıbı geçerlidir: paketin `node_modules` klasörünü API'ninkine bağlayın ve `jose`yi API bağımlılığına da ekleyin.

## Kimlik doğrulama

```ts
import { registerProductAuth } from '@sellerondata/auth-kit';

registerProductAuth(app, {
  product: 'deciship',
  jwksUrl: process.env.ACCOUNT_JWKS_URL!,        // http://account-api:4100/api/account/.well-known/jwks.json
  allowedOrigins: ['https://app.sellerondata.com'],

  // Üç üye kancasının etrafında çalışır. RLS varsa zorunlu: `runInContext` bu aşamada henüz çalışmadı,
  // bağlamsız okuma satır göremez ve geçerli üye 403 NO_PRODUCT_ACCESS alır. Aşağıda "RLS".
  withOrgContext: (orgId, work) => withCompany(orgId, work),

  // Her istekte çağrılır. Yoksa null.
  loadMember: (mid) => db.member.findFirst({ where: { id: mid }, select: { epoch: true, active: true } }),

  // JIT: tanınmayan üye. Yalnız ekler, var olana dokunmaz, satırı YENİDEN OKUYUP döner.
  // Üzerine yazan upsert, araya giren member.removed sonrası çıkarılan üyeyi geri açar.
  provisionMember: async ({ auth }) => {
    await db.member.createMany({ data: [toRow(auth)], skipDuplicates: true });          // ON CONFLICT DO NOTHING
    return db.member.findFirstOrThrow({ where: { id: auth.membershipId }, select: { epoch: true, active: true } });
  },

  // ep > Member.epoch: olay gecikmiş. Yalnız daha eski kaydı günceller, satırı YENİDEN OKUYUP döner.
  // Koşulsuz yazmak araya giren yeni iptali geri alır.
  syncMember: async ({ auth }) => {
    await db.member.updateMany({
      where: { id: auth.membershipId, epoch: { lt: auth.epoch } },                       // WHERE epoch < $jeton
      data: { epoch: auth.epoch, role: auth.productRole, name: auth.name, active: true },
    });
    return db.member.findFirstOrThrow({ where: { id: auth.membershipId }, select: { epoch: true, active: true } });
  },

  // İstek bağlamı (RLS). `done` bu bağlamın içinde çağrılır, işleyici de içinde çalışır.
  runInContext: (auth, next) => requestStore.run({ companyId: auth.orgId }, next),
});

// `onRequest` kullanın. `preHandler` gövde şemasından sonra çalışır: kimliksiz istek 400 ile alan adlarını öğrenir.
app.get('/api/deciship/invoices', { onRequest: app.requirePermission('deciship.invoices.view') }, handler);
app.post('/api/deciship/invoices', { onRequest: app.requirePermission('deciship.invoices.upload') }, handler);
app.get('/api/deciship/me', { onRequest: app.authenticate }, (req) => req.auth);
```

`req.auth`: `{ personId, membershipId, orgId, orgName, orgRole, productRole, subscription, permissions, name, locale, sessionId, epoch }`. `permissions` dondurulmuştur.

### Varsayılan reddet

Kanca verilmeyen rota açıktır. Tek tek hatırlamaya güvenmeyin:

```ts
await app.register(async (api) => {
  api.addHook('onRequest', app.authenticate);       // kapsamdaki her rota kimlik ister
  api.get('/invoices', { onRequest: app.requirePermission('deciship.invoices.view') }, handler);
}, { prefix: '/api/deciship' });
// Kapsam dışında yalnız bilinçli olanlar: /health, /internal/events (imzalı).
```

Ürün testi şart: tüm rotaları gezen, izinli açık yol listesi dışındaki her rotanın kimliksiz `401` döndüğünü doğrulayan test (`onRoute` kancasıyla toplayın).

- `GET`, `HEAD`, `OPTIONS` CSRF ve READ_ONLY denetiminden geçmez. Bu yöntemlerde durum değiştirmeyin; `app.all` ve `method: ['GET', 'POST']` kullanmayın.
- Kanca olarak verin. İşleyici içinden elle çağırmayın.

### Denetim sırası

| Durum | Yanıt |
|---|---|
| Jeton yok, geçersiz imza, yanlış `aud`/`iss`, aynı adlı birden çok `sod_at` | `401 UNAUTHORIZED` |
| Süresi dolmuş | `401 TOKEN_EXPIRED` (istemci yeniler) |
| Çerezli yazma, `X-SOD-CSRF: 1` veya izinli `Origin` yok | `403 CSRF_FAILED` |
| Anahtar doğrulanamıyor (aşağıda JWKS) | `503 AUTH_UNAVAILABLE` (istemci oturumu kapatmaz) |
| `org` null | `403 ORG_REQUIRED` |
| Çerezli yazma, `X-SOD-Org` yok veya jetondaki `org` değil | `409 ORG_MISMATCH` (istemci sayfayı yeniler, otomatik yeniden denemez) |
| `prod[ürün]` yok, `ep < Member.epoch` | `401 TOKEN_STALE` (rol geri verilmiş: istemci yeniler, 10 dk beklemez) |
| `prod[ürün]` yok, üye yok veya epoch güncel | `403 NO_PRODUCT_ACCESS`, `details.refreshable: true` (rol yeni verilmiş veya olay gecikmiş olabilir: istemci bir kez sessizce yeniler, yine aynıysa gösterir) |
| `ep > Member.epoch` | `syncMember` çalışır, dönen kayıtla sürer |
| `ep < Member.epoch` (eşitlemeden sonra da) | `401 TOKEN_STALE` (istemci yeniler) |
| Yerel kayıt pasif (jeton kaç olursa olsun) | `403 FORBIDDEN` |
| İzin yok (`requirePermission`) | `403 FORBIDDEN` |
| Yazma ve abonelik `ACTIVE` değil | `403 READ_ONLY` |

- `Authorization` başlığı varsa yalnız ona bakılır, çereze düşmez. Bearer isteklerinde CSRF ve `X-SOD-Org` gerekmez.
- `authenticate` izin denetlemez ama READ_ONLY denetler.
- Durum değiştirmeyen POST (POST ile sorgu): rotada `config: { readOnlyExempt: true }`. Zincirdeki tüm kancalarda geçerlidir. `requirePermission(p, { readOnlyExempt: true })` yalnız o kancayı etkiler, önünde `authenticate` varsa yetmez.
- Tüm yanıtlara `Cache-Control: no-store` yazılır. Rota kendi başlığını koyabilir.
- `runInContext` fırlatırsa uygulamanın hata işleyicisine gider (500), istek asılı kalmaz.

### JWKS önbelleği

| Durum | Davranış |
|---|---|
| Bilinen `kid`, önbellek 1 saatten genç | Önbellekten. 10 dakikayı geçtiyse arkada tazelenir. Hesap kesikken de çalışır. |
| Bilinen `kid`, önbellek 1 saatten yaşlı (`maxStaleMs`) | Tazelenir; tazelenemezse `503`. İptal edilen anahtar Hesap kesikken süresiz geçerli kalmaz. Hesap kesikken yeni jeton basılamadığından (ömür 10 dk) bu pencere açık oturumları düşürmez. |
| Bilinmeyen `kid` | Hemen getirilir. Listede yoksa `401`. |
| Bilinmeyen `kid`, 1 sn içinde başarılı getirme oldu (`cooldownMs`) | `401`, Hesap yorulmaz. Sahte `kid` yeni anahtarın önünü kapatmaz: istemci yeniler. |
| Son getirme başarısız, 5 sn dolmadı (`failureBackoffMs`) | Bilinmeyen `kid` `503`. |
| Listede bozuk anahtar | Yalnız o atlanır. Boş liste, bozuk gövde, HTTP hatası önbelleği bozmaz. Yönlendirme izlenmez. |
| Listeden çıkan anahtar | Bir sonraki başarılı tazelemede düşer. |
| **Ürün Hesap kesikken yeniden başlarsa** | Önbellek boştur: Hesap dönene kadar tüm kimlikli istekler `503`. Yeniden başlatmayı Hesap kesintisiyle çakıştırmayın. |

## RLS

`FORCE ROW LEVEL SECURITY` altında bağlamsız sorgu sıfır satır görür ve hata vermez. Üç yerde bağlam kurun:

```ts
// 1. Üye kancaları ve 2. işleyici: işlem açıp firmayı ayarlayan sarmal
const withCompany = <T>(orgId: string, work: () => Promise<T>) =>
  store.run({ companyId: orgId }, () => work());   // istemci eklentisi her işlemde: SELECT set_config('app.company_id', $1, true)  (SET LOCAL)

// 3. Olay yolu: `eventContext`, aynı işlemde
eventContext: (tx, event) => tx.$executeRaw`SELECT set_config('app.company_id', ${event.orgId}, true)`,
```

`set_config(..., true)` `SET LOCAL` eşdeğeridir, parametre alır, işlem bitince düşer.

## Olay alıcısı

```ts
import { registerEventReceiver } from '@sellerondata/auth-kit';

registerEventReceiver(app, {
  product: 'deciship',                        // yol: POST /api/deciship/internal/events
  transaction: (work) => prisma.$transaction(work),

  // İşlemin ilk adımı. RLS varsa zorunlu: yoksa memberEpoch satır göremez, null döner, bayatlık denetimi atlanır,
  // güncelleme sıfır satıra yazar ve olay "işlendi" sayılıp iptal kaybolur.
  eventContext: (tx, event) => tx.$executeRaw`SELECT set_config('app.company_id', ${event.orgId}, true)`,

  claimEvent: async (tx, eventId) => {
    const r = await tx.processedEvent.createMany({ data: [{ eventId }], skipDuplicates: true });
    return r.count === 1;
  },

  // SATIRI KİLİTLEYEREK okuyun. Düz okumada eşzamanlı ep6 ve ep7 ikisi de eski değeri görür,
  // son yazan ep6 ise askı kaybolur.
  memberEpoch: async (tx, mid) =>
    (await tx.$queryRaw`SELECT epoch FROM deciship."Member" WHERE id = ${mid} FOR UPDATE`)[0]?.epoch ?? null,

  // İsteğe bağlı: org.updated ve subscription.updated için sıra koruması. Satırı kilitleyerek okuyun.
  currentVersion: async (tx, event) =>
    (await tx.$queryRaw`SELECT "nameVersion" FROM deciship."Company" WHERE id = ${event.orgId} FOR UPDATE`)[0]?.nameVersion ?? null,

  // Üye olayı: satır yokken FOR UPDATE koruyamaz, koşullu ekleyin.
  onEvent: async (tx, event, meta) => {
    // INSERT ... ON CONFLICT (id) DO UPDATE SET epoch = EXCLUDED.epoch, active = EXCLUDED.active, ...
    //   WHERE "Member".epoch <= EXCLUDED.epoch
  },
});
```

`registerProductAuth`tan sonra çağrılırsa aynı JWKS önbelleğini kullanır; yoksa `jwksUrl` verin.

Doğrulama: imza, `iss`, `aud: product-events` (erişim jetonu olay yerine geçmez), `exp`, `jti == eventId`, `event.product == product`, alan şekli (`epoch`, `membershipId`, `orgId` eksikse `400`). Gövde 16 KB ile sınırlı. Gateway bu yolu dışarı kapatır, yol kodlanarak (`%69nternal`) gelse de imzasız hiçbir şey işlenmez. Adımlar tek işlemdedir: `eventContext` → `claimEvent` → epoch veya sürüm denetimi → `onEvent`. İşlenemeyen olay geri alınır, dağıtıcı yeniden dener. Yanıt `{ ok, outcome: 'processed' | 'duplicate' | 'stale' | 'ignored' }`.

- `event.epoch < yerel epoch` uygulanmaz, eşit olan uygulanır (ad değişikliği epoch artırmaz).
- `event.version < yerel sürüm` uygulanmaz (`currentVersion` verildiyse). `meta.occurredAt` olayın yazıldığı andır; sıra için sürümü kullanın.
- `member.removed` tanınmayan üye için de pasif kayıt açmalı (`personId`, `name` olayda gelir), yoksa geç gelen eski jeton JIT ile üyeyi yeniden açar. Kayıt `active: false` ve `epoch` taşımalı.
- `ProcessedEvent` en az 10 dakika saklanmalı (olay jetonu ömrü + saat payı).
- Dağıtıcı aynı üyenin olaylarını bir kopya içinde sıralı gönderir. Bu ek güvencedir: birden çok kopya veya yeniden deneme yine yarışabilir, satır kilidi şarttır.

## Test

```ts
import { createTestAuthority, runEpochRaceCheck, TEST_ORIGIN } from '@sellerondata/auth-kit/testing';

const authority = await createTestAuthority();
registerProductAuth(app, { product: 'deciship', ...authority.authOptions, allowedOrigins: [TEST_ORIGIN], loadMember });

const token = await authority.accessToken({ role: 'AUDITOR', orgId: 'org-a', membershipId: 'm-1', epoch: 2 });
await app.inject({ url: '/x', headers: authority.bearer(token) });
await app.inject({ method: 'POST', url: '/x', headers: authority.cookie(token, { write: true }) });
```

| Yardımcı | İşi |
|---|---|
| `accessToken({ role, orgId, membershipId, epoch, status, prod, expiresInSeconds, audience, issuer, foreignKey, kid, ... })` | Jeton basar. `role: null` ürün yok, `orgId: null` firma yok. |
| `eventToken(event, { audience, foreignKey, expiresInSeconds, jti })` | Olay jetonu |
| `rotateKey({ dropPrevious })`, `setOffline(bool)`, `fetchCount()` | Döndürme ve kesinti benzetimi |
| `bearer(token)`, `cookie(token, { write, origin })` | İstek başlıkları |
| `runEpochRaceCheck({ app, authority, orgId, seedMember, readMember, rounds })` | Alıcı sözleşmesi testi. ep6 ve ep7 aynı anda iner; `wrong > 0` ise alıcı kilitlemiyordur. **Gerçek veritabanıyla** çalıştırın, sahte işlem yarışı gösteremez. |

`auth-kit/testing` `NODE_ENV=production` iken içe aktarılamaz, fırlatır.

Paketin kendi testleri (`test/eventRace.db.test.ts`) compose Postgres'i ister (5434, `sod_deciship` rolü).
