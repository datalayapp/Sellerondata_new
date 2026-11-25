import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Profile, type ProfileInput, ProfileSchema, type Shape, type Template, TemplateSchema, cutDiameter } from "@tagpress/domain";
import { buildGeometry, clearGeometryCache, renderOverlay, suggestArea, templateKeyFromInput } from "./index.ts";
import { shapeTester } from "./raster.ts";

/**
 * Sentetik şablonlar 840×840 (profilin 420'lik şablon kutusunun 2 katı). Görsel pikseli (ix, iy) tasarım
 * alanında (10 + ix/2, 10 + iy/2) noktasına düşer; görsel merkezi = tasarım (220, 220).
 */
type RGBA = [number, number, number, number];
let dir = "";

async function png(name: string, draw: (x: number, y: number) => RGBA, size = 840): Promise<string> {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = draw(x + 0.5, y + 0.5);
      buf.set(c, (y * size + x) * 4);
    }
  }
  const file = path.join(dir, name);
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toFile(file);
  return file;
}

const C = 420; // görsel merkezi (görsel px)
const dist = (x: number, y: number, cx = C, cy = C) => Math.hypot(x - cx, y - cy);
const GOLD: RGBA = [190, 150, 60, 255];
const GREEN: RGBA = [40, 110, 60, 255];
const CLEAR: RGBA = [0, 0, 0, 0];
const WHITE: RGBA = [255, 255, 255, 255];

/** İnce halka (yarıçap 380 görsel px ≈ 190 tasarım px, kalınlık 6) + altta yeşil çiçek lekesi. */
function wreath(bg: RGBA) {
  return (x: number, y: number): RGBA => {
    const d = dist(x, y);
    if (Math.abs(d - 380) < 3) return GOLD;
    if (dist(x, y, C, 700) < 90) return GREEN;
    return bg;
  };
}

function profile(over: ProfileInput | Record<string, unknown> = {}): Profile {
  return ProfileSchema.parse({ name: "test", ...over });
}

function template(over: Record<string, unknown> = {}): Template {
  return TemplateSchema.parse({ key: "t", languageId: "l", file: "t.png", width: 840, height: 840, ...over });
}

const at = (bm: { data: Uint8Array; width: number; scale: number }, x: number, y: number) =>
  bm.data[Math.floor(y * bm.scale) * bm.width + Math.floor(x * bm.scale)]!;

let files: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "studio-templates-"));
  files = {
    clear: await png("saydam.png", wreath(CLEAR)),
    white: await png("beyaz.png", wreath(WHITE)),
    dark: await png("koyu.png", (x, y) => (dist(x, y, C, 700) < 90 ? GOLD : [20, 30, 70, 255])),
    // Geniş açık pembe leke (yazı taşır) + aynı renkte ince halka (taşımaz).
    stain: await png("leke.png", (x, y) => {
      const d = dist(x, y);
      if (d < 240) return [245, 185, 205, 255];
      if (Math.abs(d - 380) < 3) return [245, 185, 205, 255];
      return CLEAR;
    }),
    plain: await png("duz.png", () => WHITE),
  };
});

