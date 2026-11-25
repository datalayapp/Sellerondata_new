import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Profile, ProfileSchema, type RefLine, type Reference, type Template, TemplateSchema } from "@tagpress/domain";
import type { ReplayMetrics } from "@tagpress/engine";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { aggregate, applyProfileChanges, applyTemplateChanges, diffAll, diffReference, evaluate, type ProposalDraft, propose, robust, kMedians, userPanel } from "./index.ts";
import type { ReplayEnv } from "./env.ts";

// ---------------------------------------------------------------- sentetik veri

const profile: Profile = ProfileSchema.parse({
  name: "Test",
  fonts: {
    list: [
      { id: "Script/Regular", family: "Script", style: "Regular", kind: "script", roles: ["primary", "secondary"] },
      { id: "Serif/Regular", family: "Serif", style: "Regular", kind: "serif", roles: [] },
      { id: "Other/Regular", family: "Other", style: "Regular", kind: "script", roles: ["primary"] },
    ],
  },
  glyphRules: [{ id: "amp", match: { type: "chars", chars: "&" }, fontId: "Serif/Regular", scale: 0.5 }],
  sizing: { fill: 0.9, tiers: { primary: 1, secondary: 0.73, tertiary: 0.64, connector: 0.52 } },
  spacing: { inkGaps: { normal: 0.11, beforeLast: 0.29, connector: 0.09 } },
  connectors: { words: ["&", "and"], shiftEm: 0 },
});

interface L {
  text: string;
  size: number;
  family?: string;
  /** Görünen boşluk (üstteki satırla), küçük satırın puntosu cinsinden. */
  gap?: number;
  dx?: number;
  segments?: RefLine["segments"];
}

/** Satırları yukarıdan aşağı dizer: mürekkep yüksekliği 0,8 × punto, verilen görünen boşluklarla. */
function lines(ls: L[], top = 150, cx = 220): RefLine[] {
  let y = top;
  let prev: L | null = null;
  return ls.map((l) => {
    if (prev) y += (l.gap ?? 0.1) * Math.min(prev.size, l.size);
    const w = l.text.length * l.size * 0.4;
    const h = l.size * 0.8;
    const line: RefLine = {
      text: l.text,
      family: l.family ?? "Script",
      style: "Regular",
      sizePx: l.size,
      segments: l.segments ?? [{ text: l.text, family: l.family ?? "Script", style: "Regular", sizePx: l.size }],
      ink: { x: cx + (l.dx ?? 0) - w / 2, y, w, h },
    };
    y += h;
    prev = l;
    return line;
  });
}

let seq = 0;
function ref(user: RefLine[], program: RefLine[] | null, extra: Partial<Reference> = {}): Reference {
  seq++;
  return {
    id: `r${seq}`,
    languageId: "test",
    source: "figma",
    orderNo: String(seq),
    quantity: 1,
    templateKey: "t1",
    labelFramePx: 440,
    text: user.map((l) => l.text).join(" "),
    user,
    program,
    programMeta: null,
    image: null,
    split: "train",
    createdAt: "2026-10-09T00:00:00Z",
    ...extra,
  };
}

const tpl = (key: string, extra: Record<string, unknown> = {}): Template =>
  TemplateSchema.parse({ key, languageId: "test", file: `${key}.png`, width: 840, height: 840, ...extra });

/** Şablonun kendi kesimi: 63,5 × 38,1 mm dikdörtgen. */
const RECT = { shape: "rect", wMm: 63.5, hMm: 38.1 } as const;

// ---------------------------------------------------------------- testler

