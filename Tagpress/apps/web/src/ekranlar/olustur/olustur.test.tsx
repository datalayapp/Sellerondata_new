// @vitest-environment happy-dom
import type { Build, BuildEntry, BuildQuestion, RevisionDetail, Sample, ShowcaseItem } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRoute } from "../../lib/route.ts";
import { click, flush, press, render, waitFor } from "../../tezgah/test/render.tsx";
import Olustur from "./index.tsx";

// ---------------------------------------------------------------- sahte sunucu (sözleşme: packages/domain/src/builder-api.ts)

const at = "2026-11-22T10:00:00.000Z";
const LANG = { id: "lav", name: "Lavanda", activeVersion: 2, hasDraft: false, templateCount: 3, isDefault: true, createdAt: at };

const mkBuild = (o: Partial<Build> = {}): Build => ({
  id: "b1",
  languageId: "lav",
  mode: "site",
  state: "intake",
  resumeState: null,
  base: "published",
  baseVersion: 2,
  currentRev: 0,
  costUsd: 0,
  budgetUsd: 3,
  budgetRaised: false,
  fromSetup: false,
  labelTypes: [],
  pendingQuestions: [],
  samples: [],
  turn: null,
  lastEntryId: 0,
  error: null,
  createdAt: at,
  updatedAt: at,
  ...o,
});

const mkSample = (id: string, o: Partial<Sample> = {}): Sample => ({
  id,
  buildId: "b1",
  name: `${id}.png`,
  w: 800,
  h: 800,
  status: "uploaded",
  quality: null,
  approx: false,
  templateKey: null,
  templateMatch: null,
  lines: [],
  fontFile: null,
  split: null,
  excluded: false,
  referenceId: null,
  imageUrl: `/api/builds/b1/samples/${id}/image.png`,
  error: null,
  createdAt: at,
  ...o,
});

const question = (o: Partial<BuildQuestion> = {}): BuildQuestion => ({
  id: "q1",
  entryId: 2,
  group: "satir-bolme",
  text: "Iki isim yan yana mi, alt alta mi?",
  measured: null,
  suggestion: 0,
  options: [
    { label: "Alt alta", value: "always" },
    { label: "Yan yana", value: "never" },
  ],
  free: true,
  paths: ["lineBreaking.coupleStack"],
  answered: false,
  ...o,
});

const entry = (id: number, o: Partial<BuildEntry>): BuildEntry => ({ id, at, role: "assistant", kind: "text", turnSeq: 1, text: null, group: null, ...o });

