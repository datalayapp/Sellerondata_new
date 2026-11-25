import { randomBytes } from "node:crypto";
import { BUILD_STREAM, type BuildStreamEvent, formatBuildEventId, parseBuildEventId } from "@tagpress/domain";

/**
 * Oturum akışı (`GET /api/builds/:id/stream`, plan §4.3): oturum başına artan olay numarası ve son
 * `BUILD_STREAM.replayBuffer` olayın tamponu. Kimlik `"<bootId>:<n>"`; `Last-Event-ID` aynı açılışa aitse ve tampondaysa
 * kaldığı yerden sürer, değilse çağıran önce anlık görüntü (`status`) gönderir ve arayüz sorgulayarak eşitlenir.
 * Tampon süreç belleğindedir (açılış değişince kimlikler de değişir). Firma ayrımı çağıranda: akışa yalnız isteğin
 * firmasında bulunan oturumla abone olunur (oturum kimliği kurulum genelinde tekildir).
 */

export interface StreamItem {
  id: string;
  n: number;
  event: BuildStreamEvent;
}

type Listener = (item: StreamItem) => void;

interface Channel {
  n: number;
  buffer: StreamItem[];
  listeners: Set<Listener>;
}

export class BuildStreams {
  readonly bootId: string;
  private readonly channels = new Map<string, Channel>();

  constructor(bootId?: string) {
    this.bootId = bootId ?? randomBytes(6).toString("base64url");
  }

  private channel(buildId: string): Channel {
    let c = this.channels.get(buildId);
    if (!c) this.channels.set(buildId, (c = { n: 0, buffer: [], listeners: new Set() }));
    return c;
  }

  publish(buildId: string, event: BuildStreamEvent): StreamItem {
    const c = this.channel(buildId);
    const n = ++c.n;
    const item = { id: formatBuildEventId(this.bootId, n), n, event };
    c.buffer.push(item);
    if (c.buffer.length > BUILD_STREAM.replayBuffer) c.buffer.splice(0, c.buffer.length - BUILD_STREAM.replayBuffer);
    for (const l of [...c.listeners]) {
      try {
        l(item);
      } catch {
        c.listeners.delete(l);
      }
    }
    return item;
  }

  /**
   * Abone olur. `lastEventId` bu açılışa aitse ve ondan sonraki her olay tampondaysa `replay` o olaylardır
   * (`resumed: true`); değilse `resumed: false` (çağıran anlık görüntü gönderir).
   */
  subscribe(buildId: string, lastEventId: string | null | undefined, fn: Listener): { replay: StreamItem[]; resumed: boolean; off: () => void } {
    const c = this.channel(buildId);
    const last = parseBuildEventId(lastEventId);
    let replay: StreamItem[] = [];
    let resumed = false;
    if (last && last.bootId === this.bootId && last.n <= c.n) {
      const first = c.buffer[0]?.n ?? c.n + 1;
      if (last.n + 1 >= first || last.n === c.n) {
        replay = c.buffer.filter((i) => i.n > last.n);
        resumed = true;
      }
    }
    c.listeners.add(fn);
    return { replay, resumed, off: () => c.listeners.delete(fn) };
  }

  /** Test ve teşhis: oturumun yayınlanmış olayları (tampon). */
  buffered(buildId: string): StreamItem[] {
    return [...(this.channels.get(buildId)?.buffer ?? [])];
  }
}
