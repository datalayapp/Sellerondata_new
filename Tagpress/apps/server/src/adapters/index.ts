import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ClaudePort, ImagePort } from "@tagpress/ai";
import type { PortDeps, Ports, PortsFactory } from "../ports.ts";
import { createDesigner, createImageGenerator, createKeyTester } from "./ai.ts";
import { createEngineAdapter } from "./engine.ts";
import { FontRegistryCache, createFontCatalog, createFontCoverage } from "./fonts.ts";
import { createPrintPlanner, createPrintRenderer } from "./print.ts";
import { templatesGeometry, templatesResolver } from "./templates.ts";

export interface ProductionOptions {
  /** Testler: sahte AI istemcileri ve ağ (gerçek çağrı yapılmaz). */
  claude?: (apiKey: string) => ClaudePort;
  gemini?: (apiKey: string) => ImagePort;
  fetch?: typeof fetch;
  /** Testler: platform kipinde geçit istemcilerinin ağı (gerçek SDK + sahte geçit). */
  aiFetch?: typeof fetch;
  /** Windows sistem yedek fontları (varsayılan: Windows'ta açık). */
  systemFallbacks?: boolean;
}

/**
 * Geçerli firmanın bütün dillerinin font klasörleri (başka firmanın fontları kataloğa girmez). `orgRoot`: geçerli
 * firmanın kökü (`PortDeps.paths.root`, her çağrıda okunur); diller onun `diller/` klasöründe.
 */
function languageFontDirs(orgRoot: string): string[] {
  const dir = path.join(orgRoot, "diller");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((id) => path.join(dir, id, "fontlar"));
}

/**
 * Üretim bağlantıları: gerçek paketler. Bağlam kurulurken veri yolları ve anahtar erişimiyle çağrılır.
 * - templates: şablon çözümü, geometri (sticker dahil), alan bindirmesi
 * - typeset: dil başına font kaydı, glif kapsamı, font kataloğu
 * - engine: yerleşim, önizleme, yerleşim denetimi
 * - ai: tasarımcı (Claude) ve görüntü üretimi (Gemini)
 */
export function productionPorts(opts: ProductionOptions = {}): PortsFactory {
  return (deps: PortDeps): Partial<Ports> => {
    const fonts = new FontRegistryCache(deps.paths.sharedFonts, () => languageFontDirs(deps.paths.root), opts.systemFallbacks);
    const engine = createEngineAdapter(fonts);
    const aiDeps = {
      apiKey: deps.apiKey,
      ...(deps.platformAi ? { platformAi: deps.platformAi } : {}),
      ...(opts.aiFetch ? { fetch: opts.aiFetch } : {}),
      ...(deps.referenceImages ? { referenceImages: deps.referenceImages } : {}),
      ...(deps.breakExamples ? { breakExamples: deps.breakExamples } : {}),
      ...(deps.templateAspect ? { templateAspect: deps.templateAspect } : {}),
      fonts,
      ...(opts.claude ? { claude: opts.claude } : {}),
      ...(opts.gemini ? { gemini: opts.gemini } : {}),
    };
    return {
      templateResolver: templatesResolver,
      geometry: templatesGeometry,
      fontCoverage: createFontCoverage(fonts),
      fontCatalog: createFontCatalog(),
      engine,
      designer: createDesigner(aiDeps),
      imageGenerator: createImageGenerator(aiDeps),
      keyTester: createKeyTester(opts.fetch),
      printPlanner: createPrintPlanner(),
      printRenderer: createPrintRenderer(fonts),
    };
  };
}
