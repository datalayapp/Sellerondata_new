import type { HubAnalytics, HubDatasetPage, HubOverview, HubRow, HubWidget } from "@sellerondata/contracts";
import { type HubCtx, type HubProviders, KitError } from "@sellerondata/product-kit";
import { makePeriod } from "@sellerondata/product-kit/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HUB_LABELS } from "../../i18n/hub.ts";
import { purposeGroup } from "./analytics.ts";
import { createHubProviders } from "./index.ts";
import { type HubHarness, MEMBER_NAMES, MUSTERI, NOW, OCT, ORG_A, ORG_B, ORG_EMPTY, TIME_ZONE, seedEmpty, seedOrgA, seedOrgB, testHarness } from "./test/scenario.ts";

const P = makePeriod(OCT.from, OCT.to);
const ctx = (orgId: string, o: Partial<HubCtx> = {}): HubCtx => ({
  orgId,
  memberId: "m-1",
  locale: "tr",
  can: () => true,
  now: NOW,
  timeZone: TIME_ZONE,
  companyConfirmed: true,
  ...o,
});

let h: HubHarness;
let hub: Required<HubProviders>;
let datasets: Required<NonNullable<HubProviders["datasets"]>>;

beforeAll(async () => {
  h = await testHarness();
  seedOrgA(h.insert);
  seedOrgB(h.insert);
  seedEmpty(h.insert);
  hub = createHubProviders({ db: h.db, memberNames: async (_org, ids) => new Map(ids.filter((id) => MEMBER_NAMES[id]).map((id) => [id, MEMBER_NAMES[id]!])) }) as Required<HubProviders>;
  datasets = hub.datasets as Required<NonNullable<HubProviders["datasets"]>>;
});
afterAll(() => h.close());

const kpi = (o: HubOverview, id: string) => o.kpis.find((k) => k.id === id)!;
const widget = (a: HubAnalytics, section: string, id: string) => a.sections.find((s) => s.id === section)!.widgets.find((w) => w.id === id) as HubWidget;
const kpiItems = (w: HubWidget) => (w.kind === "kpis" ? Object.fromEntries(w.items.map((k) => [k.id, [k.value, k.previous]])) : null);
const cells = (p: HubDatasetPage | null, col: string) => p!.rows.map((r: HubRow) => r.cells[col]);
const ids = (p: HubDatasetPage | null) => p!.rows.map((r) => r.id);

