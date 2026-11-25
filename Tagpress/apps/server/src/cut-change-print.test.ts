import { afterEach, describe, expect, it } from "vitest";
import { createPrintPlanner } from "./adapters/print.ts";
import { PRINT_DEFAULTS_KEY } from "./services/setup.ts";
import { type TestApp, TEST_PROFILE, fullPorts, importJobs, jsonSetSql, makeApp, seedLanguage } from "./test/helpers.ts";

/**
 * Kesim incelemesinin bulguları ve baskı takip işleri (2026-11-22 gece):
 * - B1: kesimi değişmiş taslak yeniden planlanmadan basılınca plan sürümü bozulmaz (arşiv bugünkü ölçüyle, yanlış
 *   `printed-old-scale` yok); bayatlık plan sürümünde değil işlerin durumunda.
 * - B2: onaylı varyasyon başka şablonda üretildiyse (`snapshot.templateKey`) onay düşmesi o şablona bakar.
 * - B3: silinmiş onaylı iş kesim değişince onayını kaybeder; geri alınınca "ready" döner.
 * - Liste satırında bildirim kodları, rafta işin kesimi, yeniden planlamada yuva ↔ kesim uyarısı.
 * - `print.stickers` yalnız yeni sticker şablonu yazarken.
 * - Kurulumun kağıdı yeni şablonun varsayılanı.
 */

let t: TestApp;
let lang: string;
const RECT = { shape: "rect" as const, wMm: 63.5, hMm: 38.1 };
const GRID = { paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true };

afterEach(async () => t?.close());

async function start(features?: "registry") {
  t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner() }), startQueue: true, ...(features ? { features } : {}) });
  lang = await seedLanguage(t);
}

async function approved(records: Record<string, unknown>[]): Promise<string[]> {
  const { commit } = await importJobs(t, records);
  await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
  await t.ctx.queue.idle();
  const ap = await t.api("POST", "/api/jobs/approve-best", { ids: commit.jobIds });
  expect(ap.json.approved, ap.body).toHaveLength(commit.jobIds.length);
  return commit.jobIds as string[];
}

const job = (id: string) => t.raw.get("SELECT status, approved_variant_id, run_issues, deleted_at FROM jobs WHERE id = ?", id)!;
const codes = (id: string) => (JSON.parse(String(job(id).run_issues)) as { code: string }[]).map((i) => i.code);
const grid = async (over: Record<string, unknown> = {}) => {
  const r = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...GRID, ...over });
  expect(r.status, r.body).toBe(200);
  return r.json.template as { id: string };
};
const session = async (id: string) => (await t.api("GET", `/api/print/sessions/${id}`)).json;
const noticeCodes = (s: { notices: { code: string }[] }) => s.notices.map((n) => n.code);
const summary = async (id: string, status: "draft" | "printed") =>
  ((await t.api("GET", `/api/print/sessions?languageId=${lang}&status=${status}`)).json.sessions as { id: string; noticeCodes: string[] }[]).find((s) => s.id === id);
const patchTpl = (key: string, body: unknown) => t.api("PATCH", `/api/languages/${lang}/templates/${key}`, body);
const preview = (key: string, body: unknown) => t.api("POST", `/api/languages/${lang}/templates/${key}/cut-preview`, body);

