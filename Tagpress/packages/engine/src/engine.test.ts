import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { type DesignIntent, type IntentLine, type LayoutResult, type Profile, type TemplateGeometry, ptToPx } from "@tagpress/domain";
import type { FontRegistry } from "@tagpress/typeset";
import { PARISIENNE, testFonts, userProfile } from "./fixtures.ts";
import { checkIntentRules, insideShape, layout, makeTestGeometry, renderPreview, renderTextOnly } from "./index.ts";

const GV = "Great Vibes/Regular";
const MC = PARISIENNE;
const PF = "Playfair Display/Regular";

const L = (text: string, tier: IntentLine["tier"] = "primary", o: Partial<IntentLine> = {}): IntentLine => ({
  text,
  tier,
  role: tier === "connector" ? "connector" : tier === "primary" ? "name" : "other",
  fontId: GV,
  ...o,
});
const I = (...lines: IntentLine[]): DesignIntent => ({ lines, rationale: "" });

/** Yazı katmanını geometri çözünürlüğünde çizer ve mürekkebi sayar (motordan bağımsız denetim). */
async function inkStats(r: LayoutResult, g: TemplateGeometry, fonts: FontRegistry) {
  const S = g.free.scale;
  const png = await renderTextOnly(r, fonts, { scale: S, framePx: g.framePx });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let ink = 0, outsideCut = 0, decoration = 0, outsideFree = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! < 128) continue;
      ink++;
      if (!insideShape(g.cut, (x + 0.5) / S, (y + 0.5) / S)) outsideCut++;
      if (g.decoration.data[y * g.decoration.width + x]) decoration++;
      if (!g.free.data[y * g.free.width + x]) outsideFree++;
    }
  return { ink, outsideCut, decoration, outsideFree };
}

const cx = (b: { x: number; w: number }) => b.x + b.w / 2;
const gapBetween = (r: LayoutResult, i: number) => r.lines[i]!.ink.y - (r.lines[i - 1]!.ink.y + r.lines[i - 1]!.ink.h);

