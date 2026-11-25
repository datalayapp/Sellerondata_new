import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestApp, makeApp, seedLanguage } from "./test/helpers.ts";
import { ORG_HEADER, headerResolver } from "./test/two-orgs.ts";

/** `POST /api/languages` `copyFrom`: kaynak çözülemezse yarım dil satırı kalmaz (önce doğrulama, sonra tek işlem). */

let t: TestApp;
let lang: string;

const counts = () => ({
  languages: t.raw.all("SELECT id FROM languages").length,
  profiles: t.raw.all("SELECT id FROM profile_versions").length,
  orphans: t.raw.all("SELECT p.id FROM profile_versions p LEFT JOIN languages l ON l.id = p.language_id WHERE l.id IS NULL").length,
});

beforeEach(async () => {
  t = await makeApp({ resolver: headerResolver(() => t.ctx.orgs.defaultOrgId()!) });
  lang = await seedLanguage(t);
});
afterEach(async () => t.close());

describe("dil oluşturma: kopya kaynağı", () => {
  it("bilinmeyen dilden kopya 404 verir, hiçbir satır kalmaz; dil listesi değişmez", async () => {
    const before = counts();
    const list = (await t.api("GET", "/api/languages")).json.languages;
    const r = await t.api("POST", "/api/languages", { name: "Kopya", copyFrom: "yok-boyle-dil" });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("language-not-found");
    expect(counts()).toEqual(before);
    expect((await t.api("GET", "/api/languages")).json.languages).toEqual(list);
  });

  it("başka firmanın dilinden kopya da 404, yarım satır yok", async () => {
    const orgB = t.ctx.orgs.create({ name: "B" }).id;
    const before = counts();
    const r = await t.api("POST", "/api/languages", { name: "Kopya", copyFrom: lang }, { [ORG_HEADER]: orgB });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("language-not-found");
    expect(counts()).toEqual(before);
    expect(t.raw.all("SELECT id FROM languages WHERE org_id = ?", orgB)).toEqual([]);
  });

  it("geçerli kopya: profil kaynaktan, yeni ad; varsayılan dil değişmez", async () => {
    const r = await t.api("POST", "/api/languages", { name: "Kopya", copyFrom: lang });
    expect(r.status, r.body).toBe(200);
    const p = (await t.api("GET", `/api/languages/${r.json.id}/profile`)).json;
    expect(p.data.name).toBe("Kopya");
    expect(p.data.lineBreaking).toEqual((await t.api("GET", `/api/languages/${lang}/profile`)).json.data.lineBreaking);
    expect(r.json.isDefault).toBe(false);
    expect(counts().orphans).toBe(0);
  });

  it("geçersiz profille oluşturma da yarım satır bırakmaz (tek işlem)", async () => {
    const before = counts();
    expect(() => t.inOrg(() => t.ctx.languages.create({ name: "Bozuk", profile: { sizing: { fill: "çok" } } }))).toThrow();
    expect(counts()).toEqual(before);
  });
});
