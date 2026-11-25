import "./tezgah/tokens.css";
import "./tezgah/tokens.generated.css";
import "./tezgah/base.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initI18n } from "./i18n/index.ts";
import { LanguageProvider } from "./lib/language.tsx";
import { ConfirmProvider, ToastProvider } from "./tezgah/katman/Dialog.tsx";
import { TezgahApp } from "./tezgah/rotalar.tsx";

/** Yerel kip (girişsiz, tek firma): bugünkü Tezgâh üst satırı, sunucu `/api`, kayıtlı dil (yoksa tarayıcı dili). */
export function startLocal(): void {
  initI18n();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
  });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <LanguageProvider>
              <TezgahApp />
            </LanguageProvider>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
