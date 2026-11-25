import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAny } from '../lib/access.ts';
import { cancelJob, jobView, listJobs } from '../services/jobs/queue.ts';
import { JOB_KIND_LIST, JOB_REF_TYPES, type JobListQuery } from '../services/jobs/types.ts';

/**
 * Arka plan işleri (Mesaj 7, plan §4.9). Uç izni üç izinden biridir; işin kendi türünün izni işleyicide denetlenir (yoksa 404).
 * Gövdeler `services/jobs/queue.ts` (`listJobs`, `jobView`, `cancelJob`). Yanıttaki para alanları fiyat izni olmayana
 * `app.ts` `preSerialization` kancasıyla gitmez (`result` içi dahil).
 */

const flag = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');

/** `GET /jobs` sorgusu: `?active=1&kind=K&refType=T&refId=X&mine=1`. */
export const jobListQuery = z.object({
  active: flag.optional(),
  kind: z.enum(JOB_KIND_LIST).optional(),
  refType: z.enum(JOB_REF_TYPES).optional(),
  refId: z.string().min(1).max(200).optional(),
  mine: flag.optional(),
}) satisfies z.ZodType<JobListQuery, unknown>;

export const jobIdParam = z.object({ jobId: z.string().min(1).max(200) });

export async function jobRoutes(app: FastifyInstance) {
  const jobs = { onRequest: requireAny(app, ['deciship.invoices.upload', 'deciship.tariffs.edit', 'deciship.settings.manage']) };

  app.get('/jobs', jobs, async (req) => {
    return listJobs(req, jobListQuery.parse(req.query));
  });

  app.get('/jobs/:jobId', jobs, async (req) => {
    const { jobId } = jobIdParam.parse(req.params);
    return jobView(req, jobId);
  });

  // Salt okunur abonelikte kapalı (varsayılan): durdurma durum değiştirir.
  app.post('/jobs/:jobId/cancel', jobs, async (req) => {
    const { jobId } = jobIdParam.parse(req.params);
    return cancelJob(req, jobId);
  });
}