describe("B1: kesimi değişen taslak ve plan sürümü", () => {
  it("yeniden planlanmadan basılınca plan sürümü bugünkü kalır; arşivde eski ölçü uyarısı yok; liste kodları ayrıntıyla aynı", async () => {
    await start();
    const [a] = (await approved([{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const tpl = await grid();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, jobIds: [a] })).json.session;
    expect((await summary(s.id, "draft"))!.noticeCodes).toEqual([]);
    const v0 = s.version;

    expect((await patchTpl("a2", { cut: RECT })).status).toBe(200);
    const d = await session(s.id);
    expect(noticeCodes(d)).toEqual(["plan-stale"]);
    // Bayatlık plan sürümüne yazılmaz; oturumun sürümü de artmaz (masa bildirimleri sürümden bağımsız alır).
    expect(t.raw.get("SELECT plan_version FROM print_sessions WHERE id = ?", s.id)).toEqual({ plan_version: 2 });
    expect(d.version).toBe(v0);
    expect((await summary(s.id, "draft"))!.noticeCodes).toEqual(["plan-stale"]);

    // Onayı düşmüş işi içeren bayat taslak basılabilir (masa önce onay sorar); kayıt doğru kuralla.
    const p = await t.api("POST", `/api/print/sessions/${s.id}/printed`, {});
    expect(p.status, p.body).toBe(200);
    expect(t.raw.get("SELECT status, plan_version FROM print_sessions WHERE id = ?", s.id)).toEqual({ status: "printed", plan_version: 2 });
    expect(p.json.notices).toEqual([]);
    expect((await summary(s.id, "printed"))!.noticeCodes).toEqual([]);
  });

  it("eski ara sürümün 0 işareti bugünkü kural sayılır ve basılınca düzelir", async () => {
    await start();
    const [a] = (await approved([{ siparis: "1", etiket: "a1", adet: 2, text: "Anna" }])) as [string];
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: (await grid()).id, jobIds: [a] })).json.session;
    t.raw.run("UPDATE print_sessions SET plan_version = 0 WHERE id = ?", s.id);
    expect((await session(s.id)).notices).toEqual([]);
    expect((await t.api("POST", `/api/print/sessions/${s.id}/printed`, {})).json.notices).toEqual([]);
    expect(t.raw.get("SELECT plan_version FROM print_sessions WHERE id = ?", s.id)).toEqual({ plan_version: 2 });
  });

  it("yeniden onay: boyutsuz şablonda bayatlık kalkar; boyutlu şablona artık uymuyorsa kalır; yeniden planlama kaldırır", async () => {
    await start();
    const [a, b] = (await approved([
      { siparis: "1", etiket: "a2", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 1, text: "Marco" },
    ])) as [string, string];
    const loose = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: (await grid({ sizeId: null })).id, jobIds: [a] })).json.session;
    const sized = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: (await grid({ sizeId: "3.8" })).id, jobIds: [b] })).json.session;
    expect((await patchTpl("a2", { cut: RECT })).status).toBe(200);
    expect(noticeCodes(await session(loose.id))).toEqual(["plan-stale"]);
    expect(noticeCodes(await session(sized.id))).toEqual(["plan-stale"]);

    expect((await t.api("POST", "/api/jobs/approve-best", { ids: [a, b] })).json.approved).toHaveLength(2);
    expect(noticeCodes(await session(loose.id))).toEqual([]);
    // İşin boyutu artık "63.5x38.1"; "3.8" şablonlu plan onu yeniden planlamada atar.
    const st = await session(sized.id);
    expect(noticeCodes(st)).toEqual(["plan-stale"]);
    const r = await t.api("POST", `/api/print/sessions/${sized.id}/replan`, { version: st.version });
    expect(r.status, r.body).toBe(200);
    expect(r.json.skipped.map((x: { jobId: string }) => x.jobId)).toEqual([b]);
    expect(r.json.session.notices).toEqual([]);
  });
});

describe("B2: varyasyonun etkin şablonu (snapshot.templateKey)", () => {
  it("onay düşmesi, önizleme sayısı, raf kesimi ve dil kesimi varyasyonun şablonuna bakar", async () => {
    await start();
    // a2'nin kendi kesimi var; a1 kesimsiz (dilin kesimi).
    expect((await patchTpl("a2", { cut: RECT })).status).toBe(200);
    const [x] = (await approved([{ siparis: "1", etiket: "a2", adet: 2, text: "Anna" }])) as [string];
    const vid = String(job(x).approved_variant_id);
    // Temadan şablon üretme akışı: varyasyon a1'de üretildi, işin template_key'i a2 kaldı.
    t.raw.run(`UPDATE variants SET snapshot = ${jsonSetSql(t, "snapshot", { templateKey: { text: "'a1'" } })} WHERE id = ?`, vid);

    // Raf: etkin şablon a1 (kesimsiz) → kesim yok, eski boyut.
    const shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items.find((i: { jobId: string }) => i.jobId === x);
    expect(shelf.cut).toBeUndefined();
    expect(shelf.sizeId).toBe("3.8");

    // İşin kendi şablonu (a2) değişir: onay düşmez, önizleme 0.
    expect((await preview("a2", { cut: { ...RECT, wMm: 50 } })).json).toEqual({ changed: true, approvals: 0 });
    expect((await patchTpl("a2", { cut: { ...RECT, wMm: 50 } })).status).toBe(200);
    expect(job(x).status).toBe("approved");

    // Varyasyonun şablonu (a1) değişir: önizleme 1, onay düşer, uyarıda a1.
    expect((await preview("a1", { cut: RECT })).json).toEqual({ changed: true, approvals: 1 });
    expect((await patchTpl("a1", { cut: RECT })).status).toBe(200);
    expect(job(x).status).toBe("ready");
    expect(JSON.parse(String(job(x).run_issues))[0]).toMatchObject({ code: "template-cut-changed", params: { template: "a1" } });
  });

  it("raf kesimi varyasyonun şablonundan; tasarım dili kesimi değişince kesimsiz etkin şablonun işi düşer", async () => {
    await start();
    expect((await patchTpl("a1", { cut: RECT })).status).toBe(200);
    // İş a2'de (kesimsiz) ama varyasyon a1'de (kesimli) üretildi.
    const [x, y] = (await approved([
      { siparis: "1", etiket: "a2", adet: 2, text: "Anna" },
      { siparis: "2", etiket: "a1", adet: 2, text: "Ece" },
    ])) as [string, string];
    t.raw.run(`UPDATE variants SET snapshot = ${jsonSetSql(t, "snapshot", { templateKey: { text: "'a1'" } })} WHERE id = ?`, String(job(x).approved_variant_id));
    // y: iş a1'de (kesimli), varyasyon a2'de (kesimsiz).
    t.raw.run(`UPDATE variants SET snapshot = ${jsonSetSql(t, "snapshot", { templateKey: { text: "'a2'" } })} WHERE id = ?`, String(job(y).approved_variant_id));
    const items = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items as { jobId: string; cut?: unknown; sizeId: string }[];
    expect(items.find((i) => i.jobId === x)).toMatchObject({ cut: { shape: "rect", wMm: 63.5, hMm: 38.1 }, sizeId: "63.5x38.1" });
    expect(items.find((i) => i.jobId === y)!.cut).toBeUndefined();

    expect((await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data: { ...TEST_PROFILE, output: { cut: { kind: "circle", cx: 220, cy: 220, r: 200 } } } })).status).toBe(200);
    expect((await t.api("POST", `/api/languages/${lang}/profile/publish`, {})).status).toBe(200);
    expect(job(x).status).toBe("approved"); // etkin şablonu kesimli
    expect(job(y).status).toBe("ready"); // etkin şablonu kesimsiz
  });
});

