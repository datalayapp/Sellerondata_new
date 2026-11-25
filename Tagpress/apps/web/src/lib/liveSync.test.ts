import { type JobLog, type ProgressStep, ServerEventSchema } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { SERVER_EVENT_TYPES } from "./events.ts";
import { applyProgress, eventQueryKeys } from "./liveSync.ts";

const step = (m: string): ProgressStep => ({ jobId: "j1", taskId: null, step: "ai", message: m, at: "2026-10-09T10:00:00.000Z" });

describe("olay → sorgu eşlemesi", () => {
  it("üretim olayları iş listesini, ayrıntıyı, partiyi ve maliyeti tazeler", () => {
    expect(eventQueryKeys({ type: "job", jobId: "j1", status: "ready" })).toEqual(expect.arrayContaining(["jobs", "job", "batches", "costs"]));
    expect(eventQueryKeys({ type: "variant", jobId: "j1", variantId: "v1" })).toEqual(expect.arrayContaining(["jobs", "job", "variant", "batches", "costs"]));
    expect(eventQueryKeys({ type: "jobs", batchId: null })).toEqual(expect.arrayContaining(["jobs", "batches"]));
    expect(eventQueryKeys({ type: "batch", batchId: "b" })).toEqual(expect.arrayContaining(["batches", "jobs"]));
  });

  it("Şablon, profil, oturum, öğrenme olayları kendi sorgularını tazeler", () => {
    expect(eventQueryKeys({ type: "template", languageId: "l", key: "k" })).toContain("templates");
    expect(eventQueryKeys({ type: "profile", languageId: "l", version: 2 })).toContain("profileDraft");
    expect(eventQueryKeys({ type: "session", languageId: "l" })).toContain("designSession");
    expect(eventQueryKeys({ type: "learn", languageId: "l", runId: "r", status: "running", step: "s", done: 1, total: 2 })).toContain("learnRun");
    expect(eventQueryKeys({ type: "settings" })).toContain("settings");
    expect(eventQueryKeys({ type: "build", buildId: "b", languageId: "l", state: "interviewing" } as never)).toEqual(["build"]);
  });

  it("ilerleme olayı sorgu tazelemez (satır doğrudan yazılır)", () => {
    expect(eventQueryKeys({ type: "progress", step: step("x") })).toEqual([]);
  });

  it("sunucunun her olay türü dinlenir ve bir eşlemesi vardır", () => {
    const types = ServerEventSchema.options.map((o) => o.shape.type.value);
    expect(SERVER_EVENT_TYPES).toEqual(types);
    for (const t of ["queue", "language", "reference"]) expect(eventQueryKeys({ type: t } as never).length).toBeGreaterThan(0);
  });
});

describe("applyProgress", () => {
  const log: JobLog = { steps: [step("a")], aiCalls: [], running: false };
  it("satırı sona ekler ve işi çalışıyor işaretler", () => {
    const r = applyProgress(log, step("b"));
    expect(r?.steps.map((s) => s.message)).toEqual(["a", "b"]);
    expect(r?.running).toBe(true);
  });
  it("aynı satırı iki kez eklemez", () => {
    expect(applyProgress(log, step("a"))).toBe(log);
  });
  it("önbellek yoksa dokunmaz", () => {
    expect(applyProgress(undefined, step("a"))).toBeUndefined();
  });
});
