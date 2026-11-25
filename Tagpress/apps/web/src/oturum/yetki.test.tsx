// @vitest-environment happy-dom
import { fixMsg, type ImportPreviewResponse, type ImportRow, issueMsg, type JobLog, type VariantDetail } from "@tagpress/domain";
import { initShellI18n } from "@sellerondata/shell";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingImport } from "../ekranlar/ice-aktar/bekleyen.ts";
import IceAktarEkrani from "../ekranlar/ice-aktar/index.tsx";
import { Details } from "../ekranlar/uretim/Ayrintilar.tsx";
import { sumUsd } from "../i18n/bicim.ts";
import { resources } from "../i18n/index.ts";
import { setTestLocale } from "../i18n/test.ts";
import { api } from "../lib/api.ts";
import { apiUrl, rewriteApiUrls } from "../lib/platform.ts";
import { parseHash } from "../lib/route.ts";
import { backoff, openStream, SseParser } from "../lib/sse.ts";
import { ElleEkle } from "../ortak/ElleEkle.tsx";
import { setShortcutsOpen } from "../tezgah/kisayol/kayit.ts";
import { TezgahApp } from "../tezgah/rotalar.tsx";
import { click, flush, mockFetch, press, render, waitFor } from "../tezgah/test/render.tsx";
import { bindSession, createTagpressSession } from "./istemci.ts";

/**
 * Platform kipi, yetki incelemesi (R1) düzeltmelerine uyum: harcama izni yoksa `generate: true` gönderilmez; yönetici
 * olmayan `GET /api/costs` sormaz; gizlenen tutar (`null`) "—" görünür; sunucu kapattığı akış yeniden bağlanır
 * (`Last-Event-ID`, 401'de oturum yenilenir); yedek font adresleri iki kez öneklenmez. Sunucu sahte `fetch`.
 */
beforeAll(() => {
  vi.stubEnv("VITE_TAGPRESS_PLATFORM", "1");
  initShellI18n({ resources, defaultNS: "common", locale: "tr" });
});
afterAll(() => {
  vi.unstubAllEnvs();
  setTestLocale("tr");
});
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* yok */
  }
});
afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

type Access = { edit: boolean; spend: boolean; manage: boolean };
const SETUP = { status: "completed", step: 3, answers: { labelTypes: [] }, completedAt: "2026-11-01T00:00:00Z", skipped: false };
const org = (access: Access) => ({ org: { id: "org-a", name: "Atölye A" }, setup: SETUP, features: { registry: [], effective: {}, explicit: {} }, platform: true, access });
const USER: Access = { edit: true, spend: false, manage: false };
const LANGS = { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] };

/** Yerel yollar (`/api/x`) → platform yolları (`/api/tagpress/x`). */
const platformRoutes = (routes: Record<string, unknown>) => Object.fromEntries(Object.entries(routes).map(([k, v]) => [apiUrl(k), v]));
/** Görünen adıyla düğme (kısayol rozeti `.tz-kbd` sayılmaz). */
const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => {
    const c = b.cloneNode(true) as HTMLElement;
    for (const k of c.querySelectorAll(".tz-kbd")) k.remove();
    return c.textContent?.trim() === text;
  });

