import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.ts';
import { notFound } from '../errors.ts';
import { m as msg } from '../i18n/index.ts';
import { idParam } from '../lib/util.ts';
import {
  addDisputeResult,
  invoiceDispute,
  listDisputes,
  resendDispute,
  revertDisputeResult,
  sendDispute,
  withdrawDispute,
} from '../services/disputes.ts';
import { limited } from '../services/hub/limiter.ts';

/**
 * İtiraz takibi (Deciship/spec/itiraz.md "API sözleşmesi"). Görme `invoices.view`, değiştirme `disputes.manage`
 * (yazma izni: salt okunur abonelikte POST kapalı). Tutarlar `prices.view` yoksa app.ts `stripMoney` ile silinir.
 * Kayıt önce aranır, gövde sonra doğrulanır: başka firmanın kimliği her gövdeyle 404 alır.
 */
export async function disputeRoutes(app: FastifyInstance) {
  const view = { onRequest: app.requirePermission('deciship.invoices.view') };
  const manage = { onRequest: app.requirePermission('deciship.disputes.manage') };
  const actor = (req: { auth: { orgId: string; membershipId: string } }) => ({ companyId: req.auth.orgId, userId: req.auth.membershipId });

  app.get('/disputes', view, limited(async (req) => listDisputes(req.auth.orgId, req.query), 'read'));

  app.post('/invoices/:id/disputes', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const inv = await prisma.invoice.findFirst({ where: { id, companyId: req.auth.orgId, deletedAt: null }, select: { id: true, invoiceDate: true } });
    if (!inv) throw notFound(msg('invoice.notFound'));
    await sendDispute(actor(req), inv, req.body);
    return reply.status(201).send({ dispute: await invoiceDispute(req.auth.orgId, inv) });
  });

  app.post('/disputes/:id/resend', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await resendDispute(actor(req), id, req.body);
    return { dispute: await invoiceDispute(req.auth.orgId, { id: r.invoiceId, invoiceDate: r.invoiceDate }) };
  });

  app.post('/disputes/:id/withdraw', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await withdrawDispute(actor(req), id, req.body);
    return { dispute: await invoiceDispute(req.auth.orgId, { id: r.invoiceId, invoiceDate: r.invoiceDate }) };
  });

  app.post('/disputes/:id/results', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await addDisputeResult(actor(req), id, req.body);
    return { dispute: await invoiceDispute(req.auth.orgId, { id: r.invoiceId, invoiceDate: r.invoiceDate }) };
  });

  app.post('/dispute-results/:id/revert', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await revertDisputeResult(actor(req), id, req.body);
    return { dispute: await invoiceDispute(req.auth.orgId, { id: r.invoiceId, invoiceDate: r.invoiceDate }) };
  });
}
