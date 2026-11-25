import type { PrintExport } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../../i18n/sunucu.ts";
import { ApiFailure } from "../../../lib/api.ts";
import { useServerEvents } from "../../../lib/events.ts";
import { PRINT_KEYS, printApi } from "../mantik/api.ts";
import { type ExportOptions, exportKey, exportPhase, exportProgress, exportRequest } from "../mantik/masa.ts";

/**
 * Dosya üretimi (PDF / PNG): sunucu arka planda üretir; ilerleme `printExport` olayıyla (ve yedek olarak yoklamayla)
 * gelir, bitince dosyalar indirilir. Başlamadan önce bekleyen yerel değişiklikler gönderilir (`settle`). Oturum
 * değişince sıfırlanır.
 */
export function useDosya(sessionId: string, settle: () => Promise<number | null>) {
  const { t } = useTranslation("printDesk");
  const [exportId, setExportId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Son üretimin seçenek imzası: değiştiyse dosyalar eskidir. */
  const [madeWith, setMadeWith] = useState<string | null>(null);
  const [live, setLive] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    setExportId(null);
    setError(null);
    setMadeWith(null);
    setLive(null);
  }, [sessionId]);

  const q = useQuery({
    queryKey: [PRINT_KEYS.export, exportId],
    queryFn: () => printApi.getExport(exportId!),
    enabled: !!exportId,
    refetchInterval: (query) => {
      const s = (query.state.data as PrintExport | undefined)?.status;
      return s === "done" || s === "failed" || s === "interrupted" ? false : 1500;
    },
  });
  useServerEvents((e) => {
    if (e.type === "printExport" && e.exportId === exportId) setLive({ done: e.done, total: e.total });
  });

  const ex = exportId ? q.data : undefined;
  const phase = exportPhase(exportId, ex);
  const progress = exportProgress(phase, live, ex);

  const start = async (o: ExportOptions) => {
    setStarting(true);
    setError(null);
    setLive(null);
    try {
      await settle();
      const r = await printApi.startExport(sessionId, exportRequest(o));
      setExportId(r.id);
      setMadeWith(exportKey(o));
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 501 ? t("export.noEngine") : serverText(e));
    } finally {
      setStarting(false);
    }
  };

  return { phase, progress, ex, error, starting, madeWith, start };
}
