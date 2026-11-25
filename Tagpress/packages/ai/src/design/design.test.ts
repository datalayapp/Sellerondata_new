import { PROFILE_DOCS, ProfileSchema } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { RULE_KEYS } from "../profile-rules.ts";
import { profileA, profileB } from "../test-fixtures.ts";
import { createFakeClaude, reply, requestText, systemText } from "../testing.ts";
import { fontCatalog, longestUppercaseRun } from "./fonts.ts";
import { proposeDesigns } from "./propose.ts";
import { buildDesignSystem, buildDesignUser, designWire } from "./prompt.ts";
import { checkIntentText } from "./rules.ts";
import { validateCandidates } from "./validate.ts";

const TEXT = "Grazie di cuore Anna & Luca";
const line = (text: string, role: string, tier: string | null, fontId = "Velvet Script/Regular") => ({ text, role, tier, fontId });
const good = { rationale: "Selam üstte, isimler büyük.", lines: [line("Grazie di cuore", "greeting", "secondary"), line("Anna & Luca", "name", "primary")] };

function ctxA(extra: Partial<Parameters<typeof validateCandidates>[1]> = {}) {
  const fonts = fontCatalog(profileA, TEXT);
  return { text: TEXT, segments: [], profile: profileA, fonts, wire: designWire(profileA, fonts.filter((f) => f.usable).map((f) => f.id)), ...extra };
}

describe("istem profilden üretilir", () => {
  it("bütün kural anahtarları PROFILE_DOCS'ta belgeli", () => {
    for (const k of RULE_KEYS) expect(PROFILE_DOCS[k], k).toBeDefined();
  });

  it("farklı profil → farklı istem; değerler ve etiketler profilden", () => {
    const a = buildDesignSystem(profileA, fontCatalog(profileA, TEXT));
    const b = buildDesignSystem(profileB, fontCatalog(profileB, TEXT));
    expect(a).not.toBe(b);
    expect(a).toContain("Zarif ve ferah; isimler büyük.");
    expect(b).toContain("Canlı, oyuncu");
    expect(a).toContain("No line may be longer than 20 characters");
    expect(b).toContain("No line may be longer than 28 characters");
    expect(a).toContain(`[${PROFILE_DOCS["lineBreaking.maxLineChars"]!.label}]`);
    expect(a).toContain('"di", "per"');
    expect(a).toContain("Selamı ismin üstüne koy.");
    expect(a).toContain('"Grazie Anna & Luca" → "Grazie" / "Anna" / "&" / "Luca"');
    // Glif kuralı: bilgi olarak, font profilden.
    expect(a).toMatch(/"&" → Old Fell Italic at 0\.5×/);
    expect(a).toContain("ONE font family");
    expect(b).toContain("at most TWO font families");
    // Tarz koda gömülmemiş: bir profilin fontları ötekinin isteminde geçmez.
    expect(b).not.toContain("Velvet");
    expect(a).not.toContain("Bubble");
    // Motor alanları ayrı bölümde.
    expect(a).toMatch(/Applied by the layout engine[\s\S]*Line sizes come only from the tier/);
    expect(b).toMatch(/You may give each line a "size"/);
  });

  it("kilitli alanlar şemadan çıkar", () => {
    const sa = JSON.stringify(designWire(profileA, ["Velvet Script/Regular"]).jsonSchema);
    const sb = JSON.stringify(designWire(profileB, ["Round Sans/Regular"]).jsonSchema);
    expect(sa).not.toContain('"size"');
    expect(sa).not.toContain('"fill"');
    expect(sb).toContain('"size"');
    expect(sb).toContain('"fill"');
    expect(sa).toContain("Velvet Script/Regular");
    expect(sa).not.toMatch(/minimum|maxLength|minItems/);
  });

  it("işe özel mesaj: metin, bloklu font nedeni, şablon ipucu, önceki varyasyonlar", () => {
    const fonts = fontCatalog(profileA, "ANNA & LUCA");
    expect(fonts.find((f) => f.id === "Velvet Script/Regular")!.usable).toBe(false);
    const u = buildDesignUser(
      {
        text: "ANNA & LUCA",
        profile: profileA,
        template: { key: "t1", notes: "çiçek çelengi", widthHints: [{ at: 0.2, chars: 9 }, { at: 0.5, chars: 16 }] },
        previous: [{ lines: ["ANNA & LUCA"] }],
        candidates: 2,
      },
      fonts,
    );
    expect(u).toContain("ANNA & LUCA");
    expect(u).toMatch(/"Velvet Script\/Regular": the text has 4 capitals in a row/);
    expect(u).toContain("çiçek çelengi");
    expect(u).toContain("50%: ~16");
    expect(u).toContain('1. "ANNA & LUCA"');
    expect(u).toContain("Return exactly 2 candidates");
    expect(longestUppercaseRun("ANNA & LUCA")).toBe(4);
  });
});

