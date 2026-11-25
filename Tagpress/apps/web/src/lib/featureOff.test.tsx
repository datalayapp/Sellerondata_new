// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { serverText } from "../i18n/sunucu.ts";
import { Button, useToast } from "../tezgah/index.ts";
import { click, render, waitFor } from "../tezgah/test/render.tsx";
import { api } from "./api.ts";

/**
 * `409 feature-off`: her ekranda ortak. Ekran hatayı olağan biçimde bildirir (`toast({ message: serverText(e) })`);
 * bildirim "Aç" eylemini kendisi ekler. "Aç" özelliği açar (`PATCH /api/features`), ardından "Yeniden dene" aynı isteği
 * aynı gövdeyle bir kez daha gönderir (kendiliğinden göndermez).
 */
type Call = { url: string; method: string; body?: unknown };

function stub(state: { learnOn: boolean; calls: Call[] }) {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    state.calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/learn/run") {
      return state.learnOn ? json(200, { ok: true }) : json(409, { error: "Bu özellik kapalı. Ayarlar → Özellikler'den açabilirsiniz.", code: "feature-off", feature: "learn" });
    }
    if (url === "/api/features" && method === "PATCH") {
      state.learnOn = true;
      return json(200, { registry: [], effective: { learn: true }, explicit: {} });
    }
    return json(404, { error: "not found" });
  };
  globalThis.fetch = Object.assign(fn, { mocked: true }) as unknown as typeof fetch;
}

function Ekran() {
  const toast = useToast();
  return (
    <Button
      onClick={async () => {
        try {
          await api.post("/api/learn/run", { batch: "p1" });
        } catch (e) {
          toast({ message: serverText(e), tone: "error" });
        }
      }}
    >
      Run
    </Button>
  );
}

const toastButton = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>(".tz-toast-a")].find((b) => b.textContent === text);
const messages = () => [...document.body.querySelectorAll(".tz-toast-m")].map((m) => m.textContent);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("feature-off: Aç önerisi", () => {
  it("Aç özelliği açar; Yeniden dene isteği aynı gövdeyle tekrarlar", async () => {
    const state = { learnOn: false, calls: [] as Call[] };
    stub(state);
    const r = await render(<Ekran />);
    await click(r.get("button"));
    const ac = await waitFor(() => toastButton("Aç"));
    expect(messages()).toContain("Bu özellik kapalı. Ayarlar → Özellikler'den açabilirsiniz.");

    await click(ac);
    await waitFor(() => state.calls.some((c) => c.method === "PATCH"));
    expect(state.calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/features", body: { learn: true } });
    await waitFor(() => messages().includes("«Düzeltmelerden öğren» açıldı."));
    // İstek kendiliğinden tekrarlanmaz.
    expect(state.calls.filter((c) => c.url === "/api/learn/run").length).toBe(1);

    await click(toastButton("Yeniden dene") as HTMLButtonElement);
    await waitFor(() => messages().includes("İstek yeniden gönderildi."));
    const runs = state.calls.filter((c) => c.url === "/api/learn/run");
    expect(runs.length).toBe(2);
    expect(runs[1]).toMatchObject({ method: "POST", body: { batch: "p1" } });
    await r.unmount();
  });

  it("başka hatada Aç eklenmez", async () => {
    globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ error: "Bozuk istek.", code: "request-invalid" }), { status: 400 }), { mocked: true }) as unknown as typeof fetch;
    const r = await render(<Ekran />);
    await click(r.get("button"));
    await waitFor(() => messages().length > 0);
    expect(toastButton("Aç")).toBeUndefined();
    await r.unmount();
  });
});
