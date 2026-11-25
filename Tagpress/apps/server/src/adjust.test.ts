import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Issue, type LayoutResult, type LineEdit, type VariantEditModel, applyAdjustToLayout, applyLineEdits } from "@tagpress/domain";
import type { EditableFont, Engine } from "./ports.ts";
import { HttpError } from "./util/errors.ts";
import { runInOrg } from "./org/context.ts";
import { adjustSamples } from "./services/adjust.ts";
import { type TestApp, fakeEngine, fakeLayout, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

type EditLine = VariantEditModel["lines"][number];

let t: TestApp;
let lang: string;

/** Servisi doğrudan çağıran test satırları sunucudaki gibi firma bağlamında çalışır (bağlamsız çağrı sayılmaz). */
function inOrg<T>(t: TestApp, fn: () => T): T {
  return runInOrg(t.ctx.orgs.defaultOrgId()!, fn);
}

let rendered: LayoutResult[];

/** Sahte motor: çizilen yerleşimleri kaydeder; denetim mürekkep kutusu x < 20 ise "kesim dışı" der. */
function engine(): Engine {
  const base = fakeEngine();
  return {
    ...base,
    render: async (req) => {
      rendered.push(req.layout);
      return base.render(req);
    },
    checkPlacement: async ({ layout }) => {
      const out = layout.ink.x < 20;
      return {
        report: { inkPx: 100, outsideCutPx: out ? 7 : 0, decorationPx: 0, outsideFreePx: 0, ok: !out },
        issues: out ? [{ code: "collision", severity: "error", message: "Yazı kesim çizgisinin dışına taşıyor (7 piksel); baskıda kesilir.", field: "adjust", fixes: [] }] : [],
        ms: 3,
      };
    },
    textLayerSvg: ({ layout }) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 440">${layout.lines.map((l, i) => `<g data-line="${i}" data-text="${l.text}"></g>`).join("")}</svg>`,
    // Sahte elle düzenleme: satır genişliği = 40 px × karakter, eski satırın merkezine oturur.
    editLines: ({ layout, edits, jobText }) => {
      const out: LineEdit[] = edits
        .filter((e) => layout.lines[e.index] && (e.text !== undefined || e.fontId !== undefined || e.spans?.length))
        .map((e) => {
          if (e.fontId === "Yok/Regular") throw new HttpError(400, "Bu font seçilemez: Yok/Regular.", undefined, "edit-font");
          const old = layout.lines[e.index]!;
          const text = e.text?.trim() ?? old.text;
          const fontId = e.fontId ?? old.runs[0]!.fontId;
          const [family = "?", style = "Regular"] = fontId.split("/");
          const w = text.length * 40;
          const x = old.ink.x + old.ink.w / 2 - w / 2;
          return {
            index: e.index,
            ...(e.text !== undefined && text !== old.text ? { text } : {}),
            ...(e.fontId !== undefined ? { fontId } : {}),
            placed: { ...old, text, runs: [{ ...old.runs[0]!, text, fontId, family, style }], x, advance: w, ink: { ...old.ink, x, w } },
          };
        })
        .filter((e) => e.text !== undefined || e.fontId !== undefined);
      const edited = applyLineEdits(layout, out);
      const textEdited = edited.lines.map((l) => l.text).join(" ") !== jobText.replace(/\s+/g, " ");
      return {
        edits: out,
        layout: edited,
        issues: textEdited ? [{ code: "text-edited", severity: "info", message: "Satır metni elle düzenlendi.", field: "adjust", fixes: [] }] : [],
        textEdited,
        linesChanged: out.some((e) => e.text !== undefined),
      };
    },
    editFonts: ({ layout }) => ({
      fonts: [
        { id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", kind: "script" },
        { id: "Cinzel/Regular", family: "Cinzel", style: "Regular", kind: "serif" },
      ],
      lineFonts: layout.lines.map((l) => l.runs[0]!.fontId),
    }),
  };
}

async function variantOf(records: Record<string, unknown>[]) {
  const { commit } = await importJobs(t, records);
  await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
  await t.ctx.queue.idle();
  const job = (await t.api("GET", `/api/jobs/${commit.jobIds[0]}`)).json;
  const variantId = job.variants[0].id as string;
  return { jobId: job.id as string, variantId, job };
}

beforeEach(async () => {
  rendered = [];
  t = await makeApp({ ports: fullPorts({ engine: engine() }) });
  lang = await seedLanguage(t);
});
afterEach(() => t.close());

describe("hafif düzeltme uçları", () => {
  it("düzenleme modeli + yazı katmanı SVG", async () => {
    const { variantId, jobId } = await variantOf([{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const r = await t.api("GET", `/api/variants/${variantId}/edit`);
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({
      variantId,
      jobId,
      framePx: 440,
      templateImageUrl: `/api/languages/${lang}/templates/a1/image.png`,
      templateBox: { x: 10, y: 10, w: 420, h: 420 },
      cut: { kind: "circle", cx: 220, cy: 220, r: 218 },
      cutBox: { x: 2, y: 2, w: 436, h: 436 },
      areaBox: { x: 100, y: 100, w: 240, h: 240 },
      centers: { textCenter: { x: 220, y: 220, source: "area" }, area: { x: 220, y: 220 }, cut: { x: 220, y: 220 } },
      ink: { x: 120, y: 184, w: 200, h: 50 },
      origin: { x: 220, y: 209 },
      adjust: null,
      adjustedInk: { x: 120, y: 184, w: 200, h: 50 },
      textLayerUrl: `/api/variants/${variantId}/edit/text.svg`,
      limits: { scaleMin: 0.5, scaleMax: 1.5, shiftMaxPx: 500 },
    });
    expect(r.json.lines.map((l: EditLine) => l.text)).toEqual(["Anna", "Marco"]);
    // Kalınlık: temel kontur, hiza, satır konturu, sınır.
    expect(r.json).toMatchObject({ strokePx: 0.5, strokeAlign: "outside", limits: { strokeMaxPx: 20 } });
    expect(r.json.lines.map((l: EditLine) => l.strokePx)).toEqual([0.5, 0.5]);
    const svg = await t.api("GET", `/api/variants/${variantId}/edit/text.svg`);
    expect(svg.status).toBe(200);
    expect(String(svg.headers["content-type"])).toMatch(/image\/svg\+xml/);
    expect(svg.body).toContain(`<g data-line="1"`);
  });

  it("hızlı denetim kaydetmez; taşma sorunu döner; geçersiz düzeltme 400", async () => {
    const { variantId } = await variantOf([{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const ok = await t.api("POST", `/api/variants/${variantId}/adjust/check`, { adjust: { dx: 10, dy: 1 } });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json).toMatchObject({ adjust: { dx: 10, dy: 1, scale: 1 }, ink: { x: 130, y: 185, w: 200, h: 50 }, issues: [], collision: { outsideCutPx: 0 } });
    expect(ok.json.lineInks).toHaveLength(2);
    expect(ok.json.ms).toBeTypeOf("number");
    const out = await t.api("POST", `/api/variants/${variantId}/adjust/check`, { adjust: { dx: -150 } });
    expect(out.json.issues[0]).toMatchObject({ code: "collision", severity: "error", field: "adjust" });
    expect((await t.api("GET", `/api/variants/${variantId}`)).json.adjust).toBeNull();
    expect((await t.api("POST", `/api/variants/${variantId}/adjust/check`, { adjust: { scale: 2 } })).status).toBe(400);
    expect((await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { dx: 600 } })).status).toBe(400);
    expect((await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { dx: 1 }, extra: 1 })).status).toBe(400);
  });

  it("kaydet → önizleme yeniden çizilir, işaretlenir, öğrenme kaydı; yeniden kaydet + geri al; kaldır + geri al", async () => {
    const { variantId, jobId, job } = await variantOf([{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const baseUrl = job.variants[0].previewUrl as string;
    const baseIssues = (await t.api("GET", `/api/variants/${variantId}`)).json.issues;
    rendered = [];

    const s1 = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { dx: 10, dy: -4, scale: 1.04 } });
    expect(s1.status, s1.body).toBe(200);
    expect(s1.json.variant).toMatchObject({ adjust: { dx: 10, dy: -4, scale: 1.04 }, adjusted: true });
    expect(s1.json.variant.layout.lines[0].ink).toEqual({ x: 120, y: 184, w: 200, h: 20 }); // motor yerleşimi korunur
    expect(s1.json.variant.previewUrl).not.toBe(baseUrl);
    expect(s1.json.undo.label).toBe("Elle düzeltme kaydedildi");
    // Önizleme düzeltilmiş yerleşimle çizildi: blok merkezi (220,209) etrafında 1,04 + kaydırma.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.lines[0]!.sizePx).toBe(20.8);
    expect(rendered[0]!.ink.x).toBeCloseTo(220 + 1.04 * (120 - 220) + 10, 2);
    const row = inOrg(t, () => t.ctx.variants.row(variantId))!;
    expect(existsSync(path.join(inOrg(t, () => t.ctx.paths.previews), row.preview_file))).toBe(true);
    expect(row.preview_file).toBe(`${variantId}.adj1.png`);
    expect((await t.api("GET", s1.json.variant.previewUrl)).status).toBe(200);
    const listed = (await t.api("GET", `/api/jobs/${jobId}`)).json.variants[0];
    expect(listed.adjusted).toBe(true);

    // Öğrenme kaydı: şablon + hedef merkeze göre kayma.
    const samples = inOrg(t, () => adjustSamples(t.ctx.tdb, lang));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ variantId, templateKey: "a1", framePx: 440, adjust: { dx: 10, dy: -4, scale: 1.04 }, target: { x: 220, y: 220, source: "area" }, offsetBefore: { x: 0, y: -11 } });
    expect(samples[0]!.offsetAfter.x).toBeCloseTo(10, 1);
    expect(samples[0]!.offsetAfter.y).toBeCloseTo(-15, 1);
    expect(inOrg(t, () => t.ctx.adjust.samples(lang, "a2"))).toEqual([]);

    // Yeniden kaydet, sonra geri al → ilk düzeltmeye döner.
    const s2 = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { dx: -150, dy: 0, scale: 1 } });
    expect(s2.json.variant.issues.map((i: Issue) => [i.code, i.field])).toContainEqual(["collision", "adjust"]);
    expect(s2.json.variant.worst).toBe("error");
    expect(inOrg(t, () => t.ctx.variants.row(variantId))!.preview_file).toBe(`${variantId}.adj2.png`);
    const u2 = await t.api("POST", `/api/undo/${s2.json.undo.undoToken}`);
    expect(u2.status, u2.body).toBe(200);
    const after = (await t.api("GET", `/api/variants/${variantId}`)).json;
    expect(after.adjust).toEqual({ dx: 10, dy: -4, scale: 1.04 });
    expect(after.issues).toEqual(baseIssues);
    expect(inOrg(t, () => t.ctx.variants.row(variantId))!.preview_file).toBe(`${variantId}.adj1.png`);
    expect(inOrg(t, () => adjustSamples(t.ctx.tdb, lang)).map((s) => s.adjust.dx)).toEqual([10]);

    // Kaldır → özgün önizleme ve sorunlar; geri al → düzeltme geri gelir.
    const del = await t.api("DELETE", `/api/variants/${variantId}/adjust`);
    expect(del.status, del.body).toBe(200);
    expect(del.json.variant).toMatchObject({ adjust: null, adjusted: false, previewUrl: baseUrl });
    expect(del.json.variant.issues).toEqual(baseIssues);
    expect(inOrg(t, () => adjustSamples(t.ctx.tdb, lang))).toEqual([]);
    expect((await t.api("DELETE", `/api/variants/${variantId}/adjust`)).status).toBe(409);
    await t.api("POST", `/api/undo/${del.json.undo.undoToken}`);
    expect((await t.api("GET", `/api/variants/${variantId}`)).json.adjust).toEqual({ dx: 10, dy: -4, scale: 1.04 });
    expect(inOrg(t, () => adjustSamples(t.ctx.tdb, lang))).toHaveLength(1);

    // Kimlik düzeltmesiyle PUT = kaldır.
    const id0 = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { dx: 0, dy: 0, scale: 1 } });
    expect(id0.json.variant.adjust).toBeNull();
    expect(id0.json.undo.label).toBe("Elle düzeltme kaldırıldı");
  });

  it("görüntü modu varyasyonu düzeltilemez (422)", async () => {
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
    await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "image-on-template" });
    await t.ctx.queue.idle();
    const v = (await t.api("GET", `/api/jobs/${commit.jobIds[0]}`)).json.variants[0];
    expect(v.kind).toBe("image-on-template");
    const r = await t.api("GET", `/api/variants/${v.id}/edit`);
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("not-adjustable");
  });

  it("satır düzeltmesi + kalınlık uçtan uca: denetim, kaydet (önizleme), öğrenme kaydı", async () => {
    const { variantId } = await variantOf([{ siparis: "8", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const model = (await t.api("GET", `/api/variants/${variantId}/edit`)).json;
    const l1 = model.lines[1].ink;
    const adjust = { dx: 0, dy: 0, scale: 1, strokePx: 1, lines: [{ index: 1, dx: 8, dy: -3, scale: 1.2, strokePx: 0.5 }] };
    // Etkin konturlar (temel 0,5): satır 0 = 0,5 + 1 = 1,5; satır 1 = 0,5·1,2 + 1 + 0,5 = 2,1.
    const chk = await t.api("POST", `/api/variants/${variantId}/adjust/check`, { adjust });
    expect(chk.status, chk.body).toBe(200);
    expect(chk.json.adjust).toEqual(adjust);
    expect(chk.json.lineStrokes).toEqual([1.5, 2.1]);
    // Satır 1: kendi merkezi etrafında 1,2, +(8,−3), dışa hizada her yandan 2,1 − 0,6 = 1,5 büyür.
    const want1 = { x: l1.x + l1.w / 2 - (1.2 * l1.w) / 2 + 8 - 1.5, y: l1.y + l1.h / 2 - (1.2 * l1.h) / 2 - 3 - 1.5, w: 1.2 * l1.w + 3, h: 1.2 * l1.h + 3 };
    for (const k of ["x", "y", "w", "h"] as const) expect(chk.json.lineInks[1][k]).toBeCloseTo(want1[k], 2);
    // Satır 0 yalnızca blok kalınlığıyla büyür (her yandan 1).
    expect(chk.json.lineInks[0].w).toBeCloseTo(model.lines[0].ink.w + 2, 2);

    rendered = [];
    const s = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust });
    expect(s.status, s.body).toBe(200);
    expect(s.json.variant.adjust).toEqual(adjust);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.lines.map((l) => l.strokePx)).toEqual([1.5, 2.1]);
    expect(rendered[0]!.lines[1]!.sizePx).toBeCloseTo(model.lines[1].sizePx * 1.2, 2);
    expect(rendered[0]!.lines[0]!.sizePx).toBe(model.lines[0].sizePx);
    expect(rendered[0]!.lines[1]!.ink).toEqual(chk.json.lineInks[1]);

    // Öğrenme kaydı satırları ve kalınlığı da saklar.
    const sample = inOrg(t, () => adjustSamples(t.ctx.tdb, lang)).find((x) => x.variantId === variantId)!;
    expect(sample.adjust).toEqual(adjust);
    expect(sample.inkAfter).toEqual(chk.json.ink);
  });

  it("yalnız kalınlık (blok + satır) kaydedilir: edit cevabında geri gelir, önizleme sürümü değişir ve kalınlıkla yeniden çizilir", async () => {
    const { variantId } = await variantOf([{ siparis: "9", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const before = (await t.api("GET", `/api/variants/${variantId}/edit`)).json;
    expect(before.adjust).toBeNull();
    const v0 = new URL(before.previewUrl, "http://x").searchParams.get("v");
    rendered = [];

    // Konum/boyut aynı (kimlik), yalnız kalınlık: kimlik sayılıp düşmemeli.
    const adjust = { dx: 0, dy: 0, scale: 1, strokePx: 2, lines: [{ index: 1, dx: 0, dy: 0, scale: 1, strokePx: 1 }] };
    const put = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust });
    expect(put.status, put.body).toBe(200);
    expect(put.json.variant.adjust).toEqual(adjust);

    const after = (await t.api("GET", `/api/variants/${variantId}/edit`)).json;
    expect(after.adjust).toEqual(adjust);
    expect(after.adjust.strokePx).toBe(2);
    expect(after.adjust.lines[0].strokePx).toBe(1);
    // Taban değerler (motor çıktısı) değişmez; etkin kalınlık düzeltmeden gelir.
    expect(after.strokePx).toBe(0.5);
    expect(after.lines.map((l: EditLine) => l.strokePx)).toEqual([0.5, 0.5]);
    // Önizleme yeniden üretildi: sürüm değişti ve yeni dosya servis ediliyor.
    const v1 = new URL(after.previewUrl, "http://x").searchParams.get("v");
    expect(v1).not.toBe(v0);
    expect((await t.api("GET", after.previewUrl)).status).toBe(200);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.lines.map((l) => l.strokePx)).toEqual([2.5, 3.5]); // 0,5 + blok 2 (+ satır 1)
    expect(inOrg(t, () => t.ctx.variants.row(variantId))!.preview_file).toBe(`${variantId}.adj1.png`);

    // Kalınlığı değiştirip yeniden kaydet: sürüm yine değişir.
    const put2 = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { dx: 0, dy: 0, scale: 1, strokePx: 3 } });
    expect(put2.status, put2.body).toBe(200);
    const again = (await t.api("GET", `/api/variants/${variantId}/edit`)).json;
    expect(again.adjust).toEqual({ dx: 0, dy: 0, scale: 1, strokePx: 3 });
    expect(new URL(again.previewUrl, "http://x").searchParams.get("v")).not.toBe(v1);
    expect(rendered).toHaveLength(2);
    expect(rendered[1]!.lines.map((l) => l.strokePx)).toEqual([3.5, 3.5]);
  });

  it("kalınlık temel konturu sıfıra indirebilir: kontur kalmaz", () => {
    const profile = inOrg(t, () => t.ctx.profiles.activeProfile(lang)).profile;
    const layout = fakeLayout({ lines: [{ text: "Anna", role: "name", tier: "primary", fontId: "Great Vibes/Regular" }], rationale: "" });
    const out = applyAdjustToLayout(layout, { dx: 0, dy: 0, scale: 1, strokePx: -3 }, { strokeAlign: profile.weight.align });
    expect(out.lines[0]!.strokePx).toBe(0);
    // Kontur kalkınca mürekkep kutusu çıkıntı kadar (0,5) daralır.
    expect(out.lines[0]!.ink.w).toBeCloseTo(layout.lines[0]!.ink.w - 1, 2);
  });
});

