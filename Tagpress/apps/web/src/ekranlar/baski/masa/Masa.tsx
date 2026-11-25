import type { PrintItem, PrintTemplate } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText, undoText } from "../../../i18n/sunucu.ts";
import { ApiFailure } from "../../../lib/api.ts";
import { useServerEvents } from "../../../lib/events.ts";
import type { Go } from "../../../lib/route.ts";
import { PRINT_KEYS, printApi, usePrintTemplates, useProfileDpi, useSessions, useShelf, variantPreviewUrl } from "../mantik/api.ts";
import type { Pt } from "../../../tezgah/tuval/canvas-math.ts";
import {
  addPage,
  arrangeItems,
  boardLayout,
  centerInSlot,
  duplicateItems,
  nudgeItems,
  type PagePatch,
  placedByJob,
  releaseFromSlot,
  removeItems,
  removePage,
  sortedPages,
  updatePage,
} from "../mantik/desk-model.ts";
import {
  addTargetOf,
  editableIds,
  escapeStep,
  hasMarkOverlap,
  itemCount,
  itemSizesMap,
  keyboardDropPoint,
  layoutKey,
  markWarnings as markWarningsOf,
  missingQuantity,
  pageSizes,
  pickSessionId,
  remainingJobIds,
  selectAllIds,
  sheetCount,
  shelfDropPlan,
  type ShelfDropRefusal,
  singleItem,
  skippedSummary,
  slotState,
} from "../mantik/masa.ts";
import { remapId, remapIds } from "../mantik/id-map.ts";
import { pruneSelection } from "../mantik/selection.ts";
import { groupShelf, type ShelfGroup, type ShelfRow, shelfRows, stamp } from "../mantik/shelf.ts";
import { type AlignMode, nudgeMm } from "../mantik/slot-geometry.ts";
import { useSessionEditor } from "../mantik/useSessionEditor.ts";
import { AppFrame, BandButton, Button, CenterColumn, type Crumb, EmptyState, type MenuItem, useCommand, useCommands, useConfirm, useToast, Workspace, WorkRow } from "../../../tezgah/index.ts";
import { DuzeltPenceresi } from "../../duzelt/gomulu.tsx";
import { useBaskiSekmeleri } from "../BaskiSekmeleri.tsx";
import { Raf } from "./Raf.tsx";
import { SagPanel } from "./SagPanel.tsx";
import { type Arrange, Tuval } from "./Tuval.tsx";

const REMEMBER = "studio.baski.oturum";
function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER);
  } catch {
    return null;
  }
}
function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(REMEMBER, id);
    else localStorage.removeItem(REMEMBER);
  } catch {
    /* gizli pencere */
  }
}

const PREVIEW_KEY = "studio.baski.onizleme";
function loadPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== "0";
  } catch {
    return true;
  }
}
function savePreview(v: boolean) {
  try {
    localStorage.setItem(PREVIEW_KEY, v ? "1" : "0");
  } catch {
    /* gizli pencere */
  }
}

/** Odak bir denetimdeyse (düğme, sekme, anahtar, bağlantı) Enter ve oklar onundur: kısayol çalışmaz. */
function onControl(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el?.closest?.("button, a[href], select, [role=checkbox], [role=radio], [role=tab], [role=switch], [role=spinbutton], [role=button], summary");
}

const REFUSAL_KEY: Record<Exclude<ShelfDropRefusal, "no-page">, string> = {
  locked: "drop.locked",
  "sticker-on-label": "drop.stickerOnLabel",
  "label-on-sticker": "drop.labelOnSticker",
  "no-free-slot": "drop.noFreeSlot",
};

/**
 * Baskı masası (maket 4): solda boyuta göre gruplu raf, ortada cetvelli tuvalde oturumun sayfaları, sağda sayfa ve
 * dosya ayarları. Yerel düzenlemeler anında görünür ve toplu yamayla kendiliğinden kaydedilir (`useSessionEditor`);
 * Ctrl Z / Ctrl Y bütün masa işlemlerini kapsar. Kaydedilmemiş durum kalmadığı için gezinme bekçisi yok.
 */
