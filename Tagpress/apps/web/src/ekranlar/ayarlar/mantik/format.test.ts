import "../../../i18n/test.ts";
import { describe, expect, it } from "vitest";
import { barPercent, fillDays, formatUsd, keyStatusText, priceText } from "./format.ts";

describe("ayarlar yardımcıları", () => {
  it("haiku fiyat metni", () => {
    expect(priceText("claude-haiku-5-5")).toBe("≈ $0,10 / $0,50 · 1M token, 100K üstü istekte $0,50 / $2,50");
    expect(priceText("bilinmeyen")).toBeNull();
  });
  it("dolar biçimi", () => {
    expect(formatUsd(0)).toBe("$0,00");
    expect(formatUsd(0.0042)).toBe("$0,0042");
    expect(formatUsd(12.5)).toBe("$12,50");
  });
  it("31 günü eksiksiz doldurur", () => {
    const r = fillDays([{ day: "2026-10-09", usd: 1, calls: 2 }], "2026-10-09", 31);
    expect(r).toHaveLength(31);
    expect(r[30]?.usd).toBe(1);
    expect(r[0]?.day).toBe("2026-09-09");
    expect(r[1]?.usd).toBe(0);
  });
  it("çubuk yüzdesi", () => {
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(0.001, 10)).toBe(3);
    expect(barPercent(10, 10)).toBe(100);
  });
  it("anahtar durumu anahtarı göstermez", () => {
    expect(keyStatusText(false, null)).toBe("Anahtar yok");
    expect(keyStatusText(true, null)).toBe("Kayıtlı");
  });
});
