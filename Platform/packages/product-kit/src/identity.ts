import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import {
  registerEventReceiver,
  registerProductAuth,
  resolveProductDefinition,
  type MemberProjection,
  type ProductAuthContext,
} from '@sellerondata/auth-kit';
import { isOrgTimeZone, type PlatformEvent, type ProductEntry } from '@sellerondata/contracts';
import { setTxOrg, sqlIdent, withEventScope, withMaintenanceScope, withOrg, type SqlDb } from './db.ts';
import { readOrgProfile, type OrgProfile } from './org.ts';
import { checkProjectionGrants, type GrantIssue } from './grants.ts';
import { PROCESSED_EVENT_TTL_MS } from './projection.ts';
import {
  createOrgPurge,
  type OrgPurge,
  type PurgeConfig,
  type PurgeOptions,
  type PurgeResult,
  type PurgeRunOptions,
  type PurgeTableIssue,
} from './purge.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** `registerProductIdentity` ekler: firmanın yerel kaydı (saat dilimi, Merkez onayı). Merkez çatısı okur. */
    productKitOrg: (orgId: string) => Promise<OrgProfile | null>;
  }
}

/**
 * Kimlik ve üye izdüşümü: auth-kit'in jeton doğrulaması + olay alıcısı, `memberProjectionSql` tablolarına yazan hazır
 * kancalarla. Koşullu yazma kuralları DeciShip `apps/api/src/identity.ts` ile aynıdır (ARCHITECTURE §5, §6):
 * - JIT yalnız ekler (`ON CONFLICT DO NOTHING`) ve satırı yeniden okur: araya giren `member.removed` geri açılmaz.
 * - Jeton yerelden yeniyse eşitleme `WHERE epoch < $jeton` ile yazar ve üyeyi etkin yazar (askıdan dönüş olayı kaybolsa da çalışan
 *   döner); `member.removed` ile çıkarılmış kayda (`removedAt`) hiç dokunmaz: çıkarma kalıcıdır.
 * - Üye olayı satırı `FOR UPDATE` ile kilitler, `epoch <= olay` koşuluyla yazar; eski olay yenisini ezmez.
 * - Firma adı `nameVersion` sırasıyla; sürümsüz olay yalnız hiç sürümlü ad yazılmadıysa. Para birimi, ülke, saat dilimi
 *   (`TIME_ZONES`) ve Merkez onayı (`companyConfirmed`) aynı koşulla; alan yoksa ya da bozuksa kayıtlı değer kalır.
 * - Yeni firma satırı Merkez onayı beklerken açılır (`companyConfirmed = false`); onayı yalnız `org.updated` yazar.
 * - `Member.permissions` rolle birlikte yazılır: olay ya da jeton izin listesi taşıyorsa o (auth-kit katalogla kesiştirmiştir),
 *   taşımıyorsa null (rolden türet). Rol ile izin listesi hiç ayrı yazılmaz: eski rolün listesi yeni rolde kalmasın.
 * Olay işlemi önce yalnız `ProcessedEvent`'i görür (`app.scope = 'events'`), firma olay çözülünce açılır.
 *
 * Firmayı kapatma (DeciShip `apps/api/src/identity.ts` ile aynı kurallar):
 * - `org.closed` / `org.reopened`: `Company.closedAt` yazılır / boşalır, `closedVersion < olay` koşuluyla (eşit ya da küçük sürüm
 *   uygulanmaz; satır yoksa açılır). Kapalı firmada her uç 409 ORG_CLOSED (auth-kit `orgClosed`), JIT üye açmaz. Aracın arka plan
 *   işleri `isOrgClosed` ile firmayı atlar.
 * - `org.purged`: olay işlemi yalnız `CompanyPurge` kaydını yazar ve firmayı kapalı işaretler; silme commit'ten sonra parça parça
 *   başlar, yarıda kalırsa bakım yeniden dener (`purge.ts`). Kaydı olan firmaya sonra gelen hiçbir olay yazılmaz, JIT firmayı
 *   açmaz; tekrar gelen silme olayı yarım silmeyi yeniden başlatır (zararsız).
 * - Bir firmanın olayları, JIT'i ve silme parçaları firma kilidiyle sıralanır (işlemin ilk kilidi; satır kilitleri ondan sonra).
 */
