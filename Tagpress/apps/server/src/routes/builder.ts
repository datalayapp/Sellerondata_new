import { BUILDER_API, BUILD_STREAM, type BuildStreamEvent, isBuildRunning } from "@tagpress/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AppContext } from "../context.ts";
import { streamOwner } from "../events.ts";
import { parseBody } from "../util/errors.ts";

/**
 * Sitede tasarım dili oluşturucu uçları (`BUILDER_API`, SUNUCU-PLANI §4.9). Yollar, gövde/sorgu şemaları ve başarı
 * kodları sözleşmeden; iş kuralı `services/builder/service.ts`'te. Özellik kapısı (`language.builder`) uç tablosundan
 * (`features/route-map.ts`), firma ayrımı servisin SQL'inde.
 */
export function builderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const b = ctx.builder;
  const A = BUILDER_API;
  const params = <S extends z.ZodType>(schema: S, req: FastifyRequest) => parseBody(schema, req.params, "request-invalid") as z.output<S>;
  const query = <S extends z.ZodType>(schema: S, req: FastifyRequest) => parseBody(schema, req.query, "request-invalid") as z.output<S>;
  const body = <S extends z.ZodType>(schema: S, req: FastifyRequest) => parseBody(schema, req.body, "request-invalid") as z.output<S>;
  const png = (reply: FastifyReply, buf: Buffer) => reply.type("image/png").header("cache-control", "no-cache").send(buf);
  type Id = { id: string };

  app.post(A.estimate.path, async (req) => b.estimate(body(A.estimate.body, req)));
  app.post(A.createBuild.path, async (req, reply) => reply.code(201).send(b.create(params(A.createBuild.params, req).lang, body(A.createBuild.body, req))));
  app.get(A.currentBuild.path, async (req) => b.current(params(A.currentBuild.params, req).lang));
  app.get(A.getBuild.path, async (req) => b.get(params(A.getBuild.params, req).id));
  app.get(A.listMessages.path, async (req) => b.messages(params(A.listMessages.params, req).id, query(A.listMessages.query, req)));
  app.post(A.postMessage.path, async (req, reply) => {
    const r = b.postMessage(params(A.postMessage.params, req).id, body(A.postMessage.body, req));
    return reply.code(r.status).send(r.body);
  });
  app.put(A.putIntake.path, async (req) => b.putIntake(params(A.putIntake.params, req).id, body(A.putIntake.body, req)));
  app.post(A.uploadSamples.path, async (req) => b.uploadSamples(params(A.uploadSamples.params, req).id, body(A.uploadSamples.body, req)));
  app.patch(A.patchSample.path, async (req) => {
    const p = params(A.patchSample.params, req);
    return b.patchSample(p.id, p.sid, body(A.patchSample.body, req));
  });
  app.delete(A.deleteSample.path, async (req) => {
    const p = params(A.deleteSample.params, req);
    return b.deleteSample(p.id, p.sid);
  });
  app.get(A.sampleImage.path, async (req, reply) => {
    const p = params(A.sampleImage.params, req);
    return png(reply, await b.sampleImage(p.id, p.sid, query(A.sampleImage.query, req).w));
  });
  app.post(A.skipSamples.path, async (req, reply) => reply.code(202).send(b.skipSamples(params(A.skipSamples.params, req).id)));
  app.post(A.analyze.path, async (req, reply) => reply.code(202).send(b.analyze(params(A.analyze.params, req).id)));
  app.post(A.cancel.path, async (req) => b.cancel(params(A.cancel.params, req).id));
  app.post(A.resume.path, async (req, reply) => reply.code(202).send(b.resume(params(A.resume.params, req).id)));
  app.post(A.raiseBudget.path, async (req) => b.raiseBudget(params(A.raiseBudget.params, req).id));
  app.get<{ Params: Id }>(A.stream.path, (req, reply) => stream(ctx, req, reply));
  app.get(A.revisions.path, async (req) => b.revisions(params(A.revisions.params, req).id));
  app.get(A.revision.path, async (req) => {
    const p = params(A.revision.params, req);
    return b.revision(p.id, p.rev);
  });
  app.get(A.diff.path, async (req) => {
    const q = query(A.diff.query, req);
    return b.diff(params(A.diff.params, req).id, q.from, q.to);
  });
  app.get(A.showcase.path, async (req) => {
    const p = params(A.showcase.params, req);
    return b.showcase(p.id, p.rev, query(A.showcase.query, req).locale);
  });
  app.get(A.showcaseImage.path, async (req, reply) => {
    const p = params(A.showcaseImage.params, req);
    return png(reply, await b.showcaseImage(p.id, p.rev, p.item));
  });
  app.post(A.tryText.path, async (req) => b.tryText(params(A.tryText.params, req).id, body(A.tryText.body, req)));
  app.post(A.restore.path, async (req) => b.restore(params(A.restore.params, req).id, body(A.restore.body, req)));
  app.post(A.publish.path, async (req) => b.publishBuild(params(A.publish.params, req).id, body(A.publish.body, req)));
  app.get(A.quality.path, async (req) => b.quality(params(A.quality.params, req).id, query(A.quality.query, req).rev));
  app.post(A.qualityAi.path, async (req) => b.qualityAi(params(A.qualityAi.params, req).id, body(A.qualityAi.body, req)));
  app.post(A.close.path, async (req) => b.close(params(A.close.params, req).id));
  app.post(A.languageShowcase.path, async (req) => b.languageShowcase(params(A.languageShowcase.params, req).lang, body(A.languageShowcase.body, req)));
}

