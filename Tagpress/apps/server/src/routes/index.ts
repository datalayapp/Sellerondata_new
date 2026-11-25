import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { adjustRoutes } from "./adjust.ts";
import { builderRoutes } from "./builder.ts";
import { fallbackFontRoutes } from "./fallback-fonts.ts";
import { jobRoutes } from "./jobs.ts";
import { languageRoutes } from "./languages.ts";
import { learnRoutes } from "./learn.ts";
import { orgRoutes } from "./org.ts";
import { referenceRoutes } from "./references.ts";
import { sessionRoutes } from "./session.ts";
import { systemRoutes } from "./system.ts";
import { templateRoutes } from "./templates.ts";
import { printRoutes } from "./print.ts";
import { setupRoutes } from "./setup.ts";
import { toolRoutes } from "./tools.ts";

/** Bütün uçlar (yollar domain `API` ve `PRINT_API` tablolarından). */
export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  systemRoutes(app, ctx);
  languageRoutes(app, ctx);
  templateRoutes(app, ctx);
  jobRoutes(app, ctx);
  adjustRoutes(app, ctx);
  referenceRoutes(app, ctx);
  learnRoutes(app, ctx);
  sessionRoutes(app, ctx);
  toolRoutes(app, ctx);
  printRoutes(app, ctx);
  fallbackFontRoutes(app, ctx);
  orgRoutes(app, ctx);
  setupRoutes(app, ctx);
  builderRoutes(app, ctx);
}
