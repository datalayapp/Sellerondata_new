import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { invoices } from "../../api/endpoints";
import type { ResumablePreview } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/ui";
import { OPEN_PREVIEW_BEAT_MS, OPEN_PREVIEW_KEY, browserStorage, openElsewhere, readOpenPreviews, visibleResumables } from "./resume";
import { TAB_ID } from "./useKeepPreview";

export const RESUMABLE_KEY = ["invoice-preview-resumable"] as const;

/**
 * Y80-E2: sürdürme bandı. Kişinin sayfadan çıktıktan sonra okuması biten (ya da hâlâ süren) PDF'i üstte tek satırda:
 * "Okunan PDF hazır: dosya.pdf · Devam et". Mevcut bilgi bandı deseni (`notif info`, `BulkBand`); en yenisi gösterilir.
 * "Kaldır" önizlemeden vazgeçer (dosya sunucuda silinir; okuma ücreti önbellekte kalır, aynı dosya yeniden seçilince
 * hemen gelir). Taşıyıcı seçilmeden "Devam et" kapalı: PDF okuması taşıyıcıyı saklamaz.
 * Başka sekmede açık (çalışılan) önizleme gösterilmez (`useOpenPreviewBeacon`); eylemden hemen önce yeniden bakılır.
 */
export function ResumeBand({ carrierChosen, onContinue }: { carrierChosen: boolean; onContinue: (item: ResumablePreview) => Promise<void> }) {
  const { t } = useTranslation("invoiceUpload");
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: RESUMABLE_KEY,
    queryFn: invoices.resumable,
    staleTime: 0,
    // okuma sürüyorsa bitince "hazır"a dönsün
    refetchInterval: (q) => ((q.state.data ?? []).some((i) => i.status === "reading") ? 5000 : false),
    meta: { silent: true },
  });
  // başka sekmenin açtığı ya da bıraktığı önizleme: kayıt değişince ve kayıtlar bayatlayabileceği için ara ara yeniden bakılır
  const [, setTick] = useState(0);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === OPEN_PREVIEW_KEY) setTick((n) => n + 1);
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(() => setTick((n) => n + 1), OPEN_PREVIEW_BEAT_MS);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, []);
  const item = visibleResumables(list.data ?? [], readOpenPreviews(browserStorage()), TAB_ID, Date.now())[0];
  if (!item) return null;
  /** Eylemden hemen önce: dosya bu arada başka sekmede açıldıysa hiçbir şey yapılmaz, bant onu gizler. */
  const takenElsewhere = () => {
    const taken = openElsewhere(readOpenPreviews(browserStorage()), item.fileId, TAB_ID, Date.now());
    if (taken) setTick((n) => n + 1);
    return taken;
  };
  const ready = item.status === "ready";
  const drop = async () => {
    if (takenElsewhere()) return;
    await invoices.discardPreview(item.fileId);
    await qc.invalidateQueries({ queryKey: RESUMABLE_KEY });
  };
  return (
    <div className="notif info mb16" role="status" aria-live="polite" data-testid="resume-band">
      <Icon name={ready ? "doc" : "spin"} className={ready ? undefined : "spin"} />
      <span className="grow">
        {t(ready ? "resume.ready" : "resume.reading", { name: item.name })}
        {ready && !carrierChosen ? ` ${t("resume.needCarrier")}` : ""}
      </span>
      {ready && (
        <Button
          kind="secondary"
          small
          icon="arrow"
          loading={busy}
          disabled={!carrierChosen}
          data-testid="resume-continue"
          onClick={async () => {
            if (takenElsewhere()) return;
            setBusy(true);
            try {
              await onContinue(item);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("resume.continue")}
        </Button>
      )}
      {/* okuma sürerken dosya sunucuda korunur (süren iş): vazgeçme yalnız okunmuş önizlemede */}
      {ready && (
        <button type="button" className="link-btn" onClick={() => void drop()} disabled={busy}>
          {t("resume.discard")}
        </button>
      )}
    </div>
  );
}
