import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { tariffImports, tariffs } from '../../api/endpoints';
import type { PdfExtractTarget, TariffImportApplyResult, TariffImportDraft, TariffPdfScan, TariffPdfUpload } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Button, errorMessage } from '../../components/ui';
import { TariffImportWizard, type CurrentMeta } from '../TariffImport';
import { TariffFileHelp } from '../tariff-import/FileHelp';
import { afterImportCheck, type AfterImportCheck } from './draft';
import { PdfScanModal, TemplateLink, isAbort, isPdfUpload, type PdfPick } from '../TariffPdfImport';

const ACCEPT = '.xlsx,.csv,.pdf';
const OK_EXT = /\.(xlsx|csv|pdf)$/i;

/**
 * Dosyadan içe aktarma: Excel/CSV → kontrol özeti; PDF → (tuşla) tara → tablo seç → aynı kontrol özeti.
 * `tariffId` yoksa (yeni tarife sayfası) dosya yeni tarife olarak açılır.
 */
export function ImportBox({
  variant,
  tariffId,
  carrierId,
  carrierPicker,
  dirty,
  current,
  onApplied,
}: {
  variant: 'side' | 'create';
  tariffId?: string;
  carrierId: string;
  /** yalnız create: taşıyıcı seçimi */
  carrierPicker?: ReactNode;
  dirty: boolean;
  current: CurrentMeta;
  onApplied: (r: TariffImportApplyResult, ctx: { fileName: string; check?: AfterImportCheck }) => void;
}) {
  const { t } = useTranslation('tariffEditor');
  const create = variant === 'create';
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [badFile, setBadFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<TariffImportDraft | null>(null);
  // PDF: the scan result survives "Tablolara dön" and closing the modal
  const [pdf, setPdf] = useState<TariffPdfUpload | null>(null);
  const [scan, setScan] = useState<TariffPdfScan | null>(null);
  const [pick, setPick] = useState<PdfPick | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [fromPdf, setFromPdf] = useState(false);
  const acRef = useRef<AbortController | null>(null);
  useEffect(() => () => acRef.current?.abort(), []);
  // 10-B4: belge ve taslak yüklendikleri taşıyıcıya aittir (sunucu tarifeyi o taşıyıcıya açar). Taşıyıcı değişince bırakılır,
  // süren yükleme durdurulur; yeni taşıyıcı için dosya yeniden yüklenir.
  const latestCarrier = useRef(carrierId);
  latestCarrier.current = carrierId; // yanıt geldiğinde seçili olan taşıyıcı (çizimde güncellenir, etkiyi beklemez)
  const uploadFor = useRef(carrierId); // süren ya da son yüklemenin taşıyıcısı
  const heldFor = useRef<string | null>(null); // eldeki belge/taslağın taşıyıcısı

  const upload = useMutation({
    mutationFn: (f: File) => {
      const ac = new AbortController();
      acRef.current = ac;
      uploadFor.current = carrierId;
      return create ? tariffImports.createDraft(carrierId, f, ac.signal) : tariffs.importDraft(tariffId!, f, ac.signal);
    },
    onSuccess: (r) => {
      if (uploadFor.current !== latestCarrier.current) return; // başka taşıyıcı için başlamış yükleme
      heldFor.current = uploadFor.current;
      if (isPdfUpload(r)) {
        setPdf(r);
        setScan(null);
        setPick(null);
        setPdfOpen(true);
      } else {
        setFromPdf(false);
        setDraft(r);
      }
    },
  });
  useEffect(() => {
    // yalnız başka taşıyıcıya ait iş bırakılır: yeni taşıyıcıyla hemen başlamış yükleme durdurulmaz
    if (upload.isPending && uploadFor.current !== carrierId) acRef.current?.abort();
    if (heldFor.current === null || heldFor.current === carrierId) return;
    heldFor.current = null;
    upload.reset();
    setBadFile(null);
    setDraft(null);
    setPdf(null);
    setScan(null);
    setPick(null);
    setPdfOpen(false);
    setFromPdf(false);
    // yalnız taşıyıcı değişince
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carrierId]);
  const canUpload = create ? Boolean(carrierId) : Boolean(tariffId);
  const onFile = (f: File) => {
    setBadFile(null);
    upload.reset();
    if (!OK_EXT.test(f.name)) {
      setBadFile(t('importBox.unsupported', { name: f.name }));
      return;
    }
    upload.mutate(f);
  };

  const target: PdfExtractTarget = create || !tariffId ? { newTariff: { name: null, service: null } } : { tariffId };
  const firstSec = scan && pick ? scan.sections.find((x) => pick.sectionIds.includes(x.id)) : undefined;
  const pdfName = fromPdf && scan ? [scan.document.carrier, firstSec?.service].filter(Boolean).join(' ') : '';
  const wizardCurrent: CurrentMeta = create
    ? {
        name: '',
        service: (fromPdf && firstSec?.service) || null,
        validFrom: null,
        validTo: null,
        currency: draft?.summary.tariffCurrency || draft?.suggestedDefaults?.currency || current.currency,
        divisor: draft?.suggestedDefaults?.divisor,
        fuelVariable: draft?.suggestedDefaults?.fuelVariable,
      }
    : current;

  return (
    <section className={create ? 'card imp imp-create lift' : 'card imp'} aria-labelledby="imp-h">
      <div className="qt-head">
        <span className={`qt-ic${create ? '' : ' gray'}`} aria-hidden="true">
          <Icon name={create ? 'upload' : 'table'} />
        </span>
        <div className="grow">
          <h2 className="tt" id="imp-h">
            {t(create ? 'importBox.titleCreate' : 'importBox.titleImport')}
          </h2>
          <p className="card-desc">{t(create ? 'importBox.descCreate' : 'importBox.descImport')}</p>
        </div>
      </div>
      {carrierPicker}
      {pdf && !pdfOpen && !draft && !upload.isPending && (
        <div className="imp-file">
          <Icon name="doc" />
          <span className="grow ellipsis">{pdf.fileName}</span>
          <button type="button" className="link-btn" onClick={() => setPdfOpen(true)}>
            {t(scan ? 'importBox.backToTables' : 'importBox.resumeScan')}
          </button>
        </div>
      )}
      <button
        type="button"
        className={`drop imp-drop${over ? ' over' : ''}`}
        disabled={!canUpload || upload.isPending}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (canUpload) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && canUpload) onFile(f);
        }}
      >
        {upload.isPending ? (
          <>
            <span className="drop-ic">
              <Icon name="spin" className="spin" size={22} />
            </span>
            <b>{t('importBox.uploading')}</b>
          </>
        ) : (
          <>
            <span className="drop-ic">
              <Icon name="upload" size={22} />
            </span>
            <b>{t(create ? 'importBox.dropCreate' : 'importBox.dropImport')}</b>
            <span className="drop-fmt">{t('importBox.formats')}</span>
          </>
        )}
      </button>
      {!canUpload && <p className="qt-empty mt8">{t(create ? 'importBox.pickCarrier' : 'importBox.saveFirst')}</p>}
      {upload.isPending && (
        <Button kind="ghost" small icon="close" className="mt8" onClick={() => acRef.current?.abort()}>
          {t('importBox.cancel')}
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="tariff-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      {(badFile || (upload.isError && !isAbort(upload.error))) && (
        <div className="notif err mt12" role="alert">
          <Icon name="err" />
          <span>
            <b>{!badFile && upload.error instanceof ApiError && upload.error.code === 'STORAGE_QUOTA_EXCEEDED' ? t('importBox.storageFull') : t('importBox.readFailed')}</b>{' '}
            {badFile ?? errorMessage(upload.error)}
          </span>
        </div>
      )}
      <div className="imp-foot">
        <TemplateLink label={t('importBox.downloadTemplate')} />
      </div>
      <TariffFileHelp />

      {pdfOpen && pdf && (
        <PdfScanModal
          key={pdf.documentId}
          doc={pdf}
          scan={scan}
          pick={pick}
          target={target}
          onScanned={(x) => {
            setScan(x);
            setPick(null);
          }}
          onExtracted={(d, p) => {
            setPick(p);
            setPdfOpen(false);
            setFromPdf(true);
            setDraft(d);
          }}
          onClose={() => setPdfOpen(false)}
        />
      )}
      {draft && (
        <TariffImportWizard
          key={draft.draftId}
          initial={draft}
          dirty={dirty}
          current={wizardCurrent}
          newTariff={create}
          suggestedName={pdfName || undefined}
          onBack={
            fromPdf
              ? () => {
                  setDraft(null);
                  setPdfOpen(true);
                }
              : undefined
          }
          onClose={() => setDraft(null)}
          onApplied={(r, checks) => {
            const fileName = draft.fileName;
            setDraft(null);
            setPdf(null);
            setScan(null);
            setPick(null);
            onApplied(r, { fileName, check: afterImportCheck(checks) });
          }}
        />
      )}
    </section>
  );
}
