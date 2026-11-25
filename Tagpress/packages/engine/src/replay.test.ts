import { beforeAll, describe, expect, it } from "vitest";
import type { DesignIntent, LayoutResult, Profile, Reference, TemplateGeometry } from "@tagpress/domain";
import type { FontRegistry } from "@tagpress/typeset";
import { testFonts, userProfile } from "./fixtures.ts";
import { formatReplaySummary, layout, makeTestGeometry, referenceToIntent, replayReference, summarizeReplays } from "./index.ts";

/** Motor çıktısından sentetik "kullanıcı son hâli": her satırın baskın run'ı, punto ve mürekkep kutusu. */
function toReference(id: string, text: string, r: LayoutResult, sizeFactor = 1, shift = { dx: 0, dy: 0 }): Reference {
  return {
    id,
    languageId: "test",
    source: "figma",
    orderNo: null,
    quantity: null,
    templateKey: "test",
    labelFramePx: 440,
    text,
    user: r.lines.map((l) => {
      const main = [...l.runs].sort((a, b) => b.text.length - a.text.length)[0]!;
      return {
        text: l.text,
        family: main.family,
        style: main.style,
        sizePx: l.sizePx * sizeFactor,
        segments: l.runs.map((x) => ({ text: x.text, family: x.family, style: x.style, sizePx: x.sizePx * sizeFactor })),
        ink: { x: l.ink.x + shift.dx, y: l.ink.y + shift.dy, w: l.ink.w, h: l.ink.h },
      };
    }),
    program: null,
    programMeta: null,
    image: null,
    split: "test",
    createdAt: "2026-10-09T00:00:00Z",
  };
}

const GV = "Great Vibes/Regular";

describe("AI'sız tekrar düzeneği", () => {
  let profile: Profile;
  let fonts: FontRegistry;
  let g: TemplateGeometry;
  const cases: Array<[string, DesignIntent]> = [
    ["Anna & Marco", { rationale: "", lines: [{ text: "Anna", role: "name", tier: "primary", fontId: GV }, { text: "&", role: "connector", tier: "connector", fontId: GV }, { text: "Marco", role: "name", tier: "primary", fontId: GV }] }],
    ["Thank you Giulia 12.10.2026", { rationale: "", lines: [{ text: "Thank you", role: "greeting", tier: "secondary", fontId: GV }, { text: "Giulia", role: "name", tier: "primary", fontId: GV }, { text: "12.10.2026", role: "date", tier: "tertiary", fontId: GV }] }],
  ];

  beforeAll(async () => {
    profile = userProfile();
    fonts = await testFonts(profile);
    g = makeTestGeometry();
  });

  it("kullanıcının satırlarından niyet: font kimliği, sınıf ve tek başına bağlaç", async () => {
    const [text, intent] = cases[0]!;
    const r = await layout({ text, intent, profile, geometry: g, fonts });
    const { intent: back } = referenceToIntent(toReference("a", text, r), profile);
    expect(back.lines.map((l) => [l.text, l.tier, l.fontId])).toEqual([
      ["Anna", "primary", GV],
      ["&", "connector", GV], // "&" glif kuralı fontu (yalnızca kural) satır fontu sayılmaz
      ["Marco", "primary", GV],
    ]);
  });

  it("motorun kendi çıktısı tekrar oynatılınca birebir çıkar", async () => {
    const metrics = [];
    for (const [i, [text, intent]] of cases.entries()) {
      const r = await layout({ text, intent, profile, geometry: g, fonts });
      const m = await replayReference(toReference(`s${i}`, text, r), profile, g, fonts);
      expect(m.ok).toBe(true);
      expect(m.sizeRatio).toBeCloseTo(1, 2);
      expect(m.within10).toBe(true);
      expect(Math.abs(m.dx)).toBeLessThan(0.5);
      expect(Math.abs(m.dy)).toBeLessThan(0.5);
      expect(m.heightRatio).toBeCloseTo(1, 2);
      for (const gap of m.gaps) expect(gap.engine).toBeCloseTo(gap.user, 2);
      metrics.push(m);
    }
    // Kullanıcı %25 büyük yazmışsa ±%10 dışında kalır.
    const [text, intent] = cases[1]!;
    const r = await layout({ text, intent, profile, geometry: g, fonts });
    const big = await replayReference(toReference("big", text, r, 1.25, { dx: 0, dy: 6 }), profile, g, fonts);
    expect(big.within10).toBe(false);
    expect(big.sizeRatio).toBeCloseTo(0.8, 2);
    metrics.push(big);

    const s = summarizeReplays(metrics);
    expect(s.n).toBe(3);
    expect(s.failed).toBe(0);
    expect(s.within10).toBe(2);
    expect(s.gaps.connector?.n).toBe(2);
    expect(s.gaps.beforeLast?.n).toBe(2);
    expect(formatReplaySummary(s)).toContain("±%10 boyut: 2/3");
  });
});
