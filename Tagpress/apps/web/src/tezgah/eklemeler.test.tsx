// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTestLocale } from "../i18n/test.ts";
import { BandButton } from "./cerceve/cerceve.tsx";
import { Button, IconButton, Kbd } from "./dugme/Button.tsx";
import { EmptyState, IssueBox, StatusDot } from "./durum/durum.tsx";
import { Field, Segmented, Select, Switch } from "./form/form.tsx";
import { Dialog, useToast } from "./katman/Dialog.tsx";
import "./kisayol/genel.ts";
import { Rail } from "./yerlesim/yerlesim.tsx";
import { click, press, render, waitFor } from "./test/render.tsx";

/**
 * Temel katmana ekran ajanlarının istediği eklemeler: Kbd kayıt yazımı, BandButton ikon + yazı, düğmelerde gerçek
 * ipucu (pasif düğmede de), Select hatası ve Field etiket bağı, bilgi tonu, boş durum açıklaması, pencere açıkken
 * bildirim.
 */

afterEach(() => {
  setTestLocale("tr");
  document.body.innerHTML = "";
});

const tipText = () => document.querySelector(".tz-tip")?.textContent ?? null;

async function keyboardFocus(el: HTMLElement) {
  await press("Tab");
  await act(async () => el.focus());
}

