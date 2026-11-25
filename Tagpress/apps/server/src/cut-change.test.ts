import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Issue, type PrintSessionNotice, ProfileSchema } from "@tagpress/domain";
import { createPrintPlanner } from "./adapters/print.ts";
import { CutChangeService, cutChanged } from "./services/jobs/cut-change.ts";
import { type TestApp, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

let t: TestApp;
let lang: string;
let svc: CutChangeService;

async function approved(records: Record<string, unknown>[]): Promise<string[]> {
  const { commit } = await importJobs(t, records);
  await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
  await t.ctx.queue.idle();
  await t.api("POST", "/api/jobs/approve-best", { ids: commit.jobIds });
  return commit.jobIds as string[];
}
const job = (id: string) => t.raw.get("SELECT status, approved_variant_id, run_issues, org_id FROM jobs WHERE id = ?", id)!;
const RECT = { shape: "rect" as const, wMm: 63.5, hMm: 38.1, radiusMm: 0 };
const profile = ProfileSchema.parse({ name: "x" });

beforeEach(async () => {
  t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner() }), startQueue: true });
  lang = await seedLanguage(t);
  svc = new CutChangeService(t.ctx.tdb, t.clock);
});
afterEach(async () => t.close());

describe("kesim değişince onay düşer", () => {
  it("etkin kesim değişimi: kendi kesimi, ölçüsü, profil kesimi; aynı kesim değişim sayılmaz", () => {
    expect(cutChanged({ cut: null }, { cut: null }, profile)).toBe(false);
    expect(cutChanged({ cut: RECT }, { cut: { ...RECT } }, profile)).toBe(false);
    expect(cutChanged({ cut: null }, { cut: RECT }, profile)).toBe(true);
    // Aynı en/boy oranı, farklı ölçü: tasarım px'i aynı ama mm farklı → değişti.
    expect(cutChanged({ cut: { shape: "rect", wMm: 40, hMm: 40 } }, { cut: { shape: "rect", wMm: 50, hMm: 50 } }, profile)).toBe(true);
    const other = ProfileSchema.parse({ name: "x", output: { cut: { kind: "circle", cx: 220, cy: 220, r: 200 } } });
    expect(cutChanged(null, null, profile, other)).toBe(true);
    // Kendi kesimi olan şablon profil kesiminden etkilenmez.
    expect(cutChanged({ cut: RECT }, { cut: RECT }, profile, other)).toBe(false);
  });

  it("kesim değişince onaylı ve basılmamış işlerin onayı kalkar, uyarı eklenir, varyasyon silinmez; taslak oturum yeniden planla uyarısı alır", async () => {
    const [a, b, c] = await approved([
      { siparis: "1", etiket: "a2", adet: 2, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 2, text: "Marco" },
      { siparis: "3", etiket: "a1", adet: 2, text: "Lidia" },
    ]);
    // b basılmış bir oturumda.
    const grid = await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true });
    const ps = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: grid.json.template.id, jobIds: [b] });
    expect(ps.status, ps.body).toBe(200);
    const printed = ps.json.session;
    expect((await t.api("POST", `/api/print/sessions/${printed.id}/printed`, {})).status).toBe(200);
    const draft = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: grid.json.template.id, jobIds: [a, c] })).json.session;
    expect(draft.notices).toEqual([]);
    const variants = t.raw.all("SELECT id FROM variants WHERE job_id = ? AND deleted_at IS NULL", a!).length;

    const before = t.inOrg(() => t.ctx.templates.find(lang, "a2"))!;
    const pv = t.inOrg(() => svc.preview(lang, "a2", before, { ...before, cut: RECT }, profile));
    expect(pv).toEqual({ changed: true, jobIds: [a] });
    // Kesim değişmeyen kayıt (ör. not) hiçbir şeye dokunmaz.
    const noteOnly = { ...before, notes: "yeni not" };
    expect(t.inOrg(() => svc.onTemplateSaved(lang, "a2", before, noteOnly, profile))).toEqual([]);
    expect(job(a!).status).toBe("approved");

    expect(t.inOrg(() => svc.onTemplateSaved(lang, "a2", before, { ...before, cut: RECT }, profile))).toEqual([a]);
    const ja = job(a!);
    expect(ja).toMatchObject({ status: "ready", approved_variant_id: null });
    expect(JSON.parse(ja.run_issues as string).map((i: Issue) => [i.code, i.severity, i.params])).toEqual([["template-cut-changed", "warning", { template: "a2" }]]);
    expect(t.raw.all("SELECT id FROM variants WHERE job_id = ? AND deleted_at IS NULL", a!)).toHaveLength(variants);
    expect(job(b!).status).toBe("approved"); // basılmış iş etkilenmez
    expect(job(c!).status).toBe("approved"); // başka şablonun işi etkilenmez
    const d = (await t.api("GET", `/api/print/sessions/${draft.id}`)).json;
    expect(d.notices.map((n: PrintSessionNotice) => n.code)).toEqual(["plan-stale"]);
    expect((await t.api("GET", `/api/print/sessions/${printed.id}`)).json.notices).toEqual([]);
    // Yeniden planlayınca uyarı kalkar.
    const r = await t.api("POST", `/api/print/sessions/${draft.id}/replan`, { version: d.version });
    expect(r.json.session.notices).toEqual([]);
  });

  it("tasarım dilinin kesimi değişince yalnız kesimsiz şablonların işleri düşer", async () => {
    // a2'nin kendi kesimi onaydan ÖNCE verilir (kayıt artık onay düşürür; burada yalnız dil kesimi denenir).
    expect((await t.api("PATCH", `/api/languages/${lang}/templates/a2`, { cut: RECT })).status).toBe(200);
    const [a, b] = await approved([
      { siparis: "1", etiket: "a1", adet: 2, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 2, text: "Marco" },
    ]);
    const other = ProfileSchema.parse({ name: "x", output: { cut: { kind: "circle", cx: 220, cy: 220, r: 200 } } });
    const pv = t.inOrg(() => svc.previewProfile(lang, profile, other));
    expect(pv.jobIds).toEqual([a]);
    expect(t.inOrg(() => svc.onProfileCutChanged(lang, profile, other))).toEqual([a]);
    expect(job(a!).status).toBe("ready");
    expect(job(b!).status).toBe("approved");
  });

  it("başka firmanın aynı anahtarlı şablonunun işi etkilenmez", async () => {
    const [a] = await approved([{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }]);
    const orgB = t.ctx.orgs.create({ name: "B" }).id;
    const at = "2026-11-22T00:00:00.000Z";
    t.raw.run("INSERT INTO languages (id, name, created_at, org_id) VALUES ('dil-b', 'B', ?, ?)", at, orgB);
    t.raw.run("INSERT INTO batches (id, language_id, name, created_at, org_id) VALUES ('parti-b', 'dil-b', 'P', ?, ?)", at, orgB);
    t.raw.run(
      "INSERT INTO jobs (id, batch_id, seq, raw, text_raw, text, status, dedupe_key, created_at, updated_at, kind, template_key, org_id) VALUES ('is-b', 'parti-b', 0, '{}', 'x', 'x', 'approved', 'k', ?, ?, 'label', 'a2', ?)",
      at, at, orgB,
    );
    const before = t.inOrg(() => t.ctx.templates.find(lang, "a2"))!;
    // A firmasında çalışır; B'nin işi (aynı dil kimliği değil ama aynı şablon anahtarı) hiç görülmez.
    expect(t.inOrg(() => svc.onTemplateSaved(lang, "a2", before, { ...before, cut: RECT }, profile))).toEqual([a]);
    expect(t.inOrg(() => svc.approvedJobs("dil-b", ["a2"]))).toEqual([]);
    expect(t.raw.get("SELECT status FROM jobs WHERE id = 'is-b'")).toEqual({ status: "approved" });
    // B'nin kendi kapsamında görünür (servis firma bağlamını izler).
    expect(t.inOrg(() => svc.approvedJobs("dil-b", ["a2"]), orgB)).toEqual(["is-b"]);
  });
});