export type ProductIdentityOptions = {
  /** Kayıt anahtarı. */
  product: string;
  /** Yalnız test fikstürü; yoksa `PRODUCTS[product]`. `NODE_ENV` `test` değilse açılış durur (auth-kit `resolveProductDefinition`). */
  definition?: Pick<ProductEntry, 'key' | 'roles'> & Partial<Pick<ProductEntry, 'permissions'>>;
  db: SqlDb;
  /** `memberProjectionSql` ile kurulan şema; genellikle aracın anahtarı. */
  schema: string;
  jwksUrl: string;
  fetch?: typeof fetch;
  /** Çerezli yazma isteklerinde kabul edilen `Origin` değerleri. */
  allowedOrigins: ReadonlySet<string> | readonly string[];
  /** Olay yolu. Varsayılan `/api/<ürün>/internal/events`. */
  eventPath?: string;
  /*
   * Olay kancaları idempotent olmalı: aynı olay yeniden gelebilir. İşlenmiş olay kimliği 30 gün tutulur
   * (`PROCESSED_EVENT_TTL_DAYS`); sonra Hesap'ta `outbox-requeue` ile yeniden gönderilen olay tekrar işlenir. Sürüm koşulu
   * (`nameVersion`, `closedVersion`, üye `epoch`) eski olayı çoğunlukla eler, ama kanca aynı değeri iki kez yazmaya dayanmalı
   * (ör. eklemede `ON CONFLICT DO NOTHING`, sayaç artırmak yerine değer yazmak).
   */
  /** Yeni firma satırı ilk kez açıldığında, aynı işlemde (aracın varsayılanları; DeciShip'te koliler gibi). Firma bağlamı açıktır. */
  onCompanyCreated?: (tx: SqlDb, orgId: string) => Promise<void>;
  /** `org.updated` sürüm koşulundan geçip uygulandığında, aynı işlemde (ör. para birimine bağlı ayar). Firma satırı kilitlidir. */
  onOrgUpdated?: (tx: SqlDb, event: Extract<PlatformEvent, { type: 'org.updated' }>) => Promise<void>;
  /**
   * Firmanın kalıcı silinmesi (`org.purged`, `purge.ts`): aracın firma tabloları silme sırasıyla, dosya kancaları. Verilmezse
   * yalnız paketin satırları silinir (aracın firma tablosu varsa firma satırı yabancı anahtar yüzünden kalır ve silme bitmez).
   */
  purge?: PurgeConfig;
  /**
   * Bakım turunun aralığı, ms (varsayılan 1 saat): bitmemiş silmeler yeniden denenir, süresi dolan olay kimlikleri silinir.
   * 0: zamanlayıcı yok, araç `runPendingPurges` ve `cleanupProcessedEvents`'i kendi bakımından çağırır.
   */
  purgeRetryEveryMs?: number;
  /** İlk turun açılıştan sonraki gecikmesi, ms (varsayılan 60 sn; aralıktan büyükse aralık): yeniden başlatma turu ertelemesin. */
  purgeFirstRunMs?: number;
  onJwksError?: (err: unknown) => void;
};

