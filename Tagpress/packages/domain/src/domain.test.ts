import { describe, expect, it } from "vitest";
import { MODELS, PROFILE_DOCS, estimateCost, ProfileSchema, checkTextPreserved, emptyProfile, normalizeText, isInitialsOnly, toPlainLetters } from "./index.ts";

describe("metin", () => {
  it("dış tırnağı kaldırır, iç tırnağa dokunmaz", () => {
    expect(normalizeText('"Grazie di \"cuore\""').text).toBe('Grazie di "cuore"');
    expect(normalizeText("“Thank you”").outerQuotesRemoved).toBe(true);
    expect(normalizeText("'a' and 'b'").text).toBe("'a' and 'b'");
  });
  it("çift boşluk müşterinin satır ipucudur", () => {
    expect(normalizeText("Thank you  Anna & Marco").segments).toEqual(["Thank you", "Anna & Marco"]);
  });
  it("satır bölmesi metni değiştirmez; harf/büyüklük değişimi reddedilir", () => {
    const t = "Mina&Alessia 12.10.2026";
    expect(checkTextPreserved(["Mina", "&", "Alessia", "12.10.2026"], t, ["&"]).ok).toBe(true);
    expect(checkTextPreserved(["Mina & Alessia", "12.10.2026"], t, ["&"]).ok).toBe(true);
    expect(checkTextPreserved(["mina & Alessia", "12.10.2026"], t, ["&"]).ok).toBe(false);
    expect(checkTextPreserved(["Happy Navarathri"], "Happy Navarathri -").ok).toBe(false);
    expect(checkTextPreserved(["Thankyou"], "Thank you").ok).toBe(false);
  });
  it("noktalamadan sonra boşluksuz satır sonu kabul edilir, kelime ortası edilmez", () => {
    const t = "Il mio diciottesimo compleanno.Felice di averlo festeggiato insieme.Aurora";
    expect(checkTextPreserved(["Il mio diciottesimo compleanno.", "Felice di averlo festeggiato insieme.", "Aurora"], t).ok).toBe(true);
    expect(checkTextPreserved(["Battesimo Gregorio", "25~10~2026"], "Battesimo Gregorio 25~10~2026").ok).toBe(true);
    expect(checkTextPreserved(["Ale", "jandro"], "Alejandro").ok).toBe(false);
    expect(checkTextPreserved(["Il mio diciottesimo compleanno", "Felice"], "Il mio diciottesimo compleanno.Felice").ok).toBe(false);
  });
  it("baş harf ve özel Unicode", () => {
    expect(isInitialsOnly("A & M", ["&"])).toBe(true);
    expect(isInitialsOnly("Anna & M", ["&"])).toBe(false);
    expect(toPlainLetters("𝓛𝓪 cresima")).toBe("La cresima");
  });
});

describe("profil", () => {
  it("boş profil varsayılanlarla dolar", () => {
    const p = emptyProfile("Deneme");
    expect(p.output.designFramePx).toBe(440);
    expect(p.sizing.tiers.secondary).toBeGreaterThan(0);
  });
  it("her yaprak alanın açıklaması var", () => {
    const p = ProfileSchema.parse({ name: "x" }) as Record<string, unknown>;
    const missing: string[] = [];
    const walk = (o: unknown, path: string) => {
      if (PROFILE_DOCS[path]) return;
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
      } else if (path !== "schemaVersion") missing.push(path);
    };
    walk(p, "");
    expect(missing).toEqual([]);
  });
});

describe("maliyet", () => {
  it("görüntü modelinde görsel başına ücret (çıktı token'ı metin fiyatıyla sayılmaz)", () => {
    const usd = estimateCost({ model: MODELS.image, inputTokens: 2000, outputTokens: 1300, images: 1 })!;
    expect(usd).toBeCloseTo(0.067 + (2000 * 0.3) / 1e6, 6);
  });
  it("görsel gelmezse token fiyatı", () => {
    const usd = estimateCost({ model: MODELS.image, inputTokens: 1000, outputTokens: 100, images: 0 })!;
    expect(usd).toBeCloseTo((1000 * 0.3 + 100 * 2.5) / 1e6, 9);
  });
});
