/**
 * Kimlik: jeton doğrulama auth-kit'te, burada yalnız yerel izdüşüm (Company, Member) ve olaylar var.
 * Sözleşme: ARCHITECTURE §5. Şifre, kullanıcı adı, rol yönetimi Hesap'tadır.
 *
 * Özel roller: `Member.permissions` rolle birlikte, aynı epoch koşuluyla yazılır. Olay ya da jeton izin
 * listesi taşıyorsa o (auth-kit katalogla kesiştirmiştir), taşımıyorsa NULL: rolden katalogla türet (`lib/access.ts`
 * `memberPermissions`). Rol ile liste hiç ayrı yazılmaz: eski rolün listesi yeni rolde kalmasın. Rolün izinleri Hesap'ta
 * değişince üyenin epoch'u artar: eski jeton 401 TOKEN_STALE alır, imzalı dosya bağlantısı düşer, olay yeni listeyi yazar.
 * Sütun TEXT[] NULL; Prisma liste alanında NULL ile boş listeyi ayırmaz (şemada `String[]`): yazma ham SQL ile, Prisma ile hiç.
 *
 * Firmayı kapatma: `org.closed` firmayı kapalı işaretler (`Company.closedAt`), `org.reopened` işareti
 * kaldırır; ikisi `closedVersion` sırasıyla (eşit ya da küçük sürüm uygulanmaz). Kapalı firmada her uç 409 ORG_CLOSED döner
 * (auth-kit `orgClosed`), arka plan işleri firmayı atlar. `org.purged` silme kaydını (`CompanyPurge`) yazar, silme commit'ten
 * sonra başlar (`services/companyPurge.ts`). Silme kaydı olan firmaya sonra gelen hiçbir olay yazılmaz, JIT firmayı açmaz.
 * Bir firmanın olayları, JIT'i ve silmesi firma kilidiyle sıralanır (`lockCompanyEvents`).
 */
import { registerEventReceiver, registerProductAuth, type MemberProjection, type ProductAuthContext } from '@sellerondata/auth-kit';
import { isOrgTimeZone, type PlatformEvent } from '@sellerondata/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import { prisma, runInCompany, setTxCompany, withCompany, withEventScope, type Tx } from './db.ts';
import { env } from './env.ts';
import { AppError } from './errors.ts';
import { m } from './i18n/index.ts';
import { DEFAULT_BOX_PRESETS, DEFAULT_SETTINGS, defaultAmountTol, readSettings } from './lib/settings.ts';
import { isCompanyPurged, lockCompanyEvents, startCompanyPurge } from './services/companyPurge.ts';

export type IdentityOptions = { jwksUrl?: string; fetch?: typeof fetch };

const projection = { select: { epoch: true, active: true } } as const;

/** Yerel kayda yazılan izin listesi: jeton taşıyorsa geçerli izinler (katalogla kesişmiş), eski biçim jetonda null. */
const tokenPermissions = (auth: ProductAuthContext): string[] | null => (auth.permissionsSource === 'token' ? [...auth.permissions] : null);

/**
 * Yeni firmayı varsayılan ayar ve kolilerle açar. Yarış güvenli: `ON CONFLICT DO NOTHING`, satırı ilk ekleyen işlem
 * kolileri de ekler, bekleyen işlem onun commit'inden sonra `count: 0` alır. Çağıran işlemde firma bağlamı olmalı.
 * Yeni satır Merkez onayı beklerken açılır (`companyConfirmed: false`): olay sırası garantisizdir, JIT ya da `member.*` olayı
 * `org.updated`'dan önce gelirse yeni firma onaylı görünmesin. Onayı yalnız `org.updated` yazar. Var olan satıra dokunulmaz.
 */
async function ensureCompany(tx: Tx, companyId: string, name: string, nameVersion?: number) {
  const created = await tx.company.createMany({
    data: [{ id: companyId, name, nameVersion, settings: { ...DEFAULT_SETTINGS, companyConfirmed: false } }],
    skipDuplicates: true,
  });
  if (created.count === 1) {
    await tx.boxPreset.createMany({ data: DEFAULT_BOX_PRESETS.map((p) => ({ ...p, companyId })) });
  }
}

