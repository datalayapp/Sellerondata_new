// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { parseHash } from "../../lib/route.ts";
import { pickScreen, screenFor, TezgahApp } from "../rotalar.tsx";
import { click, flush, mockFetch, render, waitFor } from "../test/render.tsx";
import { Panel, Workspace } from "../yerlesim/yerlesim.tsx";
import { AppFrame, NarrowNote, WorkRow } from "./cerceve.tsx";
import { PHONE_QUERY, type ScreenLayout, ScreenLayoutContext } from "./duzen.ts";

/**
 * Yerleşim (ARAYUZ-PLANI "Yerleşim"): ekran türüne göre çerçeve sınıfı, tablette yan panel çekmeceleri ve iş satırı
 * düğmeleri, telefonda çalışma ekranı yerine not, yerel üst satırda "Kurulum · Eksik".
 */
const realMatchMedia = window.matchMedia;
function stubPhone(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q === PHONE_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
  sessionStorage.clear();
  document.body.innerHTML = "";
});

function frame(layout: ScreenLayout | null, panels: { left?: boolean; right?: boolean } = { left: true, right: true }) {
  return (
    <ScreenLayoutContext.Provider value={layout}>
      <AppFrame band="work" active="uretim" workRow={<WorkRow crumbs={[{ label: "Üretim" }]} />}>
        <Workspace left={panels.left ? <Panel side="left">sol</Panel> : undefined} right={panels.right ? <Panel side="right">sağ</Panel> : undefined}>
          <p>tuval</p>
        </Workspace>
      </AppFrame>
    </ScreenLayoutContext.Provider>
  );
}