describe("aday doğrulama", () => {
  it("geçerli aday niyete dönüşür; eksik tier rolden gelir", () => {
    const r = validateCandidates([{ ...good, lines: [line("Grazie di cuore", "greeting", null), line("Anna & Luca", "name", null)] }], ctxA());
    expect(r.rejected).toEqual([]);
    expect(r.valid[0]!.intent.lines.map((l) => l.tier)).toEqual(["secondary", "primary"]);
    expect(r.valid[0]!.intent.lines[0]!.size).toBeUndefined();
  });

  it("metni değiştiren aday reddedilir (büyük harf, noktalama, sıra)", () => {
    const bad = [
      { ...good, lines: [line("Grazie Di cuore", "greeting", "secondary"), line("Anna & Luca", "name", "primary")] },
      { ...good, lines: [line("Anna & Luca", "name", "primary"), line("Grazie di cuore", "greeting", "secondary")] },
      { ...good, lines: [line("Grazie di cuore!", "greeting", "secondary"), line("Anna & Luca", "name", "primary")] },
    ];
    const r = validateCandidates(bad, ctxA());
    expect(r.valid).toEqual([]);
    expect(r.rejected.every((x) => x.issues.some((i) => i.code === "text-changed"))).toBe(true);
    expect(r.repairIssues[0]).toMatch(/Candidate 1: .*reproduce the customer's text/);
  });

  it("sembol bağlaç çevresindeki boşluk (izin varsa) metin değişikliği sayılmaz", () => {
    const fonts = fontCatalog(profileA, "Anna&Luca");
    const r = validateCandidates([{ rationale: "", lines: [line("Anna", "name", "primary"), line("&", "connector", "connector"), line("Luca", "name", "primary")] }], {
      ...ctxA(),
      text: "Anna&Luca",
      fonts,
    });
    expect(r.valid).toHaveLength(1);
  });

  it("font: katalog dışı, kullanılamaz (büyük harf sınırı), rol uyumsuz, aile karışımı", () => {
    const text = "GRAZIE Anna";
    const fonts = fontCatalog(profileA, text);
    const wire = designWire(profileA, ["Plain Sans/Regular", "Velvet Script/Regular", "Old Fell/Italic"]);
    const o = { ...ctxA(), text, fonts, wire };
    const r = validateCandidates(
      [
        { rationale: "", lines: [line("GRAZIE", "greeting", "secondary"), line("Anna", "name", "primary")] }, // Velvet: büyük harf
        { rationale: "", lines: [line("GRAZIE", "greeting", "secondary", "Old Fell/Italic"), line("Anna", "name", "primary", "Plain Sans/Regular")] }, // rolsüz font
        { rationale: "", lines: [line("GRAZIE", "greeting", "secondary", "Plain Sans/Regular"), line("Anna", "name", "primary", "Nope/Regular")] }, // katalog dışı
      ],
      o,
    );
    expect(r.valid).toEqual([]);
    expect(r.rejected.map((x) => x.issues.map((i) => i.code))).toEqual([["font-unavailable", "font-unavailable"], ["font-unavailable", "font-mixing"], ["font-unavailable"]]);
  });

  it("aynı satır bölmesi farklı fontla yineleme sayılmaz; önceki varyasyonla aynı bölme sayılır", () => {
    const sameBreaksOtherFont = { rationale: "", lines: [line("Grazie di cuore", "greeting", "secondary", "Plain Sans/Regular"), line("Anna & Luca", "name", "primary", "Plain Sans/Regular")] };
    const r = validateCandidates([good, sameBreaksOtherFont, good], ctxA());
    expect(r.valid).toHaveLength(2);
    expect(r.rejected.map((x) => x.issues.map((i) => i.code))).toEqual([["ai-duplicate"]]);
    const shown = validateCandidates([sameBreaksOtherFont], ctxA({ previous: [{ lines: ["Grazie di cuore", "Anna & Luca"] }] }));
    expect(shown.valid).toEqual([]);
  });

  it("satır bölme kuralları: uzunluk, tek başına kelime, baş harf, yinelenme", () => {
    const r = validateCandidates(
      [
        { rationale: "", lines: [line("Grazie di cuore Anna & Luca", "message", "primary")] }, // > 20 karakter
        { rationale: "", lines: [line("Grazie", "greeting", "secondary"), line("di", "other", "secondary"), line("cuore", "greeting", "secondary"), line("Anna & Luca", "name", "primary")] },
        good,
      ],
      ctxA({ previous: [{ lines: ["Grazie di cuore", "Anna & Luca"] }] }),
    );
    expect(r.valid).toEqual([]);
    expect(r.rejected[0]!.issues.map((i) => i.code)).toContain("rule-line-too-long");
    expect(r.rejected[1]!.issues.map((i) => i.code)).toContain("rule-lone-word");
    expect(r.rejected[2]!.issues.map((i) => i.code)).toEqual(["ai-duplicate"]);

    // Edat satır SONUNDA kalabilir (yön tarzdır: profil örneklerinden gelir); yalnızca tek başına satır yasak.
    const trailing = validateCandidates([{ rationale: "", lines: [line("Grazie di", "greeting", "secondary"), line("cuore", "greeting", "secondary"), line("Anna & Luca", "name", "primary")] }], ctxA());
    expect(trailing.rejected.flatMap((x) => x.issues.map((i) => i.code))).not.toContain("rule-lone-word");

    const initials = validateCandidates([{ rationale: "", lines: [line("A", "name", "primary"), line("&", "connector", "connector"), line("M", "name", "primary")] }], {
      ...ctxA(),
      text: "A & M",
      fonts: fontCatalog(profileA, "A & M"),
    });
    expect(initials.rejected[0]!.issues.map((i) => i.code)).toContain("rule-initials-split");
  });

  it("profil B: müşteri bölmesi kesin, çift yan yana; oranlar açıkken boyut normalleşir", () => {
    const text = "Mia and Leo Party Time";
    const fonts = fontCatalog(profileB, text);
    const wire = designWire(profileB, fonts.filter((f) => f.usable).map((f) => f.id));
    const o = { text, segments: ["Mia and Leo", "Party Time"], profile: profileB, fonts, wire };
    const r = validateCandidates(
      [
        { rationale: "", fill: 0.7, lines: [{ ...line("Mia and Leo", "name", "primary", "Bubble Display/Regular"), size: 1.2 }, { ...line("Party Time", "title", "secondary", "Round Sans/Regular"), size: 0.6 }] },
        { rationale: "", fill: null, lines: [line("Mia", "name", "primary", "Round Sans/Regular"), line("and", "connector", "connector", "Round Sans/Regular"), line("Leo", "name", "primary", "Round Sans/Regular"), line("Party Time", "title", "secondary", "Round Sans/Regular")] },
        { rationale: "", fill: null, lines: [line("Mia and Leo Party", "name", "primary", "Round Sans/Regular"), line("Time", "title", "secondary", "Round Sans/Regular")] },
      ],
      o,
    );
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]!.intent.lines.map((l) => l.size)).toEqual([1, 0.5]);
    expect(r.valid[0]!.intent.fill).toBe(0.7);
    expect(r.rejected[0]!.issues.map((i) => i.code)).toContain("rule-couple-stack");
    expect(r.rejected[1]!.issues.map((i) => i.code)).toContain("rule-customer-break");
  });

  it("enjekte edilen ek kural (engine checkIntentRules yerine) adayı reddettirir, uyarıyı taşır", () => {
    const extraRules = (intent: { lines: Array<{ text: string }> }) =>
      intent.lines.some((l) => l.text === "Anna & Luca")
        ? [{ code: "rule-couple-stack" as const, severity: "error" as const, message: "isimleri alt alta diz", fixes: [] }]
        : [{ code: "low-fill" as const, severity: "warning" as const, message: "uyarı", fixes: [] }];
    const r = validateCandidates([good, { rationale: "", lines: [line("Grazie di cuore", "greeting", "secondary"), line("Anna", "name", "primary"), line("&", "connector", "connector"), line("Luca", "name", "primary")] }], ctxA({ extraRules }));
    expect(r.rejected[0]!.issues.map((i) => i.code)).toEqual(["rule-couple-stack"]);
    expect(r.repairIssues[0]).toContain("isimleri alt alta diz");
    expect(r.valid[0]!.warnings.map((w) => w.code)).toEqual(["low-fill"]);
  });

  it("tek bozuk aday ötekileri düşürmez (rol enum hatası yalnızca o adayı eler)", () => {
    const r = validateCandidates([{ ...good, lines: [line("Grazie di cuore", "selam", "secondary"), line("Anna & Luca", "name", "primary")] }, good], ctxA());
    expect(r.valid).toHaveLength(1);
    expect(r.rejected[0]!.issues[0]!.code).toBe("ai-failed");
  });
});

