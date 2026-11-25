import { FEATURE_KEYS, FEATURES, type FeatureKey, effectiveFeatures, suggestFeatures } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTE_FEATURES, gated } from "./features/route-map.ts";
import { runInOrg } from "./org/context.ts";
import { PENDING_SETUP } from "./services/setup.ts";
import { type TestApp, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";
import { ORG_HEADER, headerResolver } from "./test/two-orgs.ts";

/**
 * B2 — özellik anahtarları ve kurulum (SUNUCU-PLANI §3): uç tablosunun kapsamı, kapalı özellikte yazma/harcama 409
 * (okuma açık), gövdeye bağlı servis denetimleri, bağımlılık zinciri, `always`, kurulum akışı ve iki firmanın ayrılığı.
 * Sahte portlar; AI çağrısı yok.
 */

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const GRID = { paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true, sizeId: "3.8" };
/** Yol parametrelerini doldurur (kapı gövdeden ve kayıttan önce çalışır; kimliğin var olması gerekmez). */
const fill = (path: string, lang = "x") => path.replace(":lang", lang).replace(/:[a-z]+/gi, "x");
const split = (key: string) => {
  const i = key.indexOf(" ");
  return { method: key.slice(0, i) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: key.slice(i + 1) };
};
const featureOff = (r: { status: number; json: { code?: string; feature?: string } | null }, feature: FeatureKey) => r.status === 409 && r.json?.code === "feature-off" && r.json?.feature === feature;

describe("uç tablosu", () => {
  it("Fastify'a kayıtlı bütün uçlar tabloda; tabloda olup kaydı kalkan uç yok", async () => {
    t = await makeApp({ features: "registry" });
    const gate = t.ctx.featureGate!;
    const registered = new Set(gate.registered);
    const own = gate.registered.filter((k) => !(k.startsWith("HEAD ") && registered.has(`GET ${k.slice(5)}`)));
    expect(own.length).toBeGreaterThan(100);
    expect(gate.unmapped, "tabloda olmayan uç (features/route-map.ts)").toEqual([]);
    expect(Object.keys(ROUTE_FEATURES).filter((k) => !registered.has(k)), "tabloda olup kayıtlı olmayan uç").toEqual([]);
    // Okuma uçları GET; GET uçları yazma sayılmaz (kapalı özellikte veri görünür kalır).
    for (const [k, e] of Object.entries(ROUTE_FEATURES)) if (k.startsWith("GET ")) expect(e.access, k).toBe("read");
  });
});

/** Uç düzeyinde kapanan özellikler ve uçları. */
const GATED = new Map<FeatureKey, string[]>();
for (const [k, e] of Object.entries(ROUTE_FEATURES)) if (gated(e)) GATED.set(e.feature, [...(GATED.get(e.feature) ?? []), k]);
const READS = new Map<FeatureKey, string[]>();
for (const [k, e] of Object.entries(ROUTE_FEATURES)) if (e.feature && e.access === "read") READS.set(e.feature, [...(READS.get(e.feature) ?? []), k]);

describe("kapalı özellik: yazma ve harcama 409, okuma açık", () => {
  it("uç düzeyinde kapanan her özellik tabloda (ve `always` olan kapanmaz)", () => {
    expect([...GATED.keys()].sort()).toEqual(
      ["adjust", "image.themeTemplate", "import.json", "jobs.manual", "language.builder", "language.package", "language.rules", "learn", "print", "revise", "templates.editor"].sort(),
    );
  });

  it.each([...GATED.keys()])("%s kapalıyken bütün yazma/harcama uçları 409 feature-off; okuma uçları açık; açınca geçer", async (feature) => {
    t = await makeApp({ ports: fullPorts() });
    const lang = await seedLanguage(t);
    expect((await t.api("PATCH", "/api/features", { [feature]: false })).json.effective[feature]).toBe(false);
    for (const key of GATED.get(feature)!) {
      const { method, path } = split(key);
      const r = await t.api(method, fill(path, lang), method === "DELETE" ? undefined : {});
      expect(featureOff(r, feature), `${key} → ${r.status} ${r.body.slice(0, 200)}`).toBe(true);
    }
    for (const key of READS.get(feature) ?? []) {
      const { path } = split(key);
      const r = await t.api("GET", fill(path, lang));
      expect(r.json?.code, `${key} → ${r.status}`).not.toBe("feature-off");
    }
    expect((await t.api("PATCH", "/api/features", { [feature]: true })).json.effective[feature]).toBe(true);
    for (const key of GATED.get(feature)!) {
      const { method, path } = split(key);
      const r = await t.api(method, fill(path, lang), method === "DELETE" ? undefined : {});
      expect(r.json?.code, `${key} → ${r.status}`).not.toBe("feature-off");
    }
  });

  it("okuma 200: öğrenme, baskı ve kurallar kapalıyken listeler ve sürümler okunur", async () => {
    t = await makeApp({ ports: fullPorts() });
    const lang = await seedLanguage(t);
    await t.api("PATCH", "/api/features", { learn: false, print: false, "language.rules": false });
    for (const url of ["/api/references", "/api/learn/proposals", "/api/print/sessions", `/api/print/templates?languageId=${lang}`, `/api/languages/${lang}/profile/versions`, `/api/languages/${lang}/profile`]) {
      const r = await t.api("GET", url);
      expect(r.status, `${url} → ${r.body.slice(0, 200)}`).toBe(200);
    }
    // Kapalı özellik veri silmez: baskı şablonu kapalıyken kurulan yok, açınca önceki kayıt yerinde.
    await t.api("PATCH", "/api/features", { print: true });
    const g = await t.api("POST", "/api/print/templates/grid", { languageId: lang, name: "Izgara", ...GRID });
    expect(g.status, g.body).toBe(200);
    await t.api("PATCH", "/api/features", { print: false });
    expect((await t.api("GET", `/api/print/templates?languageId=${lang}`)).json.templates.map((x: { id: string }) => x.id)).toEqual([g.json.template.id]);
    expect(featureOff(await t.api("PATCH", `/api/print/templates/${g.json.template.id}`, { name: "Yeni" }), "print")).toBe(true);
  });
});

describe("gövdeye bağlı denetimler (serviste)", () => {
  it("üretim: görüntü kipleri kendi özelliğine bağlı; metin kipi her zaman açık", async () => {
    t = await makeApp({ ports: fullPorts(), features: "registry" });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const jobIds = commit.jobIds as string[];
    const img = await t.api("POST", "/api/generate", { jobIds, mode: "image-on-template" });
    expect(featureOff(img, "image.onTemplate"), img.body).toBe(true);
    const theme = await t.api("POST", "/api/generate", { jobIds, mode: "generated-template", theme: "çiçek" });
    expect(featureOff(theme, "image.themeTemplate"), theme.body).toBe(true);
    expect((await t.api("POST", "/api/generate", { jobIds })).json.queued).toEqual(jobIds);
    await t.ctx.queue.idle();
    await t.api("PATCH", "/api/features", { "image.onTemplate": true });
    expect((await t.api("POST", "/api/generate", { jobIds, mode: "image-on-template" })).json.queued).toEqual(jobIds);
    await t.ctx.queue.idle();
  });

  it("ikinci tasarım dili `language.multi`; ilk dil serbest", async () => {
    t = await makeApp({ features: "registry" });
    expect((await t.api("POST", "/api/languages", { name: "Birinci" })).status).toBe(200);
    const second = await t.api("POST", "/api/languages", { name: "İkinci" });
    expect(featureOff(second, "language.multi"), second.body).toBe(true);
    expect((await t.api("GET", "/api/languages")).json.languages).toHaveLength(1);
    await t.api("PATCH", "/api/features", { "language.multi": true });
    expect((await t.api("POST", "/api/languages", { name: "İkinci" })).status).toBe(200);
  });

  it("`language.multi` kapalıyken silinen dilin geri alınması ikinci canlı dili getirmez (409)", async () => {
    t = await makeApp({ features: "registry" });
    const a = (await t.api("POST", "/api/languages", { name: "A" })).json.id as string;
    const del = await t.api("DELETE", `/api/languages/${a}`);
    expect(del.status, del.body).toBe(200);
    await t.api("PATCH", "/api/features", { "language.multi": true });
    expect((await t.api("POST", "/api/languages", { name: "B" })).status).toBe(200);
    await t.api("PATCH", "/api/features", { "language.multi": false });
    const undo = await t.api("POST", `/api/undo/${del.json.undoToken}`);
    expect(featureOff(undo, "language.multi"), undo.body).toBe(true);
    expect((await t.api("GET", "/api/languages")).json.languages).toHaveLength(1);
  });

  it("sticker sayfa şablonu `print.stickers`; etiket şablonu `print` ile serbest", async () => {
    t = await makeApp({ features: "registry" });
    const lang = await seedLanguage(t);
    const sticker = await t.api("POST", "/api/print/templates/grid", { languageId: lang, kind: "sticker", ...GRID });
    expect(featureOff(sticker, "print.stickers"), sticker.body).toBe(true);
    const label = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...GRID });
    expect(label.status, label.body).toBe(200);
    // Etiket şablonunu sticker'a çevirmek de sticker şablonu yazmaktır.
    expect(featureOff(await t.api("PATCH", `/api/print/templates/${label.json.template.id}`, { kind: "sticker" }), "print.stickers")).toBe(true);
    await t.api("PATCH", "/api/features", { "print.stickers": true });
    expect((await t.api("POST", "/api/print/templates/grid", { languageId: lang, kind: "sticker", ...GRID })).status).toBe(200);
  });
});