describe("motor", () => {
  let profile: Profile;
  let fonts: FontRegistry;
  let g: TemplateGeometry;
  const run = (text: string, intent: DesignIntent, p: Profile = profile, geometry: TemplateGeometry = g) => layout({ text, intent, profile: p, geometry, fonts });

  beforeAll(async () => {
    profile = userProfile();
    fonts = await testFonts(profile);
    g = makeTestGeometry();
  });

  describe("metin koruma ve ön işlem", () => {
    it("metni değiştiren niyet reddedilir (text-changed)", async () => {
      const r = await run("Anna & Marco", I(L("anna & Marco")));
      expect(r.ok).toBe(false);
      expect(r.issues[0]!.code).toBe("text-changed");
      const r2 = await run("Happy Navarathri -", I(L("Happy Navarathri")));
      expect(r2.issues.map((i) => i.code)).toContain("text-changed");
    });

    it("satır kenarı boşlukları atılır, metin aynı kalır", async () => {
      const r = await run("Grazie  03/10/2026", I(L("Grazie "), L("  03/10/2026", "tertiary", { role: "date" })));
      expect(r.ok).toBe(true);
      expect(r.lines.map((l) => l.text)).toEqual(["Grazie", "03/10/2026"]);
      expect(Math.abs(cx(r.lines[0]!.ink) - cx(r.lines[1]!.ink))).toBeLessThan(0.05);
    });

    it("sembol bağlacın çevresine boşluk eklenebilir (Mina&Ali → Mina / & / Ali)", async () => {
      const r = await run("Mina&Ali", I(L("Mina"), L("&", "connector"), L("Ali")));
      expect(r.ok).toBe(true);
      expect(r.lines).toHaveLength(3);
    });

    it("baş harf çifti tek satıra alınır; bayrak kapalıyken alınmaz", async () => {
      const intent = I(L("A"), L("&", "connector"), L("M"));
      const r = await run("A & M", intent);
      expect(r.lines.map((l) => l.text)).toEqual(["A & M"]);
      expect(r.lines[0]!.tier).toBe("primary");
      expect(r.notes.join(" ")).toMatch(/Baş harf/);
      const off = await run("A & M", intent, userProfile({ sizing: { initials: { oneLine: false } } }));
      expect(off.lines).toHaveLength(3);
      // Boşluksuz kaynak boşluksuz birleşir.
      const tight = await run("A&M", I(L("A&"), L("M")));
      expect(tight.lines.map((l) => l.text)).toEqual(["A&M"]);
    });

    it("asılı bağlaç kendi satırına alınır ve isimler eşitlenir; bayrak kapalıyken dokunulmaz", async () => {
      const intent = I(L("Elena e"), L("Martina", "secondary"), L("12.10.2026", "tertiary", { role: "date" }));
      const r = await run("Elena e Martina 12.10.2026", intent);
      expect(r.lines.map((l) => l.text)).toEqual(["Elena", "e", "Martina", "12.10.2026"]);
      expect(r.lines[0]!.sizePx).toBe(r.lines[2]!.sizePx);
      expect(r.lines[1]!.tier).toBe("connector");
      expect(r.notes.some((n) => n.includes("Asılı bağlaç"))).toBe(true);
      const start = await run("Elena e Martina", I(L("Elena"), L("e Martina")));
      expect(start.lines.map((l) => l.text)).toEqual(["Elena", "e", "Martina"]);
      const off = await run("Elena e Martina 12.10.2026", intent, userProfile({ connectors: { separateDangling: false } }));
      expect(off.lines.map((l) => l.text)).toEqual(["Elena e", "Martina", "12.10.2026"]);
    });

    it("cümle içindeki bağlaca dokunulmaz", async () => {
      const r = await run("Thank you for coming and celebrating with us", I(
        L("Thank you for coming and", "secondary", { role: "message" }),
        L("celebrating with us", "secondary", { role: "message" }),
      ));
      expect(r.lines.map((l) => l.text)).toEqual(["Thank you for coming and", "celebrating with us"]);
    });
  });

  describe("run çözümü", () => {
    it("glif kuralları HER satırda ve HER rolde", async () => {
      const r = await run("Anna & Marco Grazie a tutti & Alla", I(
        L("Anna & Marco"),
        L("Grazie a tutti &", "tertiary", { role: "message" }),
        L("Alla", "secondary", { role: "place" }),
      ));
      expect(r.ok).toBe(true);
      for (const line of r.lines) {
        const amp = line.runs.find((x) => x.text.includes("&"));
        if (amp) {
          expect(amp.fontId).toBe("IM FELL Great Primer SC/Regular");
          expect(amp.sizePx).toBeCloseTo(line.sizePx * 0.5, 1); // "&" kuralının scale'i run seviyesinde
        }
      }
      // Kelime başındaki büyük A (Alex Brush) ikincil satırda da; küçük "a" kelimesine dokunulmaz.
      expect(r.lines[2]!.runs[0]).toMatchObject({ text: "A", fontId: "Alex Brush/Regular" });
      expect(r.lines[0]!.runs[0]).toMatchObject({ text: "A", fontId: "Alex Brush/Regular" });
      expect(r.lines[1]!.runs.find((x) => x.fontId === "Alex Brush/Regular")).toBeUndefined();
    });

    it("onlyWithFonts: kural yalnızca listelenen ana fontta", async () => {
      const r = await run("Anna", I(L("Anna", "primary", { fontId: MC })));
      expect(r.lines[0]!.runs.every((x) => x.fontId === MC)).toBe(true);
    });

    it("bitişik bağlaçtan sonraki büyük harf de kelime başıdır (Mina&Alessia)", async () => {
      const r = await run("Mina&Alessia", I(L("Mina&Alessia")));
      expect(r.lines[0]!.runs.map((x) => x.text)).toEqual(["Mina", "&", "A", "lessia"]);
    });

    it("tek başına bağlaç satırı sınıf oranında; '&' küçültmesi iki kez uygulanmaz", async () => {
      const r = await run("Anna & Marco", I(L("Anna"), L("&", "connector"), L("Marco")));
      expect(r.lines[1]!.sizePx / r.lines[0]!.sizePx).toBeCloseTo(0.52, 2);
      expect(r.lines[1]!.runs[0]!.sizePx).toBeCloseTo(r.lines[1]!.sizePx, 2);
      const p = userProfile({ sizing: { connectorScales: { e: 0.45 } } });
      const e = await run("Elena e Martina", I(L("Elena"), L("e", "connector"), L("Martina")), p);
      expect(e.lines[1]!.sizePx / e.lines[0]!.sizePx).toBeCloseTo(0.45, 2);
    });

    it("yedek font: Arapça ve emoji kaybolmaz, bilgi verilir", async () => {
      const text = "Ali ❤️ مرحبا بكم";
      const r = await run(text, I(L("Ali ❤️"), L("مرحبا بكم", "secondary")));
      expect(r.ok).toBe(true);
      for (const line of r.lines) expect(line.runs.map((x) => x.text).join("")).toBe(line.text);
      const fb = r.lines.flatMap((l) => l.runs.filter((x) => x.fallback));
      expect(fb.map((x) => x.fontId)).toContain("Twemoji Mozilla/Regular");
      expect(fb.map((x) => x.fontId)).toContain("Noto Naskh Arabic/Regular");
      // Arapça cümle boşluğuyla birlikte tek run (RTL kelime sırası bozulmasın).
      expect(r.lines[1]!.runs).toHaveLength(1);
      expect(r.issues.find((i) => i.code === "text-fallback-font")?.severity).toBe("info");
    });

    it("hiçbir fontun basamadığı karakter silinmez, hata olarak raporlanır", async () => {
      const r = await run("Anna 𓀀", I(L("Anna 𓀀")));
      expect(r.ok).toBe(false);
      expect(r.issues.map((i) => i.code)).toContain("text-unprintable");
      expect(r.lines[0]!.runs.map((x) => x.text).join("")).toBe("Anna 𓀀");
    });

    it("font politikası: büyük harf sınırı, tek aile, yalnızca kural fontu", async () => {
      const caps = await run("ANNA", I(L("ANNA")));
      expect(caps.ok).toBe(false);
      expect(caps.issues[0]!.code).toBe("font-unavailable");
      const mix = await run("Anna Roma", I(L("Anna"), L("Roma", "secondary", { fontId: MC })));
      expect(mix.issues.map((i) => i.code)).toContain("font-mixing");
      const two = await run("Anna Roma", I(L("Anna"), L("Roma", "secondary", { fontId: MC })), userProfile({ fonts: { mixing: "two" } }));
      expect(two.ok).toBe(true);
      const glyphOnly = await run("Anna", I(L("Anna", "primary", { fontId: "Alex Brush/Regular" })));
      expect(glyphOnly.ok).toBe(false);
    });
  });

  describe("boyut, aralık, hizalama", () => {
    it("kilitli oranlar: sınıf oranları uygulanır, niyetteki size yok sayılır", async () => {
      const r = await run("Giulia Laurea 2026", I(L("Giulia"), L("Laurea", "secondary", { size: 0.9 }), L("2026", "tertiary", { size: 0.2 })));
      const base = r.lines[0]!.sizePx;
      expect(r.lines[1]!.sizePx / base).toBeCloseTo(0.73, 2);
      expect(r.lines[2]!.sizePx / base).toBeCloseTo(0.64, 2);
      const free = userProfile({ sizing: { tiersLocked: false } });
      const r2 = await run("Giulia Laurea 2026", I(L("Giulia"), L("Laurea", "secondary", { size: 0.9 }), L("2026", "tertiary", { size: 0.5 })), free);
      expect(r2.lines[1]!.sizePx / r2.lines[0]!.sizePx).toBeCloseTo(0.9, 2);
    });

    it("görünen boşluklar: normal, son küçük satırdan önce ve bağlaç çevresi", async () => {
      const r = await run("Thank you Anna & Marco 12.10.2026", I(
        L("Thank you", "secondary", { role: "greeting" }),
        L("Anna"),
        L("&", "connector"),
        L("Marco"),
        L("12.10.2026", "tertiary", { role: "date" }),
      ));
      expect(r.ok).toBe(true);
      const s = r.lines.map((l) => l.sizePx);
      const tol = 0.06;
      expect(gapBetween(r, 1)).toBeCloseTo(0.11 * Math.min(s[0]!, s[1]!), 1);
      expect(Math.abs(gapBetween(r, 2) - 0.09 * Math.min(s[1]!, s[2]!))).toBeLessThan(tol);
      expect(Math.abs(gapBetween(r, 3) - 0.09 * Math.min(s[2]!, s[3]!))).toBeLessThan(tol);
      expect(Math.abs(gapBetween(r, 4) - 0.29 * Math.min(s[3]!, s[4]!))).toBeLessThan(tol);
    });

    it("satırlar mürekkep kutusuna göre ortalanır", async () => {
      const r = await run("Battesimo di Samuele 2026", I(L("Battesimo di", "secondary"), L("Samuele"), L("2026", "tertiary")));
      const centers = r.lines.map((l) => cx(l.ink));
      for (const c of centers) expect(Math.abs(c - centers[0]!)).toBeLessThan(0.05);
    });

    it("bağlaç kayması: iki el yazısı ismin arasında, isim puntosunun shiftEm'i kadar sağa", async () => {
      const r = await run("Kimberly & Matthew", I(L("Kimberly"), L("&", "connector"), L("Matthew")));
      const names = (cx(r.lines[0]!.ink) + cx(r.lines[2]!.ink)) / 2;
      expect(cx(r.lines[1]!.ink) - names).toBeCloseTo(0.13 * r.lines[0]!.sizePx, 1);
      // El yazısı olmayan fontta ve tamamı büyük harf isimlerde kayma yok.
      const serif = await run("Kimberly & Matthew", I(L("Kimberly", "primary", { fontId: PF }), L("&", "connector", { fontId: PF }), L("Matthew", "primary", { fontId: PF })));
      expect(Math.abs(cx(serif.lines[1]!.ink) - cx(serif.lines[0]!.ink))).toBeLessThan(0.05);
      const caps = await run("KIM & MATT", I(L("KIM", "primary", { fontId: MC }), L("&", "connector", { fontId: MC }), L("MATT", "primary", { fontId: MC })));
      expect(Math.abs(cx(caps.lines[1]!.ink) - cx(caps.lines[0]!.ink))).toBeLessThan(0.05);
      const zero = await run("Kimberly & Matthew", I(L("Kimberly"), L("&", "connector"), L("Matthew")), userProfile({ connectors: { shiftEm: 0 } }));
      expect(Math.abs(cx(zero.lines[1]!.ink) - cx(zero.lines[0]!.ink))).toBeLessThan(0.05);
    });

    it("harf yüksekliği sınırı: kısa metin kesim çapının maxCapHeight'ını aşmaz; baş harfte ayrı sınır", async () => {
      const r = await run("Lu", I(L("Lu")));
      const cap = (fonts.get(GV).capHeight / fonts.get(GV).upem) * r.basePx;
      expect(cap).toBeLessThanOrEqual(0.14 * 438 + 0.01);
      expect(r.notes.join(" ")).toMatch(/harf yüksekliği/);
      const ini = await run("A & M", I(L("A & M")), userProfile({ sizing: { initials: { maxCapHeight: 0.25 } } }));
      expect(ini.basePx).toBeGreaterThan((await run("A & M", I(L("A & M")))).basePx);
    });

    it("doluluk: kilitliyse profil, değilse niyet", async () => {
      const long = I(L("Grazie per la vostra presenza", "secondary", { role: "message" }), L("Giulia e Marco"));
      const text = "Grazie per la vostra presenza Giulia e Marco";
      const a = await run(text, long);
      expect(a.fill).toBeCloseTo(0.97, 1);
      const b = await run(text, { ...long, fill: 0.6 }, userProfile({ sizing: { fillLocked: false } }));
      expect(b.fill).toBeCloseTo(0.6, 1);
    });

    it("kontur: widthEm × ana punto, px sınırlarıyla; etiket başına tek değer", async () => {
      const intent = I(L("Anna"));
      const raw = await run("Anna", intent, userProfile({ weight: { minPx: 0, maxPx: 0 } }));
      expect(raw.strokePx).toBeCloseTo(0.02 * raw.basePx, 1);
      const capped = await run("Anna", intent, userProfile({ weight: { maxPx: 1 } }));
      expect(capped.strokePx).toBe(1);
      const floored = await run("Anna", intent, userProfile({ weight: { widthEm: 0.001, minPx: 0.8 } }));
      expect(floored.strokePx).toBe(0.8);
      const none = await run("Anna", intent, userProfile({ weight: { mode: "none" } }));
      expect(none.strokePx).toBe(0);
    });

    it("gerçek kalınlık: ağır stil varsa o, yoksa kontura düşer", async () => {
      const real = userProfile({ weight: { mode: "real" } });
      const a = await run("Anna", I(L("Anna", "primary", { fontId: PF })), real);
      expect(a.strokePx).toBe(0);
      expect(a.lines[0]!.runs[0]!.style).toBe("Bold");
      const b = await run("Anna", I(L("Anna")), real);
      expect(b.strokePx).toBeGreaterThan(0);
      expect(b.notes.join(" ")).toMatch(/konturla/);
    });

    it("koyu zeminde otomatik kontrast rengi", async () => {
      const dark = makeTestGeometry({ dark: true });
      expect((await run("Anna", I(L("Anna")), profile, dark)).color).toBe(profile.color.onDark);
      expect((await run("Anna", I(L("Anna")))).color).toBe(profile.color.text);
    });
  });

  describe("sığdırma ve doğrulama", () => {
    const texts: Array<[string, DesignIntent]> = [
      ["Anna", I(L("Anna"))],
      ["Sofia Nunzia Arcidiacono", I(L("Sofia Nunzia"), L("Arcidiacono"))],
      ["Grazie per aver condiviso con noi questo giorno speciale Giulia e Marco 12.10.2026", I(
        L("Grazie per aver condiviso", "tertiary", { role: "message" }),
        L("con noi questo giorno speciale", "tertiary", { role: "message" }),
        L("Giulia"),
        L("e", "connector"),
        L("Marco"),
        L("12.10.2026", "tertiary", { role: "date" }),
      )],
    ];

    it("mürekkep her zaman serbest alanın içinde (farklı kesim ve alanlarda)", async () => {
      const geos = [
        g,
        makeTestGeometry({ area: { kind: "ellipse", cx: 300, cy: 260, rx: 90, ry: 70 } }),
        makeTestGeometry({ cut: { kind: "rect", x: 20, y: 60, w: 400, h: 320, radius: 20 }, area: { kind: "rect", x: 40, y: 80, w: 360, h: 280, radius: 0 } }),
        makeTestGeometry({ ribbonTop: 0.3 }),
      ];
      for (const geo of geos)
        for (const [text, intent] of texts) {
          const r = await run(text, intent, profile, geo);
          expect(r.ok, `${text}: ${r.issues.map((i) => i.message).join(" ")}`).toBe(true);
          const s = await inkStats(r, geo, fonts);
          expect(s.outsideCut).toBe(0);
          expect(s.outsideFree).toBe(0);
          // Eski sistemin satır kutusu modeli de alanın içinde kalır ve en fazla birkaç yüzde küçüktür.
          const line = await layout({ text, intent, profile, geometry: geo, fonts, fit: "line" });
          expect((await inkStats(line, geo, fonts)).outsideFree).toBe(0);
          expect(line.basePx).toBeLessThanOrEqual(r.basePx + 0.01);
        }
    });

    it("hedef merkez: yer varsa bloğun mürekkep merkezi hedefte; kenardaki elle alanda alanın merkezinde", async () => {
      const r = await run("Anna", I(L("Anna")));
      expect(Math.abs(cx(r.ink) - g.target.x)).toBeLessThan(1);
      expect(Math.abs(r.ink.y + r.ink.h / 2 - g.target.y)).toBeLessThan(1);
      // Doluluk düşük: bu test sığdırmayı değil hedef merkezi ölçer.
      const side = makeTestGeometry({ area: { kind: "ellipse", cx: 300, cy: 250, rx: 80, ry: 60 } });
      const s = await run("Anna 2026", I(L("Anna"), L("2026", "tertiary")), userProfile({ sizing: { fill: 0.8 } }), side);
      expect(Math.abs(cx(s.ink) - 300)).toBeLessThan(4);
      expect(Math.abs(s.ink.y + s.ink.h / 2 - 250)).toBeLessThan(4);
    });

    it("dekorla çarpışmaz; dekor ortadaysa yazı etrafından dolaşır", async () => {
      const deco = makeTestGeometry({ decorations: [{ kind: "circle", cx: 220, cy: 220, r: 45 }], area: { kind: "circle", cx: 220, cy: 220, r: 200 } });
      const r = await run("Anna & Marco", I(L("Anna & Marco")), profile, deco);
      expect(r.ok).toBe(true);
      const s = await inkStats(r, deco, fonts);
      expect(s.decoration).toBeLessThanOrEqual(Math.max(2 * 4, 0.0015 * s.ink));
      expect(s.outsideCut).toBe(0);
    });

    it("sığmayan metin açık hatayla döner", async () => {
      const tiny = makeTestGeometry({ area: { kind: "circle", cx: 220, cy: 220, r: 6 } });
      const r = await run("Anna", I(L("Anna")), profile, tiny);
      expect(r.ok).toBe(false);
      expect(["no-layout", "text-too-small"]).toContain(r.issues.at(-1)!.code);
      const empty = makeTestGeometry({ area: { kind: "circle", cx: 1000, cy: 1000, r: 5 } });
      const e = await run("Anna", I(L("Anna")), profile, empty);
      expect(e.issues.at(-1)!.code).toBe("no-layout");
    });

    it("en küçük punto altında kalan satır için önce oranlar yumuşatılır", async () => {
      // Uzun isim genişliği sınırlar; küçük satır 0,64 oranında en küçük puntonun altında kalır, 0,73'te kalmaz.
      const text = "Alessandra Benedetta 2026";
      const intent = I(L("Alessandra Benedetta"), L("2026", "tertiary", { role: "date" }));
      const first = await run(text, intent);
      const kMax = first.basePx / first.fill;
      const minPt = (0.68 * kMax) / ptToPx(profile, 1);
      const p = userProfile({ sizing: { minPt } });
      const r = await run(text, intent, p);
      expect(r.ok).toBe(true);
      expect(r.notes.join(" ")).toMatch(/yumuşatıldı/);
      expect(Math.min(...r.lines.map((l) => l.sizePx))).toBeGreaterThanOrEqual(ptToPx(p, minPt) - 0.01);
    });

    it("okunurluk sınırının altındaki satır uyarılır", async () => {
      const r = await run("Anna 12.10.2026", I(L("Anna"), L("12.10.2026", "tertiary")), userProfile({ quality: { readableMinPt: 30 } }));
      expect(r.ok).toBe(true);
      expect(r.issues.map((i) => i.code)).toContain("text-too-small");
    });

    it("puan bileşenleri açıklanabilir", async () => {
      const r = await run("Anna", I(L("Anna")));
      expect(Object.keys(r.score.parts).sort()).toEqual(["balance", "breathing", "fill", "legibility"]);
      expect(r.score.total).toBeGreaterThan(80);
    });
  });

  describe("süre", () => {
    it("tipik etiket < 300 ms, uzun metin < 1,5 sn", async () => {
      await run("Anna & Marco", I(L("Anna"), L("&", "connector"), L("Marco"))); // ısınma
      const typical = await run("Thank you Anna & Marco 12.10.2026", I(L("Thank you", "secondary"), L("Anna & Marco"), L("12.10.2026", "tertiary")));
      expect(typical.ms).toBeLessThan(300);
      const longText =
        "Grazie di cuore per aver condiviso con noi la gioia di questo giorno indimenticabile con tutto il nostro amore Giulia e Marco 12.10.2026";
      const t0 = performance.now();
      const r = await run(longText, I(
        L("Grazie di cuore per aver", "tertiary", { role: "message" }),
        L("condiviso con noi la gioia", "tertiary", { role: "message" }),
        L("di questo giorno indimenticabile", "tertiary", { role: "message" }),
        L("con tutto il nostro amore", "tertiary", { role: "message" }),
        L("Giulia e Marco"),
        L("12.10.2026", "tertiary", { role: "date" }),
      ));
      const wall = performance.now() - t0;
      expect(r.ok).toBe(true);
      expect(wall).toBeLessThan(1500);
      console.log(`süre: tipik ${typical.ms} ms · uzun ${Math.round(wall)} ms`);
    });
  });

  describe("çıktı", () => {
    it("önizleme ve saydam yazı PNG'si ölçekli üretilir", async () => {
      const r = await run("Anna", I(L("Anna")));
      const prev = await sharp(await renderPreview(r, g, fonts, { scale: 2, showCut: true })).metadata();
      expect([prev.width, prev.height]).toEqual([880, 880]);
      const only = await sharp(await renderTextOnly(r, fonts, { scale: 1, framePx: 440 })).metadata();
      expect([only.width, only.hasAlpha]).toEqual([440, true]);
    });
  });
});

