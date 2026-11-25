// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import "../../i18n/test.ts";
import "../kisayol/genel.ts";
import { defineCommands } from "../kisayol/kayit.ts";
import { click, render } from "../test/render.tsx";
import { Button, IconButton, Kbd } from "./Button.tsx";

// Deneme komutu: adı yalnız bu testte sözlüğe eklenir.
defineCommands([{ id: "uretim.dugmeOnayla", scope: "uretim", keys: ["2"], group: "shortcuts:groups.general", badge: "primary" }]);
for (const lng of ["tr", "en"]) i18n.addResource(lng, "production", "shortcuts.dugmeOnayla", lng === "tr" ? "Onayla" : "Approve");

describe("Button", () => {
  it("command verilince ad, ipucu, rozet ve aria-keyshortcuts kayıttan gelir", async () => {
    const r = await render(<Button variant="primary" command="uretim.dugmeOnayla" />);
    const b = r.get<HTMLButtonElement>("button");
    expect(b.textContent).toContain("Onayla");
    expect(b.getAttribute("title")).toBeNull(); // ipucu Tooltip'te (eklemeler.test.tsx)
    expect(b.getAttribute("aria-keyshortcuts")).toBe("2");
    expect(b.querySelector("kbd")?.textContent).toBe("2");
    expect(b.querySelector("kbd")?.className).toContain("tz-kbd--primary");
    await r.unmount();
  });

  it("kbd={false} rozeti gizler; çocuk verilirse ad çocuktan gelir", async () => {
    const r = await render(
      <Button command="uretim.dugmeOnayla" kbd={false}>
        Hepsini onayla
      </Button>,
    );
    const b = r.get<HTMLButtonElement>("button");
    expect(b.textContent).toBe("Hepsini onayla");
    expect(b.querySelector("kbd")).toBeNull();
    await r.unmount();
  });

  it("loading: devre dışı, aria-busy, tıklama çalışmaz", async () => {
    let n = 0;
    const r = await render(
      <Button loading onClick={() => n++}>
        Üretiliyor
      </Button>,
    );
    const b = r.get<HTMLButtonElement>("button");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    await click(b);
    expect(n).toBe(0);
    await r.unmount();
  });

  it("4 değişken ve 4 boy ilgili sınıfı taşır", async () => {
    const r = await render(
      <>
        {(["primary", "secondary", "quiet", "danger"] as const).map((v) =>
          (["mini", "tool", "page", "guided"] as const).map((s) => (
            <Button key={`${v}${s}`} variant={v} size={s}>
              x
            </Button>
          )),
        )}
      </>,
    );
    expect(r.container.querySelectorAll(".tz-btn--primary.tz-btn--guided")).toHaveLength(1);
    expect(r.container.querySelectorAll(".tz-btn--danger")).toHaveLength(4);
    expect(r.container.querySelectorAll(".tz-btn--mini")).toHaveLength(4);
    await r.unmount();
  });
});

describe("IconButton", () => {
  it("label ile ya da command ile erişilebilir ad alır", async () => {
    const r = await render(
      <>
        <IconButton icon="trash" label="Sil" />
        <IconButton icon="fit" command="canvas.fit" size={28} />
        <IconButton icon="dots" label="Diğer işlemler" size={26} pressed />
      </>,
    );
    const btns = [...r.container.querySelectorAll("button")];
    expect(btns[0]!.getAttribute("aria-label")).toBe("Sil");
    expect(btns[1]!.getAttribute("aria-label")).toBeTruthy();
    expect(btns[2]!.getAttribute("aria-label")).toBe("Diğer işlemler");
    expect(r.container.querySelectorAll(".tz-ib--26, .tz-ib--28, .tz-ib--32")).toHaveLength(3);
    expect(btns[2]!.getAttribute("aria-pressed")).toBe("true");
    await r.unmount();
  });
});

describe("Kbd", () => {
  it("keys metni basar ve ekran okuyucudan gizlenir; metin yoksa hiçbir şey çizmez", async () => {
    const r = await render(
      <>
        <Kbd keys="Enter" on="band" />
        <Kbd />
      </>,
    );
    const k = r.container.querySelectorAll("kbd");
    expect(k).toHaveLength(1);
    expect(k[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(k[0]!.className).toContain("tz-kbd--band");
    await r.unmount();
  });
});
