import type { BuildEntry, BuildQuestion, RuleChange } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import "../../i18n/test.ts";
import { answerBody, chatItems, composerKind, DEFAULT_LABEL_MM, getPath, layoutShowcase, mergeEntries, summaryGroups } from "./akis.ts";
import { bildirimMetni, kaynakMetni, notMetni, olcuMetni, oturumHatasi } from "./metin.ts";

const at = "2026-11-22T10:00:00.000Z";
const q = (id: string, o: Partial<BuildQuestion> = {}): BuildQuestion => ({
  id,
  entryId: 1,
  group: "satir-bolme",
  text: `Soru ${id}`,
  measured: null,
  suggestion: null,
  options: [
    { label: "Alt alta", value: "always" },
    { label: "Yan yana", value: "never" },
  ],
  free: true,
  paths: [],
  answered: false,
  ...o,
});
const e = (id: number, o: Partial<BuildEntry>): BuildEntry => ({ id, at, role: "assistant", kind: "text", turnSeq: 1, text: null, group: null, ...o });

describe("akış girdileri", () => {
  it("birleştirme kimliğe göre tekil ve sıralı", () => {
    const a = [e(1, { text: "a" }), e(3, { text: "c" })];
    const r = mergeEntries(a, [e(2, { text: "b" }), e(3, { text: "c2" })]);
    expect(r.map((x) => [x.id, x.text])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c2"],
    ]);
    expect(mergeEntries(a, [])).toBe(a);
  });

  it("sohbet öğeleri: soru, seçilen cevap, düzeltme, bildirim", () => {
    const entries = [
      e(1, { text: "Merhaba" }),
      e(2, { kind: "question", question: q("q1") }),
      e(3, { role: "user", kind: "answer", answer: { questionId: "q1", option: 0, text: null, value: "always" } }),
      e(4, { kind: "revision", rev: 1, text: "ilk taslak" }),
      e(5, { role: "user", kind: "correction", text: "tarihi küçült" }),
      e(6, { role: "system", kind: "notice", code: "budget-raised", params: { limitUsd: 6 } }),
      e(7, { kind: "text", text: "  " }),
    ];
    const items = chatItems(entries, new Set());
    expect(items.map((i) => i.kind)).toEqual(["ai", "question", "me", "revision", "me", "notice"]);
    expect(items[1]).toMatchObject({ kind: "question", pending: false, picked: 0 });
    expect(items[2]).toMatchObject({ kind: "me", text: "Alt alta", tag: "answer" });
    expect(items[4]).toMatchObject({ kind: "me", text: "tarihi küçült", tag: "correction" });
    expect(chatItems(entries, new Set(["q1"]))[1]).toMatchObject({ pending: true });
  });
});

describe("yazı kutusu", () => {
  it("durum → ileti türü", () => {
    expect(composerKind("awaiting-user")).toBe("answer");
    expect(composerKind("review")).toBe("correction");
    expect(composerKind("samples")).toBe("note");
    expect(composerKind("drafting")).toBeNull();
    expect(composerKind("published")).toBeNull();
  });

  it("cevap gövdesi: seçenekler soru başına, metin tek açık soruya ya da genel", () => {
    const qs = [q("a"), q("b")];
    expect(answerBody(qs, {}, "")).toBeNull();
    expect(answerBody(qs, { a: 1 }, "")).toEqual({ kind: "answer", answers: [{ questionId: "a", option: 1 }] });
    expect(answerBody(qs, { a: 1 }, "yan yana dursun")).toEqual({
      kind: "answer",
      answers: [
        { questionId: "a", option: 1 },
        { questionId: "b", text: "yan yana dursun" },
      ],
    });
    expect(answerBody(qs, {}, "ikisi de")).toEqual({ kind: "answer", text: "ikisi de" });
    expect(answerBody([q("a", { free: false })], {}, "metin")).toEqual({ kind: "answer", text: "metin" });
    expect(answerBody(qs, { a: 9 }, "")).toBeNull();
  });
});

