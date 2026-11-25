/**
 * Hiç kullanılmamış kayıtların temizliği (denetim 04-B8). Yalnız elle çalışan destek komutu: `scripts/signup-purge.ts`
 * (`npm run signup:purge`). Otomatik bakım turunda YOKTUR.
 *
 * Aday koşulu bilerek dardır, şüphede silinmez (`checkCandidate`): e-postası doğrulanmamış, hiç oturum açmamış, kaydın açtığı tek
 * firmanın tek sahibi olan ve kayıttan sonra hiçbir iz bırakmamış kişi. Silme kişi başına ayrı işlemdedir ve koşullar kilit altında
 * yeniden denetlenir: liste ile silme arasında doğrulayan, giriş yapan ya da davet alan kişi silinmez.
 *
 * Kilit sırası (projenin kuralı, `subscriptions.ts` dosya başı): firma (`FOR NO KEY UPDATE`) → abonelik → kişi → üyelik
 * (`lockMemberships`) → davet. Kişi ya da üyelik kilidinden sonra firma kilitlenmez.
 */

import type { ProductKey } from '@sellerondata/contracts';
import { prisma, type PrismaClient, type Tx } from '../db.ts';
import { writeAudit } from './audit.ts';
import { emitMemberRemoved, lockMemberships, lockPerson } from './members.ts';
import { enqueueEvent, enqueueServiceEvents, eventProductsOf } from './outbox.ts';
import { requireOperator } from './support.ts';

export const SIGNUP_PURGE_DAYS_DEFAULT = 7;
export const SIGNUP_PURGE_DAYS_MIN = 7;
export const SIGNUP_PURGE_DAYS_MAX = 365;
/** Bir çalıştırmada en çok bu kadar kişi: kalanlar için komut yeniden çalıştırılır. */
export const SIGNUP_PURGE_LIMIT_DEFAULT = 500;
export const SIGNUP_PURGE_LIMIT_MAX = 5000;
const DAY_MS = 86_400_000;
const SCAN_BATCH = 200;

/** Kişinin aday olmama nedeni. Komut çıktısında ve testte görünür. */
export type PurgeSkipReason =
  | 'not_found'
  | 'no_email'
  | 'email_verified'
  | 'pending_email'
  | 'has_phone'
  | 'suspended'
  | 'too_recent'
  | 'has_session'
  | 'used_token'
  | 'recent_token'
  | 'person_activity'
  | 'membership_count'
  | 'not_owner'
  | 'member_active'
  | 'shared_org'
  | 'org_invitations'
  | 'invited_elsewhere'
  | 'org_activity'
  | 'billing';

export const PURGE_SKIP_TEXT: Record<PurgeSkipReason, string> = {
  not_found: 'kişi yok (silinmiş)',
  no_email: 'e-postası yok',
  email_verified: 'e-postası doğrulanmış',
  pending_email: 'onay bekleyen e-posta var',
  has_phone: 'telefonu var',
  suspended: 'askıda',
  too_recent: 'süreden genç',
  has_session: 'oturum açmış',
  used_token: 'şifre sıfırlama istenmiş ya da bağlantı kullanılmış',
  recent_token: 'son günlerde yeni bağlantı istenmiş',
  person_activity: 'kayıttan sonra işlem yapmış',
  membership_count: 'tek firmada değil',
  not_owner: 'firmanın sahibi değil',
  member_active: 'üyeliğinde etkinlik var',
  shared_org: 'firmada başka üye var',
  org_invitations: 'firmada davet var',
  invited_elsewhere: 'adresine başka firmadan davet var',
  org_activity: 'firmada kayıttan sonra işlem var',
  billing: 'abonelikte ödeme bilgisi var',
};

export type PurgeCandidate = { personId: string; maskedEmail: string; orgIds: string[]; createdAt: Date };

export function assertPurgeDays(days: number): number {
  if (!Number.isInteger(days) || days < SIGNUP_PURGE_DAYS_MIN || days > SIGNUP_PURGE_DAYS_MAX) {
    throw new Error(`--days ${SIGNUP_PURGE_DAYS_MIN} ile ${SIGNUP_PURGE_DAYS_MAX} arasında tam sayı olmalı (verilen: ${days}).`);
  }
  return days;
}

function assertPurgeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SIGNUP_PURGE_LIMIT_MAX) {
    throw new Error(`--limit 1 ile ${SIGNUP_PURGE_LIMIT_MAX} arasında tam sayı olmalı (verilen: ${limit}).`);
  }
  return limit;
}