describe("ekran türüne göre çerçeve", () => {
  it("çalışma ekranı: geniş çerçeve; iş satırında iki panel düğmesi, çekmece birini açar ve kapatır", async () => {
    const r = await render(frame({ kind: "work", routeId: "uretim" }));
    expect(r.container.querySelector(".tz-app--work")).not.toBeNull();
    expect(r.container.querySelector(".tz-app--col")).toBeNull();
    const ws = r.get(".tz-ws");
    expect(ws.classList.contains("tz-ws--drawers")).toBe(true);
    const buttons = [...r.container.querySelectorAll<HTMLButtonElement>(".tz-ctx-dr")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Sol panel", "Sağ panel"]);
    expect(ws.dataset.drawer).toBeUndefined();
    await click(buttons[1]!);
    expect(ws.dataset.drawer).toBe("right");
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("true");
    await click(buttons[0]!);
    expect(ws.dataset.drawer).toBe("left");
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("false");
    await click(buttons[0]!);
    expect(ws.dataset.drawer).toBeUndefined();
    await r.unmount();
  });

  it("paneli olmayan yanın düğmesi yok", async () => {
    const r = await render(frame({ kind: "work", routeId: "uretim" }, { right: true }));
    expect([...r.container.querySelectorAll(".tz-ctx-dr")].map((b) => b.getAttribute("aria-label"))).toEqual(["Sağ panel"]);
    await r.unmount();
  });

  it("form ve liste ekranı: sütun çerçevesi, çekmece ve panel düğmesi yok", async () => {
    const r = await render(frame({ kind: "column", routeId: "ayarlar" }));
    expect(r.container.querySelector(".tz-app--col")).not.toBeNull();
    expect(r.get(".tz-ws").classList.contains("tz-ws--col")).toBe(true);
    expect(r.container.querySelector(".tz-ws--drawers, .tz-ws-side, .tz-ctx-dr")).toBeNull();
    await r.unmount();
  });

  it("tür bilinmiyorsa (bağlam yok) bugünkü geniş düzen, sınıf ve çekmece yok", async () => {
    const r = await render(frame(null));
    expect(r.container.querySelector(".tz-app--work, .tz-app--col, .tz-ws-side, .tz-ctx-dr")).toBeNull();
    await r.unmount();
  });
});

describe("telefon", () => {
  it("çalışma ekranı yerine not; form ve liste ekranı kendisi", () => {
    for (const h of ["#/uretim", "#/duzelt/v1", "#/baski", "#/tasarim-dili/kurallar", "#/sablonlar/a1"]) expect(screenFor(parseHash(h), true)).toBe(NarrowNote);
    for (const h of ["#/kurulum", "#/ayarlar/dil", "#/baski/arsiv", "#/sablonlar"]) expect(screenFor(parseHash(h), true)).toBe(pickScreen(parseHash(h)));
    expect(screenFor(parseHash("#/uretim"), false)).toBe(pickScreen(parseHash("#/uretim")));
  });

  it("Üretim telefonda not gösterir, bant ve menü yerinde", async () => {
    stubPhone(true);
    mockFetch({ "/api/languages": { languages: [] }, "/api/generate/status": { running: 0, queued: 0 } });
    window.location.hash = "#/uretim";
    const r = await render(<TezgahApp />);
    await waitFor(() => document.querySelector(".tz-narrow"));
    expect(document.querySelector(".tz-narrow h2")?.textContent).toBe("Bu ekran geniş ekranda çalışır");
    expect(document.querySelector(".tz-narrow p")?.textContent).toContain("Ayarlar ve Kurulum telefonda da açılır");
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("Üretim");
    expect(document.querySelector(".tz-nv a[aria-current=page]")?.getAttribute("href")).toBe("#/uretim");
    await r.unmount();
  });

  it("Ayarlar telefonda da açılır (not yok)", async () => {
    stubPhone(true);
    mockFetch({ "/api/languages": { languages: [] }, "/api/generate/status": { running: 0, queued: 0 }, "/api/fonts": { fonts: [] } });
    window.location.hash = "#/ayarlar/dil";
    const r = await render(<TezgahApp />);
    await waitFor(() => document.querySelector(".ay-gl"));
    expect(document.querySelector(".tz-narrow")).toBeNull();
    expect(document.querySelector(".tz-app--col")).not.toBeNull();
    await r.unmount();
  });
});

describe("yerel üst satırda Kurulum · Eksik", () => {
  const org = (status: string) => ({
    org: { id: "org-1", name: "Atölye" },
    setup: { status, step: 1, answers: { labelTypes: [] }, completedAt: null, skipped: false },
    features: { registry: [], effective: {}, explicit: {} },
    platform: false,
    access: { edit: true, spend: true, manage: true },
  });
  async function open(hash: string, status?: string) {
    mockFetch({ "/api/languages": { languages: [] }, "/api/generate/status": { running: 0, queued: 0 }, ...(status ? { "/api/org": org(status) } : {}) });
    window.location.hash = hash;
    const r = await render(<TezgahApp />);
    await waitFor(() => document.querySelector(".tz-top"));
    await flush(4);
    return r;
  }
  const items = () => [...document.querySelectorAll<HTMLAnchorElement>(".tz-nv a")];

  it("kurulum bitmemişse menünün başında, Kurulum ekranındayken seçili", async () => {
    const r = await open("#/kurulum", "pending");
    const first = items()[0]!;
    expect(items()).toHaveLength(6);
    expect(first.getAttribute("href")).toBe("#/kurulum");
    expect(first.textContent).toBe("KurulumEksik");
    expect(first.querySelector(".tz-setup-tag")?.textContent).toBe("Eksik");
    expect(first.getAttribute("aria-current")).toBe("page");
    await r.unmount();
  });

  it("kurulum tamamsa yok", async () => {
    const r = await open("#/ayarlar/dil", "completed");
    expect(items()).toHaveLength(5);
    expect(document.querySelector(".tz-setup-tag")).toBeNull();
    await r.unmount();
  });

  it("yanıt gelmeden son bilinen değerle çizilir (ilk karede zıplamaz)", async () => {
    sessionStorage.setItem("tagpress.setup.pending", "yerel");
    const r = await open("#/ayarlar/dil");
    expect(document.querySelector(".tz-setup-tag")?.textContent).toBe("Eksik");
    await r.unmount();
  });
});
