import type { PrintPreset, PrintTemplateView } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../../i18n/sunucu.ts";
import { PRINT_KEYS, printApi, usePrintPresets } from "../mantik/api.ts";
import { generateGrid } from "../mantik/grid.ts";
import { pruneSelection } from "../mantik/selection.ts";
import { nudgeMm } from "../mantik/slot-geometry.ts";
import { draftOf, draftPatch, sameDraft, type TemplateDraft } from "../mantik/sablon/draft.ts";
import {
  alignSelection,
  canDelete,
  defaultSlotSize,
  distributeSelection,
  duplicateSelection,
  type EditorTab,
  nudgeSelection,
  presetName,
  removeSlots,
  slotWarnings,
  warnedSlotIds,
} from "../mantik/sablon/editor.ts";
import { readingNumbers } from "../mantik/sablon/marks.ts";
import { type CenterAxes, centerOnPaper, evenLayout, type Layout, layoutMatches, layoutOf, layoutSlots, layoutSpec, moveLayoutTo, slotsForPaper } from "../mantik/sablon/yerlesim.ts";
import { canRedo, canUndo, createHistory, type History, push, redo, undo } from "../../duzelt/mantik/adjust-history.ts";
import {
  AppFrame,
  type BandTabs,
  BandButton,
  type Crumb,
  type MenuItem,
  Panel,
  Rail,
  type RailItem,
  Tabs,
  useCommand,
  useCommands,
  useConfirm,
  useLeaveGuard,
  useToast,
  useViewport,
  Workspace,
  WorkRow,
} from "../../../tezgah/index.ts";
import { pageTemplateWarnings } from "../mantik/kenar.ts";
import { presetSizePatch } from "../mantik/raf.ts";
import { type Arrange, Kagit, type Tool } from "./Kagit.tsx";
import { GelismisPaneli, TemelPaneli } from "./Paneller.tsx";
import { useSablonSil } from "./sil.ts";

const RAIL: (RailItem | "divider")[] = [
  { id: "select", icon: "cursor", command: "baskiSablon.toolSelect" },
  { id: "circle", icon: "circle", command: "baskiSablon.toolCircle" },
  { id: "ellipse", icon: "ellipse", command: "baskiSablon.toolEllipse" },
  { id: "rect", icon: "rect", command: "baskiSablon.toolRect" },
  "divider",
  { id: "pan", icon: "hand", command: "canvas.pan" },
];