describe("kural denetimi (checkIntentRules)", () => {
  const p = userProfile();
  const codes = (text: string, ...lines: IntentLine[]) => checkIntentRules(I(...lines), text, p).map((i) => i.code);

  it("satır uzunluğu, satır sayısı, tek başına kelime", () => {
    expect(codes("Grazie per aver condiviso con noi questo giorno", L("Grazie per aver condiviso con noi questo giorno", "tertiary"))).toContain("rule-line-too-long");
    expect(codes("a b c d e f g", ...["a", "b", "c", "d", "e", "f", "g"].map((t) => L(t, "secondary", { role: "other" })))).toContain("rule-too-many-lines");
    expect(codes("La Cresima di Alessandro", L("La Cresima", "secondary", { role: "title" }), L("di", "tertiary", { role: "other" }), L("Alessandro"))).toContain("rule-lone-word");
  });

  it("isim kendi satırında ve en büyük", () => {
    expect(codes("Battesimo Arthur", L("Battesimo", "primary", { role: "title" }), L("Arthur", "secondary", { role: "name" }))).toContain("rule-name-not-own-line");
    expect(codes("Laurea Giulia per te", L("Laurea", "secondary", { role: "title" }), L("Giulia per te", "primary", { role: "name" }))).toContain("rule-name-not-own-line");
    expect(codes("Laurea Giulia", L("Laurea", "secondary", { role: "title" }), L("Giulia"))).not.toContain("rule-name-not-own-line");
  });

  it("kısa selam bölünmez; baş harf tek satır; tarih kendi satırında; metin korunur", () => {
    expect(codes("Thank You", L("Thank", "secondary", { role: "greeting" }), L("You", "secondary", { role: "greeting" }))).toContain("rule-split-greeting");
    expect(codes("A & M", L("A"), L("&", "connector"), L("M"))).toContain("rule-initials-split");
    expect(codes("Roma 12.10.2026", L("Roma 12.10.2026", "tertiary", { role: "date" }))).toContain("rule-date-own-line");
    expect(codes("Anna", L("Ana"))).toContain("text-changed");
    expect(codes("Anna & Marco", L("Anna & Marco"))).toEqual([]);
  });

  it("müşterinin kesin satır bölmesi", () => {
    const strict = userProfile({ lineBreaking: { customerBreaks: "strict" } });
    const c = (lines: IntentLine[]) => checkIntentRules(I(...lines), "Thank you  Anna & Marco", strict).map((i) => i.code);
    expect(c([L("Thank you", "secondary"), L("Anna & Marco")])).not.toContain("rule-customer-break");
    expect(c([L("Thank you", "secondary"), L("Anna"), L("&", "connector"), L("Marco")])).not.toContain("rule-customer-break");
    expect(c([L("Thank", "secondary"), L("you Anna & Marco")])).toContain("rule-customer-break");
  });
});

