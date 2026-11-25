import { describe, expect, it } from "vitest";
import type { Box } from "@tagpress/domain";
import { type RgbImage, alignTemplate, gapsAbove, inkLines, plainInk, templateInk } from "./ink-lines.ts";

/**
 * Sentetik görüntülerle: satır bulma (bilinen kutular), düz zemin sınıflaması ve şablon hizalama. Şekiller çözümsel
 * çizilir; hizalama testinde örnek, şablonun ölçeklenip kaydırılmış hâli (aynı çizim işlevi dönüşümle) + yazı.
 * Motorla üretilmiş gerçekçi etiketler `apps/server/src/services/builder/samples.test.ts`'te.
 */

type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const INK: RGB = [40, 30, 30];

function image(w: number, h: number, draw: (x: number, y: number) => RGB): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(draw(x + 0.5, y + 0.5), (y * w + x) * 3);
  return { width: w, height: h, data };
}

/** Maske: kutuların birleşimi (piksel kenarı). */
function mask(w: number, h: number, boxes: Box[]): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const b of boxes) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) m[y * w + x] = 1;
  return m;
}

/**
 * "Harf" dizisi: satır kutusu içinde aralıklı dikey çubuklar (bileşenler ayrı, kutu birleşimi = satır kutusu).
 * `stroke`: çubuk kalınlığı (px; yoksa aralığın %60'ı).
 */
function word(b: Box, letters = 6, stroke?: number): Box[] {
  const step = b.w / letters;
  return Array.from({ length: letters }, (_, i) => ({ x: Math.round(b.x + i * step), y: b.y, w: stroke ?? Math.max(2, Math.round(step * 0.6)), h: b.h })).map((l, i, a) =>
    i === a.length - 1 ? (stroke ? { ...l, x: b.x + b.w - stroke } : { ...l, w: b.x + b.w - l.x }) : l,
  );
}

const boxesOf = (r: ReturnType<typeof inkLines>) => r.lines.map((l) => l.box);

describe("inkLines", () => {
  it("boş satırla ayrılan satırlar: kutular birebir, boşluklar kutulardan", () => {
    const lines = [
      { x: 100, y: 80, w: 400, h: 60 },
      { x: 250, y: 160, w: 60, h: 30 },
      { x: 120, y: 210, w: 380, h: 70 },
    ];
    const r = inkLines(mask(600, 400, lines.flatMap((b) => word(b))), 600, 400);
    expect(boxesOf(r)).toEqual(lines);
    expect(gapsAbove(r.lines)).toEqual([null, 20, 20]);
    expect(r.block).toEqual({ x: 100, y: 80, w: 400, h: 200 });
  });

  it("i noktası ve alt çizgi bandı satırına katılır; iki satırın ortasındaki küçük bağlaç satırı katılmaz", () => {
    const dots = [
      { x: 130, y: 60, w: 6, h: 6 },
      { x: 300, y: 60, w: 6, h: 6 },
    ];
    const under = { x: 90, y: 142, w: 40, h: 4 };
    const top = { x: 100, y: 70, w: 300, h: 70 };
    const conn = { x: 230, y: 165, w: 22, h: 22 };
    const bottom = { x: 110, y: 210, w: 300, h: 70 };
    const r = inkLines(mask(500, 320, [...word(top), ...dots, under, conn, ...word(bottom)]), 500, 320);
    expect(boxesOf(r)).toEqual([{ x: 90, y: 60, w: 310, h: 86 }, conn, bottom]);
  });

  it("üst üste binen satırlar (uzantı alttaki satırın satırlarına iniyor): bileşen kümeleri ayrı satır", () => {
    // Üst satırın bir "g" uzantısı alt satırın üst kısmına iniyor; boş satır yok.
    const top = { x: 100, y: 50, w: 300, h: 60 };
    const tail = { x: 200, y: 110, w: 8, h: 45 }; // üst satırın harfine bağlı uzantı
    const bottom = { x: 120, y: 140, w: 280, h: 60 };
    const m = mask(500, 260, [...word(top), tail, ...word(bottom)]);
    const r = inkLines(m, 500, 260);
    expect(boxesOf(r)).toEqual([{ x: 100, y: 50, w: 300, h: 105 }, bottom]);
    expect(r.splits).toBe(1);
  });

  it("satırın yanındaki üst işaret (°) ve harfe yapışık aksan satırına katılır", () => {
    const digits = { x: 100, y: 100, w: 120, h: 60 };
    const degree = { x: 226, y: 94, w: 18, h: 18 };
    const accent = { x: 300, y: 92, w: 12, h: 10 };
    const letters = { x: 290, y: 104, w: 120, h: 56 };
    const r = inkLines(mask(500, 260, [...word(digits, 2), degree, accent, ...word(letters, 4)]), 500, 260);
    expect(boxesOf(r)).toEqual([{ x: 100, y: 92, w: 310, h: 68 }]);
  });

  it("virgül satırın çekirdeğine katılır; tek başına küçük gürültü atılır", () => {
    const line = { x: 100, y: 100, w: 300, h: 50 };
    const comma = { x: 402, y: 140, w: 5, h: 18 };
    const speck = { x: 20, y: 300, w: 1, h: 1 };
    const r = inkLines(mask(500, 400, [...word(line), comma, speck]), 500, 400);
    expect(boxesOf(r)).toEqual([{ x: 100, y: 100, w: 307, h: 58 }]);
    expect(r.dropped).toBeGreaterThan(0);
  });

  it("boş maske: satır yok", () => {
    const r = inkLines(new Uint8Array(100 * 100), 100, 100);
    expect(r.lines).toEqual([]);
    expect(r.block).toBeNull();
  });
});