/** "Kılavuz ve yapışma" anahtarının yerel kaydı (kişisel kolaylık; yoksa açık). */
const SNAP_KEY = "tagpress.baskiSablon.yapisma";
function readSnap(): boolean {
  try {
    return localStorage.getItem(SNAP_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeSnap(v: boolean) {
  try {
    localStorage.setItem(SNAP_KEY, v ? "1" : "0");
  } catch {
    /* gizli pencere */
  }
}

/** Odak bir denetimdeyse (düğme, sekme, anahtar, bağlantı) Delete ve oklar onundur: kısayol çalışmaz. */
function onControl(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el?.closest?.("button, a[href], select, [role=checkbox], [role=radio], [role=tab], [role=switch], [role=spinbutton], [role=button], [role=menuitem], summary");
}

/** Geri al / ileri al birimi: taslak ve diziliş birlikte (diziliş alanları geri alınınca yuvalarla aynı hâle döner). */
interface EdState {
  draft: TemplateDraft;
  layout: Layout;
}

export interface DuzenleyiciProps {
  template: PrintTemplateView;
  languageId: string;
  tabs: BandTabs;
  /** Başka şablonu aç (çoğaltınca). */
  onOpen(id: string): void;
  /** Listeye dön (silince, arşivleyince). */
  onList(): void;
}

/**
 * Sayfa şablonu düzenleyici (maket ekran 5): kâğıt ortada, sağda Temel / Gelişmiş. Taslak istemcide (Ctrl Z / Ctrl Y),
 * Kaydet (Ctrl S, iş satırında) yalnız değişen alanları gönderir; Sil iş satırında görünür, ⋯ menüsünde Çoğalt ve
 * Arşivle. Kaydedilmemiş değişiklikle ayrılmak onay ister (`useLeaveGuard`).
 */
export function Duzenleyici({ template, languageId, tabs, onOpen, onList }: DuzenleyiciProps) {
  const { t } = useTranslation("printTemplates");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const remove = useSablonSil();
  const undoKeys = useCommand("baskiSablon.undo").keysText;
  const presets = usePrintPresets(languageId);

  const [saved, setSaved] = useState<TemplateDraft>(() => draftOf(template));
  const [hist, setHist] = useState<History<EdState>>(() => {
    const d = draftOf(template);
    return createHistory({ draft: d, layout: layoutOf(d.paper, d.slots, defaultSlotSize(d, [])) });
  });
  const { draft, layout } = hist.present;
  const [selected, setSelected] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [tab, setTab] = useState<EditorTab>("temel");
  const [numbers, setNumbers] = useState(true);
  const [snap, setSnapState] = useState(readSnap);
  const [flash, setFlash] = useState(0);
  const [saving, setSaving] = useState(false);
  const dirty = !sameDraft(saved, draft);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const leave = useLeaveGuard(dirty, { body: t("leave.body") });
  const setSnap = (v: boolean) => {
    setSnapState(v);
    writeSnap(v);
  };

  // Dışarıdan (başka sekme, sunucu) değişen şablon: kaydedilmemiş değişiklik yoksa benimsenir.
  const lastUpdated = useRef(template.updatedAt);
  useEffect(() => {
    if (template.updatedAt === lastUpdated.current) return;
    lastUpdated.current = template.updatedAt;
    const incoming = draftOf(template);
    if (sameDraft(incoming, saved) || dirtyRef.current) return;
    setSaved(incoming);
    setHist((h) => ({ ...h, present: { draft: incoming, layout: layoutOf(incoming.paper, incoming.slots, defaultSlotSize(incoming, [])) } }));
  }, [template, saved]);

  const commit = useCallback(
    (next: TemplateDraft, key?: string) => setHist((h) => (next === h.present.draft ? h : push(h, { ...h.present, draft: next }, { now: Date.now(), key }))),
    [],
  );
  const commitBoth = useCallback((next: TemplateDraft, nextLayout: Layout, key?: string) => setHist((h) => push(h, { draft: next, layout: nextLayout }, { now: Date.now(), key })), []);
  // Geri alınca var olmayan yuvalar seçimden düşer.
  useEffect(() => {
    const ids = new Set(draft.slots.map((s) => s.id));
    setSelected((cur) => pruneSelection(cur, (x) => ids.has(x)) as string[]);
  }, [draft.slots]);

  const paperRect = useMemo(() => ({ x: 0, y: 0, w: draft.paper.wMm, h: draft.paper.hMm }), [draft.paper.wMm, draft.paper.hMm]);
  const api = useViewport({ world: paperRect, pad: 48 });
  const refit = (paper: TemplateDraft["paper"]) => window.setTimeout(() => api.fit({ x: 0, y: 0, w: paper.wMm, h: paper.hMm }), 0);

  const warnings = useMemo(() => pageTemplateWarnings(draft), [draft]);
  const warnIds = useMemo(() => warnedSlotIds(warnings), [warnings]);
  const slotWarnCount = slotWarnings(warnings).length;
  const readingNo = useMemo(() => readingNumbers(draft.slots), [draft.slots]);
  const preview = useMemo(() => (draft.slots.length ? null : layoutSlots(layout, draft.paper)), [draft.slots.length, layout, draft.paper]);
  const ghost = draft.kind === "sticker" && draft.stickerFlow ? null : (preview?.slots ?? null);
  const layoutError = preview?.error ?? (draft.slots.length ? layoutSlots(layout, draft.paper, draft.slots).error : null);
  const ids = useMemo(() => new Set(selected), [selected]);

  // ---------------------------------------------------------------- kaydet, sil, arşivle, çoğalt

  const doSave = async () => {
    if (!dirtyRef.current || saving) return;
    const sent = hist.present.draft;
    setSaving(true);
    try {
      const view = await printApi.patchTemplate(template.id, draftPatch(saved, sent));
      const next = draftOf(view);
      lastUpdated.current = view.updatedAt;
      setSaved(next);
      // Sunucu yuvaları okuma sırasına dizer; o arada değişiklik yoksa taslak da kayıtlı hâle geçer.
      setHist((h) => (h.present.draft === sent ? { ...h, present: { ...h.present, draft: next } } : h));
      qc.setQueriesData<{ templates: PrintTemplateView[] }>({ queryKey: [PRINT_KEYS.templates] }, (old) => (old ? { templates: old.templates.map((x) => (x.id === view.id ? view : x)) } : old));
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
      toast({ tone: "success", message: t("toast.saved", { name: view.name }) });
    } catch (e) {
      toast({ tone: "error", message: t("toast.saveFailed", { detail: serverText(e) }) });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    const r = await remove({ id: template.id, name: draft.name, usedIn: template.usedIn });
    if (!r) return;
    leave.pass();
    onList();
  };

  const setArchived = async (archived: boolean) => {
    try {
      const v = await printApi.archiveTemplate(template.id, archived);
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
      toast({
        message: v.archived ? t("toast.archived", { name: v.name }) : t("toast.unarchived", { name: v.name }),
        action: {
          label: t("toast.undo"),
          run: async () => {
            await printApi.archiveTemplate(template.id, !v.archived);
            void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
          },
        },
      });
      if (v.archived) {
        leave.pass();
        onList();
      }
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    }
  };

  const duplicate = async () => {
    try {
      const v = await printApi.duplicateTemplate(template.id);
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.templates] });
      toast({ tone: "success", message: t("toast.duplicated", { name: v.name }) });
      onOpen(v.id);
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    }
  };

  // ---------------------------------------------------------------- kâğıt ve diziliş

  /** Kâğıt değişince: ortalı tutuluyorsa yerleşim yeni kâğıda ortalanır, değilse yuvalar yerinde kalır. */
  const changePaper = (paper: TemplateDraft["paper"], key: string) => {
    commit({ ...draft, paper, slots: slotsForPaper(draft.slots, paper, layout.center) }, key);
    refit(paper);
  };

  /**
   * Etiket ya da diziliş değişti: yuvalar yeniden dizilir (ortalı değilse sol üst köşe yerinde kalır). Yuvalar elle
   * taşınmış ya da eklenip silinmişse önce sorulur. Yuvasız şablonda yalnız önizleme değişir.
   */
  const changeLayout = async (patch: Partial<Layout>, key: string) => {
    const next = { ...layout, ...patch };
    if (!draft.slots.length) {
      commitBoth(draft, next, key);
      return;
    }
    const r = layoutSlots(next, draft.paper, draft.slots);
    if (r.error || !r.slots.length) {
      commitBoth(draft, next, key);
      return;
    }
    if (!layoutMatches(layout, draft.paper, draft.slots)) {
      const ok = await confirm({ title: t("layout.confirmTitle"), body: t("layout.confirmBody", { keys: undoKeys }), confirmLabel: t("layout.confirmOk") });
      if (!ok) return;
    }
    commitBoth({ ...draft, slots: r.slots }, next, key);
    setSelected([]);
  };

  const keepCentered = (v: boolean) => {
    commitBoth(v ? { ...draft, slots: centerOnPaper(draft.slots, null, draft.paper, "xy") } : draft, { ...layout, center: v }, "layout:center");
    if (v && draft.slots.length) setFlash((n) => n + 1);
  };

  const place = () => {
    const r = layoutSlots(layout, draft.paper);
    if (r.error || !r.slots.length) return;
    commit({ ...draft, slots: r.slots });
  };

  const setMargin = (edge: "left" | "top", mm: number) => commitBoth({ ...draft, slots: moveLayoutTo(draft.slots, edge, mm) }, { ...layout, center: false }, `layout:margin:${edge}`);

  const even = () => {
    const next = evenLayout(layout, draft.paper);
    if (!next) {
      toast({ tone: "error", message: t("adv.evenFailed") });
      return;
    }
    void changeLayout(next, "layout:even");
  };

  // ---------------------------------------------------------------- hazır ayarlar

  const applyPreset = async (p: PrintPreset) => {
    const r = generateGrid(p.grid);
    if (r.error || !r.slots.length) {
      toast({ tone: "error", message: r.error ?? t("grid.empty") });
      return;
    }
    if (draft.slots.length) {
      const ok = await confirm({ title: t("grid.confirmTitle", { from: draft.slots.length, count: r.slots.length }), body: t("grid.confirmBody", { keys: undoKeys }), confirmLabel: t("grid.apply") });
      if (!ok) return;
    }
    const paper = p.grid.paper;
    const next = { ...draft, paper, slots: r.slots, ...presetSizePatch(p, draft, r.slots) };
    commitBoth(next, layoutOf(paper, r.slots, defaultSlotSize(next, [])));
    setSelected([]);
    refit(paper);
  };

  const savePreset = async () => {
    const grid = layoutSpec(layout, draft.paper, draft.slots);
    try {
      const p = await printApi.createPreset({ languageId, name: presetName(grid), kind: draft.kind, sizeId: draft.sizeId, labelDiameterMm: draft.labelDiameterMm, grid, note: "" });
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.presets] });
      toast({ tone: "success", message: t("toast.presetSaved", { name: p.name }) });
    } catch (e) {
      toast({ tone: "error", message: t("toast.presetFailed", { detail: serverText(e) }) });
    }
  };
  const deletePreset = async (p: PrintPreset) => {
    try {
      await printApi.deletePreset(p.id, languageId);
      void qc.invalidateQueries({ queryKey: [PRINT_KEYS.presets] });
    } catch (e) {
      toast({ tone: "error", message: serverText(e) });
    }
  };

  // ---------------------------------------------------------------- seçim eylemleri

  const removeSelected = () => {
    if (!ids.size) return;
    commit(removeSlots(draft, ids));
    setSelected([]);
  };
  const duplicateSelected = () => {
    if (!ids.size) return;
    const r = duplicateSelection(draft, ids);
    commit(r.draft);
    setSelected(r.added);
  };
  const arrange = (how: Arrange) => {
    const next = "align" in how ? alignSelection(draft, ids, how.align) : distributeSelection(draft, ids, how.distribute);
    if (next !== draft) commit(next);
  };
  /** Ortala: seçim varsa seçim (grup), yoksa bütün yerleşim. */
  const center = (axes: CenterAxes) => {
    const slots = centerOnPaper(draft.slots, ids, draft.paper, axes);
    if (slots !== draft.slots) commit({ ...draft, slots });
    setFlash((n) => n + 1);
  };

  // ---------------------------------------------------------------- kısayollar

  const nudge = (e: KeyboardEvent) => {
    if (onControl(e)) return false;
    const n = nudgeMm(e.key, e.shiftKey);
    if (!n || !ids.size) return false;
    commit(nudgeSelection(draft, ids, n), `nudge:${selected.join(",")}`);
  };
  useCommands("baskiSablon", {
    "baskiSablon.save": () => void doSave(),
    "baskiSablon.undo": () => setHist((h) => (canUndo(h) ? undo(h) : h)),
    "baskiSablon.redo": () => setHist((h) => (canRedo(h) ? redo(h) : h)),
    "baskiSablon.toolSelect": () => setTool("select"),
    "baskiSablon.toolCircle": () => setTool("circle"),
    "baskiSablon.toolEllipse": () => setTool("ellipse"),
    "baskiSablon.toolRect": () => setTool("rect"),
    "baskiSablon.selectAll": () => setSelected(draft.slots.map((s) => s.id)),
    "baskiSablon.duplicate": () => {
      if (!ids.size) return false;
      duplicateSelected();
    },
    "baskiSablon.delete": (e) => {
      if (onControl(e) || !ids.size) return false;
      removeSelected();
    },
    "baskiSablon.clear": () => {
      if (tool !== "select") setTool("select");
      else if (selected.length) setSelected([]);
      else return false;
    },
    "baskiSablon.back": () => onList(),
    "baskiSablon.left": nudge,
    "baskiSablon.right": nudge,
    "baskiSablon.up": nudge,
    "baskiSablon.down": nudge,
  });

  // ---------------------------------------------------------------- iş satırı

  const crumbs: Crumb[] = [{ label: draft.name, rename: { value: draft.name, onRename: (name) => name.trim() && commit({ ...draft, name: name.trim() }) } }];
  const menu: MenuItem[] = [
    { label: t("actions.duplicate"), icon: "copy", onSelect: () => void duplicate() },
    template.archived ? { label: t("actions.unarchive"), onSelect: () => void setArchived(false) } : { label: t("actions.archive"), onSelect: () => void setArchived(true) },
  ];
  const workRow = (
    <WorkRow
      back={{ command: "baskiSablon.back", onClick: onList }}
      crumbs={crumbs}
      tabs={tabs}
      tabsFirst
      meta={
        <span className="bs-meta" aria-live="polite">
          {dirty ? t("work.unsaved") : t("work.saved")}
        </span>
      }
      actions={
        <>
          {canDelete(template) && <BandButton need="edit" icon="trash" label={t("actions.delete")} onClick={() => void doDelete()} />}
          <BandButton label={t("actions.menu")} icon="dots" quiet menuItems={menu} />
          <BandButton need="edit" cta command="baskiSablon.save" label={t("actions.save")} disabled={!dirty || saving} onClick={() => void doSave()} />
        </>
      }
    />
  );

  // ---------------------------------------------------------------- sağ panel

  let body: ReactNode;
  if (tab === "temel") {
    body = (
      <TemelPaneli
        draft={draft}
        layout={layout}
        selected={selected}
        readingNo={readingNo}
        warnings={warnings}
        layoutError={layoutError}
        onCommit={commit}
        onSelect={setSelected}
        onPaper={changePaper}
        onLayout={(patch, key) => void changeLayout(patch, key)}
        onKeepCentered={keepCentered}
        onPlace={place}
        onAdvanced={() => setTab("gelismis")}
      />
    );
  } else {
    body = (
      <GelismisPaneli
        draft={draft}
        layout={layout}
        onCommit={commit}
        onLayout={(patch, key) => void changeLayout(patch, key)}
        onMargin={setMargin}
        onEven={even}
        presets={presets.data?.presets ?? []}
        onPreset={(p) => void applyPreset(p)}
        onSavePreset={() => void savePreset()}
        onDeletePreset={(p) => void deletePreset(p)}
      />
    );
  }

  const right = (
    <Panel side="right">
      <Tabs
        variant="underline"
        label={t("tabs.label")}
        value={tab}
        onChange={(id) => setTab(id as EditorTab)}
        items={[
          { id: "temel", label: t("tabs.temel"), count: slotWarnCount || undefined },
          { id: "gelismis", label: t("tabs.gelismis") },
        ]}
      />
      {body}
    </Panel>
  );

  return (
    <AppFrame band="work" active="baski" workRow={workRow}>
      <Workspace rail={<Rail label={t("tools.label")} items={RAIL} value={tool} onChange={(id) => setTool(id as Tool)} />} right={right} rightWidth={340}>
        <Kagit
          api={api}
          draft={draft}
          selected={selected}
          onSelect={setSelected}
          tool={tool}
          onTool={setTool}
          onCommit={commit}
          warnIds={warnIds}
          ghost={ghost}
          defaultSize={defaultSlotSize(draft, selected)}
          numbers={numbers}
          onNumbers={setNumbers}
          readingNo={readingNo}
          snap={snap}
          onSnap={setSnap}
          canUndo={canUndo(hist)}
          canRedo={canRedo(hist)}
          onUndo={() => setHist((h) => undo(h))}
          onRedo={() => setHist((h) => redo(h))}
          onArrange={arrange}
          onCenter={center}
          centerFlash={flash}
          onDuplicate={duplicateSelected}
          onRemove={removeSelected}
        />
      </Workspace>
    </AppFrame>
  );
}
