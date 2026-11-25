import { type Box, type DesignIntent, ProfileSchema, type Template, TemplateSchema } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  type AdjustObservation,
  type AdjustPlacer,
  adjustFindings,
  analyzeAdjust,
  desiredCenter,
  evaluateAdjust,
  proposeFromAdjust,
  runLearning,
  trimmedMean,
} from "./index.ts";
import type { ReplayEnv } from "./env.ts";

// ---------------------------------------------------------------- sentetik düzeltmeler

const F = 440;
const tpl = (key: string, textCenter: { x: number; y: number } | null = null): Template =>
  TemplateSchema.parse({ key, languageId: "l", file: `${key}.png`, width: 100, height: 100, textCenter });
const tmap = (...ts: Template[]) => new Map(ts.map((t) => [t.key, t]));

/** Motorun bloğu: hedef merkeze göre (rx, ry) artık kaymayla, 200×60. */
const engineInk = (target: { x: number; y: number }, rx = 0, ry = -10, w = 200, h = 60): Box => ({ x: target.x + rx - w / 2, y: target.y + ry - h / 2, w, h });

let seq = 0;
/** Kullanıcı motorun bloğunu (dx, dy) kaydırmış; hedef kayıt anındaki hedef (tasarım px). */
function obs(job: string, dx: number, dy: number, o: { key?: string; target?: { x: number; y: number }; framePx?: number; scale?: number; intent?: boolean } = {}): AdjustObservation {
  const framePx = o.framePx ?? F;
  const k = framePx / F;
  const target = o.target ?? { x: 220 * k, y: 220 * k };
  const before = engineInk(target, 0, -10 * k, 200 * k, 60 * k);
  const s = o.scale ?? 1;
  const after: Box = { x: before.x + dx + (before.w * (1 - s)) / 2, y: before.y + dy + (before.h * (1 - s)) / 2, w: before.w * s, h: before.h * s };
  seq++;
  return {
    id: `v${seq}`,
    jobId: job,
    templateKey: o.key ?? "a1",
    framePx,
    target,
    inkBefore: before,
    inkAfter: after,
    scale: s,
    createdAt: `2026-10-09T10:00:${String(seq % 60).padStart(2, "0")}Z`,
    replay: o.intent === false ? null : { text: "Anna", intent: { lines: [] } as unknown as DesignIntent },
    previewUrl: `/api/variants/v${seq}/preview.png?v=1.1`,
  };
}

/** Sahte motor: blok hedefin (textCenter, yoksa alan ortası 220,220) etrafında, (0, −10) artık kaymayla. */
const followPlacer: AdjustPlacer = async (o, t) => {
  if (!o.replay) return null;
  const c = t.textCenter ? { x: t.textCenter.x * F, y: t.textCenter.y * F } : { x: 220, y: 220 };
  return engineInk(c);
};

