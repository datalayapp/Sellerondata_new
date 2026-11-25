import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AI_LIMIT_DEFAULTS,
  AI_SPEND_PATHS,
  DEFAULT_ORG_TIME_ZONE,
  aiProductKeys,
  aiStalePriceProviders,
  type AiAdminLimits,
  type AiAdminOrgRow,
  type AiAdminStatus,
  type AiAllowanceState,
  type ProductKey,
} from '@sellerondata/contracts';
import type { PlatformAuth } from '../auth/platform.ts';
import type { PrismaClient } from '../db.ts';
import { env } from '../env.ts';
import { invalidField, notFound } from '../errors.ts';
import type { KeyStore } from '../keystore/store.ts';
import { defaultToolCapMicroUsd, platformStopped, platformUsage, usdToMicro } from '../limits/usage.ts';
import { ORG_ID_PATTERN, screenRate } from '../spend/query.ts';

/**
 * Platform yöneticisinin tavan ve durum uçları (sözleşme `aiSpend.ts` "Platform yöneticisi"; anahtarlar `admin-keys.ts`'te):
 * - `GET   /api/ai/admin/limits`               op                     → `AiAdminLimits`
 * - `PATCH /api/ai/admin/limits`               op; `paused: true` dışındaki her alan adım artırma → `AiAdminLimits`
 *   (acil durdurma hızlı olsun diye adım artırma istemez; geri açma ve tavan değişikliği ister)
 * - `PUT   /api/ai/admin/limits/orgs/:orgId`   op + adım artırma `{ capUsd: number | null }` (null: `AI_ORG_MONTHLY_USD`'ye dön)
 *   → `AiAdminLimits`; kalıcı silinmiş firma `404 NOT_FOUND`
 * - `GET   /api/ai/admin/status`               op                     → `AiAdminStatus`
 * Her değişiklik `AdminAudit`'e yazılır (kim, ne, eski ve yeni değer). Tavan üst sınırı 1.000.000 USD (yazım hatası koruması) [V].
 */

const MAX_USD = 1_000_000;
const usdValue = z.number().finite().min(0).max(MAX_USD);
const LimitsPatch = z
  .object({ platformDailyUsd: usdValue.optional(), platformMonthlyUsd: usdValue.optional(), paused: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty' });
const OrgCapBody = z.object({ capUsd: usdValue.nullable() }).strict();

export type AdminRouteDeps = { prisma: PrismaClient; auth: PlatformAuth; keys: Pick<KeyStore, 'providerStates'>; now?: () => Date };

type OrgSpendRow = { orgId: string; product: string; used: bigint };

/** Bu ayın (her firmanın kendi saat diliminde) firma × araç harcaması; yalnız platform anahtarıyla yapılanlar (tavan kuralı). */
async function monthSpendByOrg(prisma: PrismaClient, at: Date): Promise<OrgSpendRow[]> {
  // Firma ayının başı: firmanın saat dilimindeki ayın ilk anı (UTC). Saat dilimi yalnız `isOrgTimeZone` ile yazılır (events.ts).
  // Satır ay dönümünde iki firmaya da düşmez: `startedAt` en çok 14 saat önceki UTC ayın başından aranır, sonra firmanın ayıyla süzülür.
  const lowerBound = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) - 15 * 3_600_000);
  return prisma.$queryRaw<OrgSpendRow[]>`
    SELECT c."orgId", c."product", SUM(c."costMicroUsd")::bigint AS used
    FROM ai."AiCall" c
    LEFT JOIN ai."Org" o ON o."id" = c."orgId"
    WHERE c."status" <> 'pending' AND c."keySource" = 'platform' AND c."startedAt" >= ${lowerBound}
      AND c."startedAt" >= ((date_trunc('month', (${at}::timestamptz AT TIME ZONE COALESCE(o."timeZone", ${DEFAULT_ORG_TIME_ZONE})))
            AT TIME ZONE COALESCE(o."timeZone", ${DEFAULT_ORG_TIME_ZONE})) AT TIME ZONE 'UTC')
    GROUP BY c."orgId", c."product"`;
}