describe("özellik görünümü ve açma/kapama", () => {
  it("yeni firma kayıt varsayılanlarıyla; `print.stickers` ↔ `print` bağımlılık zinciri", async () => {
    t = await makeApp({ features: "registry" });
    const v = (await t.api("GET", "/api/features")).json;
    expect(v.registry).toEqual(FEATURE_KEYS.map((k) => FEATURES[k]));
    expect(v.effective).toEqual(effectiveFeatures({}));
    expect(v.explicit).toEqual({});

    // Bağlı olan açılınca bağımlılığı da açılır (önce `print` kapatılır).
    let r = (await t.api("PATCH", "/api/features", { print: false })).json;
    expect([r.effective.print, r.effective["print.stickers"]]).toEqual([false, false]);
    r = (await t.api("PATCH", "/api/features", { "print.stickers": true })).json;
    expect([r.effective.print, r.effective["print.stickers"]]).toEqual([true, true]);
    expect(r.explicit.print).toMatchObject({ on: true, by: "user" });
    // Bağımlılık kapanınca bağlı olan da kapanır (yanıtta yazar).
    r = (await t.api("PATCH", "/api/features", { print: false })).json;
    expect([r.effective.print, r.effective["print.stickers"]]).toEqual([false, false]);
    expect(r.explicit["print.stickers"]).toMatchObject({ on: false, by: "user" });
  });

  it("`always` özellik kapatılamaz; istek bütünüyle reddedilir; geçersiz gövde 400", async () => {
    t = await makeApp({ features: "registry" });
    const bad = await t.api("PATCH", "/api/features", { learn: true, "core.production": false });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("feature-always-on");
    expect((await t.api("GET", "/api/features")).json.explicit).toEqual({});
    expect((await t.api("PATCH", "/api/features", { yok: true })).json.code).toBe("feature-invalid");
    expect((await t.api("PATCH", "/api/features", { learn: "evet" })).status).toBe(400);
    // Açmak serbest (zaten açık), etkin değer değişmez.
    expect((await t.api("PATCH", "/api/features", { "core.production": true })).json.effective["core.production"]).toBe(true);
  });

  it("aynı istekte bir özellik kapanırken ona bağlı olan açılmak istenirse 400 `feature-invalid`, hiçbir şey yazılmaz", async () => {
    t = await makeApp({ features: "registry" });
    const bad = await t.api("PATCH", "/api/features", { print: false, "print.stickers": true });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("feature-invalid");
    expect((await t.api("GET", "/api/features")).json.explicit).toEqual({});
    // Tutarlı istekler geçer: ikisi de kapalı ya da ikisi de açık.
    expect((await t.api("PATCH", "/api/features", { print: false, "print.stickers": false })).status).toBe(200);
    expect((await t.api("PATCH", "/api/features", { print: true, "print.stickers": true })).json.effective["print.stickers"]).toBe(true);
  });

  it("bozuk özellik kaydında geçerli seçimler okunur", async () => {
    t = await makeApp({ features: "registry" });
    t.inOrg(() => t!.ctx.settings.setOrg("features", { learn: { on: true, by: "user", at: "x" }, print: { on: "bozuk" }, yok: 1 }));
    const v = (await t.api("GET", "/api/features")).json;
    expect(v.explicit).toEqual({ learn: { on: true, by: "user", at: "x" } });
    expect(v.effective.learn).toBe(true);
    expect(v.effective.print).toBe(true);
  });
});

