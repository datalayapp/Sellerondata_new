import { Fragment, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { TFunction } from "i18next";
import { invoices, settings, tariffs } from "../../api/endpoints";
import type {
  BulkRecalcPreview,
  BulkRecalcResult,
  Invoice,
  InvoiceRecalcPreview,
  JobView,
  RecalcBasis,
  RecalcLineResult,
  RecalcPatch,
} from "../../api/types";
import { useAuth, usePermission } from "../../auth/AuthContext";
import { firmCurrency } from "../../lib/currency";
import { Icon } from "../../components/Icon";
import { toast } from "../../components/Toast";
import { JobProgress } from "../../components/JobProgress";
import { Modal, ModalAction, errorMessage } from "../../components/ui";
import { useJob } from "../../lib/useJob";
import { announceBulkOutcome } from "./bulkAnnounce";
import { fmtDate, fmtMoney, fmtMoneySigned, fmtNum } from "../../lib/format";
import { statusLabel } from "./lineUtils";
import {
  RECALC_LIST_LIMIT,
  INVOICE_REFRESH_KEYS,
  activeJobFromError,
  bulkOutcome,
  bulkFollowUp,
  bulkStale,
  type BulkFollowUp,
  firstAnnouncement,
  bulkTotals,
  bulkDecision,
  decidedLinesBlocked,
  errorCode,
  hiddenCount,
  lineResult,
  moneyChange,
  previewDecision,
  subjectLines,
} from "./recalc";

/** Tek fatura: neden açıldığı başlığı ve bilgi iletisini seçer. */
export type InvoiceRecalcPurpose = "tariff" | "rules" | "recompare" | "measurement" | "edit";

export interface InvoiceRecalcJob {
  kind: "invoice";
  invoiceId: string;
  currency: string;
  /** pencerenin üst etiketi (ör. "FedEx · 9-482-11735") */
  label?: string;
  basis: RecalcBasis;
  lineIds?: string[];
  patch?: RecalcPatch;
  purpose: InvoiceRecalcPurpose;
  /**
   * Düzenleme penceresi: onay `recalculate` yerine bunu önizlemenin `token`'ıyla çağırır (kaydetme); bilgi iletisi ve
   * önbellek çağırana kalır. Sunucu 409 PREVIEW_STALE dönerse önizleme yenilenir ve pencere her durumda gösterilir.
   */
  apply?: (token: string) => Promise<unknown>;
}
export interface TariffRecalcJob {
  kind: "tariff";
  tariffId: string;
  tariffName: string;
}
export interface SettingsRecalcJob {
  kind: "settings";
}
export type RecalcJob = InvoiceRecalcJob | TariffRecalcJob | SettingsRecalcJob;

type Shown =
  | { job: InvoiceRecalcJob; preview: InvoiceRecalcPreview; stale: boolean }
  | { job: TariffRecalcJob | SettingsRecalcJob; preview: BulkRecalcPreview; stale: boolean };

/** Süren toplu iş: önizleme ("kontrol ediliyor n / N") ya da uygulama (yazılıyor). */
export type BulkSpec = TariffRecalcJob | SettingsRecalcJob;
interface Run {
  job: BulkSpec;
  view: JobView;
  phase: "preview" | "apply";
  /** önizleme: değişiklik yoksa bilgi iletisi çıkmaz */
  quiet?: boolean;
  /** önizleme: önceki önizleme eskidiği için yenileniyor */
  stale?: boolean;
  /** uygulama: başka onayla süren işe bağlanıldı (409 JOB_ACTIVE) */
  already?: boolean;
}

export type RecalcApplied = { kind: "invoice"; invoice?: Invoice } | { kind: "bulk"; result: BulkRecalcResult };

/** Önizleme ve onay hatası: itiraz kilitleri kendi cümlesiyle, diğerleri sunucunun iletisiyle. */
export function recalcErrorText(t: TFunction, e: unknown): string {
  const c = errorCode(e);
  if (c === "INVOICE_HAS_DISPUTE" || c === "LINE_IN_DISPUTE") return t(`recalc.errors.${c}`);
  return errorMessage(e);
}

/**
 * Önce/sonra akışı: önizle → (değişiklik yoksa bilgi iletisi) → pencere → onay. Önizleme eskidiyse (409 PREVIEW_STALE)
 * yenilenir ve pencerede söylenir. Fatura ayrıntısı, düzenleme penceresi, tarife düzenleyici ve Ayarlar aynı akışı kullanır.
 */
export function useRecalcFlow(opts: { onApplied?: (r: RecalcApplied) => void } = {}) {
  const { t } = useTranslation("invoiceDetail");
  const qc = useQueryClient();
  const canDecide = usePermission("deciship.lines.decide");
  const [shown, setShown] = useState<Shown | null>(null);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  // K4: uygulama bitti, önizlemeden sonra değişen faturalar yazılmadı: liste ve "Yeniden önizle"
  const [staleShown, setStaleShown] = useState<({ job: BulkSpec } & BulkFollowUp) | null>(null);
  const onApplied = useRef(opts.onApplied);
  onApplied.current = opts.onApplied;

  // Tek fatura önizlemesi eşzamanlıdır; toplu önizleme yalnız arka plan işi (startBulkPreview, Y83).
  const fetchPreview = (job: InvoiceRecalcJob): Promise<InvoiceRecalcPreview> =>
    invoices.recalculatePreview(job.invoiceId, { basis: job.basis, lineIds: job.lineIds, patch: job.patch });

  const refreshInvoice = (id: string) => {
    qc.invalidateQueries({ queryKey: ["invoice", id] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["measurements"] });
    qc.invalidateQueries({ queryKey: ["measurement"] });
  };

  const lockError = (job: RecalcJob, e: unknown) => {
    // kilit hatası: faturanın itiraz durumu değişmiş olabilir, güncel hali okunur
    const c = errorCode(e);
    if (job.kind === "invoice" && (c === "INVOICE_HAS_DISPUTE" || c === "LINE_IN_DISPUTE")) qc.invalidateQueries({ queryKey: ["invoice", job.invoiceId] });
  };

  const noChange = (job: RecalcJob, skipped: number) => {
    const key = job.kind === "invoice" ? `recalc.none.${job.purpose}` : `recalc.none.${job.kind}Bulk`;
    const skip =
      skipped > 0
        ? ` ${t(job.kind === "invoice" ? "recalc.skippedLines" : "recalc.skippedInvoices", { count: skipped, n: fmtNum(skipped) })}`
        : "";
    toast.info(t("recalc.none.title"), `${t(key)}${skip}`);
  };

  /** `quiet`: sormadan uygulandı; "silent" dayanak değişti (rakam aynı), "update" yalnız satırlar yazıldı (Y32). */
  const apply = async (s: Shown, quiet: "silent" | "update" | null = null) => {
    setApplying(true);
    try {
      if (s.job.kind === "invoice") {
        const job = s.job;
        if (job.apply) {
          await job.apply(s.preview.token);
          setShown(null);
          return;
        }
        const inv = await invoices.recalculate(job.invoiceId, { basis: job.basis, lineIds: job.lineIds, token: s.preview.token });
        if (inv && typeof inv === "object") qc.setQueryData<Invoice>(["invoice", job.invoiceId], (old) => (old ? { ...old, ...inv } : inv));
        refreshInvoice(job.invoiceId);
        const body = quiet === "update" ? "recalc.done.linesUpdated" : quiet === "silent" ? "recalc.done.sameNumbers" : "recalc.done.body";
        toast.ok(t(`recalc.done.${job.purpose}`), t(body));
        setShown(null);
        onApplied.current?.({ kind: "invoice", invoice: inv });
        return;
      }
      // Toplu uygulama arka plan işidir: 202 ile iş gelir; ilerleme pencerede, sonuç finishRun'da.
      const job = s.job;
      try {
        const started = job.kind === "tariff" ? await tariffs.recompareInvoicesAsync(job.tariffId, s.preview.token) : await settings.recompareInvoicesAsync(s.preview.token);
        setRun({ job, view: started.job, phase: "apply" });
      } catch (e) {
        // farklı onayla süren uygulama var: ona bağlanılır ve söylenir
        const active = activeJobFromError(e);
        if (!active) throw e;
        setRun({ job, view: active, phase: "apply", already: true });
      }
      qc.invalidateQueries({ queryKey: ["jobs-active"] });
    } catch (e) {
      if (s.job.kind !== "invoice" && errorCode(e) === "PREVIEW_STALE") {
        setShown(null);
        void startBulkPreview(s.job, { stale: true }).catch((e2) => toast.err(t("recalc.failed"), recalcErrorText(t, e2)));
      } else if (s.job.kind === "invoice" && errorCode(e) === "PREVIEW_STALE") {
        // rakamlar siz bakarken değişti: yeni önizleme; artık değişiklik yoksa pencere kapanır
        const job = s.job;
        try {
          const fresh = await fetchPreview(job);
          const d = previewDecision(fresh);
          // düzenleme: kayıt bu önizlemeye bağlı; rakam değişmese de kullanıcı yeni önizlemeyi görüp yeniden onaylar
          if (job.apply) setShown({ job, preview: fresh, stale: true });
          else if (d === "none") {
            setShown(null);
            noChange(job, fresh.skippedInDispute);
          } else setShown({ job, preview: fresh, stale: true });
        } catch (e2) {
          setShown(null);
          lockError(s.job, e2);
          toast.err(t("recalc.failed"), recalcErrorText(t, e2));
        }
      } else if (s.job.kind === "invoice" && s.job.apply) {
        // kaydetme hatasını düzenleme penceresi kendisi gösterir; form yeniden görünür
        setShown(null);
      } else {
        setShown(null);
        lockError(s.job, e);
        toast.err(t("recalc.failed"), recalcErrorText(t, e));
      }
    } finally {
      setApplying(false);
    }
  };

  const startBulkPreview = async (job: BulkSpec, o: { quiet?: boolean; stale?: boolean }) => {
    const started = job.kind === "tariff" ? await tariffs.recompareInvoicesPreviewAsync(job.tariffId) : await settings.recompareInvoicesPreviewAsync();
    setRun({ job, view: started.job, phase: "preview", quiet: o.quiet, stale: o.stale });
  };

  /** Toplu iş bitti: önizleme → önce/sonra penceresi; uygulama → bitiş iletisi (yazılanlar kalır). */
  const finishRun = (r: Run, j: JobView) => {
    const o = bulkOutcome(r.phase, j);
    setRun(null);
    switch (o.kind) {
      case "previewReady":
        if (bulkDecision(o.preview) === "none") {
          if (!r.quiet) noChange(r.job, o.preview.skippedInDispute);
        } else setShown({ job: r.job, preview: o.preview, stale: Boolean(r.stale) });
        break;
      case "previewFailed":
        toast.err(t("recalc.previewFailed"), o.message);
        break;
      case "applied":
      case "appliedStopped":
      case "applyFailed":
      case "stale":
      case "stopped":
        // uygulama nasıl biterse bitsin kısmen yazılmış olabilir: sorgular hep tazelenir
        setShown(null);
        for (const key of INVOICE_REFRESH_KEYS) qc.invalidateQueries({ queryKey: [...key] });
        if (o.kind === "stale") void startBulkPreview(r.job, { stale: true }).catch((e) => toast.err(t("recalc.previewFailed"), recalcErrorText(t, e)));
        else if (firstAnnouncement(j.id)) {
          const follow = bulkFollowUp(o);
          if (follow) setStaleShown({ job: r.job, ...follow });
          else announceBulkOutcome(t, o, r.job.kind);
        }
        if (o.kind === "applied") onApplied.current?.({ kind: "bulk", result: o.result });
        else if (o.kind === "appliedStopped") onApplied.current?.({ kind: "bulk", result: o.result ?? { invoices: o.written, lines: 0, skipped: { inDispute: 0, stale: 0 } } });
        break;
      default:
        setShown(null);
    }
  };

  /** `quiet`: değişiklik yoksa bilgi iletisi çıkmaz (ör. ayar kaydından sonra kendiliğinden sorulduğunda). */
  const start = async (job: RecalcJob, o: { quiet?: boolean } = {}) => {
    if (starting || applying) return;
    setStarting(true);
    try {
      if (job.kind !== "invoice") {
        // Toplu önizleme arka plan işidir ("kontrol ediliyor n / N"); bitince önce/sonra penceresi finishRun'da açılır.
        await startBulkPreview(job, { quiet: o.quiet });
        return;
      }
      const preview = await fetchPreview(job);
      const d = previewDecision(preview);
      // düzenleme: rakam değişmiyorsa sormadan, önizlemenin token'ıyla kaydedilir; karar izni olmayan kararlı satırı
      // değiştiremez (Y123): pencere her zaman açılır ve nedenini söyler
      if (decidedLinesBlocked({ job, preview }, canDecide)) setShown({ job, preview, stale: false });
      else if (d === "none" && !job.apply) {
        if (!o.quiet) noChange(job, preview.skippedInDispute);
      } else if (d === "ask") setShown({ job, preview, stale: false });
      // "update" (Y32): görünür değişiklik yok ama satırlar yazılacak; sormadan uygulanır, işaret kalıcı kalmaz
      else await apply({ job, preview, stale: false }, d === "update" ? "update" : "silent");
    } catch (e) {
      lockError(job, e);
      toast.err(t("recalc.previewFailed"), recalcErrorText(t, e));
    } finally {
      setStarting(false);
    }
  };

  const { job: liveJob, receivedAt, stop: stopJob } = useJob(run?.view.id, {
    initial: run?.view,
    onFinish: (j) => {
      if (run && run.view.id === j.id) finishRun(run, j);
    },
  });
  const cancelPreview = () => {
    void stopJob();
    setRun(null);
  };
  const applyRun = run?.phase === "apply" && liveJob ? { job: liveJob, receivedAt, already: Boolean(run.already), onStop: () => void stopJob() } : null;
  /**
   * K4: sayfa bandı (`BulkBand` `onStale`) bitişi bu akıştan önce gördüyse pencereyi o açar (`bulkFollowUp`). Aynı kapsamın
   * yeni önizlemesi atlanan ve kapsamda kalan faturaları yeniden gösterir.
   */
  const showStale = (job: BulkSpec, follow: BulkFollowUp) => setStaleShown({ job, ...follow });
  const previewAgain = () => {
    const job = staleShown?.job;
    setStaleShown(null);
    if (job) void start(job);
  };
  const dialog = staleShown ? (
    <StaleDialog job={staleShown.job} follow={staleShown} onAgain={previewAgain} onClose={() => setStaleShown(null)} />
  ) : shown ? (
    <RecalcDialog shown={shown} applying={applying} onApply={() => apply(shown)} onClose={() => setShown(null)} run={applyRun} />
  ) : run?.phase === "preview" && liveJob ? (
    <PreviewWait job={run.job} view={liveJob} receivedAt={receivedAt} onCancel={cancelPreview} />
  ) : null;
  return { start, showStale, busy: starting || applying || run !== null, open: shown !== null || staleShown !== null || run?.phase === "preview", dialog };
}

/**
 * K4: toplu geçiş bitti ama bazı faturalar eski dayanakta kaldı: önizlemeden sonra değişenler (liste, faturaya bağlantı;
 * silinen bağlantısız) ve sonradan kapsama girenler ya da itirazı kapananlar (sayı). Yazılan sayı (durdurulduysa "kalanı
 * durduruldu") ve tek birincil eylem "Yeniden önizle" (aynı kapsam).
 */
function StaleDialog({ job, follow, onAgain, onClose }: { job: BulkSpec; follow: BulkFollowUp; onAgain: () => void; onClose: () => void }) {
  const { t } = useTranslation("invoiceDetail");
  const { result, stopped } = follow;
  const stale = bulkStale(result);
  const inDispute = result.skipped?.inDispute ?? 0;
  // kapsamda kalanlar bayat atlananları da sayar; geri kalanı sonradan eklenen ya da itirazı kapanan faturadır
  const remaining = result.remaining ?? 0;
  const others = Math.max(0, remaining - stale.count);
  const title =
    stale.count > 0
      ? t("recalc.staleDone.title", { count: stale.count, n: fmtNum(stale.count) })
      : t("recalc.staleDone.remainingTitle", { count: remaining, n: fmtNum(remaining) });
  return (
    <Modal
      label={job.kind === "tariff" ? job.tariffName : t("recalc.settingsLabel")}
      title={title}
      onClose={onClose}
      size="wide"
      className="rc-dlg"
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t("common:actions.close")}
          </ModalAction>
          <ModalAction kind="prim" icon="refresh" onClick={onAgain}>
            {t("recalc.staleDone.again")}
          </ModalAction>
        </>
      }
    >
      <p className="rc-subject">
        {stopped
          ? t("recalc.done.bulkStopped", { n: fmtNum(result.invoices) })
          : t("recalc.done.bulkBody", { invoices: t("recalc.units.invoices", { count: result.invoices, n: fmtNum(result.invoices) }) })}
      </p>
      {stale.count > 0 && <p className="t2 s13 mt8">{t("recalc.staleDone.body")}</p>}
      {others > 0 && <p className="t2 s13 mt8">{t("recalc.staleDone.remaining", { count: others, n: fmtNum(others) })}</p>}
      {inDispute > 0 && <p className="t2 s13 mt8">{t("recalc.staleDone.inDispute", { count: inDispute, n: fmtNum(inDispute) })}</p>}
      {stale.list.length > 0 && (
        <RcList>
          <thead>
            <tr>
              <th>{t("recalc.cols.invoice")}</th>
            </tr>
          </thead>
          <tbody>
            {stale.list.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.deleted ? (
                    <span className="mono t3">{i.invoiceNo}</span>
                  ) : (
                    <Link to={`/invoices/${i.id}`} className="mono" onClick={onClose}>
                      {i.invoiceNo}
                    </Link>
                  )}{" "}
                  <span className="t3 s12 rc-car">
                    {i.carrierName}
                    {i.deleted ? ` · ${t("recalc.staleDone.deleted")}` : ""}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </RcList>
      )}
      {stale.more > 0 && <p className="t3 s12 mt8">{t("recalc.moreInvoices", { count: stale.more, n: fmtNum(stale.more) })}</p>}
    </Modal>
  );
}