describe("diffReference", () => {
  it("satır sonu ayırıcıları ve büyük/küçük harf farkı bölme farkı sayılmaz; ölçek, merkez ve font değişimi", () => {
    const program = lines([{ text: "Happy Navarathri -", size: 40 }, { text: "hema&suresh", size: 50, family: "Other" }], 160);
    // Program metni küçük harfle (sentetik): bölme aynı sayılır ama "yalnızca ayırıcı" değildir.
    const user = lines([{ text: "Happy Navarathri", size: 48 }, { text: "Hema&Suresh", size: 60 }], 150, 224);
    const d = diffReference(ref(user, program, { text: "Happy Navarathri - Hema&Suresh" }), { profile });
    expect(d.sameBreaks).toBe(true);
    expect(d.separatorsOnly).toBe(false); // harf farkı da var
    expect(d.textEdited).toBe(false); // müşteri metninden yalnızca ayırıcıyla ayrılıyor
    expect(d.scale).toBeCloseTo(60 / 50, 5);
    expect(d.center!.dx).toBeCloseTo(4, 0);
    expect(d.fontChange).toEqual({ from: "Other/Regular", to: "Script/Regular" });
  });

  it("farklı bölme: iki taraf da raporlanır", () => {
    const d = diffReference(ref(lines([{ text: "Grazie", size: 50 }, { text: "per la tua presenza", size: 30 }]), lines([{ text: "Grazie per la", size: 40 }, { text: "tua presenza", size: 40 }])), { profile });
    expect(d.sameBreaks).toBe(false);
    expect(d.breaks).toEqual({ user: ["Grazie", "per la tua presenza"], program: ["Grazie per la", "tua presenza"] });
  });

  it("tek başına '&' satırı: asıl punto boşluk segmentlerini saymaz; bağlaç boşluğu türü ve kayma", () => {
    const amp: RefLine["segments"] = [
      { text: "   ", family: "Serif", style: "Regular", sizePx: 28 },
      { text: "&", family: "Serif", style: "Regular", sizePx: 26 },
    ];
    const user = lines([{ text: "Anna", size: 50 }, { text: "&", size: 28, family: "Serif", segments: amp, gap: 0.08, dx: 6.5 }, { text: "Marco", size: 50, gap: 0.1 }]);
    const d = diffReference(ref(user, null), { profile });
    const conn = d.user.lines[1]!;
    expect(conn.connector).toBe(true);
    expect(conn.sizePx).toBe(26);
    expect(conn.ratio).toBeCloseTo(26 / 50, 5);
    expect(d.user.gaps.map((g) => g.kind)).toEqual(["connector", "connector"]);
    expect(d.user.connectorShiftEm).toBeCloseTo(6.5 / 50, 3);
    expect(d.program).toBeNull();
    expect(d.sameBreaks).toBeNull();
  });

  it("satır içi glif kuralı segmenti ('&' serif) satırın puntosunu düşürmez, oranı ayrıca ölçülür", () => {
    const segs: RefLine["segments"] = [
      { text: "Mina ", family: "Script", style: "Regular", sizePx: 50 },
      { text: "&", family: "Serif", style: "Regular", sizePx: 25 },
      { text: " Ali", family: "Script", style: "Regular", sizePx: 50 },
    ];
    const d = diffReference(ref(lines([{ text: "Mina & Ali", size: 50, segments: segs }]), null), { profile });
    expect(d.user.lines[0]!.sizePx).toBe(50);
    expect(d.user.lines[0]!.glyphs).toEqual([{ text: "&", family: "Serif", ratio: 0.5 }]);
  });

  it("çok satırlı tek katmandan bölünmüş satırlar 'yaklaşık' işaretlenir, boşlukları ölçüm sayılmaz", () => {
    // Okuyucunun yaptığı gibi: aynı x/genişlik, aralarında tam 0 boşluk.
    const box = { x: 150, w: 140 };
    const mk = (text: string, y: number, h: number, size: number): RefLine => ({
      text,
      family: "Script",
      style: "Regular",
      sizePx: size,
      segments: [{ text, family: "Script", style: "Regular", sizePx: size }],
      ink: { ...box, y, h },
    });
    const user = [mk("Kimberly", 120, 52, 49), mk("&", 172, 30, 24.5), mk("Matthew", 202, 40, 49)];
    const d = diffReference(ref(user, null), { profile });
    expect(d.approxLines).toBe(3);
    expect(d.user.gaps.every((g) => g.approx && g.value === 0)).toBe(true);
    expect(d.user.connectorShiftEm).toBeNull();
  });

  it("kurdele bandı ihlali şablonla ölçülür", () => {
    const t = tpl("t1", { ribbonTop: 0.3 });
    const d = diffReference(ref(lines([{ text: "Anna", size: 60 }], 100), null), { profile, template: t });
    expect(d.ribbon!.violation).toBe(true);
    expect(d.ribbon!.ribbonY).toBeCloseTo(1 + 0.3 * 2 * 218.82, 1);
  });

  it("kurdele bandı şablonun kendi kesiminden: dikdörtgen kesimde üst kenar ve çap kesimden gelir", () => {
    // 63,5 × 38,1 mm dikdörtgen, varsayılan profil (1 px kenar payı): x 1, y 88,6, 438 × 262,8 px; çap = kısa kenar.
    const t = tpl("t1", { ribbonTop: 0.3, cut: RECT });
    const d = diffReference(ref(lines([{ text: "Anna", size: 60 }], 100), null), { profile, template: t });
    expect(d.ribbon!.violation).toBe(true);
    expect(d.ribbon!.ribbonY).toBeCloseTo(88.6 + 0.3 * 262.8, 3);
    // Kesimsiz şablonda eskisi gibi profilin kesimi.
    const old = diffReference(ref(lines([{ text: "Anna", size: 60 }], 100), null), { profile, template: tpl("t1", { ribbonTop: 0.3 }) });
    expect(old.ribbon!.ribbonY).toBeCloseTo(1 + 0.3 * 2 * 218.82, 6);
  });

  it("farklı boyuttaki frame istatistik dışı", () => {
    expect(diffReference(ref(lines([{ text: "A", size: 50 }]), null, { labelFramePx: 590 }), { profile }).usable).toBe(false);
  });
});

