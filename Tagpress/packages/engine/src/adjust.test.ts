import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { type DesignIntent, type LayoutResult, type Profile, type ProfileInput, type TemplateGeometry, boxCenter, effectiveLineStroke, ptToPx, svgStrokeWidth } from "@tagpress/domain";
import type { FontRegistry } from "@tagpress/typeset";
import { testFonts, userProfile } from "./fixtures.ts";
import { applyAdjust, centerAdjust, centerPoints, checkPlacement, layout, makeTestGeometry, renderTextOnly, textLayerSvg } from "./index.ts";

const GV = "Great Vibes/Regular";
const intent: DesignIntent = {
  lines: [
    { text: "Anna", role: "name", tier: "primary", fontId: GV },
    { text: "& Marco", role: "name", tier: "primary", fontId: GV },
  ],
  rationale: "",
};

/** Yazı katmanını çizip gerçek mürekkep kutusunu ölçer (tasarım px). */
async function renderedInk(r: LayoutResult, fonts: FontRegistry, S = 2) {
  const png = await renderTextOnly(r, fonts, { scale: S, framePx: 440 });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! < 128) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x + 1);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y + 1);
    }
  return { x: x0 / S, y: y0 / S, w: (x1 - x0) / S, h: (y1 - y0) / S };
}

