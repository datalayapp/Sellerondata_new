// @vitest-environment happy-dom
import type { IssueCode, JobDetail, JobSummary, VariantSummary } from "@tagpress/domain";
import { act, type Ref, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setShortcutsOpen } from "../../tezgah/kisayol/kayit.ts";
import { TezgahApp } from "../../tezgah/rotalar.tsx";
import { click, flush, mockFetch, press, render, waitFor } from "../../tezgah/test/render.tsx";

/**
 * Üretim ekranı (sahte sunucu): sütun yerleşimi, Bekleyen → Düzenle → Onaylı şeridi, alım alanı (yükleyince üretim
 * başlamaz, kartlar bekleyenlere düşer), kart silme ve geri al, seçilenleri üret, sağ panelde onaydan önce `flush()`.
 */

// Gömülü küçük tezgâh başka işte yazılıyor: burada sözleşmesi (handle.flush) taklit edilir ve çağrı sırası kaydedilir.
const { order } = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("../duzelt/gomulu.tsx", () => ({
  HizliDuzelt: ({ variantId, handleRef }: { variantId: string; handleRef?: Ref<{ flush(): Promise<boolean> }> }) => {
    useImperativeHandle(handleRef, () => ({
      flush: async () => {
        order.push(`flush:${variantId}`);
        return true;
      },
    }));
    return <div data-testid="hizli">{variantId}</div>;
  },
  DuzeltPenceresi: ({ variantId }: { variantId: string }) => <div data-testid="pencere">{variantId}</div>,
}));

const variant = (jobId: string, no: number, over: Partial<VariantSummary> = {}): VariantSummary => ({
  id: `${jobId}-v${no}`,
  jobId,
  no,
  kind: "text",
  score: null,
  aiRank: no === 2 ? 1 : null,
  suspect: false,
  approved: false,
  stale: false,
  previewUrl: `/api/variants/${jobId}-v${no}/preview.png`,
  worst: null,
  issueCount: 0,
  createdAt: "2026-11-21T10:00:00.000Z",
  ...over,
});

const job = (id: string, seq: number, over: Partial<JobSummary> = {}): JobSummary => ({
  id,
  batchId: "b1",
  languageId: "dil-1",
  seq,
  orderNo: String(9010 + seq),
  quantity: 60,
  templateKey: "a15",
  labelSize: "3.8",
  product: null,
  text: `Elif & Kerem ${seq}`,
  segments: [],
  kind: "label",
  aiNote: "",
  status: "ready",
  error: null,
  approvedVariantId: null,
  issues: [],
  worst: null,
  variants: [],
  createdAt: `2026-11-21T10:00:0${seq}.000Z`,
  updatedAt: "2026-11-21T10:00:00.000Z",
  ...over,
});

const detail = (j: JobSummary): JobDetail => ({ ...j, raw: {}, textRaw: j.text, dismissed: [], batchName: "21 Kasım partisi" });

let jobs: JobSummary[] = [];
let api: ReturnType<typeof mockFetch>;

