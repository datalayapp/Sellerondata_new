import type { FastifyInstance } from 'fastify';
import { env } from '../env.ts';
import { notFound } from '../errors.ts';
import { audit } from '../lib/audit.ts';
import { endDemo, startDemo } from '../services/demoTour.ts';

/**
 * Örnek veriyle deneme turu (MESAJ-14 §4.3; kurallar ve güvenceler `services/demoTour.ts`). Yalnız ayar yetkisi; salt okunur
 * abonelikte kapalı. `DEMO_TOUR=off` yalnız başlatmayı kapatır (404): açık kalmış deneme yine bitirilebilir, yoksa firma
 * kendi verisini hiç ekleyemezdi.
 */
export async function demoRoutes(app: FastifyInstance) {
  const manage = { onRequest: app.requirePermission('deciship.settings.manage') };

  app.post('/settings/demo', manage, async (req, reply) => {
    if (!env.demoTourEnabled) throw notFound();
    const { orgId: companyId, membershipId: userId } = req.auth;
    const loaded = await startDemo(companyId, userId, { log: req.log });
    await audit(companyId, userId, 'company.demoStart', 'Company', companyId, loaded);
    return reply.status(201).send(loaded);
  });

  app.delete('/settings/demo', manage, async (req) => {
    const { orgId: companyId, membershipId: userId } = req.auth;
    const removed = await endDemo(companyId, { log: req.log });
    await audit(companyId, userId, 'company.demoEnd', 'Company', companyId, { removed });
    return { removed };
  });
}
