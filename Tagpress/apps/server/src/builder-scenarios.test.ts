import http from "node:http";
import { BUILDER_API, BuildEstimateSchema, BuildQualitySchema, BuildSchema, ProfileTryResponseSchema, ShowcaseResponseSchema, apiPath } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { type BuilderHarness, builderHarness, fake, q, samplePng, say } from "./test/builder.ts";

/**
 * C4 — oluşturucunun sentetik firma senaryoları (SUNUCU-PLANI §4.8): beş firma, sahte modelle (ücretsiz, ağsız).
 * Her senaryo bir ürün yolunu baştan sona yürür ve değişmezleri denetler: kanıtsız değer yok, müşteri metni bozulmaz,
 * şema dışı yol yok, yayın yalnız kullanıcıyla.
 */

const P = (k: keyof typeof BUILDER_API, p: Record<string, string | number> = {}) => apiPath(BUILDER_API[k].path, p);
let h: BuilderHarness;
afterEach(async () => {
  await h?.idle();
  await h?.t.close();
});

const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, status = 200) => {
  const r = await h.t.api(method, url, body);
  expect(r.status, `${method} ${url} → ${r.body.slice(0, 400)}`).toBe(status);
  return r.json;
};
const build = async (id: string) => BuildSchema.parse(await call("GET", P("getBuild", { id })));
const entryId = (req: { messages: unknown[] }, kind = "answer") => Number(new RegExp(`<entry id=(\\d+) kind=\\\\"${kind}\\\\"`).exec(JSON.stringify(req.messages.at(-1)))?.[1]);
const invariants = async (id: string) => BuildQualitySchema.parse(await call("GET", P("quality", { id }))).invariants;

