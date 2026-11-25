import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY_FILE_NAME } from "./services/secret-box.ts";
import { type TestApp, jsonSetSql, makeApp, png, seedLanguage } from "./test/helpers.ts";
import { isSafeRelative, safeJoin } from "./util/safe-path.ts";

const at = "2026-10-01T00:00:00.000Z";

describe("safeJoin", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("kök altındaki göreli yol kabul; kaçışlar reddedilir", () => {
    const root = path.resolve("/kok");
    expect(safeJoin(root, "referanslar/dil/a.png", { ext: [".png"] })).toBe(path.join(root, "referanslar", "dil", "a.png"));
    expect(safeJoin(root, "A.PNG", { ext: [".png"] })).toBe(path.join(root, "A.PNG"));
    for (const bad of [
      "",
      "..",
      "../a.png",
      "a/../../b.png",
      "a/./b.png",
      "a//b.png",
      "/etc/passwd",
      "C:/Windows/x.png",
      "C:x.png",
      "c:\\x.png",
      "a\\..\\b.png",
      "\\\\sunucu\\pay\\x.png",
      ".ana-anahtar.json.1.tmp",
      "a/.gizli.png",
      "a\u0000.png",
      " a.png",
      "studio.db",
      KEY_FILE_NAME,
      "a.png.db",
    ]) {
      expect(safeJoin(root, bad, { ext: [".png"] }), bad).toBeNull();
      expect(isSafeRelative(bad, { ext: [".png"] }), bad).toBe(false);
    }
    expect(safeJoin(root, 5)).toBeNull();
    expect(safeJoin(root, "studio.db")).toBe(path.join(root, "studio.db")); // uzantı sınırı yoksa ad serbest
  });

  it("simgesel bağ / bağlantı noktasıyla kök dışına çıkış reddedilir", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "safe-path-"));
    const root = path.join(dir, "kok");
    const outside = path.join(dir, "disari");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "gizli.png"), "x");
    // Windows'ta yönetici hakkı istemeyen dizin bağlantısı (junction); öteki sistemlerde dizin bağı.
    symlinkSync(outside, path.join(root, "bag"), "junction");
    expect(safeJoin(root, "bag/gizli.png", { ext: [".png"] })).toBeNull();
    expect(safeJoin(root, "bag/yok/yeni.png", { ext: [".png"] })).toBeNull();
    mkdirSync(path.join(root, "ic"));
    expect(safeJoin(root, "ic/yeni.png", { ext: [".png"] })).toBe(path.join(root, "ic", "yeni.png"));
  });
});

