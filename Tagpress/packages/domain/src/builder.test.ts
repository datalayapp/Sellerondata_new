import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BudgetExceededErrorSchema,
  BUILDER_API,
  BuildEstimateSchema,
  BuildMessageSchema,
  BuildQualitySchema,
  BuildStreamEventSchema,
  BUILD_STREAM_EVENT_TYPES,
  BuildTryRequestSchema,
  builderRouteTable,
  formatBuildEventId,
  MissingKeyErrorSchema,
  parseBuildEventId,
  RevisionDetailSchema,
  SamplePatchSchema,
  SampleUploadSchema,
  ShowcaseItemSchema,
  type BuilderRouteDef,
} from "./builder-api.ts";
import {
  BUILDER_TOOL_NAMES,
  BUILDER_TOOLS,
  builderToolJsonSchema,
  parseBuilderToolInput,
  strictSchemaProblem,
  toEvidence,
} from "./builder-tools.ts";
import {
  BUILD_EVENTS,
  BUILD_LABEL_TYPES,
  BUILD_STATES,
  BUILD_TERMINAL_STATES,
  BUILDER_FEATURE,
  BUILDER_SAMPLE_LIMITS,
  BUILDER_WRITABLE_PATHS,
  BuildEntrySchema,
  BuildQuestionSchema,
  BuildSchema,
  canTransition,
  EvidenceSchema,
  holdoutCount,
  initialBuildState,
  isWritableProfilePath,
  nextBuildState,
  profileDocKey,
  RuleChangeSchema,
  SampleSchema,
  type Build,
  type BuildEvent,
  type BuildState,
  type Sample,
} from "./builder.ts";
import { emptyProfile } from "./profile.ts";
import { PROFILE_DOCS } from "./profile-docs.ts";
import { LABEL_TYPES } from "./setup.ts";

const AT = "2026-11-21T10:00:00.000Z";
const NO_REV = { hasRevision: false };
const REV = { hasRevision: true };

// ================================================================ durum makinesi

/** Beklenen tablo: [kaynak, olay, revizyon yok → hedef, revizyon var → hedef]. Listede olmayan her çift geçersizdir. */
const EXPECTED: Array<[BuildState, BuildEvent, BuildState | null, BuildState | null]> = [
  ["intake", "start-samples", "samples", "samples"],
  ["intake", "skip-samples", "drafting", "drafting"],
  ["samples", "skip-samples", "drafting", "drafting"],
  ["samples", "analyze", "analyzing", "analyzing"],
  ["review", "analyze", "analyzing", "analyzing"],
  ["analyzing", "analysis-done", "drafting", "review"],
  ["analyzing", "analysis-failed", "samples", "review"],
  ["drafting", "ask", "awaiting-user", "awaiting-user"],
  ["revising", "ask", "awaiting-user", "awaiting-user"],
  ["drafting", "turn-end", "awaiting-user", "review"],
  ["revising", "turn-end", "review", "review"],
  ["awaiting-user", "answer", "drafting", "revising"],
  ["review", "correct", "revising", "revising"],
  ["analyzing", "cancel", "samples", "review"],
  ["drafting", "cancel", "awaiting-user", "review"],
  ["revising", "cancel", "awaiting-user", "review"],
  ["analyzing", "interrupt", "interrupted", "interrupted"],
  ["drafting", "interrupt", "interrupted", "interrupted"],
  ["revising", "interrupt", "interrupted", "interrupted"],
  ["drafting", "fail", "failed", "failed"],
  ["revising", "fail", "failed", "failed"],
  ["review", "publish", null, "published"],
  ["awaiting-user", "publish", null, "published"],
  ...BUILD_STATES.filter((s) => s !== "published" && s !== "closed").map((s) => [s, "close", "closed", "closed"] as [BuildState, BuildEvent, BuildState, BuildState]),
];