describe("istatistik", () => {
  it("medyan/IQR ve k-medyan", () => {
    const r = robust([1, 2, 3, 4, 100])!;
    expect(r.median).toBe(3);
    expect(r.iqr).toBe(2);
    const k = kMedians([0.5, 0.52, 0.55, 0.7, 0.72, 0.75], [0.73, 0.64]);
    expect(k.centers[0]).toBeCloseTo(0.72, 2);
    expect(k.centers[1]).toBeCloseTo(0.52, 2);
  });
});

/** n etiket: isim + tarih; satır arası boşluk `gap`, tarih oranı `ratio`. */
function corpus(n: number, opts: { gap: number; ratio: number; template?: string; top?: number; split?: Reference["split"] }): Reference[] {
  return Array.from({ length: n }, (_, i) =>
    ref(
      lines(
        [
          { text: `Grazie`, size: 40 },
          { text: `Giulia${i}`, size: 60, gap: opts.gap },
          { text: `per la tua presenza ${i}`, size: 60 * opts.ratio, gap: opts.gap },
        ],
        opts.top ?? 150,
      ),
      null,
      { templateKey: opts.template ?? "t1", split: opts.split ?? "train" },
    ),
  );
}

describe("aggregate ve propose", () => {
  it("eşik altı istatistik öneriye dönüşmez; eşikte boşluk ve oran önerisi çıkar", () => {
    const few = corpus(6, { gap: 0.2, ratio: 0.5 });
    expect(propose(profile, [tpl("t1")], few).filter((p) => p.slug.startsWith("spacing"))).toEqual([]);
    const many = corpus(16, { gap: 0.2, ratio: 0.5 });
    const ps = propose(profile, [tpl("t1")], many);
    const gap = ps.find((p) => p.slug === "spacing.inkGaps.normal");
    expect(gap?.changes[0]).toMatchObject({ target: "profile", path: "spacing.inkGaps.normal", from: 0.11, to: 0.2 });
    // 0,5 oranlı satırlar beforeLast boşluğu (son küçük satır) — 16 örnek → öneri.
    expect(ps.find((p) => p.slug === "spacing.inkGaps.beforeLast")?.changes[0]?.to).toBe(0.2);
    // "Grazie" (40/60 = 0,67) ikincil, son satır (0,5) üçüncül kümede.
    expect(ps.find((p) => p.slug === "sizing.tiers.tertiary")?.changes[0]?.to).toBe(0.5);
    expect(ps.find((p) => p.slug === "sizing.tiers.secondary")?.changes[0]?.to).toBe(0.67);
  });

  it("test kümesi öneriye katılmaz", () => {
    const refs = corpus(16, { gap: 0.2, ratio: 0.5, split: "test" });
    expect(propose(profile, [tpl("t1")], refs)).toEqual([]);
  });

  it("şablon: hedef merkez (≥2), kurdele (≥3) ve alan (≥3) önerileri; ayarlanabilir eşik", () => {
    const t = tpl("t2", { ribbonTop: 0.3, area: { mode: "manual", shape: { kind: "rect", x: 0.3, y: 0.35, w: 0.4, h: 0.3, radius: 0 } } });
    const refs = corpus(3, { gap: 0.11, ratio: 0.64, template: "t2", top: 110 });
    const ps = propose(profile, [t], refs);
    const center = ps.find((p) => p.slug === "template:t2:textCenter");
    expect(center?.changes[0]).toMatchObject({ target: "template", key: "t2", field: "textCenter", from: null });
    const ribbon = ps.find((p) => p.slug === "template:t2:ribbonTop");
    expect(ribbon?.changes[0]?.to).toBeLessThan(0.3);
    const area = ps.find((p) => p.slug === "template:t2:area");
    expect(area).toBeTruthy();
    // Eşik 4 olunca kurdele/alan önerisi yok, merkez (eşik 2) var.
    const strict = propose(profile, [t], refs, { minTemplate: 4 });
    expect(strict.map((p) => p.slug).sort()).toEqual(["template:t2:textCenter"]);
  });

  it("kurdele önerisi şablonun kendi kesimiyle: dikdörtgen kesimde üst kenar ve çap kesimden", () => {
    // Bant 88,6 + 0,3 × 262,8 = 167,44 px; yazı 150 px'te başlıyor → ihlal. Öneri (150 − 4 − 88,6) / 262,8.
    const t = tpl("t3", { ribbonTop: 0.3, cut: RECT });
    const refs = corpus(3, { gap: 0.11, ratio: 0.64, template: "t3", top: 150 });
    const ribbon = propose(profile, [t], refs).find((p) => p.slug === "template:t3:ribbonTop");
    expect(ribbon?.changes[0]?.to).toBe(Math.round(((150 - 4 - 88.6) / 262.8) * 1000) / 1000);
  });

  it("yaklaşık boşluklar toplamaya girmez (bağlaç boşluğu 0,00 bulgusu)", () => {
    const box = { x: 150, w: 140 };
    const mk = (text: string, y: number, h: number, size: number): RefLine => ({ text, family: "Script", style: "Regular", sizePx: size, segments: [{ text, family: "Script", style: "Regular", sizePx: size }], ink: { ...box, y, h } });
    const synthetic = Array.from({ length: 10 }, () => ref([mk("Kim", 120, 52, 49), mk("&", 172, 30, 24.5), mk("Matt", 202, 40, 49)], null));
    const real = Array.from({ length: 6 }, () => ref(lines([{ text: "Anna", size: 50 }, { text: "&", size: 26, gap: 0.09 }, { text: "Marco", size: 50, gap: 0.09 }]), null));
    const agg = aggregate(diffAll([...synthetic, ...real], profile), { profile });
    expect(agg.gapsWithApprox.connector!.median).toBe(0);
    expect(agg.gaps.connector!.median).toBeCloseTo(0.09, 3);
    expect(agg.gapsApprox.connector).toBe(20);
  });

  it("örnek bölme önerisi yalnızca müşteri metnini birebir koruyan bölmelerden", () => {
    const mk = (u: string[], p: string[], text: string) => ref(lines(u.map((t) => ({ text: t, size: 50 }))), lines(p.map((t) => ({ text: t, size: 50 }))), { text });
    const refs = [
      mk(["Grazie", "per la tua presenza"], ["Grazie per la", "tua presenza"], "Grazie per la tua presenza"),
      mk(["Thank you", "for coming"], ["Thank", "you for coming"], "Thank you for coming"),
      mk(["Laurea", "Giulia"], ["Laurea Giulia"], "Laurea Giulia"),
      // Kullanıcı "-" ayırıcısını silmiş: örnek olamaz (metin değişmez).
      mk(["Happy Navarathri", "Hema"], ["Happy Navarathri - Hema"], "Happy Navarathri - Hema"),
    ];
    const ex = propose(profile, [tpl("t1")], refs).find((p) => p.slug === "lineBreaking.examples")!;
    expect(ex.kind).toBe("ai");
    const added = (ex.changes[0]!.to as Array<{ text: string }>).map((e) => e.text);
    expect(added.sort()).toEqual(["Grazie per la tua presenza", "Laurea Giulia", "Thank you for coming"]);
  });
});