describe("dosya sunan uçlar veri klasörünün dışına (ya da başka dosyasına) çıkmaz", () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });
  const status = async (url: string) => (await t!.api("GET", url)).status;
  /** Veri klasöründeki gizli dosyalar (ana anahtar uygulama açılınca zaten üretilir). */
  const secrets = () => {
    writeFileSync(path.join(t!.dir, "gizli.png"), "GIZLI");
    expect(existsSync(path.join(t!.dir, KEY_FILE_NAME))).toBe(true);
  };
  const refBody = (lang: string, image: string | null) => ({
    languageId: lang,
    source: "figma",
    orderNo: null,
    quantity: null,
    templateKey: "a1",
    labelFramePx: 440,
    text: "Anna",
    user: [{ text: "Anna", family: "Great Vibes", style: "Regular", sizePx: 40, segments: [], ink: { x: 1, y: 1, w: 10, h: 10 } }],
    program: null,
    programMeta: null,
    image,
    split: "train",
  });

  it("referans görseli: istemci yalnız referanslar/<dil>/…png verebilir; kayıttaki kötü değer de sunulmaz", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t);
    secrets();
    for (const image of [KEY_FILE_NAME, "studio.db", "gizli.png", "../../disari.png", `referanslar/${lang}/../../studio.db`, `referanslar/${lang}/../../gizli.png`, `referanslar/${lang}\\..\\..\\gizli.png`, "referanslar/baska/a.png", `referanslar/${lang}/a.jpg`]) {
      const r = await t.api("POST", "/api/references", refBody(lang, image));
      expect(r.status, image).toBe(400);
      expect(r.json.fields?.[0]?.path, image).toBe("image");
    }
    const ok = await t.api("POST", "/api/references", refBody(lang, `referanslar/${lang}/ref.png`));
    expect(ok.status, ok.body).toBe(200);
    expect(await status(`/api/references/${ok.json.id}/image.png`)).toBe(404); // dosya yok
    const refsDir = t.inOrg(() => t!.ctx.paths.references(lang));
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(path.join(refsDir, "ref.png"), await png(8, 8));
    expect(await status(`/api/references/${ok.json.id}/image.png`)).toBe(200);
    expect(await status(`/api/learn/references/${ok.json.id}/thumb.png`)).toBe(200);
    // Eski/kötü kayıt (doğrudan veritabanında): sunan taraf da reddeder.
    for (const image of [KEY_FILE_NAME, "studio.db", "gizli.png", `referanslar/${lang}/../../gizli.png`]) {
      t.raw.run(`UPDATE refs SET data = ${jsonSetSql(t, "data", { image: { text: "?" } })} WHERE id = ?`, image, ok.json.id);
      expect(await status(`/api/references/${ok.json.id}/image.png`), image).toBe(404);
      expect(await status(`/api/learn/references/${ok.json.id}/thumb.png`), image).toBe(404);
    }
  });

  it("şablon görseli: kayıttaki kaçan dosya adı sunulmaz, yazılmaz, silinmez; dil paketi dışarı yazmaz", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t, ["a1"]);
    secrets();
    expect(() => t!.inOrg(() => t!.ctx.templates.upsert(lang, { key: "k1", languageId: lang, file: "../../gizli.png", width: 1, height: 1 }))).toThrow();
    expect(() => t!.inOrg(() => t!.ctx.templates.upsert(lang, { key: "k2", languageId: lang, file: "a1.db", width: 1, height: 1 }))).toThrow();
    for (const file of ["../../gizli.png", "../../../studio.db", `../../../${KEY_FILE_NAME}`]) {
      t.raw.run(`UPDATE templates SET data = ${jsonSetSql(t, "data", { file: { text: "?" } })} WHERE language_id = ? AND key = 'a1'`, file, lang);
      expect(await status(`/api/languages/${lang}/templates/a1/image.png`), file).toBe(404);
      const exp = await t.api("GET", `/api/languages/${lang}/export`);
      expect(exp.status, exp.body).toBe(200);
      expect(exp.json.templates[0].png).toBeNull();
    }
    // Geçici şablon temizliği kayıttaki kaçan yolu silmez.
    t.raw.run(`UPDATE templates SET data = ${jsonSetSql(t, "data", { file: { text: "'../../gizli.png'" }, tags: { json: '["gecici"]' } })}, created_at = '2000-01-01' WHERE key = 'a1'`);
    await t.inOrg(() => t!.ctx.templates.purgeTemporary(0));
    expect(existsSync(path.join(t.dir, "gizli.png"))).toBe(true);

    // Dil paketi içe aktarma: font/şablon adları klasör dışına yazamaz.
    const exp = (await t.api("GET", `/api/languages/${lang}/export`)).json;
    const pngB64 = (await png(8, 8)).toString("base64");
    const imp = await t.api("POST", "/api/languages/import", {
      ...exp,
      name: "Kötü paket",
      templates: [{ record: { key: "z1", file: "../../../disari.png" }, png: pngB64 }, { record: { key: "z2", file: "z2.db" }, png: pngB64 }],
      fonts: [{ file: "../disari.ttf", data: "AAEAAA==" }, { file: "..\\disari2.ttf", data: "AAEAAA==" }],
    });
    expect(imp.status, imp.body).toBe(200);
    const id = imp.json.language.id;
    expect(existsSync(path.join(t.dir, "disari.png"))).toBe(false);
    expect(existsSync(path.join(t.inOrg(() => t!.ctx.paths.language(id)), "disari.ttf"))).toBe(false);
    expect(existsSync(path.join(t.inOrg(() => t!.ctx.paths.templates(id)), "z1.png"))).toBe(true);
    expect(existsSync(path.join(t.inOrg(() => t!.ctx.paths.templates(id)), "z2.png"))).toBe(true);
    expect(existsSync(path.join(t.inOrg(() => t!.ctx.paths.templates(id)), "z2.db"))).toBe(false);
  });

  it("şablon yedeği ve geri yükleme: kayıttaki kaçan ad ve anahtar klasör dışına yazmaz; geçersiz anahtar reddedilir", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t, ["a1"]);
    secrets();
    for (const key of ["../../kacak", "A1", "a/b", "..", ".gizli"]) {
      expect(() => t!.inOrg(() => t!.ctx.templates.upsert(lang, { key, languageId: lang, file: "a1.png", width: 1, height: 1 })), key).toThrow();
    }
    // Geri yükleme: önce gerçek bir yedek, sonra kayıttaki dosya adı bozulur.
    expect(await t.inOrg(() => t!.ctx.templates.backup(lang, "a1"))).toBeTruthy();
    t.raw.run(`UPDATE templates SET data = ${jsonSetSql(t, "data", { file: { text: "'../../../kacak.png'" } })} WHERE key = 'a1'`);
    await expect(t.inOrg(() => t!.ctx.templates.restore(lang, "a1"))).rejects.toThrow();
    expect(existsSync(path.join(t.dir, "kacak.png"))).toBe(false);
    // Yedek: kayıttaki anahtar kaçıyorsa (eski/kötü kayıt) yedek klasör dışına yazılmaz.
    t.raw.run(`UPDATE templates SET key = '../../../kacak', data = ${jsonSetSql(t, "data", { key: { text: "'../../../kacak'" }, file: { text: "'a1.png'" } })} WHERE key = 'a1'`);
    await t.inOrg(() => t!.ctx.templates.backup(lang, "../../../kacak")).catch(() => null);
    expect(readdirSync(t.dir).filter((n) => n.startsWith("kacak"))).toEqual([]);
  });

  it("/api/health disk yolu döndürmez", async () => {
    t = await makeApp();
    const h = await t.api("GET", "/api/health");
    expect(h.status).toBe(200);
    expect(h.json).not.toHaveProperty("dataDir");
    expect(h.body).not.toContain(JSON.stringify(t.dir).slice(1, -1));
    expect(h.body).not.toContain(path.basename(t.dir));
  });

  it("varyasyon önizlemesi ve yazı katmanı: kayıttaki kaçan ad sunulmaz, temizlikte silinmez", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t);
    secrets();
    t.raw.exec(`INSERT INTO batches (org_id, id, language_id, name, created_at) VALUES ('${t.org}', 'b', '${lang}', 'P', '${at}')`);
    t.raw.exec(
      `INSERT INTO jobs (org_id, id, batch_id, seq, raw, text_raw, text, status, issues, run_issues, dedupe_key, created_at, updated_at) VALUES ('${t.org}', 'j', 'b', 1, '{}', 'a', 'a', 'ready', '[]', '[]', 'd', '${at}', '${at}')`,
    );
    const image = JSON.stringify({ textBox: null, readText: null, textLayerFile: "../gizli.png" });
    t.raw.run(`INSERT INTO variants (org_id, id, job_id, no, kind, snapshot, preview_file, image, created_at) VALUES (?, 'v', 'j', 1, 'engine', '{}', '../gizli.png', ?, '${at}')`, t.org, image);
    expect(await status("/api/variants/v/preview.png")).toBe(404);
    expect(await status("/api/variants/v/text-layer.png")).toBe(404);
    t.raw.exec(`UPDATE variants SET deleted_at = '2000-01-01T00:00:00.000Z', base_preview_file = '../gizli.png'`);
    await t.inOrg(() => t!.ctx.undo.purge());
    expect(existsSync(path.join(t.dir, "gizli.png"))).toBe(true);
  });

  it("baskı çıktısı, deneme ve öğrenme önizlemesi, font örneği: kaçış 404/400", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t);
    secrets();
    const files = JSON.stringify([
      { name: "a.png", file: "../../gizli.png", bytes: 1 },
      { name: "b", file: `../../${KEY_FILE_NAME}`, bytes: 1 },
      { name: "c", file: "../../studio.db", bytes: 1 },
    ]);
    t.raw.run(`INSERT INTO print_exports (org_id, id, session_id, format, status, files, created_at) VALUES (?, 'e1', 's', 'png', 'done', ?, '${at}')`, t.org, files);
    for (const i of [0, 1, 2]) expect(await status(`/api/print/exports/e1/files/${i}`), String(i)).toBe(404);
    t.raw.exec(`UPDATE print_exports SET id = '..' WHERE id = 'e1'`);
    t.raw.run(`UPDATE print_exports SET files = ? WHERE id = '..'`, JSON.stringify([{ name: "a.png", file: "gizli.png", bytes: 1 }]));
    expect(await status(`/api/print/exports/../files/0`)).toBe(404);
    expect(await status(`/api/print/exports/%2E%2E/files/0`)).toBe(404);

    for (const url of [
      "/api/trials/..%2F..%2Fgizli/preview.png",
      "/api/learn/previews/..%2F..%2F/gizli.png",
      "/api/learn/previews/..%2F..%2F..%2F/gizli.png",
      "/api/learn/previews/x/..%2F..%2F..%2Fgizli.png",
      `/api/languages/${lang}/fonts/..%2F..%2F..%2Fgizli.png/specimen.png`,
      `/api/languages/${lang}/fonts/..%5C..%5C..%5Cstudio.db/specimen.png`,
    ]) {
      expect([400, 404], url).toContain(await status(url));
    }
    const up = await t.api("POST", `/api/languages/${lang}/fonts`, { fileName: "../disari.ttf", data: "AAEAAA==" });
    expect(up.status).toBe(400);
    expect(existsSync(path.join(t.inOrg(() => t!.ctx.paths.language(lang)), "disari.ttf"))).toBe(false);
  });

  it("derlenmiş arayüz: veri dosyaları ve kaçış istekleri yalnız index.html döner", async () => {
    const tt = await makeApp({
      prepare: (dir) => {
        mkdirSync(path.join(dir, "web-yok", "assets"), { recursive: true });
        writeFileSync(path.join(dir, "web-yok", "index.html"), "<!doctype html><title>Kabuk</title>");
        mkdirSync(path.join(dir, "web-yok-ikiz"), { recursive: true });
        writeFileSync(path.join(dir, "web-yok-ikiz", "gizli.txt"), "GIZLI");
      },
    });
    t = tt;
    for (const url of ["/../studio.db", `/../${KEY_FILE_NAME}`, "/..%2Fstudio.db", "/%2E%2E/web-yok-ikiz/gizli.txt", "/../web-yok-ikiz/gizli.txt", "/..%5Cstudio.db"]) {
      const r = await t.api("GET", url);
      expect(r.body, url).not.toContain("GIZLI");
      expect(r.body, url).not.toContain("SQLite");
      expect(r.body, url).not.toContain("tagpress-ana-anahtar");
    }
  });
});
