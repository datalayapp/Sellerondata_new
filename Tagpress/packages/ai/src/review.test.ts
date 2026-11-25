import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { canonicalCandidateId, rankCandidates } from "./rank.ts";
import { profileA } from "./test-fixtures.ts";
import { createFakeClaude, reply, requestText, systemText } from "./testing.ts";
import { sameText, transcribe } from "./transcribe.ts";

const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } }).png().toBuffer();

describe("aday seçimi", () => {
  it("kimlik toleransı: 'Candidate A', 'b)', 'Aday C' bilinen kimliğe çevrilir", () => {
    const known = ["A", "B", "C"];
    expect(canonicalCandidateId("Candidate A", known)).toBe("A");
    expect(canonicalCandidateId(" b) ", known)).toBe("B");
    expect(canonicalCandidateId("Aday C", known)).toBe("C");
    expect(canonicalCandidateId("D", known)).toBeNull();
  });

  it("sıralamayı sunucu kimliklerine çevirir, eksikleri sona ekler, kuralları modele gösterir", async () => {
    const f = createFakeClaude([
      reply.json({
        ranking: ["Candidate C", "a"],
        reasons: [
          { id: "Candidate C", reason: "Satır bölmesi doğal." },
          { id: "A", reason: "İsim küçük." },
        ],
        noneAcceptable: false,
        summary: "C en dengeli.",
      }),
    ]);
    const res = await rankCandidates(f.claude, {
      images: [
        { id: "v-1", png, summary: "Grazie / Anna & Luca" },
        { id: "v-2", png },
        { id: "v-3", png },
      ],
      context: { text: "Grazie Anna & Luca", profile: profileA },
    });
    expect(res.ok).toBe(true);
    expect(res.ranking).toEqual(["v-3", "v-1", "v-2"]);
    expect(res.reasons["v-3"]).toBe("Satır bölmesi doğal.");
    expect(res.reasons["v-2"]).toMatch(/gerekçe vermedi/);
    const sys = systemText(f.requests[0]!);
    expect(sys).toContain("No line may be longer than 20 characters");
    expect(sys).toContain('"Grazie Anna & Luca" → "Grazie" / "Anna"');
    expect(requestText(f.requests[0]!)).toContain("Candidate A: Grazie / Anna & Luca");
    expect(JSON.stringify(f.requests[0]!.output_config?.format?.schema)).toContain('"enum":["A","B","C"]');
  });

  it("en olası aday: görünür sorun yoksa başta kalır, sorun varsa modelin sırası geçer", async () => {
    const images = [
      { id: "v-1", png },
      { id: "v-2", png },
      { id: "v-3", png },
    ];
    const answer = (preferredHasProblem: boolean) => reply.json({ ranking: ["B", "C", "A"], reasons: [], noneAcceptable: false, summary: "", preferredHasProblem });
    const f = createFakeClaude([answer(false), answer(true)]);
    const kept = await rankCandidates(f.claude, { images, context: { text: "Grazie Anna & Luca", profile: profileA }, preferredId: "v-1" });
    expect(kept.ranking).toEqual(["v-1", "v-2", "v-3"]);
    expect(kept.preferredHasProblem).toBe(false);
    // Teşhis: modelin kendi sırası, 1. aday korunsa da kaybolmaz.
    expect(kept.modelRanking).toEqual(["v-2", "v-3", "v-1"]);
    expect(requestText(f.requests[0]!)).toContain('Candidate A was proposed as this designer\'s most likely design');
    expect(JSON.stringify(f.requests[0]!.output_config?.format?.schema)).toContain("preferredHasProblem");
    const overruled = await rankCandidates(f.claude, { images, context: { text: "Grazie Anna & Luca", profile: profileA }, preferredId: "v-1" });
    expect(overruled.ranking).toEqual(["v-2", "v-3", "v-1"]);
    expect(overruled.preferredHasProblem).toBe(true);
  });

  it("tek adayda model çağrılmaz; hata olursa girdi sırası korunur", async () => {
    const f = createFakeClaude([reply.auth()]);
    expect((await rankCandidates(f.claude, { images: [{ id: "x", png }], context: { text: "a", profile: profileA } })).ranking).toEqual(["x"]);
    expect(f.requests).toHaveLength(0);
    const res = await rankCandidates(f.claude, { images: [{ id: "x", png }, { id: "y", png }], context: { text: "a", profile: profileA } });
    expect(res.ok).toBe(false);
    expect(res.ranking).toEqual(["x", "y"]);
    expect(res.error?.config).toBe(true);
  });
});

describe("yazı okuma", () => {
  it("sameText yalnızca boşluk/satır sonu farkını tolere eder", () => {
    expect(sameText("Grazie\nAnna  &  Luca", "Grazie Anna & Luca")).toBe(true);
    expect(sameText(" Grazie Anna & Luca ", "Grazie Anna & Luca")).toBe(true);
    expect(sameText("Grazie anna & Luca", "Grazie Anna & Luca")).toBe(false);
    expect(sameText("Grazie Anna & Luca!", "Grazie Anna & Luca")).toBe(false);
    expect(sameText("Grazie Anna and Luca", "Grazie Anna & Luca")).toBe(false);
    expect(sameText("Anna&Luca", "Anna & Luca")).toBe(false);
    expect(sameText("Anna&Luca", "Anna & Luca", ["&"])).toBe(true);
    expect(sameText("Café", "Café")).toBe(true); // NFC
  });

  it("transcribe satırları döner", async () => {
    const f = createFakeClaude([reply.json({ lines: ["Grazie", " Anna & Luca "], legible: true })]);
    const r = await transcribe(f.claude, png);
    expect(r.lines).toEqual(["Grazie", "Anna & Luca"]);
    expect(r.text).toBe("Grazie Anna & Luca");
  });
});