/** `registerProductIdentity`'nin döndürdüğü tutamak: kalıcı silme ve bakım. */
export type ProductIdentity = {
  /** Firmayı kalıcı siler (silme kaydı yoksa hiçbir şey yapmaz); tekrar çağrılabilir, kaldığı yerden sürer. */
  purgeOrg(orgId: string, opts?: PurgeOptions): Promise<PurgeResult>;
  /** Bitmemiş silmeleri sürdürür; tamamlanan firma sayısı. Zamanlayıcı da bunu çağırır. */
  runPendingPurges(opts?: PurgeRunOptions): Promise<number>;
  /** Silme listesinin veritabanı kataloğuna göre sorunları (`PurgeTableIssue`). Aracın testi `[]` beklesin. */
  checkPurgeTables(): Promise<PurgeTableIssue[]>;
  /**
   * Uygulama rolünün şablon tablolarındaki hakları beklenenle aynı mı (`PROJECTION_TABLE_PRIVILEGES`, `grants.ts`); fazlası ya da
   * eksiği `GrantIssue`. Aracın testi `[]` beklesin: göçteki hak kayması (toplu GRANT, geri alınmamış varsayılan hak) görünür.
   */
  checkGrants(): Promise<GrantIssue[]>;
  /** Olay alıcısının arkada başlattığı silmelerin bitmesini bekler (testler; kapanışta kendiliğinden). */
  settlePurges(): Promise<void>;
  /**
   * `PROCESSED_EVENT_TTL_MS`'ten (30 gün) eski işlenmiş olay kimliklerini siler (bakım kapsamı; ilke de yalnız süresi dolanı
   * gösterir). Silinen sayı. Zamanlayıcı da bunu çağırır. `now`: testler için.
   */
  cleanupProcessedEvents(now?: number): Promise<number>;
};

/** Varsayılan yeniden deneme aralığı. */
export const PURGE_RETRY_EVERY_MS = 60 * 60_000;
/** İlk turun açılıştan sonraki varsayılan gecikmesi (DeciShip bakımı gibi). */
export const PURGE_FIRST_RUN_MS = 60_000;

type ProjectionRow = { epoch: number; active: boolean };

/** Son görülme en çok bu sıklıkla yazılır: her istekte satır güncellenmesin. */
const LAST_SEEN_EVERY = '1 hour';

