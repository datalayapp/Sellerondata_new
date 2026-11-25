import type { JobLog, ProgressStep, ServerEvent } from "@tagpress/domain";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useConnection, useServerEvents } from "./events.ts";

/**
 * Sunucu olayı → tazelenecek sorgu anahtarı kökleri (saf eşleme; birim testi var).
 * `invalidateQueries({ queryKey: [kök] })` yalnızca ekranda AÇIK sorguları yeniden çeker, kapalı olanları bayatlatır.
 * `job` kökü ayrıntıyı ve günlüğü (["job", id, "log"]) birlikte kapsar.
 */
export function eventQueryKeys(e: ServerEvent): string[] {
  switch (e.type) {
    case "job":
      // Durum değişince maliyet de değişmiş olabilir (üretim bitti / hata). Onay değişince masadaki
      // "yeniden planla" uyarısı (oturumun işlerinden hesaplanır) da tazelenir.
      return ["jobs", "job", "batches", "costs", "printShelf", "printSession", "printSessions"];
    case "jobs":
      return ["jobs", "job", "batches", "printShelf", "printSession", "printSessions"];
    case "batch":
      return ["batches", "jobs"];
    case "variant":
      // Yeni varyasyon, düzeltme, silme, onay: iş, liste, parti sayaçları, varyasyon ayrıntısı ve maliyet.
      return ["jobs", "job", "variant", "variantEdit", "batches", "costs", "printShelf", "printPreview"];
    case "progress":
      // Günlük satırı olayın içinde gelir (applyProgress); AI çağrı özeti (aiCalls) için günlük sorgusu yine de tazelenir.
      return [];
    case "queue":
      return ["queue", "costs"];
    case "template":
      return ["templates", "template"];
    case "profile":
      // Raftaki "36 → 40 (+4)" fazlalığı profilin baskı kurallarından gelir.
      return ["profile", "profileDraft", "profileVersions", "profileDiff", "sablon-profil", "printShelf"];
    case "language":
      return ["languages", "profileDraft", "templates"];
    case "settings":
      return ["settings", "languages", "costs"];
    case "reference":
      return ["references", "proposals"];
    case "session":
      return ["designSession", "profileDraft"];
    case "learn":
      return ["learnRun", "proposals"];
    case "build":
      return ["build"];
    case "print":
      return ["printTemplates", "printTemplate", "printPresets", "printShelf", "printSessions", "printSession", "printPreview"];
    case "printExport":
      return ["printExport"];
  }
}

/** Günlük satırını önbellekteki günlüğe ekler (aynı satır iki kez eklenmez). Önbellek yoksa dokunmaz. */
export function applyProgress(old: JobLog | undefined, step: ProgressStep): JobLog | undefined {
  if (!old) return old;
  if (old.steps.some((s) => s.at === step.at && s.step === step.step && s.message === step.message)) return old;
  return { ...old, steps: [...old.steps, step], running: true };
}

/** Bağlantı kopup geri geldiğinde kaçan olaylar için tazelenecek kökler. */
export const RECONNECT_KEYS = ["jobs", "job", "variant", "batches", "queue", "costs", "templates", "languages", "settings", "profile", "profileDraft", "references", "proposals", "designSession", "build", "learnRun", "printTemplates", "printPresets", "printShelf", "printSessions", "printSession", "printExport"];

/**
 * Bütün ekranlar için tek canlı eşitleme: olay → sorgu tazeleme (art arda gelenler 150 ms'de tek istekte toplanır),
 * günlük satırı anında önbelleğe yazılır, SSE koptuktan sonra yeniden bağlanınca her şey tazelenir.
 */
export function useLiveSync() {
  const qc = useQueryClient();
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef(new Set<string>());
  const flush = useCallback(() => {
    for (const k of pending.current) void qc.invalidateQueries({ queryKey: [k] });
    pending.current.clear();
    timer.current = undefined;
  }, [qc]);
  const schedule = useCallback(
    (keys: readonly string[]) => {
      for (const k of keys) pending.current.add(k);
      if (keys.length && timer.current === undefined) timer.current = window.setTimeout(flush, 150);
    },
    [flush],
  );
  const logTimers = useRef(new Map<string, number>());
  useEffect(() => {
    const t = logTimers.current;
    return () => {
      window.clearTimeout(timer.current);
      for (const id of t.values()) window.clearTimeout(id);
    };
  }, []);

  const connected = useConnection();
  const wasDown = useRef(false);
  useEffect(() => {
    if (!connected) wasDown.current = true;
    else if (wasDown.current) {
      wasDown.current = false;
      schedule(RECONNECT_KEYS);
    }
  }, [connected, schedule]);

  useServerEvents((e) => {
    if (e.type === "progress") writeProgress(qc, e.step);
    schedule(eventQueryKeys(e));
    if (e.type === "progress") scheduleLog(qc, e.step.jobId, logTimers.current);
  });
}

function writeProgress(qc: QueryClient, step: ProgressStep) {
  qc.setQueryData<JobLog | undefined>(["job", step.jobId, "log"], (old) => applyProgress(old, step));
}

/** AI çağrı özeti (aiCalls) satırlarla gelmez: iş başına en fazla 1 sn'de bir günlüğü sunucudan tazele. */
function scheduleLog(qc: QueryClient, jobId: string, timers: Map<string, number>) {
  if (timers.has(jobId)) return;
  timers.set(
    jobId,
    window.setTimeout(() => {
      timers.delete(jobId);
      void qc.invalidateQueries({ queryKey: ["job", jobId, "log"] });
    }, 1000),
  );
}
