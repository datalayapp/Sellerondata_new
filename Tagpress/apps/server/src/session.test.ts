import type { ServerEvent } from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestApp, makeApp, seedLanguage } from "./test/helpers.ts";

describe("tasarım dili oturumu (beceri + MCP günlüğü)", () => {
  let t: TestApp;
  let lang: string;
  let events: ServerEvent[];
  beforeEach(async () => {
    t = await makeApp();
    lang = await seedLanguage(t);
    events = [];
    t.ctx.events.subscribe((e) => events.push(e));
  });
  afterEach(() => t.close());

  it("oturum yokken boş; girdi oturumu açar, durum girdi türünden çıkar; SSE 'session' yayınlanır", async () => {
    const empty = await t.api("GET", `/api/languages/${lang}/design-session`);
    expect(empty.json).toEqual({ id: null, title: "", status: "idle", startedAt: null, updatedAt: null, entries: [] });

    const q = await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "question", group: "satır bölme", text: "İsim her zaman kendi satırında mı?" });
    expect(q.status, q.body).toBe(200);
    expect(q.json).toMatchObject({ kind: "question", group: "satır bölme" });
    expect(events.some((e) => e.type === "session" && e.languageId === lang)).toBe(true);
    let s = (await t.api("GET", `/api/languages/${lang}/design-session`)).json;
    expect(s.status).toBe("asking");
    expect(s.entries).toHaveLength(1);

    await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "answer", group: "satır bölme", text: "Evet." });
    await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "trial", text: "Motor denemesi: ±%10 50/78" });
    s = (await t.api("GET", `/api/languages/${lang}/design-session`)).json;
    expect(s.status).toBe("trying");
    expect(s.entries.map((e: { kind: string }) => e.kind)).toEqual(["question", "answer", "trial"]);

    // Not durumu değiştirmez; açık durum verilirse değişir. Bitmiş oturuma yeni girdi yeni oturum açar.
    await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "note", text: "bitti", status: "done" });
    expect((await t.api("GET", `/api/languages/${lang}/design-session`)).json.status).toBe("done");
    t.clock.advance(1000);
    await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "note", text: "yeni tur" });
    s = (await t.api("GET", `/api/languages/${lang}/design-session`)).json;
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].text).toBe("yeni tur");
  });

  it("geçersiz girdi 400; bilinmeyen dil 404", async () => {
    expect((await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "x", text: "a" })).status).toBe(400);
    expect((await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "note", text: "  " })).status).toBe(400);
    expect((await t.api("GET", `/api/languages/yok/design-session`)).status).toBe(404);
  });

  it("taslak yazımı (MCP taslak_yaz): eski yolla (figma.frameName) gelen değer yeni alana yazılır; tabanda alan olsa da yama kazanır", async () => {
    expect(t.inOrg(() => t.ctx.profiles.activeProfile(lang)).profile.printing.orderNamePattern).toBe("{orderNo}_{quantity}adet");
    const r = await t.api("POST", `/api/languages/${lang}/design-session/draft`, { patch: { figma: { frameName: "{orderNo}-{template}" } }, note: "eski yol" });
    expect(r.status, r.body).toBe(200);
    expect(r.json.draft.data.printing.orderNamePattern).toBe("{orderNo}-{template}");
    expect(r.json.draft.data).not.toHaveProperty("figma");
    expect(r.json.changes).toEqual([{ path: "printing.orderNamePattern", from: "{orderNo}_{quantity}adet", to: "{orderNo}-{template}" }]);
    // Yeni yolla da aynı (ve tabandaki eski değer üstüne yazılır).
    const r2 = await t.api("POST", `/api/languages/${lang}/design-session/draft`, { patch: { printing: { orderNamePattern: "{seq}" } } });
    expect(r2.json.draft.data.printing.orderNamePattern).toBe("{seq}");
  });

  it("taslak yazımı: kısmi yama derin birleşir, geçersizse alan yollarıyla 400 ve hiçbir şey kaydedilmez; başarılıysa 'draft-write' girdisi", async () => {
    const bad = await t.api("POST", `/api/languages/${lang}/design-session/draft`, { patch: { sizing: { fill: 5 } } });
    expect(bad.status).toBe(400);
    expect(bad.json.fields.map((f: { path: string }) => f.path)).toEqual(["sizing.fill"]);
    expect((await t.api("GET", `/api/languages/${lang}/profile/draft`)).json).toBeNull();

    const ok = await t.api("POST", `/api/languages/${lang}/design-session/draft`, {
      patch: { sizing: { fill: 0.92 }, lineBreaking: { examples: [{ text: "Laurea Giulia", lines: ["Laurea", "Giulia"] }] }, ai: { instructions: "zarif" } },
      note: "Satır bölme ve doluluk",
    });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json.draft.status).toBe("draft");
    expect(ok.json.draft.data.sizing.fill).toBe(0.92);
    // Dokunulmayan alanlar korunur.
    expect(ok.json.draft.data.lineBreaking.maxLineChars).toBe(20);
    expect(ok.json.changes.map((c: { path: string }) => c.path).sort()).toEqual(["ai.instructions", "lineBreaking.examples", "sizing.fill"]);
    expect(events.some((e) => e.type === "profile")).toBe(true);
    const s = (await t.api("GET", `/api/languages/${lang}/design-session`)).json;
    expect(s.status).toBe("drafting");
    expect(s.entries.at(-1)).toMatchObject({ kind: "draft-write", text: "Satır bölme ve doluluk" });
    expect(s.entries.at(-1).paths.sort()).toEqual(["ai.instructions", "lineBreaking.examples", "sizing.fill"]);

    // İkinci yama taslağın üstüne yazar (yayınlanmış profile değil).
    const second = await t.api("POST", `/api/languages/${lang}/design-session/draft`, { patch: { sizing: { maxCapHeight: 0.15 } } });
    expect(second.json.draft.data.sizing).toMatchObject({ fill: 0.92, maxCapHeight: 0.15 });
    expect(second.json.changes).toEqual([{ path: "sizing.maxCapHeight", from: 0.18, to: 0.15 }]);
    // Yayınlanmış profil değişmedi.
    expect((await t.api("GET", `/api/languages/${lang}/profile`)).json.data.sizing.fill).not.toBe(0.92);
  });

  it("açık başlatma yeni oturum açar, eskisi silinmez", async () => {
    await t.api("POST", `/api/languages/${lang}/design-session/entries`, { kind: "note", text: "eski" });
    t.clock.advance(1000);
    const s = await t.api("POST", `/api/languages/${lang}/design-session`, { title: "İkinci tur" });
    expect(s.json).toMatchObject({ title: "İkinci tur", status: "idle", entries: [] });
    expect((t.raw.get("SELECT COUNT(*) AS n FROM design_sessions") as { n: number }).n).toBe(2);
  });
});
