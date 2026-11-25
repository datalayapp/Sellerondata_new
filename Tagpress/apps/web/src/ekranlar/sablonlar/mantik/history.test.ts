import { describe, expect, it } from "vitest";
import { canUndo, emptyHistory, HISTORY_LIMIT, record, undo } from "./history.ts";

describe("geri al geçmişi", () => {
  it("boş geçmişte geri alınmaz", () => {
    const h = emptyHistory<number>();
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBeNull();
  });
  it("aynı anahtar tek adımda birleşir", () => {
    let h = emptyHistory<number>();
    h = record(h, 1, "k");
    h = record(h, 2, "k");
    h = record(h, 3, "k");
    expect(h.past).toEqual([1]);
    expect(canUndo(h)).toBe(true);
  });
  it("anahtarsız her seferinde yeni adım", () => {
    let h = emptyHistory<number>();
    h = record(h, 1);
    h = record(h, 2);
    expect(h.past).toEqual([1, 2]);
  });
  it("farklı anahtar yeni adım açar", () => {
    let h = emptyHistory<number>();
    h = record(h, 1, "a");
    h = record(h, 2, "b");
    expect(h.past).toEqual([1, 2]);
    expect(h.key).toBe("b");
  });
  it("undo son durumu döner ve anahtarı sıfırlar", () => {
    let h = emptyHistory<number>();
    h = record(h, 1, "a");
    h = record(h, 2, "b");
    const r = undo(h)!;
    expect(r.value).toBe(2);
    expect(r.history.past).toEqual([1]);
    expect(r.history.key).toBeNull();
  });
  it("undo sonrası aynı anahtar yeni adım açar", () => {
    let h = emptyHistory<number>();
    h = record(h, 1, "a");
    h = undo(h)!.history;
    h = record(h, 5, "a");
    expect(h.past).toEqual([5]);
  });
  it("sınır aşılınca en eski düşer", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = record(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(5);
    expect(h.past[HISTORY_LIMIT - 1]).toBe(HISTORY_LIMIT + 4);
  });
});
