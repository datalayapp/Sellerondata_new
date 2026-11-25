import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiError } from '../api/client';
import { jobs, tariffDocuments, tariffs } from '../api/endpoints';
import type { JobView, PdfExtractTarget, PdfPricing, PdfScanMode, TariffImportDraft, TariffImportUpload, TariffPdfScan, TariffPdfSection, TariffPdfUpload } from '../api/types';
import { Icon } from '../components/Icon';
import { JobProgress } from '../components/JobProgress';
import { toast } from '../components/Toast';
import { Button, Modal, ModalAction, errorMessage } from '../components/ui';
import { fmtDate, fmtNum } from '../lib/format';
import { isJobFinished } from '../lib/jobs';
import { useJob } from '../lib/useJob';
import { serviceCode, serviceInfo, serviceKey } from '../lib/serviceInfo';

// ======================================================================
// Kısa bekleme (kodla tarama): yapay zekâ taraması ve tablo okuma arka plan işidir, ilerlemesi `JobProgress`te
// ======================================================================
function Busy({ title, onCancel }: { title: string; onCancel: () => void }) {
  const { t } = useTranslation('tariffImport');
  return (
    <div className="lp" role="status" aria-live="polite">
      <div className="lp-h">
        <Icon name="spin" className="spin" />
        <b className="grow">{title}</b>
        <Button kind="ghost" small icon="close" onClick={onCancel}>
          {t('pdf.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ======================================================================
// Biçimlendirme
// ======================================================================
export const isPdfUpload = (r: TariffImportUpload): r is TariffPdfUpload => r.kind === 'pdf' && 'documentId' in r && !('draftId' in r);
export const isAbort = (e: unknown) => (e as Error | null)?.name === 'AbortError';

/** [5,6,7,11] → "5–7, 11" */
export function pagesText(p: number[]): string {
  const s = Array.from(new Set(p)).sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}–${s[j]}` : String(s[i]));
    i = j;
  }
  return out.join(', ');
}

/** ["A","B",…,"I"] → "A–I"; uzun ve düzensiz listeler kısaltılır */
function zonesText(z: string[]): string {
  if (!z.length) return '—';
  if (z.every((x) => /^[A-Z]$/.test(x))) {
    // letter runs: A…I + R…W → "A–I, R–W"
    const runs: string[] = [];
    for (let i = 0; i < z.length; i++) {
      let j = i;
      while (j + 1 < z.length && z[j + 1].charCodeAt(0) === z[j].charCodeAt(0) + 1) j++;
      runs.push(j - i >= 2 ? `${z[i]}–${z[j]}` : z.slice(i, j + 1).join(', '));
      i = j;
    }
    if (runs.length <= 3) return runs.join(', ');
  }
  return z.length > 6 ? `${z.slice(0, 5).join(', ')} +${z.length - 5}` : z.join(', ');
}

function weightText(s: TariffPdfSection, unit: string): string | null {
  if (s.weightMin == null && s.weightMax == null) return null;
  if (s.weightMin != null && s.weightMax != null) return `${fmtNum(s.weightMin, 0, 3)}–${fmtNum(s.weightMax, 0, 3)} ${unit}`;
  return s.weightMax != null ? `≤ ${fmtNum(s.weightMax, 0, 3)} ${unit}` : `${fmtNum(s.weightMin, 0, 3)}+ ${unit}`;
}

/** Faturayla karşılaştırmada işe yaramayan tablolar (liste fiyatı, ithalat) "Diğer tablolar"a gider. */
const otherReason = (s: TariffPdfSection): 'list' | 'import' | null => (s.priceType === 'list' ? 'list' : s.direction === 'import' ? 'import' : null);

/** Belgeden kısa özet: "FedEx · USD · kg · 01.01.2026'dan itibaren · yakıt %5" */
function docLine(s: TariffPdfScan, t: TFunction): string {
  const d = s.document;
  const from = d.validFrom ? (/^\d{4}-\d{2}-\d{2}/.test(d.validFrom) ? fmtDate(d.validFrom) : d.validFrom) : null;
  const fuel = d.fuel.kind === 'FIXED_PCT' && d.fuel.pct != null ? t('pdf.fuelPct', { pct: fmtNum(d.fuel.pct, 0, 2) }) : d.fuel.kind === 'INDEXED' ? t('pdf.fuelIndexed') : null;
  return [d.carrier, d.currency, d.weightUnit, from ? t('pdf.asOf', { date: from }) : null, fuel].filter(Boolean).join(' · ');
}

// ======================================================================
// PDF: dosya → kodla tarama (metinli PDF'te kendiliğinden) / "Yapay zekâ ile tara" → tablo seç → çıkar
// ======================================================================
export interface PdfPick {
  sectionIds: string[];
  includeCountryZones: boolean;
  /** 'listDiscount': liste fiyatı × indirim tablosu (seçilen tabloların karşılığı varsa) */
  pricing?: PdfPricing;
}

export function PdfScanModal({
  doc,
  scan,
  pick,
  target,
  onScanned,
  onExtracted,
  onClose,
}: {
  doc: TariffPdfUpload;
  /** önceki tarama sonucu ("Tablolara dön" ile yeniden açılınca) */
  scan: TariffPdfScan | null;
  pick: PdfPick | null;
  target: PdfExtractTarget;
  onScanned: (s: TariffPdfScan) => void;
  onExtracted: (draft: TariffImportDraft, pick: PdfPick) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('tariffImport');
  const [busy, setBusy] = useState<null | { k: 'scan'; mode: PdfScanMode } | { k: 'extract' }>(null);
  const [err, setErr] = useState<unknown>(null);
  const [errKind, setErrKind] = useState<'scan' | 'extract'>('scan');
  const acRef = useRef<AbortController | null>(null);
  useEffect(() => () => acRef.current?.abort(), []);
  // Bu belgenin süren arka plan işi (tarama ya da tablo okuma). Pencere kapansa da iş sürer; yeniden açılınca bağlanılır.
  const [attached, setAttached] = useState<null | { job: JobView; kind: 'scan' | 'extract'; pick: PdfPick | null }>(null);
  const { job: liveJob, receivedAt, stop: stopJob } = useJob(attached?.job.id, {
    initial: attached?.job,
    onFinish: (j) => {
      if (!attached || attached.job.id !== j.id) return;
      setAttached(null);
      setBusy(null);
      if (j.status === 'SUCCEEDED' && j.result) {
        if (attached.kind === 'scan') onScanned(j.result as TariffPdfScan);
        else if (attached.pick) onExtracted(j.result as TariffImportDraft, attached.pick);
      } else if (j.status === 'FAILED' && j.error) {
        setErrKind(attached.kind);
        setErr(new ApiError(j.error.statusCode, j.error.code, j.error.message, j.error.details));
      }
    },
  });
  const cancel = () => {
    if (attached) {
      void stopJob();
      return;
    }
    acRef.current?.abort();
    setBusy(null);
  };
  const attach = (job: JobView) => {
    if (job.kind === 'TARIFF_PDF_EXTRACT') {
      const prm = job.params ?? {};
      const pick: PdfPick = {
        sectionIds: Array.isArray(prm.sectionIds) ? (prm.sectionIds as string[]) : [],
        includeCountryZones: Boolean(prm.includeCountryZones),
        pricing: prm.pricing === 'listDiscount' ? 'listDiscount' : 'table',
      };
      setBusy({ k: 'extract' });
      setAttached({ job, kind: 'extract', pick });
    } else {
      setBusy({ k: 'scan', mode: 'ai' });
      setAttached({ job, kind: 'scan', pick: null });
    }
  };

  const runScan = (mode: PdfScanMode) => {
    const ac = new AbortController();
    acRef.current?.abort();
    acRef.current = ac;
    setErr(null);
    setBusy({ k: 'scan', mode });
    const failed = (e: unknown) => {
      if (isAbort(e) || ac.signal.aborted) return;
      setBusy(null);
      setErrKind('scan');
      setErr(e);
    };
    if (mode === 'ai') {
      // Yapay zekâ taraması arka plan işidir: 202 ile iş gelir, sonucu `useJob` yoklayıp getirir.
      tariffDocuments.scanAsync(doc.documentId, ac.signal).then((r) => {
        if (!ac.signal.aborted) setAttached({ job: r.job, kind: 'scan', pick: null });
      }, failed);
      return;
    }
    tariffDocuments.scan(doc.documentId, mode, ac.signal).then((s) => {
      if (ac.signal.aborted) return;
      setBusy(null);
      onScanned(s);
    }, failed);
  };

  // Açılışta bu belgenin süren işi varsa ona bağlanılır; yoksa kodla tarama (ücretsiz, birkaç saniye) metin katmanı olan PDF'te kendiliğinden başlar.
  useEffect(() => {
    let live = true;
    void (async () => {
      let active: JobView[] = [];
      try {
        active = await jobs.list({ active: true, refType: 'TariffDocument', refId: doc.documentId });
      } catch {
        /* liste okunamadıysa bugünkü akış sürer */
      }
      if (!live) return;
      const running = active.find((j) => (j.kind === 'TARIFF_PDF_SCAN' || j.kind === 'TARIFF_PDF_EXTRACT') && !isJobFinished(j.status));
      if (running) attach(running);
      else if (!scan && doc.textLayer) runScan('code');
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- selection ----
  const suggested = useMemo(() => new Set(scan?.suggestedSectionIds ?? []), [scan]);
  const [sel, setSel] = useState<Set<string>>(() => new Set(pick?.sectionIds ?? scan?.suggestedSectionIds ?? []));
  const [cz, setCz] = useState(pick?.includeCountryZones ?? true);
  const [pricing, setPricing] = useState<PdfPricing>(pick?.pricing ?? scan?.suggestedPricing ?? 'table');
  const scanKey = useRef(scan);
  useEffect(() => {
    // a new scan result → reset selection to its suggestion
    if (scan && scan !== scanKey.current) {
      scanKey.current = scan;
      setSel(new Set(scan.suggestedSectionIds));
      setCz(true);
      setPricing(scan.suggestedPricing ?? 'table');
    }
  }, [scan]);
  const toggle = (id: string, on: boolean) => {
    const n = new Set(sel);
    if (on) n.add(id);
    else n.delete(id);
    setSel(n);
  };
  // suggested tables first, then the rest in PDF order
  const ordered = [...(scan?.sections ?? [])].sort((a, b) => Number(suggested.has(b.id)) - Number(suggested.has(a.id)));
  const main = ordered.filter((s) => suggested.has(s.id) || !otherReason(s));
  const other = ordered.filter((s) => !main.includes(s));
  const fitLabel = t(scan?.suggestionSource === 'invoices' ? 'pdf.fit.invoices' : scan?.suggestionSource === 'tariff' ? 'pdf.fit.tariff' : 'pdf.fit.default');
  const selected = (scan?.sections ?? []).filter((s) => sel.has(s.id));
  // Seçilen tablolar birden fazla hizmete aitse (ör. IP + IE) aynı bölgede biri diğerinin üzerine yazar
  const selectedServices = [...new Set(selected.map(serviceKey))];
  const mixed = selectedServices.length > 1;
  // Öneri notu: "Faturalarınızda International Priority (IP) kullanıldığı için …"
  const suggestedSecs = (scan?.sections ?? []).filter((s) => suggested.has(s.id));
  const sugInfo = suggestedSecs.length ? serviceInfo(suggestedSecs[0]!) : null;
  const sugName = sugInfo ? `${sugInfo.name} (${sugInfo.code})` : suggestedSecs.length ? serviceCode(suggestedSecs[0]!) ?? suggestedSecs[0]!.title.split('·')[0]!.trim() : null;
  const sugN = suggestedSecs.length;
  const sugContext = scan?.suggestionSource === 'invoices' ? 'invoices' : scan?.suggestionSource === 'tariff' ? 'tariff' : 'default';
  // FedEx PDF'leri bölgeleri Dünya / Avrupa (EN: World / Europe) diye ayırır; yalnız öyle tablolar varken açıkla
  const allSecs = scan?.sections ?? [];
  const regionGroups = allSecs.some((s) => /Dünya|World/.test(s.title)) && allSecs.some((s) => /Avrupa|Europe/.test(s.title)); // i18n-ok: PDF bölüm başlığı eşleme regex'i
  const anyNet = allSecs.some((s) => s.priceType === 'net');
  // Liste fiyatı × indirim tablosu: seçilen tablolardan en az birinin liste karşılığı ve indirim tablosu varsa seçim sunulur
  const linked = selected.filter((s) => s.listDiscount);
  const showPricing = linked.length > 0;
  const useDiscount = showPricing && pricing === 'listDiscount';
  const netLinked = linked.filter((s) => s.priceType !== 'list');
  const listPages = linked.flatMap((s) => s.listDiscount!.listPages);
  const discPages = linked.flatMap((s) => s.listDiscount!.discountPages);
  const netPages = netLinked.flatMap((s) => s.pages);
  const diff = netLinked.reduce(
    (a, s) => {
      const d = s.listDiscount!.diff;
      return d ? { compared: a.compared + d.compared, differing: a.differing + d.differing, maxDiff: Math.max(a.maxDiff, d.maxDiff) } : a;
    },
    { compared: 0, differing: 0, maxDiff: 0 },
  );
  const unlinked = useDiscount ? selected.filter((s) => !s.listDiscount) : [];

  const runExtract = () => {
    if (!scan) return;
    const p: PdfPick = { sectionIds: selected.map((s) => s.id), includeCountryZones: scan.hasCountryZones && cz, pricing: useDiscount ? 'listDiscount' : 'table' };
    const ac = new AbortController();
    acRef.current = ac;
    setErr(null);
    setBusy({ k: 'extract' });
    // Tablo okuma arka plan işidir: 202 ile iş gelir, taslak `job.result`ta döner.
    tariffDocuments.extractAsync(doc.documentId, { ...p, target }, ac.signal).then(
      (r) => {
        if (!ac.signal.aborted) setAttached({ job: r.job, kind: 'extract', pick: p });
      },
      (e) => {
        if (isAbort(e) || ac.signal.aborted) return;
        setBusy(null);
        setErrKind('extract');
        setErr(e);
      },
    );
  };

  const empty = scan != null && scan.sections.length === 0;
  // code scan found nothing or the PDF is an image → AI is the way forward
  const aiFirst = empty || (!scan && !doc.textLayer);
  const aiOff = doc.aiAvailable === false || (err instanceof ApiError && err.code === 'AI_DISABLED');
  const unit = scan?.document.weightUnit ?? 'kg';

  const scanButtons = (
    <div className="ps-btns">
      <Button kind={aiFirst ? 'secondary' : 'primary'} icon="search" onClick={() => runScan('code')} disabled={Boolean(busy)}>
        {t(scan?.mode === 'code' ? 'pdf.rescan' : 'pdf.scan')}
      </Button>
      <div className="ps-ai">
        <Button kind={aiFirst ? 'primary' : 'secondary'} icon="spark" onClick={() => runScan('ai')} disabled={Boolean(busy) || aiOff}>
          {t('pdf.scanAi')}
        </Button>
        <span className="ps-ai-n">{t(aiOff ? 'pdf.scanAiOff' : 'pdf.scanAiHint')}</span>
      </div>
    </div>
  );

  const sectionRow = (s: TariffPdfSection) => {
    const on = sel.has(s.id);
    const w = weightText(s, unit);
    const why = otherReason(s);
    const info = serviceInfo(s);
    return (
      <li key={s.id}>
        <label className={`ps-sec${on ? ' on' : ''}`}>
          <input type="checkbox" checked={on} onChange={(e) => toggle(s.id, e.target.checked)} />
          <span className="ps-sec-b">
            <span className="ps-sec-t">
              <b>{s.title}</b>
              {suggested.has(s.id) && (
                <span className="ps-fit">
                  <Icon name="check" size={12} /> {fitLabel}
                </span>
              )}
              {why && <span className="ps-why">{t(`pdf.other.${why}`)}</span>}
            </span>
            {info && (
              <span className="ps-sec-d">
                {info.code} = {info.name} · {info.hint}
              </span>
            )}
            <span className="ps-sec-m num">
              <span>{t('pdf.zonesOf', { zones: zonesText(s.zones) })}</span>
              {w && <span>{w}</span>}
              {on && useDiscount && s.listDiscount ? (
                <span>
                  {t('pdf.listTimesDiscount', { list: pagesText(s.listDiscount.listPages), discount: pagesText(s.listDiscount.discountPages) })}
                </span>
              ) : (
                s.pages.length > 0 && <span>{t('pdf.pageShort', { pages: pagesText(s.pages) })}</span>
              )}
            </span>
          </span>
        </label>
      </li>
    );
  };

  const why = !selected.length ? t('pdf.selectOne') : null;
  const showFoot = scan && !empty && !busy;

  return (
    <Modal
      busy={Boolean(busy) && !attached}
      label={t('pdf.modalLabel')}
      title={scan && !empty ? t('pdf.titlePick') : t('pdf.scan')}
      size="wide"
      className="ps"
      onClose={() => {
        acRef.current?.abort();
        onClose();
      }}
      actions={
        showFoot ? (
          <>
            <p className="iw-why ps-foot-why">
              <Icon name="info" size={14} /> <span>{why ?? t('pdf.selectedFoot', { count: selected.length, formatted: fmtNum(selected.length) })}</span>
            </p>
            <ModalAction kind="dark" onClick={onClose}>
              {t('pdf.cancelBtn')}
            </ModalAction>
            <ModalAction kind="prim" icon="arrow" disabled={Boolean(why)} title={why ?? undefined} onClick={runExtract}>
              {t('pdf.take')}
            </ModalAction>
          </>
        ) : undefined
      }
    >
      <div className="ps-file" data-autofocus tabIndex={-1}>
        <span className="iw-ic" aria-hidden="true">
          <Icon name="doc" />
        </span>
        <div className="grow">
          <b className="ps-fname">{doc.fileName}</b>
          <span className="t3 s12 num">
            {t('pdf.pageCount', { count: doc.pages, formatted: fmtNum(doc.pages) })}
            {scan && scan.sections.length > 0 ? ` · ${docLine(scan, t)}` : ''}
          </span>
        </div>
      </div>

      {busy && attached && liveJob ? (
        <JobProgress
          job={liveJob}
          receivedAt={receivedAt}
          title={attached.kind === 'scan' ? t('pdf.progress.aiScan') : t('pdf.progress.aiExtract')}
          onStop={cancel}
          stopLabel={t('pdf.cancel')}
          queuedText={t('pdf.queued')}
          slowAfterSec={attached.kind === 'scan' ? 75 : 130}
        />
      ) : busy?.k === 'scan' ? (
        <Busy title={t(busy.mode === 'ai' ? 'pdf.progress.aiScan' : 'pdf.progress.scan')} onCancel={cancel} />
      ) : busy?.k === 'extract' ? (
        <Busy title={t(scan?.mode === 'code' ? 'pdf.progress.extract' : 'pdf.progress.aiExtract')} onCancel={cancel} />
      ) : (
        <>
          {err != null && (
            <div className={`notif ${aiOff ? 'warn' : 'err'} mt12`} role="alert">
              <Icon name={aiOff ? 'warn' : 'err'} />
              <span>
                {aiOff ? (
                  <>
                    <b>{t('pdf.aiOff.title')}</b> {t('pdf.aiOff.body')} <TemplateLink />
                  </>
                ) : (
                  <>
                    <b>{t(errKind === 'extract' ? 'pdf.err.extract' : 'pdf.err.scan')}</b>{' '}
                    {err instanceof ApiError && err.status === 404 ? t('pdf.err.expired') : errorMessage(err)} {t('pdf.err.unchanged')}
                  </>
                )}
              </span>
            </div>
          )}

          {!scan && (
            <>
              <p className="ps-lead">
                {t(`pdf.${doc.textLayer ? 'leadText' : 'leadImage'}${aiOff ? 'NoAi' : ''}`)}
              </p>
              {scanButtons}
            </>
          )}

          {empty && (
            <>
              <div className="notif warn mt12">
                <Icon name="warn" />
                <span>
                  {aiOff ? <>{t('pdf.noTablesNoAi')} <TemplateLink /></> : (scan.message ?? t('pdf.noTables'))}
                </span>
              </div>
              {scanButtons}
            </>
          )}

          {scan && !empty && (
            <>
              {scan.message && (
                <div className="notif info mt12">
                  <Icon name="info" />
                  <span>{scan.message}</span>
                </div>
              )}
              <div className="ps-guide">
                {sugName && sugN > 0 && (
                  <p>
                    <Icon name="info" size={14} />
                    <span>
                      <Trans
                        t={t}
                        i18nKey="pdf.guide.suggest"
                        context={sugContext}
                        count={sugN}
                        values={{ name: sugName, formatted: fmtNum(sugN) }}
                        components={{ b: <b /> }}
                      />
                    </span>
                  </p>
                )}
                <p className="t3">
                  {regionGroups && (
                    <>
                      <Trans t={t} i18nKey="pdf.guide.regions" components={{ b: <b /> }} />{' '}
                    </>
                  )}
                  {anyNet && (
                    <>
                      <Trans t={t} i18nKey="pdf.guide.net" components={{ b: <b /> }} />{' '}
                    </>
                  )}
                  {t('pdf.guide.single')}
                </p>
              </div>
              <ul className="ps-secs" aria-label={t('pdf.foundTables')}>
                {main.map(sectionRow)}
              </ul>
              {showPricing && (
                <fieldset className="ps-price">
                  <legend>{t('pdf.pricing.legend')}</legend>
                  <label className={`ps-sec${useDiscount ? ' on' : ''}`}>
                    <input type="radio" name="ps-pricing" checked={useDiscount} onChange={() => setPricing('listDiscount')} />
                    <span className="ps-sec-b">
                      <span className="ps-sec-t">
                        <b>{t('pdf.pricing.listDiscount')}</b>
                        <span className="ps-fit">
                          <Icon name="check" size={12} /> {t('pdf.fit.default')}
                        </span>
                      </span>
                      <span className="ps-sec-d">{t('pdf.pricing.listDiscountDesc', { list: pagesText(listPages), discount: pagesText(discPages) })}</span>
                    </span>
                  </label>
                  {netLinked.length > 0 && (
                    <label className={`ps-sec${useDiscount ? '' : ' on'}`}>
                      <input type="radio" name="ps-pricing" checked={!useDiscount} onChange={() => setPricing('table')} />
                      <span className="ps-sec-b">
                        <span className="ps-sec-t">
                          <b>{t('pdf.pricing.net')}</b>
                        </span>
                        <span className="ps-sec-d">{t('pdf.pricing.netDesc', { pages: pagesText(netPages) })}</span>
                      </span>
                    </label>
                  )}
                  {diff.compared > 0 && (
                    <p className="ps-price-n num">
                      {diff.differing > 0
                        ? t('pdf.pricing.differ', {
                            compared: fmtNum(diff.compared),
                            differing: fmtNum(diff.differing),
                            max: `${fmtNum(diff.maxDiff, 2, 2)}${scan.document.currency ? ` ${scan.document.currency}` : ''}`,
                          })
                        : t('pdf.pricing.same', { compared: fmtNum(diff.compared) })}
                    </p>
                  )}
                  {unlinked.length > 0 && (
                    <p className="ps-price-n">
                      {t('pdf.pricing.unlinked', { count: unlinked.length, formatted: fmtNum(unlinked.length) })}
                    </p>
                  )}
                </fieldset>
              )}
              {other.length > 0 && (
                <details className="ps-other" open={other.some((s) => sel.has(s.id)) || undefined}>
                  <summary>
                    <Icon name="chev" className="tfh-chev" /> {t('pdf.otherTables', { formatted: fmtNum(other.length) })}
                    <span className="t3 s12">{t('pdf.otherTablesHint')}</span>
                  </summary>
                  <ul className="ps-secs">{other.map(sectionRow)}</ul>
                </details>
              )}
              {mixed && (
                <div className="notif warn mt12" role="status">
                  <Icon name="warn" />
                  <span>
                    <Trans t={t} i18nKey="pdf.mixed" values={{ services: selectedServices.map((k) => k.toUpperCase()).join(', ') }} components={{ b: <b /> }} />
                  </span>
                </div>
              )}
              {scan.hasCountryZones && (
                <label className="check ps-cz">
                  <input type="checkbox" checked={cz} onChange={(e) => setCz(e.target.checked)} />
                  <span>
                    {t('pdf.takeCountryZones')}
                    {scan.document.countryZonePages.length > 0 && <span className="t3"> ({t('pdf.pageShort', { pages: pagesText(scan.document.countryZonePages) })})</span>}
                  </span>
                </label>
              )}
              {scan.mode === 'code' && (
                <p className="ps-again">
                  {t('pdf.missingTables')}{' '}
                  <button type="button" className="link-btn" onClick={() => runScan('ai')} disabled={aiOff}>
                    <Icon name="spark" /> {t('pdf.scanAi')}
                  </button>
                </p>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export function TemplateLink({ label }: { label?: string }) {
  const { t } = useTranslation('tariffImport');
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="link-btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await tariffs.downloadTemplate();
        } catch (e) {
          toast.err(t('pdf.templateFailed'), errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name={busy ? 'spin' : 'download'} className={busy ? 'spin' : undefined} /> {label ?? t('pdf.downloadTemplate')}
    </button>
  );
}