describe("C4 senaryoları (sahte model)", () => {
  it("1. düğün dükkânı, örnekli: ölçümden taslak (n ölçümden), soru-cevap, deneme, kalite kartı, yayın; örnekler referans olur", async () => {
    h = await builderHarness();
    // Anahtar yokken tahmin yine çalışır (anahtar kaynağı null).
    expect((await call("POST", P("estimate"), { languageId: h.lang, samples: 2 })).keySource).toBeNull();

    const model = h.model.set([
      // İlk tur: ölçümlere bakar, ölçümle taslak yazar, soru sorar.
      fake.reply([fake.text("Ölçümlere bakıyorum."), fake.tool("get_measurements", {}), fake.tool("get_samples", { limit: 4 })]),
      say.propose([{ path: "lineBreaking.maxLineChars", value_json: "14", evidence: { kind: "measurement", key: "lineLength.p90", n: 999 } }], "Satır uzunluğu ölçümden"),
      say.ask([q("isim", { measured: { key: "lineLength.max" } })]),
      // Cevap turu.
      (req) => say.propose([{ path: "lineBreaking.nameOwnLine", value_json: "false", evidence: { kind: "answer", entryId: entryId(req) } }], "Cevaba göre"),
      say.done("Taslak hazır."),
    ]);
    const est = BuildEstimateSchema.parse(await call("POST", P("estimate"), { languageId: h.lang, samples: 2 }));
    expect(est).toMatchObject({ keySource: "org", sessionCapUsd: 3, monthLimitUsd: 20, monthWarn: false });
    expect(est.lowUsd).toBeGreaterThan(0);
    expect(est.highUsd).toBeGreaterThan(est.lowUsd);
    // Önek sayımı ücretsiz count_tokens ile (sahte model sayar; model isteği gönderilmez).
    expect(model.countRequests).toHaveLength(1);
    expect(model.requests).toHaveLength(0);
    const b0 = await call("POST", P("createBuild", { lang: h.lang }), { base: "published", fromSetup: true, labelTypes: ["wedding"] }, 201);
    const id = b0.id as string;
    const png = (await samplePng()).toString("base64");
    await call("POST", P("uploadSamples", { id }), { files: [{ name: "a.png", dataBase64: png }, { name: "b.png", dataBase64: png }] });
    await call("POST", P("analyze", { id }), undefined, 202);
    await h.idle();
    let b = await build(id);
    expect(b.state).toBe("awaiting-user");
    expect(b.currentRev).toBe(1);
    const rev1 = await call("GET", P("revision", { id, rev: 1 }));
    expect(rev1.changes[0].source).toMatchObject({ kind: "measurement", ref: "lineLength.p90" });
    expect(rev1.changes[0].source.n).toBeLessThan(999);
    expect(b.pendingQuestions[0]!.measured).toMatchObject({ key: "lineLength.max", value: expect.any(Number), n: expect.any(Number) });
    // Görsellerdeki metin veri bloğunda; ayrılmış küme modele gitmez (örnek az: küme yok).
    expect(JSON.stringify(model.requests[1]!.messages)).toContain("<sample id=");

    await call("POST", P("postMessage", { id }), { kind: "answer", answers: [{ questionId: "isim", option: 1 }] }, 202);
    await h.idle();
    b = await build(id);
    expect(b).toMatchObject({ state: "review", currentRev: 2 });
    expect(model.remaining).toBe(0);

    const tried = ProfileTryResponseSchema.parse(await call("POST", P("tryText", { id }), { text: "Zeynep & Ali", mode: "engine" }));
    expect(tried).toMatchObject({ mode: "engine", costUsd: 0 });
    expect((await h.t.app.inject({ method: "GET", url: tried.results[0]!.draft!.previewUrl })).statusCode).toBe(200);
    const aiEst = await call("POST", P("tryText", { id }), { text: "Zeynep & Ali", mode: "ai" });
    expect(aiEst.results).toEqual([]);
    expect(aiEst.estimateUsd).toBeGreaterThan(0);
    const quality = BuildQualitySchema.parse(await call("GET", P("quality", { id })));
    // Ayrılmış küme için en az 8 ölçülebilir örnek gerekir: iki örnekte kart yok (neden örneklerin ölçümünden).
    const measurable = b.samples.some((s) => s.status === "measured");
    expect(quality).toMatchObject({ rev: 2, test: null, testReason: measurable ? "too-few-samples" : "no-measurable", ai: null, invariants: { unsupportedValues: 0, textChanged: 0, outsideSchema: 0 } });

    const published = await call("POST", P("publish", { id }), {});
    expect(published.data.lineBreaking.maxLineChars).toBe(14);
    b = await build(id);
    expect(b.state).toBe("published");
    const refs = h.t.inOrg(() => h.t.ctx.references.list({ languageId: h.lang })).filter((r) => r.source === "uploaded");
    expect(refs).toHaveLength(2);
    expect(b.samples.every((s) => s.referenceId)).toBe(true);
    // Yayından sonra oturum değişmez.
    expect((await h.t.api("POST", P("postMessage", { id }), { kind: "note", text: "x" })).json.code).toBe("build-state");
  });

  it("2. ürün etiketi firması, örneksiz: ölçüm kanıtı reddedilir, cevapla dil kurulur; oturumsuz örnek etiketler", async () => {
    h = await builderHarness();
    const model = h.model.set([
      say.propose([{ path: "sizing.fill", value_json: "0.8", evidence: { kind: "measurement", key: "fill.blockWidthOfCut" } }], "Doluluk"),
      say.ask([q("dolu", { group: "doluluk", options: [{ label: "Dolu", value_json: "0.9" }, { label: "Ferah", value_json: "0.75" }], suggestion: 1, free: false })]),
      (req) => say.propose([{ path: "sizing.fill", value_json: "0.75", evidence: { kind: "answer", entryId: entryId(req) } }], "Ferah"),
      say.done(),
    ]);
    const id = (await call("POST", P("createBuild", { lang: h.lang }), { base: "default", fromSetup: true, labelTypes: ["product"] }, 201)).id as string;
    await call("POST", P("skipSamples", { id }), undefined, 202);
    await h.idle();
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("unknown-measurement");
    let b = await build(id);
    expect(b).toMatchObject({ state: "awaiting-user", currentRev: 0, base: "default", baseVersion: null });
    expect(b.pendingQuestions[0]).toMatchObject({ suggestion: 1, free: false, options: [{ label: "Dolu", value: 0.9 }, { label: "Ferah", value: 0.75 }] });
    // Serbest cevapsız soruya metin cevap: geçersiz.
    expect((await h.t.api("POST", P("postMessage", { id }), { kind: "answer", answers: [{ questionId: "dolu", text: "orta" }] })).json.code).toBe("question-unknown");
    await call("POST", P("postMessage", { id }), { kind: "answer", answers: [{ questionId: "dolu", option: 1 }] }, 202);
    await h.idle();
    b = await build(id);
    expect(b).toMatchObject({ state: "review", currentRev: 1 });
    const show = ShowcaseResponseSchema.parse(await call("POST", P("languageShowcase", { lang: h.lang }), { source: "draft", locale: "en" }));
    // Kurulum cevabı yoksa düğün örnekleri; dil İngilizce istendi.
    expect(show.items.some((i) => i.source === "preset" && i.text === "Emma & James 14.06.2026")).toBe(true);
    expect(show.items.length).toBeGreaterThan(0);
    for (const i of show.items.filter((x) => !x.error)) expect((await h.t.app.inject({ method: "GET", url: i.previewUrl })).statusCode).toBe(200);
    expect(await invariants(id)).toEqual({ unsupportedValues: 0, textChanged: 0, outsideSchema: 0 });
  });

  it("3. düzeltme döngüsü ve geri dönüş: yayınlanan profil geri dönülen revizyonun verisidir", async () => {
    h = await builderHarness();
    h.model.set([say.ask([q("a")])]);
    const id = (await call("POST", P("createBuild", { lang: h.lang }), { base: "published" }, 201)).id as string;
    await call("POST", P("skipSamples", { id }), undefined, 202);
    await h.idle();
    h.model.set([(req) => say.propose([{ path: "lineBreaking.maxLines", value_json: "5", evidence: { kind: "answer", entryId: entryId(req) } }], "5 satır"), say.done()]);
    await call("POST", P("postMessage", { id }), { kind: "answer", answers: [{ questionId: "a", text: "Beş satır." }] }, 202);
    await h.idle();
    h.model.set([(req) => say.propose([{ path: "lineBreaking.maxLines", value_json: "2", evidence: { kind: "correction", entryId: entryId(req, "correction") } }], "2 satır"), say.done()]);
    await call("POST", P("postMessage", { id }), { kind: "correction", text: "İki satır olsun." }, 202);
    await h.idle();
    expect((await build(id)).currentRev).toBe(2);
    const restored = await call("POST", P("restore", { id }), { rev: 1 });
    expect(restored.profile.lineBreaking.maxLines).toBe(5);
    const published = await call("POST", P("publish", { id }), { note: "Geri dönüldü" });
    expect(published.data.lineBreaking.maxLines).toBe(5);
    expect(published.note).toBe("Geri dönüldü");
    const list = (await call("GET", P("revisions", { id }))).revisions as Array<{ reason: string; costUsd: number }>;
    expect(list.map((r) => r.reason)).toEqual(["initial", "correction", "restore"]);
    expect(list[0]!.costUsd).toBeGreaterThan(0);
    expect(list[2]!.costUsd).toBe(0);
  });

  it("4. uydurma değer deneyen model: kanıtsız, metni bozan ve şema dışı öneriler hiç yazılmaz; taslak bozulmaz", async () => {
    h = await builderHarness();
    h.model.set([]);
    const id = (await call("POST", P("createBuild", { lang: h.lang }), { base: "published" }, 201)).id as string;
    // Kullanıcının notu gerçek bir girdi: kanıt geçerli, ama değer müşteri metnini bozuyor.
    const note = (await call("POST", P("postMessage", { id }), { kind: "note", text: "Ece & Can böyle yazılır." })).entries[0].id as number;
    const evil = [
      { path: "lineBreaking.examples", value_json: JSON.stringify([{ text: "Ece & Can", lines: ["ECE", "& CAN"] }]), evidence: { kind: "answer", entryId: note } },
      { path: "sizing.tiers.secondary", value_json: "0.4", evidence: { kind: "measurement", key: "ratios.secondary" } },
      { path: "lineBreaking.maxLines", value_json: "3", evidence: { kind: "answer", entryId: 999_999 } },
    ];
    const model = h.model.set([
      say.propose(evil, "Uydurma"),
      // Yayın ya da ücretli deneme aracı yok: bilinmeyen araç doğrulamada durur.
      fake.reply([fake.tool("publish", { note: "x" })]),
      say.propose(evil, "Uydurma"),
      say.propose(evil, "Uydurma"),
    ]);
    const before = h.t.inOrg(() => h.t.ctx.profiles.active(h.lang))!;
    await call("POST", P("skipSamples", { id }), undefined, 202);
    await h.idle();
    expect(model.remaining).toBe(0);
    const b = await build(id);
    expect(b.currentRev).toBe(0);
    expect(JSON.stringify(model.requests[2]!.messages.at(-1))).toContain('Unknown tool \\"publish\\"');
    expect(h.t.inOrg(() => h.t.ctx.profiles.active(h.lang))!.version).toBe(before.version);
    expect(h.t.inOrg(() => h.t.ctx.profiles.draft(h.lang))).toBeNull();
    expect((await h.t.api("POST", P("publish", { id }), {})).json.code).toBe("build-no-revision");
    expect(await invariants(id)).toEqual({ unsupportedValues: 0, textChanged: 0, outsideSchema: 0 });
    expect((await call("POST", P("close", { id }), {})).state).toBe("closed");
  });

  it("5. bütçesi dar firma: %80'de uyarı, aylık sınırda yeni tur başlamaz (artırılamaz); harcama dökümü oturumda", async () => {
    h = await builderHarness();
    h.t.inOrg(() => h.t.ctx.settings.setOrg("ai.limits", { monthlyUsd: 0.62 }));
    // İlk tur ≈ $0,52 (Opus 5.5, 130k girdi): ay %80'i geçer.
    h.model.set([fake.reply([fake.tool("ask_user", { questions: [q("a")] })], { usage: { input_tokens: 130_000, output_tokens: 10 } })]);
    const id = (await call("POST", P("createBuild", { lang: h.lang }), { base: "published" }, 201)).id as string;
    await call("POST", P("skipSamples", { id }), undefined, 202);
    await h.idle();
    const est = BuildEstimateSchema.parse(await call("POST", P("estimate"), { languageId: h.lang, samples: 0 }));
    expect(est.monthWarn).toBe(true);
    expect(est.monthUsd).toBeGreaterThan(0.5);
    const r = await h.t.api("POST", P("postMessage", { id }), { kind: "answer", answers: [{ questionId: "a", option: 0 }] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "budget-exceeded", scope: "month", canRaise: false, buildId: id });
    // Reddedilen istekte hiçbir şey yazılmadı: soru hâlâ bekliyor, oturum aynı durumda.
    const b = await build(id);
    expect(b).toMatchObject({ state: "awaiting-user", turn: null });
    expect(b.pendingQuestions).toHaveLength(1);
    const calls = h.t.raw.all("SELECT purpose, cost_usd FROM ai_calls WHERE build_id = ?", id);
    expect(calls.reduce((s, c) => s + Number(c.cost_usd), 0)).toBeCloseTo(b.costUsd, 6);
  });
});

