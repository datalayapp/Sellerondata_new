import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveStreams, eventFromReceiverBody } from "./live-streams.ts";

/** Açık akışların kaydı (R1): olaya, jeton bitişine ve kapanışa göre kapanma. Uçtan uca hâli `r1.pg.test.ts` (gerçek port). */
describe("LiveStreams", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("member.removed / member.upserted yalnız o üyenin, org.closed / org.purged firmanın bütün akışlarını kapatır", () => {
    const s = new LiveStreams();
    const closed: string[] = [];
    s.register({ orgId: "a", memberId: "m1", expiresAt: null }, () => closed.push("a/m1"));
    s.register({ orgId: "a", memberId: "m2", expiresAt: null }, () => closed.push("a/m2"));
    s.register({ orgId: "b", memberId: "m1", expiresAt: null }, () => closed.push("b/m1"));
    expect(s.handleEvent({ type: "member.removed", orgId: "a", membershipId: "m1" })).toBe(1);
    expect(closed).toEqual(["a/m1"]);
    expect(s.handleEvent({ type: "subscription.updated", orgId: "a" })).toBe(0);
    expect(s.handleEvent({ type: "member.upserted", orgId: "a", membershipId: "m2" })).toBe(1);
    expect(s.handleEvent({ type: "org.closed", orgId: "b" })).toBe(1);
    expect(closed).toEqual(["a/m1", "a/m2", "b/m1"]);
    expect(s.size).toBe(0);
    s.register({ orgId: "c", memberId: null, expiresAt: null }, () => closed.push("c"));
    expect(s.handleEvent({ type: "org.purged", orgId: "c" })).toBe(1);
    // Biçimsiz olay hiçbir şeyi kapatmaz.
    expect(s.handleEvent({ type: "org.closed" })).toBe(0);
  });

  it("jeton bitince akış kapanır; bağlantıyı istemci kapatınca kayıt silinir, kapanış çağrılmaz", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const s = new LiveStreams(() => now);
    const end = vi.fn();
    s.register({ orgId: "a", memberId: "m", expiresAt: now + 5_000 }, end);
    vi.advanceTimersByTime(4_999);
    expect(end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(s.size).toBe(0);
    const other = vi.fn();
    const off = s.register({ orgId: "a", memberId: "m", expiresAt: now + 1_000 }, other);
    off();
    vi.advanceTimersByTime(2_000);
    expect(other).not.toHaveBeenCalled();
    // Bitmiş jeton: hemen (sonraki tur) kapanır; kapanış bir kez.
    const late = vi.fn();
    s.register({ orgId: "a", memberId: "m", expiresAt: now - 1 }, late);
    vi.advanceTimersByTime(0);
    expect(late).toHaveBeenCalledTimes(1);
    expect(s.closeAll()).toBe(0);
  });

  it("olay alıcısı gövdesinden olay: jeton yükündeki `event`; bozuk gövde null", () => {
    const payload = Buffer.from(JSON.stringify({ event: { type: "member.removed", orgId: "a", membershipId: "m" } })).toString("base64url");
    expect(eventFromReceiverBody({ token: `x.${payload}.y` })).toEqual({ type: "member.removed", orgId: "a", membershipId: "m" });
    for (const bad of [null, {}, { token: 1 }, { token: "x" }, { token: "x.!!!.y" }, { token: `x.${Buffer.from("{}").toString("base64url")}.y` }]) {
      expect(eventFromReceiverBody(bad)).toBeNull();
    }
  });
});
