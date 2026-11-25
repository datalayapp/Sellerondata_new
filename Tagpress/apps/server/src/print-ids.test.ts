import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrintPlanner } from "./adapters/print.ts";
import { type TestApp, fullPorts, makeApp, seedLanguage } from "./test/helpers.ts";
import { ORG_HEADER, headerResolver } from "./test/two-orgs.ts";
import { isUuidv7 } from "./util/ids.ts";

/**
 * Baskı yamasında istemci kimliği (SUNUCU-PLANI §10.3, dil kimliğindeki kural): `addPage`/`addItem`'ın `id`'si her
 * zaman geçici başvurudur; sunucu her eklemeye yeni UUIDv7 verir, yanıtta `ids` (geçici → gerçek). Hiçbir yanıt bir
 * kimliğin (başka ya da aynı firmada) var olup olmadığını söylemez. Aynı yamada iki eklemeye aynı geçici kimlik
 * belirsizdir: `id-in-use`.
 */

let t: TestApp;
type Org = { org?: string; lang: string; session: string; page: string; item: string; job: string };
let A: Org;
let B: Org;

const as = (org?: string) => (method: "GET" | "POST" | "PATCH", url: string, body?: unknown) => t.api(method, url, body, org ? { [ORG_HEADER]: org } : {});

async function setupOrg(org?: string): Promise<Org> {
  const call = as(org);
  const lang = await t.inOrg(() => seedLanguage(t), org);
  const records = [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }];
  const prev = await call("POST", "/api/import/preview", { fileName: "s.json", content: JSON.stringify(records), languageId: lang });
  const commit = await call("POST", "/api/import/commit", { fileName: "s.json", mapping: prev.json.mapping, rows: prev.json.rows, languageId: lang });
  const ids = commit.json.jobIds as string[];
  await call("POST", "/api/generate", { jobIds: ids });
  await t.ctx.queue.idle();
  await call("POST", "/api/jobs/approve-best", { ids });
  const grid = await call("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true });
  const s = await call("POST", "/api/print/sessions", { languageId: lang, templateId: grid.json.template.id, jobIds: ids });
  expect(s.status, s.body).toBe(200);
  const session = s.json.session;
  return { ...(org ? { org } : {}), lang, session: session.id, page: session.pages[0].id, item: session.pages[0].items[0].id, job: ids[0]! };
}

async function patch(o: Org, ops: unknown[]) {
  const call = as(o.org);
  const version = (await call("GET", `/api/print/sessions/${o.session}`)).json.version;
  return call("PATCH", `/api/print/sessions/${o.session}`, { version, ops });
}

const owner = (table: "print_pages" | "print_items", id: string) => t.raw.get(`SELECT org_id, ${table === "print_pages" ? "session_id" : "page_id"} AS parent FROM ${table} WHERE id = ?`, id);

beforeEach(async () => {
  t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner() }), startQueue: true, resolver: headerResolver(() => t.ctx.orgs.defaultOrgId()!) });
  A = await setupOrg();
  B = await setupOrg(t.ctx.orgs.create({ name: "B" }).id);
});
afterEach(async () => t.close());

