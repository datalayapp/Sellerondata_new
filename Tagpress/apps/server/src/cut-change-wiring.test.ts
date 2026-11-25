import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrintPlanner } from "./adapters/print.ts";
import { type TestApp, TEST_PROFILE, fullPorts, makeApp, seedLanguage } from "./test/helpers.ts";
import { ORG_HEADER, headerResolver } from "./test/two-orgs.ts";

/**
 * Kesim değişince onayın düşmesi, bağlı hâliyle (YOL-HARITASI kalan iş 1): şablon kaydı (PATCH), önizleme ucu
 * (`cut-preview`), tasarım dili yayını ve geri alma; çok firmalı kurulumda başka firmanın aynı anahtarlı şablonu.
 */

let t: TestApp;
let lang: string;
const RECT = { shape: "rect" as const, wMm: 63.5, hMm: 38.1 };
const OTHER_CUT = { kind: "circle" as const, cx: 220, cy: 220, r: 200 };

const as = (org?: string) => (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown) => t.api(method, url, body, org ? { [ORG_HEADER]: org } : {});

async function approvedIn(language: string, records: Record<string, unknown>[], org?: string): Promise<string[]> {
  const call = as(org);
  const prev = await call("POST", "/api/import/preview", { fileName: "siparis.json", content: JSON.stringify(records), languageId: language });
  expect(prev.status, prev.body).toBe(200);
  const commit = await call("POST", "/api/import/commit", { fileName: "siparis.json", mapping: prev.json.mapping, rows: prev.json.rows, languageId: language });
  expect(commit.status, commit.body).toBe(200);
  const ids = commit.json.jobIds as string[];
  await call("POST", "/api/generate", { jobIds: ids });
  await t.ctx.queue.idle();
  const ap = await call("POST", "/api/jobs/approve-best", { ids });
  expect(ap.json.approved, ap.body).toHaveLength(ids.length);
  return ids;
}

async function reapprove(ids: string[], org?: string): Promise<void> {
  const ap = await as(org)("POST", "/api/jobs/approve-best", { ids });
  expect(ap.json.approved, ap.body).toHaveLength(ids.length);
}

const job = (id: string) => t.raw.get("SELECT status, approved_variant_id, run_issues, deleted_at FROM jobs WHERE id = ?", id)!;
const codes = (id: string) => (JSON.parse(String(job(id).run_issues)) as { code: string }[]).map((i) => i.code);
const preview = (body: unknown, key = "a2", language = lang, org?: string) => as(org)("POST", `/api/languages/${language}/templates/${key}/cut-preview`, body);
const patchTpl = (body: unknown, key = "a2", language = lang, org?: string) => as(org)("PATCH", `/api/languages/${language}/templates/${key}`, body);

beforeEach(async () => {
  t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner() }), startQueue: true, resolver: headerResolver(() => t.ctx.orgs.defaultOrgId()!) });
  lang = await seedLanguage(t);
});
afterEach(async () => t.close());

