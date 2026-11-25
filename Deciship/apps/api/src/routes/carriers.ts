import { m } from '../i18n/index.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CARRIER_PRESETS } from '@deciship/core';
import { prisma, Prisma } from '../db.ts';
import { conflict, notFound } from '../errors.ts';
import { requireAny } from '../lib/access.ts';
import { audit } from '../lib/audit.ts';
import { MAX_SAVED_MAPPING_BYTES, mappingSchema, savedMappingOf } from '../lib/mappingSchema.ts';
import { readSettings } from '../lib/settings.ts';
import { idParam } from '../lib/util.ts';
import { effectivePackagingLimits, packagingLimitsSchema, readPackagingLimits } from '../lib/packaging.ts';

export const CARRIER_CODES = ['fedex', 'ups', 'dhl', 'aras', 'yurtici', 'mng', 'ptt', 'generic'] as const;

const createBody = z.object({
  code: z.enum(CARRIER_CODES),
  name: z.string().trim().min(1).max(100).optional(),
});
const patchBody = z.object({
  code: z.enum(CARRIER_CODES).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  active: z.boolean().optional(),
  /** Fatura içe aktarmadaki eşleme şemasının aynısı; bilinmeyen alanlar atılır, boyut sınırlı. */
  defaultMapping: z
    .unknown()
    .refine((v) => JSON.stringify(v ?? null).length <= MAX_SAVED_MAPPING_BYTES, 'v.mappingTooLarge')
    .pipe(mappingSchema)
    .nullable()
    .optional(),
  /**
   * Taşıyıcı poşeti / zarfı sınırlarının firma ayarı; null = taşıyıcı kodunun varsayılanı. Değişince eski faturalar
   * kendiliğinden yeniden hesaplanmaz (sınır karşılaştırma anında okunur; "Yeniden karşılaştır" yeni sınırla hesaplar).
   */
  packagingLimits: packagingLimitsSchema.nullable().optional(),
});

type CarrierRow = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  defaultMapping: unknown;
  packagingLimits?: unknown;
  createdAt: Date;
  _count?: { tariffs: number; invoices: number };
};

export function serializeCarrier(c: CarrierRow) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    active: c.active,
    defaultMapping: c.defaultMapping ?? null,
    /** Kayıtlı poşet / zarf sınırı ayarı (null = taşıyıcı kodunun varsayılanı). */
    packagingLimits: readPackagingLimits(c.packagingLimits),
    /** Karşılaştırmanın kullandığı sınırlar: ayar > taşıyıcı kodunun varsayılanı (core `packagingLimitsFor`). */
    effectivePackagingLimits: effectivePackagingLimits(c),
    tariffCount: c._count?.tariffs ?? undefined,
    invoiceCount: c._count?.invoices ?? undefined,
    createdAt: c.createdAt,
  };
}

export async function carrierRoutes(app: FastifyInstance) {
  // Liste: tarife ekranı, fatura yükleme ve fatura süzgeci. Yazma: kurulum/ayar işi, tarifeler ve faturalar buna bağlıdır.
  const read = { onRequest: requireAny(app, ['deciship.tariffs.edit', 'deciship.invoices.upload', 'deciship.invoices.view']) };
  const manage = { onRequest: app.requirePermission('deciship.settings.manage') };

  app.get('/carriers', read, async (req) => {
    const carriers = await prisma.carrier.findMany({
      where: { companyId: req.auth.orgId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { tariffs: true, invoices: { where: { deletedAt: null, isSample: false } } } } },
    });
    return { items: carriers.map(serializeCarrier) };
  });

  app.post('/carriers', manage, async (req, reply) => {
    const body = createBody.parse(req.body);
    const companyId = req.auth.orgId;
    const carrier = await prisma.$transaction(async (tx) => {
      // Deneme başlatmasıyla sıraya girer (`services/demoTour.ts` bayrağı firma satırı FOR UPDATE altında yazar): koruma
      // kancası bayrağı okuduktan sonra başlayan deneme, bu taşıyıcıyı ya boş firma denetiminde görür ya da burada 409 olur.
      await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR SHARE`;
      const company = await tx.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
      if (readSettings(company.settings).demo) throw conflict('DEMO_ACTIVE', m('err.demoActive'));
      return tx.carrier.create({ data: { companyId, code: body.code, name: body.name ?? CARRIER_PRESETS[body.code].name } });
    });
    await audit(req.auth.orgId, req.auth.membershipId, 'carrier.create', 'Carrier', carrier.id, body);
    return reply.status(201).send({ carrier: serializeCarrier(carrier) });
  });

  app.patch('/carriers/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body);
    const existing = await prisma.carrier.findFirst({ where: { id, companyId: req.auth.orgId } });
    if (!existing) throw notFound(m('carrier.notFound'));
    const carrier = await prisma.carrier.update({
      where: { id },
      data: {
        code: body.code,
        name: body.name,
        active: body.active,
        defaultMapping:
          // K36: ağırlık seçimi dosya başınadır, kayıtlı eşlemeye yazılmaz
          body.defaultMapping === null ? Prisma.DbNull : (savedMappingOf(body.defaultMapping) as Prisma.InputJsonValue | undefined),
        packagingLimits: body.packagingLimits === null ? Prisma.DbNull : (body.packagingLimits as Prisma.InputJsonValue | undefined),
      },
    });
    if (body.packagingLimits !== undefined) {
      await audit(req.auth.orgId, req.auth.membershipId, 'carrier.packagingLimits', 'Carrier', id, { packagingLimits: body.packagingLimits });
    }
    return { carrier: serializeCarrier(carrier) };
  });

  app.delete('/carriers/:id', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const existing = await prisma.carrier.findFirst({ where: { id, companyId } });
    if (!existing) throw notFound(m('carrier.notFound'));
    const invoiceCount = await prisma.invoice.count({ where: { carrierId: id } });
    if (invoiceCount > 0) {
      const carrier = await prisma.carrier.update({ where: { id }, data: { active: false } });
      await audit(companyId, userId, 'carrier.deactivate', 'Carrier', id);
      return reply.status(200).send({ carrier: serializeCarrier(carrier), deactivated: true });
    }
    await prisma.carrier.delete({ where: { id } });
    await audit(companyId, userId, 'carrier.delete', 'Carrier', id);
    return reply.status(204).send();
  });
}
