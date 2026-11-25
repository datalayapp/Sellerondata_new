import { API, type FixAction, type ImportCommitResponse, type ImportField, type ImportPreviewResponse, type ImportRow, type ImportValidateResponse, type Issue } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fixLabel, notQueuedText, serverText } from "../../i18n/sunucu.ts";
import { useCan } from "../../lib/access.ts";
import { api } from "../../lib/api.ts";
import { routeHash } from "../../lib/route.ts";
import { useDesignLanguage } from "../../ortak/index.ts";
import {
  applyPatches,
  baseName,
  blankRow,
  bulkCounts,
  bumpRevs,
  commitBody,
  excludePatches,
  getRow,
  includeAllPatches,
  isErrorRow,
  isTypingTarget,
  nextMapping,
  PASTED_FILE_NAME,
  type PatchList,
  previewBody,
  problemStep,
  readImportFile,
  restoreRows,
  type SelectMods,
  selectRow,
  selectVisible,
  setIncludePatches,
  settledIndexes,
  snapshotRows,
  stepActive,
  templatePatches,
  VALIDATE_DELAY,
  validateBody,
  validationIndexes,
} from "./mantik/desk.ts";
import {
  applyPatch,
  filterCounts,
  filterRows,
  isDuplicate,
  isProblem,
  mergeValidated,
  patchNeedsValidation,
  plainLetterPatches,
  type RowFilter,
  type RowPatch,
  resolveFix,
  tallyRows,
} from "./mantik/rows.ts";
import { invalidateWork } from "../uretim/mantik/data.ts";
import { useConfirm, useToast } from "../../tezgah/index.ts";

interface Source {
  fileName: string;
  content: string;
}

export type Phase = { kind: "empty" } | { kind: "loading"; fileName: string } | { kind: "error"; message: string } | { kind: "ready" };

export type BulkKind = "errors" | "problems" | "duplicates";

/**
 * İçe aktarma masasının durumu ve eylemleri (görünümden bağımsız). Saf kararlar `mantik/{rows,desk}.ts`
 * içinde; burada yalnız durum, sunucu çağrıları, bildirim ve onay. Hiçbir metin kendiliğinden değişmez: müşteri metnine
 * yalnızca kullanıcının yazdığı ya da tıkladığı düzeltme dokunur, düzeltmeler bildirimden geri alınır.
 */
