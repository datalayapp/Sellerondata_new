import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Box,
  type DesignIntent,
  type IntentLine,
  type LayoutResult,
  type Profile,
  ProfileSchema,
  type Reference,
  type Template,
  TemplateSchema,
  cutDiameter,
} from "@tagpress/domain";
import { layout, renderPreview, renderTextOnly } from "@tagpress/engine";
import { measureStyle } from "@tagpress/learn";
import { buildGeometry, clearGeometryCache, imageBoxOf } from "@tagpress/templates";
import { FontRegistry } from "@tagpress/typeset";
import { TEST_FALLBACK_FONTS_DIR, TEST_FONTS_DIR } from "@tagpress/typeset/testing";
import {
  PDF_SUPPORTED,
  SampleFiles,
  type SampleMeasurement,
  type SampleTemplateInput,
  type SampleTranscriber,
  acceptSampleFile,
  analyzeSample,
  applyUserLines,
  assignSplits,
  fontMetricsFrom,
  pairLines,
  sampleFields,
  sampleReference,
  sniffFormat,
} from "./samples.ts";

/**
 * Fikstürler motorla üretilir: sentetik şablon görseli (altın halka, yeşil çiçek, yapraklar; 840 px) gerçek şablon
 * geometrisinden geçer (`buildGeometry`), metin motorla yerleşir (`layout`) ve önizleme olarak çizilir
 * (`renderPreview`, ölçek 2 → 880 px). Doğru satır kutuları motorun `PlacedLine.ink`'idir (tasarım px × 2).
 * Fontlar depodaki açık lisanslı test fontları; kullanıcının verisine dokunulmaz.
 */

const GV = "Great Vibes/Regular";
const PF = "Playfair Display/Regular";
const SCALE = 2;
let dir = "";
let profile: Profile;
let fonts: FontRegistry;
let tpl: Template;
let tplPng: Buffer;
let otherPng: Buffer;

function makeProfile(): Profile {
  return ProfileSchema.parse({
    name: "örnek ölçüm testi",
    fonts: {
      mixing: "two",
      list: [
        { id: GV, family: "Great Vibes", style: "Regular", file: "GreatVibes-Regular.ttf", kind: "script", roles: ["primary", "secondary"], lockTracking: true },
        { id: PF, family: "Playfair Display", style: "Regular", file: "PlayfairDisplay[wght].ttf", kind: "serif", roles: ["primary", "secondary"] },
      ],
    },
    sizing: { fill: 0.95, tiers: { primary: 1, secondary: 0.72, tertiary: 0.6, connector: 0.5 }, breathing: 0.03, minPt: 4, maxPt: 40 },
    spacing: { inkGaps: { normal: 0.12, beforeLast: 0.25, connector: 0.1 }, beforeLastRatio: 0.85 },
    weight: { mode: "none" },
  });
}

type RGBA = [number, number, number, number];
async function drawPng(size: number, draw: (x: number, y: number) => RGBA): Promise<Buffer> {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) buf.set(draw(x + 0.5, y + 0.5), (y * size + x) * 4);
  return sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

const GOLD: RGBA = [190, 150, 60, 255];
const GREEN: RGBA = [40, 110, 60, 255];
const PINK: RGBA = [220, 120, 150, 255];
const CREAM: RGBA = [253, 248, 236, 255];
const CLEAR: RGBA = [0, 0, 0, 0];

/** Şablon: krem daire zemin, altın halka, altta çiçek ve yapraklar, üstte küçük yaprak çifti (840 px). */
function wreath(x: number, y: number): RGBA {
  const d = Math.hypot(x - 420, y - 420);
  if (d > 415) return CLEAR;
  if (Math.abs(d - 385) < 4) return GOLD;
  if (Math.hypot(x - 420, y - 705) < 62) return PINK;
  if (Math.hypot(x - 330, y - 690) < 40 || Math.hypot(x - 510, y - 690) < 40) return GREEN;
  if (Math.hypot(x - 380, y - 120) < 22 || Math.hypot(x - 460, y - 120) < 22) return GREEN;
  return CREAM;
}

