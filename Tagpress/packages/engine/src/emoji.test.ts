import { PDFArray, PDFDocument, PDFName, type PDFPage, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { type DesignIntent, type IntentLine, type LayoutResult, PrintCellLabelSchema, PrintCutSchema } from "@tagpress/domain";
import { type FontRegistry, shapeRun } from "@tagpress/typeset";
import { testFonts, userProfile } from "./fixtures.ts";
import { checkEdits, insideShape, layout, makeTestGeometry, printPagePng, printPageSvg, printPdf, renderPreview, renderTextOnly, resolveEdits, textLayerSvg } from "./index.ts";
import type { LabelArt } from "./print.ts";
import type { PrintPdfPage } from "./print-pdf.ts";

/**
 * Emoji, sembol ve süslü yazı uçtan uca: yerleşim → önizleme PNG → baskı PNG → vektör PDF. Fontlar depodaki fikstür
 * + uygulamayla gelen yedekler; sistem fontu yok (her makinede aynı sonuç).
 */

const GV = "Great Vibes/Regular";
const ZWJ = "\u200D";
/** Twemoji kalp rengi (#DD2E44). */
const HEART = [0xdd, 0x2e, 0x44] as const;

const L = (text: string, o: Partial<IntentLine> = {}): IntentLine => ({ text, tier: "primary", role: "name", fontId: GV, ...o });
const I = (...lines: IntentLine[]): DesignIntent => ({ lines, rationale: "" });

let fonts: FontRegistry;
beforeAll(async () => {
  fonts = await testFonts();
});

async function run(text: string, intent: DesignIntent = I(L(text)), profile = userProfile()): Promise<LayoutResult> {
  return layout({ text, intent, profile, geometry: makeTestGeometry(), fonts });
}

/** Görselde verilen renge yakın piksel sayısı. */
async function countColor(png: Buffer, rgb: readonly [number, number, number], tol = 40): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * 4;
    if (data[o + 3]! > 200 && Math.abs(data[o]! - rgb[0]) <= tol && Math.abs(data[o + 1]! - rgb[1]) <= tol && Math.abs(data[o + 2]! - rgb[2]) <= tol) n++;
  }
  return n;
}

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

function printPage(art: LabelArt): PrintPdfPage {
  return {
    name: "emoji",
    copies: 1,
    paper: { wMm: 60, hMm: 60 },
    slots: [{ id: "s0", shape: "circle", cx: 30, cy: 30, w: 38, h: 38, rotation: 0, cornerRadius: 0 }],
    cut: PrintCutSchema.parse({}),
    cellLabels: [],
    items: [{ xMm: 30, yMm: 30, diameterMm: 38, art }],
  };
}

describe("emoji ve sembol: yerleşim", () => {
  const SAMPLES: Array<[string, DesignIntent?]> = [
    ["Elif ❤️ Kerem"],
    ["Teşekkürler 🙏🏽✨"],
    ["🇹🇷 İyi ki doğdun 🎂", I(L("🇹🇷"), L("İyi ki doğdun 🎂", { role: "greeting", tier: "secondary" }))],
    [`Aile 👨${ZWJ}👩${ZWJ}👧`],
    ["★ El yapımı ★"],
    ["1️⃣"],
    ["🎉🎂🎈"],
    ["Ali ♥ ✿ ☾ ∞ ™ Can"],
  ];

  it("her örnek basılır: metin run'larda aynen, hiçbir glif boş kutu değil, emoji tek parça", async () => {
    for (const [text, intent] of SAMPLES) {
      const r = await run(text, intent);
      expect(r.ok, `${text}: ${r.issues.map((i) => i.message).join("; ")}`).toBe(true);
      expect(r.issues.map((i) => i.code), text).not.toContain("text-unprintable");
      for (const line of r.lines) {
        expect(line.runs.map((x) => x.text).join(""), text).toBe(line.text);
        for (const run of line.runs) expect(shapeRun(fonts, run.text, { fontId: run.fontId, sizePx: run.sizePx }).notdef, `${text} / ${run.text}`).toBe(0);
      }
    }
  });

  it("emojinin mürekkebi ölçülür: yerleşim kutusu emojiyi kapsar, hiçbir piksel kesim çizgisinin dışına taşmaz", async () => {
    const g = makeTestGeometry();
    const S = 2;
    for (const [text, intent] of SAMPLES) {
      const r = await run(text, intent);
      const png = await renderTextOnly(r, fonts, { scale: S, framePx: g.framePx });
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, outside = 0;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * 4 + 3]! < 128) continue;
          x0 = Math.min(x0, x / S);
          x1 = Math.max(x1, (x + 1) / S);
          y0 = Math.min(y0, y / S);
          y1 = Math.max(y1, (y + 1) / S);
          if (!insideShape(g.cut, (x + 0.5) / S, (y + 0.5) / S)) outside++;
        }
      expect(outside, text).toBe(0);
      // Motorun bildirdiği mürekkep kutusu çizilen mürekkebi kapsar (1,5 px pay).
      expect(x0, text).toBeGreaterThanOrEqual(r.ink.x - 1.5);
      expect(x1, text).toBeLessThanOrEqual(r.ink.x + r.ink.w + 1.5);
      expect(y0, text).toBeGreaterThanOrEqual(r.ink.y - 1.5);
      expect(y1, text).toBeLessThanOrEqual(r.ink.y + r.ink.h + 1.5);
    }
  });

  it("parçalı basılacak emoji (fontta tek parça yok) görünür uyarıyla bildirilir", async () => {
    const r = await run(`Ali 🐱${ZWJ}🚀`);
    expect(r.ok).toBe(true);
    const w = r.issues.find((i) => i.severity === "warning" && i.message.includes(`🐱${ZWJ}🚀`));
    expect(w?.code).toBe("text-fallback-font");
  });

  it("Düzelt: satıra yazılan emoji de küme düzeyinde çözülür, parçalı olan uyarılır", async () => {
    const base = await run("Ali Can");
    const profile = userProfile();
    const r = resolveEdits(base, [{ index: 0, text: `Ali 🐱${ZWJ}🚀 Can 🎂` }], profile, fonts);
    expect(r.unprintable).toEqual([]);
    expect(r.partialChars).toEqual([`🐱${ZWJ}🚀`]);
    const c = checkEdits({ base, edited: r.layout, edits: r.edits, jobText: "Ali Can", profile, unprintable: r.unprintable, partialChars: r.partialChars, monochromeChars: r.monochromeChars });
    expect(c.issues.some((i) => i.severity === "warning" && i.message.includes(`🐱${ZWJ}🚀`))).toBe(true);
  });

  it("hiçbir fontta olmayan karakter silinmez, hata olarak raporlanır", async () => {
    const r = await run("Anna 𓀀");
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === "text-unprintable")?.message).toContain("𓀀");
  });
});