/** JIT: tanınmayan üye. Aynı anda gelen istekler ve olaylarla çakışabilir. Var olan kaydın epoch'una dokunmaz. */
async function provisionMember(auth: ProductAuthContext): Promise<MemberProjection> {
  const member = await prisma.$transaction(async (tx): Promise<MemberProjection | null> => {
    // Kalıcı silinen ya da kapalı firmada üye kaydı açılmaz (Hesap kapalı firmaya ürün erişimi vermez; bu çift güvencedir).
    await lockCompanyEvents(tx, auth.orgId);
    if (await isCompanyPurged(tx, auth.orgId)) return { epoch: 0, active: false, orgClosed: true };
    const existing = await tx.company.findFirst({ where: { id: auth.orgId }, select: { closedAt: true } });
    if (existing?.closedAt) return { epoch: auth.epoch, active: false, orgClosed: true };
    await ensureCompany(tx, auth.orgId, auth.orgName ?? '');
    const created = await tx.member.createMany({
      data: [
        {
          id: auth.membershipId,
          companyId: auth.orgId,
          personId: auth.personId,
          name: auth.name,
          role: auth.productRole,
          active: true,
          epoch: auth.epoch,
        },
      ],
      skipDuplicates: true,
    });
    // Satırı bu işlem açtıysa izin listesi de yazılır; var olan kayda (olay ya da başka JIT) dokunulmaz.
    const permissions = tokenPermissions(auth);
    if (created.count === 1 && permissions) {
      await tx.$executeRaw`UPDATE "Member" SET "permissions" = ${permissions}::text[] WHERE "id" = ${auth.membershipId} AND "companyId" = ${auth.orgId}`;
    }
    return tx.member.findFirst({ where: { id: auth.membershipId, companyId: auth.orgId }, ...projection });
  });
  // Yalnız aynı üyelik kimliği başka firmada kayıtlıysa olur. Hesap bunu üretmez; bağlam dışında satır açılmaz.
  if (!member) throw new AppError(401, 'UNAUTHORIZED', m('err.membershipConflict'));
  return member;
}

/**
 * Jeton yerel kayıttan yeni: olay gecikmiş ya da hiç gelmedi (DEAD). Koşullu güncelleme: eş zamanlı yeni olayı geri almaz.
 * `active` da yazılır (KALANLAR 6.10): Hesap jetonu yalnız etkin (`ACTIVE`) üyeliğe ve o anki epoch'la basar (`buildAccessPayload`),
 * her askı ve çıkarma epoch'u artırır. Yerel kayıttan büyük epoch'lu jeton, yerel pasifliği yazan olaydan sonraki etkin hali kanıtlar:
 * askıdan dönüş olayı kaybolsa da çalışan bir sonraki jetonla döner. Eşit epoch'lu jeton (askıyı yazan olayla aynı an) bu yola girmez,
 * pasif kalır; sonra gelen askı olayı (daha büyük epoch) yine kapatır, eski jeton `TOKEN_STALE` alır. Rol ve izinlerle aynı güven.
 * Bilinçli kabul (KARARLAR "Firma kapatma ve silme" altı, üyelik eşitlemesi): askıdan dönüş olayı gelmeden yeni askı olayı da gecikirse
 * arada basılmış jeton en çok jeton ömrü (10 dk) erişim verir; olaylar sırayla gelseydi de aynı olurdu.
 * Çıkarma kalıcıdır: `member.removed` ile yazılmış kayda (`removedAt`) eşitleme hiç dokunmaz, jeton kaç olursa olsun pasif kalır
 * (Hesap üyelik kimliğini yeniden kullanmaz; yedekten geri yükleme ya da tohum daha büyük epoch'lu jeton bassa da açılmaz).
 */
async function syncMember(auth: ProductAuthContext): Promise<MemberProjection | void> {
  await prisma.$executeRaw`
    UPDATE "Member"
    SET "epoch" = ${auth.epoch}, "role" = ${auth.productRole}, "permissions" = ${tokenPermissions(auth)}::text[],
        "name" = ${auth.name}, "personId" = ${auth.personId}, "active" = true, "updatedAt" = now()
    WHERE "id" = ${auth.membershipId} AND "epoch" < ${auth.epoch} AND "removedAt" IS NULL`;
  return (await prisma.member.findFirst({ where: { id: auth.membershipId }, ...projection })) ?? undefined;
}