const profile = { sizing: { fill: 0.94, tiers: { secondary: 0.6, tertiary: 0.38, connector: 0.55 } }, spacing: { align: "center", inkGaps: { normal: 0.12 } } };
const detail = (rev: number): RevisionDetail => ({
  rev,
  at,
  reason: rev === 1 ? "initial" : "correction",
  summary: "",
  profile: profile as never,
  changes: rev === 0 ? [] : [{ path: "sizing.tiers.tertiary", group: "boyut", label: "sizing.tiers.tertiary", unit: "oran", from: 0.45, to: 0.38, source: { kind: "correction", ref: "5" } }],
});
const item = (id: string, o: Partial<ShowcaseItem> = {}): ShowcaseItem => ({
  id,
  labelType: "wedding",
  sampleId: null,
  text: "Ayse & Can 12.10.2026",
  templateKey: "a1",
  size: "3.8",
  sizeMm: { shape: "circle", w: 38, h: 38 },
  previewUrl: `/api/x/${id}.png`,
  changed: false,
  note: [],
  source: "preset",
  error: null,
  ...o,
});

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function server(start: { build?: Build | null; entries?: BuildEntry[]; estimate?: Record<string, unknown> } = {}) {
  const s = {
    build: start.build ?? null,
    entries: start.entries ?? [],
    estimate: { lowUsd: 0.9, highUsd: 1.3, sessionCapUsd: 3, monthUsd: 1.2, monthLimitUsd: 20, monthWarn: false, keySource: "org", ...start.estimate },
    calls: [] as Call[],
    /** "METOT yol" → bir kerelik hata. */
    fail: new Map<string, { status: number; body: Record<string, unknown> }>(),
    showcase: (rev: number) => [
      item("wedding", { changed: rev > 0, note: rev > 0 ? [{ label: "sizing.tiers.tertiary", direction: "down" }] : [] }),
      item("product", { labelType: "product", sizeMm: { shape: "rect", w: 63.5, h: 38.1 } }),
    ],
  };
  const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const b = () => s.build!;
  const routes: Array<[string, RegExp, (m: RegExpMatchArray, body: Record<string, unknown>, q: URLSearchParams) => unknown]> = [
    ["GET", /^\/api\/languages$/, () => ({ languages: [LANG] })],
    ["POST", /^\/api\/builds\/estimate$/, () => s.estimate],
    ["GET", /^\/api\/languages\/lav\/builds\/current$/, () => s.build],
    [
      "POST",
      /^\/api\/languages\/lav\/builds$/,
      (_, body) => {
        const types = (body.labelTypes as Build["labelTypes"] | undefined) ?? [];
        s.build = mkBuild({ base: body.base as Build["base"], fromSetup: !!body.fromSetup, labelTypes: types, state: body.fromSetup && types.length ? "samples" : "intake" });
        return s.build;
      },
    ],
    ["PUT", /^\/api\/builds\/b1\/intake$/, (_, body) => (s.build = { ...b(), state: "samples", labelTypes: body.labelTypes as Build["labelTypes"] })],
    [
      "POST",
      /^\/api\/builds\/b1\/samples$/,
      (_, body) => {
        const files = body.files as Array<{ name: string }>;
        const added = files.map((f, i) => mkSample(`s${b().samples.length + i + 1}`, { name: f.name }));
        s.build = { ...b(), samples: [...b().samples, ...added] };
        return { samples: added, rejected: [] };
      },
    ],
    [
      "PATCH",
      /^\/api\/builds\/b1\/samples\/(\w+)$/,
      (m, body) => {
        const sm = b().samples.find((x) => x.id === m[1])!;
        const next = { ...sm, ...(body.exclude !== undefined ? { excluded: body.exclude as boolean } : {}) };
        s.build = { ...b(), samples: b().samples.map((x) => (x.id === sm.id ? next : x)) };
        return next;
      },
    ],
    ["DELETE", /^\/api\/builds\/b1\/samples\/(\w+)$/, (m) => ((s.build = { ...b(), samples: b().samples.filter((x) => x.id !== m[1]) }), { ok: true })],
    ["POST", /^\/api\/builds\/b1\/analyze$/, () => (s.build = { ...b(), state: "analyzing" })],
    ["POST", /^\/api\/builds\/b1\/skip-samples$/, () => (s.build = { ...b(), state: "drafting", turn: { seq: 1, startedAt: at } })],
    ["GET", /^\/api\/builds\/b1\/messages$/, (_, __, q) => ({ entries: s.entries.filter((e) => e.id > Number(q.get("after") ?? 0)) })],
    [
      "POST",
      /^\/api\/builds\/b1\/messages$/,
      (_, body) => {
        const id = (s.entries.at(-1)?.id ?? 0) + 1;
        const e = entry(id, { role: "user", kind: body.kind as BuildEntry["kind"], text: (body.text as string) ?? null });
        s.entries = [...s.entries, e];
        s.build = { ...b(), state: b().currentRev > 0 ? "revising" : "drafting", pendingQuestions: [], turn: { seq: 2, startedAt: at }, lastEntryId: id };
        return { turn: { seq: 2 }, entries: [e] };
      },
    ],
    ["POST", /^\/api\/builds\/b1\/cancel$/, () => (s.build = { ...b(), state: "review", turn: null })],
    ["POST", /^\/api\/builds\/b1\/resume$/, () => (s.build = { ...b(), state: "drafting", error: null, resumeState: null })],
    ["POST", /^\/api\/builds\/b1\/budget\/raise$/, () => (s.build = { ...b(), budgetUsd: 6, budgetRaised: true })],
    [
      "POST",
      /^\/api\/builds\/b1\/close$/,
      () => {
        const closed = { ...b(), state: "closed" as const };
        s.build = null;
        return closed;
      },
    ],
    ["GET", /^\/api\/builds\/b1\/revisions\/(\d+)\/showcase$/, (m) => ({ items: s.showcase(Number(m[1])) })],
    ["GET", /^\/api\/builds\/b1\/revisions\/(\d+)$/, (m) => detail(Number(m[1]))],
    ["GET", /^\/api\/builds\/b1\/revisions$/, () => ({ revisions: [] })],
    ["GET", /^\/api\/builds\/b1\/quality$/, () => ({ rev: 1, test: null, testReason: "too-few-samples", ai: null, invariants: { unsupportedValues: 0, textChanged: 0, outsideSchema: 0 } })],
    [
      "POST",
      /^\/api\/builds\/b1\/try$/,
      () => ({
        estimateUsd: 0,
        costUsd: 0,
        mode: "engine",
        results: [
          {
            sampleId: "t",
            published: null,
            draft: { previewUrl: "/api/try.png", lines: [], sizesPx: [], issues: 0, issueList: [], costUsd: null, sameBreaksAsReference: null, sizeDiffVsReference: null },
          },
        ],
      }),
    ],
    [
      "POST",
      /^\/api\/builds\/b1\/restore$/,
      (_, body) => ((s.build = { ...b(), currentRev: b().currentRev + 1 }), { ...detail(b().currentRev), rev: b().currentRev, reason: "restore", restoredFrom: body.rev }),
    ],
    [
      "POST",
      /^\/api\/builds\/b1\/publish$/,
      () => {
        s.build = null;
        return { id: "p5", languageId: "lav", version: 5, status: "published", data: profile, note: "", createdAt: at };
      },
    ],
  ];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, "http://yerel");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    s.calls.push({ method, path: u.pathname, query: u.searchParams, body });
    const f = s.fail.get(`${method} ${u.pathname}`);
    if (f) {
      s.fail.delete(`${method} ${u.pathname}`);
      return json(f.body, f.status);
    }
    for (const [m, re, h] of routes) {
      const hit = method === m ? u.pathname.match(re) : null;
      if (hit) return json(h(hit, body, u.searchParams), method === "POST" && /\/builds$/.test(u.pathname) ? 201 : 200);
    }
    return json({ error: "yok" }, 404);
  };
  globalThis.fetch = Object.assign(fn, { mocked: true }) as unknown as typeof fetch;
  return s;
}
type Srv = ReturnType<typeof server>;
const callsTo = (s: Srv, method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

// ---------------------------------------------------------------- sahte oturum akışı (SSE)

class TestES {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: TestES[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  private listeners = new Map<string, Set<(e: { data: string }) => void>>();
  constructor(public url: string) {
    TestES.all.push(this);
  }
  addEventListener(t: string, fn: (e: { data: string }) => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
  emit(type: string, data: Record<string, unknown>) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify({ type, ...data }) });
  }
}
const stream = () => TestES.all.filter((x) => x.url === "/api/builds/b1/stream" && x.readyState !== 2).at(-1)!;
async function emit(type: string, data: Record<string, unknown> = {}) {
  await act(async () => stream().emit(type, data));
  await flush(4);
}

