// @vitest-environment happy-dom
import type { PrintItem, PrintPatchOp, PrintSessionDetail, PrintSessionNotice } from "@tagpress/domain";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch, render, waitFor } from "../../../tezgah/test/render.tsx";
import { PRINT_KEYS } from "./api.ts";
import { addPage, findItem, nudgeItems, placeFromShelf } from "./desk-model.ts";
import type { IdMap } from "./id-map.ts";
import { type SessionEditor, useSessionEditor } from "./useSessionEditor.ts";

/**
 * Oturum düzenleyici kancası (sahte sunucu, SUNUCU-PLANI §10.3): eklemelerin geçici kimliği yanıttaki `ids` ile
 * gerçeğe döner; geçmiş, gönderim sürerken yapılan değişiklik, seçim (onIds) ve geri al / ileri al buna göre çalışır.
 * Bildirimler sürüm artmadan değişince yerel durum bozulmadan görünür.
 */

const item = (id: string, pageId: string, slot: string, x: number, y: number): PrintItem => ({ id, pageId, jobId: "j1", variantId: "v-j1", slotId: slot, xMm: x, yMm: y, rotation: 0, scale: 1, extra: false, manual: false, z: 0 });

function freshSession(): PrintSessionDetail {
  return {
    id: "s1",
    languageId: "dil-1",
    name: "Oturum",
    status: "draft",
    version: 1,
    createdAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
    printedAt: null,
    templateId: "t1",
    sourceSessionId: null,
    jobIds: ["j1"],
    itemSizes: {},
    notices: [],
    pages: [{ id: "p1", sessionId: "s1", templateId: "t1", index: 0, name: "Sayfa 1", copies: 1, kind: "plan", showCellLabels: false, locked: false, items: [item("a", "p1", "s1", 30, 30)] }],
  } as unknown as PrintSessionDetail;
}

let serial = 0;
/** Sahte sunucunun yaması: her eklemeye YENİ kimlik verir (istemci kimliği geçici), aynı yamada geçici kimliği çevirir. */
function applyOps(s: PrintSessionDetail, ops: PrintPatchOp[]): { session: PrintSessionDetail; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const real = (id: string) => ids[id] ?? id;
  let pages = s.pages.map((p) => ({ ...p, items: [...p.items] }));
  for (const o of ops) {
    if (o.op === "removeItem") pages = pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== real(o.itemId)) }));
    else if (o.op === "removePage") pages = pages.filter((p) => p.id !== real(o.pageId));
    else if (o.op === "addPage") {
      const id = `srv-p${++serial}`;
      if (o.id) ids[o.id] = id;
      pages.push({ id, sessionId: s.id, templateId: o.templateId ?? "t1", index: o.index ?? pages.length, name: o.name ?? "", copies: o.copies ?? 1, kind: "manual", showCellLabels: true, locked: false, items: [] });
    } else if (o.op === "addItem") {
      const { op: _op, id: tmp, ...rest } = o;
      const id = `srv-${++serial}`;
      if (tmp) ids[tmp] = id;
      const pageId = real(o.pageId);
      pages = pages.map((p) => (p.id === pageId ? { ...p, items: [...p.items, { rotation: 0, scale: 1, z: 0, extra: false, manual: true, slotId: null, xMm: 0, yMm: 0, variantId: "", ...rest, pageId, id } as PrintItem] } : p));
    } else if (o.op === "moveItem" || o.op === "updateItem") {
      const { op: _op, itemId, ...rest } = o;
      const extra = "pageId" in rest && rest.pageId ? { pageId: real(rest.pageId) } : {};
      pages = pages.map((p) => ({ ...p, items: p.items.map((i) => (i.id === real(itemId) ? ({ ...i, ...rest, ...extra } as PrintItem) : i)) }));
    } else if (o.op === "updatePage") {
      const { op: _op, pageId, ...rest } = o;
      pages = pages.map((p) => (p.id === real(pageId) ? { ...p, ...rest } : p));
    }
  }
  return { session: { ...s, pages, version: s.version + 1 }, ids };
}

