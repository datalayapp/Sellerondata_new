import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrintPlanner } from "./adapters/print.ts";
import { type TestApp, TEST_PROFILE, fullPorts, makeApp, seedLanguage } from "./test/helpers.ts";
import { ORG_HEADER, headerResolver } from "./test/two-orgs.ts";

/**
 * Kesim değişince onayın düşmesi, varyasyon silmenin geri alınmasında: silmeden bu yana işin etkin kesimi değiştiyse
 * onay geri gelmez (`ready` + `template-cut-changed`); değişmediyse onay döner. İmzasız eski geri alma kayıtları
 * bugünkü gibi onaylı döner. Çok firmalı kurulumda başka firmanın aynı anahtarlı şablonu karışmaz.
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

const job = (id: string) => t.raw.get("SELECT status, approved_variant_id, run_issues FROM jobs WHERE id = ?", id)!;
const codes = (id: string) => (JSON.parse(String(job(id).run_issues)) as { code: string }[]).map((i) => i.code);
const patchTpl = (body: unknown, key = "a2", language = lang, org?: string) => as(org)("PATCH", `/api/languages/${language}/templates/${key}`, body);

/** Onaylı varyasyonu siler; geri alma anahtarı ve silinen varyasyon. */
async function deleteApproved(jobId: string, org?: string): Promise<{ token: string; variantId: string }> {
  const variantId = String(job(jobId).approved_variant_id);
  const del = await as(org)("DELETE", `/api/variants/${variantId}`);
  expect(del.status, del.body).toBe(200);
  expect(job(jobId).approved_variant_id).toBeNull();
  return { token: del.json.undoToken as string, variantId };
}

async function undo(token: string, org?: string): Promise<void> {
  const r = await as(org)("POST", `/api/undo/${token}`);
  expect(r.status, r.body).toBe(200);
}

beforeEach(async () => {
  t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner() }), startQueue: true, resolver: headerResolver(() => t.ctx.orgs.defaultOrgId()!) });
  lang = await seedLanguage(t);
});
afterEach(async () => t.close());

describe("varyasyon silmenin geri alınması ve kesim değişikliği", () => {
  it("silmeden sonra şablon kesimi değişirse geri alma onayı getirmez: iş ready ve uyarılı, varyasyon geri gelir", async () => {
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const { token, variantId } = await deleteApproved(a);

    expect((await patchTpl({ cut: RECT })).status).toBe(200);
    await undo(token);

    expect(job(a)).toMatchObject({ status: "ready", approved_variant_id: null });
    expect(codes(a)).toEqual(["template-cut-changed"]);
    expect(t.raw.get("SELECT deleted_at FROM variants WHERE id = ?", variantId)!.deleted_at).toBeNull();
  });

  it("kesim değişmeden (ya da kesimsiz alan değişince) geri alma onayı getirir", async () => {
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const { token, variantId } = await deleteApproved(a);

    expect((await patchTpl({ notes: "yeni not" })).status).toBe(200);
    await undo(token);

    expect(job(a)).toMatchObject({ status: "approved", approved_variant_id: variantId });
    expect(codes(a)).toEqual([]);
  });

  it("tasarım dilinin kesimi değişince kesimsiz şablonlu işin geri alınması onay getirmez", async () => {
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a1", adet: 2, text: "Anna" }])) as [string];
    const { token } = await deleteApproved(a);

    expect((await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data: { ...TEST_PROFILE, output: { cut: OTHER_CUT } } })).status).toBe(200);
    expect((await t.api("POST", `/api/languages/${lang}/profile/publish`, {})).status).toBe(200);
    await undo(token);

    expect(job(a)).toMatchObject({ status: "ready", approved_variant_id: null });
    expect(codes(a)).toEqual(["template-cut-changed"]);
  });

  it("imzasız eski geri alma kaydı bugünkü gibi onaylı döner", async () => {
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const { token, variantId } = await deleteApproved(a);
    const row = t.raw.get("SELECT payload FROM undo WHERE token = ?", token)!;
    const payload = JSON.parse(String(row.payload)) as { approvals: { cutSignature?: string }[] };
    expect(payload.approvals[0]!.cutSignature).toEqual(expect.any(String));
    for (const ap of payload.approvals) delete ap.cutSignature;
    t.raw.run("UPDATE undo SET payload = ? WHERE token = ?", JSON.stringify(payload), token);

    expect((await patchTpl({ cut: RECT })).status).toBe(200);
    await undo(token);

    expect(job(a)).toMatchObject({ status: "approved", approved_variant_id: variantId });
  });
});

describe("çok firmalı kurulum", () => {
  it("başka firmanın aynı anahtarlı şablonunun kesimi değişince geri alma onayı getirir; kendi kesimi değişince getirmez", async () => {
    const orgB = t.ctx.orgs.create({ name: "B" }).id;
    const langB = await t.inOrg(() => seedLanguage(t), orgB);
    const [a] = (await approvedIn(lang, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const [bj] = (await approvedIn(langB, [{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }], orgB)) as [string];
    const delA = await deleteApproved(a);
    const delB = await deleteApproved(bj, orgB);

    // B kendi a2 şablonunun kesimini değiştirir: A'nın geri alması onaylı döner.
    expect((await patchTpl({ cut: RECT }, "a2", langB, orgB)).status).toBe(200);
    // A'nın anahtarı B'de geçmez.
    expect((await as(orgB)("POST", `/api/undo/${delA.token}`)).status).toBe(404);
    await undo(delA.token);
    expect(job(a)).toMatchObject({ status: "approved", approved_variant_id: delA.variantId });

    // B'nin geri alması: kendi kesimi değişti → ready ve uyarılı.
    await undo(delB.token, orgB);
    expect(job(bj)).toMatchObject({ status: "ready", approved_variant_id: null });
    expect(codes(bj)).toEqual(["template-cut-changed"]);
    expect(codes(a)).toEqual([]);
  });
});