describe("elle düzeltmelerden öğrenme: istatistik", () => {
  it("istenen merkez = kayıttaki hedef + kullanıcının kaydırdığı kadar (oran); farklı alan boyutu aynı oranı verir", () => {
    const a = desiredCenter(obs("j1", 12, 8));
    expect(a.x).toBeCloseTo(232 / 440, 6);
    expect(a.y).toBeCloseTo(228 / 440, 6);
    // 880 px alanda iki kat kayma: aynı oran.
    const b = desiredCenter(obs("j1", 24, 16, { framePx: 880 }));
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    // Merkez sonradan değişmiş olsa da örnek mutlak istenen noktayı verir.
    const c = desiredCenter(obs("j1", 2, 0, { target: { x: 230, y: 228 } }));
    expect(c.x).toBeCloseTo(232 / 440, 6);
    expect(c.y).toBeCloseTo(228 / 440, 6);
  });

  it("sistematik kayma → hedef merkez önerisi (iş başına ortanca; tek işin aşırı düzeltmesi sürüklemez)", () => {
    const list = [
      obs("j1", 12, 8),
      obs("j1", 14, 9),
      obs("j2", 11, 7),
      obs("j3", 13, 8),
      obs("j4", 12, 9),
      // Aşırı düzeltme: tek iş, üç varyasyon.
      obs("j5", -120, -90),
      obs("j5", -120, -90),
      obs("j5", -120, -90),
    ];
    const [s] = analyzeAdjust(list, tmap(tpl("a1")), { framePx: F, current: new Map([["a1", { x: 0.5, y: 0.5 }]]) });
    expect(s).toMatchObject({ key: "a1", samples: 8, jobs: 5, enough: true, currentSource: "geometry" });
    expect(s!.x.systematic).toBe(true);
    expect(s!.y.systematic).toBe(true);
    expect(s!.x.agreement).toBeCloseTo(0.8, 6);
    // İşlerin ortancası: j1 13 px, j2 11, j3 13, j4 12, j5 −120 → 12 px.
    expect(s!.x.shift.median * F).toBeCloseTo(12, 6);
    expect(s!.y.shift.median * F).toBeCloseTo(8, 6);
    expect(s!.to).toEqual({ x: Number((232 / 440).toFixed(3)), y: Number((228 / 440).toFixed(3)) });

    const drafts = proposeFromAdjust([s!], tmap(tpl("a1")), F);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d).toMatchObject({ slug: "template:a1:textCenter:adjust", kind: "motor", scope: { kind: "template", key: "a1" }, primary: "position", count: 8 });
    expect(d.changes).toEqual([{ target: "template", key: "a1", field: "textCenter", path: "template:a1.textCenter", from: null, to: s!.to }]);
    expect(d.summary).toMatch(/5 işin 8 varyasyonunu/);
    expect(d.summary).toMatch(/12 px sağa ve 8 px aşağı/);
    expect(d.stats).toMatchObject({ source: "adjust", samples: 8, jobs: 5, x: { medianPx: 12, systematic: true, agreement: 0.8 }, y: { medianPx: 8 } });
  });

  it("tek işin çok varyasyonu öneri doğurmaz; yön tutarsızsa öneri yok ve bulgu söyler", () => {
    const oneJob = [obs("j1", 40, 0), obs("j1", 40, 0), obs("j1", 40, 0), obs("j1", 40, 0), obs("j2", 0, 0), obs("j3", 0, 0)];
    const [a] = analyzeAdjust(oneJob, tmap(tpl("a1")), { framePx: F });
    expect(a!.enough).toBe(true);
    expect(a!.x.systematic).toBe(false);
    expect(a!.to).toBeNull();

    const mixed = [obs("j1", 15, 0), obs("j2", -15, 0), obs("j3", 14, 0), obs("j4", -14, 0)];
    const stats = analyzeAdjust(mixed, tmap(tpl("a1")), { framePx: F });
    expect(stats[0]!.to).toBeNull();
    expect(proposeFromAdjust(stats, tmap(tpl("a1")), F)).toEqual([]);
    expect(adjustFindings(stats, mixed).some((f) => /a1: 4 düzeltme \(4 iş\) var ama kayma sistematik değil/.test(f))).toBe(true);
  });

  it("eşikler yapılandırılabilir; bilinmeyen şablon ve bozuk kayıt atılır; küçük kayma öneri değil", () => {
    const list = [obs("j1", 12, 0), obs("j2", 12, 0), obs("j3", 12, 0), obs("j4", 12, 0)];
    expect(analyzeAdjust(list, tmap(tpl("a1")), { framePx: F })[0]!.to).not.toBeNull();
    expect(analyzeAdjust(list, tmap(tpl("a1")), { framePx: F, thresholds: { minAdjustJobs: 5 } })[0]!.to).toBeNull();
    expect(analyzeAdjust(list, tmap(tpl("a1")), { framePx: F, thresholds: { minAdjust: 6 } })[0]!.enough).toBe(false);
    expect(analyzeAdjust(list, tmap(tpl("a1")), { framePx: F, thresholds: { minAdjustShift: 0.05 } })[0]!.to).toBeNull();
    // 2 px: varsayılan eşiğin (0,01 ≈ 4,4 px) altında.
    expect(analyzeAdjust([obs("j1", 2, 0), obs("j2", 2, 0), obs("j3", 2, 0), obs("j4", 2, 0)], tmap(tpl("a1")), { framePx: F })[0]!.to).toBeNull();
    const bad = { ...obs("j9", 5, 5), inkBefore: { x: 0, y: 0, w: 0, h: 0 } };
    const stats = analyzeAdjust([...list, bad, obs("j1", 5, 5, { key: "yok" })], tmap(tpl("a1")), { framePx: F });
    expect(stats.map((s) => [s.key, s.samples])).toEqual([["a1", 4]]);
  });

  it("yalnızca sistematik eksen değişir; şablonda merkez varsa geçerli merkez odur, aynıysa öneri yok", () => {
    // Kayıtlar şablonun (0,5; 0,45) merkeziyle yapıldı: hedef (220, 198) px.
    const at = { target: { x: 220, y: 198 } };
    const list = [obs("j1", 12, 3, at), obs("j2", 12, -3, at), obs("j3", 12, 1, at), obs("j4", 12, -1, at)];
    const t = tpl("a1", { x: 0.5, y: 0.45 });
    const [s] = analyzeAdjust(list, tmap(t), { framePx: F });
    expect(s!.currentSource).toBe("template");
    expect(s!.y.systematic).toBe(false);
    expect(s!.to!.y).toBe(0.45);
    // İstenen x = 232/440; geçerli 0,5.
    expect(s!.to!.x).toBeCloseTo(0.527, 3);
    // Öneri uygulanınca aynı kayıtlar yeni öneri doğurmaz.
    const applied = tpl("a1", s!.to);
    const again = analyzeAdjust(list, tmap(applied), { framePx: F });
    expect(again[0]!.to).toBeNull();
  });

  it("kırpılmış ortalama ve boyut bulgusu (öneri değil)", () => {
    expect(trimmedMean([1, 2, 3, 4, 100])).toBeCloseTo(3, 6);
    const list = [obs("j1", 0, 0, { scale: 0.9 }), obs("j2", 0, 0, { scale: 0.92 }), obs("j3", 0, 0, { scale: 0.88 }), obs("j4", 0, 0, { scale: 1 })];
    const stats = analyzeAdjust(list, tmap(tpl("a1")), { framePx: F });
    expect(stats[0]!.to).toBeNull();
    const f = adjustFindings(stats, list);
    expect(f.some((x) => /×0,91|×0\.91/.test(x) && /Boyut önerisi üretilmedi/.test(x))).toBe(true);
  });
});

