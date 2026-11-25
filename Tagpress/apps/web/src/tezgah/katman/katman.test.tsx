// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../kisayol/genel.ts";
import { defineCommands, useCommands } from "../kisayol/kayit.ts";
import { click, press, render, waitFor } from "../test/render.tsx";
import { Dialog, useConfirm, useToast } from "./Dialog.tsx";
import { placePanel } from "./ortak.ts";
import { Menu, Popover, Tooltip } from "./Popover.tsx";

/**
 * Katmanlar: pencerede Esc ve odağın tetikleyiciye dönmesi, odak tuzağı, sarı onay şeridi, işlem sürerken kapanmama;
 * pencere içindeki açılır panelin pencerenin içine konması (üst katman); menüde oklar ve seçim; bildirimde geri al;
 * ipucunun klavye odağında açılması; konumlama.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const active = () => document.activeElement as HTMLElement | null;
const escape = () => press("Escape", { target: active() ?? document.body });

function Opener({ dirty = false, busy = false, withMenu = false, onClose }: { dirty?: boolean; busy?: boolean; withMenu?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="opener" onClick={() => setOpen(true)}>
        aç
      </button>
      {open && (
        <Dialog
          title="Pencere"
          dirty={dirty}
          busy={busy}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
          footer={<button type="button" id="save">kaydet</button>}
        >
          <input id="first" aria-label="ad" />
          {withMenu && (
            <Menu
              align="start"
              trigger={(p) => (
                <button type="button" id="menu-trigger" {...p}>
                  şablon
                </button>
              )}
              items={[
                { label: "A15", onSelect: () => {} },
                { label: "B20", onSelect: () => {} },
              ]}
            />
          )}
        </Dialog>
      )}
    </>
  );
}

async function openDialog(ui = <Opener />) {
  const r = await render(ui);
  const b = r.get<HTMLButtonElement>("#opener");
  b.focus();
  await click(b);
  return r;
}

describe("pencere", () => {
  it("açılınca odak gövdedeki ilk öğede; Esc kapatır ve odak açan düğmeye döner", async () => {
    const closed = vi.fn();
    const r = await openDialog(<Opener onClose={closed} />);
    expect(document.querySelector("dialog.tz-dlg")).not.toBeNull();
    expect(active()?.id).toBe("first");
    await escape();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelector("dialog.tz-dlg")).toBeNull();
    expect(active()?.id).toBe("opener");
    await r.unmount();
  });

  it("odak tuzağı: son öğeden Tab ilk öğeye, ilk öğeden Shift Tab son öğeye", async () => {
    const r = await openDialog();
    const dlg = r.get<HTMLDialogElement>("dialog");
    const close = dlg.querySelector<HTMLButtonElement>(".tz-dlg-h button")!;
    const save = r.get<HTMLButtonElement>("#save");
    save.focus();
    await press("Tab", { target: save });
    expect(active()).toBe(close);
    await press("Tab", { target: close, shiftKey: true });
    expect(active()).toBe(save);
    await r.unmount();
  });

  it("değişiklik varken Esc sarı onay şeridini açar; ikinci Esc düzenlemeye döner; 'Sil ve kapat' kapatır", async () => {
    const closed = vi.fn();
    const r = await openDialog(<Opener dirty onClose={closed} />);
    await escape();
    expect(closed).not.toHaveBeenCalled();
    const strip = r.get(".tz-dlg-f--ask");
    expect(strip.textContent).toContain("Değişiklikler kaydedilmedi");
    expect(active()?.textContent).toBe("Düzenlemeye dön");
    await escape();
    expect(document.querySelector(".tz-dlg-f--ask")).toBeNull();
    expect(document.querySelector("dialog")).not.toBeNull();
    await escape();
    await click(r.byText("Sil ve kapat")!);
    expect(closed).toHaveBeenCalledTimes(1);
    await r.unmount();
  });

  it("işlem sürerken Esc ve X kapatmaz", async () => {
    const closed = vi.fn();
    const r = await openDialog(<Opener busy onClose={closed} />);
    await escape();
    const x = r.get<HTMLButtonElement>(".tz-dlg-h button");
    expect(x.disabled).toBe(true);
    expect(x.getAttribute("aria-label")).toBe("İşlem sürüyor");
    expect(closed).not.toHaveBeenCalled();
    expect(r.get("dialog").getAttribute("aria-busy")).toBe("true");
    await r.unmount();
  });

  it("pencere içindeki menü pencerenin içine açılır; Esc önce menüyü, sonra pencereyi kapatır", async () => {
    const r = await openDialog(<Opener withMenu />);
    const trig = r.get<HTMLButtonElement>("#menu-trigger");
    trig.focus();
    await click(trig);
    const pop = r.get(".tz-pop");
    expect(pop.closest("dialog")).toBe(r.get("dialog"));
    expect(active()?.textContent).toContain("A15");
    // odak tuzağı açık paneli de kapsar
    const dlg = r.get<HTMLDialogElement>("dialog");
    expect([...dlg.querySelectorAll("[role=menuitem]")].length).toBe(2);
    await escape();
    expect(document.querySelector(".tz-pop")).toBeNull();
    expect(document.querySelector("dialog")).not.toBeNull();
    expect(active()?.id).toBe("menu-trigger");
    await escape();
    expect(document.querySelector("dialog")).toBeNull();
    expect(active()?.id).toBe("opener");
    await r.unmount();
  });
});

defineCommands([{ id: "uretim.katmanDeneme", scope: "uretim", keys: ["a"], group: "shortcuts:groups.general" }]);

function MenuScreen({ log }: { log: string[] }) {
  useCommands("uretim", { "uretim.katmanDeneme": () => log.push("kisayol") });
  return (
    <Menu
      trigger={(p) => (
        <button type="button" id="more" {...p}>
          diğer
        </button>
      )}
      items={[
        { label: "Çoğalt", icon: "copy", onSelect: () => log.push("cogalt") },
        { label: "Kapalı", disabled: true, onSelect: () => log.push("kapali") },
        "sep",
        { label: "Sığdır", command: "canvas.fit", onSelect: () => log.push("sigdir") },
        { label: "Sil", danger: true, onSelect: () => log.push("sil") },
      ]}
    />
  );
}

describe("menü", () => {
  it("oklar, Home/End devre dışı öğeyi atlar; seçim çalışır, menü kapanır, odak tetikleyiciye döner", async () => {
    const log: string[] = [];
    const r = await render(<MenuScreen log={log} />);
    const t = r.get<HTMLButtonElement>("#more");
    expect(t.getAttribute("aria-haspopup")).toBe("menu");
    t.focus();
    await click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(r.get("[role=menu]")).not.toBeNull();
    expect(active()?.textContent).toContain("Çoğalt");
    await press("ArrowDown", { target: active()! });
    expect(active()?.textContent).toContain("Sığdır");
    expect(active()?.querySelector(".tz-menu-k")?.textContent).toBe("Shift 1");
    expect(active()?.getAttribute("aria-keyshortcuts")).toBe("Shift+1");
    await press("ArrowDown", { target: active()! });
    expect(active()?.textContent).toContain("Sil");
    await press("ArrowDown", { target: active()! });
    expect(active()?.textContent).toContain("Çoğalt");
    await press("ArrowUp", { target: active()! });
    expect(active()?.textContent).toContain("Sil");
    await press("Home", { target: active()! });
    expect(active()?.textContent).toContain("Çoğalt");
    await press("End", { target: active()! });
    await click(active()!);
    expect(log).toEqual(["sil"]);
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(active()).toBe(t);
    await r.unmount();
  });

  it("menü açıkken ekran kısayolları çalışmaz; kapanınca çalışır", async () => {
    const log: string[] = [];
    const r = await render(<MenuScreen log={log} />);
    const t = r.get<HTMLButtonElement>("#more");
    await click(t);
    await press("a", { target: active()! });
    expect(log).toEqual([]);
    await escape();
    await press("a");
    expect(log).toEqual(["kisayol"]);
    await r.unmount();
  });

  it("dışarı tıklamak kapatır (odak tıklanan yerde kalır)", async () => {
    const r = await render(
      <>
        <MenuScreen log={[]} />
        <button type="button" id="other">
          başka
        </button>
      </>,
    );
    await click(r.get("#more"));
    expect(document.querySelector(".tz-pop")).not.toBeNull();
    const other = r.get<HTMLButtonElement>("#other");
    await act(async () => {
      other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      other.focus();
    });
    expect(document.querySelector(".tz-pop")).toBeNull();
    expect(active()).toBe(other);
    await r.unmount();
  });
});

describe("açılır kutu", () => {
  it("açılınca odak içindeki ilk alana; son öğeden Tab kapatır ve odağı tetikleyiciye verir", async () => {
    const r = await render(
      <Popover
        trigger={(p) => (
          <button type="button" id="pt" {...p}>
            ad
          </button>
        )}
      >
        {(close) => (
          <div>
            <input id="pi" aria-label="ad" />
            <button type="button" id="pb" onClick={close}>
              kaydet
            </button>
          </div>
        )}
      </Popover>,
    );
    await click(r.get("#pt"));
    expect(r.get(".tz-pop").getAttribute("role")).toBe("dialog");
    expect(r.get(".tz-pop").parentElement).toBe(document.body);
    expect(active()?.id).toBe("pi");
    const pb = r.get<HTMLButtonElement>("#pb");
    pb.focus();
    await press("Tab", { target: pb });
    expect(document.querySelector(".tz-pop")).toBeNull();
    expect(active()?.id).toBe("pt");
    await r.unmount();
  });

  it("konum: altta yer yoksa üste çevrilir; pencere kenarına taşmaz; sona hizalanır", () => {
    const vp = { width: 1000, height: 700 };
    const panel = { width: 240, height: 200 };
    const low = placePanel({ left: 100, top: 600, width: 80, height: 30 }, panel, vp);
    expect(low.side).toBe("top");
    expect(low.top).toBe(600 - 4 - 200);
    const high = placePanel({ left: 100, top: 50, width: 80, height: 30 }, panel, vp);
    expect(high.side).toBe("bottom");
    expect(high.top).toBe(84);
    const right = placePanel({ left: 900, top: 50, width: 80, height: 30 }, panel, vp);
    expect(right.left).toBe(1000 - 240 - 8);
    const end = placePanel({ left: 500, top: 50, width: 80, height: 30 }, panel, vp, { align: "end" });
    expect(end.left).toBe(580 - 240);
    const tooTall = placePanel({ left: 0, top: 300, width: 80, height: 30 }, { width: 240, height: 900 }, vp);
    expect(tooTall.maxHeight).toBe(Math.max(700 - 330 - 12, 300 - 12));
  });
});

function ToastScreen({ undo }: { undo: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [answer, setAnswer] = useState<string>("");
  return (
    <>
      <button type="button" id="t1" onClick={() => toast({ message: "Etiket silindi", action: { label: "Geri al", run: undo } })}>
        sil
      </button>
      <button type="button" id="t2" onClick={() => toast({ message: "Olmadı", tone: "error", duration: 30 })}>
        hata
      </button>
      <button type="button" id="c1" onClick={async () => setAnswer(String(await confirm({ title: "Silinsin mi?", tone: "danger", confirmLabel: "Sil" })))}>
        onay
      </button>
      <output id="answer">{answer}</output>
    </>
  );
}

describe("bildirim ve onay", () => {
  it("geri al: eylem çalışır, bildirim kapanır; bildirim kibar canlı bölgede", async () => {
    const undo = vi.fn();
    const r = await render(<ToastScreen undo={undo} />);
    await click(r.get("#t1"));
    const toast = r.get(".tz-toast");
    expect(toast.textContent).toContain("Etiket silindi");
    expect(toast.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    await click(r.byText("Geri al")!);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".tz-toast")).toBeNull();
    await r.unmount();
  });

  it("hata kesintili canlı bölgede; süre dolunca kapanır", async () => {
    const r = await render(<ToastScreen undo={() => {}} />);
    await click(r.get("#t2"));
    expect(r.get(".tz-toast").closest("[aria-live]")?.getAttribute("aria-live")).toBe("assertive");
    await waitFor(() => !document.querySelector(".tz-toast"), 2000);
    await r.unmount();
  });

  it("tehlikeli onayda odak Vazgeç'te; onay true, Esc false döner", async () => {
    const r = await render(<ToastScreen undo={() => {}} />);
    await click(r.get("#c1"));
    expect(active()?.textContent).toBe("Vazgeç");
    await click(r.byText("Sil")!);
    await waitFor(() => r.get("#answer").textContent === "true");
    await click(r.get("#c1"));
    await escape();
    await waitFor(() => r.get("#answer").textContent === "false");
    await r.unmount();
  });
});

describe("ipucu", () => {
  it("klavye odağında ad ve kısayolla açılır; title bastırılır; Esc kapatır", async () => {
    const r = await render(
      <Tooltip command="canvas.fit">
        <button type="button" id="tip" title="Sığdır · Shift 1">
          s
        </button>
      </Tooltip>,
    );
    const b = r.get<HTMLButtonElement>("#tip");
    expect(b.getAttribute("title")).toBeNull();
    await press("Tab");
    await act(async () => b.focus());
    const tip = await waitFor(() => document.querySelector(".tz-tip"));
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toContain("Sığdır");
    expect(tip.querySelector("kbd")?.textContent).toBe("Shift 1");
    expect(b.getAttribute("aria-keyshortcuts")).toBe("Shift+1");
    await press("Escape", { target: b });
    expect(document.querySelector(".tz-tip")).toBeNull();
    await r.unmount();
  });

  it("fareyle gelen odakta açılmaz; içerik verilirse açıklama olarak bağlanır", async () => {
    const r = await render(
      <Tooltip content="Kesim çizgisini göster">
        <button type="button" id="tip2" aria-label="Kesim">
          k
        </button>
      </Tooltip>,
    );
    const b = r.get<HTMLButtonElement>("#tip2");
    await act(async () => {
      b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      b.focus();
    });
    await new Promise((res) => setTimeout(res, 250));
    expect(document.querySelector(".tz-tip")).toBeNull();
    await act(async () => b.blur());
    await press("Tab");
    await act(async () => b.focus());
    const tip = await waitFor(() => document.querySelector(".tz-tip"));
    expect(b.getAttribute("aria-describedby")).toBe(tip.id);
    await r.unmount();
  });
});
