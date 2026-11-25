import { describe, expect, it } from "vitest";
import { MM_PER_INCH, PT_PER_INCH } from "@tagpress/domain";
import { STICKER_FALLBACK_AREA, stickerAreaMm, stickerMmPerPx, stickerPrintSize } from "./sticker-size.ts";

// Kullanıcının profilindeki sayfalar (pt): istiridye 130 × 96 (45,86 × 33,87 mm), normal Ø108 (38,1 mm).
const OYSTER = { shape: "rect" as const, maxW: 130, maxH: 96 };
const ROUND = { shape: "circle" as const, maxW: 108, maxH: 108 };
const pt = (v: number) => (v * MM_PER_INCH) / PT_PER_INCH;

describe("sticker baskı ölçüsü (mm)", () => {
  it("yazı alanı pt → mm; yuvarlakta çap", () => {
    expect(stickerAreaMm(OYSTER)).toEqual({ shape: "rect", wMm: pt(130), hMm: pt(96) });
    expect(stickerAreaMm(ROUND).wMm).toBeCloseTo(38.1, 6);
    expect(stickerAreaMm(ROUND).hMm).toBeCloseTo(38.1, 6);
    expect(stickerAreaMm(null)).toBe(STICKER_FALLBACK_AREA);
  });

  it("kullanıcının sticker'ı (5255, mürekkep 297,48 × 57,54 px) istiridye alanına sığar: 45,86 mm, 105 mm değil", () => {
    const ink = { x: 71.01, y: 190.99, w: 297.48, h: 57.54 };
    const s = stickerPrintSize(ink, OYSTER, 440);
    expect(s.wMm).toBeCloseTo(pt(130), 6); // genişlik sınırlar
    expect(s.hMm).toBeLessThanOrEqual(pt(96));
    expect(s.hMm).toBeCloseTo((57.54 * pt(130)) / 297.48, 6);
    // Eski hesap: 1 tasarım px = 1 pt → 104,9 mm.
    expect(297.48 * pt(1)).toBeCloseTo(104.94, 2);
  });

  it("uzun boylu yazıda yükseklik sınırlar (5260: 204,76 × 219,85 px → 31,5 × 33,9 mm)", () => {
    const s = stickerPrintSize({ x: 117.37, y: 110.24, w: 204.76, h: 219.85 }, OYSTER, 440);
    expect(s.hMm).toBeCloseTo(pt(96), 6);
    expect(s.wMm).toBeCloseTo((204.76 * pt(96)) / 219.85, 6);
    expect(s.wMm).toBeLessThan(pt(130));
  });

  it("yuvarlak alanda mürekkebin köşegeni çapa sığar", () => {
    const ink = { x: 0, y: 0, w: 300, h: 400 };
    const s = stickerPrintSize(ink, ROUND, 440);
    expect(Math.hypot(s.wMm, s.hMm)).toBeCloseTo(38.1, 6);
  });

  it("görsel kutusu (tasarım karesi) mürekkep merkezine göre, aynı ölçekte; çapa mürekkep merkezi", () => {
    const ink = { x: 100, y: 200, w: 200, h: 40 };
    const s = stickerPrintSize(ink, OYSTER, 440);
    const k = s.mmPerPx;
    expect(k).toBeCloseTo(stickerMmPerPx(ink, OYSTER, 440), 12);
    expect(s.anchorPx).toEqual({ x: 200, y: 220 });
    expect(s.art).toEqual({ xMm: -200 * k, yMm: -220 * k, wMm: 440 * k, hMm: 440 * k });
  });

  it("elle ölçek çarpan olarak uygulanır; mürekkep yoksa tasarım karesi sığdırılır", () => {
    const ink = { x: 0, y: 0, w: 130, h: 96 };
    expect(stickerPrintSize(ink, OYSTER, 440, 0.5).wMm).toBeCloseTo(pt(130) / 2, 6);
    const none = stickerPrintSize(null, OYSTER, 440);
    expect(none.wMm).toBeCloseTo(pt(96), 6); // kare, kısa kenar (yükseklik) sınırlar
    expect(none.anchorPx).toEqual({ x: 220, y: 220 });
  });
});

describe("daire sticker: satır satır sığdırma (eski eklentinin circleReach'i)", () => {
  const lines = [
    { x: 170, y: 160, w: 100, h: 30 },
    { x: 70, y: 195, w: 300, h: 30 },
    { x: 170, y: 230, w: 100, h: 30 },
  ];
  const all = { x: 70, y: 160, w: 300, h: 100 };
  it("ortası uzun çok satırlı yazı ortak kutunun köşegeniyle değil satır köşeleriyle sığar (daha büyük, alan aşılmaz)", () => {
    const byLines = stickerPrintSize(all, ROUND, 440, 1, { lineInks: lines });
    const byBox = stickerPrintSize(all, ROUND, 440);
    expect(byLines.mmPerPx / byBox.mmPerPx).toBeCloseTo(Math.hypot(150, 50) / Math.hypot(150, 15), 9); // ~%4,9 büyük
    // En uzak satır köşesi tam yarıçapta: merkez (220, 210), orta satırın köşesi (370, 225).
    expect(Math.hypot(150, 15) * byLines.mmPerPx).toBeCloseTo(38.1 / 2, 6);
    // Dikdörtgen alanda satırlar etkisiz (en/boy sınırı).
    expect(stickerPrintSize(all, OYSTER, 440, 1, { lineInks: lines }).mmPerPx).toBe(stickerPrintSize(all, OYSTER, 440).mmPerPx);
  });
  it("eski ölçü yalnız istenince (arşiv): 1 tasarım px = 1 pt", () => {
    expect(stickerPrintSize(all, OYSTER, 440, 1, { legacy: true }).wMm).toBeCloseTo(300 * pt(1), 9);
  });
});