describe("elle düzeltmelerden öğrenme: dışarıda tutulan işlerle önce/sonra", () => {
  const list = () => [obs("j1", 12, 8), obs("j2", 11, 9), obs("j3", 13, 7), obs("j4", 12, 8), obs("j5", 12, 8)];

  it("motor hedefi izliyorsa önerilen merkez kullanıcının konumuna yaklaştırır", async () => {
    const t = tpl("a1");
    const [s] = analyzeAdjust(list(), tmap(t), { framePx: F });
    const ev = await evaluateAdjust(s!, t, list(), followPlacer, { framePx: F });
    expect(ev.verdict).toBe("better");
    expect(ev.weak).toBe(false);
    expect(ev.drop).toBe(false);
    expect(ev.folds).toBe(5);
    expect(ev.n).toBe(5);
    expect(ev.before!.positionError).toBeGreaterThan(13);
    expect(ev.after!.positionError).toBeLessThan(2);
    expect(ev.reason).toMatch(/5 varyasyon, 5 katta/);
  });

  it("motor hedefe tepki vermiyorsa: aynı → zayıf, düşmez; ters yönde → kötü → düşer; niyet yoksa ölçülemez", async () => {
    const t = tpl("a1");
    const [s] = analyzeAdjust(list(), tmap(t), { framePx: F });
    const stuck: AdjustPlacer = async () => engineInk({ x: 220, y: 220 });
    const same = await evaluateAdjust(s!, t, list(), stuck, { framePx: F });
    expect(same).toMatchObject({ verdict: "same", weak: true, drop: false });
    const opposite: AdjustPlacer = async (_o, tt) => engineInk({ x: 440 - (tt.textCenter?.x ?? 0.5) * F, y: 440 - (tt.textCenter?.y ?? 0.5) * F });
    const worse = await evaluateAdjust(s!, t, list(), opposite, { framePx: F });
    expect(worse).toMatchObject({ verdict: "worse", drop: true });
    const noIntent = list().map((o) => ({ ...o, replay: null }));
    const un = await evaluateAdjust(s!, t, noIntent, followPlacer, { framePx: F });
    expect(un).toMatchObject({ verdict: "unmeasured", weak: true, drop: false, n: 0 });
  });

  it("öneri boyutu bozarsa kanıt zayıf (yan ölçü)", async () => {
    const t = tpl("a1");
    const [s] = analyzeAdjust(list(), tmap(t), { framePx: F });
    const shrinks: AdjustPlacer = async (_o, tt) => {
      const c = tt.textCenter ? { x: tt.textCenter.x * F, y: tt.textCenter.y * F } : { x: 220, y: 220 };
      return engineInk(c, 0, -10, 200, tt.textCenter ? 45 : 60);
    };
    const ev = await evaluateAdjust(s!, t, list(), shrinks, { framePx: F });
    expect(ev.verdict).toBe("better");
    expect(ev.weak).toBe(true);
    expect(ev.reason).toMatch(/boyut sapması/);
  });
});

