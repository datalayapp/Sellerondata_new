import type { PrintSessionDetail as PrintSessionFull, PrintSessionNotice } from "@tagpress/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { i18n } from "../../../i18n/index.ts";
import { serverText, undoText } from "../../../i18n/sunucu.ts";
import { ApiFailure } from "../../../lib/api.ts";
import { useToast } from "../../../lib/notify.ts";
import { canRedo, canUndo, createHistory, type History, push, redo, undo } from "../../duzelt/mantik/adjust-history.ts";
import { PRINT_KEYS, printApi } from "./api.ts";
import { diffSession } from "./desk-model.ts";
import { type IdMap, idMapOf, remapHistory, remapKeys, remapSession } from "./id-map.ts";

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts) as string;

/** Son düzenlemeden bu kadar sonra yama gönderilir (ard arda ok tuşları tek istekte). */
const FLUSH_MS = 250;

const NO_NOTICES: PrintSessionNotice[] = [];

export interface SessionEditorOptions {
  /**
   * Yama yanıtı eklemelerin geçici kimliklerini gerçeğe çevirdi (`ids`): bileşen kendi tuttuğu kimlikleri (seçim,
   * etkin sayfa, odak) aynı eşlemeyle çevirir. Yerel durum ve geçmiş aynı güncellemede çevrilir (tek çizim).
   */
  onIds?(ids: IdMap): void;
}

/**
 * Oturum düzenleyici: yerel durum (geri al / ileri al geçmişiyle) + sunucuya toplu yama.
 *
 * - Her yerel değişiklik geçmişe bir adımdır; sürükleme bırakılınca tek adım, ok tuşları 0,5 sn içinde birleşir.
 * - Sunucuya `diffSession(sunucudaki, yerel)` gider (`version` ile). Yanıt yeni "sunucudaki" olur; o arada yeni yerel
 *   değişiklik yoksa yerel durum da yanıtla değişir (sunucunun koyduğu `manual`, sayfa adları…).
 * - Eklemenin kimliği geçicidir: yanıttaki `ids` (geçici → gerçek) geçmişin bütün durumlarına, gönderim sürerken
 *   yapılan değişikliklere, silinen sayfa anahtarlarına ve (`onIds` ile) bileşenin seçimine uygulanır; eşleme oturum
 *   boyunca saklanır ki yanıttan hemen sonra eski çizimden gelen bir değişiklik de çevrilsin.
 * - 409 (sürüm çakışması): son hâl yüklenir, geçmiş sıfırlanır, kullanıcıya söylenir.
 * - Dışarıdan gelen değişiklik (başka sekme, yeniden planlama): bekleyen yerel değişiklik yoksa benimsenir.
 * - Bildirimler (`notices`) sürümden bağımsızdır (kesim değişince sürüm artmadan `plan-stale` gelebilir): ayrı döner,
 *   sunucudan gelen en son hâlden okunur; yerel durum ve geçmiş bozulmaz.
 */