async function loadMember(membershipId: string, orgId: string, orgName: string | null): Promise<MemberProjection | null> {
  const member = await prisma.member.findFirst({
    where: { id: membershipId, companyId: orgId },
    select: { epoch: true, active: true, company: { select: { name: true, closedAt: true } } },
  });
  // Firmayı olay açtıysa adı henüz yoktur (`member.*` olayı ad taşımaz). `org.updated` beklenirken jetondan doldurulur.
  if (member && !member.company.name && orgName) {
    await prisma.company.updateMany({ where: { id: orgId, name: '' }, data: { name: orgName } });
  }
  return member && { epoch: member.epoch, active: member.active, ...(member.company.closedAt ? { orgClosed: true } : {}) };
}

/** `event.epoch < yerel` auth-kit'te elenir. Koşul burada da var: iki olay aynı anda okuyup yazmasın. */
async function applyMemberEvent(
  tx: Tx,
  event: { orgId: string; membershipId: string; epoch: number },
  fields: { personId?: string; name?: string; role: string | null; permissions: readonly string[] | null; active: boolean; removed?: boolean },
) {
  const removedAt = fields.removed ? new Date() : null;
  await tx.member.createMany({
    data: [
      {
        id: event.membershipId,
        companyId: event.orgId,
        personId: fields.personId ?? '',
        name: fields.name ?? '',
        role: fields.role,
        active: fields.active,
        epoch: event.epoch,
        removedAt,
      },
    ],
    skipDuplicates: true,
  });
  // Rol, izin listesi ve askı aynı koşulla birlikte: eski olay yenisini ezmez. Ad ve kişi alanı olayda yoksa eskisi kalır.
  // Çıkarma işareti (`removedAt`) yalnız yazılır, hiç boşalmaz: çıkarılmış kaydı jeton açmaz (`syncMember`).
  await tx.$executeRaw`
    UPDATE "Member"
    SET "epoch" = ${event.epoch}, "role" = ${fields.role}, "permissions" = ${fields.permissions ? [...fields.permissions] : null}::text[],
        "active" = ${fields.active}, "name" = COALESCE(${fields.name ?? null}::text, "name"),
        "personId" = COALESCE(${fields.personId ?? null}::text, "personId"),
        "removedAt" = CASE WHEN ${fields.removed === true} THEN COALESCE("removedAt", now()) ELSE "removedAt" END, "updatedAt" = now()
    WHERE "id" = ${event.membershipId} AND "epoch" <= ${event.epoch}`;
}

/** Sözleşmede isteğe bağlı, yalnız TRY, USD, EUR ya da GBP. Alıcıda biçim denetimi olmadığı için burada süzülür: gerisi yok sayılır. */
function eventCurrency(event: PlatformEvent): 'TRY' | 'USD' | 'EUR' | 'GBP' | null {
  const raw = (event as { currency?: unknown }).currency;
  return raw === 'TRY' || raw === 'USD' || raw === 'EUR' || raw === 'GBP' ? raw : null;
}

/**
 * Firma para biriminin tek kaynağı Merkez: yeni kayıtların varsayılanı olur. Var olan faturanın para birimi ve tutarı değişmez.
 * Tutar toleransı eski para biriminin varsayılanındaysa (`defaultAmountTol`) yeninin varsayılanına geçer; kullanıcı elle
 * başka bir değer yazdıysa dokunulmaz (varsayılanla aynı sayıyı elle yazmak ayırt edilemez, varsayılan sayılır). Eski faturalar
 * kendi `compareSettings`'iyle kalır, "Ayar değişti" der (SPEC §3.14). Çağıran işlem firma satırını kilitlemiştir.
 */
