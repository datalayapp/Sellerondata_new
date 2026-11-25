import zlib from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, type PDFPage, PDFArray } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { type PrintSlot, PrintCellLabelSchema, PrintCutSchema, ProfileSchema } from "@tagpress/domain";
import {
  cellLabelAnchor,
  itemMatrix,
  labelDiameterMm,
  pagePixelSize,
  printCutSvg,
  printPagePng,
  printPageSvg,
  printPageThumbnail,
  type LabelArt,
} from "./print.ts";
import { parseTextLayerSvg, printPdf, type PrintPdfPage } from "./print-pdf.ts";
import { parsePathD, registrationMarks } from "./print-vector.ts";

/** textLayerSvg biçiminde (grup konturu, paint-order) küçük bir yazı katmanı: ortada siyah dikdörtgen. */
const TEXT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="440" viewBox="0 0 440 440">` +
  `<g data-line="0" data-stroke-px="1" stroke="#000000" stroke-width="2" stroke-linejoin="round" paint-order="stroke">` +
  `<path d="M180 200L260 200L260 240L180 240Z" fill="#000000"/><path d="M200 150Q220 130 240 150L240 160L200 160Z" fill="rgba(255,0,0,1)" stroke="none"/></g></svg>`;

let RED: Buffer;
let TEXT_PNG: Buffer;

function art(o: Partial<LabelArt> = {}): LabelArt {
  return {
    key: "a",
    designFramePx: 440,
    template: { source: RED, box: { x: 0, y: 0, w: 440, h: 440 } },
    text: { kind: "svg", svg: TEXT_SVG },
    clip: { kind: "circle", cx: 220, cy: 220, r: 220 },
    ...o,
  };
}

const slot = (id: string, cx: number, cy: number, o: Partial<PrintSlot> = {}): PrintSlot => ({ id, shape: "circle", cx, cy, w: 38, h: 38, rotation: 0, cornerRadius: 0, ...o });

/** Kesim ayarı kısmi girdi (zod varsayılanları doldurur). */
function page(cut: Record<string, unknown> = {}, o: Partial<PrintPdfPage> = {}): PrintPdfPage {
  const slots = [slot("s0", 30, 30), slot("s1", 75, 30), slot("s2", 30, 75)];
  return {
    name: "4849_1sayfa",
    copies: 2,
    paper: { wMm: 210, hMm: 297 },
    slots,
    cut: PrintCutSchema.parse(cut),
    cellLabels: [],
    items: slots.map((s) => ({ xMm: s.cx, yMm: s.cy, diameterMm: 38, art: art() })),
    ...o,
  };
}

async function pixel(png: Buffer, xMm: number, yMm: number, dpi: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const x = Math.floor((xMm * dpi) / 25.4);
  const y = Math.floor((yMm * dpi) / 25.4);
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

/** Sayfanın içerik akışını (açılmış) metin olarak verir. */
function contentText(p: PDFPage): string {
  const c = p.node.get(PDFName.of("Contents"));
  const refs = c instanceof PDFArray ? c.asArray() : [c];
  let out = "";
  for (const r of refs) {
    const s = p.doc.context.lookup(r);
    if (s instanceof PDFRawStream) out += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return out;
}

beforeAll(async () => {
  RED = await sharp({ create: { width: 200, height: 200, channels: 4, background: "#ff0000" } }).png().toBuffer();
  // Görüntü modu yazı katmanı: saydam, ortada mavi kare.
  TEXT_PNG = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 4, background: "#0000ff" } }).png().toBuffer(), left: 80, top: 80 }])
    .png()
    .toBuffer();
});

describe("baskı: yardımcılar", () => {
  it("etiket çapı profilin boyut tablosundan (3,8 → 38 mm, 2,5 → 25 mm)", () => {
    const p = ProfileSchema.parse({ name: "t" });
    expect(labelDiameterMm(p, "3.8")).toBeCloseTo(38, 6);
    expect(labelDiameterMm(p, "2.5")).toBeCloseTo(25, 6);
    expect(labelDiameterMm(p, "5.2")).toBeCloseTo(52, 6);
  });

  it("hücre etiketi yuvanın sağ alt köşesine göre", () => {
    const style = PrintCellLabelSchema.parse({});
    expect(cellLabelAnchor(slot("x", 30, 30), style)).toEqual({ xMm: 49 - 11.3, yMm: 49 - 1.6 });
  });

  it("öğe dönüşümü: çapa yuva merkezine, ölçek çap/alan, dönüş saat yönünde", () => {
    const m = itemMatrix({ xMm: 30, yMm: 40, diameterMm: 44, art: art() });
    // (220, 220) → (30, 40); (440, 220) → (30 + 22, 40)
    expect(m[0] * 220 + m[2] * 220 + m[4]).toBeCloseTo(30, 9);
    expect(m[1] * 440 + m[3] * 220 + m[5]).toBeCloseTo(40, 9);
    expect(m[0] * 440 + m[2] * 220 + m[4]).toBeCloseTo(52, 9);
    const r = itemMatrix({ xMm: 0, yMm: 0, diameterMm: 44, rotation: 90, art: art() });
    // Sağdaki nokta 90° saat yönünde dönünce aşağıya (y+) gider.
    expect(r[0] * 440 + r[2] * 220 + r[4]).toBeCloseTo(0, 9);
    expect(r[1] * 440 + r[3] * 220 + r[5]).toBeCloseTo(22, 9);
  });

  it("kayıt işaretleri: tarz başına şekil sayısı ve konum", () => {
    const paper = { wMm: 210, hMm: 297 };
    const reg = (style: "corners-l" | "corner-square" | "crosshair") => PrintCutSchema.parse({ registration: { enabled: true, style } }).registration;
    const l = registrationMarks(paper, reg("corners-l"));
    expect(l).toHaveLength(4);
    expect(l.every((s) => s.fill === "#000000")).toBe(true);
    expect(l[0]!.cmds[0]).toMatchObject({ t: "M", x: 10, y: 10 });
    expect(l[3]!.cmds[0]).toMatchObject({ t: "M", x: 200, y: 287 });
    const sq = registrationMarks(paper, reg("corner-square"));
    expect(sq).toHaveLength(4);
    expect(sq[0]!.cmds.filter((c) => c.t === "L")).toHaveLength(3); // kare
    expect(sq[1]!.cmds.filter((c) => c.t === "L")).toHaveLength(5); // L
    const cr = registrationMarks(paper, reg("crosshair"));
    expect(cr).toHaveLength(8); // 4 artı + 4 daire
    expect(cr.every((s) => s.stroke === "#000000" && s.strokeWidth === 0.5)).toBe(true);
    expect(registrationMarks(paper, PrintCutSchema.parse({}).registration)).toHaveLength(0);
  });
});

describe("baskı: sayfa SVG", () => {
  it("mm viewBox, yuva sayısı/konumu, öğeler ve tek tanım", async () => {
    const svg = await printPageSvg(page());
    expect(svg).toContain('width="210mm" height="297mm" viewBox="0 0 210 297"');
    const slots = [...svg.matchAll(/<path d="([^"]+)"[^>]*data-slot="(s\d)"/g)];
    expect(slots.map((m) => m[2])).toEqual(["s0", "s1", "s2"]);
    // Daire yolu sağ uçtan başlar: (cx + r, cy).
    const first = parsePathD(slots[0]![1]!)!;
    expect(first[0]).toMatchObject({ t: "M", x: 49, y: 30 });
    const second = parsePathD(slots[1]![1]!)!;
    expect(second[0]).toMatchObject({ t: "M", x: 94, y: 30 });
    expect(svg.match(/data-item="/g)).toHaveLength(3);
    // Aynı çizim bir kez tanımlanır, görsel bir kez gömülür.
    expect(svg.match(/<g id="art\d+"/g)).toHaveLength(1);
    expect(svg.match(/<image id="img\d+"/g)).toHaveLength(1);
    // Öğe dönüşümü: ölçek 38/440, öteleme 30 - 19.
    expect(svg).toContain(`transform="matrix(${Math.round((38 / 440) * 1000) / 1000} 0 0 ${Math.round((38 / 440) * 1000) / 1000} 11 11)"`);
    // Katman sırası: öğeler < kesim çizgileri.
    expect(svg.indexOf('data-layer="items"')).toBeLessThan(svg.indexOf('data-layer="cut"'));
  });

  it("görünmez çizgi: kesim katmanı yok; kılavuz yalnızca istenirse", async () => {
    const svg = await printPageSvg(page({ outlineVisible: false }));
    expect(svg).not.toContain('data-layer="cut"');
    expect(svg).not.toContain('data-layer="guides"');
    const g = await printPageSvg(page({ outlineVisible: false }), { guides: true });
    expect(g).toContain('data-layer="guides"');
  });

  it("taşma payı: kırpma şekli bleed kadar büyür, kesim çizgisi yuvada kalır", async () => {
    const svg = await printPageSvg(page({ bleedMm: 1 }));
    const clip = svg.match(/<clipPath id="[^"]+"><path d="([^"]+)"/)![1]!;
    const bleedPx = 1 / (38 / 440);
    expect((parsePathD(clip)![0] as { x: number }).x).toBeCloseTo(220 + 220 + bleedPx, 2);
    const slotD = svg.match(/<path d="([^"]+)"[^>]*data-slot="s0"/)![1]!;
    expect(parsePathD(slotD)![0]).toMatchObject({ x: 49, y: 30 });
    // Şablon kırpma merkezine göre (R + b) / R büyütülür.
    expect(svg).toMatch(/<use href="#img0" transform="matrix\(2\.31/);
  });

  it("kayıt işaretleri ve hücre etiketi (glif yolu, renk, konum)", async () => {
    const style = PrintCellLabelSchema.parse({});
    const at = cellLabelAnchor(slot("s0", 30, 30), style);
    const svg = await printPageSvg(page({ registration: { enabled: true, style: "corners-l" } }, { cellLabels: [{ text: "4849_36adet", ...at, style }] }));
    expect(svg.match(/<g data-layer="registration">/g)).toHaveLength(1);
    const m = svg.match(/<path d="([^"]+)" fill="#1A4DB3" data-cell-label="4849_36adet"/);
    expect(m).toBeTruthy();
    const cmds = parsePathD(m![1]!)!;
    const xs = cmds.flatMap((c) => (c.t === "Z" ? [] : [c.x]));
    const ys = cmds.flatMap((c) => (c.t === "Z" ? [] : [c.y]));
    const sizeMm = (8.4 * 25.4) / 72;
    expect(Math.min(...xs)).toBeGreaterThan(at.xMm - 0.2);
    expect(Math.min(...xs)).toBeLessThan(at.xMm + 0.5);
    // Rakam yüksekliği ≈ 0,73 em; yazı kutunun üstünden aşağıda başlar.
    expect(Math.min(...ys)).toBeGreaterThan(at.yMm);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.6 * sizeMm);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1.1 * sizeMm);
  });
});

describe("baskı: PNG", () => {
  it("boyut = mm·dpi/25,4, dpi meta verisi, katmanlar", async () => {
    const png = await printPagePng(page(), { dpi: 150 });
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(Math.round((210 * 150) / 25.4));
    expect(meta.height).toBe(Math.round((297 * 150) / 25.4));
    expect(meta.density).toBe(150);
    expect(pagePixelSize({ wMm: 210, hMm: 297 }, 300)).toMatchObject({ widthPx: 2480, heightPx: 3508 });
    // Etiket içi kırmızı, yazı siyah, yuva çizgisi koyu, sayfa beyaz.
    expect(await pixel(png, 30 - 10, 30, 150)).toEqual([255, 0, 0]);
    const ink = await pixel(png, 30, 30 + (2 / 440) * 38, 150);
    expect(Math.max(...ink)).toBeLessThan(60);
    expect(Math.max(...(await pixel(png, 49, 30, 150)))).toBeLessThan(140);
    expect(await pixel(png, 150, 200, 150)).toEqual([255, 255, 255]);
  });

  it("taşma payı: kesim çizgisinin 0,5 mm dışı bleed'de boyalı, bleed'siz beyaz; kırpma dışı beyaz", async () => {
    const dpi = 200;
    const none = await printPagePng(page({ outlineVisible: false }), { dpi });
    const bleed = await printPagePng(page({ outlineVisible: false, bleedMm: 1 }), { dpi });
    expect(await pixel(none, 49.5, 30, dpi)).toEqual([255, 255, 255]);
    expect(await pixel(bleed, 49.5, 30, dpi)).toEqual([255, 0, 0]);
    expect(await pixel(bleed, 48.5, 30, dpi)).toEqual([255, 0, 0]);
    // Kare şablonun köşesi kesim dışında: kırpılır.
    expect(await pixel(none, 11.5, 11.5, dpi)).toEqual([255, 255, 255]);
    expect(await pixel(bleed, 50.5, 30, dpi)).toEqual([255, 255, 255]);
  });

  it("görüntü modu: yazı katmanı PNG'si şablon kutusuna; sticker kırpılmaz ve çapa mürekkep merkezi", async () => {
    const imgArt = art({ text: { kind: "png", source: TEXT_PNG, box: { x: 0, y: 0, w: 440, h: 440 } } });
    const sticker = art({ key: "st", template: null, clip: null, anchor: { x: 220, y: 100 } });
    const input = page({ outlineVisible: false }, { items: [{ xMm: 30, yMm: 30, diameterMm: 38, art: imgArt }, { xMm: 120, yMm: 120, diameterMm: 38, art: sticker }] });
    const png = await printPagePng(input, { dpi: 200 });
    expect(await pixel(png, 30, 30, 200)).toEqual([0, 0, 255]);
    expect(await pixel(png, 30 - 12, 30, 200)).toEqual([255, 0, 0]);
    // Sticker: (220,100) → (120,120); siyah dikdörtgen (220, 220) → y = 120 + 120·38/440.
    const ink = await pixel(png, 120, 120 + (120 * 38) / 440, 200);
    expect(Math.max(...ink)).toBeLessThan(60);
  });

  it("küçük resim istenen genişlikte", async () => {
    const png = await printPageThumbnail(page(), { widthPx: 240 });
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(240);
    expect(meta.height).toBe(Math.round((297 * 240) / 210));
  });

  it("aşırı büyük sayfa reddedilir", async () => {
    await expect(printPagePng(page({}, { paper: { wMm: 1000, hMm: 1000 } }), { dpi: 1200 })).rejects.toThrow(/çok büyük/);
  });
});

describe("baskı: kesim dosyası", () => {
  it("yalnızca yuva yolları ve kayıt işaretleri, mm ölçekli", () => {
    const svg = printCutSvg(page({ outlineVisible: false, registration: { enabled: true, style: "crosshair" } }));
    expect(svg).toContain('width="210mm" height="297mm" viewBox="0 0 210 297"');
    expect(svg.match(/id="yuva-s\d"/g)).toHaveLength(3);
    expect(svg).toContain('<g id="kayit-isaretleri">');
    expect(svg).not.toContain("<image");
    expect(svg.match(/fill="none" stroke="#000000" stroke-width="0.25"/g)).toHaveLength(3);
  });
});

describe("baskı: PDF", () => {
  it("raster kip: A4 pt, sayfa sayısı, raster sayfa + vektör kesim çizgileri, sayfa etiketi", async () => {
    const pages = [page(), page({ registration: { enabled: true, style: "corner-square" } }, { name: "4850_1sayfa", copies: 1 })];
    const bytes = await printPdf(pages, { dpi: 100, title: "Deneme" });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    for (const p of doc.getPages()) {
      expect(p.getWidth()).toBeCloseTo(595.28, 1);
      expect(p.getHeight()).toBeCloseTo(841.89, 1);
    }
    expect(doc.getTitle()).toBe("Deneme");
    expect(doc.getSubject()).toContain("4849_1sayfa · 2 kopya");
    const c0 = contentText(doc.getPage(0));
    // 3 yuva = 3 kontur (S), Bézier daireler (c), tek sayfa görseli (Do).
    expect(c0.match(/^S$/gm)).toHaveLength(3);
    expect(c0.match(/ c$/gm)!.length).toBeGreaterThanOrEqual(12);
    expect(c0.match(/ Do$/gm)).toHaveLength(1);
    const c1 = contentText(doc.getPage(1));
    expect(c1.match(/^f$/gm)!.length).toBeGreaterThanOrEqual(4); // kayıt işaretleri dolgu
    // Görsel: sayfa pikseli dpi'de.
    const xo = doc.getPage(0).node.Resources()!.lookup(PDFName.of("XObject")) as unknown as { values(): unknown[] };
    const img = doc.context.lookup(xo.values()[0] as never) as PDFRawStream;
    expect(img.dict.get(PDFName.of("Width"))!.toString()).toBe(String(Math.round((210 * 100) / 25.4)));
    const labels = doc.catalog.lookup(PDFName.of("PageLabels"));
    expect(labels).toBeTruthy();
  });

  it("görünmez çizgi: PDF'te kesim çizgisi yok", async () => {
    const doc = await PDFDocument.load(await printPdf([page({ outlineVisible: false })], { dpi: 72 }));
    expect(contentText(doc.getPage(0)).match(/^S$/gm)).toBeNull();
  });

  it("vektör kip: yazı yolları vektör (dolgu + kontur), şablon raster, kırpma", async () => {
    const doc = await PDFDocument.load(await printPdf([page({ bleedMm: 0.5 })], { dpi: 100, mode: "vector" }));
    const c = contentText(doc.getPage(0));
    expect(c.match(/^W$/gm)).toHaveLength(3); // her etiket kırpılır
    expect(c.match(/ Do$/gm)).toHaveLength(3); // her kopyada şablon
    expect(c.match(/^f$/gm)!.length).toBeGreaterThanOrEqual(6); // yazı dolguları
    expect(c.match(/^S$/gm)!.length).toBeGreaterThanOrEqual(3 + 3); // yazı konturu + yuva çizgileri
    // Gömülü şablon görseli bir kez (her kopya aynı görsele başvurur).
    const xo = doc.getPage(0).node.Resources()!.lookup(PDFName.of("XObject")) as unknown as { values(): unknown[] };
    expect(xo.values()).toHaveLength(1);
  });

  it("yazı katmanı çözücüsü: motor biçimini okur, bilinmeyeni reddeder", () => {
    const p = parseTextLayerSvg(TEXT_SVG)!;
    expect(p.viewBox).toEqual([0, 0, 440, 440]);
    expect(p.paths).toHaveLength(2);
    expect(p.paths[0]!.shape).toMatchObject({ fill: "#000000", stroke: "#000000", strokeWidth: 2 });
    expect(p.paths[0]!.strokeFirst).toBe(true);
    expect(p.paths[1]!.shape.stroke).toBeNull();
    expect(parseTextLayerSvg(`<svg viewBox="0 0 10 10"><image href="x.png"/></svg>`)).toBeNull();
    expect(parseTextLayerSvg(`<svg viewBox="0 0 10 10"><path d="m0 0l1 1"/></svg>`)).toBeNull();
  });
});

// zlib'in PNG'ye CRC yazabildiğini doğrula (Node ≥ 22.2).
it("zlib.crc32 var", () => expect(typeof zlib.crc32).toBe("function"));
