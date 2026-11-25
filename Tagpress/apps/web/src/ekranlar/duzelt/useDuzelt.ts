import {
  type AdjustCheckResponse,
  type AdjustRelayoutResponse,
  type AdjustSaveResponse,
  API,
  boxCenter,
  type CenterAxis,
  type CenterTarget,
  editedInkLayout,
  editsKey,
  type FontSpan,
  IDENTITY_ADJUST,
  type Issue,
  type VariantAdjust,
  type VariantEditModel,
} from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { commonFont, sameEdits, withEdits, withLineFont, withoutSpan } from "./mantik/adjust-edit.ts";
import { canRedo, canUndo, createHistory, type History, push, redo, undo } from "./mantik/adjust-history.ts";
import { sameAdjust } from "./mantik/adjust-math.ts";
import {
  centerSelection,
  cycleSel,
  nudgeSelection,
  type Sel,
  selectedLines,
  selectionBox,
  selIndices,
  singleLine,
  stepSelectionScale,
  stepSelectionStroke,
} from "./mantik/adjust-select.ts";
import {
  applyDraft,
  BASE_TEXT_KEY,
  beginEditing,
  canSave,
  checkBody,
  checkView,
  editDraft,
  type Editing,
  editRange,
  fontPlan,
  isDirty,
  mergeKey,
  relayoutBody,
  saveBody,
} from "./mantik/adjust-session.ts";
import { sanitizeSvgInner } from "./mantik/adjust-svg.ts";
import { invalidateWork, useJobOps } from "../uretim/mantik/data.ts";
import { useConfirm, useLeaveGuard, useToast } from "../../tezgah/index.ts";
import { withOffset } from "./konum.ts";

/** `persist` sonucu: kaydedildi, kaydedilecek bir şey yoktu, kayıt olmadı (hata ya da geçersiz taslak). */
export type PersistResult = "saved" | "clean" | "failed";

/**
 * Düzelt ekranının durumu: geçmiş (geri al / ileri al), seçim, sürükleme ara değeri, yerinde metin düzenleme,
 * otomatik denetim, yazı katmanı (sunucunun SVG'si), kaydet / kaldır / çık. Kararların hepsi saf modüllerde
 * (`mantik/adjust-*.ts`); burası yalnız onları React durumuna ve sunucu uçlarına bağlar.
 *
 * Üç yerde aynı çekirdek: `#/duzelt` sayfası ve büyük pencere (Kaydet / Vazgeç; `onLeave(saved)`), sağ paneldeki küçük
 * tezgâh (`persist` ile kendiliğinden kayıt; `guard: false`, gezinme bekçisi yok, bekleyen kayıt ayrılırken yazılır).
 */