/** Başka şablon: köşeli çerçeve ve yan yapraklar. */
function frame(x: number, y: number): RGBA {
  if (x < 30 || y < 30 || x > 810 || y > 810) return GOLD;
  if (Math.hypot(x - 120, y - 420) < 70 || Math.hypot(x - 720, y - 420) < 70) return GREEN;
  return [255, 255, 255, 255];
}

const L = (text: string, tier: IntentLine["tier"] = "primary", fontId = GV): IntentLine => ({ text, tier, role: tier === "connector" ? "connector" : tier === "primary" ? "name" : "other", fontId });
const I = (...lines: IntentLine[]): DesignIntent => ({ lines, rationale: "" });

interface Fixture {
  text: string;
  result: LayoutResult;
  label: Buffer;
  /** Doğru kutular (880 px'lik etikette). */
  truth: Box[];
}

async function fixture(text: string, intent: DesignIntent): Promise<Fixture> {
  const geometry = await buildGeometry(tpl, profile, { imagePath: path.join(dir, "t1.png") });
  const result = await layout({ text, intent, profile, geometry, fonts });
  expect(result.ok, JSON.stringify(result.issues)).toBe(true);
  const label = await renderPreview(result, geometry, fonts, { scale: SCALE, profile });
  return { text, result, label, truth: result.lines.map((l) => ({ x: l.ink.x * SCALE, y: l.ink.y * SCALE, w: l.ink.w * SCALE, h: l.ink.h * SCALE })) };
}

const fakeReader = (lines: string[]): SampleTranscriber => ({ transcribe: async () => ({ ok: true, lines }) });

function templateInput(png = tplPng, key = "t1"): SampleTemplateInput {
  return { key, png, imageBox: imageBoxOf(tpl, profile), match: "user" };
}

function expectBoxes(got: readonly (Box | null)[], truth: readonly Box[], tol = 2) {
  expect(got.length).toBe(truth.length);
  got.forEach((b, i) => {
    const t = truth[i]!;
    expect(b, `satır ${i}`).not.toBeNull();
    const err = Math.max(Math.abs(b!.x - t.x), Math.abs(b!.y - t.y), Math.abs(b!.x + b!.w - t.x - t.w), Math.abs(b!.y + b!.h - t.y - t.h));
    expect(err, `satır ${i}: ${JSON.stringify(b)} ~ ${JSON.stringify(t)}`).toBeLessThanOrEqual(tol);
  });
}

const analyze = (png: Buffer, o: Partial<Parameters<typeof analyzeSample>[0]> = {}) =>
  analyzeSample({ png, designFramePx: profile.output.designFramePx, cutDiameterPx: cutDiameter(profile), ...o });

/** Ölçülmüş örnekte sayısal değer kalmamış mı (kalite `none`). */
function expectNoNumbers(m: SampleMeasurement) {
  expect(m.ink).toEqual([]);
  expect(m.frame).toBeNull();
  expect(m.block).toBeNull();
  expect(m.fill).toBeNull();
  for (const l of m.lines) {
    expect(l.ink).toBeNull();
    expect(l.gapAbovePx).toBeNull();
  }
}

let wedding: Fixture;
let date: Fixture;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ornek-olcum-"));
  profile = makeProfile();
  fonts = await FontRegistry.create({ entries: profile.fonts.list, fontDir: TEST_FONTS_DIR, fallbackDirs: [TEST_FALLBACK_FONTS_DIR], systemFallbacks: false });
  tplPng = await drawPng(840, wreath);
  otherPng = await drawPng(840, frame);
  writeFileSync(path.join(dir, "t1.png"), tplPng);
  tpl = TemplateSchema.parse({ key: "t1", languageId: "l", file: "t1.png", width: 840, height: 840 });
  wedding = await fixture("Elena & Marco 12.10.2026", I(L("Elena"), L("&", "connector"), L("Marco"), L("12.10.2026", "tertiary", PF)));
  date = await fixture("Battesimo Diego", I(L("Battesimo", "secondary"), L("Diego")));
}, 60_000);

