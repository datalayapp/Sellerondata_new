import { API, type ServerEvent, ServerEventSchema } from "@tagpress/domain";
import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./platform.ts";
import { openStream, type StreamHandle } from "./sse.ts";

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: StreamHandle | null = null;
let connected = false;
/** Sunucunun yayınladığı bütün olay türleri (`ServerEventSchema`dan türetilir; yeni tür eklenince kendiliğinden dinlenir). */
export const SERVER_EVENT_TYPES: string[] = ServerEventSchema.options.map((o) => o.shape.type.value);
const statusListeners = new Set<(c: boolean) => void>();

/**
 * Tek paylaşılan akış (`lib/sse.ts`). Yeniden bağlanma orada: yerel kipte tarayıcı + kalıcı kapanmada 2 sn sonra yeni
 * bağlantı; platformda sunucu akışı kapatınca (jeton bitti, üye ya da firma değişti) oturum istemcisiyle yeniden açılır.
 * Geri gelince `useLiveSync` kaçan olaylar için sorguları tazeler.
 */
function ensure() {
  if (source) return;
  source = openStream(
    apiUrl(API.events),
    {
      onOpen: () => setConnected(true),
      onDown: () => setConnected(false),
      // Sunucu olayları adlıdır (`event: job` gibi); tür gövdede de var.
      onEvent: (_type, data) => {
        try {
          const e = JSON.parse(data) as ServerEvent;
          for (const l of listeners) l(e);
        } catch {
          /* bozuk olay: yok say */
        }
      },
    },
    { types: SERVER_EVENT_TYPES, reopenMs: 2000 },
  );
}

/** Testler için: paylaşılan akışı kapatır (sonraki abone yeniden açar). */
export function resetServerEvents(): void {
  source?.close();
  source = null;
  setConnected(false);
}

function setConnected(c: boolean) {
  connected = c;
  for (const l of statusListeners) l(c);
}

/** Sunucu olaylarına abone ol (SSE tek bağlantı, bütün bileşenler paylaşır). */
export function useServerEvents(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensure();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

export function useConnection(): boolean {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensure();
    statusListeners.add(setC);
    return () => {
      statusListeners.delete(setC);
    };
  }, []);
  return c;
}
