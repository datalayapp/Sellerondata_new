import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth, usePermission } from "../auth/AuthContext";
import { firmCurrency } from "../lib/currency";
import {
  HARD_ROW_FLAGS,
  type FieldSources,
  type MappingDiagnostics,
} from "@deciship/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { carriers, invoices, jobs } from "../api/endpoints";
import type {
  AiMappingResult,
  ColumnMapping,
  InvoiceCreateResult,
  InvoiceOverlap,
  InvoicePreview,
  JobView,
  MappingIssues,
  PdfWeightAmbiguity,
  ResumablePreview,
} from "../api/types";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { Button, Empty, Modal, ModalAction, PageHeader } from "../components/ui";
import i18next from "i18next";
import { fmtNum, getFormatLocale } from "../lib/format";
import { MAPPING_FIELDS } from "../lib/labels";
import { useReturnTo } from "../lib/returnTo";
import { useJob } from "../lib/useJob";
import { JobLeft, JobStopped, waitJob } from "../lib/waitJob";
import { latestRequest, unlessAborted } from "../lib/latestRequest";
import { ReturnBar } from "../components/ReturnBar";
import { useLeaveGuard } from "../components/LeaveGuard";
import { MappingStep } from "./invoice-upload/MappingStep";
import { MetaStep, WizbarMsg } from "./invoice-upload/MetaStep";
import { PdfLinesStep, fromPdfRow, pdfRowInvalid, pdfWeightConfirmed, relocalizePdfRows, toPdfRow, withPdfWeightAsks, type PdfRow } from "./invoice-upload/PdfStep";
import { StepOne } from "./invoice-upload/StepOne";
import { NO_FILE, beginImport, importFailed, importSucceeded, previewArrived, takeDiscard, type LiveFile } from "./invoice-upload/liveFile";
import { canContinue, isEdited, planCarrierPick, planFilePick, rereadFresh, rowsKey, switchTariff, type FileKey, type PreviewSource, type WorkState } from "./invoice-upload/wizardKeep";
import { MAX_MB, SLOW_IMPORT_MS, isBlockedPdf, emptyMapping, fillOf, guessedDay, pdfReadState, retryFresh, type Step } from "./invoice-upload/uploadUtils";
import { IssuesModal } from "./invoice-upload/Verification";
import { RESUMABLE_KEY, ResumeBand } from "./invoice-upload/ResumeBand";
import { useKeepPreview, useOpenPreviewBeacon } from "./invoice-upload/useKeepPreview";

