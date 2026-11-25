import {
  FeaturesPatchBodySchema,
  SETUP_API,
  SetupAnswersPutBodySchema,
  SetupCompleteBodySchema,
  SetupPreviewBodySchema,
} from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { parseBody } from "../util/errors.ts";

/** Özellik anahtarları ve kurulum (`SETUP_API`, SUNUCU-PLANI §3.4). Hepsi geçerli firma kapsamında. */
export function setupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { features, setup } = ctx;

  app.get(SETUP_API.featuresGet.path, async () => features.view());
  app.patch(SETUP_API.featuresPatch.path, async (req) => features.toggle(parseBody(FeaturesPatchBodySchema, req.body, "feature-invalid"), "user").view);

  app.get(SETUP_API.setupGet.path, async () => setup.state());
  app.post(SETUP_API.preview.path, async (req) => setup.preview(parseBody(SetupPreviewBodySchema, req.body, "setup-invalid").answers));
  app.put(SETUP_API.answers.path, async (req) => {
    const body = parseBody(SetupAnswersPutBodySchema, req.body, "setup-invalid");
    return setup.saveAnswers(body.step, body.answers);
  });
  app.post(SETUP_API.complete.path, async (req) => {
    const body = parseBody(SetupCompleteBodySchema, req.body, "setup-invalid");
    return setup.complete(body.answers, body.features);
  });
  app.post(SETUP_API.skip.path, async () => setup.skip());
  app.post(SETUP_API.restart.path, async () => setup.restart());
}