export function Masa({ languageId, sessionId, go }: { languageId: string; sessionId: string | null; go: Go }) {
  const { t } = useTranslation("printDesk");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const undoKeys = useCommand("baskiMasa.undo").keysText;

  // ---- oturum
  const drafts = useSessions(languageId, "draft");
  const draftList = useMemo(() => drafts.data?.sessions ?? [], [drafts.data]);
  const effectiveId = pickSessionId(sessionId, draftList, remembered());
  useEffect(() => {
    if (effectiveId) remember(effectiveId);
  }, [effectiveId]);

  // ---- seçim ve etkin sayfa (kaydedilen eklemelerin geçici kimlikleri gerçeğe dönünce bunlar da çevrilir)
  const [selected, setSelected] = useState<string[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ pageId: string; n: number } | null>(null);
  const ed = useSessionEditor(effectiveId, {
    onIds: (ids) => {
      setSelected((cur) => remapIds(cur, ids));
      setActivePageId((cur) => (cur ? remapId(cur, ids) : cur));
      setFocus((f) => (f && ids.has(f.pageId) ? { ...f, pageId: remapId(f.pageId, ids) } : f));
    },
  });
  const session = ed.session;
  const readOnly = session?.status === "printed";

  // ---- şablonlar, raf, ölçüler
  const tq = usePrintTemplates(languageId, true);
  const templateList = useMemo(() => tq.data?.templates ?? [], [tq.data]);
  const templates = useMemo(() => new Map<string, PrintTemplate>(templateList.map((x) => [x.id, x])), [templateList]);
  const liveTemplates = useMemo(() => templateList.filter((x) => !x.archived), [templateList]);
  const profileDpi = useProfileDpi(languageId);
  const shelfQ = useShelf(languageId);
  const shelfItems = useMemo(() => shelfQ.data?.items ?? [], [shelfQ.data]);
  // Raf sayacı yalnız taslaklardan: basılmış (salt okunur) oturum açıkken yerel fark eklenmez.
  const serverPlaced = useMemo(() => placedByJob(readOnly ? null : ed.serverSession), [ed.serverSession, readOnly]);
  const localPlaced = useMemo(() => placedByJob(readOnly ? null : session), [session, readOnly]);
  const rows = useMemo(() => shelfRows(shelfItems, serverPlaced, localPlaced), [shelfItems, serverPlaced, localPlaced]);
  const groups = useMemo(() => groupShelf(rows), [rows]);
  const orders = useMemo(() => new Map(shelfItems.map((i) => [i.jobId, { orderNo: i.orderNo, quantity: i.quantity }])), [shelfItems]);
  const sizes = useMemo(() => itemSizesMap(shelfItems, session?.itemSizes), [shelfItems, session?.itemSizes]);

  // Varyasyon önizlemesi: raftaki adres (düzeltme sürümü anahtarlı) ya da yalın uç + yerel sürüm (Düzelt'ten sonra artar).
  const [revs, setRevs] = useState<ReadonlyMap<string, number>>(new Map());
  useServerEvents((e) => {
    if (e.type === "variant") setRevs((m) => new Map(m).set(e.variantId, (m.get(e.variantId) ?? 0) + 1));
  });
  const shelfPreview = useMemo(() => new Map(shelfItems.map((i) => [i.variantId, i.previewUrl])), [shelfItems]);
  const previewOf = useCallback((v: string) => shelfPreview.get(v) ?? variantPreviewUrl(v, revs.get(v) ?? 0), [shelfPreview, revs]);
  const revTotal = useMemo(() => [...revs.values()].reduce((a, b) => a + b, 0), [revs]);

  // ---- masa düzeni (yalnız sayfa listesi ya da ölçüleri değişince)
  const pages = useMemo(() => (session ? sortedPages(session) : []), [session]);
  const sizeList = pageSizes(pages, templates);
  const key = layoutKey(sizeList);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- düzen yalnız ölçü listesi (key) değişince kurulur; sizeList her çizimde yeni dizi
  const layout = useMemo(() => boardLayout(sizeList), [key]);

  // ---- oturum eylemleri ve önizleme
  const [busy, setBusy] = useState<null | "plan" | "replan" | "printed" | "add">(null);
  const [preview, setPreviewState] = useState(loadPreview);
  const setPreview = (v: boolean) => {
    setPreviewState(v);
    savePreview(v);
  };

  useEffect(() => {
    if (!session) return;
    const ids = new Set(session.pages.flatMap((p) => p.items.map((i) => i.id)));
    setSelected((cur) => pruneSelection(cur, (x) => ids.has(x)) as string[]);
    if (activePageId && !session.pages.some((p) => p.id === activePageId)) setActivePageId(null);
  }, [session, activePageId]);
  useEffect(() => {
    setSelected([]);
    setActivePageId(null);
  }, [effectiveId]);

  const editable = useMemo(() => editableIds(session, selected), [session, selected]);
  const inSlot = useMemo(() => slotState(session, editable, templates), [session, editable, templates]);
  const activePage = session?.pages.find((p) => p.id === activePageId) ?? null;
  const markWarnings = useMemo(() => markWarningsOf(session, templateList), [session, templateList]);
  const addTarget = addTargetOf(session, templates, readOnly);

  const refuse = useCallback((m: string) => toast({ message: m }), [toast]);
  const invalidate = (...keys: string[]) => {
    for (const k of keys) void qc.invalidateQueries({ queryKey: [k] });
  };
  const failed = (key: string, e: unknown) => toast({ tone: "error", message: t(key, { detail: serverText(e) }) });

  // ---------------------------------------------------------------- oturum eylemleri

  const plan = async (g: ShelfGroup, templateId: string) => {
    setBusy("plan");
    try {
      const jobIds = remainingJobIds(g);
      const r = await printApi.createSession({ languageId, templateId, jobIds: jobIds.length ? jobIds : undefined });
      qc.setQueryData([PRINT_KEYS.session, r.session.id], r.session);
      invalidate(PRINT_KEYS.sessions, PRINT_KEYS.shelf);
      for (const w of r.warnings) toast({ message: w });
      const tpl = templateList.find((x) => x.id === templateId);
      if (tpl && hasMarkOverlap(tpl)) toast({ message: t("toast.markOverlap", { name: tpl.name }) });
      const skipped = skippedSummary(r.skipped);
      if (skipped.count) toast({ message: t("toast.planSkipped", { count: skipped.count, reasons: skipped.reasons.join(" · ") }) });
      toast({ tone: "success", message: t("toast.planned", { name: r.session.name, count: r.session.pages.length }) });
      go("baski", ["masa", r.session.id]);
    } catch (e) {
      failed("toast.planFailed", e);
    } finally {
      setBusy(null);
    }
  };

  const replan = async () => {
    if (!session) return;
    setBusy("replan");
    try {
      const v = await ed.settle();
      const r = await printApi.replan(session.id, v ?? session.version);
      ed.adopt(r.session);
      for (const w of r.warnings) toast({ message: w });
      const missing = missingQuantity(r.skipped);
      if (missing.count) toast({ message: t("toast.replanMissing", { count: missing.count, orders: missing.orders.join(", ") }) });
      toast({ tone: "success", message: t("toast.replanned", { keys: undoKeys }) });
      invalidate(PRINT_KEYS.shelf);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) await ed.reload();
      failed("toast.replanFailed", e);
    } finally {
      setBusy(null);
    }
  };

  const addToSession = async (g: ShelfGroup) => {
    if (!session || readOnly) return;
    const jobIds = remainingJobIds(g);
    if (!jobIds.length) return;
    setBusy("add");
    try {
      const v = await ed.settle();
      const before = session.pages.length;
      const r = await printApi.addJobs(session.id, { version: v ?? session.version, jobIds });
      ed.adopt(r.session);
      for (const w of r.warnings) toast({ message: w });
      const skipped = skippedSummary(r.skipped);
      if (skipped.count) toast({ message: t("toast.addSkipped", { count: skipped.count, reasons: skipped.reasons.join(" · ") }) });
      const added = r.session.pages.length - before;
      toast({ tone: "success", message: added > 0 ? t("toast.addedPages", { count: added, keys: undoKeys }) : t("toast.addedSlots", { keys: undoKeys }) });
      invalidate(PRINT_KEYS.shelf, PRINT_KEYS.sessions);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) await ed.reload();
      failed("toast.addFailed", e);
    } finally {
      setBusy(null);
    }
  };

  const markPrinted = async () => {
    if (!session) return;
    const ok = await confirm({
      title: t("printed.title", { name: session.name }),
      body: t("printed.body", { pages: session.pages.length, sheets: sheetCount(session) }),
      confirmLabel: t("printed.confirm"),
    });
    if (!ok) return;
    setBusy("printed");
    try {
      const v = await ed.settle();
      const r = await printApi.markPrinted(session.id, true, v ?? undefined);
      invalidate(PRINT_KEYS.sessions, PRINT_KEYS.shelf);
      remember(null);
      toast({
        tone: "success",
        message: t("printed.done", { name: r.name }),
        action: {
          label: t("editor.undo"),
          run: async () => {
            try {
              await printApi.markPrinted(r.id, false);
              invalidate(PRINT_KEYS.sessions, PRINT_KEYS.shelf);
              go("baski", ["masa", r.id]);
            } catch (e) {
              toast({ tone: "error", message: serverText(e) });
            }
          },
        },
      });
      go("baski", ["masa"]);
    } catch (e) {
      failed("printed.failed", e);
    } finally {
      setBusy(null);
    }
  };

  const reprint = async () => {
    if (!session) return;
    try {
      const r = await printApi.reprint(session.id);
      qc.setQueryData([PRINT_KEYS.session, r.id], r);
      invalidate(PRINT_KEYS.sessions);
      toast({ tone: "success", message: t("toast.reprinted", { name: r.name }) });
      go("baski", ["masa", r.id]);
    } catch (e) {
      failed("toast.reprintFailed", e);
    }
  };

  const deleteSession = async () => {
    if (!session) return;
    const ok = await confirm({ title: t("session.deleteTitle", { name: session.name }), body: t("session.deleteBody"), confirmLabel: t("session.deleteConfirm"), tone: "danger" });
    if (!ok) return;
    try {
      const u = await printApi.deleteSession(session.id);
      remember(null);
      invalidate(PRINT_KEYS.sessions, PRINT_KEYS.shelf);
      toast({
        message: undoText(u),
        action: {
          label: t("editor.undo"),
          run: async () => {
            await printApi.undo(u.undoToken);
            invalidate(PRINT_KEYS.sessions, PRINT_KEYS.shelf);
          },
        },
      });
      go("baski", ["masa"]);
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    }
  };

  // ---------------------------------------------------------------- raftan sayfaya

  const dropOnPage = (pageId: string, point: Pt, row: ShelfRow, mods: { shift: boolean; alt: boolean }) => {
    if (!session || readOnly) return;
    const r = shelfDropPlan(session, templates, { pageId, point, row, shift: mods.shift, alt: mods.alt });
    if (!r.ok) {
      if (r.reason !== "no-page") refuse(t(REFUSAL_KEY[r.reason]));
      return;
    }
    ed.commit(r.session);
    setSelected(r.added);
    setActivePageId(pageId);
    if (r.short > 0) refuse(t("drop.short", { added: r.added.length, short: r.short }));
  };

  /** Klavyeyle (raf kartında Enter): etkin sayfanın ilk boş yuvasına; tek sayfalı oturumda o sayfaya. */
  const placeFromKeyboard = (row: ShelfRow, shift: boolean) => {
    if (!session || readOnly) return;
    const page = activePage ?? (session.pages.length === 1 ? session.pages[0] : undefined);
    const point = keyboardDropPoint(page, page ? templates.get(page.templateId) : undefined);
    if (!page || !point) {
      refuse(t("drop.pickPage"));
      return;
    }
    dropOnPage(page.id, point, row, { shift, alt: false });
  };

  // ---------------------------------------------------------------- seçim ve sayfa eylemleri

  const removeSelected = () => {
    if (!session || !editable.size) return;
    ed.commit(removeItems(session, editable));
    setSelected([]);
  };
  const duplicateSelected = () => {
    if (!session || !editable.size) return;
    const r = duplicateItems(session, editable, templates);
    ed.commit(r.session);
    setSelected(r.added);
  };
  const arrange = (how: Arrange) => {
    if (!session || !editable.size) return;
    ed.commit(arrangeItems(session, editable, templates, how as { align: AlignMode } | { distribute: "x" | "y" }, sizes));
  };
  const recenter = () => session && editable.size && ed.commit(centerInSlot(session, editable, templates));
  const release = () => session && editable.size && ed.commit(releaseFromSlot(session, editable));
  const patchPage = (id: string, patch: PagePatch, k?: string) => session && ed.commit(updatePage(session, id, patch), k);
  const setPageTemplate = (id: string, templateId: string) => session && ed.commit({ ...session, pages: session.pages.map((p) => (p.id === id ? { ...p, templateId } : p)) });
  const newPage = (templateId: string) => {
    if (!session) return;
    const tpl = templates.get(templateId);
    const r = addPage(session, templateId, { showCellLabels: tpl?.cellLabel.enabledByDefault ?? true });
    ed.commit(r.session);
    setActivePageId(r.pageId);
    setSelected([]);
    setFocus((f) => ({ pageId: r.pageId, n: (f?.n ?? 0) + 1 }));
  };
  const dropPage = async (id: string) => {
    if (!session) return;
    const p = session.pages.find((x) => x.id === id);
    if (!p) return;
    if (p.items.length) {
      const ok = await confirm({ title: t("page.deleteTitle", { name: p.name }), body: t("page.deleteBody", { count: p.items.length, keys: undoKeys }), confirmLabel: t("page.delete"), tone: "danger" });
      if (!ok) return;
    }
    ed.commit(removePage(session, id));
    setActivePageId(null);
  };
  /** Yazıyı düzelt: Düzelt penceresi masanın üstünde açılır; kaydedilince raf ve sayfa önizlemeleri tazelenir. */
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const openAdjust = (it: PrintItem) => {
    if (!session) return;
    setAdjusting(it.variantId);
  };
  const closeAdjust = (saved: boolean) => {
    const v = adjusting;
    setAdjusting(null);
    if (!saved || !v) return;
    setRevs((m) => new Map(m).set(v, (m.get(v) ?? 0) + 1));
    invalidate(PRINT_KEYS.shelf, PRINT_KEYS.sessions);
  };
  const adjustSelected = () => {
    const it = singleItem(session, selected);
    if (it) openAdjust(it);
  };

  // ---------------------------------------------------------------- kısayollar

  const nudge = (e: KeyboardEvent) => {
    if (onControl(e)) return false;
    const n = nudgeMm(e.key, e.shiftKey);
    if (!session || readOnly || !n || !editable.size) return false;
    ed.commit(nudgeItems(session, editable, n.x, n.y, templates), `nudge:${[...editable].join(",")}`);
  };
  useCommands("baskiMasa", {
    "baskiMasa.undo": () => {
      if (!session || readOnly) return false;
      ed.undo();
    },
    "baskiMasa.redo": () => {
      if (!session || readOnly) return false;
      ed.redo();
    },
    "baskiMasa.selectAll": () => {
      if (!session) return false;
      setSelected(selectAllIds(session, activePageId));
    },
    "baskiMasa.clear": () => {
      const step = escapeStep(selected.length, activePageId);
      if (step === "none") return false;
      if (step === "selection") setSelected([]);
      else setActivePageId(null);
    },
    "baskiMasa.adjust": (e) => {
      if (onControl(e) || readOnly || !singleItem(session, selected)) return false;
      adjustSelected();
    },
    "baskiMasa.duplicate": () => {
      if (readOnly || !editable.size) return false;
      duplicateSelected();
    },
    "baskiMasa.delete": (e) => {
      if (onControl(e) || readOnly || !editable.size) return false;
      removeSelected();
    },
    "baskiMasa.left": nudge,
    "baskiMasa.right": nudge,
    "baskiMasa.up": nudge,
    "baskiMasa.down": nudge,
  });

  // ---------------------------------------------------------------- iş satırı

  const tabs = useBaskiSekmeleri("masa", go);
  // Maket: sekmeler önce, sonra oturum adı ve özet; sağda sessiz "Taslak oturumlar ⌄" ve "⋯" (arşive git, oturumu sil).
  const crumbs: Crumb[] = session ? [{ label: session.name, rename: readOnly ? undefined : { value: session.name, onRename: (name) => ed.commit({ ...session, name }) } }] : [];
  const meta = session ? <span className="bm-meta">{t("work.summary", { pages: t("work.pages", { count: session.pages.length }), labels: t("work.labels", { count: itemCount(session) }) })}</span> : undefined;
  const draftItems: MenuItem[] = draftList.length
    ? draftList.map((s) => {
        const stale = (s.noticeCodes ?? []).includes("plan-stale");
        const line = t("session.line", { pages: t("work.pages", { count: s.pageCount }), sheets: t("work.sheets", { count: s.sheetCount }), labels: t("work.labels", { count: s.itemCount }), when: stamp(s.updatedAt) });
        return {
          label: [s.name, line, stale ? t("session.stale") : null].filter(Boolean).join(" · "),
          icon: stale ? "warn" : s.id === effectiveId ? "check" : undefined,
          onSelect: () => go("baski", ["masa", s.id]),
        };
      })
    : [{ label: t("session.noDrafts"), disabled: true, onSelect: () => {} }];
  const moreItems: MenuItem[] = [
    { label: t("session.toArchive"), icon: "print", onSelect: () => go("baski", ["arsiv"]) },
    ...(session && !readOnly ? [{ label: t("session.delete"), icon: "trash" as const, danger: true, onSelect: () => void deleteSession() }] : []),
  ];
  const workRow = (
    <WorkRow
      tabsFirst
      crumbs={crumbs}
      tabs={tabs}
      meta={meta}
      actions={
        <>
          <BandButton quiet label={t("session.drafts")} menuItems={draftItems} />
          <BandButton quiet icon="dots" label={t("session.more")} menuItems={moreItems} />
        </>
      }
    />
  );

  const raf = (
    <Raf
      groups={groups}
      templates={liveTemplates}
      canDrop={!!session && !readOnly}
      planning={busy === "plan"}
      onPlan={(g, tid) => void plan(g, tid)}
      addTarget={addTarget}
      adding={busy === "add"}
      onAdd={(g) => void addToSession(g)}
      onTemplates={() => go("baski", ["sablonlar"])}
      onPlace={placeFromKeyboard}
    />
  );

  // ---------------------------------------------------------------- orta sütun

  let center;
  if (session) {
    center = (
      <Tuval
        session={session}
        notices={ed.notices}
        layout={layout}
        templates={templates}
        liveTemplates={liveTemplates}
        sizes={sizes}
        orders={orders}
        selected={selected}
        editable={editable}
        inSlot={inSlot}
        activePageId={activePageId}
        readOnly={readOnly}
        preview={preview}
        onPreview={setPreview}
        previewOf={previewOf}
        thumbVersion={`${ed.serverSession?.version ?? session.version}.${revTotal}`}
        focus={focus}
        saving={ed.saving}
        saveError={ed.error}
        canUndo={ed.canUndo && !readOnly}
        canRedo={ed.canRedo && !readOnly}
        replanning={busy === "replan"}
        onUndo={ed.undo}
        onRedo={ed.redo}
        onReplan={() => void replan()}
        onNewPage={newPage}
        onTemplates={() => go("baski", ["sablonlar"])}
        onSelect={setSelected}
        onActivePage={setActivePageId}
        onCommit={(n) => ed.commit(n)}
        onAdjust={openAdjust}
        onAdjustSelected={adjustSelected}
        onShelfDrop={dropOnPage}
        onRefuse={refuse}
        onArrange={arrange}
        onRecenter={recenter}
        onRelease={release}
        onDuplicate={duplicateSelected}
        onRemove={removeSelected}
      />
    );
  } else if ((!!effectiveId && ed.query.isLoading) || drafts.isLoading) {
    center = (
      <CenterColumn>
        <div className="bm-wait" aria-busy="true" />
      </CenterColumn>
    );
  } else if (ed.query.isError) {
    center = (
      <CenterColumn>
        <EmptyState
          icon="warn"
          title={t("empty.openFailed")}
          body={serverText(ed.query.error)}
          action={
            <Button
              onClick={() => {
                remember(null);
                go("baski", ["masa"]);
              }}
            >
              {t("empty.otherSession")}
            </Button>
          }
        />
      </CenterColumn>
    );
  } else {
    center = (
      <CenterColumn>
        <EmptyState
          icon="print"
          title={t("empty.noSession")}
          body={liveTemplates.length ? t("empty.noSessionBody") : t("empty.noTemplateBody")}
          action={
            liveTemplates.length ? undefined : (
              <Button variant="primary" onClick={() => go("baski", ["sablonlar"])}>
                {t("empty.setupTemplate")}
              </Button>
            )
          }
        />
      </CenterColumn>
    );
  }

  return (
    <AppFrame band="work" active="baski" workRow={workRow}>
      <Workspace
        leftWidth={270}
        left={raf}
        rightWidth={300}
        right={
          session ? (
            <SagPanel
              session={session}
              notices={ed.notices}
              activePage={activePage}
              templates={templates}
              liveTemplates={liveTemplates}
              readOnly={readOnly}
              markWarnings={markWarnings}
              defaultDpi={profileDpi.data ?? null}
              settle={ed.settle}
              printing={busy === "printed"}
              onPatchPage={patchPage}
              onTemplate={setPageTemplate}
              onDeletePage={(id) => void dropPage(id)}
              onEditTemplate={(id) => go("baski", ["sablonlar", id])}
              onMarkPrinted={() => void markPrinted()}
              onReprint={() => void reprint()}
              onReplan={() => void replan()}
            />
          ) : undefined
        }
      >
        {center}
      </Workspace>
      {adjusting && <DuzeltPenceresi variantId={adjusting} onClose={closeAdjust} />}
    </AppFrame>
  );
}