afterAll(() => {
  clearGeometryCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("dekor maskesi", () => {
  for (const kind of ["clear", "white"] as const) {
    it(`${kind === "clear" ? "saydam" : "beyaz"} zemin: zemin dekor değil, halka ve leke dekor`, async () => {
      const g = await buildGeometry(template({ key: kind }), profile(), { imagePath: files[kind]! });
      expect(g.decorationMethod).toBe("color");
      // Halka: görsel (420, 40) → tasarım (220, 30).
      expect(at(g.decoration, 220, 30)).toBe(1);
      // Çiçek: görsel (420, 700) → tasarım (220, 360).
      expect(at(g.decoration, 220, 360)).toBe(1);
      // Merkez boş ve yazılabilir.
      expect(at(g.decoration, 220, 220)).toBe(0);
      expect(at(g.free, 220, 220)).toBe(1);
      expect(g.background.dark).toBe(false);
      expect(g.background.luminance).toBeGreaterThan(0.95);
    });
  }

  it("koyu zemin: zemin dekor değil, koyu olarak işaretlenir", async () => {
    const g = await buildGeometry(template({ key: "koyu" }), profile(), { imagePath: files.dark! });
    expect(at(g.decoration, 220, 360)).toBe(1);
    expect(at(g.decoration, 220, 200)).toBe(0);
    expect(at(g.free, 220, 200)).toBe(1);
    expect(g.background.dark).toBe(true);
    expect(g.background.luminance).toBeLessThan(0.3);
  });

  it("kalın doku zemin yazılabilir, aynı renkteki ince halka dekor", async () => {
    const g = await buildGeometry(template({ key: "leke" }), profile(), { imagePath: files.stain! });
    expect(at(g.decoration, 220, 220)).toBe(0); // leke ortası
    expect(at(g.decoration, 220, 30)).toBe(1); // ince halka
    expect(at(g.free, 220, 220)).toBe(1);
  });

  it("alpha kaynağında dolu pikseller dekor", async () => {
    const g = await buildGeometry(template({ key: "alfa", decoration: { source: "alpha" }, area: { mode: "manual", shape: { kind: "rect", x: 0.2, y: 0.2, w: 0.6, h: 0.6, radius: 0 } }, ignoreDecorationInArea: true }), profile(), { imagePath: files.white! });
    expect(g.decorationMethod).toBe("alpha");
    // Beyaz kare dolu → dekor (alan dışında kalan kısmı çarpışma maskesinde durur).
    expect(at(g.decoration, 70, 220)).toBe(1);
  });
});

describe("kesim şekli", () => {
  const cuts: Shape[] = [
    { kind: "circle", cx: 220, cy: 220, r: 200 },
    { kind: "ellipse", cx: 220, cy: 220, rx: 205, ry: 150 },
    { kind: "rect", x: 40, y: 60, w: 360, h: 320, radius: 40 },
    { kind: "polygon", points: [{ x: 220, y: 20 }, { x: 410, y: 150 }, { x: 340, y: 410 }, { x: 100, y: 410 }, { x: 30, y: 150 }] },
  ];
  for (const cut of cuts) {
    it(`${cut.kind}: serbest alan kesimin içinde, kesim payı kadar uzak`, async () => {
      const p = profile({ output: { cut } });
      const g = await buildGeometry(template({ key: `kesim-${cut.kind}` }), p, { imagePath: files.plain! });
      const inside = shapeTester(cut, 1);
      const margin = p.sizing.edgeMargin * cutDiameter(p);
      let n = 0;
      for (let y = 0; y < g.free.height; y++) {
        for (let x = 0; x < g.free.width; x++) {
          if (!g.free.data[y * g.free.width + x]) continue;
          n++;
          const px = (x + 0.5) / g.free.scale, py = (y + 0.5) / g.free.scale;
          expect(inside(px, py)).toBe(true);
          // Kesim payı: dört yöndeki komşu nokta da kesim içinde.
          expect(inside(px + margin * 0.9, py) && inside(px - margin * 0.9, py) && inside(px, py + margin * 0.9) && inside(px, py - margin * 0.9)).toBe(true);
        }
      }
      expect(n).toBeGreaterThan(1000);
      expect(g.cut).toEqual(cut);
    });
  }
});

describe("kesim payı ve nefes payı ayrı", () => {
  it("kesim payı büyük, dekor payı küçük olabilir", async () => {
    const p = profile({ sizing: { edgeMargin: 0.1, breathing: 0.005 } });
    const shape: Shape = { kind: "rect", x: 0, y: 0, w: 1, h: 1, radius: 0 };
    const g = await buildGeometry(template({ key: "paylar", area: { mode: "manual", shape } }), p, { imagePath: files.clear! });
    const c = p.output.cut as { cx: number; cy: number; r: number };
    const D = cutDiameter(p);
    let minEdge = Infinity;
    for (let y = 0; y < g.free.height; y++) {
      for (let x = 0; x < g.free.width; x++) {
        if (!g.free.data[y * g.free.width + x]) continue;
        minEdge = Math.min(minEdge, c.r - Math.hypot((x + 0.5) / 2 - c.cx, (y + 0.5) / 2 - c.cy));
      }
    }
    expect(minEdge).toBeGreaterThanOrEqual(0.1 * D - 1);
    // Çiçeğin (tasarım merkezi 220,360; yarıçap 45) hemen üstü: dilatePx (3) + 0,005·D (~2,2) payından sonrası serbest.
    expect(at(g.free, 220, 360 - 45 - 7)).toBe(1);
    expect(at(g.free, 220, 360 - 45 - 2)).toBe(0);
  });
});

describe("alan, kurdele, hedef merkez", () => {
  it("kurdele bandı: üstten kesim çapının oranı kadar yazı yok", async () => {
    const p = profile();
    const g = await buildGeometry(template({ key: "kurdele", ribbonTop: 0.3 }), p, { imagePath: files.clear! });
    const D = cutDiameter(p);
    const top = 219.82 - 218.82;
    expect(g.ribbonY).toBeCloseTo(top + 0.3 * D, 5);
    const limitRow = Math.round(g.ribbonY! * g.free.scale);
    for (let y = 0; y < limitRow; y++) expect(g.rows[y]).toEqual([]);
    expect(g.areaBounds.y).toBeGreaterThanOrEqual(g.ribbonY! - 0.5);
  });

  it("elle alan: serbest alan şeklin içinde; rows maskeyle aynı", async () => {
    const shape: Shape = { kind: "ellipse", cx: 0.5, cy: 0.45, rx: 0.25, ry: 0.15 };
    const g = await buildGeometry(template({ key: "elle", area: { mode: "manual", shape } }), profile(), { imagePath: files.clear! });
    expect(g.manualArea).toBe(true);
    const inside = shapeTester(shape, 440);
    for (let y = 0; y < g.free.height; y++) {
      const spans = g.rows[y]!;
      for (let x = 0; x < g.free.width; x++) {
        const on = g.free.data[y * g.free.width + x] === 1;
        const px = (x + 0.5) / g.free.scale;
        const inSpan = spans.some(([a, b]) => px >= a && px < b);
        expect(inSpan).toBe(on);
        if (on) expect(inside(px, (y + 0.5) / g.free.scale)).toBe(true);
      }
    }
    expect(g.areaBounds.x).toBeGreaterThanOrEqual(0.25 * 440 - 1);
    expect(g.areaBounds.x + g.areaBounds.w).toBeLessThanOrEqual(0.75 * 440 + 1);
  });

  it("alandaki dekoru yok say: elle alan dekorun üstüne taşar, çarpışma maskesinden çıkar", async () => {
    // Çiçeğin (tasarım 220, 360) üstünü de kapsayan dikdörtgen.
    const shape: Shape = { kind: "rect", x: 0.3, y: 0.6, w: 0.4, h: 0.3, radius: 0 };
    const normal = await buildGeometry(template({ key: "yok-say-0", area: { mode: "manual", shape } }), profile(), { imagePath: files.clear! });
    const free = await buildGeometry(template({ key: "yok-say-1", area: { mode: "manual", shape }, ignoreDecorationInArea: true }), profile(), {
      imagePath: files.clear!,
    });
    expect(at(normal.free, 220, 360)).toBe(0);
    expect(at(free.free, 220, 360)).toBe(1);
    expect(at(free.decoration, 220, 360)).toBe(0);
    expect(at(free.decoration, 220, 30)).toBe(1); // alan dışındaki dekor yerinde
  });

  it("hedef merkez serbest alan dışındaysa en yakın serbest noktaya kırpılır", async () => {
    const shape: Shape = { kind: "rect", x: 0.3, y: 0.3, w: 0.4, h: 0.3, radius: 0 };
    const g = await buildGeometry(template({ key: "hedef", area: { mode: "manual", shape }, textCenter: { x: 0.5, y: 0.9 } }), profile(), {
      imagePath: files.clear!,
    });
    expect(at(g.free, g.target.x, g.target.y)).toBe(1);
    expect(g.target.x).toBeCloseTo(220, 0);
    expect(g.target.y).toBeGreaterThan(g.areaBounds.y + g.areaBounds.h - 2);
  });

  it("hedef merkez içerdeyse aynen kalır; yoksa alanın ağırlık merkezi", async () => {
    const shape: Shape = { kind: "rect", x: 0.3, y: 0.3, w: 0.4, h: 0.3, radius: 0 };
    const a = await buildGeometry(template({ key: "h1", area: { mode: "manual", shape }, textCenter: { x: 0.45, y: 0.4 } }), profile(), { imagePath: files.clear! });
    expect(a.target).toEqual({ x: 0.45 * 440, y: 0.4 * 440 });
    const b = await buildGeometry(template({ key: "h2", area: { mode: "manual", shape } }), profile(), { imagePath: files.clear! });
    expect(b.target.x).toBeCloseTo(0.5 * 440, 0);
    expect(b.target.y).toBeCloseTo(0.45 * 440, 0);
  });

  it("otomatik alan önerisi: merkezde, kesim ve dekordan uzak, oran biriminde", async () => {
    const t = template({ key: "oneri" });
    const s = await suggestArea(t, profile(), files.clear!);
    expect(["ellipse", "rect"]).toContain(s.kind);
    const b = s.kind === "ellipse" ? { x: s.cx - s.rx, y: s.cy - s.ry, w: 2 * s.rx, h: 2 * s.ry } : s.kind === "rect" ? s : null;
    expect(b).not.toBeNull();
    expect(b!.x).toBeGreaterThan(0.05);
    expect(b!.x + b!.w).toBeLessThan(0.95);
    expect(b!.w).toBeGreaterThan(0.4); // halka içi geniş
    expect(b!.y + b!.h).toBeLessThan(0.76); // çiçeğin üstünde kalır (çiçek üstü ≈ 0,77)
    const g = await buildGeometry(t, profile(), { imagePath: files.clear! });
    expect(g.manualArea).toBe(false);
    expect(at(g.free, 220, 200)).toBe(1);
  });

  it("şablona özel görsel kutusu (taşan görsel) kullanılır", async () => {
    // Aynı görsel 20 px sağa kaydırılırsa çiçek de kayar.
    const g = await buildGeometry(template({ key: "kutu", imageBox: { x: 30, y: 10, w: 420, h: 420 } }), profile(), { imagePath: files.clear! });
    expect(g.templateBox).toEqual({ x: 30, y: 10, w: 420, h: 420 });
    expect(at(g.decoration, 240, 360)).toBe(1);
  });

  it("önbellek: aynı girdiyle aynı nesne döner", async () => {
    const t = template({ key: "onbellek", area: { mode: "manual", shape: { kind: "rect", x: 0.3, y: 0.3, w: 0.4, h: 0.3, radius: 0 } } });
    const a = await buildGeometry(t, profile(), { imagePath: files.white! });
    const b = await buildGeometry(t, profile(), { imagePath: files.white! });
    expect(b).toBe(a);
    const c = await buildGeometry({ ...t, ribbonTop: 0.1 }, profile(), { imagePath: files.white! });
    expect(c).not.toBe(a);
  });
});

describe("önizleme katmanı", () => {
  it("PNG üretir; hedef merkez çizilir", async () => {
    const g = await buildGeometry(template({ key: "overlay", ribbonTop: 0.2 }), profile(), { imagePath: files.clear! });
    const buf = await renderOverlay(g);
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(880);
    const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (Math.round(y * 2) * 880 + Math.round(x * 2)) * 3;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    const [r, , b] = px(g.target.x, g.target.y);
    expect(b).toBeGreaterThan(r!); // mavi artı
    const [rr, gg, bb] = px(220, 20); // kurdele bandı (sarı)
    expect(rr).toBeGreaterThan(bb! + 40);
    expect(gg).toBeGreaterThan(bb!);
  });
});

describe("şablon anahtarı", () => {
  const known = ["1", "2", "12", "15", "a1", "a15", "a2", "a24"];
  const sizes = [{ id: "2.5" }, { id: "3.8" }, { id: "5.2" }];
  it.each([
    ["A1", "a1", null],
    ["01", "1", null],
    ["a15 5.2", "a15", "5.2"],
    ["2,5 cm 12", "12", "2.5"],
    ["12 (2.5)", "12", "2.5"],
    ["A-15", "a15", null],
    [" a024 ", "a24", null],
    ["#2", "2", null],
  ])("%s → %s / %s", (raw, key, size) => {
    const r = templateKeyFromInput(raw, known, sizes);
    expect(r.key).toBe(key);
    expect(r.size).toBe(size);
    expect(r.suggestions).toEqual([]);
  });
  it("yalnızca boyut: şablon yok", () => {
    expect(templateKeyFromInput("5.2", known, sizes)).toEqual({ key: null, size: "5.2", suggestions: [] });
  });
  it("bilinmeyen anahtar: en yakın öneriler", () => {
    const r = templateKeyFromInput("a16", known, sizes);
    expect(r.key).toBeNull();
    expect(r.suggestions[0]).toBe("a15");
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(templateKeyFromInput("13", known, sizes).suggestions.slice(0, 2).sort()).toEqual(["12", "15"].sort());
  });
  it("boyut kimlikleri profilden gelir (koda gömülü değil)", () => {
    expect(templateKeyFromInput("a15 5.2", known, []).key).toBeNull();
    expect(templateKeyFromInput("a15 7", known, [{ id: "7" }])).toEqual({ key: "a15", size: "7", suggestions: [] });
  });
});