async function applyOrgCurrency(tx: Tx, orgId: string, currency: string) {
  const company = await tx.company.findFirst({ where: { id: orgId }, select: { settings: true } });
  const raw = company?.settings && typeof company.settings === 'object' && !Array.isArray(company.settings) ? (company.settings as Record<string, unknown>) : {};
  const prev = readSettings(raw);
  const followDefault =
    typeof raw.amountTol === 'number' && prev.currency.toUpperCase() !== currency && Math.abs(raw.amountTol - defaultAmountTol(prev.currency)) < 1e-9;
  // kayıtlı tolerans yoksa yazılmaz: `readSettings` yeni para biriminin varsayılanını zaten verir
  const patch = followDefault ? { currency, amountTol: defaultAmountTol(currency) } : { currency };
  await tx.$executeRaw`
    UPDATE "Company"
    SET "settings" = COALESCE("settings", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE "id" = ${orgId}`;
}

/** Sözleşmede isteğe bağlı, ISO-2. Para birimi gibi burada süzülür: bozuk değer yok sayılır, ad ve para birimi yine işlenir. */
function eventCountry(event: PlatformEvent): string | null {
  const raw = (event as { country?: unknown }).country;
  return typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) ? raw : null;
}

/** Firma ülkesinin tek kaynağı Merkez: Türk Ticaret Kanunu süresi buna bağlıdır (`firmCountry`). */
async function applyOrgCountry(tx: Tx, orgId: string, country: string) {
  await tx.$executeRaw`
    UPDATE "Company"
    SET "settings" = COALESCE("settings", '{}'::jsonb) || jsonb_build_object('country', ${country}::text)
    WHERE "id" = ${orgId}`;
}

/**
 * Sözleşmede isteğe bağlı, yalnız `TIME_ZONES`'tan (contracts). Para birimi gibi burada süzülür: listede olmayan ya da bozuk değer
 * yok sayılır, ad ve diğer alanlar yine işlenir. Alan yoksa (eski biçim olay ya da Hesap'ın varsayılanı söylemediği yeniden duyuru)
 * kayıtlı değere dokunulmaz.
 */
function eventTimeZone(event: PlatformEvent): string | null {
  const raw = (event as { timeZone?: unknown }).timeZone;
  return isOrgTimeZone(raw) ? raw : null;
}

/**
 * Firma saat diliminin tek kaynağı Merkez (Mesaj 15 §4.1). Faturanın hesap dayanağına girmez (SPEC §3.14): dondurulmuş sonuçlar
 * değişmez, eski faturalar yeniden hesaplanmaz. Çağıran işlem firma satırını kilitlemiştir.
 */
async function applyOrgTimeZone(tx: Tx, orgId: string, timeZone: string) {
  await tx.$executeRaw`
    UPDATE "Company"
    SET "settings" = COALESCE("settings", '{}'::jsonb) || jsonb_build_object('timeZone', ${timeZone}::text)
    WHERE "id" = ${orgId}`;
}

/** Sözleşmede isteğe bağlı, yalnız `true` ya da `false`. Bozuk değer yok sayılır; alan yoksa (eski biçim olay) kayıtlı değere dokunulmaz. */
function eventCompanyConfirmed(event: PlatformEvent): boolean | null {
  const raw = (event as { companyConfirmed?: unknown }).companyConfirmed;
  return typeof raw === 'boolean' ? raw : null;
}

/** Firma bilgilerinin Merkez onayı (`companyConfirmedOf`): DeciShip kurulumu buna bağlıdır. Çağıran işlem firma satırını kilitlemiştir. */
async function applyOrgCompanyConfirmed(tx: Tx, orgId: string, confirmed: boolean) {
  await tx.$executeRaw`
    UPDATE "Company"
    SET "settings" = COALESCE("settings", '{}'::jsonb) || jsonb_build_object('companyConfirmed', ${confirmed}::boolean)
    WHERE "id" = ${orgId}`;
}

/** Olay işleminin commit'inden sonra çalışacak işler (`registerIdentity` `transaction`). */
const afterCommitStore = new AsyncLocalStorage<(() => void)[]>();
const afterCommit = (job: () => void) => {
  const jobs = afterCommitStore.getStore();
  if (!jobs) throw new Error('identity: afterCommit called outside the event transaction');
  jobs.push(job);
};

type IdentityLog = { warn: (obj: unknown, msg: string) => void; error?: (obj: unknown, msg: string) => void };

