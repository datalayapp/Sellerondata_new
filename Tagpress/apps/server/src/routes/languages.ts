import {
  API,
  CreateLanguageSchema,
  PROFILE_DOCS,
  PublishSchema,
  RenameLanguageSchema,
  RevertProfileSchema,
  SaveDraftSchema,
} from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { parseBody } from "../util/errors.ts";

type Lang = { Params: { lang: string } };

/** Tasarım dilleri ve profil sürümleri. */
export function languageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { languages, profiles, undo } = ctx;

  app.get(API.languages, async () => ({ languages: languages.list() }));
  app.post(API.languages, async (req) => languages.create(parseBody(CreateLanguageSchema, req.body)));
  app.patch<Lang>(API.language, async (req) => languages.rename(req.params.lang, parseBody(RenameLanguageSchema, req.body).name));
  app.delete<Lang>(API.language, async (req) => {
    languages.softDelete(req.params.lang);
    return undo.languageDeleted(req.params.lang);
  });
  app.post<Lang>(API.languageDefault, async (req) => languages.setDefault(req.params.lang));

  app.get(API.profileDocs, async () => ({ docs: PROFILE_DOCS }));
  app.get<Lang>(API.profile, async (req) => {
    languages.get(req.params.lang);
    return profiles.active(req.params.lang);
  });
  app.get<Lang>(API.profileDraft, async (req) => {
    languages.get(req.params.lang);
    return profiles.draft(req.params.lang);
  });
  app.put<Lang>(API.profileDraft, async (req) => {
    languages.get(req.params.lang);
    const body = parseBody(SaveDraftSchema, req.body);
    return profiles.saveDraft(req.params.lang, body.data, body.note);
  });
  app.delete<Lang>(API.profileDraft, async (req) => {
    profiles.discardDraft(languages.get(req.params.lang).id);
    return { ok: true };
  });
  // Yeni etkin profil (boyutlar, sticker sayfaları, satır sınırları) işlerin sorunlarını değiştirebilir.
  const revalidate = (id: string) => ctx.jobs.revalidate(ctx.jobs.idsOfLanguage(id));
  app.post<Lang>(API.profilePublish, async (req) => {
    const r = profiles.publish(languages.get(req.params.lang).id, parseBody(PublishSchema, req.body).note);
    revalidate(r.languageId);
    return r;
  });
  app.get<Lang>(API.profileVersions, async (req) => ({ versions: profiles.versions(languages.get(req.params.lang).id) }));
  app.get<{ Params: { lang: string; version: string } }>(API.profileVersion, async (req) =>
    profiles.version(languages.get(req.params.lang).id, parseBody(z.coerce.number().int().positive(), req.params.version, "version-invalid")),
  );
  app.get<Lang & { Querystring: { from?: string; to?: string } }>(API.profileDiff, async (req) => {
    const q = parseBody(z.object({ from: z.coerce.number().int().positive(), to: z.coerce.number().int().positive() }), req.query, "version-range-invalid");
    return profiles.diff(languages.get(req.params.lang).id, q.from, q.to);
  });
  app.post<Lang>(API.profileRevert, async (req) => {
    const body = parseBody(RevertProfileSchema, req.body);
    const r = profiles.revert(languages.get(req.params.lang).id, body.version, body.note);
    revalidate(r.languageId);
    return r;
  });
}
