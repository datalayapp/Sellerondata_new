import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProfileSchema, type Template, TemplateSchema, cutDiameter, shapeBounds } from "@tagpress/domain";
import { tagpressEnv } from "@tagpress/domain/env";
import { buildGeometry, clearGeometryCache, renderOverlay } from "./index.ts";

/**
 * Ölçüm testi: aktarılmış gerçek şablonlarla birkaç sınama. Birim testlerine girmez; `pnpm test:olcum` ile koşar ve
 * aktarım çıktısı yoksa açık hatayla düşer (atlanmaz).
 */
const DATA = tagpressEnv("DATA_DIR") ?? path.resolve(import.meta.dirname, "..", "..", "..", "data");
const PKG = path.join(DATA, "aktarim", "benim-tarzim", "paket.json");
const has = existsSync(PKG);

if (!has) throw new Error(`Ölçüm testi gerçek veri ister: ${PKG} bulunamadı. Veri klasörü: TAGPRESS_DATA_DIR ya da data/.`);

describe("gerçek şablonlar", () => {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const profile = ProfileSchema.parse(pkg.profile);
  const templates: Template[] = pkg.templates.map((t: unknown) => TemplateSchema.parse(t));
  const get = (key: string) => templates.find((t) => t.key === key)!;
  const img = (t: Template) => path.join(DATA, "diller", "benim-tarzim", "sablonlar", t.file);
  afterAll(() => clearGeometryCache());

  it.each(["1", "13", "a1", "5", "28"])("%s: ölçülmüş alan içinde serbest alan, hedef merkez serbest alanda", async (key) => {
    const t = get(key);
    const g = await buildGeometry(t, profile, { imagePath: img(t) });
    expect(g.manualArea).toBe(true);
    const s = t.area.mode === "manual" ? shapeBounds(t.area.shape) : null;
    const F = profile.output.designFramePx;
    expect(g.areaBounds.x).toBeGreaterThanOrEqual(s!.x * F - 1);
    expect(g.areaBounds.x + g.areaBounds.w).toBeLessThanOrEqual((s!.x + s!.w) * F + 1);
    const at = g.free.data[Math.floor(g.target.y * g.free.scale) * g.free.width + Math.floor(g.target.x * g.free.scale)];
    expect(at).toBe(1);
    // Ölçülmüş alanın en az yarısı yazıya açık kalmalı (kullanıcı yazısını oraya koymuş).
    let n = 0;
    for (const v of g.free.data) n += v;
    expect(n / g.free.scale ** 2).toBeGreaterThan(0.5 * s!.w * s!.h * F * F);
    // Kesim payı korunur.
    const c = profile.output.cut;
    if (c.kind === "circle") {
      const D = cutDiameter(profile);
      for (const [x, y] of [[g.areaBounds.x, g.target.y], [g.areaBounds.x + g.areaBounds.w, g.target.y]] as const) {
        expect(c.r - Math.hypot(x - c.cx, y - c.cy)).toBeGreaterThanOrEqual(profile.sizing.edgeMargin * D - 1.5);
      }
    }
  });

  it("koyu zeminli şablonlar (kullanıcı açık renk yazı kullanmış) koyu, kraft değil", async () => {
    for (const [key, dark] of [["25", true], ["26", true], ["28", false], ["12", false], ["1", false]] as const) {
      const t = get(key);
      const g = await buildGeometry(t, profile, { imagePath: img(t) });
      expect([key, g.background.dark]).toEqual([key, dark]);
    }
  });

  it("taşan görselli şablon (5) kendi kutusuyla yerleşir; otomatik alanlı şablon (a15) öneri alır", async () => {
    const five = get("5");
    // Şablon kutusu eski referanslardan ölçülen (5, 5, 430); 5.png 874×840 olduğu için 17 birim sola taşar.
    expect(five.imageBox).toEqual({ x: -12.4048, y: 5, w: 447.4048, h: 430 });
    const g5 = await buildGeometry(five, profile, { imagePath: img(five) });
    expect(g5.templateBox).toEqual(five.imageBox);
    const a15 = get("a15");
    expect(a15.area.mode).toBe("auto");
    const g = await buildGeometry(a15, profile, { imagePath: img(a15) });
    expect(g.manualArea).toBe(false);
    expect(g.areaBounds.w).toBeGreaterThan(200);
    const png = await renderOverlay(g);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});