describe("Kbd", () => {
  it("combo ve keys kayıt yazımını platforma göre gösterir; düz metin aynen kalır", async () => {
    const r = await render(
      <>
        <Kbd combo="mod+enter" />
        <Kbd keys="mod+shift+enter" />
        <Kbd keys="Enter" />
        <Kbd combo={["mod+=", "mod++"]} />
      </>,
    );
    expect([...r.container.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl Enter", "Ctrl Shift Enter", "Enter", "Ctrl = / Ctrl +"]);
    await r.unmount();
  });

  it("Mac'te ⌘", async () => {
    const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const r = await render(<Kbd combo="mod+enter" />);
    expect(r.container.querySelector("kbd")?.textContent).toBe("⌘ Enter");
    spy.mockRestore();
    await r.unmount();
  });
});

describe("BandButton", () => {
  it("quiet + icon varsayılan yalnız ikon; iconOnly={false} ikon ve yazı", async () => {
    const r = await render(
      <>
        <BandButton label="Kısayollar" icon="kbd" quiet onClick={() => {}} />
        <BandButton label="Yayınla" icon="send" quiet iconOnly={false} onClick={() => {}} />
      </>,
    );
    const [a, b] = [...r.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(a!.getAttribute("aria-label")).toBe("Kısayollar");
    expect(a!.textContent).toBe("");
    expect(b!.getAttribute("aria-label")).toBeNull();
    expect(b!.textContent).toBe("Yayınla");
    expect(b!.querySelector("svg")).not.toBeNull();
    await r.unmount();
  });
});

describe("düğmelerde gerçek ipucu", () => {
  it("Button (komutlu), IconButton, BandButton ve ray düğmesi klavye odağında ad + kısayol gösterir; title yok", async () => {
    const r = await render(
      <>
        <Button command="canvas.fit" id="b1" />
        <IconButton icon="trash" label="Sil" id="b2" />
        <BandButton label="Kısayollar" icon="kbd" command="help" quiet onClick={() => {}} />
        <Rail label="Araçlar" value="fit" onChange={() => {}} items={[{ id: "fit", icon: "fit", command: "canvas.fit" }]} />
      </>,
    );
    for (const b of r.container.querySelectorAll("button")) expect(b.getAttribute("title")).toBeNull();
    const [btn, ib, band, rail] = [...r.container.querySelectorAll<HTMLButtonElement>("button")];
    await keyboardFocus(btn!);
    await waitFor(() => tipText() === "SığdırShift 1");
    await keyboardFocus(ib!);
    await waitFor(() => tipText() === "Sil");
    // ad aria-label'da: açıklama olarak tekrar bağlanmaz
    expect(ib!.getAttribute("aria-describedby")).toBeNull();
    await keyboardFocus(band!);
    await waitFor(() => tipText() === "Kısayollar?");
    await keyboardFocus(rail!);
    await waitFor(() => tipText() === "SığdırShift 1");
    expect(rail!.getAttribute("aria-label")).toBe("Sığdır");
    expect(rail!.getAttribute("aria-keyshortcuts")).toBe("Shift+1");
    await r.unmount();
  });

  it("pasif düğmede de fareyle ipucu görünür (sarmalayıcı fareyi yakalar)", async () => {
    const r = await render(
      <Button command="canvas.fit" disabled>
        Sığdır
      </Button>,
    );
    const b = r.get<HTMLButtonElement>("button");
    expect(b.disabled).toBe(true);
    const host = b.parentElement!;
    expect(host.classList.contains("tz-tip-host")).toBe(true);
    expect(host.classList.contains("is-off")).toBe(true);
    await act(async () => {
      host.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" } as PointerEventInit));
    });
    await waitFor(() => tipText() === "SığdırShift 1", 2000);
    await r.unmount();
  });

  it("title verilen düğmede ipucu o metin (+ kısayol)", async () => {
    const r = await render(
      <Button command="canvas.fit" title="Sayfayı sığdır">
        x
      </Button>,
    );
    await keyboardFocus(r.get("button"));
    await waitFor(() => tipText() === "Sayfayı sığdırShift 1");
    await r.unmount();
  });
});

describe("form", () => {
  it("Select invalid; Field error Select'e de geçer", async () => {
    const r = await render(
      <Field label="Şablon" error="Şablon seçin">
        <Select value="a" options={[{ value: "a", label: "A" }]} onChange={() => {}} />
      </Field>,
    );
    const sel = r.get<HTMLSelectElement>("select");
    expect(sel.getAttribute("aria-invalid")).toBe("true");
    expect(sel.closest(".tz-fi")?.classList.contains("is-invalid")).toBe(true);
    expect(r.get("label").getAttribute("for")).toBe(sel.id);
    await r.unmount();
  });

  it("Field etiketi Switch ve Segmented'e aria-labelledby ile bağlanır", async () => {
    const r = await render(
      <>
        <Field label="Otomatik üret" hint="Yeni iş gelince">
          <Switch checked={false} onChange={() => {}} label="Otomatik üret" />
        </Field>
        <Field label="Görünüm">
          <Segmented value={"a" as string} options={[{ value: "a", label: "Büyük" }, { value: "b", label: "Liste" }]} onChange={() => {}} />
        </Field>
      </>,
    );
    const [l1, l2] = [...r.container.querySelectorAll("label")];
    const sw = r.get("[role=switch]");
    const seg = r.get("[role=radiogroup]");
    expect(sw.getAttribute("aria-labelledby")).toBe(l1!.id);
    expect(sw.getAttribute("aria-describedby")).toBeTruthy();
    expect(l1!.getAttribute("for")).toBe(sw.id);
    expect(seg.getAttribute("aria-labelledby")).toBe(l2!.id);
    expect(l2!.getAttribute("for")).toBeNull();
    await r.unmount();
  });
});

describe("durum", () => {
  it("bilgi tonu: IssueBox ve StatusDot; EmptyState açıklaması", async () => {
    const r = await render(
      <>
        <IssueBox tone="info">Bu şablon 2 dilde kullanılıyor.</IssueBox>
        <StatusDot tone="info" />
        <EmptyState icon="file" title="Henüz iş yok" body="Dosyayı buraya bırakın." />
      </>,
    );
    expect(r.get(".tz-issue--info").getAttribute("role")).toBe("note");
    expect(r.get(".tz-issue--info svg").getAttribute("data-icon")).toBe("info");
    expect(r.get(".tz-dot--info")).not.toBeNull();
    expect(r.get(".tz-dot-w--info").textContent).toBe("Bilgi");
    expect(r.get(".tz-empty-b").textContent).toBe("Dosyayı buraya bırakın.");
    await r.unmount();
  });
});

function ToastInDialog({ undo }: { undo: () => void }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <>
      <button type="button" id="open" onClick={() => setOpen(true)}>
        aç
      </button>
      {open && (
        <Dialog title="Pencere" onClose={() => setOpen(false)}>
          <button type="button" id="del" onClick={() => toast({ message: "Satır silindi", action: { label: "Geri al", run: undo } })}>
            sil
          </button>
        </Dialog>
      )}
    </>
  );
}

describe("pencere açıkken bildirim", () => {
  it("bildirim en üstteki açık pencerenin içinde; geri al çalışır; pencere kapanınca gövdeye döner", async () => {
    const undo = vi.fn();
    const r = await render(<ToastInDialog undo={undo} />);
    await click(r.get("#open"));
    await click(r.get("#del"));
    const toast = r.get(".tz-toast");
    expect(toast.closest("dialog")).toBe(r.get("dialog"));
    await click(r.byText("Geri al")!);
    expect(undo).toHaveBeenCalledTimes(1);
    await click(r.get("#del"));
    await press("Escape", { target: r.get("#del") });
    expect(document.querySelector("dialog")).toBeNull();
    const after = r.get(".tz-toast");
    expect(after.closest("dialog")).toBeNull();
    expect(after.closest(".tz-toasts")?.parentElement).toBe(document.body);
    await r.unmount();
  });
});

describe("portal temizliği", () => {
  it("kaldırılmadan bırakılan kök (düşen test) varken pencere açmak removeChild hatası vermez", async () => {
    // Önceki testin kökü unmount edilmeden kalmış ve gövde dışarıdan temizlenmiş gibi.
    await render(<div>eski</div>);
    document.body.innerHTML = "";
    const r = await render(
      <Dialog title="Pencere" onClose={() => {}}>
        <p>x</p>
      </Dialog>,
    );
    expect(document.querySelector("dialog")).not.toBeNull();
    await r.unmount();
  });
});