afterAll(() => {
  clearGeometryCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("örnekten ölçüm: şablon + mürekkep (exact)", () => {
  it("motorla üretilmiş etikette satır kutuları ±2 px; çerçeve tasarım alanına çevirir; okuma eşleşir", async () => {
    for (const f of [wedding, date]) {
      const texts = f.result.lines.map((l) => l.text);
      const m = await analyze(f.label, { template: templateInput(), transcriber: fakeReader(texts) });
      expect(m.quality).toBe("exact");
      expect(m.reason).toBeNull();
      expect(m.approx).toBe(false);
      expect(m.templateKey).toBe("t1");
      expect(m.templateMatch).toBe("user");
      expectBoxes(m.ink, f.truth);
      expect(m.lines.map((l) => l.text)).toEqual(texts);
      expect(m.lines.every((l) => l.textSource === "transcribe" && l.fontFile === null)).toBe(true);
      // Görünen boşluk: kutulardan.
      for (let i = 1; i < m.lines.length; i++) expect(m.lines[i]!.gapAbovePx).toBe(m.ink[i]!.y - (m.ink[i - 1]!.y + m.ink[i - 1]!.h));
      expect(m.lines[0]!.gapAbovePx).toBeNull();
      // Çerçeve: 880 px etiket → 440 tasarım px (½), kayma ~0.
      expect(m.frame!.kx).toBeCloseTo(0.5, 2);
      expect(Math.abs(m.frame!.dx)).toBeLessThan(1);
      const D = cutDiameter(profile);
      expect(m.fill!.widthOfCut).toBeCloseTo(f.result.ink.w / D, 1);
      expect(Math.abs(m.fill!.center.x - (f.result.ink.x + f.result.ink.w / 2))).toBeLessThan(1.5);
      expect(Math.abs(m.fill!.center.y - (f.result.ink.y + f.result.ink.h / 2))).toBeLessThan(1.5);
      expect(sampleFields(m)).toMatchObject({ status: "measured", quality: "exact", approx: false, w: 880, h: 880 });
    }
  }, 60_000);

  it("yeniden ölçeklenmiş, kaydırılmış ve JPEG'e çevrilmiş yükleme de hizalanır (±2 px)", async () => {
    const S = 1100 / 880;
    const scaled = await sharp(wedding.label).resize(1100, 1100).toBuffer();
    const shifted = await sharp(scaled).extend({ left: 37, top: 12, right: 5, bottom: 30, background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
    const acc = await acceptSampleFile(shifted);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    expect(acc.format).toBe("jpeg");
    const m = await analyze(acc.png, { template: templateInput(), transcriber: fakeReader(wedding.result.lines.map((l) => l.text)) });
    expect(m.quality).toBe("exact");
    expectBoxes(
      m.ink,
      wedding.truth.map((b) => ({ x: b.x * S + 37, y: b.y * S + 12, w: b.w * S, h: b.h * S })),
    );
    // Tasarım alanına çeviri yine motorun kutularını verir (±1 tasarım px).
    const back = m.ink.map((b) => ({ x: b.x * m.frame!.kx + m.frame!.dx, y: b.y * m.frame!.ky + m.frame!.dy, w: b.w * m.frame!.kx, h: b.h * m.frame!.ky }));
    expectBoxes(back, wedding.result.lines.map((l) => l.ink), 1);
  }, 60_000);

  it("okunan satır sayısı mürekkeple eşleşmezse approx; kutular ölçümden kalır, eşleme sırayla", async () => {
    const m = await analyze(date.label, { template: templateInput(), transcriber: fakeReader(["Battesimo Diego"]) });
    expect(m.quality).toBe("exact");
    expect(m.approx).toBe(true);
    expect(m.ink).toHaveLength(2);
    expect(m.lines.map((l) => l.text)).toEqual(["Battesimo Diego", null]);
    // Kullanıcı düzeltmesi sayıyı eşitlerse approx kalkar.
    const fixed = applyUserLines(m, [{ text: "Battesimo" }, { text: "Diego", fontFile: "GreatVibes-Regular.ttf" }]);
    expect(fixed.approx).toBe(false);
    expect(fixed.lines.map((l) => [l.text, l.textSource, l.fontFile])).toEqual([
      ["Battesimo", "user", null],
      ["Diego", "user", "GreatVibes-Regular.ttf"],
    ]);
    expect(fixed.ink).toEqual(m.ink);
  }, 60_000);

  it("adaylardan otomatik eşleşme: doğru şablon seçilir", async () => {
    const m = await analyze(date.label, {
      candidates: [
        { key: "baska", png: otherPng, imageBox: imageBoxOf(tpl, profile), match: "auto" },
        { ...templateInput(), match: "auto" },
      ],
    });
    expect(m.quality).toBe("exact");
    expect(m.templateKey).toBe("t1");
    expect(m.templateMatch).toBe("auto");
    expectBoxes(m.ink, date.truth);
  }, 60_000);

  it("yanlış şablon hizalanmaz; dekorlu görsel şablonsuz ölçülmez → none, hiçbir sayı yok", async () => {
    const m = await analyze(wedding.label, { template: { key: "baska", png: otherPng, imageBox: imageBoxOf(tpl, profile), match: "user" }, transcriber: fakeReader(["Elena", "&", "Marco", "12.10.2026"]) });
    expect(m.quality).toBe("none");
    expect(m.reason).toBe("template-mismatch");
    expect(m.templateKey).toBe("baska");
    expect(m.diagnostics.alignment).toMatchObject({ ok: false });
    expectNoNumbers(m);
    expect(m.approx).toBe(false);
    // Okunan metin yalnız niteliksel kullanım için durur.
    expect(m.lines.map((l) => l.text)).toEqual(["Elena", "&", "Marco", "12.10.2026"]);
    expect(sampleFields(m).status).toBe("qualitative");
  }, 60_000);
});

describe("düz zemin (ink) ve fotoğraf (none)", () => {
  it("şablonsuz düz zeminde eşikleme: kutular ±2 px, çerçeve ve doluluk yok", async () => {
    const png = await sharp(await renderTextOnly(wedding.result, fonts, { scale: SCALE, profile })).flatten({ background: "#fffdf8" }).jpeg({ quality: 90 }).toBuffer();
    const acc = await acceptSampleFile(png);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    const m = await analyze(acc.png, { transcriber: fakeReader(wedding.result.lines.map((l) => l.text)) });
    expect(m.quality).toBe("ink");
    expect(m.approx).toBe(false);
    expect(m.templateKey).toBeNull();
    expect(m.frame).toBeNull();
    expect(m.fill).toBeNull();
    expectBoxes(m.ink, wedding.truth);
  }, 60_000);

  it("fotoğraf benzeri görsel (degrade + gürültü) → none, hiçbir kutu yok", async () => {
    const W = 600;
    const buf = Buffer.alloc(W * W * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const v = 90 + (x + y) / 8 + rnd() * 40;
        buf.set([Math.min(255, v + 30), Math.min(255, v + 10), Math.min(255, v - 20)], (y * W + x) * 3);
      }
    }
    const photo = await sharp(buf, { raw: { width: W, height: W, channels: 3 } })
      .composite([{ input: await sharp(wedding.label).resize(360).png().toBuffer(), left: 120, top: 120 }])
      .jpeg({ quality: 80 })
      .toBuffer();
    const acc = await acceptSampleFile(photo);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    const m = await analyze(acc.png, { transcriber: fakeReader(["Elena", "&", "Marco"]) });
    expect(m.quality).toBe("none");
    expectNoNumbers(m);
    expect(m.lines.map((l) => l.text)).toEqual(["Elena", "&", "Marco"]);
  }, 60_000);

  it("şablonsuz dekorlu etiket → none: krem zeminli daire düz zemin değil, beyaz zeminde renkli dekor ayrılmaz", async () => {
    const m = await analyze(wedding.label);
    expect(m.quality).toBe("none");
    expect(m.reason).toBe("not-plain");
    expectNoNumbers(m);
    expect(m.lines).toEqual([]);
    const text = await renderTextOnly(wedding.result, fonts, { scale: SCALE, profile });
    const onFrame = await sharp(otherPng).resize(880, 880).composite([{ input: text }]).flatten({ background: "#ffffff" }).png().toBuffer();
    const m2 = await analyze(onFrame, { transcriber: fakeReader(["Elena", "&", "Marco", "12.10.2026"]) });
    expect(m2.quality).toBe("none");
    expect(m2.reason).toBe("decoration");
    expectNoNumbers(m2);
  }, 60_000);

  it("okuma başarısızsa metinler null, approx değil", async () => {
    const m = await analyze(date.label, { template: templateInput(), transcriber: { transcribe: async () => ({ ok: false, lines: [] }) } });
    expect(m.transcript).toBeNull();
    expect(m.approx).toBe(false);
    expect(m.lines.map((l) => l.text)).toEqual([null, null]);
  }, 60_000);
});

describe("yükleme: güvenilmez dosya", () => {
  /** Geçerli imzalı, başlığı dev boyut söyleyen PNG (dekompresyon bombası; açılmadan reddedilmeli). */
  function bombPng(w: number, h: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(1024))), chunk("IEND", Buffer.alloc(0))]);
  }

  it("biçim içerikten: uzantı yok sayılır; metin, HTML ve bilinmeyen bayt reddedilir", async () => {
    expect(sniffFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(await acceptSampleFile(Buffer.from("merhaba"))).toEqual({ ok: false, code: "sample-type" });
    expect(await acceptSampleFile(Buffer.from("<html><img src=x></html>"))).toEqual({ ok: false, code: "sample-type" });
    const webp = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).webp().toBuffer();
    expect((await acceptSampleFile(webp)).ok).toBe(false);
  });

  it("PDF: sharp bu kurulumda PDF okuyamıyor → açık ret (format pdf)", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    expect(sniffFormat(pdf)).toBe("pdf");
    if (!PDF_SUPPORTED) expect(await acceptSampleFile(pdf)).toEqual({ ok: false, code: "sample-type", params: { format: "pdf" } });
    else expect((await acceptSampleFile(pdf)).ok).toBe(false); // bozuk PDF
  });

  it("boyut ve piksel sınırı; dekompresyon bombası açılmadan reddedilir; bozuk dosya okunamaz", async () => {
    const png = await sharp({ create: { width: 200, height: 120, channels: 3, background: "#fff" } }).png().toBuffer();
    expect(await acceptSampleFile(png, { maxFileBytes: 10 })).toMatchObject({ ok: false, code: "sample-too-large" });
    expect(await acceptSampleFile(png, { maxInputPixels: 1000 })).toMatchObject({ ok: false, code: "sample-too-large" });
    const bomb = bombPng(60_000, 60_000);
    expect(bomb.length).toBeLessThan(2000);
    const t0 = Date.now();
    expect(await acceptSampleFile(bomb)).toMatchObject({ ok: false, code: "sample-too-large" });
    expect(Date.now() - t0).toBeLessThan(2000);
    const broken = Buffer.concat([png.subarray(0, 40), Buffer.alloc(200, 7)]);
    expect(await acceptSampleFile(broken)).toMatchObject({ ok: false, code: "sample-unreadable" });
    const tiny = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#fff" } }).png().toBuffer();
    expect(await acceptSampleFile(tiny)).toMatchObject({ ok: false, code: "sample-unreadable" });
  });

  it("yeniden kodlama: yön uygulanır, EXIF silinir, en uzun kenar 2000, saydamlık beyaza", async () => {
    const jpg = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#3366aa" } })
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "gizli", Artist: "müşteri" } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpg).metadata()).exif).toBeDefined();
    const acc = await acceptSampleFile(jpg);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    const meta = await sharp(acc.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    // 3000×1000, 90° döndürülmüş → 1000×3000 → en uzun kenar 2000.
    expect([acc.w, acc.h]).toEqual([667, 2000]);
    const alpha = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const a2 = await acceptSampleFile(alpha);
    expect(a2.ok).toBe(true);
    if (!a2.ok) return;
    const { data, info } = await sharp(a2.png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });
});

