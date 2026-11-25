import { printDefaultsFromSetup } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { PRINT_DEFAULTS_KEY } from "./services/setup.ts";
import { type TestApp, makeApp, seedLanguage } from "./test/helpers.ts";

/** Kurulum tamamlanınca baskı cevaplarından varsayılanlar yazılır; yeni ızgara sayfa şablonu kesim ayarını buradan alır. */

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const GRID = { paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true };
const stored = () => t!.raw.get("SELECT value FROM org_settings WHERE org_id = ? AND key = ?", t!.org, PRINT_DEFAULTS_KEY);

describe("kurulumun baskı varsayılanları", () => {
  it("tamamlanınca `print.defaults` yazılır; yeni ızgara şablonu kesim çizgisi, kayıt işareti, taşma ve kesim dosyasını alır", async () => {
    t = await makeApp({ features: "registry" });
    const lang = await seedLanguage(t);
    expect(stored()).toBeUndefined();
    const answers = { labelTypes: ["wedding"], print: { paperPreset: "letter", usesCutter: true, cutter: "plotter", paperType: "precut" } };
    const done = await t.api("POST", "/api/setup/complete", { answers, features: ["print"] });
    expect(done.status, done.body).toBe(200);
    expect(JSON.parse(String(stored()!.value))).toEqual(printDefaultsFromSetup(answers as never));

    const g = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...GRID });
    expect(g.status, g.body).toBe(200);
    expect(g.json.template.cut).toMatchObject({ outlineVisible: false, cutFile: true, bleedMm: 1, registration: { enabled: true, style: "corners-l" } });
    // Şemanın diğer varsayılanları korunur.
    expect(g.json.template.cut.outlineWidthMm).toBeGreaterThan(0);
    expect(g.json.template.cut.registration.insetMm).toBeGreaterThan(0);
  });

  it("atla da standart varsayılanları yazar; kurulum hiç çalışmamış firmada şema varsayılanları geçer", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t);
    // Sahibin firması (kurulum göçle tamam, kayıt yok): şema varsayılanı.
    const g0 = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...GRID });
    expect(g0.json.template.cut).toMatchObject({ outlineVisible: true, cutFile: false, bleedMm: 0, registration: { enabled: false } });
    expect((await t.api("POST", "/api/setup/skip")).status).toBe(200);
    expect(JSON.parse(String(stored()!.value))).toEqual(printDefaultsFromSetup({}));
    // Bozuk kayıt yeni şablonu bozmaz: şema varsayılanına düşer.
    t.raw.run("UPDATE org_settings SET value = ? WHERE org_id = ? AND key = ?", JSON.stringify({ cut: { bleedMm: -5 } }), t.org, PRINT_DEFAULTS_KEY);
    const g1 = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...GRID });
    expect(g1.status, g1.body).toBe(200);
    expect(g1.json.template.cut.bleedMm).toBe(0);
  });
});
