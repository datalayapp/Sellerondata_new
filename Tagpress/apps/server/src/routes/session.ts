import { API, DesignDraftWriteSchema, DesignSessionEntryInputSchema, DesignSessionStartSchema } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { parseBody } from "../util/errors.ts";

type Lang = { Params: { lang: string } };

/** Tasarım dili oluşturma oturumu (Claude Code becerisi + MCP): günlük ve taslak yazımı. SSE: `session`. */
export function sessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { languages, designSessions } = ctx;
  const lang = (id: string) => languages.get(id).id;

  app.get<Lang>(API.designSession, async (req) => designSessions.current(lang(req.params.lang)));
  app.post<Lang>(API.designSession, async (req) => designSessions.start(lang(req.params.lang), parseBody(DesignSessionStartSchema, req.body, "session-invalid").title));
  app.post<Lang>(API.designSessionEntries, async (req) => designSessions.add(lang(req.params.lang), parseBody(DesignSessionEntryInputSchema, req.body, "session-entry-invalid")));
  app.post<Lang>(API.designSessionDraft, async (req) => {
    const body = parseBody(DesignDraftWriteSchema, req.body, "draft-patch-invalid");
    return designSessions.writeDraft(lang(req.params.lang), body.patch, body.note);
  });
}
