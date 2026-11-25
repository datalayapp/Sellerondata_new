import { m } from '../i18n/index.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.ts';
import { env } from '../env.ts';
import { notFound } from '../errors.ts';
import { can } from '../lib/access.ts';
import { audit } from '../lib/audit.ts';
import { fxSourceLabel } from '@deciship/core';
import { firmCountry, ONBOARDING_STEPS, readSettings, settingsFor } from '../lib/settings.ts';
import { startBulkJob } from '../services/jobs/handlers/bulkRecompare.ts';
import { requireAsync } from '../services/jobs/queue.ts';
import { clearCompanyData, loadSampleData } from '../services/companyData.ts';
import { onboardingStatus, patchOnboarding, setOnboardingAfterDataReset } from '../services/onboarding.ts';
import { idParam, num } from '../lib/util.ts';
import { packagingSettings } from '../services/packagingSettings.ts';

/**
 * Firma adı, para birimi, ülke, saat dilimi ve firma bilgilerinin onayı (`companyConfirmed`) Merkez'den gelir (`org.updated`,
 * JIT): burada yazılamaz, gönderilirse istek reddedilir (saat dilimi Y131: tek yazarı Merkez `PATCH /org`).
 */
const settingsPatch = z.strictObject({
  // Ölçümün her kenarına eklenen paydır (SPEC §3.13); büyük değer gerçek ağırlık farklarını da "Uyumlu" yapar.
  edgeTolCm: z.number().min(0).max(10).optional(),
  weightTolKg: z.number().min(0).max(100).optional(),
  amountTol: z.number().min(0).max(1_000_000).optional(),
  desiDivisor: z.number().int().min(1000).max(10000).optional(),
  requiredBoxPhotos: z.number().int().min(0).max(10).optional(),
  // Mobilde akla aykırı ölçü uyarısının eşikleri (Y44). Yalnız uyarıdır: ölçüm bunlarla reddedilmez. Kenar alanı en çok 400 cm.
  warnEdgeCm: z.number().int().min(10).max(400).optional(),
  warnWeightKg: z.number().int().min(1).max(999).optional(),
  // Tartı fotoğrafını ücretli yapay zekâ okusun mu (varsayılan kapalı; `lib/settings.ts`).
  scaleAiRead: z.boolean().optional(),
  fxTolerancePct: z.number().min(0).max(20).optional(),
  unknownSurchargesAsDiff: z.boolean().optional(),
  disputeReminders: z.boolean().optional(),
});

