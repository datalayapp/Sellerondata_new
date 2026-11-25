import type { DesignSessionEntry, LearnProposal, RefLine, Reference, ServerEvent } from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInOrg } from "./org/context.ts";
import { type TestApp, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

/** Öneri kanıtı sunucuda serbest biçimli (`unknown`); testin okuduğu alanlar. */
type ProposalView = LearnProposal & { evidence: { slug?: string } | null };

/** Servisi doğrudan çağıran test satırları sunucudaki gibi firma bağlamında çalışır (bağlamsız çağrı sayılmaz). */
function inOrg<T>(t: TestApp, fn: () => T): T {
  return runInOrg(t.ctx.orgs.defaultOrgId()!, fn);
}

/** Satırlar: mürekkep yüksekliği 0,8 × punto, verilen görünen boşlukla alt alta. */
function lines(ls: Array<{ text: string; size: number; gap?: number }>, top = 150, cx = 220): RefLine[] {
  let y = top;
  let prev: { size: number } | null = null;
  return ls.map((l) => {
    if (prev) y += (l.gap ?? 0.1) * Math.min(prev.size, l.size);
    const w = l.text.length * l.size * 0.4;
    const h = l.size * 0.8;
    const out: RefLine = { text: l.text, family: "Great Vibes", style: "Regular", sizePx: l.size, segments: [{ text: l.text, family: "Great Vibes", style: "Regular", sizePx: l.size }], ink: { x: cx - w / 2, y, w, h } };
    y += h;
    prev = l;
    return out;
  });
}

function reference(lang: string, i: number, over: Partial<Reference> & { gap?: number; top?: number } = {}): Omit<Reference, "createdAt"> {
  const user = lines(
    [
      { text: "Grazie", size: 40 },
      { text: `Giulia${i}`, size: 60, gap: over.gap ?? 0.2 },
    ],
    over.top ?? 150,
  );
  return {
    id: `ref-${i}`,
    languageId: lang,
    source: "figma",
    orderNo: String(i),
    quantity: 1,
    templateKey: over.templateKey ?? "a1",
    labelFramePx: 440,
    text: `Grazie Giulia${i}`,
    user,
    program: null,
    programMeta: null,
    image: null,
    split: over.split ?? "train",
  };
}

describe("öğrenme uçları", () => {
  let t: TestApp;
  let lang: string;
  let events: ServerEvent[];
  beforeEach(async () => {
    t = await makeApp();
    lang = await seedLanguage(t);
    events = [];
    t.ctx.events.subscribe((e) => events.push(e));
  });
  afterEach(() => t.close());

  it("referans yokken koşu 409", async () => {
    const r = await t.api("POST", `/api/languages/${lang}/learn/run`, {});
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/referans/i);
  });

  it("koşu → öneriler (yama + kanıt) → uygula (taslak + şablon provenance 'learned') → geri al → reddet", async () => {
    for (let i = 0; i < 16; i++) inOrg(t, () => t.ctx.references.save(reference(lang, i)));
    for (let i = 16; i < 19; i++) inOrg(t, () => t.ctx.references.save(reference(lang, i, { templateKey: "a2", top: 120 })));
    for (let i = 19; i < 22; i++) inOrg(t, () => t.ctx.references.save(reference(lang, i, { split: "test" })));

    const start = await t.api("POST", `/api/languages/${lang}/learn/run`, {});
    expect(start.status, start.body).toBe(202);
    expect(start.json).toMatchObject({ status: "running", base: "published" });
    // Aynı anda ikinci koşu yok.
    expect((await t.api("POST", `/api/languages/${lang}/learn/run`, {})).status).toBe(409);
    await t.ctx.learning.running;
    const st = (await t.api("GET", `/api/languages/${lang}/learn/run`)).json;
    expect(st.status, st.error).toBe("done");
    expect(st.result.proposals.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "learn" && e.status === "done")).toBe(true);

    const list = (await t.api("GET", `/api/learn/proposals?languageId=${lang}&status=open`)).json.proposals;
    const gap = list.find((p: ProposalView) => p.evidence?.slug === "spacing.inkGaps.normal");
    expect(gap.patch).toEqual([{ target: "profile", path: "spacing.inkGaps.normal", from: 0.15, to: 0.2 }]);
    expect(gap.evidence).toMatchObject({ source: "learn-run", kind: "motor", count: 19 });
    // Fontsuz test ortamında motor yerleşemez: öneri düşmez ama kanıt zayıf işaretlenir.
    expect(gap.evidence.weak).toBe(true);
    const center = list.find((p: ProposalView) => p.evidence?.slug === "template:a2:textCenter");
    expect(center.patch[0]).toMatchObject({ target: "template", key: "a2", field: "textCenter", from: null });

    // Uygula: profil → taslak.
    const ap = await t.api("POST", `/api/learn/proposals/${gap.id}/apply`, {});
    expect(ap.status, ap.body).toBe(200);
    expect(ap.json.draft.data.spacing.inkGaps.normal).toBe(0.2);
    expect(ap.json.proposal.status).toBe("accepted");
    expect((await t.api("POST", `/api/learn/proposals/${gap.id}/apply`, {})).status).toBe(409);
    expect((await t.api("GET", `/api/languages/${lang}/profile`)).json.data.spacing.inkGaps.normal).toBe(0.15);

    // Uygula: şablon kaydı + provenance.
    const ac = await t.api("POST", `/api/learn/proposals/${center.id}/apply`, {});
    expect(ac.json.templates).toEqual(["a2"]);
    const tpl = inOrg(t, () => t.ctx.templates.find(lang, "a2"))!;
    expect(tpl.textCenter).toEqual(center.patch[0].to);
    expect(tpl.provenance.at(-1)).toMatchObject({ field: "textCenter", source: "learned", samples: 3 });

    // Geri al: şablon eski değerine, öneri açık.
    const rv = await t.api("POST", `/api/learn/proposals/${center.id}/revert`, {});
    expect(rv.status, rv.body).toBe(200);
    expect(rv.json.proposal.status).toBe("open");
    expect(inOrg(t, () => t.ctx.templates.find(lang, "a2"))!.textCenter).toBeNull();
    // Profil önerisini geri al: taslaktaki değer hâlâ önerininki → eski değer.
    const rg = await t.api("POST", `/api/learn/proposals/${gap.id}/revert`, {});
    expect(rg.json.draft.data.spacing.inkGaps.normal).toBe(0.15);

    // Reddet ve uygulanmış öneriyi reddetme yasağı.
    expect((await t.api("POST", `/api/learn/proposals/${center.id}/reject`, {})).json.status).toBe("rejected");
    // Oturum günlüğüne not düştü.
    const s = (await t.api("GET", `/api/languages/${lang}/design-session`)).json;
    expect(s.entries.some((e: DesignSessionEntry) => e.kind === "note" && /Öğrenme önerisi uygulandı/.test(e.text))).toBe(true);

    // Yeni koşu aynı kararın AÇIK önerisinin yerini alır (kopya birikmez).
    await t.api("POST", `/api/languages/${lang}/learn/run`, {});
    await t.ctx.learning.running;
    const again = (await t.api("GET", `/api/learn/proposals?languageId=${lang}&status=open`)).json.proposals;
    expect(again.filter((p: ProposalView) => p.evidence?.slug === "spacing.inkGaps.normal")).toHaveLength(1);
  }, 60_000);

  it("elle düzeltmelerden şablon merkezi önerisi: referans olmadan koşu → öneri (kanıt) → uygula → geri al", async () => {
    await t.close();
    t = await makeApp({ ports: fullPorts() });
    lang = await seedLanguage(t);
    // Dört iş, a1 şablonu; kullanıcı her birinde yazıyı ~30 px sağa, ~24 px aşağı kaydırıyor. Bir işte iki varyasyon.
    const { commit } = await importJobs(
      t,
      [1, 2, 3, 4].map((i) => ({ siparis: String(i), etiket: "a1", adet: 1, text: `Anna Marco ${i}` })),
    );
    await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
    await t.ctx.queue.idle();
    const shifts = [
      [30, 24],
      [31, 23],
      [29, 25],
      [30, 24],
    ];
    let first = "";
    for (const [i, jobId] of (commit.jobIds as string[]).entries()) {
      const job = (await t.api("GET", `/api/jobs/${jobId}`)).json;
      const [dx, dy] = shifts[i]!;
      const r = await t.api("PUT", `/api/variants/${job.variants[0].id}/adjust`, { adjust: { dx, dy, scale: 0.95 } });
      expect(r.status, r.body).toBe(200);
      if (i === 0) {
        first = job.variants[0].id;
        if (job.variants[1]) await t.api("PUT", `/api/variants/${job.variants[1].id}/adjust`, { adjust: { dx: 30, dy: 24 } });
      }
    }
    expect(inOrg(t, () => t.ctx.learning.adjustInput(lang)).observations.length).toBeGreaterThanOrEqual(4);
    expect(inOrg(t, () => t.ctx.learning.adjustInput(lang)).observations[0]!.replay).toMatchObject({ text: expect.stringContaining("Anna Marco") });

    // Referans yok ama elle düzeltme var: koşu çalışır.
    const start = await t.api("POST", `/api/languages/${lang}/learn/run`, { minAdjust: 4, minAdjustJobs: 3 });
    expect(start.status, start.body).toBe(202);
    await t.ctx.learning.running;
    const st = (await t.api("GET", `/api/languages/${lang}/learn/run`)).json;
    expect(st.status, st.error).toBe("done");
    expect(st.result.counts).toMatchObject({ refs: 0, adjustTemplates: 1 });
    expect(st.result.findings.some((f: string) => /elle düzeltilmiş/.test(f))).toBe(true);
    const list = (await t.api("GET", `/api/learn/proposals?languageId=${lang}&status=open`)).json.proposals;
    const p = list.find((x: ProposalView) => x.evidence?.slug === "template:a1:textCenter:adjust");
    expect(p, JSON.stringify(st.result)).toBeTruthy();
    expect(p.patch[0]).toMatchObject({ target: "template", key: "a1", field: "textCenter", path: "template:a1.textCenter", from: null });
    // Kayıtlar (220, 220) hedefle yapıldı: istenen merkez (250, 244) / 440.
    expect(p.patch[0].to).toEqual({ x: 0.568, y: 0.555 });
    expect(p.summary).toMatch(/4 işin \d varyasyonunu/);
    expect(p.evidence).toMatchObject({ source: "learn-run", origin: "adjust", kind: "motor", primary: "position", stats: { source: "adjust", jobs: 4 } });
    expect(p.evidence.variants.find((v: { variantId: string; url: string }) => v.variantId === first).url).toMatch(new RegExp(`^/api/variants/${first}/preview\\.png\\?v=\\d+\\.\\d+$`));
    // Fontsuz test ortamında motor yeniden yerleştiremez: öneri düşmez, kanıt zayıf işaretlenir.
    expect(p.evidence.weak).toBe(true);
    expect(p.summary).toMatch(/Kanıt zayıf/);

    // Uygula → şablon kaydı + provenance; geri al → eski değer.
    const ap = await t.api("POST", `/api/learn/proposals/${p.id}/apply`, {});
    expect(ap.status, ap.body).toBe(200);
    expect(ap.json.templates).toEqual(["a1"]);
    expect(ap.json.draft).toBeNull();
    const tpl = inOrg(t, () => t.ctx.templates.find(lang, "a1"))!;
    expect(tpl.textCenter).toEqual({ x: 0.568, y: 0.555 });
    expect(tpl.provenance.at(-1)).toMatchObject({ field: "textCenter", source: "learned", samples: p.evidence.count });
    const rv = await t.api("POST", `/api/learn/proposals/${p.id}/revert`, {});
    expect(rv.status, rv.body).toBe(200);
    expect(rv.json.proposal.status).toBe("open");
    expect(inOrg(t, () => t.ctx.templates.find(lang, "a1"))!.textCenter).toBeNull();
  }, 60_000);

  it("ölçüm özeti, örnekler ve motor denemesi uçları", async () => {
    for (let i = 0; i < 5; i++) inOrg(t, () => t.ctx.references.save(reference(lang, i, { split: i < 3 ? "train" : "test" })));
    const m = await t.api("GET", `/api/languages/${lang}/learn/measure`);
    expect(m.status, m.body).toBe(200);
    expect(m.json.measurement.refs.usable).toBe(5);
    expect(m.json.measurement.lineCount).toEqual([{ lines: 2, count: 5 }]);

    const s = await t.api("GET", `/api/languages/${lang}/learn/samples?limit=2&split=train`);
    expect(s.json.total).toBe(3);
    expect(s.json.samples).toHaveLength(2);
    expect(s.json.samples[0].lines[0]).toMatchObject({ text: "Grazie", font: "Great Vibes/Regular" });
    expect(s.json.samples[0].lines[0].pt).toBeGreaterThan(0);

    const r = await t.api("POST", `/api/languages/${lang}/learn/replay`, { source: "published", limit: 2, split: "all", previews: 0 });
    expect(r.status, r.body).toBe(200);
    expect(r.json.refs).toBe(2);
    expect(r.json.sides[0].label).toMatch(/Yayınlanan/);
    expect(r.json.sides[0].metrics.n).toBe(2);

    expect((await t.api("GET", `/api/learn/previews/yok/yok.png`)).status).toBe(404);
    expect((await t.api("GET", `/api/learn/previews/..%2F..%2Fstudio.db/x.png`)).status).toBe(404);
    const thumb = await t.app.inject({ method: "GET", url: `/api/languages/${lang}/learn/templates/a1/thumb.png?w=64` });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/png");
  }, 60_000);
});
