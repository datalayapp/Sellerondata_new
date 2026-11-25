// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { setTestLocale } from "../../i18n/test.ts";
import { Button, IconButton } from "../dugme/Button.tsx";
import { act } from "react";
import { click, press, render, waitFor } from "../test/render.tsx";
import "./genel.ts";
import { allCommands, ariaKeys, CANVAS_SCOPES, type Command, defineCommands, formatSpec, labelKey, matchSpec, type Scope, useCommands } from "./kayit.ts";

// Ekranların kısayol dosyaları (her ekran `src/ekranlar/<ekran>/kisayollar.ts`); içe aktarılınca kaydolur.
import.meta.glob("../../ekranlar/**/kisayollar.ts", { eager: true });

const SCREEN_SCOPES: Scope[] = ["uretim", "duzelt", "iceAktar", "baskiMasa", "baskiSablon", "tasarimDili", "sablonlar", "ayarlar", "kurulum"];

/** Aynı anda etkin kapsamlar: genel + ekran (+ tuval, tuval kullanan ekranda). */
const together = (s: Scope): Scope[] => ["genel", ...(CANVAS_SCOPES.includes(s) ? (["tuval"] as Scope[]) : []), s];

const key = (e: Partial<KeyboardEventInit> & { key: string }) => new KeyboardEvent("keydown", { code: /^[0-9]$/.test(e.key) ? `Digit${e.key}` : "", ...e });

afterEach(() => setTestLocale("tr"));

// Dağıtıcı denemesi için ekran komutları (adları yalnız bu testte sözlüğe eklenir). Gerçek ekran komutlarıyla
// çakışmasın diye kısayolu olmayan bir kapsamda ("ayarlar") ve sık rozetle.
defineCommands([
  { id: "ayarlar.testOnayla", scope: "ayarlar", keys: ["a"], group: "shortcuts:groups.general", badge: "frequent" },
  { id: "ayarlar.testKaydet", scope: "ayarlar", keys: ["mod+s"], group: "shortcuts:groups.general", inInput: true },
  { id: "ayarlar.testSerbest", scope: "ayarlar", keys: ["enter"], group: "shortcuts:groups.general" },
]);
for (const lng of ["tr", "en"]) {
  i18n.addResource(lng, "settings", "shortcuts.testOnayla", lng === "tr" ? "Onayla" : "Approve");
  i18n.addResource(lng, "settings", "shortcuts.testKaydet", lng === "tr" ? "Kaydet" : "Save");
  i18n.addResource(lng, "settings", "shortcuts.testSerbest", lng === "tr" ? "Aç" : "Open");
}