function routes(): Record<string, unknown> {
  const r: Record<string, unknown> = {
    "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
    "/api/generate/status": { running: 0, queued: 0, concurrency: 1, runningJobIds: [] },
    "/api/jobs": () => ({ jobs, total: jobs.length }),
    "/api/batches": { batches: [{ id: "b1", languageId: "dil-1", name: "siparisler", sourceFile: "siparisler.json", createdAt: new Date().toISOString(), total: 3, byStatus: {}, withIssues: 0, approved: 0 }] },
    "/api/print/shelf": { items: [{}, {}] },
    "/api/generate": (_u: string, init?: RequestInit) => ({ queued: JSON.parse(String(init?.body ?? "{}")).jobIds ?? [], skipped: [] }),
    "/api/jobs/delete": (_u: string, init?: RequestInit) => {
      const ids = JSON.parse(String(init?.body ?? "{}")).ids as string[];
      jobs = jobs.filter((j) => !ids.includes(j.id));
      return { undoToken: "geri-1", label: `${ids.length} iş silindi`, expiresAt: "2026-11-21T11:00:00.000Z" };
    },
    "/api/undo/geri-1": () => ({ ok: true }),
    "/api/languages/dil-1/templates": { templates: [] },
    "/api/languages/dil-1/profile": { data: { output: { sizes: [{ id: "3.8", cm: 3.8, framePx: 440 }], defaultSize: "3.8" } } },
    "/api/costs": { todayUsd: 0.42, monthUsd: 3.5, totalUsd: 9, byDay: [], byModel: [], byPurpose: [], unpricedCalls: 0 },
  };
  for (const j of jobs) {
    r[`/api/jobs/${j.id}`] = () => detail(jobs.find((x) => x.id === j.id) ?? j);
    r[`/api/jobs/${j.id}/log`] = { steps: [], aiCalls: [], running: false };
    r[`/api/jobs/${j.id}/approve`] = (_u: string, init?: RequestInit) => {
      const variantId = JSON.parse(String(init?.body ?? "{}")).variantId as string | null;
      order.push(`approve:${variantId}`);
      const cur = jobs.find((x) => x.id === j.id) ?? j;
      const next: JobSummary = { ...cur, status: variantId ? "approved" : "ready", approvedVariantId: variantId, variants: cur.variants.map((v) => ({ ...v, approved: v.id === variantId })), updatedAt: new Date().toISOString() };
      jobs = jobs.map((x) => (x.id === j.id ? next : x));
      return detail(next);
    };
  }
  return r;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* yok */
  }
  order.length = 0;
  jobs = [
    job("j1", 1, { variants: [variant("j1", 1), variant("j1", 2), variant("j1", 3)] }),
    job("j2", 2, { variants: [variant("j2", 1), variant("j2", 2)] }),
    job("j3", 3, { status: "new", worst: "warning", issues: [{ code: "kod-sozlukte-yok" as IssueCode, severity: "warning", message: "Şablon bulunamadı", fixes: [] }] }),
  ];
  api = mockFetch(routes());
});

afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
});

async function open(hash: string, ready: () => unknown = () => document.querySelectorAll("[data-job]").length === jobs.length) {
  window.location.hash = hash;
  const r = await render(<TezgahApp />);
  await waitFor(ready);
  await flush(3);
  return r;
}

const flowText = () => [...document.querySelectorAll<HTMLElement>(".tz-flow button")].map((b) => b.textContent);
const card = (id: string) => document.querySelector<HTMLElement>(`[data-job="${id}"]`);