export function InvoiceUploadPage() {
  const { t } = useTranslation("invoiceUpload");
  const { t: tInvoices } = useTranslation("invoices");
  const nav = useNavigate();
  // kurulum sihirbazından açıldıysa (?donus=) kayıttan sonra sihirbaza döner
  const ret = useReturnTo();
  const qc = useQueryClient();
  const cs = useQuery({ queryKey: ["carriers"], queryFn: carriers.list });
  const [step, setStep] = useState<Step>(1);
  const [sp] = useSearchParams();
  // ?tasiyici=<id> (kurulum sihirbazı) taşıyıcıyı önceden seçer
  const [carrierId, setCarrierId] = useState<string>(() => sp.get("tasiyici") ?? "");
  /** "" = henüz seçilmedi (TariffSelect fatura gününde geçerli tarifeyi, yoksa varsayılanı önseçer; K2) */
  const [tariffId, setTariffId] = useState<string>("");
  // Tarife kendiliğinden mi seçildi: kişi elle seçmediyse fatura tarihi değişince önseçim yenilenir (K2).
  const [tariffAuto, setTariffAuto] = useState(true);
  // Güncel taşıyıcı: bekleyen işlerin (okuma sonucu, sürdürme) sonunda eski kapanış değeri kullanılmasın.
  const carrierRef = useRef(carrierId);
  carrierRef.current = carrierId;
  // Taşıyıcı başına seçilen tarife: A→B→A tarifeyi sessizce sıfırlamaz (`switchTariff`).
  const tariffMemoRef = useRef<Record<string, string>>({});
  const { me, refreshMe } = useAuth();
  // K3: taşıyıcının kayıtlı eşlemesi bir taşıyıcı ayarıdır; yalnız ayar izni olan değiştirir (sunucu da yok sayar).
  const canRemember = usePermission("deciship.settings.manage");
  const [file, setFile] = useState<File | null>(null);
  // Y80-E2: sürdürme bandından açılan önizlemenin dosya adı (yerel `File` yok: "Yeniden oku" kapalı, ad başlıkta görünür)
  const [resumed, setResumed] = useState<{ name: string; size: number } | null>(null);
  const shownFile = file ?? resumed;
  // Y62-E3: "Yeniden oku" onayı (ücretli; ekrandaki düzeltmeler silinir). 10-B9: taşıyıcı ya da dosya değişince düzeltme
  // varsa aynı biçimde sorulur (`change`; onaylanınca `run`).
  // `change` seçimi tutar, kararı değil: onayda plan o anki duruma göre yeniden kurulur (arada okuma bitmiş olabilir).
  const [ask, setAsk] = useState<{ kind: "reread" } | { kind: "change"; pick: { carrier: string } | { file: File } } | null>(null);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  // 10-B5/10-B9: ekrandaki önizlemenin okunduğu dosya ve taşıyıcı. Önizleme 1. adıma dönünce ve yeniden okuma sürerken
  // kalır; yalnız yeni okuma uygulanınca ya da kullanıcı ondan gerçekten vazgeçince (başka dosya, sayfadan çıkış) gider.
  const [src, setSrc] = useState<PreviewSource | null>(null);
  // Okumadan hemen sonraki hâl: yeniden okuma bunu siler, düzeltme varsa önce sorulur (`isEdited`).
  const baseRef = useRef<WorkState | null>(null);
  const [metaEdited, setMetaEdited] = useState(false);
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping());
  const [saveMappingWish, setSaveMapping] = useState(true);
  // İzni yoksa eşleme hiç hatırlanmaz (kutu kapalı, istek `false`)
  const saveMapping = canRemember && saveMappingWish;
  const [pdfRows, setPdfRows] = useState<PdfRow[]>([]);
  // K36: arayüz dili değişince PDF hücreleri (ve "düzeltildi mi" tabanı) anlamını korur
  useEffect(() => {
    let prev = getFormatLocale();
    const onLang = () => {
      const next = getFormatLocale();
      if (next === prev) return;
      const from = prev;
      prev = next;
      setPdfRows((rows) => relocalizePdfRows(rows, from, next));
      const base = baseRef.current;
      if (base?.rows) baseRef.current = { ...base, rows: JSON.stringify(relocalizePdfRows(JSON.parse(base.rows) as Omit<PdfRow, "key">[], from, next)) };
    };
    i18next.on("languageChanged", onLang);
    return () => i18next.off("languageChanged", onLang);
  }, []);
  // Fatura tarihi dosyada yoksa boş kalır, kullanıcı seçer: bugünle doldurmak yanlış dönem ve itiraz süresi yazar.
  const [meta, setMeta] = useState({
    invoiceNo: "",
    invoiceDate: "",
    currency: firmCurrency(me),
  });
  const [found, setFound] = useState({ invoiceNo: false, invoiceDate: false });
  const [metaTouched, setMetaTouched] = useState(false);
  // Dosyadan okunan son tarih: kullanıcı tarihi elle değiştirdiyse yeni okuma üzerine yazmaz.
  const guessedDateRef = useRef("");
  // SPEC §11: alan kaynakları, güncel okuma kontrolü, yapay zekâ sonucu, onay pencereleri
  const [sources, setSources] = useState<FieldSources>({});
  const [diag, setDiag] = useState<MappingDiagnostics | undefined>();
  const [verifiedKey, setVerifiedKey] = useState("");
  const [ai, setAi] = useState<AiMappingResult | null>(null);
  const [gate, setGate] = useState<MappingIssues | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  // Aynı gönderiler başka faturada: yüklemeden önce bir kez sorulur.
  const [overlap, setOverlap] = useState<InvoiceOverlap | null>(null);
  const [overlapOpen, setOverlapOpen] = useState(false);
  const [overlapOk, setOverlapOkState] = useState(false);
  // "Yine de yükle" ile mutate aynı olayda çalışır; state eskimesin diye güncel değer ref'te de tutulur.
  const overlapOkRef = useRef(false);
  const setOverlapOk = (v: boolean) => {
    overlapOkRef.current = v;
    setOverlapOkState(v);
  };
  // Okuma kontrolü isteği düşen eşleme: eski sonuç gösterilmez, yeniden denenir.
  const [verifyFailedKey, setVerifyFailedKey] = useState("");
  const [verifyTry, setVerifyTry] = useState(0);

  const activeCarriers = (cs.data ?? []).filter((c) => c.active !== false);
  const carrier = activeCarriers.find((c) => c.id === carrierId) ?? null;
  // tek aktif taşıyıcı varsa o seçili gelir; geçersiz/pasif önseçim temizlenir
  useEffect(() => {
    if (!cs.data || carrier) return;
    const only = activeCarriers.length === 1 ? activeCarriers[0]!.id : "";
    if (only !== carrierId) setCarrierId(only);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cs.data]);

  // Okuma iptali: taşıyıcı değişince eski okuma yeniyi ezmesin. `seq` hangi okumanın güncel olduğunu söyler.
  // `fresh`: son okuma "Yeniden oku" ile başladı; `jobStarted`: sunucu okuma işini kabul etti. "Tekrar dene" yalnız iş
  // başlamadıysa `fresh` gider: başladıysa okuduğu parçalar önbellekte, yeni `fresh` iş onları yeniden ücretlerdi (`retryFresh`).
  // `freshUnapplied`: `fresh` bir okuma işi başladı ve ondan sonra hiçbir okuma uygulanmadı: sonraki "Yeniden oku" da `fresh`
  // göndermez (`rereadFresh`; o işin ücretlediği parçalar önbellekte).
  const readRef = useRef<{ seq: number; ctrl: AbortController | null; fresh: boolean; jobStarted: boolean; freshUnapplied: boolean }>({ seq: 0, ctrl: null, fresh: false, jobStarted: false, freshUnapplied: false });
  // Önizlemesi çıkmış ama içe aktarılmamış dosya: vazgeçilirse sunucuda silinir (Mesaj 7).
  // İçe aktarma sürerken dosya silinmeye açık sayılmaz (`liveFile.ts`).
  const liveFileRef = useRef<LiveFile>(NO_FILE);
  const dropLiveFile = () => {
    const { discard, next } = takeDiscard(liveFileRef.current);
    liveFileRef.current = next;
    if (discard) void invoices.discardPreview(discard);
  };
  /** Ekrandaki önizlemeden vazgeçilir: ekrandan kalkar, dosyasının silme çağrısı döner (çağıran gönderir). */
  const releasePreview = (): string | null => {
    const { discard, next } = takeDiscard(liveFileRef.current);
    liveFileRef.current = next;
    setPreview(null);
    setSrc(null);
    setResumed(null);
    baseRef.current = null;
    return discard;
  };
  const abandonPreview = () => {
    const discard = releasePreview();
    if (discard) void invoices.discardPreview(discard);
  };
  const keyOf = (f: File): FileKey => ({ name: f.name, size: f.size, lastModified: f.lastModified });
  // Süren PDF okuma işi (sayfa kapansa da sürer; ilerleme yoklanır) ve işin hatası. `src`: okunan dosya ve taşıyıcı.
  const [readJob, setReadJob] = useState<{ job: JobView; seq: number; src: PreviewSource } | null>(null);
  const [jobError, setJobError] = useState<ApiError | null>(null);
  const previewMut = useMutation({
    mutationFn: async ({ f, cid, discard, signal, fresh }: { f: File; cid: string; seq: number; discard: string | null; signal: AbortSignal; fresh: boolean }) => {
      try {
        // Vazgeçilen önizlemenin dosyası (başka dosya seçildi), yenisi başlamadan silinir. Aynı dosyanın yeniden okumasında
        // eski önizleme kalır ve yenisi uygulanınca silinir (`previewArrived`).
        if (discard) await invoices.discardPreview(discard);
        return await invoices.previewAsync(f, cid, signal, fresh);
      } catch (e) {
        if ((e as Error).name === "AbortError") return null;
        throw e;
      }
    },
    meta: { silent: true },
    onSuccess: (r, vars) => {
      // Başlayan `fresh` iş bırakılmış olsa da sunucuda sürer ve ücretlenir.
      if (r && "job" in r && vars.fresh) readRef.current.freshUnapplied = true;
      if (!r || vars.seq !== readRef.current.seq) return;
      const source = { file: keyOf(vars.f), carrierId: vars.cid };
      if ("job" in r) {
        readRef.current.jobStarted = true;
        setReadJob({ job: r.job, seq: vars.seq, src: source });
      }
      else applyPreview(r.preview, source);
    },
    // 10-B5: PDF okuması düştüyse (hak, hız sınırı, ağ) hak bilgisi yenilenir: hak dolduysa "Yeniden oku" gizlenir.
    onError: (_e, vars) => {
      if (vars.f.name.toLowerCase().endsWith(".pdf")) void refreshMe();
    },
  });
  const applyPreview = (p: InvoicePreview, source: PreviewSource) => {
    // Yeni okuma uygulanıyor: tutulan eski önizlemenin dosyası ancak şimdi silinir (10-B5).
    const { discard, next } = previewArrived(liveFileRef.current, p.fileId);
    liveFileRef.current = next;
    if (discard) void invoices.discardPreview(discard);
    readRef.current.freshUnapplied = false;
    // PDF okuması taşıyıcıya bağlı değil: okuma sürerken taşıyıcı değiştiyse önizleme güncel taşıyıcınındır (`retarget`).
    const pdf = p.format === "pdf";
    setSrc({ ...source, pdf, carrierId: pdf ? carrierRef.current : source.carrierId });
    // Okuma sürerken açılmış "yeniden okunsun mu?" sorusu eski duruma göreydi: kapanır, seçim yeniden yapılır.
    setAsk(null);
    setMetaEdited(false);
    setPreview(p);
    const guessedDate = guessedDay(p.guessedMeta?.invoiceDate);
    guessedDateRef.current = guessedDate;
    setMeta({
      invoiceNo: p.guessedMeta?.invoiceNo ?? "",
      invoiceDate: guessedDate,
      currency: p.guessedMeta?.currency ?? firmCurrency(me),
    });
    setFound({ invoiceNo: Boolean(p.guessedMeta?.invoiceNo), invoiceDate: Boolean(guessedDate) });
    setAi(null);
    setOverlap(p.format === "pdf" ? null : (p.overlap ?? null));
    setOverlapOk(false);
    setVerifyFailedKey("");
    if (p.format === "pdf") {
      // K36: PDF'te "1.500" gibi basılı ağırlıklar sorulur (sunucunun metin denetiminden)
      const rows = withPdfWeightAsks(p.aiLines.map(toPdfRow), p.pdfCheck?.rows ?? []);
      setPdfRows(rows);
      baseRef.current = { rows: rowsKey(rows), mapping: "", metaEdited: false };
    } else {
      const m = {
        ...emptyMapping(),
        ...p.suggestedMapping,
        surchargeColumns: p.suggestedMapping?.surchargeColumns ?? [],
      };
      setMapping(m);
      setVerifiedKey(JSON.stringify(m));
      baseRef.current = { rows: "", mapping: JSON.stringify(m), metaEdited: false };
      setDiag(p.diagnostics);
      setSources(p.fieldSources ?? {});
      // Sorunlu eşleme varsayılan olarak hatırlanmaz (SPEC §11.4).
      setSaveMapping(p.diagnostics?.verification?.verdict !== "check");
    }
    setStep(2);
    window.scrollTo({ top: 0 });
  };

  // PDF okuma işi: bitince bugünkü önizleme akışı sonuçla sürer; hata `job.error` ile görünür; durdurulursa dosya seçili kalır.
  const { job: liveJob, receivedAt: jobAt, stop: stopJob } = useJob(readJob?.job.id, {
    initial: readJob?.job,
    onFinish: (j) => {
      // 10-B5: her PDF okumasından sonra hak bilgisi yenilenir (son hak kullanıldıysa "Yeniden oku" gizlenir).
      void refreshMe();
      if (!readJob || readJob.job.id !== j.id || readJob.seq !== readRef.current.seq) return;
      setReadJob(null);
      if (j.status === "SUCCEEDED" && j.result) applyPreview(j.result as InvoicePreview, readJob.src);
      else if (j.status === "FAILED" && j.error) setJobError(new ApiError(j.error.statusCode, j.error.code, j.error.message, j.error.details));
    },
  });

  /**
   * `keepOld`: aynı dosya yeniden okunuyor ("Yeniden oku", taşıyıcı değişimi, "Tekrar dene"): ekrandaki önizleme ve dosyası
   * yenisi uygulanana kadar kalır; okuma düşer ya da durdurulursa 1. adımdaki "Devam" ile geri açılır (10-B5).
   * Değilse (başka dosya) önizlemeden vazgeçilir; dosyası mutasyonda, yeni istekten önce silinir.
   */
  const startRead = (f: File, cid: string, { fresh = false, keepOld = false }: { fresh?: boolean; keepOld?: boolean } = {}) => {
    const r = readRef.current;
    r.ctrl?.abort();
    const ctrl = new AbortController();
    r.ctrl = ctrl;
    r.seq += 1;
    r.fresh = fresh;
    r.jobStarted = false;
    // Okuma yalnız 1. adımda sürer ("Devam" kapalı): sonuç 2./3. adımda ya da içe aktarma sırasında ekranı değiştirmez.
    setStep(1);
    const discard = keepOld ? null : releasePreview();
    setReadJob(null);
    setJobError(null);
    previewMut.mutate({ f, cid, seq: r.seq, discard, signal: ctrl.signal, fresh });
  };
  // Y62-E3: okuma hak dolduğu için reddedildiyse ekran durumu (PDF seçeneği) yenilenir.
  const readError = previewMut.error ?? jobError;
  const quotaHit = readError instanceof ApiError && readError.code === "AI_QUOTA_EXCEEDED";
  useEffect(() => {
    if (quotaHit) void refreshMe();
  }, [quotaHit, refreshMe]);
  const stopRead = () => {
    const r = readRef.current;
    r.ctrl?.abort();
    r.ctrl = null;
    r.seq += 1;
    previewMut.reset();
    setReadJob(null);
    setJobError(null);
  };
  // Y80-E2: bantta "Devam et": okunmuş PDF'in sonucu işten alınır, dosya tazelenir (Y95) ve bugünkü önizleme akışı sürer.
  // Bundan sonra dosya bu sayfanın önizlemesidir: başka dosya seçmek ya da sayfadan çıkış onu da siler (vazgeçme kuralı aynı).
  const continueResume = async (item: ResumablePreview) => {
    const j = await jobs.get(item.jobId).catch(() => null);
    const ok = j?.status === "SUCCEEDED" && j.result != null && (await invoices.keepPreview(item.fileId));
    void qc.invalidateQueries({ queryKey: RESUMABLE_KEY });
    if (!ok || !j?.result) {
      toast.err(t("resume.gone"));
      return;
    }
    stopRead();
    abandonPreview();
    setFile(null);
    setResumed({ name: item.name, size: item.size });
    applyPreview(j.result as InvoicePreview, { file: null, carrierId: carrierRef.current });
  };
  // Sayfadan çıkılırsa süren okuma isteği bırakılır (iş sunucuda sürer); vazgeçilen önizlemenin dosyası silinir.
  useEffect(
    () => () => {
      readRef.current.ctrl?.abort();
      dropLiveFile();
    },
    [],
  );
  // Sekme kapanırken de (bfcache'e giden sayfa hariç).
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (!e.persisted) dropLiveFile();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // KALANLAR 6.18: büyük CSV/Excel arka planda içe aktarılır; ilerleme 3. adımda (JobProgress), sonuç ve hata bugünkü yoldan
  const [importJob, setImportJob] = useState<{ job: JobView; receivedAt: number } | null>(null);
  const importAliveRef = useRef(true);
  useEffect(() => {
    importAliveRef.current = true;
    return () => {
      importAliveRef.current = false;
    };
  }, []);
  const stopImport = async () => {
    if (!importJob) return;
    try {
      const job = await jobs.cancel(importJob.job.id);
      setImportJob({ job, receivedAt: Date.now() });
    } catch {
      /* iş bu arada bitti: gerçek durum yoklamayla gelir */
    }
  };

  const createMut = useMutation({
    mutationFn: async (acknowledgeIssues: boolean = false): Promise<InvoiceCreateResult> => {
      if (!preview || !carrier) throw new Error(t("errors.missingInfo"));
      const started = await invoices.create({
        fileId: preview.fileId,
        carrierId: carrier.id,
        invoiceNo: meta.invoiceNo.trim(),
        invoiceDate: meta.invoiceDate,
        currency: meta.currency,
        tariffId: tariffId || null,
        mapping: preview.format === "pdf" ? undefined : mapping,
        lines: preview.format === "pdf" ? pdfRows.map(fromPdfRow) : undefined,
        saveMapping: preview.format === "pdf" ? false : saveMapping,
        acknowledgeIssues,
        confirmOverlap: overlapOkRef.current,
        ...(preview.format === "pdf" ? { pdfWeightConfirmed: pdfWeightConfirmed(pdfRows) } : {}),
      });
      if (!("job" in started)) return started;
      // Onay penceresi kapanır: ilerleme ve "Durdur" 3. adımda görünür. İşin hatası (ör. okuma kontrolü) aşağıdaki
      // `onError`'a eşzamanlı yanıtın hatasıyla aynı biçimde gelir.
      setGate(null);
      try {
        const result = await waitJob(started.job, {
          get: jobs.get,
          alive: () => importAliveRef.current,
          onUpdate: (job, receivedAt) => setImportJob({ job, receivedAt }),
        });
        return result as InvoiceCreateResult;
      } finally {
        setImportJob(null);
      }
    },
    meta: { silent: true },
    // İçe aktarma başlarken dosya vazgeçme yollarından çıkar; hata olursa geri gelir (yeniden denenebilsin).
    onMutate: () => {
      liveFileRef.current = beginImport(liveFileRef.current);
    },
    onError: (e) => {
      // sayfadan çıkıldı: iş sunucuda sürer, dosya işe bağlı kalır (vazgeçme yoluna dönmez)
      if (e instanceof JobLeft) return;
      liveFileRef.current = importFailed(liveFileRef.current);
      // Sunucu okuma kontrolünü yeniden çalıştırır; ekrandaki sonuç eskiyse onay penceresi sunucunun listesiyle açılır.
      if (e instanceof ApiError && e.code === "MAPPING_UNVERIFIED" && e.details)
        setGate(e.details as MappingIssues);
      // K36: sunucu PDF'te "1.500" gibi basılı ağırlık buldu (ekran bilmiyordu): satırlar sorulur, içe aktarma kapanır
      if (e instanceof ApiError && e.code === "PDF_WEIGHT_CHOICE_REQUIRED") {
        const rows = (e.details as { rows?: { rowIndex: number; weightAmbiguity?: PdfWeightAmbiguity }[] } | undefined)?.rows;
        if (rows?.length) setPdfRows((cur) => withPdfWeightAsks(cur, rows));
      }
      // Çakışmayı sunucu bildirdi (PDF faturada istemci önceden bilmez): onay penceresi açılır.
      if (e instanceof ApiError && e.code === "INVOICE_OVERLAP") {
        const ov = (e.details as { overlap?: InvoiceOverlap } | undefined)?.overlap;
        if (ov) {
          setOverlap(ov);
          setOverlapOk(false);
          setOverlapOpen(true);
        }
      }
    },
    onSuccess: ({ invoice: inv, importReport }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["carriers"] });
      qc.invalidateQueries({ queryKey: ["measurements"] });
      const tot = inv.totals;
      toast.ok(
        t("toast.imported"),
        tot
          ? [
              t("toast.lines", { count: tot.lines, n: fmtNum(tot.lines) }),
              t("toast.diff", { count: tot.diff, n: fmtNum(tot.diff) }),
              t("toast.unmatched", { count: tot.unmatched, n: fmtNum(tot.unmatched) }),
            ].join(" · ")
          : undefined,
      );
      const skippedCount = importReport?.skippedCount ?? 0;
      if (skippedCount > 0) toast.info(t("toast.skipped", { count: skippedCount }));
      // İçe aktarılan dosya artık faturaya bağlıdır: vazgeçme çağrısı gitmez.
      liveFileRef.current = importSucceeded();
      release();
      nav(ret.back(`/invoices/${inv.id}`, { fatura: inv.id }));
    },
  });
  // Okunan dosya, eşleme ve fatura bilgileri kayıt olmadan giderse kaybolur (1. adıma dönülmüş olsa da önizleme ekranda; 10-B9).
  const { dialog: leaveDialog, release } = useLeaveGuard(preview !== null && !createMut.isSuccess, { body: t("platform:leave.bodyUpload") });
  // Y95: açık önizlemede çalışılıyorsa dosya sunucunun 24 saatlik temizliğine düşmesin.
  const openFileId = preview && !createMut.isSuccess ? preview.fileId : null;
  useKeepPreview(openFileId);
  // Çoklu sekme: başka sekmenin sürdürme bandı bu dosyayı göstermesin (orada "Kaldır" bu sekmenin dosyasını silerdi).
  useOpenPreviewBeacon(openFileId);

  // SPEC §11.1: eşleme değişince okuma kontrolü sunucuda yeniden çalışır (tüm satırlar; dosya yeniden yüklenmez).
  const mappingKey = JSON.stringify(mapping);
  const tableFileId =
    preview && preview.format !== "pdf" ? preview.fileId : null;
  useEffect(() => {
    // Adıma bakılmaz: Devam'a hemen basılırsa kontrol sürer, sonucu fatura tarihine ve onay penceresine yansır.
    if (!tableFileId || !carrierId || mappingKey === verifiedKey || mappingKey === verifyFailedKey)
      return;
    let live = true;
    const t = setTimeout(() => {
      invoices
        .verifyMapping({
          fileId: tableFileId,
          carrierId,
          mapping: JSON.parse(mappingKey) as ColumnMapping,
        })
        .then((r) => {
          if (!live) return;
          setDiag(r.diagnostics);
          setVerifiedKey(mappingKey);
          setVerifyFailedKey("");
          setOverlap((cur) => {
            const next = r.overlap ?? null;
            if (next?.invoiceId !== cur?.invoiceId) setOverlapOk(false);
            return next;
          });
          const read = guessedDay(r.guessedMeta?.invoiceDate);
          if (read && read !== guessedDateRef.current) {
            const previous = guessedDateRef.current;
            guessedDateRef.current = read;
            setMeta((cur) => (cur.invoiceDate === previous ? { ...cur, invoiceDate: read } : cur));
            setFound((cur) => ({ ...cur, invoiceDate: true }));
          }
        })
        // Eski sonuç ve eski fatura tarihi doğruymuş gibi kalmasın: hata gösterilir, yeniden denenir.
        .catch(() => {
          if (!live) return;
          setDiag(undefined);
          setVerifyFailedKey(mappingKey);
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [mappingKey, verifiedKey, verifyFailedKey, verifyTry, tableFileId, carrierId]);
  const verifyFailed = Boolean(tableFileId) && mappingKey !== verifiedKey && mappingKey === verifyFailedKey;
  const verifying = Boolean(tableFileId) && mappingKey !== verifiedKey && !verifyFailed;

  // SPEC §11.2: yapay zekâ ile eşle (10–30 sn). Taşıyıcı ya da dosya değişince, sayfadan çıkınca süren istek iptal edilir:
  // eski dosyanın eşlemesi yenisinin üstüne yazılmaz. İptal hata sayılmaz (sonuç `null`).
  const [aiReq] = useState(latestRequest);
  useEffect(() => () => aiReq.cancel(), [aiReq, carrierId, tableFileId]);
  const aiMut = useMutation({
    mutationFn: () => {
      if (!preview || preview.format === "pdf" || !carrierId)
        throw new Error(t("errors.missingInfo"));
      const signal = aiReq.start();
      return unlessAborted(
        signal,
        invoices.aiMapping(
          {
            fileId: preview.fileId,
            carrierId,
            mapping,
            sources,
          },
          signal,
        ),
      );
    },
    meta: { silent: true },
    onSuccess: (r) => {
      if (!r) return;
      const m = {
        ...emptyMapping(),
        ...r.mapping,
        surchargeColumns: r.mapping.surchargeColumns ?? [],
      };
      setMapping(m);
      setVerifiedKey(JSON.stringify(m));
      setDiag(r.diagnostics);
      setVerifyFailedKey("");
      if ((r.overlap?.invoiceId ?? null) !== (overlap?.invoiceId ?? null)) setOverlapOk(false);
      setOverlap(r.overlap ?? null);
      setSources(r.fieldSources ?? {});
      setAi(r);
      if (!metaTouched) {
        const guessedDate = guessedDay(r.guessedMeta?.invoiceDate);
        if (guessedDate) guessedDateRef.current = guessedDate;
        setMeta((cur) => ({
          invoiceNo: cur.invoiceNo || r.guessedMeta?.invoiceNo || "",
          invoiceDate: guessedDate || cur.invoiceDate,
          currency: r.guessedMeta?.currency ?? cur.currency,
        }));
        setFound((cur) => ({
          invoiceNo: cur.invoiceNo || Boolean(r.guessedMeta?.invoiceNo),
          invoiceDate: cur.invoiceDate || Boolean(guessedDate),
        }));
      }
      const ok = r.diagnostics.verification.verdict === "ok";
      toast.ok(
        t("toast.aiApplied"),
        ok ? t("toast.aiOk") : t("toast.aiCheck"),
      );
    },
  });
  const verification =
    preview && preview.format !== "pdf" ? diag?.verification : undefined;
  const hasIssues = verification?.verdict === "check";
  const issuesNow = (): MappingIssues | null =>
    verification && hasIssues
      ? {
          issues: verification.issues,
          verdict: verification.verdict,
          flaggedRows: verification.flaggedRows,
          flagCounts: verification.flagCounts,
          examples: verification.rowFlags
            .filter((r) => r.codes.some((c) => HARD_ROW_FLAGS.includes(c)))
            .slice(0, 10),
        }
      : null;

  // Okumadan sonra ekranda yapılan düzeltme (PDF satırları, eşleme, elle yazılan fatura bilgisi).
  const editedNow = () =>
    isEdited(baseRef.current, {
      rows: preview?.format === "pdf" ? rowsKey(pdfRows) : "",
      mapping: preview && preview.format !== "pdf" ? JSON.stringify(mapping) : "",
      metaEdited,
    });
  /** `confirmed`: "Dosya yeniden okunsun mu?" onaylandı; plan yine o anki duruma göre kurulur, yalnız soru atlanır. */
  const start = (f: File, confirmed = false) => {
    if (f.size > MAX_MB * 1024 * 1024) {
      toast.err(t("toast.tooBig"), t("toast.tooBigBody", { mb: MAX_MB }));
      return;
    }
    const pdf = pdfReadState(me);
    if (isBlockedPdf(f, pdf === "on")) {
      if (pdf === "quota") toast.err(t("toast.pdfQuota"), t("toast.pdfQuotaBody"));
      else toast.err(t("toast.pdfDisabled"), t("toast.pdfDisabledBody"));
      return;
    }
    const plan = planFilePick({ file: keyOf(f), carrierId, src, edited: editedNow() });
    // Aynı dosya aynı taşıyıcıyla yeniden seçildi: okunmuş önizleme (düzeltmeleriyle) açılır, yeniden okunmaz.
    if (plan.do === "show") {
      setFile(f);
      stopRead();
      goStep(2);
      return;
    }
    if (plan.do !== "read") return;
    if (plan.ask && !confirmed) {
      setAsk({ kind: "change", pick: { file: f } });
      return;
    }
    setFile(f);
    previewMut.reset();
    if (carrierId) startRead(f, carrierId, { keepOld: plan.keepOld });
    else {
      readRef.current.ctrl?.abort();
      setReadJob(null);
      setJobError(null);
      if (!plan.keepOld) abandonPreview();
    }
  };
  const pickCarrier = (id: string, confirmed = false) => {
    const plan = planCarrierPick({ picked: id, current: carrierId, file: file ? keyOf(file) : null, src, edited: editedNow() });
    const choose = () => {
      const sw = switchTariff(tariffMemoRef.current, carrierId, tariffId, id);
      tariffMemoRef.current = sw.memo;
      setTariffId(sw.tariffId);
      // geri gelen taşıyıcının tarifesi korunur (elle seçilmiş sayılır); yeni taşıyıcıda önseçim yapılır
      setTariffAuto(sw.tariffId === "");
      setCarrierId(id);
    };
    if (plan.do === "none") return;
    if (plan.do === "set") return choose();
    // PDF önizlemesi taşıyıcıya bağlı değil: yalnız seçim değişir, okunmaz, sorulmaz (hak dolduysa da "Devam" edilir).
    // Süren bir yeniden okuma bırakılmaz; sonucu güncel taşıyıcıyla uygulanır.
    if (plan.do === "retarget") {
      choose();
      setSrc((s) => (s ? { ...s, carrierId: id } : s));
      return;
    }
    // Önizlemenin taşıyıcısına dönüldü: başka taşıyıcıyla süren okuma bırakılır, önizleme "Devam" ile açılır.
    // (Tablo okuması eşzamanlıdır, bırakılacak sunucu işi yok; PDF bu yola girmez.)
    if (plan.do === "back") {
      choose();
      stopRead();
      return;
    }
    if (plan.do !== "read" || !file) return;
    if (plan.ask && !confirmed) {
      setAsk({ kind: "change", pick: { carrier: id } });
      return;
    }
    choose();
    startRead(file, id, { keepOld: plan.keepOld });
  };

  const missing = useMemo(() => {
    if (!preview || preview.format === "pdf") return [];
    return MAPPING_FIELDS.filter((f) => f.required && !mapping[f.key]).map(
      (f) => f.key,
    );
  }, [preview, mapping]);

  const trackingEmpty = fillOf(preview, mapping.trackingNo) === 0;
  // 10-B7: takip no, net tutar, kg ve kenarlar; kırmızı hücre varken içe aktarılmaz (tablo aynı kuralla yakar).
  const pdfInvalid =
    preview?.format === "pdf" &&
    (pdfRows.length === 0 || pdfRows.some(pdfRowInvalid));
  // K36: tablo faturasında "1.500" ağırlık seçilmeden ilerlenmez ve içe aktarılmaz (onay penceresi de geçirmez; sunucu da reddeder)
  const weightUnchosen = preview?.format !== "pdf" && Boolean(diag?.weightAmbiguity) && !mapping.weightFormat;
  const metaErrs = {
    invoiceNo: !meta.invoiceNo.trim() ? t("errors.invoiceNoRequired") : null,
    invoiceDate: !meta.invoiceDate ? t("errors.invoiceDateRequired") : null,
  };

  // Kur indirmesi sürüyorsa bekleme uzar: birkaç saniye sonra neden sürdüğü anlatılır, hızlı içe aktarmada görünmez.
  const [importSlow, setImportSlow] = useState(false);
  useEffect(() => {
    if (!createMut.isPending) {
      setImportSlow(false);
      return;
    }
    const timer = setTimeout(() => setImportSlow(true), SLOW_IMPORT_MS);
    return () => clearTimeout(timer);
  }, [createMut.isPending]);

  // Durdurulan arka plan içe aktarması hata değildir: ekran içe aktarmadan önceki hâline döner.
  const createErr = createMut.error instanceof JobStopped || createMut.error instanceof JobLeft ? null : createMut.error;
  // Hata, sabit alt çubuğun altında kalmasın: görünür alana kaydır.
  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (createErr) errRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [createErr]);
  const exists =
    createErr instanceof ApiError && createErr.code === "INVOICE_EXISTS";
  const goStep = (s: Step) => {
    setStep(s);
    window.scrollTo({ top: 0 });
  };
  // 10-B9: "Geri" önizlemeden vazgeçmek değildir: 1. adımda "Devam" ile aynı satırlara ve eşlemeye dönülür.
  const readBusy = previewMut.isPending || readJob !== null;
  const showContinue = step === 1 && preview !== null && canContinue(src, carrierId, readBusy);

  const steps: [Step, string][] = [
    [1, t("steps.carrierFile")],
    [2, preview?.format === "pdf" ? t("steps.checkLines") : t("steps.mapping")],
    [3, t("steps.meta")],
  ];

  // Örnek veriyle deneme açıkken kendi fatura yüklenemez (sunucu 409 DEMO_ACTIVE); sayfa nedenini söyler.
  if (me?.company.settings.demo) {
    return (
      <>
        <PageHeader title={t("title")} />
        <div className="content">
          <Empty icon="upload" title={t("title")}>
            {tInvoices("demo.uploadBlocked")}
          </Empty>
        </div>
      </>
    );
  }

  return (
    <>
      {leaveDialog}
      <PageHeader
        crumbs={
          <>
            <Link to="/invoices">{t("crumb")}</Link>
            <span className="sep">/</span>
            <span>{t("title")}</span>
          </>
        }
        title={t("title")}
        sub={
          shownFile && step > 1 ? (
            <span className="wiz-file">
              <Icon name="doc" /> <span className="ellipsis">{shownFile.name}</span>
              <span className="t3">
                · {(shownFile.size / 1024).toFixed(0)} KB
                {carrier ? ` · ${carrier.name}` : ""}
              </span>
            </span>
          ) : (
            t("sub")
          )
        }
      />
      <div className="content">
        <ReturnBar hint={t("returnHint")} />
        {/* Y80-E2: yarım kalan PDF okuması; bu sayfada dosya seçilince ya da okuma sürerken görünmez */}
        {step === 1 && !file && !resumed && !readJob && !previewMut.isPending && (
          <ResumeBand carrierChosen={Boolean(carrier)} onContinue={continueResume} />
        )}
        <div className={`wiz${step === 3 ? " narrow" : step === 2 && preview?.format !== "pdf" ? " wide" : ""}`}>
          <ol className="wsteps" aria-label={t("steps.label")}>
            {steps.map(([n, stepLabel]) => {
              const state = step === n ? "on" : step > n ? "done" : "";
              return (
                <li
                  key={n}
                  className={`ws ${state}`}
                  aria-current={step === n ? "step" : undefined}
                >
                  <span className="ws-dot" aria-hidden="true">
                    {step > n ? <Icon name="check" /> : n}
                  </span>
                  <span className="ws-txt">
                    <span className="ws-no">{t("steps.no", { n })}</span>
                    <span className="ws-t">{stepLabel}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          {step === 1 && (
            <StepOne
              carriers={activeCarriers}
              loading={cs.isLoading}
              loadError={cs.isError ? cs.error : null}
              carrierId={carrierId}
              setCarrierId={pickCarrier}
              file={shownFile}
              onFile={start}
              busy={readBusy}
              error={readError}
              // Aynı dosya ve taşıyıcı: tutulan önizleme yenisi gelene kadar kalır (10-B5); `fresh` kuralı `retryFresh`.
              onRetry={() => file && carrierId && startRead(file, carrierId, { fresh: retryFresh(readRef.current.fresh, readRef.current.jobStarted), keepOld: true })}
              onStop={stopRead}
              job={liveJob && readJob ? liveJob : null}
              jobReceivedAt={jobAt}
              onStopJob={() => void stopJob()}
            />
          )}

          {step === 2 && preview && preview.format !== "pdf" && (
            <MappingStep
              preview={preview}
              mapping={mapping}
              setMapping={(m) => {
                // 10-B8: yapay zekâ eşlemesi beklenirken seçenekler kapalı; sonucu kişinin seçimini sessizce ezmesin.
                if (aiMut.isPending) return;
                // Tarih sırası tek sorunsa seçimle çözülür: eşleme yine hatırlanır, sonraki faturada aynı soru gelmez.
                if (m.dateOrder !== mapping.dateOrder && verification?.issues.length === 1 && diag?.dateAmbiguity) setSaveMapping(true);
                setMapping(m);
              }}
              missing={missing}
              saveMapping={saveMapping}
              canRemember={canRemember}
              setSaveMapping={(b) => {
                // SPEC §11.4: sorunlu eşlemeyi hatırlamak için onay
                if (b && hasIssues) setConfirmSave(true);
                else setSaveMapping(b);
              }}
              diag={diag}
              verifying={verifying}
              sources={sources}
              setSources={setSources}
              ai={ai}
              aiBusy={aiMut.isPending}
              aiError={aiMut.error}
              onAi={() => aiMut.mutate()}
              currency={meta.currency}
            />
          )}
          {step === 2 && preview && preview.format === "pdf" && (
            <PdfLinesStep
              warning={preview.warning}
              rows={pdfRows}
              setRows={setPdfRows}
              currency={meta.currency}
              pdfCheck={preview.pdfCheck}
              aiSkipped={preview.aiSkipped}
              aiCached={preview.aiCached}
              onReread={file && carrierId && pdfReadState(me) === "on" ? () => setAsk({ kind: "reread" }) : undefined}
            />
          )}

          {step === 3 && preview && (
            <MetaStep
              preview={preview}
              meta={meta}
              setMeta={(m) => {
                setMetaEdited(true);
                setMeta(m);
              }}
              metaTouched={metaTouched}
              metaErrs={metaErrs}
              found={found}
              importSlow={importSlow}
              importJob={importJob}
              onStopImport={() => void stopImport()}
              carrier={carrier}
              tariffId={tariffId}
              setTariffId={(id, auto) => {
                setTariffId(id);
                setTariffAuto(auto);
              }}
              tariffAuto={tariffAuto}
              file={shownFile}
              pdfRowCount={pdfRows.length}
              saveMapping={saveMapping}
              verification={verification}
              hasIssues={hasIssues}
              createErr={createErr}
              exists={exists}
              errRef={errRef}
            />
          )}

          {step > 1 && verifyFailed && (
            <div className="notif err mt16" role="alert" data-testid="verify-failed">
              <Icon name="err" />
              <span>{t("verifyFailed.text")}</span>
              <Button kind="secondary" icon="refresh" onClick={() => {
                  setVerifyFailedKey("");
                  setVerifyTry((n) => n + 1);
                }}>
                {t("verifyFailed.retry")}
              </Button>
            </div>
          )}

          {showContinue && (
            <div className="wizbar">
              <div className="wizbar-msg" />
              <Button
                icon="arrow"
                onClick={() => {
                  // Düşen ya da durdurulan yeniden okumanın hatası temizlenir; önizleme olduğu gibi açılır.
                  stopRead();
                  goStep(2);
                }}
              >
                {t("next")}
              </Button>
            </div>
          )}

          {step > 1 && (
            <div className="wizbar">
              <Button
                kind="secondary"
                icon="back"
                onClick={() => goStep((step - 1) as Step)}
                disabled={createMut.isPending}
              >
                {t("back")}
              </Button>
              <div className="wizbar-msg" aria-live="polite">
                <WizbarMsg
                  step={step}
                  missing={missing}
                  pdfInvalid={Boolean(pdfInvalid)}
                  trackingEmpty={trackingEmpty}
                  hasIssues={hasIssues}
                  verification={verification}
                  isPdf={preview?.format === "pdf"}
                  metaMissing={[
                    ...(metaErrs.invoiceNo ? [t("meta.invoiceNo")] : []),
                    ...(metaErrs.invoiceDate ? [t("meta.invoiceDate")] : []),
                  ]}
                />
              </div>
              {step === 2 ? (
                <Button
                  icon="arrow"
                  disabled={
                    missing.length > 0 || Boolean(pdfInvalid) || trackingEmpty || weightUnchosen
                  }
                  onClick={() => goStep(3)}
                >
                  {t("next")}
                </Button>
              ) : (
                <Button
                  icon="check"
                  loading={createMut.isPending}
                  disabled={verifying || verifyFailed || Boolean(pdfInvalid) || weightUnchosen}
                  onClick={() => {
                    setMetaTouched(true);
                    if (metaErrs.invoiceNo || metaErrs.invoiceDate) return;
                    if (overlap && !overlapOk) {
                      setOverlapOpen(true);
                      return;
                    }
                    // SPEC §11.4: sorun varsa doğrudan içe aktarılmaz; onay penceresi açılır.
                    const iss = issuesNow();
                    if (iss) setGate(iss);
                    else createMut.mutate(false);
                  }}
                >
                  {createMut.isPending ? t("importing") : t("import")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {overlapOpen && overlap && (
        <Modal
          title={t("overlap.title")}
          onClose={() => setOverlapOpen(false)}
          actions={
            <>
              <ModalAction
                kind="prim"
                data-testid="overlap-cancel"
                icon="back"
                onClick={() => {
                  setOverlapOpen(false);
                  setOverlap(null);
                  abandonPreview();
                  setFile(null);
                  setStep(1);
                  window.scrollTo({ top: 0 });
                }}
              >
                {t("overlap.cancel")}
              </ModalAction>
              <ModalAction
                kind="dark"
                data-testid="overlap-go"
                onClick={() => {
                  setOverlapOk(true);
                  setOverlapOpen(false);
                  const iss = issuesNow();
                  if (iss) setGate(iss);
                  else createMut.mutate(false);
                }}
              >
                {t("overlap.go")}
              </ModalAction>
            </>
          }
        >
          <p className="t2">
            {/* Gönderiler birden çok eski faturaya yayılmışsa (birleşik pay) hepsi sayılır */}
            {overlap.otherInvoices?.length ? (
              <Trans
                t={t}
                i18nKey="overlap.textMany"
                count={overlap.matched}
                values={{
                  total: fmtNum(overlap.total),
                  matched: fmtNum(overlap.matched),
                  nos: [overlap.invoiceNo, ...overlap.otherInvoices.map((o) => o.invoiceNo)].join(", "),
                }}
                components={{ mono: <span className="mono" /> }}
              />
            ) : (
              <Trans
                t={t}
                i18nKey="overlap.text"
                count={overlap.matched}
                values={{ total: fmtNum(overlap.total), matched: fmtNum(overlap.matched), no: overlap.invoiceNo }}
                components={{ mono: <span className="mono" /> }}
              />
            )}
          </p>
        </Modal>
      )}
      {gate && (
        <IssuesModal
          // 01-B8: PDF faturada kapı yalnız para birimi farkında açılır (sunucunun 409 ayrıntısı); eşleme metni geçmez
          title={t(preview?.format === "pdf" ? "gate.pdfTitle" : "gate.title")}
          intro={t(preview?.format === "pdf" ? "gate.pdfIntro" : "gate.intro")}
          issues={gate}
          extra={
            importSlow
              ? `${t("meta.wait.title")} ${t("meta.wait.body")}`
              : saveMapping && preview?.format !== "pdf"
                ? t("gate.extra")
                : undefined
          }
          confirmText={t("gate.confirm")}
          checkText={t("gate.check")}
          loading={createMut.isPending}
          onBack={() => {
            setGate(null);
            createMut.reset();
            goStep(2);
          }}
          onConfirm={() => {
            // K36: ağırlık seçimi onayla geçilmez
            if (weightUnchosen) {
              setGate(null);
              goStep(2);
              return;
            }
            createMut.mutate(true, { onSettled: () => setGate(null) });
          }}
        />
      )}
      {ask?.kind === "reread" && file && carrierId && (
        <Modal
          title={t("reread.title")}
          onClose={() => setAsk(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setAsk(null)}>
                {t("reread.cancel")}
              </ModalAction>
              <ModalAction
                kind="prim"
                icon="refresh"
                data-testid="pdf-reread-go"
                onClick={() => {
                  setAsk(null);
                  goStep(1);
                  // 10-B5: eski okuma ve düzeltmeler yenisi uygulanana kadar kalır; düşerse "Devam" ile geri açılır.
                  // Önceki "Yeniden oku"nun işi başlayıp uygulanmadıysa `fresh` gitmez (çift ücret yok, `rereadFresh`).
                  startRead(file, carrierId, { fresh: rereadFresh(readRef.current.freshUnapplied), keepOld: true });
                }}
              >
                {t("reread.confirm")}
              </ModalAction>
            </>
          }
        >
          <p className="t2">{t("reread.body")}</p>
        </Modal>
      )}
      {ask?.kind === "change" && (
        <Modal
          title={t("change.title")}
          onClose={() => setAsk(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setAsk(null)}>
                {t("change.cancel")}
              </ModalAction>
              <ModalAction
                kind="prim"
                icon="refresh"
                data-testid="upload-change-go"
                onClick={() => {
                  const pick = ask.pick;
                  setAsk(null);
                  if ("carrier" in pick) pickCarrier(pick.carrier, true);
                  else start(pick.file, true);
                }}
              >
                {t("change.confirm")}
              </ModalAction>
            </>
          }
        >
          <p className="t2">{t("change.body")}</p>
        </Modal>
      )}
      {confirmSave && issuesNow() && (
        <IssuesModal
          title={t("save.title")}
          intro={t("save.intro")}
          issues={issuesNow()!}
          backText={t("save.back")}
          confirmText={t("save.confirm")}
          checkText={t("save.check")}
          onBack={() => setConfirmSave(false)}
          onConfirm={() => {
            setSaveMapping(true);
            setConfirmSave(false);
          }}
        />
      )}
    </>
  );
}
