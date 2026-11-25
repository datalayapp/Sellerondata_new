import { readFile } from "node:fs/promises";
import {
  PRINT_API,
  PrintExportRequestSchema,
  PrintGridRequestSchema,
  PrintMarkPrintedSchema,
  PrintPresetCreateSchema,
  PrintPresetPatchSchema,
  PrintAddJobsSchema,
  PrintReplanSchema,
  PrintReprintSchema,
  PrintSessionCreateSchema,
  PrintSessionListQuerySchema,
  PrintSessionPatchSchema,
  PrintTemplateArchiveSchema,
  PrintTemplateCreateSchema,
  PrintTemplateDuplicateSchema,
  PrintTemplatePatchSchema,
} from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { fail, parseBody } from "../util/errors.ts";
import { sendPng } from "./templates.ts";

type Id = { Params: { id: string } };
const flag = (v: unknown) => v === "1" || v === "true" || v === true;
const lang = (q: { languageId?: string }) => {
  if (!q.languageId) throw fail("language-id-required");
  return q.languageId;
};

/** Baskı masası: sayfa şablonları, ön ayarlar, raf, oturumlar, önizleme ve çıktı. */
export function printRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { printTemplates: templates, printShelf: shelf, printSessions: sessions, printExports: exports } = ctx;

  // ---------------------------------------------------------------- şablonlar
  app.get<{ Querystring: { languageId?: string; archived?: string } }>(PRINT_API.templates, async (req) => ({
    templates: templates.list(lang(req.query), flag(req.query.archived)),
  }));
  app.post(PRINT_API.templates, async (req) => templates.create(parseBody(PrintTemplateCreateSchema, req.body)));
  app.post(PRINT_API.templateGrid, async (req) => templates.grid(parseBody(PrintGridRequestSchema, req.body)));
  app.get<Id>(PRINT_API.template, async (req) => templates.get(req.params.id));
  app.patch<Id>(PRINT_API.template, async (req) => templates.update(req.params.id, parseBody(PrintTemplatePatchSchema, req.body)));
  app.delete<Id>(PRINT_API.template, async (req) => templates.remove(req.params.id));
  app.post<Id>(PRINT_API.templateArchive, async (req) => templates.archive(req.params.id, parseBody(PrintTemplateArchiveSchema, req.body).archived));
  app.post<Id>(PRINT_API.templateDuplicate, async (req) => templates.duplicate(req.params.id, parseBody(PrintTemplateDuplicateSchema, req.body).name));

  // ---------------------------------------------------------------- ön ayarlar
  app.get<{ Querystring: { languageId?: string } }>(PRINT_API.presets, async (req) => ({ presets: templates.presets(lang(req.query)) }));
  app.post(PRINT_API.presets, async (req) => templates.createPreset(parseBody(PrintPresetCreateSchema, req.body)));
  app.patch<Id>(PRINT_API.preset, async (req) => templates.updatePreset(req.params.id, parseBody(PrintPresetPatchSchema, req.body)));
  app.delete<Id & { Querystring: { languageId?: string } }>(PRINT_API.preset, async (req) => {
    templates.deletePreset(lang(req.query), req.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- raf
  app.get<{ Querystring: { languageId?: string } }>(PRINT_API.shelf, async (req) => {
    const id = ctx.languages.get(lang(req.query)).id;
    return { items: shelf.list(id) };
  });

  // ---------------------------------------------------------------- oturumlar
  app.get(PRINT_API.sessions, async (req) => ({ sessions: sessions.list(parseBody(PrintSessionListQuerySchema, req.query, "query-invalid")) }));
  app.post(PRINT_API.sessions, async (req) => {
    const body = parseBody(PrintSessionCreateSchema, req.body);
    ctx.languages.get(body.languageId);
    return sessions.create(body);
  });
  app.get<Id>(PRINT_API.session, async (req) => sessions.detail(req.params.id));
  app.patch<Id>(PRINT_API.session, async (req) => {
    const body = parseBody(PrintSessionPatchSchema, req.body);
    return sessions.patch(req.params.id, body.version, body.ops);
  });
  app.delete<Id>(PRINT_API.session, async (req) => sessions.remove(req.params.id));
  app.post<Id>(PRINT_API.sessionReplan, async (req) => sessions.replan(req.params.id, parseBody(PrintReplanSchema, req.body).version));
  app.post<Id>(PRINT_API.sessionAddJobs, async (req) => {
    const body = parseBody(PrintAddJobsSchema, req.body);
    return sessions.addJobs(req.params.id, body.version, body.jobIds);
  });
  app.post<Id>(PRINT_API.sessionPrinted, async (req) => {
    const body = parseBody(PrintMarkPrintedSchema, req.body);
    return sessions.markPrinted(req.params.id, body.printed, body.version);
  });
  app.post<Id>(PRINT_API.sessionReprint, async (req) => sessions.reprint(req.params.id, parseBody(PrintReprintSchema, req.body).name));

  // ---------------------------------------------------------------- önizleme ve çıktı
  app.get<Id & { Querystring: { w?: string } }>(PRINT_API.pagePreview, async (req, reply) => {
    const w = req.query.w ? Math.round(Number(req.query.w)) : 480;
    if (!Number.isFinite(w) || w < 32 || w > 4000) throw fail("preview-width-range");
    return sendPng(reply, await exports.pagePng(req.params.id, w), "no-cache");
  });
  app.post<Id>(PRINT_API.sessionExport, async (req, reply) => reply.code(202).send(exports.start(req.params.id, parseBody(PrintExportRequestSchema, req.body))));
  app.get<Id>(PRINT_API.export, async (req) => exports.get(req.params.id));
  app.get<{ Params: { id: string; index: string } }>(PRINT_API.exportFile, async (req, reply) => {
    const f = exports.file(req.params.id, Number(req.params.index));
    return reply
      .type(f.mime)
      .header("content-disposition", `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header("cache-control", "no-cache")
      .send(await readFile(f.path));
  });
}