beforeEach(() => {
  TestES.all = [];
  // `render` sahte EventSource'u yeniden kurar; bu dosya kendi akışını kullanır (atamayı yok say).
  Object.defineProperty(globalThis, "EventSource", { configurable: true, get: () => TestES, set: () => {} });
  try {
    localStorage.clear();
  } catch {
    /* yok */
  }
});
afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------- yardımcılar

const route = (query = ""): AppRoute => ({ id: "tasarim-dili", rest: ["olustur"], query: new URLSearchParams(query) });
const dugme = (label: string, root: ParentNode = document.body) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim().startsWith(label)) ?? null;
const text = () => document.body.textContent ?? "";
const toasts = () => [...document.body.querySelectorAll(".tz-toast-m")].map((x) => x.textContent);
const kutu = () => document.querySelector<HTMLTextAreaElement>("textarea.ol-kutu, .ol-kutu textarea")!;
async function yaz(el: HTMLTextAreaElement | HTMLInputElement, v: string) {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function ac(srv: Srv, query = "", go = vi.fn()) {
  void srv;
  const r = await render(<Olustur route={route(query)} go={go} />);
  await flush(6);
  return { r, go };
}

// ---------------------------------------------------------------- testler

describe("Oluştur: başlangıç ve örnekler", () => {
  it("oturum yokken tahmin ve Başla; giriş türleri; örnek yükleme; Ölç ve başla", async () => {
    const srv = server();
    const { r } = await ac(srv);
    await waitFor(() => text().includes("Tasarım dilinizi yapay zekâ ile kurun"));
    expect(text()).toContain("Tahmini maliyet");
    expect(text()).toContain("oturum sınırı $3,00");
    expect(callsTo(srv, "POST", "/api/builds/estimate")[0]?.body).toEqual({ languageId: "lav", samples: 0 });
    expect(document.querySelectorAll(".tz-btn--primary").length).toBe(1);

    await click(dugme("Başla")!);
    await waitFor(() => text().includes("Ne tür etiketler yapıyorsunuz?"));
    expect(callsTo(srv, "POST", "/api/languages/lav/builds")[0]?.body).toEqual({ base: "published" });
    expect(dugme("Devam et")!.disabled).toBe(true);
    await click(dugme("Düğün ve nişan")!);
    await click(dugme("Teşekkür")!);
    await click(dugme("Devam et")!);
    await waitFor(() => text().includes("Bitmiş etiketlerinizden örnek yükleyin"));
    expect(callsTo(srv, "PUT", "/api/builds/b1/intake")[0]?.body).toEqual({ labelTypes: ["wedding", "thanks"] });
    expect(dugme("Ölç ve başla")!.disabled).toBe(true);

    // Dosya seçimi: uygun dosya base64 gider; uygunsuz tarayıcıda elenir ve söylenir.
    const input = document.querySelector<HTMLInputElement>("[data-testid=ol-dosya]")!;
    const ok = new File([new Uint8Array([1, 2, 3])], "ayse.png", { type: "image/png" });
    const bad = new File(["x"], "not.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [ok, bad] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/samples").length === 1);
    expect(callsTo(srv, "POST", "/api/builds/b1/samples")[0]?.body).toEqual({ files: [{ name: "ayse.png", dataBase64: "AQID" }] });
    await waitFor(() => document.querySelector(".ol-kart"));
    expect(toasts()).toContain("1 örnek eklendi.");
    expect(toasts()).toContain("not.txt eklenmedi: yalnız PNG, JPG ya da PDF");

    await click(dugme("Ölç ve başla")!);
    await waitFor(() => text().includes("Örnekleriniz ölçülüyor"));
    expect(callsTo(srv, "POST", "/api/builds/b1/analyze").length).toBe(1);
    await emit("step", { turnSeq: null, step: "measure", phase: "start", sampleId: "s1" });
    expect(text()).toContain("Örnekler ölçülüyor");
    await r.unmount();
  });

  it("örneğim yok: sorularla kurulur", async () => {
    const srv = server({ build: mkBuild({ state: "samples", labelTypes: ["wedding"] }) });
    const { r } = await ac(srv);
    await waitFor(() => dugme("Örneğim yok"));
    await click(dugme("Örneğim yok")!);
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/skip-samples").length === 1);
    await waitFor(() => text().includes("Diliniz kuruluyor"));
    await r.unmount();
  });

  it("örnek penceresi: dışarıda bırak ve sil", async () => {
    const srv = server({
      build: mkBuild({
        state: "samples",
        samples: [mkSample("s1", { status: "measured", quality: "exact", lines: [{ text: "Ayse", ink: null, gapAbovePx: null, fontFile: null, textSource: "transcribe" }] })],
      }),
    });
    const { r } = await ac(srv);
    await waitFor(() => document.querySelector(".ol-kart"));
    await click(document.querySelector(".ol-kart")!);
    const dlg = await waitFor(() => document.querySelector("dialog"));
    expect(dlg.textContent).toContain("Ölçüldü");
    await click(dlg.querySelector("[role=switch]")!);
    await waitFor(() => callsTo(srv, "PATCH", "/api/builds/b1/samples/s1").length === 1);
    expect(callsTo(srv, "PATCH", "/api/builds/b1/samples/s1")[0]?.body).toEqual({ exclude: true });
    await click(dugme("Sil", document.querySelector("dialog")!)!);
    const onay = await waitFor(() => [...document.querySelectorAll("dialog")].find((d) => d.textContent?.includes("Örnek silinsin mi?")));
    await click(dugme("Sil", onay)!);
    await waitFor(() => callsTo(srv, "DELETE", "/api/builds/b1/samples/s1").length === 1);
    await r.unmount();
  });
});

