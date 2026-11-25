import { ProfileSchema } from "@tagpress/domain";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createGemini } from "../gemini.ts";
import { decodeRgba, encodeRgba, type RawImage, shapeMask } from "../images.ts";
import { createFakeClaude, createFakeGemini, fakeGeminiFetch, reply } from "../testing.ts";
import { cutGuidePng, generateTemplate } from "./template.ts";
import { composeOnTemplate, extractTextLayer, templateUntouched } from "./text-layer.ts";
import { templateCutShape, writeOnTemplate } from "./write.ts";

/**
 * Sentetik şablon: 256×256, kesim dairesi dışı saydam, krem zemin, koyu yeşil çelenk halkası, yapraklar ve
 * kırmızı bir çiçek. Mürekkep, dekora yakın koyulukta kahverengi (zor durum).
 */
const S = 256;
const CUT = { kind: "circle" as const, cx: 128, cy: 128, r: 124 };
const CREAM: [number, number, number] = [245, 238, 225];
const GREEN: [number, number, number] = [40, 80, 50];
const RED: [number, number, number] = [200, 40, 60];
const INK: [number, number, number] = [60, 30, 20];
const TEXT_BOX = { x0: 70, y0: 108, x1: 186, y1: 148 };

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function drawTemplate(opts: { ringDx?: number; erasedFlower?: boolean } = {}): RawImage {
  const data = new Uint8Array(S * S * 4);
  const dx = opts.ringDx ?? 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const d = Math.hypot(x + 0.5 - CUT.cx, y + 0.5 - CUT.cy);
      if (d > CUT.r) continue; // saydam
      let c = CREAM;
      const dr = Math.hypot(x + 0.5 - CUT.cx - dx, y + 0.5 - CUT.cy);
      if (dr >= 100 && dr <= 112) c = GREEN;
      // Yapraklar: halkanın dışında küçük kareler.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const lx = CUT.cx + dx + Math.cos(a) * 117;
        const ly = CUT.cy + Math.sin(a) * 117;
        if (Math.abs(x - lx) < 5 && Math.abs(y - ly) < 5) c = GREEN;
      }
      if (!opts.erasedFlower && x >= 118 && x < 138 && y >= 30 && y < 44) c = RED;
      data.set([...c, 255], i);
    }
  }
  return { width: S, height: S, channels: 4, data };
}