describe("oturum akışı (SSE) kaldığı yerden", () => {
  /** Akışı açar, `n` olay gelince kapatır. */
  function read(port: number, id: string, lastEventId: string | null, n: number): Promise<Array<{ id: string | null; event: string; data: unknown }>> {
    return new Promise((resolve, reject) => {
      const out: Array<{ id: string | null; event: string; data: unknown }> = [];
      const req = http.get({ host: "127.0.0.1", port, path: P("stream", { id }), headers: lastEventId ? { "last-event-id": lastEventId } : {} }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const f = Object.fromEntries(block.split("\n").flatMap((l) => (/^(id|event|data): /.test(l) ? [[l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]] : [])));
            if (!f.event) continue;
            out.push({ id: f.id ?? null, event: f.event, data: JSON.parse(f.data ?? "null") });
            if (out.length >= n) {
              req.destroy();
              resolve(out);
            }
          }
        });
      });
      req.on("error", (e) => (out.length >= n ? undefined : reject(e)));
    });
  }

  it("kalite kartı: ayrılmış kümedeki örneklerin şablonu yoksa test null ve neden not-replayable (başarısız değil)", async () => {
    h = await builderHarness();
    h.model.set([say.ask([q("a")])]);
    const id = (await call("POST", P("createBuild", { lang: h.lang }), { base: "published", fromSetup: true, labelTypes: ["wedding"] }, 201)).id as string;
    const png = (await samplePng()).toString("base64");
    await call("POST", P("uploadSamples", { id }), { files: Array.from({ length: 12 }, (_, i) => ({ name: `s${i}.png`, dataBase64: png })) });
    await call("POST", P("analyze", { id }), undefined, 202);
    await h.idle();
    const b = await build(id);
    const rows = h.t.inOrg(() => h.t.ctx.builder.store.sampleRows(id)).filter((s) => !s.excluded && s.status === "measured");
    expect(b.samples.length).toBeGreaterThanOrEqual(8);
    expect(rows.some((s) => s.split === "test"), "bölmeye test düşen ölçülmüş örnek bekleniyor").toBe(true);
    const quality = BuildQualitySchema.parse(await call("GET", P("quality", { id })));
    expect(quality).toMatchObject({ test: null, testReason: "not-replayable" });
  });

  it("ilk bağlantıda anlık durum; kimlikle yeniden bağlanınca kaçırılan olaylar sırayla, anlık durum olmadan", async () => {
    h = await builderHarness();
    h.model.set([say.ask([q("a")])]);
    const id = (await call("POST", P("createBuild", { lang: h.lang }), { base: "published" }, 201)).id as string;
    await h.t.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.t.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const first = await read(port, id, null, 1);
    expect(first[0]).toMatchObject({ id: null, event: "status", data: { state: "intake" } });
    const mark = h.t.ctx.builder.streams.buffered(id).at(-1)!.id;
    await call("POST", P("skipSamples", { id }), undefined, 202);
    await h.idle();
    const missed = h.t.ctx.builder.streams.buffered(id).filter((i) => i.n > Number(mark.split(":")[1]));
    expect(missed.map((i) => i.event.type)).toEqual(expect.arrayContaining(["status", "step", "question", "cost", "done"]));
    const again = await read(port, id, mark, missed.length);
    expect(again.map((e) => e.id)).toEqual(missed.map((i) => i.id));
    expect(again.at(-1)!.data).toMatchObject({ type: "status", state: "awaiting-user" });
    const stale = await read(port, id, "baska:1", 1);
    expect(stale[0]).toMatchObject({ id: null, event: "status", data: { state: "awaiting-user" } });
  });
});
