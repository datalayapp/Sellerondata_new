import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  API,
  type TemplateCutPreviewResponse,
  TemplateCutPreviewRequestSchema,
  TemplatePatchSchema,
  UploadFontSchema,
  UploadTemplateSchema,
} from "@tagpress/domain";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context.ts";
import { fail, parseBody } from "../util/errors.ts";
import { fromBase64 } from "../util/text.ts";

type Lang = { Params: { lang: string } };
type Key = { Params: { lang: string; key: string } };

export const sendPng = (reply: FastifyReply, buf: Buffer, cache = "no-cache") => reply.type("image/png").header("cache-control", cache).send(buf);

/** Şablonlar ve fontlar (tasarım dili altında). */
export function templateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { languages, templates, fonts, profiles, ports, jobs, cutChange } = ctx;
  const lang = (id: string) => languages.get(id).id;

  app.get<Lang>(API.templates, async (req) => ({ templates: templates.list(lang(req.params.lang)) }));
  app.post<Lang>(API.templates, async (req) => {
    const body = parseBody(UploadTemplateSchema, req.body);
    const id = lang(req.params.lang);
    const r = await templates.upload(id, { key: body.key, fileName: body.fileName, png: fromBase64(body.png), kind: body.kind });
    revalidateTemplateJobs(ctx, id, [r.item.template.key]);
    return r.item;
  });
  app.post<Lang>(API.templatesSync, async (req) => {
    const id = lang(req.params.lang);
    const r = await templates.sync(id);
    // Şablonu değişen/kaybolan işlerin sorunları yeniden hesaplanır.
    const changed = [...r.added, ...r.missing];
    if (changed.length) revalidateTemplateJobs(ctx, id, changed);
    return r;
  });
  app.get<Key>(API.template, async (req) => templates.get(lang(req.params.lang), req.params.key));
  app.patch<Key>(API.template, async (req) => templates.update(lang(req.params.lang), req.params.key, parseBody(TemplatePatchSchema, req.body)));
  // Kaydetmeden önce: kesim değişirse kaç onaylı iş yeniden kontrol isteyecek (kayda yazmaz; PATCH'le aynı birleştirme).
  app.post<Key>(API.templateCutPreview, async (req): Promise<TemplateCutPreviewResponse> => {
    const id = lang(req.params.lang);
    const body = parseBody(TemplateCutPreviewRequestSchema, req.body);
    const { before, after } = templates.merged(id, req.params.key, { cut: body.cut });
    const profile = profiles.active(id)?.data;
    if (!profile) return { changed: false, approvals: 0 };
    const p = cutChange.preview(id, req.params.key, before, after, profile);
    return { changed: p.changed, approvals: p.jobIds.length };
  });
  app.get<Key>(API.templateImage, async (req, reply) => {
    const id = lang(req.params.lang);
    const t = templates.find(id, req.params.key);
    const file = t && templates.imagePath(id, t);
    if (!file || !existsSync(file)) throw fail("template-image-not-found");
    return sendPng(reply, await readFile(file), "private, max-age=300");
  });
  app.get<Key>(API.templateOverlay, async (req, reply) => {
    const id = lang(req.params.lang);
    const t = templates.find(id, req.params.key);
    if (!t) throw fail("template-not-found");
    if (!ports.geometry?.overlay) throw fail("overlay-unavailable");
    const imagePath = templates.imagePath(id, t);
    if (!existsSync(imagePath)) throw fail("template-image-not-found");
    return sendPng(reply, await ports.geometry.overlay({ template: t, imagePath, profile: profiles.activeProfile(id).profile }));
  });

  app.get<Lang>(API.fonts, async (req) => {
    const id = lang(req.params.lang);
    return fonts.list(id, profiles.activeProfile(id).profile);
  });
  app.post<Lang>(API.fonts, async (req) => {
    const id = lang(req.params.lang);
    const body = parseBody(UploadFontSchema, req.body);
    const file = await fonts.upload(id, body.fileName, fromBase64(body.data));
    const list = await fonts.list(id, profiles.activeProfile(id).profile);
    // Yeni font kapsamı değiştirebilir: dilin işleri yeniden denetlenir.
    jobs.revalidate(jobs.idsOfLanguage(id));
    return list.files.find((f) => f.file === file && f.scope === "language")!;
  });
  app.get<{ Params: { lang: string; file: string }; Querystring: { scope?: string; text?: string } }>(API.fontSpecimen, async (req, reply) => {
    const id = lang(req.params.lang);
    const scope = req.query.scope === "shared" ? "shared" : "language";
    const file = fonts.file(id, scope, req.params.file);
    const cat = ports.fontCatalog;
    if (!cat?.specimen) throw fail("specimen-unavailable");
    return sendPng(reply, await cat.specimen(file, (req.query.text ?? "").slice(0, 80) || "Anna & Marco 12.10.2026", 48));
  });
}

/** Belirli şablonları kullanan işlerin içe aktarma sorunlarını yeniden hesaplar. */
export function revalidateTemplateJobs(ctx: AppContext, languageId: string, keys: string[]): void {
  const ph = keys.map(() => "?").join(",");
  const ids = ctx.tdb
    .prepare(
      `SELECT j.id FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org WHERE j.org_id = $org AND b.language_id = ? AND j.deleted_at IS NULL AND j.template_key IN (${ph})`,
    )
    .all(languageId, ...keys) as { id: string }[];
  ctx.jobs.revalidate(ids.map((r) => r.id));
}
