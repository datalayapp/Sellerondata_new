import { API, AdjustRelayoutRequestSchema, VariantAdjustRequestSchema } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { parseBody } from "../util/errors.ts";

type Id = { Params: { id: string } };

/** Hafif düzeltme: düzenleme modeli, yazı katmanı, elle metin/font ölçümü, hızlı denetim, kaydet/kaldır. */
export function adjustRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { adjust } = ctx;
  app.get<Id>(API.variantEdit, async (req) => adjust.editModel(req.params.id));
  app.get<Id>(API.variantEditText, async (req, reply) => {
    const svg = await adjust.textSvg(req.params.id);
    // Düzeltmesiz yerleşim varyasyon boyunca değişmez.
    return reply.type("image/svg+xml; charset=utf-8").header("cache-control", "private, max-age=3600").send(svg);
  });
  app.post<Id>(API.variantEditRelayout, async (req) => adjust.relayout(req.params.id, parseBody(AdjustRelayoutRequestSchema, req.body).edits));
  app.post<Id>(API.variantAdjustCheck, async (req) => adjust.check(req.params.id, parseBody(VariantAdjustRequestSchema, req.body).adjust));
  app.put<Id>(API.variantAdjust, async (req) => adjust.save(req.params.id, parseBody(VariantAdjustRequestSchema, req.body).adjust));
  app.delete<Id>(API.variantAdjust, async (req) => adjust.remove(req.params.id));
}