describe("proposeDesigns", () => {
  it("geçerli aday yoksa önceki ham yanıt + sorunlarla onarım ister", async () => {
    const bad = { candidates: [{ ...good, lines: [line("Grazie di cuore", "greeting", "secondary"), line("Anna e Luca", "name", "primary")] }] };
    const fixed = { candidates: [good, { rationale: "Dört satır.", lines: [line("Grazie di cuore", "greeting", "secondary"), line("Anna", "name", "primary"), line("&", "connector", "connector"), line("Luca", "name", "primary")] }] };
    const f = createFakeClaude([reply.json(bad), reply.json(fixed)]);
    const res = await proposeDesigns(f.claude, { text: TEXT, profile: profileA, aiNote: "isimler büyük olsun" });
    expect(res.ok).toBe(true);
    expect(res.intents).toHaveLength(2);
    expect(res.attempts).toBe(2);
    const second = f.requests[1]!;
    expect(second.messages[1]!.content).toBe(JSON.stringify(bad));
    expect(second.messages[2]!.content).toMatch(/Candidate 1: the lines do not reproduce/);
    expect(requestText(f.requests[0]!)).toContain("isimler büyük olsun");
    expect(systemText(f.requests[0]!)).toContain("Zarif ve ferah");
    expect(res.usage).toHaveLength(2);
    expect(res.request.user).toContain(TEXT);
  });

  it("kota hatası: çağrı başarısız, ayar hatası olarak işaretli", async () => {
    const f = createFakeClaude([reply.quota()]);
    const res = await proposeDesigns(f.claude, { text: TEXT, profile: profileA });
    expect(res.ok).toBe(false);
    expect(res.configError).toBe(true);
    expect(res.issues[0]!.code).toBe("ai-failed");
  });

  it("kullanılabilir font yoksa AI çağrılmaz", async () => {
    const f = createFakeClaude([]);
    const res = await proposeDesigns(f.claude, { text: TEXT, profile: profileA, fonts: [] });
    expect(res.ok).toBe(false);
    expect(res.issues[0]!.code).toBe("font-unavailable");
    expect(f.requests).toHaveLength(0);
  });

  it("onarımlar tükenirse ai-no-good-candidate", async () => {
    const bad = { candidates: [{ ...good, lines: [line("Grazie", "greeting", "secondary")] }] };
    const f = createFakeClaude([reply.json(bad), reply.json(bad), reply.json(bad)]);
    const res = await proposeDesigns(f.claude, { text: TEXT, profile: profileA });
    expect(res.ok).toBe(false);
    expect(res.issues[0]!.code).toBe("ai-no-good-candidate");
    expect(res.rejected).toHaveLength(1);
    expect(res.raw).toBe(JSON.stringify(bad));
  });
});

