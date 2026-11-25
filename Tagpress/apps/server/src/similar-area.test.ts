import { ProfileSchema, emptyProfile } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { createDesigner } from "./adapters/ai.ts";
import { FontRegistryCache } from "./adapters/fonts.ts";
import { fakeGeometry } from "./test/helpers.ts";

/** Sahte Claude: istemi kaydeder, tek geçerli aday döner. */
function recordingClaude(seen: string[]) {
  return {
    model: "sahte",
    callJson: async (req: { content: Array<{ type: string; text?: string }> }) => {
      seen.push(req.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
      return {
        ok: true,
        data: { candidates: [{ rationale: "", lines: [{ text: "Sara & Luca", role: "name", tier: "primary", fontId: "Great Vibes/Regular" }, { text: "09.09.2027", role: "date", tier: "primary", fontId: "Great Vibes/Regular" }] }] },
        usage: [],
        raw: "{}",
        calls: [],
        attempts: 1,
      };
    },
  } as never;
}

describe("benzer örneklere şablon yazı alanı oranı", () => {
  it("örneklerin şablon oranı sunucudan gelir, işin şablonu güncel geometriden; oranlar önbellekte", async () => {
    const seen: string[] = [];
    const asked: string[] = [];
    const designer = createDesigner({
      apiKey: () => "k",
      fonts: new FontRegistryCache("C:/fontlar"),
      claude: () => recordingClaude(seen),
      breakExamples: () => [
        { text: "Anna & Marco 01.02.2027", lines: ["Anna", "&", "Marco", "01.02.2027"], templateKey: "dar", referenceId: "r1" },
        { text: "Mia & Leo 07.08.2027", lines: ["Mia & Leo", "07.08.2027"], templateKey: "genis", referenceId: "r2" },
        { text: "Eva & Tom 05.06.2027", lines: ["Eva & Tom", "05.06.2027"], templateKey: "is", referenceId: "r3" },
        { text: "Ada & Bo 03.03.2027", lines: ["Ada", "&", "Bo", "03.03.2027"], templateKey: "yok", referenceId: "r4" },
      ],
      templateAspect: async (_lang, key) => {
        asked.push(key);
        return ({ dar: 1.25, genis: 2.19, is: 9 } as Record<string, number>)[key];
      },
    });
    const profile = ProfileSchema.parse({
      ...emptyProfile("x"),
      fonts: { list: [{ id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", kind: "script", roles: ["primary"], file: "GreatVibes-Regular.ttf" }] },
      connectors: { ...emptyProfile("x").connectors, words: ["&"] },
    });
    const template = { key: "is", languageId: "dil", notes: "", tags: [], ribbonTop: 0, printedText: false } as never;
    const geometry = await fakeGeometry().forTemplate({ template, imagePath: "yok.png" } as never);
    const req = {
      jobId: "j", text: "Sara & Luca 09.09.2027", segments: [], aiNote: "", kind: "label" as const, profile, profileVersion: 1,
      template, sticker: null, geometry, previous: [], revision: null, candidates: 1, log: () => {}, languageId: "dil",
    };
    await designer.design(req);
    const prompt = seen[0]!;
    // fakeGeometry alanı 240×240 → işin oranı 1; "is" şablonunun sunucu değeri (9) değil, güncel geometri kullanılır.
    expect(prompt).toContain("(this job's template: 1)");
    expect(prompt).toContain('"01.02.2027" (area w/h 1.25)');
    expect(prompt).toContain('"07.08.2027" (area w/h 2.19)');
    expect(prompt).toContain('"05.06.2027" (same template, same structure; area w/h 1)');
    expect(prompt).toMatch(/"Bo" \/ "03\.03\.2027"\n|"Bo" \/ "03\.03\.2027"$/u);
    expect(asked.sort()).toEqual(["dar", "genis", "yok"]);
    await designer.design(req);
    expect(asked).toHaveLength(3); // ikinci çağrıda önbellekten
  });
});
