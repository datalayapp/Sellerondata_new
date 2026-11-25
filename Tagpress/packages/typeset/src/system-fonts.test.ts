import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FontRegistry } from "./registry.ts";
import { SYSTEM_TEXT_FALLBACKS, findSystemFonts, systemFontDirs } from "./system-fonts.ts";
import { TEST_FALLBACK_FONTS_DIR } from "./testing.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sistem-font-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("sistem font klasörleri", () => {
  it("ortam değişkeni verilirse yalnız o klasörler; boş değer = kapalı", () => {
    expect(systemFontDirs({ TAGPRESS_SYSTEM_FONT_DIRS: "" }, "win32")).toEqual([]);
    expect(systemFontDirs({ TAGPRESS_SYSTEM_FONT_DIRS: ` a ${path.delimiter}${path.delimiter}b` }, "linux")).toEqual(["a", "b"]);
    // Eski ad (geriye uyum) da kabul edilir; ikisi birden varsa yeni ad kazanır.
    expect(systemFontDirs({ STUDIO_SYSTEM_FONT_DIRS: "eski" }, "linux")).toEqual(["eski"]);
    expect(systemFontDirs({ TAGPRESS_SYSTEM_FONT_DIRS: "", STUDIO_SYSTEM_FONT_DIRS: "eski" }, "linux")).toEqual([]);
  });

  it("platforma göre bilinen klasörler (kullanıcıya özgü sabit yol yok)", () => {
    expect(systemFontDirs({ WINDIR: "W:\\Win", LOCALAPPDATA: "L:\\App" }, "win32", "H")).toEqual([
      path.join("W:\\Win", "Fonts"),
      path.join("L:\\App", "Microsoft", "Windows", "Fonts"),
    ]);
    expect(systemFontDirs({}, "win32", "H")).toEqual([]);
    expect(systemFontDirs({}, "darwin", "/ev")).toContain(path.join("/ev", "Library", "Fonts"));
    const linux = systemFontDirs({ XDG_DATA_HOME: "/xdg" }, "linux", "/ev");
    expect(linux[0]).toBe(path.join("/xdg", "fonts"));
    expect(linux).toContain("/usr/share/fonts");
  });

  it("dosya adı büyük/küçük harf duyarsız, alt klasörlerde de bulunur; verilen sırayla, yinelemesiz", () => {
    const dir = path.join(tmp, "ara");
    mkdirSync(path.join(dir, "truetype", "dejavu"), { recursive: true });
    writeFileSync(path.join(dir, "truetype", "dejavu", "DejaVuSans.ttf"), "");
    writeFileSync(path.join(dir, "ARIAL.TTF"), "");
    writeFileSync(path.join(dir, "notlar.txt"), "");
    expect(findSystemFonts(["yok.ttf", "dejavusans.ttf", "arial.ttf", "DejaVuSans.ttf"], [dir])).toEqual([
      path.join(dir, "truetype", "dejavu", "DejaVuSans.ttf"),
      path.join(dir, "ARIAL.TTF"),
    ]);
    expect(findSystemFonts(["arial.ttf"], [])).toEqual([]);
    expect(findSystemFonts(["arial.ttf"], [path.join(tmp, "olmayan")])).toEqual([]);
  });
});

describe("kayıtta sistem yedeği", () => {
  const KEYS = ["TAGPRESS_SYSTEM_FONT_DIRS", "STUDIO_SYSTEM_FONT_DIRS"] as const;
  const prev = KEYS.map((k) => process.env[k]);
  afterEach(() => {
    KEYS.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
  });
  // Bilinen bir sistem yedeği adıyla (listenin son adı) fikstürdeki Arapça font: hangi platformda olursa olsun aynı.
  const dir = path.join(tmp, "sistem");
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(TEST_FALLBACK_FONTS_DIR, "NotoNaskhArabic[wght].ttf"), path.join(dir, SYSTEM_TEXT_FALLBACKS.at(-1)!));

  it("varsayılan açık: ortak klasörde olmayan karakter sistem yedeğinden basılır; kapalıyken null", () => {
    process.env.TAGPRESS_SYSTEM_FONT_DIRS = dir;
    // Uygulamayla gelen yedekler kapalı: Arapça onlarda da var, burada yalnız sistem yedeği sınanır.
    expect(FontRegistry.createSync({ bundledFallbacks: false }).fallbackFor("م")).toBe("Noto Naskh Arabic/Regular");
    expect(FontRegistry.createSync({ bundledFallbacks: false, systemFallbacks: false }).fallbackFor("م")).toBeNull();
    process.env.TAGPRESS_SYSTEM_FONT_DIRS = "";
    expect(FontRegistry.createSync({ bundledFallbacks: false }).fallbackFor("م")).toBeNull();
  });
});