describe("baskı yamasında istemci kimliği", () => {
  it("başka firmada dolu kimlik: hata yok, yeni UUIDv7; aynı yamadaki başvuru çevrilir; yanıtta gerçek kimlik", async () => {
    const aPage = owner("print_pages", A.page);
    const aItem = owner("print_items", A.item);
    const r = await patch(B, [
      { op: "addPage", id: A.page },
      { op: "addItem", id: A.item, pageId: A.page, jobId: B.job, slotId: null, xMm: 20, yMm: 20, rotation: 7 },
      { op: "updatePage", pageId: A.page, name: "Yeni" },
    ]);
    expect(r.status, r.body).toBe(200);
    const pageId = r.json.ids[A.page] as string;
    const itemId = r.json.ids[A.item] as string;
    expect(isUuidv7(pageId) && isUuidv7(itemId)).toBe(true);
    expect([pageId, itemId]).not.toContain(A.page);
    const page = r.json.session.pages.find((p: { id: string }) => p.id === pageId);
    expect(page).toMatchObject({ name: "Yeni" });
    expect(page.items).toEqual([expect.objectContaining({ id: itemId, jobId: B.job, rotation: 7 })]);
    // A'nın satırları yerinde.
    expect(owner("print_pages", A.page)).toEqual(aPage);
    expect(owner("print_items", A.item)).toEqual(aItem);
    // Sonraki yamada gerçek kimlikle başvurulur.
    expect((await patch(B, [{ op: "updateItem", itemId, rotation: 3 }])).status).toBe(200);
  });

  it("boş, başka firmada dolu ve aynı firmada dolu kimlik aynı yanıtı alır: her zaman yeni UUIDv7 (varlık okunamaz)", async () => {
    const shape = (r: { status: number; json: { ids?: Record<string, string> } }, temp: string) => ({ status: r.status, real: isUuidv7(r.json.ids?.[temp]), same: r.json.ids?.[temp] === temp });
    const free = await patch(B, [{ op: "addPage", id: "p_benim" }]);
    const foreign = await patch(B, [{ op: "addPage", id: A.page }]);
    const own = await patch(B, [{ op: "addPage", id: B.page }]);
    expect(shape(free, "p_benim")).toEqual({ status: 200, real: true, same: false });
    expect(shape(foreign, A.page)).toEqual(shape(free, "p_benim"));
    expect(shape(own, B.page)).toEqual(shape(free, "p_benim"));
    // Aynı firmadaki sayfa yerinde; yeni sayfa ayrı.
    expect(own.json.session.pages.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([B.page, own.json.ids[B.page]]));
    // Öğe de: aynı firmada dolu öğe kimliği yeni öğe olur, eskisi değişmez.
    const before = t.raw.get("SELECT page_id, x_mm FROM print_items WHERE id = ?", B.item);
    const it2 = await patch(B, [{ op: "addItem", id: B.item, pageId: B.page, jobId: B.job, slotId: null, xMm: 5, yMm: 5 }]);
    expect(it2.status, it2.body).toBe(200);
    expect(isUuidv7(it2.json.ids[B.item])).toBe(true);
    expect(t.raw.get("SELECT page_id, x_mm FROM print_items WHERE id = ?", B.item)).toEqual(before);
    // Kimlik verilmezse `ids` yok.
    const n = await patch(B, [{ op: "renameSession", name: "Ad" }]);
    expect(n.json).not.toHaveProperty("ids");
  });

  it("silinmiş sayfanın kimliğiyle ekleme yeni sayfa açar (silinmiş sayfa geri alma anahtarıyla döner)", async () => {
    const added = await patch(B, [{ op: "addPage", id: "p_sil" }]);
    const real = added.json.ids.p_sil as string;
    expect((await patch(B, [{ op: "removePage", pageId: real }])).status).toBe(200);
    const again = await patch(B, [{ op: "addPage", id: real }]);
    expect(again.status, again.body).toBe(200);
    expect(again.json.ids[real]).not.toBe(real);
    expect(t.raw.get("SELECT deleted_at IS NOT NULL AS gone FROM print_pages WHERE id = ?", real)).toEqual({ gone: 1 });
  });

  it("aynı yamada iki eklemeye aynı geçici kimlik: id-in-use; hepsi ya da hiçbiri", async () => {
    const twice = await patch(B, [{ op: "addPage", id: "p_iki" }, { op: "addPage", id: "p_iki" }]);
    expect(twice.status).toBe(400);
    expect(twice.json.code).toBe("id-in-use");
    const mixed = await patch(B, [{ op: "addPage", id: "x" }, { op: "addItem", id: "x", pageId: B.page, jobId: B.job, slotId: null, xMm: 5, yMm: 5 }]);
    expect(mixed.json.code).toBe("id-in-use");
    // Düşen yamalarda hiçbir sayfa eklenmedi.
    expect(t.raw.all("SELECT id FROM print_pages WHERE org_id = ? AND session_id = ? AND deleted_at IS NULL", B.org!, B.session)).toHaveLength(1);
  });
});