describe("öğrenme akışına bağlantı (runLearning)", () => {
  const profile = ProfileSchema.parse({ name: "Test" });
  /** Sahte tekrar ortamı: referans yok; geometri hedefi alan ortası ya da şablon merkezi; motor hedefi izler. */
  const env = {
    replayAll: async () => new Map(),
    geometry: async (t: Template) => ({ target: t.textCenter ? { x: t.textCenter.x * F, y: t.textCenter.y * F } : { x: 220, y: 220 } }),
    layoutIntent: async (_text: string, _intent: DesignIntent, _p: unknown, t: Template) => ({
      ok: true,
      lines: [{}],
      ink: engineInk(t.textCenter ? { x: t.textCenter.x * F, y: t.textCenter.y * F } : { x: 220, y: 220 }),
    }),
  } as unknown as ReplayEnv;

  it("elle düzeltmeler öneri listesine kanıtıyla girer; bitmiş etiket (referans) olmadan da çalışır", async () => {
    const list = [obs("j1", 12, 8), obs("j2", 11, 9), obs("j3", 13, 7), obs("j4", 12, 8), obs("j5", 12, 8), obs("k1", 20, 0, { key: "a2" })];
    const res = await runLearning({
      profile,
      templates: [tpl("a1"), tpl("a2")],
      refs: [],
      env,
      adjust: { observations: list, usage: new Map([["a1", { approved: 20, adjusted: 5 }]]) },
    });
    expect(res.counts).toMatchObject({ refs: 0, adjust: 6, adjustTemplates: 2 });
    expect(res.proposals).toHaveLength(1);
    const p = res.proposals[0]!;
    expect(p.slug).toBe("template:a1:textCenter:adjust");
    expect(p.patch[0]).toMatchObject({ target: "template", key: "a1", field: "textCenter", from: null, to: { x: 0.527, y: 0.518 } });
    expect(p.summary).toMatch(/onaylanan 20 etiketin 5 tanesi elle düzeltilmiş/);
    expect(p.evidence).toMatchObject({ source: "learn-run", origin: "adjust", kind: "motor", count: 5, verdict: "better", weak: false, primary: "position" });
    expect(p.evidence.heldOut).toMatchObject({ n: 5, folds: 5 });
    expect(p.evidence.heldOut!.after.positionError).toBeLessThan(p.evidence.heldOut!.before.positionError!);
    expect(p.evidence.variants![0]).toMatchObject({ jobId: "j1", url: expect.stringMatching(/^\/api\/variants\/v\d+\/preview\.png/) });
    expect(res.findings.some((f) => /elle düzeltilmiş 6 varyasyon \(2 şablon\)/.test(f))).toBe(true);
    // a2: tek iş → yeterli değil, öneri yok.
    expect(res.adjust.find((s) => s.key === "a2")).toMatchObject({ enough: false, to: null });
  });

  it("ters etki eden öneri düşürülür", async () => {
    const bad = {
      ...env,
      layoutIntent: async (_t: string, _i: DesignIntent, _p: unknown, t: Template) => ({
        ok: true,
        lines: [{}],
        ink: engineInk({ x: 440 - (t.textCenter?.x ?? 0.5) * F, y: 440 - (t.textCenter?.y ?? 0.5) * F }),
      }),
    } as unknown as ReplayEnv;
    const list = [obs("j1", 12, 8), obs("j2", 11, 9), obs("j3", 13, 7), obs("j4", 12, 8)];
    const res = await runLearning({ profile, templates: [tpl("a1")], refs: [], env: bad, adjust: { observations: list } });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]).toMatchObject({ slug: "template:a1:textCenter:adjust" });
  });
});
