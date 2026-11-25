import { checkTextPreserved } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { breaksOnCustomerText, pickSimilarExamples, similarExamplesSection } from "./similar.ts";

describe("benzer örnekler", () => {
  it("kullanıcının bölmesini müşteri metnine uygular (silinen ayırıcı metinde kalır)", () => {
    const text = "Happy Navarathri - Priya & Arjun";
    const lines = breaksOnCustomerText(text, ["Happy Navarathri", "Priya & Arjun"]);
    expect(lines).toEqual(["Happy Navarathri -", "Priya & Arjun"]);
    expect(checkTextPreserved(lines!, text, ["&"]).ok).toBe(true);
  });

  it("kullanıcı kelimeyi değiştirdiyse örnek kullanılmaz", () => {
    expect(breaksOnCustomerText("Battesimo di Aurora", ["Battesimo", "Auroraa"])).toBeNull();
  });

  it("yapısı ve kelimeleri benzeyen örnekleri seçer", () => {
    const pool = [
      { text: "Battesimo di Samuele 12/10/2026", lines: ["Battesimo di", "Samuele", "12/10/2026"] },
      { text: "Thank you for coming", lines: ["Thank you", "for coming"] },
      { text: "Anna & Marco 01.02.2027", lines: ["Anna & Marco", "01.02.2027"] },
      { text: "Merry Christmas", lines: ["Merry Christmas"] },
    ];
    const got = pickSimilarExamples("Battesimo di Aurora 17/10/2026", pool, 2, ["&", "e", "y"]);
    expect(got[0]!.text).toBe("Battesimo di Samuele 12/10/2026");
    const couple = pickSimilarExamples("Carolina & Matteo 19 giugno 2027", pool, 1, ["&"]);
    expect(couple[0]!.text).toBe("Anna & Marco 01.02.2027");
  });

  it("yapısı aynı örnekler arasında aynı şablondakini öne alır ve işaretler", () => {
    const pool = [
      { text: "Anna & Marco 01.02.2027", lines: ["Anna & Marco", "01.02.2027"], templateKey: "t1" },
      { text: "Lena & Paul 03.04.2027", lines: ["Lena", "&", "Paul", "03.04.2027"], templateKey: "t2" },
    ];
    const t2 = pickSimilarExamples("Sara & Luca 05.06.2027", pool, 2, ["&"], { templateKey: "t2" });
    expect(t2[0]!.text).toBe("Lena & Paul 03.04.2027");
    expect(t2[0]!.sameTemplate).toBe(true);
    expect(t2[1]!.sameTemplate).toBe(false);
    expect(similarExamplesSection(t2)).toContain('"Paul" / "03.04.2027" (same template, same structure)');
    expect(similarExamplesSection(t2)).toContain("strongest evidence");
    const t1 = pickSimilarExamples("Sara & Luca 05.06.2027", pool, 1, ["&"], { templateKey: "t1" });
    expect(t1[0]!.text).toBe("Anna & Marco 01.02.2027");
  });

  it("örneklere şablon yazı alanı oranı yazılır (piksel değil, eşik yok); oran yoksa eski biçim", () => {
    const examples = [
      { text: "Daniel&Ruby 28/11/2026", lines: ["Daniel", "&", "Ruby", "28/11/2026"], areaAspect: 1.27 },
      { text: "Lindsey & Sal 3-21-27", lines: ["Lindsey & Sal", "3-21-27"], areaAspect: 2.1875 },
      { text: "Michela & Gerardo", lines: ["Michela", "&", "Gerardo"], sameTemplate: true, areaAspect: 1.53 },
      { text: "Patrick & Jasmine", lines: ["Patrick", "&", "Jasmine"] },
    ];
    const s = similarExamplesSection(examples, { areaAspect: 1.53 });
    expect(s).toContain('"Ruby" / "28/11/2026" (area w/h 1.27)');
    expect(s).toContain('"3-21-27" (area w/h 2.19)');
    expect(s).toContain('"Gerardo" (on this same template; area w/h 1.53)');
    expect(s).toContain('"Jasmine"\n'.trimEnd());
    expect(s).not.toContain('"Jasmine" (');
    expect(s).toContain("(this job's template: 1.53)");
    expect(s).toContain("follow the examples whose area is shaped like this job's");
    // İşin oranı bilinmese de örnek oranları yazılır; hiçbir örnekte oran yoksa açıklama da yok.
    expect(similarExamplesSection(examples)).not.toContain("this job's template");
    expect(similarExamplesSection(examples)).toContain("area w/h 1.27");
    const plain = similarExamplesSection(examples.map(({ areaAspect: _a, ...e }) => e), { areaAspect: 1.53 });
    expect(plain).not.toContain("area w/h");
  });

  it("kullanıcı yapışık sembolü ayrı yazdıysa örnek havuza girer; satır içinde metin değişmez", () => {
    expect(breaksOnCustomerText("Daniel&Ruby 28/11/2026", ["Daniel", "    &", "Ruby", "28/11/2026"])).toEqual(["Daniel", "&", "Ruby", "28/11/2026"]);
    expect(breaksOnCustomerText("Daniel&Ruby 28/11/2026", ["Daniel & Ruby", "28/11/2026"])).toEqual(["Daniel&Ruby", "28/11/2026"]);
    expect(breaksOnCustomerText("Lena&Verena", ["Lena&Verena"])).toEqual(["Lena&Verena"]);
  });

  it("aynı şablonda aynı kaba yapıdaki (bağlaç + tarih) örnekler başa alınır; yalnız çiftte çapa yok", () => {
    const pool = [
      { text: "Anna & Marco 01.02.2027", lines: ["Anna & Marco", "01.02.2027"], templateKey: "t1" },
      { text: "Mia & Leo 02.02.2027", lines: ["Mia & Leo", "02.02.2027"], templateKey: "t1" },
      { text: "Eva & Tom 03.02.2027", lines: ["Eva & Tom", "03.02.2027"], templateKey: "t1" },
      { text: "Daniel&Ruby 28/11/2026", lines: ["Daniel", "&", "Ruby", "28/11/2026"], templateKey: "t2" },
      { text: "Lena & Paul", lines: ["Lena", "&", "Paul"], templateKey: "t2" },
    ];
    // "Yuriy & Ana Isabel": iki kelimelik isim ve yapışık sembol aynı kaba yapı (N C N D) sayılır.
    const got = pickSimilarExamples("Yuriy & Ana Isabel 27.10.2026", pool, 3, ["&"], { templateKey: "t2" });
    expect(got[0]).toMatchObject({ text: "Daniel&Ruby 28/11/2026", sameTemplate: true, sameStructure: true });
    expect(got.slice(1).every((e) => !e.sameStructure || !e.sameTemplate)).toBe(true);
    const alone = pickSimilarExamples("Sara & Luca", pool, 3, ["&"], { templateKey: "t2" });
    expect(alone.some((e) => e.sameStructure)).toBe(false);
    expect(similarExamplesSection(alone)).not.toContain("strongest evidence");
  });
});