describe("Oluştur: tur, soru ve cevap", () => {
  it("ölçümden sonra canlı metin, soru gelir; hazır cevap tek tıkla gider", async () => {
    const srv = server({ build: mkBuild({ state: "analyzing", samples: [mkSample("s1")] }) });
    const { r } = await ac(srv);
    await waitFor(() => text().includes("Örnekleriniz ölçülüyor"));
    await waitFor(() => TestES.all.some((x) => x.url === "/api/builds/b1/stream"));

    srv.build = { ...srv.build!, state: "drafting", turn: { seq: 1, startedAt: at } };
    await emit("status", { state: "drafting", resumeState: null, running: true, lastEntryId: 0 });
    await emit("text", { turnSeq: 1, index: 0, delta: "Orneklerinize " });
    await emit("text", { turnSeq: 1, index: 0, delta: "baktim." });
    await waitFor(() => document.querySelector(".ol-msg.is-canli")?.textContent === "Orneklerinize baktim.");
    await emit("step", { turnSeq: 1, step: "propose_changes", phase: "start" });
    expect(text()).toContain("Kurallar yazılıyor");

    const q = question();
    const qe = entry(2, { kind: "question", question: q, group: "satir-bolme" });
    srv.entries = [entry(1, { text: "Orneklerinize baktim." }), qe];
    srv.build = { ...srv.build!, state: "awaiting-user", turn: null, pendingQuestions: [q], lastEntryId: 2 };
    await emit("question", { entry: qe });
    await emit("done", { turnSeq: 1, state: "awaiting-user", stopReason: "ask_user" });
    await waitFor(() => text().includes("Soruları cevaplayın"));
    expect(document.querySelector(".ol-msg.is-canli")).toBeNull();
    expect(text()).toContain(q.text);
    const chip = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".ol-chip")].find((b) => b.textContent?.startsWith("Alt alta")));
    expect(chip.disabled).toBe(false);
    expect(chip.classList.contains("is-oneri")).toBe(true);

    await click(chip);
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/messages").length === 1);
    expect(callsTo(srv, "POST", "/api/builds/b1/messages")[0]?.body).toEqual({ kind: "answer", answers: [{ questionId: "q1", option: 0 }] });
    await waitFor(() => text().includes("Diliniz kuruluyor"));
    await r.unmount();
  });

  it("serbest cevap yazı kutusundan Enter ile gider; Shift Enter göndermez", async () => {
    const q = question({ options: [] });
    const srv = server({ build: mkBuild({ state: "awaiting-user", pendingQuestions: [q], lastEntryId: 1 }), entries: [entry(1, { kind: "question", question: q })] });
    const { r } = await ac(srv);
    await waitFor(() => text().includes(q.text));
    const box = kutu();
    await yaz(box, "alt alta, ortada");
    await press("Enter", { target: box, shiftKey: true });
    expect(callsTo(srv, "POST", "/api/builds/b1/messages").length).toBe(0);
    await press("Enter", { target: box });
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/messages").length === 1);
    expect(callsTo(srv, "POST", "/api/builds/b1/messages")[0]?.body).toEqual({ kind: "answer", answers: [{ questionId: "q1", text: "alt alta, ortada" }] });
    await waitFor(() => kutu().value === "");
    await r.unmount();
  });
});