describe("B3: silinmiş onaylı iş", () => {
  it("kesim değişince silinmiş işin de onayı düşer; geri alınınca 'ready' ve uyarılı döner; önizleme yalnız görünenleri sayar", async () => {
    await start();
    const [a, b] = (await approved([
      { siparis: "1", etiket: "a2", adet: 2, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 2, text: "Marco" },
    ])) as [string, string];
    const del = await t.api("POST", "/api/jobs/delete", { ids: [a] });
    expect(del.status, del.body).toBe(200);
    expect((await preview("a2", { cut: RECT })).json).toEqual({ changed: true, approvals: 1 });
    expect((await patchTpl("a2", { cut: RECT })).status).toBe(200);
    expect(job(b).status).toBe("ready");
    const u = await t.api("POST", `/api/undo/${del.json.undoToken}`, {});
    expect(u.status, u.body).toBe(200);
    expect(job(a)).toMatchObject({ status: "ready", approved_variant_id: null, deleted_at: null });
    expect(codes(a)).toEqual(["template-cut-changed"]);
  });
});

describe("yeniden planlamada yuva ↔ kesim", () => {
  it("kesimli etiket boyutsuz daire şablonunda: oturum kurma ve yeniden planlama aynı görünür uyarıyı verir (engellemez)", async () => {
    await start();
    expect((await patchTpl("a2", { cut: RECT })).status).toBe(200);
    const [a] = (await approved([{ siparis: "77", etiket: "a2", adet: 1, text: "Anna" }])) as [string];
    const round = await grid({ sizeId: null });
    const c = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: round.id, jobIds: [a] });
    expect(c.status, c.body).toBe(200);
    const warn = (ws: string[]) => ws.filter((w) => w.startsWith("77:") && w.includes("yuvası"));
    expect(warn(c.json.warnings)).toHaveLength(1);
    const r = await t.api("POST", `/api/print/sessions/${c.json.session.id}/replan`, { version: c.json.session.version });
    expect(r.status, r.body).toBe(200);
    expect(warn(r.json.warnings)).toEqual(warn(c.json.warnings));
    // Boyutlu şablonda boyut farkı hata deseni: atlanır.
    const sized = await grid({ sizeId: "3.8" });
    const s = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: sized.id, jobIds: [a] });
    expect(s.json.code).toBe("session-no-matching-jobs");
  });
});