/**
 * Oturum akışı (SSE). Oturum isteğin firmasında aranır (yoksa 404, akış açılmaz). `Last-Event-ID` bu açılışa aitse ve
 * tampondaysa kaçırılan olaylar sırayla; değilse önce anlık `status` (kimliksiz) gelir. 15 sn'de bir yorum satırı. Jeton
 * bitince, üye çıkarılınca ya da firma kapanınca sunucu kapatır (istemci yeniden bağlanır, `Last-Event-ID` ile sürer).
 */
async function stream(ctx: AppContext, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
  const id = parseBody(BUILDER_API.stream.params, req.params, "request-invalid").id;
  const b = ctx.builder;
  const row = b.store.row(id);
  const res = reply.raw;
  reply.hijack();
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...corsOf(reply),
  });
  const write = (event: BuildStreamEvent, eventId: string | null) => res.write(`${eventId ? `id: ${eventId}\n` : ""}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.write("retry: 2000\n\n");
  const lastId = (req.headers["last-event-id"] as string | undefined) ?? null;
  const sub = b.streams.subscribe(id, lastId, (item) => write(item.event, item.id));
  if (sub.resumed) for (const item of sub.replay) write(item.event, item.id);
  else write({ type: "status", state: row.state, resumeState: row.state === "interrupted" || row.state === "failed" ? row.resume_state : null, running: isBuildRunning(row.state), lastEntryId: b.store.lastEntryId(id) }, null);
  const beat = setInterval(() => res.write(": canli\n\n"), BUILD_STREAM.heartbeatMs);
  beat.unref();
  let unregister: () => void = () => undefined;
  const close = () => {
    clearInterval(beat);
    sub.off();
    unregister();
  };
  // Jeton bitince, üye çıkarılınca ya da firma kapanınca akış kapanır (R1; `platform/live-streams.ts`).
  unregister = ctx.liveStreams.register(streamOwner(req, ctx.tenancy.orgId("builder.stream")), () => {
    close();
    res.end();
  });
  req.raw.on("close", close);
  res.on("error", close);
}

/** Güvenlik kancasının yazdığı CORS başlıkları (hijack sonrası el ile). */
function corsOf(reply: FastifyReply): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(reply.getHeaders())) if (k.startsWith("access-control-") || k === "vary") out[k] = String(v);
  return out;
}