export async function buildAdminLimits(prisma: PrismaClient, at: Date): Promise<AiAdminLimits> {
  const [platform, limitsRow, spend, overridden] = await Promise.all([
    platformUsage(prisma, at),
    prisma.platformLimits.findUnique({ where: { id: 1 } }),
    monthSpendByOrg(prisma, at),
    prisma.org.findMany({ where: { capOverrideMicroUsd: { not: null }, purgedAt: null }, select: { id: true } }),
  ]);
  const defaultCap = usdToMicro(env.limits.orgMonthlyUsd);
  const tools: AiAdminLimits['tools'] = {};
  for (const p of aiProductKeys()) {
    const cap = defaultToolCapMicroUsd(p);
    if (cap !== null) tools[p] = { defaultCapMicroUsd: cap };
  }
  const byOrg = new Map<string, Partial<Record<ProductKey, number>>>();
  for (const r of spend) {
    const m = byOrg.get(r.orgId) ?? {};
    m[r.product as ProductKey] = (m[r.product as ProductKey] ?? 0) + Number(r.used);
    byOrg.set(r.orgId, m);
  }
  for (const o of overridden) if (!byOrg.has(o.id)) byOrg.set(o.id, {});
  const ids = [...byOrg.keys()];
  const orgs = ids.length ? await prisma.org.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, capOverrideMicroUsd: true } }) : [];
  const info = new Map(orgs.map((o) => [o.id, o]));
  const stopped = platformStopped(platform);
  const warnPct = AI_LIMIT_DEFAULTS.warnPct;
  const rows: AiAdminOrgRow[] = ids.map((orgId) => {
    const o = info.get(orgId);
    const byProduct = byOrg.get(orgId) ?? {};
    const used = Object.values(byProduct).reduce((a, b) => a + (b ?? 0), 0);
    const overriddenCap = o?.capOverrideMicroUsd;
    const cap = overriddenCap != null ? Number(overriddenCap) : defaultCap;
    const usedPct = cap > 0 ? Math.floor((used / cap) * 100) : used > 0 ? 100 : 0;
    const state: AiAllowanceState = stopped ? 'paused' : used >= cap ? 'capped' : usedPct >= warnPct ? 'warn' : 'ok';
    return { orgId, orgName: o?.name ?? null, usedMicroUsd: used, byProduct, capMicroUsd: cap, capOverridden: overriddenCap != null, usedPct, state };
  });
  rows.sort((a, b) => b.usedMicroUsd - a.usedMicroUsd || a.orgId.localeCompare(b.orgId));
  return {
    platform: {
      dailyCapMicroUsd: platform.day.cap,
      monthlyCapMicroUsd: platform.month.cap,
      todayUsedMicroUsd: platform.day.used,
      monthUsedMicroUsd: platform.month.used,
      paused: platform.paused,
      pausedAt: limitsRow?.pausedAt?.toISOString() ?? null,
      pausedBy: limitsRow?.pausedBy ?? null,
    },
    orgDefaultCapMicroUsd: defaultCap,
    tools,
    orgs: rows,
    tryPerUsd: screenRate(),
  };
}

function actor(req: FastifyRequest) {
  const p = req.principal!;
  return { actorId: p.personId, actorName: p.name || p.personId };
}