let server: PrintSessionDetail;
let gate: Promise<void> | null;
let api: ReturnType<typeof mockFetch>;
const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}"));
const patches = () => api.calls.filter((c) => c.method === "PATCH");
const opsOf = (n: number) => (patches()[n]?.body as { ops: PrintPatchOp[] } | undefined)?.ops ?? [];

beforeEach(() => {
  serial = 0;
  gate = null;
  server = freshSession();
  api = mockFetch({
    "/api/print/sessions/s1": async (_u: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        if (gate) await gate;
        const r = applyOps(server, body(init).ops);
        server = r.session;
        return { session: server, warnings: [], undo: null, ...(Object.keys(r.ids).length ? { ids: r.ids } : {}) };
      }
      return server;
    },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

let ed: SessionEditor;
let qc: QueryClient;
const seen: IdMap[] = [];
function Probe() {
  ed = useSessionEditor("s1", { onIds: (ids) => seen.push(ids) });
  qc = useQueryClient();
  return null;
}

async function open() {
  seen.length = 0;
  const r = await render(<Probe />);
  await waitFor(() => ed.session);
  return r;
}

/** Raftan p1'e serbest konumla bir etiket (geçici kimlik `tmp`). */
const placed = (s: PrintSessionDetail, tmp: string, pageId = "p1") =>
  placeFromShelf(s, { slots: [] } as never, { pageId, point: { x: 100, y: 100 }, jobId: "j1", variantId: "v-j1", count: 1, free: true, quantity: 1, placed: 0 }, () => tmp).session;
const commit = async (fn: (s: PrintSessionDetail) => PrintSessionDetail, key?: string) => {
  await act(async () => ed.commit(fn(ed.session!), key));
};

describe("useSessionEditor: geçici kimlik → gerçek kimlik", () => {
  it("ekle → kaydet: geçmiş ve seçim gerçek kimliğe döner; sonraki fark aynı öğeyi yeniden eklemez; geri al / ileri al", async () => {
    const r = await open();
    await commit((s) => placed(s, "i_tmp"));
    await waitFor(() => patches().length === 1);
    expect(opsOf(0)).toEqual([expect.objectContaining({ op: "addItem", id: "i_tmp", pageId: "p1" })]);
    await waitFor(() => ed.session && findItem(ed.session, "srv-1"));
    expect(findItem(ed.session!, "i_tmp")).toBeNull();
    expect(seen.map((m) => [...m])).toEqual([[["i_tmp", "srv-1"]]]);

    // İt: gerçek kimlikle taşıma (silip yeniden ekleme değil).
    await commit((s) => nudgeItems(s, new Set(["srv-1"]), 1, 0, new Map()), "nudge");
    await waitFor(() => patches().length === 2);
    expect(opsOf(1)).toEqual([expect.objectContaining({ op: "moveItem", itemId: "srv-1", xMm: 101 })]);

    // Ctrl+Z iki kez: taşıma geri, sonra ekleme geri (gerçek kimlikle silinir).
    await act(async () => ed.undo());
    await waitFor(() => patches().length === 3);
    expect(opsOf(2)).toEqual([expect.objectContaining({ op: "moveItem", itemId: "srv-1", xMm: 100 })]);
    await act(async () => ed.undo());
    await waitFor(() => patches().length === 4);
    expect(opsOf(3)).toEqual([{ op: "removeItem", itemId: "srv-1" }]);

    // Ctrl+Y iki kez: öğe yeniden eklenir (sunucu yeni kimlik verir), sonra o yeni kimlikle taşınır.
    await act(async () => ed.redo());
    await waitFor(() => patches().length === 5);
    expect(opsOf(4)).toEqual([expect.objectContaining({ op: "addItem", id: "srv-1" })]);
    await waitFor(() => ed.session && findItem(ed.session, "srv-2"));
    await act(async () => ed.redo());
    await waitFor(() => patches().length === 6);
    expect(opsOf(5)).toEqual([expect.objectContaining({ op: "moveItem", itemId: "srv-2", xMm: 101 })]);
    expect(server.pages[0]!.items.map((i) => i.id)).toEqual(["a", "srv-2"]);
    await r.unmount();
  });

  it("gönderim sürerken yapılan değişiklik de çevrilir: sıradaki yama taşımadır", async () => {
    const r = await open();
    let release!: () => void;
    gate = new Promise((res) => (release = res));
    await commit((s) => placed(s, "i_tmp"));
    await waitFor(() => patches().length === 1);
    // Yanıt gelmeden: geçici kimlikli öğe itilir.
    await commit((s) => nudgeItems(s, new Set(["i_tmp"]), 0, 2, new Map()), "nudge");
    expect(ed.saving).toBe(true);
    gate = null;
    await act(async () => release());
    await waitFor(() => patches().length === 2);
    expect(opsOf(1)).toEqual([expect.objectContaining({ op: "moveItem", itemId: "srv-1", yMm: 102 })]);
    await waitFor(() => !ed.saving && ed.session === ed.serverSession);
    expect(server.pages[0]!.items).toHaveLength(2);
    await r.unmount();
  });

  it("yeni sayfa ve üstüne konan etiket tek yamada: sayfa da öğe de gerçek kimlik alır", async () => {
    const r = await open();
    await commit((s) => {
      const p = addPage(s, "t1", { id: "p_tmp" });
      return placed(p.session, "i_tmp", "p_tmp");
    });
    await waitFor(() => patches().length === 1);
    expect(opsOf(0).map((o) => o.op)).toEqual(["addPage", "updatePage", "addItem"]);
    await waitFor(() => ed.session?.pages.some((p) => p.id === "srv-p1"));
    const page = ed.session!.pages.find((p) => p.id === "srv-p1")!;
    expect(page.items.map((i) => [i.id, i.pageId])).toEqual([["srv-2", "srv-p1"]]);
    // Sayfaya sonraki değişiklik gerçek kimlikle.
    await commit((s) => ({ ...s, pages: s.pages.map((p) => (p.id === "srv-p1" ? { ...p, copies: 3 } : p)) }));
    await waitFor(() => patches().length === 2);
    expect(opsOf(1)).toEqual([{ op: "updatePage", pageId: "srv-p1", copies: 3 }]);
    await r.unmount();
  });

  it("eski çizimden gelen değişiklik (yanıttan sonra, geçici kimlikle) de çevrilir", async () => {
    const r = await open();
    await commit((s) => placed(s, "i_tmp"));
    const stale = ed.session!; // geçici kimlikli hâl
    await waitFor(() => ed.session && findItem(ed.session, "srv-1"));
    await act(async () => ed.commit(nudgeItems(stale, new Set(["i_tmp"]), 3, 0, new Map())));
    await waitFor(() => patches().length === 2);
    expect(opsOf(1)).toEqual([expect.objectContaining({ op: "moveItem", itemId: "srv-1", xMm: 103 })]);
    await r.unmount();
  });
});

describe("useSessionEditor: bildirimler", () => {
  const STALE: PrintSessionNotice = { code: "plan-stale", message: "yedek", params: { sheets: 7, replanSheets: 4 } };

  it("sürüm artmadan gelen bildirim görünür; yerel durum ve geçmiş bozulmaz", async () => {
    const r = await open();
    expect(ed.notices).toEqual([]);
    await commit((s) => ({ ...s, name: "Yeni ad" }));
    await waitFor(() => patches().length === 1 && !ed.saving);
    const before = ed.session;
    expect(ed.canUndo).toBe(true);
    // Kesim değişti: sunucu yalnız bildirimi ekler, sürüm aynı; canlı eşitleme oturum sorgusunu yeniden çeker.
    server = { ...server, notices: [STALE] };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: [PRINT_KEYS.session] });
    });
    await waitFor(() => ed.notices.length === 1);
    expect(ed.notices[0]!.code).toBe("plan-stale");
    expect(ed.session).toBe(before);
    expect(ed.canUndo).toBe(true);
    // Bildirim kalkınca da görünür (yine sürüm aynı).
    server = { ...server, notices: [] };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: [PRINT_KEYS.session] });
    });
    await waitFor(() => ed.notices.length === 0);
    expect(patches()).toHaveLength(1);
    await r.unmount();
  });
});
