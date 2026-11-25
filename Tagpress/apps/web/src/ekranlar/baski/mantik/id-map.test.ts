import type { PrintItem, PrintPageFull, PrintSessionDetail } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { createHistory, push, redo, undo } from "../../duzelt/mantik/adjust-history.ts";
import { addPage, diffSession, placeFromShelf } from "./desk-model.ts";
import { idMapOf, remapHistory, remapId, remapIds, remapKeys, remapSession } from "./id-map.ts";

const item = (id: string, pageId: string): PrintItem => ({ id, pageId, jobId: "j1", variantId: "v1", slotId: null, xMm: 10, yMm: 10, rotation: 0, scale: 1, extra: false, manual: true, z: 0 });
const page = (id: string, items: PrintItem[] = []): PrintPageFull =>
  ({ id, sessionId: "s1", templateId: "t1", index: 0, name: "Sayfa", copies: 1, kind: "manual", showCellLabels: false, locked: false, items }) as PrintPageFull;
const session = (pages: PrintPageFull[]): PrintSessionDetail => ({ id: "s1", version: 1, name: "Oturum", pages, notices: [] }) as unknown as PrintSessionDetail;

describe("geçici kimlik → gerçek kimlik", () => {
  it("yanıttaki ids düz nesneden eşlemeye; boş/aynı kimlik atlanır", () => {
    expect(idMapOf(undefined).size).toBe(0);
    expect(idMapOf({}).size).toBe(0);
    const m = idMapOf({ p_tmp: "019a-p", i_tmp: "019a-i", same: "same", bos: "" });
    expect([...m]).toEqual([
      ["p_tmp", "019a-p"],
      ["i_tmp", "019a-i"],
    ]);
    // Nesnenin kendi alanı olmayan ad ("constructor") eşlenmez.
    expect(remapId("constructor", m)).toBe("constructor");
  });

  it("oturum: sayfa kimliği, öğe kimliği ve öğenin sayfası çevrilir; değişmeyen aynı nesne", () => {
    const keep = page("p1", [item("a", "p1")]);
    const s = session([keep, page("p_tmp", [item("i_tmp", "p_tmp"), item("b", "p_tmp")])]);
    const ids = idMapOf({ p_tmp: "P", i_tmp: "I" });
    const n = remapSession(s, ids);
    expect(n.pages[0]).toBe(keep);
    expect(n.pages[1]!.id).toBe("P");
    expect(n.pages[1]!.items.map((i) => [i.id, i.pageId])).toEqual([
      ["I", "P"],
      ["b", "P"],
    ]);
    expect(remapSession(s, idMapOf({ yok: "x" }))).toBe(s);
    expect(remapSession(s, idMapOf(undefined))).toBe(s);
    // Var olan sayfaya eklenen öğe: yalnız öğe kimliği.
    const t = remapSession(session([page("p1", [item("a", "p1"), item("i_tmp", "p1")])]), ids);
    expect(t.pages[0]!.items.map((i) => [i.id, i.pageId])).toEqual([
      ["a", "p1"],
      ["I", "p1"],
    ]);
  });

  it("seçim listesi ve anahtarlar (silinen sayfa → geri alma anahtarı)", () => {
    const ids = idMapOf({ i_tmp: "I", p_tmp: "P" });
    const sel = ["a", "b"];
    expect(remapIds(sel, ids)).toBe(sel);
    expect(remapIds(["a", "i_tmp"], ids)).toEqual(["a", "I"]);
    const removed = new Map([
      ["p_tmp", "tok1"],
      ["p2", "tok2"],
    ]);
    remapKeys(removed, ids);
    expect([...removed].sort()).toEqual([
      ["P", "tok1"],
      ["p2", "tok2"],
    ]);
  });

  it("geçmişin bütün durumları çevrilir; değişen yoksa aynı geçmiş", () => {
    const s0 = session([page("p1")]);
    const s1 = addPage(s0, "t1", { id: "p_tmp" }).session;
    const s2 = placeFromShelf(s1, { slots: [] } as never, { pageId: "p_tmp", point: { x: 5, y: 5 }, jobId: "j1", variantId: "v1", count: 1, free: true, quantity: 1, placed: 0 }, () => "i_tmp").session;
    let h = push(push(createHistory(s0), s1, { now: 1 }), s2, { now: 2 });
    h = undo(h); // geçmiş [s0], şimdiki s1, gelecek [s2]
    const ids = idMapOf({ p_tmp: "P", i_tmp: "I" });
    const r = remapHistory(h, ids);
    expect(r.past[0]).toBe(s0);
    expect(r.present.pages.map((p) => p.id)).toEqual(["p1", "P"]);
    expect(r.future[0]!.pages[1]!.id).toBe("P");
    expect(r.future[0]!.pages[1]!.items[0]).toMatchObject({ id: "I", pageId: "P" });
    expect(remapHistory(h, idMapOf({ yok: "x" }))).toBe(h);
  });

  it("ekle → kaydet → geri al → ileri al: çevrilmiş geçmişten doğru fark çıkar (yeniden ekleme yok)", () => {
    const s0 = session([page("p1")]);
    const local = placeFromShelf(s0, { slots: [] } as never, { pageId: "p1", point: { x: 5, y: 5 }, jobId: "j1", variantId: "v1", count: 1, free: true, quantity: 1, placed: 0 }, () => "i_tmp").session;
    expect(diffSession(s0, local).map((o) => o.op)).toEqual(["addItem"]);
    // Sunucu "I" kimliğini verdi; yanıt yeni sunucu durumu olur.
    const ids = idMapOf({ i_tmp: "I" });
    const server = remapSession(local, ids);
    let h = push(createHistory(s0), local, { now: 1 });
    h = { ...remapHistory(h, ids), present: server };
    // Kaydedildikten sonra fark yok.
    expect(diffSession(server, h.present)).toEqual([]);
    // Ctrl+Z: gerçek kimlikle silinir.
    h = undo(h);
    expect(diffSession(server, h.present)).toEqual([{ op: "removeItem", itemId: "I" }]);
    // Ctrl+Y: gerçek kimlikli öğe yeniden eklenir (sunucu yine yeni kimlik verir).
    h = redo(h);
    const back = diffSession(s0, h.present);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ op: "addItem", id: "I", pageId: "p1" });
  });
});
