import { API, LearnReplayRequestSchema, LearnRunRequestSchema } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { parseBody } from "../util/errors.ts";
import { sendPng } from "./templates.ts";

type Lang = { Params: { lang: string } };
type Id = { Params: { id: string } };

const Source = z.enum(["draft", "published"]);
const Width = z.coerce.number().int().min(32).max(1200).optional();

/**
 * Öğrenme uçları: koşu (arka plan + SSE `learn`), öneriyi uygula/reddet/geri al, ölçüm özeti, örnekler,
 * motor denemesi (AI'sız) ve görseller. Öneri CRUD'u `references.ts`'te.
 */
export function learnRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { languages, learning } = ctx;
  const lang = (id: string) => languages.get(id).id;

  app.post<Lang>(API.learnRun, async (req, reply) => {
    const r = learning.run(lang(req.params.lang), parseBody(LearnRunRequestSchema, req.body, "learn-request-invalid"));
    return reply.code(202).send(r);
  });
  app.get<Lang>(API.learnRun, async (req) => learning.latestRun(lang(req.params.lang)));
  app.delete<Lang>(API.learnRun, async (req) => learning.cancel(lang(req.params.lang)));

  app.post<Id>(API.learnApply, async (req) => learning.apply(req.params.id));
  app.post<Id>(API.learnReject, async (req) => learning.reject(req.params.id));
  app.post<Id>(API.learnRevert, async (req) => learning.revert(req.params.id));

  app.get<Lang & { Querystring: { source?: string } }>(API.learnMeasure, async (req) =>
    learning.measure(lang(req.params.lang), parseBody(Source, req.query.source ?? "published", "source-invalid")),
  );
  app.get<Lang & { Querystring: Record<string, string | undefined> }>(API.learnSamples, async (req) => {
    const q = parseBody(
      z.object({
        limit: z.coerce.number().int().min(1).max(60).optional(),
        template: z.string().min(1).optional(),
        split: z.enum(["train", "test"]).optional(),
        w: Width,
      }),
      req.query,
      "query-invalid",
    );
    return learning.samples(lang(req.params.lang), q);
  });
  app.post<Lang>(API.learnReplay, async (req) => learning.replay(lang(req.params.lang), parseBody(LearnReplayRequestSchema, req.body, "replay-request-invalid")));

  app.get<{ Params: { dir: string; file: string } }>(API.learnPreview, async (req, reply) =>
    sendPng(reply, await readFile(learning.previewPath(req.params.dir, req.params.file)), "private, max-age=86400"),
  );
  app.get<Id & { Querystring: { w?: string; template?: string } }>(API.learnReferenceThumb, async (req, reply) => {
    const q = parseBody(z.object({ w: Width, template: z.enum(["0", "1"]).optional() }), req.query, "query-invalid");
    return sendPng(reply, await learning.referenceImage(req.params.id, { ...(q.w ? { w: q.w } : {}), template: q.template === "1" }));
  });
  app.get<{ Params: { lang: string; key: string }; Querystring: { w?: string } }>(API.learnTemplateThumb, async (req, reply) => {
    const q = parseBody(z.object({ w: Width }), req.query, "query-invalid");
    return sendPng(reply, await learning.templateThumb(lang(req.params.lang), req.params.key, q.w ?? 200), "private, max-age=300");
  });
}
