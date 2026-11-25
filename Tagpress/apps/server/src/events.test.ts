import type { ServerEvent } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { type TestApp, fakeDesigner, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

describe("canlı güncelleme: sunucu olayları", () => {
  it("üretim: iş durumu, günlük satırı, varyasyon ve kuyruk olayları sırayla yayınlanır; son 'job' olayı hazır durumunu taşır", async () => {
    t = await makeApp({ ports: fullPorts({ designer: fakeDesigner() }) });
    await seedLanguage(t);
    const events: ServerEvent[] = [];
    t.ctx.events.subscribe((e) => events.push(e));
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }], { generate: true });
    const id = commit.jobIds[0] as string;
    await t.ctx.queue.idle();

    const types = new Set(events.map((e) => e.type));
    for (const need of ["jobs", "job", "progress", "variant", "queue"] as const) expect(types, `${need} olayı yayınlanmadı`).toContain(need);

    const jobEvents = events.filter((e): e is Extract<ServerEvent, { type: "job" }> => e.type === "job" && e.jobId === id);
    expect(jobEvents.map((e) => e.status)).toContain("generating");
    expect(jobEvents.at(-1)?.status).toBe("ready");

    // Varyasyon olayı, işin 'hazır' olayından ÖNCE gelir (arayüz hazır olayında varyasyonu görebilsin).
    const iVariant = events.findIndex((e) => e.type === "variant" && e.jobId === id);
    const lastJob = events.lastIndexOf(jobEvents.at(-1) as ServerEvent);
    expect(iVariant).toBeGreaterThanOrEqual(0);
    expect(iVariant).toBeLessThan(lastJob);

    // Günlük satırları olayın içinde gelir; ayrıntı uç noktası aynı satırları verir.
    const steps = events.filter((e): e is Extract<ServerEvent, { type: "progress" }> => e.type === "progress" && e.step.jobId === id).map((e) => e.step.message);
    expect(steps.length).toBeGreaterThan(0);
    const log = (await t.api("GET", `/api/jobs/${id}/log`)).json;
    expect(log.steps.map((s: { message: string }) => s.message)).toEqual(steps);
  });

  it("onay ve düzeltme-dışı değişiklikler de olay yayınlar (onayla → job)", async () => {
    t = await makeApp({ ports: fullPorts() });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }], { generate: true });
    await t.ctx.queue.idle();
    const id = commit.jobIds[0] as string;
    const events: ServerEvent[] = [];
    t.ctx.events.subscribe((e) => events.push(e));
    const r = await t.api("POST", `/api/jobs/${id}/approve`, { variantId: null });
    expect(r.status, r.body).toBe(200);
    expect(events.some((e) => e.type === "job" && e.jobId === id)).toBe(true);
  });

  it("SSE akışı olayları ADLI yazar (`event: <tür>`): arayüz her türü ayrı dinler", async () => {
    t = await makeApp({ ports: fullPorts() });
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = t.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctl.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // retry satırı
    t.inOrg(() => t.ctx.events.emit({ type: "settings" }));
    t.inOrg(() => t.ctx.events.emit({ type: "job", jobId: "j9", status: "ready" }));
    let buf = "";
    while (!buf.includes("event: job")) buf += dec.decode((await reader.read()).value);
    ctl.abort();
    expect(buf).toContain("event: settings\ndata: {\"type\":\"settings\"}\n\n");
    expect(buf).toContain('event: job\ndata: {"type":"job","jobId":"j9","status":"ready"}\n\n');
  });
});
