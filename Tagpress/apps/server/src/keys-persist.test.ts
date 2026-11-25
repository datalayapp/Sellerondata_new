import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestApp, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

let t: TestApp;
const envKeys = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of envKeys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(async () => {
  await t?.close();
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Gerçek bağlantı fabrikası gibi (işlev) verilir: anahtar ön denetimi açılır. */
const factory = () => fullPorts();

describe("anahtar ön denetimi", () => {
  it("anahtar yokken üretim/revizyon/Dene AI/temadan şablon kuyruğa alınmadan 409 missing-key döner", async () => {
    t = await makeApp({ ports: factory });
    const lang = await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const jobId = commit.jobIds[0];

    const text = await t.api("POST", "/api/generate", { jobIds: [jobId], mode: "text" });
    expect(text.status).toBe(409);
    expect(text.json).toMatchObject({ code: "missing-key", provider: "anthropic" });
    expect(text.json.error).toContain("Ayarlar → Bağlantılar'dan Anthropic anahtarını girin.");

    const img = await t.api("POST", "/api/generate", { jobIds: [jobId], mode: "image-on-template" });
    expect(img.json).toMatchObject({ code: "missing-key", provider: "gemini" });

    const tpl = await t.api("POST", `/api/languages/${lang}/templates/generate`, { theme: "çiçek" });
    expect(tpl.status).toBe(409);
    expect(tpl.json).toMatchObject({ code: "missing-key", provider: "gemini" });

    const dene = { samples: [{ id: "s", text: "Anna", templateKey: "a1" }], mode: "ai" };
    const tr = await t.api("POST", `/api/languages/${lang}/profile/try`, dene);
    expect(tr.status, tr.body).toBe(409);
    expect(tr.json).toMatchObject({ code: "missing-key", provider: "anthropic" });

    // Ücretsiz yollar etkilenmez: tahmin (dryRun) ve motor modu.
    const dry = await t.api("POST", `/api/languages/${lang}/profile/try`, { ...dene, dryRun: true });
    expect(dry.status, dry.body).toBe(200);

    // Hiçbir iş kuyruğa alınmadı.
    expect((await t.api("GET", "/api/generate/status")).json.queued ?? 0).toBe(0);
  });

  it("anahtar girilince geçer; içe aktarma anahtarsız da tamamlanır", async () => {
    t = await makeApp({ ports: factory });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }], { generate: true });
    expect(commit.queued).toEqual([]); // anahtar yok: kuyruğa alınmadı ama içe aktarma bozulmadı
    await t.api("PUT", "/api/settings/keys/anthropic", { apiKey: "sk-ant-deneme-1234" });
    const r = await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "text" });
    expect(r.status, r.body).toBe(200);
    expect(r.json.queued).toEqual(commit.jobIds);
    await t.ctx.queue.idle();
  });

  it("sahte portlu testlerde (nesne) denetim kapalıdır", async () => {
    t = await makeApp({ ports: fullPorts() });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
    expect((await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "text" })).status).toBe(200);
    await t.ctx.queue.idle();
  });
});

describe("arka plan görevlerinin kalıcılığı", () => {
  it("yeniden başlatmada yarım şablon görevi ve öğrenme koşusu 'interrupted' olur; bitenler korunur", async () => {
    t = await makeApp({ ports: fullPorts() });
    const lang = await seedLanguage(t);
    const done = (await t.api("POST", `/api/languages/${lang}/templates/generate`, { theme: "pastel", key: "pastel-1" })).json;
    await t.ctx.templateTasks.idle();
    const now = new Date().toISOString();
    t.raw.run("INSERT INTO template_tasks (org_id, id, language_id, status, theme, created_at, updated_at) VALUES (?, 'yarim', ?, 'running', 'x', ?, ?)", t.org, lang, now, now);
    t.raw.run(
      "INSERT INTO learn_runs (org_id, id, language_id, status, base, profile_version, step, done, total, message, started_at) VALUES (?, 'kosu', ?, 'running', 'draft', 1, 'olcum', 1, 3, 'Ölçülüyor', ?)",
      t.org,
      lang,
      now,
    );
    const dir = t.dir;
    await t.app.close(); // sunucu kapanır, veri klasörü kalır
    t = await makeApp({ dir, ports: fullPorts() });
    try {
      expect((await t.api("GET", `/api/template-tasks/${done.id}`)).json).toMatchObject({ status: "done", key: "pastel-1" });
      const task = (await t.api("GET", "/api/template-tasks/yarim")).json;
      expect(task).toMatchObject({ status: "interrupted" });
      expect(task.error).toContain("kesildi");
      const run = (await t.api("GET", `/api/languages/${lang}/learn/run`)).json;
      expect(run).toMatchObject({ id: "kosu", status: "interrupted", step: "olcum" });
      expect(run.finishedAt).not.toBeNull();
    } finally {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
      t = undefined as never;
    }
  });
});
