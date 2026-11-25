import { BUILD_STREAM_EVENT_TYPES, isBuildRunning, type Build, type BuildEntry, type BuildStreamEvent } from "@tagpress/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure } from "../../lib/api.ts";
import { openStream } from "../../lib/sse.ts";
import { builderApi, keys } from "./api.ts";
import { mergeEntries } from "./akis.ts";

/** Çalışan turda akış yoksa (bağlantı koptu, vekil kapattı) yedek sorgu aralığı. */
export const POLL_MS = 3000;

export type StreamStep = Extract<BuildStreamEvent, { type: "step" }>;

/** Kullanıcıya özel kutuyla gösterilen hatalar (bütçe, anahtar); diğerleri bildirimdir. */
export interface Failure {
  code: "budget-exceeded" | "missing-key";
  body: ApiFailure["body"] & Record<string, unknown>;
  /** Bütçe artırılınca yeniden denenecek iş. */
  retry: (() => Promise<unknown>) | null;
}

/**
 * Oluşturucu oturumunun verisi: etkin oturum (`currentBuild`), soldaki akış (artımlı `listMessages?after=`), oturum
 * akışı (SSE: canlı metin, adım, maliyet; olay gelince sorgular tazelenir) ve akış yoksa çalışan turda yedek sorgu.
 */
export function useOlustur(lang: string) {
  const qc = useQueryClient();
  // Akış açıkken sorgu gerekmez; kopukken çalışan turda oturum aralıkla okunur (yeni girdi varsa akış da çekilir).
  const connectedRef = useRef(false);
  const buildQ = useQuery({
    queryKey: keys.current(lang),
    queryFn: () => builderApi.current(lang),
    refetchInterval: (q) => (q.state.data && isBuildRunning(q.state.data.state) && !connectedRef.current ? POLL_MS : false),
    retry: false,
  });
  const build = buildQ.data ?? null;
  const id = build?.id ?? null;

  const msgKey = id ? keys.messages(lang, id) : null;
  const messagesQ = useQuery({
    queryKey: msgKey ?? ["build", lang, "none"],
    enabled: !!id,
    queryFn: async () => {
      const old = qc.getQueryData<BuildEntry[]>(msgKey!) ?? [];
      const after = old.at(-1)?.id ?? 0;
      const r = await builderApi.messages(id!, after);
      return mergeEntries(old, r.entries);
    },
    retry: false,
  });
  const entries = messagesQ.data ?? [];
  const lastEntry = entries.at(-1)?.id ?? 0;

  // Oturum yenilenince (yeni girdi var) akışı da çek; aynı sayı için bir kez (sunucu tutarsızsa döngü olmasın).
  const lastWanted = build?.lastEntryId ?? 0;
  const asked = useRef(0);
  useEffect(() => {
    if (!id || lastWanted <= lastEntry || asked.current === lastWanted) return;
    asked.current = lastWanted;
    void qc.invalidateQueries({ queryKey: keys.messages(lang, id) });
  }, [id, lastWanted, lastEntry, lang, qc]);

  const [live, setLive] = useState<{ turnSeq: number; text: string } | null>(null);
  const [step, setStep] = useState<StreamStep | null>(null);
  const [month, setMonth] = useState<{ usd: number; limit: number } | null>(null);
  const [latestRev, setLatestRev] = useState<number | null>(null);

  const setBuild = useCallback((b: Build | null) => qc.setQueryData(keys.current(lang), b), [qc, lang]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["build", lang] }), [qc, lang]);

  const onEvent = useCallback(
    (e: BuildStreamEvent) => {
      if (!id) return;
      switch (e.type) {
        case "status":
          void qc.invalidateQueries({ queryKey: keys.current(lang) });
          if (!e.running) {
            setLive(null);
            setStep(null);
          }
          break;
        case "text":
          setLive((cur) => (cur && cur.turnSeq === e.turnSeq ? { turnSeq: e.turnSeq, text: cur.text + e.delta } : { turnSeq: e.turnSeq, text: e.delta }));
          break;
        case "step":
          if (e.phase === "start") setStep(e);
          else setStep((cur) => (cur && cur.step === e.step ? null : cur));
          break;
        case "question":
          qc.setQueryData<BuildEntry[]>(keys.messages(lang, id), (old) => mergeEntries(old ?? [], [e.entry]));
          void qc.invalidateQueries({ queryKey: keys.current(lang) });
          break;
        case "revision":
          setLatestRev(e.rev);
          void qc.invalidateQueries({ queryKey: keys.revisions(lang, id) });
          void qc.invalidateQueries({ queryKey: keys.current(lang) });
          break;
        case "cost":
          setMonth({ usd: e.monthUsd, limit: e.monthLimitUsd });
          qc.setQueryData<Build | null>(keys.current(lang), (b) => (b ? { ...b, costUsd: e.costUsd, budgetUsd: e.budgetUsd } : b));
          break;
        case "error":
          void qc.invalidateQueries({ queryKey: keys.current(lang) });
          break;
        case "done":
          setLive(null);
          setStep(null);
          void qc.invalidateQueries({ queryKey: keys.current(lang) });
          void qc.invalidateQueries({ queryKey: keys.messages(lang, id) });
          void qc.invalidateQueries({ queryKey: keys.revisions(lang, id) });
          break;
      }
    },
    [id, lang, qc],
  );
  const connected = useBuildStream(id, onEvent);
  connectedRef.current = connected;

  // Oturum çalışmayı bitirince canlı metin ve adım temizlenir (akış kaçırıldıysa da).
  const running = !!build && isBuildRunning(build.state);
  useEffect(() => {
    if (!running) {
      setLive(null);
      setStep(null);
    }
  }, [running]);

  return {
    lang,
    build,
    loading: buildQ.isLoading,
    loadError: buildQ.error,
    entries,
    entriesLoading: messagesQ.isLoading && !!id,
    live,
    step,
    month,
    latestRev,
    connected,
    setBuild,
    refresh,
  };
}
export type OlusturData = ReturnType<typeof useOlustur>;

