import { describe, expect, it } from "vitest";
import { DEFAULT_FONTS, DEFAULT_LANGUAGE_NAME, ProfileSchema, defaultProfile, emptyProfile } from "./index.ts";

describe("varsayılan profil", () => {
  it("şemadan geçer ve şema varsayılanlarından başka değer taşımaz (yalnız ad, açıklama, font listesi)", () => {
    const p = defaultProfile();
    expect(ProfileSchema.parse(p)).toEqual(p);
    expect(p.name).toBe(DEFAULT_LANGUAGE_NAME);
    // Font listesi ve açıklama dışındaki her alan boş profilin (şema varsayılanlarının) aynısı: uydurma ölçüm yok.
    expect({ ...p, description: "", fonts: { ...p.fonts, list: [] } }).toEqual(emptyProfile(DEFAULT_LANGUAGE_NAME));
    expect(p.fonts.mixing).toBe(emptyProfile("x").fonts.mixing);
  });

  it("font listesi: bir el yazısı, bir serif, bir sans; kimlik = aile/stil, dosyası ve rolü var", () => {
    const list = defaultProfile().fonts.list;
    expect(list.map((f) => f.kind).sort()).toEqual(["sans", "script", "serif"]);
    expect(new Set(list.map((f) => f.id)).size).toBe(list.length);
    for (const f of list) {
      expect(f.id).toBe(`${f.family}/${f.style}`);
      expect(f.file).toMatch(/\.(ttf|otf)$/);
      expect(f.roles.length).toBeGreaterThan(0);
      expect(f.enabled).toBe(true);
    }
    expect(list).toEqual(DEFAULT_FONTS);
  });

  it("her çağrı yeni nesne döner (değiştirmek sonrakini etkilemez); ad verilebilir", () => {
    const a = defaultProfile();
    a.fonts.list[0]!.roles.push("accent");
    a.sizing.fill = 0.5;
    const b = defaultProfile("Yeni");
    expect(b.name).toBe("Yeni");
    expect(b.sizing.fill).toBe(emptyProfile("x").sizing.fill);
    expect(b.fonts.list[0]!.roles).toEqual(DEFAULT_FONTS[0]!.roles);
  });
});
