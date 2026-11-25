// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkRow } from "./cerceve/cerceve.tsx";
import { useLeaveGuard } from "./katman/leaveGuard.ts";
import { Menu, Popover } from "./katman/Popover.tsx";
import "./kisayol/genel.ts";
import { defineCommands, setShortcutsOpen, useCommands } from "./kisayol/kayit.ts";
import { ShortcutsPanel } from "./kisayol/ShortcutsPanel.tsx";
import { click, flush, press, render, waitFor } from "./test/render.tsx";
import { ListRow, Tabs } from "./yerlesim/yerlesim.tsx";

/** İç içe katman, menülü sekme, satır tıklama olayı, akış adımı ipucu, gezinme bekçisi, tuşsuz komut. */

afterEach(async () => {
  await act(async () => setShortcutsOpen(false));
  document.body.innerHTML = "";
});

const active = () => document.activeElement as HTMLElement | null;
const pops = () => document.querySelectorAll(".tz-pop").length;

function Nested({ log }: { log: string[] }) {
  return (
    <>
      <Popover
        trigger={(p) => (
          <button type="button" id="outer" {...p}>
            dış
          </button>
        )}
      >
        {() => (
          <div>
            <input id="name" aria-label="ad" />
            <Menu
              align="start"
              trigger={(p) => (
                <button type="button" id="inner" {...p}>
                  şablon
                </button>
              )}
              items={[
                { label: "A15", onSelect: () => log.push("a15") },
                { label: "B20", onSelect: () => log.push("b20") },
              ]}
            />
          </div>
        )}
      </Popover>
      <button type="button" id="away">
        başka
      </button>
    </>
  );
}

describe("iç içe katman", () => {
  it("iç menü açılınca dış kutu açık kalır; Esc önce içtekini, sonra dıştakini kapatır", async () => {
    const r = await render(<Nested log={[]} />);
    await click(r.get("#outer"));
    const inner = r.get<HTMLButtonElement>("#inner");
    inner.focus();
    await click(inner);
    expect(pops()).toBe(2);
    expect(active()?.textContent).toContain("A15");
    await press("Escape", { target: active()! });
    expect(pops()).toBe(1);
    expect(active()?.id).toBe("inner");
    await press("Escape", { target: active()! });
    expect(pops()).toBe(0);
    expect(active()?.id).toBe("outer");
    await r.unmount();
  });

  it("iç menüde seçim yalnız içtekini kapatır; dışarı tık ikisini de kapatır", async () => {
    const log: string[] = [];
    const r = await render(<Nested log={log} />);
    await click(r.get("#outer"));
    await click(r.get("#inner"));
    await click(r.byText("B20", "[role=menuitem]")!);
    expect(log).toEqual(["b20"]);
    expect(pops()).toBe(1);
    await click(r.get("#inner"));
    expect(pops()).toBe(2);
    const away = r.get<HTMLButtonElement>("#away");
    await act(async () => {
      away.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      away.focus();
    });
    expect(pops()).toBe(0);
    await r.unmount();
  });
});