describe("ayrılmış küme", () => {
  const s = (id: string, at: string, quality: "exact" | "ink" | "none" | null = "exact", excluded = false) => ({ id, createdAt: at, quality, excluded });

  it("8'in altında ölçülebilir örnekte hepsi null", () => {
    const list = Array.from({ length: 7 }, (_, i) => s(`s${i}`, `2026-01-01T00:00:0${i}Z`));
    expect([...assignSplits(list).values()].every((v) => v === null)).toBe(true);
  });

  it("8 ve üzerinde %25 test (aşağı yuvarlanır), yükleme sırasıyla, eşitlikte kimlikle; ölçülemeyen ve dışarıda bırakılan null", () => {
    const list = [
      ...Array.from({ length: 9 }, (_, i) => s(`s${i}`, `2026-01-01T00:00:0${i}Z`)),
      s("none", "2026-01-01T00:00:00Z", "none"),
      s("bekliyor", "2026-01-01T00:00:00Z", null),
      s("dis", "2026-01-01T00:00:00Z", "ink", true),
    ];
    const r = assignSplits(list);
    expect([...r.entries()].filter(([, v]) => v === "test").map(([k]) => k)).toEqual(["s3", "s7"]);
    expect(r.get("none")).toBeNull();
    expect(r.get("bekliyor")).toBeNull();
    expect(r.get("dis")).toBeNull();
    expect(r.get("s0")).toBe("train");
    // Sıra girdi sırasından bağımsız; aynı anda yüklenenler kimliğe göre.
    const same = Array.from({ length: 8 }, (_, i) => s(`k${7 - i}`, "2026-01-01T00:00:00Z", i % 2 ? "ink" : "exact"));
    const r2 = assignSplits([...same].reverse());
    expect([...r2.entries()].filter(([, v]) => v === "test").map(([k]) => k).sort()).toEqual(["k3", "k7"]);
    expect(assignSplits(same)).toEqual(r2);
    // Sonradan eklenen örnek önceki atamaları değiştirmez.
    const more = assignSplits([...list, ...Array.from({ length: 4 }, (_, i) => s(`z${i}`, `2026-01-02T00:00:0${i}Z`))]);
    for (const [k, v] of r) expect(more.get(k)).toBe(v);
    expect([...more.values()].filter((v) => v === "test")).toHaveLength(3);
  });

  // B2: modele bir kez gösterilmiş örnek asla ayrılmış kümeye geçmez.
  const n2 = (i: number) => String(i).padStart(2, "0");
  const seen = (i: number, split: "train" | "test" | null = null, shown = true) => ({ id: `s${n2(i)}`, createdAt: `2026-11-22T00:00:${n2(i)}Z`, quality: "ink" as const, split, shown });
  const apply = (list: ReturnType<typeof seen>[]) => {
    const r = assignSplits(list);
    return list.map((x) => ({ ...x, split: r.get(x.id) ?? null }));
  };

  it("7 örnek modele gösterildi; 8. eklenince gösterilmiş hiçbir örnek test olmaz, test yalnız yeni örnekten", () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map((i) => seen(i));
    expect([...assignSplits(seven).values()].every((v) => v === null)).toBe(true);
    const eight = assignSplits([...seven, seen(8, null, false)]);
    for (const s of seven) expect(eight.get(s.id), s.id).not.toBe("test");
    expect(eight.get("s08")).toBe("test");
    // Hepsi gösterilmişse hedefe ulaşılmasa da test yok (az test, ama modelin görmediği).
    expect([...assignSplits([...seven, seen(8)]).values()].filter((v) => v === "test")).toEqual([]);
  });

  it("12 örnekte ilk örnek silinince train olan örnek test olmaz; test olanlar yerinde kalır (fazlası train'e geçer)", () => {
    // İlk atama: hiçbiri gösterilmemiş → düzenli aralık (s04, s08, s12). Sonra tur başlar: train olanlar gösterilir.
    const all = apply([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => seen(i, null, false)));
    expect(all.filter((x) => x.split === "test").map((x) => x.id)).toEqual(["s04", "s08", "s12"]);
    const shown = all.map((x) => ({ ...x, shown: x.split !== "test" }));
    const after = apply(shown.slice(1));
    expect(after.filter((x) => x.split === "test").map((x) => x.id)).toEqual(["s04", "s08"]);
    const moved = after.filter((x) => shown.find((y) => y.id === x.id)!.split === "train" && x.split === "test");
    expect(moved).toEqual([]);
    // Yeni (gösterilmemiş) örnekler gelince eksik test yalnız onlardan tamamlanır.
    const more = apply([...after.map((x) => ({ ...x, shown: x.split !== "test" })), seen(13, null, false), seen(14, null, false), seen(15, null, false), seen(16, null, false), seen(17, null, false)]);
    const tests = more.filter((x) => x.split === "test").map((x) => x.id);
    expect(tests).toHaveLength(4);
    expect(tests.filter((id) => !["s04", "s08"].includes(id)).every((id) => Number(id.slice(1)) >= 13)).toBe(true);
  });
});