describe("şablon katmanı (önizleme)", () => {
  it("görsel kutusu tasarım alanından taşarsa kırpılır; önizleme hata vermez", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { templateLayer } = await import("./index.ts");
    const dir = mkdtempSync(path.join(tmpdir(), "motor-katman-"));
    try {
      const file = path.join(dir, "t.png");
      await sharp({ create: { width: 874, height: 840, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } } }).png().toFile(file);
      // Şablona özel kutu: 7 px sola taşan, 437 genişlikte (eski sistemin imageBox örneği).
      const layer = (await templateLayer(file, { x: -7, y: 10, w: 437, h: 420 }, 1.5, 660))!;
      expect([layer.left, layer.top]).toEqual([0, 15]);
      const meta = await sharp(layer.input as Buffer).metadata();
      expect(meta.width! + layer.left!).toBeLessThanOrEqual(660);
      expect(meta.height! + layer.top!).toBeLessThanOrEqual(660);
      const empty = { ok: true, lines: [], basePx: 0, strokePx: 0, color: "#000", ink: { x: 0, y: 0, w: 0, h: 0 }, fill: 0, score: { total: 0, parts: {} }, issues: [], notes: [], ms: 0 } as LayoutResult;
      const g = { ...makeTestGeometry(), imagePath: file, templateBox: { x: -7, y: 10, w: 437, h: 420 } };
      const png = await renderPreview(empty, g, {} as FontRegistry, { scale: 1.5 });
      expect((await sharp(png).metadata()).width).toBe(660);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