/** Komut çıktısı ve sonuç için: "ali@alan.com" → "a***@alan.com". Adres denetim izine hiç yazılmaz. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

function cutoffOf(days: number, now = new Date()): Date {
  return new Date(now.getTime() - assertPurgeDays(days) * DAY_MS);
}

type Db = Tx | PrismaClient;

/**
 * Tek kişinin aday koşulları. Aday ise null, değilse ilk tutmayan koşul. Kilitsiz çağrı (liste) da kilit altındaki yeniden
 * denetim de bunu kullanır. Koşullar yalnız daraltılır; biri bile tutmazsa kişi silinmez.
 */
async function checkCandidate(db: Db, personId: string, cutoff: Date): Promise<PurgeSkipReason | null> {
  const person = await db.person.findUnique({
    where: { id: personId },
    select: {
      email: true,
      emailVerifiedAt: true,
      pendingEmail: true,
      phone: true,
      phoneVerifiedAt: true,
      suspendedAt: true,
      createdAt: true,
      memberships: { select: { id: true, orgId: true, orgRole: true, lastActiveAt: true } },
    },
  });
  if (!person) return 'not_found';
  if (!person.email) return 'no_email';
  if (person.emailVerifiedAt) return 'email_verified';
  if (person.pendingEmail) return 'pending_email';
  if (person.phone || person.phoneVerifiedAt) return 'has_phone';
  if (person.suspendedAt) return 'suspended';
  if (!(person.createdAt < cutoff)) return 'too_recent';

  // Oturum: hiç satır yok (iptal ya da süresi geçmiş olanlar da sayılır).
  if (await db.session.count({ where: { personId } })) return 'has_session';
  // Şifre sıfırlama istenmiş ya da herhangi bir bağlantı kullanılmış: adresin sahibi ilgileniyor olabilir.
  if (await db.oneTimeToken.count({ where: { personId, OR: [{ kind: 'PASSWORD_RESET' }, { usedAt: { not: null } }] } })) return 'used_token';
  // Süre içinde yeni bağlantı üretilmiş: doğru şifreyle giriş denemesi (`EMAIL_NOT_VERIFIED` yeni doğrulama postası yollar) ya da
  // "yeniden gönder". Kişi hesabıyla şu an ilgileniyor, doğrulama postasını açmak üzere olabilir; denetim izi bırakmayan bu yol
  // `session` ve audit koşullarına görünmez.
  if (await db.oneTimeToken.count({ where: { personId, createdAt: { gte: cutoff } } })) return 'recent_token';

  // Tek üyelik: kaydın açtığı firmada sahip. Oturumu olmayan kişi ikinci firma açamaz; birden çok üyelik başka yoldan gelmiştir.
  if (person.memberships.length !== 1) return 'membership_count';
  const [m] = person.memberships;
  if (m.orgRole !== 'OWNER') return 'not_owner';
  if (m.lastActiveAt) return 'member_active';

  // Denetim izinde kişinin yaptığı tek şey kendi firmasını açmak (kayıt). `session.created`, `member.joined` vb. varsa aday değil.
  const actorRows = await db.auditLog.findMany({ where: { actorPersonId: personId }, select: { action: true, orgId: true }, take: 2 });
  if (actorRows.length !== 1 || actorRows[0].action !== 'org.created' || actorRows[0].orgId !== m.orgId) return 'person_activity';
  // Kişiyi hedef alan kayıt (doğrulama, şifre, telefon, destek). `login.locked` başkasının yanlış denemesidir, kullanım sayılmaz.
  if (await db.auditLog.count({ where: { target: personId, action: { not: 'login.locked' } } })) return 'person_activity';

  if ((await db.membership.count({ where: { orgId: m.orgId } })) !== 1) return 'shared_org';
  // Davet hangi durumda olursa olsun (bekleyen, kabul, geri alınmış, süresi geçmiş).
  if (await db.invitation.count({ where: { orgId: m.orgId } })) return 'org_invitations';
  if (await db.invitation.count({ where: { OR: [{ email: person.email }, { targetPersonId: personId }] } })) return 'invited_elsewhere';

  // Firmanın denetim izinde yalnız kendi açılış kaydı (destek `support.*`, `org.updated` vb. varsa dokunulmaz).
  const orgRows = await db.auditLog.findMany({ where: { orgId: m.orgId }, select: { action: true, actorPersonId: true }, take: 2 });
  if (orgRows.length !== 1 || orgRows[0].action !== 'org.created' || orgRows[0].actorPersonId !== personId) return 'org_activity';
  // Aracın istediği bildirim postası: firmada ürün tarafında iş olmuş.
  if (await db.productNotice.count({ where: { orgId: m.orgId } })) return 'org_activity';
  if (await db.subscription.count({ where: { orgId: m.orgId, OR: [{ provider: { not: null } }, { providerRef: { not: null } }] } })) return 'billing';
  return null;
}