/**
 * Oturum akışı (`GET /api/builds/:id/stream`). Olaylar adlıdır; her tür ayrı dinlenir. Yeniden bağlanma `lib/sse.ts`'te:
 * kopan ya da sunucunun kapattığı (jeton bitti, üye ya da firma değişti) akış `Last-Event-ID` ile kaldığı yerden sürer;
 * yerel kipte kalıcı kapanmada (vekil 502) 3 sn sonra yeni bağlantı açılır (sunucu önce `status` gönderir, arayüz eşitlenir).
 * Platformda 401'de oturum yenilenir ve akış yeniden açılır.
 */
export function useBuildStream(id: string | null, fn: (e: BuildStreamEvent) => void): boolean {
  const ref = useRef(fn);
  ref.current = fn;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!id) return;
    const s = openStream(
      builderApi.streamUrl(id),
      {
        onOpen: () => setOpen(true),
        onDown: () => setOpen(false),
        onEvent: (_type, data) => {
          try {
            ref.current(JSON.parse(data) as BuildStreamEvent);
          } catch {
            /* bozuk olay: yok say */
          }
        },
      },
      { types: BUILD_STREAM_EVENT_TYPES, reopenMs: 3000 },
    );
    return () => {
      s.close();
      setOpen(false);
    };
  }, [id]);
  return open;
}

/** Hata özel kutuyla mı gösterilir (bütçe, anahtar)? */
export function failureOf(e: unknown, retry: (() => Promise<unknown>) | null): Failure | null {
  if (!(e instanceof ApiFailure)) return null;
  const code = e.body.code;
  if (code === "budget-exceeded" || code === "missing-key") return { code, body: e.body as Failure["body"], retry };
  return null;
}
