import "./kisayollar.ts";
import "./uretim.css";
import type { FixAction, Issue, JobPatch, VariantSummary } from "@tagpress/domain";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type TransitionEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCan } from "../../lib/access.ts";
import type { EkranProps, Go } from "../../lib/route.ts";
import { ElleEkle, useDesignLanguage } from "../../ortak/index.ts";
import { useShelf } from "../baski/mantik/api.ts";
import { canAdjust } from "../duzelt/mantik/adjust-math.ts";
import { DuzeltPenceresi, type HizliDuzeltHandle } from "../duzelt/gomulu.tsx";
import { setPendingImport } from "../ice-aktar/bekleyen.ts";
import { AppFrame, BandButton, Button, Dialog, EmptyState, Icon, useCommands, useConfirm, useToast, WorkRow } from "../../tezgah/index.ts";
import { IntakeEmpty, IntakeStrip, useFileDrop, usePasteOrders } from "./Alim.tsx";
import { SidePanel } from "./IsPaneli.tsx";
import { Board } from "./Izgara.tsx";
import { invalidateWork, useBatches, useJob, useJobLog, useJobOps, useJobs, useLabelSizes, useProgress, useTemplates, useVariantDetail } from "./mantik/data.ts";
import { afterApprove, boardOf, isBusy, isProblem, pruneIds, type Section, SECTIONS, sectionCounts, sectionOf, SORT_CHOICES, type SortChoice, stepIn, toggleId, typeCounts, variantAtKey, variantsByNo } from "./mantik/jobs.ts";
import { approveCheck, fixStep, focusedVariant, freshestJob, mergeIssues } from "./mantik/masa.ts";
import { lastUpload, pastedSource, type UploadSource } from "./mantik/yukle.ts";
import { ACCEPT_ATTR } from "../ice-aktar/mantik/desk.ts";
import { ImageForm, type ImageOpts } from "./parcalar.tsx";

/**
 * Üretim (sahip kararı 2026-11-24; tuval "Üretim sadeleştirme"): sütun ekranı. Üstte alım alanı (Dosya yükle, Elle ekle),
 * altında üç bölümlü ızgara (Üretilmeyi bekleyenler, Düzenle, Onaylandı). Karta tıklayınca sağ panel sütunun hemen
 * sağında açılır (`?is=<iş>`; sahip kararı 2026-11-24): sütun sola kayar, ikisi birlikte ortalanır; seçenekler, gömülü
 * küçük tezgâh, onay. İş satırında Bekleyen → Düzenle → Onaylı, Baskı masası ve ⋯; iş satırı panelle kıpırdamaz.
 */
