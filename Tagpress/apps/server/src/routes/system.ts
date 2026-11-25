import { API, AiProviderSchema, SetApiKeySchema, SettingsPatchSchema, type SettingsView } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { missingPorts } from "../ports.ts";
import { fail, parseBody } from "../util/errors.ts";

/** Sağlık, ayarlar, API anahtarları, maliyet, geri alma. */
export function systemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { settings, secrets, languages, costs, undo, events } = ctx;

  app.get(API.health, async () => ({
    ok: true as const,
    version: "0.1.0",
    // Disk yolu (`dataDir`) yanıtta yok: sağlık ucu kimlik doğrulamasız ve ileride sunucuda açık.
    missingPorts: missingPorts(ctx.ports),
    languages: languages.list().length,
  }));

  const view = (): SettingsView => ({ settings: settings.get(), keys: secrets.status(), warnings: secrets.warnings() });
  app.get(API.settings, async () => view());
  app.patch(API.settings, async (req) => {
    const patch = parseBody(SettingsPatchSchema, req.body, "setting-invalid");
    if (patch.defaultLanguageId && !languages.exists(patch.defaultLanguageId)) throw fail("language-unknown");
    settings.update(patch);
    if (patch.concurrency) ctx.queue.kick();
    events.emit({ type: "settings" });
    return view();
  });
  app.put<{ Params: { provider: string } }>(API.settingsKey, async (req) => {
    const provider = parseBody(AiProviderSchema, req.params.provider, "provider-invalid");
    // strict: adres (baseUrl) ya da başka alan gönderilirse reddedilir.
    const body = parseBody(SetApiKeySchema, req.body, "key-invalid");
    const s = secrets.set(provider, body.apiKey);
    events.emit({ type: "settings" });
    return s;
  });
  app.delete<{ Params: { provider: string } }>(API.settingsKey, async (req) => {
    const s = secrets.remove(parseBody(AiProviderSchema, req.params.provider, "provider-invalid"));
    events.emit({ type: "settings" });
    return s;
  });

  app.get<{ Querystring: { languageId?: string } }>(API.costs, async (req) => costs.summary(req.query.languageId || undefined));
  app.get<{ Params: { id: string } }>(API.aiCall, async (req) => costs.get(req.params.id));
  app.post<{ Params: { token: string } }>(API.undo, async (req) => undo.undo(req.params.token));
}
