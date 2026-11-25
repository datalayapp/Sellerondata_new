// Kabuğun belirteçleri → TagPress (Tezgâh) belirteçleri → kabuk stilleri → Tezgâh temel stilleri. Kabuğun
// `primitives.css`'i yüklenmez: genel sıfırlamaları (button, a, h1) Tezgâh'ın kendi temel stilleriyle çakışır.
import "@sellerondata/shell/tokens.css";
import "../tezgah/tokens.generated.css";
import "@sellerondata/shell/shell.css";
import "../tezgah/base.css";
import "../tezgah/cerceve/kabuk.css";
// Yüksek karşıtlık kuralları en sonda: araç ve sayfa kenarlıklarının üstüne yazabilsin.
import "@sellerondata/shell/a11y.css";
import { initShellI18n, SessionProvider } from "@sellerondata/shell";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { resources } from "../i18n/index.ts";
import { ConfirmProvider, ToastProvider } from "../tezgah/katman/Dialog.tsx";
import { TezgahApp } from "../tezgah/rotalar.tsx";
import { bindSession, createTagpressSession } from "./istemci.ts";
import { PlatformKabuk } from "./Kabuk.tsx";

const statusOf = (e: unknown) => (e as { status?: unknown } | null)?.status;

/** Platform kipinin sorgu istemcisi: 4xx yeniden denenmez (sonuç değişmez; oturum yenilemesi istemcinin işi). */
export function createPlatformQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, e) => {
          const s = statusOf(e);
          if (typeof s === "number" && s >= 400 && s < 500) return false;
          return count < 1;
        },
      },
    },
  });
}

/**
 * Platform kipinin girişi (`main.tsx`, `VITE_TAGPRESS_PLATFORM=1`). Dil: kişinin hesaptaki tercihi → `sod_lang` çerezi →
 * tarayıcı dili → İngilizce (kabuğun `initShellI18n`'i; Tezgâh sözlükleri aynı kaynaklardan).
 */
export function startPlatform(): void {
  initShellI18n({ resources, defaultNS: "common" });
  const queryClient = createPlatformQueryClient();
  const session = createTagpressSession();
  bindSession(session, queryClient);
  // Eşzamanlı çizim: ilk kare kabukla gelir (araçlar arası geçişte boş bant çizilmez).
  flushSync(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <SessionProvider client={session}>
            <ToastProvider>
              <ConfirmProvider>
                <PlatformKabuk>
                  <TezgahApp />
                </PlatformKabuk>
              </ConfirmProvider>
            </ToastProvider>
          </SessionProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
  });
}
