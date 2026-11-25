// @vitest-environment happy-dom
import type { MeResponse } from "@sellerondata/contracts";
import { initShellI18n, SessionProvider } from "@sellerondata/shell";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, api, path, withQuery } from "../lib/api.ts";
import { apiUrl, loginHref, rewriteApiUrls } from "../lib/platform.ts";
import { parseHash } from "../lib/route.ts";
import { resources } from "../i18n/index.ts";
import { serverText } from "../i18n/sunucu.ts";
import { setTestLocale } from "../i18n/test.ts";
import AyarlarEkrani from "../ekranlar/ayarlar/index.tsx";
import { Button } from "../tezgah/index.ts";
import { ConfirmProvider, ToastProvider } from "../tezgah/katman/Dialog.tsx";
import { flush, mockFetch, render, stubEventSource, waitFor } from "../tezgah/test/render.tsx";
import { createPlatformErrorHandler } from "./hatalar.ts";
import { bindSession, createTagpressSession } from "./istemci.ts";
import { gateOf, PlatformKabuk } from "./Kabuk.tsx";

/**
 * Platform kipi (VITE_TAGPRESS_PLATFORM=1): adres öneki, istek başlıkları (kabuğun oturum istemcisi), 401'de bir kez
 * yenileme, 403/409 yönlendirmeleri, oturum kapısı ve yetkiye göre kapanan eylemler. Sunucu sahte `fetch`.
 */