describe("elle metin/font düzenlemesi", () => {
  it("relayout: motor satırı ölçer (istemcinin placed'i yok sayılır), yazı katmanı ve notlar döner; seçilemeyen font / boş satır 400", async () => {
    const { variantId } = await variantOf([{ siparis: "21", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const bogus = { text: "X", role: "name", tier: "primary", sizePx: 1, runs: [], baselineY: 0, x: 0, advance: 0, ink: { x: 0, y: 0, w: 1, h: 1 } };
    const r = await t.api("POST", `/api/variants/${variantId}/edit/relayout`, { edits: [{ index: 1, text: "Marcello", placed: bogus }] });
    expect(r.status, r.body).toBe(200);
    expect(r.json.edits).toHaveLength(1);
    expect(r.json.edits[0]).toMatchObject({ index: 1, text: "Marcello", placed: { text: "Marcello", ink: { x: 60, w: 320 } } });
    expect(r.json.textSvg).toContain('data-text="Marcello"');
    expect(r.json.issues.map((i: Issue) => i.code)).toEqual(["text-edited"]);
    // Kaydetmez.
    expect((await t.api("GET", `/api/variants/${variantId}`)).json.adjust).toBeNull();
    const bad = await t.api("POST", `/api/variants/${variantId}/edit/relayout`, { edits: [{ index: 0, fontId: "Yok/Regular" }] });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("edit-font");
    expect((await t.api("POST", `/api/variants/${variantId}/edit/relayout`, { edits: [{ index: 0, text: "  " }] })).status).toBe(400);
    expect((await t.api("POST", `/api/variants/${variantId}/adjust/check`, { adjust: { edits: [{ index: 0, text: "a\nb" }] } })).status).toBe(400);
  });

  it("düzenleme modeli: font kataloğu, aile kuralı, iş metni, satır fontları", async () => {
    const { variantId } = await variantOf([{ siparis: "22", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const m = (await t.api("GET", `/api/variants/${variantId}/edit`)).json;
    expect(m.fonts.map((f: EditableFont) => f.id)).toEqual(["Great Vibes/Regular", "Cinzel/Regular"]);
    expect(m.fontMixing).toBe("single");
    expect(m.jobText).toBe("Anna Marco");
    for (const l of m.lines) expect(typeof l.fontId).toBe("string");
  });

  it("denetim + kaydet: düzenleme önizlemeye ve öğrenme kaydına girer; iş metni değişmez", async () => {
    const { variantId, jobId } = await variantOf([{ siparis: "23", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const adjust = { dx: 4, dy: 0, scale: 1, edits: [{ index: 1, text: "Marcello", fontId: "Cinzel/Regular" }] };
    const chk = await t.api("POST", `/api/variants/${variantId}/adjust/check`, { adjust });
    expect(chk.status, chk.body).toBe(200);
    expect(chk.json.adjust.edits[0]).toMatchObject({ index: 1, text: "Marcello", fontId: "Cinzel/Regular", placed: { text: "Marcello" } });
    expect(chk.json.lineInks[1]).toMatchObject({ x: 64, w: 320 });
    expect(chk.json.issues.map((i: Issue) => i.code)).toContain("text-edited");

    rendered = [];
    const s = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust });
    expect(s.status, s.body).toBe(200);
    expect(s.json.variant).toMatchObject({ adjusted: true, textEdited: true, stale: false });
    expect(s.json.variant.adjust.edits[0].placed.runs[0]).toMatchObject({ text: "Marcello", family: "Cinzel" });
    expect(s.json.variant.issues.find((i: Issue) => i.code === "text-edited")).toMatchObject({ severity: "info", field: "adjust" });
    // Motor yerleşimi (layout) korunur; önizleme düzenlenmiş + düzeltilmiş hâlle çizildi.
    expect(s.json.variant.layout.lines[1].text).toBe("Marco");
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.lines.map((l) => l.text)).toEqual(["Anna", "Marcello"]);
    expect(rendered[0]!.lines[1]!.ink.x).toBe(64);
    // İşin (müşterinin) metni değişmez.
    const job = (await t.api("GET", `/api/jobs/${jobId}`)).json;
    expect(job.text).toBe("Anna Marco");
    expect(job.variants[0].textEdited).toBe(true);
    // Öğrenme kaydı: "önce" düzenlenmiş satırlarla motor yerleşimi, "sonra" + kaydırma.
    const sample = inOrg(t, () => adjustSamples(t.ctx.tdb, lang)).find((x) => x.variantId === variantId)!;
    expect(sample.inkBefore).toMatchObject({ x: 60, w: 320 });
    expect(sample.inkAfter).toMatchObject({ x: 64, w: 320 });
    expect(sample.adjust.edits?.[0]?.text).toBe("Marcello");
    expect(inOrg(t, () => t.ctx.learning.adjustInput(lang)).observations.find((o) => o.id === variantId)?.replay).toBeNull();
    // Düzenleme modeli kayıtlı düzenlemeyi geri verir.
    const m = (await t.api("GET", `/api/variants/${variantId}/edit`)).json;
    expect(m.adjust.edits[0]).toMatchObject({ index: 1, text: "Marcello", placed: { text: "Marcello" } });
  });

  it("geri al ve yalnız font: düzenleme geri alınınca not ve işaret kalkar; metin aynıysa elle metin işareti yok", async () => {
    const { variantId } = await variantOf([{ siparis: "24", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const s = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { edits: [{ index: 0, text: "Ana" }] } });
    expect(s.status, s.body).toBe(200);
    expect(s.json.variant.textEdited).toBe(true);
    await t.api("POST", `/api/undo/${s.json.undo.undoToken}`);
    const v = (await t.api("GET", `/api/variants/${variantId}`)).json;
    expect(v.adjust).toBeNull();
    expect(v.textEdited).toBe(false);
    expect(v.issues.some((i: Issue) => i.code === "text-edited")).toBe(false);
    // Aynı metin + yalnız font: düzenleme kalır, metin işareti yok.
    const f = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { edits: [{ index: 0, text: "Anna", fontId: "Cinzel/Regular" }] } });
    expect(f.status, f.body).toBe(200);
    expect(f.json.variant.textEdited).toBe(false);
    expect(f.json.variant.adjust.edits).toEqual([expect.objectContaining({ index: 0, fontId: "Cinzel/Regular" })]);
    expect(f.json.variant.adjust.edits[0].text).toBeUndefined();
    // Motorun etkisiz bulduğu düzenleme: kayıtlı düzeltme kaldırılır.
    const none = await t.api("PUT", `/api/variants/${variantId}/adjust`, { adjust: { edits: [{ index: 0, text: "Anna" }] } });
    expect(none.status, none.body).toBe(200);
    expect(none.json.variant.adjust).toBeNull();
  });
});
