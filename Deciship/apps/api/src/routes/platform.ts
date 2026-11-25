import { finished, Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { env } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { zonedDate } from '../lib/time.ts';
import { buildActivity } from '../services/hub/activity.ts';
import { buildAiCalls, buildAiCallsXlsx } from '../services/hub/aiCalls.ts';
import { buildAiUsage } from '../services/hub/aiUsage.ts';
import { buildAnalytics } from '../services/hub/analytics.ts';
import { csvHeader, csvRows } from '../services/hub/csv.ts';
import { datasetExport, datasetPage, listDatasets } from '../services/hub/datasets.ts';
import { limited } from '../services/hub/limiter.ts';
import { companySettings } from '../services/hub/metrics.ts';
import { buildOverview } from '../services/hub/overview.ts';
import { parsePeriod } from '../services/hub/period.ts';
import { storageUsage } from '../services/storageQuota.ts';
import { P, hubContext, hubError, type HubGuard } from '../services/hub/types.ts';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Yanıt kişiye ve dile özeldir: paylaşılan önbellekte tutulmaz. */
function personal(reply: FastifyReply) {
  reply.header('Cache-Control', 'private, no-store');
  reply.header('Vary', 'Accept-Language');
}

/**
 * Merkez sözleşmesi (ARCHITECTURE §7, contracts/hub.ts). `/platform/*`; `/api/deciship` önekiyle kaydedilir. Yetki `guard`
 * üzerinden gelir: kapıyı geçemeyene 403, Merkez o bölümü gizler. Alt süzme (para, çalışan adı) servislerdedir.
 */
export async function hubRoutes(app: FastifyInstance, opts: { guard: HubGuard }) {
  const { guard } = opts;

  app.get('/platform/overview', { onRequest: guard(P.reports) }, limited(async (req, reply) => {
    personal(reply);
    const ctx = hubContext(req);
    const { timeZone } = await companySettings(ctx.companyId);
    return buildOverview(ctx, parsePeriod(req.query, ctx, timeZone));
  }));

  app.get('/platform/analytics', { onRequest: guard(P.reports) }, limited(async (req, reply) => {
    personal(reply);
    const ctx = hubContext(req);
    const { timeZone } = await companySettings(ctx.companyId);
    return buildAnalytics(ctx, parsePeriod(req.query, ctx, timeZone), req.query as Record<string, unknown>);
  }));

  app.get('/platform/datasets', { onRequest: guard(P.invoices) }, limited(async (req, reply) => {
    personal(reply);
    return listDatasets(hubContext(req));
  }));

  app.get('/platform/datasets/:id', { onRequest: guard(P.invoices) }, limited(async (req, reply) => {
    personal(reply);
    const { id } = req.params as { id: string };
    return datasetPage(hubContext(req), id, req.query);
  }));

  app.get('/platform/datasets/:id/export', { onRequest: [guard(P.export), guard(P.invoices)] }, limited(async (req, reply) => {
    personal(reply);
    const ctx = hubContext(req);
    const { id } = req.params as { id: string };
    const { columns, total, batches, query, timeZone } = await datasetExport(ctx, id, req.query);
    await audit(ctx.companyId, ctx.userId, 'data.export', 'Dataset', id, { rows: total, q: query.q ?? null, filters: query.filters });
    // İlerlemeyen akış kesilir: okumayan istemci yuvayı ve belleği sonsuza kadar tutmasın.
    const socket = req.raw.socket as (typeof req.raw.socket & { setTimeout?: unknown }) | undefined;
    // Sınama isteğinde (inject) gerçek soket yok.
    if (typeof socket?.setTimeout === 'function') {
      socket.setTimeout(env.hubExportIdleMs, () => socket.destroy());
      finished(reply.raw, () => socket.setTimeout(0));
    }
    // Bir parti eksik gelirse üreteç hata verir: başlık gitmiş olduğundan Fastify bağlantıyı keser, dosya tamamlanmış görünmez.
    async function* chunks() {
      yield csvHeader(columns, ctx.locale);
      for await (const rows of batches()) yield csvRows(columns, rows, ctx.locale, timeZone);
    }
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="deciship-${id}-${zonedDate(ctx.now, timeZone)}.csv"`)
      .send(Readable.from(chunks()));
  }, 'export'));

  app.get('/platform/activity', { onRequest: guard(P.reports) }, limited(async (req, reply) => {
    personal(reply);
    return buildActivity(hubContext(req), req.query as Record<string, unknown>);
  }));

  // Yapay zekâ kullanımı (contracts HubAiUsage): bu dönem ya da `?period=YYYY-MM` (en çok 12 ay geri). Hak, isteğin
  // aboneliğindeki limitten (`aiCreditMonthly`) yoksa ortam varsayılanından. Para alanları fiyat izni olana.
  app.get('/platform/ai-usage', { onRequest: guard(P.settings) }, limited(async (req, reply) => {
    personal(reply);
    const ctx = hubContext(req);
    const { period } = (req.query ?? {}) as { period?: unknown };
    if (period !== undefined && typeof period !== 'string') throw hubError(400, 'VALIDATION', ctx.t('err.filter', { name: 'period' }));
    return buildAiUsage(ctx, period === '' ? undefined : period, req.auth.subscription?.limits ?? {});
  }));

  // Ayrıntılı döküm (contracts HubAiCallPage): çağrı başına satır, `?period=&kind=&member=&page=&pageSize=`. Özetle aynı izin.
  app.get('/platform/ai-usage/calls', { onRequest: guard(P.settings) }, limited(async (req, reply) => {
    personal(reply);
    return buildAiCalls(hubContext(req), (req.query ?? {}) as Record<string, unknown>);
  }));

  // Ayrıntılı dökümün Excel'i: aynı süzgeçler. Dışa aktarma izni ayrıca gerekir (veri seti dışa aktarmasıyla aynı kural).
  app.get('/platform/ai-usage/calls/export', { onRequest: [guard(P.settings), guard(P.export)] }, limited(async (req, reply) => {
    personal(reply);
    const ctx = hubContext(req);
    const { buffer, fileName, period, rows } = await buildAiCallsXlsx(ctx, (req.query ?? {}) as Record<string, unknown>);
    await audit(ctx.companyId, ctx.userId, 'data.export', 'AiUsage', period, { rows });
    return reply.type(XLSX_MIME).header('Content-Disposition', `attachment; filename="${fileName}"`).send(buffer);
  }, 'export'));

  // 06-B6: Merkez Abonelik kartı için dosya alanı kullanımı (ekran sonra)
  app.get('/platform/storage-usage', { onRequest: guard(P.settings) }, limited(async (req, reply) => {
    personal(reply);
    return storageUsage(req.auth.orgId);
  }));
}