export function registerProductIdentity(app: FastifyInstance, opts: ProductIdentityOptions): ProductIdentity {
  resolveProductDefinition(opts.product, opts.definition, 'registerProductIdentity');
  const s = sqlIdent(opts.schema, 'schema');
  const { db } = opts;
  const COMPANY = `${s}."Company"`;
  const MEMBER = `${s}."Member"`;
  const PROCESSED = `${s}."ProcessedEvent"`;
  const PURGE = `${s}."CompanyPurge"`;

  /** Firma kilidi: olay, JIT ve silme aynı firmada sırayla. Kilit adı şemayla: araçlar birbirini beklemez. */
  const lockOrg = (tx: SqlDb, orgId: string) => tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${opts.schema}:org-events:${orgId}`]);
  const isPurged = async (tx: SqlDb, orgId: string) => (await tx.query(`SELECT 1 FROM ${PURGE} WHERE "orgId" = $1`, [orgId])).length > 0;

  const purge: OrgPurge = createOrgPurge({ db, schema: opts.schema, config: opts.purge, lockOrg, log: app.log });
  /** Olay alıcısının başlattığı silmeler: kapanış ve testler bekleyebilsin. */
  const inflight = new Set<Promise<unknown>>();
  const startPurge = (orgId: string) => {
    const run: Promise<unknown> = purge
      .purgeOrg(orgId)
      .catch((err: unknown) => app.log.warn({ err, orgId }, 'product-kit purge failed; maintenance will retry'))
      .finally(() => inflight.delete(run));
    inflight.add(run);
  };
  const settlePurges = async () => {
    while (inflight.size) await Promise.allSettled([...inflight]);
  };
  const cleanupProcessedEvents = async (now = Date.now()) =>
    withMaintenanceScope(db, async (tx) => {
      const rows = await tx.query<{ n: number }>(
        `WITH gone AS (DELETE FROM ${PROCESSED} WHERE "processedAt" < $1 RETURNING 1) SELECT count(*)::int AS n FROM gone`,
        [new Date(now - PROCESSED_EVENT_TTL_MS)],
      );
      return rows[0]?.n ?? 0;
    });

  /** Olay işleminin commit'inden sonra çalışacak işler (`registerEventReceiver` `transaction`). Geri alınan işlemde çalışmaz. */
  const afterCommitStore = new AsyncLocalStorage<(() => void)[]>();
  const afterCommit = (job: () => void) => {
    const jobs = afterCommitStore.getStore();
    if (!jobs) throw new Error('product-kit: afterCommit olay işlemi dışında çağrıldı');
    jobs.push(job);
  };

  /** `withOrgContext` işleminin bağlantısı: auth-kit kancaları işlem nesnesi almaz. */
  const txStore = new AsyncLocalStorage<SqlDb>();
  const currentTx = (): SqlDb => {
    const tx = txStore.getStore();
    if (!tx) throw new Error('product-kit: üye kancası firma bağlamı dışında çağrıldı');
    return tx;
  };

  /**
   * Yarış güvenli: satırı ilk ekleyen işlem `onCompanyCreated`'ı da çalıştırır; bekleyen işlem 0 satır alır. Yeni satır Merkez
   * onayı beklerken açılır (`companyConfirmed` varsayılanı `false`); var olan satıra dokunulmaz.
   */
  async function ensureCompany(tx: SqlDb, orgId: string, name: string, nameVersion?: number): Promise<void> {
    const created = await tx.query(
      `INSERT INTO ${COMPANY} ("id", "name", "nameVersion") VALUES ($1, $2, $3) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
      [orgId, name, nameVersion ?? null],
    );
    if (created.length === 1 && opts.onCompanyCreated) await opts.onCompanyCreated(tx, orgId);
  }

  async function readProjection(tx: SqlDb, membershipId: string, orgId: string): Promise<ProjectionRow | null> {
    const rows = await tx.query<ProjectionRow>(`SELECT "epoch", "active" FROM ${MEMBER} WHERE "id" = $1 AND "orgId" = $2`, [membershipId, orgId]);
    return rows[0] ?? null;
  }

  async function loadMember(membershipId: string, orgId: string, orgName: string | null): Promise<MemberProjection | null> {
    const tx = currentTx();
    const rows = await tx.query<ProjectionRow & { companyName: string; closedAt: Date | null }>(
      `SELECT m."epoch", m."active", c."name" AS "companyName", c."closedAt" FROM ${MEMBER} m JOIN ${COMPANY} c ON c."id" = m."orgId"
       WHERE m."id" = $1 AND m."orgId" = $2`,
      [membershipId, orgId],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.closedAt) return { epoch: row.epoch, active: row.active, orgClosed: true };
    // Firmayı üye olayı açtıysa adı henüz yoktur (`member.*` ad taşımaz): `org.updated` beklenirken jetondan doldurulur.
    if (!row.companyName && orgName) await tx.query(`UPDATE ${COMPANY} SET "name" = $2 WHERE "id" = $1 AND "name" = ''`, [orgId, orgName]);
    if (row.active) {
      await tx.query(
        `UPDATE ${MEMBER} SET "lastSeenAt" = now() WHERE "id" = $1 AND ("lastSeenAt" IS NULL OR "lastSeenAt" < now() - interval '${LAST_SEEN_EVERY}')`,
        [membershipId],
      );
    }
    return { epoch: row.epoch, active: row.active };
  }

  async function provisionMember(auth: ProductAuthContext): Promise<MemberProjection> {
    const tx = currentTx();
    // Kalıcı silinen ya da kapalı firmada üye kaydı açılmaz (Hesap kapalı firmaya ürün erişimi vermez; bu çift güvencedir).
    await lockOrg(tx, auth.orgId);
    if (await isPurged(tx, auth.orgId)) return { epoch: 0, active: false, orgClosed: true };
    const company = await tx.query<{ closedAt: Date | null }>(`SELECT "closedAt" FROM ${COMPANY} WHERE "id" = $1`, [auth.orgId]);
    if (company[0]?.closedAt) return { epoch: auth.epoch, active: false, orgClosed: true };
    await ensureCompany(tx, auth.orgId, auth.orgName ?? '');
    await tx.query(
      `INSERT INTO ${MEMBER} ("id", "orgId", "personId", "name", "role", "permissions", "active", "epoch", "lastSeenAt")
       VALUES ($1, $2, $3, $4, $5, $6::text[], true, $7, now()) ON CONFLICT ("id") DO NOTHING`,
      [auth.membershipId, auth.orgId, auth.personId, auth.name, auth.productRole, storedPermissions(auth), auth.epoch],
    );
    // Satır yoksa aynı üyelik kimliği başka firmada kayıtlıdır (RLS gizler). Hesap bunu üretmez: pasif say, 403 FORBIDDEN.
    return (await readProjection(tx, auth.membershipId, auth.orgId)) ?? { epoch: 0, active: false };
  }

  /**
   * Jeton yerel kayıttan yeni (`ep > epoch`): olay gecikmiş ya da hiç gelmedi (DEAD). Kayıt jetondan eşitlenir, üye etkin de yazılır:
   * Hesap jetonu yalnız `ACTIVE` üyeliğe ve o anki epoch'la basar, her askı ve çıkarma epoch'u artırır; askıdan dönüş olayı kaybolsa da
   * çalışan bir sonraki jetonla döner. Eşit epoch'lu jeton bu yola girmez, sonra gelen askı olayı yine kapatır. Bilinçli kabul: dönüş
   * olayı gelmeden yeni askı olayı da gecikirse arada basılmış jeton en çok jeton ömrü kadar erişim verir. Çıkarma kalıcıdır:
   * `member.removed` ile yazılmış kayda (`removedAt`) dokunulmaz, jeton kaç olursa olsun pasif kalır (DeciShip `identity.ts` ile aynı).
   */
  async function syncMember(auth: ProductAuthContext): Promise<MemberProjection | void> {
    const tx = currentTx();
    await tx.query(
      `UPDATE ${MEMBER} SET "epoch" = $2, "role" = $3, "permissions" = $6::text[], "name" = $4, "personId" = $5, "active" = true
       WHERE "id" = $1 AND "epoch" < $2 AND "removedAt" IS NULL`,
      [auth.membershipId, auth.epoch, auth.productRole, auth.name, auth.personId, storedPermissions(auth)],
    );
    return (await readProjection(tx, auth.membershipId, auth.orgId)) ?? undefined;
  }

  /** Satır yoksa açar, varsa yalnız `epoch <= olay` ise yazar. Ad ve kişi alanı olayda yoksa eskisi kalır. */
  async function applyMemberEvent(
    tx: SqlDb,
    event: { orgId: string; membershipId: string; epoch: number },
    fields: { personId?: string; name?: string; role: string | null; permissions: readonly string[] | null; active: boolean; removed?: boolean },
  ): Promise<void> {
    // Çıkarma işareti (`removedAt`) yalnız `member.removed` yazar ve hiç boşalmaz: çıkarılmış kaydı jeton açmaz (`syncMember`).
    await tx.query(
      `INSERT INTO ${MEMBER} AS m ("id", "orgId", "personId", "name", "role", "permissions", "active", "epoch", "removedAt")
       VALUES ($1, $2, COALESCE($3::text, ''), COALESCE($4::text, ''), $5, $8::text[], $6, $7, CASE WHEN $9::boolean THEN now() END)
       ON CONFLICT ("id") DO UPDATE SET
         "removedAt" = CASE WHEN $9::boolean THEN COALESCE(m."removedAt", now()) ELSE m."removedAt" END,
         "epoch" = EXCLUDED."epoch",
         "role" = EXCLUDED."role",
         "permissions" = EXCLUDED."permissions",
         "active" = EXCLUDED."active",
         "personId" = CASE WHEN $3::text IS NULL THEN m."personId" ELSE EXCLUDED."personId" END,
         "name" = CASE WHEN $4::text IS NULL THEN m."name" ELSE EXCLUDED."name" END
       WHERE m."epoch" <= EXCLUDED."epoch"`,
      [event.membershipId, event.orgId, fields.personId ?? null, fields.name ?? null, fields.role, fields.active, event.epoch, fields.permissions ? [...fields.permissions] : null, fields.removed === true],
    );
  }

  /** Kapatma ve geri açma: `closedVersion < olay`. Satır yoksa açılır: sırası bozuk üye olayı kapalı firmayı açık kurmasın. */
  async function applyClosedState(tx: SqlDb, orgId: string, version: number, closedAt: string | null): Promise<void> {
    await ensureCompany(tx, orgId, '');
    await tx.query(
      `UPDATE ${COMPANY} SET "closedAt" = $2::timestamptz, "closedVersion" = $3 WHERE "id" = $1 AND ("closedVersion" IS NULL OR "closedVersion" < $3)`,
      [orgId, closedAt, version],
    );
  }

  async function onEvent(tx: SqlDb, event: PlatformEvent): Promise<void> {
    // Kalıcı silinen firma yeniden kurulmaz (firma kilidi `eventContext`te alındı). Silme olayı tekrar geldiyse yarıda kalmış
    // silme yeniden başlatılır (zararsız).
    if (await isPurged(tx, event.orgId)) {
      if (event.type === 'org.purged') afterCommit(() => startPurge(event.orgId));
      return;
    }
    switch (event.type) {
      case 'member.upserted':
        await ensureCompany(tx, event.orgId, '');
        // İzin listesi auth-kit'te katalogla kesişmiştir; rolsüz olayda ya da eski biçimde yoktur (null: rolden türet).
        await applyMemberEvent(tx, event, { personId: event.personId, name: event.name, role: event.role, permissions: event.role ? (event.permissions ?? null) : null, active: event.active });
        return;
      case 'member.removed':
        // Tanınmayan üye için de pasif kayıt açılır: geç gelen eski jeton JIT ile üyeyi yeniden açamasın.
        await ensureCompany(tx, event.orgId, '');
        await applyMemberEvent(tx, event, { personId: event.personId, name: event.name, role: null, permissions: null, active: false, removed: true });
        return;
      case 'org.updated': {
        await ensureCompany(tx, event.orgId, event.name, event.version);
        const applied = await tx.query(
          `UPDATE ${COMPANY} SET
             "name" = $2,
             "nameVersion" = COALESCE($3::integer, "nameVersion"),
             "currency" = COALESCE($4::text, "currency"),
             "country" = COALESCE($5::text, "country"),
             "timeZone" = COALESCE($6::text, "timeZone"),
             "companyConfirmed" = COALESCE($7::boolean, "companyConfirmed")
           WHERE "id" = $1 AND ("nameVersion" IS NULL OR ($3::integer IS NOT NULL AND "nameVersion" <= $3::integer))
           RETURNING "id"`,
          [event.orgId, event.name, event.version ?? null, eventCurrency(event), eventCountry(event), eventTimeZone(event), eventCompanyConfirmed(event)],
        );
        if (applied.length === 1 && opts.onOrgUpdated) await opts.onOrgUpdated(tx, event);
        return;
      }
      case 'org.closed': {
        // Sözleşmede ISO an (auth-kit biçimi denetler); okunamazsa şimdiki an: kapalılık kaybolmasın.
        const at = Number.isFinite(Date.parse(event.closedAt)) ? event.closedAt : new Date().toISOString();
        await applyClosedState(tx, event.orgId, event.version, at);
        return;
      }
      case 'org.reopened':
        await applyClosedState(tx, event.orgId, event.version, null);
        return;
      case 'org.purged':
        // Son olay, sürümsüz: her durumda uygulanır. Kayıt silmenin tek tetikleyicisidir; firma bu andan kapalıdır. Silmenin
        // kendisi commit'ten sonra, parça parça (büyük firmada olay işlemi uzamaz, zaman aşımıyla olay geri gelmez).
        await tx.query(`INSERT INTO ${PURGE} ("orgId") VALUES ($1) ON CONFLICT DO NOTHING`, [event.orgId]);
        await tx.query(`UPDATE ${COMPANY} SET "closedAt" = now() WHERE "id" = $1 AND "closedAt" IS NULL`, [event.orgId]);
        afterCommit(() => startPurge(event.orgId));
        return;
      case 'subscription.updated':
        // Abonelik durumu jetonla gelir (READ_ONLY denetimi auth-kit'te); yerelde satır yok, sıralanacak durum yok.
        return;
    }
  }

  registerProductAuth(app, {
    product: opts.product,
    ...(opts.definition ? { definition: opts.definition } : {}),
    jwksUrl: opts.jwksUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    allowedOrigins: [...opts.allowedOrigins],
    onJwksError: opts.onJwksError ?? ((err) => app.log.warn({ err }, 'product-kit: Hesap anahtarları alınamadı')),
    // Üye okuma ve açma `runInContext`ten önce çalışır: FORCE RLS altında kendi bağlamları gerekir.
    withOrgContext: (orgId, work) => withOrg(db, orgId, (tx) => txStore.run(tx, work)),
    loadMember: (membershipId, claims) => loadMember(membershipId, claims.org!, claims.orgName),
    provisionMember: ({ auth }) => provisionMember(auth),
    syncMember: ({ auth }) => syncMember(auth),
  });

  registerEventReceiver<SqlDb>(app, {
    product: opts.product,
    ...(opts.definition ? { definition: opts.definition } : {}),
    ...(opts.eventPath ? { path: opts.eventPath } : {}),
    // Commit'ten sonraki işler (kalıcı silme) işlem geri alınırsa çalışmaz.
    transaction: async (work) => {
      const jobs: (() => void)[] = [];
      const result = await afterCommitStore.run(jobs, () => withEventScope(db, work));
      for (const job of jobs) job();
      return result;
    },
    // Firma kilidi işlemin ilk kilidi: satır kilitleri (`memberEpoch`, `currentVersion`) ondan sonra, sıra hep aynı.
    eventContext: async (tx, event) => {
      await setTxOrg(tx, event.orgId);
      await lockOrg(tx, event.orgId);
    },
    claimEvent: async (tx, eventId) =>
      (await tx.query(`INSERT INTO ${PROCESSED} ("eventId") VALUES ($1) ON CONFLICT DO NOTHING RETURNING "eventId"`, [eventId])).length === 1,
    // Satır kilidi: eşzamanlı rol değişimi ve askı sırayla işlenir, son yazan eski olay olamaz.
    memberEpoch: async (tx, membershipId) =>
      (await tx.query<{ epoch: number }>(`SELECT "epoch" FROM ${MEMBER} WHERE "id" = $1 FOR UPDATE`, [membershipId]))[0]?.epoch ?? null,
    currentVersion: async (tx, event) => {
      if (event.type === 'org.closed' || event.type === 'org.reopened') {
        return (await tx.query<{ closedVersion: number | null }>(`SELECT "closedVersion" FROM ${COMPANY} WHERE "id" = $1 FOR UPDATE`, [event.orgId]))[0]?.closedVersion ?? null;
      }
      if (event.type !== 'org.updated') return null;
      return (await tx.query<{ nameVersion: number | null }>(`SELECT "nameVersion" FROM ${COMPANY} WHERE "id" = $1 FOR UPDATE`, [event.orgId]))[0]?.nameVersion ?? null;
    },
    onEvent,
  });

  app.decorate('productKitOrg', (orgId: string) => withOrg(db, orgId, (tx) => readOrgProfile(tx, opts.schema, orgId)));

  // Bakım turu: bitmemiş silmeler (olay alıcısının silmesi yarıda kaldıysa), sonra süresi dolan olay kimlikleri. İlk tur açılıştan
  // kısa süre sonra, sonra aralıkla. Biri düşerse öteki yine çalışır. Zamanlayıcı süreci açık tutmaz; kapanışta yeni tur
  // başlamaz, süren tur ve olay alıcısının silmeleri beklenir.
  const every = opts.purgeRetryEveryMs ?? PURGE_RETRY_EVERY_MS;
  const timers: NodeJS.Timeout[] = [];
  let closing = false;
  let tour: Promise<void> | null = null;
  const tick = () => {
    if (closing || tour) return;
    tour = (async () => {
      await purge.runPendingPurges().catch((err: unknown) => app.log.warn({ err }, 'product-kit: pending purges failed'));
      if (closing) return;
      await cleanupProcessedEvents().catch((err: unknown) => app.log.warn({ err }, 'product-kit: processed event cleanup failed'));
    })().finally(() => {
      tour = null;
    });
  };
  if (every > 0) {
    app.addHook('onReady', async () => {
      const first = setTimeout(() => {
        tick();
        if (closing) return;
        const repeat = setInterval(tick, every);
        repeat.unref();
        timers.push(repeat);
      }, Math.min(opts.purgeFirstRunMs ?? PURGE_FIRST_RUN_MS, every));
      first.unref();
      timers.push(first);
    });
  }
  app.addHook('onClose', async () => {
    closing = true;
    for (const t of timers) clearTimeout(t);
    if (tour) await tour;
    await settlePurges();
  });

  return { ...purge, settlePurges, cleanupProcessedEvents, checkGrants: () => checkProjectionGrants(db, opts.schema) };
}