describe("kurulum", () => {
  const COMMON = suggestFeatures({ labelTypes: [] });

  it("yeni firma `pending`; önizleme kaydetmez; adım kaydı; bitir; yeniden çalıştır", async () => {
    t = await makeApp({ features: "registry" });
    expect((await t.api("GET", "/api/setup")).json).toEqual(PENDING_SETUP);
    expect((await t.api("GET", "/api/org")).json.setup).toEqual(PENDING_SETUP);

    const p = (await t.api("POST", "/api/setup/preview", { answers: { labelTypes: ["sticker", "wedding"] } })).json;
    expect(p.changes).toEqual([{ key: "print.stickers", from: false, to: true }]);
    expect(p.features["print.stickers"]).toBe(true);
    expect((await t.api("GET", "/api/features")).json.explicit).toEqual({});

    const s1 = (await t.api("PUT", "/api/setup/answers", { step: 2, answers: { labelTypes: ["sticker"] } })).json;
    expect(s1).toMatchObject({ status: "in-progress", step: 2, answers: { labelTypes: ["sticker"] }, completedAt: null });
    expect((await t.api("GET", "/api/setup")).json).toEqual(s1);

    const approved = Object.entries(p.features).filter(([, on]) => on).map(([k]) => k);
    const done = (await t.api("POST", "/api/setup/complete", { answers: { labelTypes: ["sticker"], print: { paperPreset: "a4" } }, features: approved })).json;
    expect(done.setup).toMatchObject({ status: "completed", step: 3, completedAt: t.clock.now().toISOString(), skipped: false });
    expect(done.features.effective).toEqual(p.features);
    expect(done.features.explicit["print.stickers"]).toMatchObject({ on: true, by: "setup" });
    expect((await t.api("GET", "/api/org")).json).toMatchObject({ setup: done.setup, features: done.features });

    // Kullanıcı sonradan elle açar; yeniden çalıştırmada eski cevaplar dolu ve elle açılan önizlemede kapanmaz.
    await t.api("PATCH", "/api/features", { learn: true });
    const re = (await t.api("POST", "/api/setup/restart", {})).json;
    expect(re).toMatchObject({ status: "in-progress", step: 1, answers: { labelTypes: ["sticker"] }, completedAt: null });
    expect((await t.api("GET", "/api/features")).json.effective.learn).toBe(true);
    const p2 = (await t.api("POST", "/api/setup/preview", { answers: { labelTypes: [] } })).json;
    expect(p2.changes).toEqual([{ key: "print.stickers", from: true, to: false }]);
    expect(p2.features.learn).toBe(true);
    // Ürün kararı: kurulum ekranı bütün özellikleri gösterir; onaylanan listede olmayan, elle açılmış olsa da kapanır.
    const done2 = (await t.api("POST", "/api/setup/complete", { answers: { labelTypes: [] }, features: COMMON })).json;
    expect(done2.features.effective.learn).toBe(false);
    expect(done2.features.explicit.learn).toMatchObject({ on: false, by: "setup" });
    expect(done2.features.effective["print.stickers"]).toBe(false);
  });

  it("listede olan, elle açılmış özellik kaydını korur; listede olmayan açık özellik kapanır, `always` kalır", async () => {
    t = await makeApp({ features: "registry" });
    await t.api("PATCH", "/api/features", { learn: true, "image.onTemplate": true });
    await t.api("POST", "/api/setup/restart", {});
    const done = (await t.api("POST", "/api/setup/complete", { answers: { labelTypes: [] }, features: [...COMMON, "learn"] })).json;
    expect(done.features.effective.learn).toBe(true);
    expect(done.features.explicit.learn).toMatchObject({ on: true, by: "user" });
    expect(done.features.effective["image.onTemplate"]).toBe(false);
    expect(done.features.explicit["image.onTemplate"]).toMatchObject({ on: false, by: "setup" });
    expect(done.features.effective["core.production"]).toBe(true);
    expect(done.features.explicit["core.production"]).toBeUndefined();
  });

  it("göçün açtığı özellik listede yoksa kapanır; onaylanan bağlı özellik bağımlılığını açar", async () => {
    t = await makeApp({ features: "registry" });
    const at = t.clock.now().toISOString();
    t.inOrg(() => t!.ctx.features.write({ "image.onTemplate": { on: true, by: "migration", at }, print: { on: false, by: "user", at } }));
    const p = (await t.api("POST", "/api/setup/preview", { answers: { labelTypes: [] } })).json;
    expect(p.changes.find((c: { key: string }) => c.key === "image.onTemplate")).toBeUndefined();
    const done = (await t.api("POST", "/api/setup/complete", { answers: { labelTypes: ["sticker"] }, features: ["print.stickers"] })).json;
    expect(done.features.effective["image.onTemplate"]).toBe(false);
    expect(done.features.explicit["image.onTemplate"]).toMatchObject({ on: false, by: "setup" });
    expect([done.features.effective.print, done.features.effective["print.stickers"]]).toEqual([true, true]);
    // Onaylanmayan, kurulum ya da varsayılanla açık olanlar kapanır; `always` açık kalır.
    expect(done.features.effective["import.json"]).toBe(false);
    expect(done.features.effective["core.production"]).toBe(true);
    expect(done.features.explicit["core.production"]).toBeUndefined();
  });

  it("atla: ortak küme açılır, `skipped: true`", async () => {
    t = await makeApp({ features: "registry" });
    const r = (await t.api("POST", "/api/setup/skip", {})).json;
    expect(r.setup).toMatchObject({ status: "completed", skipped: true, answers: { labelTypes: [] } });
    expect(FEATURE_KEYS.filter((k) => r.features.effective[k])).toEqual(COMMON);
  });

  it("geçersiz cevap 400 `setup-invalid`", async () => {
    t = await makeApp({ features: "registry" });
    expect((await t.api("POST", "/api/setup/preview", { answers: { labelTypes: ["yok"] } })).json.code).toBe("setup-invalid");
    expect((await t.api("PUT", "/api/setup/answers", { step: 4, answers: { labelTypes: [] } })).json.code).toBe("setup-invalid");
    expect((await t.api("POST", "/api/setup/complete", { answers: { labelTypes: [] }, features: ["yok"] })).json.code).toBe("setup-invalid");
    expect((await t.api("GET", "/api/setup")).json).toEqual(PENDING_SETUP);
  });
});

