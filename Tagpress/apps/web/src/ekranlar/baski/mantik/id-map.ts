import type { PrintSessionDetail } from "@tagpress/domain";
import type { History } from "../../duzelt/mantik/adjust-history.ts";

/**
 * Geçici kimlik → gerçek kimlik çevirisi — SAF (SUNUCU-PLANI §10.3). İstemcinin `addPage`/`addItem`'a verdiği kimlik
 * her zaman geçicidir; sunucu her eklemeye yeni kimlik verir ve yama yanıtında `ids` ile eşlemeyi döner. Masa yerel
 * durumunu, geri al / ileri al geçmişini, bekleyen değişiklikleri ve seçimi bununla çevirir; çevrilmezse sonraki fark
 * aynı sayfayı/öğeyi yeniden ekler (geçici kimlik sunucuda yok).
 *
 * Değişmeyen değer aynı başvuruyla döner (masadaki `present !== base` gibi kimlik karşılaştırmaları bozulmasın).
 */

export type IdMap = ReadonlyMap<string, string>;

const NONE: IdMap = new Map();

/** Yanıttaki `ids` (düz nesne) → eşleme; kendi alanları dışında hiçbir şey okunmaz, kimliği değişmeyenler atlanır. */
export function idMapOf(ids: Readonly<Record<string, string>> | null | undefined): IdMap {
  if (!ids) return NONE;
  const out = new Map<string, string>();
  for (const [from, to] of Object.entries(ids)) if (typeof to === "string" && to && from !== to) out.set(from, to);
  return out.size ? out : NONE;
}

export function remapId(id: string, ids: IdMap): string {
  return ids.get(id) ?? id;
}

/** Kimlik listesi (seçim): değişen yoksa aynı dizi. */
export function remapIds<T extends readonly string[]>(list: T, ids: IdMap): T {
  if (!ids.size || !list.some((x) => ids.has(x))) return list;
  return list.map((x) => ids.get(x) ?? x) as unknown as T;
}

/** Anahtarları yerinde çevirir (silinen sayfa → geri alma anahtarı gibi). */
export function remapKeys<V>(m: Map<string, V>, ids: IdMap): void {
  if (!ids.size) return;
  for (const [from, to] of ids) {
    if (!m.has(from)) continue;
    m.set(to, m.get(from)!);
    m.delete(from);
  }
}

/** Oturum durumu: sayfa `id`'si, öğe `id`'si ve öğenin sayfası (`pageId`). Değişen yoksa aynı nesne. */
export function remapSession<S extends Pick<PrintSessionDetail, "pages">>(s: S, ids: IdMap): S {
  if (!ids.size) return s;
  let changed = false;
  const pages = s.pages.map((p) => {
    const id = ids.get(p.id) ?? p.id;
    let itemsChanged = false;
    const items = p.items.map((i) => {
      const iid = ids.get(i.id) ?? i.id;
      const pageId = ids.get(i.pageId) ?? i.pageId;
      if (iid === i.id && pageId === i.pageId) return i;
      itemsChanged = true;
      return { ...i, id: iid, pageId };
    });
    if (id === p.id && !itemsChanged) return p;
    changed = true;
    return { ...p, id, items: itemsChanged ? items : p.items };
  });
  return changed ? { ...s, pages } : s;
}

/** Geri al / ileri al geçmişinin bütün durumları (geçmiş, şimdiki, gelecek). Değişen yoksa aynı geçmiş. */
export function remapHistory<S extends Pick<PrintSessionDetail, "pages">>(h: History<S>, ids: IdMap): History<S> {
  if (!ids.size) return h;
  let changed = false;
  const map = (s: S) => {
    const n = remapSession(s, ids);
    if (n !== s) changed = true;
    return n;
  };
  const past = h.past.map(map);
  const present = map(h.present);
  const future = h.future.map(map);
  return changed ? { ...h, past, present, future } : h;
}