describe("Oluştur: gösterim, düzeltme ve yayın", () => {
  const review = () => mkBuild({ state: "review", currentRev: 2, costUsd: 0.47, lastEntryId: 1, samples: [mkSample("s1", { status: "measured" })] });

  it("örnek etiketler, değişen kural; düzeltme; önceki sürümle karşılaştırma; geri dönüş", async () => {
    const srv = server({ build: review(), entries: [entry(1, { kind: "revision", rev: 2, text: "tarih kucultuldu" })] });
    const { r } = await ac(srv);
    await waitFor(() => document.querySelectorAll(".tz-ab").length >= 2);
    expect(callsTo(srv, "GET", "/api/builds/b1/revisions/2/showcase")[0]?.query.get("locale")).toBe("tr");
    expect(text()).toContain("Düğün ve nişan");
    expect(text()).toContain("Ø 38 mm");
    expect(text()).toContain("63,5 × 38,1 mm");
    expect(document.querySelector(".ol-chg-t")?.textContent).toMatch(/küçüldü$/);
    expect(document.querySelectorAll(".tz-ab.is-sel").length).toBe(1);
    // Sağda değişen kural vurgulu, eski değer üstü çizili, kaynağı yanında.
    const chg = await waitFor(() => document.querySelector(".ol-kv.is-chg"));
    expect(chg.querySelector("s")?.textContent).toBe("%45");
    expect(chg.textContent).toContain("%38");
    expect(chg.textContent).toContain("düzeltmeniz");
    expect(text()).toContain("Sürüm 1 → Sürüm 2 · taslak: 1 kural değişti");
    expect(text()).toContain("Harcanan $0,470 / $3,00");
    expect(document.querySelectorAll(".tz-btn--primary").length).toBe(1);

    // Düzeltme: yazı kutusu + Enter.
    await yaz(kutu(), "tarihi biraz daha kucult");
    await press("Enter", { target: kutu() });
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/messages").length === 1);
    expect(callsTo(srv, "POST", "/api/builds/b1/messages")[0]?.body).toEqual({ kind: "correction", text: "tarihi biraz daha kucult" });
    await waitFor(() => document.querySelector(".ol-msg--me")?.textContent === "tarihi biraz daha kucult");
    // Tur bitti, yeni sürüm yok (sunucu incelemeye döndü).
    srv.build = { ...srv.build!, state: "review", turn: null };
    await emit("done", { turnSeq: 2, state: "review", stopReason: "end_turn" });
    await waitFor(() => !dugme("Yayınla")?.disabled);

    // V: önceki sürüm; "Bu sürüme dön".
    await press("v");
    await waitFor(() => document.querySelector('[role=radio][aria-checked="true"]')?.textContent === "Sürüm 1");
    await waitFor(() => callsTo(srv, "GET", "/api/builds/b1/revisions/1/showcase").length === 1);
    await click(dugme("Bu sürüme dön")!);
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/restore").length === 1);
    expect(callsTo(srv, "POST", "/api/builds/b1/restore")[0]?.body).toEqual({ rev: 1 });
    await waitFor(() => toasts().includes("Sürüm 3 yazıldı."));
    await r.unmount();
  });

  it("kendi metniyle ücretsiz deneme", async () => {
    const srv = server({ build: review() });
    const { r } = await ac(srv);
    const field = await waitFor(() => document.querySelector<HTMLInputElement>(".ol-dene input"));
    await yaz(field, "Mina & Ali");
    await click(dugme("Dene", document.querySelector(".ol-dene")!)!);
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/try").length === 1);
    expect(callsTo(srv, "POST", "/api/builds/b1/try")[0]?.body).toEqual({ text: "Mina & Ali", rev: 2, mode: "engine" });
    await waitFor(() => text().includes("Kendi metniniz"));
    expect(document.querySelector('img[src="/api/try.png"]')).not.toBeNull();
    await r.unmount();
  });

  it("Yayınla: onay, not, bitti sayfası ve özete geçiş; kurulumdan gelindiyse geri dönüş", async () => {
    const srv = server({ build: review() });
    const { r, go } = await ac(srv);
    await waitFor(() => !dugme("Yayınla")?.disabled);
    await click(dugme("Yayınla")!);
    const dlg = await waitFor(() => document.querySelector("dialog"));
    expect(dlg.textContent).toContain("Tasarım dili yayınlansın mı?");
    await yaz(dlg.querySelector("input")!, "ilk dil");
    await click(dugme("Yayınla", dlg)!);
    await waitFor(() => text().includes("Sürüm 5 yayında"));
    expect(callsTo(srv, "POST", "/api/builds/b1/publish")[0]?.body).toEqual({ note: "ilk dil" });
    await click(dugme("Özete git")!);
    expect(go).toHaveBeenCalledWith("tasarim-dili", ["ozet"]);
    await r.unmount();

    const srv2 = server({ build: review() });
    const { r: r2, go: go2 } = await ac(srv2, "kurulum=1&don=%23%2Fkurulum%2Fprint");
    await waitFor(() => !dugme("Yayınla")?.disabled);
    await click(dugme("Yayınla")!);
    await click(dugme("Yayınla", await waitFor(() => document.querySelector("dialog")))!);
    await waitFor(() => dugme("Kuruluma dön"));
    await press("Enter", { ctrlKey: true });
    expect(go2).toHaveBeenCalledWith("kurulum", ["print"], {});
    await r2.unmount();
  });

  it("Yayınla: oturum sürerken dil başka yerden değiştiyse açık uyarı; onaylanırsa yine de yayınlanır (overwrite)", async () => {
    const srv = server({ build: review() });
    srv.fail.set("POST /api/builds/b1/publish", { status: 409, body: { error: "degisti", code: "build-base-changed", baseVersion: 4, publishedVersion: 6, draftChanged: false } });
    const { r } = await ac(srv);
    await waitFor(() => !dugme("Yayınla")?.disabled);
    await click(dugme("Yayınla")!);
    await click(dugme("Yayınla", await waitFor(() => document.querySelector("dialog")))!);
    const warn = await waitFor(() => [...document.querySelectorAll("dialog")].find((d) => d.textContent?.includes("Tasarım dili bu arada değişti")));
    expect(warn.textContent).toContain("başka bir sürüm yayınlandı (sürüm 6)");
    await click(dugme("Yine de yayınla", warn)!);
    await waitFor(() => text().includes("Sürüm 5 yayında"));
    expect(callsTo(srv, "POST", "/api/builds/b1/publish").map((c) => c.body)).toEqual([{}, { overwrite: true }]);
    await r.unmount();
  });
});