describe("yama", () => {
  it("profil ve şablon değişiklikleri kopya üzerinde uygulanır, geçersiz yama reddedilir", () => {
    const p2 = applyProfileChanges(profile, [{ target: "profile", path: "sizing.fill", from: 0.9, to: 0.95 }]);
    expect(p2.sizing.fill).toBe(0.95);
    expect(profile.sizing.fill).toBe(0.9);
    expect(() => applyProfileChanges(profile, [{ target: "profile", path: "sizing.fill", from: 0.9, to: 5 }])).toThrow();
    const m = applyTemplateChanges(new Map([["t1", tpl("t1")]]), [{ target: "template", key: "t1", field: "textCenter", path: "template:t1.textCenter", from: null, to: { x: 0.5, y: 0.45 } }]);
    expect(m.get("t1")!.textCenter).toEqual({ x: 0.5, y: 0.45 });
  });
});

describe("evaluate (sahte tekrar ortamı)", () => {
  /** Boyut oranı = 1 + (fill − 0,95) × 2: doluluk 0,95'e yaklaştıkça kullanıcıya uyar. */
  const fakeEnv = {
    async replayAll(refs: Reference[], p: Profile) {
      return new Map(
        refs.map((r) => {
          const s = 1 + (p.sizing.fill - 0.95) * 2 + (Number(r.orderNo) % 3) * 0.01;
          const m: ReplayMetrics = { id: r.id, templateKey: r.templateKey, ok: true, lines: 2, sizeRatio: s, within10: Math.abs(s - 1) <= 0.1, dx: 0, dy: 0, heightRatio: s, gaps: [], ms: 1 };
          return [r.id, m];
        }),
      );
    },
  } as unknown as ReplayEnv;
  const heldOut = corpus(10, { gap: 0.11, ratio: 0.64, split: "test" });
  const draft = (to: number): ProposalDraft => ({
    slug: "sizing.fill",
    kind: "motor",
    scope: { kind: "profile" },
    title: "",
    summary: "",
    changes: [{ target: "profile", path: "sizing.fill", from: 0.85, to }],
    primary: "size",
    count: 20,
    stats: {},
    examples: [],
  });
  const base = { ...profile, sizing: { ...profile.sizing, fill: 0.85 } } as Profile;

  it("iyileştiren öneri güçlü, kötüleştiren düşer, az örnek zayıf", async () => {
    const baseline = await fakeEnv.replayAll(heldOut, base, new Map());
    const ctx = { env: fakeEnv, profile: base, templates: new Map(), heldOut, baseline, approx: new Map() };
    const good = await evaluate(draft(0.95), ctx);
    expect(good.verdict).toBe("better");
    expect(good.weak).toBe(false);
    expect(good.after!.within10).toBeGreaterThan(good.before!.within10);
    const bad = await evaluate(draft(0.6), ctx);
    expect(bad.verdict).toBe("worse");
    expect(bad.drop).toBe(true);
    const small = await evaluate(draft(0.95), { ...ctx, heldOut: heldOut.slice(0, 3) });
    expect(small.weak).toBe(true);
    expect(small.reason).toMatch(/yalnızca 3/);
  });

  it("AI önerisi ölçülmez, zayıf işaretlenir ama düşmez", async () => {
    const ev = await evaluate({ ...draft(0.9), kind: "ai", primary: "none" }, { env: fakeEnv, profile, templates: new Map(), heldOut, baseline: new Map(), approx: new Map() });
    expect(ev).toMatchObject({ verdict: "unmeasured", weak: true, drop: false });
  });
});

