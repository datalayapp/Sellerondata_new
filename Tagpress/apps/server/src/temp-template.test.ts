import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { TemplateItem } from "@tagpress/domain";
import { DAY_MS } from "./util/clock.ts";
import { type TestApp, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

/** "Kalıcı yapma" kapalı temadan şablon: geçici şablon + onu kullanan bir varyasyon. */
async function temporaryVariant(keep: boolean) {
  t = await makeApp({ ports: fullPorts() });
  const lang = await seedLanguage(t);
  const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
  await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "generated-template", theme: "lavanta", keepTemplate: keep });
  await t.ctx.queue.idle();
  const job = (await t.api("GET", `/api/jobs/${commit.jobIds[0]}`)).json;
  const variantId = job.variants[0].id as string;
  const key = (await t.api("GET", `/api/variants/${variantId}`)).json.snapshot.templateKey as string;
  return { lang, jobId: job.id as string, variantId, key };
}

describe("geçici şablon", () => {
  it("'Kalıcı yapma' kapalıysa gecici etiketi alır; sunucu listesi ve id ile çözme sürer (gizleme arayüzde)", async () => {
    const { lang, key } = await temporaryVariant(false);
    const item = (await t.api("GET", `/api/languages/${lang}/templates/${key}`)).json;
    expect(item.template.tags).toEqual(["uretilen", "gecici"]);
    const list = (await t.api("GET", `/api/languages/${lang}/templates`)).json.templates;
    expect(list.map((i: TemplateItem) => i.template.key)).toContain(key);
  });

  it("varyasyon kalıcı silinince kullanılmayan geçici şablon ve dosyası temizlenir; geri al kırılmaz", async () => {
    const { lang, variantId, key } = await temporaryVariant(false);
    const tpl = t.inOrg(() => t.ctx.templates.find(lang, key))!;
    const file = t.inOrg(() => t.ctx.templates.imagePath(lang, tpl));
    t.clock.advance(2 * DAY_MS);

    // Yumuşak silinmiş varyasyon geri alınabilir: şablon durur, geri alınca varyasyon çözülebilir.
    const del = await t.api("DELETE", `/api/variants/${variantId}`);
    await t.inOrg(() => t.ctx.undo.purge());
    expect(t.inOrg(() => t.ctx.templates.find(lang, key))).not.toBeNull();
    expect(existsSync(file)).toBe(true);
    expect((await t.api("POST", `/api/undo/${del.json.undoToken}`)).status).toBe(200);
    expect((await t.api("GET", `/api/variants/${variantId}`)).json.snapshot.templateKey).toBe(key);

    // Silinip süre dolunca (kalıcı silme) şablon da gider.
    await t.api("DELETE", `/api/variants/${variantId}`);
    t.clock.advance(31 * DAY_MS);
    await t.inOrg(() => t.ctx.undo.purge());
    expect(t.inOrg(() => t.ctx.templates.find(lang, key))).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect((await t.api("GET", `/api/languages/${lang}/templates/${key}`)).status).toBe(404);
  });

  it("kullanan başka varyasyon varsa, kalıcı yapılan ya da taze şablon silinmez", async () => {
    const a = await temporaryVariant(false);
    // Başka varyasyon aynı şablonu kullanıyor gibi: iş kaydı şablon anahtarını taşır.
    t.raw.run("UPDATE jobs SET template_key = ? WHERE id = ?", a.key, a.jobId);
    t.clock.advance(2 * DAY_MS);
    await t.api("DELETE", `/api/variants/${a.variantId}`);
    t.clock.advance(31 * DAY_MS);
    await t.inOrg(() => t.ctx.undo.purge());
    expect(t.inOrg(() => t.ctx.templates.find(a.lang, a.key))).not.toBeNull(); // iş hâlâ kullanıyor
    await t.close();

    const k = await temporaryVariant(true); // kalıcı: gecici etiketi yok
    await t.api("DELETE", `/api/variants/${k.variantId}`);
    t.clock.advance(31 * DAY_MS);
    await t.inOrg(() => t.ctx.undo.purge());
    expect(t.inOrg(() => t.ctx.templates.find(k.lang, k.key))).not.toBeNull();
  });
});
