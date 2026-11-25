import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestApp, makeApp, png, seedLanguage } from "./test/helpers.ts";
import type { ApiError, Issue, Language, ProfileVersionSummary, Template } from "@tagpress/domain";
import { isUuidv7 } from "./util/ids.ts";
type FieldError = NonNullable<ApiError["fields"]>[number];

describe("tasarım dilleri", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  it("hiç dil yokken: liste boş, içe aktarma açık mesaj verir; yeni dil v1 yayınlanmış ve varsayılan olur", async () => {
    expect((await t.api("GET", "/api/languages")).json.languages).toEqual([]);
    const none = await t.api("POST", "/api/import/preview", { content: '[{"text":"a"}]' });
    expect(none.status).toBe(409);
    expect(none.json.error).toMatch(/tasarım dili/);
    const c = await t.api("POST", "/api/languages", { name: "Gökçe'nin Dili" });
    expect(c.status, c.body).toBe(200);
    // Yeni dilin kimliği UUIDv7 (addan türetilmez: firmalar birbirinin dil adlarını kimlikten çıkaramaz).
    const first: string = c.json.id;
    expect(isUuidv7(first)).toBe(true);
    expect(c.json).toMatchObject({ name: "Gökçe'nin Dili", activeVersion: 1, hasDraft: false, isDefault: true });
    expect(existsSync(t.inOrg(() => t.ctx.paths.templates(first)))).toBe(true);
    const c2 = await t.api("POST", "/api/languages", { name: "Gökçe'nin Dili", copyFrom: first });
    const second: string = c2.json.id;
    expect(isUuidv7(second)).toBe(true);
    expect(second).not.toBe(first);
    expect(c2.json).toMatchObject({ name: "Gökçe'nin Dili", activeVersion: 1, isDefault: false });
    // API'den gelen kimlik yok sayılır (her zaman UUIDv7): yanıt, istenen kimliğin başka firmada dolu olup olmadığını
    // ele vermesin. Okunabilir kimlik yalnız sunucu içi güvenilir yolla (sahibin aktarım paketi) korunur.
    const e1 = (await t.api("POST", "/api/languages", { name: "Elle", id: "elle" })).json.id;
    const e2 = (await t.api("POST", "/api/languages", { name: "Elle", id: "elle" })).json.id;
    expect([isUuidv7(e1), isUuidv7(e2), e1 !== e2]).toEqual([true, true, true]);
    await t.api("POST", `/api/languages/${second}/default`);
    expect((await t.api("GET", "/api/languages")).json.languages.find((l: Language) => l.isDefault).id).toBe(second);
    const ren = await t.api("PATCH", `/api/languages/${second}`, { name: "İkinci" });
    expect(ren.json.name).toBe("İkinci");
    const del = await t.api("DELETE", `/api/languages/${second}`);
    expect((await t.api("GET", "/api/languages")).json.languages.map((l: Language) => l.id)).toEqual([first, e1, e2]);
    await t.api("POST", `/api/undo/${del.json.undoToken}`);
    expect((await t.api("GET", "/api/languages")).json.languages.map((l: Language) => l.id)).toEqual([first, second, e1, e2]);
  });
});