describe("Genel Bakış", () => {
  it("KPI'lar sırayla ve firmanın verisinden; anlık değerler dönemden bağımsız", async () => {
    const o = await hub.overview(ctx(ORG_A), P);
    expect(o.product).toBe("tagpress");
    expect(o.kpis.map((k) => k.id)).toEqual(["approved", "pending", "printed", "jobs", "queue", "ai_calls"]);
    // Onaylanan: j-onay-1, j-onay-2 (silinen iş ve silinen partinin işi sayılmaz); önceki dönem j-eylul.
    expect([kpi(o, "approved").value, kpi(o, "approved").previous]).toEqual([2, 1]);
    expect(kpi(o, "pending").value).toBe(2);
    // Basılan sayfa: silinmemiş sayfaların kopyaları (2 + 1); silinmiş sayfa (5) yok.
    expect([kpi(o, "printed").value, kpi(o, "printed").previous]).toEqual([3, 0]);
    // Gelen iş: 6 (1 Ekim 00:30 İstanbul dahil, 1 Kasım 00:30 hariç).
    expect([kpi(o, "jobs").value, kpi(o, "jobs").previous]).toEqual([6, 1]);
    expect(kpi(o, "queue").value).toBe(2);
    expect([kpi(o, "ai_calls").value, kpi(o, "ai_calls").previous]).toEqual([4, 1]);
    const [cur, prev] = kpi(o, "approved").trend!;
    expect(cur!.points).toHaveLength(31);
    expect(cur!.points.filter((x) => x.y).map((x) => x.x)).toEqual(["2026-10-04", "2026-10-22"]);
    expect(prev!.points.filter((x) => x.y).map((x) => x.x)).toEqual(["2026-09-16"]);
    // Başka dönemde anlık değerler aynı.
    const other = await hub.overview(ctx(ORG_A), makePeriod("2026-01-01", "2026-01-31"));
    expect([kpi(other, "approved").value, kpi(other, "pending").value, kpi(other, "queue").value]).toEqual([0, 2, 2]);
  });

  it("uyarılar: başarısız üretim, düşen onay, takılan görev; dil yayınlıysa dil uyarısı yok", async () => {
    const o = await hub.overview(ctx(ORG_A), P);
    expect(o.alerts.map((a) => [a.id, a.tone, a.title])).toEqual([
      ["failed-jobs", "bad", "1 işin üretimi başarısız"],
      ["approval-dropped", "warning", "Kesim değişti: 1 işin onayı düştü"],
      ["stuck-task", "warning", "1 görev 15 dakikadan uzun sürüyor"],
    ]);
    // 15 dakikadan kısa süren görev takılmış sayılmaz.
    const early = await hub.overview(ctx(ORG_A, { now: new Date("2026-11-05T08:40:00.000Z") }), P);
    expect(early.alerts.map((a) => a.id)).not.toContain("stuck-task");
  });

  it("kurulum listesi firmanın verisinden; derin bağlantılar /tagpress/#/…", async () => {
    const o = await hub.overview(ctx(ORG_A), P);
    expect(o.setup).toMatchObject({ completed: true, href: "/tagpress/#/kurulum", label: "TagPress kurulumu" });
    expect(o.setup!.steps!.map((s) => [s.id, s.done, s.required])).toEqual([
      ["setup", true, true],
      ["language", true, true],
      ["first-job", true, true],
      ["first-print", true, false],
    ]);
    for (const href of [...o.alerts.map((a) => a.href), ...o.setup!.steps!.map((s) => s.href)]) expect(href).toMatch(/^\/tagpress\/#\//);
  });

  it("İngilizce etiketler", async () => {
    const o = await hub.overview(ctx(ORG_A, { locale: "en" }), P);
    expect(o.kpis.map((k) => k.label)).toEqual(["Approved labels", "Awaiting approval", "Printed sheets", "Incoming jobs", "In production", "AI calls"]);
    expect(o.alerts[0]!.title).toBe("1 jobs failed to generate");
  });
});

describe("firma izolasyonu", () => {
  it("B'nin sayıları B'nin, A'nınkiler A'nın; A'nın yanıtında B yok", async () => {
    const b = await hub.overview(ctx(ORG_B), P);
    expect(Object.fromEntries(b.kpis.map((k) => [k.id, k.value]))).toEqual({ approved: 3, pending: 0, printed: 0, jobs: 4, queue: 1, ai_calls: 1 });
    expect(b.alerts.map((a) => a.id)).toEqual(["failed-jobs"]);
    const all = JSON.stringify([
      await hub.overview(ctx(ORG_A), P),
      await hub.analytics(ctx(ORG_A), P, {}),
      await datasets.list(ctx(ORG_A)),
      await datasets.page(ctx(ORG_A), "jobs", { pageSize: "200" }),
      await datasets.page(ctx(ORG_A), "prints", {}),
      await datasets.page(ctx(ORG_A), "templates", {}),
      await hub.activity(ctx(ORG_A), { pageSize: "100" }),
    ]);
    for (const leak of ["B Dili", "jb-", "parti-b", "B-0"]) expect(all).not.toContain(leak);
    // B'nin dili A'nın süzgecinde geçersiz.
    await expect(hub.analytics(ctx(ORG_A), P, { "filter.language": "dil-b" })).rejects.toBeInstanceOf(KitError);
  });

  it("boş firma geçerli boş yanıt döner", async () => {
    const c = ctx(ORG_EMPTY);
    const o = await hub.overview(c, P);
    expect(o.kpis.map((k) => k.value)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(o.alerts.map((a) => a.id)).toEqual(["no-language"]);
    expect(o.setup!.completed).toBe(false);
    expect(o.setup!.steps!.every((s) => !s.done)).toBe(true);
    const a = await hub.analytics(c, P, {});
    expect(a.sections.map((s) => [s.id, s.widgets.map((w) => w.kind)])).toEqual([
      ["production", ["empty"]],
      ["languages", ["empty"]],
      ["print", ["empty"]],
      ["ai", ["empty"]],
    ]);
    expect(a.filters).toEqual([{ id: "language", kind: "select", label: "Tasarım dili", options: [] }]);
    for (const id of ["jobs", "prints", "templates"]) expect(await datasets.page(c, id, {})).toMatchObject({ rows: [], total: 0, page: 1 });
    expect(await hub.activity(c, {})).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
  });
});

describe("müşteri metni", () => {
  it("hiçbir Merkez yanıtında ve aramada yok", async () => {
    const out = JSON.stringify([
      await hub.overview(ctx(ORG_A), P),
      await hub.analytics(ctx(ORG_A), P, { compare: "previous" }),
      await datasets.page(ctx(ORG_A), "jobs", { pageSize: "200" }),
      await hub.activity(ctx(ORG_A), { pageSize: "100" }),
    ]);
    expect(out).not.toContain("Ayşe");
    expect(out).not.toContain("Revizyon");
    expect((await datasets.page(ctx(ORG_A), "jobs", { q: MUSTERI.slice(0, 4) }))!.total).toBe(0);
  });
});

describe("Analiz", () => {
  it("dört bölüm; seriler firmanın gününe göre; karşılaştırma önceki dönemle", async () => {
    const a = await hub.analytics(ctx(ORG_A), P, { compare: "previous" });
    expect(a.sections.map((s) => s.id)).toEqual(["production", "languages", "print", "ai"]);
    expect(a.compare).toEqual({ from: "2026-08-31", to: "2026-09-30" });
    expect(kpiItems(widget(a, "production", "production-kpis"))).toEqual({ jobs: [6, 1], approved: [2, 1], "approval-rate": [33.3, 100] });
    const series = widget(a, "production", "production-series");
    expect(series.kind === "timeseries" && series.series.map((s) => [s.id, s.points.filter((x) => x.y).map((x) => `${x.x}:${x.y}`)])).toEqual([
      ["jobs", ["2026-10-01:1", "2026-10-02:1", "2026-10-05:1", "2026-10-06:1", "2026-10-21:1", "2026-10-22:1"]],
      ["approved", ["2026-10-04:1", "2026-10-22:1"]],
    ]);
    const langs = widget(a, "languages", "languages-breakdown");
    expect(langs.kind === "breakdown" && langs.items.map((i) => [i.label, i.value, i.share])).toEqual([
      ["Çocuk", 1, 50],
      ["Zarif", 1, 50],
    ]);
    expect(kpiItems(widget(a, "print", "print-kpis"))).toEqual({ printed: [3, 0], sessions: [1, 0] });
    const ai = widget(a, "ai", "ai-breakdown");
    expect(ai.kind === "breakdown" && ai.items.map((i) => [i.key, i.value])).toEqual([
      // Eşit sayıda ada göre (Aday seçimi, Tasarım adayları, Tasarım dili oluşturucu, Temadan şablon).
      ["rank", 1],
      ["design", 1],
      ["builder", 1],
      ["template", 1],
    ]);
    expect(kpiItems(widget(a, "ai", "ai-kpis"))).toEqual({ ai_calls: [4, 1], "failed-calls": [1, 0] });
    // Süzgeçte yalnız silinmemiş diller.
    expect(a.filters[0]).toMatchObject({ id: "language", options: [{ value: "dil-zarif", label: "Zarif" }, { value: "dil-cocuk", label: "Çocuk" }] });
  });

  it("dil süzgeci bütün bölümlere uygulanır; tanınmayan ya da silinmiş dil 400", async () => {
    const a = await hub.analytics(ctx(ORG_A), P, { "filter.language": "dil-cocuk" });
    expect(a.compare).toBeUndefined();
    expect(kpiItems(widget(a, "production", "production-kpis"))).toEqual({ jobs: [2, undefined], approved: [1, undefined], "approval-rate": [50, undefined] });
    expect(widget(a, "print", "print-empty").kind).toBe("empty");
    expect(kpiItems(widget(a, "ai", "ai-kpis"))).toEqual({ ai_calls: [1, undefined], "failed-calls": [1, undefined] });
    for (const bad of ["yok", "dil-eski"]) {
      await expect(hub.analytics(ctx(ORG_A), P, { "filter.language": bad })).rejects.toMatchObject({ status: 400, code: "VALIDATION" });
    }
  });

  it("amaç grupları", () => {
    expect(["design", "rank", "transcribe", "builder-turn", "builder-try-design", "sablon-x", "deneme-rank", "image-on-template", "x"].map(purposeGroup)).toEqual([
      "design",
      "rank",
      "transcribe",
      "builder",
      "builder",
      "template",
      "trial",
      "image",
      "other",
    ]);
  });
});

describe("Veriler", () => {
  it("üç veri seti; işler ve baskılar dışa aktarılır", async () => {
    const list = await datasets.list(ctx(ORG_A));
    expect(list.datasets.map((d) => [d.id, d.exportable])).toEqual([
      ["jobs", true],
      ["prints", true],
      ["templates", false],
    ]);
    expect(await datasets.page(ctx(ORG_A), "yok", {})).toBeNull();
  });

  it("işler: görünen işler, süzgeç, arama, sıra, sayfa; bağlantı araçtaki işe", async () => {
    const all = await datasets.page(ctx(ORG_A), "jobs", {});
    expect(all!.total).toBe(9);
    expect(all!.columns.map((c) => c.id)).toEqual(["orderNo", "product", "language", "kind", "status", "quantity", "createdAt", "approvedAt"]);
    expect(ids(all)[0]).toBe("j-sirada");
    expect(all!.rows[0]!.href).toBe("/tagpress/#/uretim?is=j-sirada");
    const approved = await datasets.page(ctx(ORG_A), "jobs", { "filter.status": "approved", sort: "approvedAt", dir: "asc" });
    expect(ids(approved)).toEqual(["j-eylul", "j-onay-1", "j-onay-2"]);
    expect(cells(approved, "approvedAt")).toEqual(["2026-09-16T08:00:00.000Z", "2026-10-04T12:00:00.000Z", "2026-10-22T09:00:00.000Z"]);
    expect(cells(approved, "status")).toEqual(["Onaylandı", "Onaylandı", "Onaylandı"]);
    expect(cells(approved, "kind")).toEqual(["Etiket", "Etiket", "Sticker"]);
    expect((await datasets.page(ctx(ORG_A), "jobs", { "filter.status": ["ready", "failed"] }))!.total).toBe(3);
    expect((await datasets.page(ctx(ORG_A), "jobs", { "filter.from": OCT.from, "filter.to": OCT.to }))!.total).toBe(6);
    expect((await datasets.page(ctx(ORG_A), "jobs", { "filter.language": "dil-cocuk" }))!.total).toBe(2);
    expect(ids(await datasets.page(ctx(ORG_A), "jobs", { q: "ETSY-1001" }))).toEqual(["j-onay-1"]);
    expect(ids(await datasets.page(ctx(ORG_A), "jobs", { q: "bebek" }))).toEqual(["j-onay-2"]);
    // Sipariş numarasız iş artan sırada da sonda.
    expect(cells(await datasets.page(ctx(ORG_A), "jobs", { sort: "orderNo", dir: "asc", pageSize: "200" }), "orderNo").at(-1)).toBeNull();
    const p2 = await datasets.page(ctx(ORG_A), "jobs", { page: "2", pageSize: "4" });
    expect([p2!.page, p2!.pageSize, p2!.total, p2!.rows.length]).toEqual([2, 4, 9, 4]);
    for (const bad of [{ "filter.status": "silindi" }, { "filter.kind": "x" }, { "filter.from": "2026-13-01" }, { page: "0" }, { pageSize: "abc" }]) {
      await expect(datasets.page(ctx(ORG_A), "jobs", bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("gün süzgeci firmanın gününe göre (İstanbul ile UTC farklı işi seçer)", async () => {
    const day = { "filter.from": "2026-10-01", "filter.to": "2026-10-01" };
    expect(ids(await datasets.page(ctx(ORG_A), "jobs", day))).toEqual(["j-sinir-ekim"]);
    expect(ids(await datasets.page(ctx(ORG_A, { timeZone: "UTC" }), "jobs", day))).toEqual([]);
    const nov1 = { "filter.from": "2026-11-01", "filter.to": "2026-11-01" };
    expect(ids(await datasets.page(ctx(ORG_A), "jobs", nov1))).toEqual(["j-sinir-kasim"]);
    // UTC'de 31 Ekim 21:30 Ekim'e düşer: dönemde gelen iş yine 6 (biri girer, biri çıkar).
    const utc = await hub.overview(ctx(ORG_A, { timeZone: "UTC" }), P);
    expect(kpi(utc, "jobs").value).toBe(6);
  });

  it("baskı oturumları: sayfa ve kopya sayısı, durum süzgeci", async () => {
    const all = await datasets.page(ctx(ORG_A), "prints", {});
    expect(ids(all)).toEqual(["baski-taslak", "baski-1"]);
    expect(all!.rows.map((r) => [r.cells.status, r.cells.pages, r.cells.sheets, r.cells.jobs])).toEqual([
      ["Taslak", 1, 1, 1],
      ["Basıldı", 2, 3, 1],
    ]);
    expect(all!.rows[1]!.href).toBe("/tagpress/#/baski/masa/baski-1");
    expect(ids(await datasets.page(ctx(ORG_A), "prints", { "filter.status": "printed", "filter.from": OCT.from, "filter.to": OCT.to }))).toEqual(["baski-1"]);
  });

  it("şablonlar: silinmiş dilin şablonu yok; kesim okunur", async () => {
    const t = await datasets.page(ctx(ORG_A), "templates", {});
    expect(t!.rows.map((r) => [r.cells.language, r.cells.name, r.cells.kind, r.cells.cut])).toEqual([
      ["Zarif", "a1", "Etiket", "Tasarım dilinin kesimi"],
      ["Zarif", "yuvarlak", "Etiket", "Ø38 mm daire"],
      ["Çocuk", "s1", "Sticker", "63.5 × 38.1 mm yuvarlak köşeli"],
    ]);
    expect(t!.rows[1]!.href).toBe("/tagpress/#/sablonlar/yuvarlak");
  });

  it("dışa aktarma: sayfadaki süzgeçle bütün satırlar; şablonlar ve bilinmeyen set yok; süzgeç hatası akıştan önce", async () => {
    const out = await datasets.export(ctx(ORG_A), "jobs", { "filter.status": "approved", page: "3" });
    const rows: HubRow[] = [];
    for await (const batch of out!.batches()) rows.push(...batch);
    expect(rows.map((r) => r.id).sort()).toEqual(["j-eylul", "j-onay-1", "j-onay-2"]);
    expect(out!.columns.map((c) => c.id)).toContain("orderNo");
    expect(await datasets.export(ctx(ORG_A), "templates", {})).toBeNull();
    expect(await datasets.export(ctx(ORG_A), "yok", {})).toBeNull();
    await expect(datasets.export(ctx(ORG_A), "jobs", { "filter.status": "x" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("Etkinlik", () => {
  it("beyaz listedeki olaylar, yeniden eskiye; kişi adı izdüşümden", async () => {
    const page = await hub.activity(ctx(ORG_A), { pageSize: "100" });
    expect(page.total).toBe(10);
    expect(page.items.map((i) => [i.id, i.actor])).toEqual([
      ["design:oturum-1", "Can Kaya"],
      ["publish:dil-cocuk-v1", null],
      ["export:cikti-2", null],
      ["export:cikti-1", "Elif Demir"],
      ["job-log:3", null],
      ["publish:dil-zarif-v2", null],
      ["job-log:2", "Elif Demir"],
      ["publish:dil-eski-v1", null],
      ["publish:dil-zarif-v1", null],
      ["setup:completed", null],
    ]);
    const done = page.items.find((i) => i.id === "job-log:2")!;
    expect(done).toMatchObject({ action: "Tasarım adayları hazırlandı", target: "İş ETSY-1001", href: "/tagpress/#/uretim?is=j-onay-1" });
    expect(page.items.find((i) => i.id === "job-log:3")!.target).toBe("İş #3");
    expect(page.items.find((i) => i.id === "export:cikti-1")).toMatchObject({ action: "Baskı çıktısı alındı (PDF)", target: "Ekim baskısı" });
  });

  it("sayfalama", async () => {
    const p2 = await hub.activity(ctx(ORG_A), { page: "2", pageSize: "3" });
    expect([p2.page, p2.pageSize, p2.total]).toEqual([2, 3, 10]);
    expect(p2.items.map((i) => i.id)).toEqual(["export:cikti-1", "job-log:3", "publish:dil-zarif-v2"]);
    expect((await hub.activity(ctx(ORG_A), { page: "5", pageSize: "3" })).items).toEqual([]);
    await expect(hub.activity(ctx(ORG_A), { page: "-1" })).rejects.toMatchObject({ status: 400 });
  });

  it("kişi adı kaynağı yoksa actor null (yerel kip)", async () => {
    const local = createHubProviders({ db: h.db });
    const page = await local.activity!(ctx(ORG_A), {});
    expect(page.items.every((i) => i.actor === null)).toBe(true);
  });
});

describe("etiketler", () => {
  it("TR ve EN aynı anahtarlar, boş metin yok", () => {
    expect(Object.keys(HUB_LABELS.en).sort()).toEqual(Object.keys(HUB_LABELS.tr).sort());
    for (const dict of Object.values(HUB_LABELS)) for (const v of Object.values(dict)) expect(v.trim()).not.toBe("");
  });
});
