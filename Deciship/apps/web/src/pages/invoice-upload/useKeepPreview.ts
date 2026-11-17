import { useEffect } from "react";
import { invoices } from "../../api/endpoints";
import { OPEN_PREVIEW_BEAT_MS, browserStorage, keepAliveDue, markClosed, markOpen, updateOpenPreviews } from "./resume";

const CHECK_MS = 60 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "wheel"] as const;

/**
 * Y95: açık önizlemede (adım 2–3) kullanıcı çalışıyorsa sunucuya ara ara "hâlâ çalışıyorum" denir; dosyası 24 saat dolunca
 * silinmez. Yalnız son tazelemeden beri sayfada bir şey yapıldıysa (`keepAliveDue`): açık bırakılıp dokunulmayan sekme
 * dosyayı canlı tutmaz. `fileId` null iken (önizleme yok, içe aktarıldı) hiçbir şey gitmez.
 */
export function useKeepPreview(fileId: string | null): void {
  useEffect(() => {
    if (!fileId) return;
    let lastActivity = 0;
    let lastKept = Date.now();
    const onActivity = () => {
      lastActivity = Date.now();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { capture: true, passive: true });
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (!keepAliveDue(lastActivity, lastKept, now)) return;
      lastKept = now;
      void invoices.keepPreview(fileId);
    }, CHECK_MS);
    return () => {
      window.clearInterval(timer);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true });
    };
  }, [fileId]);
}

/** Bu sekmenin kimliği (sekme başına bir; sayfa yenilenince yenisi). */
export const TAB_ID: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

/**
 * Çoklu sekme koruması: bu sekme önizlemede çalışırken dosya kimliği kalp atışıyla `localStorage`'a yazılır; başka
 * sekmenin sürdürme bandı onu göstermez (`visibleResumables`). Önizleme kapanınca ya da sekme kapanırken kayıt silinir;
 * sekme çökerse kayıt bir dakikada bayatlar. Depolama erişilemezse hiçbir şey yapılmaz.
 */
export function useOpenPreviewBeacon(fileId: string | null): void {
  useEffect(() => {
    if (!fileId) return;
    const storage = browserStorage();
    const beat = () => updateOpenPreviews(storage, (m) => markOpen(m, fileId, TAB_ID, Date.now()));
    const close = () => updateOpenPreviews(storage, (m) => markClosed(m, fileId, TAB_ID, Date.now()));
    beat();
    const timer = window.setInterval(beat, OPEN_PREVIEW_BEAT_MS);
    window.addEventListener("pagehide", close);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", close);
      close();
    };
  }, [fileId]);
}
