import type { ApiFailure } from "../lib/api.ts";
import { FIRMS_HREF, toolAccessHref } from "../lib/platform.ts";

/**
 * Platform kipinde sunucu hatasına sayfa düzeyinde tepki (plan §3 TP-WEB). Hata yine çağırana fırlar; ekran kendi
 * bildirimini gösterir (`serverText`, metin ortak sözlükten). Burada yalnız yer değişimi ve yetki tazelemesi:
 * - 401: oturum istemcisi bir kez yeniler ve yeniden dener; olmazsa `onSessionLost` girişe götürür (burada iş yok).
 * - 403 `NO_PRODUCT_ACCESS` (istemcinin sessiz yenilemesinden sonra da): Merkez'in "bu araçta erişimin yok" sayfası.
 * - 409 `ORG_CLOSED`: Hesabım › Firmalar.
 * - 409 `ORG_MISMATCH` (sunucu yazmayı reddetti, hiçbir şey değişmedi): sekme başka firmayı gösteriyor; kaydedilmemiş
 *   değişiklik yoksa sayfa yenilenir, varsa kabuğun oturum uyarısı (yenile / bu firmaya dön) kişiye bırakılır. Okumaları
 *   oturum istemcisi uyarı açıkken hiç göndermez; onlar burada tepki doğurmaz (`lib/api.ts`).
 * - 403 `FORBIDDEN` / `READ_ONLY`: izin ya da abonelik az önce değişmiş olabilir; firma yanıtı (`access`) ve kişi yeniden okunur.
 */
export interface PlatformErrorDeps {
  assign(href: string): void;
  replace(href: string): void;
  reload(): void;
  hasUnsavedChanges(): boolean;
  /** `["org"]` ve kabuğun `/me` sorgusunu bayatlatır. */
  refreshAccess(): void;
  now?(): number;
}

/** Aynı hata art arda gelse de yetki bu aralıkta en çok bir kez tazelenir. */
const REFRESH_GAP_MS = 5_000;

export function createPlatformErrorHandler(deps: PlatformErrorDeps): (f: ApiFailure) => void {
  let leaving = false;
  let lastRefresh = Number.NEGATIVE_INFINITY;
  const now = deps.now ?? Date.now;
  const leave = (go: () => void) => {
    if (leaving) return;
    leaving = true;
    go();
  };
  return (f) => {
    switch (f.body.code) {
      case "NO_PRODUCT_ACCESS":
        leave(() => deps.replace(toolAccessHref()));
        return;
      case "ORG_CLOSED":
        leave(() => deps.assign(FIRMS_HREF));
        return;
      case "ORG_MISMATCH":
        if (!deps.hasUnsavedChanges()) leave(() => deps.reload());
        return;
      case "FORBIDDEN":
      case "READ_ONLY": {
        const t = now();
        if (t - lastRefresh < REFRESH_GAP_MS) return;
        lastRefresh = t;
        deps.refreshAccess();
        return;
      }
      default:
        return;
    }
  };
}
