import { createSessionClient, currentLocale, ME_QUERY_KEY, type SessionClient } from "@sellerondata/shell";
import type { QueryClient } from "@tanstack/react-query";
import { bindPlatformTransport, onPlatformError } from "../lib/api.ts";
import { loginHref } from "../lib/platform.ts";
import { allowUnload, hasUnsavedChanges } from "../tezgah/katman/leaveGuard.ts";
import { createPlatformErrorHandler } from "./hatalar.ts";

/**
 * Platform kipinin oturum istemcisi (kabuktan; şablon `Platform/templates/tool-web/src/api/session.ts`): HttpOnly çerez,
 * yazmalarda `X-SOD-CSRF: 1`, firma biliniyorsa `X-SOD-Org`, `Accept-Language`, 401'de tek seferlik yenileme + tekrar.
 * Yenileme de reddedilirse kalınan yerle (karma dahil) Merkez girişine gidilir; kaydedilmemiş değişiklik varsa tarayıcı
 * sorar (Tezgâh gezinme bekçisinin `beforeunload` uyarısı).
 */
export function createTagpressSession(opts: { fetchImpl?: typeof fetch; onSessionLost?: () => void } = {}): SessionClient {
  return createSessionClient({
    getLocale: currentLocale,
    onSessionLost: opts.onSessionLost ?? (() => window.location.assign(loginHref())),
    fetchImpl: opts.fetchImpl,
  });
}

/** TagPress istemcisini (`lib/api.ts`) oturum istemcisine ve sayfa düzeyi hata tepkisine bağlar. Dönen işlev bağı çözer. */
export function bindSession(client: SessionClient, qc: QueryClient): () => void {
  bindPlatformTransport((url, init) => client.raw(url, init));
  onPlatformError(
    createPlatformErrorHandler({
      assign: (href) => window.location.assign(href),
      replace: (href) => window.location.replace(href),
      reload: () => {
        allowUnload();
        window.location.reload();
      },
      hasUnsavedChanges,
      refreshAccess: () => {
        void qc.invalidateQueries({ queryKey: ["org"] });
        void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      },
    }),
  );
  return () => {
    bindPlatformTransport(null);
    onPlatformError(null);
  };
}