describe("print.stickers yalnız yeni sticker şablonu yazarken (B2 incelemesi 3)", () => {
  it("açıkken kurulan sticker şablonu kapatınca: oturum açma, yeniden adlandırma, arşivleme, yeniden basma serbest; yeni sticker şablonu 409", async () => {
    await start("registry");
    expect((await t.api("PATCH", "/api/features", { print: true, "print.stickers": true })).json.effective["print.stickers"]).toBe(true);
    await approved([{ siparis: "5", etiket: "", adet: 2, text: "Teşekkürler", urun: "Oyster" }]);
    const tpl = await t.api("POST", "/api/print/templates", {
      languageId: lang,
      name: "Sticker A4",
      kind: "sticker",
      sizeId: "istiridye",
      paper: { wMm: 210, hMm: 297 },
      stickerFlow: { marginTopMm: 7.8, marginBottomMm: 8.5, marginSideMm: 7, minGapXMm: 5.3, minRowGapMm: 4.6, maxRowGapLastMm: 6.4 },
    });
    expect(tpl.status, tpl.body).toBe(200);
    const sg = await t.api("POST", "/api/print/templates/grid", { languageId: lang, kind: "sticker", ...GRID });
    expect(sg.status, sg.body).toBe(200);
    const label = await grid();

    expect((await t.api("PATCH", "/api/features", { "print.stickers": false })).json.effective["print.stickers"]).toBe(false);
    const off = (r: { status: number; json: { code?: string; feature?: string } }) => r.status === 409 && r.json.code === "feature-off" && r.json.feature === "print.stickers";

    const s = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.json.id });
    expect(s.status, s.body).toBe(200);
    expect((await t.api("PATCH", `/api/print/templates/${tpl.json.id}`, { name: "Yeni ad" })).status).toBe(200);
    expect((await t.api("POST", `/api/print/templates/${sg.json.template.id}/archive`, { archived: true })).status).toBe(200);
    // Basılmış oturumun şablonu sonra değişti → yeniden basım anlık kopyayı (sticker) arşivli şablon olarak geri getirir.
    expect((await t.api("POST", `/api/print/sessions/${s.json.session.id}/printed`, {})).status).toBe(200);
    expect((await t.api("PATCH", `/api/print/templates/${tpl.json.id}`, { paper: { wMm: 200, hMm: 290 } })).status).toBe(200);
    const re = await t.api("POST", `/api/print/sessions/${s.json.session.id}/reprint`, {});
    expect(re.status, re.body).toBe(200);
    expect(re.json.pages[0].templateId).not.toBe(tpl.json.id);

    // Yeni sticker şablonu yazmak: oluşturma, ızgara, çoğaltma, etiket şablonunu sticker'a çevirme.
    expect(off(await t.api("POST", "/api/print/templates", { languageId: lang, name: "S2", kind: "sticker" }))).toBe(true);
    expect(off(await t.api("POST", "/api/print/templates/grid", { languageId: lang, kind: "sticker", ...GRID }))).toBe(true);
    expect(off(await t.api("POST", `/api/print/templates/${tpl.json.id}/duplicate`, {}))).toBe(true);
    expect(off(await t.api("PATCH", `/api/print/templates/${label.id}`, { kind: "sticker" }))).toBe(true);
  });
});

describe("kurulumun kağıdı", () => {
  it("kağıt verilmeyen yeni şablon kurulumun kağıdını alır (yoksa A4); kesim alanları kurulum varsayılanının üstüne", async () => {
    await start();
    const a4 = await t.api("POST", "/api/print/templates", { languageId: lang, name: "Boş" });
    expect(a4.status, a4.body).toBe(200);
    expect(a4.json.paper).toEqual({ wMm: 210, hMm: 297 });
    const done = await t.api("POST", "/api/setup/complete", { answers: { labelTypes: ["wedding"], print: { paperPreset: "letter", usesCutter: true, cutter: "plotter" } }, features: ["print"] });
    expect(done.status, done.body).toBe(200);
    const stored = JSON.parse(String(t.raw.get("SELECT value FROM org_settings WHERE org_id = ? AND key = ?", t.org, PRINT_DEFAULTS_KEY)!.value));
    const letter = await t.api("POST", "/api/print/templates", { languageId: lang, name: "Mektup", cut: { bleedMm: 2 } });
    expect(letter.status, letter.body).toBe(200);
    expect(letter.json.paper).toEqual(stored.paper);
    expect(letter.json.paper).not.toEqual({ wMm: 210, hMm: 297 });
    expect(letter.json.cut).toMatchObject({ bleedMm: 2, cutFile: true, registration: { enabled: true } });
    // Açık kağıt kurulumu ezmez.
    expect((await t.api("POST", "/api/print/templates", { languageId: lang, name: "A5", paper: { wMm: 148, hMm: 210 } })).json.paper).toEqual({ wMm: 148, hMm: 210 });
  });
});
