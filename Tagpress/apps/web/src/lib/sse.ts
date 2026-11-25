import { openPlatformStream, streamFailure } from "./api.ts";
import { isPlatform } from "./platform.ts";

/**
 * Sunucu akışı (SSE): `GET /api/events` ve oluşturucu akışı `GET /api/builds/:id/stream`. İki kip:
 *
 * - Yerel kip: tarayıcının `EventSource`'u (bugünkü davranış). Kopan bağlantıyı tarayıcı `Last-Event-ID` ile kendisi
 *   yeniler; kalıcı kapanmada (vekil 502, yeniden başlayan sunucu) `reopenMs` sonra yeni bağlantı açılır.
 * - Platform kipi: `EventSource` başlık taşıyamaz ve 401'de kalıcı kapanır; akış kabuğun oturum istemcisiyle `fetch`
 *   üzerinden okunur (`lib/api.ts` `openPlatformStream`: çerez, `X-SOD-Org`, `Accept-Language`, 401'de bir kez yenile +
 *   yeniden dene). Sunucu akışı jeton bitince, üye ya da firma değişince kapatır (R1); istemci sunucunun `retry:`
 *   süresi sonra yeniden bağlanır ve son olay kimliğini `Last-Event-ID` ile gönderir (oluşturucu kaldığı yerden sürer).
 *   Açılış reddedilirse hata sayfa düzeyi tepkiye gider (`oturum/hatalar.ts`: erişim sayfası, firma kapalı, yetki
 *   tazeleme) ve artan aralıkla yeniden denenir; oturum bitti (401: istemci girişe götürdü), erişim yok ya da firma
 *   kapalıysa, ya da akış artık yoksa (404) yeniden denenmez.
 */
export interface StreamHandlers {
  /** Bağlantı açıldı (yeniden açılışlarda da). */
  onOpen(): void;
  /** Adlı olay (`event: job`); adsız ileti `message` türüyle gelir. */
  onEvent(type: string, data: string): void;
  /** Bağlantı koptu ya da açılamadı (yeniden denenecek ya da durdu). */
  onDown(): void;
}

export interface StreamOptions {
  /** Dinlenen adlı olay türleri (yerel kipte `EventSource` adlı olayları `onmessage`'a düşürmez). */
  types: readonly string[];
  /** Yerel kipte kalıcı kapanmadan sonra yeniden açma süresi. */
  reopenMs?: number;
}

export interface StreamHandle {
  close(): void;
}

/** Platform kipinde ilk yeniden deneme süresi (sunucu `retry:` gönderirse o geçer) ve başarısız açılışlarda üst sınır. */
export const STREAM_RETRY_MS = 2000;
export const STREAM_MAX_BACKOFF_MS = 30_000;

/** Yeniden denenmeyen yanıtlar: oturum bitti (istemci girişe götürür), araç erişimi yok, firma kapalı, akış yok. */
const FINAL_CODES = new Set(["NO_PRODUCT_ACCESS", "ORG_CLOSED"]);

export function openStream(url: string, h: StreamHandlers, opts: StreamOptions): StreamHandle {
  return isPlatform() ? openFetchStream(url, h) : openEventSource(url, h, opts);
}

function openEventSource(url: string, h: StreamHandlers, opts: StreamOptions): StreamHandle {
  let es: EventSource | null = null;
  let timer: number | undefined;
  let closed = false;
  const on = (m: MessageEvent<string>) => h.onEvent(m.type || "message", m.data);
  const open = () => {
    if (closed || typeof EventSource === "undefined") return;
    const s = new EventSource(url);
    es = s;
    for (const t of opts.types) s.addEventListener(t, on as EventListener);
    s.onmessage = on;
    s.onopen = () => h.onOpen();
    s.onerror = () => {
      h.onDown();
      // Vekil sunucu (502) ya da yeniden başlayan sunucu bağlantıyı kalıcı kapatır; tarayıcı kendiliğinden denemez.
      if (s.readyState === EventSource.CLOSED && es === s) {
        es = null;
        timer = window.setTimeout(open, opts.reopenMs ?? STREAM_RETRY_MS);
      }
    };
  };
  open();
  return {
    close() {
      closed = true;
      window.clearTimeout(timer);
      es?.close();
      es = null;
    },
  };
}

/** SSE çözümleyicisi (WHATWG kuralları): satırlar, `event`/`data`/`id`/`retry` alanları, boş satırda gönderim. */
export class SseParser {
  lastEventId = "";
  retryMs: number | null = null;
  private buf = "";
  private event = "";
  private data: string[] = [];
  private pendingCr = false;

  constructor(private readonly emit: (type: string, data: string) => void) {}

  push(chunk: string): void {
    let text = chunk;
    // Önceki parça `\r` ile bittiyse ardından gelen `\n` aynı satır sonudur.
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = text.endsWith("\r");
    this.buf += text;
    const lines = this.buf.split(/\r\n|\r|\n/);
    this.buf = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
    }
  }

  private dispatch(): void {
    const type = this.event || "message";
    const data = this.data.join("\n");
    const had = this.data.length > 0;
    this.event = "";
    this.data = [];
    if (had) this.emit(type, data);
  }
}

function openFetchStream(url: string, h: StreamHandlers): StreamHandle {
  let closed = false;
  let ctrl: AbortController | null = null;
  let timer: number | undefined;
  let lastEventId = "";
  let retryMs = STREAM_RETRY_MS;
  let failures = 0;

  const later = (ms: number) => {
    if (closed) return;
    timer = window.setTimeout(() => void run(), ms);
  };

  const run = async () => {
    if (closed) return;
    const c = new AbortController();
    ctrl = c;
    let res: Response;
    try {
      res = await openPlatformStream(url, { signal: c.signal, lastEventId: lastEventId || null });
    } catch (e) {
      if (closed || (e as Error).name === "AbortError") return;
      // Ağ yok ya da oturum istemcisi isteği göndermedi (başka firmaya geçmiş sekme): aralıkla yeniden.
      h.onDown();
      return later(backoff(++failures, retryMs));
    }
    if (closed) return;
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("text/event-stream") || !res.body) {
      h.onDown();
      if (!res.ok) {
        const failure = await streamFailure(res);
        if (closed) return;
        if (res.status === 401 || res.status === 404 || FINAL_CODES.has(failure.body.code ?? "")) return;
      } else {
        void res.body?.cancel().catch(() => undefined);
      }
      return later(backoff(++failures, retryMs));
    }
    failures = 0;
    h.onOpen();
    const parser = new SseParser((t, d) => {
      if (!closed) h.onEvent(t, d);
    });
    parser.lastEventId = lastEventId;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        lastEventId = parser.lastEventId;
        if (parser.retryMs !== null) retryMs = parser.retryMs;
      }
      parser.push(decoder.decode());
      lastEventId = parser.lastEventId;
    } catch {
      /* bağlantı koptu ya da kapatıldı */
    }
    if (closed) return;
    // Sunucu akışı kapattı (jeton bitti, üye ya da firma değişti, yeniden başlıyor): `retry:` süresi sonra yeniden.
    h.onDown();
    later(retryMs);
  };

  void run();
  return {
    close() {
      closed = true;
      window.clearTimeout(timer);
      ctrl?.abort();
      ctrl = null;
    },
  };
}

/** Başarısız açılışlarda artan bekleme: 2 s, 4 s, 8 s … en çok 30 s. */
export function backoff(failures: number, base: number): number {
  return Math.min(STREAM_MAX_BACKOFF_MS, base * 2 ** Math.max(0, failures - 1));
}