/** "Harfler": dikey/yatay çubuklar, kenarları %50 örtmeli; hafif sıkıştırma gürültüsü. */
function paintText(template: RawImage, seed = 7): RawImage {
  const out = new Uint8Array(S * S * 3);
  const rand = rng(seed);
  for (let i = 0; i < S * S; i++) {
    const a = template.data[4 * i + 3]! / 255;
    for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(template.data[4 * i + c]! * a + 255 * (1 - a));
  }
  const cover = new Float32Array(S * S);
  const bar = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0 - 1; y <= y0 + h; y++) {
      for (let x = x0 - 1; x <= x0 + w; x++) {
        const edge = x < x0 || x >= x0 + w || y < y0 || y >= y0 + h;
        const i = y * S + x;
        cover[i] = Math.max(cover[i]!, edge ? 0.5 : 1);
      }
    }
  };
  for (let k = 0; k < 13; k++) bar(TEXT_BOX.x0 + 1 + k * 9, TEXT_BOX.y0 + 1, 4, 24);
  bar(TEXT_BOX.x0 + 1, TEXT_BOX.y0 + 30, 114, 4);
  for (let i = 0; i < S * S; i++) {
    const a = cover[i]!;
    for (let c = 0; c < 3; c++) {
      const v = out[3 * i + c]! * (1 - a) + INK[c]! * a + (rand() - 0.5) * 6;
      out[3 * i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { width: S, height: S, channels: 3, data: out };
}

function sameAtZeroAlpha(original: RawImage, composite: RawImage, layer: RawImage): { checked: number; differing: number } {
  let checked = 0;
  let differing = 0;
  for (let i = 0; i < S * S; i++) {
    if (layer.data[4 * i + 3]) continue;
    checked++;
    for (let c = 0; c < 4; c++) if (original.data[4 * i + c] !== composite.data[4 * i + c]) {
      differing++;
      break;
    }
  }
  return { checked, differing };
}

const region = shapeMask(CUT, S, S);

describe("yazı katmanı ayırma", () => {
  it("sentetik şablon + sentetik yazı: katman ayrılır, kutu doğru, güven ölçüleri temiz", () => {
    const tpl = drawTemplate();
    const layer = extractTextLayer(tpl, paintText(tpl), { region });
    expect(layer.box).not.toBeNull();
    const b = layer.box!;
    expect(Math.abs(b.x - TEXT_BOX.x0)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.y - TEXT_BOX.y0)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.x + b.w - TEXT_BOX.x1)).toBeLessThanOrEqual(4);
    expect(Math.abs(b.y + b.h - TEXT_BOX.y1)).toBeLessThanOrEqual(4);
    expect(layer.coverage).toBeGreaterThan(0.01);
    expect(layer.drift).toBeLessThan(0.001);
    expect(layer.edited).toBeLessThan(0.001);
    for (let c = 0; c < 3; c++) expect(Math.abs(layer.ink[c]! - INK[c]!)).toBeLessThanOrEqual(8);
    // Çubuğun ortası tam örtülü, dekor halkası yazı değil.
    expect(layer.alpha[(TEXT_BOX.y0 + 10) * S + TEXT_BOX.x0 + 3]).toBeGreaterThan(220);
    expect(layer.alpha[128 * S + 128 + 105]).toBe(0);
  });

  it("bileşikte yazı alfası 0 olan her piksel orijinal şablonla birebir aynı", () => {
    const tpl = drawTemplate();
    const layer = extractTextLayer(tpl, paintText(tpl), { region });
    const { layer: img, composite } = composeOnTemplate(tpl, layer);
    const r = sameAtZeroAlpha(tpl, composite, img);
    expect(r.checked).toBeGreaterThan(S * S * 0.9);
    expect(r.differing).toBe(0);
    expect(templateUntouched(tpl, composite, layer.alpha)).toBe(true);
    // Kesim dışı saydam pikseller saydam kalır.
    expect(composite.data[3]).toBe(0);
  });

  it("dekoru yeniden çizen model: kutu dışı değişim ölçülür", () => {
    const tpl = drawTemplate();
    const moved = paintText(drawTemplate({ ringDx: 6 }));
    const layer = extractTextLayer(tpl, moved, { region });
    expect(Math.max(layer.drift, layer.edited)).toBeGreaterThan(0.01);
  });
});

