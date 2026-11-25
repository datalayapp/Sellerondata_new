import { API, LearnProposalInputSchema, LearnProposalPatchSchema, ReferenceInputSchema, ReferencePatchSchema } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { parseBody } from "../util/errors.ts";

type Id = { Params: { id: string } };

/** Referanslar ve öğrenme önerileri (CRUD). */
export function referenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { references, learn, languages } = ctx;

  app.get<{ Querystring: { languageId?: string; split?: string } }>(API.references, async (req) => ({
    references: references.list({ languageId: req.query.languageId || undefined, split: req.query.split || undefined }),
  }));
  app.post(API.references, async (req) => {
    const body = parseBody(ReferenceInputSchema, req.body, "reference-invalid");
    return references.save({ ...body, languageId: languages.resolve(body.languageId) });
  });
  app.get<Id>(API.reference, async (req) => references.get(req.params.id));
  app.patch<Id>(API.reference, async (req) => references.update(req.params.id, parseBody(ReferencePatchSchema, req.body)));
  app.delete<Id>(API.reference, async (req) => {
    references.remove(req.params.id);
    return { ok: true };
  });

  app.get<{ Querystring: { languageId?: string; status?: string } }>(API.learnProposals, async (req) => ({
    proposals: learn.list({ languageId: req.query.languageId || undefined, status: req.query.status || undefined }),
  }));
  app.post(API.learnProposals, async (req) => {
    const body = parseBody(LearnProposalInputSchema, req.body, "proposal-invalid");
    return learn.create({ ...body, languageId: languages.resolve(body.languageId) });
  });
  app.get<Id>(API.learnProposal, async (req) => learn.get(req.params.id));
  app.patch<Id>(API.learnProposal, async (req) => learn.update(req.params.id, parseBody(LearnProposalPatchSchema, req.body)));
  app.delete<Id>(API.learnProposal, async (req) => {
    learn.remove(req.params.id);
    return { ok: true };
  });
}