export function useMasa({ onClose, openBatch }: { onClose(): void; openBatch(batchId: string): void }) {
  const { t } = useTranslation("importDesk");
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  // "Aktar ve üret" ücretlidir (yapay zekâ izni + değiştirme). İzin yoksa `generate: true` hiç gönderilmez (sunucu 403
  // `FORBIDDEN` döner, hiçbir şey yazmaz); düğme pasif, kısayol bir şey yapmaz. Üretimsiz aktarma serbest.
  const canSpend = useCan("spend");
  const { current: language } = useDesignLanguage();

  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const rowsRef = useRef<ImportRow[]>([]);
  const [batchName, setBatchNameState] = useState("");
  const [filter, setFilter] = useState<RowFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const [committing, setCommitting] = useState<null | "plain" | "generate">(null);

  const source = useRef<Source | null>(null);
  const session = useRef(0);
  const tableRef = useRef<HTMLDivElement>(null);

  // Doğrulama sırası: satır başına düzenleme sürümü (yarış koruması) ve bekleyen satırlar.
  const revs = useRef(new Map<number, number>());
  const dirty = useRef(new Set<number>());
  const timer = useRef<number | undefined>(undefined);
  const validateFailed = useRef(false);

  const languageId = preview?.languageId ?? language?.id ?? null;

  const updateRows = useCallback((fn: (cur: ImportRow[]) => ImportRow[]) => {
    const next = fn(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  }, []);

  // ------------------------------------------------------------ doğrulama

  const flush = useCallback(async () => {
    timer.current = undefined;
    const idxs = [...dirty.current];
    dirty.current.clear();
    if (!idxs.length) return;
    const mine = session.current;
    const sent = new Map(idxs.map((i) => [i, revs.current.get(i) ?? 0]));
    const body = validateBody(languageId, rowsRef.current, idxs);
    const settle = () =>
      setPending((p) => {
        const n = new Set(p);
        for (const i of settledIndexes(sent, revs.current)) n.delete(i);
        return n;
      });
    try {
      const res = await api.post<ImportValidateResponse>(API.importValidate, body);
      if (mine !== session.current) return;
      updateRows((cur) => mergeValidated(cur, res.rows, sent, revs.current));
      validateFailed.current = false;
      settle();
    } catch (e) {
      if (mine !== session.current) return;
      settle();
      if (!validateFailed.current) {
        validateFailed.current = true;
        toast({ tone: "error", message: t("toast.validateFailed", { detail: serverText(e) }) });
      }
    }
  }, [languageId, t, toast, updateRows]);

  const queueValidation = useCallback(
    (indexes: number[]) => {
      if (!indexes.length) return;
      bumpRevs(revs.current, indexes);
      for (const i of indexes) dirty.current.add(i);
      setPending((p) => new Set([...p, ...indexes]));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), VALIDATE_DELAY);
    },
    [flush],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const patchRow = useCallback(
    (index: number, patch: RowPatch) => {
      updateRows((cur) => cur.map((r) => (r.index === index ? applyPatch(r, patch) : r)));
      setTouched(true);
      if (patchNeedsValidation(patch)) queueValidation([index]);
    },
    [queueValidation, updateRows],
  );

  /** Birden çok satıra yama; bildirimdeki "Geri al" önceki hâle döner (geri alma da yeniden doğrulanır). */
  const bulkPatch = useCallback(
    (patches: PatchList, message: string) => {
      if (!patches.length) return;
      const before = snapshotRows(rowsRef.current, patches.map((p) => p.index));
      updateRows((cur) => applyPatches(cur, patches));
      setTouched(true);
      queueValidation(validationIndexes(patches));
      toast({
        message,
        action: {
          label: t("toast.undo"),
          run: () => {
            updateRows((cur) => restoreRows(cur, before));
            queueValidation([...before.keys()]);
          },
        },
      });
    },
    [queueValidation, t, toast, updateRows],
  );

  // ------------------------------------------------------------ yükleme

  const load = useCallback(
    async (src: Source, mapping?: Partial<ImportPreviewResponse["mapping"]>) => {
      const mine = ++session.current;
      window.clearTimeout(timer.current);
      dirty.current.clear();
      revs.current.clear();
      setPending(new Set());
      source.current = src;
      setPhase({ kind: "loading", fileName: src.fileName });
      try {
        const res = await api.post<ImportPreviewResponse>(API.importPreview, previewBody(src.fileName, src.content, language?.id, mapping));
        if (mine !== session.current) return;
        setPreview(res);
        rowsRef.current = res.rows;
        setRows(res.rows);
        setBatchNameState((prev) => (mapping && prev ? prev : baseName(res.fileName || src.fileName)));
        setFilter("all");
        setSelected(new Set());
        anchor.current = null;
        setActiveIndex(res.rows[0]?.index ?? null);
        setEditingIndex(null);
        setPickerIndex(null);
        setTouched(false);
        setPhase({ kind: "ready" });
      } catch (e) {
        if (mine !== session.current) return;
        setPhase({ kind: "error", message: serverText(e) });
      }
    },
    [language?.id],
  );

  const loadFile = useCallback(
    async (file: File) => {
      const read = await readImportFile(file);
      if (!read.ok) {
        source.current = null;
        setPhase({ kind: "error", message: t(`file.${read.problem}`, { name: file.name }) });
        return;
      }
      await load({ fileName: file.name, content: read.content });
    },
    [load, t],
  );

  /** Elde düzenleme varken yeni veri gelirse sor. */
  const confirmReplace = useCallback(async (): Promise<boolean> => {
    if (!touched) return true;
    return confirm({ title: t("confirm.replace.title"), body: t("confirm.replace.body"), confirmLabel: t("confirm.replace.ok"), tone: "danger" });
  }, [confirm, t, touched]);

  const acceptFile = useCallback(
    async (file: File) => {
      if (await confirmReplace()) await loadFile(file);
    },
    [confirmReplace, loadFile],
  );

  const acceptText = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      if (await confirmReplace()) await load({ fileName: PASTED_FILE_NAME, content: text });
    },
    [confirmReplace, load],
  );

  const retry = useCallback(() => {
    if (source.current) void load(source.current);
  }, [load]);

  // Ctrl+V: panodaki JSON metni (ya da kopyalanan dosya) masaya yüklenir.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("dialog[open]")) return;
      const file = e.clipboardData?.files?.[0];
      if (file) {
        e.preventDefault();
        void acceptFile(file);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim()) {
        e.preventDefault();
        void acceptText(text);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFile, acceptText]);

  // Kaydedilmemiş düzenleme varken sekmeyi kapatma/yenileme uyarısı (tarayıcının kendi uyarısı).
  useEffect(() => {
    if (!touched) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [touched]);

  // ------------------------------------------------------------ eşleme

  const changeMapping = useCallback(
    async (field: ImportField, value: string | null) => {
      if (!preview || !source.current) return;
      if (touched) {
        const ok = await confirm({ title: t("confirm.mapping.title"), body: t("confirm.mapping.body"), confirmLabel: t("confirm.mapping.ok"), tone: "danger" });
        if (!ok) return;
      }
      await load(source.current, nextMapping(preview.mapping, field, value));
    },
    [confirm, load, preview, t, touched],
  );

  // ------------------------------------------------------------ türetilmiş

  const tally = useMemo(() => tallyRows(rows), [rows]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const visibleIdx = useMemo(() => visible.map((r) => r.index), [visible]);
  const bulk = useMemo(() => bulkCounts(rows), [rows]);
  const styledPatches = useMemo(() => plainLetterPatches(rows), [rows]);

  // ------------------------------------------------------------ odak ve kaydırma

  const focusField = useCallback((index: number, field: string) => {
    window.requestAnimationFrame(() => {
      const el = tableRef.current?.querySelector<HTMLElement>(`[data-row="${index}"] [data-field="${field}"]`);
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  }, []);

  const scrollTo = useCallback((index: number) => {
    window.requestAnimationFrame(() => tableRef.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView?.({ block: "nearest" }));
  }, []);

  const moveActive = useCallback(
    (index: number | null) => {
      if (index === null) return;
      setActiveIndex(index);
      scrollTo(index);
    },
    [scrollTo],
  );

  // ------------------------------------------------------------ satır eylemleri

  const startEdit = useCallback(
    (index: number) => {
      setActiveIndex(index);
      setEditingIndex(index);
      scrollTo(index);
    },
    [scrollTo],
  );
  const stopEdit = useCallback(() => setEditingIndex(null), []);
  const setPicker = useCallback((index: number, open: boolean) => setPickerIndex((cur) => (open ? index : cur === index ? null : cur)), []);

  const select = useCallback(
    (index: number, mods: SelectMods) => {
      setSelected((prev) => {
        const out = selectRow(prev, visibleIdx, anchor.current, index, mods);
        anchor.current = out.anchor;
        return out.selected;
      });
    },
    [visibleIdx],
  );
  const selectAllVisible = useCallback((on: boolean) => setSelected((prev) => selectVisible(prev, visibleIdx, on)), [visibleIdx]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  /** Sorun düzeltmesi: değer taşıyan düzeltme yama olur (geri alınabilir); değersizse ilgili alan açılır. */
  const fix = useCallback(
    (index: number, issue: Issue, f: FixAction) => {
      const row = getRow(rowsRef.current, index);
      if (!row) return;
      const out = resolveFix(row, issue, f);
      switch (out.type) {
        case "patch":
          bulkPatch([{ index, patch: out.patch }], t("toast.fixApplied", { fix: fixLabel(f) }));
          break;
        case "focus":
          focusField(index, out.field);
          break;
        case "edit-text":
          startEdit(index);
          break;
        case "pick-template":
          setPickerIndex(index);
          break;
        case "open-template":
          window.open(routeHash("sablonlar", [out.key]), "_blank", "noopener");
          break;
        case "none":
          break;
      }
    },
    [bulkPatch, focusField, startEdit, t],
  );

  const toggleInclude = useCallback(
    (index: number) => {
      const r = getRow(rowsRef.current, index);
      if (r) patchRow(index, { include: !r.include });
    },
    [patchRow],
  );

  /** "Satır ekle": tablonun sonuna boş satır; metni hemen düzenlenir, sorunları sunucu denetler. */
  const addRow = useCallback(() => {
    const blank = blankRow(rowsRef.current);
    updateRows((cur) => [...cur, blank]);
    setTouched(true);
    setFilter("all");
    queueValidation([blank.index]);
    startEdit(blank.index);
  }, [queueValidation, startEdit, updateRows]);

  // ------------------------------------------------------------ toplu işlemler

  const excludeWhere = useCallback(
    (kind: BulkKind) => {
      const pred = kind === "errors" ? isErrorRow : kind === "problems" ? isProblem : isDuplicate;
      const ps = excludePatches(rowsRef.current, pred);
      bulkPatch(ps, t(`toast.excluded.${kind}`, { count: ps.length }));
    },
    [bulkPatch, t],
  );

  const includeAll = useCallback(() => {
    const ps = includeAllPatches(rowsRef.current);
    bulkPatch(ps, t("toast.includedAgain", { count: ps.length }));
  }, [bulkPatch, t]);

  const setIncludeFor = useCallback(
    (indexes: Iterable<number>, include: boolean) => {
      const ps = setIncludePatches(rowsRef.current, indexes, include);
      if (ps.length) bulkPatch(ps, t(include ? "toast.included" : "toast.excludedRows", { count: ps.length }));
    },
    [bulkPatch, t],
  );

  const assignTemplate = useCallback(
    (key: string | null) => {
      const ps = templatePatches(selected, key);
      bulkPatch(ps, key ? t("toast.templateAssigned", { count: ps.length, key }) : t("toast.templateCleared", { count: ps.length }));
    },
    [bulkPatch, selected, t],
  );

  const convertStyled = useCallback(() => {
    const ps = plainLetterPatches(rowsRef.current);
    bulkPatch(ps, t("toast.plainLetters", { count: ps.length }));
  }, [bulkPatch, t]);

  const setBatchName = useCallback((v: string) => {
    setBatchNameState(v);
    setTouched(true);
  }, []);

  // ------------------------------------------------------------ kapat ve kaydet

  const requestClose = useCallback(async () => {
    if (committing) return;
    if (touched) {
      const ok = await confirm({ title: t("confirm.close.title"), body: t("confirm.close.body"), confirmLabel: t("confirm.close.ok"), tone: "danger" });
      if (!ok) return;
    }
    onClose();
  }, [committing, confirm, onClose, t, touched]);

  const commit = useCallback(
    async (generate: boolean) => {
      if (!preview || committing || tally.importable === 0) return;
      if (generate && !canSpend) return;
      setCommitting(generate ? "generate" : "plain");
      try {
        const res = await api.post<ImportCommitResponse>(API.importCommit, commitBody(preview, batchName, rowsRef.current, generate));
        invalidateWork(qc);
        const message = res.notQueued
          ? t("toast.importedNotQueued", { count: res.created, reason: notQueuedText(res.notQueued) })
          : generate && res.queued.length
            ? t("toast.importedQueued", { count: res.created, queued: res.queued.length })
            : t("toast.imported", { count: res.created });
        toast({ tone: "success", message, action: { label: t("toast.openBatch"), run: () => openBatch(res.batchId) } });
        setTouched(false);
        onClose();
      } catch (e) {
        toast({ tone: "error", message: t("toast.importFailed", { detail: serverText(e) }) });
        setCommitting(null);
      }
    },
    [batchName, canSpend, committing, onClose, openBatch, preview, qc, t, tally.importable, toast],
  );

  // ------------------------------------------------------------ gezinme

  const nextProblem = useCallback(
    (dir: 1 | -1) => {
      const next = problemStep(visible, activeIndex, dir);
      if (next === null) toast({ message: t("toast.noProblems") });
      else moveActive(next);
    },
    [activeIndex, moveActive, t, toast, visible],
  );
  const step = useCallback((dir: 1 | -1) => moveActive(stepActive(visibleIdx, activeIndex, dir)), [activeIndex, moveActive, visibleIdx]);

  return {
    phase,
    preview,
    rows,
    visible,
    visibleIdx,
    tally,
    counts,
    bulk,
    styledCount: styledPatches.length,
    batchName,
    filter,
    selected,
    activeIndex,
    editingIndex,
    pickerIndex,
    touched,
    pending,
    committing,
    languageId,
    tableRef,
    setFilter,
    setBatchName,
    setActiveIndex,
    loadFile,
    acceptFile,
    acceptText,
    retry,
    canRetry: !!source.current,
    changeMapping,
    patchRow,
    fix,
    toggleInclude,
    addRow,
    startEdit,
    stopEdit,
    setPicker,
    select,
    selectAllVisible,
    clearSelection,
    excludeWhere,
    includeAll,
    setIncludeFor,
    assignTemplate,
    convertStyled,
    requestClose,
    commit,
    nextProblem,
    step,
  };
}

export type Masa = ReturnType<typeof useMasa>;