function titleOf(t: TFunction, s: Shown): string {
  if (s.job.kind === "invoice") return t(`recalc.title.${s.job.purpose}`);
  const n = (s.preview as BulkRecalcPreview).changedInvoices;
  return t(s.job.kind === "tariff" ? "recalc.title.tariffBulk" : "recalc.title.settingsBulk", { count: n, n: fmtNum(n) });
}

/** Toplu önizleme beklerken küçük pencere: "Faturalar kontrol ediliyor 12 / 48". */
function PreviewWait({ job, view, receivedAt, onCancel }: { job: BulkSpec; view: JobView; receivedAt: number; onCancel: () => void }) {
  const { t } = useTranslation("invoiceDetail");
  return (
    <Modal
      label={job.kind === "tariff" ? job.tariffName : t("recalc.settingsLabel")}
      title={job.kind === "tariff" ? t("recalc.subject.tariffBulk", { name: job.tariffName }) : t("recalc.subject.settingsBulk")}
      onClose={onCancel}
      actions={
        <ModalAction kind="dark" onClick={onCancel}>
          {t("recalc.cancel")}
        </ModalAction>
      }
    >
      <JobProgress job={view} receivedAt={receivedAt} />
    </Modal>
  );
}

/** Önce/sonra penceresi. Tek birincil eylem "Uygula"; satır (ya da toplu kipte fatura) listesi pencere içinde kayar. */
function RecalcDialog({
  shown,
  applying,
  onApply,
  onClose,
  run,
}: {
  shown: Shown;
  applying: boolean;
  onApply: () => void;
  onClose: () => void;
  /** toplu uygulama sürüyor: gövdenin altında ilerleme, birincil eylem "Kapat, arka planda sürsün" */
  run?: { job: JobView; receivedAt: number; already: boolean; onStop: () => void } | null;
}) {
  const { t } = useTranslation("invoiceDetail");
  const showPrices = usePermission("deciship.prices.view");
  const canDecide = usePermission("deciship.lines.decide");
  const blocked = decidedLinesBlocked(shown, canDecide);
  const label =
    shown.job.kind === "invoice" ? shown.job.label : shown.job.kind === "tariff" ? shown.job.tariffName : t("recalc.settingsLabel");
  return (
    <Modal
      busy={applying}
      label={label}
      title={titleOf(t, shown)}
      onClose={onClose}
      size="wide"
      className="rc-dlg"
      actions={
        run ? (
          <ModalAction kind="prim" onClick={onClose}>
            {t("recalc.closeBackground")}
          </ModalAction>
        ) : (
          <>
            <ModalAction kind="dark" disabled={applying} onClick={onClose}>
              {t("recalc.cancel")}
            </ModalAction>
            {!blocked && (
              <ModalAction kind="prim" icon="check" loading={applying} onClick={onApply}>
                {t("recalc.apply")}
              </ModalAction>
            )}
          </>
        )
      }
    >
      {blocked && (
        <div className="notif warn rc-stale" role="status">
          <Icon name="warn" />
          <span>{t("recalc.decidedBlocked")}</span>
        </div>
      )}
      {shown.stale && (
        <div className="notif warn rc-stale" role="status">
          <Icon name="warn" />
          <span>{t("recalc.stale")}</span>
        </div>
      )}
      {shown.job.kind === "invoice" ? (
        <InvoiceBody preview={shown.preview as InvoiceRecalcPreview} invoiceId={shown.job.invoiceId} currency={shown.job.currency} showPrices={showPrices} />
      ) : (
        <BulkBody
          preview={shown.preview as BulkRecalcPreview}
          subject={shown.job.kind === "tariff" ? t("recalc.subject.tariffBulk", { name: shown.job.tariffName }) : t("recalc.subject.settingsBulk")}
          showPrices={showPrices}
        />
      )}
      {run && (
        <>
          {run.already && (
            <div className="notif info mt12" role="status">
              <Icon name="info" />
              <span>{t("recalc.alreadyRunning")}</span>
            </div>
          )}
          <JobProgress job={run.job} receivedAt={run.receivedAt} onStop={run.onStop} />
          <p className="t3 s12 mt8">{t("recalc.stopNote")}</p>
        </>
      )}
    </Modal>
  );
}

