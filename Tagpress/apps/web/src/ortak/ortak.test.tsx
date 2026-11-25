// @vitest-environment happy-dom
import type { JobStatus } from "@tagpress/domain";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { click, mockFetch, press, render, waitFor } from "../tezgah/test/render.tsx";
import { ElleEkle } from "./ElleEkle.tsx";
import { JOB_TONE, JobStatusDot, TemplatePicker } from "./ortak.tsx";

/** React denetimli alanına değer yazar. */
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

function Picker({ onPick }: { onPick: (k: string | null) => void }) {
  const [v, setV] = useState<string | null>(null);
  return (
    <TemplatePicker
      languageId="tr"
      keys={["a15", "a20", "b7"]}
      suggestions={["b7"]}
      allowClear
      value={v}
      onChange={(k) => {
        setV(k);
        onPick(k);
      }}
      trigger={(p) => (
        <button type="button" {...p}>
          {v ?? "seç"}
        </button>
      )}
    />
  );
}

const options = () => [...document.body.querySelectorAll("[role=option]")];

describe("TemplatePicker", () => {
  it("arama listeyi daraltır, tıklama seçer ve kapatır", async () => {
    const onPick = vi.fn();
    const r = await render(<Picker onPick={onPick} />);
    await click(r.get("button"));
    const search = r.get<HTMLInputElement>("input[type=search]");
    expect(options().length).toBe(4); // şablonsuz, önerilen b7, a15, a20
    await typeInto(search, "a2");
    expect(options().map((o) => o.textContent)).toEqual(["a20"]);
    await click(options()[0]?.querySelector("button") as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("a20");
    expect(document.body.querySelector("[role=listbox]")).toBeNull();
    await r.unmount();
  });

  it("klavye: aşağı ok ile gez, Enter seç; öneriler üstte", async () => {
    const onPick = vi.fn();
    const r = await render(<Picker onPick={onPick} />);
    await click(r.get("button"));
    const search = r.get<HTMLInputElement>("input[type=search]");
    const titles = options().map((o) => o.textContent);
    expect(titles[0]).toBe("Şablonsuz bırak");
    expect(titles[1]).toBe("b7");
    await press("ArrowDown", { target: search });
    await press("Enter", { target: search });
    expect(onPick).toHaveBeenCalledWith("b7");
    await r.unmount();
  });

  it("şablonsuz bırak null döner; eşleşme yoksa boş metin", async () => {
    const onPick = vi.fn();
    const r = await render(<Picker onPick={onPick} />);
    await click(r.get("button"));
    await click(r.byText("Şablonsuz bırak") as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(null);
    await click(r.get("button"));
    await typeInto(r.get<HTMLInputElement>("input[type=search]"), "zzz");
    expect(document.body.textContent).toContain("eşleşen şablon yok");
    await r.unmount();
  });
});

describe("JobStatusDot", () => {
  const expected: Record<JobStatus, string> = { new: "idle", queued: "busy", generating: "busy", ready: "ready", failed: "error", approved: "ok" };

  it.each(Object.entries(expected))("%s durumu %s tonunu alır", async (status, tone) => {
    expect(JOB_TONE[status as JobStatus]).toBe(tone);
    const r = await render(<JobStatusDot status={status as JobStatus} />);
    expect(r.container.querySelector(`.tz-dot--${tone}`)).not.toBeNull();
    await r.unmount();
  });

  it("etiketli ve etiketsiz kullanımda ad var", async () => {
    const r = await render(
      <>
        <JobStatusDot status="ready" withLabel />
        <JobStatusDot status="failed" />
      </>,
    );
    expect(r.container.textContent).toContain("Hazır");
    expect(r.get('[aria-label="Üretilemedi"]')).toBeTruthy();
    await r.unmount();
  });
});

describe("ElleEkle", () => {
  it("alanları API'ye gönderir, onAdded çağrılır, pencere açık kalır", async () => {
    const { calls } = mockFetch({
      "/api/languages": { languages: [] },
      "/api/languages/tr/profile": { data: { output: { sizes: [{ id: "2.5", cm: 2.5, framePx: 300 }] } } },
      "/api/jobs/manual": { id: "j1", batchId: "b1", orderNo: "123" },
    });
    const onAdded = vi.fn();
    const r = await render(<ElleEkle open languageId="tr" onClose={() => {}} onAdded={onAdded} />);
    const add = () => r.byText("Ekle") as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    await typeInto(r.get<HTMLTextAreaElement>("textarea"), "Ayşe & Can");
    const inputs = [...document.body.querySelectorAll<HTMLInputElement>("input.tz-fi-in")];
    await typeInto(inputs[0] as HTMLInputElement, "123");
    await typeInto(inputs[1] as HTMLInputElement, "4");
    expect(add().disabled).toBe(false);
    await click(add());
    await waitFor(() => onAdded.mock.calls.length > 0);
    expect(onAdded).toHaveBeenCalledWith("j1");
    const post = calls.find((c) => c.url.includes("/api/jobs/manual"));
    expect(post?.method).toBe("POST");
    expect(post?.body).toMatchObject({ languageId: "tr", text: "Ayşe & Can", orderNo: "123", quantity: 4, templateKey: null, labelSize: null, generate: false });
    expect(r.get<HTMLTextAreaElement>("textarea").value).toBe("");
    await r.unmount();
  });

  it("yanıtta notQueued varsa bildirim nedeni söyler", async () => {
    mockFetch({
      "/api/languages": { languages: [] },
      "/api/jobs/manual": { id: "j1", batchId: "b1", orderNo: null, notQueued: { code: "ai-unavailable", message: "x" } },
    });
    const r = await render(<ElleEkle open languageId="tr" onClose={() => {}} onAdded={() => {}} />);
    await typeInto(r.get<HTMLTextAreaElement>("textarea"), "Ayşe");
    await click(r.byText("Ekle") as HTMLButtonElement);
    await waitFor(() => document.body.textContent?.includes("üretim başlamadı"));
    expect(document.body.textContent).toContain("Sipariş eklendi; üretim başlamadı: Yapay zekâ şu an kullanılamıyor");
    await r.unmount();
  });

  const validateWith = (severity: "error" | "warning", code = "text-missing", message = "Sunucu sorunu") => ({
    "/api/languages": { languages: [] },
    "/api/import/validate": { rows: [{ index: 0, issues: [{ code, severity, message, fixes: [] }] }] },
  });
  const generate = (r: { byText: (t: string) => HTMLElement | null }) => r.byText("Ekle ve üret") as HTMLButtonElement;

  it("anlık denetim: hata varken Ekle ve üret kapalı, sorun görünür", async () => {
    const { calls } = mockFetch(validateWith("error"));
    const r = await render(<ElleEkle open languageId="tr" onClose={() => {}} onAdded={() => {}} />);
    await typeInto(r.get<HTMLTextAreaElement>("textarea"), "Ayşe");
    await waitFor(() => document.body.querySelector(".tz-issue--error"));
    // Kod sözlükte var: sunucunun mesajı değil sözlük metni görünür.
    expect(document.body.textContent).toContain(i18n.t("issues:text-missing"));
    expect(document.body.textContent).not.toContain("Sunucu sorunu");
    expect(generate(r).disabled).toBe(true);
    expect((r.byText("Ekle") as HTMLButtonElement).disabled).toBe(false);
    const call = calls.find((c) => c.url.includes("/api/import/validate"));
    expect(call?.method).toBe("POST");
    expect(call?.body).toMatchObject({ languageId: "tr", rows: [{ text: "Ayşe", templateKey: null }] });
    await r.unmount();
  });

  it("uyarıda Ekle ve üret açık; Yok say uyarıyı gizler, geri getirilir", async () => {
    mockFetch(validateWith("warning"));
    const r = await render(<ElleEkle open languageId="tr" onClose={() => {}} onAdded={() => {}} />);
    await typeInto(r.get<HTMLTextAreaElement>("textarea"), "Ayşe");
    await waitFor(() => document.body.querySelector(".tz-issue--warn"));
    expect(generate(r).disabled).toBe(false);
    await click(r.byText(i18n.t("issues:fix.dismiss")) as HTMLElement);
    expect(document.body.textContent).toContain("1 uyarıyı geri getir");
    await r.unmount();
  });

  it("sözlükte olmayan kodda sunucunun metni görünür", async () => {
    mockFetch(validateWith("error", "kod-sozlukte-yok", "Sunucunun kendi metni"));
    const r = await render(<ElleEkle open languageId="tr" onClose={() => {}} onAdded={() => {}} />);
    await typeInto(r.get<HTMLTextAreaElement>("textarea"), "Ayşe");
    await waitFor(() => document.body.querySelector(".tz-issue--error"));
    expect(document.body.textContent).toContain("Sunucunun kendi metni");
    await r.unmount();
  });

  it("kapalıyken hiçbir şey çizmez", async () => {
    const r = await render(<ElleEkle open={false} languageId="tr" onClose={() => {}} onAdded={() => {}} />);
    expect(document.body.querySelector("dialog")).toBeNull();
    await r.unmount();
  });
});
