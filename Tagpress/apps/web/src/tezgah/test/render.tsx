import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setTestLocale } from "../../i18n/test.ts";
import { LanguageProvider } from "../../lib/language.tsx";
import { ConfirmProvider, ToastProvider } from "../katman/Dialog.tsx";

/**
 * Bileşen testi yardımcısı (happy-dom). Dosyanın başına `// @vitest-environment happy-dom` yazılır.
 *
 *   const r = await render(<Button command="help" />);           // sağlayıcılarla (sorgu, bildirim, onay, tasarım dili)
 *   r.container.querySelector("button");
 *   await press("?");                                             // pencerede tuş
 *   await click(r.get("button"));
 *   await r.unmount();
 *
 * `mockFetch({ "/api/languages": { languages: [] } })` sahte sunucu kurar (eşleşmeyen adres 404). EventSource
 * (sunucu olayları) `render` ile kendiliğinden sahtelenir. Dil TR; `setTestLocale("en")` ile değişir.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
}

export function stubEventSource() {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
}

type Handler = unknown | ((url: string, init?: RequestInit) => unknown);

/** Sahte `fetch`: adres (sorgusuz yol) → yanıt gövdesi ya da işlev. Çağrılar `calls` içinde. */
export function mockFetch(routes: Record<string, Handler> = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const p = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? url;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const h = routes[p];
    if (h === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const body = typeof h === "function" ? await (h as (u: string, i?: RequestInit) => unknown)(url, init) : h;
    return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : 200, headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = Object.assign(fn, { mocked: true }) as unknown as typeof fetch;
  return { calls };
}

export function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfirmProvider>
          <LanguageProvider>{children}</LanguageProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export interface Rendered {
  container: HTMLElement;
  root: Root;
  rerender(ui: ReactNode): Promise<void>;
  unmount(): Promise<void>;
  /** Seçiciyle tek öğe; yoksa hata. */
  get<T extends Element = HTMLElement>(selector: string): T;
  /** Görünen metne göre öğe (düğme, bağlantı...). */
  byText<T extends Element = HTMLElement>(text: string, selector?: string): T | null;
}

/** Bekleyen söz ve zamanlayıcıları boşaltır (tembel yükleme, sorgular). */
export async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Koşul sağlanana kadar bekler (tembel yüklenen ekran, sorgu); süre dolarsa hata. */
export async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("waitFor: süre doldu"); // i18n-ok: test hata iletisi
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

export async function render(ui: ReactNode, opts: { providers?: boolean } = {}): Promise<Rendered> {
  setTestLocale("tr");
  stubEventSource();
  if (!(globalThis.fetch as unknown as { mocked?: boolean } | undefined)?.mocked) mockFetch();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const wrap = (x: ReactNode) => (opts.providers === false ? x : <TestProviders>{x}</TestProviders>);
  await act(async () => {
    root.render(wrap(ui));
  });
  await flush();
  return {
    container,
    root,
    rerender: async (next) => {
      await act(async () => {
        root.render(wrap(next));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    get: <T extends Element = HTMLElement>(selector: string) => {
      const el = container.querySelector<T>(selector) ?? document.body.querySelector<T>(selector);
      if (!el) throw new Error(`Öğe yok: ${selector}`); // i18n-ok: test hata iletisi
      return el;
    },
    byText: <T extends Element = HTMLElement>(text: string, selector = "button, a, [role=tab], [role=menuitem]") =>
      ([...document.body.querySelectorAll<T>(selector)].find((el) => el.textContent?.trim() === text) as T | undefined) ?? null,
  };
}

/** Pencereye (ya da verilen öğeye) tuş basar. `key`: "?", "Escape", "a"; `code` rakamlarda kendiliğinden. */
export async function press(key: string, init: KeyboardEventInit & { target?: Element } = {}) {
  const { target, ...rest } = init;
  const code = /^[0-9]$/.test(key) ? `Digit${key}` : key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key === " " ? "Space" : key;
  const e = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...rest });
  await act(async () => {
    (target ?? document.body).dispatchEvent(e);
  });
  return e;
}

export async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}