function Change({ before, after, currency }: { before: number; after: number; currency: string }) {
  const c = moneyChange(before, after);
  return (
    <span className="num">
      {fmtMoney(c.before, currency)} → <b>{fmtMoney(c.after, currency)}</b>
      {c.dir !== "same" && <span className={c.dir === "down" ? "green" : "red"}> ({fmtMoneySigned(c.delta, currency)})</span>}
    </span>
  );
}

function InvoiceBody({
  preview: p,
  invoiceId,
  currency,
  showPrices,
}: {
  preview: InvoiceRecalcPreview;
  invoiceId: string;
  currency: string;
  showPrices: boolean;
}) {
  const { t } = useTranslation("invoiceDetail");
  const qc = useQueryClient();
  // faturanın hesaplandığı gün: açık fatura sorgusundan (yoksa "hesaplandığı gün" yazılır)
  const calculatedAt = qc.getQueryData<Invoice>(["invoice", invoiceId])?.basis?.calculatedAt ?? null;
  const subject = subjectLines(p.basis, calculatedAt).map((x) =>
    t(x.key, { ...x.values, at: x.values.at ? fmtDate(String(x.values.at)) : t("recalc.subject.then") }),
  );
  const shownLines = p.lines.slice(0, RECALC_LIST_LIMIT);
  const more = hiddenCount(p.changedLines, shownLines.length);
  const result = (r: RecalcLineResult) => {
    const x = lineResult(r);
    return x.kind === "money" && showPrices ? fmtMoneySigned(x.amount, currency) : statusLabel(r.status);
  };
  return (
    <>
      {subject.map((s) => (
        <p key={s} className="rc-subject">
          {s}
        </p>
      ))}
      <dl className="kvs mt12">
        {showPrices && (
          <>
            <dt className="k">{t("recalc.overpaid")}</dt>
            <dd>
              <Change before={p.totals.before.overchargeTotal} after={p.totals.after.overchargeTotal} currency={currency} />
            </dd>
          </>
        )}
        <dt className="k">{t("recalc.changedLines")}</dt>
        <dd className="num">{fmtNum(p.changedLines)}</dd>
      </dl>
      {p.frozenChanged > 0 && <p className="t2 s13 mt8">{t("recalc.frozenNote", { count: p.frozenChanged, n: fmtNum(p.frozenChanged) })}</p>}
      {p.skippedInDispute > 0 && (
        <p className="t2 s13 mt8">{t("recalc.skippedLines", { count: p.skippedInDispute, n: fmtNum(p.skippedInDispute) })}</p>
      )}
      {shownLines.length > 0 && (
        <RcList>
          <thead>
            <tr>
              <th>{t("recalc.cols.trackingNo")}</th>
              <th className="r">{t("recalc.cols.before")}</th>
              <th className="r">{t("recalc.cols.after")}</th>
            </tr>
          </thead>
          <tbody>
            {shownLines.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.trackingNo}</td>
                <td className="r num t2">{result(l.before)}</td>
                <td className="r num sb">{result(l.after)}</td>
              </tr>
            ))}
          </tbody>
        </RcList>
      )}
      {more > 0 && <p className="t3 s12 mt8">{t("recalc.moreLines", { count: more, n: fmtNum(more) })}</p>}
    </>
  );
}