describe("harcama izni yoksa üretim gönderilmez", () => {
  const row = (index: number): ImportRow => ({
    raw: {},
    include: true,
    textRaw: "Ayşe & Can",
    text: "Ayşe & Can",
    segments: ["Ayşe & Can"],
    templateInput: "a12",
    templateKey: "a12",
    labelSize: "3.8",
    orderNo: `90${index}`,
    quantity: 50,
    product: null,
    kind: "label",
    aiNote: "",
    dismissed: [],
    issues: index === 1 ? [{ ...issueMsg("duplicate-in-file", { row: 1 }), severity: "warning", fixes: [fixMsg("skip")] }] : [],
    dedupeKey: `k${index}`,
    index,
  });
  const PREVIEW: ImportPreviewResponse = {
    languageId: "dil-1",
    fileName: "Etiketler.json",
    fields: ["metin"],
    mapping: { text: "metin", template: null, orderNo: null, quantity: null, product: null, size: null },
    mappingSource: { text: "name", template: null, orderNo: null, quantity: null, product: null, size: null },
    format: "array",
    rows: [row(0), row(1)],
    warnings: [],
    summary: { total: 2, included: 2, errors: 0, warnings: 1, duplicates: 0, stickers: 0, byCode: {} },
    templateKeys: ["a12"],
    labelSizes: [{ id: "3.8", cm: 3.8 } as ImportPreviewResponse["labelSizes"][number]],
  };

  async function masa(access: Access) {
    const { calls } = mockFetch(
      platformRoutes({
        "/api/org": org(access),
        "/api/languages": LANGS,
        "/api/generate/status": { running: 0, queued: 0 },
        "/api/import/preview": PREVIEW,
        "/api/import/validate": { rows: [], summary: PREVIEW.summary },
        "/api/import/commit": { batchId: "p1", jobIds: ["j1", "j2"], created: 2, skipped: [], queued: [] },
      }),
    );
    setPendingImport(new File([JSON.stringify([{ metin: "Ayşe & Can" }])], "Etiketler.json", { type: "application/json" }));
    const r = await render(<IceAktarEkrani route={parseHash("#/uretim/ice-aktar")} go={vi.fn()} />);
    await waitFor(() => document.querySelector(".ia-row"));
    await flush(3);
    return { r, calls };
  }
  const commits = (calls: ReturnType<typeof mockFetch>["calls"]) => calls.filter((c) => c.url.includes("/import/commit"));

  it("içe aktarma: 'İçe aktar ve üret' pasif, Ctrl Enter bir şey göndermez; üretimsiz aktarma generate:false ile gider", async () => {
    const { r, calls } = await masa(USER);
    await waitFor(() => button("İçe aktar") && !button("İçe aktar")!.disabled);
    expect(button("İçe aktar ve üret")?.disabled).toBe(true);
    await press("Enter", { ctrlKey: true });
    await flush(3);
    expect(commits(calls)).toHaveLength(0);
    await click(button("İçe aktar")!);
    await waitFor(() => commits(calls).length > 0);
    expect(commits(calls)).toHaveLength(1);
    expect(commits(calls)[0]?.url).toBe("/api/tagpress/import/commit");
    expect(commits(calls)[0]?.body).toMatchObject({ generate: false });
    await r.unmount();
  });

  it("içe aktarma: izin varsa 'İçe aktar ve üret' generate:true gönderir", async () => {
    const { r, calls } = await masa({ edit: true, spend: true, manage: false });
    await waitFor(() => button("İçe aktar ve üret") && !button("İçe aktar ve üret")!.disabled);
    await click(button("İçe aktar ve üret")!);
    await waitFor(() => commits(calls).length > 0);
    expect(commits(calls)[0]?.body).toMatchObject({ generate: true });
    await r.unmount();
  });

  it("elle iş: 'Ekle ve üret' pasif, Ctrl Shift Enter bir şey göndermez; 'Ekle' generate:false ile gider", async () => {
    const { calls } = mockFetch(
      platformRoutes({
        "/api/org": org(USER),
        "/api/languages": LANGS,
        "/api/import/validate": { rows: [{ index: 0, issues: [] }], summary: {} },
        "/api/jobs/manual": { id: "j9", batchId: "b9", orderNo: null },
      }),
    );
    const r = await render(<ElleEkle open languageId="dil-1" onClose={vi.fn()} onAdded={vi.fn()} />);
    const ta = await waitFor(() => document.body.querySelector<HTMLTextAreaElement>(".or-ea textarea"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(ta, "Ayşe & Can");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => button("Ekle") && !button("Ekle")!.disabled);
    expect(button("Ekle ve üret")?.disabled).toBe(true);
    await press("Enter", { ctrlKey: true, shiftKey: true, target: ta });
    await flush(3);
    const manual = () => calls.filter((c) => c.url.includes("/jobs/manual"));
    expect(manual()).toHaveLength(0);
    await click(button("Ekle")!);
    await waitFor(() => manual().length > 0);
    expect(manual()[0]?.url).toBe("/api/tagpress/jobs/manual");
    expect(manual()[0]?.body).toMatchObject({ text: "Ayşe & Can", generate: false });
    await r.unmount();
  });
});

describe("harcama tutarları yalnız yöneticiye", () => {
  const JOB = {
    id: "j1",
    batchId: "b1",
    languageId: "dil-1",
    seq: 1,
    orderNo: "9011",
    quantity: 60,
    templateKey: "a15",
    labelSize: "3.8",
    product: null,
    text: "Elif & Kerem",
    segments: [],
    kind: "label",
    aiNote: "",
    status: "new",
    error: null,
    approvedVariantId: null,
    issues: [],
    worst: null,
    variants: [],
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:00.000Z",
  };
  const BATCH = { id: "b1", languageId: "dil-1", name: "21 Kasım partisi", sourceFile: null, createdAt: "2026-11-21T10:00:00.000Z", total: 1, byStatus: { new: 1 }, withIssues: 0, approved: 0 };

  function sunucu(access: Access) {
    return mockFetch(
      platformRoutes({
        "/api/org": org(access),
        "/api/languages": LANGS,
        "/api/generate/status": { running: 0, queued: 0, concurrency: 1, runningJobIds: [] },
        "/api/jobs": { jobs: [JOB], total: 1 },
        "/api/jobs/j1": { ...JOB, raw: {}, textRaw: JOB.text, dismissed: [], batchName: BATCH.name },
        "/api/jobs/j1/log": { steps: [], aiCalls: [], running: false },
        "/api/batches": { batches: [BATCH] },
        "/api/print/shelf": { items: [] },
        "/api/languages/dil-1/templates": { templates: [] },
        "/api/languages/dil-1/profile": { data: { output: { sizes: [{ id: "3.8", cm: 3.8, framePx: 440 }], defaultSize: "3.8" } } },
        "/api/costs": { todayUsd: 0.42, monthUsd: 3.5, totalUsd: 9, byDay: [], byModel: [], byPurpose: [], unpricedCalls: 0 },
        "/api/fonts": { fonts: [] },
      }),
    ).calls;
  }
  const costCalls = (calls: ReturnType<typeof mockFetch>["calls"]) => calls.filter((c) => c.url.includes("/costs"));

  it("Kullanıcı: Üretim ekranı ve Ayarlar › Maliyet adresi /costs hiç sormaz; 'Bugün $X' yok", async () => {
    const calls = sunucu(USER);
    window.location.hash = "#/uretim?is=j1";
    const r = await render(<TezgahApp />);
    await waitFor(() => document.querySelectorAll("[data-job]").length === 1);
    await waitFor(() => calls.some((c) => c.url === "/api/tagpress/org"));
    await flush(6);
    expect(document.body.textContent).not.toContain("Bugün ~$");
    await act(async () => {
      window.location.hash = "#/ayarlar/maliyet";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => document.querySelector(".ay-gl"));
    await flush(6);
    expect(costCalls(calls)).toEqual([]);
    await r.unmount();
  });

  it("Yönetici: aynı ekran günün maliyetini sorar (denetim: sınama boş geçmiyor)", async () => {
    const calls = sunucu({ edit: true, spend: true, manage: true });
    window.location.hash = "#/uretim?is=j1";
    const r = await render(<TezgahApp />);
    await waitFor(() => costCalls(calls).length > 0);
    expect(costCalls(calls)[0]?.url).toBe("/api/tagpress/costs?languageId=dil-1");
    await waitFor(() => document.body.textContent?.includes("Bugün ~$0,420"));
    await r.unmount();
  });

  const call = (costUsd: number | null) => ({ id: `c${costUsd}`, purpose: "generate", model: "m1", summary: "", error: null, inputTokens: 10, outputTokens: 20, costUsd, durationMs: 1500, createdAt: "2026-11-21T10:00:00.000Z" });
  const variant = (costUsd: number | null) => ({ id: "v1", no: 1, snapshot: { costUsd, model: "m1", profileVersion: 2 }, layout: null, issues: [], image: null, score: null, rationale: "" }) as unknown as VariantDetail;
  const log = (costs: Array<number | null>): JobLog => ({ steps: [], aiCalls: costs.map(call), running: false }) as unknown as JobLog;
  const dd = (label: string) => [...document.body.querySelectorAll("dt")].find((d) => d.textContent === label)?.nextElementSibling?.textContent;

  it("gizlenen tutar (null) '—' görünür: varyasyon, işin toplamı ve çağrı satırı ($0 değil)", async () => {
    const r = await render(<Details variant={variant(null)} variants={[]} focusedId={null} onFocus={vi.fn()} log={log([null, null])} logLoading={false} />, { providers: false });
    expect(dd("Bu varyasyon")).toBe("—");
    expect(dd("İşin toplamı")).toBe("—");
    const cells = [...document.body.querySelectorAll(".ur-tbl tbody tr")].map((tr) => tr.children[3]?.textContent);
    expect(cells).toEqual(["—", "—"]);
    expect(document.body.textContent).not.toContain("$0");
    await r.unmount();
  });

  it("dolu tutar (yerel kip, yönetici) eskisi gibi; bilinmeyen tek çağrı toplamı bozmaz", async () => {
    const r = await render(<Details variant={variant(0.012)} variants={[]} focusedId={null} onFocus={vi.fn()} log={log([0.012, null, 0.03])} logLoading={false} />, { providers: false });
    expect(dd("Bu varyasyon")).toBe("$0,012");
    expect(dd("İşin toplamı")).toBe("$0,042");
    await r.unmount();
    expect(sumUsd([])).toBe(0);
    expect(sumUsd([null, undefined])).toBeNull();
    expect(sumUsd([0.5, null])).toBe(0.5);
  });
});

describe("sunucu akışı (SSE) yeniden bağlanır", () => {
  const enc = new TextEncoder();
  /** Gövdesi verilen parçalar olan ve sonra kapanan akış yanıtı. */
  const sse = (...chunks: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(enc.encode(ch));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
  /** Kapanmayan akış (test sonunda istemci kapatır). */
  const openSse = (chunk: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(chunk));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  type Call = { url: string; headers: Headers };
  function scripted(handler: (url: string, n: number) => Response) {
    const calls: Call[] = [];
    const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: new Headers(init.headers) });
      return handler(url, calls.filter((c) => c.url === url).length);
    }) as typeof fetch;
    return { fn, calls };
  }

  it("çözümleyici: adlı olay, çok satırlı veri, kimlik, retry, yorum ve bölünmüş parça", () => {
    const got: Array<[string, string]> = [];
    const p = new SseParser((t, d) => got.push([t, d]));
    p.push("retry: 1500\n\n: canli\n\nid: boot:1\nevent: job\ndata: {\"a\":");
    p.push("1}\n\nevent: text\r\ndata: x\r\ndata: y\r\n\r\ndata: adsız\n\n");
    expect(got).toEqual([
      ["job", '{"a":1}'],
      ["text", "x\ny"],
      ["message", "adsız"],
    ]);
    expect(p.lastEventId).toBe("boot:1");
    expect(p.retryMs).toBe(1500);
    expect(backoff(1, 2000)).toBe(2000);
    expect(backoff(3, 2000)).toBe(8000);
    expect(backoff(10, 2000)).toBe(30_000);
  });

  it("oluşturucu akışı: sunucu kapatınca Last-Event-ID ile yeniden açılır; 401'de oturum yenilenir, akış sürer", async () => {
    const STREAM = "/api/tagpress/builds/b1/stream";
    const f = scripted((url, n) => {
      if (url === "/api/account/auth/refresh") return json(200, {});
      if (url !== STREAM) return json(404, { error: { code: "NOT_FOUND", message: "yok" } });
      // 1: iki olay, sonra sunucu kapatır (jeton bitti). 2: jeton bayat (401). 3: yenilemeden sonra akış sürer.
      if (n === 1) return sse("retry: 5\n\n", 'id: boot:1\nevent: text\ndata: {"type":"text","delta":"a"}\n\n', 'id: boot:2\nevent: text\ndata: {"type":"text","delta":"b"}\n\n');
      if (n === 2) return json(401, { error: { code: "TOKEN_STALE", message: "bayat" } });
      return openSse('id: boot:3\nevent: done\ndata: {"type":"done"}\n\n');
    });
    const lost = vi.fn();
    const unbind = bindSession(createTagpressSession({ fetchImpl: f.fn, onSessionLost: lost }), new QueryClient());
    const events: string[] = [];
    let opens = 0;
    let downs = 0;
    const s = openStream(apiUrl("/api/builds/b1/stream"), { onOpen: () => opens++, onDown: () => downs++, onEvent: (t, d) => events.push(`${t}:${d}`) }, { types: ["text", "done"] });
    try {
      await waitFor(() => events.length === 3, 3000);
      expect(events).toEqual(['text:{"type":"text","delta":"a"}', 'text:{"type":"text","delta":"b"}', 'done:{"type":"done"}']);
      const streams = f.calls.filter((c) => c.url === STREAM);
      expect(streams).toHaveLength(3);
      expect(streams[0]?.headers.has("Last-Event-ID")).toBe(false);
      expect(streams[0]?.headers.get("Accept")).toBe("text/event-stream");
      expect(streams[1]?.headers.get("Last-Event-ID")).toBe("boot:2");
      expect(streams[2]?.headers.get("Last-Event-ID")).toBe("boot:2");
      expect(f.calls.map((c) => c.url)).toEqual([STREAM, STREAM, "/api/account/auth/refresh", STREAM]);
      expect(opens).toBe(2);
      expect(downs).toBe(1);
      expect(lost).not.toHaveBeenCalled();
    } finally {
      s.close();
      unbind();
    }
  });

  it("olay akışı: oturum bitti (yenileme reddedildi) → girişe bir kez, yeniden denenmez", async () => {
    const f = scripted((url) => (url === "/api/account/auth/refresh" ? json(401, { error: { code: "UNAUTHORIZED", message: "x" } }) : json(401, { error: { code: "UNAUTHORIZED", message: "x" } })));
    const lost = vi.fn();
    const unbind = bindSession(createTagpressSession({ fetchImpl: f.fn, onSessionLost: lost }), new QueryClient());
    let downs = 0;
    const s = openStream(apiUrl("/api/events"), { onOpen: vi.fn(), onDown: () => downs++, onEvent: vi.fn() }, { types: ["job"] });
    try {
      await waitFor(() => downs === 1);
      await new Promise((res) => setTimeout(res, 50));
      expect(lost).toHaveBeenCalledTimes(1);
      expect(f.calls.filter((c) => c.url === "/api/tagpress/events")).toHaveLength(1);
    } finally {
      s.close();
      unbind();
    }
  });

  it("olay akışı: firma kapandı (409 ORG_CLOSED) → Hesabım › Firmalar, yeniden denenmez", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const f = scripted(() => json(409, { error: { code: "ORG_CLOSED", message: "kapalı" } }));
    const unbind = bindSession(createTagpressSession({ fetchImpl: f.fn }), new QueryClient());
    let downs = 0;
    const s = openStream(apiUrl("/api/events"), { onOpen: vi.fn(), onDown: () => downs++, onEvent: vi.fn() }, { types: ["job"] });
    try {
      await waitFor(() => downs === 1);
      expect(assign).toHaveBeenCalledWith("/account/firms");
    } finally {
      s.close();
      unbind();
    }
  });
});

describe("yedek fontlar", () => {
  it("platformda sunucunun önekli verdiği css/url adresleri yeniden öneklenmez", async () => {
    const body = { fonts: [{ file: "emoji.ttf", cssFamily: "TagPress Emoji", url: "/api/tagpress/fallback-fonts/emoji.ttf?v=abc" }], css: "/api/tagpress/fallback-fonts.css" };
    expect(rewriteApiUrls(structuredClone(body))).toEqual(body);
    expect(apiUrl(body.css)).toBe("/api/tagpress/fallback-fonts.css");
    expect(apiUrl(body.fonts[0]!.url)).toBe("/api/tagpress/fallback-fonts/emoji.ttf?v=abc");
    const { calls } = mockFetch({ "/api/tagpress/fallback-fonts": body });
    await expect(api.get("/api/fallback-fonts")).resolves.toEqual(body);
    expect(calls[0]?.url).toBe("/api/tagpress/fallback-fonts");
  });
});