describe("Oluştur: bütçe, anahtar ve kesinti", () => {
  it("oturum sınırı: kutu, artır ve aynı iletiyi yeniden gönder", async () => {
    const srv = server({ build: mkBuild({ state: "review", currentRev: 1, costUsd: 2.95 }) });
    srv.fail.set("POST /api/builds/b1/messages", { status: 409, body: { error: "sinir", code: "budget-exceeded", scope: "session", usedUsd: 2.95, limitUsd: 3, estimateUsd: 0.08, canRaise: true } });
    const { r } = await ac(srv);
    await waitFor(() => kutu());
    await yaz(kutu(), "isimler daha kalin");
    await press("Enter", { target: kutu() });
    await waitFor(() => text().includes("Oturum sınırı doldu."));
    expect(text()).toContain("Harcanan $2,95 / $3,00; bu adım ~$0,080.");
    expect(kutu().value).toBe("isimler daha kalin");
    await click(dugme("Sınırı artır ve devam et")!);
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/messages").length === 2);
    expect(callsTo(srv, "POST", "/api/builds/b1/budget/raise").length).toBe(1);
    expect(callsTo(srv, "POST", "/api/builds/b1/messages")[1]?.body).toEqual({ kind: "correction", text: "isimler daha kalin" });
    await waitFor(() => !text().includes("Oturum sınırı doldu."));
    expect(toasts()).toContain("Oturum sınırı $6,00 oldu.");
    // Yeniden gönderilen ileti gitti: yazı kutusu temizlenir.
    await waitFor(() => kutu().value === "");
    await r.unmount();
  });

  it("aylık sınır: artırma yok", async () => {
    const srv = server({ build: mkBuild({ state: "samples", samples: [mkSample("s1")] }) });
    srv.fail.set("POST /api/builds/b1/analyze", { status: 409, body: { error: "ay", code: "budget-exceeded", scope: "month", usedUsd: 20, limitUsd: 20, estimateUsd: 0.5, canRaise: false } });
    const { r } = await ac(srv);
    await waitFor(() => dugme("Ölç ve başla") && !dugme("Ölç ve başla")!.disabled);
    await click(dugme("Ölç ve başla")!);
    await waitFor(() => text().includes("Aylık sınır doldu."));
    expect(dugme("Sınırı artır")).toBeNull();
    await r.unmount();
  });

  it("anahtar yoksa Başla pasif ve Bağlantılar'a git; oturum açılırken anahtar hatası da gösterilir", async () => {
    const srv = server({ estimate: { keySource: null } });
    const { r } = await ac(srv);
    await waitFor(() => text().includes("Yapay zekâ anahtarı yok."));
    expect(dugme("Başla")!.disabled).toBe(true);
    expect(dugme("Bağlantılar'a git")).not.toBeNull();
    await r.unmount();

    const srv2 = server();
    srv2.fail.set("POST /api/languages/lav/builds", {
      status: 409,
      body: { error: "Anthropic anahtari yok.", code: "missing-key", provider: "anthropic", keySource: "org", params: { providerName: "Anthropic" } },
    });
    const { r: r2 } = await ac(srv2);
    await waitFor(() => dugme("Başla") && !dugme("Başla")!.disabled);
    await click(dugme("Başla")!);
    await waitFor(() => dugme("Bağlantılar'a git"));
    expect(text()).toContain("Anthropic anahtarı yok");
    await r2.unmount();
  });

  it("yarıda kalan oturum: Devam et (Ctrl Enter da)", async () => {
    const srv = server({ build: mkBuild({ state: "interrupted", resumeState: "drafting", error: { code: "interrupted", retryable: true, at } }) });
    const { r } = await ac(srv);
    await waitFor(() => text().includes("Sunucu çalışırken kapandı."));
    expect(document.querySelectorAll(".tz-btn--primary").length).toBe(1);
    await press("Enter", { ctrlKey: true });
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/resume").length === 1);
    await waitFor(() => text().includes("Diliniz kuruluyor"));
    await r.unmount();
  });

  it("yeniden denenemeyen hata: Devam et yok, oturum kapatılır", async () => {
    const srv = server({ build: mkBuild({ state: "failed", resumeState: "revising", currentRev: 1, error: { code: "key-invalid", retryable: false, at } }) });
    const { r } = await ac(srv);
    await waitFor(() => text().includes("Yapay zekâ anahtarı geçersiz."));
    expect(dugme("Devam et")).toBeNull();
    expect(dugme("Yayınla")!.disabled).toBe(true);
    await click(dugme("Oturumu kapat", document.querySelector(".tz-pnl--l")!)!);
    const onay = await waitFor(() => document.querySelector("dialog"));
    await click(dugme("Oturumu kapat", onay)!);
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/close").length === 1);
    await waitFor(() => text().includes("Tasarım dilinizi yapay zekâ ile kurun"));
    await r.unmount();
  });

  it("çalışırken Durdur; tur sürerken yazı kutusu kapalı", async () => {
    const srv = server({ build: mkBuild({ state: "revising", currentRev: 1, turn: { seq: 3, startedAt: at } }) });
    const { r } = await ac(srv);
    await waitFor(() => document.querySelector(".tz-ab"));
    expect(kutu().disabled).toBe(true);
    await click(document.querySelector<HTMLButtonElement>('.ol-composer button[aria-label="Durdur"]')!);
    await waitFor(() => callsTo(srv, "POST", "/api/builds/b1/cancel").length === 1);
    await waitFor(() => !kutu().disabled);
    await r.unmount();
  });
});