beforeAll(() => {
  vi.stubEnv("VITE_TAGPRESS_PLATFORM", "1");
  initShellI18n({ resources, defaultNS: "common", locale: "tr" });
});
afterAll(() => {
  vi.unstubAllEnvs();
  setTestLocale("tr");
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const platformError = (status: number, code: string, message = code) => json(status, { error: { code, message } });

type Call = { url: string; method: string; headers: Headers; body?: string };
/** Sırayla yanıt veren sahte `fetch`; her çağrı kaydedilir. */
function scripted(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : undefined });
    return handler(url, init, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

function me(over: Partial<MeResponse> = {}, permissions: string[] = ["tagpress.web.access", "tagpress.work.edit", "tagpress.ai.use"]): MeResponse {
  return {
    person: { id: "p1", name: "Ayşe", email: "ayse@ornek.test", phone: null, locale: "tr", emailVerified: true },
    orgs: [{ id: "org-a", name: "Atölye A", orgRole: "OWNER", status: "ACTIVE" }],
    activeOrg: { id: "org-a", name: "Atölye A", country: "TR", currency: "TRY", orgRole: "OWNER", membershipId: "m1" },
    products: [{ key: "tagpress", available: true, subscription: { status: "ACTIVE", plan: "early_access" }, role: "USER", permissions }],
    ...over,
  } as MeResponse;
}

describe("adresler", () => {
  it("/api/x → /api/tagpress/x; önekli ve /api dışı adres değişmez; path ve withQuery öneklenir", () => {
    expect(apiUrl("/api/jobs")).toBe("/api/tagpress/jobs");
    expect(apiUrl("/api/tagpress/jobs")).toBe("/api/tagpress/jobs");
    expect(apiUrl("/api/events")).toBe("/api/tagpress/events");
    expect(apiUrl("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
    expect(apiUrl("#/uretim")).toBe("#/uretim");
    expect(path("/api/jobs/:id", { id: "a b" })).toBe("/api/tagpress/jobs/a%20b");
    expect(withQuery(path("/api/print/pages/:id/preview.png", { id: "p1" }), { w: 300 })).toBe("/api/tagpress/print/pages/p1/preview.png?w=300");
  });

  it("yanıttaki görsel adresleri öneklenir; adı adres olmayan alana (müşteri metni) dokunulmaz", () => {
    const body = rewriteApiUrls({ jobs: [{ text: "/api/jobs metni", previewUrl: "/api/variants/v1/preview.png", templateImageUrl: null, url: "/api/learn/previews/x/a.png" }] });
    expect(body.jobs[0]).toEqual({ text: "/api/jobs metni", previewUrl: "/api/tagpress/variants/v1/preview.png", templateImageUrl: null, url: "/api/tagpress/learn/previews/x/a.png" });
  });

  it("giriş adresi kalınan yeri karma dahil taşır", () => {
    expect(loginHref({ pathname: "/tagpress/", search: "", hash: "#/uretim?is=j1" })).toBe(`/login?next=${encodeURIComponent("/tagpress/#/uretim?is=j1")}`);
  });
});

describe("istek başlıkları ve oturum", () => {
  let qc: QueryClient;
  let unbind: () => void;
  beforeEach(() => {
    qc = new QueryClient();
    localStorage.clear();
  });
  afterEach(() => unbind?.());

  it("yazma: /api/tagpress altında, X-SOD-CSRF: 1, X-SOD-Org, Accept-Language; X-Studio yok", async () => {
    const f = scripted((url) => (url === "/api/account/me" ? json(200, me()) : json(200, { ok: true })));
    const client = createTagpressSession({ fetchImpl: f.fn });
    unbind = bindSession(client, qc);
    client.noteActiveOrg("org-a");
    await api.post("/api/jobs/manual", { text: "Ayşe" });
    await api.get("/api/jobs");
    const [post, get] = f.calls;
    expect(post?.url).toBe("/api/tagpress/jobs/manual");
    expect(post?.method).toBe("POST");
    expect(post?.headers.get("X-SOD-CSRF")).toBe("1");
    expect(post?.headers.get("X-SOD-Org")).toBe("org-a");
    expect(post?.headers.get("Accept-Language")).toBe("tr");
    expect(post?.headers.get("content-type")).toBe("application/json");
    expect(post?.headers.has("X-Studio")).toBe(false);
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ text: "Ayşe" });
    expect(get?.url).toBe("/api/tagpress/jobs");
    expect(get?.headers.has("X-SOD-CSRF")).toBe(false);
  });

  it("401: bir kez yenilenir ve istek yeniden gönderilir", async () => {
    const f = scripted((url, _i, n) => {
      if (url === "/api/account/auth/refresh") return json(200, {});
      return n === 1 ? platformError(401, "TOKEN_STALE") : json(200, { jobs: [] });
    });
    const client = createTagpressSession({ fetchImpl: f.fn, onSessionLost: vi.fn() });
    unbind = bindSession(client, qc);
    await expect(api.get("/api/jobs")).resolves.toEqual({ jobs: [] });
    expect(f.calls.map((c) => c.url)).toEqual(["/api/tagpress/jobs", "/api/account/auth/refresh", "/api/tagpress/jobs"]);
  });

  it("401 ve yenileme de reddedilirse oturum kaybı (giriş) bir kez çağrılır, hata fırlar", async () => {
    const lost = vi.fn();
    const f = scripted(() => platformError(401, "UNAUTHORIZED"));
    const client = createTagpressSession({ fetchImpl: f.fn, onSessionLost: lost });
    unbind = bindSession(client, qc);
    await expect(api.get("/api/jobs")).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("platform hata gövdesi ApiError biçimine çevrilir; metin ortak sözlükten (TR ve EN)", async () => {
    const f = scripted(() => platformError(409, "ORG_CLOSED", "kapalı"));
    const client = createTagpressSession({ fetchImpl: f.fn });
    unbind = bindSession(client, qc);
    vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const err = await api.post("/api/jobs/manual", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).body.code).toBe("ORG_CLOSED");
    expect(serverText(err)).toBe("Bu firma kapatıldı. Firmada işlem yapılamaz.");
    expect(serverText(new ApiFailure(403, { error: "x", code: "READ_ONLY" }))).toBe("Abonelik salt okunur durumda. Değişiklik yapılamaz.");
    setTestLocale("en");
    try {
      expect(serverText(new ApiFailure(403, { error: "x", code: "READ_ONLY" }))).toBe("The subscription is read only. Changes are not allowed.");
    } finally {
      setTestLocale("tr");
    }
  });
});

describe("sayfa düzeyi tepki", () => {
  const deps = () => ({ assign: vi.fn(), replace: vi.fn(), reload: vi.fn(), refreshAccess: vi.fn(), hasUnsavedChanges: vi.fn(() => false) });
  const fail = (status: number, code: string) => new ApiFailure(status, { error: code, code });

  it("403 NO_PRODUCT_ACCESS → Merkez'in erişim sayfası; 409 ORG_CLOSED → Hesabım › Firmalar (bir kez)", () => {
    const d = deps();
    const on = createPlatformErrorHandler(d);
    on(fail(403, "NO_PRODUCT_ACCESS"));
    on(fail(403, "NO_PRODUCT_ACCESS"));
    expect(d.replace).toHaveBeenCalledTimes(1);
    expect(d.replace).toHaveBeenCalledWith("/account/tool-access/tagpress");
    const d2 = deps();
    createPlatformErrorHandler(d2)(fail(409, "ORG_CLOSED"));
    expect(d2.assign).toHaveBeenCalledWith("/account/firms");
  });

  it("409 ORG_MISMATCH → sayfa yenilenir; kaydedilmemiş değişiklik varsa yenilenmez (kabuğun uyarısı kalır)", () => {
    const d = deps();
    createPlatformErrorHandler(d)(fail(409, "ORG_MISMATCH"));
    expect(d.reload).toHaveBeenCalledTimes(1);
    const d2 = { ...deps(), hasUnsavedChanges: () => true };
    createPlatformErrorHandler(d2)(fail(409, "ORG_MISMATCH"));
    expect(d2.reload).not.toHaveBeenCalled();
  });

  it("403 FORBIDDEN / READ_ONLY → yetki yeniden okunur (aralıkla, döngü yok); TagPress kodları yer değiştirmez", () => {
    let t = 0;
    const d = { ...deps(), now: () => t };
    const on = createPlatformErrorHandler(d);
    on(fail(403, "FORBIDDEN"));
    on(fail(403, "READ_ONLY"));
    t = 6000;
    on(fail(403, "READ_ONLY"));
    expect(d.refreshAccess).toHaveBeenCalledTimes(2);
    on(fail(409, "feature-off"));
    expect(d.assign).not.toHaveBeenCalled();
    expect(d.replace).not.toHaveBeenCalled();
  });

  it("istemci üzerinden: 403 NO_PRODUCT_ACCESS erişim sayfasına götürür", async () => {
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    const f = scripted(() => platformError(403, "NO_PRODUCT_ACCESS"));
    const unbind = bindSession(createTagpressSession({ fetchImpl: f.fn }), new QueryClient());
    try {
      await expect(api.get("/api/jobs")).rejects.toBeInstanceOf(ApiFailure);
      expect(replace).toHaveBeenCalledWith("/account/tool-access/tagpress");
    } finally {
      unbind();
    }
  });
});

describe("oturum kapısı", () => {
  it("gateOf: kişi yok → giriş; Hesap yok → bağlantı yok; firma yok; web izni yok; tamam", () => {
    expect(gateOf(null, false, false)).toBe("anon");
    expect(gateOf(null, true, false)).toBe("loading");
    expect(gateOf(null, false, true)).toBe("offline");
    expect(gateOf(me({ activeOrg: null }), false, false)).toBe("no-org");
    expect(gateOf(me({}, []), false, false)).toBe("no-access");
    expect(gateOf(me(), false, false)).toBe("ok");
  });

  /** Kabuğu bağlar; bağ (`bindSession`) her testin sonunda `afterEach` ile çözülür, düşen test sonrakine sızmaz. */
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  async function mountKabuk(fetchImpl: typeof fetch) {
    stubEventSource();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = createTagpressSession({ fetchImpl });
    const unbind = bindSession(client, qc);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    cleanup = async () => {
      await act(async () => root.unmount());
      unbind();
    };
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <SessionProvider client={client}>
            <ToastProvider>
              <ConfirmProvider>
                <PlatformKabuk>
                  <p className="icerik">içerik</p>
                </PlatformKabuk>
              </ConfirmProvider>
            </ToastProvider>
          </SessionProvider>
        </QueryClientProvider>,
      );
    });
    await flush(6);
    return { el };
  }

  it("oturum yok (401, yenileme reddedildi) → kalınan yerle Merkez girişi", async () => {
    window.location.hash = "#/uretim";
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    globalThis.fetch = (async () => platformError(401, "UNAUTHORIZED")) as unknown as typeof fetch;
    const k = await mountKabuk((async () => platformError(401, "UNAUTHORIZED")) as unknown as typeof fetch);
    await waitFor(() => assign.mock.calls.length > 0);
    expect(String(assign.mock.calls[0]?.[0])).toMatch(/^\/login\?next=/);
    expect(decodeURIComponent(String(assign.mock.calls[0]?.[0]))).toContain("#/uretim");
    expect(k.el.querySelector(".icerik")).toBeNull();
  });

  it("web izni yok → Merkez'in erişim sayfası; içerik çizilmez", async () => {
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    const k = await mountKabuk((async (u: RequestInfo | URL) => (String(u) === "/api/account/me" ? json(200, me({}, [])) : json(404, {}))) as unknown as typeof fetch);
    await waitFor(() => replace.mock.calls.length > 0);
    expect(replace).toHaveBeenCalledWith("/account/tool-access/tagpress");
    expect(k.el.querySelector(".icerik")).toBeNull();
  });

  it("izin tamam → kabuk (TagPress bandı, menü karma adresleri) ve içerik", async () => {
    const k = await mountKabuk((async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url === "/api/account/me") return json(200, me());
      if (url === "/api/tagpress/languages") return json(200, { languages: [] });
      return json(404, { error: "yok" });
    }) as unknown as typeof fetch);
    await waitFor(() => k.el.querySelector(".icerik"));
    expect(k.el.querySelector(".sod-shell[data-sod-workspace]")).not.toBeNull();
    expect(k.el.querySelector(".sod-brand-n")?.textContent).toBe("TagPress");
    const nav = [...k.el.querySelectorAll<HTMLAnchorElement>(".sod-nav a")].map((a) => a.getAttribute("href"));
    expect(nav).toEqual(["/tagpress/#/uretim", "/tagpress/#/tasarim-dili", "/tagpress/#/sablonlar", "/tagpress/#/baski", "/tagpress/#/ayarlar"]);
    // Geniş ekranda her menü öğesinin kabuk simgesi var (A · bölmeli sekmeler).
    expect([...k.el.querySelectorAll(".sod-nav a svg[data-i]")].map((s) => s.getAttribute("data-i"))).toEqual(["spark", "edit", "copy", "doc", "gear"]);
  });

  describe("Kurulum · Eksik ve sütun", () => {
    const SETUP = (status: string) => ({ status, step: 1, answers: { labelTypes: [] }, completedAt: null, skipped: false });
    const orgBody = (status: string, manage: boolean) => ({ org: { id: "org-a", name: "Atölye A" }, setup: SETUP(status), features: { registry: [], effective: {}, explicit: {} }, platform: true, access: { edit: true, spend: true, manage } });
    const server = (status: string | null, manage = true) =>
      (async (u: RequestInfo | URL) => {
        const url = String(u);
        if (url === "/api/account/me") return json(200, me());
        if (url === "/api/tagpress/languages") return json(200, { languages: [] });
        if (url === "/api/tagpress/org" && status) return json(200, orgBody(status, manage));
        return json(404, { error: "yok" });
      }) as unknown as typeof fetch;
    const navOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLAnchorElement>(".sod-nav a")];
    afterEach(() => sessionStorage.clear());

    it("kurulum bitmemiş, yönetebilen: menünün başında bayraklı Kurulum ve Eksik rozeti; Kurulum ekranındayken seçili", async () => {
      window.location.hash = "#/kurulum";
      const k = await mountKabuk(server("pending"));
      await waitFor(() => k.el.querySelector(".tz-setup-tag"));
      const first = navOf(k.el)[0]!;
      expect(first.getAttribute("href")).toBe("/tagpress/#/kurulum");
      expect(first.textContent).toContain("Kurulum");
      expect(first.querySelector(".tz-setup-tag")?.textContent).toBe("Eksik");
      expect(first.querySelector("svg[data-i]")?.getAttribute("data-i")).toBe("flag");
      expect(first.getAttribute("aria-current")).toBe("page");
      expect(navOf(k.el)).toHaveLength(6);
      // Kurulum form ekranı: kabuk sütunda.
      expect(k.el.querySelector(".sod-shell[data-sod-column]")).not.toBeNull();
    });

    it("yönetemeyen kişide ve kurulum tamamsa yok; çalışma ekranı sütunda değil", async () => {
      // Baskı masası çalışma ekranı (Üretim 2026-11-24'ten beri sütunda).
      window.location.hash = "#/baski";
      let k = await mountKabuk(server("pending", false));
      await waitFor(() => navOf(k.el).length > 0);
      await flush(4);
      expect(k.el.querySelector(".tz-setup-tag")).toBeNull();
      expect(navOf(k.el)).toHaveLength(5);
      expect(k.el.querySelector(".sod-shell[data-sod-column]")).toBeNull();
      await cleanup?.();
      cleanup = null;
      k = await mountKabuk(server("completed"));
      await waitFor(() => navOf(k.el).length > 0);
      await flush(4);
      expect(k.el.querySelector(".tz-setup-tag")).toBeNull();
    });

    it("yanıt gelmeden firmanın son bilinen durumuyla çizilir", async () => {
      window.location.hash = "#/ayarlar/dil";
      sessionStorage.setItem("tagpress.setup.pending", "org-a");
      const k = await mountKabuk(server(null));
      await waitFor(() => navOf(k.el).length > 0);
      expect(k.el.querySelector(".tz-setup-tag")?.textContent).toBe("Eksik");
      expect(k.el.querySelector(".sod-shell[data-sod-column]")).not.toBeNull();
    });
  });
});