/**
 * Firma kapalı mı (ya da kalıcı silinmiş mi): aracın arka plan işleri (kuyruk, hatırlatma, tarama) kapalı firmayı atlar.
 * Firma bağlamında çağrılır (`withOrg`); satır yoksa (hiç görülmemiş firma) açık sayılır, silme kaydı varsa kapalı.
 */
export async function isOrgClosed(tx: SqlDb, schema: string, orgId: string): Promise<boolean> {
  const s = sqlIdent(schema, 'schema');
  const rows = await tx.query<{ closed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${s}."Company" WHERE "id" = $1 AND "closedAt" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM ${s}."CompanyPurge" WHERE "orgId" = $1) AS "closed"`,
    [orgId],
  );
  return rows[0]?.closed === true;
}

/** Yerel kayda yazılan izin listesi: jeton taşıyorsa geçerli izinler (katalogla kesişmiş), eski biçim jetonda null (rolden türet). */
function storedPermissions(auth: ProductAuthContext): string[] | null {
  return auth.permissionsSource === 'token' ? [...auth.permissions] : null;
}

/** Sözleşmede isteğe bağlı; yalnız bilinen para birimleri, gerisi yok sayılır (DeciShip ile aynı süzgeç). */
function eventCurrency(event: PlatformEvent): string | null {
  const raw = (event as { currency?: unknown }).currency;
  return raw === 'TRY' || raw === 'USD' || raw === 'EUR' || raw === 'GBP' ? raw : null;
}

/** Yalnız `TIME_ZONES`'tan (contracts); listede olmayan ya da bozuk değer yok sayılır (DeciShip ile aynı süzgeç). */
function eventTimeZone(event: PlatformEvent): string | null {
  const raw = (event as { timeZone?: unknown }).timeZone;
  return isOrgTimeZone(raw) ? raw : null;
}

/** Yalnız `true` ya da `false`; bozuk değer ve eski biçim olay (alan yok) kayıtlı değere dokunmaz. */
function eventCompanyConfirmed(event: PlatformEvent): boolean | null {
  const raw = (event as { companyConfirmed?: unknown }).companyConfirmed;
  return typeof raw === 'boolean' ? raw : null;
}

/** ISO-2; bozuk değer yok sayılır, ad ve para birimi yine işlenir. */
function eventCountry(event: PlatformEvent): string | null {
  const raw = (event as { country?: unknown }).country;
  return typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) ? raw : null;
}