describe("hafif düzeltme (motor)", () => {
  let profile: Profile;
  let fonts: FontRegistry;
  let g: TemplateGeometry;
  let base: LayoutResult;

  beforeAll(async () => {
    profile = userProfile();
    fonts = await testFonts(profile);
    // Altta bir süsleme; hedef merkez alanın biraz üstünde.
    g = makeTestGeometry({ decorations: [{ kind: "circle", cx: 220, cy: 340, r: 30 }], target: { x: 220, y: 200 } });
    base = await layout({ text: "Anna & Marco", intent, profile, geometry: g, fonts });
    expect(base.ok).toBe(true);
  });

  it("düzeltilmiş yerleşimin çizimi hesaplanan mürekkep kutusuyla örtüşür (kaydırma + ölçek)", async () => {
    const adj = applyAdjust(base, { dx: 12, dy: -8, scale: 1.1 });
    const ink = await renderedInk(adj, fonts);
    // Kontur ve kenar yumuşatma payı: ~1,5 px.
    expect(Math.abs(ink.x - adj.ink.x)).toBeLessThan(1.5);
    expect(Math.abs(ink.y - adj.ink.y)).toBeLessThan(1.5);
    expect(Math.abs(ink.w - adj.ink.w)).toBeLessThan(2.5);
    expect(Math.abs(ink.h - adj.ink.h)).toBeLessThan(2.5);
    expect(adj.lines.map((l) => l.text)).toEqual(base.lines.map((l) => l.text));
  });

  it("ortalama: çizilen yazının merkezi hedef merkeze oturur", async () => {
    const a = centerAdjust(base, g, { axis: "both" });
    const ink = await renderedInk(applyAdjust(base, a), fonts);
    const c = boxCenter(ink);
    expect(Math.abs(c.x - g.target.x)).toBeLessThan(1.5);
    expect(Math.abs(c.y - g.target.y)).toBeLessThan(1.5);
    const cut = centerAdjust(base, g, { axis: "y", target: "cut", adjust: a });
    expect(cut.dx).toBe(a.dx);
    expect(boxCenter(applyAdjust(base, cut).ink).y).toBeCloseTo(centerPoints(g).cut.y, 1);
  });

  it("denetim: yerinde sorun yok; kesim dışına taşınca hata, süslemeye değince uyarı", async () => {
    const ok = await checkPlacement(base, g, fonts, profile);
    expect(ok.issues).toEqual([]);
    expect(ok.report.ok).toBe(true);

    const out = await checkPlacement(applyAdjust(base, { dx: -250, dy: 0, scale: 1 }), g, fonts, profile);
    expect(out.report.outsideCutPx).toBeGreaterThan(0);
    expect(out.issues[0]).toMatchObject({ code: "collision", severity: "error", field: "adjust" });

    // Bloğu süslemenin üstüne taşı.
    const c = boxCenter(base.ink);
    const deco = await checkPlacement(applyAdjust(base, { dx: 220 - c.x, dy: 340 - c.y, scale: 0.6 }), g, fonts, profile);
    expect(deco.report.decorationPx).toBeGreaterThan(0);
    expect(deco.issues.some((i) => i.code === "collision" && i.severity === "warning")).toBe(true);
  });

  it("denetim: çok küçültülünce okunurluk uyarısı", async () => {
    const smallest = Math.min(...base.lines.map((l) => l.sizePx));
    // Okunurluk sınırı: özgün en küçük satırın %75'i (özgün yerleşim geçer, yarıya küçültülen geçmez).
    const p2 = userProfile({ quality: { readableMinPt: (0.75 * smallest) / ptToPx(profile, 1) } } as Partial<ProfileInput>);
    expect((await checkPlacement(base, g, fonts, p2)).issues).toEqual([]);
    const small = await checkPlacement(applyAdjust(base, { dx: 0, dy: 0, scale: 0.5 }), g, fonts, p2);
    expect(small.issues).toEqual([expect.objectContaining({ code: "text-too-small", severity: "warning", field: "adjust" })]);
  });

  it("denetim hızlı (sürükleme bırakılınca çağrılır)", async () => {
    await checkPlacement(base, g, fonts, profile);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await checkPlacement(applyAdjust(base, { dx: i, dy: -i, scale: 1 + i / 100 }), g, fonts, profile);
    const each = (performance.now() - t0) / 5;
    expect(each).toBeLessThan(150);
  });

  it("yazı katmanı SVG: satır grupları, tasarım alanı viewBox'ı, kontur grup özniteliğinde", () => {
    const svg = textLayerSvg(base, fonts, { profile });
    expect(svg).toContain('viewBox="0 0 440 440"');
    expect(svg).toMatch(/<g data-line="0" [^>]*stroke-width="[\d.]+"[^>]*paint-order="stroke"/);
    expect(svg).toMatch(/<g data-line="1" /);
    expect(svg).toContain("<path");
    // Yolların kendi stroke-width'i yok (gruptan miras).
    expect(svg).not.toMatch(/<path[^>]*stroke-width/);
    const w = svgStrokeWidth(base.strokePx, profile.weight.align);
    expect(svg).toContain(`stroke-width="${Math.round(w * 100) / 100}"`);
  });

  it("satır düzeltmesi + kalınlık: çizim hesaplanan satır kutusuyla örtüşür", async () => {
    const a = { dx: 0, dy: 0, scale: 1, strokePx: 1.5, lines: [{ index: 1, dx: 14, dy: 6, scale: 1.15, strokePx: 1 }] };
    const adj = applyAdjust(base, a, { strokeAlign: profile.weight.align });
    expect(adj.lines[0]!.strokePx).toBeCloseTo(effectiveLineStroke(base, a, 0), 5);
    expect(adj.lines[1]!.strokePx).toBeCloseTo(base.strokePx * 1.15 + 2.5, 2);
    // Yalnızca 2. satırı çiz, ölçülen kutu hesaplananla örtüşsün.
    const only1 = { ...adj, lines: [adj.lines[1]!] };
    const ink = await renderedInk(only1, fonts);
    const want = adj.lines[1]!.ink;
    expect(Math.abs(ink.x - want.x)).toBeLessThan(1.5);
    expect(Math.abs(ink.y - want.y)).toBeLessThan(1.5);
    expect(Math.abs(ink.w - want.w)).toBeLessThan(2.5);
    expect(Math.abs(ink.h - want.h)).toBeLessThan(2.5);
    // Kalınlık çizimi gerçekten değiştirir.
    const thin = await renderedInk({ ...base, lines: [base.lines[1]!] }, fonts);
    expect(ink.w).toBeGreaterThan(thin.w * 1.15);
  });

  it("kalınlık çarpışma denetimine girer: kesime yakın satır kalınlaşınca taşar", async () => {
    // Bloğu kesim kenarına yaklaştır: önce taşmayan bir konum bul, sonra kalınlaştır.
    let dx = -100;
    let near = await checkPlacement(applyAdjust(base, { dx, dy: 0, scale: 1 }), g, fonts, profile);
    while (near.report.outsideCutPx === 0 && dx > -300) {
      dx -= 2;
      near = await checkPlacement(applyAdjust(base, { dx, dy: 0, scale: 1 }), g, fonts, profile);
    }
    dx += 4; // taşmanın hemen içi
    const inside = await checkPlacement(applyAdjust(base, { dx, dy: 0, scale: 1 }), g, fonts, profile);
    expect(inside.report.outsideCutPx).toBe(0);
    const thick = await checkPlacement(applyAdjust(base, { dx, dy: 0, scale: 1, strokePx: 6 }, { strokeAlign: profile.weight.align }), g, fonts, profile);
    expect(thick.report.outsideCutPx).toBeGreaterThan(0);
    expect(thick.report.inkPx).toBeGreaterThan(inside.report.inkPx);
  });
});
