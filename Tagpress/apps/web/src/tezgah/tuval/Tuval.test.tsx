// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import "../kisayol/genel.ts";
import { click, press, render, waitFor } from "../test/render.tsx";
import { PX_PER_MM, type Rect, toWorld } from "./canvas-math.ts";
import { Artboard, CanvasViewport, canvasStats, SelectionBox, worldRectStyle, ZoomControl } from "./Tuval.tsx";
import { type ViewApi, useViewport } from "./useViewport.ts";

/**
 * Tuval: tekerlek ve kısayolla yakınlaştırma, sığdır / %100 / seçime, kaydırmada React çiziminin dünya katmanına
 * inmemesi (başarım sayacı), görünür alan dışındaki sayfaların çizilmemesi.
 */

const W = 800;
const H = 600;

// happy-dom düzen hesaplamaz: tuval kabı 800 × 600 ölçülsün.
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    queueMicrotask(() => this.cb([{ target: el, contentRect: { width: W, height: H } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});
afterEach(() => {
  document.body.innerHTML = "";
});

const WORLD: Rect = { x: 0, y: 0, w: 100, h: 50 };
const SEL: Rect = { x: 60, y: 10, w: 20, h: 10 };
let api: ViewApi;
let screenRenders = 0;

function Screen({ world = WORLD, children }: { world?: Rect; children?: ReactNode }) {
  screenRenders++;
  api = useViewport({ world });
  return (
    <>
      <CanvasViewport api={api} rulers highlight={{ x: [SEL.x, SEL.x + SEL.w] }}>
        {children}
      </CanvasViewport>
      <ZoomControl api={api} presets={["fit", "actual", "selection"]} onSelection={() => api.fit(SEL)} />
    </>
  );
}

const box = () => document.querySelector<HTMLElement>(".tz-cv")!;
const world = () => document.querySelector<HTMLElement>(".tz-cv-world")!;
const view = () => api.canvas.get();
/** happy-dom WheelEvent'i ctrlKey/clientX/clientY'yi kurucudan almaz: elle yazılır. */
const wheel = ({ ctrlKey = false, clientX = 0, clientY = 0, ...init }: WheelEventInit) => {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  Object.defineProperties(e, { ctrlKey: { value: ctrlKey }, clientX: { value: clientX }, clientY: { value: clientY } });
  return box().dispatchEvent(e);
};

async function mount(children?: ReactNode, w?: Rect) {
  const r = await render(<Screen world={w}>{children}</Screen>);
  await waitFor(() => api.canvas.size().w === W);
  return r;
}

describe("tuval: yakınlaştırma", () => {
  it("ilk boyutta dünya sığdırılır; dönüşüm dünya katmanına yazılır", async () => {
    const r = await mount();
    const z = Math.min((W - 80) / WORLD.w, (H - 80) / WORLD.h);
    expect(view().zoom).toBeCloseTo(z);
    expect(world().style.transform).toContain(`scale(${view().zoom})`);
    expect(world().style.getPropertyValue("--tz-zoom")).toBe(String(view().zoom));
    await r.unmount();
  });

  it("Ctrl + tekerlek imlece doğru yakınlaştırır; düz tekerlek kaydırır", async () => {
    const r = await mount();
    const before = view();
    const at = { x: 300, y: 200 };
    const p = toWorld(at, before);
    await act(async () => wheel({ deltaY: -100, ctrlKey: true, clientX: at.x, clientY: at.y }));
    expect(view().zoom).toBeGreaterThan(before.zoom);
    const q = toWorld(at, view());
    expect(q.x).toBeCloseTo(p.x);
    expect(q.y).toBeCloseTo(p.y);
    const zoomed = view();
    await act(async () => wheel({ deltaY: 50 }));
    expect(view().zoom).toBe(zoomed.zoom);
    expect(view().y).toBeCloseTo(zoomed.y - 50);
    expect(view().x).toBeCloseTo(zoomed.x);
    await r.unmount();
  });

  it("kısayollar: Ctrl = / Ctrl −, Shift 1 sığdır, 1 gerçek boyut, Shift 2 seçime", async () => {
    const r = await mount();
    const fit = view().zoom;
    await press("=", { ctrlKey: true });
    expect(view().zoom).toBeCloseTo(fit * 1.25);
    await press("-", { ctrlKey: true });
    expect(view().zoom).toBeCloseTo(fit);
    await press("1");
    expect(view().zoom).toBeCloseTo(PX_PER_MM);
    await waitFor(() => document.querySelector(".tz-zm-v")?.textContent === "%100");
    await press("2", { shiftKey: true });
    const selZoom = Math.min((W - 80) / SEL.w, (H - 80) / SEL.h);
    expect(view().zoom).toBeCloseTo(selZoom);
    // seçimin ortası tuvalin ortasında
    const c = toWorld({ x: W / 2, y: H / 2 }, view());
    expect(c.x).toBeCloseTo(SEL.x + SEL.w / 2);
    expect(c.y).toBeCloseTo(SEL.y + SEL.h / 2);
    await press("1", { shiftKey: true });
    expect(view().zoom).toBeCloseTo(fit);
    await r.unmount();
  });

  it("yakınlaştırma düğmeleri: sığdır, gerçek boyut, seçime, + ve −", async () => {
    const r = await mount();
    const fit = view().zoom;
    const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".tz-zm button")].find((b) => b.textContent?.includes(label) || b.getAttribute("aria-label") === label)!;
    await click(btn("Gerçek boyut"));
    expect(view().zoom).toBeCloseTo(PX_PER_MM);
    await click(btn("Seçime yakınlaştır"));
    expect(view().zoom).toBeCloseTo(Math.min((W - 80) / SEL.w, (H - 80) / SEL.h));
    await click(btn("Sığdır"));
    expect(view().zoom).toBeCloseTo(fit);
    await click(btn("Yakınlaştır"));
    expect(view().zoom).toBeCloseTo(fit * 1.25);
    await click(btn("Uzaklaştır"));
    expect(view().zoom).toBeCloseTo(fit);
    await r.unmount();
  });

  it("cetvel mm sayılarını ve seçim vurgusunu çizer", async () => {
    const r = await mount();
    await waitFor(() => document.querySelectorAll(".tz-rl--t .tz-rl-j").length > 0);
    const labels = [...document.querySelectorAll(".tz-rl--t .tz-rl-j")].map((e) => e.textContent);
    expect(labels).toContain("0");
    expect(document.querySelector(".tz-rl--t .tz-rl-hi")).not.toBeNull();
    expect(document.querySelectorAll(".tz-rl--l .tz-rl-j").length).toBeGreaterThan(0);
    await r.unmount();
  });

  it("sol cetvel 3 karaktere kadar yatay (maket), daha uzun sayı görünürse dikey", async () => {
    const r = await mount();
    await waitFor(() => document.querySelectorAll(".tz-rl--l .tz-rl-j").length > 0);
    const left = () => document.querySelector(".tz-rl--l")!;
    expect(left().classList.contains("tz-rl--v")).toBe(false);
    // 1 metreden ötesine kaydır: 4 basamaklı mm sayıları görünür
    await act(async () => api.canvas.set({ zoom: 0.5, x: 0, y: -600 }));
    await waitFor(() => left().classList.contains("tz-rl--v"));
    expect([...document.querySelectorAll(".tz-rl--l .tz-rl-j")].some((e) => (e.textContent ?? "").length > 3)).toBe(true);
    await r.unmount();
  });
});

