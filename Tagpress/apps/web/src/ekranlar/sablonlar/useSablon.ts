import {
  API,
  type ProfileRecord,
  type Shape,
  type SuggestAreaRequest,
  type SuggestAreaResponse,
  type TemplateCutPreviewRequest,
  type TemplateCutPreviewResponse,
  type TemplateItem,
} from "@tagpress/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api, path } from "../../lib/api.ts";
import { decorationMask, tintMask } from "./mantik/decor.ts";
import {
  buildPatch,
  changedLabels,
  clearDraft,
  type DecorationSettings,
  deepEqual,
  type EditChanges,
  type EditState,
  editStateOf,
  effective,
  loadDraft,
  saveDraft,
  setDecoration,
  setField,
} from "./mantik/draft.ts";
import { canUndo, emptyHistory, type History, record, undo as undoStep } from "./mantik/history.ts";
import { outputOf, templateScale } from "./mantik/olcu.ts";
import { pxToRatio } from "./mantik/shapeMath.ts";
import { useConfirm, useToast } from "../../tezgah/index.ts";

/** Dekor önizlemesinin örnekleme çarpanı (tasarım alanı pikseli başına kaç piksel). */
const DECOR_SCALE = 2;

type Field = keyof Omit<EditState, "decoration">;

/**
 * Bir şablonun düzenleme durumu: sunucu kaydı, dokunulan alanlar (taslak, tarayıcı oturumunda saklanır), geri al
 * geçmişi, kayıt, otomatik öneri ve dekor önizlemesi. Kayıt yalnız değişen alanları gönderir (`buildPatch`).
 */
export function useSablon(lang: string, key: string) {
  const { t } = useTranslation("templates");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const tq = useQuery({ queryKey: ["template", lang, key], queryFn: () => api.get<TemplateItem>(path(API.template, { lang, key })), retry: false });
  const pq = useQuery({ queryKey: ["sablon-profil", lang], queryFn: () => api.get<ProfileRecord>(path(API.profile, { lang })), staleTime: 60_000, retry: false });

  const item = tq.data;
  const orig = useMemo(() => editStateOf(item?.template ?? {}), [item]);
  const [ed, setEd] = useState<{ changes: EditChanges; history: History<EditChanges> }>({ changes: {}, history: emptyHistory() });
  const changes = ed.changes;
  const eff = useMemo(() => effective(orig, changes), [orig, changes]);
  const patch = useMemo(() => buildPatch(orig, changes), [orig, changes]);
  const dirty = Object.keys(patch).length > 0;
  const labels = changedLabels(patch);
  const [restored, setRestored] = useState(false);
  const [ghost, setGhost] = useState<Shape | null>(null);
  const loaded = useRef(false);

  // Taslağı geri yükle (aynı kayıt sürümüne aitse); sonra her değişiklikte sakla.
  useEffect(() => {
    if (!item || loaded.current) return;
    loaded.current = true;
    const d = loadDraft(lang, key, item.updatedAt);
    if (d && Object.keys(d).length) {
      setEd({ changes: d, history: emptyHistory() });
      setRestored(true);
    }
  }, [item, lang, key]);
  useEffect(() => {
    if (item && loaded.current) saveDraft(lang, key, item.updatedAt, changes);
  }, [changes, item, lang, key]);

  /** Alanı değiştir. `merge`: aynı anahtarlı ardışık değişiklikler tek geri al adımı (sürükleme, yazma). */
  const set = <K extends Field>(k: K, v: EditState[K], merge: string | null = null) =>
    setEd((s) => {
      const next = setField(orig, s.changes, k, v);
      return deepEqual(next, s.changes) ? s : { changes: next, history: record(s.history, s.changes, merge) };
    });
  const setDec = <K extends keyof DecorationSettings>(k: K, v: DecorationSettings[K], merge: string | null = null) =>
    setEd((s) => {
      const next = setDecoration(orig, s.changes, k, v);
      return deepEqual(next, s.changes) ? s : { changes: next, history: record(s.history, s.changes, merge) };
    });

  const undo = () =>
    setEd((s) => {
      const u = undoStep(s.history);
      return u ? { changes: u.value, history: u.history } : s;
    });

  /** Bütün değişiklikleri at (bildirimde "Geri getir"). */
  const revertAll = () => {
    const before = changes;
    setEd((s) => ({ changes: {}, history: record(s.history, s.changes) }));
    clearDraft(lang, key);
    setGhost(null);
    setRestored(false);
    toast({ message: t("toast.reverted"), action: { label: t("toast.restore"), run: () => setEd((s) => ({ changes: before, history: record(s.history, s.changes) })) } });
  };

  const save = useMutation({
    mutationFn: () => api.patch<TemplateItem>(path(API.template, { lang, key }), patch),
    onSuccess: (saved) => {
      qc.setQueryData(["template", lang, key], saved);
      qc.setQueryData(["templates", lang], (old: { templates: TemplateItem[] } | undefined) => (old ? { templates: old.templates.map((x) => (x.template.key === key ? saved : x)) } : old));
      void qc.invalidateQueries({ queryKey: ["templates", lang] });
      clearDraft(lang, key);
      setEd({ changes: {}, history: emptyHistory() });
      setRestored(false);
      setGhost(null);
      toast({ tone: "success", message: t("toast.saved", { fields: labels.join(", ") }) });
    },
    onError: (e) => toast({ tone: "error", message: t("toast.saveFailed", { error: serverText(e) }) }),
  });
  // Kesim değişikliği kaydedilmeden önce sunucuya sorulur: kaç onaylı (basılmamış) işin onayı düşecek. Varsa onay
  // penceresi, yoksa doğrudan kayıt. Sayı alınamazsa (eski sunucu, bağlantı) yine sorulur: onay sessizce düşmesin.
  const [checking, setChecking] = useState(false);
  const doSave = async () => {
    if (!dirty || save.isPending || checking) return;
    if ("cut" in patch) {
      setChecking(true);
      let approvals: number | null;
      try {
        // PATCH'e gidecek kesimle aynı değer (`null`: şablonun kesimi kalkar, dilin kesimine düşer).
        const body: TemplateCutPreviewRequest = { cut: eff.cut };
        approvals = (await api.post<TemplateCutPreviewResponse>(path(API.templateCutPreview, { lang, key }), body)).approvals;
      } catch {
        approvals = null;
      } finally {
        setChecking(false);
      }
      if (approvals !== 0) {
        const ok = await confirm({
          title: t("cutConfirm.title"),
          body: approvals === null ? t("cutConfirm.unknown") : t("cutConfirm.body", { count: approvals }),
          confirmLabel: t("cutConfirm.save"),
        });
        if (!ok) return;
      }
    }
    save.mutate();
  };

  const suggest = useMutation({
    mutationFn: () => {
      const dec = patch.decoration as SuggestAreaRequest["decoration"] | undefined;
      return api.post<SuggestAreaResponse>(path(API.templateSuggestArea, { lang, key }), (dec ? { decoration: dec } : {}) satisfies SuggestAreaRequest);
    },
    onSuccess: (r) => setGhost(r.shape),
  });

  // ---- ölçüler
  const out = useMemo(() => outputOf(pq.data?.data), [pq.data]);
  const scale = useMemo(() => templateScale(out, { cut: eff.cut, imageBox: eff.imageBox }), [out, eff.cut, eff.imageBox]);
  const cutRatio = useMemo(() => pxToRatio(scale.cutPx, scale.framePx), [scale]);

  const imageUrl = item && !item.fileMissing ? `${path(API.templateImage, { lang, key })}?v=${encodeURIComponent(item.template.hash || item.updatedAt)}` : null;
  const overlayUrl = item ? `${path(API.templateOverlay, { lang, key })}?v=${encodeURIComponent(item.updatedAt)}` : null;
  const decor = useDecorPreview(imageUrl, scale.framePx, scale.imageBox, eff.decoration);

  return {
    tq,
    pq,
    item,
    orig,
    eff,
    patch,
    dirty,
    labels,
    restored,
    ghost,
    setGhost,
    set,
    setDec,
    undo,
    canUndo: canUndo(ed.history),
    revertAll,
    save,
    /** Kayıt ya da kayıttan önceki kesim denetimi sürüyor. */
    saving: save.isPending || checking,
    doSave,
    suggest,
    out,
    scale,
    cutRatio,
    imageUrl,
    overlayUrl,
    decor,
  };
}