describe("writeOnTemplate", () => {
  it("sonuç = orijinal şablon + yazı katmanı; PNG'de de şablon pikselleri birebir", async () => {
    const tpl = drawTemplate();
    const templatePng = await encodeRgba(tpl);
    const generated = await encodeRgba(paintText(tpl));
    const gemini = createFakeGemini([generated]);
    const f = createFakeClaude([reply.json({ lines: ["Ada & Ali"], legible: true })]);
    const res = await writeOnTemplate({ gemini, claude: f.claude }, { templatePng, text: "Ada & Ali", areaHint: "centre", cut: CUT });
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.checks.templateUntouched).toBe(true);
    expect(res.checks.textMatches).toBe(true);
    expect(res.inkColor).toMatch(/^#[0-9A-F]{6}$/);

    const comp = await decodeRgba(res.compositePng!);
    const lay = await decodeRgba(res.textLayerPng!);
    const r = sameAtZeroAlpha(tpl, comp, lay);
    expect(r.differing).toBe(0);
    expect(r.checked).toBeGreaterThan(S * S * 0.9);

    // Modele beyaza düzleştirilmiş 1024'lük şablon gitti; istemde "şablona dokunma" var.
    const sent = await sharp(gemini.requests[0]!.images![0]!).metadata();
    expect([sent.width, sent.height]).toEqual([1024, 1024]);
    expect(gemini.requests[0]!.prompt).toMatch(/DO NOT CHANGE THE TEMPLATE/);
    expect(gemini.requests[0]!.prompt).toContain("Ada & Ali");
  });

  it("dekoru yeniden çizen sahte model reddedilir; bütün denemeler başarısızsa image-template-changed", async () => {
    const tpl = drawTemplate();
    const bad = await encodeRgba(paintText(drawTemplate({ ringDx: 6 })));
    const gemini = createFakeGemini([bad, bad]);
    const f = createFakeClaude([]);
    const res = await writeOnTemplate({ gemini, claude: f.claude }, { templatePng: await encodeRgba(tpl), text: "Ada & Ali", areaHint: "centre", cut: CUT });
    expect(res.ok).toBe(false);
    expect(res.checks.attempts).toBe(2);
    expect(res.issues[0]!.code).toBe("image-template-changed");
    expect(res.compositePng).toBeUndefined();
    expect(res.textLayerPng).toBeUndefined();
    expect(f.requests).toHaveLength(0); // reddedilen görsel okunmaz
  });

  it("dekoru silen model (yazıya yer açmak için) reddedilir, ikinci deneme kabul edilir", async () => {
    const tpl = drawTemplate();
    const erased = await encodeRgba(paintText(drawTemplate({ erasedFlower: true })));
    const fine = await encodeRgba(paintText(tpl));
    const gemini = createFakeGemini([erased, fine]);
    const f = createFakeClaude([reply.json({ lines: ["Ada & Ali"], legible: true })]);
    const said: string[] = [];
    const res = await writeOnTemplate(
      { gemini, claude: f.claude },
      { templatePng: await encodeRgba(tpl), text: "Ada & Ali", areaHint: "centre", cut: CUT, onProgress: (m) => said.push(m) },
    );
    expect(res.ok).toBe(true);
    expect(res.checks.attempts).toBe(2);
    expect(res.checks.edited).toBeLessThan(0.004);
    // Her denemenin kabul ölçüleri ve okunan yazı günlüğe düşer (eşiklere uyum sonradan doğrulanabilsin).
    const measures = said.filter((m) => m.startsWith("Ayrım ölçüleri:"));
    expect(measures).toHaveLength(2);
    expect(measures[1]).toContain(`dekor değişimi ${res.checks.edited.toFixed(4)} (≤ 0.004)`);
    expect(measures[1]).toContain(`kayma ${res.checks.drift.toFixed(4)} (≤ 0.08)`);
    expect(said).toContain("Yazı kontrolü: müşteri metniyle aynı (görselde: Ada & Ali)");
  });

  it("yazı tutmazsa yeniden dener; tutmazsa image-text-mismatch", async () => {
    const tpl = drawTemplate();
    const gen = await encodeRgba(paintText(tpl));
    const ok = await writeOnTemplate(
      { gemini: createFakeGemini([gen, gen]), claude: createFakeClaude([reply.json({ lines: ["Ada & Al"] }), reply.json({ lines: ["Ada", "& Ali"] })]).claude },
      { templatePng: await encodeRgba(tpl), text: "Ada & Ali", areaHint: "centre", cut: CUT },
    );
    expect(ok.ok).toBe(true);
    expect(ok.checks.attempts).toBe(2);

    const bad = await writeOnTemplate(
      { gemini: createFakeGemini([gen, gen]), claude: createFakeClaude([reply.json({ lines: ["ADA & ALI"] }), reply.json({ lines: ["Ada & Ali."] })]).claude },
      { templatePng: await encodeRgba(tpl), text: "Ada & Ali", areaHint: "centre", cut: CUT },
    );
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i) => i.code)).toContain("image-text-mismatch");
    // Katman yine de şablonu korur (kullanıcı görebilir).
    expect(bad.checks.templateUntouched).toBe(true);
  });

  it("kota hatasında beklemeden açık hata", async () => {
    const gemini = createFakeGemini([{ error: { kind: "quota", provider: "gemini", message: "kota bitti" } }]);
    const res = await writeOnTemplate({ gemini }, { templatePng: await encodeRgba(drawTemplate()), text: "Ada", areaHint: "centre" });
    expect(res.ok).toBe(false);
    expect(gemini.requests).toHaveLength(1);
    expect(res.issues[0]!.code).toBe("ai-failed");
  });
});