function BulkBody({ preview: p, subject, showPrices }: { preview: BulkRecalcPreview; subject: string; showPrices: boolean }) {
  const { t } = useTranslation("invoiceDetail");
  const firm = firmCurrency(useAuth().me);
  const list = p.invoices.slice(0, RECALC_LIST_LIMIT);
  // sunucu para birimine göre ayrı toplar (tüm faturalardan); birden çok para birimi varsa her biri ayrı satır
  const totals = showPrices ? bulkTotals(p) : [];
  const more = hiddenCount(p.changedInvoices, list.length);
  return (
    <>
      <p className="rc-subject">{subject}</p>
      <dl className="kvs mt12">
        {totals.map((x) => (
          <Fragment key={x.currency}>
            <dt className="k">{totals.length > 1 ? t("recalc.overpaidIn", { currency: x.currency }) : t("recalc.overpaid")}</dt>
            <dd>
              <Change before={x.before.overchargeTotal} after={x.after.overchargeTotal} currency={x.currency} />
            </dd>
          </Fragment>
        ))}
        <dt className="k">{t("recalc.changedInvoices")}</dt>
        <dd className="num">{fmtNum(p.changedInvoices)}</dd>
      </dl>
      {p.skippedInDispute > 0 && (
        <p className="t2 s13 mt8">{t("recalc.skippedInvoices", { count: p.skippedInDispute, n: fmtNum(p.skippedInDispute) })}</p>
      )}
      {list.length > 0 && (
        <RcList>
          <thead>
            <tr>
              <th>{t("recalc.cols.invoice")}</th>
              {showPrices && <th className="r">{t("recalc.cols.overpaid")}</th>}
              <th className="r">{t("recalc.cols.lines")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => (
              <tr key={i.id}>
                <td>
                  <span className="mono">{i.invoiceNo}</span> <span className="t3 s12 rc-car">{i.carrierName}</span>
                </td>
                {showPrices && (
                  <td className="r">
                    <Change before={i.before.overchargeTotal} after={i.after.overchargeTotal} currency={i.currency ?? firm} />
                  </td>
                )}
                <td className="r num">{fmtNum(i.changedLines)}</td>
              </tr>
            ))}
          </tbody>
        </RcList>
      )}
      {more > 0 && <p className="t3 s12 mt8">{t("recalc.moreInvoices", { count: more, n: fmtNum(more) })}</p>}
    </>
  );
}

/** Uzun listede pencere büyümez: tablo kendi içinde kayar. */
function RcList({ children }: { children: ReactNode }) {
  return (
    <div className="table-wrap rc-list mt16" tabIndex={0}>
      <table className="dt compact">{children}</table>
    </div>
  );
}