export type Sablon = ReturnType<typeof useSablon>;

/** Dekor maskesi tarayıcıda yaklaşık (kesin hesap "Sunucu bindirmesi" katmanında). Görsel ya da tuval yoksa null. */
function useDecorPreview(imageUrl: string | null, frame: number, box: { x: number; y: number; w: number; h: number }, decoration: DecorationSettings) {
  const [pixels, setPixels] = useState<{ data: Uint8ClampedArray; size: number } | null>(null);
  useEffect(() => {
    if (!imageUrl || typeof Image === "undefined") {
      setPixels(null);
      return;
    }
    let dead = false;
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      try {
        const c = document.createElement("canvas");
        // Tuval çözünürlüğüne yakın (2×) örnekle: dekor taraması tırtıklı bloklar yerine pürüzsüz kenar verir.
        const px = frame * DECOR_SCALE;
        c.width = c.height = px;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, box.x * DECOR_SCALE, box.y * DECOR_SCALE, box.w * DECOR_SCALE, box.h * DECOR_SCALE);
        setPixels({ data: ctx.getImageData(0, 0, px, px).data, size: px });
      } catch {
        setPixels(null);
      }
    };
    img.onerror = () => !dead && setPixels(null);
    img.src = imageUrl;
    return () => {
      dead = true;
    };
  }, [imageUrl, frame, box.x, box.y, box.w, box.h]);
  const dec = useDeferredValue(decoration);
  return useMemo(() => {
    if (!pixels) return null;
    const mask = decorationMask(pixels.data, pixels.size, pixels.size, { ...dec, dilatePx: dec.dilatePx * DECOR_SCALE });
    const toUrl = (rgba: Uint8ClampedArray) => {
      const c = document.createElement("canvas");
      c.width = c.height = pixels.size;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.putImageData(new ImageData(rgba as unknown as ImageDataArray, pixels.size, pixels.size), 0, 0);
      return c.toDataURL("image/png");
    };
    // `tint`: dekorun olduğu yer beyaz (tarama maskesi); `knock`: kurdele bandını dekorun altında bırakan siyah maske.
    return { tint: toUrl(tintMask(mask, [255, 255, 255], 255)), knock: toUrl(tintMask(mask, [0, 0, 0], 255)) };
  }, [pixels, dec]);
}
