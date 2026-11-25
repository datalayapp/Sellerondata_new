import { describe, expect, it } from "vitest";
import { type Profile, ProfileSchema, type RefLine, type Reference, ReferenceSchema, TemplateSchema } from "@tagpress/domain";
import { measureStyle, refUse } from "./measure.ts";

/**
 * Ölçüm özeti ve yüklenen örnekler (kaliteye göre katkı). Kayıtlar sentetik; görüntüden ölçüm
 * `apps/server/src/services/builder/samples.test.ts`'te.
 */

const profile: Profile = ProfileSchema.parse({ name: "t", connectors: { words: ["&", "e"] } });

const line = (text: string, sizePx: number, y: number, h: number, family = "Great Vibes"): RefLine => ({
  text,
  family,
  style: "Regular",
  sizePx,
  segments: [{ text, family, style: "Regular", sizePx }],
  ink: { x: 220 - text.length * 6, y, w: text.length * 12, h },
});

function ref(id: string, o: Partial<Reference> = {}): Reference {
  return ReferenceSchema.parse({
    id,
    languageId: "l",
    source: "figma",
    orderNo: null,
    quantity: null,
    templateKey: "t1",
    labelFramePx: 440,
    text: "Elena & Marco",
    user: [line("Elena", 60, 150, 50), line("&", 30, 210, 25), line("Marco", 60, 245, 50)],
    program: null,
    programMeta: null,
    image: null,
    split: "train",
    createdAt: "2026-01-01T00:00:00Z",
    ...o,
  });
}

const zero = (l: RefLine): RefLine => ({ ...l, family: "", style: "", sizePx: 0, segments: [{ text: l.text, family: "", style: "", sizePx: 0 }], ink: { x: 0, y: 0, w: 0, h: 0 } });

describe("refUse", () => {
  it("yapılandırılmış kayıt her ölçüye; yüklenen örnek kaliteye göre", () => {
    expect(refUse({})).toEqual({ examples: true, text: true, sizes: true, gaps: true, frame: true });
    expect(refUse({ quality: "exact", sizesKnown: true })).toEqual({ examples: true, text: true, sizes: true, gaps: true, frame: true });
    expect(refUse({ quality: "exact", sizesKnown: false })).toEqual({ examples: true, text: true, sizes: false, gaps: false, frame: true });
    expect(refUse({ quality: "ink", sizesKnown: true })).toEqual({ examples: true, text: true, sizes: true, gaps: false, frame: false });
    expect(refUse({ quality: "ink", sizesKnown: false })).toEqual({ examples: true, text: true, sizes: false, gaps: false, frame: false });
    expect(refUse({ quality: "none" })).toEqual({ examples: true, text: false, sizes: false, gaps: false, frame: false });
    expect(refUse({ quality: "exact", approx: true, sizesKnown: true })).toEqual({ examples: true, text: false, sizes: false, gaps: false, frame: false });
  });
});