describe("userPanel: şablon görselinin yeri", () => {
  /** Kırmızı şablon + saydam yazı katmanı; panelde (110, 20) noktasının rengi. */
  async function pixelAt(template: Template, x: number, y: number): Promise<number[]> {
    const dir = await mkdtemp(join(tmpdir(), "learn-panel-"));
    try {
      const tp = join(dir, "t.png");
      const lp = join(dir, "l.png");
      await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toFile(tp);
      await sharp({ create: { width: 440, height: 440, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(lp);
      const env = { opts: { templatePath: () => tp, referenceImagePath: () => lp } } as unknown as ReplayEnv;
      const png = await userPanel(ref(lines([{ text: "Anna", size: 60 }]), null), profile, template, env, 0.5);
      const { data, info } = await sharp(png!).raw().toBuffer({ resolveWithObject: true });
      const i = (y * info.width + x) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("kesimsiz şablon profilin şablon kutusunda; dikdörtgen kesimli şablon kesimin kutusunda (üstü boş)", async () => {
    // Profil kutusu 10,10,420 → panelde 5..215; dikdörtgen kesim y 88,6..351,4 → panelde 44..176.
    expect(await pixelAt(tpl("t1"), 110, 20)).toEqual([255, 0, 0]);
    expect(await pixelAt(tpl("t1", { cut: RECT }), 110, 20)).toEqual([255, 255, 255]);
    expect(await pixelAt(tpl("t1", { cut: RECT }), 110, 110)).toEqual([255, 0, 0]);
  });
});
