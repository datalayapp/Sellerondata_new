import type { Prisma, Tx } from '../db.ts';

export type Actor = { personId?: string | null; membershipId?: string | null; ip?: string | null };

/** Denetim izi. İşlemi yapan değişiklikle aynı veritabanı işleminde yazılır. Kod, şifre, jeton `meta`ya girmez. */
export async function writeAudit(
  tx: Tx,
  entry: { orgId?: string | null; actor: Actor; action: string; target?: string | null; meta?: Prisma.InputJsonValue },
) {
  await tx.auditLog.create({
    data: {
      orgId: entry.orgId ?? null,
      actorPersonId: entry.actor.personId ?? null,
      actorMembershipId: entry.actor.membershipId ?? null,
      ip: entry.actor.ip ?? null,
      action: entry.action,
      target: entry.target ?? null,
      ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
    },
  });
}