describe("örnek etiket yerleşimi", () => {
  it("üç sütun, en büyük örneğe göre; ölçüsüz kare", () => {
    const { boxes, world } = layoutShowcase([
      { id: "a", sizeMm: { shape: "circle", w: 38, h: 38 } },
      { id: "b", sizeMm: null },
      { id: "c", sizeMm: { shape: "rect", w: 63.5, h: 38.1 } },
      { id: "d", sizeMm: { shape: "circle", w: 25, h: 25 } },
    ]);
    expect(boxes.map((b) => b.id)).toEqual(["a", "b", "c", "d"]);
    expect(boxes[1]).toMatchObject({ w: DEFAULT_LABEL_MM, h: DEFAULT_LABEL_MM });
    // Sütunlar örtüşmez; ikinci satır birincinin altında.
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.w);
    expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.h);
    expect(world.w).toBeGreaterThanOrEqual(boxes[2]!.x + boxes[2]!.w);
    expect(world.h + world.y).toBeGreaterThanOrEqual(boxes[3]!.y + boxes[3]!.h);
  });
});

describe("özet", () => {
  const profile = { sizing: { fill: 0.94, tiers: { secondary: 0.6, tertiary: 0.38, connector: 0.55 } }, spacing: { align: "center" } };
  const change: RuleChange = { path: "sizing.tiers.tertiary", group: "boyut", label: "sizing.tiers.tertiary", unit: "oran", from: 0.45, to: 0.38, source: { kind: "correction", ref: "5" } };
  const extra: RuleChange = { path: "weight.minPx", group: "kalinlik-renk", label: "weight.minPx", unit: "px", from: 0, to: 0.3, source: { kind: "measurement", ref: "w", n: 6 } };

  it("gruplar sıralı; değişen satır işaretli; listede olmayan değişiklik grubuna eklenir", () => {
    const g = summaryGroups(profile as never, [change, extra]);
    expect(g.map((x) => x.group)).toEqual(["boyut", "bosluk", "kalinlik-renk"]);
    const boyut = g[0]!.rows;
    expect(boyut.find((r) => r.path === "sizing.tiers.tertiary")).toMatchObject({ value: 0.38, change });
    expect(boyut.find((r) => r.path === "sizing.fill")).toMatchObject({ value: 0.94, change: null });
    expect(g[2]!.rows).toEqual([{ path: "weight.minPx", value: 0.3, change: extra }]);
    expect(getPath(profile, "sizing.tiers.secondary")).toBe(0.6);
    expect(getPath(profile, "yok.burada")).toBeUndefined();
  });

  it("kaynak, not, ölçü, hata ve bildirim cümleleri sözlükten", () => {
    expect(kaynakMetni(change)).toBe("düzeltmeniz");
    expect(kaynakMetni(extra)).toBe("ölçüm · 6 örnek");
    expect(notMetni([{ label: "sizing.tiers.tertiary", direction: "down" }])).toMatch(/küçüldü$/);
    expect(olcuMetni({ shape: "circle", w: 38, h: 38 })).toBe("Ø 38 mm");
    expect(olcuMetni({ shape: "rect", w: 63.5, h: 38.1 })).toBe("63,5 × 38,1 mm");
    expect(olcuMetni(null)).toBeNull();
    expect(oturumHatasi({ code: "rate-limited" })).toBe("Yapay zekâ hizmeti şu an yoğun.");
    expect(oturumHatasi({ code: "bilinmeyen" })).toBe("Bir hata oldu.");
    expect(bildirimMetni("budget-raised", { limitUsd: 6 })).toBe("Oturum sınırı $6,00 oldu.");
    expect(bildirimMetni("retrying", { waitMs: 4200, attempt: 2 })).toContain("5 sn");
    // Bütçe dolunca tur sessiz bitmez; dışarıdan değişen taslak saklandığında söylenir.
    expect(bildirimMetni("budget-stopped", { scope: "month", usedUsd: 1.6, limitUsd: 1.5 })).toBe("Harcama sınırına ulaşıldı ($1,60 / $1,50); bu tur durdu.");
    expect(bildirimMetni("draft-replaced", { rev: 3 })).toBe("Taslak bu oturumun dışında değiştirilmişti; o hâli sürüm 3 olarak saklandı.");
  });
});
