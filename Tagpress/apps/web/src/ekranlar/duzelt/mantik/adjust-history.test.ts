import { describe, expect, it } from "vitest";
import { canRedo, canUndo, createHistory, HISTORY_LIMIT, push, redo, undo } from "./adjust-history.ts";

describe("geçmiş", () => {
  it("push → undo → redo", () => {
    let h = createHistory(0);
    h = push(h, 1, { now: 0 });
    h = push(h, 2, { now: 1000 });
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = undo(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe(1);
    expect(canRedo(h)).toBe(true);
    h = redo(redo(h));
    expect(h.present).toBe(2);
    expect(redo(h)).toBe(h);
  });
  it("yeni işlem ileri alma listesini boşaltır", () => {
    let h = push(push(createHistory(0), 1, { now: 0 }), 2, { now: 1000 });
    h = push(undo(h), 9, { now: 2000 });
    expect(canRedo(h)).toBe(false);
    expect(h.past).toEqual([0, 1]);
  });
  it("aynı değer yeni adım açmaz", () => {
    const h = createHistory(5);
    expect(push(h, 5, { now: 0 })).toBe(h);
  });
  it("aynı anahtarlı hızlı işlemler tek adımda birleşir; yavaşı birleşmez", () => {
    let h = createHistory(0);
    h = push(h, 1, { now: 0, key: "ok" });
    h = push(h, 2, { now: 200, key: "ok" });
    h = push(h, 3, { now: 600, key: "ok" });
    expect(h.past).toEqual([0]);
    h = undo(h);
    expect(h.present).toBe(0);
    h = redo(h);
    h = push(h, 4, { now: 5000, key: "ok" });
    expect(h.past).toEqual([0, 3]);
  });
  it("farklı anahtar birleşmez", () => {
    let h = push(createHistory(0), 1, { now: 0, key: "ok" });
    h = push(h, 2, { now: 100, key: "boyut" });
    expect(h.past).toEqual([0, 1]);
  });
  it("sınır: en eski adımlar atılır", () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = push(h, i, { now: i * 1000 });
    expect(h.past.length).toBe(HISTORY_LIMIT);
    expect(h.past[0]).toBe(20);
    expect(h.present).toBe(HISTORY_LIMIT + 20);
  });
  it("özel eşitlik", () => {
    const h = createHistory({ a: 1 });
    expect(push(h, { a: 1 }, { now: 0, eq: (x, y) => x.a === y.a })).toBe(h);
  });
});
