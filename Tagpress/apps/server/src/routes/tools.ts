import { readFile } from "node:fs/promises";
import {
  API,
  AiProviderSchema,
  GenerateTemplateRequestSchema,
  LanguageImportRequestSchema,
  MODELS,
  ProfileTryRequestSchema,
  SuggestAreaRequestSchema,
  TemplateTryRequestSchema,
} from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { canSeeAmounts } from "../org/access.ts";
import { fail, parseBody } from "../util/errors.ts";
import { sendPng } from "./templates.ts";

type Lang = { Params: { lang: string } };
type Key = { Params: { lang: string; key: string } };
type Id = { Params: { id: string } };

/** Tasarım dili paketi 100 MB'a kadar (base64 şişmesi dahil ~140 MB gövde). */
const PACKAGE_BODY_LIMIT = 150 * 1024 * 1024;

/**
 * Birleştirmede eklenen uçlar: şablon alan önerisi ve AI'sız deneme, temadan şablon üretimi, anahtar denemesi,
 * tasarım dili paketi (dışa/içe aktarma), tasarım dili "Dene", deneme önizlemeleri ve referans görselleri.
 */
export function toolRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { languages, trials, templateTasks, languagePackages, secrets, references, ports } = ctx;
  const lang = (id: string) => languages.get(id).id;

  app.post<Key>(API.templateSuggestArea, async (req) => {
    const body = parseBody(SuggestAreaRequestSchema, req.body);
    return trials.suggestArea(lang(req.params.lang), req.params.key, body.decoration);
  });

  app.post<Key>(API.templateTry, async (req) => trials.templateTry(lang(req.params.lang), req.params.key, parseBody(TemplateTryRequestSchema, req.body)));

  app.post<Lang>(API.templatesGenerate, async (req) => templateTasks.enqueue(lang(req.params.lang), parseBody(GenerateTemplateRequestSchema, req.body)));
  app.get<Id>(API.templateTask, async (req) => {
    const task = templateTasks.get(req.params.id);
    // Platformda harcama tutarı yalnız Yöneticiye (`org/access.ts`).
    return canSeeAmounts() ? task : { ...task, costUsd: null };
  });

  app.post<{ Params: { provider: string } }>(API.settingsKeyTest, async (req) => {
    const provider = parseBody(AiProviderSchema, req.params.provider, "provider-invalid");
    const model = provider === "anthropic" ? MODELS.daily : MODELS.image;
    if (!ports.keyTester) throw fail("key-tester-unavailable");
    const key = secrets.get(provider);
    if (!key) return { ok: false, message: "Anahtar girilmemiş.", model };
    return ports.keyTester(provider, key);
  });

  app.get<Lang>(API.languageExport, async (req, reply) => {
    const pkg = await languagePackages.export(lang(req.params.lang));
    reply.header("content-disposition", `attachment; filename="tasarim-dili-${pkg.language.id}.json"`);
    return pkg;
  });
  app.post(API.languagesImport, { bodyLimit: PACKAGE_BODY_LIMIT }, async (req) => languagePackages.import(parseBody(LanguageImportRequestSchema, req.body, "language-package-invalid")));

  app.post<Lang>(API.profileTry, async (req) => {
    const body = parseBody(ProfileTryRequestSchema, req.body, "trial-request-invalid");
    // AI modu para harcar (tahmin/`dryRun` ve motor modu ücretsiz): anahtar yoksa baştan açık hata.
    if (body.mode === "ai" && !body.dryRun) ctx.keyGuard.require("anthropic");
    return trials.profileTry(lang(req.params.lang), body);
  });
  app.get<Id>(API.trialPreview, async (req, reply) => sendPng(reply, await readFile(trials.previewFile(req.params.id)), "private, max-age=86400"));

  app.get<Id>(API.referenceImage, async (req, reply) => {
    const file = references.imagePath(ctx.paths.root, references.get(req.params.id));
    if (!file) throw fail("reference-image-not-found");
    return sendPng(reply, await readFile(file), "private, max-age=3600");
  });
}