describe("plainInk", () => {
  const text = (x: number, y: number): RGB => {
    const inBox = (b: Box) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
    return [...word({ x: 100, y: 100, w: 300, h: 60 }, 12, 6), ...word({ x: 150, y: 190, w: 200, h: 40 }, 10, 5)].some(inBox) ? INK : WHITE;
  };

  it("düz beyaz zeminde tek renkli yazı: düz, maske yazı", () => {
    const p = plainInk(image(500, 300, text));
    expect(p.plain).toBe(true);
    expect(boxesOf(inkLines(p.mask, 500, 300))).toEqual([
      { x: 100, y: 100, w: 300, h: 60 },
      { x: 150, y: 190, w: 200, h: 40 },
    ]);
  });

  it("degrade ve gürültü (fotoğraf) düz değil", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const p = plainInk(image(400, 400, (x, y) => {
      const v = Math.round(120 + x / 5 + y / 7 + rnd() * 30);
      return [v, v - 10, v - 30];
    }));
    expect(p.plain).toBe(false);
    expect(["not-plain", "textured"]).toContain(p.reason);
    expect([...p.mask].every((v) => v === 0)).toBe(true);
  });

  it("renkli dekor, kalın dolu şekil ve çevreleyen halka yazı sayılmaz", () => {
    const green = plainInk(image(500, 300, (x, y) => (Math.hypot(x - 450, y - 250) < 30 ? [40, 140, 60] : text(x, y))));
    expect(green).toMatchObject({ plain: false, reason: "multi-color" });
    const blob = plainInk(image(500, 300, (x, y) => (Math.hypot(x - 450, y - 250) < 30 ? INK : text(x, y))));
    expect(blob).toMatchObject({ plain: false, reason: "thick" });
    const ring = plainInk(image(400, 400, (x, y) => (Math.abs(Math.hypot(x - 200, y - 200) - 180) < 2 ? INK : WHITE)));
    expect(ring).toMatchObject({ plain: false, reason: "decoration" });
  });

  it("mürekkepsiz görsel", () => {
    expect(plainInk(image(200, 200, () => WHITE))).toMatchObject({ plain: false, reason: "no-ink" });
  });
});