describe("Üretim ekranı", () => {
  it("sütun ekranı; şeritte Bekleyen → Düzenle → Onaylı sayılarıyla, Baskı masası; Karşılaştır ve parti seçici yok", async () => {
    const r = await open("#/uretim");
    expect(document.querySelector(".tz-app--col")).not.toBeNull();
    expect(flowText()).toEqual(["Bekleyen1", "Düzenle2", "Onaylı0"]);
    expect(document.querySelector(".tz-ctx")?.textContent).toContain("Baskı masası2");
    expect(document.body.textContent).not.toContain("Karşılaştır");
    expect(document.body.textContent).not.toContain("Bütün işler");
    // Üç bölüm: bekleyen kartında uyarı; Düzenle kartında seçenek sayısı.
    expect(document.querySelector('[data-sec="pending"]')?.contains(card("j3"))).toBe(true);
    expect(card("j3")?.textContent).toContain("Şablon bulunamadı");
    expect(document.querySelector('[data-sec="edit"]')?.contains(card("j1"))).toBe(true);
    expect(card("j1")?.textContent).toContain("3 seçenek");
    expect(document.querySelector(".ur-chip--warn")?.textContent).toContain("Sorunlu 1");
    // Alım şeridi her zaman görünür.
    expect(r.byText("Dosya yükle")).not.toBeNull();
    expect(r.byText("Elle ekle")).not.toBeNull();
    await r.unmount();
  });

  it("liste boşken büyük alım alanı ve sayfa içi elle ekleme formu", async () => {
    jobs = [];
    api = mockFetch(routes());
    const r = await open("#/uretim", () => document.querySelector(".ur-drop"));
    expect(document.querySelector(".ur-drop")?.textContent).toContain("Sipariş dosyasını buraya sürükleyin");
    expect(document.querySelector(".ur-manual")?.textContent).toContain("Listeye ekle");
    expect(flowText()).toEqual(["Bekleyen0", "Düzenle0", "Onaylı0"]);
    expect(document.querySelectorAll(".tz-btn--primary")).toHaveLength(1);
    await r.unmount();
  });

  it("dosya yüklenince masa açılmaz, üretim başlamaz; siparişler bekleyenlere düşer", async () => {
    const r = await open("#/uretim");
    const previewRows = [0, 1].map((i) => ({ index: i, raw: {}, include: true, textRaw: `Yeni ${i}`, text: `Yeni ${i}`, segments: [], templateInput: null, templateKey: null, labelSize: null, orderNo: `77${i}`, quantity: 5, product: null, kind: "label", aiNote: "", dismissed: [], issues: [], dedupeKey: `n${i}` }));
    const extra = { ...routes() };
    extra["/api/import/preview"] = { languageId: "dil-1", fileName: "yeni.json", fields: ["metin"], mapping: { text: "metin", orderNo: "no", quantity: null, template: null, size: null, product: null }, mappingSource: {}, format: "array", rows: previewRows, warnings: [], summary: {}, templateKeys: [], labelSizes: [] };
    extra["/api/import/commit"] = () => {
      jobs = [...jobs, job("n1", 4, { status: "new", orderNo: "770", text: "Yeni 0" }), job("n2", 5, { status: "new", orderNo: "771", text: "Yeni 1" })];
      return { batchId: "b2", jobIds: ["n1", "n2"], created: 2, skipped: [], queued: [] };
    };
    api = mockFetch(extra);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(['[{"metin":"Yeni 0"},{"metin":"Yeni 1"}]'], "yeni.json", { type: "application/json" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/import/commit")));
    const commit = api.calls.find((c) => c.url.endsWith("/api/import/commit"));
    expect(commit?.body).toMatchObject({ generate: false, batchName: "yeni" });
    await waitFor(() => document.body.textContent?.includes("2 sipariş listeye eklendi."));
    await waitFor(() => card("n1") && card("n2"));
    expect(document.querySelector('[data-sec="pending"]')?.contains(card("n1"))).toBe(true);
    expect(api.calls.some((c) => c.url.endsWith("/api/generate") && c.method === "POST")).toBe(false);
    expect(window.location.hash).not.toContain("ice-aktar");
    expect(flowText()[0]).toBe("Bekleyen3");
    await r.unmount();
  });

  it("çöp kutusu kartı tek tıkla siler, bildirimdeki Geri al geri getirir", async () => {
    const r = await open("#/uretim");
    await click(card("j2")!.querySelector<HTMLElement>(".ur-del")!);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/jobs/delete")));
    expect(api.calls.find((c) => c.url.endsWith("/api/jobs/delete"))?.body).toEqual({ ids: ["j2"] });
    await waitFor(() => !card("j2"));
    const undo = await waitFor(() => r.byText("Geri al"));
    await click(undo);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/undo/geri-1") && c.method === "POST"));
    await r.unmount();
  });

  it("seçilenleri üret: onay kutusuyla seçilen bekleyenlerin üretimi başlar", async () => {
    const r = await open("#/uretim");
    const gen = () => [...document.querySelectorAll<HTMLButtonElement>('[data-sec="pending"] button')].find((b) => b.textContent?.startsWith("Seçilenleri üret"));
    expect(gen()?.textContent).toContain("Seçilenleri üret (0)");
    expect(gen()?.disabled).toBe(true);
    await click(card("j3")!.querySelector<HTMLElement>("[role=checkbox]")!);
    await waitFor(() => gen()?.textContent?.includes("Seçilenleri üret (1)"));
    await click(gen()!);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/generate") && c.method === "POST"));
    expect(api.calls.find((c) => c.url.endsWith("/api/generate"))?.body).toEqual({ jobIds: ["j3"] });
    await waitFor(() => document.body.textContent?.includes("1 iş üretime alındı."));
    await r.unmount();
  });

  it("karta tıklayınca sağ panel açılır; 1–9 seçenek seçer, onaydan önce küçük tezgâh kaydedilir, sıradakine geçilir", async () => {
    const r = await open("#/uretim");
    await click(card("j1")!.querySelector<HTMLElement>(".ur-ec-b")!);
    await waitFor(() => document.querySelector(".ur-side"));
    expect(window.location.hash).toContain("is=j1");
    const side = document.querySelector<HTMLElement>(".ur-side")!;
    // Varsayılan sıra: en yeni önce (j2, j1).
    expect(side.textContent).toContain("Düzenle · 2 / 2");
    expect(side.querySelector(".tz-btn--primary")?.textContent).toContain("V2 onayla");
    expect(side.querySelectorAll(".ur-vth[role=radio]")).toHaveLength(3);
    expect(document.querySelector('[data-testid="hizli"]')?.textContent).toBe("j1-v2");
    await press("1");
    await waitFor(() => side.querySelector(".tz-btn--primary")?.textContent?.includes("V1 onayla"));
    (document.activeElement as HTMLElement | null)?.blur();
    await press("Enter");
    await waitFor(() => order.some((o) => o.startsWith("approve:")));
    expect(order.slice(0, 2)).toEqual(["flush:j1-v1", "approve:j1-v1"]);
    await waitFor(() => window.location.hash.includes("is=j2"));
    await waitFor(() => document.body.textContent?.includes("№ 9011 onaylandı (V1)"));
    await r.unmount();
  });

  it("Esc paneli kapatır; ← → bölüm içinde gezinir", async () => {
    const r = await open("#/uretim?is=j1", () => document.querySelector(".ur-side"));
    await press("ArrowRight");
    await waitFor(() => window.location.hash.includes("is=j2"));
    await press("Escape");
    await waitFor(() => !document.querySelector(".ur-side"));
    expect(window.location.hash).not.toContain("is=");
    await r.unmount();
  });

  it("panel sütunun yanında açılır: grup açık sınıfını alır, iş satırı grubun dışında; kapanırken etkisiz durur, geçiş bitince kalkar", async () => {
    const r = await open("#/uretim");
    const grp = () => document.querySelector<HTMLElement>(".ur-page > .ur-grp")!;
    const slot = () => document.querySelector<HTMLElement>(".ur-side-slot");
    expect(grp().classList.contains("is-open")).toBe(false);
    expect(grp().dataset.panel).toBe("closed");
    expect(slot()).toBeNull();
    // İş satırı (Bekleyen · Düzenle · Onaylı) kayan grubun dışında: panel onu kıpırdatmaz.
    expect(grp().contains(document.querySelector(".tz-flow"))).toBe(false);

    await click(card("j1")!.querySelector<HTMLElement>(".ur-ec-b")!);
    await waitFor(() => document.querySelector(".ur-side"));
    expect(grp().classList.contains("is-open")).toBe(true);
    expect(grp().dataset.panel).toBe("open");
    expect(slot()?.parentElement).toBe(grp());
    expect(slot()?.previousElementSibling?.classList.contains("ur-col")).toBe(true);
    expect(slot()?.hasAttribute("inert")).toBe(false);

    await press("Escape");
    await waitFor(() => !window.location.hash.includes("is="));
    // Kapanış geçişi sürerken panel son hâliyle ve etkisiz durur.
    expect(grp().classList.contains("is-open")).toBe(false);
    expect(grp().dataset.panel).toBe("closing");
    expect(slot()?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".ur-side")).not.toBeNull();
    // Başka özelliğin ya da içteki öğenin geçiş sonu paneli kaldırmaz; ızgara kolonlarınınki kaldırır.
    const end = (target: Element, propertyName: string) =>
      act(async () => {
        target.dispatchEvent(Object.assign(new Event("transitionend", { bubbles: true }), { propertyName }));
      });
    await end(grp(), "max-width");
    await end(document.querySelector(".ur-side")!, "grid-template-columns");
    expect(grp().dataset.panel).toBe("closing");
    await end(grp(), "grid-template-columns");
    expect(grp().dataset.panel).toBe("closed");
    expect(slot()).toBeNull();
    await r.unmount();
  });

  it("hareketi azalt açıkken panel geçişsiz kapanır", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      const r = await open("#/uretim?is=j1", () => document.querySelector(".ur-side"));
      expect(document.querySelector<HTMLElement>(".ur-grp")?.dataset.panel).toBe("open");
      await press("Escape");
      await waitFor(() => !window.location.hash.includes("is="));
      expect(document.querySelector<HTMLElement>(".ur-grp")?.dataset.panel).toBe("closed");
      expect(document.querySelector(".ur-side-slot")).toBeNull();
      await r.unmount();
    } finally {
      window.matchMedia = real;
    }
  });

  it("D ayrıntılı düzenleme penceresini aynı ekranda açar", async () => {
    const r = await open("#/uretim?is=j1", () => document.querySelector(".ur-side"));
    await press("d");
    await waitFor(() => document.querySelector('[data-testid="pencere"]'));
    expect(document.querySelector('[data-testid="pencere"]')?.textContent).toBe("j1-v2");
    expect(window.location.hash).toContain("#/uretim");
    await r.unmount();
  });
});
