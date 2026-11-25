import { EventEmitter } from "node:events";
import type { ServerEvent } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import { OrgContextError, maybeOrg } from "./org/context.ts";
import type { Tenancy } from "./org/tenancy.ts";
import type { LiveStreams } from "./platform/live-streams.ts";

/** Dinleyici: olay ve yayınlandığı firma. */
export type EventListener = (event: ServerEvent, orgId: string) => void;

/**
 * Sunucu içi olay yolu; SSE ile arayüze aktarılır. Her olay yayınlandığı anın firmasıyla taşınır (olayın gövdesine
 * girmez). Firma bağlamı yoksa (her kipte): geliştirme ve testte hata, üretimde olay düşer ve sayılır
 * (`tenancy.audit`, `events.emit`); varsayılan firmaya gitmez.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly tenancy: Tenancy,
    private readonly opts: { production?: boolean } = {},
  ) {
    this.emitter.setMaxListeners(200);
  }

  emit(event: ServerEvent): void {
    let orgId: string;
    try {
      orgId = this.tenancy.orgId(`events.emit:${event.type}`);
    } catch (err) {
      if (err instanceof OrgContextError && this.opts.production) {
        this.tenancy.audit.record("no-context", `events.emit:${event.type} (düştü)`);
        return;
      }
      throw err;
    }
    this.emitter.emit("event", event, orgId);
  }

  /**
   * Olayları dinler. `orgId` verilirse yalnız o firmanınkiler gelir (SSE); verilmezse hepsi (sunucu içi dinleyici,
   * test). Dinleyici yayın anının bağlamında çağrılır; firma işi yapacaksa `runInOrg(orgId, …)` ile açar.
   */
  subscribe(fn: EventListener, opts: { orgId?: string } = {}): () => void {
    const want = opts.orgId;
    const listener: EventListener = want ? (e, org) => (org === want ? fn(e, org) : undefined) : fn;
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  get listeners(): number {
    return this.emitter.listenerCount("event");
  }
}

/**
 * `GET /api/events`: text/event-stream. Abone olurken isteğin firması alınır; yalnız o firmanın olayları yazılır.
 * 25 sn'de bir yorum satırı bağlantıyı canlı tutar. Akış `streams`'e kaydedilir (R1): jeton bitince, üye çıkarılınca ya da
 * firma kapanınca sunucu akışı kapatır; istemci yeniden bağlanır ve kimlik denetiminden yeniden geçer.
 */
export function registerEvents(
  app: FastifyInstance,
  bus: EventBus,
  tenancy: Tenancy,
  corsHeaders: (origin: string | undefined) => Record<string, string>,
  streams: LiveStreams,
): void {
  app.get("/api/events", (req, reply) => {
    const orgId = tenancy.orgId("events.sse");
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...corsHeaders(req.headers.origin),
    });
    res.write("retry: 2000\n\n");
    const off = bus.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`), { orgId });
    const beat = setInterval(() => res.write(": canli\n\n"), 25_000);
    let unregister: () => void = () => undefined;
    const close = () => {
      clearInterval(beat);
      off();
      unregister();
    };
    unregister = streams.register(streamOwner(req, orgId), () => {
      close();
      res.end();
    });
    req.raw.on("close", close);
    res.on("error", close);
  });
}

/** Akışın sahibi: isteğin firması, üyesi (platform) ve jetonun bitişi (auth-kit bağlamı `expiresAt`; yerel kipte yok). */
export function streamOwner(req: object, orgId: string): { orgId: string; memberId: string | null; expiresAt: number | null } {
  const expiresAt = (req as { auth?: { expiresAt?: unknown } | null }).auth?.expiresAt;
  return { orgId, memberId: maybeOrg()?.memberId ?? null, expiresAt: typeof expiresAt === "number" ? expiresAt : null };
}
