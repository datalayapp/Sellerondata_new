import { randomUUID } from 'node:crypto';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  type ProductClaim,
  type ProductKey,
} from '@sellerondata/contracts';
import type { PrismaClient, Tx } from '../db.ts';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { randomToken, sha256 } from './crypto.ts';
import { signAccessToken, type AccessPayload } from './tokens.ts';
import { platformOperatorOf } from './me.ts';
import { writeAudit } from './audit.ts';
import { bumpPersonEpochs, lockPerson } from './members.ts';
import { productAccessFor, productClaimsOf, type SubscriptionRow } from './productAccess.ts';
import { loadRoleBook, type RoleBook } from './roleBook.ts';

type Db = PrismaClient | Tx;

export type ClientKind = 'web' | 'mobile';
export type ClientMeta = { ip: string; userAgent: string | null };

export { isSubscriptionLive } from './productAccess.ts';

/**
 * `prod` alanı. Yalnız kapalı olmayan (`isProductOn`), kişinin katalogda geçerli rolü VE firmanın canlı aboneliği olan ürün girer.
 * Kural `productAccessFor`'dadır; `/me` aynı işlevi kullanır. `roles`: firmanın rol defteri (özel ve düzenlenmiş hazır roller;
 * `perms` buradan çözülür). Verilmezse yalnız katalog hazır rolleri tanınır.
 */
export function buildProductClaims(
  access: readonly { product: string; role: string }[],
  subscriptions: readonly SubscriptionRow[],
  now = new Date(),
  roles?: RoleBook,
): Partial<Record<ProductKey, ProductClaim>> {
  return productClaimsOf(productAccessFor(access, subscriptions, { now, roles }));
}

/** Jeton gövdesi her zaman veritabanından kurulur. Askıdaki üyelik ve kapalı firma (`closedAt`) firma ve ürün vermez. */
export async function buildAccessPayload(
  db: Db,
  person: { id: string; name: string; locale: 'tr' | 'en' },
  sessionId: string,
  activeOrgId: string | null,
  /** Oturum ailesi (`AccessClaims.fid`). Verilmezse satırdan okunur. */
  familyId?: string,
): Promise<AccessPayload> {
  const fid = familyId ?? (await db.session.findUnique({ where: { id: sessionId }, select: { familyId: true } }))?.familyId;
  const membership = activeOrgId
    ? await db.membership.findFirst({
        where: { personId: person.id, orgId: activeOrgId, status: 'ACTIVE', org: { closedAt: null } },
        include: { org: { select: { name: true } }, productAccess: true },
      })
    : null;
  const subscriptions = membership ? await db.subscription.findMany({ where: { orgId: membership.orgId } }) : [];
  const roles = membership ? await loadRoleBook(db, membership.orgId) : undefined;
  // Platform yöneticisi kişiye bağlıdır, firmadan bağımsız: firmasız oturumda da yazılır. Yalnız `true` iken (`AccessClaims.op`).
  const op = await platformOperatorOf(db, person.id);
  return {
    ...(op ? { op: true as const } : {}),
    sid: sessionId,
    ...(fid ? { fid } : {}),
    name: person.name,
    locale: person.locale,
    org: membership?.orgId ?? null,
    orgName: membership?.org.name ?? null,
    mid: membership?.id ?? null,
    orgRole: membership?.orgRole ?? null,
    ep: membership?.epoch ?? 0,
    prod: membership ? buildProductClaims(membership.productAccess, subscriptions, new Date(), roles) : {},
  };
}

