/**
 * Açık uzun yanıtlar (SSE: `GET /api/events`, oluşturucu akışı). Bir akış açılırken kimlik bir kez denetlenir; sonrası
 * için (R1) akış kimin adına açıldığını taşır ve şu anlarda kapanır:
 * - jetonun bitişi (`expiresAt`, auth-kit bağlamı): istemci yeniden bağlanır ve kimlik denetiminden yeniden geçer;
 * - `member.removed` / `member.upserted` (üyenin rolü, izni ya da etkinliği değişti): o üyenin akışları;
 * - `org.closed` / `org.purged`: firmanın bütün akışları;
 * - uygulama kapanışı.
 * Yerel kipte üye ve bitiş yoktur: akış yalnız kapanışta biter.
 */
export interface StreamOwner {
  orgId: string;
  memberId: string | null;
  /** Jetonun bitiş anı (ms); yoksa süresiz (yerel kip). */
  expiresAt: number | null;
}

/** Olay alıcısının işlediği hesap olayının akışları ilgilendiren kısmı. */
export interface StreamEvent {
  type: string;
  orgId?: unknown;
  membershipId?: unknown;
}

interface Entry {
  owner: StreamOwner;
  end: () => void;
  timer: NodeJS.Timeout | null;
}

/** `setTimeout` üst sınırı (~24,8 gün); daha uzak bitiş bu aralıkla yeniden kurulur. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export class LiveStreams {
  private readonly entries = new Set<Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Akışı kaydeder. `end` akışı kapatır (bir kez çağrılır; kayıt kendiliğinden silinir). Dönen işlev kaydı siler (istemci
   * bağlantıyı kendisi kapattığında).
   */
  register(owner: StreamOwner, end: () => void): () => void {
    const entry: Entry = { owner, end, timer: null };
    this.entries.add(entry);
    if (owner.expiresAt !== null) this.arm(entry, owner.expiresAt);
    return () => this.drop(entry);
  }

  /** Hesap olayı (olay alıcısı işledikten sonra): ilgili akışlar kapanır. Kapanan akış sayısı. */
  handleEvent(event: StreamEvent): number {
    const orgId = typeof event.orgId === "string" ? event.orgId : null;
    if (!orgId) return 0;
    switch (event.type) {
      case "member.removed":
      case "member.upserted":
        return typeof event.membershipId === "string" ? this.closeWhere((o) => o.orgId === orgId && o.memberId === event.membershipId) : 0;
      case "org.closed":
      case "org.purged":
        return this.closeWhere((o) => o.orgId === orgId);
      default:
        return 0;
    }
  }

  /** Bütün akışlar (uygulama kapanışı). */
  closeAll(): number {
    return this.closeWhere(() => true);
  }

  get size(): number {
    return this.entries.size;
  }

  private closeWhere(match: (o: StreamOwner) => boolean): number {
    let n = 0;
    for (const entry of [...this.entries]) {
      if (!match(entry.owner)) continue;
      this.finish(entry);
      n++;
    }
    return n;
  }

  private arm(entry: Entry, at: number): void {
    const ms = at - this.now();
    if (ms <= 0) {
      // Jeton zaten bitmiş: akış hemen kapanır (bir sonraki turda; kayıt dönen işlevden önce bitmesin).
      entry.timer = setTimeout(() => this.finish(entry), 0);
    } else {
      entry.timer = setTimeout(() => (ms > MAX_TIMEOUT_MS ? this.arm(entry, at) : this.finish(entry)), Math.min(ms, MAX_TIMEOUT_MS));
    }
    entry.timer.unref();
  }

  private drop(entry: Entry): boolean {
    if (!this.entries.delete(entry)) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    return true;
  }

  private finish(entry: Entry): void {
    if (!this.drop(entry)) return;
    try {
      entry.end();
    } catch {
      /* bağlantı zaten kapanmış olabilir */
    }
  }
}

/**
 * Olay alıcısının gövdesindeki imzalı olay jetonundan olay (`{ token }` → yük `event`). İmzayı alıcı zaten doğrulamıştır
 * (yalnız 2xx yanıttan sonra çağrılır); burada yalnız yük okunur. Okunamazsa null.
 */
export function eventFromReceiverBody(body: unknown): StreamEvent | null {
  const token = (body as { token?: unknown } | null | undefined)?.token;
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { event?: unknown };
    const event = payload.event as StreamEvent | undefined;
    return event && typeof event === "object" && typeof event.type === "string" ? event : null;
  } catch {
    return null;
  }
}
