import { describe, expect, it } from "vitest";
import { LEGACY_ENV_NAMES, tagpressEnv } from "./env.ts";

describe("tagpressEnv: yeni ad önce, eski ad geriye uyum", () => {
  it("yalnız yeni ad verilmişse onu okur", () => {
    expect(tagpressEnv("DATA_DIR", { TAGPRESS_DATA_DIR: "/yeni" })).toBe("/yeni");
  });

  it("yalnız eski ad verilmişse onu kabul eder", () => {
    expect(tagpressEnv("DATA_DIR", { STUDIO_DATA_DIR: "/eski" })).toBe("/eski");
  });

  it("ikisi birden verilmişse yeni ad kazanır", () => {
    expect(tagpressEnv("URL", { TAGPRESS_URL: "http://yeni", STUDIO_URL: "http://eski" })).toBe("http://yeni");
  });

  it("yeni ad boş da olsa tanımlıdır: eskiye düşülmez (boş değer anlamlı olabilir, ör. kapalı)", () => {
    expect(tagpressEnv("SYSTEM_FONT_DIRS", { TAGPRESS_SYSTEM_FONT_DIRS: "", STUDIO_SYSTEM_FONT_DIRS: "/eski" })).toBe("");
  });

  it("hiçbiri yoksa undefined; değer kırpılmaz", () => {
    expect(tagpressEnv("BOOTSTRAP", {})).toBeUndefined();
    expect(tagpressEnv("BOOTSTRAP", { TAGPRESS_BOOTSTRAP: " 1 " })).toBe(" 1 ");
  });

  it("ortam verilmezse süreç ortamını okur", () => {
    const keys = ["TAGPRESS_BOOTSTRAP", "STUDIO_BOOTSTRAP"] as const;
    const saved = keys.map((k) => process.env[k]);
    try {
      delete process.env.TAGPRESS_BOOTSTRAP;
      process.env.STUDIO_BOOTSTRAP = "eski";
      expect(tagpressEnv("BOOTSTRAP")).toBe("eski");
      process.env.TAGPRESS_BOOTSTRAP = "yeni";
      expect(tagpressEnv("BOOTSTRAP")).toBe("yeni");
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  it("geriye uyumlu adlar: veri klasörü, ilk açılış içe alımı, sistem fontları, uygulama adresi", () => {
    expect([...LEGACY_ENV_NAMES]).toEqual(["DATA_DIR", "BOOTSTRAP", "SYSTEM_FONT_DIRS", "URL"]);
  });
});