describe("şablon kaydı kesimi değiştirince", () => {
  it("önizleme sayıyı verir ve kayda yazmaz; kayıt onaylı, basılmamış, silinmemiş işlerin onayını düşürür; yanıt şablon nesnesi", async () => {
    const [a, printed, deleted, other] = await approvedIn(lang, [
      { siparis: "1", etiket: "a2", adet: 2, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 2, text: "Marco" },
      { siparis: "3", etiket: "a2", adet: 2, text: "Lidia" },
      { siparis: "4", etiket: "a1", adet: 2, text: "Ece" },
    ]) as [string, string, string, string];
    const grid = await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true });
    const ps = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: grid.json.template.id, jobIds: [printed] })).json.session;
    expect((await t.api("POST", `/api/print/sessions/${ps.id}/printed`, {})).status).toBe(200);
    const draft = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: grid.json.template.id, jobIds: [a, other] })).json.session;
    expect((await t.api("POST", "/api/jobs/delete", { ids: [deleted] })).status).toBe(200);

    const pv = await preview({ cut: RECT });
    expect(pv.status, pv.body).toBe(200);
    expect(pv.json).toEqual({ changed: true, approvals: 1 });
    // Önizleme kayda yazmaz, onay düşürmez.
    expect((await t.api("GET", `/api/languages/${lang}/templates/a2`)).json.template.cut).toBeNull();
    expect(job(a).status).toBe("approved");

    const r = await patchTpl({ cut: RECT });
    expect(r.status, r.body).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["fileMissing", "imageUrl", "overlayUrl", "template", "updatedAt"]);
    expect(r.json.template.cut).toMatchObject(RECT);
    expect(job(a)).toMatchObject({ status: "ready", approved_variant_id: null });
    expect(codes(a)).toEqual(["template-cut-changed"]);
    expect(job(printed).status).toBe("approved"); // basılmış
    // Silinmiş (geri alınabilir) iş: önizlemede sayılmaz ama onayı da düşer (geri alınınca eski kesimle onaylı dönmesin).
    expect(job(deleted)).toMatchObject({ status: "ready", approved_variant_id: null });
    expect(codes(deleted)).toEqual(["template-cut-changed"]);
    expect(job(deleted).deleted_at).not.toBeNull();
    expect(job(other).status).toBe("approved"); // başka şablon
    expect((await t.api("GET", `/api/print/sessions/${draft.id}`)).json.notices.map((n: { code: string }) => n.code)).toEqual(["plan-stale"]);
    expect((await t.api("GET", `/api/print/sessions/${ps.id}`)).json.notices).toEqual([]);
  });

  it("aynı kesimle yeniden kayıt ve kesimsiz alan değişikliği onay düşürmez; kesim kaldırılınca (null) yine düşer", async () => {
    expect((await patchTpl({ cut: RECT })).status).toBe(200);
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];

    expect((await preview({ cut: { ...RECT, radiusMm: 0 } })).json).toEqual({ changed: false, approvals: 0 });
    expect((await patchTpl({ cut: { ...RECT, radiusMm: 0 } })).status).toBe(200);
    expect((await patchTpl({ notes: "yeni not", tags: ["x"] })).status).toBe(200);
    expect(job(a).status).toBe("approved");

    // Kesim kaldırılır: dilin kesimine düşer → etkin kesim değişti.
    expect((await preview({ cut: null })).json).toEqual({ changed: true, approvals: 1 });
    expect((await patchTpl({ cut: null })).status).toBe(200);
    expect(job(a).status).toBe("ready");
    expect(codes(a)).toEqual(["template-cut-changed"]);
    // Onay düşmüş işi olan önizleme 0 sayar.
    expect((await preview({ cut: RECT })).json).toEqual({ changed: true, approvals: 0 });
    // Yeniden onaylanıp yine değişirse uyarı tek kalır (çoğalmaz).
    await reapprove([a]);
    expect((await patchTpl({ cut: RECT })).status).toBe(200);
    expect(codes(a)).toEqual(["template-cut-changed"]);
  });

  it("önizleme gövdesi doğrulanır; bilinmeyen şablon 404", async () => {
    expect((await preview({ cut: { shape: "yildiz", wMm: 10, hMm: 10 } })).status).toBe(400);
    expect((await preview({})).status).toBe(400);
    expect((await preview({ cut: { shape: "rect", wMm: -1, hMm: 10 } })).status).toBe(400);
    const miss = await preview({ cut: RECT }, "yok");
    expect(miss.status).toBe(404);
    expect(miss.json.code).toBe("template-key-not-found");
  });

  it("şablon tam yazımı (upsert) da kesimi değiştirirse onay düşer", async () => {
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const cur = t.inOrg(() => t.ctx.templates.find(lang, "a2"))!;
    t.inOrg(() => t.ctx.templates.upsert(lang, { ...cur, cut: RECT }));
    expect(job(a).status).toBe("ready");
  });
});