describe("profil taslak / yayın / geri al", () => {
  let t: TestApp;
  let lang: string;
  beforeEach(async () => {
    t = await makeApp();
    lang = await seedLanguage(t);
  });
  afterEach(() => t.close());

  it("geçersiz taslak kaydedilmez, alan yolları döner", async () => {
    const r = await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data: { name: "x", sizing: { fill: 5 }, lineBreaking: { maxLines: -1 } } });
    expect(r.status).toBe(400);
    expect(r.json.fields.map((f: FieldError) => f.path).sort()).toEqual(["lineBreaking.maxLines", "sizing.fill"]);
    expect((await t.api("GET", `/api/languages/${lang}/profile/draft`)).json).toBeNull();
  });

  it("taslak → yayın → etkin; fark; geri alma yeni sürüm oluşturur", async () => {
    const active = (await t.api("GET", `/api/languages/${lang}/profile`)).json;
    expect(active.version).toBe(1);
    const data = { ...active.data, sizing: { ...active.data.sizing, fill: 0.8 } };
    const d = await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data, note: "doluluk" });
    expect(d.json).toMatchObject({ version: 2, status: "draft" });
    // Taslak etkin değildir.
    expect((await t.api("GET", `/api/languages/${lang}/profile`)).json.version).toBe(1);
    const pub = await t.api("POST", `/api/languages/${lang}/profile/publish`, {});
    expect(pub.json).toMatchObject({ version: 2, status: "published", note: "doluluk" });
    expect((await t.api("GET", `/api/languages/${lang}/profile`)).json.data.sizing.fill).toBe(0.8);
    const diff = await t.api("GET", `/api/languages/${lang}/profile/diff?from=1&to=2`);
    expect(diff.json.changes).toEqual([{ path: "sizing.fill", from: 0.9, to: 0.8 }]);
    const rev = await t.api("POST", `/api/languages/${lang}/profile/revert`, { version: 1 });
    expect(rev.json).toMatchObject({ version: 3, status: "published" });
    expect((await t.api("GET", `/api/languages/${lang}/profile`)).json.data.sizing.fill).toBe(0.9);
    const versions = (await t.api("GET", `/api/languages/${lang}/profile/versions`)).json.versions;
    expect(versions.map((v: ProfileVersionSummary) => [v.version, v.active])).toEqual([[3, true], [2, false], [1, false]]);
    expect((await t.api("POST", `/api/languages/${lang}/profile/publish`, {})).status).toBe(409);
  });

  it("yayınlanan profil işlerin sorunlarını yeniden hesaplar", async () => {
    const m = await t.api("POST", "/api/jobs/manual", { text: "Anna", templateKey: "a1", labelSize: "9.9", orderNo: "1", quantity: 1 });
    expect(m.json.issues.map((i: Issue) => i.code)).toEqual(["size-unknown"]);
    const active = (await t.api("GET", `/api/languages/${lang}/profile`)).json;
    const sizes = [...active.data.output.sizes, { id: "9.9", cm: 9.9, framePx: 1100 }];
    await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data: { ...active.data, output: { ...active.data.output, sizes } } });
    await t.api("POST", `/api/languages/${lang}/profile/publish`, {});
    expect((await t.api("GET", `/api/jobs/${m.json.id}`)).json.issues).toEqual([]);
    await t.api("POST", `/api/languages/${lang}/profile/revert`, { version: 1 });
    expect((await t.api("GET", `/api/jobs/${m.json.id}`)).json.issues.map((i: Issue) => i.code)).toEqual(["size-unknown"]);
  });

  it("taslak açıkken geri alma yapılırsa taslak yayınlandığında yine en yüksek sürüm olur", async () => {
    const active = (await t.api("GET", `/api/languages/${lang}/profile`)).json;
    await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data: { ...active.data, description: "taslak" } });
    await t.api("POST", `/api/languages/${lang}/profile/revert`, { version: 1 });
    const pub = await t.api("POST", `/api/languages/${lang}/profile/publish`, {});
    expect((await t.api("GET", `/api/languages/${lang}/profile`)).json).toMatchObject({ version: pub.json.version, data: { description: "taslak" } });
  });
});