describe("Oluştur: kurulumdan giriş ve erişilebilirlik", () => {
  it("kurulumdan: türlerle oturum açılır (bilinmeyen tür atlanır), taban varsayılan", async () => {
    const srv = server();
    const { r } = await ac(srv, "kurulum=1&turler=wedding,bilinmez,sticker");
    await waitFor(() => text().includes("Etiket türleri: Düğün ve nişan, Sticker."));
    expect(document.querySelector("[role=radiogroup]")).toBeNull();
    await waitFor(() => dugme("Başla") && !dugme("Başla")!.disabled);
    await press("Enter", { ctrlKey: true });
    await waitFor(() => callsTo(srv, "POST", "/api/languages/lav/builds").length === 1);
    expect(callsTo(srv, "POST", "/api/languages/lav/builds")[0]?.body).toEqual({ base: "default", fromSetup: true, labelTypes: ["wedding", "sticker"] });
    await waitFor(() => text().includes("Bitmiş etiketlerinizden örnek yükleyin"));
    await r.unmount();
  });

  it("iş satırında dilin adı ve sekme adı Oluştur; Claude Code yolu ⋯ menüsünde, komut kopyalanabilir", async () => {
    const srv = server();
    const { r, go } = await ac(srv);
    await waitFor(() => text().includes("Tasarım dilinizi yapay zekâ ile kurun"));
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toBe("Lavanda");
    expect(document.querySelector(".tz-btabs [aria-selected=true]")?.textContent).toBe("Oluştur");
    expect(document.querySelector(".ol-baslik")?.closest(".ol-sayfa")).not.toBeNull();
    await click(document.querySelector<HTMLElement>('.tz-ctx [aria-label="Diğer"]')!);
    await click([...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((x) => x.textContent?.includes("Claude Code ile oluştur"))!);
    const dialog = await waitFor(() => document.querySelector("dialog"));
    expect(dialog.textContent).toContain("Claude Code'da komutu çalıştırın");
    expect(dialog.querySelector("code")?.textContent).toBe("/tasarim-dili");
    await click(dugme("Kuralları aç", dialog)!);
    expect(go).toHaveBeenCalledWith("tasarim-dili", ["kurallar"]);
    await r.unmount();
  });

  it("ikon düğmeleri adlı; sekmeler Tasarım diline gider; kısayol listesinde Oluştur komutları", async () => {
    const srv = server({ build: mkBuild({ state: "review", currentRev: 1 }) });
    const { r, go } = await ac(srv);
    await waitFor(() => document.querySelector(".tz-ab"));
    for (const b of document.body.querySelectorAll<HTMLElement>(".tz-ib")) expect(b.getAttribute("aria-label")?.trim(), b.outerHTML).toBeTruthy();
    const tab = [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((x) => x.textContent?.startsWith("Kurallar"))!;
    await click(tab);
    expect(go).toHaveBeenCalledWith("tasarim-dili", ["kurallar"]);
    await press("c");
    expect(document.activeElement).toBe(kutu());
    await r.unmount();
  });
});