describe("generateTemplate", () => {
  it("çıktıyı kesim şekline maskeler; yazı bulunursa yeniden dener", async () => {
    const solid = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 90, g: 140, b: 200 } } }).png().toBuffer();
    const gemini = createFakeGemini([solid, solid]);
    const f = createFakeClaude([reply.json({ lines: ["Happy"], legible: true }), reply.json({ lines: [], legible: true })]);
    const cut = { kind: "circle" as const, cx: 128, cy: 128, r: 100 };
    const res = await generateTemplate({ gemini, claude: f.claude }, { theme: "deniz, mavi", cut, sizePx: 256 });
    expect(res.ok).toBe(true);
    expect(res.checks.attempts).toBe(2);
    const img = await decodeRgba(res.png!);
    expect([img.width, img.height]).toEqual([256, 256]);
    for (let y = 0; y < 256; y += 3) {
      for (let x = 0; x < 256; x += 3) {
        const d = Math.hypot(x + 0.5 - 128, y + 0.5 - 128);
        const a = img.data[(y * 256 + x) * 4 + 3]!;
        if (d > 101.5) expect(a).toBe(0);
        if (d < 98.5) expect(a).toBe(255);
      }
    }
    const c = (128 * 256 + 128) * 4;
    expect([img.data[c], img.data[c + 1], img.data[c + 2]]).toEqual([90, 140, 200]);
    // Kılavuz tuval: kesim çizgisi kılavuz ölçeğinde (512) çizili.
    const guide = await decodeRgba(gemini.requests[0]!.images![0]!);
    expect(guide.width).toBe(512);
    const onLine = (256 * 512 + (256 + 200)) * 4;
    expect(guide.data[onLine]).toBeLessThan(230);
    expect(guide.data[(256 * 512 + 256) * 4]).toBe(255);
    expect(gemini.requests[0]!.prompt).toMatch(/NO TEXT/);
  });

  it("cutGuidePng beyaz kare üretir", async () => {
    const g = await decodeRgba(await cutGuidePng({ kind: "rect", x: 20, y: 20, w: 472, h: 300, radius: 30 }, 512));
    expect(g.data[0]).toBe(255);
  });
});