describe("kısayol kaydı", () => {
  const cmds = () => allCommands();

  it("aynı anda etkin kapsamlarda iki komut aynı tuşu taşımaz", () => {
    const clashes: string[] = [];
    for (const s of SCREEN_SCOPES) {
      const seen = new Map<string, Command>();
      for (const c of cmds().filter((x) => together(s).includes(x.scope))) {
        for (const k of c.keys) {
          const norm = k.toLowerCase().replace(/^ctrl\+/, "mod+");
          const prev = seen.get(norm);
          if (prev && prev.id !== c.id) clashes.push(`${s}: ${k} → ${prev.id} / ${c.id}`);
          seen.set(norm, c);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("her komutun TR ve EN adı var", () => {
    const missing: string[] = [];
    for (const c of cmds()) {
      for (const lng of ["tr", "en"]) if (!i18n.exists(labelKey(c), { lng, fallbackLng: false })) missing.push(`${lng} ${labelKey(c)}`);
      for (const lng of ["tr", "en"]) if (!i18n.exists(c.group, { lng, fallbackLng: false })) missing.push(`${lng} ${c.group}`);
    }
    expect(missing).toEqual([]);
  });

  it("bir ekranda en çok 1 birincil ve 4 sık rozet", () => {
    for (const s of [...SCREEN_SCOPES, "genel", "tuval"] as Scope[]) {
      const own = cmds().filter((c) => c.scope === s);
      expect(own.filter((c) => c.badge === "primary").length, s).toBeLessThanOrEqual(1);
      expect(own.filter((c) => c.badge === "frequent").length, s).toBeLessThanOrEqual(4);
    }
  });

  it("ekran komutunun kimliği kapsamla başlar", () => {
    expect(() => defineCommands([{ id: "onayla", scope: "uretim", keys: ["a"], group: "production:shortcuts.groups.x" }])).toThrow();
  });
});

describe("tuş adları", () => {
  it("ekranda Windows biçimi; boşluk dile göre", () => {
    expect(formatSpec("mod+s")).toBe("Ctrl S");
    expect(formatSpec("shift+n")).toBe("Shift N");
    expect(formatSpec("1-9")).toBe("1–9");
    expect(formatSpec("space")).toBe("Boşluk");
    setTestLocale("en");
    expect(formatSpec("space")).toBe("Space");
    expect(formatSpec("escape")).toBe("Esc");
  });

  it("aria-keyshortcuts biçimi", () => {
    expect(ariaKeys(["mod+s"])).toBe("Control+S");
    expect(ariaKeys(["1-3"])).toBe("1 2 3");
    expect(ariaKeys(["shift+0", "space"])).toBe("Shift+0 Space");
  });

  it("eşleşme: değiştirici tuşlar birebir, simge tuşunda Shift yok sayılır", () => {
    expect(matchSpec("mod+s", key({ key: "s", ctrlKey: true }))).toBe(true);
    expect(matchSpec("mod+s", key({ key: "s" }))).toBe(false);
    expect(matchSpec("s", key({ key: "s", ctrlKey: true }))).toBe(false);
    expect(matchSpec("shift+n", key({ key: "N", shiftKey: true }))).toBe(true);
    expect(matchSpec("n", key({ key: "N", shiftKey: true }))).toBe(false);
    expect(matchSpec("?", key({ key: "?", shiftKey: true }))).toBe(true);
    expect(matchSpec("1-9", key({ key: "5" }))).toBe(true);
    expect(matchSpec("1-9", key({ key: "0" }))).toBe(false);
    expect(matchSpec("alt+1", key({ key: "1", altKey: true }))).toBe(true);
    expect(matchSpec("shift+1", key({ key: "!", code: "Digit1", shiftKey: true }))).toBe(true);
    expect(matchSpec("space", key({ key: " " }))).toBe(true);
  });
});



function Ekran({ on, modal, release }: { on: (id: string) => void; modal?: boolean; release?: () => boolean }) {
  useCommands("ayarlar", {
    "ayarlar.testSerbest": () => {
      on("serbest");
      return release?.() ? false : undefined;
    }, "ayarlar.testOnayla": () => on("onayla"), "ayarlar.testKaydet": () => on("kaydet") });
  useCommands("genel", { help: () => on("genel-yardim") });
  useCommands("ayarlar", { "ayarlar.testOnayla": () => on("modal-onayla") }, { enabled: !!modal, modal: true });
  return (
    <div>
      <input aria-label="alan" />
      <Button command="ayarlar.testOnayla" variant="primary" />
      <IconButton icon="check" command="ayarlar.testKaydet" />
    </div>
  );
}

describe("dağıtıcı", () => {
  it("komut çalışır; yazı alanında yalnız inInput işaretliler", async () => {
    const log: string[] = [];
    const r = await render(<Ekran on={(x) => log.push(x)} />);
    await press("a");
    await press("?", { shiftKey: true });
    const input = r.get<HTMLInputElement>("input");
    input.focus();
    await press("a", { target: input });
    await press("s", { target: input, ctrlKey: true });
    expect(log).toEqual(["onayla", "genel-yardim", "kaydet"]);
    await r.unmount();
  });

  it("alt kip (modal) açıkken yalnız o çalışır", async () => {
    const log: string[] = [];
    const r = await render(<Ekran modal on={(x) => log.push(x)} />);
    await press("a");
    await press("?", { shiftKey: true });
    expect(log).toEqual(["modal-onayla"]);
    await r.unmount();
  });

  it("işleyici false dönerse olay serbest kalır (preventDefault yok); dönüş yoksa engellenir", async () => {
    const log: string[] = [];
    let free = true;
    const r = await render(<Ekran on={(x) => log.push(x)} release={() => free} />);
    const btn = r.get<HTMLButtonElement>(".tz-btn--primary");
    btn.focus();
    const e1 = await press("Enter", { target: btn });
    expect(log).toEqual(["serbest"]);
    expect(e1.defaultPrevented).toBe(false);
    free = false;
    const e2 = await press("Enter", { target: btn });
    expect(log).toEqual(["serbest", "serbest"]);
    expect(e2.defaultPrevented).toBe(true);
    const e3 = await press("a");
    expect(e3.defaultPrevented).toBe(true);
    await r.unmount();
  });

  it("düğme adı, ipucu, rozet ve aria-keyshortcuts kayıttan", async () => {
    const log: string[] = [];
    const r = await render(<Ekran on={(x) => log.push(x)} />);
    const b = r.get<HTMLButtonElement>(".tz-btn--primary");
    expect(b.textContent).toContain("Onayla");
    // ipucu tarayıcının title'ı değil: klavye odağında gerçek ipucu
    expect(b.getAttribute("title")).toBeNull();
    await press("Tab");
    await act(async () => b.focus());
    const tip = await waitFor(() => document.querySelector(".tz-tip"));
    expect(tip.textContent).toBe("OnaylaA");
    expect(b.getAttribute("aria-keyshortcuts")).toBe("A");
    expect(b.querySelector("kbd")?.textContent).toBe("A");
    const ib = r.get<HTMLButtonElement>(".tz-ib");
    expect(ib.getAttribute("aria-label")).toBe("Kaydet");
    expect(ib.querySelector("kbd")).toBeNull();
    await click(b);
    await r.unmount();
  });
});