export default function UretimEkrani({ route, go }: EkranProps) {
  const { t } = useTranslation("production");
  const { current, loading } = useDesignLanguage();
  if (current) return <Production key={current.id} languageId={current.id} route={route} go={go} />;
  return (
    <AppFrame band="work" active="uretim" workRow={<WorkRow crumbs={[{ label: t("title") }]} />}>
      <div className="ur-page">
        <div className="ur-grp">
          <div className="ur-col">
            {loading ? (
              <div className="ur-wait" aria-busy="true" />
            ) : (
              <EmptyState
                icon="tag"
                title={t("empty.noLanguage")}
                action={
                  <Button variant="primary" onClick={() => go("ayarlar", ["tasarim-dilleri"])}>
                    {t("empty.toSettings")}
                  </Button>
                }
              />
            )}
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

/** Panel geçişinin süresi (ms); `uretim.css` `--ur-slide` ile aynı. */
const SLIDE_MS = 280;

/** Hareketi azalt açıksa panel geçişsiz açılır ve kapanır (CSS de geçişi kapatır). */
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Odak bir denetimdeyse (düğme, onay kutusu, bağlantı) Enter onundur: kısayol çalışmaz. */
function onControl(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el?.closest?.("button, a[href], [role=checkbox], [role=radio], [role=tab], [role=switch], summary, select");
}

/** Gömülü küçük tezgâhın içindeki tuş (oklar orada yazıyı kaydırabilir): panelde gezinme çalışmaz. */
const inQuick = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.(".ur-quick");

function Production({ languageId, route, go }: { languageId: string; route: EkranProps["route"]; go: Go }) {
  const { t } = useTranslation("production");
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const ops = useJobOps();
  const progress = useProgress();
  const canSpend = useCan("spend");
  const currentId = route.query.get("is");

  const jobsQ = useJobs({ languageId });
  const batchesQ = useBatches(languageId);
  const templatesQ = useTemplates(languageId);
  const shelfQ = useShelf(languageId);
  const sizesQ = useLabelSizes(languageId);
  const jobs = useMemo(() => jobsQ.data?.jobs ?? [], [jobsQ.data]);
  const byId = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const defaultSize = sizesQ.data?.defaultSize;

  // ---- süzgeç ve ızgara
  const [query, setQuery] = useState("");
  const [problems, setProblems] = useState(false);
  const [type, setType] = useState<string | null>(null);
  const [sort, setSort] = useState<SortChoice>(SORT_CHOICES[0] as SortChoice);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const board = useMemo(() => boardOf(jobs, { query, problems, type, sort: sort.sort, dir: sort.dir, defaultSize }), [jobs, query, problems, type, sort, defaultSize]);
  const counts = useMemo(() => sectionCounts(jobs), [jobs]);
  const types = useMemo(() => typeCounts(jobs, defaultSize), [jobs, defaultSize]);
  const problemCount = useMemo(() => jobs.filter(isProblem).length, [jobs]);
  const selectable = useMemo(() => board.pending.filter((j) => !isBusy(j)).map((j) => j.id), [board]);
  const shown = board.pending.length + board.edit.length + board.approved.length;
  const settled = jobsQ.isSuccess && !jobsQ.isFetching;
  const templateImages = useMemo(() => new Map((templatesQ.data ?? []).filter((x) => !x.fileMissing).map((x) => [x.template.key, x.imageUrl])), [templatesQ.data]);

  useEffect(() => {
    if (!settled) return;
    const next = pruneIds(selected, selectable);
    if (next !== selected) setSelected(next);
  }, [settled, selectable, selected]);

  // ---- bölümlere kaydırma ve şeritte bulunulan bölüm
  const pageRef = useRef<HTMLDivElement>(null);
  const secEls = useRef<Partial<Record<Section, HTMLElement | null>>>({});
  const sectionRef = useCallback((s: Section) => (el: HTMLElement | null) => void (secEls.current[s] = el), []);
  const [inView, setInView] = useState<Section | null>(null);
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const spy = () => {
      let cur: Section | null = null;
      for (const s of SECTIONS) {
        const el = secEls.current[s];
        if (el && el.offsetTop - 80 <= page.scrollTop) cur = s;
      }
      setInView(cur ?? SECTIONS.find((s) => secEls.current[s]) ?? null);
    };
    spy();
    page.addEventListener("scroll", spy, { passive: true });
    return () => page.removeEventListener("scroll", spy);
  }, [shown]);
  const scrollTo = (s: Section) => {
    if (problems || type || query) {
      // Süzgeç bölümü gizlemiş olabilir: önce temizlenir.
      setProblems(false);
      setType(null);
      setQuery("");
    }
    requestAnimationFrame(() => {
      const el = secEls.current[s];
      if (el && pageRef.current) pageRef.current.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    });
  };

  // ---- açık iş (sağ panel)
  const setCurrent = useCallback((id: string | null) => go("uretim", [], { is: id }, true), [go]);
  const listJob = currentId ? byId.get(currentId) : undefined;
  const detailQ = useJob(listJob ? (currentId as string) : null);
  const job = listJob ? freshestJob(detailQ.data, listJob) : null;
  const jobVariants = job?.variants;
  const variants = useMemo(() => (jobVariants ? variantsByNo(jobVariants) : []), [jobVariants]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const focused = job ? focusedVariant(variants, focusId, job) : null;
  const variantQ = useVariantDetail(focused?.id ?? null);
  const issues = job ? mergeIssues(job.issues, variantQ.data?.issues) : [];
  const logQ = useJobLog(job?.id ?? null, !!job && variants.length > 0);
  const section = job ? sectionOf(job) : null;
  const sectionOrder = useMemo(() => (section ? board[section].map((j) => j.id) : []), [board, section]);
  const posIndex = currentId ? sectionOrder.indexOf(currentId) : -1;

  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [revise, setRevise] = useState({ open: false, value: "" });
  const [bigEdit, setBigEdit] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const quickRef = useRef<HizliDuzeltHandle>(null);
  const reviseRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refs = { text: useRef<HTMLTextAreaElement>(null), quantity: useRef<HTMLInputElement>(null), order: useRef<HTMLInputElement>(null), size: useRef<HTMLSelectElement>(null) };

  useEffect(() => {
    setFocusId(null);
    setRevise({ open: false, value: "" });
    setPickerOpen(false);
    setInfoOpen(false);
  }, [currentId]);

  // Açık kart görünür alana (en yakın kenara); sütun daralınca satırlar değişir, geçiş bitince bir kez daha.
  const showCurrent = useCallback(() => {
    if (currentId) pageRef.current?.querySelector<HTMLElement>(`[data-job="${currentId.replace(/["\\]/g, "")}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [currentId]);
  useEffect(showCurrent, [showCurrent]);

  const close = () => setCurrent(null);
  const step = (d: 1 | -1) => {
    const next = stepIn(sectionOrder, currentId, d);
    if (next) setCurrent(next);
  };

  // ---- yükleme
  const [uploading, setUploading] = useState(false);
  const openDesk = useCallback(
    (file: File) => {
      setPendingImport(file);
      go("uretim", ["ice-aktar"]);
    },
    [go],
  );
  const upload = useCallback(
    async (src: UploadSource) => {
      setUploading(true);
      const r = await ops.upload(src, languageId, openDesk);
      setUploading(false);
      if (r && r.created > 0) {
        setProblems(false);
        setType(null);
        setQuery("");
        requestAnimationFrame(() => {
          const el = secEls.current.pending;
          if (el && pageRef.current) pageRef.current.scrollTo({ top: el.offsetTop - 12 });
        });
      }
    },
    [ops, languageId, openDesk],
  );
  const onFile = useCallback((file: File) => void upload({ file }), [upload]);
  const dragging = useFileDrop(onFile);
  usePasteOrders(useCallback((text: string) => void upload(pastedSource(text)), [upload]));
  const chooseFile = () => fileRef.current?.click();

  // ---- eylemler
  const generateSelected = async () => {
    const ids = selectable.filter((id) => selected.has(id));
    if (!ids.length) return;
    const r = await ops.generate(ids);
    if (r) setSelected(new Set());
  };
  const deleteJob = async (id: string) => {
    const wasOpen = id === currentId;
    const next = wasOpen ? stepIn(sectionOrder, id, 1) : null;
    const r = await ops.deleteJobs([id]);
    if (r && wasOpen) setCurrent(next && next !== id ? next : null);
  };
  const approve = async () => {
    if (!job || !focused || locked) return;
    const check = approveCheck(focused);
    if (check === "skip") return;
    if (check === "confirm-stale" && !(await confirm({ title: t("approve.staleTitle"), body: t("approve.staleBody"), confirmLabel: t("approve.staleConfirm") }))) return;
    setLocked(true);
    // Küçük tezgâhta bekleyen düzeltme önce kaydedilir; kayıt olmazsa onaylanmaz.
    const saved = (await quickRef.current?.flush()) ?? true;
    if (!saved) {
      setLocked(false);
      return;
    }
    const before = sectionOf(job) === "edit" ? sectionOrder : [];
    const approvedId = job.id;
    const no = focused.no;
    const r = await ops.approve(approvedId, focused.id);
    setLocked(false);
    if (!r) return;
    toast({
      tone: "success",
      message: job.orderNo ? t("approve.doneOrder", { order: job.orderNo, no }) : t("approve.done", { no }),
      action: { label: t("approve.undo"), run: () => void ops.approve(approvedId, null) },
    });
    if (before.length) {
      const next = afterApprove(before, approvedId);
      if (next) setCurrent(next);
      else close();
    }
  };
  const unapprove = async () => {
    if (job) await ops.approve(job.id, null);
  };
  const regenerate = async () => {
    if (!job || isBusy(job)) return;
    setBusy(true);
    await ops.generate([job.id]);
    setBusy(false);
  };
  const sendRevise = async (request: string) => {
    const req = request.trim();
    if (!req || !focused) return;
    setBusy(true);
    const r = await ops.revise(focused.id, req);
    setBusy(false);
    if (r) setRevise({ open: false, value: "" });
  };
  const openRevise = (open: boolean) => {
    setRevise((r) => ({ ...r, open }));
    if (open) requestAnimationFrame(() => reviseRef.current?.focus());
  };
  const patch = (p: JobPatch) => (job ? ops.patchJob(job.id, p) : Promise.resolve(null));
  const openBig = async () => {
    if (!focused || !canAdjust(focused)) return;
    await quickRef.current?.flush();
    setBigEdit(focused.id);
  };
  const focusField = (field: "text" | "quantity" | "order" | "size") => {
    if (field !== "text") setInfoOpen(true);
    requestAnimationFrame(() => {
      const el = refs[field].current;
      el?.focus();
      if (field === "text") refs.text.current?.select();
    });
  };

  const fix = async (issue: Issue, f: FixAction) => {
    if (!job) return;
    const s = fixStep(issue, f, { text: job.text, templateKey: job.templateKey, dismissed: job.dismissed }, !!focused);
    switch (s.do) {
      case "focus":
        focusField(s.field);
        break;
      case "patch": {
        const r = await patch(s.patch);
        const undo = s.undo;
        if (r && undo) toast({ message: t("fix.converted"), action: { label: t("toast.undo"), run: () => void patch(undo) } });
        break;
      }
      case "pickTemplate":
        setInfoOpen(true);
        setPickerOpen(true);
        break;
      case "openTemplate":
        go("sablonlar", [s.key]);
        break;
      case "regenerate":
        await regenerate();
        break;
      case "revise":
        await sendRevise(s.request);
        break;
      case "draftRevise":
        setRevise({ open: true, value: s.request ?? revise.value });
        requestAnimationFrame(() => reviseRef.current?.focus());
        break;
      case "refuse":
        toast({ tone: "error", message: t("fix.refused") });
        break;
      case "none":
        break;
    }
  };

  // ---- kısayollar
  const panelOpen = !!job;
  const quiet = () => false as const;
  useCommands("uretim", {
    "uretim.pick": (e) => {
      if (!panelOpen) return false;
      const n = Number(/(\d)$/.exec(e.code)?.[1] ?? e.key);
      const v = variantAtKey(variants, n);
      if (!v) return false;
      setFocusId(v.id);
    },
    "uretim.approve": (e) => {
      if (!panelOpen || onControl(e) || !focused || focused.approved) return false;
      void approve();
    },
    "uretim.adjust": () => {
      if (!focused || !canAdjust(focused)) return false;
      void openBig();
    },
    "uretim.next": (e) => (panelOpen && !inQuick(e) ? step(1) : quiet()),
    "uretim.prev": (e) => (panelOpen && !inQuick(e) ? step(-1) : quiet()),
    "uretim.editText": () => {
      if (!panelOpen) return false;
      focusField("text");
    },
    "uretim.revise": () => {
      if (!focused || !canSpend) return false;
      openRevise(true);
    },
    "uretim.regenerate": () => {
      if (!job || !canSpend) return false;
      void regenerate();
    },
    "uretim.delete": () => {
      if (!job) return false;
      void deleteJob(job.id);
    },
    "uretim.close": () => {
      if (!panelOpen) return false;
      close();
    },
    "uretim.search": () => searchRef.current?.focus(),
    "uretim.upload": () => chooseFile(),
    "uretim.generate": () => {
      if (!canSpend || !selectable.some((id) => selected.has(id))) return false;
      void generateSelected();
    },
    "uretim.approveBest": () => {
      if (!board.edit.length) return false;
      void ops.approveBest(board.edit.map((j) => j.id));
    },
  });

  // ---- iş satırı: Bekleyen → Düzenle → Onaylı, Baskı masası, ⋯
  const activeSection = section ?? inView;
  const shelf = shelfQ.data?.items.length ?? counts.approved;
  const workRow = (
    <WorkRow
      crumbs={[{ label: t("title") }]}
      flow={SECTIONS.map((s) => ({
        id: s,
        label: t(`sections.${s}.short`),
        count: counts[s],
        active: jobs.length > 0 && activeSection === s,
        hint: t(`sections.${s}.hint`, { count: counts[s] }),
        onClick: () => {
          if (counts[s] > 0) scrollTo(s);
        },
      }))}
      actions={
        <>
          <button type="button" className="tz-cb is-q ur-print" onClick={() => go("baski")}>
            <Icon name="print" size={15} />
            {t("strip.print")}
            <b className="tz-mono">{shelf}</b>
            <Icon name="right" size={12} />
          </button>
          <BandButton label={t("strip.more")} icon="dots" quiet menuItems={[{ label: t("strip.detailedImport"), icon: "filep", onSelect: () => go("uretim", ["ice-aktar"]) }]} />
        </>
      }
    />
  );

  // ---- sağ panelin yeri (sahip kararı 2026-11-24): sütunun hemen sağında açılır, sütun sola kayar ve ikisi birlikte
  // ortalanır; iş satırı kıpırdamaz. Kapanırken panel geçiş bitene dek son hâliyle, etkisiz (`inert`) durur.
  const panel = job && section ? (
    <SidePanel
      job={job}
      languageId={languageId}
      sizes={sizesQ.data?.sizes ?? []}
      defaultSize={defaultSize}
      variants={variants}
      focused={focused}
      variantDetail={variantQ.data}
      issues={issues}
      log={logQ.data}
      logLoading={logQ.isLoading}
      progress={progress[job.id]}
      refs={refs}
      position={{ section, index: Math.max(0, posIndex), total: Math.max(sectionOrder.length, 1) }}
      pickerOpen={pickerOpen}
      onPickerOpen={setPickerOpen}
      infoOpen={infoOpen}
      locked={locked}
      busy={busy}
      canSpend={canSpend}
      quickRef={quickRef}
      revise={{ open: revise.open, value: revise.value, ref: reviseRef }}
      onReviseChange={(value) => setRevise((r) => ({ ...r, value }))}
      onReviseOpen={openRevise}
      onRevise={() => void sendRevise(revise.value)}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onClose={close}
      onPatch={patch}
      onFix={(i, f) => void fix(i, f)}
      onRegenerate={() => void regenerate()}
      onImage={() => setImageOpen(true)}
      onSaveNote={(n) => void ops.setAiNote([job.id], n)}
      onFocus={setFocusId}
      onApprove={() => void approve()}
      onUnapprove={() => void unapprove()}
      onAdjust={() => void openBig()}
      onQuickSaved={() => invalidateWork(qc)}
      onPrint={() => go("baski")}
      onOpenTemplate={(k) => go("sablonlar", [k])}
      onDeleteJob={() => void deleteJob(job.id)}
      onDeleteVariant={async (v: VariantSummary) => {
        const r = await ops.deleteVariant(v.id);
        if (r) setFocusId(null);
      }}
      onToggleSuspect={(v: VariantSummary) => void ops.setSuspect(v.id, !v.suspect)}
    />
  ) : null;
  const open = !!panel;
  const held = useRef<ReactNode>(null);
  if (panel) held.current = panel;
  const [wasOpen, setWasOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setClosing(!open && !reducedMotion());
  }
  useEffect(() => {
    if (!closing) return;
    // Geçiş sonu olayı gelmezse (sekme arka planda, test ortamı) panel yine kalkar.
    const timer = window.setTimeout(() => setClosing(false), SLIDE_MS + 120);
    return () => window.clearTimeout(timer);
  }, [closing]);
  const onSlideEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== "grid-template-columns") return;
    if (open) showCurrent();
    else setClosing(false);
  };

  const empty = settled && jobs.length === 0;
  return (
    <AppFrame band="work" active="uretim" workRow={workRow}>
      <div className="ur-page">
        <div className={open ? "ur-grp is-open" : "ur-grp"} data-panel={open ? "open" : closing ? "closing" : "closed"} onTransitionEnd={onSlideEnd}>
          <div ref={pageRef} className="ur-col">
            {jobsQ.isLoading && jobs.length === 0 ? (
              <div className="ur-wait" aria-busy="true" />
            ) : empty || (jobsQ.isError && jobs.length === 0) ? (
              <IntakeEmpty languageId={languageId} uploading={uploading} onChoose={chooseFile} onAdded={() => undefined} />
            ) : (
              <>
                <IntakeStrip last={lastUpload(batchesQ.data)} uploading={uploading} onChoose={chooseFile} onManual={() => setManualOpen(true)} />
                <Board
                  board={board}
                  noMatch={jobs.length > 0 && shown === 0}
                  query={query}
                  onQuery={setQuery}
                  searchRef={searchRef}
                  problemCount={problemCount}
                  problems={problems}
                  onProblems={setProblems}
                  types={types}
                  type={type}
                  onType={setType}
                  sort={sort}
                  onSort={setSort}
                  onClearFilter={() => {
                    setQuery("");
                    setProblems(false);
                    setType(null);
                  }}
                  defaultSize={defaultSize}
                  currentId={currentId}
                  selected={selected}
                  selectable={selectable}
                  onToggle={(id) => setSelected((s) => toggleId(s, id))}
                  onSelectAll={(all) => setSelected(all ? new Set(selectable) : new Set())}
                  canSpend={canSpend}
                  onGenerate={() => void generateSelected()}
                  onRetry={(id) => void ops.generate([id])}
                  onApproveBest={() => void ops.approveBest(board.edit.map((j) => j.id))}
                  onPrint={() => go("baski")}
                  onOpen={(id) => setCurrent(id === currentId ? null : id)}
                  onDelete={(id) => void deleteJob(id)}
                  progress={progress}
                  templateImages={templateImages}
                  sectionRef={sectionRef}
                />
              </>
            )}
          </div>
          {(open || closing) && (
            <div className="ur-side-slot" inert={!open}>
              {panel ?? held.current}
            </div>
          )}
        </div>
      </div>

      {bigEdit && (
        <DuzeltPenceresi
          variantId={bigEdit}
          onClose={() => {
            setBigEdit(null);
            invalidateWork(qc);
          }}
        />
      )}
      {imageOpen && job && (
        <Dialog title={t("panel.image")} size="sm" onClose={() => setImageOpen(false)}>
          <ImageForm
            count={1}
            onRun={(o: ImageOpts) => {
              setImageOpen(false);
              void ops.generate([job.id], o);
            }}
          />
        </Dialog>
      )}
      <ElleEkle open={manualOpen} languageId={languageId} onClose={() => setManualOpen(false)} onAdded={() => undefined} />
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ATTR}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
      {dragging && (
        <div className="ur-dropall" aria-hidden="true">
          <Icon name="up" />
          <b>{t("drop.title")}</b>
          <span>{t("drop.body")}</span>
        </div>
      )}
    </AppFrame>
  );
}