describe("örnekte tek satır duran kısa ifade", () => {
  const L = (text: string, role: "greeting" | "name" | "message" = "greeting") => ({ text, role, tier: "primary" as const });
  const profile = ProfileSchema.parse({
    name: "x",
    lineBreaking: {
      keepShortGreetings: false,
      examples: [
        { text: "Thank You", lines: ["Thank You"] },
        { text: "Merry Christmas", lines: ["Merry", "Christmas"] },
      ],
    },
  });
  const codes = (lines: ReturnType<typeof L>[], text: string) => checkIntentText(lines, text, [], profile).map((p) => p.issue.code);
  it("genel kural kapalıyken de örnekteki tek satırlık ifade bölünemez; bölünen örnekler serbest", () => {
    expect(codes([L("Thank"), L("You")], "Thank You")).toContain("rule-split-greeting");
    expect(codes([L("Thank you!")], "Thank you!")).not.toContain("rule-split-greeting");
    expect(codes([L("Thank you"), L("for coming", "message")], "Thank you for coming")).not.toContain("rule-split-greeting");
    expect(codes([L("Thank"), L("you for coming", "message")], "Thank you for coming")).toContain("rule-split-greeting");
    expect(codes([L("Merry"), L("Christmas!")], "Merry Christmas!")).not.toContain("rule-split-greeting");
    expect(codes([L("Frohe"), L("Weihnachten")], "Frohe Weihnachten")).not.toContain("rule-split-greeting");
  });
});