/**
 * Kapatma ve geri açma: `closedVersion < olay` koşuluyla (sözleşme: eşit ya da küçük sürüm uygulanmaz; auth-kit küçüğü zaten
 * `stale` sayar). Satır yoksa önce açılır: sırası bozuk gelen üye olayı kapalı firmayı açık kurmasın, gecikmiş eski kapatma da
 * geri açılmış firmayı kapatmasın. Çağıran firma satırını kilitlemiştir (`currentVersion`).
 */
async function applyClosedState(tx: Tx, orgId: string, version: number, closedAt: Date | null) {
  await ensureCompany(tx, orgId, '');
  await tx.company.updateMany({
    where: { id: orgId, OR: [{ closedVersion: null }, { closedVersion: { lt: version } }] },
    data: { closedAt, closedVersion: version },
  });
}

async function onEvent(tx: Tx, event: PlatformEvent, log: IdentityLog) {
  // Firma kilidi `eventContext`te alındı: silme kaydı yazan işlemle aynı anda gelen olay, kaydı commit'ten sonra görür.
  if (await isCompanyPurged(tx, event.orgId)) {
    // Kalıcı silinen firma yeniden kurulmaz. Silme olayı tekrar geldiyse yarıda kalmış silme yeniden denenir (zararsız).
    if (event.type === 'org.purged') afterCommit(() => startCompanyPurge(event.orgId, log));
    return;
  }
  switch (event.type) {
    case 'member.upserted':
      await ensureCompany(tx, event.orgId, '');
      // İzin listesi auth-kit'te katalogla kesişmiştir; eski biçim olayda ve rolsüz olayda yoktur (NULL: rolden türet).
      await applyMemberEvent(tx, event, {
        personId: event.personId,
        name: event.name,
        role: event.role,
        permissions: event.role ? (event.permissions ?? null) : null,
        active: event.active,
      });
      break;
    case 'member.removed':
      // Tanınmayan üye için de pasif kayıt açılır: geç gelen eski jeton JIT ile üyeyi yeniden açamasın.
      await ensureCompany(tx, event.orgId, '');
      await applyMemberEvent(tx, event, { personId: event.personId, name: event.name, role: null, permissions: null, active: false, removed: true });
      break;
    case 'org.updated':
      await ensureCompany(tx, event.orgId, event.name, event.version);
      // Satırı kilitleyen koşullu güncelleme: paralel ya da gecikmiş eski olay yeni adı ezmez. Sürümsüz olay sıralanamaz:
      // yalnız hiç sürümlü ad yazılmadıysa uygulanır.
      {
        const applied = await tx.company.updateMany({
          where: {
            id: event.orgId,
            OR: event.version === undefined ? [{ nameVersion: null }] : [{ nameVersion: null }, { nameVersion: { lte: event.version } }],
          },
          data: { name: event.name, ...(event.version === undefined ? {} : { nameVersion: event.version }) },
        });
        // Aynı koşuldan geçen olay yazar: eski olay yeni değeri ezmez. Satır bu işlemde kilitli.
        const currency = eventCurrency(event);
        if (applied.count && currency) await applyOrgCurrency(tx, event.orgId, currency);
        const country = eventCountry(event);
        if (applied.count && country) await applyOrgCountry(tx, event.orgId, country);
        const timeZone = eventTimeZone(event);
        if (applied.count && timeZone) await applyOrgTimeZone(tx, event.orgId, timeZone);
        const confirmed = eventCompanyConfirmed(event);
        if (applied.count && confirmed !== null) await applyOrgCompanyConfirmed(tx, event.orgId, confirmed);
      }
      break;
    case 'org.closed': {
      // Sözleşmede ISO an (auth-kit biçimi denetler); yine de okunamazsa şimdiki an: kapalılık kaybolmasın.
      const at = new Date(event.closedAt);
      await applyClosedState(tx, event.orgId, event.version, Number.isFinite(at.getTime()) ? at : new Date());
      break;
    }
    case 'org.reopened':
      await applyClosedState(tx, event.orgId, event.version, null);
      break;
    case 'org.purged':
      // Son olay, sürümsüz: her durumda uygulanır. Kayıt silmenin tek tetikleyicisidir; firma bu andan kapalıdır.
      await tx.companyPurge.createMany({ data: [{ companyId: event.orgId }], skipDuplicates: true });
      await tx.company.updateMany({ where: { id: event.orgId, closedAt: null }, data: { closedAt: new Date() } });
      afterCommit(() => startCompanyPurge(event.orgId, log));
      break;
    case 'subscription.updated':
      // Abonelik durumu jetonla gelir (READ_ONLY denetimi auth-kit'te). Yerelde satır yok, sırası bozulacak durum da yok.
      break;
  }
}