export function adminRoutes(app: FastifyInstance, deps: AdminRouteDeps) {
  const { authenticate, requireOperator, requireStepUp } = deps.auth;
  const op = [authenticate, requireOperator];
  const now = deps.now ?? (() => new Date());

  app.get(AI_SPEND_PATHS.adminLimits, { onRequest: op }, async (): Promise<AiAdminLimits> => buildAdminLimits(deps.prisma, now()));

  app.patch(AI_SPEND_PATHS.adminLimits, { onRequest: op, bodyLimit: 1024 }, async (req, reply: FastifyReply) => {
    const parsed = LimitsPatch.safeParse(req.body);
    if (!parsed.success) throw invalidField(String(parsed.error.issues[0]?.path.join('.') ?? ''), parsed.error.issues[0]?.code ?? 'invalid_value');
    const body = parsed.data;
    // Yalnız acil durdurma adım artırmasız; geri açma (`paused: false`) ve tavanlar adım artırma ister.
    const onlyPause = body.paused === true && body.platformDailyUsd === undefined && body.platformMonthlyUsd === undefined;
    if (!onlyPause) {
      await requireStepUp(req, reply);
      if (reply.sent) return reply;
    }
    const { actorId, actorName } = actor(req);
    const at = now();
    await deps.prisma.$transaction(async (tx) => {
      // Tavan kararıyla aynı kilit (limits/index.ts): değişiklik süren bir karar ile yarışmaz.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'ai:limits:platform'}, 0))`;
      const before = await tx.platformLimits.findUnique({ where: { id: 1 } });
      const data: Record<string, unknown> = { updatedAt: at };
      if (body.platformDailyUsd !== undefined) data.dailyCapMicroUsd = BigInt(usdToMicro(body.platformDailyUsd));
      if (body.platformMonthlyUsd !== undefined) data.monthlyCapMicroUsd = BigInt(usdToMicro(body.platformMonthlyUsd));
      if (body.paused !== undefined && body.paused !== before?.paused) {
        data.paused = body.paused;
        data.pausedAt = body.paused ? at : null;
        data.pausedBy = body.paused ? actorName : null;
      }
      await tx.platformLimits.update({ where: { id: 1 }, data });
      const detail = {
        ...(body.platformDailyUsd !== undefined
          ? { dailyCapMicroUsd: { from: numOrNull(before?.dailyCapMicroUsd), to: usdToMicro(body.platformDailyUsd) } }
          : {}),
        ...(body.platformMonthlyUsd !== undefined
          ? { monthlyCapMicroUsd: { from: numOrNull(before?.monthlyCapMicroUsd), to: usdToMicro(body.platformMonthlyUsd) } }
          : {}),
        ...(body.paused !== undefined ? { paused: { from: before?.paused ?? false, to: body.paused } } : {}),
      };
      const action = body.paused === true && !before?.paused ? 'platform.pause' : body.paused === false && before?.paused ? 'platform.resume' : 'limits.update';
      await tx.adminAudit.create({ data: { id: randomUUID(), at, actorId, actorName, action, detail } });
    });
    req.log.info(
      { paused: body.paused, daily: body.platformDailyUsd !== undefined, monthly: body.platformMonthlyUsd !== undefined },
      'platform tavanları değişti',
    );
    return buildAdminLimits(deps.prisma, at);
  });

  app.put(
    `${AI_SPEND_PATHS.adminLimits}/orgs/:orgId`,
    { onRequest: [authenticate, requireOperator, requireStepUp], bodyLimit: 1024 },
    async (req): Promise<AiAdminLimits> => {
      const orgId = (req.params as { orgId?: string }).orgId ?? '';
      if (!ORG_ID_PATTERN.test(orgId)) throw notFound();
      const parsed = OrgCapBody.safeParse(req.body);
      if (!parsed.success) throw invalidField('capUsd', parsed.error.issues[0]?.code ?? 'invalid_value');
      const capUsd = parsed.data.capUsd;
      const { actorId, actorName } = actor(req);
      const at = now();
      await deps.prisma.$transaction(async (tx) => {
        // Firma olayları ve tavan kararıyla aynı sıra: önce firma olay kilidi (events.ts), sonra tavan firma kilidi (limits/index.ts).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai:org-events:${orgId}`}, 0))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai:limits:org:${orgId}`}, 0))`;
        const before = await tx.org.findUnique({ where: { id: orgId }, select: { purgedAt: true, capOverrideMicroUsd: true } });
        if (before?.purgedAt) throw notFound();
        const cap = capUsd === null ? null : BigInt(usdToMicro(capUsd));
        const fields = { capOverrideMicroUsd: cap, capOverriddenBy: cap === null ? null : actorName, capOverriddenAt: cap === null ? null : at };
        await tx.org.upsert({ where: { id: orgId }, create: { id: orgId, ...fields }, update: fields });
        await tx.adminAudit.create({
          data: {
            id: randomUUID(),
            at,
            actorId,
            actorName,
            action: 'org.cap',
            orgId,
            detail: { from: numOrNull(before?.capOverrideMicroUsd), to: cap === null ? null : Number(cap) },
          },
        });
      });
      req.log.info({ orgId, reset: capUsd === null }, 'firma hakkı değişti');
      return buildAdminLimits(deps.prisma, at);
    },
  );

  app.get(AI_SPEND_PATHS.adminStatus, { onRequest: op }, async (): Promise<AiAdminStatus> => {
    const at = now();
    const [providers, platform] = await Promise.all([deps.keys.providerStates(), platformUsage(deps.prisma, at)]);
    const paused = platformStopped(platform);
    return {
      available: !paused && Object.values(providers).some((s) => s === 'ok'),
      paused,
      providers,
      checkedAt: at.toISOString(),
      stalePrices: aiStalePriceProviders(at),
    };
  });
}

const numOrNull = (v: bigint | null | undefined) => (v === null || v === undefined ? null : Number(v));