describe("yetkiye göre kapanan eylemler", () => {
  const SETUP = { status: "completed", step: 3, answers: { labelTypes: [] }, completedAt: "2026-11-01T00:00:00Z", skipped: false };
  const org = (access: { edit: boolean; spend: boolean; manage: boolean }) => ({ org: { id: "org-a", name: "Atölye A" }, setup: SETUP, features: { registry: [], effective: {}, explicit: {} }, platform: true, access });
  const navButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>(".ay-gl-b")].map((b) => b.textContent?.trim());

  it("yönetici olmayan: Ayarlar'da Bağlantılar, Üretim, Maliyet ve Özellikler yok; Özellikler adresi başka bölüme düşer", async () => {
    mockFetch({ "/api/tagpress/org": org({ edit: true, spend: true, manage: false }), "/api/tagpress/languages": { languages: [] }, "/api/tagpress/fonts": { fonts: [] } });
    const r = await render(<AyarlarEkrani route={parseHash("#/ayarlar/ozellikler")} go={vi.fn()} />);
    await waitFor(() => navButtons().length > 0);
    expect(navButtons()).toEqual(["Fontlar", "Tasarım dilleri", "Firma", "Dil"]);
    expect([...document.body.querySelectorAll("h2")].map((h) => h.textContent)).not.toContain("Özellikler");
    await r.unmount();
  });

  it("yönetici: bütün bölümler; firma adı Merkez'de değişir (salt okunur)", async () => {
    mockFetch({ "/api/tagpress/org": org({ edit: true, spend: true, manage: true }), "/api/tagpress/languages": { languages: [] } });
    const r = await render(<AyarlarEkrani route={parseHash("#/ayarlar/firma")} go={vi.fn()} />);
    await waitFor(() => navButtons().length > 0);
    expect(navButtons()).toContain("Özellikler");
    expect(navButtons()).toContain("Bağlantılar");
    const input = await waitFor(() => document.body.querySelector<HTMLInputElement>(".ay-form input"));
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("Atölye A");
    expect(document.body.textContent).toContain("Firma adı SellerOnData Merkez'de değişir.");
    expect([...document.body.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Kaydet")).toBe(false);
    await r.unmount();
  });

  it("değiştirme ya da harcama izni yoksa ilgili düğme pasif, ipucunda neden", async () => {
    mockFetch({ "/api/tagpress/org": org({ edit: false, spend: false, manage: false }), "/api/tagpress/languages": { languages: [] } });
    const onClick = vi.fn();
    const r = await render(
      <>
        <Button need="edit" onClick={onClick}>
          Onayla
        </Button>
        <Button need="spend">Yeniden üret</Button>
        <Button>Göster</Button>
      </>,
    );
    await flush(4);
    const b = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent?.trim() === text);
    expect(b("Onayla")?.disabled).toBe(true);
    expect(b("Yeniden üret")?.disabled).toBe(true);
    expect(b("Göster")?.disabled).toBe(false);
    await r.unmount();
  });

  it("izin varsa aynı düğmeler açık", async () => {
    mockFetch({ "/api/tagpress/org": org({ edit: true, spend: true, manage: false }), "/api/tagpress/languages": { languages: [] } });
    const r = await render(<Button need="edit">Onayla</Button>);
    await waitFor(() => !document.body.querySelector<HTMLButtonElement>("button")?.disabled);
    await r.unmount();
  });
});