export function registerIdentity(app: FastifyInstance, opts: IdentityOptions = {}) {
  registerProductAuth(app, {
    product: 'deciship',
    jwksUrl: opts.jwksUrl ?? env.accountJwksUrl,
    fetch: opts.fetch,
    allowedOrigins: env.allowedOrigins,
    onJwksError: (err) => app.log.warn({ err }, 'Hesap anahtarları alınamadı'),
    // Üye okuma ve açma `runInContext`ten önce çalışır: FORCE RLS altında kendi bağlamları gerekir.
    withOrgContext: (orgId, work) => withCompany(orgId, work),
    loadMember: (membershipId, claims) => loadMember(membershipId, claims.org!, claims.orgName),
    provisionMember: ({ auth }) => provisionMember(auth),
    syncMember: ({ auth }) => syncMember(auth),
    runInContext: (auth, next) => {
      // İş kodunun adları: Merkez servisleri `req.auth.companyId` ve `userId` okur.
      Object.assign(auth, { companyId: auth.orgId, userId: auth.membershipId });
      runInCompany(auth.orgId, next);
    },
  });

  registerEventReceiver<Tx>(app, {
    product: 'deciship',
    // Dar kapı: bağlamı olmayan işlem yalnız ProcessedEvent'i görür. Firma, olay çözülünce `eventContext` ile açılır.
    // Commit'ten sonraki işler (kalıcı silme) işlem geri alınırsa çalışmaz.
    transaction: async (work) => {
      const jobs: (() => void)[] = [];
      const result = await afterCommitStore.run(jobs, () => withEventScope(() => prisma.$transaction(work)));
      for (const job of jobs) job();
      return result;
    },
    // Firma kilidi işlemin ilk kilidi: satır kilitleri (`memberEpoch`, `currentVersion`) ondan sonra. Kalıcı silme ve JIT de
    // önce bu kilidi alır; sıra hep aynı, kilitlenme (deadlock) olmaz.
    eventContext: async (tx, event) => {
      await setTxCompany(tx, event.orgId);
      await lockCompanyEvents(tx, event.orgId);
    },
    claimEvent: async (tx, eventId) => {
      const r = await tx.processedEvent.createMany({ data: [{ eventId }], skipDuplicates: true });
      return r.count === 1;
    },
    // Satır kilidi: eşzamanlı rol değişimi ve askı sırayla işlenir, son yazan eski olay olamaz.
    memberEpoch: async (tx, membershipId) => {
      const rows = await tx.$queryRaw<{ epoch: number }[]>`SELECT "epoch" FROM "Member" WHERE "id" = ${membershipId} FOR UPDATE`;
      return rows[0]?.epoch ?? null;
    },
    currentVersion: async (tx, event) => {
      if (event.type === 'org.closed' || event.type === 'org.reopened') {
        const rows = await tx.$queryRaw<{ closedVersion: number | null }[]>`SELECT "closedVersion" FROM "Company" WHERE "id" = ${event.orgId} FOR UPDATE`;
        return rows[0]?.closedVersion ?? null;
      }
      // Abonelik yerelde tutulmaz (jetonla gelir), sıralanacak durum yok.
      if (event.type !== 'org.updated') return null;
      const rows = await tx.$queryRaw<{ nameVersion: number | null }[]>`SELECT "nameVersion" FROM "Company" WHERE "id" = ${event.orgId} FOR UPDATE`;
      return rows[0]?.nameVersion ?? null;
    },
    onEvent: (tx, event) => onEvent(tx, event, app.log),
  });
}