describe("oturum durum makinesi", () => {
  it("geçiş tablosu beklenenle birebir aynı (her durum × olay)", () => {
    for (const from of BUILD_STATES) {
      for (const event of BUILD_EVENTS) {
        if (event === "resume") continue;
        const row = EXPECTED.find(([f, e]) => f === from && e === event);
        expect(canTransition(from, event), `${from} + ${event}`).toBe(!!row);
        expect(nextBuildState(from, event, NO_REV), `${from} + ${event} (revizyonsuz)`).toBe(row ? row[2] : null);
        expect(nextBuildState(from, event, REV), `${from} + ${event} (revizyonlu)`).toBe(row ? row[3] : null);
      }
    }
  });

  it("devam: yalnız interrupted/failed'den ve yalnız çalışan bir duruma", () => {
    for (const from of ["interrupted", "failed"] as const) {
      expect(nextBuildState(from, "resume", { hasRevision: false, resumeState: "analyzing" })).toBe("analyzing");
      expect(nextBuildState(from, "resume", { hasRevision: true, resumeState: "revising" })).toBe("revising");
      expect(nextBuildState(from, "resume", { hasRevision: false, resumeState: "drafting" })).toBe("drafting");
      expect(nextBuildState(from, "resume", { hasRevision: true, resumeState: "review" })).toBeNull();
      expect(nextBuildState(from, "resume", { hasRevision: true })).toBeNull();
    }
    for (const from of BUILD_STATES.filter((s) => s !== "interrupted" && s !== "failed")) {
      expect(canTransition(from, "resume")).toBe(false);
      expect(nextBuildState(from, "resume", { hasRevision: true, resumeState: "drafting" })).toBeNull();
    }
  });

  it("bitmiş durumlardan hiçbir olay geçmez", () => {
    for (const s of BUILD_TERMINAL_STATES) for (const e of BUILD_EVENTS) expect(canTransition(s, e)).toBe(false);
  });

  it("her durum girişten ulaşılabilir; bitmemiş her durumdan kapatılır", () => {
    const seen = new Set<BuildState>(["intake"]);
    const queue: BuildState[] = ["intake"];
    while (queue.length) {
      const s = queue.shift()!;
      for (const e of BUILD_EVENTS)
        for (const ctx of [NO_REV, REV, { hasRevision: true, resumeState: "revising" as const }, { hasRevision: false, resumeState: "analyzing" as const }]) {
          const t = nextBuildState(s, e, ctx);
          if (t && !seen.has(t)) (seen.add(t), queue.push(t));
        }
    }
    expect([...seen].sort()).toEqual([...BUILD_STATES].sort());
  });

  it("ilk durum: kurulumdan tür seçimiyle gelindiyse örnekler, yoksa giriş", () => {
    expect(initialBuildState({ fromSetup: true, hasLabelTypes: true })).toBe("samples");
    expect(initialBuildState({ fromSetup: true, hasLabelTypes: false })).toBe("intake");
    expect(initialBuildState({ fromSetup: false, hasLabelTypes: true })).toBe("intake");
  });
});

// ================================================================ sabitler ve yardımcılar

describe("sabitler", () => {
  it("örnek sınırları dışa açık", () => {
    expect(BUILDER_SAMPLE_LIMITS.maxFiles).toBe(24);
    expect(BUILDER_SAMPLE_LIMITS.maxRequestBytes).toBe(60 * 1024 * 1024);
  });
  it("ayrılmış küme: 8'in altında yok, üstünde %25 aşağı yuvarlanır", () => {
    expect(holdoutCount(7)).toBe(0);
    expect(holdoutCount(8)).toBe(2);
    expect(holdoutCount(11)).toBe(2);
    expect(holdoutCount(24)).toBe(6);
  });
  it("etiket türleri kurulumla aynı", () => {
    expect([...BUILD_LABEL_TYPES]).toEqual([...LABEL_TYPES]);
  });
  it("yazılabilir yollar: PROFILE_DOCS'tan, gizli alan, ad ve tasarım alanı hariç", () => {
    for (const p of BUILDER_WRITABLE_PATHS) expect(PROFILE_DOCS[p]?.hidden).not.toBe(true);
    expect(BUILDER_WRITABLE_PATHS).not.toContain("name");
    expect(BUILDER_WRITABLE_PATHS).not.toContain("output.designFramePx");
    expect(BUILDER_WRITABLE_PATHS).toContain("sizing.tiers.tertiary");
    expect(profileDocKey("sizing.tiers.tertiary")).toBe("sizing.tiers.tertiary");
    expect(profileDocKey("fonts.list.0.family")).toBe("fonts.list");
    expect(profileDocKey("yok.boyle")).toBeNull();
    expect(isWritableProfilePath("fonts.list.0.family")).toBe(true);
    expect(isWritableProfilePath("output.designFramePx")).toBe(false);
  });
});

