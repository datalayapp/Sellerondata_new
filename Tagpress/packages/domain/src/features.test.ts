import { describe, expect, it } from "vitest";
import {
  applyToggle,
  effectiveFeatures,
  FEATURE_GROUPS,
  FEATURE_KEYS,
  FeatureError,
  FeatureStateSchema,
  FEATURES,
  type FeatureKey,
} from "./features.ts";
import { SETUP_FEATURE_RULES } from "./setup.ts";

// Plan §3.1 tablosu (varsayılan açık mı).
const PLAN_DEFAULTS: Record<FeatureKey, boolean> = {
  "core.production": true,
  "import.json": true,
  "jobs.manual": true,
  adjust: true,
  revise: true,
  "image.onTemplate": false,
  "image.themeTemplate": false,
  learn: false,
  print: true,
  "print.stickers": false,
  "templates.editor": true,
  "language.builder": true,
  "language.rules": false,
  "language.multi": false,
  "language.package": false,
  "text.languages": false,
};
const PLAN_PAID: Partial<Record<FeatureKey, string>> = {
  "core.production": "haiku",
  revise: "haiku",
  "image.onTemplate": "gemini",
  "image.themeTemplate": "gemini",
  "language.builder": "opus",
};

const AT = "2026-11-21T10:00:00.000Z";

describe("özellik kaydı", () => {
  it("16 anahtar (görsel denetim üründen kalktı, SUNUCU-PLANI §9); her birinin tanımı ve geçerli grubu var", () => {
    expect(FEATURE_KEYS).toHaveLength(16);
    expect(FEATURE_KEYS as readonly string[]).not.toContain("critique");
    for (const k of FEATURE_KEYS) {
      expect(FEATURES[k].key).toBe(k);
      expect(FEATURE_GROUPS).toContain(FEATURES[k].group);
    }
  });

  it("ücret ve varsayılanlar plan tablosuyla eşleşir", () => {
    for (const k of FEATURE_KEYS) {
      expect(FEATURES[k].defaultOn, k).toBe(PLAN_DEFAULTS[k]);
      expect(FEATURES[k].paid, k).toBe(PLAN_PAID[k] ?? "none");
    }
    expect(FEATURES["core.production"].always).toBe(true);
    expect(FEATURES["print.stickers"].dependsOn).toEqual(["print"]);
  });

  it("bağımlılık döngüsü yok, bağımlılıklar kayıtlı", () => {
    for (const k of FEATURE_KEYS) {
      const seen = new Set<FeatureKey>();
      const stack = [...(FEATURES[k].dependsOn ?? [])];
      while (stack.length) {
        const d = stack.pop()!;
        expect(FEATURES[d], d).toBeDefined();
        expect(d, `${k} döngüsü`).not.toBe(k);
        if (seen.has(d)) continue;
        seen.add(d);
        stack.push(...(FEATURES[d].dependsOn ?? []));
      }
    }
  });
});

describe("effectiveFeatures", () => {
  it("boş seçimde varsayılanlar", () => {
    expect(effectiveFeatures({})).toEqual(PLAN_DEFAULTS);
  });
  it("açık seçim varsayılanı ezer; always kapatılamaz", () => {
    const e = effectiveFeatures({
      learn: { on: true, by: "user", at: AT },
      adjust: { on: false, by: "user", at: AT },
      "core.production": { on: false, by: "user", at: AT },
    });
    expect(e.learn).toBe(true);
    expect(e.adjust).toBe(false);
    expect(e["core.production"]).toBe(true);
  });
  it("bağımlısı kapalı özellik kapalı sayılır", () => {
    const e = effectiveFeatures({
      "print.stickers": { on: true, by: "user", at: AT },
      print: { on: false, by: "user", at: AT },
    });
    expect(e["print.stickers"]).toBe(false);
  });
});

describe("applyToggle", () => {
  it("açarken bağımlılık zinciri de açılır", () => {
    const off = { print: { on: false, by: "user" as const, at: AT } };
    const r = applyToggle(off, "print.stickers", true, "user", AT);
    expect(r.explicit.print?.on).toBe(true);
    expect(r.explicit["print.stickers"]?.on).toBe(true);
    expect(r.changed.sort()).toEqual(["print", "print.stickers"]);
    expect(effectiveFeatures(r.explicit)["print.stickers"]).toBe(true);
  });
  it("kapatırken bağlılar da kapanır", () => {
    const on = applyToggle({}, "print.stickers", true, "user", AT).explicit;
    const r = applyToggle(on, "print", false, "user", AT);
    expect(r.changed.sort()).toEqual(["print", "print.stickers"]);
    const e = effectiveFeatures(r.explicit);
    expect(e.print).toBe(false);
    expect(e["print.stickers"]).toBe(false);
  });
  it("sıradan anahtar yalnız kendini değiştirir; girdi değişmez", () => {
    const input = {};
    const r = applyToggle(input, "learn", true, "user", AT);
    expect(r.changed).toEqual(["learn"]);
    expect(r.explicit.learn).toEqual({ on: true, by: "user", at: AT });
    expect(input).toEqual({});
  });
  it("always kapatılamaz", () => {
    expect(() => applyToggle({}, "core.production", false, "user", AT)).toThrow(FeatureError);
    try {
      applyToggle({}, "core.production", false, "user", AT);
    } catch (e) {
      expect((e as FeatureError).code).toBe("always-on");
    }
  });
});

describe("FeatureStateSchema", () => {
  it("bilinmeyen anahtarı atar, hata vermez", () => {
    const r = FeatureStateSchema.parse({
      learn: { on: true, by: "setup", at: AT },
      eskiOzellik: { on: true, by: "user", at: AT },
    });
    expect(Object.keys(r)).toEqual(["learn"]);
  });
  it("bilinen anahtarın bozuk seçimi reddedilir", () => {
    expect(FeatureStateSchema.safeParse({ learn: { on: "evet" } }).success).toBe(false);
  });
});

describe("kurulumdaki yer (`setup`)", () => {
  it("`core` = adım 1'in ortak kümesi; `hidden` = her zaman açık; geri kalanı isteğe bağlı ve hiçbir türle kendiliğinden açılmaz (sticker → yalnız print.stickers)", () => {
    const common = new Set<FeatureKey>(SETUP_FEATURE_RULES.always);
    for (const k of FEATURE_KEYS) {
      const place = FEATURES[k].setup;
      if (FEATURES[k].always) expect(place, k).toBe("hidden");
      else if (common.has(k)) expect(place, k).toBe("core");
      else expect(place, k).toBe("optional");
    }
    const byType = Object.values(SETUP_FEATURE_RULES.byType).flat();
    expect(byType).toEqual(["print.stickers"]);
    // Müşteri metni dilleri ve birden çok tasarım dili ayrı seçenekler, ikisi de varsayılan kapalı.
    for (const k of ["text.languages", "language.multi"] as const) expect([FEATURES[k].setup, FEATURES[k].defaultOn], k).toEqual(["optional", false]);
  });
});