describe("tuval: başarım", () => {
  let contentRenders = 0;
  function Heavy({ i }: { i: number }) {
    contentRenders++;
    return <div className="heavy" data-i={i} style={{ width: 210, height: 297 }} />;
  }

  it("30 kaydırma adımında dünya içeriği yeniden çizilmez; ekran seyrek, cetvel karede bir çizilir", async () => {
    const pages = Array.from({ length: 40 }, (_, i) => (
      <Artboard key={i} x={(i % 8) * 230} y={Math.floor(i / 8) * 320} name={`S${i + 1}`}>
        <Heavy i={i} />
      </Artboard>
    ));
    const r = await mount(pages, { x: 0, y: 0, w: 8 * 230, h: 5 * 320 });
    await waitFor(() => document.querySelectorAll(".tz-rl--t .tz-rl-j").length > 0);
    const c0 = contentRenders;
    const s0 = screenRenders;
    const v0 = canvasStats.viewport;
    const r0 = canvasStats.rulers;
    const start = view();
    await act(async () => {
      for (let i = 0; i < 30; i++) wheel({ deltaY: 10, deltaX: 5 });
    });
    // dönüşüm son konumda
    expect(view().y).toBeCloseTo(start.y - 300);
    expect(view().x).toBeCloseTo(start.x - 150);
    expect(world().style.transform).toContain(`translate(${view().x}px, ${view().y}px)`);
    // seyrek güncellemenin sonu
    await waitFor(() => api.view.y === view().y, 1000);
    expect(contentRenders - c0).toBe(0);
    expect(screenRenders - s0).toBeLessThanOrEqual(3);
    expect(canvasStats.viewport - v0).toBeLessThanOrEqual(3);
    expect(canvasStats.rulers - r0).toBeLessThanOrEqual(3);
    await r.unmount();
  });

  it("boyutu verilen Artboard görünür alanın dışındayken içeriğini çizmez; kaydırınca çizer", async () => {
    const pages = Array.from({ length: 40 }, (_, i) => (
      <Artboard key={i} x={i * 230} y={0} w={210} h={297} name={`S${i + 1}`}>
        <Heavy i={i} />
      </Artboard>
    ));
    const r = await mount(pages, { x: 0, y: 0, w: 210, h: 297 });
    const drawn = () => [...document.querySelectorAll<HTMLElement>(".heavy")].map((e) => Number(e.dataset.i));
    expect(drawn()).toEqual([0, 1, 2]);
    expect(document.querySelectorAll(".tz-ab.is-culled").length).toBe(37);
    await act(async () => wheel({ deltaX: 2000 }));
    const now = drawn();
    expect(now).not.toContain(0);
    expect(now.length).toBeGreaterThan(0);
    expect(now).toContain(5);
    expect(now.length).toBeLessThanOrEqual(5);
    await r.unmount();
  });
});