describe("alignTemplate + templateInk", () => {
  const GOLD: RGB = [190, 150, 60];
  const GREEN: RGB = [40, 110, 60];
  const CREAM: RGB = [252, 247, 235];
  /** Şablon çizimi, şablon koordinatında (600 px): halka, iki yaprak, çiçek. */
  const deco = (x: number, y: number): RGB => {
    const d = Math.hypot(x - 300, y - 300);
    if (d > 296) return WHITE;
    if (Math.abs(d - 270) < 4) return GOLD;
    if (Math.hypot(x - 300, y - 500) < 45) return [220, 120, 150];
    if (Math.hypot(x - 230, y - 490) < 28 || Math.hypot(x - 370, y - 490) < 28) return GREEN;
    return CREAM;
  };
  const template = image(600, 600, deco);
  /** Yazı şablon koordinatında. */
  const textBoxes = [
    { x: 190, y: 220, w: 220, h: 50 },
    { x: 220, y: 300, w: 160, h: 40 },
  ];
  const letters = textBoxes.flatMap((b) => word(b));
  const inText = (x: number, y: number) => letters.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  /** Örnek: ölçek s, kayma (dx, dy); şablonun dışı beyaz. */
  const sample = (s: number, dx: number, dy: number, w: number, h: number) =>
    image(w, h, (x, y) => {
      const px = (x - dx) / s;
      const py = (y - dy) / s;
      if (px < 0 || py < 0 || px >= 600 || py >= 600) return WHITE;
      return inText(px, py) ? INK : deco(px, py);
    });

  it("ölçeklenmiş ve kaydırılmış örnekte hizalama bulunur; mürekkep satırları dönüşümle ±2 px", () => {
    const s = 1.37;
    const dx = 23.4;
    const dy = -11.2;
    const S = sample(s, dx, dy, 860, 820);
    const a = alignTemplate(S, template, { guesses: [{ scale: 1.3, dx: 0, dy: 0 }] });
    expect(a.ok).toBe(true);
    expect(a.scale).toBeCloseTo(s, 2);
    expect(Math.abs(a.dx - dx)).toBeLessThan(1.5);
    expect(Math.abs(a.dy - dy)).toBeLessThan(1.5);
    const sep = templateInk(S, template, a);
    const got = boxesOf(inkLines(sep.mask, S.width, S.height));
    const want = textBoxes.map((b) => ({ x: b.x * s + dx, y: b.y * s + dy, w: b.w * s, h: b.h * s }));
    expect(got).toHaveLength(2);
    got.forEach((b, i) => {
      const t = want[i]!;
      expect(Math.max(Math.abs(b.x - t.x), Math.abs(b.y - t.y), Math.abs(b.x + b.w - t.x - t.w), Math.abs(b.y + b.h - t.y - t.h))).toBeLessThanOrEqual(2);
    });
  });

  it("küçültülmüş örnek (şablondan küçük) de hizalanır", () => {
    const S = sample(0.62, 8, 5, 390, 390);
    const a = alignTemplate(S, template);
    expect(a.ok).toBe(true);
    expect(a.scale).toBeCloseTo(0.62, 2);
    expect(inkLines(templateInk(S, template, a).mask, S.width, S.height).lines).toHaveLength(2);
  });

  it("başka şablonla hizalama tutmaz; dekorsuz şablon belirsizdir", () => {
    const other = image(600, 600, (x, y) => (x < 30 || y < 30 || x > 570 || y > 570 ? GOLD : Math.hypot(x - 100, y - 300) < 50 ? GREEN : WHITE));
    const S = sample(1, 0, 0, 600, 600);
    expect(alignTemplate(S, other)).toMatchObject({ ok: false, reason: "mismatch" });
    expect(alignTemplate(S, image(600, 600, () => CREAM))).toMatchObject({ ok: false, reason: "featureless" });
  });
});