/** Tek kişi için: aday ise null, değilse neden. Salt okur. */
export async function explainSignupPurge(personId: string, opts: { days?: number; now?: Date } = {}): Promise<PurgeSkipReason | null> {
  return checkCandidate(prisma, personId, cutoffOf(opts.days ?? SIGNUP_PURGE_DAYS_DEFAULT, opts.now));
}

/** Adaylar, en eski kayıt önce. Salt okur, kilit yok, denetim kaydı yok. */
export async function findSignupPurgeCandidates(opts: { days?: number; limit?: number; now?: Date } = {}): Promise<PurgeCandidate[]> {
  const cutoff = cutoffOf(opts.days ?? SIGNUP_PURGE_DAYS_DEFAULT, opts.now);
  const limit = assertPurgeLimit(opts.limit ?? SIGNUP_PURGE_LIMIT_DEFAULT);
  const found: PurgeCandidate[] = [];
  let after: string | undefined;
  // Ön süzgeç veritabanında (ucuz alanlar); her satır sonra `checkCandidate` ile tek tek denetlenir.
  for (;;) {
    const rows = await prisma.person.findMany({
      where: {
        ...(after ? { id: { gt: after } } : {}),
        email: { not: null },
        emailVerifiedAt: null,
        pendingEmail: null,
        phone: null,
        phoneVerifiedAt: null,
        suspendedAt: null,
        createdAt: { lt: cutoff },
        sessions: { none: {} },
        memberships: { some: {} },
      },
      select: { id: true, email: true, createdAt: true, memberships: { select: { orgId: true } } },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
    });
    for (const r of rows) {
      if (await checkCandidate(prisma, r.id, cutoff)) continue;
      found.push({ personId: r.id, maskedEmail: maskEmail(r.email as string), orgIds: r.memberships.map((m) => m.orgId), createdAt: r.createdAt });
      if (found.length >= limit) return sortByAge(found);
    }
    if (rows.length < SCAN_BATCH) return sortByAge(found);
    after = rows[rows.length - 1].id;
  }
}

function sortByAge(list: PurgeCandidate[]): PurgeCandidate[] {
  return list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.personId.localeCompare(b.personId));
}

export type PurgeOneResult = { purged: true; personId: string; maskedEmail: string; orgIds: string[] } | { purged: false; reason: PurgeSkipReason };

/**
 * Tek kişiyi siler (kendi işleminde). Kilitler kuraldaki sırayla alınır, koşullar kilit altında yeniden denetlenir; tutmazsa hiçbir
 * şey yazılmaz. Silmeden önce, aynı işlemde: `member.removed` (epoch + 1) ve her olay ürününe `subscription.updated` (CANCELED,
 * sürüm + 1). `Outbox`un firmaya yabancı anahtarı yok: firma silinince olaylar kalır, dağıtıcı teslim eder.
 * Silme sırası: firma (üyelik, abonelik, davet, bildirim zincirleme), sonra kişi (oturum, tek kullanımlık jeton zincirleme).
 * Üyeliğin kişiye bağı `Restrict`: kişi firmadan önce silinemez. "Firmada en az bir OWNER" tetikleyicisi ertelenmiştir ve firma
 * yoksa geçer.
 */
