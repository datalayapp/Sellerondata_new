import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  API,
  ApproveSchema,
  BulkJobPatchSchema,
  CancelGenerationSchema,
  GenerateRequestSchema,
  IdsSchema,
  ImportCommitRequestSchema,
  ImportPreviewRequestSchema,
  ImportValidateRequestSchema,
  JobListQuerySchema,
  JobPatchSchema,
  ManualJobSchema,
  RenameBatchSchema,
  ReviseRequestSchema,
  VariantPatchSchema,
} from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { canSeeAmounts } from "../org/access.ts";
import { listJobs } from "../services/jobs/query.ts";
import { fail, parseBody } from "../util/errors.ts";
import { sendPng } from "./templates.ts";

type Id = { Params: { id: string } };

/** İçe aktarma, işler, partiler, varyasyonlar, üretim. */
export function jobRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { importer, jobs, batches, variants, undo, generation, queue, progress, costs } = ctx;

  app.post(API.importPreview, async (req) => importer.preview(parseBody(ImportPreviewRequestSchema, req.body)));
  app.post(API.importValidate, async (req) => importer.validate(parseBody(ImportValidateRequestSchema, req.body)));
  app.post(API.importCommit, async (req) => importer.commit(parseBody(ImportCommitRequestSchema, req.body)));

  app.get(API.jobs, async (req) => {
    const list = listJobs(ctx.tdb, parseBody(JobListQuerySchema, req.query, "query-invalid"));
    return { jobs: list, total: list.length };
  });
  app.post(API.jobsManual, async (req) => {
    // Üretim başlatılamadıysa iş yine açılır; neden yanıtta (`notQueued`, web bildirimi).
    const r = importer.manual(parseBody(ManualJobSchema, req.body));
    return r.notQueued ? { ...r.job, notQueued: r.notQueued } : r.job;
  });
  app.post(API.jobsBulk, async (req) => {
    const body = parseBody(BulkJobPatchSchema, req.body);
    return { jobs: body.ids.map((id) => jobs.update(id, body.patch)) };
  });
  app.post(API.jobsDelete, async (req) => undo.deleteJobs(parseBody(IdsSchema, req.body).ids));
  app.post(API.jobsApproveBest, async (req) => jobs.approveBest(parseBody(IdsSchema, req.body).ids));
  app.get<Id>(API.job, async (req) => jobs.get(req.params.id));
  app.patch<Id>(API.job, async (req) => jobs.update(req.params.id, parseBody(JobPatchSchema, req.body)));
  app.delete<Id>(API.job, async (req) => undo.deleteJobs([jobs.require(req.params.id).id]));
  app.post<Id>(API.jobApprove, async (req) => jobs.approve(req.params.id, parseBody(ApproveSchema, req.body).variantId));
  app.get<Id>(API.jobLog, async (req) => {
    jobs.require(req.params.id);
    // Platformda çağrıların tutarı yalnız Yöneticiye (`org/access.ts`); diğerine `costUsd: null` (çağrılar görünür).
    const calls = costs.forJob(req.params.id);
    const aiCalls = canSeeAmounts() ? calls : calls.map((c) => ({ ...c, costUsd: null }));
    return { steps: progress.list(req.params.id), aiCalls, running: queue.status().runningJobIds.includes(req.params.id) };
  });

  app.get<{ Querystring: { languageId?: string } }>(API.batches, async (req) => ({ batches: batches.list(req.query.languageId || undefined) }));
  app.patch<Id>(API.batch, async (req) => batches.rename(req.params.id, parseBody(RenameBatchSchema, req.body).name));
  app.delete<Id>(API.batch, async (req) => undo.deleteBatch(req.params.id));

  app.get<Id>(API.variant, async (req) => variants.get(req.params.id));
  app.patch<Id>(API.variant, async (req) => {
    const body = parseBody(VariantPatchSchema, req.body);
    return body.suspect === undefined ? variants.get(req.params.id) : variants.setSuspect(req.params.id, body.suspect);
  });
  app.delete<Id>(API.variant, async (req) => undo.deleteVariant(req.params.id));
  app.get<Id>(API.variantPreview, async (req, reply) => {
    const v = variants.row(req.params.id, true);
    const file = v && variants.previewPath(v);
    if (!file || !existsSync(file)) throw fail("preview-not-found");
    return sendPng(reply, await readFile(file), "private, max-age=31536000, immutable");
  });
  app.get<Id>(API.variantTextLayer, async (req, reply) => {
    const v = variants.row(req.params.id, true);
    const file = v && variants.textLayerPath(v);
    if (!file || !existsSync(file)) throw fail("text-layer-not-found");
    return sendPng(reply, await readFile(file), "private, max-age=31536000, immutable");
  });
  app.post<Id>(API.variantRevise, async (req) => generation.revise(req.params.id, parseBody(ReviseRequestSchema, req.body).request));

  app.post(API.generate, async (req) => generation.enqueue(parseBody(GenerateRequestSchema, req.body)));
  app.post(API.generateCancel, async (req) => ({ cancelled: queue.cancel(parseBody(CancelGenerationSchema, req.body).jobIds) }));
  app.get(API.generateStatus, async () => queue.status());
}
