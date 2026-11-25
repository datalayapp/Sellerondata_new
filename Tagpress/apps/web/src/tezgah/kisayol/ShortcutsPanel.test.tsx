// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { press, render } from "../test/render.tsx";
import "./genel.ts";
import { defineCommands, setShortcutsOpen, useCommands } from "./kayit.ts";
import { groupCommands, ShortcutsPanel, shownScopes } from "./ShortcutsPanel.tsx";

/** `?` listesi: etkin kapsamların komutları gruplu; ekran kapsamı üstte, genel en altta; etkin olmayan ekran yok. */

defineCommands([
  { id: "baskiMasa.testPlanla", scope: "baskiMasa", keys: ["p"], group: "printDesk:shortcuts.groups.testDesk" },
  { id: "uretim.testGizli", scope: "uretim", keys: ["g"], group: "production:shortcuts.groups.testQueue" },
]);
for (const lng of ["tr", "en"]) {
  i18n.addResource(lng, "printDesk", "shortcuts.testPlanla", lng === "tr" ? "Planla" : "Plan");
  i18n.addResource(lng, "printDesk", "shortcuts.groups.testDesk", lng === "tr" ? "Masa" : "Desk");
  i18n.addResource(lng, "production", "shortcuts.testGizli", lng === "tr" ? "Gizli" : "Hidden");
  i18n.addResource(lng, "production", "shortcuts.groups.testQueue", lng === "tr" ? "Kuyruk" : "Queue");
}

afterEach(async () => {
  await act(async () => setShortcutsOpen(false));
  document.body.innerHTML = "";
});

/** Tuval kullanan ekran: yakınlaştırma denetiminin verdiği tuval işleyicileri; seçim işleyicisi isteğe bağlı. */
function Desk({ selection = false }: { selection?: boolean }) {
  useCommands("genel", { help: () => setShortcutsOpen(true) });
  useCommands("baskiMasa", { "baskiMasa.testPlanla": () => {} });
  useCommands("tuval", { "canvas.fit": () => {}, "canvas.zoomIn": () => {}, ...(selection ? { "canvas.selection": () => {} } : {}) });
  return null;
}

function Settings() {
  useCommands("genel", { help: () => setShortcutsOpen(true) });
  useCommands("ayarlar", {});
  return null;
}

describe("kısayol listesi", () => {
  it("kapsam yığını: ekran > tuval > genel; tuval kullanan ekranda tuval eklenir", () => {
    expect(shownScopes(["baskiMasa", "genel"])).toEqual(["baskiMasa", "tuval", "genel"]);
    expect(shownScopes(["ayarlar", "genel"])).toEqual(["ayarlar", "genel"]);
    expect(shownScopes(["duzelt", "tuval", "genel"])).toEqual(["duzelt", "tuval", "genel"]);
    expect(shownScopes([])).toEqual(["genel"]);
    const groups = groupCommands(["baskiMasa", "tuval", "genel"], undefined, new Set(["canvas.fit"])).map(([g]) => g);
    expect(groups[0]).toBe("printDesk:shortcuts.groups.testDesk");
    expect(groups).toContain("shortcuts:groups.canvas");
    expect(groups.at(-1)).toBe("shortcuts:groups.general");
  });

  it("? ile açılır; etkin ekranın, tuvalin ve genelin komutlarını gruplu gösterir, başka ekranınkini göstermez", async () => {
    const r = await render(
      <>
        <Desk />
        <ShortcutsPanel />
      </>,
    );
    await press("?", { shiftKey: true });
    const panel = r.get("dialog .tz-kp");
    const has = (id: string) => !!panel.querySelector(`[data-command="${id}"]`);
    expect(has("baskiMasa.testPlanla")).toBe(true);
    expect(has("canvas.fit")).toBe(true);
    expect(has("help")).toBe(true);
    expect(has("nav.production")).toBe(true);
    expect(has("uretim.testGizli")).toBe(false);
    const heads = [...panel.querySelectorAll("h3")].map((h) => h.textContent);
    expect(heads[0]).toBe("Masa");
    expect(heads).toContain("Tuval");
    const fit = panel.querySelector('[data-command="canvas.fit"]')!;
    expect(fit.querySelector("dt")?.textContent).toBe("Sığdır");
    expect([...fit.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Shift 1"]);
    const zoomIn = panel.querySelector('[data-command="canvas.zoomIn"]')!;
    expect(zoomIn.querySelectorAll("kbd").length).toBe(2);
    // seçim işleyicisi verilmedi: "Seçime yakınlaştır" yok; işleyicisi kayıtta olmayan "Kaydır" (passive) var
    expect(has("canvas.selection")).toBe(false);
    expect(has("canvas.pan")).toBe(true);
    // işleyici verilmeyen tuval komutu da yok
    expect(has("canvas.actual")).toBe(false);
    await r.unmount();
  });

  it("seçim işleyicisi verilince 'Seçime yakınlaştır' görünür", async () => {
    const r = await render(
      <>
        <Desk selection />
        <ShortcutsPanel />
      </>,
    );
    await act(async () => setShortcutsOpen(true));
    expect(r.get("dialog .tz-kp").querySelector('[data-command="canvas.selection"]')).not.toBeNull();
    await r.unmount();
  });

  it("tuval kullanmayan ekranda tuval komutları yok", async () => {
    const r = await render(
      <>
        <Settings />
        <ShortcutsPanel />
      </>,
    );
    await act(async () => setShortcutsOpen(true));
    const panel = r.get("dialog .tz-kp");
    expect(panel.querySelector('[data-command="canvas.fit"]')).toBeNull();
    expect(panel.querySelector('[data-command="help"]')).not.toBeNull();
    await press("Escape", { target: document.activeElement ?? document.body });
    expect(document.querySelector("dialog .tz-kp")).toBeNull();
    await r.unmount();
  });
});