describe("şablon kayıtları", () => {
  let t: TestApp;
  let lang: string;
  beforeEach(async () => {
    t = await makeApp();
    lang = await seedLanguage(t, ["a1"]);
  });
  afterEach(() => t.close());

  it("kısmi güncelleme ölçülmüş/bilinmeyen alanları ASLA düşürmez", async () => {
    // Ölçülmüş ve bilinmeyen alanlar (aktarımdan gelen imageBox gibi).
    t.inOrg(() =>
      t.ctx.templates.upsert(lang, {
        ...t.ctx.templates.find(lang, "a1"),
        textCenter: { x: 0.5, y: 0.41 },
        provenance: [{ field: "textCenter", source: "measured", samples: 12, at: "2026-01-01" }],
        imageBox: { x: 1, y: 2, w: 3, h: 4 },
        decoration: { source: "alpha", threshold: 20, dilatePx: 4 },
      }),
    );
    const r = await t.api("PATCH", `/api/languages/${lang}/templates/a1`, { notes: "çelenk", decoration: { threshold: 25 } });
    expect(r.status, r.body).toBe(200);
    const tpl = r.json.template;
    expect(tpl).toMatchObject({ notes: "çelenk", textCenter: { x: 0.5, y: 0.41 }, imageBox: { x: 1, y: 2, w: 3, h: 4 }, decoration: { source: "alpha", threshold: 25, dilatePx: 4 } });
    expect(tpl.provenance[0]).toMatchObject({ field: "textCenter", source: "measured", samples: 12 });
    expect(tpl.provenance.slice(1).map((p: Template["provenance"][number]) => [p.field, p.source])).toEqual([["notes", "user"], ["decoration", "user"]]);
    // Alan türü değişince eski şeklin alanları taşınmaz.
    const area = await t.api("PATCH", `/api/languages/${lang}/templates/a1`, { area: { mode: "manual", shape: { kind: "circle", cx: 0.5, cy: 0.5, r: 0.3 } } });
    expect(area.json.template.area).toEqual({ mode: "manual", shape: { kind: "circle", cx: 0.5, cy: 0.5, r: 0.3 } });
    const bad = await t.api("PATCH", `/api/languages/${lang}/templates/a1`, { ribbonTop: 3, width: 1 });
    expect(bad.status).toBe(400);
    expect(bad.json.fields.map((f: FieldError) => f.path)).toEqual(["width"]);
    const bad2 = await t.api("PATCH", `/api/languages/${lang}/templates/a1`, { ribbonTop: 3 });
    expect(bad2.json.fields[0].path).toBe("ribbonTop");
  });

  it("dosyası kaybolan şablon silinmez, 'dosya eksik' olur; dosya dönünce düzelir", async () => {
    await t.api("PATCH", `/api/languages/${lang}/templates/a1`, { notes: "korunmalı" });
    const file = path.join(t.inOrg(() => t.ctx.paths.templates(lang)), "a1.png");
    renameSync(file, `${file}.bak`);
    const s = await t.api("POST", `/api/languages/${lang}/templates/sync`);
    expect(s.json.missing).toEqual(["a1"]);
    const item = (await t.api("GET", `/api/languages/${lang}/templates/a1`)).json;
    expect(item).toMatchObject({ fileMissing: true, template: { notes: "korunmalı" } });
    expect((await t.api("GET", `/api/languages/${lang}/templates/a1/image.png`)).status).toBe(404);
    renameSync(`${file}.bak`, file);
    await t.api("POST", `/api/languages/${lang}/templates/sync`);
    expect((await t.api("GET", `/api/languages/${lang}/templates/a1`)).json).toMatchObject({ fileMissing: false, template: { notes: "korunmalı" } });
  });

  it("PNG yükleme: üzerine yazmadan önce yedek; aynı özet yazılmaz; geri yükleme", async () => {
    const before = t.inOrg(() => t.ctx.templates.find(lang, "a1"))!.hash;
    const up = await t.api("POST", `/api/languages/${lang}/templates`, { fileName: "a1.png", png: (await png(60, 60)).toString("base64") });
    expect(up.status, up.body).toBe(200);
    expect(up.json.template).toMatchObject({ width: 60, height: 60 });
    expect(t.inOrg(() => t.ctx.templates.backups(lang, "a1"))).toHaveLength(1);
    const restored = await t.inOrg(() => t.ctx.templates.restore(lang, "a1"));
    expect(restored.restored).toMatch(/^a1-/);
    expect(t.inOrg(() => t.ctx.templates.find(lang, "a1"))!.hash).toBe(before);
    const notPng = await t.api("POST", `/api/languages/${lang}/templates`, { fileName: "x.png", png: Buffer.from("merhaba").toString("base64") });
    expect(notPng.status).toBe(400);
    const img = await t.api("GET", `/api/languages/${lang}/templates/a1/image.png`);
    expect(img.headers["content-type"]).toBe("image/png");
  });

  it("templates paketi bağlı değilse bindirme 501", async () => {
    expect((await t.api("GET", `/api/languages/${lang}/templates/a1/overlay.png`)).status).toBe(501);
  });
});
