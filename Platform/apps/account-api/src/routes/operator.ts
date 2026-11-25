import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OperatorStepUpResponse } from '@sellerondata/contracts';
import { principalOf, requirePlatformOperator } from '../auth.ts';
import { prisma } from '../db.ts';
import { AppError } from '../errors.ts';
import { writeAudit } from '../lib/audit.ts';
import { verifyPassword } from '../lib/crypto.ts';
import { enforceRateLimit, RATE_RULES } from '../lib/rateLimit.ts';
import { existingPassword } from '../lib/schemas.ts';
import { signStepUpToken } from '../lib/tokens.ts';

/**
 * Platform yöneticisi uçları (YAPAY-ZEKA-GECIDI §2; contracts `tokens.ts`). Yalnız tarayıcı oturumu ve şu an yönetici olan kişi
 * (`requirePlatformOperator`); başkası gövdeye bakılmadan `403 FORBIDDEN`.
 */
export async function operatorRoutes(app: FastifyInstance) {
  /**
   * Adım artırma: şifre yeniden sorulur, geçidin değiştiren yönetici uçları için 5 dakikalık, tek amaçlı (`aud: ai-admin`) ve bu
   * oturum ailesine bağlı (`fid`; oturum yenilemesinden sağ çıkar) jeton verilir. Yanlış şifre `401 INVALID_CREDENTIALS`; şifre onayı kovası (firma kapatma ile ortak, her
   * deneme sayılır) dolunca `429 TOO_MANY_ATTEMPTS`. Başarı denetim izine yazılır (firmasız; jeton yazılmaz, yalnız kimliği).
   */
  app.post('/operator/step-up', { preHandler: requirePlatformOperator }, async (req, reply) => {
    const principal = principalOf(req);
    const body = z.object({ password: existingPassword }).parse(req.body);
    await enforceRateLimit([{ key: `password:person:${principal.personId}`, rule: RATE_RULES.passwordConfirm }]);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId }, select: { passwordHash: true } });
    if (!(await verifyPassword(person.passwordHash, body.password))) throw new AppError(401, 'INVALID_CREDENTIALS');

    const { token, expiresAt, jti } = await signStepUpToken(principal);
    await writeAudit(prisma, {
      actor: { personId: principal.personId, ip: req.ip },
      action: 'operator.step_up',
      target: principal.personId,
      meta: { jti, expiresAt: expiresAt.toISOString() },
    });
    const response: OperatorStepUpResponse = { token, expiresAt: expiresAt.toISOString() };
    return reply.header('cache-control', 'no-store').send(response);
  });
}
