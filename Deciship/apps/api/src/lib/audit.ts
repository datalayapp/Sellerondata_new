import { prisma } from '../db.ts';

export async function audit(
  companyId: string,
  userId: string | null,
  action: string,
  entity: string,
  entityId?: string | null,
  data?: unknown,
) {
  try {
    await prisma.auditLog.create({
      data: {
        companyId,
        userId,
        action,
        entity,
        entityId: entityId ?? null,
        data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)),
      },
    });
  } catch {
    /* audit must never break the request */
  }
}