describe("measureStyle: yüklenen örnekler", () => {
  const base = [ref("a"), ref("b", { user: [line("Anna", 60, 160, 50), line("12.10.2026", 36, 225, 28, "Playfair Display")], text: "Anna 12.10.2026" })];
  const numeric = (m: ReturnType<typeof measureStyle>) => ({ ratios: m.ratios, gaps: m.gaps, fill: m.fill, templates: m.templates, fonts: m.fonts, connectors: m.connectors, lineCount: m.lineCount, lineLength: m.lineLength });

  it("none ve approx örnek hiçbir sayısal ölçüyü değiştirmez; yalnız örnek bölmeye ve sayaca girer", () => {
    const before = measureStyle(base, profile);
    const none = ref("u-none", { source: "uploaded", quality: "none", sizesKnown: false, text: "Sara & Luca", user: [zero(line("Sara", 0, 0, 0)), zero(line("&", 0, 0, 0)), zero(line("Luca", 0, 0, 0))] });
    const approx = ref("u-approx", { source: "uploaded", quality: "exact", approx: true, sizesKnown: false, text: "Sara Luca", user: [zero(line("Sara Luca", 0, 0, 0))] });
    const after = measureStyle([...base, none, approx], profile);
    expect(numeric(after)).toEqual(numeric(before));
    expect(after.refs.uploaded).toEqual({ total: 2, exact: 1, ink: 0, none: 1, approx: 1, sizesUnknown: 0 });
    expect(after.examples.map((e) => e.text)).toEqual(expect.arrayContaining(["Sara & Luca", "Sara Luca"]));
    expect(after.examples.find((e) => e.text === "Sara & Luca")!.fonts).toEqual([]);
  });

  it("exact + font onaylı: oranlar, boşluklar, doluluk ve şablon merkezi n'i birer artar", () => {
    const before = measureStyle(base, profile);
    const up = ref("u-exact", { source: "uploaded", quality: "exact", approx: false, sizesKnown: true });
    const after = measureStyle([...base, up], profile);
    expect(after.ratios.connector!.n).toBe(before.ratios.connector!.n + 1);
    expect(after.gaps.connector!.n).toBe(before.gaps.connector!.n + 2);
    expect(after.fill.blockWidthOfCut!.n).toBe(before.fill.blockWidthOfCut!.n + 1);
    expect(after.fill.largestPx!.n).toBe(before.fill.largestPx!.n + 1);
    expect(after.templates[0]!.n).toBe(before.templates[0]!.n + 1);
    expect(after.lineCount).toEqual([
      { lines: 2, count: 1 },
      { lines: 3, count: 2 },
    ]);
  });

  it("exact + font onaysız: oran, boşluk, punto ve font boş kalır; doluluk ve merkez ölçülür", () => {
    const up = ref("u-exact", { source: "uploaded", quality: "exact", approx: false, sizesKnown: false });
    up.user = up.user.map((l) => ({ ...zero(l), ink: l.ink }));
    const only = measureStyle([up], profile);
    expect(only.ratios.connector).toBeNull();
    expect(only.ratios.secondary).toBeNull();
    expect(only.gaps.normal).toBeNull();
    expect(only.gaps.connector).toBeNull();
    expect(only.fill.largestPx).toBeNull();
    expect(only.fonts.byLabel).toEqual([]);
    expect(only.connectors.shiftEm).toBeNull();
    expect(only.fill.blockWidthOfCut!.n).toBe(1);
    expect(only.templates).toHaveLength(1);
    expect(only.lineCount).toEqual([{ lines: 3, count: 1 }]);
    expect(only.refs.uploaded.sizesUnknown).toBe(1);
  });

  it("ink: oranlar var (font onaylıysa); boşluk, doluluk ve merkez yok", () => {
    const up = ref("u-ink", { source: "uploaded", quality: "ink", approx: false, sizesKnown: true });
    const only = measureStyle([up], profile);
    expect(only.ratios.connector!.n).toBe(1);
    expect(only.gaps.connector).toBeNull();
    expect(only.fill.blockWidthOfCut).toBeNull();
    expect(only.fill.largestPx).toBeNull();
    expect(only.templates).toEqual([]);
  });
});

describe("measureStyle: kesim çapı şablonun kesiminden", () => {
  const tpl = (cut: unknown) => TemplateSchema.parse({ key: "t1", languageId: "l", file: "t1.png", width: 840, height: 840, cut });
  // Yazı bloğu: 60 × 145 px (Elena/&/Marco, y 150..295).
  it("dikdörtgen kesimli şablonda blok oranları kesimin kısa kenarına (262,8 px) göre", () => {
    const m = measureStyle([ref("a")], profile, [tpl({ shape: "rect", wMm: 63.5, hMm: 38.1 })]);
    expect(m.fill.blockWidthOfCut!.median).toBe(Math.round((60 / 262.8) * 1000) / 1000);
    expect(m.fill.blockHeightOfCut!.median).toBe(Math.round((145 / 262.8) * 1000) / 1000);
  });

  it("kesimsiz şablonda eskisi gibi profilin kesim çapı (şablonsuzla aynı)", () => {
    const withTpl = measureStyle([ref("a")], profile, [tpl(null)]);
    const none = measureStyle([ref("a")], profile);
    expect(withTpl.fill).toEqual(none.fill);
    expect(withTpl.fill.blockWidthOfCut!.median).toBe(Math.round((60 / (2 * 218.82)) * 1000) / 1000);
  });
});