describe("iki firma: özellik ve kurulum durumu firmaya özgü", () => {
  it("A'nın açtığı/kapattığı özellik ve kurulumu B'yi etkilemez", async () => {
    t = await makeApp({ features: "registry", resolver: headerResolver(() => t!.ctx.orgs.defaultOrgId()!) });
    const a = t.org;
    const b = t.ctx.orgs.create({ name: "B" }).id;
    const as = (org: string) => ({ [ORG_HEADER]: org });
    await t.api("PATCH", "/api/features", { learn: true, print: false }, as(a));
    await t.api("POST", "/api/setup/complete", { answers: { labelTypes: ["sticker"] }, features: ["print.stickers", "learn"] }, as(a));
    const vb = (await t.api("GET", "/api/org", undefined, as(b))).json;
    expect(vb.org.id).toBe(b);
    expect(vb.setup).toEqual(PENDING_SETUP);
    expect(vb.features.explicit).toEqual({});
    expect(vb.features.effective).toEqual(effectiveFeatures({}));
    // B'de kapalı olan A'da açık: B'nin yazma ucu 409, A'nınki geçer.
    await t.api("PATCH", "/api/features", { learn: false }, as(b));
    expect(featureOff(await t.api("POST", "/api/learn/proposals", { title: "x" }, as(b)), "learn")).toBe(true);
    expect((await t.api("POST", "/api/learn/proposals", { title: "x" }, as(a))).json?.code).not.toBe("feature-off");
    expect(runInOrg(a, () => t!.ctx.features.isOn("learn"))).toBe(true);
    expect(runInOrg(a, () => t!.ctx.setup.state().status)).toBe("completed");
    expect(runInOrg(b, () => t!.ctx.setup.state().status)).toBe("pending");
  });
});