export async function purgeSignupCandidate(personId: string, opts: { operator: string; days?: number; now?: Date }): Promise<PurgeOneResult> {
  const operator = requireOperator(opts.operator);
  const days = assertPurgeDays(opts.days ?? SIGNUP_PURGE_DAYS_DEFAULT);
  const cutoff = cutoffOf(days, opts.now);
  return prisma.$transaction(async (tx): Promise<PurgeOneResult> => {
    // Kilitsiz okuma yalnız hangi firmanın kilitleneceğini bulmak için; asıl karar kilitlerden sonra.
    const pre = await tx.membership.findMany({ where: { personId }, select: { orgId: true } });
    if (pre.length !== 1) {
      const exists = await tx.person.count({ where: { id: personId } });
      return { purged: false, reason: exists ? 'membership_count' : 'not_found' };
    }
    const orgId = pre[0].orgId;

    // 1. firma, 2. abonelik, 3. kişi, 4. üyelik, 5. davet.
    const org = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "platform"."Organization" WHERE "id" = ${orgId} FOR NO KEY UPDATE`;
    if (!org.length) return { purged: false, reason: 'not_found' };
    await tx.$queryRaw`SELECT 1 FROM "platform"."Subscription" WHERE "orgId" = ${orgId} ORDER BY "product" FOR UPDATE`;
    await lockPerson(tx, personId);
    // Firmanın başka üyesi varsa onun kişi satırı kilitlenmeden çıkılır (kişiler kimlik sırasıyla kilitlenmeli).
    const orgMembers = await tx.membership.findMany({ where: { orgId }, select: { id: true, personId: true } });
    if (orgMembers.length !== 1 || orgMembers[0].personId !== personId) return { purged: false, reason: 'shared_org' };
    await lockMemberships(tx, [orgMembers[0].id]);
    const invitations = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "platform"."Invitation" WHERE "orgId" = ${orgId} ORDER BY "id" FOR UPDATE`;
    if (invitations.length) return { purged: false, reason: 'org_invitations' };

    const reason = await checkCandidate(tx, personId, cutoff);
    if (reason) return { purged: false, reason };

    const person = await tx.person.findUniqueOrThrow({ where: { id: personId }, select: { name: true, email: true } });
    const membership = await tx.membership.findUniqueOrThrow({ where: { id: orgMembers[0].id }, select: { id: true, orgId: true, personId: true, epoch: true } });
    const subs = await tx.subscription.findMany({ where: { orgId }, orderBy: { product: 'asc' } });
    const products: ProductKey[] = await eventProductsOf(tx, orgId);

    await emitMemberRemoved(tx, { ...membership, person: { name: person.name } });
    for (const product of products) {
      const sub = subs.find((s) => s.product === product);
      if (!sub) continue;
      await enqueueEvent(tx, { type: 'subscription.updated', orgId, product, status: 'CANCELED', plan: sub.plan, version: sub.version + 1 });
    }
    // Firma siliniyor: hizmet (geçit) firmanın ayrıntılı kayıtlarını silsin. Araçlar `org.purged` değil abonelik iptali alır (yukarıda).
    await enqueueServiceEvents(tx, { type: 'org.purged', orgId });
    const orgIds = [orgId];
    await writeAudit(tx, { actor: {}, action: 'support.signup_purged', target: personId, meta: { personId, orgIds, operator, days } });

    // Araç erişimi önce, açıkça: özel rol bağı (`ProductAccess.customRoleId → ProductRole`) NO ACTION; iki ucu da firma silmesinin
    // zincirine bırakılırsa tetikleyici sırasına göre yabancı anahtar hatası verebilir (`orgClosure.ts` `purgeClosedOrg` ile aynı).
    await tx.productAccess.deleteMany({ where: { membershipId: membership.id } });
    await tx.organization.delete({ where: { id: orgId } });
    await tx.person.delete({ where: { id: personId } });
    return { purged: true, personId, maskedEmail: maskEmail(person.email as string), orgIds };
  });
}

export type PurgeResult = {
  purged: { personId: string; maskedEmail: string; orgIds: string[] }[];
  skipped: { personId: string; maskedEmail: string; reason: PurgeSkipReason }[];
  failed: { personId: string; maskedEmail: string; error: string }[];
};

/** Adayları bulur, her birini ayrı işlemde siler. Biri hata verirse sonrakiler yine denenir; yeniden çalıştırmak zararsız. */
export async function purgeSignups(opts: { operator: string; days?: number; limit?: number; now?: Date }): Promise<PurgeResult> {
  const operator = requireOperator(opts.operator);
  const days = assertPurgeDays(opts.days ?? SIGNUP_PURGE_DAYS_DEFAULT);
  const candidates = await findSignupPurgeCandidates({ days, limit: opts.limit, now: opts.now });
  const result: PurgeResult = { purged: [], skipped: [], failed: [] };
  for (const c of candidates) {
    try {
      const r = await purgeSignupCandidate(c.personId, { operator, days, now: opts.now });
      if (r.purged) result.purged.push({ personId: r.personId, maskedEmail: r.maskedEmail, orgIds: r.orgIds });
      else result.skipped.push({ personId: c.personId, maskedEmail: c.maskedEmail, reason: r.reason });
    } catch (err) {
      result.failed.push({ personId: c.personId, maskedEmail: c.maskedEmail, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
