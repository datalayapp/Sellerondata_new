import { describe, expect, it } from "vitest";
import { PROFILE_DOCS } from "./profile-docs.ts";
import { ProfileSchema, emptyProfile, upgradeProfileInput } from "./profile.ts";

describe("eski adlı profil alanları", () => {
  it("figma.frameName → printing.orderNamePattern; ölü alanlar ve figma bölümü atılır; girdi değişmez", () => {
    const old = { name: "Eski", printing: { dpi: 600 }, figma: { frameName: "{orderNo}-{seq}", maxShrink: 0.03, maxShiftPx: 4 } };
    const copy = structuredClone(old);
    const up = upgradeProfileInput(old);
    expect(up).toEqual({ name: "Eski", printing: { dpi: 600, orderNamePattern: "{orderNo}-{seq}" } });
    expect(old).toEqual(copy);
    const p = ProfileSchema.parse(up);
    expect(p.printing).toMatchObject({ dpi: 600, orderNamePattern: "{orderNo}-{seq}" });
    expect(p).not.toHaveProperty("figma");
  });

  it("yeni alan varsa da eski adla gelen yazılır (yama kazanır); desen yoksa varsayılan geçer; ilgisiz girdi aynen döner", () => {
    expect(upgradeProfileInput({ name: "a", printing: { orderNamePattern: "yeni", dpi: 300 }, figma: { frameName: "eski" } })).toEqual({ name: "a", printing: { orderNamePattern: "eski", dpi: 300 } });
    expect(upgradeProfileInput({ name: "a", figma: { maxShrink: 0.1 } })).toEqual({ name: "a" });
    expect(upgradeProfileInput({ name: "a", figma: { frameName: 3 } })).toEqual({ name: "a" });
    expect(upgradeProfileInput({ name: "a", printing: 5, figma: { frameName: "x" } })).toEqual({ name: "a", printing: 5 });
    const plain = { name: "a" };
    expect(upgradeProfileInput(plain)).toBe(plain);
    for (const v of [null, "metin", 5, [{ figma: {} }]]) expect(upgradeProfileInput(v)).toBe(v);
    expect(ProfileSchema.parse(upgradeProfileInput({ name: "a", figma: {} })).printing.orderNamePattern).toBe("{orderNo}_{quantity}adet");
  });

  it("printing.stickerDpi 150'nin altındaysa (eski 72 = 1 px 1 pt) silinir; varsayılan 300; diğer değerler korunur", () => {
    const old = { name: "a", printing: { dpi: 300, stickerDpi: 72 } };
    const up = upgradeProfileInput(old);
    expect(up).toEqual({ name: "a", printing: { dpi: 300 } });
    expect(old.printing.stickerDpi).toBe(72); // girdi değişmez
    expect(ProfileSchema.parse(up).printing.stickerDpi).toBe(300);
    const keep = { name: "a", printing: { stickerDpi: 600 } };
    expect(upgradeProfileInput(keep)).toBe(keep);
    // İkisi birlikte: Figma adı da çevrilir.
    expect(upgradeProfileInput({ name: "a", printing: { stickerDpi: 72 }, figma: { frameName: "x" } })).toEqual({ name: "a", printing: { orderNamePattern: "x" } });
    expect(emptyProfile("x").printing).toMatchObject({ dpi: 300, stickerDpi: 300 });
    // Şema 72'yi artık kabul etmez (upgrade'siz).
    expect(ProfileSchema.safeParse({ name: "a", printing: { stickerDpi: 72 } }).success).toBe(false);
  });

  it("şemada ve alan açıklamalarında Figma adı kalmadı", () => {
    expect(emptyProfile("x")).not.toHaveProperty("figma");
    expect(Object.keys(PROFILE_DOCS).filter((k) => k.startsWith("figma."))).toEqual([]);
    expect(PROFILE_DOCS["printing.orderNamePattern"]).toMatchObject({ label: "Sipariş adı deseni", group: "baski" });
  });
});