describe("tuval öğeleri", () => {
  it("seçim çerçevesi tutamakları kimliğiyle ve ölçü etiketiyle çizilir", async () => {
    const r = await mount(<SelectionBox rect={SEL} handles sizeLabel="20 × 10 mm" />);
    const hs = [...document.querySelectorAll<HTMLElement>("[data-tz-handle]")].map((h) => h.dataset.tzHandle);
    expect(hs).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
    expect(document.querySelector(".tz-szb")?.textContent).toBe("20 × 10 mm");
    await r.unmount();
  });

  it("seçim çerçevesi dünya birimine yuvarlanmaz: konum ve boyut left/width ile değil, ekran pikselli kutuya değişkenle", async () => {
    // Chrome dünya katmanındaki (scale(zoom)) kutunun left/top/width/height'ını boyamadan önce 1 dünya birimine (1 mm)
    // yuvarlar: yazı akarken çerçeve mm mm sıçrar, genişliği 1 mm büyüyüp küçülür. Kutu ekran pikselinde çizilmeli.
    const rect: Rect = { x: 10.37, y: 4.71, w: 20.35, h: 9.08 };
    const r = await mount(<SelectionBox rect={rect} handles />);
    const el = r.get<HTMLElement>(".tz-selbox");
    expect(el.classList.contains("tz-wrect")).toBe(true);
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(["", "", "", ""]);
    expect(["--tz-x", "--tz-y", "--tz-w", "--tz-h"].map((p) => el.style.getPropertyValue(p))).toEqual(["10.37", "4.71", "20.35", "9.08"]);
    expect(worldRectStyle(rect)).toEqual({ "--tz-x": 10.37, "--tz-y": 4.71, "--tz-w": 20.35, "--tz-h": 9.08 });
    await r.unmount();
  });
});

describe("ZoomControl metinleri", () => {
  it("labels.fit verilirse sığdır düğmesinin metni o; ipucu ve kısayol komuttan", async () => {
    function Z() {
      api = useViewport({ world: WORLD });
      return <ZoomControl api={api} presets={["fit", "actual"]} labels={{ fit: "Hepsini sığdır" }} />;
    }
    const r = await render(<Z />);
    const texts = [...document.querySelectorAll(".tz-zm .tz-btn")].map((b) => b.textContent);
    expect(texts).toEqual(["Hepsini sığdır", "Gerçek boyut"]);
    expect(document.querySelector(".tz-zm .tz-btn")?.getAttribute("aria-keyshortcuts")).toBe("Shift+1");
    await r.unmount();
  });
});