const onboardingStep = z.enum(ONBOARDING_STEPS);
const onboardingPatch = z
  .object({
    step: onboardingStep.optional(),
    done: onboardingStep.optional(),
    skipped: onboardingStep.optional(),
    complete: z.boolean().optional(),
    dismissBanner: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => !(b.done && b.skipped && b.done === b.skipped), 'v.stepBothStates');

const dim = z.number().positive().max(1000);
const presetBody = z.object({
  name: z.string().trim().min(1).max(40),
  lengthCm: dim,
  widthCm: dim,
  heightCm: dim,
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  active: z.boolean().optional(),
});

function serializePreset(p: {
  id: string;
  name: string;
  lengthCm: unknown;
  widthCm: unknown;
  heightCm: unknown;
  sortOrder: number;
  active: boolean;
}) {
  return {
    id: p.id,
    name: p.name,
    lengthCm: num(p.lengthCm as number),
    widthCm: num(p.widthCm as number),
    heightCm: num(p.heightCm as number),
    sortOrder: p.sortOrder,
    active: p.active,
  };
}

export async function settingsRoutes(app: FastifyInstance) {
  const manage = { onRequest: app.requirePermission('deciship.settings.manage') };

  app.get('/settings', { onRequest: app.authenticate }, async (req) => {
    const company = await prisma.company.findFirstOrThrow({ where: { id: req.auth.orgId } });
    return {
      name: company.name,
      ...settingsFor(req, readSettings(company.settings), firmCountry(company)),
      ...(can(req, 'deciship.settings.manage') ? { fxSource: fxSourceLabel(req.locale) } : {}),
      // İstemci sıfırlama düğmesini buna göre gösterir. Yalnız açık/kapalı bilgisi.
      dataResetEnabled: env.dataResetEnabled,
      // Mobil ölçü ekranı: taşıyıcı poşeti / zarfı uyarısının sınırları ve barkoddan taşıyıcı bulunamazsa kullanılacak taşıyıcı.
      packaging: await packagingSettings(req.auth.orgId),
    };
  });

  app.patch('/settings', manage, async (req) => {
    const body = settingsPatch.parse(req.body);
    const companyId = req.auth.orgId;
    // Satır kilidi: ayarlar tek JSON; aynı anda gelen iki yazım (kurulum ilerlemesi dahil) birbirini ezmesin.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
      const company = await tx.company.findFirstOrThrow({ where: { id: companyId } });
      const settings = { ...readSettings(company.settings), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
      return tx.company.update({ where: { id: companyId }, data: { settings } });
    });
    await audit(companyId, req.auth.membershipId, 'settings.update', 'Company', companyId, body);
    // Merkez onayı ayar yanıtına girmez (`settingsFor` gibi): kurulum yanıtı `company.confirmed` taşır.
    const { companyConfirmed: _confirmed, ...saved } = readSettings(updated.settings);
    return { name: updated.name, ...saved, country: firmCountry(updated), fxSource: fxSourceLabel(req.locale) };
  });

  /**
   * Mesaj 4: ayar kaydı faturaları hesaplamaz (yukarıda), eski faturalar eski ayarla kalır. Bu iki uç dayanağındaki ayarı
   * bugünkünden farklı faturaları bugünkü ayara toplu geçirir (`services/bulkRecalc.ts`); `current` dayanak tarifenin
   * bugünkü sürümünü de alır. Önizleme yazmaz; onay önizlemenin `token`'ıyla gelir, tutmuyorsa 409 `PREVIEW_STALE`.
   * Yalnız arka planda (Mesaj 7, Y83): `?async=1` → 202 `{ job, joined }` (tarife uçlarıyla aynı kurallar,
   * `services/jobs/handlers/bulkRecompare.ts`); `async` yoksa 400 `ASYNC_REQUIRED`.
   */
  app.post('/settings/recompare-invoices/preview', manage, async (req, reply) => {
    requireAsync(req);
    return reply.status(202).send(await startBulkJob(req, { kind: 'BULK_RECOMPARE_PREVIEW', scope: { kind: 'settings' }, label: null }));
  });

  app.post('/settings/recompare-invoices', manage, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).parse(req.body ?? {});
    requireAsync(req);
    return reply.status(202).send(await startBulkJob(req, { kind: 'BULK_RECOMPARE_APPLY', scope: { kind: 'settings' }, label: null, token }));
  });

  // İlk kurulum sihirbazı: ilerleme + kontrol listesi.
  app.get('/settings/onboarding', manage, async (req) => onboardingStatus(req.auth.orgId));

  app.patch('/settings/onboarding', manage, async (req) => {
    const body = onboardingPatch.parse(req.body);
    const { orgId: companyId, membershipId: userId } = req.auth;
    await patchOnboarding(companyId, body);
    if (body.complete !== undefined) await audit(companyId, userId, body.complete ? 'onboarding.complete' : 'onboarding.reopen', 'Company', companyId);
    return onboardingStatus(companyId);
  });

  // ARCHITECTURE §11: uç yalnız ENABLE_DATA_RESET=true iken kayıtlıdır, üretimde varsayılan olarak yoktur (404).
  if (env.dataResetEnabled) {
    const dataReset = z.object({ confirm: z.literal(true), samples: z.boolean().optional() });
    app.post('/settings/data/reset', manage, async (req) => {
      const body = dataReset.parse(req.body);
      const { orgId: companyId, membershipId: userId } = req.auth;
      const removed = await clearCompanyData(companyId);
      const loaded = body.samples ? await loadSampleData(companyId, { fallbackUserId: userId }) : null;
      // sıfırlama kurulum sihirbazını baştan açar; örnek veri kurulumu tamamlanmış sayar
      await setOnboardingAfterDataReset(companyId, Boolean(body.samples));
      await audit(companyId, userId, body.samples ? 'company.samples' : 'company.reset', 'Company', companyId, { removed, loaded });
      return { removed, loaded };
    });
  }

  app.get('/box-presets', { onRequest: app.requirePermission('deciship.measurements.capture') }, async (req) => {
    const presets = await prisma.boxPreset.findMany({
      where: { companyId: req.auth.orgId, ...(can(req, 'deciship.settings.manage') ? {} : { active: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return { items: presets.map(serializePreset) };
  });

  app.post('/box-presets', manage, async (req, reply) => {
    const body = presetBody.parse(req.body);
    const { orgId: companyId } = req.auth;
    const maxOrder = await prisma.boxPreset.aggregate({ where: { companyId }, _max: { sortOrder: true } });
    const preset = await prisma.boxPreset.create({
      data: { ...body, companyId, sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1 },
    });
    return reply.status(201).send({ preset: serializePreset(preset) });
  });

  app.patch('/box-presets/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = presetBody.partial().parse(req.body);
    const existing = await prisma.boxPreset.findFirst({ where: { id, companyId: req.auth.orgId } });
    if (!existing) throw notFound(m('preset.notFound'));
    const preset = await prisma.boxPreset.update({ where: { id }, data: body });
    return { preset: serializePreset(preset) };
  });

  app.delete('/box-presets/:id', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.boxPreset.findFirst({ where: { id, companyId: req.auth.orgId } });
    if (!existing) throw notFound(m('preset.notFound'));
    await prisma.boxPreset.delete({ where: { id } });
    return reply.status(204).send();
  });
}