describe("tasarım dili yayınında kesim değişince", () => {
  it("yalnız kesimsiz şablonların işleri düşer; kesimi aynı kalan yayın düşürmez; geri alma da düşürür", async () => {
    expect((await patchTpl({ cut: RECT })).status).toBe(200);
    const [a, b] = (await approvedIn(lang, [
      { siparis: "1", etiket: "a1", adet: 2, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 2, text: "Marco" },
    ])) as [string, string];
    const publish = async (data: unknown) => {
      expect((await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data })).status).toBe(200);
      const r = await t.api("POST", `/api/languages/${lang}/profile/publish`, {});
      expect(r.status, r.body).toBe(200);
      return r.json.version as number;
    };
    const v1 = t.inOrg(() => t.ctx.profiles.active(lang))!.version;

    await publish({ ...TEST_PROFILE, lineBreaking: { maxLineChars: 22, maxLines: 4 } });
    expect([job(a).status, job(b).status]).toEqual(["approved", "approved"]);

    await publish({ ...TEST_PROFILE, output: { cut: OTHER_CUT } });
    expect(job(a).status).toBe("ready"); // kesimsiz şablon
    expect(codes(a)).toEqual(["template-cut-changed"]);
    expect(job(b).status).toBe("approved"); // kendi kesimi olan şablon

    await reapprove([a]);
    const rv = await t.api("POST", `/api/languages/${lang}/profile/revert`, { version: v1 });
    expect(rv.status, rv.body).toBe(200);
    expect(job(a).status).toBe("ready");
    expect(job(b).status).toBe("approved");
  });
});

describe("çok firmalı kurulum", () => {
  it("bir firmanın şablon kaydı ve dil yayını başka firmanın aynı anahtarlı şablonunun işine dokunmaz", async () => {
    const orgB = t.ctx.orgs.create({ name: "B" }).id;
    const langB = await t.inOrg(() => seedLanguage(t), orgB);
    expect(langB).not.toBe(lang);
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const [bj] = (await approvedIn(langB, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }], orgB)) as [string];

    // A kaydeder: yalnız A'nın işi düşer.
    expect((await preview({ cut: RECT })).json).toEqual({ changed: true, approvals: 1 });
    expect((await patchTpl({ cut: RECT })).status).toBe(200);
    expect(job(a).status).toBe("ready");
    expect(job(bj).status).toBe("approved");

    // B'nin önizlemesi yalnız B'nin işini sayar; A, B'nin diline erişemez.
    await reapprove([a]);
    expect((await preview({ cut: RECT }, "a2", langB, orgB)).json).toEqual({ changed: true, approvals: 1 });
    expect((await preview({ cut: RECT }, "a2", langB)).json.code).toBe("language-not-found");
    expect((await patchTpl({ cut: RECT }, "a2", langB)).json.code).toBe("language-not-found");
    expect(job(bj).status).toBe("approved");

    // B kaydeder: A'nın (yeniden onaylanmış) işi etkilenmez.
    expect((await patchTpl({ cut: RECT }, "a2", langB, orgB)).status).toBe(200);
    expect(job(bj).status).toBe("ready");
    expect(job(a).status).toBe("approved");

    // B'nin dil yayını (kesim değişir): A'nın kesimsiz şablonlu işi etkilenmez.
    const [a1] = (await approvedIn(lang, [{ siparis: "2", etiket: "a1", adet: 2, text: "Ece" }])) as [string];
    const [b1] = (await approvedIn(langB, [{ siparis: "2", etiket: "a1", adet: 2, text: "Ece" }], orgB)) as [string];
    expect((await as(orgB)("PUT", `/api/languages/${langB}/profile/draft`, { data: { ...TEST_PROFILE, output: { cut: OTHER_CUT } } })).status).toBe(200);
    expect((await as(orgB)("POST", `/api/languages/${langB}/profile/publish`, {})).status).toBe(200);
    expect(job(b1).status).toBe("ready");
    expect(job(a1).status).toBe("approved");
  });
});