// ================================================================ şemalar

const sample: Sample = {
  id: "s1",
  buildId: "b1",
  name: "ayse-can.png",
  w: 1200,
  h: 1200,
  status: "measured",
  quality: "exact",
  approx: false,
  templateKey: "ek2",
  templateMatch: "user",
  lines: [
    { text: "Ayşe", ink: { x: 10, y: 20, w: 300, h: 80 }, gapAbovePx: null, fontFile: "GreatVibes.ttf", textSource: "transcribe" },
    { text: "12.10.2026", ink: { x: 40, y: 140, w: 200, h: 30 }, gapAbovePx: 40, fontFile: null, textSource: "user" },
  ],
  fontFile: null,
  split: "train",
  excluded: false,
  referenceId: null,
  imageUrl: "/api/builds/b1/samples/s1/image.png",
  error: null,
  createdAt: AT,
};

const question = {
  id: "q-baglac",
  entryId: 4,
  group: "baglaclar",
  text: "& işareti nasıl olsun?",
  measured: { key: "connectors.ownLineShare", value: 0.8, n: 6, q1: 0.7, q3: 0.9 },
  suggestion: 1,
  options: [
    { label: "Aynı satırda", value: false },
    { label: "Küçük, ayrı satırda", value: true },
  ],
  free: true,
  paths: ["connectors.separateDangling"],
  answered: false,
} as const;

const build: Build = {
  id: "b1",
  languageId: "lavanda",
  mode: "site",
  state: "awaiting-user",
  resumeState: null,
  base: "published",
  baseVersion: 3,
  currentRev: 2,
  costUsd: 0.41,
  budgetUsd: 3,
  budgetRaised: false,
  fromSetup: true,
  labelTypes: ["wedding", "baptism"],
  pendingQuestions: [question as never],
  samples: [sample],
  turn: null,
  lastEntryId: 9,
  error: null,
  createdAt: AT,
  updatedAt: AT,
};

const ruleChange = {
  path: "sizing.tiers.tertiary",
  group: "boyut",
  label: "sizing.tiers.tertiary",
  unit: "oran",
  from: 0.45,
  to: 0.38,
  source: { kind: "correction", ref: "7" },
} as const;

