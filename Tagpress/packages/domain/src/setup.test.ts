import { describe, expect, it } from "vitest";
import { effectiveFeatures, FEATURE_KEYS, type FeatureKey } from "./features.ts";
import { LABEL_TYPES, previewSetup, printDefaultsFromSetup, SETUP_API, SetupAnswersSchema, SetupStateSchema, suggestFeatures, type LabelType } from "./setup.ts";

const AT = "2026-11-21T10:00:00.000Z";
const COMMON: FeatureKey[] = [
  "core.production",
  "import.json",
  "jobs.manual",
  "adjust",
  "revise",
  "print",
  "templates.editor",
  "language.builder",
];
const NEVER: FeatureKey[] = [
  "image.onTemplate",
  "image.themeTemplate",
  "learn",
  "language.rules",
  "language.multi",
  "language.package",
  "text.languages",
];

describe("suggestFeatures", () => {
  it("tür sırası plan §3.2 ile aynı", () => {
    expect([...LABEL_TYPES]).toEqual(["wedding", "baptism", "birthday", "thanks", "product", "sticker"]);
  });
  it("boş seçimde ortak küme", () => {
    expect(suggestFeatures({ labelTypes: [] }).sort()).toEqual([...COMMON].sort());
  });
  it.each(LABEL_TYPES.filter((t) => t !== "sticker"))("%s yalnız ortak kümeyi açar", (t: LabelType) => {
    expect(suggestFeatures({ labelTypes: [t] }).sort()).toEqual([...COMMON].sort());
  });
  it("sticker ayrıca print.stickers açar", () => {
    expect(suggestFeatures({ labelTypes: ["sticker"] }).sort()).toEqual([...COMMON, "print.stickers"].sort());
  });
  it("hiçbir seçim ücretli ya da ileri özellik açmaz", () => {
    const s = suggestFeatures({ labelTypes: [...LABEL_TYPES] });
    for (const k of NEVER) expect(s).not.toContain(k);
  });
});

describe("previewSetup", () => {
  it("varsayılan durumda sticker yalnız print.stickers'ı açar", () => {
    const r = previewSetup({ labelTypes: ["sticker"] }, {}, AT);
    expect(r.changes).toEqual([{ key: "print.stickers", from: false, to: true }]);
    expect(r.features["print.stickers"]).toBe(true);
  });
  it("kullanıcının elle açtığı özellik kapatılmaz", () => {
    const explicit = { learn: { on: true, by: "user" as const, at: AT } };
    const r = previewSetup({ labelTypes: [] }, explicit, AT);
    expect(r.features.learn).toBe(true);
    expect(r.changes.find((c) => c.key === "learn")).toBeUndefined();
  });
  it("göçle açılmış özellik kapatılmaz", () => {
    const explicit = { learn: { on: true, by: "migration" as const, at: AT } };
    const r = previewSetup({ labelTypes: [] }, explicit, AT);
    expect(r.features.learn).toBe(true);
    expect(r.changes.find((c) => c.key === "learn")).toBeUndefined();
  });
  it("kurulumun (setup) açtığı ama artık önerilmeyen özellik kapanır", () => {
    const explicit = { "print.stickers": { on: true, by: "setup" as const, at: AT } };
    const r = previewSetup({ labelTypes: ["wedding"] }, explicit, AT);
    expect(r.changes).toEqual([{ key: "print.stickers", from: true, to: false }]);
  });
  it("özellik haritası bütün anahtarları içerir; değişiklik yoksa etkin durumla aynı", () => {
    const r = previewSetup({ labelTypes: [] }, {}, AT);
    expect(Object.keys(r.features).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(r.changes).toEqual([]);
    expect(r.features).toEqual(effectiveFeatures({}));
  });
});

describe("SETUP_API", () => {
  const eps = Object.values(SETUP_API);
  it("8 uç (plan §3.4); metot + yol çifti benzersiz", () => {
    expect(eps).toHaveLength(8);
    const keys = eps.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("setup yolları benzersiz", () => {
    const paths = eps.filter((e) => e.path.startsWith("/api/setup")).map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
  it("durum şeması örnek değeri kabul eder", () => {
    const ok = SetupStateSchema.safeParse({
      status: "in-progress",
      step: 2,
      answers: { labelTypes: ["sticker"], language: { choice: "default" } },
      completedAt: null,
      skipped: false,
    });
    expect(ok.success).toBe(true);
  });
});

describe("kurulumdaki baskı cevapları → varsayılanlar (mm)", () => {
  it("eski cevaplar okunur; sorulmayan her şey standart (A4, çizgi basılır, işaret yok, taşma 0, sticker Ø38 mm)", () => {
    expect(SetupAnswersSchema.parse({ labelTypes: [], print: { paperPreset: "a4", usesCutter: true } }).print).toEqual({ paperPreset: "a4", usesCutter: true });
    const d = printDefaultsFromSetup({});
    expect(d.paper).toEqual({ wMm: 210, hMm: 297 });
    expect(d.cut).toEqual({ outlineVisible: true, cutFile: false, bleedMm: 0, registration: { enabled: false, style: "corners-l" } });
    expect(d.sticker.maxW * (25.4 / 72)).toBeCloseTo(38, 9);
    expect(printDefaultsFromSetup({ print: { paperPreset: "bilinmeyen" } }).paper).toEqual({ wMm: 210, hMm: 297 });
  });

  it("kağıt, kağıt türü, makine ve sticker ölçüsü", () => {
    expect(printDefaultsFromSetup({ print: { paperPreset: "letter" } }).paper).toEqual({ wMm: 215.9, hMm: 279.4 });
    expect(printDefaultsFromSetup({ print: { paperType: "precut", usesCutter: false } }).cut.outlineVisible).toBe(false);
    expect(printDefaultsFromSetup({ print: { usesCutter: true, cutter: "silhouette" } }).cut).toEqual({ outlineVisible: true, cutFile: true, bleedMm: 1, registration: { enabled: false, style: "corners-l" } });
    expect(printDefaultsFromSetup({ print: { usesCutter: true, cutter: "plotter" } }).cut.registration).toEqual({ enabled: true, style: "corners-l" });
    expect(printDefaultsFromSetup({ print: { usesCutter: false, cutter: "plotter" } }).cut.registration.enabled).toBe(false);
    expect(printDefaultsFromSetup({ print: { stickerSizeMm: 50 } }).sticker.maxW * (25.4 / 72)).toBeCloseTo(50, 9);
    expect(SetupAnswersSchema.safeParse({ labelTypes: [], print: { stickerSizeMm: 5 } }).success).toBe(false);
  });
});