export function useSessionEditor(sessionId: string | null, opts: SessionEditorOptions = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: [PRINT_KEYS.session, sessionId],
    queryFn: ({ signal }) => printApi.session(sessionId!, signal),
    enabled: !!sessionId,
  });
  const onIds = useRef(opts.onIds);
  onIds.current = opts.onIds;

  const [hist, setHist] = useState<History<PrintSessionFull> | null>(null);
  const histRef = useRef(hist);
  histRef.current = hist;
  const base = useRef<PrintSessionFull | null>(null);
  const inflight = useRef(false);
  /** Bu oturumda silinen sayfalar → sunucunun geri alma anahtarı. */
  const removedPages = useRef(new Map<string, string>());
  /** Bu oturumda sunucunun verdiği gerçek kimlikler (geçici → gerçek). */
  const idMap = useRef(new Map<string, string>());
  const timer = useRef<number | undefined>(undefined);
  /** Bekleyen fark Ctrl+Z / Ctrl+Y'den mi: öyleyse "N sayfa silindi — Geri al" bildirimi gösterilmez (kullanıcı zaten geri alıyor). */
  const fromHistory = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((s: PrintSessionFull | null) => {
    base.current = s;
    setHist(s ? createHistory(s) : null);
  }, []);

  // Oturum değişince sıfırdan.
  useEffect(() => {
    window.clearTimeout(timer.current);
    base.current = null;
    removedPages.current.clear();
    idMap.current.clear();
    setHist(null);
    setError(null);
  }, [sessionId]);

  // Sunucudan gelen hâl: ilk yükleme ya da dışarıdan değişiklik.
  useEffect(() => {
    const s = q.data;
    if (!s || s.id !== sessionId) return;
    const b = base.current;
    if (!b || !histRef.current) {
      reset(s);
      return;
    }
    if (s.version <= b.version) return;
    const dirty = histRef.current.present !== b;
    if (inflight.current || dirty) return; // yerel değişiklik gönderilince yeniden okunur
    base.current = s;
    setHist((h) => (h ? { ...h, present: s } : createHistory(s)));
  }, [q.data, sessionId, reset]);

  const refetchAndReset = useCallback(async () => {
    if (!sessionId) return;
    const fresh = await printApi.session(sessionId);
    qc.setQueryData([PRINT_KEYS.session, sessionId], fresh);
    reset(fresh);
  }, [qc, reset, sessionId]);

  const flush = useCallback(async () => {
    timer.current = undefined;
    const h = histRef.current;
    const b = base.current;
    if (!h || !b || !sessionId) return;
    if (inflight.current) return;
    const sent = h.present;
    let ops = diffSession(b, sent);
    if (!ops.length) return;
    const quiet = fromHistory.current;
    fromHistory.current = false;
    inflight.current = true;
    setSaving(true);
    try {
      // Silinmiş sayfa geri gelecekse (Ctrl+Z) aynı kimlikle yeniden eklenemez: sunucunun geri alma anahtarıyla
      // (öğeleriyle birlikte) geri getirilir, sonra kalan fark gönderilir.
      const tokens = new Set(ops.flatMap((o) => (o.op === "addPage" && o.id && removedPages.current.has(o.id) ? [removedPages.current.get(o.id)!] : [])));
      if (tokens.size) {
        for (const t of tokens) await printApi.undo(t);
        for (const [pid, t] of removedPages.current) if (tokens.has(t)) removedPages.current.delete(pid);
        const fresh = await printApi.session(sessionId);
        base.current = fresh;
        ops = diffSession(fresh, sent);
        if (!ops.length) {
          qc.setQueryData([PRINT_KEYS.session, sessionId], fresh);
          setHist((cur) => (cur && cur.present === sent ? { ...cur, present: fresh } : cur));
          return;
        }
      }
      const r = await printApi.patchSession(sessionId, { version: (base.current ?? b).version, ops });
      if (r.undo) for (const o of ops) if (o.op === "removePage") removedPages.current.set(o.pageId, r.undo.undoToken);
      // Geçici kimlik → gerçek: geçmişin her durumu, gönderim sürerken yapılan değişiklik ve seçim aynı çizimde çevrilir.
      const ids = idMapOf(r.ids);
      if (ids.size) {
        // Zincir kısalır (geçici → eski gerçek → yeni gerçek: ileri alınan ekleme yeniden kimlik alır).
        for (const [from, to] of idMap.current) if (ids.has(to)) idMap.current.set(from, ids.get(to)!);
        for (const [from, to] of ids) idMap.current.set(from, to);
        remapKeys(removedPages.current, ids);
      }
      base.current = r.session;
      qc.setQueryData([PRINT_KEYS.session, sessionId], r.session);
      setHist((cur) => {
        if (!cur) return cur;
        const h = remapHistory(cur, ids);
        return cur.present === sent ? { ...h, present: r.session } : h;
      });
      if (ids.size) onIds.current?.(ids);
      setError(null);
      for (const w of r.warnings) toast({ tone: "default", message: w });
      if (r.undo && !quiet) {
        const token = r.undo.undoToken;
        toast({
          message: undoText(r.undo),
          action: {
            label: t("printDesk:editor.undo"),
            run: async () => {
              try {
                await printApi.undo(token);
                await refetchAndReset();
              } catch (e) {
                toast({ tone: "error", message: t("printDesk:editor.undoFailed", { detail: serverText(e) }) });
              }
            },
          },
        });
      }
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.shelf] });
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409 && (e.body.code === "version-conflict" || e.body.code === "printed")) {
        toast({ tone: "error", message: t("printDesk:editor.conflict") });
        try {
          await refetchAndReset();
        } catch (e2) {
          setError(serverText(e2));
        }
      } else {
        // Sunucu reddetti: yerel durum sunucudakine döner (geçmişte adım olarak kalır, ileri alınabilir).
        const msg = serverText(e);
        setError(msg);
        toast({ tone: "error", message: t("printDesk:editor.saveFailed", { detail: msg }) });
        const back = base.current;
        if (back) setHist((cur) => (cur ? push(cur, back, { now: Date.now() }) : cur));
      }
    } finally {
      inflight.current = false;
      setSaving(false);
      // Gönderirken yeni değişiklik olduysa sıradaki yama.
      const now = histRef.current;
      if (now && base.current && now.present !== sent && now.present !== base.current) schedule();
    }
  }, [qc, refetchAndReset, sessionId, toast]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  function schedule() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushRef.current(), FLUSH_MS);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Sayfadan ayrılırken bekleyen yamayı hemen gönder.
  useEffect(() => {
    const on = () => {
      if (timer.current !== undefined) void flush();
    };
    window.addEventListener("pagehide", on);
    return () => {
      window.removeEventListener("pagehide", on);
      on();
    };
  }, [flush]);

  /** Yerel değişiklik: geçmişe yaz ve yamayı zamanla. `key`: ard arda aynı işlem (ok tuşu) tek adımda birleşir. */
  const commit = useCallback((next: PrintSessionFull, key?: string) => {
    fromHistory.current = false;
    // Yanıttan hemen sonra eski çizimden hesaplanan değişiklik geçici kimlik taşıyabilir.
    const n = remapSession(next, idMap.current);
    setHist((h) => (h ? push(h, n, { now: Date.now(), key }) : h));
    schedule();
  }, []);

  /** Sunucunun döndürdüğü yeni hâl (yeniden planlama, şablon değiştirme): geri alınabilir adım olarak benimsenir. */
  const adopt = useCallback((s: PrintSessionFull) => {
    base.current = s;
    qc.setQueryData([PRINT_KEYS.session, s.id], s);
    setHist((h) => (h ? push(h, s, { now: Date.now() }) : createHistory(s)));
  }, [qc]);

  const doUndo = useCallback(() => {
    fromHistory.current = true;
    setHist((h) => (h && canUndo(h) ? undo(h) : h));
    schedule();
  }, []);
  const doRedo = useCallback(() => {
    fromHistory.current = true;
    setHist((h) => (h && canRedo(h) ? redo(h) : h));
    schedule();
  }, []);

  /** Sunucuya gidecek değişiklik kalmadıysa sunucudaki sürüm (yeniden planlama / basıldı için). Bekleyen varsa önce gönderir. */
  const settle = useCallback(async (): Promise<number | null> => {
    window.clearTimeout(timer.current);
    for (let i = 0; i < 20 && inflight.current; i++) await new Promise((r) => window.setTimeout(r, 100));
    await flush();
    for (let i = 0; i < 20 && inflight.current; i++) await new Promise((r) => window.setTimeout(r, 100));
    return base.current?.version ?? null;
  }, [flush]);

  // Bildirimler: sunucudan gelen en son hâl (sorgu verisi; yama yanıtı da oraya yazılır), yoksa sunucudaki.
  const b = base.current;
  const latest = q.data && q.data.id === sessionId && (!b || q.data.version >= b.version) ? q.data : b;

  return {
    query: q,
    session: hist?.present ?? null,
    serverSession: base.current,
    /** Oturum bildirimleri (`plan-stale`, `printed-old-scale`, `sticker-small-text`); sürüm artmadan da değişebilir. */
    notices: hist ? (latest?.notices ?? NO_NOTICES) : NO_NOTICES,
    canUndo: !!hist && canUndo(hist),
    canRedo: !!hist && canRedo(hist),
    commit,
    adopt,
    undo: doUndo,
    redo: doRedo,
    settle,
    saving,
    error,
    reload: refetchAndReset,
  };
}

export type SessionEditor = ReturnType<typeof useSessionEditor>;
