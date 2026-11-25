// @vitest-environment happy-dom
import { FEATURE_KEYS, FEATURES, type FeatureKey } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "../../lib/route.ts";
import { click, flush, mockFetch, render, type Rendered, waitFor } from "../../tezgah/test/render.tsx";
import AyarlarEkrani from "./index.tsx";

/** Yalnız yanıt şekli: bağımlılık kuralı sunucuda; PATCH yanıtı testte elle verilir. */
const effective = (off: readonly FeatureKey[]) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, !off.includes(k)])) as Record<FeatureKey, boolean>;
const view = (off: readonly FeatureKey[]) => ({ registry: Object.values(FEATURES), effective: effective(off), explicit: {} });
const SETUP = { status: "completed", step: 3, answers: { labelTypes: [] }, completedAt: "2026-11-01T00:00:00Z", skipped: false };

let calls: ReturnType<typeof mockFetch>["calls"];
let orgName: string;
beforeEach(() => {
  orgName = "Atölye";
  calls = mockFetch({
    "/api/languages": { languages: [] },
    "/api/features": (_u: string, init?: RequestInit) => {
      if (init?.method !== "PATCH") return view(["learn"]);
      const body = JSON.parse(String(init.body)) as Record<string, boolean>;
      // "Baskı" kapatılınca sunucu ona bağlı "Sticker sayfaları"nı da kapatır (yanıt bunu yazar).
      return body.print === false ? view(["print", "print.stickers"]) : view(Object.entries(body).filter(([, v]) => !v).map(([k]) => k as FeatureKey));
    },
    "/api/org": (_u: string, init?: RequestInit) => {
      if (init?.method === "PATCH") orgName = (JSON.parse(String(init.body)) as { name: string }).name;
      return { org: { id: "org-1", name: orgName }, setup: SETUP, features: view([]) };
    },
  }).calls;
});
afterEach(() => {
  document.body.innerHTML = "";
});

async function ac(section: string, go = vi.fn()): Promise<Rendered> {
  const r = await render(<AyarlarEkrani route={parseHash(`#/ayarlar/${section}`)} go={go} />);
  await flush(4);
  return r;
}

const switchOf = (name: string) => document.body.querySelector<HTMLButtonElement>(`[role=switch][aria-label="${name}"]`);
const toasts = () => [...document.body.querySelectorAll(".tz-toast-m")].map((x) => x.textContent);
const dugme = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

async function yaz(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Ayarlar: Özellikler", () => {
  it("kayıttaki özellikler gruplarıyla listelenir; her zaman açık olan kilitli, ücretli olan işaretli", async () => {
    const r = await ac("ozellikler");
    await waitFor(() => switchOf("Düzeltmelerden öğren"));
    expect(document.body.querySelectorAll("[role=switch]").length).toBe(FEATURE_KEYS.length);
    expect(switchOf("Üretim ve karşılaştırma")?.disabled).toBe(true);
    expect(switchOf("Düzeltmelerden öğren")?.getAttribute("aria-checked")).toBe("false");
    const headings = [...document.body.querySelectorAll(".tz-sec-h h3")].map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Üretim", "Görsel", "Baskı", "Tasarım dili", "Kurulum"]));
    const builder = switchOf("Tasarım dili oluşturma")?.closest("li");
    expect(builder?.textContent).toContain("Ücretli");
    await r.unmount();
  });

  it("açma ve kapama PATCH /api/features ile; bağlı özellik de değişince bildirim söyler", async () => {
    const r = await ac("ozellikler");
    await waitFor(() => switchOf("Düzeltmelerden öğren"));

    await click(switchOf("Düzeltmelerden öğren") as HTMLElement);
    await waitFor(() => calls.some((c) => c.method === "PATCH"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ learn: true });
    await waitFor(() => switchOf("Düzeltmelerden öğren")?.getAttribute("aria-checked") === "true");
    expect(toasts()).toContain("Kaydedildi.");

    await click(switchOf("Baskı masası, kesim işaretleri") as HTMLElement);
    await waitFor(() => switchOf("Sticker sayfaları")?.getAttribute("aria-checked") === "false");
    expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ print: false });
    expect(toasts()).toContain("Kaydedildi. Bağlı özellikler de değişti: Sticker sayfaları.");
    await r.unmount();
  });

  it("Kurulumu yeniden çalıştır Kurulum'u açar", async () => {
    const go = vi.fn();
    const r = await ac("ozellikler", go);
    await waitFor(() => dugme("Kurulumu yeniden çalıştır"));
    await click(dugme("Kurulumu yeniden çalıştır") as HTMLButtonElement);
    expect(go).toHaveBeenCalledWith("kurulum");
    await r.unmount();
  });
});

describe("Ayarlar: Firma", () => {
  it("ad değişir ve PATCH /api/org ile kaydedilir; boş ad kaydedilmez", async () => {
    const r = await ac("firma");
    const input = await waitFor(() => document.body.querySelector<HTMLInputElement>(".ay-form input"));
    expect(input.value).toBe("Atölye");
    const save = () => dugme("Kaydet") as HTMLButtonElement;
    // Değişiklik yokken kayıt kapalı.
    expect(save().disabled).toBe(true);

    await yaz(input, "   ");
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).toContain("Firma adı boş olamaz.");

    await yaz(input, "  GiftUpStore ");
    expect(save().disabled).toBe(false);
    await click(save());
    await waitFor(() => calls.some((c) => c.method === "PATCH"));
    expect(calls.find((c) => c.method === "PATCH" && c.url === "/api/org")?.body).toEqual({ name: "GiftUpStore" });
    await waitFor(() => toasts().includes("Kaydedildi."));
    expect(input.value).toBe("GiftUpStore");
    expect(save().disabled).toBe(true);
    await r.unmount();
  });

  it("80 karakterden uzun ad uyarı verir", async () => {
    const r = await ac("firma");
    const input = await waitFor(() => document.body.querySelector<HTMLInputElement>(".ay-form input"));
    await yaz(input, "x".repeat(81));
    expect(document.body.textContent).toContain("Firma adı en çok 80 karakter olabilir.");
    expect((dugme("Kaydet") as HTMLButtonElement).disabled).toBe(true);
    await r.unmount();
  });
});