export function useDuzelt({ variantId, model, onLeave, guard: guardOn = true }: { variantId: string; model: VariantEditModel; onLeave(saved: boolean): void; guard?: boolean }) {
  const { t } = useTranslation("adjust");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { undo: undoJob } = useJobOps();

  // Geçmiş: bırakılmış durumlar. `live` yalnız sürüklerken ara değeri tutar (sunucuya istek gitmez).
  const [hist, setHist] = useState<History<VariantAdjust>>(() => createHistory(model.adjust ?? IDENTITY_ADJUST));
  const [live, setLive] = useState<VariantAdjust | null>(null);
  const [sel, setSelRaw] = useState<Sel>(null);
  const [target, setTarget] = useState<CenterTarget>("textCenter");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [check, setCheck] = useState<AdjustCheckResponse | null>(null);
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // Sunucudaki son düzeltme: açılıştaki ya da son başarılı kaydın (kendiliğinden kayıtta "kaydedilmemiş" buna göre).
  const [saved, setSavedRaw] = useState<VariantAdjust | null>(model.adjust ?? null);
  const savedRef = useRef(saved);
  const [saveError, setSaveError] = useState<unknown>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const markSaved = (a: VariantAdjust | null) => {
    savedRef.current = a;
    setSavedRaw(a);
  };
  const cur = live ?? hist.present;

  const histRef = useRef(hist);
  histRef.current = hist;
  const curRef = useRef(cur);
  curRef.current = cur;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // ---- türetilenler (tasarım px)
  const layout = useMemo(() => {
    const e = editedInkLayout({ ink: model.ink, origin: model.origin, lines: model.lines }, cur.edits);
    return { ...e, strokePx: model.strokePx, strokeAlign: model.strokeAlign };
  }, [model, cur.edits]);
  const lineCount = layout.lines.length;
  const selV: Sel = selIndices(sel, lineCount);
  const single = singleLine(selV, lineCount);
  const selBox = selectionBox(layout, cur, selV);
  const targets = useMemo(() => ({ textCenter: model.centers.textCenter, area: model.centers.area, cut: model.centers.cut }), [model]);
  const goal = targets[target];
  const baseFont = (i: number) => model.lines[i]?.fontId;
  const fontTargets = selectedLines(selV, lineCount);
  const shownFont = commonFont(cur, fontTargets, baseFont);
  const canEditText = !!model.fonts;
  const dirty = isDirty(cur, saved) || (!!editing && editing.draft !== editing.current);
  /** Bırakılmış (geçmişe yazılmış) ama henüz kaydedilmemiş değişiklik var mı (sürükleme ara değeri ve taslak hariç). */
  const unsaved = isDirty(hist.present, saved);
  // Üst menü, Alt 1–5, tarayıcı geri ve sekme kapatma: kaydedilmemiş değişiklik sorulur (Esc / Vazgeç kendi sorar;
  // ondan sonraki dönüş ve kayıttan sonraki dönüş `go(…, replace)` ile bekçiye takılmaz, yine de `pass()` verilir).
  const guard = useLeaveGuard(guardOn && dirty, { title: t("leave.title"), body: t("leave.body"), confirm: t("leave.confirm") });
  const leave = (didSave: boolean) => {
    guard.pass();
    onLeave(didSave);
  };

  // ---- yazı katmanı: düzeltmesiz katman (GET) ya da motorun düzenlenmiş katmanı; düzenlemenin notları
  const textKey = editsKey(cur.edits);
  const [baseSvg, setBaseSvg] = useState<string | null | undefined>(undefined); // undefined: yükleniyor, null: gömülemedi
  const [editedSvgs, setEditedSvgs] = useState<Record<string, string | null>>({});
  const [notes, setNotes] = useState<Record<string, Issue[]>>({});
  const pending = useRef(new Set<string>());
  const textUrl = model.textLayerUrl;
  useEffect(() => {
    if (!textUrl) {
      setBaseSvg(null);
      return;
    }
    const ac = new AbortController();
    fetch(textUrl, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((txt) => setBaseSvg(sanitizeSvgInner(txt)))
      .catch(() => {
        if (!ac.signal.aborted) setBaseSvg(null);
      });
    return () => ac.abort();
  }, [textUrl]);
  const remember = (r: AdjustRelayoutResponse, alsoKey?: string) => {
    const inner = sanitizeSvgInner(r.textSvg);
    const k = editsKey(r.edits);
    setEditedSvgs((m) => ({ ...m, [k]: inner, ...(alsoKey ? { [alsoKey]: inner } : {}) }));
    setNotes((m) => ({ ...m, [k]: r.issues, ...(alsoKey ? { [alsoKey]: r.issues } : {}) }));
  };
  // Düzenlemenin katmanı elde yoksa (kayıtlı düzenlemeyle açılış, geri al) motordan iste.
  useEffect(() => {
    if (textKey === BASE_TEXT_KEY || textKey in editedSvgs || pending.current.has(textKey)) return;
    pending.current.add(textKey);
    api
      .post<AdjustRelayoutResponse>(path(API.variantEditRelayout, { id: variantId }), relayoutBody(hist.present))
      .then((r) => remember(r, textKey))
      .catch(() => setEditedSvgs((m) => ({ ...m, [textKey]: null })))
      .finally(() => pending.current.delete(textKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- istek yalnız katman anahtarı ya da düzenlemeler değişince; remember ve hist.present her çizimde yeni, aynı katman yeniden istenmesin
  }, [variantId, textKey, editedSvgs, hist.present.edits]);
  // Gösterilen katman: güncel düzenlemeninki; henüz gelmediyse son gösterilen (titreme olmasın).
  const last = useRef<string | null | undefined>(undefined);
  const wanted = textKey === BASE_TEXT_KEY ? baseSvg : editedSvgs[textKey];
  const inner = wanted !== undefined ? wanted : last.current !== undefined ? last.current : baseSvg;
  last.current = inner;

  // ---- otomatik denetim (bırakınca / tuş dizisi bitince; kaydetmeyi engellemez)
  const commit = () => setRev((n) => n + 1);
  useEffect(() => {
    if (rev === 0) return;
    const ac = new AbortController();
    const tm = window.setTimeout(async () => {
      try {
        const r = await api.post<AdjustCheckResponse>(path(API.variantAdjustCheck, { id: variantId }), checkBody(curRef.current));
        if (!ac.signal.aborted) setCheck(r);
      } catch {
        if (!ac.signal.aborted) setCheck(null);
      }
    }, 150);
    return () => {
      ac.abort();
      window.clearTimeout(tm);
    };
  }, [rev, variantId]);
  const view = checkView(check, cur, notes[textKey] ?? []);

  // ---- geçmiş
  /** Yeni adım. `key` verilirse aynı anahtarlı hızlı işlemler tek adımda birleşir (ok tuşu, boyut, kalınlık). */
  const apply = (fn: (a: VariantAdjust) => VariantAdjust, key?: string) => {
    setHist((h) => push(h, fn(h.present), { now: Date.now(), key: mergeKey(key, selV), eq: sameAdjust }));
    commit();
  };
  /** Sürüklemenin sonucu tek adım. */
  const settle = (next: VariantAdjust | null) => {
    setLive(null);
    if (!next) return;
    setHist((h) => push(h, next, { now: Date.now(), eq: sameAdjust }));
    commit();
  };

  // ---- metin ve font (motorla ölçülür; AI yok)
  /** Süren motor ölçümü (metin, font): kendiliğinden kayıt önce onun sonucunu bekler. */
  const inflight = useRef<Promise<VariantAdjust | null> | null>(null);
  const relayoutTo = (next: VariantAdjust): Promise<VariantAdjust | null> => {
    const p = measure(next);
    inflight.current = p;
    void p.finally(() => {
      if (inflight.current === p) inflight.current = null;
    });
    return p;
  };
  const measure = async (next: VariantAdjust): Promise<VariantAdjust | null> => {
    if (sameEdits(next, histRef.current.present)) return histRef.current.present;
    setBusy(true);
    try {
      const r = await api.post<AdjustRelayoutResponse>(path(API.variantEditRelayout, { id: variantId }), relayoutBody(next));
      remember(r);
      const result = withEdits(histRef.current.present, r.edits);
      setHist((h) => push(h, withEdits(h.present, r.edits), { now: Date.now(), eq: sameAdjust }));
      commit();
      return result;
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
      return null;
    } finally {
      setBusy(false);
    }
  };
  const setSel = (s: Sel) => setSelRaw(s);
  const startEdit = (i: number): boolean => {
    if (!layout.lines[i]) return false;
    if (!canEditText) {
      toast({ message: t("text.noEngine") });
      return false;
    }
    setSelRaw([i]);
    setEditing(beginEditing(layout.lines, i));
    return true;
  };
  const setDraft = (draft: string, start: number, end: number) => setEditing((ed) => (ed ? editDraft(ed, draft, start, end) : ed));
  const setRange = (start: number, end: number) => setEditing((ed) => (ed ? editRange(ed, start, end) : ed));
  const cancelEdit = () => setEditing(null);
  /** Taslağı yazar; `font` verilirse taslakta seçili parçanın (ya da bütün satırın) fontu da (tek adım). */
  const commitEdit = async (font?: string): Promise<VariantAdjust | null> => {
    const ed = editingRef.current;
    if (!ed) return null;
    setEditing(null);
    editingRef.current = null;
    const r = applyDraft(histRef.current.present, ed, model.lines[ed.index]?.text ?? ed.current, font, baseFont);
    if (!r.ok) {
      toast({ tone: "error", message: t("text.empty") });
      return null;
    }
    return relayoutTo(r.next);
  };
  const chooseFont = (fontId: string) => {
    if (!fontId) return;
    const plan = fontPlan(editingRef.current);
    if (plan === "draft-with-font") {
      void commitEdit(fontId);
      return;
    }
    const targetsNow = fontTargets;
    void (async () => {
      const base = plan === "draft-then-lines" ? await commitEdit() : null;
      await relayoutTo(withLineFont(base ?? histRef.current.present, targetsNow, fontId, baseFont));
    })();
  };
  const removeSpan = (index: number, span: FontSpan) => void relayoutTo(withoutSpan(histRef.current.present, index, span));

  // ---- seçime uygulanan işlemler
  const center = (axis: CenterAxis) => apply((a) => centerSelection(layout, targets, a, selV, { axis, target }));
  const scale = (step: number) => apply((a) => stepSelectionScale(layout, a, selV, step), "boyut");
  const stroke = (step: number) => apply((a) => stepSelectionStroke(a, selV, step), "kalinlik");
  const nudge = (key: string, shift: boolean, step: number) => apply((a) => nudgeSelection(a, selV, key, shift, step), "ok");
  const setOffset = (axis: "x" | "y", v: number) => apply((a) => withOffset(a, selV, axis, v));
  const reset = () => apply(() => IDENTITY_ADJUST);
  const cycle = (back: boolean) => setSelRaw(cycleSel(selV, lineCount, back));
  const doUndo = () => {
    setHist(undo);
    commit();
  };
  const doRedo = () => {
    setHist(redo);
    commit();
  };

  // ---- kaydet, kaldır, çık
  const save = async () => {
    if (saving) return;
    let adjust = curRef.current;
    if (editingRef.current) {
      const r = await commitEdit();
      if (r) adjust = r;
    }
    if (!isDirty(adjust, savedRef.current)) return;
    setSaving(true);
    try {
      const r = await api.put<AdjustSaveResponse>(path(API.variantAdjust, { id: variantId }), saveBody(adjust));
      markSaved(adjust);
      invalidateWork(qc);
      toast({ tone: "success", message: t("toast.saved"), action: { label: t("toast.undo"), run: () => undoJob(r.undo.undoToken) } });
      leave(true);
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!savedRef.current || saving) return;
    const ok = await confirm({ title: t("remove.title"), body: t("remove.body"), confirmLabel: t("remove.confirm"), tone: "danger" });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await api.del<AdjustSaveResponse>(path(API.variantAdjust, { id: variantId }));
      invalidateWork(qc);
      markSaved(null);
      toast({ message: t("toast.removed"), action: { label: t("toast.undo"), run: () => undoJob(r.undo.undoToken) } });
      leave(true);
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    } finally {
      setSaving(false);
    }
  };
  /** Vazgeç: kaydedilmemiş değişiklik varsa önce sorar. */
  const exit = async () => {
    if (saving) return;
    if (dirty) {
      const ok = await confirm({ title: t("leave.title"), body: t("leave.body"), confirmLabel: t("leave.confirm"), tone: "danger" });
      if (!ok) return;
    }
    leave(false);
  };

  // ---- kendiliğinden kayıt (küçük tezgâh)
  /**
   * Bırakılmış son durumu sessizce kaydeder (bildirim yok, ekrandan çıkılmaz). `commitDraft`: açık metin taslağı önce
   * motorla yazılır. Kayıtlar sıraya girer: aynı anda iki istek gitmez, sonraki bir öncekinin sonucuna göre karar verir.
   */
  const persist = (opts: { commitDraft?: boolean } = {}): Promise<PersistResult> => {
    const run = async (): Promise<PersistResult> => {
      let adjust = histRef.current.present;
      // Süren ölçümün sonucu henüz geçmişe çizilmemiş olabilir: dönen düzeltme en günceli.
      if (inflight.current) {
        const r = await inflight.current;
        if (r) adjust = r;
      }
      if (opts.commitDraft && editingRef.current) {
        const r = await commitEdit();
        if (!r) return "failed";
        adjust = r;
      }
      if (!isDirty(adjust, savedRef.current)) {
        setSaveError(null);
        return "clean";
      }
      setSaving(true);
      try {
        await api.put<AdjustSaveResponse>(path(API.variantAdjust, { id: variantId }), saveBody(adjust));
        markSaved(adjust);
        setSaveError(null);
        invalidateWork(qc);
        return "saved";
      } catch (e) {
        setSaveError(e);
        return "failed";
      } finally {
        setSaving(false);
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p;
    return p;
  };

  return {
    model,
    layout,
    cur,
    hist,
    sel: selV,
    single,
    selBox,
    selCenter: boxCenter(selBox),
    goal,
    target,
    setTarget,
    editing,
    canEditText,
    shownFont,
    busy,
    saving,
    dirty,
    unsaved,
    saved,
    saveError,
    canSave: canSave({ dirty, editing: !!editing, saving, busy }),
    canUndo: canUndo(hist),
    canRedo: canRedo(hist),
    check: view,
    checked: !!check,
    inner,
    // eylemler
    setSel,
    setLive,
    settle,
    apply,
    center,
    scale,
    stroke,
    nudge,
    setOffset,
    reset,
    cycle,
    undo: doUndo,
    redo: doRedo,
    startEdit,
    setDraft,
    setRange,
    cancelEdit,
    commitEdit,
    chooseFont,
    removeSpan,
    save,
    remove,
    exit,
    persist,
  };
}

export type Duzelt = ReturnType<typeof useDuzelt>;
