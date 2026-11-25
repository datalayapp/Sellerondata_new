// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n/test.ts";
import "../kisayol/genel.ts";
import { click, press, render } from "../test/render.tsx";
import { CollapsedGroup, Rail, SelectionBar, Tabs } from "./yerlesim.tsx";

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* kayıt yok */
  }
});

describe("CollapsedGroup", () => {
  it("tek tıkla açılır ve kapanır; aria-expanded izler", async () => {
    const r = await render(
      <CollapsedGroup title="Ayrıntılar" summary="satırlar, maliyet">
        <p>içerik</p>
      </CollapsedGroup>,
    );
    const head = r.get<HTMLButtonElement>(".tz-gc-h");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(r.get(".tz-gc-b").hasAttribute("hidden")).toBe(true);
    expect(head.textContent).toContain("satırlar, maliyet");
    await click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(r.get(".tz-gc-b").hasAttribute("hidden")).toBe(false);
    expect(head.textContent).not.toContain("satırlar, maliyet");
    await click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    await r.unmount();
  });

  it("klavyeyle açılır: gerçek bir düğmedir ve içeriğine aria-controls ile bağlıdır", async () => {
    const r = await render(
      <CollapsedGroup title="Ayrıntılar">
        <p>içerik</p>
      </CollapsedGroup>,
    );
    const head = r.get<HTMLButtonElement>(".tz-gc-h");
    expect(head.tagName).toBe("BUTTON");
    expect(head.getAttribute("aria-controls")).toBe(r.get(".tz-gc-b").id);
    await r.unmount();
  });

  it("persistKey verilince durum yerel kayıtta kalır ve yeniden açılışta okunur", async () => {
    const a = await render(
      <CollapsedGroup title="Ayrıntılar" persistKey="test.grup">
        <p>içerik</p>
      </CollapsedGroup>,
    );
    await click(a.get(".tz-gc-h"));
    expect(localStorage.getItem("tagpress.grup.test.grup")).toBe("1");
    await a.unmount();
    const b = await render(
      <CollapsedGroup title="Ayrıntılar" persistKey="test.grup">
        <p>içerik</p>
      </CollapsedGroup>,
    );
    expect(b.get(".tz-gc-h").getAttribute("aria-expanded")).toBe("true");
    await b.unmount();
  });

  it("yerel kayıt okunamazsa (hata fırlatırsa) varsayılanla çalışır", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("kayıt yok");
    });
    const r = await render(
      <CollapsedGroup title="Ayrıntılar" persistKey="x" defaultOpen>
        <p>içerik</p>
      </CollapsedGroup>,
    );
    expect(r.get(".tz-gc-h").getAttribute("aria-expanded")).toBe("true");
    spy.mockRestore();
    await r.unmount();
  });
});

describe("Rail", () => {
  const items = [
    { id: "fit", icon: "fit" as const, command: "canvas.fit" },
    { id: "actual", icon: "grid" as const, command: "canvas.actual" },
    "divider" as const,
    { id: "pan", icon: "hand" as const, command: "canvas.pan" },
  ];

  it("↑ ↓ ile düğmeler arasında gezilir, uçlarda sarar; yalnız etkin düğme sekme sırasında", async () => {
    const r = await render(<Rail label="Araçlar" items={items} value="fit" onChange={() => {}} />);
    const btns = [...r.container.querySelectorAll<HTMLButtonElement>(".tz-rail-b")];
    expect(btns).toHaveLength(3);
    expect(btns.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    btns[0]!.focus();
    await press("ArrowDown", { target: btns[0]! });
    expect(document.activeElement).toBe(btns[1]);
    await press("ArrowDown", { target: btns[1]! });
    expect(document.activeElement).toBe(btns[2]);
    await press("ArrowDown", { target: btns[2]! });
    expect(document.activeElement).toBe(btns[0]);
    await press("ArrowUp", { target: btns[0]! });
    expect(document.activeElement).toBe(btns[2]);
    await press("Home", { target: btns[2]! });
    expect(document.activeElement).toBe(btns[0]);
    await r.unmount();
  });

  it("tıklama aracı seçer; etkin araç aria-pressed taşır ve adı kayıttan gelir", async () => {
    const onChange = vi.fn();
    const r = await render(<Rail label="Araçlar" items={items} value="actual" onChange={onChange} />);
    const btns = [...r.container.querySelectorAll<HTMLButtonElement>(".tz-rail-b")];
    expect(btns[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(btns[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(btns[0]!.getAttribute("aria-label")).toBeTruthy();
    await click(btns[2]!);
    expect(onChange).toHaveBeenCalledWith("pan");
    await r.unmount();
  });
});

describe("Tabs", () => {
  const tabs = [
    { id: "a", label: "Tümü", count: 12 },
    { id: "b", label: "Sorunlu", count: 1 },
    { id: "c", label: "Diğer", menu: true },
  ];

  it("← → ile sekmeler arasında gezilir: seçim ve odak birlikte gider", async () => {
    const onChange = vi.fn();
    const r = await render(<Tabs items={tabs} value="a" onChange={onChange} label="Süzgeç" />);
    const els = [...r.container.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    expect(r.get("[role=tablist]").getAttribute("aria-label")).toBe("Süzgeç");
    expect(els.map((e) => e.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    els[0]!.focus();
    await press("ArrowRight", { target: els[0]! });
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(document.activeElement).toBe(els[1]);
    await press("ArrowLeft", { target: els[0]! });
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(els[2]);
    await r.unmount();
  });
});

describe("SelectionBar", () => {
  it("Esc seçimi kaldırır (onClear); etiket aria-live bölgesindedir", async () => {
    const onClear = vi.fn();
    const r = await render(
      <SelectionBar label="3 satır seçili" onClear={onClear}>
        <button type="button">Dahil et</button>
      </SelectionBar>,
    );
    expect(r.get("[aria-live=polite]").textContent).toBe("3 satır seçili");
    await press("Escape");
    expect(onClear).toHaveBeenCalledTimes(1);
    await r.unmount();
  });

  it("yazı alanındayken Esc seçimi kaldırmaz; kapatma düğmesi kaldırır", async () => {
    const onClear = vi.fn();
    const r = await render(
      <>
        <input aria-label="Ad" />
        <SelectionBar label="2 satır" onClear={onClear}>
          <span />
        </SelectionBar>
      </>,
    );
    await press("Escape", { target: r.get("input") });
    expect(onClear).not.toHaveBeenCalled();
    await click(r.get(".tz-selbar .tz-ib"));
    expect(onClear).toHaveBeenCalledTimes(1);
    await r.unmount();
  });
});
