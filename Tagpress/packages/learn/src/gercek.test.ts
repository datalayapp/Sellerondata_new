import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ProfileSchema, type Reference, ReferenceSchema, type Template, TemplateSchema } from "@tagpress/domain";
import { tagpressEnv } from "@tagpress/domain/env";
import { describe, expect, it } from "vitest";
import { referenceToIntent } from "@tagpress/engine";
import { type AdjustObservation, ReplayEnv, analyzeAdjust, evaluateAdjust, measureStyle, runLearning } from "./index.ts";

/**
 * Ölçüm (duman) testi: eski sistemden aktarılan gerçek veriyle (data/aktarim/benim-tarzim) çalışır. Birim testlerine
 * girmez; `pnpm test:olcum` ile koşar ve veri yoksa açık hatayla düşer (atlanmaz).
 * Süre/bellek için referansların yalnızca en çok kullanılan birkaç şablona ait olanları kullanılır.
 */
const DATA = tagpressEnv("DATA_DIR") ?? path.resolve(import.meta.dirname, "../../../data");
const PKG = path.join(DATA, "aktarim", "benim-tarzim");
const HAS = existsSync(path.join(PKG, "paket.json")) && existsSync(path.join(DATA, "diller", "benim-tarzim", "fontlar"));

if (!HAS) throw new Error(`Ölçüm testi gerçek veri ister: ${PKG} (paket.json, referanslar.json) ve dil fontları bulunamadı. Veri klasörü: TAGPRESS_DATA_DIR ya da data/.`);

describe("gerçek veri (duman)", () => {
  const load = () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG, "paket.json"), "utf8")) as { profile: unknown; templates: unknown[] };
    const profile = ProfileSchema.parse(pkg.profile);
    const templates: Template[] = pkg.templates.map((t) => TemplateSchema.parse(t));
    const refs: Reference[] = (JSON.parse(readFileSync(path.join(PKG, "referanslar.json"), "utf8")) as unknown[]).map((r) => ReferenceSchema.parse(r));
    return { profile, templates, refs };
  };

  it("ölçüm özeti: bağlaç çevresi boşluğu yaklaşık satırlar çıkarılınca eski ölçüme (0,09) döner", () => {
    const { profile, templates, refs } = load();
    const m = measureStyle(refs, profile, templates);
    expect(m.refs.usable).toBeGreaterThan(200);
    expect(m.gaps.withApprox.connector!.median).toBeCloseTo(0, 2);
    expect(m.gaps.approxExcluded.connector).toBeGreaterThan(0);
    expect(m.gaps.connector!.median).toBeGreaterThan(0.05);
    expect(m.gaps.connector!.median).toBeLessThan(0.13);
    expect(m.findings.some((f) => f.startsWith("Bağlaç çevresi"))).toBe(true);
    expect(m.fonts.byLabel[0]!.key).toBe("Great Vibes/Regular");
  });

  it("öğrenme akışı (alt küme): öneriler yama + kanıt biçiminde, ayrılmış kümede kötüleştiren öneri güçlü değil", async () => {
    const { profile, templates, refs } = load();
    const counts = new Map<string, number>();
    for (const r of refs) if (r.templateKey) counts.set(r.templateKey, (counts.get(r.templateKey) ?? 0) + 1);
    const top = new Set([...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k));
    const subset = refs.filter((r) => r.templateKey && top.has(r.templateKey));
    const env = new ReplayEnv({
      fontDir: path.join(DATA, "diller", "benim-tarzim", "fontlar"),
      fallbackDirs: [path.join(DATA, "ortak", "fontlar")],
      templatePath: (t) => path.join(DATA, "diller", "benim-tarzim", "sablonlar", t.file),
      referenceImagePath: (r) => (r.image ? path.join(DATA, r.image) : null),
      cacheLimit: 8,
    });
    const res = await runLearning({ profile, templates, refs: subset, env, thresholds: { minProfile: 10 }, previews: { total: 2 } });
    expect(res.baseline.test?.n).toBeGreaterThan(5);
    for (const p of res.proposals) {
      expect(p.patch.length).toBeGreaterThan(0);
      for (const c of p.patch) expect(c).toHaveProperty("path");
      if (p.evidence.heldOut && !p.evidence.weak) expect(p.evidence.verdict).toBe("better");
    }
    for (const d of res.dropped) expect(d.reason).toBeTruthy();
  }, 180_000);

  it("elle düzeltmeler (gerçek motor): sistematik kaymadan çıkan merkez, dışarıda tutulan işlerde motoru kullanıcının konumuna yaklaştırır", async () => {
    const { profile, templates, refs } = load();
    const tmap = new Map(templates.map((t) => [t.key, t]));
    const env = new ReplayEnv({
      fontDir: path.join(DATA, "diller", "benim-tarzim", "fontlar"),
      fallbackDirs: [path.join(DATA, "ortak", "fontlar")],
      templatePath: (t) => path.join(DATA, "diller", "benim-tarzim", "sablonlar", t.file),
      cacheLimit: 16,
    });
    const counts = new Map<string, number>();
    for (const r of refs) if (r.templateKey && tmap.has(r.templateKey)) counts.set(r.templateKey, (counts.get(r.templateKey) ?? 0) + 1);
    const key = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    const tpl = tmap.get(key)!;
    const F = profile.output.designFramePx;
    const g = await env.geometry(tpl, profile);
    // Kullanıcı her işte motorun bloğunu ~14 px sağa, ~9 px aşağı kaydırmış (küçük iş başı oynamayla).
    const obs: AdjustObservation[] = [];
    for (const [i, ref] of refs.filter((r) => r.templateKey === key).slice(0, 6).entries()) {
      const { intent, text } = referenceToIntent(ref, profile);
      const r = await env.layoutIntent(text, intent, profile, tpl);
      if (!r.ok || !r.lines.length) continue;
      const dx = 14 + (i % 3) - 1;
      const dy = 9 - (i % 2);
      obs.push({ id: `v${i}`, jobId: `j${i}`, templateKey: key, framePx: F, target: g.target, inkBefore: r.ink, inkAfter: { ...r.ink, x: r.ink.x + dx, y: r.ink.y + dy }, scale: 1, replay: { text, intent } });
    }
    expect(obs.length).toBeGreaterThanOrEqual(4);
    const stats = analyzeAdjust(obs, tmap, { framePx: F, current: new Map([[key, { x: g.target.x / F, y: g.target.y / F }]]) });
    const s = stats[0]!;
    expect(s.x.systematic && s.y.systematic).toBe(true);
    const ev = await evaluateAdjust(s, tpl, obs, async (o, t) => {
      const r = await env.layoutIntent(o.replay!.text, o.replay!.intent, profile, t);
      return r.ok && r.lines.length ? r.ink : null;
    }, { framePx: F });
    expect(ev.n).toBe(obs.length);
    expect(ev.verdict, ev.reason).toBe("better");
    expect(ev.after!.positionError).toBeLessThan(ev.before!.positionError / 2);
  }, 180_000);
});