describe("menülü sekme", () => {
  it("oklarla menü sekmesine gelince seçilmez; Enter ve ↓ menüyü açar; öğe seçer, odak sekmeye döner", async () => {
    const onChange = vi.fn();
    const pick = vi.fn();
    const r = await render(
      <Tabs
        label="Süzgeç"
        value="all"
        onChange={onChange}
        items={[
          { id: "all", label: "Hepsi" },
          { id: "err", label: "Sorunlu", count: 2 },
          { id: "more", label: "Diğer", menu: true, menuItems: [{ label: "Atlananlar", onSelect: () => pick("skipped") }, "sep", { label: "Basılanlar", onSelect: () => pick("printed") }] },
        ]}
      />,
    );
    const tabs = [...r.container.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const more = tabs[2]!;
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    tabs[0]!.focus();
    await press("ArrowRight", { target: tabs[0]! });
    expect(onChange).toHaveBeenLastCalledWith("err");
    await press("ArrowRight", { target: tabs[1]! });
    expect(active()).toBe(more);
    expect(onChange).toHaveBeenCalledTimes(1);
    await press("Enter", { target: more });
    expect(r.get("[role=menu]")).not.toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // menüdeki oklar sekmeleri gezmez
    await press("ArrowDown", { target: active()! });
    expect(active()?.textContent).toContain("Basılanlar");
    await press("End", { target: active()! });
    expect(active()?.getAttribute("role")).toBe("menuitem");
    await click(active()!);
    expect(pick).toHaveBeenCalledWith("printed");
    expect(active()).toBe(more);
    await press("ArrowDown", { target: more });
    expect(r.get("[role=menu]")).not.toBeNull();
    await r.unmount();
  });
});

describe("satır ve akış", () => {
  it("ListRow onClick olayı verir (Ctrl / Shift tıklama)", async () => {
    const seen: Array<[boolean, boolean]> = [];
    const r = await render(<ListRow title="İş 12" onClick={(e) => seen.push([e.ctrlKey, e.shiftKey])} />);
    const b = r.get<HTMLButtonElement>(".tz-lr-b");
    await act(async () => {
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    expect(seen).toEqual([
      [true, false],
      [false, true],
    ]);
    await r.unmount();
  });

  it("FlowStep hint ipucu olarak görünür", async () => {
    const r = await render(<WorkRow crumbs={[{ label: "Üretim" }]} flow={[{ id: "a", label: "Öneriler", count: 3, hint: "3 işte öneri var", onClick: () => {} }]} />);
    const step = r.get<HTMLButtonElement>(".tz-flow button");
    await press("Tab");
    await act(async () => step.focus());
    await waitFor(() => document.querySelector(".tz-tip")?.textContent === "3 işte öneri var");
    await r.unmount();
  });
});

describe("? listesi", () => {
  defineCommands([
    { id: "ayarlar.testTussuz", scope: "ayarlar", keys: [], group: "shortcuts:groups.general" },
    { id: "ayarlar.testTuslu", scope: "ayarlar", keys: ["n"], group: "shortcuts:groups.general" },
  ]);
  function Screen() {
    useCommands("ayarlar", {});
    return null;
  }
  it("tuşu olmayan komut satırı gösterilmez", async () => {
    const r = await render(
      <>
        <Screen />
        <ShortcutsPanel />
      </>,
    );
    await act(async () => setShortcutsOpen(true));
    const panel = r.get("dialog .tz-kp");
    expect(panel.querySelector('[data-command="ayarlar.testTussuz"]')).toBeNull();
    expect(panel.querySelector('[data-command="ayarlar.testTuslu"]')).not.toBeNull();
    await r.unmount();
  });
});

function Guarded({ initial = true }: { initial?: boolean }) {
  const [dirty, setDirty] = useState(initial);
  const guard = useLeaveGuard(dirty);
  return (
    <>
      <button type="button" id="clean" onClick={() => setDirty(false)}>
        kaydet
      </button>
      <button
        type="button"
        id="save-go"
        onClick={() => {
          guard.pass();
          window.location.hash = "#/baski";
        }}
      >
        kaydet ve git
      </button>
    </>
  );
}

const hashChanged = async (h: string) => {
  await act(async () => {
    window.location.hash = h;
    // happy-dom hashchange'i bir sonraki zamanlayıcı turunda değil, biraz sonra yollar.
    await new Promise((res) => setTimeout(res, 20));
  });
  await flush(2);
};

describe("gezinme bekçisi", () => {
  it("değişiklik varken adres değişimi durur ve onay sorulur; Vazgeç kalır, Kaydetmeden çık gider", async () => {
    await hashChanged("#/duzelt/v1"); // başlangıç adresi bekçi kurulmadan yerleşsin (olay eşzamansız)
    const seen: string[] = [];
    const listen = () => seen.push(window.location.hash);
    window.addEventListener("hashchange", listen);
    const r = await render(<Guarded />);
    await hashChanged("#/uretim");
    expect(window.location.hash).toBe("#/duzelt/v1");
    expect(seen).toEqual([]); // rota dinleyicileri olayı görmedi
    const dlg = await waitFor(() => document.querySelector("dialog"));
    expect(dlg.textContent).toContain("Değişiklikler kaydedilmedi");
    await click(r.byText("Vazgeç")!);
    await flush(2);
    expect(window.location.hash).toBe("#/duzelt/v1");
    await hashChanged("#/uretim");
    await click((await waitFor(() => r.byText("Kaydetmeden çık")))!);
    await waitFor(() => window.location.hash === "#/uretim" && seen.length > 0);
    expect(window.location.hash).toBe("#/uretim");
    expect(seen).toEqual(["#/uretim"]);
    window.removeEventListener("hashchange", listen);
    await r.unmount();
  });

  it("değişiklik yokken ya da pass() sonrası serbest; sekme kapatmada tarayıcı uyarısı", async () => {
    await hashChanged("#/duzelt/v2");
    const r = await render(<Guarded />);
    const before = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    await click(r.get("#save-go"));
    await act(async () => new Promise((res) => setTimeout(res, 20)));
    expect(window.location.hash).toBe("#/baski");
    expect(document.querySelector("dialog")).toBeNull();
    await click(r.get("#clean"));
    await hashChanged("#/ayarlar");
    expect(window.location.hash).toBe("#/ayarlar");
    expect(document.querySelector("dialog")).toBeNull();
    const after = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    await r.unmount();
  });
});

describe("baskı masası istekleri", () => {
  it("NumberStepper editable: yazılan sayı Enter'da uygulanır, sınıra çekilir; geçersizde eski değer; Esc vazgeçer", async () => {
    const { NumberStepper } = await import("./form/form.tsx");
    const seen: number[] = [];
    function S() {
      const [v, setV] = useState(11);
      return (
        <NumberStepper
          editable
          value={v}
          step={1}
          min={1}
          max={500}
          format={(n) => String(n)}
          onChange={(n) => {
            seen.push(n);
            setV(n);
          }}
          aria-label="Kopya"
        />
      );
    }
    const r = await render(<S />);
    const input = r.get<HTMLInputElement>("input.tz-st-in");
    expect(input.getAttribute("role")).toBe("spinbutton");
    const type = async (text: string) => {
      await act(async () => input.focus());
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("1.250");
    await press("Enter", { target: input });
    expect(seen).toEqual([500]); // sınıra çekildi
    await type("abc");
    await press("Enter", { target: input });
    expect(seen).toEqual([500]);
    expect(input.value).toBe("500");
    await type("42");
    await press("Escape", { target: input });
    await act(async () => input.blur());
    expect(seen).toEqual([500]);
    await type("42");
    await act(async () => input.blur());
    expect(seen).toEqual([500, 42]);
    await press("ArrowUp", { target: input });
    expect(seen.at(-1)).toBe(43);
    await r.unmount();
  });

  it("BandButton menü açar; ZoomControl düğme metni; Button chevron; unlock ikonu", async () => {
    const { BandButton } = await import("./cerceve/cerceve.tsx");
    const { Button } = await import("./dugme/Button.tsx");
    const { Icon } = await import("./ikon/Icon.tsx");
    const pick = vi.fn();
    const r = await render(
      <>
        <BandButton label="Taslak oturumlar" menuItems={[{ label: "21 Kasım", onSelect: pick }]} />
        <Button chevron>A4</Button>
        <Icon name="unlock" />
      </>,
    );
    const band = r.get<HTMLButtonElement>(".tz-cb");
    expect(band.getAttribute("aria-haspopup")).toBe("menu");
    await click(band);
    await click(r.byText("21 Kasım", "[role=menuitem]")!);
    expect(pick).toHaveBeenCalled();
    expect(r.get(".tz-btn-chev")).not.toBeNull();
    expect(r.get('svg[data-icon="unlock"]')).not.toBeNull();
    await r.unmount();
  });
});