describe("Gemini istemcisi", () => {
  const b64 = (async () => (await sharp({ create: { width: 8, height: 8, channels: 3, background: "#00ff00" } }).png().toBuffer()).toString("base64"))();

  it("interactions yoksa generateContent'e düşer ve bunu hatırlar", async () => {
    const data = await b64;
    const ok = { candidates: [{ content: { parts: [{ text: "işte" }, { inlineData: { mimeType: "image/png", data } }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1290 } };
    const f = fakeGeminiFetch([
      { endpoint: "interactions", status: 404, body: { error: { message: "Not found" } } },
      { endpoint: "generateContent", body: ok },
      { endpoint: "generateContent", body: ok },
    ]);
    const g = createGemini({ apiKey: "k", fetch: f.fetch, sleep: async () => {} });
    const r1 = await g.generate({ prompt: "p", images: [Buffer.from("x")] });
    expect(r1.error).toBeUndefined();
    expect(r1.ok).toBe(true);
    expect(r1.endpoint).toBe("generateContent");
    expect(r1.usage).toMatchObject({ inputTokens: 12, outputTokens: 1290, images: 1 });
    const body = f.requests[1]!.body as { generationConfig: { responseModalities: string[] }; contents: Array<{ parts: unknown[] }> };
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE", "TEXT"]);
    expect(body.contents[0]!.parts).toHaveLength(2);
    const r2 = await g.generate({ prompt: "p" });
    expect(r2.ok).toBe(true);
    expect(f.requests).toHaveLength(3);
  });

  it("kota hatasında ikinci uç noktayı denemez, ayar hatası döner", async () => {
    const f = fakeGeminiFetch([{ endpoint: "interactions", status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details." } } }]);
    const g = createGemini({ apiKey: "k", fetch: f.fetch, sleep: async () => {} });
    const r = await g.generate({ prompt: "p" });
    expect(r.ok).toBe(false);
    expect(r.error?.config).toBe(true);
    expect(f.requests).toHaveLength(1);
  });

  it("dakikalık hız sınırında bekleyip yeniden dener", async () => {
    const data = await b64;
    const f = fakeGeminiFetch([
      { endpoint: "interactions", status: 429, body: { error: { message: "Quota exceeded for metric requests per minute" } } },
      { endpoint: "interactions", body: { outputs: [{ type: "image", mime_type: "image/png", data }] } },
    ]);
    const sleeps: number[] = [];
    const g = createGemini({ apiKey: "k", fetch: f.fetch, sleep: async (ms) => void sleeps.push(ms) });
    const r = await g.generate({ prompt: "p" });
    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe("interactions");
    expect(sleeps).toEqual([1000]);
  });
});

describe("templateCutShape", () => {
  const profile = ProfileSchema.parse({ name: "t" });

  it("kesimsiz şablon (ya da şablon yok): profilin kesimi ve şablon kutusu, eskisiyle aynı", () => {
    const old = templateCutShape(profile, 840, 840);
    expect(old).toEqual({ kind: "circle", cx: (219.82 - 10) * 2, cy: (219.82 - 10) * 2, r: 218.82 * 2 });
    expect(templateCutShape(profile, 840, 840, { cut: null, imageBox: null })).toEqual(old);
    expect(templateCutShape(profile, 840, 840, null)).toEqual(old);
  });

  it("dikdörtgen kesimli şablon: maske şablonun kendi kesiminden, görsel kesim kutusunu kaplar", () => {
    // 63,5 × 38,1 mm → tasarım alanında 438 × 262,8 px; görsel 876 × 526 px bu kutuya oturur → maske görselin tamamı.
    const s = templateCutShape(profile, 876, 526, { cut: { shape: "rect", wMm: 63.5, hMm: 38.1 }, imageBox: null });
    expect(s.kind).toBe("rect");
    const r = s as Extract<typeof s, { kind: "rect" }>;
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(0, 6);
    expect(r.w).toBeCloseTo(876, 6);
    expect(r.h).toBeCloseTo(526, 6);
    expect(r.radius).toBe(0);
  });

  it("kesimli şablonda şablona özel görsel kutusu (imageBox) geçerli", () => {
    // Görsel kesimden 20 px geniş ve 20 px yukarıdan başlıyor (ölçek 1): kesim görselin içinde kayık.
    const imageBox = { x: -9, y: 68.6, w: 458, h: 302.8 };
    const s = templateCutShape(profile, 458, 302.8, { cut: { shape: "rect", wMm: 63.5, hMm: 38.1 }, imageBox }) as { kind: "rect"; x: number; y: number; w: number; h: number };
    expect(s.x).toBeCloseTo(10, 6);
    expect(s.y).toBeCloseTo(20, 6);
    expect(s.w).toBeCloseTo(438, 6);
    expect(s.h).toBeCloseTo(262.8, 6);
  });
});