describe("ölçüm özetine katılım", () => {
  let exact: SampleMeasurement;
  beforeAll(async () => {
    exact = await analyze(date.label, { template: templateInput(), transcriber: fakeReader(["Battesimo", "Diego"]) });
  }, 60_000);

  const ref = (m: SampleMeasurement, o: { fonts?: boolean; fontFile?: string | null; id?: string } = {}): Reference | null =>
    sampleReference({
      id: o.id ?? "u1",
      languageId: "l",
      createdAt: "2026-11-21T00:00:00Z",
      split: null,
      measurement: m,
      fontFile: o.fontFile === undefined ? "GreatVibes-Regular.ttf" : o.fontFile,
      designFramePx: profile.output.designFramePx,
      fonts: o.fonts === false ? null : fontMetricsFrom(fonts, profile.fonts.list),
    });

  it("font onaylıysa punto mürekkepten ve fonttan ölçülür (motorun puntosuna yakın); oranlar, boşluk ve doluluk özete girer", () => {
    const r = ref(exact)!;
    expect(r).toMatchObject({ source: "uploaded", quality: "exact", approx: false, sizesKnown: true, templateKey: "t1", labelFramePx: 440, text: "Battesimo Diego" });
    date.result.lines.forEach((l, i) => {
      expect(r.user[i]!.family).toBe("Great Vibes");
      expect(Math.abs(r.user[i]!.sizePx / l.sizePx - 1)).toBeLessThan(0.05);
      expectBoxes([r.user[i]!.ink], [l.ink], 1);
    });
    const m = measureStyle([r], profile, [tpl]);
    expect(m.refs.uploaded).toEqual({ total: 1, exact: 1, ink: 0, none: 0, approx: 0, sizesUnknown: 0 });
    expect(m.ratios.secondary?.n ?? m.ratios.tertiary?.n).toBe(1);
    expect(m.gaps.normal?.n).toBe(1);
    expect(m.fill.blockWidthOfCut?.n).toBe(1);
    expect(m.fill.largestPx?.n).toBe(1);
    expect(m.templates.map((t) => [t.key, t.n])).toEqual([["t1", 1]]);
  });

  it("font onaylı değilse punto 0 ve ölçülmez: oran ve boşluk boş, doluluk ve merkez yine ölçülür; font adı üretilmez", () => {
    const r = ref(exact, { fonts: false })!;
    expect(r.sizesKnown).toBe(false);
    expect(r.user.every((l) => l.sizePx === 0 && l.family === "")).toBe(true);
    const m = measureStyle([r], profile, [tpl]);
    expect(m.ratios.secondary).toBeNull();
    expect(m.ratios.tertiary).toBeNull();
    expect(m.gaps.normal).toBeNull();
    expect(m.fill.largestPx).toBeNull();
    expect(m.fill.blockWidthOfCut?.n).toBe(1);
    expect(m.templates).toHaveLength(1);
    expect(m.fonts.byLabel).toEqual([]);
    expect(m.examples[0]).toMatchObject({ lines: ["Battesimo", "Diego"], fonts: [] });
    expect(m.refs.uploaded.sizesUnknown).toBe(1);
  });

  it("none ve approx: yalnız satır bölme örneği; hiçbir sayısal ölçüye girmez", () => {
    const none: SampleMeasurement = { ...exact, quality: "none", frame: null, block: null, fill: null, ink: [], ...pairLines("none", [], [{ text: "Battesimo", fontFile: null, source: "transcribe" }, { text: "Diego", fontFile: null, source: "transcribe" }]) };
    const approx = applyUserLines(exact, [{ text: "Battesimo Diego" }]);
    expect(approx.approx).toBe(true);
    for (const m0 of [none, approx]) {
      const r = ref(m0)!;
      expect(r.user.every((l) => l.sizePx === 0 && l.ink.w === 0 && l.ink.h === 0)).toBe(true);
      const m = measureStyle([r], profile, [tpl]);
      expect(m.ratios.secondary).toBeNull();
      expect(m.gaps.normal).toBeNull();
      expect(m.fill.blockWidthOfCut).toBeNull();
      expect(m.fill.largestPx).toBeNull();
      expect(m.templates).toEqual([]);
      expect(m.lineCount).toEqual([]);
      expect(m.examples).toHaveLength(1);
    }
    // Metni olmayan none örneği katılmaz.
    expect(ref({ ...none, lines: [] })).toBeNull();
  });

  it("ink: oranlar (font onaylıysa) var; boşluk, doluluk ve şablon merkezi yok", async () => {
    const png = await sharp(await renderTextOnly(date.result, fonts, { scale: SCALE, profile })).flatten({ background: "#ffffff" }).png().toBuffer();
    const m0 = await analyze(png, { transcriber: fakeReader(["Battesimo", "Diego"]) });
    expect(m0.quality).toBe("ink");
    const r = ref(m0)!;
    expect(r.quality).toBe("ink");
    date.result.lines.forEach((l, i) => expect(Math.abs(r.user[i]!.sizePx / r.user[1]!.sizePx - l.sizePx / date.result.lines[1]!.sizePx)).toBeLessThan(0.03));
    const m = measureStyle([r], profile, [tpl]);
    expect((m.ratios.secondary ?? m.ratios.tertiary)?.n).toBe(1);
    expect(m.gaps.normal).toBeNull();
    expect(m.fill.blockWidthOfCut).toBeNull();
    expect(m.templates).toEqual([]);
  }, 60_000);
});

describe("dosya katmanı", () => {
  it("yalnız kimlikten kurulan ad; kaçış reddedilir", async () => {
    const files = new SampleFiles(path.join(dir, "ornekler"));
    const png = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#fff" } }).png().toBuffer();
    const file = await files.write("s-01", png);
    expect(path.basename(file)).toBe("s-01.png");
    expect((await files.read("s-01"))?.equals(png)).toBe(true);
    await files.remove("s-01");
    expect(await files.read("s-01")).toBeNull();
    for (const bad of ["../x", "a/b", "..", ".gizli", "C:\\x", "x.png", ""]) expect(() => files.path(bad)).toThrow();
  });
});
