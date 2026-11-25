import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AI_LIMIT_DEFAULTS,
  AI_SPEND_PATHS,
  aiMicrosToAmount,
  aiMicroUsdToMicroTry,
  aiProductKeys,
  type AiAllowanceState,
  type AiOrgAllowanceView,
  type AiSpendCallsPage,
  type AiSpendSummary,
} from '@sellerondata/contracts';
import type { PlatformAuth } from '../auth/platform.ts';
import type { PrismaClient } from '../db.ts';
import { AppError, invalidField } from '../errors.ts';
import { orgUsage, platformStopped, platformUsage } from '../limits/usage.ts';
import { buildCallsExport, buildCallsPage } from '../spend/calls.ts';
import { requireOrgAdmin, screenRate, spendContext } from '../spend/query.ts';
import { buildSpendSummary } from '../spend/summary.ts';

/**
 * Merkez harcama görünümü (sözleşme `aiSpend.ts`; gateway `/api/ai/`, Hesap erişim jetonu):
 * - `GET /api/ai/spend/summary`         → `HubAnalytics`
 * - `GET /api/ai/spend/calls`           → `HubDatasetPage`
 * - `GET /api/ai/spend/calls/export`    → CSV ya da XLSX (`format`, varsayılan `xlsx`; en çok 50.000 satır)
 * - `GET /api/ai/spend/allowance`       → `AiOrgAllowanceView` (yalnız firma görünümü)
 * Yetki `spend/query.ts`: firma görünümü etkin firmanın OWNER/ADMIN'i (firma yalnız jetondan), `scope=platform` yalnız `op`.
 * Yanıtlar `cache-control: no-store` (kimlik kancası yazar).
 */
export type SpendRouteDeps = { prisma: PrismaClient; auth: PlatformAuth; now?: () => Date };

function contentDisposition(fileName: string): string {
  const ascii =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\]/g, '') || 'export';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function spendRoutes(app: FastifyInstance, deps: SpendRouteDeps) {
  const { authenticate } = deps.auth;
  const now = deps.now ?? (() => new Date());

  app.get(AI_SPEND_PATHS.summary, { onRequest: [authenticate] }, async (req): Promise<AiSpendSummary> => {
    const at = now();
    return buildSpendSummary(deps.prisma, await spendContext(req, deps.prisma, at), at);
  });

  app.get(AI_SPEND_PATHS.calls, { onRequest: [authenticate] }, async (req): Promise<AiSpendCallsPage> => {
    return buildCallsPage(deps.prisma, await spendContext(req, deps.prisma, now()), (req.query ?? {}) as Record<string, unknown>);
  });

  app.get(AI_SPEND_PATHS.export, { onRequest: [authenticate] }, async (req, reply: FastifyReply) => {
    const ctx = await spendContext(req, deps.prisma, now());
    const raw = (req.query as Record<string, unknown> | undefined)?.format;
    if (raw !== undefined && raw !== 'csv' && raw !== 'xlsx') throw invalidField('format', 'invalid_value');
    const file = await buildCallsExport(deps.prisma, ctx, raw === 'csv' ? 'csv' : 'xlsx');
    req.log.info({ scope: ctx.scope, rows: file.rows, format: raw ?? 'xlsx' }, 'harcama dışa aktarıldı');
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', contentDisposition(file.fileName))
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(file.body);
  });

  app.get(AI_SPEND_PATHS.allowance, { onRequest: [authenticate] }, async (req): Promise<AiOrgAllowanceView> => {
    if (!req.principal) throw new AppError(401, 'UNAUTHORIZED');
    const orgId = requireOrgAdmin(req.principal);
    return buildOrgAllowance(deps.prisma, orgId, now());
  });
}

/**
 * Firmanın tek ortak aylık hakkı (bütün araçlar; karar 2026-11-21 §9.3) ve araç kırılımı, TL. Hesap G3'ün tavan hesabıyla aynı
 * (`limits/usage.ts`): harcanan = kapanmış satırlar, kalan = hak − harcanan − açık paylar. `state` `/internal/allowance` kuralı:
 * platform durduysa `paused`; hak doldu (ya da araç tavanı doldu) `capped`; `warnPct` `warn`.
 */
export async function buildOrgAllowance(prisma: PrismaClient, orgId: string, at: Date): Promise<AiOrgAllowanceView> {
  const rate = screenRate();
  const tl = (micro: number) => aiMicrosToAmount(aiMicroUsdToMicroTry(micro, rate));
  const warnAt = (cap: number) => (cap * AI_LIMIT_DEFAULTS.warnPct) / 100;
  const platform = await platformUsage(prisma, at);
  const paused = platformStopped(platform);
  const products = aiProductKeys();
  const usages = [];
  for (const p of products) usages.push(await orgUsage(prisma, orgId, p, at));
  const first = usages[0]!;
  const { cap, used, reserved } = first.org;
  const orgCapped = used >= cap;
  const state: AiAllowanceState = paused ? 'paused' : orgCapped ? 'capped' : used >= warnAt(cap) ? 'warn' : 'ok';
  const usedPct = cap > 0 ? Math.floor((used / cap) * 100) : used > 0 ? 100 : 0;
  return {
    period: first.month.period,
    periodStart: first.month.start.toISOString(),
    resetsAt: first.month.end.toISOString(),
    currency: 'TRY',
    capAmount: tl(cap),
    usedAmount: tl(used),
    remainingAmount: tl(Math.max(0, cap - used - reserved)),
    usedPct,
    state,
    pausedBy: paused ? 'platform' : orgCapped ? 'org' : null,
    byProduct: usages.map((u) => {
      const toolCap = u.tool.cap;
      const toolCapped = toolCap !== null && u.tool.used >= toolCap;
      const toolWarn = toolCap !== null && u.tool.used >= warnAt(toolCap);
      const s: AiAllowanceState = paused ? 'paused' : orgCapped || toolCapped ? 'capped' : state === 'warn' || toolWarn ? 'warn' : 'ok';
      return { product: u.tool.product, usedAmount: tl(u.tool.used), capAmount: toolCap === null ? null : tl(toolCap), state: s };
    }),
  };
}
