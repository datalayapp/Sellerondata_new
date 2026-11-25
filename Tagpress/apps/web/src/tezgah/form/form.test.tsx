// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import "../../i18n/test.ts";
import { click, press, render } from "../test/render.tsx";
import { Checkbox, Field, NumberStepper, Segmented, TextField } from "./form.tsx";

describe("Checkbox", () => {
  it("mixed durumu aria-checked=mixed taşır; tıklayınca işaretli olur", async () => {
    const onChange = vi.fn();
    const r = await render(<Checkbox checked="mixed" onChange={onChange} label="Hepsini seç" />);
    const c = r.get<HTMLButtonElement>("[role=checkbox]");
    expect(c.getAttribute("aria-checked")).toBe("mixed");
    expect(c.getAttribute("aria-label")).toBe("Hepsini seç");
    expect(c.className).toContain("is-mixed");
    await click(c);
    expect(onChange).toHaveBeenCalledWith(true);
    await r.unmount();
  });

  it("işaretliyken tıklama kaldırır", async () => {
    const onChange = vi.fn();
    const r = await render(<Checkbox checked onChange={onChange} label="Seç" />);
    expect(r.get("[role=checkbox]").getAttribute("aria-checked")).toBe("true");
    await click(r.get("[role=checkbox]"));
    expect(onChange).toHaveBeenCalledWith(false);
    await r.unmount();
  });
});

describe("Segmented", () => {
  it("oklarla seçim ve odak birlikte gider", async () => {
    const onChange = vi.fn();
    const r = await render(
      <Segmented<"a" | "b">
        value="a"
        options={[
          { value: "a", label: "Normal" },
          { value: "b", label: "Kalın" },
        ]}
        onChange={onChange}
        aria-label="Kalınlık"
      />,
    );
    const els = [...r.container.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    els[0]!.focus();
    await press("ArrowRight", { target: els[0]! });
    expect(onChange).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(els[1]);
    await r.unmount();
  });
});

describe("NumberStepper", () => {
  it("düğmeler ve oklar adım kadar değiştirir; sınırlar korunur; düğmelerin adı vardır", async () => {
    const onChange = vi.fn();
    const r = await render(<NumberStepper value={38} step={1} min={37} max={39} format={(v) => `${v} mm`} onChange={onChange} aria-label="Çap" />);
    const [dec, inc] = [...r.container.querySelectorAll("button")];
    expect(dec!.getAttribute("aria-label")).toBe("Azalt");
    expect(inc!.getAttribute("aria-label")).toBe("Artır");
    expect(r.get("[role=spinbutton]").getAttribute("aria-valuetext")).toBe("38 mm");
    await click(inc!);
    expect(onChange).toHaveBeenLastCalledWith(39);
    await press("ArrowDown", { target: r.get("[role=spinbutton]") });
    expect(onChange).toHaveBeenLastCalledWith(37);
    await r.unmount();
  });
});

describe("Field", () => {
  it("etiket denetime bağlanır; hata alert olur ve invalid metin alanına geçer", async () => {
    const r = await render(
      <Field label="Sipariş no" error="Yalnız rakam girin.">
        <TextField value="10x82" onChange={() => {}} />
      </Field>,
    );
    const input = r.get<HTMLInputElement>("input");
    expect(r.get("label").getAttribute("for")).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(r.get("[role=alert]").textContent).toBe("Yalnız rakam girin.");
    expect(input.getAttribute("aria-describedby")).toBe(r.get("[role=alert]").id);
    await r.unmount();
  });
});
