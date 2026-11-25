import { AI_LIMIT_DEFAULTS, aiRejectBody, aiRejectHeaders, type AiAllowance, type AiAllowanceState } from '@sellerondata/contracts';
import type { PrismaClient } from '../db.ts';
import type { InternalRoutes } from '../internal/scope.ts';
import { orgUsage, platformStopped, platformUsage } from '../limits/usage.ts';

/** Firma kimliği biçimi (Hesap kimliği; `parseAiContextHeaders` ile aynı). */
const ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * `GET /internal/allowance?orgId=` (araç jetonuyla, iç ağ) → `AiAllowance`: firmanın tek ortak aylık hakkı (bütün araçlar) ve
 * çağıran aracın (jetondan) firma × araç tavanı. Dönem firmanın saat diliminde. Araç bunu en çok 30 sn önbellekler.
 * `state`: platform durduysa `paused`; hak ya da araç tavanı harcananla dolduysa `capped`; birinden biri `warnPct`'e geldiyse `warn`.
 * Açık paylar (`reservedMicroUsd`) kalanı düşürür ama durumu değiştirmez (geçicidir).
 * Bozuk ya da eksik `orgId`: 400 `sod_context_invalid` (Anthropic biçimi, yeniden denenmez).
 */
export function allowanceRoutes(deps: { prisma: PrismaClient; now?: () => Date }): InternalRoutes {
  const now = deps.now ?? (() => new Date());
  return (scope) => {
    // Testin `internalRoutes` ile önce verdiği aynı adresli yol kalır (G1 testlerinin yer tutucuları); üretimde liste boştur.
    if ((scope.sodRoutes ?? []).includes(`GET ${scope.prefix}/allowance`)) return;
    scope.get('/allowance', async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const q = req.query as Record<string, unknown> | undefined;
      const orgId = typeof q?.orgId === 'string' ? q.orgId.trim() : '';
      if (!ORG_ID_PATTERN.test(orgId) || !req.tool) {
        void reply.headers(aiRejectHeaders('sod_context_invalid'));
        return reply.status(400).send(aiRejectBody('anthropic', 'sod_context_invalid', 'orgId missing or invalid'));
      }
      const at = now();
      const platform = await platformUsage(deps.prisma, at);
      const o = await orgUsage(deps.prisma, orgId, req.tool.product, at);
      const warnAt = (cap: number) => (cap * AI_LIMIT_DEFAULTS.warnPct) / 100;
      const toolCap = o.tool.cap;
      const capped = o.org.used >= o.org.cap || (toolCap !== null && o.tool.used >= toolCap);
      const warn = o.org.used >= warnAt(o.org.cap) || (toolCap !== null && o.tool.used >= warnAt(toolCap));
      const state: AiAllowanceState = platformStopped(platform) ? 'paused' : capped ? 'capped' : warn ? 'warn' : 'ok';
      const body: AiAllowance = {
        period: o.month.period,
        resetsAt: o.month.end.toISOString(),
        capMicroUsd: o.org.cap,
        usedMicroUsd: o.org.used,
        reservedMicroUsd: o.org.reserved,
        remainingMicroUsd: Math.max(0, o.org.cap - o.org.used - o.org.reserved),
        state,
        tool: { product: req.tool.product, capMicroUsd: toolCap, usedMicroUsd: o.tool.used },
      };
      return body;
    });
  };
}
