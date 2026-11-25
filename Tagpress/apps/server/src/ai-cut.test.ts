import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Shape, TemplateSchema, defaultProfile } from "@tagpress/domain";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTENT_DIR } from "./org/seed.ts";
import { png } from "./test/helpers.ts";

/**
 * `adapters/ai.ts`: şablonun kendi kesimi (kalan iş 1). Görüntü kipi ("şablona yaz") modele şablonun ETKİN kesimini
 * verir; tasarım özeti harf yüksekliği tavanını geometrinin (etkin) kesiminden hesaplar. Gerçek yapay zekâ çağrısı yok:
 * `writeOnTemplate` sahtesi gelen kesimi kaydeder.
 */

const seen: { cut?: Shape }[] = [];
vi.mock("@tagpress/ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tagpress/ai")>();
  return {
    ...real,
    writeOnTemplate: vi.fn(async (_deps: unknown, input: { cut?: Shape }) => {
      seen.push({ ...(input.cut ? { cut: input.cut } : {}) });
      return { ok: false, checks: { attempts: 1, rejectedBecause: [], textMatches: null, transcript: null, templateUntouched: true }, usage: [], issues: [{ message: "sahte" }], promptVersion: "x", prompt: "" };
    }),
  };
});

const { templateCutShape } = await import("@tagpress/ai");
const { createImageGenerator, templateSummary } = await import("./adapters/ai.ts");
const { FontRegistryCache } = await import("./adapters/fonts.ts");

const dir = mkdtempSync(path.join(os.tmpdir(), "ai-kesim-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const profile = defaultProfile();
const RECT = { shape: "rect" as const, wMm: 63.5, hMm: 38.1 };

describe("görüntü kipi: şablonun kendi kesimi", () => {
  it("kesimli şablonda modele şablonun kesimi gider; kesimsiz şablonda dilin kesimi (eskisi gibi)", async () => {
    const file = path.join(dir, "s.png");
    writeFileSync(file, await png(300, 200));
    const gen = createImageGenerator({ apiKey: (p) => (p === "gemini" ? "k" : null), fonts: new FontRegistryCache(dir), gemini: () => ({ model: "sahte", generate: async () => { throw new Error("çağrılmamalı"); } }) });
    const geometry = { templateBox: { x: 10, y: 10, w: 420, h: 420 }, areaBounds: { x: 100, y: 100, w: 240, h: 240 } } as never;
    const run = async (cut: typeof RECT | null) => {
      const template = TemplateSchema.parse({ key: "s", languageId: "dil", file: "s.png", width: 300, height: 200, cut });
      await expect(gen.onTemplate({ jobId: "j", text: "Anna", aiNote: "", profile, template, templatePath: file, geometry, revision: null, log: () => {} })).rejects.toThrow("sahte");
      return { got: seen.at(-1)!.cut, template };
    };
    const own = await run(RECT);
    expect(own.got).toEqual(templateCutShape(profile, 300, 200, own.template));
    expect(own.got).not.toEqual(templateCutShape(profile, 300, 200));
    expect(own.got?.kind).toBe("rect");
    const legacy = await run(null);
    expect(legacy.got).toEqual(templateCutShape(profile, 300, 200));
  });
});

describe("tasarım özeti: harf yüksekliği tavanı etkin kesimden", () => {
  it("küçük kesimli geometride tahmini punto küçülür, satıra daha çok harf sığar; dilin kesimiyle eskisiyle aynı", () => {
    const reg = new FontRegistryCache(path.join(DEFAULT_CONTENT_DIR, "fontlar")).forProfile(path.join(DEFAULT_CONTENT_DIR, "fontlar"), profile);
    const F = 440;
    const geometry = (cut: Shape) =>
      ({
        key: "s",
        framePx: F,
        cut,
        rows: Array.from({ length: F }, () => [[60, 380]] as Array<[number, number]>),
        areaBounds: { x: 60, y: 60, w: 320, h: 320 },
        background: { luminance: 0.9, dark: false },
      }) as never;
    const hints = (cut: Shape) => templateSummary({ template: null, geometry: geometry(cut), profile }, reg).widthHints!.map((h) => h.chars);
    const big = hints(profile.output.cut);
    const small = hints({ kind: "rect", x: 170, y: 195, w: 100, h: 50, radius: 0 });
    expect(big.every((c) => c > 0)).toBe(true);
    expect(small.every((c, i) => c > big[i]!)).toBe(true);
  });
});