/** `tercih ?? lastOrgId ?? tek firma ?? ilk firma`. Yalnız etkin üyelikler ve kapatılmamış firmalar sayılır. */
export async function chooseActiveOrg(
  db: Db,
  person: { id: string; lastOrgId: string | null },
  preferredOrgId?: string | null,
): Promise<string | null> {
  const active = await db.membership.findMany({
    where: { personId: person.id, status: 'ACTIVE', org: { closedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: { orgId: true },
  });
  const has = (id: string | null | undefined) => !!id && active.some((m) => m.orgId === id);
  if (has(preferredOrgId)) return preferredOrgId as string;
  if (has(person.lastOrgId)) return person.lastOrgId;
  return active[0]?.orgId ?? null;
}

/** Oturum ailesinin üst yaşı (ms). Yenileme zinciri bunu aşamaz; sonra şifreyle yeniden giriş gerekir. */
export function sessionMaxAgeMs() {
  return env.sessionMaxAgeDays * 24 * 3600_000;
}

/** Aile üst yaşına ulaştı mı? Yenileme, aile başı ve site yoklaması aynı kuralı kullanır. */
export function familyExpired(familyCreatedAt: Date, now = new Date()) {
  return familyCreatedAt.getTime() + sessionMaxAgeMs() <= now.getTime();
}

/** Yeni satırın bitişi: `min(şimdi + 30 gün, aile başlangıcı + üst sınır)`. */
function refreshExpiry(familyCreatedAt: Date, now = new Date()) {
  return new Date(Math.min(now.getTime() + REFRESH_TTL_SECONDS * 1000, familyCreatedAt.getTime() + sessionMaxAgeMs()));
}

export async function touchActiveOrg(tx: Tx, personId: string, orgId: string | null) {
  if (!orgId) return;
  await tx.person.update({ where: { id: personId }, data: { lastOrgId: orgId } });
  await tx.membership.updateMany({ where: { personId, orgId }, data: { lastActiveAt: new Date() } });
}

export async function createSession(
  tx: Tx,
  input: { person: { id: string; lastOrgId: string | null }; client: ClientKind; meta: ClientMeta; preferredOrgId?: string | null },
) {
  // Tüm oturum açan yollar buradan geçer: askıdaki kişi, doğrulaması sürerken askıya alınmış olsa da oturum alamaz.
  await lockPerson(tx, input.person.id);
  const current = await tx.person.findUniqueOrThrow({ where: { id: input.person.id }, select: { suspendedAt: true } });
  if (current.suspendedAt) throw new AppError(401, 'INVALID_CREDENTIALS');
  const activeOrgId = await chooseActiveOrg(tx, input.person, input.preferredOrgId);
  const refreshToken = randomToken();
  const now = new Date();
  const session = await tx.session.create({
    data: {
      personId: input.person.id,
      activeOrgId,
      client: input.client,
      familyId: randomUUID(),
      // Aynı değer iki sütuna: ailenin ilk satırı `createdAt = familyCreatedAt` ile tanınır (bilinen cihaz, §11).
      createdAt: now,
      familyCreatedAt: now,
      refreshHash: sha256(refreshToken),
      userAgent: input.meta.userAgent,
      ip: input.meta.ip,
      expiresAt: refreshExpiry(now, now),
    },
  });
  await touchActiveOrg(tx, input.person.id, activeOrgId);
  return { session, refreshToken };
}

/** Ailenin etkin başı. Üst yaşı geçmiş aile başsızdır (bitiş zaten üst sınırla kırpılır; göçten önceki satırlar için de). */
export async function familyHead(db: Db, familyId: string) {
  const now = new Date();
  return db.session.findFirst({
    where: {
      familyId,
      rotatedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
      familyCreatedAt: { gt: new Date(now.getTime() - sessionMaxAgeMs()) },
    },
  });
}

// Döndürme yeni satır açar: kişi kilidi olmadan eşzamanlı iptal yeni satırı görmez, oturum şifre değişiminden sağ çıkar;
// firma değişimi de döndürülen eski satıra yazılıp kaybolur.
export { assertPasswordUnchanged, lockPerson } from './members.ts';

/** Ailenin iptal edilmemiş satırlarını iptal eder; gerçekten iptal edilen satır sayısını döner (zaten iptalse 0). */
export async function revokeFamily(tx: Tx, familyId: string): Promise<number> {
  const row = await tx.session.findFirst({ where: { familyId }, select: { personId: true } });
  if (!row) return 0;
  await lockPerson(tx, row.personId);
  const { count } = await tx.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  return count;
}

export async function revokeAllSessions(tx: Tx, personId: string, exceptFamilyId?: string) {
  await lockPerson(tx, personId);
  await tx.session.updateMany({
    where: { personId, revokedAt: null, ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

export type RefreshOutcome =
  /** Başarılı döndürme. `refreshToken` null ise istemci elindekini korur (web, ödemesiz tekrar). */
  | { kind: 'rotated'; session: { id: string; personId: string; client: ClientKind; activeOrgId: string | null; familyId: string }; refreshToken: string | null }
  | { kind: 'invalid' }
  /** Aile üst yaşına ulaştı: iptal edildi, `session.expired` yazıldı. */
  | { kind: 'expired' }
  | { kind: 'reuse_detected' };

/** Satırı kilitleyerek okur: aynı jetonla eşzamanlı iki yenileme sıraya girer. */
async function lockByHash(tx: Tx, refreshHash: string) {
  await tx.$queryRaw`SELECT 1 FROM "platform"."Session" WHERE "refreshHash" = ${refreshHash} FOR UPDATE`;
  return tx.session.findUnique({ where: { refreshHash } });
}

async function rotate(
  tx: Tx,
  row: {
    id: string;
    personId: string;
    activeOrgId: string | null;
    client: ClientKind;
    familyId: string;
    familyCreatedAt: Date;
    userAgent: string | null;
    ip: string | null;
  },
  meta: ClientMeta,
  /** Bu yenilemede sunulan satır. Normal döndürmede `row`un kendisi; tolerans içi tekrarda eski jetonun satırı (04-B1). */
  presentedId: string = row.id,
  /** İstemcinin bu yenilemede gönderdiği tekrar anahtarının özeti (6.8); yoksa null. */
  retryKeyHash: string | null = null,
) {
  const person = await tx.person.findUniqueOrThrow({ where: { id: row.personId }, select: { id: true, lastOrgId: true } });
  // Etkin firma üyeliği bittiyse giriş kuralıyla yeni firma seçilir. Yanıttaki `activeOrgId` değişimi istemciye bildirir.
  const activeOrgId = await chooseActiveOrg(tx, person, row.activeOrgId);
  const refreshToken = randomToken();
  const now = new Date();
  await tx.session.update({ where: { id: row.id }, data: { rotatedAt: now } });
  const next = await tx.session.create({
    data: {
      personId: row.personId,
      activeOrgId,
      client: row.client,
      familyId: row.familyId,
      // Üst sınır aile başlangıcından sayılır: döndürme süreyi uzatamaz.
      familyCreatedAt: row.familyCreatedAt,
      refreshHash: sha256(refreshToken),
      userAgent: meta.userAgent ?? row.userAgent,
      ip: meta.ip,
      lastUsedAt: now,
      expiresAt: refreshExpiry(row.familyCreatedAt, now),
      parentId: presentedId,
      retryKeyHash,
    },
  });
  await touchActiveOrg(tx, row.personId, activeOrgId);
  return { session: next, refreshToken };
}

/**
 * Yenileme. Her başarılı kullanımda jeton döner.
 *
 * Eski jeton tekrar gelirse aile iptal edilir (ARCHITECTURE §5). Tek istisna tolerans: eski jetondan doğan yeni jeton henüz
 * hiç kullanılmadıysa (ailenin başı bu eski jetonun sunumuyla doğdu, `parentId`) VE şunlardan biri:
 * - süre (`REFRESH_REUSE_GRACE_SECONDS`) dolmadı;
 * - istek, başı doğuran sunumdaki tekrar anahtarının aynısını taşıyor (`retryKey`, 6.8): aynı istemcinin aynı yenilemeyi
 *   tekrarlamasıdır (kayıp yanıt, yeni jetonu depoya yazamadan kapanan uygulama); süre aranmaz, aile üst yaşı ve baş satırın
 *   bitişi geçerli kalır. Anahtar eski jetonla birlikte yenilemeden hemen önce üretilir: jetonun daha önce alınmış kopyası onu bilmez.
 * Toleransta:
 * - Web: iki sekme aynı çerezle yenilerse ikincisi yeni çerezi yazmaz, yalnız baş satır için erişim jetonu alır.
 * - Mobil: yanıt yolda kaybolduysa istemcinin elindeki tek jeton eskisidir; baş satır döndürülür (ebeveyni ve anahtarı yine eski
 *   sunumunkidir).
 * Yeni jeton kullanıldıktan sonra gelen eski jeton süre içinde de, doğru anahtarla da hırsızlıktır; süre dışında anahtarsız ya da
 * başka anahtarla gelen tekrar da: aile düşer, epoch artar, ürünler anında bırakır.
 */
export async function refreshSession(tx: Tx, refreshToken: string, meta: ClientMeta, retryKey: string | null = null): Promise<RefreshOutcome> {
  const refreshHash = sha256(refreshToken);
  const owner = await tx.session.findUnique({ where: { refreshHash }, select: { personId: true } });
  if (!owner) return { kind: 'invalid' };
  await lockPerson(tx, owner.personId);
  const person = await tx.person.findUniqueOrThrow({ where: { id: owner.personId }, select: { id: true, lastOrgId: true, suspendedAt: true } });
  if (person.suspendedAt) return { kind: 'invalid' };
  const row = await lockByHash(tx, refreshHash);
  if (!row || row.revokedAt) return { kind: 'invalid' };
  // Anahtar yalnız mobil oturumda sayılır (6.8): web sekmeleri ortak çerezle yeniler, anahtar göndermez; gelirse yok sayılır.
  const retryKeyHash = retryKey && row.client === 'mobile' ? sha256(retryKey) : null;

  // Üst yaş: hangi satırla gelinirse gelinsin (baş, tolerans içi ya da eski) aile kapanır. Kişi ve satır kilidi altında.
  if (familyExpired(row.familyCreatedAt)) {
    await revokeFamily(tx, row.familyId);
    await writeAudit(tx, { actor: { personId: row.personId, ip: meta.ip }, action: 'session.expired', target: row.familyId });
    return { kind: 'expired' };
  }

  if (row.rotatedAt) {
    const age = Date.now() - row.rotatedAt.getTime();
    await tx.$queryRaw`SELECT 1 FROM "platform"."Session" WHERE "familyId" = ${row.familyId} AND "rotatedAt" IS NULL AND "revokedAt" IS NULL FOR UPDATE`;
    const head = await familyHead(tx, row.familyId);
    // Olay koşulu (04-B1): ailenin başı bu eski jetonun sunumuyla doğduysa yeni jeton henüz hiç kullanılmadı (kayıp yanıt,
    // eşzamanlı istek). Yeni jeton bir kez kullanıldıysa baş başka satırın çocuğudur: eski jetonun gelmesi hırsızlıktır.
    // Göçten önceki satırda ebeveyn yok: yalnız süre kuralı (eski davranış).
    const headFromThisToken = !!head && (head.parentId === null || head.parentId === row.id);
    const inGrace = age <= env.refreshReuseGraceSeconds * 1000;
    // Aynı istemcinin aynı yenilemeyi tekrarı (6.8): başı doğuran sunumun anahtarı. Göçten önceki (ebeveynsiz) başta anahtar yoktur.
    const sameRetry = !!head && head.parentId === row.id && !!retryKeyHash && head.retryKeyHash === retryKeyHash;
    if (!head && inGrace) return { kind: 'invalid' };
    if (head && headFromThisToken && (inGrace || sameRetry)) {
      if (head.client === 'web') {
        // Çerez değişmez ama firma kuralı aynıdır: baş satır firmasız kaldıysa jeton yine `org: null` çıkardı, `/me` (TOKEN_STALE) döngüye girerdi.
        const activeOrgId = await chooseActiveOrg(tx, person, head.activeOrgId);
        if (activeOrgId === head.activeOrgId) return { kind: 'rotated', session: head, refreshToken: null };
        const moved = await tx.session.update({ where: { id: head.id }, data: { activeOrgId } });
        await touchActiveOrg(tx, person.id, activeOrgId);
        return { kind: 'rotated', session: moved, refreshToken: null };
      }
      // Baş döndürülür ama ebeveyni yine eski jetonun satırıdır: aynı eski jetonla gelen sonraki tekrar da (eşzamanlı istekler)
      // tolerans içinde kalır; arada baş satırın kendi jetonu sunulursa (meşru sahip) bu kez hırsızlık yakalanır.
      // Anahtar da bu isteğinkidir: aynı istemcinin sonraki tekrarı yine tanınır, anahtarsız bir tekrar onu devralamaz.
      const rotated = await rotate(tx, head, meta, row.id, retryKeyHash);
      // Süre penceresi dışında yalnız anahtarla geçen tekrar izlenebilsin (kişi düzeyi, firma izinde görünmez).
      if (!inGrace) {
        await writeAudit(tx, {
          actor: { personId: row.personId, ip: meta.ip },
          action: 'session.retry_accepted',
          target: row.familyId,
          meta: { ageSeconds: Math.round(age / 1000) },
        });
      }
      return { kind: 'rotated', ...rotated };
    }
    await revokeFamily(tx, row.familyId);
    await bumpPersonEpochs(tx, row.personId);
    await writeAudit(tx, {
      actor: { personId: row.personId, ip: meta.ip },
      action: 'session.reuse_detected',
      target: row.familyId,
      // Ayırt etmek için (04-B1): `successorUsed` true ise eski jetondan doğan yeni jeton kullanılmıştı (güçlü hırsızlık işareti);
      // false ise yalnız süre doldu (geç gelen tekrar da olabilir). `headMissing`: ailenin başı yok (yeni jetonun süresi doldu,
      // bakım sildi); o zaman `successorUsed` bilinmez, anahtar karşılaştırılamaz. `retryKey`: istek anahtar taşıyordu; baş varken ve
      // yeni jeton kullanılmamışken anahtarlı istek ancak anahtar tutmadıysa buraya düşer (eski jetonu iki taraf tutuyor: güçlü işaret).
      // Başsız ailede iptal ve epoch artışı yine yapılır: güvenli taraf.
      meta: { ageSeconds: Math.round(age / 1000), successorUsed: !!head && !headFromThisToken, retryKey: !!retryKeyHash, headMissing: !head },
    });
    return { kind: 'reuse_detected' };
  }

  if (row.expiresAt <= new Date()) return { kind: 'invalid' };
  return { kind: 'rotated', ...(await rotate(tx, row, meta, row.id, retryKeyHash)) };
}

/**
 * Çıkış: jeton hangi satıra aitse aile düşer. Ailenin sahibi ve gerçekten iptal edilen satır sayısı döner: zaten iptal edilmiş
 * ailenin eski jetonu tekrar gelirse `revoked: 0` olur, çağıran epoch artırmaz. Bilinmeyen jeton sessizce geçer (null).
 */
export async function revokeByRefreshToken(tx: Tx, refreshToken: string): Promise<{ personId: string; revoked: number } | null> {
  const row = await tx.session.findUnique({ where: { refreshHash: sha256(refreshToken) }, select: { familyId: true, personId: true } });
  if (!row) return null;
  return { personId: row.personId, revoked: await revokeFamily(tx, row.familyId) };
}

export async function signForSession(
  db: Db,
  person: { id: string; name: string; locale: 'tr' | 'en' },
  /** `familyId` verilmezse satırdan okunur (oturum satırı çoğu yolda zaten bütün gelir). */
  session: { id: string; activeOrgId: string | null; familyId?: string },
) {
  const familyId = typeof session.familyId === 'string' && session.familyId ? session.familyId : undefined;
  const payload = await buildAccessPayload(db, person, session.id, session.activeOrgId, familyId);
  return { accessToken: await signAccessToken(person.id, payload), activeOrgId: payload.org, expiresIn: ACCESS_TTL_SECONDS };
}