describe("şemalar: geçerli ve geçersiz örnekler", () => {
  const cases: Array<[string, z.ZodType, unknown, unknown]> = [
    ["Build", BuildSchema, build, { ...build, state: "bekliyor" }],
    ["Sample", SampleSchema, sample, { ...sample, quality: "approx" }],
    ["BuildQuestion", BuildQuestionSchema, question, { ...question, group: "rastgele" }],
    [
      "BuildEntry",
      BuildEntrySchema,
      { id: 5, at: AT, role: "user", kind: "answer", turnSeq: 2, text: null, group: "baglaclar", answer: { questionId: "q-baglac", option: 1, text: null, value: true } },
      { id: 0, at: AT, role: "user", kind: "answer", turnSeq: 2, text: null, group: null },
    ],
    ["Evidence (ölçüm)", EvidenceSchema, { kind: "measurement", key: "tiers.tertiary", n: 6 }, { kind: "measurement", n: 6 }],
    ["Evidence (cevap)", EvidenceSchema, { kind: "answer", entryId: 5 }, { kind: "answer", entryId: "beş" }],
    ["RuleChange", RuleChangeSchema, { ...ruleChange, warning: { code: "outside-measured-range", params: { q1: 0.4, q3: 0.5, n: 6 } } }, { ...ruleChange, source: { kind: "tahmin", ref: null } }],
    ["BuildMessage (cevap)", BuildMessageSchema, { kind: "answer", answers: [{ questionId: "q-baglac", option: 1 }] }, { kind: "answer" }],
    ["BuildMessage (düzeltme)", BuildMessageSchema, { kind: "correction", text: "Tarih biraz büyük, küçült." }, { kind: "correction", answers: [{ questionId: "q", option: 0 }] }],
    ["BuildMessage (iki kez aynı soru)", BuildMessageSchema, { kind: "note", text: "Not" }, { kind: "answer", answers: [{ questionId: "q", option: 0 }, { questionId: "q", text: "x" }] }],
    ["SampleUpload", SampleUploadSchema, { files: [{ name: "a.png", dataBase64: "iVBORw0KGgo=" }] }, { files: Array.from({ length: 25 }, (_, i) => ({ name: `${i}.png`, dataBase64: "x" })) }],
    ["SamplePatch", SamplePatchSchema, { lines: [{ text: "Ayşe", fontFile: "GreatVibes.ttf" }, { text: "12.10.2026" }], exclude: false }, {}],
    ["BuildTryRequest", BuildTryRequestSchema, { text: "Ayşe & Can 12.10.2026", mode: "engine" }, { text: "Ayşe", mode: "gemini" }],
    ["BuildEstimate", BuildEstimateSchema, { lowUsd: 0.7, highUsd: 1.5, sessionCapUsd: 3, monthUsd: 2.1, monthLimitUsd: 20, monthWarn: false, keySource: null }, { lowUsd: 0.7 }],
    [
      "BudgetExceededError",
      BudgetExceededErrorSchema,
      { error: "Oturum sınırı aşılacak.", code: "budget-exceeded", scope: "session", usedUsd: 2.9, limitUsd: 3, estimateUsd: 0.3, canRaise: true, buildId: "b1" },
      { error: "x", code: "budget-exceeded", scope: "yıl", usedUsd: 1, limitUsd: 3, estimateUsd: 0.1, canRaise: false },
    ],
    ["MissingKeyError", MissingKeyErrorSchema, { error: "Anthropic anahtarı yok.", code: "missing-key", provider: "anthropic", keySource: "org" }, { error: "x", code: "missing-key", provider: "gemini", keySource: "org" }],
    [
      "ShowcaseItem",
      ShowcaseItemSchema,
      {
        id: "i1",
        labelType: "wedding",
        sampleId: null,
        text: "Ayşe & Can 12.10.2026",
        templateKey: "ek2",
        size: "3.8",
        sizeMm: { shape: "circle", w: 38, h: 38 },
        previewUrl: "/api/builds/b1/revisions/3/showcase/i1",
        changed: true,
        note: [{ label: "sizing.tiers.tertiary", direction: "down" }, { label: "weight.widthEm", direction: "up" }],
        source: "preset",
        error: null,
      },
      { id: "i1", text: "x", changed: "evet" },
    ],
    [
      "BuildQuality",
      BuildQualitySchema,
      { rev: 3, test: { n: 4, failed: 0, within10: 3, positionPx: 4.2, gaps: { normal: 0.05, beforeLast: null, connector: 0.1 } }, testReason: null, ai: null, invariants: { unsupportedValues: 0, textChanged: 0, outsideSchema: 0 } },
      { rev: 3, test: null, testReason: "bilinmiyor", ai: null, invariants: { unsupportedValues: 0, textChanged: 0, outsideSchema: 0 } },
    ],
    ["RevisionDetail", RevisionDetailSchema, { rev: 0, at: AT, reason: null, summary: "", profile: emptyProfile("Lavanda"), changes: [] }, { rev: 1, at: AT, reason: "initial", summary: "", profile: { sizing: "yok" }, changes: [] }],
  ];
  it.each(cases)("%s", (_name, schema, ok, bad) => {
    const good = schema.safeParse(ok);
    expect(good.success, JSON.stringify(good.error?.issues)).toBe(true);
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it("akış olayları: her tür geçerli bir örnekle, bilinmeyen tür reddedilir", () => {
    const events = [
      { type: "status", state: "drafting", resumeState: null, running: true, lastEntryId: 3 },
      { type: "text", turnSeq: 1, index: 0, delta: "Örneklerinize baktım" },
      { type: "step", turnSeq: 1, step: "get_measurements", phase: "start" },
      { type: "question", entry: { id: 4, at: AT, role: "assistant", kind: "question", turnSeq: 1, text: question.text, group: "baglaclar", question } },
      { type: "revision", rev: 1, reason: "initial", changeCount: 7, summary: "İlk taslak", entryId: 6 },
      { type: "cost", costUsd: 0.31, turnUsd: 0.3, budgetUsd: 3, monthUsd: 2.4, monthLimitUsd: 20 },
      { type: "error", error: { code: "rate-limited", retryable: true, at: AT } },
      { type: "done", turnSeq: 1, state: "awaiting-user", stopReason: "ask_user" },
    ];
    expect(events.map((e) => e.type)).toEqual([...BUILD_STREAM_EVENT_TYPES]);
    for (const e of events) expect(BuildStreamEventSchema.safeParse(e).success, e.type).toBe(true);
    expect(BuildStreamEventSchema.safeParse({ type: "publish" }).success).toBe(false);
    expect(BuildStreamEventSchema.safeParse({ type: "step", turnSeq: 1, step: "publish_profile", phase: "start" }).success).toBe(false);
  });

  it("olay kimliği: <bootId>:<n> biçimi, bozuk kimlik null", () => {
    expect(formatBuildEventId("k7x", 12)).toBe("k7x:12");
    expect(parseBuildEventId("k7x:12")).toEqual({ bootId: "k7x", n: 12 });
    expect(parseBuildEventId("12")).toBeNull();
    expect(parseBuildEventId(undefined)).toBeNull();
  });
});

// ================================================================ AI araçları

describe("AI araçları", () => {
  it("tam olarak sekiz araç; yayın ya da ücretli deneme aracı yok", () => {
    expect([...BUILDER_TOOL_NAMES].sort()).toEqual(
      ["ask_user", "engine_trial", "get_measurements", "get_samples", "get_templates", "profile_schema", "propose_changes", "read_profile"].sort(),
    );
    expect(Object.keys(BUILDER_TOOLS).sort()).toEqual([...BUILDER_TOOL_NAMES].sort());
    for (const n of BUILDER_TOOL_NAMES) expect(n).not.toMatch(/publish|yayin|ai_trial|uretim|generate/);
    const writers = BUILDER_TOOL_NAMES.filter((n) => BUILDER_TOOLS[n].effect === "draft");
    expect(writers).toEqual(["propose_changes"]);
  });

  it.each(BUILDER_TOOL_NAMES)("%s katı araç tanımına çevrilir", (name) => {
    const schema = builderToolJsonSchema(name);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(strictSchemaProblem(schema)).toBeNull();
    expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems|default|anyOf|oneOf|const|pattern|\$ref)":/);
  });

  it("yapısal denetim katı olmayan şemayı yakalar", () => {
    expect(strictSchemaProblem({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toMatch(/additionalProperties/);
    expect(strictSchemaProblem({ type: "object", properties: {}, additionalProperties: false, minProperties: 1 })).toMatch(/minProperties/);
    expect(strictSchemaProblem({ type: "integer" })).toMatch(/tür/);
    expect(strictSchemaProblem({ type: "array" })).toMatch(/öğe/);
    expect(strictSchemaProblem({ anyOf: [{ type: "string" }] })).toMatch(/anyOf/);
  });

  const valid: Record<string, unknown> = {
    read_profile: { source: "draft", group: "boyut" },
    profile_schema: {},
    get_samples: { limit: 8 },
    get_measurements: {},
    get_templates: { keys: ["ek2"] },
    propose_changes: {
      note: "Tarih küçüldü, isimler kalınlaştı",
      changes: [
        { path: "sizing.tiers.tertiary", value_json: "0.38", evidence: { kind: "correction", entryId: 7 } },
        { path: "spacing.inkGaps.normal", value_json: "0.12", evidence: { kind: "measurement", key: "gaps.normal", n: 6 } },
        { path: "lineBreaking.notes", value_json: "null", evidence: { kind: "default" } },
      ],
    },
    engine_trial: { split: "test", limit: 20 },
    ask_user: {
      questions: [
        { id: "q1", group: "baglaclar", text: "& nasıl olsun?", options: [{ label: "Aynı satırda", value_json: "false" }, { label: "Ayrı satırda", value_json: "true" }], free: false, suggestion: 1 },
      ],
    },
  };
  const invalid: Record<string, unknown> = {
    read_profile: { source: "published" },
    profile_schema: { group: "yok" },
    get_samples: { limit: 0 },
    get_measurements: { fazla: 1 },
    get_templates: { keys: [] },
    propose_changes: { note: "x", changes: [{ path: "output.designFramePx", value_json: "500", evidence: { kind: "default" } }] },
    engine_trial: { split: "train", limit: 5 },
    ask_user: { questions: [] },
  };
  it.each(BUILDER_TOOL_NAMES)("%s girdisi: geçerli kabul, geçersiz ret", (name) => {
    const ok = parseBuilderToolInput(name, valid[name]);
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    expect(parseBuilderToolInput(name, invalid[name]).success).toBe(false);
  });

  it("propose_changes: kanıt kuralları", () => {
    const one = (path: string, value_json: string, evidence: unknown) => parseBuilderToolInput("propose_changes", { note: "n", changes: [{ path, value_json, evidence }] }).success;
    expect(one("sizing.fill", "0.94", { kind: "measurement", key: "fill", n: 5 })).toBe(true);
    expect(one("sizing.fill", "0.94", { kind: "measurement", n: 5 })).toBe(false);
    expect(one("sizing.fill", "0.94", { kind: "answer" })).toBe(false);
    expect(one("sizing.fill", "0.94", { kind: "answer", entryId: 2.5 })).toBe(false);
    expect(one("sizing.fill", "0.94", { kind: "default" })).toBe(false);
    expect(one("sizing.fill", "null", { kind: "answer", entryId: 3 })).toBe(false);
    expect(one("sizing.fill", "{bozuk", { kind: "answer", entryId: 3 })).toBe(false);
    expect(one("sizing.fill", "0.94", { kind: "answer", entryId: 3, key: "fill" })).toBe(false);
    expect(one("yok.alan", "1", { kind: "answer", entryId: 3 })).toBe(false);
    expect(toEvidence({ kind: "measurement", key: " fill ", n: 5 })).toEqual({ kind: "measurement", key: "fill", n: 5 });
    expect(toEvidence({ kind: "correction", entryId: 4 })).toEqual({ kind: "correction", entryId: 4 });
  });

  it("ask_user: öneri seçeneklerden biri, kimlikler benzersiz, seçenek değeri JSON", () => {
    const q = (extra: object) => ({ id: "q1", group: "boyut", text: "?", options: [{ label: "a" }, { label: "b" }], free: false, ...extra });
    expect(parseBuilderToolInput("ask_user", { questions: [q({ suggestion: 2 })] }).success).toBe(false);
    expect(parseBuilderToolInput("ask_user", { questions: [q({}), q({})] }).success).toBe(false);
    expect(parseBuilderToolInput("ask_user", { questions: [q({ options: [{ label: "a", value_json: "{x" }, { label: "b" }] })] }).success).toBe(false);
    expect(parseBuilderToolInput("ask_user", { questions: [q({ options: [], free: true })] }).success).toBe(true);
    expect(parseBuilderToolInput("ask_user", { questions: [q({ options: [], free: false })] }).success).toBe(false);
  });
});

// ================================================================ uçlar

describe("BUILDER_API", () => {
  const routes = Object.entries(BUILDER_API) as Array<[string, BuilderRouteDef]>;

  it("metot + yol benzersiz ve iki yol aynı isteği yakalamaz", () => {
    const keys = routes.map(([, r]) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const segs = (p: string) => p.split("/").filter(Boolean);
    for (let i = 0; i < routes.length; i++)
      for (let j = i + 1; j < routes.length; j++) {
        const [an, a] = routes[i]!;
        const [bn, b] = routes[j]!;
        if (a.method !== b.method) continue;
        const sa = segs(a.path);
        const sb = segs(b.path);
        if (sa.length !== sb.length) continue;
        const clash = sa.every((s, k) => s === sb[k] || s.startsWith(":") || sb[k]!.startsWith(":"));
        expect(clash, `${an} ↔ ${bn}`).toBe(false);
      }
  });

  it("hepsi /api altında, language.builder'a bağlı; durumlar ve gövde tutarlı", () => {
    for (const [name, r] of routes) {
      expect(r.path.startsWith("/api/"), name).toBe(true);
      expect(r.feature, name).toBe(BUILDER_FEATURE);
      expect(["read", "write", "spend"]).toContain(r.access);
      for (const s of r.states ?? []) expect(BUILD_STATES, name).toContain(s);
      if (r.method === "GET") expect(r.body, name).toBeUndefined();
      if (r.method === "GET") expect(r.access, name).toBe("read");
      if (r.kind === "json") expect(r.response, name).not.toBeNull();
      else expect(r.response, name).toBeNull();
      if (r.access === "spend") expect(r.errors, name).toContain("budget-exceeded");
      const params = [...r.path.matchAll(/:([a-z]+)/gi)].map((m) => m[1]);
      if (params.length) {
        const shape = (r.params as z.ZodObject<z.ZodRawShape>).shape;
        expect(Object.keys(shape).sort(), name).toEqual([...params].sort());
      } else expect(r.params, name).toBeUndefined();
    }
  });

  it("plandaki uçların hepsi var (§4.9)", () => {
    const keys = new Set(routes.map(([, r]) => `${r.method} ${r.path}`));
    for (const k of [
      "POST /api/builds/estimate",
      "POST /api/languages/:lang/builds",
      "GET /api/languages/:lang/builds/current",
      "GET /api/builds/:id",
      "GET /api/builds/:id/messages",
      "POST /api/builds/:id/messages",
      "POST /api/builds/:id/samples",
      "PATCH /api/builds/:id/samples/:sid",
      "DELETE /api/builds/:id/samples/:sid",
      "GET /api/builds/:id/samples/:sid/image.png",
      "POST /api/builds/:id/analyze",
      "POST /api/builds/:id/cancel",
      "GET /api/builds/:id/stream",
      "GET /api/builds/:id/revisions",
      "GET /api/builds/:id/revisions/:rev",
      "GET /api/builds/:id/diff",
      "GET /api/builds/:id/revisions/:rev/showcase",
      "POST /api/builds/:id/try",
      "POST /api/builds/:id/restore",
      "POST /api/builds/:id/publish",
      "GET /api/builds/:id/quality",
      "POST /api/builds/:id/close",
      "POST /api/languages/:lang/showcase",
    ])
      expect(keys.has(k), k).toBe(true);
  });

  it("tur başlatan uçlar harcama; yayın kullanıcı ucu ve modelsiz", () => {
    for (const n of ["postMessage", "analyze", "skipSamples", "resume", "tryText", "qualityAi"] as const) expect(BUILDER_API[n].access).toBe("spend");
    expect(BUILDER_API.publish.access).toBe("write");
    expect(BUILDER_API.languageShowcase.access).toBe("read");
    expect(builderRouteTable()).toHaveLength(routes.length);
    expect(builderRouteTable()[0]).toEqual({ key: "POST /api/builds/estimate", feature: "language.builder", access: "read" });
  });

  it("uç durumları durum makinesiyle uyumlu", () => {
    expect(BUILDER_API.analyze.states).toEqual(BUILD_EVENTS_FROM("analyze"));
    expect(BUILDER_API.skipSamples.states).toEqual(BUILD_EVENTS_FROM("skip-samples"));
    expect(BUILDER_API.cancel.states).toEqual(BUILD_EVENTS_FROM("cancel"));
    expect(BUILDER_API.resume.states).toEqual(BUILD_EVENTS_FROM("resume"));
    expect(BUILDER_API.publish.states).toEqual(BUILD_EVENTS_FROM("publish"));
    expect([...BUILDER_API.close.states].sort()).toEqual([...BUILD_EVENTS_FROM("close")].sort());
  });
});

function BUILD_EVENTS_FROM(event: BuildEvent): BuildState[] {
  return BUILD_STATES.filter((s) => canTransition(s, event));
}