describe("süslü yazı olduğu gibi basılır", () => {
  it("matematiksel, tam genişlikli, küçük büyük harf ve daire içi harfler yedek fontla basılır", async () => {
    for (const text of ["𝓔𝓵𝓲𝓯 & 𝐊𝐞𝐫𝐞𝐦", "Ａｙｓｅ", "ᴇʟɪꜰ", "Ⓐⓨş𝘦"]) {
      const r = await run(text);
      expect(r.ok, `${text}: ${r.issues.map((i) => i.message).join("; ")}`).toBe(true);
      for (const line of r.lines) for (const run of line.runs) expect(shapeRun(fonts, run.text, { fontId: run.fontId, sizePx: run.sizePx }).notdef, run.text).toBe(0);
    }
  });

  it("süslü büyük harfler tasarım fontunun büyük harf sınırına sayılmaz (onlar yedek fontla basılır)", async () => {
    const r = await run("𝐊𝐄𝐑𝐄𝐌");
    expect(r.issues.map((i) => i.code)).not.toContain("font-unavailable");
    expect(r.ok).toBe(true);
    // Düz büyük harfte sınır aynen geçerli.
    expect((await run("KEREM")).issues.map((i) => i.code)).toContain("font-unavailable");
  });
});

describe("emoji renkli çizilir: önizleme, baskı PNG'si, vektör PDF", () => {
  it("seçicisiz ❤ da kırmızı basılır; metin değişmez (FE0F eklenmez)", async () => {
    const r = await run("Elif ❤ Kerem");
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.runs.map((x) => x.text).join("")).join(" ")).toBe("Elif ❤ Kerem");
    expect(await countColor(await renderPreview(r, makeTestGeometry(), fonts, { profile: userProfile() }), HEART)).toBeGreaterThan(50);
  });

  it("❤️ üç çıktıda da kırmızı", async () => {
    const r = await run("Elif ❤️ Kerem");
    const g = makeTestGeometry();
    const profile = userProfile();
    expect(await countColor(await renderPreview(r, g, fonts, { profile }), HEART)).toBeGreaterThan(50);

    const art: LabelArt = { key: "e", designFramePx: g.framePx, text: { kind: "svg", svg: textLayerSvg(r, fonts, { profile }) }, clip: g.cut };
    expect(await countColor(await printPagePng(printPage(art), { dpi: 150 }), HEART)).toBeGreaterThan(50);

    const doc = await PDFDocument.load(await printPdf([printPage(art)], { dpi: 100, mode: "vector" }));
    const c = contentText(doc.getPage(0));
    const fills = [...c.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(fills.some(([R, G, B]) => Math.abs(R! * 255 - HEART[0]) < 3 && Math.abs(G! * 255 - HEART[1]) < 3 && Math.abs(B! * 255 - HEART[2]) < 3)).toBe(true);
  });
});

describe("sipariş adı (hücre etiketi): etiket metniyle aynı küme düzeyi font çözümü", () => {
  const withLabel = (text: string): PrintPdfPage => ({
    ...printPage({ key: "bos", designFramePx: 440, text: null, clip: null }),
    cellLabels: [{ text, xMm: 10, yMm: 50, style: PrintCellLabelSchema.parse({ sizePt: 14, color: "#000000" }) }],
  });

  it("emoji renkli, Arapça ve sembol boş kutu değil: SVG, PNG ve vektör PDF", async () => {
    const page = withLabel("Elif ❤️ ★ مريم 4849");
    const svg = await printPageSvg(page);
    const layer = svg.slice(svg.indexOf('data-layer="cell-labels"'));
    expect(layer).toMatch(/fill="rgba\(221,46,68/);
    expect(await countColor(await printPagePng(page, { dpi: 200 }), HEART)).toBeGreaterThan(20);
    const doc = await PDFDocument.load(await printPdf([page], { dpi: 100, mode: "vector" }));
    const fills = [...contentText(doc.getPage(0)).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(fills.some(([R, G, B]) => Math.abs(R! * 255 - HEART[0]) < 3 && Math.abs(G! * 255 - HEART[1]) < 3 && Math.abs(B! * 255 - HEART[2]) < 3)).toBe(true);
  });

  it("hücre etiketinde fontta olmayan karakter kalmaz (.notdef yok)", async () => {
    const { cellLabelMissing, defaultCellLabelFont } = await import("./print-vector.ts");
    expect(cellLabelMissing("Elif ❤️ ★ مريم 🇹🇷 4849_3adet", defaultCellLabelFont())).toEqual([]);
    expect(cellLabelMissing("Anna 𓀀", defaultCellLabelFont())).toEqual(["𓀀"]);
  });
});
